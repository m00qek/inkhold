// Dragging across a PDF's words to select them, and the rects that show it.
//
// THE PAGE IS A RASTER, so none of the browser's own text selection is available
// here: there is no text node to select, no caret, no `::selection`, and
// `getSelection()` has nothing to say. Everything is built from the shim's word
// list and `markGeometry`, which already places a page rect on the canvas
// through every zoom — one host over the page hit-testing in JS, never one DOM
// element per word (`pdfSelection.ts`, `wordAtPoint`).
//
// UNDER THE LINKS, AND THAT SETTLES THE LINK QUESTION WITHOUT CODE. `linkLayer`
// mounts real anchors above this, so a press on a link reaches the anchor and
// keeps every behaviour a link has — middle-click, the status-bar preview, the
// context menu, focus. Nothing here has to tell a click from a drag, and nothing
// here can break a link by getting that wrong. The cost is that a selection
// cannot BEGIN on a word inside a link, which is the right trade: the link is
// what that word is for.
//
// MOUSE AND PEN ONLY. A drag is how you scroll a page on a touch screen, so
// claiming drags there would take away scrolling to add selecting. Touch falls
// through to the page untouched.

import { el } from "../ui/dom";
import { placePageRect, type Size } from "../render/markGeometry";
import type { PdfWord } from "../render/pdfWire";
import { nearestWord, selectionText, wordAtPoint, wordsInRange, type WordRange } from "./pdfSelection";

export interface PdfSelectionLayer {
  /** The host element. Mount it in `.pdf-stage`, UNDER the link layer. */
  el: HTMLElement;
  /**
   * The page this layer is now over: its words, its size in points, and the
   * canvas size those words have to be placed against.
   *
   * Called on every render of the page — a zoom, a resize, a re-raster — so the
   * rects follow the page. Passing a different word list (a page turn) drops any
   * selection.
   */
  setPage(words: readonly PdfWord[], at: { pagePt: Size; canvas: Size }): void;
  /** Drop the selection and the rects. Safe at any time. */
  clear(): void;
  /** What is selected right now, as text. `""` when nothing is. */
  text(): string;
  /** Whether anything is selected — for gating the Copy affordance. */
  has(): boolean;
  destroy(): void;
}

export interface PdfSelectionOptions {
  /**
   * The selection changed — gained words, lost them, or went away. The viewer
   * uses this to show or hide its Copy affordance.
   */
  onChange(has: boolean): void;
}

export function createPdfSelectionLayer(opts: PdfSelectionOptions): PdfSelectionLayer {
  const host = el("div", { class: "pdf-select" });

  let words: readonly PdfWord[] = [];
  let pagePt: Size = { width: 0, height: 0 };
  let canvasSize: Size = { width: 0, height: 0 };
  let range: WordRange | null = null;
  let dragging = false;

  /** Pointer position -> page points, which is the space the words are in. */
  function toPage(ev: PointerEvent): { x: number; y: number } | null {
    if (pagePt.width <= 0 || canvasSize.width <= 0) return null;
    const box = host.getBoundingClientRect();
    if (box.width <= 0) return null;
    // The host is the page's own box, so this is one scale and no offset. Taken
    // from the LIVE rect rather than from `canvasSize`, because a zoom animation
    // or a panel opening can leave the two disagreeing for a frame and the
    // pointer is always right about where it is.
    const k = pagePt.width / box.width;
    return { x: (ev.clientX - box.left) * k, y: (ev.clientY - box.top) * k };
  }

  function paint(): void {
    const picked = range ? wordsInRange(words, range) : [];
    if (picked.length === 0) {
      host.replaceChildren();
      return;
    }
    const boxes: HTMLElement[] = [];
    for (const w of picked) {
      const box = placePageRect(w, pagePt, canvasSize);
      if (box.width < 1 || box.height < 1) continue;
      // Decorative, like find's marks: what is selected reaches assistive tech
      // as the TEXT the copy carries, not as geometry.
      const r = el("div", { class: "pdf-select__box", "aria-hidden": "true" });
      const st = r.style;
      st.left = `${box.left}px`;
      st.top = `${box.top}px`;
      st.width = `${box.width}px`;
      st.height = `${box.height}px`;
      boxes.push(r);
    }
    host.replaceChildren(...boxes);
  }

  function setRange(next: WordRange | null): void {
    const had = range !== null && wordsInRange(words, range).length > 0;
    range = next;
    paint();
    const has = range !== null && wordsInRange(words, range).length > 0;
    if (has !== had) opts.onChange(has);
  }

  host.addEventListener("pointerdown", (ev) => {
    // Mouse and pen only (see the header), primary button only — a right-click
    // is on its way to a context menu and must not eat the selection first.
    if (ev.pointerType === "touch" || ev.button !== 0) return;
    if (words.length === 0) return;
    const p = toPage(ev);
    if (!p) return;
    const at = wordAtPoint(words, p.x, p.y);
    if (at === null) {
      // A PRESS IN A MARGIN CLEARS. Extending a drag is forgiving about white
      // space (`nearestWord`); starting one is not, because a press on nothing
      // is how a reader dismisses what they had.
      setRange(null);
      return;
    }
    dragging = true;
    setRange({ anchor: at, head: at });
    // POINTER CAPTURE, so a drag that leaves the page keeps extending, and the
    // release lands here whatever is under the pointer by then.
    host.setPointerCapture(ev.pointerId);
    // Only now: an un-handled press must stay available to whatever is beneath.
    ev.preventDefault();
  });

  host.addEventListener("pointermove", (ev) => {
    if (!dragging || !range) return;
    const p = toPage(ev);
    if (!p) return;
    // NEAREST, not strict, or the drag stalls in the margin (`nearestWord`).
    const at = nearestWord(words, p.x, p.y);
    if (at === null || at === range.head) return;
    setRange({ anchor: range.anchor, head: at });
  });

  function endDrag(ev: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    if (host.hasPointerCapture(ev.pointerId)) host.releasePointerCapture(ev.pointerId);
  }
  host.addEventListener("pointerup", endDrag);
  host.addEventListener("pointercancel", endDrag);

  return {
    el: host,
    setPage(next, at) {
      // A DIFFERENT PAGE DROPS THE SELECTION. Identity, not contents: the same
      // page re-rendered at a new zoom hands back the same array and must keep
      // what is selected, while a page turn hands back a different one and must
      // not carry indices into a document they no longer describe.
      if (next !== words) {
        words = next;
        range = null;
        opts.onChange(false);
      }
      pagePt = at.pagePt;
      canvasSize = at.canvas;
      host.style.left = "0";
      host.style.top = "0";
      host.style.width = `${at.canvas.width}px`;
      host.style.height = `${at.canvas.height}px`;
      // The cursor is the only hint that a raster page can be selected at all.
      host.classList.toggle("is-selectable", next.length > 0);
      paint();
    },
    clear() {
      dragging = false;
      setRange(null);
    },
    text() {
      return range ? selectionText(wordsInRange(words, range)) : "";
    },
    has() {
      return range !== null && wordsInRange(words, range).length > 0;
    },
    destroy() {
      words = [];
      range = null;
      host.remove();
    },
  };
}
