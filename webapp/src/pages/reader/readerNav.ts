// The reader's navigation: page turns, the URL it publishes, the keyboard and image sizing.

import { FIT_PAGE, FIT_WIDTH } from "../viewer/viewerControls";
import { VIEWER_DEBOUNCE_MS } from "../viewer/viewerChrome";
import type { ReaderCtx } from "./readerContext";

export interface ReaderNav {
  /** What the URL should say the search is: nothing while the bar is shut. */
  urlQuery(): string;
  findQuery(raw: string): string;
  /** Publishes page and query through `onPosition` (see `ReaderState.urlSuspended`). */
  syncUrl(): void;
  queueUrlSync(): void;
  goToPage(index: number): void;
  onKey(e: KeyboardEvent): void;
  /** Applies the image zoom ladder to the `<img>` stage. */
  sizeImage(): void;
}

export function createReaderNav(ctx: ReaderCtx): ReaderNav {
  const { st } = ctx;
  /** What the URL should say the search is: nothing at all while the bar is shut. */
  function urlQuery(): string {
    return ctx.find.isOpen() ? ctx.findBar.input.value.trim() : "";
  }

  /** Trimmed as {@link urlQuery} trims, so priming doesn't rewrite the URL. */
  function findQuery(raw: string): string {
    return raw.trim();
  }

  function syncUrl(): void {
    if (st.urlTimer !== undefined) {
      clearTimeout(st.urlTimer);
      st.urlTimer = undefined;
    }
    if (!st.open || st.urlSuspended || !st.meta) return;
    // Bin opens use the bin route (the live one 404s); history previews carry the md5.
    if (st.mode === "note") {
      if (st.fromBin) {
        ctx.deps.onPosition?.(st.meta.id, st.pageIndex, "", undefined, true);
        return;
      }
      ctx.deps.onPosition?.(st.meta.id, st.pageIndex, urlQuery(), st.previewVersion?.md5);
      return;
    }
    // An image publishes only for bin or history opens.
    if (st.mode === "image") {
      if (st.fromBin) {
        ctx.deps.onPosition?.(st.meta.id, 0, "", undefined, true);
        return;
      }
      if (st.previewVersion) ctx.deps.onPosition?.(st.meta.id, 0, "", st.previewVersion.md5);
    }
  }

  /** Debounced, for the find field: the URL settles on the word, not each prefix. */
  function queueUrlSync(): void {
    if (st.urlTimer !== undefined) clearTimeout(st.urlTimer);
    st.urlTimer = setTimeout(() => {
      st.urlTimer = undefined;
      syncUrl();
    }, VIEWER_DEBOUNCE_MS);
  }

  /**
   * Publish the position after `showPage`, in one place. Not folded in because
   * `showPage` awaits the paint, and the URL should follow the turn.
   */
  function goToPage(index: number): void {
    void ctx.paint.showPage(index);
    syncUrl();
  }

  // --- keyboard (only while open) ------------------------------------------
  function onKey(e: KeyboardEvent): void {
    if (!st.open) return;
    // An open export menu and the find bar each take Escape before the reader.
    if (e.key === "Escape") {
      if (ctx.find.isOpen()) {
        ctx.find.close();
        syncUrl();
        return;
      }
      return ctx.deps.onBack();
    }
    if (st.mode !== "note") return;

    // Ctrl/Cmd+F is claimed only here, so the browser's find works elsewhere.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      ctx.find.open();
      return;
    }

    // Paging keys don't apply inside inputs (including the pager's field).
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") goToPage(st.pageIndex + 1);
    else if (e.key === "ArrowLeft") goToPage(st.pageIndex - 1);
    // Home/End are prevented, or they would also scroll the document.
    else if (e.key === "Home") {
      e.preventDefault();
      goToPage(0);
    } else if (e.key === "End" && st.meta) {
      e.preventDefault();
      goToPage(st.meta.pages.length - 1);
    }
  }

  /** Apply the current zoom step to the image preview. */
  function sizeImage(): void {
    if (st.zoom === FIT_PAGE) {
      // Back to the CSS rule: fit the stage in both axes.
      ctx.files.img.style.width = "";
      ctx.files.img.style.maxWidth = "";
      ctx.files.img.style.maxHeight = "";
      return;
    }
    // Past Fit the image may overflow `.filestage`, so lift the max-* clamps.
    ctx.files.img.style.maxWidth = "none";
    ctx.files.img.style.maxHeight = "none";
    if (st.zoom === FIT_WIDTH) {
      // Unlike Fit, this enlarges small images.
      ctx.files.img.style.width = "100%";
      return;
    }
    // Not `ZOOM_SCALE`: for an image 100% means natural size.
    const factor = Number.parseInt(st.zoom, 10) / 100;
    const natural = ctx.files.img.naturalWidth || ctx.files.img.clientWidth;
    if (natural > 0 && Number.isFinite(factor)) {
      ctx.files.img.style.width = `${Math.round(natural * factor)}px`;
    }
  }

  return { urlQuery, findQuery, syncUrl, queueUrlSync, goToPage, onKey, sizeImage };
}
