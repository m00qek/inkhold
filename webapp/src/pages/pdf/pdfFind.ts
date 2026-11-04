// Find-in-PDF controller, with the DOM injected. The browser's FTS5 index over
// `text/<md5>` decides what matched and the count; this file only locates the
// index's folded terms on the page via MuPDF. The count is never derived from the
// boxes, and a page with no locatable box stays a match (FTS folding and PDF text
// can disagree on hyphenation, ligatures, split content streams).

import { dispatchApiFailure, type ApiFailureSink } from "../../api/client";
import type { Id } from "../../core/types";
import type { DocSearch, DocSearchResult } from "../../search/docSearch";
import type { PdfWord } from "../../render/pdfWire";
import { fold, words } from "../../search/fold";

interface FindPage {
  readonly pageIndex: number;
  readonly matches: number;
  readonly terms: readonly string[];
}

/** A PDF segment ordinal is a page. */
function toPages(result: DocSearchResult): FindPage[] {
  return result.segments.map((s) => ({ pageIndex: s.segment, matches: s.matches, terms: s.terms }));
}

/**
 * The boxes to mark: a word is marked when one of its folded terms is in the
 * index's `terms` for this page. An empty result is not "no matches".
 */
export function matchWords(boxes: readonly PdfWord[], terms: readonly string[]): PdfWord[] {
  if (terms.length === 0) return [];
  const wanted = new Set(terms.map(fold));
  return boxes.filter((w) => words(w.t).some((t) => wanted.has(t)));
}

/**
 * Counter states. No `unrecognised` state: an underived document 404s on
 * `text/<md5>` and lands in `error`, not `empty`.
 */
export type PdfFindState =
  | { kind: "idle" }
  /** In flight. No provisional total: a self-revising number loses trust. */
  | { kind: "counting" }
  /** `at` is 0-based over the exact `total`. */
  | { kind: "settled"; at: number; total: number; fuzzy: boolean }
  /** Exact found nothing, typo ladder found something; offered opt-in. */
  | { kind: "fuzzyPrompt" }
  | { kind: "empty" }
  | { kind: "error" };

export interface PdfFindView {
  setOpen(open: boolean): void;
  setState(state: PdfFindState): void;
  /** `current` indexes `words`, or -1. Empty means nothing to point at, never "no matches". */
  setPageMarks(words: PdfWord[], current: number): void;
  /** Badges keyed by 0-based page; the index's counts, not the located marks. */
  setPageCounts(counts: ReadonlyMap<number, number>): void;
  showPage(index: number): void;
  /** False until counts land. */
  setStepEnabled(enabled: boolean): void;
  focusField(): void;
}

export interface PdfFindDeps {
  docs: DocSearch;
  view: PdfFindView;
  /** Words on a page in display space. Must resolve `[]`, not reject, for an unreadable page. */
  words: (page: number) => Promise<PdfWord[]>;
  /** Where UNAUTHORIZED / STALE_PAGE go; never swallowed here. */
  failures: ApiFailureSink;
  /** Debounce before the count is asked for, ms. Default 220. */
  debounceMs?: number;
}

export interface PdfFindController {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /**
   * Clears everything found. `md5` is `NoteMeta.fileHash`, which a history/bin
   * preview has already rewritten, so those need no special routing.
   */
  setDocument(noteId: Id | null, md5: string | null): void;
  setPage(index: number): void;
  setQuery(raw: string): void;
  repaint(): void;
  step(dir: 1 | -1): void;
  /** Reveal the held fuzzy result; nothing is re-queried. */
  searchSimilar(): void;
  query(): string;
  reset(): void;
  /**
   * Words on `page` from the cache shared by find and selection. A miss runs
   * MuPDF's structured-text device, so call it on intent, not per page turn.
   */
  wordsFor(page: number): Promise<PdfWord[]>;
  /** The same words if already landed, else null; the array is stable across calls. */
  wordsKnown(page: number): PdfWord[] | null;
}

export function createPdfFindController(deps: PdfFindDeps): PdfFindController {
  const { view, failures } = deps;
  const debounceMs = deps.debounceMs ?? 220;

  let open = false;
  let noteId: Id | null = null;
  let docMd5: string | null = null;
  let pageIndex = 0;

  /** The trimmed query pending, in flight or painted; makes `setQuery` idempotent. */
  let active: string | null = null;
  let query = "";

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped when intent changes; a response with a stale token is dropped. */
  let token = 0;

  let counts: FindPage[] = [];
  let landedCounts = false;
  let fuzzy = false;
  let heldFuzzy: FindPage[] | null = null;
  let optedIn = false;
  let runAbort: AbortController | null = null;
  /** 0-based current match over the whole document; -1 when none. */
  let at = -1;

  /**
   * Per-page word cache. A page's words cost a structured-text run (like a
   * render) and find repaints per keystroke and zoom; PDF blobs are immutable so
   * only a document change invalidates it. Caching the promise joins concurrent callers.
   */
  const wordCache = new Map<number, Promise<PdfWord[]>>();
  /**
   * Settled words for the synchronous selection repaint. Must be the same array
   * instance each time: the selection layer treats a new array as a page turn.
   */
  const settledWords = new Map<number, PdfWord[]>();

  const total = (): number => counts.reduce((sum, p) => sum + p.matches, 0);

  function locate(index: number): { pageIndex: number; within: number } | null {
    if (index < 0) return null;
    let seen = 0;
    for (const page of counts) {
      if (index < seen + page.matches) return { pageIndex: page.pageIndex, within: index - seen };
      seen += page.matches;
    }
    return null;
  }

  function termsOn(page: number): readonly string[] | null {
    if (!landedCounts) return null;
    return counts.find((p) => p.pageIndex === page)?.terms ?? [];
  }

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

  function publishCounts(): void {
    view.setPageCounts(countsMap());
  }

  function clearPainted(): void {
    view.setPageMarks([], -1);
    view.setPageCounts(new Map());
    view.setStepEnabled(false);
  }

  /** A page that will not read has no boxes; never an error at the counter. */
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

  /** Repaint the on-screen page's marks. Never touches the counter. */
  async function paintPage(): Promise<void> {
    const terms = termsOn(pageIndex);
    if (!open || noteId === null || query === "" || terms === null) {
      view.setPageMarks([], -1);
      return;
    }
    const mine = token;
    const page = pageIndex;
    const words = await wordsFor(page);
    if (mine !== token || !open || pageIndex !== page) return;

    const matched = matchWords(words, terms);
    let current = -1;
    if (matched.length > 0) {
      const where = locate(at);
      // The index may count more on this page than we located; clamp to the last box.
      if (where && where.pageIndex === page) current = Math.min(where.within, matched.length - 1);
    }
    view.setPageMarks(matched, current);
  }

  /** First landing: keep a match on this page if there is one, else the document's first. */
  function landOnFirst(): void {
    const here = firstOnPage(pageIndex);
    at = here >= 0 ? here : 0;
  }

  function applyResult(id: Id, result: DocSearchResult, mine: number): void {
    if (mine !== token) return; // a later keystroke superseded us
    if (!open || noteId !== id) return;

    // Fuzzy fallback is shown only on opt-in; the ladder already ran.
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

    // `showPage` comes back through `setPage`, which repaints.
    const where = locate(at);
    if (where && where.pageIndex !== pageIndex) view.showPage(where.pageIndex);
    else void paintPage();
  }

  /**
   * The first find on a document pays the fetch plus the index build; later ones
   * are the query alone. Only the fetch is aborted; a superseded answer is dropped
   * by its token.
   */
  async function runSearch(id: Id, md5: string, q: string, mine: number): Promise<void> {
    const ac = new AbortController();
    runAbort = ac;
    try {
      const result = await deps.docs.search(md5, q, ac.signal);
      applyResult(id, result, mine);
    } catch (e) {
      if (mine !== token) return;
      // A 404 (text not derived yet) is an error, distinct from an empty result.
      if (dispatchApiFailure(failures, e)) return;
      view.setState({ kind: "error" });
    }
  }

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
    runAbort?.abort();
    runAbort = null;
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

    // Debounced because the first find on a document is a fetch plus an index build.
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
    view.focusField();
    // Opening fetches nothing; this re-run refreshes or repaints the existing query.
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
    // Not `this.close()`: callers destructure the controller.
    toggle: () => (open ? closeBar() : openBar()),
    query: () => query,

    setDocument(id: Id | null, md5: string | null): void {
      const changed = id !== noteId || md5 !== docMd5;
      noteId = id;
      docMd5 = md5;
      if (changed) {
        pageIndex = 0;
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
      at = (at + dir + n) % n;
      view.setState({ kind: "settled", at, total: n, fuzzy });
      const where = locate(at);
      if (!where) return;
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

/** The counter text. Every number shown is the index's. */
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

export function pdfCountIsNone(state: PdfFindState): boolean {
  return state.kind !== "settled" && state.kind !== "idle";
}
