// Find-in-note's brain, split out of reader.ts the same way ocrPanel.ts and
// noteSearch.ts are: all of the fetch/debounce/staleness logic with the DOM
// injected as a {@link FindView}, so it is exercisable on plain Node while
// reader.ts keeps only the wiring.
//
// Universal search answers WHICH NOTE. Find answers WHERE ON THIS PAGE — and it
// can, because the device's recognition carries a rectangle per word.
//
// ============================================================================
// TWO PHASES, BECAUSE THEY COST DIFFERENT THINGS
// ============================================================================
//
// The two things find shows come from different places, and only one of them is
// a search:
//
//   COUNTS — the counter and the filmstrip badges — are the BROWSER's answer.
//   §1.1: one document's text is loaded into the same wasm
//   FTS5 instance the library search uses and asked the same `idx_query`. The
//   text arrives as `text/<md5>` on the FIRST FIND (§4.1) — never on open,
//   because reading a note needs the renderer and not a text index — and is
//   HTTP-immutable, so every later find on it costs nothing.
//
//   RECTANGLES — the ovals — need `getPageText`, and only for the page actually
//   on screen. Lazy, and HTTP-immutable behind `?v={textHash}`.
//
// So a 200-page notebook costs ONE text fetch plus one page-text request per
// page you actually look at, and the notebook-wide count is then computed
// locally on every keystroke.
//
// The note-scoped SERVER route this used to call is gone (§6 step 7), and with
// it the reason the phases were split the way they were: the server threaded
// every connection but serialised them on a coarse `db_lock`, so a find could
// starve the pages being read. Nothing here contends with anything any more.
//
// ============================================================================
// WHAT THE INTERMEDIATE STATE MUST NOT SAY
// ============================================================================
//
// While the counts are outstanding the state is `counting`, and it carries NO
// TOTAL — only how many matched on the page in front of you. `1 of 12` is a
// claim about the whole note, and a total that quietly revises itself is how a
// search loses trust. "4 on this page, still counting 12 pages" is both true and
// more useful than a number about to change.
//
// ============================================================================
// WHERE SETTLING LANDS
// ============================================================================
//
// Two halves of one rule, and they pull in opposite directions on purpose:
//
//   - the page on screen HAS matches: the highlighted one is KEPT, rather than
//     the page being jumped out from under someone who has started reading it;
//   - the page on screen has NONE: the reader GOES to the first match's page.
//
// The second half was missing, and without it the counter said `1 of 1`, the
// filmstrip badged a page you were not on, nothing was circled, and Next had
// nowhere to step. Every part individually right and the feature broken. There
// is nothing to preserve in that case — no match on this page to be taken away
// from — so the two halves do not actually conflict.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Api } from "../api/types";
import type { Hash, Id, PageRef, WordBox } from "../core/types";
import type { DocSearch, DocSearchResult } from "../search/docSearch";
// The client's imitation of the index's tokenizer, shared with `pdfFind.ts`,
// `txtFind.ts` and `docSearch.ts` so the ovals and the counts cannot come to
// disagree about what a word is (§8.2). Aliased because
// `matchWords` already binds `words` to the boxes it is filtering.
import { fold, words as wordTerms } from "../search/fold";

/**
 * One matching page: the count the counter sums and the terms the ovals are
 * drawn from — `docSearch.ts`'s record, in the reader's own vocabulary
 * (`pageIndex`, because a `.note` segment ordinal IS a page).
 *
 * Declared here rather than shared: the seam's own match shape was the shape of
 * a SERVER response, and it went with the routes — this controller reads none.
 * The fields are the same because the meaning is.
 */
interface FindPage {
  readonly pageIndex: number;
  readonly matches: number;
  readonly terms: readonly string[];
}

/** `docSearch.ts`'s answer in the reader's vocabulary. */
function toPages(result: DocSearchResult): FindPage[] {
  return result.segments.map((s) => ({ pageIndex: s.segment, matches: s.matches, terms: s.terms }));
}

/**
 * What the find bar's counter can be showing. Distinct states rather than "some
 * matches, possibly none", because the differences are what the copy turns on:
 *
 *  - `unrecognised` is NOT `empty`. A word the device never recognised is
 *    invisible to find even though it is plainly on the page, so a note with no
 *    recognition says "Not recognised on the device" — never "No matches", which
 *    would claim a search happened.
 *  - `counting` is not `settled` with a provisional number. See the file header.
 *  - `error` is not `empty`, for the reason it never is: a failed search that
 *    renders as an empty one is indistinguishable from a query nobody wrote
 *    about.
 */
export type FindState =
  /** The field is empty. Nothing was asked and nothing is claimed. */
  | { kind: "idle" }
  /** No page of this note carries recognition, so there is nothing to search. */
  | { kind: "unrecognised" }
  /**
   * Phase 1: the page on screen is answered, the note is still being counted.
   *
   * `recognisedPages` is `null` while the reader is still on the SKELETON page
   * list, where the count is not merely zero but UNKNOWN — see
   * {@link FindController.setNote}. The counter then says "searching…" with no
   * number rather than "searching 0 pages…", which would be a claim.
   */
  | { kind: "counting"; onThisPage: number; recognisedPages: number | null }
  /**
   * Phase 2, SETTLED, with matches. `at` is 0-based over the EXACT `total`.
   *
   * THERE IS NO FLOOR STATE, and its absence is the shape of the new mechanism
   * rather than a simplification of the old one: the answer comes from a local
   * index in one call, so there are no batches to accumulate and no "N+" that
   * later resolves. What is still progressive is the WAIT — see `counting`.
   *
   * `fuzzy` says nothing matched as typed and these are close matches. Carried on
   * the state rather than held beside it because it qualifies the very number
   * being shown — `3 of 7` means something different when the seven are
   * approximate — and it is said ONCE, above the note, never per match.
   */
  | { kind: "settled"; at: number; total: number; fuzzy: boolean }
  /**
   * The exact search found nothing, but a TYPO-TOLERANT search would find close
   * matches — offered as opt-in (in-doc-search Phase 3, route 2) rather than
   * shown automatically. The affordance ("No matches — search similar?") fires
   * {@link FindController.searchSimilar} on request. Manual in-viewer fuzzy is
   * the one path this gates; a deep link from a global fuzzy hit already carries
   * the RESOLVED term, so it runs exact and never reaches here.
   */
  | { kind: "fuzzyPrompt" }
  /** Phase 2, with none. The note WAS searched — this is a real absence. */
  | { kind: "empty" }
  | { kind: "error" };

export interface FindView {
  /** Reveal/hide the bar and set the toggle's `aria-pressed`. */
  setOpen(open: boolean): void;
  /** Paint the counter. */
  setState(state: FindState): void;
  /**
   * Draw the ovals for the page ON SCREEN. `current` indexes into `words`, or is
   * -1 when the current match is not on this page (or there is none).
   */
  setPageMatches(words: WordBox[], current: number): void;
  /** Filmstrip badges, keyed by 0-based page index. Empty clears them. */
  setPageCounts(counts: ReadonlyMap<number, number>): void;
  /** Stepping crossed a page boundary — turn the page as it goes. */
  showPage(index: number): void;
  /**
   * Whether prev/next can be pressed. FALSE UNTIL THE COUNTS LAND: stepping
   * through a set whose size is not yet known would step through the wrong set.
   */
  setStepEnabled(enabled: boolean): void;
  /** Put the caret in the field (opening the bar, and Ctrl+F while already open). */
  focusField(): void;
}

export interface FindDeps {
  /** Still the API, but ONLY for `getPageText` — the ovals. No search route. */
  api: Api;
  /**
   * The one in-document search (§1.1). Shared with the `.txt` and `.pdf` viewers
   * so the wasm instance and its built index are one per session, not one per
   * viewer — §8.1's "documents do not stack" is a property of reusing it.
   */
  docs: DocSearch;
  view: FindView;
  /** Where UNAUTHORIZED / STALE_PAGE go. Never swallow them here. */
  failures: ApiFailureSink;
  /** Quiet period before the note-wide count is asked for, ms. Default 220. */
  debounceMs?: number;
}

export interface FindController {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /**
   * A note opened, or its metadata was refetched. Clears everything found.
   *
   * `recognitionKnown` says whether `pages` is the AUTHORITATIVE page list. The
   * reader opens instantly from a listing summary, whose skeleton invents
   * `textHash: null` for every page it has not seen — so "no page carries
   * recognition" read off it is not a fact, it is the absence of one. Pass
   * `false` there and the "Not recognised on the device" claim is withheld until
   * the real metadata lands (a caller may still pass `true` when the LISTING's
   * own whole-note answer settles it negatively). Defaults to `true`, which is
   * right for every caller holding a real `NoteMeta`.
   *
   * `md5` IS THE ONLY THING THE SEARCH NEEDS, and that is what collapsed the
   * scope adapters (§1.1: "history and bin are not special: they are other
   * md5s"). `NoteMeta.fileHash` already carries it, and `historyScope.ts` and
   * `bin.ts` already rewrite that field for a version preview — so a preview
   * searches its own retained blob with no reroute anywhere. Null (a note with
   * no content address) leaves find inert rather than searching the wrong blob.
   */
  setNote(noteId: Id | null, md5: string | null, pages: readonly PageRef[], recognitionKnown?: boolean): void;
  /** The reader moved to a page — repaint that page's ovals. */
  setPage(index: number): void;
  /** The field changed. Cheap, idempotent, safe per keystroke. */
  setQuery(raw: string): void;
  /** Step to the next (+1) / previous (-1) match, across page boundaries. */
  step(dir: 1 | -1): void;
  /**
   * Opt IN to the typo-tolerant fallback for the current query — the response to
   * the `fuzzyPrompt` affordance. The ladder already ran (`idx_fuzzy` fires it
   * only when the query as typed matched nothing) and its answer was merely
   * HELD, not displayed, so this reveals it without asking anything again. A
   * no-op unless a fuzzy result is currently being held.
   */
  searchSimilar(): void;
  /** Close and drop everything — a different note, or the reader closing. */
  reset(): void;
}

/**
 * The word boxes to circle, in reading order.
 *
 * ## `terms` is the answer; the query is only a guess
 *
 * When `terms` is non-null it is what the index COUNTED on this page — folded
 * terms named from the page's own text by `docSearch.ts` — and a word is circled
 * exactly when one of its own terms is in that list. An equality test, not a
 * second matching rule: the ovals are then derived from the count rather than
 * re-derived from the query.
 *
 * That distinction is the point of the whole term shape. This function used to
 * re-derive the match with a folded SUBSTRING test, independently of how the
 * count was made, and the two agreed only by luck — a raw query cannot reproduce
 * the prefix `*` expansion, the tokenizer's exact folding, or which near-miss the
 * typo ladder expanded into.
 *
 * ## `terms === null` is phase 1, and says so
 *
 * Before the note-wide counts land there is no answer to derive anything from —
 * the first find on a document is waiting on `text/<md5>` and a ~40–360 ms index
 * build (§8.1) — and drawing nothing would cost find the immediacy that is its
 * whole feel. So the substring guess survives HERE and only here, alongside a
 * counter that claims nothing beyond this page ("4 on this page · searching 3
 * pages…"). When the counts land both are replaced by the real answer.
 *
 * The count is never derived from the returned boxes once the counts have
 * landed: where the device's word rectangles tokenise differently from the
 * transcript the two can still disagree, and then the count wins — the number
 * says how many the index found, the ovals show the ones that can be pointed at.
 */
export function matchWords(
  words: readonly WordBox[],
  query: string,
  terms: readonly string[] | null,
): WordBox[] {
  if (terms !== null) {
    if (terms.length === 0) return [];
    const wanted = new Set(terms.map(fold));
    return words.filter((w) => wordTerms(w.text).some((t) => wanted.has(t)));
  }
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return words.filter((w) => {
    const text = fold(w.text);
    return tokens.some((token) => text.includes(token));
  });
}

export function createFindController(deps: FindDeps): FindController {
  const { api, view, failures } = deps;
  const debounceMs = deps.debounceMs ?? 220;

  let open = false;
  let noteId: Id | null = null;
  /** The blob this find searches — `NoteMeta.fileHash`, which a version preview
   *  has already rewritten to the retained version's own md5. */
  let noteMd5: string | null = null;
  let pages: readonly PageRef[] = [];
  let pageIndex = 0;

  /** The trimmed query pending, in flight, or painted. Makes `setQuery` idempotent. */
  let active: string | null = null;
  let query = "";

  let timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Bumped whenever the intent changes. A response painted only if its captured
   * token is still current — the same guard the OCR panel and the library search
   * use, and the reason an overtaking slow response is a no-op rather than a
   * regression to older results.
   */
  let token = 0;

  /** Phase 2's answer: matching pages, in page order. Complete when it lands. */
  let counts: FindPage[] = [];
  /** The answer has landed: the ovals derive from its counted terms now, not the
   *  provisional phase-1 guess, and the count is EXACT. */
  let landedCounts = false;
  /** Whether the answer on screen came from the typo ladder. */
  let fuzzy = false;
  /**
   * A fuzzy fallback computed but HELD, awaiting the opt-in (manual-fuzzy is
   * opt-in). `null` unless the `fuzzyPrompt` state is showing.
   */
  let heldFuzzy: FindPage[] | null = null;
  /** The user opted in to fuzzy for the current query — clears on every new query. */
  let optedIn = false;
  /** Aborts the in-flight `text/<md5>` fetch when the query moves on. */
  let runAbort: AbortController | null = null;
  /** 0-based index of the current match over the whole note; -1 when there is none. */
  let at = -1;

  /** Per-note word-box cache, keyed by `textHash` so it turns over with it. */
  const wordCache = new Map<Hash, WordBox[]>();

  /**
   * Is `pages` the authoritative page list, or the reader's SKELETON? See
   * {@link FindController.setNote}. While false, "no page carries recognition"
   * is unknown rather than false, and every claim that turns on it is withheld.
   */
  let recognitionKnown = true;

  const recognisedPages = (): number => pages.filter((p) => p.textHash !== null).length;
  /** The recognised-page count, or `null` while the page list is provisional —
   *  the counter renders the two differently, because they mean different things. */
  const recognisedPagesOrNull = (): number | null => (recognitionKnown ? recognisedPages() : null);
  const total = (): number => counts.reduce((sum, p) => sum + p.matches, 0);

  /** The page of, and offset within, global match `index`. */
  function locate(index: number): { pageIndex: number; within: number } | null {
    if (index < 0) return null;
    let seen = 0;
    for (const page of counts) {
      if (index < seen + page.matches) return { pageIndex: page.pageIndex, within: index - seen };
      seen += page.matches;
    }
    return null;
  }

  /**
   * What the index counted on `page` — the terms the ovals are drawn from.
   * `null` until the counts land, which is what puts {@link matchWords} into its
   * provisional mode; an empty array afterwards means the page genuinely has
   * nothing to circle.
   */
  function termsOn(page: number): readonly string[] | null {
    if (!landedCounts) return null;
    return counts.find((p) => p.pageIndex === page)?.terms ?? [];
  }

  /** The global index of the FIRST match on `page`, or -1 if it has none. */
  function firstOnPage(page: number): number {
    let seen = 0;
    for (const p of counts) {
      if (p.pageIndex === page) return seen;
      seen += p.matches;
    }
    return -1;
  }

  function countsMap(): Map<number, number> {
    return new Map(counts.map((p) => [p.pageIndex, p.matches]));
  }

  function clearPainted(): void {
    view.setPageMatches([], -1);
    view.setPageCounts(new Map());
    view.setStepEnabled(false);
  }

  /**
   * The word boxes for one page, cached by `textHash`.
   *
   * `textHash === null` COSTS NO REQUEST — that is the whole point of it being
   * carried on `NoteMeta.pages`: a page the device never recognised is known to
   * have nothing before anything is asked.
   */
  async function wordsFor(id: Id, page: PageRef): Promise<WordBox[]> {
    if (page.textHash === null) return [];
    const cached = wordCache.get(page.textHash);
    if (cached !== undefined) return cached;
    try {
      const { words } = await api.getPageText(id, page);
      wordCache.set(page.textHash, words);
      return words;
    } catch (e) {
      // A dead session or a stale `?v=` belongs to the shell / the note metadata.
      // Anything else costs this page its ovals and nothing more — the counter
      // is a separate request and stays truthful.
      dispatchApiFailure(failures, e, id, page);
      return [];
    }
  }

  /**
   * Repaint the ovals for the page on screen. Idempotent, and safe to call from
   * every path that changes page — the pager, the filmstrip, the keyboard, a
   * STALE_PAGE refetch, and stepping.
   */
  async function paintPage(): Promise<void> {
    const id = noteId;
    const page = pages[pageIndex];
    if (!open || id === null || !page || query === "") {
      view.setPageMatches([], -1);
      return;
    }
    const mine = token;
    const words = await wordsFor(id, page);
    // Paging fast, or typing on, must never draw page N's ovals over page M.
    if (mine !== token || !open || noteId !== id || pages[pageIndex] !== page) return;

    const matched = matchWords(words, query, termsOn(pageIndex));
    // Before the answer lands there is no note-wide index yet, so the first match
    // on this page is the current one; after, only if `at` really is here.
    let current = -1;
    if (matched.length > 0) {
      if (!landedCounts) current = 0;
      else {
        const where = locate(at);
        if (where && where.pageIndex === pageIndex) current = Math.min(where.within, matched.length - 1);
      }
    }
    view.setPageMatches(matched, current);
    // Phase 1's counter says what it actually knows: this page, and that the
    // rest is still being counted. No total. Once the answer has landed,
    // `applyResult` owns the counter — paintPage must not clobber it, so it only
    // speaks beforehand.
    if (!landedCounts) {
      view.setState({ kind: "counting", onThisPage: matched.length, recognisedPages: recognisedPagesOrNull() });
    }
  }

  /**
   * WHERE FIND LANDS the first time matches appear, and the two halves are not
   * the same rule.
   *
   *  - THIS PAGE HAS MATCHES: keep the one already highlighted — settling must
   *    not turn the page out from under someone who has started reading it.
   *  - IT HAS NONE: go to the note's first match. Without this the counter read
   *    `1 of 1`, the filmstrip badged a page you were not on, nothing was
   *    circled, and Next had nowhere to step — every part right, the feature
   *    broken.
   */
  function landOnFirst(): void {
    const here = firstOnPage(pageIndex);
    at = here >= 0 ? here : 0;
  }

  /**
   * Take the index's answer: paint the exact counter, and gate the typo-tolerant
   * fallback behind the opt-in.
   */
  function applyResult(id: Id, result: DocSearchResult, mine: number): void {
    if (mine !== token) return; // a later keystroke superseded us
    if (!open || noteId !== id) return;

    // THE MANUAL-FUZZY OPT-IN. A fuzzy fallback that FOUND something is not shown
    // automatically — the user is offered "search similar" and it displays only on
    // request (`searchSimilar`). The ladder has already run (`idx_fuzzy` fires it
    // only when the query as typed matched nothing); we simply HOLD its answer
    // rather than substituting close matches for the word that was typed. A fuzzy
    // fallback that found NOTHING is a real absence — "No matches", no affordance,
    // since searching similar would find nothing either.
    if (result.usedFuzzy && !optedIn) {
      landedCounts = true;
      counts = [];
      fuzzy = true;
      at = -1;
      view.setPageCounts(new Map());
      view.setStepEnabled(false);
      const held = toPages(result);
      if (held.length > 0) {
        heldFuzzy = held;
        view.setState({ kind: "fuzzyPrompt" });
      } else {
        heldFuzzy = null;
        fuzzy = false;
        view.setState({ kind: "empty" });
      }
      void paintPage();
      return;
    }

    // EXACT, or opted-in fuzzy. One call, one complete answer.
    landedCounts = true;
    counts = toPages(result);
    fuzzy = result.usedFuzzy;
    view.setPageCounts(countsMap());

    const n = total();
    if (n > 0) landOnFirst();
    else at = -1;

    if (n === 0) {
      view.setStepEnabled(false);
      view.setState({ kind: "empty" });
      void paintPage();
      return;
    }
    view.setStepEnabled(n > 1);
    view.setState({ kind: "settled", at, total: n, fuzzy });

    // Navigate to the landed match's page if it is not the one on screen;
    // otherwise repaint this page's ovals in place. `showPage` returns through
    // `setPage`, which repaints — not an extra.
    const where = locate(at);
    if (where && where.pageIndex !== pageIndex) view.showPage(where.pageIndex);
    else void paintPage();
  }

  /**
   * Phase 2: the whole notebook, from the browser's own index.
   *
   * The FIRST find on a document pays `text/<md5>` plus the index build (39 ms at
   * 77 segments, 363 ms at the worst real document — §8.1); every find after that
   * is the query alone, because `docSearch.ts` keeps the built index and the
   * response is HTTP-immutable. The abort covers the fetch: a giant document must
   * not keep downloading for a query nobody is looking at any more. The build and
   * the query are not abortable and should not be — they are the same work the
   * next keystroke needs, and a superseded answer is dropped by its token.
   */
  async function runSearch(id: Id, md5: string, q: string, mine: number): Promise<void> {
    const ac = new AbortController();
    runAbort = ac;
    try {
      const result = await deps.docs.search(md5, q, ac.signal);
      applyResult(id, result, mine);
    } catch (e) {
      if (mine !== token) return;
      // A dead session belongs to the shell. Anything else — including a 404 from
      // a document that is not derived yet — is a real failure of this search and
      // must not render as an empty one.
      if (dispatchApiFailure(failures, e)) return;
      view.setState({ kind: "error" });
    }
  }

  /** The opt-in: reveal the held fuzzy result as a settled, approximate answer.
   *  Nothing is asked again — the ladder's answer was already computed and held. */
  function searchSimilar(): void {
    if (heldFuzzy === null || !open) return;
    optedIn = true;
    counts = heldFuzzy;
    heldFuzzy = null;
    fuzzy = true;
    landedCounts = true;
    view.setPageCounts(countsMap());

    const n = total();
    if (n === 0) {
      at = -1;
      view.setStepEnabled(false);
      view.setState({ kind: "empty" });
      void paintPage();
      return;
    }
    landOnFirst();
    view.setStepEnabled(n > 1);
    view.setState({ kind: "settled", at, total: n, fuzzy: true });
    const where = locate(at);
    if (where && where.pageIndex !== pageIndex) view.showPage(where.pageIndex);
    else void paintPage();
  }

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // Stop a superseded `text/<md5>` fetch — a giant document must not keep
    // downloading for a query nobody is looking at any more.
    runAbort?.abort();
    runAbort = null;
    // Orphans anything already awaiting a response: its captured token is stale
    // from here on, so it drops itself when it resolves.
    token++;
  }

  function runQuery(raw: string): void {
    const q = raw.trim();
    query = q;
    cancelPending();
    counts = [];
    landedCounts = false;
    fuzzy = false;
    heldFuzzy = null;
    optedIn = false;
    at = -1;

    // `textHash` GATES THE WHOLE FEATURE, and it costs no request to check: it
    // is already on `NoteMeta.pages`, non-null exactly where a page has
    // recognition. A note with none says so, rather than reporting an absence of
    // matches that would imply a search took place.
    //
    // ONLY ONCE THE PAGE LIST IS REAL, though. A `?q=` deep link primes find
    // against the reader's skeleton, whose pages all carry an invented
    // `textHash: null` — asking it here painted "Not recognised on the device"
    // about a note whose metadata was still in flight. It self-corrected when
    // the meta landed, but the false statement was what the user read meanwhile.
    // While `recognitionKnown` is false the query simply runs: phase 2 counts
    // over `text/<md5>`, which does not depend on the local page list at all, so
    // the honest answer arrives on its own.
    if (recognitionKnown && noteId !== null && pages.length > 0 && recognisedPages() === 0) {
      clearPainted();
      view.setState({ kind: "unrecognised" });
      return;
    }
    if (q === "") {
      clearPainted();
      view.setState({ kind: "idle" });
      return;
    }

    // PHASE 1, immediately: the page in front of you. This is what makes find
    // feel local while the note-wide count is still in flight.
    view.setPageCounts(new Map());
    view.setStepEnabled(false);
    view.setState({ kind: "counting", onThisPage: 0, recognisedPages: recognisedPagesOrNull() });
    void paintPage();

    // PHASE 2, debounced: the whole notebook, in one call.
    //
    // STILL DEBOUNCED even though the query is local, and §4.6's "the debounce is
    // void" does not reach here: the FIRST find on a document is a fetch plus a
    // build, and firing that per keystroke would download and index the document
    // seven times for one intent. The query itself is 1.3–11.5 ms (§8.1) and
    // would not need it.
    //
    // A note with no content address cannot be searched — the route is keyed by
    // md5 — and there is nothing to say about that beyond leaving find inert.
    const id = noteId;
    const md5 = noteMd5;
    if (id === null || md5 === null) return;
    const mine = token;
    timer = setTimeout(() => {
      timer = undefined;
      void runSearch(id, md5, q, mine);
    }, debounceMs);
  }

  function openBar(): void {
      if (!open) {
        open = true;
        view.setOpen(true);
      }
      // Ctrl+F on an already-open bar re-focuses rather than closing, which is
      // what every other find bar does.
      view.focusField();
      // OPENING THE BAR FETCHES NOTHING — peeking is free. This re-run is a
      // pure state refresh for an empty field, and re-paints an existing query
      // otherwise.
      //
      // It is UNCONDITIONAL because "this note was never recognised on the
      // device" is a fact about the NOTE, not about the query: `textHash` has
      // already said so, at no cost, so the bar can answer it before a single
      // keystroke rather than waiting to be asked a question it cannot answer.
      active = null;
      runQuery(query);
  }

  function closeBar(): void {
      if (!open) return;
      open = false;
      cancelPending();
      view.setOpen(false);
      clearPainted();
  }

  return {
    isOpen: () => open,
    open: openBar,
    close: closeBar,
    // Named functions rather than `this.close()`: the controller is routinely
    // destructured at the call site, and a `this`-dependent method breaks the
    // moment it is.
    toggle: () => (open ? closeBar() : openBar()),

    setNote(id: Id | null, md5: string | null, next: readonly PageRef[], known = true): void {
      const changed = id !== noteId;
      noteId = id;
      noteMd5 = md5;
      pages = next;
      recognitionKnown = known;
      if (changed) pageIndex = 0;
      // Always cleared: a different note has different boxes, and a metadata
      // REFETCH of the same note (the STALE_PAGE path) hands back new hashes, so
      // the cached boxes are history either way.
      wordCache.clear();
      if (open) runQuery(query);
    },

    setPage(index: number): void {
      pageIndex = index;
      if (open) void paintPage();
    },

    setQuery(raw: string): void {
      const q = raw.trim();
      if (q === active) return; // same question; leave the answer in progress alone
      active = q;
      runQuery(raw);
    },

    step(dir: 1 | -1): void {
      const n = total();
      if (!landedCounts || n === 0) return; // nothing to step through, or not knowably so yet
      // Wraps, unconditionally: the answer is complete when it lands, so there is
      // no floor to step off the end of.
      at = (at + dir + n) % n;
      view.setState({ kind: "settled", at, total: n, fuzzy });
      const where = locate(at);
      if (!where) return;
      // Stepping crosses page boundaries and turns the page as it goes — that is
      // what makes it a note-wide find rather than a page one. The reader answers
      // `showPage` by calling `setPage`, which repaints the ovals.
      if (where.pageIndex !== pageIndex) view.showPage(where.pageIndex);
      else void paintPage();
    },

    searchSimilar,

    reset(): void {
      open = false;
      noteId = null;
      noteMd5 = null;
      pages = [];
      pageIndex = 0;
      active = null;
      query = "";
      counts = [];
      landedCounts = false;
      fuzzy = false;
      heldFuzzy = null;
      optedIn = false;
      at = -1;
      cancelPending();
      wordCache.clear();
      view.setOpen(false);
      clearPainted();
      view.setState({ kind: "idle" });
    },
  };
}
