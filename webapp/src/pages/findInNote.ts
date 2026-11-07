// Find in a note: the shared find session (`viewer/findSession.ts`) with a
// note's surface. Counts come from the browser's FTS5 index over `text/<md5>`
// (fetched on first find); ovals need `getPageText`, only for the page on
// screen, and before the count lands they are a substring guess.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Api } from "../api/types";
import type { Hash, Id, PageRef, WordBox } from "../core/types";
import type { DocSearch } from "../search/docSearch";
import { createFindSession, type FindState } from "./viewer/findSession";
// Shared tokenizer, so ovals and counts agree on what a word is.
import { fold, words as wordTerms } from "../search/fold";

export interface FindView {
  setOpen(open: boolean): void;
  setState(state: FindState): void;
  /** Ovals for the page on screen; `current` is -1 when the current match is elsewhere. */
  setPageMatches(words: WordBox[], current: number): void;
  /** Scroll the current match's oval into view, if it's off-screen (a zoomed page). */
  revealCurrent?(): void;
  setPageCounts(counts: ReadonlyMap<number, number>): void;
  showPage(index: number): void;
  /** False until the counts land: stepping an unknown set would step the wrong set. */
  setStepEnabled(enabled: boolean): void;
  focusField(): void;
}

export interface FindDeps {
  /** Only for `getPageText` (the ovals). */
  api: Api;
  docs: DocSearch;
  view: FindView;
  /** Where UNAUTHORIZED / STALE_PAGE go; never swallowed here. */
  failures: ApiFailureSink;
  debounceMs?: number;
}

export interface FindController {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /**
   * Clears everything found. Pass `recognitionKnown = false` for the reader's
   * skeleton page list (it invents `textHash: null`), so "Not recognised on the
   * device" is withheld until real metadata lands. `md5` is all the search
   * needs; version previews already rewrite `fileHash`. Null leaves find inert.
   */
  setNote(noteId: Id | null, md5: string | null, pages: readonly PageRef[], recognitionKnown?: boolean): void;
  setPage(index: number): void;
  setQuery(raw: string): void;
  step(dir: 1 | -1): void;
  /** Reveal the held fuzzy answer; asks nothing again. */
  searchSimilar(): void;
  reset(): void;
}

/**
 * Word boxes to circle. With `terms` (what the index counted on this page) it is
 * an equality test on folded terms, so ovals derive from the count. `terms ===
 * null` is phase 1, where a substring guess keeps find immediate. If boxes and
 * transcript tokenise differently, the count wins.
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

  let noteId: Id | null = null;
  let pages: readonly PageRef[] = [];
  /** False while the page list is the reader's skeleton (it invents `textHash: null`). */
  let recognitionKnown = true;
  const wordCache = new Map<Hash, WordBox[]>();

  const recognisedPages = (): number => pages.filter((p) => p.textHash !== null).length;

  /** Cached by `textHash`; a null `textHash` costs no request. */
  async function wordsFor(id: Id, page: PageRef): Promise<WordBox[]> {
    if (page.textHash === null) return [];
    const cached = wordCache.get(page.textHash);
    if (cached !== undefined) return cached;
    try {
      const { words } = await api.getPageText(id, page);
      wordCache.set(page.textHash, words);
      return words;
    } catch (e) {
      // Anything but auth/stale costs only this page's ovals.
      dispatchApiFailure(failures, e, id, page);
      return [];
    }
  }

  const session = createFindSession({
    docs: deps.docs,
    failures,
    debounceMs: deps.debounceMs,
    // Find is immediate: the page on screen is circled before the count lands.
    provisional: true,
    // `textHash` gates the feature at no cost, once the page list is real.
    gate: (): FindState | null =>
      recognitionKnown && noteId !== null && pages.length > 0 && recognisedPages() === 0 ? { kind: "unrecognised" } : null,
    scope: () => (recognitionKnown ? recognisedPages() : null),
    surface: {
      setOpen: (open) => view.setOpen(open),
      setState: (state) => view.setState(state),
      setStepEnabled: (enabled) => view.setStepEnabled(enabled),
      focusField: () => view.focusField(),
      setHits: (hits) => view.setPageCounts(new Map(hits.map((h) => [h.segment, h.matches]))),
      showSegment: (index) => view.showPage(index),
      clearMarks: () => view.setPageMatches([], -1),
      async paint(index, ask) {
        const id = noteId;
        const page = pages[index];
        if (id === null || !page) {
          view.setPageMatches([], -1);
          return 0;
        }
        const words = await wordsFor(id, page);
        if (ask.stale() || noteId !== id || pages[index] !== page) return null;
        const matched = matchWords(words, ask.query, ask.terms);
        const current = ask.currentOf(matched.length);
        view.setPageMatches(matched, current);
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

    setNote(id, md5, next, known = true) {
      const changed = id !== noteId;
      noteId = id;
      pages = next;
      recognitionKnown = known;
      // A metadata refetch brings new hashes, so the cache is stale either way.
      wordCache.clear();
      session.setDocument(md5, changed ? 0 : undefined);
    },

    setPage: session.setPage,
    setQuery: session.setQuery,
    step: session.step,
    searchSimilar: session.searchSimilar,

    reset() {
      noteId = null;
      pages = [];
      recognitionKnown = true;
      wordCache.clear();
      session.reset();
    },
  };
}
