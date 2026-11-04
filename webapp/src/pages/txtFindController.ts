// Find in a `.txt`: the whole file is loaded, so find is text/DOM work. The
// index names matching paragraphs with byte ranges, which are mapped into the
// loaded string. Steps between matching paragraphs rather than pages.

import { el } from "../ui/dom";
import { dispatchApiFailure } from "../api/client";
import { svg, VIEWER_IC } from "./viewerIcons";
import { VIEWER_DEBOUNCE_MS } from "./viewerChrome";
import type { ViewerDeps } from "./viewer";
import {
  buildFindContent,
  resolveFindSegments,
  totalMatches,
  txtCountText,
  TXT_SEARCHING,
  type FindSegment,
} from "./txtFind";

export interface TxtFindDeps {
  docSearch: ViewerDeps["docSearch"];
  onSessionExpired: () => void;
  /** The toolbar's find button; its pressed state follows the bar. */
  toggle: HTMLElement;
  root: () => HTMLElement;
  textPre: () => HTMLPreElement | null;
  loadedText: () => string | null;
  fileHash: () => string | null | undefined;
  syncUrl: () => void;
  queueUrlSync: () => void;
}

export interface TxtFindController {
  bar: HTMLElement;
  isOpen(): boolean;
  /** The query the URL should carry. */
  query(): string;
  /** The current paragraph ordinal, or 0 with nothing current. */
  currentSegment(): number;
  open(): void;
  close(): void;
  setOpen(open: boolean): void;
  reset(): void;
  /** A `?q=` deep link: the query runs once the text lands, landing on `target`. */
  prime(query: string, target: number): void;
  /** The text is in the DOM; run a primed query. */
  onTextShown(): void;
}

export function createTxtFind(deps: TxtFindDeps): TxtFindController {
  let findOpen = false;
  /** The trimmed query pending, in flight, or painted; makes input idempotent. */
  let findActive: string | null = null;
  let findQuery = "";
  /** Bumped on every intent change; stale responses are dropped. */
  let findToken = 0;
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  let findSegs: FindSegment[] = [];
  /** Aligned 1:1 with `findSegs`. */
  let findParas: HTMLElement[] = [];
  /** Index into `findSegs`/`findParas`; -1 = none. */
  let findAt = -1;
  /** The first find on a file pays the `text/<md5>` fetch and an index build. */
  let findSearching = false;
  /**
   * A fuzzy result held until the user opts in. A deep link from a global fuzzy
   * hit carries the resolved term and runs exact, so it never reaches this.
   */
  let heldFuzzySegs: FindSegment[] | null = null;
  let findOptedIn = false;
  let findAbort: AbortController | null = null;
  /** Paragraph ordinal a `?q=` deep link targets, consumed when results land. */
  let pendingTarget: number | null = null;

  // ---- find bar ----
  // Steps between matching paragraphs rather than pages.
  const findInput = el("input", {
    type: "text",
    autocomplete: "off",
    placeholder: "Find in this file",
    "aria-label": "Find in this file",
  }) as HTMLInputElement;
  const findCount = el("span", { class: "txtbar__count", role: "status", "aria-live": "polite" });
  // The manual-fuzzy opt-in: offered when exact find is empty but fuzzy found
  // matches; reveals the already-computed held result.
  const findAsk = el("button", {
    class: "txtbar__ask",
    type: "button",
    hidden: true,
    text: "Search similar",
  }) as HTMLButtonElement;
  const findPrev = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Previous match",
    title: "Previous match",
    html: svg(VIEWER_IC.prev, 1.9),
  }) as HTMLButtonElement;
  const findNext = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Next match",
    title: "Next match",
    html: svg(VIEWER_IC.next, 1.9),
  }) as HTMLButtonElement;
  const findClose = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Close find",
    title: "Close find",
    html: svg(VIEWER_IC.close, 1.9),
  });
  // Own class, not `.findbar`: both viewers are mounted and the reader's tests
  // query `.findbar` globally.
  const findBar = el(
    "div",
    { class: "txtbar", hidden: true },
    el("span", { class: "txtbar__field", html: svg(VIEWER_IC.find, 1.8) }, findInput),
    findCount,
    findAsk,
    findPrev,
    findNext,
    findClose,
  );

  // ---- find ----

  function paintFindCount(): void {
    findCount.textContent =
      findQuery === ""
        ? ""
        : findSearching
          ? TXT_SEARCHING
          : txtCountText(totalMatches(findSegs), findSegs.length);
    const canStep = findSegs.length > 1;
    findPrev.disabled = !canStep;
    findNext.disabled = !canStep;
  }

  /** Keeps the same `<pre>` so the font size persists. */
  function clearFindMarks(): void {
    findSegs = [];
    findParas = [];
    findAt = -1;
    findSearching = false;
    findAsk.hidden = true;
    const textPre = deps.textPre();
    const loadedText = deps.loadedText();
    if (textPre && loadedText !== null) textPre.replaceChildren(document.createTextNode(loadedText));
  }

  /** Scrolls only on a landing or a step. */
  function focusCurrent(scroll = true): void {
    for (const [i, p] of findParas.entries()) p.classList.toggle("is-current", i === findAt);
    const cur = findParas[findAt];
    // `scrollIntoView` is absent under the test DOM.
    if (cur && scroll) cur.scrollIntoView?.({ block: "center", inline: "nearest" });
  }

  /**
   * On a landing, settle on the deep link's target if it matched, else the first
   * match, and scroll there; otherwise keep the current paragraph and do not
   * scroll (so revealing a held fuzzy answer keeps the reader's place).
   */
  function renderFind(landing: boolean): void {
    const textPre = deps.textPre();
    const loadedText = deps.loadedText();
    if (!textPre || loadedText === null) return;
    const built = buildFindContent(loadedText, findSegs);
    textPre.replaceChildren(...built.nodes);
    findParas = built.paras;
    if (landing) {
      let at = findSegs.length > 0 ? 0 : -1;
      if (pendingTarget !== null) {
        const idx = findSegs.findIndex((s) => s.segment === pendingTarget);
        if (idx >= 0) at = idx;
      }
      findAt = at;
      pendingTarget = null;
    } else if (findAt >= findSegs.length) {
      findAt = findSegs.length - 1;
    }
    focusCurrent(landing);
    paintFindCount();
    // The URL follows where find actually landed.
    deps.syncUrl();
  }

  /** Reveal the held fuzzy matches; nothing is re-queried. */
  function searchSimilar(): void {
    if (heldFuzzySegs === null || deps.loadedText() === null) return;
    findOptedIn = true;
    findSegs = heldFuzzySegs;
    heldFuzzySegs = null;
    findSearching = false;
    findAsk.hidden = true;
    findAt = -1;
    renderFind(true);
  }

  /**
   * One call, one complete answer. The abort covers only the fetch; the index
   * build and query are the work the next keystroke needs anyway.
   */
  async function runFind(query: string, mine: number): Promise<void> {
    const fileHash = deps.fileHash();
    if (deps.loadedText() === null || !fileHash) return;
    // Also set here because a `?q=` deep link calls this directly, bypassing `setFindQuery`.
    findSearching = true;
    paintFindCount();
    const ac = new AbortController();
    findAbort = ac;
    try {
      const result = await deps.docSearch.search(fileHash, query, ac.signal);
      const loadedText = deps.loadedText();
      if (mine !== findToken || loadedText === null) return;
      // A segment without a byte range cannot be placed, so it is dropped.
      const located = result.segments.flatMap((s) =>
        s.offset === null || s.length === null
          ? []
          : [{ segment: s.segment, offset: s.offset, length: s.length, matches: s.matches, terms: s.terms }],
      );
      // A fuzzy fallback that found something is held for the opt-in; the
      // fallback itself only ran because exact found 0.
      if (result.usedFuzzy && !findOptedIn) {
        const segs = resolveFindSegments(loadedText, located);
        clearFindMarks();
        findCount.textContent = "No matches";
        heldFuzzySegs = segs.length > 0 ? segs : null;
        findAsk.hidden = segs.length === 0;
        return;
      }
      findSearching = false;
      findSegs = resolveFindSegments(loadedText, located);
      renderFind(true);
    } catch (e) {
      if (mine !== findToken) return;
      if (dispatchApiFailure({ onSessionExpired: deps.onSessionExpired }, e)) return;
      // Anything else (e.g. text not derived yet) leaves the text unmarked; the
      // next keystroke retries.
      clearFindMarks();
      paintFindCount();
    }
  }

  function setFindQuery(raw: string): void {
    const q = raw.trim();
    if (q === findActive) return;
    findActive = q;
    findQuery = q;
    findToken++;
    findAbort?.abort();
    findAbort = null;
    findSearching = q !== "";
    heldFuzzySegs = null;
    findOptedIn = false;
    findAsk.hidden = true;
    if (findTimer !== undefined) {
      clearTimeout(findTimer);
      findTimer = undefined;
    }
    if (q === "") {
      clearFindMarks();
      paintFindCount();
      deps.syncUrl();
      return;
    }
    // The waiting state starts at the keystroke, so the old count is never shown.
    paintFindCount();
    const mine = findToken;
    findTimer = setTimeout(() => {
      findTimer = undefined;
      void runFind(q, mine);
    }, VIEWER_DEBOUNCE_MS);
  }

  /** Wraps unconditionally: the answer is complete when it lands. */
  function stepFind(dir: 1 | -1): void {
    const n = findSegs.length;
    if (n === 0) return;
    findAt = (findAt + dir + n) % n;
    focusCurrent();
    deps.syncUrl();
  }

  function resetFind(): void {
    if (findTimer !== undefined) {
      clearTimeout(findTimer);
      findTimer = undefined;
    }
    findAbort?.abort();
    findAbort = null;
    findToken++;
    findActive = null;
    findQuery = "";
    findAt = -1;
    findSegs = [];
    findParas = [];
    findSearching = false;
    heldFuzzySegs = null;
    findOptedIn = false;
    findAsk.hidden = true;
    pendingTarget = null;
    findInput.value = "";
    setFindOpen(false);
    paintFindCount();
  }

  function setFindOpen(open: boolean): void {
    findOpen = open;
    findBar.hidden = !open;
    deps.root().classList.toggle("is-finding", open);
    deps.toggle.setAttribute("aria-pressed", String(open));
  }

  function openFind(): void {
    setFindOpen(true);
    findInput.focus();
    findInput.select();
  }

  function closeFind(): void {
    if (!findOpen) return;
    setFindOpen(false);
    if (findTimer !== undefined) {
      clearTimeout(findTimer);
      findTimer = undefined;
    }
    findAbort?.abort();
    findAbort = null;
    findToken++;
    findActive = null;
    findQuery = "";
    findSearching = false;
    heldFuzzySegs = null;
    findOptedIn = false;
    findInput.value = "";
    clearFindMarks();
    paintFindCount();
    deps.syncUrl();
  }

  deps.toggle.addEventListener("click", () => (findOpen ? closeFind() : openFind()));
  findClose.addEventListener("click", () => closeFind());
  findAsk.addEventListener("click", () => searchSimilar());
  findInput.addEventListener("input", () => {
    setFindQuery(findInput.value);
    deps.queueUrlSync();
  });
  findInput.addEventListener("keydown", (e) => {
    // Handled explicitly: a stray `<form>` submit would reload the hash-routed SPA.
    if (e.key !== "Enter") return;
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  });
  findPrev.addEventListener("click", () => stepFind(-1));
  findNext.addEventListener("click", () => stepFind(1));

  return {
    bar: findBar,
    isOpen: () => findOpen,
    query: () => findQuery,
    currentSegment: () => (findOpen && findAt >= 0 && findSegs[findAt] ? findSegs[findAt]!.segment : 0),
    open: openFind,
    close: closeFind,
    setOpen: setFindOpen,
    reset: resetFind,
    prime(query, target) {
      findQuery = query;
      findActive = query;
      findInput.value = query;
      pendingTarget = target;
      setFindOpen(true);
    },
    onTextShown() {
      if (findOpen && findQuery !== "") void runFind(findQuery, findToken);
    },
  };
}
