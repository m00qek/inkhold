// Find-in-PDF's brain, split out of pdfViewer.ts the way findInNote.ts is out of
// reader.ts and txtFind.ts is out of txtViewer.ts: the fetch/debounce/staleness
// logic with the DOM injected, so it is exercisable on plain Node.
//
// A THIRD FIND CONTROLLER, ON PURPOSE. Find-controller UNIFICATION is a
// settled won't-do: the three share a SHAPE — an in-document query, terms
// as the one-way authority for what to mark, prev/next stepping, an exact count
// — and nothing of their mechanism.
//
//   `.note`  the device's word rectangles, in millimetres, drawn as ovals
//   `.txt`   a byte range in a blob that IS the display, marked in the DOM
//   `.pdf`   words the browser's own renderer locates, in the page's points
//
// ============================================================================
// THE DIVISION OF LABOUR, WHICH IS THE WHOLE FEATURE
// ============================================================================
//
// THE INDEX decides what matched — the browser's own, over the document's
// `text/<md5>` loaded into the same wasm FTS5 instance the library search uses.
// It answers, per page, the match COUNT and the folded TERMS counted. This file
// is a LOCATOR: it asks MuPDF where those terms sit on the page in front of it
// and draws a mark. It never decides membership, and two things follow that are
// easy to undo by accident:
//
//   1. THE COUNT IS THE INDEX'S. It is never derived from the boxes drawn.
//   2. A PAGE THE LOCATOR CANNOT PLACE A BOX ON STAYS A MATCH, with no box.
//      SQLite's `unicode61 remove_diacritics 2` and a PDF's own text can
//      legitimately disagree — hyphenation across a line break, a ligature, a
//      word split across two content streams — so this WILL happen. "No matches"
//      would be a confident false statement about a document that does contain
//      the word. The counter is the index's; the boxes are best-effort.
//
// Locating the already-folded TERM rather than the user's raw query shrinks that
// window a long way.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Id } from "../core/types";
import type { DocSearch, DocSearchResult } from "../search/docSearch";
import type { PdfWord } from "../render/pdfWire";
import { fold, words } from "../search/fold";

/**
 * One matching page: the count the counter sums and the terms the marks are
 * located from — `docSearch.ts`'s record in this viewer's vocabulary.
 */
interface FindPage {
  readonly pageIndex: number;
  readonly matches: number;
  readonly terms: readonly string[];
}

/** `docSearch.ts`'s answer in this viewer's vocabulary: a PDF segment ordinal IS
 *  a page, so the format difference is data rather than a branch. */
function toPages(result: DocSearchResult): FindPage[] {
  return result.segments.map((s) => ({ pageIndex: s.segment, matches: s.matches, terms: s.terms }));
}

/**
 * The word boxes to mark on one page, in reading order.
 *
 * `terms` is the index's list of what it COUNTED on this page — folded terms,
 * named from the page's own text by `docSearch.ts` — and a run is marked exactly
 * when one of its own terms is in that list. An equality test, not a second
 * matching rule.
 *
 * AN EMPTY RESULT IS NOT AN ABSENCE OF MATCHES. It means this side could not
 * name them, which the caller must not turn into "No matches" — see the header.
 */
export function matchWords(boxes: readonly PdfWord[], terms: readonly string[]): PdfWord[] {
  if (terms.length === 0) return [];
  const wanted = new Set(terms.map(fold));
  return boxes.filter((w) => words(w.t).some((t) => wanted.has(t)));
}

/**
 * What the find bar's counter can be showing. Distinct states rather than "some
 * matches, possibly none", because the differences are what the copy turns on.
 *
 * NO `unrecognised` HERE, unlike the reader — which gets that state for free off
 * `textHash`, a flag a PDF has no equivalent of on this side. A document whose
 * text has not been derived yet 404s on `text/<md5>` and reaches `error` rather
 * than `empty`, so a freshly uploaded book reads as "couldn't search this file"
 * rather than as an absence of matches.
 */
export type PdfFindState =
  /** The field is empty. Nothing was asked and nothing is claimed. */
  | { kind: "idle" }
  /**
   * The query is in flight. NO TOTAL, deliberately: a number that quietly
   * revises itself is how a search loses trust, and unlike the reader this
   * viewer has no cheap local answer to show meanwhile — a PDF page's words cost
   * a structured-text run of the page.
   */
  | { kind: "counting" }
  /**
   * SETTLED, with matches. `at` is 0-based over the EXACT `total`; there is no
   * floor state, because the answer comes from a local index in one call.
   */
  | { kind: "settled"; at: number; total: number; fuzzy: boolean }
  /**
   * The exact search found nothing, but the typo ladder found close matches —
   * offered as opt-in rather than shown automatically, exactly as the other two
   * viewers offer it. A deep link from a global fuzzy hit already carries the
   * RESOLVED term, so it runs exact and never reaches here.
   */
  | { kind: "fuzzyPrompt" }
  /** The document WAS searched — this is a real absence. */
  | { kind: "empty" }
  | { kind: "error" };

export interface PdfFindView {
  /** Reveal/hide the bar and set the toggle's `aria-pressed`. */
  setOpen(open: boolean): void;
  /** Paint the counter. */
  setState(state: PdfFindState): void;
  /**
   * Mark the located words on the page ON SCREEN. `current` indexes into
   * `words`, or is -1 when the current match is not on this page (or there is
   * none). An empty list means "nothing to point at here", NEVER "no matches" —
   * the counter is set separately and by the server's numbers.
   */
  setPageMarks(words: PdfWord[], current: number): void;
  /**
   * Filmstrip badges, keyed by 0-based page index. Empty clears them.
   *
   * The counts are the INDEX's, not the locator's: a page the index matched but
   * whose words this side could not place still carries its number. Deriving the
   * badge from the marks would quietly turn an unplaceable match into a page
   * with no matches.
   */
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

export interface PdfFindDeps {
  /**
   * The one in-document search, shared with the reader and the `.txt` viewer so
   * the wasm instance and its built index are one per session.
   */
  docs: DocSearch;
  view: PdfFindView;
  /**
   * The words on one page of the open document, in the page's display space.
   *
   * INJECTED rather than reached for, because the honesty rule's whole test is
   * "what happens when this comes back without the term on it", which needs to
   * be stageable. It must resolve to `[]` rather than reject for a page it
   * cannot read: an unreadable page is a page with no boxes, not a broken find.
   */
  words: (page: number) => Promise<PdfWord[]>;
  /** Where UNAUTHORIZED / STALE_PAGE go. Never swallow them here. */
  failures: ApiFailureSink;
  /** Quiet period before the document-wide count is asked for, ms. Default 220. */
  debounceMs?: number;
}

export interface PdfFindController {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /**
   * A document opened, or was replaced. Clears everything found.
   *
   * `md5` is what the search is keyed by — `NoteMeta.fileHash`, which a version
   * preview has already rewritten to the retained blob's own md5. That is why
   * neither `historyScope` nor `binScope` reroutes anything here: history and
   * bin are not special, they are other md5s.
   */
  setDocument(noteId: Id | null, md5: string | null): void;
  /** The viewer moved to a page — repaint that page's marks. */
  setPage(index: number): void;
  /** The field changed. Cheap, idempotent, safe per keystroke. */
  setQuery(raw: string): void;
  /** The page was re-rastered (zoom, a panel toggle) — the marks must follow. */
  repaint(): void;
  /** Step to the next (+1) / previous (-1) match, across page boundaries. */
  step(dir: 1 | -1): void;
  /** Opt IN to the typo-tolerant fallback for the current query. Nothing is asked
   *  again: the ladder's answer was already computed and merely HELD. */
  searchSimilar(): void;
  /** The query currently running — what the address bar publishes. */
  query(): string;
  /** Close and drop everything — a different document, or the viewer hiding. */
  reset(): void;
  /**
   * This document's words on `page`, from the one cache — find's marks and the
   * text selection are two readers of the same structured-text run.
   *
   * CALL IT ON INTENT, not on every page turn: a miss RUNS the page through
   * MuPDF's structured-text device, which pulls every font and content stream it
   * references. A hit is free.
   */
  wordsFor(page: number): Promise<PdfWord[]>;
  /** The same words if they have already landed, else null — for a caller that
   *  cannot await. The array is stable across calls. */
  wordsKnown(page: number): PdfWord[] | null;
}

export function createPdfFindController(deps: PdfFindDeps): PdfFindController {
  const { view, failures } = deps;
  const debounceMs = deps.debounceMs ?? 220;

  let open = false;
  let noteId: Id | null = null;
  /** The blob this find searches — `NoteMeta.fileHash`, already rewritten to the
   *  retained version's md5 by a history/bin preview. */
  let docMd5: string | null = null;
  let pageIndex = 0;

  /** The trimmed query pending, in flight, or painted. Makes `setQuery` idempotent. */
  let active: string | null = null;
  let query = "";

  let timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Bumped whenever the intent changes. A response is painted only if its
   * captured token is still current — the same guard the reader's find and the
   * library search use, and the reason an overtaking slow response is a no-op.
   */
  let token = 0;

  /** The index's answer: matching pages, in page order. Complete when it lands. */
  let counts: FindPage[] = [];
  /** The answer has landed, so there is something to derive marks from. */
  let landedCounts = false;
  /** Whether the answer on screen came from the typo ladder. */
  let fuzzy = false;
  /** A fuzzy fallback computed but HELD, awaiting the opt-in. */
  let heldFuzzy: FindPage[] | null = null;
  /** The user opted in to fuzzy for the current query — clears on every new query. */
  let optedIn = false;
  /** Aborts the in-flight `text/<md5>` fetch when the query moves on. */
  let runAbort: AbortController | null = null;
  /** 0-based index of the current match over the whole document; -1 when none. */
  let at = -1;

  /**
   * THE document's word cache, keyed by page — find's and the selection's both,
   * because they want the same words of the same page.
   *
   * NOT AN OPTIMISATION. A page's words cost a structured-text run of that page,
   * which on a range-served book is the same class of work as rendering it, and
   * find repaints on every keystroke, step and zoom. Cleared with the document,
   * because that is the only thing that can invalidate it: a PDF blob is
   * immutable.
   *
   * THE PROMISE IS WHAT IS CACHED, so a second caller arriving while the first
   * is still in flight JOINS it rather than running the page twice — which is
   * what a `pointerenter` immediately followed by a `pointerdown` does.
   */
  const wordCache = new Map<number, Promise<PdfWord[]>>();
  /**
   * What has already settled, for the one caller that cannot await: the
   * selection layer is repainted synchronously out of `paint()`.
   *
   * The SAME ARRAY INSTANCE every time, which is load-bearing — the layer reads
   * a different array as a different page and drops what is selected, so a fresh
   * one per repaint would clear the selection on every zoom step.
   */
  const settledWords = new Map<number, PdfWord[]>();

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

  /** What the index counted on `page`, or null before the answer has landed. */
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

  /** The badges follow `counts`, so this is called wherever `counts` moves. */
  function publishCounts(): void {
    view.setPageCounts(countsMap());
  }

  function clearPainted(): void {
    view.setPageMarks([], -1);
    view.setPageCounts(new Map());
    view.setStepEnabled(false);
  }

  /** The words on `page`, cached. A page that will not read is a page with no
   *  boxes — never an error that reaches the counter. */
  function wordsFor(page: number): Promise<PdfWord[]> {
    let held = wordCache.get(page);
    if (held === undefined) {
      held = deps
        .words(page)
        .catch((): PdfWord[] => [])
        .then((got) => {
          settledWords.set(page, got);
          return got;
        });
      wordCache.set(page, held);
    }
    return held;
  }

  function forgetWords(): void {
    wordCache.clear();
    settledWords.clear();
  }

  /**
   * Repaint the marks for the page on screen. Idempotent, and safe to call from
   * every path that changes what is displayed.
   *
   * NOTHING HERE TOUCHES THE COUNTER. That is the honesty rule as code: this
   * function's only outputs are boxes, so a page it can name nothing on paints
   * nothing and the count above it is untouched.
   */
  async function paintPage(): Promise<void> {
    const terms = termsOn(pageIndex);
    if (!open || noteId === null || query === "" || terms === null) {
      view.setPageMarks([], -1);
      return;
    }
    const mine = token;
    const page = pageIndex;
    const words = await wordsFor(page);
    // Paging fast, or typing on, must never draw page N's marks over page M.
    if (mine !== token || !open || pageIndex !== page) return;

    const matched = matchWords(words, terms);
    let current = -1;
    if (matched.length > 0) {
      const where = locate(at);
      // `Math.min` because the index's count and the boxes this side can name are
      // allowed to differ — the index counted 3 on this page and we located 2, so
      // match index 2 marks the last box we have rather than none.
      if (where && where.pageIndex === page) current = Math.min(where.within, matched.length - 1);
    }
    view.setPageMarks(matched, current);
  }

  /**
   * WHERE FIND LANDS the first time matches appear — the reader's rule verbatim:
   *
   *  - THIS PAGE HAS MATCHES: keep the one already there, rather than turning the
   *    page out from under someone who has started reading it;
   *  - IT HAS NONE: go to the document's first match.
   */
  function landOnFirst(): void {
    const here = firstOnPage(pageIndex);
    at = here >= 0 ? here : 0;
  }

  /** Take the index's answer: paint the exact counter, and gate the typo-tolerant
   *  fallback behind the opt-in. */
  function applyResult(id: Id, result: DocSearchResult, mine: number): void {
    if (mine !== token) return; // a later keystroke superseded us
    if (!open || noteId !== id) return;

    // THE MANUAL-FUZZY OPT-IN, the same gate the other two viewers hold: a fuzzy
    // fallback that FOUND something is offered as "search similar" and displays
    // only on request. The ladder has already run (`idx_fuzzy` fires it only on
    // a total of 0); only the DISPLAY is gated.
    if (result.usedFuzzy && !optedIn) {
      landedCounts = true;
      counts = [];
      publishCounts();
      fuzzy = true;
      at = -1;
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

    landedCounts = true;
    counts = toPages(result);
    publishCounts();
    fuzzy = result.usedFuzzy;

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
    // otherwise repaint in place. `showPage` returns through `setPage`, which
    // repaints — not an extra.
    const where = locate(at);
    if (where && where.pageIndex !== pageIndex) view.showPage(where.pageIndex);
    else void paintPage();
  }

  /**
   * The document-wide count, from the browser's own index.
   *
   * The FIRST find on a book pays `text/<md5>` plus the index build; every find
   * after that is the query alone, because `docSearch.ts` keeps the built index
   * and the response is HTTP-immutable. Measured: a 1,703-segment planner builds
   * in 48 ms, Les Misérables in 363 ms. The abort covers the fetch; the build
   * and the query are not abortable and should not be — they are the same work
   * the next keystroke needs, and a superseded answer is dropped by its token.
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
      // a document whose text is not derived yet — is a real failure of this
      // search, which is distinct from an empty result and must say so.
      if (dispatchApiFailure(failures, e)) return;
      view.setState({ kind: "error" });
    }
  }

  /** The opt-in: reveal the held fuzzy result as a settled, approximate answer. */
  function searchSimilar(): void {
    if (heldFuzzy === null || !open) return;
    optedIn = true;
    counts = heldFuzzy;
    publishCounts();
    heldFuzzy = null;
    fuzzy = true;
    landedCounts = true;

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
    // Stop a superseded `text/<md5>` fetch — a 1,450-page book must not keep
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

    if (q === "") {
      clearPainted();
      view.setState({ kind: "idle" });
      return;
    }

    clearPainted();
    view.setState({ kind: "counting" });

    // STILL DEBOUNCED even though the query is local: the FIRST find on a
    // document is a fetch plus a build, and firing that per keystroke would
    // download and index the book seven times for one intent. A document with no
    // content address cannot be searched — the route is keyed by md5.
    const id = noteId;
    const md5 = docMd5;
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
    // Ctrl+F on an already-open bar re-focuses rather than closing, which is what
    // every other find bar does — including the other two here.
    view.focusField();
    // OPENING THE BAR FETCHES NOTHING — peeking is free. This re-run is a pure
    // state refresh for an empty field, and re-paints an existing query otherwise.
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
    query: () => query,

    setDocument(id: Id | null, md5: string | null): void {
      const changed = id !== noteId || md5 !== docMd5;
      noteId = id;
      docMd5 = md5;
      if (changed) {
        pageIndex = 0;
        // A different document has different pages AND a different page 0.
        forgetWords();
      }
      if (open) runQuery(query);
    },

    setPage(index: number): void {
      pageIndex = index;
      if (open) void paintPage();
    },

    wordsFor,
    wordsKnown: (page) => settledWords.get(page) ?? null,

    setQuery(raw: string): void {
      const q = raw.trim();
      if (q === active) return; // same question; leave the answer in progress alone
      active = q;
      runQuery(raw);
    },

    repaint(): void {
      if (open) void paintPage();
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
      // what makes it a document-wide find rather than a page one. The viewer
      // answers `showPage` by calling `setPage`, which repaints.
      if (where.pageIndex !== pageIndex) view.showPage(where.pageIndex);
      else void paintPage();
    },

    searchSimilar,

    reset(): void {
      open = false;
      noteId = null;
      docMd5 = null;
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
      forgetWords();
      view.setOpen(false);
      clearPainted();
      view.setState({ kind: "idle" });
    },
  };
}

/**
 * What the counter says.
 *
 * `counting` shows NO TOTAL, and every state that reports a number reports the
 * INDEX's. There is deliberately no wording for "the page matched but we could
 * not point at it" — that page is simply a match with nothing drawn, and saying
 * anything about it would be explaining an implementation detail to somebody
 * reading a book.
 */
export function pdfCountText(state: PdfFindState): string {
  switch (state.kind) {
    case "idle":
      return "";
    case "counting":
      return "Searching…";
    case "settled":
      return `${state.at + 1} of ${state.total}`;
    case "fuzzyPrompt":
      return "No matches";
    case "empty":
      return "No matches";
    case "error":
      return "Couldn't search this file. Keep typing to retry.";
  }
}

/** The dimmer treatment: every state that is not a live count of matches. */
export function pdfCountIsNone(state: PdfFindState): boolean {
  return state.kind !== "settled" && state.kind !== "idle";
}
