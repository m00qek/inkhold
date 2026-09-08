// The transcript-search half of the library's search box, split out of
// library.ts the same way ocrPanel.ts is split out of reader.ts: all of the
// debounce/race/failure logic with the DOM injected as a {@link SearchView}, so
// it is exercisable on plain Node while library.ts keeps only the wiring.
//
// THE ENGINE IS INJECTED, behind `search/localSearch.ts`'s one result shape, and
// this file never reads `LocalSearch.ready`. There is one engine to read it
// about since §6 step 6, but the rule predates that and outlives it: a branch
// here on how an answer was obtained is a second rendering path, and the second
// path is the one that rots.
//
// The two things this file exists to get right:
//
//   DEBOUNCE — the query no longer leaves the machine (`golden-search.md` §4.6),
//   so a keystroke no longer wastes a REQUEST; it wastes a FRAME. The index
//   answers out of wasm, and the pathological short prefix — `con*`, a
//   1,359-term expansion over 5,642 pages — MEASURED 37.9 ms on the whole
//   library (§8.1). Seven of those on the way to "roadmap" is visible jank for
//   six answers nobody reads, so keystrokes still coalesce into one run after a
//   quiet moment. See {@link DEFAULT_DEBOUNCE_MS} for why the number moved.
//
//   STALENESS — even debounced, runs can overtake each other: a slow query for
//   "road" resolving after a fast one for "roadmap" would paint the WRONG,
//   OLDER results and leave them there, because nothing later is coming to
//   correct them. Every run therefore carries a token, and a response whose
//   token has moved on is dropped rather than painted. Same guard the reader and
//   the OCR panel use for their own paints — this is the third instance of the
//   pattern, not a new invention.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Expansion, LocalHit, LocalSearch } from "../search/localSearch";

/**
 * The floor a LIBRARY-WIDE query must clear before it is run. One or two
 * characters matches very nearly the whole index — noise on screen, and now the
 * expensive case as well (§4.6's 37.9 ms is a two-to-three character prefix) —
 * so the box simply does not fire below it. This is the GLOBAL floor ONLY:
 * in-document find (find-in-note, the `.txt` viewer's find bar) is exempt by
 * design and searches a one-character string happily — it lives in the viewers,
 * not in this controller.
 */
export const MIN_GLOBAL_QUERY_LEN = 3;

/**
 * The quiet period before a query runs, ms.
 *
 * NOT the 220 ms this box was born with. That number bought one backend FTS
 * query per PAUSE instead of one per keystroke, and there is no backend query
 * left to buy (§4.6: "the existing justification is gone and the number must not
 * be inherited silently"). What replaces it is a smaller argument for a smaller
 * number: the run is local but not free, it happens on the main thread, and its
 * worst case is a short common prefix — exactly what a box sees on the way to a
 * longer word.
 *
 * So the value is chosen to sit under the ~150 ms at which a response stops
 * reading as immediate, while still swallowing the middle of a typed burst
 * (~100 ms between keys at speed). Zero was the other candidate and is rejected
 * for the same 37.9 ms: at zero the box would run the most expensive query it
 * ever runs on every one of the first three keystrokes, and the results area
 * would flicker through three answers to questions nobody finished asking.
 */
export const DEFAULT_DEBOUNCE_MS = 120;

/**
 * What the results area can be showing. These are deliberately distinct states
 * rather than "some hits, possibly zero": "we haven't asked", "we're asking",
 * "we asked and there are none" and "the ask failed" are four different things
 * to a user, and collapsing the last three into an empty list is precisely how a
 * broken search gets mistaken for an empty one.
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
       * recency ({@link rankDocuments}). One row per document and never one per
       * page, which is what §4.3 buys by dropping excerpts.
       *
       * THE ABSENCES ARE STILL THE DESIGN: no cursor (a client holding the whole
       * index has already paid for every match, so there is nothing left to
       * spend), and no `Coverage` (nothing counts the unsearchable now that no
       * server interprets the query).
       *
       * `LocalResults.totalPages` is not carried either: it is the sum of these
       * documents' page counts, so the view would be storing a number it can
       * add up. The renderer counts what it paints.
       */
      documents: readonly LocalHit[];
      /**
       * What the typo ladder substituted, or empty when the query as typed is
       * what answered.
       *
       * NOT `usedFuzzy`. A boolean was the SERVER's shape, and it was all the
       * server could offer because the corrected word only ever existed inside
       * the marked excerpt §4.3 deletes. The client ran the expansion itself, so
       * it holds the words — and the words are the point: §4.3 gives up the
       * excerpt's at-a-glance "why", and what replaces it is the match count
       * plus, when the ladder fired, the word actually searched.
       *
       * PER TOKEN, NOT PER DOCUMENT, which is why it lives on the state beside
       * `documents` rather than on a {@link LocalHit}: one substitution explains
       * every row in the list at once. See {@link expansionNotice}.
       */
      expansions: readonly Expansion[];
    }
  | { kind: "error"; query: string };

export interface SearchView {
  setState(state: SearchState): void;
}

export interface NoteSearchDeps {
  view: SearchView;
  /**
   * The engine. One, never two — see the file header. Defaults to
   * {@link noLocalSearch} so a test about the debounce need not fake an index.
   */
  search?: LocalSearch;
  /**
   * Where UNAUTHORIZED goes. Never swallow it: an expired session that surfaced
   * as "no results" would be indistinguishable from a genuinely unmatched query,
   * which is the exact bug class the ApiFailureSink was introduced to remove.
   *
   * A LIBRARY-WIDE QUERY NO LONGER LEAVES THE MACHINE, so the sink is unlikely
   * to fire from here — an engine that answers out of wasm and IndexedDB has no
   * session to have expired. It stays because the alternative is a `catch` that
   * turns whatever a future engine throws into a results-area message, which is
   * exactly the collapse the sink exists to prevent, and because routing an
   * error it never sees costs one call.
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

/**
 * The engine a box has when nobody handed it one: never ready, and answers every
 * query with nothing.
 *
 * It exists so this controller has no `search === undefined` branch and so a
 * test that is about the debounce does not have to build an index.
 */
export const noLocalSearch: LocalSearch = {
  ready: false,
  search: (query) => Promise.resolve({ query, totalPages: 0, documents: [], expansions: [] }),
};

export function createNoteSearch(deps: NoteSearchDeps): NoteSearchController {
  const { view, failures } = deps;
  const engine = deps.search ?? noLocalSearch;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Bumped whenever the intent changes. A response is painted only if the token
   * it captured is still current, which is what makes an overtaking slow
   * response a no-op instead of a regression to older results.
   */
  let token = 0;

  /**
   * The trimmed query currently pending, running, or painted. Its job is to
   * make `setQuery` idempotent: the gallery calls it on every `input` event, and
   * events that do not change the *effective* query (typing a trailing space,
   * a re-render echoing the value back) must not cancel and re-issue a query
   * that is already on its way to answering exactly this question.
   */
  let active: string | null = null;

  /**
   * The run the current {@link token} owns, so a superseded one can be ABORTED
   * rather than merely ignored.
   *
   * Dropping a response on the token is what stops it painting; it does nothing
   * about the work itself. That mattered on the wire (a superseded request held
   * one of the browser's ~6 connections) and it still matters locally, for the
   * other half of §4.6's number: an abandoned `con*` is 37.9 ms of main thread
   * an engine that honours the signal can give back.
   */
  let inflight: AbortController | null = null;

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // Orphans anything already awaiting an answer: its captured token is stale
    // from here on, so it will drop itself when it resolves — and lets an engine
    // that watches the signal stop early, which the token alone cannot do.
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
      // Trailing whitespace is the only thing the trim is still load-bearing
      // for: the identity check below. Without it, typing a space would re-fire
      // a search for the same question. (It used to carry a second job — the
      // server read a trailing space as "this word is finished" and the prefix
      // page cost 810 ms against 80 ms completed. The query now folds through
      // the index's own tokenizer, raw, so that half is gone.)
      const query = raw.trim();
      if (query === active) return; // same question; leave the answer in progress alone
      active = query;
      cancelPending();

      if (query.length < MIN_GLOBAL_QUERY_LEN) {
        // No run at all — see `MIN_GLOBAL_QUERY_LEN`. Empty, or below the global
        // floor: a 1–2 char library-wide query is noise on screen and the
        // costliest thing the index does, so the box idles exactly as it does
        // when empty rather than searching as you type. In-doc find is not gated
        // here — it is the viewers' own, and this controller never runs it.
        view.setState({ kind: "idle" });
        return;
      }

      // Announced immediately, run later: the user gets feedback on the
      // keystroke while the engine still only sees one query per pause.
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
 * The expansions as the sentence groups them: one entry per TYPED token, in the
 * order the ladder reported them, holding the vocabulary words offered for it.
 *
 * The grouping is the whole reason this is not a flat list. `valjen` alone
 * produced TWO substitutions — `valen` and `valjean`, a genuine distance tie —
 * and the index searched them as alternatives of one another; a two-token query
 * where both words were corrected searched its groups TOGETHER. So the terms
 * inside a group are joined with "or" and the groups are not, and a flat list
 * would have to pick one connective and be wrong about the other.
 *
 * Exported for the tests that pin the wording, and shared by
 * {@link expansionNotice} and {@link deepLinkQuery} so the sentence and the link
 * cannot disagree about what a tie is.
 */
export function groupExpansions(expansions: readonly Expansion[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const e of expansions) {
    const held = groups.get(e.typed);
    // Deduped: the same substitution reported twice is one word to a reader, and
    // "matched valjean or valjean" is the sort of thing that reaches a screen.
    if (held) {
      if (!held.includes(e.matched)) held.push(e.matched);
    } else groups.set(e.typed, [e.matched]);
  }
  return groups;
}

/**
 * One piece of the expansion sentence: prose, or a vocabulary word to emphasise.
 *
 * IT IS PARTS RATHER THAN A STRING BECAUSE OF THE EMPHASIS AND THE ESCAPING, and
 * those turn out to be the same problem. §4.3's phrasing is "matched
 * **reunião**" — the substituted word is set apart, so the sentence cannot be
 * one `textContent`. The other way to get emphasis is a markup string spliced in
 * with `innerHTML`, and step 6 deleted this app's last one of those. Both halves
 * here are device-authored text (a term out of the index's own vocabulary, a
 * token out of the search box), so the renderer turns each part into a text node
 * or an element with `text:` and there is no escaping pass to get wrong.
 */
export interface ExpansionPart {
  readonly text: string;
  /** True for a word the ladder searched — the renderer sets it apart. */
  readonly matched?: boolean;
}

/**
 * What the results say about a query the typo ladder had to correct — the line
 * §7 was still missing, and the half of §4.3's replacement for the excerpt that
 * a match count cannot carry.
 *
 * ## The wording
 *
 * `Matched valjean instead of “valjaen”.` — the design's own verb, with the
 * typed token named because otherwise the sentence asserts a word the reader
 * never wrote and gives them nothing to connect it to. One uniform template per
 * group, so the tie and the multi-token case are the same sentence and not two
 * more branches:
 *
 *   Matched **valen** or **valjean** instead of “valjen”.
 *   Matched **valen** or **valjean** instead of “valjen”, and **reunião**
 *     instead of “reuniao”.
 *
 * ONLY THE TOKENS THAT FAILED APPEAR. A query where one word was exact and the
 * other was corrected reports the corrected one alone, which is exactly right:
 * the sentence explains a substitution, and there was only one.
 *
 * ## What it deliberately does not say
 *
 * NOT "no matches for …". The list underneath holds rows that matched by NAME
 * too, and those matched the typed spelling exactly — a negative about the query
 * as a whole would be contradicted by a `<mark>`ed title two lines below it.
 * This says only what was substituted, which stays true whatever else answered.
 *
 * NOT AN EXCERPT. §4.3 is emphatic, and the reason is structural rather than
 * aesthetic: producing one means the server interprets the query, which is the
 * entire cost the redesign removed. A word is free — the client did the
 * expansion itself — and a snippet is not.
 *
 * `null` when nothing was substituted, which is every query that answered as
 * typed: expansion is a FALLBACK, never a widening, so silence is the ordinary
 * case and the line appears exactly when something needs explaining.
 */
export function expansionNotice(expansions: readonly Expansion[]): ExpansionPart[] | null {
  const groups = groupExpansions(expansions);
  if (groups.size === 0) return null;

  const parts: ExpansionPart[] = [{ text: "Matched " }];
  const entries = [...groups];
  for (const [i, [typed, terms]] of entries.entries()) {
    for (const [j, term] of terms.entries()) {
      // "or", not "and": inside a group the terms are ALTERNATIVES — the ladder
      // could not separate them, so the index searched `(valen OR valjean)` and
      // a row needed only one of them.
      if (j > 0) parts.push({ text: j === terms.length - 1 ? " or " : ", " });
      parts.push({ text: term, matched: true });
    }
    parts.push({ text: ` instead of “${typed}”` });
    // Between GROUPS the relationship is the opposite one — both tokens had to
    // appear — so they are listed rather than alternated, and the pairing is
    // kept: "valen or valjean, and reunião" without the "instead of" clauses
    // would leave the reader guessing which stood in for which.
    if (i < entries.length - 1) parts.push({ text: i === entries.length - 2 ? ", and " : ", " });
  }
  parts.push({ text: "." });
  return parts;
}

// --- the query a deep link carries -------------------------------------------

/**
 * The query a global-search HIT should deep-link the viewer's find with: the
 * typed query, with any token the ladder unambiguously corrected replaced by the
 * word that was actually searched.
 *
 * ## Why this is a named function and not just `q`
 *
 * It used to resolve the word that actually matched, by reading the server's
 * marks back out of the excerpt's HTML. §4.3 drops excerpts, so that machinery
 * went with them, and for a while this carried the raw query and said so.
 *
 * ## The decision, reversed, and why the shape now carries it
 *
 * DEEP-LINK WHAT WAS SEARCHED. The old objection was that the row does not know
 * the matched term — and it does now: the CLIENT ran the expansion, so the term
 * arrives on `LocalResults.expansions` without anything having to parse a
 * snippet. That closes the note this function has been carrying ("the one place
 * that changes when the shape can carry it") and it fixes a real defect rather
 * than adding a nicety: `pdfFind.ts` states, in the contract for its own
 * `fuzzyPrompt`, that "a deep link from a global fuzzy hit already carries the
 * RESOLVED term, so it runs exact and never reaches here". With the typo in the
 * link that sentence was false in all three viewers — you clicked a row that had
 * just told you the document matched on 887 pages, and the find that opened with
 * it said "No matches" over a "search similar" opt-in.
 *
 * It also gives back the residual fuzzy scan: an exact term skips the ladder the
 * viewer would otherwise have to run again inside the document.
 *
 * ## The two things it refuses to substitute
 *
 * A TIE. `valjen` reached `valen` AND `valjean`, one edit and one character away
 * each, and the row does not say which of them this document holds. Picking the
 * first would invent a fact — and would be worse than the typo for the half of
 * the rows that hold the other word, because the viewer's own ladder recovers
 * from a typo and has no reason to expand one real word into another. So a token
 * with more than one candidate travels as typed.
 *
 * A TOKEN THE CALLER DID NOT EXPAND. The caller passes no expansions for a
 * NAME-ONLY row (see `galleryCards.resultCard`): that row matched the typed
 * spelling in its title, and the corrected word may not be in the document at
 * all, so substituting there would swap a query the reader wrote for one nothing
 * connects to what they clicked.
 *
 * The whitespace of the typed query is preserved exactly, because the tokens are
 * substituted in place rather than re-joined: `Expansion.typed` is the raw
 * whitespace-delimited token (`sqlite_core.zig` records `t.raw`), which is what
 * makes a plain token-for-token swap correct and case-preserving.
 */
export function deepLinkQuery(typed: string, expansions: readonly Expansion[] = []): string {
  if (expansions.length === 0) return typed;
  const groups = groupExpansions(expansions);
  // The capturing split keeps the separators as elements, so re-joining restores
  // the original spacing rather than normalising it.
  return typed
    .split(/(\s+)/)
    .map((token) => {
      const terms = groups.get(token);
      return terms && terms.length === 1 ? terms[0]! : token;
    })
    .join("");
}

/**
 * What a result row says about how much of the document the query reached — the
 * quiet line beside the date, where the excerpt used to be.
 *
 * ## THE RULE: this counts PAGES, and there is only ever one authority
 *
 * The obvious wording is "12 matches across 4 pages", and the number it needs
 * does not exist here — an index row is a page's term list, so a page either
 * matched or did not and a per-page tally is not a thing the count can be made
 * of. A row claiming "3 matches" beside a find counter reading "1 of 9" for the
 * SAME query is a second source of truth for one number. So the row says what it
 * actually knows, and the document-wide match tally is find's to give, from the
 * same query, once you are inside.
 *
 * ## It says so for ONE page too, now that the number is exact
 *
 * The old rule was silence below two, and every reason for it has expired. The
 * server returned one hit per document and seeked past the rest of the band, so
 * a count of one was the ordinary case and meant nothing; worse, the number only
 * ever counted hits inside the fetched window, so for a notebook the query
 * reached on three hundred pages it stated a reach the row did not know.
 * `LocalHit.pages` is every matching page of that document — one is now a fact
 * worth as much as forty, and it is the fact that separates a passing mention
 * from the notebook the query is really about.
 *
 * `null` for a name-only match: there is nothing to say about pages when no page
 * matched, and "Matches on 0 pages" would make the reader parse a number to
 * learn that the title above it was the whole answer.
 *
 * `kind` switches the UNIT with the source type: a `.note`'s hits are PAGES, a
 * `.txt`'s are PARAGRAPHS. The wording is otherwise identical — one quiet line
 * of metadata beside the date — because the question ("how much of this file did
 * the query reach") is the same; only what a segment IS differs.
 */
export function pageSummary(pages: number, kind = 0): string | null {
  if (pages < 1) return null;
  if (kind === 1) return `Matches in ${pages} ${pages === 1 ? "paragraph" : "paragraphs"}`;
  return `Matches on ${pages} ${pages === 1 ? "page" : "pages"}`;
}

/**
 * What the empty state says about how much of the library was searchable at all.
 *
 * ## Why this stopped being able to count
 *
 * It used to quantify: `12 of your 40 notes have no recognised text` settles
 * "it is not there" against "it might be there and I cannot see it", which the
 * unquantified sentence cannot. The numbers came attached to a zero-hit
 * response, and there is no longer a response — §4.3 leaves the server with no
 * query-interpreting code, so nothing counts anything at query time.
 *
 * THE SENTENCE THAT SURVIVES IS THE ONE THAT NEVER NEEDED A COUNT. Degrading to
 * it is the same call the old `null` branch made for a server that did not say:
 * better to say less than to assert a confident "0 of your 0 notes" about a
 * library nobody counted.
 *
 * The count is recoverable — a document in the listing with no terms record is
 * exactly an unsearchable one, and the client holds both — but that is a fact
 * about the INDEX rather than about a query, and `LocalSearch` deliberately
 * exposes only results. When something does expose it, this is where it lands.
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
 * ## Why this is not folded into {@link coverageLine}
 *
 * They answer opposite questions. `coverageLine` is about notes whose text will
 * never exist — the device never recognised them, and no amount of waiting
 * changes that. This is about a file whose text is *on its way*, seconds or
 * minutes out. Merging the two would tell somebody their half-minute-old upload
 * is permanently unsearchable, which is wrong and, worse, tells them to stop
 * waiting for the thing that is about to arrive.
 *
 * So the empty state says BOTH when both apply, pending first: it is the one
 * that changes what the reader should do next.
 *
 * `null` when nothing is outstanding, which is the ordinary case — the caller
 * then shows the coverage sentence alone, exactly as it did before this existed.
 */
export function pendingLine(pending: number): string | null {
  if (pending <= 0) return null;
  return `${documents(pending)} — matches in them will appear on their own.`;
}

/**
 * The quiet line over a NON-EMPTY list of results.
 *
 * THE CLAIM BEING REPAIRED IS COMPLETENESS. A list of results implies "this is
 * what there is"; while a derive is outstanding that is not true, and a reader
 * who does not know it reads a partial answer as a whole one. Anywhere the app
 * does not imply completeness — the gallery, a folder listing — silence is
 * correct and this says nothing.
 *
 * IT DID NOT RETIRE WITH THE CURSOR, and the distinction is the whole reason it
 * still exists. "More results" said the ANSWER was cut short and could be
 * resumed; a whole local index answers whole, so that control is gone. This says
 * the CORPUS is not finished yet — a document still being derived is not in the
 * manifest, so it is not in the index, so it cannot match. `pending-ness.md` is
 * explicitly still live (§0), and the live channel's `event: index` frame is
 * where the number comes from.
 *
 * Deliberately quieter than the empty state's version: over real results the
 * reader has something to be getting on with, and the line is a caveat rather
 * than an explanation.
 */
export function resultsMayGrowLine(pending: number): string | null {
  if (pending <= 0) return null;
  return `More may appear — ${documents(pending)}.`;
}
