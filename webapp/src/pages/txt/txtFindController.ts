// Find in a `.txt`: the shared find session (`viewer/findSession.ts`) with a
// text file's surface. The whole file is loaded, so the "page" is a paragraph:
// the index names matching paragraphs with byte ranges, mapped into the loaded
// string and marked; stepping moves match by match, scrolling to each.

import { createFindBar } from "../viewer/findBar";
import { VIEWER_DEBOUNCE_MS } from "../viewer/viewerChrome";
import { createFindSession, findCountIsNone, findCountText } from "../viewer/findSession";
import type { ViewerDeps } from "../viewer/viewer";
import { buildFindContent, resolveFindSegments } from "./txtFind";

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
  /** The paragraph ordinal of the current match, or 0 with nothing current. */
  currentSegment(): number;
  open(): void;
  close(): void;
  setOpen(open: boolean): void;
  reset(): void;
  /** A `?q=` deep link: the query runs once the text lands, landing on paragraph `target`. */
  prime(query: string, target: number): void;
  /** The text is in the DOM: find can search it. */
  onTextShown(): void;
}

/** What the counter says for a file with no text in it. */
export const TXT_TEXTLESS = "This file is empty.";

export function createTxtFind(deps: TxtFindDeps): TxtFindController {
  // Own block, not `.findbar`: both viewers are mounted and the reader's tests
  // query `.findbar` globally.
  const bar = createFindBar({ block: "txtbar", label: "Find in this file" });

  /** Each marked paragraph, by its ordinal. */
  let paras = new Map<number, HTMLElement>();

  function plainText(): void {
    const pre = deps.textPre();
    const text = deps.loadedText();
    paras = new Map();
    // Keeps the same `<pre>`, so the font size persists.
    if (pre && text !== null) pre.replaceChildren(document.createTextNode(text));
  }

  function clearCurrent(): void {
    for (const p of paras.values()) {
      p.classList.remove("is-current");
      for (const m of p.querySelectorAll("mark.is-current")) m.classList.remove("is-current");
    }
  }

  const session = createFindSession({
    docs: deps.docSearch,
    failures: { onSessionExpired: deps.onSessionExpired },
    debounceMs: VIEWER_DEBOUNCE_MS,
    // A paragraph without a byte range cannot be placed: marking from byte 0 would be wrong.
    placeable: (hit) => hit.offset !== null && hit.length !== null,
    surface: {
      setOpen(open) {
        bar.el.hidden = !open;
        deps.root().classList.toggle("is-finding", open);
        deps.toggle.setAttribute("aria-pressed", String(open));
      },
      setState(state) {
        bar.count.textContent = findCountText(state, "file", TXT_TEXTLESS);
        bar.count.classList.toggle("is-none", findCountIsNone(state));
        bar.ask.hidden = state.kind !== "fuzzyPrompt";
        // The URL follows the query and where find landed.
        deps.syncUrl();
      },
      setStepEnabled(enabled) {
        bar.prev.disabled = !enabled;
        bar.next.disabled = !enabled;
      },
      focusField() {
        bar.input.focus();
        bar.input.select();
      },
      setHits(hits) {
        const pre = deps.textPre();
        const text = deps.loadedText();
        if (hits.length === 0 || !pre || text === null) {
          plainText();
          return;
        }
        const located = hits.map((h) => ({ segment: h.segment, offset: h.offset!, length: h.length!, matches: h.matches, terms: h.terms }));
        const segs = resolveFindSegments(text, located);
        const built = buildFindContent(text, segs);
        pre.replaceChildren(...built.nodes);
        paras = new Map(segs.map((s, i) => [s.segment, built.paras[i]!]));
      },
      // One screen of text: the "page turn" is just the current paragraph.
      showSegment: (segment) => session.setPage(segment),
      clearMarks: clearCurrent,
      async paint(segment, ask) {
        clearCurrent();
        const para = paras.get(segment);
        if (!para || ask.terms === null) return 0;
        const marks = para.querySelectorAll("mark");
        para.classList.add("is-current");
        const mark = ask.current >= 0 && marks.length > 0 ? marks[Math.min(ask.current, marks.length - 1)] : undefined;
        mark?.classList.add("is-current");
        // `scrollIntoView` is absent under the test DOM.
        if (ask.reveal) (mark ?? para).scrollIntoView?.({ block: "center", inline: "nearest" });
        deps.syncUrl();
        return marks.length;
      },
    },
  });

  function close(): void {
    if (!session.isOpen()) return;
    session.close();
    bar.input.value = "";
    session.setQuery("");
    deps.syncUrl();
  }

  deps.toggle.addEventListener("click", () => (session.isOpen() ? close() : session.open()));
  bar.close.addEventListener("click", close);
  bar.ask.addEventListener("click", () => session.searchSimilar());
  bar.input.addEventListener("input", () => {
    session.setQuery(bar.input.value);
    deps.queueUrlSync();
  });
  bar.input.addEventListener("keydown", (e) => {
    // Handled explicitly: a stray `<form>` submit would reload the hash-routed SPA.
    if (e.key !== "Enter") return;
    e.preventDefault();
    session.step(e.shiftKey ? -1 : 1);
  });
  bar.prev.addEventListener("click", () => session.step(-1));
  bar.next.addEventListener("click", () => session.step(1));

  return {
    bar: bar.el,
    isOpen: session.isOpen,
    query: session.query,
    currentSegment: () => session.currentSegment() ?? 0,
    open: () => session.open(),
    close,
    setOpen: (open) => (open ? session.open({ focus: false }) : close()),
    reset() {
      session.reset();
      paras = new Map();
      bar.input.value = "";
    },
    prime(query, target) {
      bar.input.value = query;
      // Nothing to search until the text lands; `onTextShown` names the file.
      session.setDocument(null, target);
      session.open({ focus: false });
      session.setQuery(query);
    },
    onTextShown() {
      session.setDocument(deps.fileHash() ?? null);
    },
  };
}
