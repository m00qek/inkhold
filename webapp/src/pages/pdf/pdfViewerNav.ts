// The PDF viewer's navigation: going to a page, publishing it to the pager and
// the URL, and the keyboard and copy handlers.

import type { PdfViewerCtx } from "./pdfViewerContext";

export interface PdfNav {
  /** The pager reflects `st.pageIndex`/`st.pageCount`. */
  syncPager(): void;
  /** Publishes page and find query through `onPosition`. */
  syncUrl(): void;
  go(to: number): Promise<void>;
  onKey(e: KeyboardEvent): void;
  onCopy(e: ClipboardEvent): void;
}

export function createPdfNav(ctx: PdfViewerCtx): PdfNav {
  const { st } = ctx;
  function syncPager(): void {
    ctx.pager.set(st.pageIndex, st.pageCount);
  }

  /**
   * Publish the page (and query) to the URL. Bin origins use
   * `#/bin/note/:id/page/:n` with no query, since a trashed blob is not served
   * at the live route.
   */
  function syncUrl(): void {
    if (!st.open_ || !st.meta) return;
    ctx.deps.onPosition?.(st.meta.id, st.pageIndex, st.fromBin ? "" : ctx.find.query(), undefined, st.fromBin || undefined);
  }

  async function go(to: number): Promise<void> {
    if (!st.open_ || to < 0 || to >= st.pageCount || to === st.pageIndex) return;
    st.pageIndex = to;
    syncPager();
    ctx.pagesPanel.setCurrent(to);
    // Tracks the entry the page is inside, not the last one clicked.
    ctx.outlinePanel.setCurrent(to);
    ctx.digests.setCurrent(to);
    // Before `syncUrl` and the raster, so URL and marks are already the new page's.
    ctx.find.setPage(to);
    syncUrl();
    await ctx.renderer.paint();
  }

  // ---- keyboard (only while on screen) ----
  // Paging matches the reader, including leaving modified arrows alone.
  function onKey(e: KeyboardEvent): void {
    if (ctx.root.hidden) return;
    // Ctrl+F before the input guard, so it reaches (or re-focuses) the field from anywhere.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      ctx.find.open();
      return;
    }
    // Escape unwinds one thing at a time: selection, find, then the viewer.
    if (e.key === "Escape") {
      if (ctx.selectLayer.has()) {
        ctx.selectLayer.clear();
        return;
      }
      if (ctx.find.isOpen()) {
        ctx.find.close();
        ctx.findBar.input.value = "";
        return;
      }
      return ctx.deps.onBack();
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
    if (ctx.root.hidden || !st.open_) return;
    if (!ctx.selectLayer.has()) return;
    if ((globalThis.getSelection?.()?.toString() ?? "") !== "") return;
    const text = ctx.selectLayer.text();
    if (text === "") return;
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  }

  return { syncPager, syncUrl, go, onKey, onCopy };
}
