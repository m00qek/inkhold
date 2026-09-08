// Find-in-PDF's brain, split out of pdfViewer.ts the way findInNote.ts is out of
// reader.ts and txtFind.ts is out of txtViewer.ts: the fetch/debounce/staleness
// logic with the DOM injected, so it is exercisable on plain Node.
//
// ============================================================================
// A THIRD FIND CONTROLLER, ON PURPOSE
// ============================================================================
//
// `code-review-2` recorded find-controller UNIFICATION as WON'T-DO when there
// were two (`STATUS.md`). This is the third, and it is a consequence of that
// decision rather than a departure from it: per-viewer controllers ARE the
// accepted pattern here, because what the three share is a SHAPE — an in-document
// query, terms as the one-way authority for what to mark, prev/next stepping, an
// exact count — and nothing of their mechanism.
//
//   `.note`  the device's word rectangles, in millimetres, drawn as ovals
//   `.txt`   a byte range in a blob that IS the display, marked in the DOM
//   `.pdf`   words the browser's own renderer locates, in the page's points
//
// A unified controller would be three mechanisms behind one interface plus the
// branches to pick between them, which is more code than three small files and
// harder to read than any of them.
//
// ============================================================================
// THE DIVISION OF LABOUR, WHICH IS THE WHOLE FEATURE
// ============================================================================
//
// THE INDEX decides what matched — now the browser's own, over the document's
// `text/<md5>` loaded into the same wasm FTS5 instance the library search uses
// (`golden-search.md` §1.1). It answers, per page, the match COUNT and the folded
// TERMS counted. This file is a LOCATOR: it asks MuPDF where those terms sit on
// the page in front of it and draws a mark.
//
// So this file never decides membership, and two things follow that are easy to
// undo by accident:
//
//   1. THE COUNT IS THE INDEX'S. It is never derived from the boxes drawn.
//   2. A PAGE THE LOCATOR CANNOT PLACE A BOX ON STAYS A MATCH, with no box.
//      SQLite's `unicode61 remove_diacritics 2` and a PDF's own text can
//      legitimately disagree — hyphenation across a line break, a ligature, a
//      word split across two content streams — so this WILL happen. "No matches"
//      would be a confident false statement about a document that does contain
//      the word, which is the exact failure `countText`'s `unrecognised` state
//      exists to prevent elsewhere. The counter is the index's; the boxes are
//      best-effort.
//
// Locating the already-folded TERM rather than the user's raw query shrinks that
// window a long way — the same move `deepLinkQuery` makes when it carries the
// corrected spelling on a fuzzy hit instead of the typo.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Id } from "../core/types";
import type { DocSearch, DocSearchResult } from "../search/docSearch";
import type { PdfWord } from "../render/pdfText";

/**
 * One matching page: the count the counter sums and the terms the marks are
 * located from — `docSearch.ts`'s record in this viewer's vocabulary.
 *
 * Declared here rather than shared: the seam's own match shape was the shape of
 * a SERVER response, and it went with the routes — this controller reads none.
 */
interface FindPage {
  readonly pageIndex: number;
  readonly matches: number;
  readonly terms: readonly string[];
}

/** `docSearch.ts`'s answer in this viewer's vocabulary. A PDF segment ordinal IS
 *  a page, which is the whole of what §1.1 means by a format difference being
 *  data rather than a branch. */
function toPages(result: DocSearchResult): FindPage[] {
  return result.segments.map((s) => ({ pageIndex: s.segment, matches: s.matches, terms: s.terms }));
}

/**
 * Case- and accent-insensitive form — the SAME fold `unicode61
 * remove_diacritics 2` applies to the index, and byte-for-byte the one
 * `findInNote.ts` and `txtFind.ts` apply. The household writes Portuguese, so
 * `avaliação` typed as `avaliacao` has to mark the word it means; the backend
 * folded the same way to COUNT it, which is what keeps the marks and the count
 * describing the same matches.
 *
 * IF THIS EVER DIVERGES FROM THE OTHER TWO the failure is silent and one-sided:
 * the count stays right and the marks quietly stop appearing, which reads as
 * "find is broken on PDFs" and points at nothing.
 */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * The terms one run carries, folded — the client side of the tokenizer the index
 * applies. `unicode61` splits on everything that is not a letter or a digit, so
 * `page-range` is two terms and `Endor,` is one.
 *
 * THIS IS WHERE MEMBERSHIP IS DECIDED, which is why the decoder's own splitting
 * need only be good enough for a BOX. `pdf_shim.c` splits on an explicit table of
 * separators; anything it glues together is pulled apart here before the
 * comparison, so a separator it does not know costs a slightly wide mark and
 * never a lost match.
 */
export function wordTerms(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
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
export function matchWords(words: readonly PdfWord[], terms: readonly string[]): PdfWord[] {
  if (terms.length === 0) return [];
  const wanted = new Set(terms.map(fold));
  return words.filter((w) => wordTerms(w.t).some((t) => wanted.has(t)));
}

/**
 * What the find bar's counter can be showing. Distinct states rather than "some
 * matches, possibly none", because the differences are what the copy turns on.
 *
 * There is no `unrecognised` here, and its absence is a decision. That state
 * exists in the reader because `textHash` answers "was this note ever recognised"
 * for free, off metadata the viewer already holds. A PDF has no such flag on this
 * side. A document whose text has not been derived yet 404s on `text/<md5>`, and
 * that reaches `error` rather than `empty` — the route deliberately cannot say
 * whether a document is underived or merely unreachable, so neither can this. A
 * freshly uploaded book therefore reads as "couldn't search this file", which is
 * honest about what happened, rather than as an absence of matches.
 */
export type PdfFindState =
  /** The field is empty. Nothing was asked and nothing is claimed. */
  | { kind: "idle" }
  /**
   * The query is in flight and no batch has landed. NO TOTAL, deliberately: a
   * number that quietly revises itself is how a search loses trust, and unlike
   * the reader this viewer has no cheap local answer to show meanwhile (the
   * reader's phase 1 is a page of word boxes it already holds; a PDF page's words
   * cost a structured-text run of the page).
   */
  | { kind: "counting" }
  /**
   * SETTLED, with matches. `at` is 0-based over the EXACT `total`.
   *
   * THERE IS NO FLOOR STATE: the answer comes from a local index in one call, so
   * there are no batches to accumulate and no "N+" that later resolves. What is
   * still progressive is the WAIT — see `counting`.
   */
  | { kind: "settled"; at: number; total: number; fuzzy: boolean }
  /**
   * The exact search found nothing, but the typo ladder found close matches —
   * offered as opt-in rather than shown automatically, exactly as the other two
   * viewers offer it. A deep link from a global fuzzy hit already
   * carries the RESOLVED term, so it runs exact and never reaches here.
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
   * whose words this side could not place still carries its number. The badge
   * answers "which pages is it on, and how often" — a question already answered
   * exactly — while the marks answer "where on this page", which is best-effort.
   * Deriving the badge from the marks would quietly turn an unplaceable match
   * into a page with no matches.
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
   * The one in-document search (§1.1). Shared with the reader and the `.txt`
   * viewer so the wasm instance and its built index are one per session.
   */
  docs: DocSearch;
  view: PdfFindView;
  /**
   * The words on one page of the open document, in the page's display space.
   *
   * INJECTED rather than reached for, because on the real path it is a message
   * to a worker holding a MuPDF instance — and because the honesty rule's whole
   * test is "what happens when this comes back without the term on it", which
   * needs to be stageable. It must resolve to `[]` rather than reject for a page
   * it cannot read: an unreadable page is a page with no boxes, not a broken find.
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
   * neither `historyScope` nor `binScope` reroutes anything here: §1.1's "history
   * and bin are not special, they are other md5s".
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
   * Per-document word cache, keyed by page.
   *
   * NOT AN OPTIMISATION — a page's words cost a structured-text run of that page,
   * which on a range-served book is the same class of work as rendering it. Find
   * repaints on every keystroke, every step and every zoom, and without this each
   * of those would re-run the page. Cleared with the document, because that is
   * the only thing that can invalidate it: a PDF blob is immutable.
   */
  const wordCache = new Map<number, PdfWord[]>();

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
  async function wordsFor(page: number): Promise<PdfWord[]> {
    const cached = wordCache.get(page);
    if (cached !== undefined) return cached;
    let words: PdfWord[];
    try {
      words = await deps.words(page);
    } catch {
      words = [];
    }
    wordCache.set(page, words);
    return words;
  }

  /**
   * Repaint the marks for the page on screen. Idempotent, and safe to call from
   * every path that changes what is displayed — the pager, the filmstrip, the
   * keyboard, a zoom, a panel toggle, and stepping.
   *
   * NOTHING HERE TOUCHES THE COUNTER. That is the honesty rule as code: this
   * function's only outputs are boxes, so a page it can name nothing on paints
   * nothing and the count above it — which is the server's — is untouched.
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
   * WHERE FIND LANDS the first time matches appear, and the two halves are not
   * the same rule — the reader's, verbatim, because the reasoning is identical:
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

    // THE MANUAL-FUZZY OPT-IN, the same gate the other two viewers hold. A fuzzy
    // fallback that FOUND something is not shown automatically — the user is
    // offered "search similar" and it displays only on request. The ladder has
    // already run (`idx_fuzzy` fires it only on a total of 0); only the DISPLAY
    // is gated.
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
   * and the response is HTTP-immutable. §8.1 measured a 1,703-segment planner at
   * 48 ms to build and Les Misérables at 363 ms. The abort covers the fetch; the
   * build and the query are not abortable and should not be — they are the same
   * work the next keystroke needs, and a superseded answer is dropped by its
   * token.
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

    // STILL DEBOUNCED even though the query is local, and §4.6's "the debounce is
    // void" does not reach here: the FIRST find on a document is a fetch plus a
    // build, and firing that per keystroke would download and index the book
    // seven times for one intent. A document with no content address cannot be
    // searched — the route is keyed by md5.
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
        wordCache.clear();
      }
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
      wordCache.clear();
      view.setOpen(false);
      clearPainted();
      view.setState({ kind: "idle" });
    },
  };
}

/**
 * What the counter says.
 *
 * THE COPY DECISION THIS FEATURE TURNS ON: `counting` shows NO TOTAL, and every
 * state that reports a number reports the INDEX's. There is deliberately no
 * wording for "the page matched but we could not point at it" — that page is
 * simply a match with nothing drawn, and saying anything about it would be
 * explaining an implementation detail to somebody reading a book.
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
