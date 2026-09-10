// Find's marks over a PDF page: a precise translucent highlight, one box per
// located word.
//
// A HIGHLIGHT, NOT AN OVAL like `findOvals.ts` draws, and that is about the
// DATA. The reader circles because a device's word rectangles come from a
// recogniser and can sit slightly off the ink; a PDF word's box comes from the
// content stream, so an oval there would assert LESS precision than we have. A
// filled wash is allowed for the same reason — printed text stays legible under
// it where handwriting would not. It is the `.txt` viewer's own `<mark>` at the
// same two weights (13-txt-viewer.css), not a third idea.
//
// UNDER THE INK. The stage stacks page, THESE, the `.mark`'s handwriting, then
// the links: our mark must not cover the person's own ink, and the links stay on
// top because a link under a scribble is exactly the case that occurs. Stacking
// order is DOM order here — see `pdfViewer.ts`'s `stage`.
//
// Neither this nor `findOvals.ts` asks what kind of file it is looking at. A
// shared "draw a find mark" component that branched on the document's type is
// the thing this arrangement exists to avoid.

import { el } from "../ui/dom";
import { placePageRect, type Size } from "../render/markGeometry";
import type { PdfWord } from "../render/pdfWire";

export interface PdfHighlightLayer {
  /** The host element. Mount it in `.pdf-stage`, UNDER the ink. */
  el: HTMLElement;
  /**
   * Put a mark over each of `words` on a page of `pagePt` points drawn at
   * `canvas` CSS pixels. `current` indexes into `words`, or is -1 when the
   * current match is not on this page (or there is none).
   *
   * An empty list takes the layer down — the state a page the server matched
   * but the client could not locate lands in: no box, and the counter above it
   * still says the page matched.
   */
  setMarks(words: readonly PdfWord[], at: { pagePt: Size; canvas: Size; current: number }): void;
  /** Take the layer down. */
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
        // A box that rounds away to nothing paints nothing; skipping it keeps
        // the DOM the size of what is actually visible on a 1,450-page book.
        if (box.width < 1 || box.height < 1) continue;
        const mark = el("div", {
          class: i === at.current ? "pdf-find-mark is-current" : "pdf-find-mark",
          // Decorative to assistive tech, unlike the link layer's anchors: the
          // count and the stepping are announced by the find bar's live region,
          // and N unlabelled boxes over a raster say nothing a reader can use.
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
      // The layer is the page's own box, so a rect in page space is a rect here.
      // Set explicitly rather than by `inset: 0`, because the stage also holds
      // the OVERSIZED `.mark` host and nothing guarantees the two agree.
      host.style.left = "0";
      host.style.top = "0";
      host.style.width = `${at.canvas.width}px`;
      host.style.height = `${at.canvas.height}px`;
      host.hidden = false;
    },
  };
}
