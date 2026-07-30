// The transcript-search half of the library's search box, split out of
// library.ts the same way ocrPanel.ts is split out of reader.ts: all of the
// debounce/race/failure logic with the DOM injected as a {@link SearchView}, so
// it is exercisable on plain Node while library.ts keeps only the wiring.
//
// The two things this file exists to get right:
//
//   DEBOUNCE — a backend FTS query per keystroke is waste. Typing "roadmap"
//   would be seven queries for one intent, six of them already obsolete when
//   they land. So keystrokes coalesce into one request after a quiet moment.
//
//   STALENESS — even debounced, requests can overtake each other: a slow query
//   for "road" resolving after a fast one for "roadmap" would paint the WRONG,
//   OLDER results and leave them there, because nothing later is coming to
//   correct them. Every request therefore carries a token, and a response whose
//   token has moved on is dropped rather than painted. Same guard the reader and
//   the OCR panel use for their own paints — this is the third instance of the
//   pattern, not a new invention.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Api } from "../api/types";
import type { Coverage, Id, SearchHit } from "../core/types";

/**
 * The floor a LIBRARY-WIDE query must clear before a request is made. One or two
 * characters matches very nearly the whole index — broad-term cost on the wire
 * and noise on screen — and answers nothing anyone was asking, so the box simply
 * does not fire below it. Mirrors the backend's `min_global_query_len` (defense
 * in depth lives on both sides). This is the GLOBAL floor ONLY: in-document find
 * (find-in-note, the `.txt` viewer's find bar) is exempt by design and searches a
 * one-character string happily — it lives in the viewers, not in this controller.
 */
export const MIN_GLOBAL_QUERY_LEN = 3;

/**
 * What the results area can be showing. These are deliberately distinct states
 * rather than "some hits, possibly zero": "we haven't asked", "we're asking",
 * "we asked and there are none" and "the ask failed" are four different things
 * to a user, and collapsing the last three into an empty list is precisely how a
 * broken search gets mistaken for an empty one.
 */
export type SearchState =
  /** The box is empty — no request was made and nothing is claimed. */
  | { kind: "idle" }
  | { kind: "searching"; query: string }
  | {
      kind: "results";
      query: string;
      hits: SearchHit[];
      /**
       * The service answered approximately. Carried through the state rather
       * than left on the wire because the view has to SAY so — once, above the
       * results — and a response that quietly presented close matches as exact
       * ones is the defect this field exists to close.
       */
      usedFuzzy: boolean;
      /** Zero-hit only; see {@link Coverage}. `null` whenever the server did not say. */
      coverage: Coverage | null;
      /**
       * The server's opaque continuation, present exactly when more hits MAY
       * exist beyond the ones in `hits` — see {@link SearchResults.cursor}.
       * Carried through the state because its PRESENCE is what the view renders
       * (the "More results" control exists precisely while there is a cursor to
       * spend); its VALUE is only ever handed back via {@link
       * NoteSearchController.loadMore}, never parsed. NO TOTAL accompanies it,
       * ever — the results header must speak in "N+" floors, not counts.
       */
      cursor?: string;
    }
  | { kind: "error"; query: string };

export interface SearchView {
  setState(state: SearchState): void;
}

export interface NoteSearchDeps {
  api: Api;
  view: SearchView;
  /**
   * Where UNAUTHORIZED goes. Never swallow it: an expired session that surfaced
   * as "no results" would be indistinguishable from a genuinely unmatched query,
   * which is the exact bug class the ApiFailureSink was introduced to remove.
   */
  failures: ApiFailureSink;
  /** Quiet period before a query is sent, ms. Default 220. */
  debounceMs?: number;
  /** Max hits requested. Default 20 — the server's own default and a sane page. */
  limit?: number;
}

export interface NoteSearchController {
  /** The search box changed. Cheap, idempotent, and safe to call per keystroke. */
  setQuery(raw: string): void;
  /**
   * Spend the current results' cursor: fetch the next page and paint the SAME
   * `results` state grown by it — hits appended in arrival order, the new
   * page's cursor (or none) replacing the spent one. A no-op when there is no
   * cursor to spend or a fetch for one is already in flight, so a double-click
   * on the control cannot request the same page twice.
   *
   * The returned promise settles when the attempt is over — it is the view's
   * hook for its own loading affordance — and it NEVER rejects: UNAUTHORIZED
   * routes to the failure sink like every other call, and any other failure
   * deliberately leaves the painted results standing. A failed "more" must not
   * become an error screen over twenty perfectly good hits; the control simply
   * re-arms and the retry is free.
   *
   * `usedFuzzy` and `coverage` keep the FIRST page's answer: whether the search
   * was approximate was decided when it ran, and every page continues that same
   * search — a notice that flickered per page would be describing the transport,
   * not the results.
   */
  loadMore(): Promise<void>;
  /** Drop the pending timer, orphan any in-flight response, and clear the view. */
  reset(): void;
}

export function createNoteSearch(deps: NoteSearchDeps): NoteSearchController {
  const { api, view, failures } = deps;
  const debounceMs = deps.debounceMs ?? 220;
  const limit = deps.limit ?? 20;

  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Bumped whenever the intent changes. A response is painted only if the token
   * it captured is still current, which is what makes an overtaking slow
   * response a no-op instead of a regression to older results.
   */
  let token = 0;

  /**
   * The trimmed query currently pending, in flight, or painted. Its job is to
   * make `setQuery` idempotent: the gallery calls it on every `input` event, and
   * events that do not change the *effective* query (typing a trailing space,
   * a re-render echoing the value back) must not cancel and re-issue a request
   * that is already on its way to answering exactly this question.
   */
  let active: string | null = null;

  /**
   * The last `results` state painted, kept so `loadMore` knows what it is
   * growing: the query the cursor belongs to, the hits to append after, and the
   * cursor itself. `null` whenever nothing pageable is on screen — before the
   * first response, after `reset`, and from the moment a new query is typed
   * (cleared in {@link cancelPending}), so a late "More" click against a search
   * being replaced spends nothing.
   */
  let painted: Extract<SearchState, { kind: "results" }> | null = null;

  /** One page fetch at a time — the double-click guard `loadMore` promises. */
  let fetchingMore = false;

  /**
   * The request the current {@link token} owns, so a superseded one can be
   * ABORTED rather than merely ignored.
   *
   * Dropping a response on the token is what stops it painting; it does nothing
   * about the request itself, which carries on to completion holding one of the
   * browser's ~6 connections per origin. Typing an eight-letter query past the
   * 220 ms debounce is a handful of those, all for answers already superseded,
   * all competing with the gallery's own listings and thumbnails on exactly the
   * link where that is felt. Note-scoped find has threaded a signal since it was
   * written; this is the same thing on the library-wide half.
   *
   * ONE CONTROLLER FOR BOTH ARMS: the first page and a "More" page belong to the
   * same search, and the events that supersede one supersede the other.
   */
  let inflight: AbortController | null = null;

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // Orphans anything already awaiting a response: its captured token is stale
    // from here on, so it will drop itself when it resolves — and gives the
    // connection back, which the token alone cannot do.
    token++;
    inflight?.abort();
    inflight = null;
    painted = null;
  }

  async function run(query: string, mine: number): Promise<void> {
    const ac = new AbortController();
    inflight = ac;
    try {
      const results = await api.searchText(query, limit, undefined, ac.signal);
      if (mine !== token) return; // a later keystroke superseded us — drop it
      painted = {
        kind: "results",
        query,
        hits: results.hits,
        usedFuzzy: results.usedFuzzy,
        coverage: results.coverage,
        cursor: results.cursor,
      };
      view.setState(painted);
    } catch (e) {
      if (mine !== token) return;
      // A dead session belongs to the shell, not to the results area. Routing it
      // first is what stops an expired cookie from rendering as "no matches".
      if (dispatchApiFailure(failures, e)) return;
      // Everything else stays a recoverable, self-describing message: the next
      // keystroke retries for free.
      view.setState({ kind: "error", query });
    }
  }

  return {
    setQuery(raw: string): void {
      const query = raw.trim();
      if (query === active) return; // same question; leave the answer in progress alone
      active = query;
      cancelPending();

      if (query.length < MIN_GLOBAL_QUERY_LEN) {
        // No request at all — see `Api.searchText`. Empty, or below the global
        // floor (`MIN_GLOBAL_QUERY_LEN`): a 1–2 char library-wide query is broad-
        // term cost and noise, so the box idles exactly as it does when empty
        // rather than firing search-as-you-type. In-doc find is not gated here —
        // it is the viewers' own, and this controller never runs it.
        view.setState({ kind: "idle" });
        return;
      }

      // Announced immediately, sent later: the user gets feedback on the
      // keystroke while the network still only sees one query per pause.
      view.setState({ kind: "searching", query });
      const mine = token;
      timer = setTimeout(() => {
        timer = undefined;
        void run(query, mine);
      }, debounceMs);
    },

    async loadMore(): Promise<void> {
      const current = painted;
      if (fetchingMore || current === null || current.cursor === undefined) return;
      fetchingMore = true;
      // The same staleness token every paint honours: a keystroke or reset
      // while this page is in flight orphans it, exactly as it orphans a
      // first-page response.
      const mine = token;
      const ac = new AbortController();
      inflight = ac;
      try {
        const results = await api.searchText(current.query, limit, current.cursor, ac.signal);
        if (mine !== token) return;
        painted = {
          ...current,
          // Arrival order IS the order — the server display-sorts within a page
          // and the keyset walks pages in rank order, so appending preserves
          // both. Re-sorting here would shuffle rows the user is looking at.
          hits: [...current.hits, ...results.hits],
          // The next page's cursor, or `undefined` when the stream is done —
          // which is what makes the "More" control disappear honestly.
          cursor: results.cursor,
        };
        view.setState(painted);
      } catch (e) {
        if (mine !== token) return;
        if (dispatchApiFailure(failures, e)) return;
        // Deliberately NOT `view.setState({kind:"error"})`: the results already
        // on screen are real and stay. See the interface doc — the control
        // re-arms when this promise settles, and the retry costs a click.
      } finally {
        fetchingMore = false;
      }
    },

    reset(): void {
      active = null;
      cancelPending();
      view.setState({ kind: "idle" });
    },
  };
}

// --- grouping ---------------------------------------------------------------
//
// `searchText` ranks and returns PAGES, one row per matching page. Left as-is
// that lets one verbose note own the whole list: a notebook matching on six
// pages is six rows, and everything else is pushed off the end of the limit's
// window. The note is the unit people think in ("which notebook was that in?"),
// so the client groups the pages back up under it. The group's best-ranked page
// is where the row's link lands and where its excerpt comes from; the rest
// become a count (see {@link pageSummary}) rather than a strip of destinations —
// the row opens the note with the query still running, and Next walks them.

// --- the resolved term a deep link carries (in-doc-search Phase 3, route 2) ---
//
// When a GLOBAL search matched FUZZILY, the word actually in the document is not
// the one the user typed — it is the correction. The server already tells us
// which word it was: `SearchHit.snippet` is HTML with the matched words wrapped
// in `<mark>`, and on a fuzzy hit those marks are the CORRECTED spelling. So the
// deep link into the viewer can carry that resolved term instead of the typo,
// and the in-doc find on open runs it EXACT — the corrected word really is in the
// doc — with NO in-doc fuzzy scan (the residual Pi tail this route removes). The
// query and matching are untouched; only which term the LINK carries changes.

/** Reverse the server's snippet escaping for a single marked word. Only the five
 *  entities `note_search.escapeSnippet` emits appear, and a `<mark>` body never
 *  itself contains markup, so this is the exact inverse of what produced it. */
function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&"); // last, so `&amp;lt;` restores to `&lt;`, not `<`
}

/**
 * The words a hit's snippet actually MARKED — the terms the server counted on
 * that page, in appearance order, deduped case-insensitively. On a fuzzy hit
 * these are the corrected spellings; on an exact hit they are the query's own
 * words. Empty when the snippet carried no `<mark>` (a name-only match, or a hit
 * with no excerpt).
 */
export function markedTerms(snippet: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<mark>([\s\S]*?)<\/mark>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    const term = unescapeEntities(m[1]!).trim();
    if (term === "") continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * The query a global-search HIT should deep-link the viewer's find with.
 *
 * On an EXACT search it is the typed query, verbatim — nothing to resolve. On a
 * FUZZY search it is the RESOLVED term(s) pulled from the hit's own marked
 * snippet, so the viewer opens searching the word that is really there (exact,
 * cheap) rather than re-fuzzing the typo inside the document. Falls back to the
 * typed query whenever a hit carries no usable marks — a name-only match, or a
 * snippet the server did not mark — which is the honest "search what they typed".
 */
export function deepLinkQuery(typed: string, usedFuzzy: boolean, snippet: string | undefined): string {
  if (!usedFuzzy || !snippet) return typed;
  const terms = markedTerms(snippet);
  return terms.length > 0 ? terms.join(" ") : typed;
}

/** One matching page of a note: where to jump, and the excerpt that says why. */
export interface HitPage {
  /** 0-based, exactly as {@link SearchHit.pageIndex}. */
  pageIndex: number;
  /** ⚠️ PRE-ESCAPED HTML — see {@link SearchHit.snippet}. */
  snippet: string;
}

/** A note and every page of it the query matched, best-ranked note first. */
export interface NoteHits {
  noteId: Id;
  /** PLAIN TEXT, device-authored — see {@link SearchHit.noteName}. */
  noteName: string;
  /** In the order the server ranked them; never empty. */
  pages: HitPage[];
  /**
   * What this group's {@link HitPage.pageIndex}es COUNT — a `.txt` file's
   * paragraphs (kind 1) or a `.note`'s pages (kind 0/absent). One value per
   * group because a file is one type: every hit under a given file shares it.
   * Absent reads as 0, tolerant like {@link SearchHit.kind}, so a group's items
   * open the reader unless it is emphatically a `.txt` group.
   */
  kind: number;
}

/**
 * Group page hits under their note, PRESERVING SERVER ORDER — a note takes the
 * position of its best-ranked page, and its pages keep the order they arrived
 * in. bm25 is the only ranking anything here has; re-sorting would throw it away
 * and put a client-side guess in its place.
 *
 * A repeated `(noteId, pageIndex)` collapses. The server does not emit one, but
 * a duplicate would otherwise become two chips pointing at the same page, which
 * reads as two matches.
 */
export function groupHits(hits: readonly SearchHit[]): NoteHits[] {
  const byNote = new Map<Id, NoteHits>();
  for (const hit of hits) {
    let group = byNote.get(hit.noteId);
    if (!group) {
      // `kind` is the group's, taken from the first hit that named the file —
      // tolerant, so absent/0 is a note and only exactly 1 is a `.txt`. A file
      // is one type, so later hits cannot disagree.
      group = { noteId: hit.noteId, noteName: hit.noteName, pages: [], kind: hit.kind === 1 ? 1 : 0 };
      byNote.set(hit.noteId, group);
    }
    if (group.pages.some((p) => p.pageIndex === hit.pageIndex)) continue;
    group.pages.push({ pageIndex: hit.pageIndex, snippet: hit.snippet });
  }
  return [...byNote.values()];
}

/**
 * What a result row says about how much of the note the query reached — the
 * quiet line that replaced the strip of page chips.
 *
 * ## Why this counts PAGES and not matches
 *
 * The obvious wording is "12 matches across 4 pages", and the number it needs
 * does not exist on this route. `SearchHit` is one row per matching PAGE with an
 * excerpt; only the note-scoped route (`PageMatch.matches`, what find-in-note
 * counts with) carries a tally, and asking it here would be one request per
 * result — precisely the fan-out the two-phase cost model exists to prevent.
 *
 * Counting `<mark>`s in the excerpt would produce a number, and it would be the
 * wrong one: `snippet()` marks the terms inside one small window, not the page.
 * A row claiming "3 matches" beside a find counter reading "1 of 9" for the SAME
 * query is exactly the second source of truth the one-way-authority rule forbids
 * — the count is the index's answer, and there is only ever one of it. So the row
 * says what it actually knows, and the note-wide tally is find's to give, from
 * the same query, once you are inside.
 *
 * `null` for a name-only match: there is nothing to say about pages when no page
 * matched, and "Matches on 0 pages" would make the reader parse a number to
 * learn that the title above it was the whole answer.
 *
 * Singulars are the point of the branch, not decoration — "Matches on 1 pages"
 * is the tell that a count was interpolated rather than written.
 *
 * `kind` switches the UNIT with the source type: a `.note`'s hits are PAGES, a
 * `.txt`'s are PARAGRAPHS. The wording is otherwise identical — one quiet line
 * of metadata beside the date — because the question ("how much of this file did
 * the query reach") is the same; only what a segment IS differs.
 */
export function pageSummary(pages: number, kind = 0): string | null {
  if (pages <= 0) return null;
  if (kind === 1) return `Matches in ${pages} ${pages === 1 ? "paragraph" : "paragraphs"}`;
  return `Matches on ${pages} ${pages === 1 ? "page" : "pages"}`;
}

/**
 * What the empty state says about how much of the library was searchable at all.
 *
 * "Only notes recognised on the device are searchable" is true and useless: it
 * leaves the reader unable to tell "it is not there" from "it might be there and
 * I cannot see it". `12 of your 40 notes have no recognised text` settles that.
 *
 * ABSENT COVERAGE IS NOT ZEROES. The server attaches the numbers only to a
 * zero-hit response, and only when it computed them; `null` therefore means "not
 * said", so the sentence degrades to the unquantified one rather than asserting
 * a confident "0 of your 0 notes" about a library nobody counted. `unsearchable:
 * 0` degrades too — there is nothing to warn about when everything is findable,
 * and "0 of your 40 notes have no recognised text" is a sentence that makes the
 * reader do arithmetic to learn that the answer is simply no.
 *
 * Lives here rather than in the shell so both branches are exercisable on plain
 * Node; the fake cannot express "the server did not say".
 */
export function coverageLine(coverage: Coverage | null): string {
  if (!coverage || coverage.notes <= 0 || coverage.unsearchable <= 0) {
    return "Only notes recognised on the device are searchable.";
  }
  return (
    `${coverage.unsearchable} of your ${coverage.notes} notes have no recognised text, ` +
    "so they cannot be searched by their handwriting."
  );
}
