// Find's marks over a PDF page: a translucent box per located word. A box, not
// an oval, because PDF word boxes come from the content stream and are exact.
// Stacked under the ink and links (DOM order in the stage).

import { el } from "../../ui/dom";
import { placePageRect, type Size } from "../../render/markGeometry";
import type { PdfWord } from "../../render/pdfWire";

export interface PdfHighlightLayer {
  /** Mount in `.pdf-stage`, under the ink. */
  el: HTMLElement;
  /**
   * `current` indexes `words`, or -1. An empty list takes the layer down (a page
   * the server matched but the client could not locate).
   */
  setMarks(words: readonly PdfWord[], at: { pagePt: Size; canvas: Size; current: number }): void;
  clear(): void;
}

export function createPdfHighlightLayer(): PdfHighlightLayer {
  const host = el("div", { class: "pdf-find-marks", hidden: true });

  function clear(): void {
    host.replaceChildren();
    host.hidden = true;
  }

  return {
    el: host,
    clear,
    setMarks(words, at) {
      const boxes: HTMLElement[] = [];
      for (const [i, word] of words.entries()) {
        const box = placePageRect(word, at.pagePt, at.canvas);
        if (box.width < 1 || box.height < 1) continue;
        const mark = el("div", {
          class: i === at.current ? "pdf-find-mark is-current" : "pdf-find-mark",
          // Decorative: the find bar's live region announces count and stepping.
          "aria-hidden": "true",
        });
        const st = mark.style;
        st.left = `${box.left}px`;
        st.top = `${box.top}px`;
        st.width = `${box.width}px`;
        st.height = `${box.height}px`;
        boxes.push(mark);
      }
      if (boxes.length === 0) {
        clear();
        return;
      }
      host.replaceChildren(...boxes);
      // Sized explicitly, not `inset: 0`: the stage also holds the oversized `.mark` host.
      host.style.left = "0";
      host.style.top = "0";
      host.style.width = `${at.canvas.width}px`;
      host.style.height = `${at.canvas.height}px`;
      host.hidden = false;
    },
  };
}
