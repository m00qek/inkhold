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
// A 200-page notebook must not mean 200 requests. It would not even fire them at
// once — browsers cap ~6 concurrent per origin on HTTP/1.1 — and our server
// threads every connection but serialises them on a coarse `db_lock`, so those
// six would contend on the same mutex the reader needs for its page bitmaps. A
// find could starve the pages being read.
//
// The way out is that the two things find shows have different costs:
//
//   COUNTS — the counter and the filmstrip badges — need only which pages match
//   and how many. That is ONE note-scoped query (`Api.searchInNote`) against the
//   FTS index that already holds per-page text, for the whole notebook.
//
//   RECTANGLES — the ovals — need `getPageText`, and only for the page actually
//   on screen. Lazy, and HTTP-immutable behind `?v={textHash}`.
//
// So a 200-page notebook costs one request plus one per page you actually look
// at. That is not an optimisation to add later; at that size it is the design.
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
import type { Hash, Id, NoteSearchBatch, PageMatch, PageRef, WordBox } from "../core/types";

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
  /** Phase 1: the page on screen is answered, the note is still being counted. */
  | { kind: "counting"; onThisPage: number; recognisedPages: number }
  /**
   * Phase 2, STREAMING (in-doc-search Phase 4). Matches are arriving in page
   * order and the note is still being drained, so `total` is a FLOOR, not the
   * final count — the counter shows it as "N+" and settles to the exact number
   * once the last batch lands. `at` steps the accumulated set; `fuzzy` is carried
   * for the same reason `settled` carries it. This is the browser-Ctrl+F shape
   * ("3 / 20+" → resolves), and a finite document always reaches the exact count.
   */
  | { kind: "streaming"; at: number; total: number; fuzzy: boolean }
  /**
   * Phase 2, SETTLED, with matches. `at` is 0-based over the now-EXACT `total`.
   *
   * `fuzzy` is the server's `usedFuzzy`: nothing matched as typed and these are
   * close matches. Carried on the state rather than held beside it because it
   * qualifies the very number being shown — `3 of 7` means something different
   * when the seven are approximate — and it is said ONCE, above the note, never
   * per match.
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
  api: Api;
  view: FindView;
  /** Where UNAUTHORIZED / STALE_PAGE go. Never swallow them here. */
  failures: ApiFailureSink;
  /** Quiet period before the note-wide count is sent, ms. Default 220. */
  debounceMs?: number;
}

export interface FindController {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** A note opened, or its metadata was refetched. Clears everything found. */
  setNote(noteId: Id | null, pages: readonly PageRef[]): void;
  /** The reader moved to a page — repaint that page's ovals. */
  setPage(index: number): void;
  /** The field changed. Cheap, idempotent, safe per keystroke. */
  setQuery(raw: string): void;
  /** Step to the next (+1) / previous (-1) match, across page boundaries. */
  step(dir: 1 | -1): void;
  /**
   * Opt IN to the typo-tolerant fallback for the current query — the response to
   * the `fuzzyPrompt` affordance. The fuzzy result was already fetched (the
   * server returns it as one no-cursor batch when the exact search is empty); it
   * was merely HELD, not displayed, so this reveals it without a new request. A
   * no-op unless a fuzzy result is currently being held.
   */
  searchSimilar(): void;
  /** Close and drop everything — a different note, or the reader closing. */
  reset(): void;
}

/**
 * Case- and accent-insensitive form. The household writes Portuguese, so
 * `avaliação` typed as `avaliacao` has to circle the word it means; the backend
 * folds the same way for its index, which is what keeps the ovals and the counts
 * describing the same matches.
 */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * The terms one word label carries, folded — the client side of the tokenizer
 * the index applies to the transcript. `unicode61` splits on everything that is
 * not a letter or a digit, so `page-range` is two terms and `Endor,` is one.
 */
function wordTerms(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The word boxes to circle, in reading order.
 *
 * ## `terms` is the answer; the query is only a guess
 *
 * When `terms` is non-null it is the server's list of what it COUNTED on this
 * page — folded index terms, from `PageMatch.terms` — and a word is circled
 * exactly when one of its own terms is in that list. An equality test, not a
 * second matching rule: the ovals are then derived from the count rather than
 * re-derived from the query.
 *
 * That distinction is the point of the whole term shape. This function used to
 * re-derive the match with a folded SUBSTRING test, independently of how the
 * server counted, and the two agreed only by luck — the client has no way to
 * reproduce the prefix `*` expansion, the tokenizer's exact folding, or which
 * near-miss a typo expanded into. That coincidence is what kept the typo
 * fallback switched off on the note-scoped route.
 *
 * ## `terms === null` is phase 1, and says so
 *
 * Before the note-wide counts land there is no server answer to derive anything
 * from, and drawing nothing would cost find the immediacy that is its whole
 * feel. So the substring guess survives HERE and only here, alongside a counter
 * that claims nothing beyond this page ("4 on this page · searching 3 pages…").
 * When the counts land both are replaced by the real answer.
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

  /** Phase 2's answer: matching pages ACCUMULATED so far, in page order. */
  let counts: PageMatch[] = [];
  /** The stream is exhausted — the count is now EXACT, not a floor. */
  let settled = false;
  /** A batch has landed (streaming or settled): the ovals derive from the server's
   *  counted terms now, not the provisional phase-1 guess. While `landedCounts` is
   *  true and `settled` is false, the note is still draining — the counter shows a
   *  floor ("N+"). Once `settled`, the count is exact. */
  let landedCounts = false;
  /** The server's `usedFuzzy` for the answer currently on screen. */
  let fuzzy = false;
  /**
   * A fuzzy fallback fetched but HELD, awaiting the opt-in (manual-fuzzy is opt-in
   * — in-doc-search Phase 3). `null` unless the `fuzzyPrompt` state is showing.
   */
  let heldFuzzy: PageMatch[] | null = null;
  /** The user opted in to fuzzy for the current query — clears on every new query. */
  let optedIn = false;
  /** Aborts the in-flight stream drain between batches when the query moves on. */
  let runAbort: AbortController | null = null;
  /** 0-based index of the current match over the whole note; -1 when there is none. */
  let at = -1;

  /** Per-note word-box cache, keyed by `textHash` so it turns over with it. */
  const wordCache = new Map<Hash, WordBox[]>();

  const recognisedPages = (): number => pages.filter((p) => p.textHash !== null).length;
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
   * What the server counted on `page` — the terms the ovals are drawn from.
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
    // Before any batch lands there is no note-wide index yet, so the first match
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
    // rest is still being counted. No total. Once a batch has landed, the batch
    // handler owns the counter (a floor or the exact settle) — paintPage must not
    // clobber it, so it only speaks before the first batch.
    if (!landedCounts) {
      view.setState({ kind: "counting", onThisPage: matched.length, recognisedPages: recognisedPages() });
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
   *
   * Runs ONCE, the first time `at` moves off -1; later batches only APPEND
   * higher-page matches (rowid ASC == page order), so `at` stays valid and the
   * reader is never yanked around as the stream drains.
   */
  function landOnFirst(): void {
    const here = firstOnPage(pageIndex);
    at = here >= 0 ? here : 0;
  }

  /**
   * Consume one streaming batch: accumulate, paint the progressive counter (a
   * floor while draining, the exact settle on the last batch), and gate the
   * typo-tolerant fallback behind the opt-in.
   */
  function applyBatch(id: Id, batch: NoteSearchBatch, mine: number): void {
    if (mine !== token) return; // a later keystroke superseded us
    if (!open || noteId !== id) return;

    // THE MANUAL-FUZZY OPT-IN (in-doc-search Phase 3, route 2). A fuzzy fallback
    // that FOUND something is not shown automatically — the user is offered
    // "search similar" and it displays only on request (`searchSimilar`). The
    // fuzzy scan already ran server-side (it is a one-shot, no-cursor batch); we
    // simply HOLD its result rather than substituting close matches for the word
    // that was typed. A fuzzy fallback that found NOTHING is a real absence — "No
    // matches", no affordance, since searching similar would find nothing either.
    if (batch.usedFuzzy && !optedIn) {
      landedCounts = true;
      counts = [];
      fuzzy = true;
      at = -1;
      view.setPageCounts(new Map());
      view.setStepEnabled(false);
      if (batch.pages.length > 0) {
        heldFuzzy = batch.pages;
        settled = false;
        view.setState({ kind: "fuzzyPrompt" });
      } else {
        heldFuzzy = null;
        settled = true;
        fuzzy = false;
        view.setState({ kind: "empty" });
      }
      void paintPage();
      return;
    }

    // EXACT, or opted-in fuzzy: accumulate and show progressively.
    landedCounts = true;
    counts = batch.pages;
    fuzzy = batch.usedFuzzy;
    view.setPageCounts(countsMap());

    const n = total();
    if (n > 0 && at < 0) landOnFirst();
    else if (n > 0) at = Math.min(at, n - 1);
    else at = -1;

    if (batch.done) {
      settled = true;
      if (n === 0) {
        view.setStepEnabled(false);
        view.setState({ kind: "empty" });
        void paintPage();
        return;
      }
      view.setStepEnabled(n > 1);
      view.setState({ kind: "settled", at, total: n, fuzzy });
    } else {
      settled = false;
      if (n === 0) {
        // Nothing matched yet but more batches are coming (a rare exact-keyset
        // case — an empty exact normally becomes the fuzzy one-shot). Keep the
        // still-counting feel rather than claiming an absence prematurely.
        view.setStepEnabled(false);
        view.setState({ kind: "counting", onThisPage: 0, recognisedPages: recognisedPages() });
        void paintPage();
        return;
      }
      view.setStepEnabled(n > 1);
      view.setState({ kind: "streaming", at, total: n, fuzzy });
    }

    // Navigate to the landed match's page if it is not the one on screen (only
    // ever true on the first landing); otherwise repaint this page's ovals in
    // place. `showPage` returns through `setPage`, which repaints — not an extra.
    const where = locate(at);
    if (where && where.pageIndex !== pageIndex) view.showPage(where.pageIndex);
    else void paintPage();
  }

  /** Phase 2: the note-scoped STREAMING drain — each batch is a separate request
   *  (a separate small db-lock window, the single-core fairness win), consumed as
   *  it lands so the counter shows a floor and settles to exact. */
  async function runStream(id: Id, q: string, mine: number): Promise<void> {
    const ac = new AbortController();
    runAbort = ac;
    try {
      await api.searchInNoteStream(id, q, (batch) => applyBatch(id, batch, mine), ac.signal);
    } catch (e) {
      if (mine !== token) return;
      // A dead session / stale page belongs to the shell. Anything else is a real
      // failure of this search, distinct from an empty result.
      if (dispatchApiFailure(failures, e)) return;
      view.setState({ kind: "error" });
    }
  }

  /** The opt-in: reveal the held fuzzy result as a settled, approximate answer.
   *  No new request — the fuzzy batch was already fetched, only held back. */
  function searchSimilar(): void {
    if (heldFuzzy === null || !open) return;
    optedIn = true;
    counts = heldFuzzy;
    heldFuzzy = null;
    fuzzy = true;
    settled = true;
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
    // Stop draining a superseded stream between batches — a giant document must
    // not keep fetching for a query nobody is looking at any more.
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
    settled = false;
    landedCounts = false;
    fuzzy = false;
    heldFuzzy = null;
    optedIn = false;
    at = -1;

    // `textHash` GATES THE WHOLE FEATURE, and it costs no request to check: it
    // is already on `NoteMeta.pages`, non-null exactly where a page has
    // recognition. A note with none says so, rather than reporting an absence of
    // matches that would imply a search took place.
    if (noteId !== null && pages.length > 0 && recognisedPages() === 0) {
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
    view.setState({ kind: "counting", onThisPage: 0, recognisedPages: recognisedPages() });
    void paintPage();

    // PHASE 2, debounced: one request for the whole notebook. Debounced for the
    // same reason the library's search is — seven keystrokes for one intent is
    // six queries already obsolete when they land.
    const id = noteId;
    if (id === null) return;
    const mine = token;
    timer = setTimeout(() => {
      timer = undefined;
      void runStream(id, q, mine);
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

    setNote(id: Id | null, next: readonly PageRef[]): void {
      const changed = id !== noteId;
      noteId = id;
      pages = next;
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
      // SETTLED wraps over the exact set; STREAMING clamps within the accumulated
      // set — wrapping over a floor would step onto a match the "N+" only promised
      // MIGHT exist. The background drain keeps extending the set, and prev/next
      // stepping past what is loaded simply holds at the last loaded match until
      // the next batch (which auto-continues) grows it — the fetch-ahead the plan
      // asks for, delivered by the drain that is already running.
      at = settled ? (at + dir + n) % n : Math.max(0, Math.min(n - 1, at + dir));
      view.setState({ kind: settled ? "settled" : "streaming", at, total: n, fuzzy });
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
      pages = [];
      pageIndex = 0;
      active = null;
      query = "";
      counts = [];
      settled = false;
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
