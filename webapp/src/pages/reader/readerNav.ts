// The reader's navigation: page turns, the URL it publishes, the keyboard and image sizing.

import { createFindController } from "../findInNote";
import { createFindBarView } from "./readerBars";
import { FIT_PAGE, FIT_WIDTH } from "../viewer/viewerControls";
import { VIEWER_DEBOUNCE_MS } from "../viewer/viewerChrome";
import type { ReaderState } from "./readerState";

import type { ReaderDeps } from "./reader";

export interface ReaderNavParts {
  deps: ReaderDeps;
  showPage: (index: number) => Promise<void>;
  fileImg: () => HTMLImageElement;
  findInput: () => ReturnType<typeof createFindBarView>["input"];
  find: () => ReturnType<typeof createFindController>;
}

export function createReaderNav(st: ReaderState, p: ReaderNavParts) {
  /** What the URL should say the search is: nothing at all while the bar is shut. */
  function urlQuery(): string {
    return p.find().isOpen() ? p.findInput().value.trim() : "";
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
        p.deps.onPosition?.(st.meta.id, st.pageIndex, "", undefined, true);
        return;
      }
      p.deps.onPosition?.(st.meta.id, st.pageIndex, urlQuery(), st.previewVersion?.md5);
      return;
    }
    // An image publishes only for bin or history opens.
    if (st.mode === "image") {
      if (st.fromBin) {
        p.deps.onPosition?.(st.meta.id, 0, "", undefined, true);
        return;
      }
      if (st.previewVersion) p.deps.onPosition?.(st.meta.id, 0, "", st.previewVersion.md5);
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
    void p.showPage(index);
    syncUrl();
  }

  // --- keyboard (only while open) ------------------------------------------
  function onKey(e: KeyboardEvent): void {
    if (!st.open) return;
    // An open export menu and the find bar each take Escape before the reader.
    if (e.key === "Escape") {
      if (p.find().isOpen()) {
        p.find().close();
        syncUrl();
        return;
      }
      return p.deps.onBack();
    }
    if (st.mode !== "note") return;

    // Ctrl/Cmd+F is claimed only here, so the browser's find works elsewhere.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      p.find().open();
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
      p.fileImg().style.width = "";
      p.fileImg().style.maxWidth = "";
      p.fileImg().style.maxHeight = "";
      return;
    }
    // Past Fit the image may overflow `.filestage`, so lift the max-* clamps.
    p.fileImg().style.maxWidth = "none";
    p.fileImg().style.maxHeight = "none";
    if (st.zoom === FIT_WIDTH) {
      // Unlike Fit, this enlarges small images.
      p.fileImg().style.width = "100%";
      return;
    }
    // Not `ZOOM_SCALE`: for an image 100% means natural size.
    const factor = Number.parseInt(st.zoom, 10) / 100;
    const natural = p.fileImg().naturalWidth || p.fileImg().clientWidth;
    if (natural > 0 && Number.isFinite(factor)) {
      p.fileImg().style.width = `${Math.round(natural * factor)}px`;
    }
  }

  return { urlQuery, findQuery, syncUrl, queueUrlSync, goToPage, onKey, sizeImage };
}
