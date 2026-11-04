// Drag-to-select over a raster PDF page, built from the shim's word list since
// there is no browser text selection. Mounted under the link layer, so a press on
// a link stays a link. Mouse and pen only: on touch a drag scrolls.

import { el } from "../../ui/dom";
import { placePageRect, type Size } from "../../render/markGeometry";
import type { PdfWord } from "../../render/pdfWire";
import { nearestWord, selectionText, wordAtPoint, wordsInRange, type WordRange } from "./pdfSelection";

export interface PdfSelectionLayer {
  /** Mount in `.pdf-stage`, under the link layer. */
  el: HTMLElement;
  /** Called on every render; a different word array (page turn) drops the selection. */
  setPage(words: readonly PdfWord[], at: { pagePt: Size; canvas: Size }): void;
  clear(): void;
  text(): string;
  has(): boolean;
  destroy(): void;
}

export interface PdfSelectionOptions {
  onChange(has: boolean): void;
}

export function createPdfSelectionLayer(opts: PdfSelectionOptions): PdfSelectionLayer {
  const host = el("div", { class: "pdf-select" });

  let words: readonly PdfWord[] = [];
  let pagePt: Size = { width: 0, height: 0 };
  let canvasSize: Size = { width: 0, height: 0 };
  let range: WordRange | null = null;
  let dragging = false;

  function toPage(ev: PointerEvent): { x: number; y: number } | null {
    if (pagePt.width <= 0 || canvasSize.width <= 0) return null;
    const box = host.getBoundingClientRect();
    if (box.width <= 0) return null;
    // From the live rect, not `canvasSize`, which can lag a frame during zoom.
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
    // Primary button only, so a right-click does not eat the selection.
    if (ev.pointerType === "touch" || ev.button !== 0) return;
    if (words.length === 0) return;
    const p = toPage(ev);
    if (!p) return;
    const at = wordAtPoint(words, p.x, p.y);
    if (at === null) {
      // A press in a margin clears.
      setRange(null);
      return;
    }
    dragging = true;
    setRange({ anchor: at, head: at });
    host.setPointerCapture(ev.pointerId);
    // Only now: an unhandled press must stay available to whatever is beneath.
    ev.preventDefault();
  });

  host.addEventListener("pointermove", (ev) => {
    if (!dragging || !range) return;
    const p = toPage(ev);
    if (!p) return;
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
      // Compared by identity: a re-render at a new zoom passes the same array.
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
