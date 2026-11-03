// Find-in-note controller, with the DOM injected as a {@link FindView}. Counts
// come from the browser's FTS5 index over `text/<md5>` (fetched on first find);
// ovals need `getPageText`, only for the page on screen.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Api } from "../api/types";
import type { Hash, Id, PageRef, WordBox } from "../core/types";
import type { DocSearch, DocSearchResult } from "../search/docSearch";
// Shared tokenizer, so ovals and counts agree on what a word is.
import { fold, words as wordTerms } from "../search/fold";

/** One matching page; `pageIndex` because a `.note` segment ordinal is a page. */
interface FindPage {
  readonly pageIndex: number;
  readonly matches: number;
  readonly terms: readonly string[];
}

function toPages(result: DocSearchResult): FindPage[] {
  return result.segments.map((s) => ({ pageIndex: s.segment, matches: s.matches, terms: s.terms }));
}

/**
 * `unrecognised` is not `empty` (nothing was searched), `counting` carries no
 * total (a total that revises itself loses trust), and `error` never renders as
 * an empty result.
 */
export type FindState =
  | { kind: "idle" }
  | { kind: "unrecognised" }
  /** Phase 1. `recognisedPages` is null while the page list is still the skeleton. */
  | { kind: "counting"; onThisPage: number; recognisedPages: number | null }
  /** Phase 2: `at` is 0-based over the exact `total`; `fuzzy` qualifies the whole count. */
  | { kind: "settled"; at: number; total: number; fuzzy: boolean }
  /**
   * Exact found nothing but a typo-tolerant search would; offered opt-in. A deep
   * link from a global fuzzy hit carries the resolved term and never reaches here.
   */
  | { kind: "fuzzyPrompt" }
  | { kind: "empty" }
  | { kind: "error" };

export interface FindView {
  setOpen(open: boolean): void;
  setState(state: FindState): void;
  /** Ovals for the page on screen; `current` is -1 when the current match is elsewhere. */
  setPageMatches(words: WordBox[], current: number): void;
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
  const debounceMs = deps.debounceMs ?? 220;

  let open = false;
  let noteId: Id | null = null;
  let noteMd5: string | null = null;
  let pages: readonly PageRef[] = [];
  let pageIndex = 0;

  let active: string | null = null;
  let query = "";

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on every intent change; a response paints only if its token is current. */
  let token = 0;

  let counts: FindPage[] = [];
  let landedCounts = false;
  let fuzzy = false;
  /** A fuzzy fallback held until the user opts in. */
  let heldFuzzy: FindPage[] | null = null;
  let optedIn = false;
  let runAbort: AbortController | null = null;
  /** 0-based index of the current match over the whole note; -1 for none. */
  let at = -1;

  const wordCache = new Map<Hash, WordBox[]>();

  let recognitionKnown = true;

  const recognisedPages = (): number => pages.filter((p) => p.textHash !== null).length;
  const recognisedPagesOrNull = (): number | null => (recognitionKnown ? recognisedPages() : null);
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

  /** Null until the counts land (phase-1 mode); `[]` afterwards means nothing to circle. */
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

  function clearPainted(): void {
    view.setPageMatches([], -1);
    view.setPageCounts(new Map());
    view.setStepEnabled(false);
  }

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

  async function paintPage(): Promise<void> {
    const id = noteId;
    const page = pages[pageIndex];
    if (!open || id === null || !page || query === "") {
      view.setPageMatches([], -1);
      return;
    }
    const mine = token;
    const words = await wordsFor(id, page);
    if (mine !== token || !open || noteId !== id || pages[pageIndex] !== page) return;

    const matched = matchWords(words, query, termsOn(pageIndex));
    let current = -1;
    if (matched.length > 0) {
      if (!landedCounts) current = 0;
      else {
        const where = locate(at);
        if (where && where.pageIndex === pageIndex) current = Math.min(where.within, matched.length - 1);
      }
    }
    view.setPageMatches(matched, current);
    // Before the answer lands, the counter reports only this page.
    if (!landedCounts) {
      view.setState({ kind: "counting", onThisPage: matched.length, recognisedPages: recognisedPagesOrNull() });
    }
  }

  /**
   * Where find lands when matches appear: keep the highlighted match if this
   * page has one, otherwise go to the note's first match.
   */
  function landOnFirst(): void {
    const here = firstOnPage(pageIndex);
    at = here >= 0 ? here : 0;
  }

  function applyResult(id: Id, result: DocSearchResult, mine: number): void {
    if (mine !== token) return; // a later keystroke superseded us
    if (!open || noteId !== id) return;

    // Manual fuzzy is opt-in: hold a fuzzy answer behind "search similar". One
    // that found nothing is a real absence.
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

    const where = locate(at);
    if (where && where.pageIndex !== pageIndex) view.showPage(where.pageIndex);
    else void paintPage();
  }

  /**
   * Phase 2. The abort covers only the `text/<md5>` fetch; the index build is
   * the same work the next keystroke needs, and stale answers drop by token.
   */
  async function runSearch(id: Id, md5: string, q: string, mine: number): Promise<void> {
    const ac = new AbortController();
    runAbort = ac;
    try {
      const result = await deps.docs.search(md5, q, ac.signal);
      applyResult(id, result, mine);
    } catch (e) {
      if (mine !== token) return;
      // A 404 (document not derived yet) is a failure, not an empty result.
      if (dispatchApiFailure(failures, e)) return;
      view.setState({ kind: "error" });
    }
  }

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

    // `textHash` gates the feature at no cost, but only once the page list is
    // real: the skeleton invents `textHash: null` for every page.
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

    view.setPageCounts(new Map());
    view.setStepEnabled(false);
    view.setState({ kind: "counting", onThisPage: 0, recognisedPages: recognisedPagesOrNull() });
    void paintPage();

    // Phase 2, still debounced: the first find fetches and builds the index.
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
      // Ctrl+F on an open bar re-focuses.
      view.focusField();
      // Fetches nothing; re-run so an unrecognised note says so before any keystroke.
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

    setNote(id: Id | null, md5: string | null, next: readonly PageRef[], known = true): void {
      const changed = id !== noteId;
      noteId = id;
      noteMd5 = md5;
      pages = next;
      recognitionKnown = known;
      if (changed) pageIndex = 0;
      // A metadata refetch brings new hashes, so the cache is stale either way.
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
