// The PDF viewer's find: the controller (pdfFind.ts) wired to the find bar,
// the page's highlight layer and the page strip's match counts. A part of
// the viewer like navigation and the lifecycle, built from its context.

import type { PdfWord } from "../../render/pdfWire";
import { createPdfFindController, pdfCountIsNone, pdfCountText, type PdfFindController } from "./pdfFind";
import type { PdfViewerCtx } from "./pdfViewerContext";
import { revealIn } from "../../ui/dom";

export function createPdfViewerFind(ctx: PdfViewerCtx): PdfFindController {
  /** Words are in page points and placed by the same transform as the ink; no size yet clears the layer. */
  function paintFindMarks(words: PdfWord[], current: number): void {
    const size = ctx.renderer.pageSizePt();
    if (!size || words.length === 0) {
      ctx.findLayer.clear();
      return;
    }
    ctx.findLayer.setMarks(words, {
      pagePt: size,
      canvas: ctx.renderer.cssCanvasSize(),
      current,
    });
  }

  const find = createPdfFindController({
    docs: ctx.deps.docSearch,
    failures: { onSessionExpired: ctx.deps.onSessionExpired },
    // The locator; a page that will not read just has no boxes.
    words: async (page) => (ctx.st.session && ctx.st.open_ ? ctx.st.session.pageWords(page) : []),
    view: {
      setOpen(isOpen) {
        ctx.findBar.el.hidden = !isOpen;
        ctx.root.classList.toggle("is-finding", isOpen);
        ctx.findToggle.setAttribute("aria-pressed", String(isOpen));
        if (!isOpen) ctx.findLayer.clear();
      },
      setState(state) {
        ctx.findBar.count.textContent = pdfCountText(state);
        ctx.findBar.count.classList.toggle("is-none", pdfCountIsNone(state));
        ctx.findBar.ask.hidden = state.kind !== "fuzzyPrompt";
        // The URL follows the query, so a find is shareable.
        ctx.nav.syncUrl();
      },
      setPageMarks: paintFindMarks,
      revealCurrent() {
        const mark = ctx.main.querySelector(".pdf-find-mark.is-current");
        if (mark) revealIn(mark, ctx.main);
      },
      setPageCounts: (counts) => ctx.pagesPanel.setBadges(counts),
      showPage: (index) => void ctx.nav.go(index),
      setStepEnabled(enabled) {
        ctx.findBar.prev.disabled = !enabled;
        ctx.findBar.next.disabled = !enabled;
      },
      focusField() {
        ctx.findBar.input.focus();
        ctx.findBar.input.select();
      },
    },
  });

  ctx.findToggle.addEventListener("click", () => find.toggle());
  ctx.findBar.close.addEventListener("click", () => {
    find.close();
    ctx.findBar.input.value = "";
  });
  ctx.findBar.input.addEventListener("input", () => find.setQuery(ctx.findBar.input.value));
  ctx.findBar.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      find.step(e.shiftKey ? -1 : 1);
    }
  });
  ctx.findBar.prev.addEventListener("click", () => find.step(-1));
  ctx.findBar.next.addEventListener("click", () => find.step(1));
  ctx.findBar.ask.addEventListener("click", () => find.searchSimilar());

  return find;
}
