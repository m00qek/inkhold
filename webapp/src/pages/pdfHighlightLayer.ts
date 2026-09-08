// Find's marks over a PDF page: a precise translucent highlight, one box per
// located word.
//
// A HIGHLIGHT, NOT AN OVAL, and that is a decision about the DATA rather than
// about taste. `findOvals.ts` states the rule it is the other half of: the
// reader circles because the device's word rectangles come from a recogniser and
// "can sit slightly off the ink, so a hard box asserts a precision the data does
// not have". A PDF word's box comes from the content stream — it is where the
// glyphs ARE — so an oval there would assert LESS precision than we have, which
// is the same error pointing the other way. The mark expresses how sure we are:
// recognised handwriting gets circled, typeset glyphs get marked exactly.
//
// A WASH IS ALLOWED HERE FOR THE SAME REASON. The oval's other objection is that
// "a filled highlight would obscure the very ink it points at" — which is about
// reading HANDWRITING through the mark. Printed text under a translucent wash
// stays legible, and it is the vocabulary every PDF reader already uses, so it
// needs no explaining to the person reading. It is the `.txt` viewer's own
// `<mark>` at the same two weights (13-txt-viewer.css), not a third idea.
//
// UNDER THE INK. The stage stacks page, THESE, the `.mark`'s handwriting, then
// the links. The handwriting is the person's own and our mark must not cover it;
// the links stay on top because a link under a scribble is exactly the case that
// occurs. Stacking order is DOM order here — see `pdfViewer.ts`'s `stage`.
//
// NO FILE-TYPE SNIFFING ANYWHERE. This component draws highlights and only
// highlights; `findOvals.ts` draws ovals and only ovals; neither asks what kind
// of file it is looking at. A shared "draw a find mark" component that branched
// on the document's type is the thing this arrangement exists to avoid.

import { el } from "../ui/dom";
import { placePageRect, type Size } from "../render/markGeometry";
import type { PdfWord } from "../render/pdfText";

export interface PdfHighlightLayer {
  /** The host element. Mount it in `.pdf-stage`, UNDER the ink. */
  el: HTMLElement;
  /**
   * Put a mark over each of `words` on a page of `pagePt` points drawn at
   * `canvas` CSS pixels. `current` indexes into `words`, or is -1 when the
   * current match is not on this page (or there is none).
   *
   * An empty list takes the layer down, which is the state a page the server
   * matched but the client could not locate lands in — no box, and the counter
   * above it still says the page matched.
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
          // DECORATIVE TO ASSISTIVE TECH, unlike the link layer's anchors. The
          // count and the stepping are announced by the find bar's own live
          // region; a screen reader meeting N unlabelled boxes over a raster
          // would be told nothing it can use and a great deal it cannot.
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
