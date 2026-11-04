// The PDF viewer's navigation: going to a page, publishing it to the pager and
// the URL, and the keyboard and copy handlers. Parts are read lazily, since the
// viewer builds them after this.

import type { ViewerDeps } from "../viewer/viewer";
import type { PdfViewerState } from "./pdfViewerState";
import type { PdfFindController } from "./pdfFind";
import type { createPager } from "../viewer/viewerControls";
import type { createPdfOutlinePanel } from "./pdfOutlinePanel";
import type { createPdfThumbStrip } from "./pdfThumbStrip";
import type { createPdfPageRenderer } from "./pdfPageRenderer";
import type { createPdfSelectionLayer } from "./pdfSelectionLayer";

export interface PdfNavParts {
  deps: ViewerDeps;
  pager: () => ReturnType<typeof createPager>;
  find: () => PdfFindController;
  pagesPanel: () => ReturnType<typeof createPdfThumbStrip>["panel"];
  outlinePanel: () => ReturnType<typeof createPdfOutlinePanel>;
  renderer: () => ReturnType<typeof createPdfPageRenderer>;
  root: () => HTMLElement;
  selectLayer: () => ReturnType<typeof createPdfSelectionLayer>;
  findInput: () => HTMLInputElement;
}

export function createPdfNav(st: PdfViewerState, p: PdfNavParts) {
  function syncPager(): void {
    p.pager().set(st.pageIndex, st.pageCount);
  }

  /**
   * Publish the page (and query) to the URL. Bin origins use
   * `#/bin/note/:id/page/:n` with no query, since a trashed blob is not served
   * at the live route.
   */
  function syncUrl(): void {
    if (!st.open_ || !st.meta) return;
    p.deps.onPosition?.(st.meta.id, st.pageIndex, st.fromBin ? "" : p.find().query(), undefined, st.fromBin || undefined);
  }

  async function go(to: number): Promise<void> {
    if (!st.open_ || to < 0 || to >= st.pageCount || to === st.pageIndex) return;
    st.pageIndex = to;
    syncPager();
    p.pagesPanel().setCurrent(to);
    // Tracks the entry the page is inside, not the last one clicked.
    p.outlinePanel().setCurrent(to);
    // Before `syncUrl` and the raster, so URL and marks are already the new page's.
    p.find().setPage(to);
    syncUrl();
    await p.renderer().paint();
  }

  // ---- keyboard (only while on screen) ----
  // Paging matches the reader, including leaving modified arrows alone.
  function onKey(e: KeyboardEvent): void {
    if (p.root().hidden) return;
    // Ctrl+F before the input guard, so it reaches (or re-focuses) the field from anywhere.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      p.find().open();
      return;
    }
    // Escape unwinds one thing at a time: selection, find, then the viewer.
    if (e.key === "Escape") {
      if (p.selectLayer().has()) {
        p.selectLayer().clear();
        return;
      }
      if (p.find().isOpen()) {
        p.find().close();
        p.findInput().value = "";
        return;
      }
      return p.deps.onBack();
    }
    // Paging keys do not apply in inputs, including the pager's own field.
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") void go(st.pageIndex + 1);
    else if (e.key === "ArrowLeft") void go(st.pageIndex - 1);
    // Home/End are prevented, or they also scroll the stage to its ends.
    else if (e.key === "Home") {
      e.preventDefault();
      void go(0);
    } else if (e.key === "End" && st.pageCount > 0) {
      e.preventDefault();
      void go(st.pageCount - 1);
    }
  }

  /**
   * Ctrl+C via the `copy` event, whose `clipboardData` works over plain HTTP
   * where the async clipboard does not. Yields to a real DOM selection (e.g. in
   * the find field).
   */
  function onCopy(e: ClipboardEvent): void {
    if (p.root().hidden || !st.open_) return;
    if (!p.selectLayer().has()) return;
    if ((globalThis.getSelection?.()?.toString() ?? "") !== "") return;
    const text = p.selectLayer().text();
    if (text === "") return;
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  }

  return { syncPager, syncUrl, go, onKey, onCopy };
}
