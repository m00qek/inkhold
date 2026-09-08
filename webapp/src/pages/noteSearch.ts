// The transcript-search half of the library's search box: the debounce, race
// and failure logic, with the DOM injected as a {@link SearchView} so it runs on
// plain Node while library.ts keeps only the wiring.
//
// THE ENGINE IS INJECTED and this file never reads `LocalSearch.ready`: a branch
// here on how an answer was obtained is a second rendering path, and the second
// path is the one that rots.
//
// STALENESS is the race to get right. A slow run for "road" resolving after a
// fast one for "roadmap" would paint the older results and leave them there,
// because nothing later is coming to correct them. Every run carries a token,
// and a response whose token has moved on is dropped rather than painted.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Expansion, LocalHit, LocalSearch } from "../search/localSearch";

/**
 * The floor a LIBRARY-WIDE query must clear before it runs. One or two
 * characters matches very nearly the whole index — noise on screen, and the
 * expensive case (§4.6's 37.9 ms is a two-to-three character prefix). Global
 * only: in-document find lives in the viewers and searches one character happily.
 */
export const MIN_GLOBAL_QUERY_LEN = 3;

/**
 * The quiet period before a query runs, ms.
 *
 * Not the round-trip era's 220 ms — a keystroke no longer costs a request, it
 * costs a FRAME: `con*`, a 1,359-term expansion over 5,642 pages, MEASURED
 * 37.9 ms on the whole library (§8.1). So the value sits under the ~150 ms at
 * which a response stops reading as immediate while still swallowing the middle
 * of a typed burst (~100 ms between keys). Zero was rejected for the same
 * 37.9 ms: it would run the most expensive query the box ever runs on each of
 * the first three keystrokes, flickering through three answers to questions
 * nobody finished asking.
 */
export const DEFAULT_DEBOUNCE_MS = 120;

/**
 * Four distinct states, never "some hits, possibly zero": collapsing "asking",
 * "none" and "failed" into an empty list is how a broken search gets mistaken
 * for an empty one.
 */
export type SearchState =
  /** The box is empty — no query was run and nothing is claimed. */
  | { kind: "idle" }
  | { kind: "searching"; query: string }
  | {
      kind: "results";
      query: string;
      /**
       * The ranked DOCUMENTS that matched — most matching pages first, then
       * recency ({@link rankDocuments}); one row per document, never per page
       * (§4.3). No cursor and no `Coverage`. `LocalResults.totalPages` is not
       * carried either: the renderer counts what it paints (see
       * `gallerySearch.searchCountLabel` for why the engine's total would be
       * wrong).
       */
      documents: readonly LocalHit[];
      /**
       * What the typo ladder substituted, or empty when the query as typed
       * answered. PER TOKEN, NOT PER DOCUMENT — which is why it lives beside
       * `documents` rather than on a {@link LocalHit}: one substitution explains
       * every row at once. See {@link expansionNotice}.
       */
      expansions: readonly Expansion[];
    }
  | { kind: "error"; query: string };

export interface SearchView {
  setState(state: SearchState): void;
}

export interface NoteSearchDeps {
  view: SearchView;
  /** The engine. Defaults to {@link noLocalSearch} so a debounce test need not fake an index. */
  search?: LocalSearch;
  /**
   * Where UNAUTHORIZED goes. Never swallow it: an expired session surfacing as
   * "no results" is indistinguishable from an unmatched query. A local engine is
   * unlikely to raise it, but the alternative is a `catch` that turns whatever
   * a future engine throws into a results-area message — the exact collapse the
   * sink exists to prevent.
   */
  failures: ApiFailureSink;
  /** Quiet period before a query runs, ms. Default {@link DEFAULT_DEBOUNCE_MS}. */
  debounceMs?: number;
}

export interface NoteSearchController {
  /** The search box changed. Cheap, idempotent, and safe to call per keystroke. */
  setQuery(raw: string): void;
  /** Drop the pending timer, orphan any in-flight response, and clear the view. */
  reset(): void;
}

/** The engine a box has when nobody handed it one: never ready, answers nothing. */
export const noLocalSearch: LocalSearch = {
  ready: false,
  search: (query) => Promise.resolve({ query, totalPages: 0, documents: [], expansions: [] }),
};

export function createNoteSearch(deps: NoteSearchDeps): NoteSearchController {
  const { view, failures } = deps;
  const engine = deps.search ?? noLocalSearch;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Bumped whenever the intent changes; a response paints only if its captured token is still current. */
  let token = 0;

  /**
   * The trimmed query currently pending, running, or painted. Makes `setQuery`
   * idempotent: an `input` event that does not change the effective query (a
   * trailing space, a re-render echoing the value back) must not cancel and
   * re-issue a query already on its way to answering exactly this question.
   */
  let active: string | null = null;

  /**
   * The run the current {@link token} owns, so a superseded one is ABORTED, not
   * merely ignored. The token stops a stale response painting; it does nothing
   * about the work, and an abandoned `con*` is 37.9 ms of main thread an engine
   * that honours the signal can give back.
   */
  let inflight: AbortController | null = null;

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    token++;
    inflight?.abort();
    inflight = null;
  }

  async function run(query: string, mine: number): Promise<void> {
    const ac = new AbortController();
    inflight = ac;
    try {
      const results = await engine.search(query, ac.signal);
      if (mine !== token) return; // a later keystroke superseded us — drop it
      view.setState({ kind: "results", query, documents: results.documents, expansions: results.expansions });
    } catch (e) {
      if (mine !== token) return;
      // Routed FIRST: this is what stops an expired cookie rendering as "no matches".
      if (dispatchApiFailure(failures, e)) return;
      // Everything else is recoverable — the next keystroke retries for free.
      view.setState({ kind: "error", query });
    }
  }

  return {
    setQuery(raw: string): void {
      // The trim is load-bearing for the identity check only: without it a
      // trailing space would re-fire a search for the same question.
      const query = raw.trim();
      if (query === active) return; // same question; leave the answer in progress alone
      active = query;
      cancelPending();

      if (query.length < MIN_GLOBAL_QUERY_LEN) {
        view.setState({ kind: "idle" });
        return;
      }

      // Announced immediately, run later: feedback on the keystroke while the
      // engine still sees one query per pause.
      view.setState({ kind: "searching", query });
      const mine = token;
      timer = setTimeout(() => {
        timer = undefined;
        void run(query, mine);
      }, debounceMs);
    },

    reset(): void {
      active = null;
      cancelPending();
      view.setState({ kind: "idle" });
    },
  };
}

// --- what the ladder substituted ---------------------------------------------

/**
 * The expansions grouped per TYPED token, in the order the ladder reported them.
 *
 * A group with two words is a distance TIE — `valjen` reached `valen` AND
 * `valjean`, and the index searched them as alternatives — so its terms are
 * joined with "or" while the groups themselves are not. Shared by
 * {@link expansionNotice} and {@link deepLinkQuery} so the sentence and the
 * link cannot disagree about what a tie is.
 */
export function groupExpansions(expansions: readonly Expansion[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const e of expansions) {
    const held = groups.get(e.typed);
    // Deduped: "matched valjean or valjean" is the sort of thing that reaches a screen.
    if (held) {
      if (!held.includes(e.matched)) held.push(e.matched);
    } else groups.set(e.typed, [e.matched]);
  }
  return groups;
}

/**
 * One piece of the expansion sentence: prose, or a vocabulary word to emphasise.
 *
 * Parts rather than a string because the emphasis ("matched **reunião**") rules
 * out one `textContent`, and both halves are device-authored text — a term from
 * the index's vocabulary, a token from the search box — so `innerHTML` is ruled
 * out too (step 6 deleted the app's last one). Each part becomes a text node or
 * an element with `text:`, and there is no escaping pass to get wrong.
 */
export interface ExpansionPart {
  readonly text: string;
  /** True for a word the ladder searched — the renderer sets it apart. */
  readonly matched?: boolean;
}

/**
 * What the results say about a query the typo ladder had to correct — §4.3's
 * "matched **reunião**". One template per group, so a tie and a multi-token
 * query are the same sentence:
 *
 *   Matched **valen** or **valjean** instead of “valjen”.
 *   Matched **valen** or **valjean** instead of “valjen”, and **reunião**
 *     instead of “reuniao”.
 *
 * NOT "no matches for …": the list underneath holds rows that matched by NAME,
 * with the typed spelling, and a negative about the query would be contradicted
 * by a `<mark>`ed title two lines below it. This says only what was substituted,
 * which stays true whatever else answered. `null` when nothing was.
 */
export function expansionNotice(expansions: readonly Expansion[]): ExpansionPart[] | null {
  const groups = groupExpansions(expansions);
  if (groups.size === 0) return null;

  const parts: ExpansionPart[] = [{ text: "Matched " }];
  const entries = [...groups];
  for (const [i, [typed, terms]] of entries.entries()) {
    for (const [j, term] of terms.entries()) {
      // "or" inside a group: the terms are ALTERNATIVES, a row needed only one.
      if (j > 0) parts.push({ text: j === terms.length - 1 ? " or " : ", " });
      parts.push({ text: term, matched: true });
    }
    parts.push({ text: ` instead of “${typed}”` });
    // "and" between groups: both tokens had to appear.
    if (i < entries.length - 1) parts.push({ text: i === entries.length - 2 ? ", and " : ", " });
  }
  parts.push({ text: "." });
  return parts;
}

// --- the query a deep link carries -------------------------------------------

/**
 * The query a global-search hit deep-links the viewer's find with: the typed
 * query, with each token the ladder UNAMBIGUOUSLY corrected replaced by the
 * word actually searched.
 *
 * Carrying the CORRECTED term is what fixed a live defect: with the typo in the
 * link, a row that had just said the document matched on 887 pages opened a
 * find that said "No matches" over a "search similar" opt-in, in all three
 * viewers. It also spares the viewer the residual fuzzy scan — an exact term
 * skips its ladder.
 *
 * Two refusals:
 *
 * A TIE travels as typed. `valjen` reached `valen` AND `valjean` and the row
 * does not say which this document holds; picking one invents a fact, and is
 * worse than the typo for the rows holding the other word — the viewer's ladder
 * recovers from a typo, not from one real word swapped for another.
 *
 * A NAME-ONLY row gets no expansions from its caller (`galleryCards.resultCard`):
 * it matched the typed spelling in its title, and the corrected word may not be
 * in the document at all.
 *
 * Whitespace is preserved exactly because tokens are substituted in place, not
 * re-joined: `Expansion.typed` is the raw whitespace-delimited token
 * (`sqlite_core.zig` records `t.raw`), which is what makes a plain
 * token-for-token swap correct and case-preserving.
 */
export function deepLinkQuery(typed: string, expansions: readonly Expansion[] = []): string {
  if (expansions.length === 0) return typed;
  const groups = groupExpansions(expansions);
  // The capturing split keeps the separators, so re-joining restores the spacing.
  return typed
    .split(/(\s+)/)
    .map((token) => {
      const terms = groups.get(token);
      return terms && terms.length === 1 ? terms[0]! : token;
    })
    .join("");
}

/**
 * What a result row says about how much of the document the query reached —
 * the quiet line beside the date.
 *
 * THE RULE: this counts PAGES, and there is only ever one authority for a match
 * count. An index row is a page's term list, so a page matched or did not and a
 * per-page tally does not exist here. A row claiming "3 matches" beside a find
 * counter reading "1 of 9" for the SAME query is a second source of truth for
 * one number; the document-wide tally is find's to give, once you are inside.
 *
 * `null` for a name-only match — "Matches on 0 pages" makes the reader parse a
 * number to learn the title was the whole answer.
 *
 * `kind` switches the unit with the source type: a `.note`'s hits are PAGES, a
 * `.txt`'s PARAGRAPHS.
 */
export function pageSummary(pages: number, kind = 0): string | null {
  if (pages < 1) return null;
  if (kind === 1) return `Matches in ${pages} ${pages === 1 ? "paragraph" : "paragraphs"}`;
  return `Matches on ${pages} ${pages === 1 ? "page" : "pages"}`;
}

/**
 * What the empty state says about how much of the library was searchable.
 *
 * Unquantified, because nothing counts the unsearchable at query time (§4.3
 * leaves the server with no query-interpreting code).
 */
export function coverageLine(): string {
  return "Only notes recognised on the device are searchable.";
}

/** `n document` / `n documents`, so the two sentences below agree on the noun. */
function documents(n: number): string {
  return `${n} ${n === 1 ? "document is" : "documents are"} still being indexed`;
}

/**
 * What the EMPTY state says about work that has not finished yet.
 *
 * Not folded into {@link coverageLine}, which is about text that will NEVER
 * exist: merging them would tell somebody their half-minute-old upload is
 * permanently unsearchable, and to stop waiting for the thing about to arrive.
 * When both apply the caller says both, pending first.
 */
export function pendingLine(pending: number): string | null {
  if (pending <= 0) return null;
  return `${documents(pending)} — matches in them will appear on their own.`;
}

/**
 * The quiet line over a NON-EMPTY list of results.
 *
 * IT DID NOT RETIRE WITH THE CURSOR. "More results" said the ANSWER was cut
 * short and could be resumed; a whole local index answers whole. This says the
 * CORPUS is not finished: a document still being derived is not in the manifest,
 * so not in the index, so it cannot match — and a list of results implies "this
 * is what there is". The number comes from the live channel's `event: index`
 * frame (the pending-ness work is still live, §0). Quieter than the empty state's
 * version because over real results it is a caveat, not an explanation.
 */
export function resultsMayGrowLine(pending: number): string | null {
  if (pending <= 0) return null;
  return `More may appear — ${documents(pending)}.`;
}
