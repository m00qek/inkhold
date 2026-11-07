// Find in a PDF: the shared find session (`viewer/findSession.ts`) with a
// PDF's surface. The browser's FTS5 index over `text/<md5>` decides what
// matched and the count; this file only locates the index's folded terms on
// the page via MuPDF. The count is never derived from the boxes, and a page
// with no locatable box stays a match (FTS folding and PDF text can disagree
// on hyphenation, ligatures, split content streams).

import type { ApiFailureSink } from "../../api/client";
import type { Id } from "../../core/types";
import type { DocSearch } from "../../search/docSearch";
import type { PdfWord } from "../../render/pdfWire";
import { fold, words } from "../../search/fold";
import { createFindSession, findCountIsNone, findCountText, type FindState } from "../viewer/findSession";

/**
 * The boxes to mark: a word is marked when one of its folded terms is in the
 * index's `terms` for this page. An empty result is not "no matches".
 */
export function matchWords(boxes: readonly PdfWord[], terms: readonly string[]): PdfWord[] {
  if (terms.length === 0) return [];
  const wanted = new Set(terms.map(fold));
  return boxes.filter((w) => words(w.t).some((t) => wanted.has(t)));
}

/** The shared session's states (`viewer/findSession.ts`). */
export type PdfFindState = FindState;

/**
 * Where the server stops extracting a PDF's text (`pdf_text.zig` `max_pages`).
 * Past it a find says which pages it searched.
 */
const PDF_TEXT_MAX_PAGES = 5_000;

export interface PdfFindView {
  setOpen(open: boolean): void;
  setState(state: PdfFindState): void;
  /** `current` indexes `words`, or -1. Empty means nothing to point at, never "no matches". */
  setPageMarks(words: PdfWord[], current: number): void;
  /** Scroll the current match's mark into view, if it's off-screen (a zoomed page). */
  revealCurrent?(): void;
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
  const { view } = deps;
  let noteId: Id | null = null;
  let docMd5: string | null = null;

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

  const session = createFindSession({
    docs: deps.docs,
    failures: deps.failures,
    debounceMs: deps.debounceMs,
    extractsUpTo: PDF_TEXT_MAX_PAGES,
    surface: {
      setOpen: (open) => view.setOpen(open),
      setState: (state) => view.setState(state),
      setStepEnabled: (enabled) => view.setStepEnabled(enabled),
      focusField: () => view.focusField(),
      setHits: (hits) => view.setPageCounts(new Map(hits.map((h) => [h.segment, h.matches]))),
      showSegment: (index) => view.showPage(index),
      clearMarks: () => view.setPageMarks([], -1),
      async paint(page, ask) {
        if (noteId === null || ask.terms === null) {
          view.setPageMarks([], -1);
          return 0;
        }
        const got = await wordsFor(page);
        if (ask.stale()) return null;
        const matched = matchWords(got, ask.terms);
        const current = ask.currentOf(matched.length);
        view.setPageMarks(matched, current);
        if (ask.reveal && current >= 0) view.revealCurrent?.();
        return matched.length;
      },
    },
  });

  return {
    isOpen: session.isOpen,
    open: () => session.open(),
    close: session.close,
    toggle: session.toggle,
    query: session.query,

    setDocument(id, md5) {
      const changed = id !== noteId || md5 !== docMd5;
      noteId = id;
      docMd5 = md5;
      if (changed) forgetWords();
      session.setDocument(md5, changed ? 0 : undefined);
    },

    setPage: session.setPage,
    wordsFor,
    wordsKnown: (page) => settledWords.get(page) ?? null,
    setQuery: session.setQuery,
    repaint: session.repaint,
    step: session.step,
    searchSimilar: session.searchSimilar,

    reset() {
      noteId = null;
      docMd5 = null;
      forgetWords();
      session.reset();
    },
  };
}

/** The counter's words: the shared wording, a PDF's own "no text" line. */
export function pdfCountText(state: PdfFindState): string {
  return findCountText(state, "file", "No text to search: this PDF's pages are images, like a scan.");
}

export const pdfCountIsNone = findCountIsNone;
