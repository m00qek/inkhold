// The reader's page painting: one page through the layers path or the composite, the filmstrip, and refetching stale metadata.

import type { Hash, Id, NoteMeta, PageRef } from "../../core/types";
import { defaultPlaceholder, renderPage } from "../../render/lazy";
import { dispatchApiFailure } from "../../api/client";
import { FIT_PAGE } from "../viewer/viewerControls";
import { isPhone } from "../../ui/breakpoints";
import { tokenPx } from "../../ui/sidePanel";
import type { PageLayer } from "../../core/types";
import type { ReaderCtx } from "./readerContext";
import { DPR_CAP, ZOOM_SCALE } from "./reader";
import { contentBox } from "../../ui/dom";

export interface ReaderPaint {
  /** A `?v=` 404'd (STALE_PAGE): refetch the metadata and rebuild. */
  refetchMeta(noteId: Id, page: PageRef): Promise<void>;
  /** Paints page `index` through the layers path or the composite. */
  showPage(index: number): Promise<void>;
  buildFilmstrip(): void;
}

export function createReaderPaint(ctx: ReaderCtx): ReaderPaint {
  const { st } = ctx;
  /** Stale hashes already refetched: one metadata refetch per hash is the loop guard. */
  const staleHandled = new Set<Hash>();

  /** A `?v=` 404'd (STALE_PAGE): refetch the metadata and rebuild. */
  async function refetchMeta(noteId: Id, page: PageRef): Promise<void> {
    if (staleHandled.has(page.hash)) return;
    staleHandled.add(page.hash);
    let fresh: NoteMeta;
    try {
      fresh = await ctx.api.getNoteMeta(noteId);
    } catch (e) {
      dispatchApiFailure({ onSessionExpired: ctx.deps.onSessionExpired }, e);
      return;
    }
    if (!st.open || st.meta?.id !== noteId) return; // closed / moved on while fetching
    st.meta = fresh;
    // `setNote` drops the cached word boxes; the links memo would only hold dead entries.
    ctx.linksByPage.clear();
    ctx.find.setNote(fresh.id, fresh.fileHash, fresh.pages);
    buildFilmstrip();
    void showPage(st.pageIndex);
  }

  /**
   * Try the per-layer path for the focused page; false means fall back to the
   * composite. Same page and theme short-circuits, so relayouts are CSS-only.
   */
  async function presentLayers(noteId: Id, page: PageRef, vos: PageLayer[], token: number): Promise<boolean> {
    const theme = ctx.getTheme();
    if (ctx.noteLayerCtl.isPresented(page.hash, theme)) {
      // Same page: just undo `showPage`'s hide (same task, so no flicker).
      ctx.noteLayerCtl.el.hidden = false;
      ctx.panels.refreshLayersUi();
      return true;
    }
    try {
      const bytes = await ctx.api.getPageBytes(noteId, page);
      if (token !== st.paintToken) return false;
      const stack = await ctx.noteLayerCtl.present(noteId, page.hash, bytes, vos, theme);
      if (token !== st.paintToken) return false;
      if (stack) {
        ctx.panels.refreshLayersUi();
        return true;
      }
    } catch (e) {
      // The layered path must still report session/stale failures.
      dispatchApiFailure(ctx.failures, e, noteId, page);
    }
    ctx.noteLayerCtl.release();
    ctx.panels.refreshLayersUi();
    return false;
  }

  async function showPage(index: number): Promise<void> {
    if (!st.meta || st.mode !== "note") return;
    st.pageIndex = Math.max(0, Math.min(st.meta.pages.length - 1, index));
    const page = st.meta.pages[st.pageIndex];
    if (!page) return;

    // Every page change comes through here, so the strip follows for free.
    ctx.pageIndexPanel.setCurrent(st.pageIndex);
    ctx.pager.set(st.pageIndex, st.meta.pages.length);

    // Decided from metadata now, not after the decode. The server omits
    // `layers` when a page has none, so only skeleton pages (index > 0 before
    // the meta resolves) are unknown.
    const pageIsAuthoritative = st.metaResolved || st.pageIndex === 0;
    const layerVos = page.layers ?? null;
    const pageHasLayers = layerVos !== null && layerVos.length > 0;
    st.layersAvail = pageHasLayers ? "some" : pageIsAuthoritative ? "none" : "unknown";
    ctx.panels.refreshLayersUi();

    // Hide the previous page's stack so it doesn't cover the new page's blur-up.
    // Hidden, not released: release bumps `gen` and loses the `isPresented`
    // short-circuit that makes relayouts free.
    if (!ctx.panels.stackIsCurrent()) {
      ctx.noteLayerCtl.el.hidden = true;
      ctx.pageCanvas.hidden = false;
    }

    // Size the page: fit the stage's content box (or a zoom step), clamp to
    // width. Its padding, not a constant: on a phone an open panel is a sheet the
    // stage pads itself clear of, so Fit lands the page above it.
    const box = contentBox(ctx.stage);
    const aspect = page.width / page.height;
    // Docked side panels take their widths from the layout tokens; a phone's
    // are sheets below the page and take none.
    const beside = !isPhone();
    const gap = tokenPx("--panel-gap", 22);
    const ocrW = beside && ctx.ocr.isOpen() ? tokenPx("--panel-w", 268) + gap : 0;
    const layersW = beside && ctx.panels.layersPanelShown() ? tokenPx("--panel-w-wide", 320) + gap : 0;
    const pagesW = beside && st.pageIndexOpen ? tokenPx("--panel-w-narrow", 180) + gap : 0;
    const maxW = Math.max(box.w - ocrW - layersW - pagesW, 80);
    // Fit keeps the whole page in view. A zoom step is a size, and a pinch a
    // factor of Fit; either may be wider than the stage, which then scrolls
    // sideways: clamping them too threw every step away wherever Fit already
    // filled the width (a phone, a tablet held upright), so handwriting could
    // never be enlarged there.
    const fitH = Math.min(Math.min(Math.max(box.h, 120), 1000), maxW / aspect);
    let h = fitH;
    // Note mode only, so `zoom` is a note-ladder value.
    if (st.pinch !== null) h = fitH * st.pinch;
    else if (st.zoom !== FIT_PAGE && st.zoom in ZOOM_SCALE) h = 640 * ZOOM_SCALE[st.zoom as keyof typeof ZOOM_SCALE];
    const w = h * aspect;
    st.fitScale = h / fitH;
    ctx.pageEl.style.width = `${Math.round(w)}px`;
    ctx.pageEl.style.height = `${Math.round(h)}px`;
    ctx.pageWrap.style.height = `${Math.round(h)}px`;

    // OCR and find follow the page here; find after the resize, since ovals use page pixels.
    ctx.ocr.setPage(st.meta.id, page);
    ctx.find.setPage(st.pageIndex);

    const token = ++st.paintToken;
    const noteId: Id = st.meta.id;

    // Links depend on the page box, not pixels; not awaited so they never delay a turn.
    void ctx.overlays.paintLinks(st.pageIndex, token);

    // Blur up the thumbnail, or draw the ruled sheet, so the old page doesn't linger.
    let thumbDrawn = false;
    const thumbCanvas = ctx.pageIndexPanel.thumbCanvas(st.pageIndex);
    if (thumbCanvas && thumbCanvas.width > 0 && thumbCanvas.height > 0) {
      const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
      ctx.pageCanvas.width = Math.round(w * dpr);
      ctx.pageCanvas.height = Math.round(h * dpr);
      const g = ctx.pageCanvas.getContext("2d");
      if (g) {
        g.drawImage(thumbCanvas, 0, 0, ctx.pageCanvas.width, ctx.pageCanvas.height);
        ctx.pageCanvas.classList.add("is-loading");
        thumbDrawn = true;
      }
    }
    if (!thumbDrawn) {
      // The strip is virtualised, so a far jump may have no painted thumb to blur.
      ctx.pageCanvas.classList.remove("is-loading");
      defaultPlaceholder(ctx.pageCanvas, page);
    }

    // Layered path: focused page only; any failure paints the composite below.
    let layeredUp = false;
    if (page.hash !== "" && pageHasLayers && layerVos) {
      layeredUp = await presentLayers(noteId, page, layerVos, token);
      if (token !== st.paintToken) return; // a newer showPage superseded us
      // The decode can still fail (v1/hostile payload, slot mismatch, stale
      // wasm); stop offering a stack that will never load.
      if (!layeredUp) {
        st.layersAvail = "none";
        ctx.panels.refreshLayersUi();
      }
    } else {
      ctx.noteLayerCtl.release();
      ctx.panels.refreshLayersUi();
    }
    // One paint owns the page; the other is hidden.
    ctx.pageCanvas.hidden = layeredUp;
    if (layeredUp) ctx.pageCanvas.classList.remove("is-loading");

    if (!layeredUp && page.hash !== "") {
      try {
        const bitmap = await renderPage({ api: ctx.api, renderer: ctx.renderer, cache: ctx.cache, theme: ctx.getTheme() }, noteId, page, "full");
        if (token !== st.paintToken) return; // a newer showPage superseded us
        const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
        ctx.pageCanvas.width = Math.round(w * dpr);
        ctx.pageCanvas.height = Math.round(h * dpr);
        const g = ctx.pageCanvas.getContext("2d");
        if (g) {
          g.drawImage(bitmap, 0, 0, ctx.pageCanvas.width, ctx.pageCanvas.height);
          ctx.pageCanvas.classList.remove("is-loading");
        }
      } catch (e) {
        // Keep the previous paint; session/stale errors still go to the sink.
        dispatchApiFailure(ctx.failures, e, noteId, page);
      }
    }

    // Warm the neighbours so paging is instant.
    for (const j of [st.pageIndex - 1, st.pageIndex + 1]) {
      const neighbour = st.meta.pages[j];
      if (neighbour) ctx.filmEngine.prefetch(noteId, neighbour, "full");
    }
  }

  /** Rebuild the strip from `meta` (open, skeleton resolve, STALE_PAGE); badges survive. */
  function buildFilmstrip(): void {
    ctx.filmEngine.reset();
    if (!st.meta) {
      ctx.pageIndexPanel.clear();
      return;
    }
    ctx.pageIndexPanel.setPages(st.meta.pages.length);
    // `hasInk` comes with the page list, so it covers unpainted rows; pages
    // without it are omitted, not guessed.
    const inked = new Map<number, boolean>();
    st.meta.pages.forEach((page, i) => {
      if (page.hasInk !== undefined) inked.set(i, page.hasInk);
    });
    ctx.pageIndexPanel.setInk(inked);
    ctx.pageIndexPanel.setCurrent(st.pageIndex);
  }

  return { refetchMeta, showPage, buildFilmstrip };
}
