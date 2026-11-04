// The reader's page painting: one page through the layers path or the composite, the filmstrip, and refetching stale metadata.

import type { Hash, Id, NoteMeta, PageRef } from "../core/types";
import { defaultPlaceholder, renderPage, type LazyEngine } from "../render/lazy";
import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import { createOcrController } from "./ocrPanel";
import { createFindController } from "./findInNote";
import { createPager, FIT_PAGE } from "./viewerControls";
import { tokenPx } from "../ui/sidePanel";
import { createPageIndex } from "./pageIndex";
import type { PdfLink } from "../core/types";
import { createNoteLayersController } from "./noteLayers";
import type { PageLayer } from "../core/types";
import type { ReaderState } from "./readerState";
import { createReaderOverlays } from "./readerOverlays";
import { createReaderPanels } from "./readerPanels";

import type { ReaderDeps } from "./reader";
import { DPR_CAP, ZOOM_SCALE } from "./reader";

export interface ReaderPaintParts {
  deps: ReaderDeps;
  api: () => ReaderDeps["api"];
  renderer: () => ReaderDeps["renderer"];
  cache: () => ReaderDeps["cache"];
  getTheme: () => ReaderDeps["getTheme"];
  pageCanvas: () => HTMLCanvasElement;
  noteLayerCtl: () => ReturnType<typeof createNoteLayersController>;
  pageEl: () => HTMLElement;
  pageIndexPanel: () => ReturnType<typeof createPageIndex>;
  pageWrap: () => HTMLElement;
  stage: () => HTMLElement;
  pager: () => ReturnType<typeof createPager>;
  layersPanelShown: () => ReturnType<typeof createReaderPanels>["layersPanelShown"];
  refreshLayersUi: () => ReturnType<typeof createReaderPanels>["refreshLayersUi"];
  stackIsCurrent: () => ReturnType<typeof createReaderPanels>["stackIsCurrent"];
  paintLinks: () => ReturnType<typeof createReaderOverlays>["paintLinks"];
  staleHandled: () => Set<Hash>;
  failures: () => ApiFailureSink;
  ocr: () => ReturnType<typeof createOcrController>;
  linksByPage: () => Map<string, readonly PdfLink[]>;
  find: () => ReturnType<typeof createFindController>;
  filmEngine: () => LazyEngine;
}

export function createReaderPaint(st: ReaderState, p: ReaderPaintParts) {
  /** A `?v=` 404'd (STALE_PAGE): refetch the metadata and rebuild. */
  async function refetchMeta(noteId: Id, page: PageRef): Promise<void> {
    if (p.staleHandled().has(page.hash)) return;
    p.staleHandled().add(page.hash);
    let fresh: NoteMeta;
    try {
      fresh = await p.api().getNoteMeta(noteId);
    } catch (e) {
      dispatchApiFailure({ onSessionExpired: p.deps.onSessionExpired }, e);
      return;
    }
    if (!st.open || st.meta?.id !== noteId) return; // closed / moved on while fetching
    st.meta = fresh;
    // `setNote` drops the cached word boxes; the links memo would only hold dead entries.
    p.linksByPage().clear();
    p.find().setNote(fresh.id, fresh.fileHash, fresh.pages);
    buildFilmstrip();
    void showPage(st.pageIndex);
  }

  /**
   * Try the per-layer path for the focused page; false means fall back to the
   * composite. Same page and theme short-circuits, so relayouts are CSS-only.
   */
  async function presentLayers(noteId: Id, page: PageRef, vos: PageLayer[], token: number): Promise<boolean> {
    const theme = p.getTheme()();
    if (p.noteLayerCtl().isPresented(page.hash, theme)) {
      // Same page: just undo `showPage`'s hide (same task, so no flicker).
      p.noteLayerCtl().el.hidden = false;
      p.refreshLayersUi()();
      return true;
    }
    try {
      const bytes = await p.api().getPageBytes(noteId, page);
      if (token !== st.paintToken) return false;
      const stack = await p.noteLayerCtl().present(noteId, page.hash, bytes, vos, theme);
      if (token !== st.paintToken) return false;
      if (stack) {
        p.refreshLayersUi()();
        return true;
      }
    } catch (e) {
      // The layered path must still report session/stale failures.
      dispatchApiFailure(p.failures(), e, noteId, page);
    }
    p.noteLayerCtl().release();
    p.refreshLayersUi()();
    return false;
  }

  async function showPage(index: number): Promise<void> {
    if (!st.meta || st.mode !== "note") return;
    st.pageIndex = Math.max(0, Math.min(st.meta.pages.length - 1, index));
    const page = st.meta.pages[st.pageIndex];
    if (!page) return;

    // Every page change comes through here, so the strip follows for free.
    p.pageIndexPanel().setCurrent(st.pageIndex);
    p.pager().set(st.pageIndex, st.meta.pages.length);

    // Decided from metadata now, not after the decode. The server omits
    // `layers` when a page has none, so only skeleton pages (index > 0 before
    // the meta resolves) are unknown.
    const pageIsAuthoritative = st.metaResolved || st.pageIndex === 0;
    const layerVos = page.layers ?? null;
    const pageHasLayers = layerVos !== null && layerVos.length > 0;
    st.layersAvail = pageHasLayers ? "some" : pageIsAuthoritative ? "none" : "unknown";
    p.refreshLayersUi()();

    // Hide the previous page's stack so it doesn't cover the new page's blur-up.
    // Hidden, not released: release bumps `gen` and loses the `isPresented`
    // short-circuit that makes relayouts free.
    if (!p.stackIsCurrent()()) {
      p.noteLayerCtl().el.hidden = true;
      p.pageCanvas().hidden = false;
    }

    // Size the page: fit the stage height (or a zoom step), clamp to width.
    const rect = p.stage().getBoundingClientRect();
    const aspect = page.width / page.height;
    let h = Math.min(Math.max(rect.height - 56, 120), 1000);
    // Note mode only, so `zoom` is a note-ladder value.
    if (st.zoom !== FIT_PAGE && st.zoom in ZOOM_SCALE) h = 640 * ZOOM_SCALE[st.zoom as keyof typeof ZOOM_SCALE];
    let w = h * aspect;
    // Side panels take their widths from the layout tokens.
    const gap = tokenPx("--panel-gap", 22);
    const ocrW = p.ocr().isOpen() ? tokenPx("--panel-w", 268) + gap : 0;
    const layersW = p.layersPanelShown()() ? tokenPx("--panel-w-wide", 320) + gap : 0;
    const pagesW = st.pageIndexOpen ? tokenPx("--panel-w-narrow", 180) + gap : 0;
    const maxW = Math.max(rect.width - 56 - ocrW - layersW - pagesW, 80);
    if (w > maxW) {
      w = maxW;
      h = w / aspect;
    }
    p.pageEl().style.width = `${Math.round(w)}px`;
    p.pageEl().style.height = `${Math.round(h)}px`;
    p.pageWrap().style.height = `${Math.round(h)}px`;

    // OCR and find follow the page here; find after the resize, since ovals use page pixels.
    p.ocr().setPage(st.meta.id, page);
    p.find().setPage(st.pageIndex);

    const token = ++st.paintToken;
    const noteId: Id = st.meta.id;

    // Links depend on the page box, not pixels; not awaited so they never delay a turn.
    void p.paintLinks()(st.pageIndex, token);

    // Blur up the thumbnail, or draw the ruled sheet, so the old page doesn't linger.
    let thumbDrawn = false;
    const thumbCanvas = p.pageIndexPanel().thumbCanvas(st.pageIndex);
    if (thumbCanvas && thumbCanvas.width > 0 && thumbCanvas.height > 0) {
      const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
      p.pageCanvas().width = Math.round(w * dpr);
      p.pageCanvas().height = Math.round(h * dpr);
      const ctx = p.pageCanvas().getContext("2d");
      if (ctx) {
        ctx.drawImage(thumbCanvas, 0, 0, p.pageCanvas().width, p.pageCanvas().height);
        p.pageCanvas().classList.add("is-loading");
        thumbDrawn = true;
      }
    }
    if (!thumbDrawn) {
      // The strip is virtualised, so a far jump may have no painted thumb to blur.
      p.pageCanvas().classList.remove("is-loading");
      defaultPlaceholder(p.pageCanvas(), page);
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
        p.refreshLayersUi()();
      }
    } else {
      p.noteLayerCtl().release();
      p.refreshLayersUi()();
    }
    // One paint owns the page; the other is hidden.
    p.pageCanvas().hidden = layeredUp;
    if (layeredUp) p.pageCanvas().classList.remove("is-loading");

    if (!layeredUp && page.hash !== "") {
      try {
        const bitmap = await renderPage({ api: p.api(), renderer: p.renderer(), cache: p.cache(), theme: p.getTheme()() }, noteId, page, "full");
        if (token !== st.paintToken) return; // a newer showPage superseded us
        const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
        p.pageCanvas().width = Math.round(w * dpr);
        p.pageCanvas().height = Math.round(h * dpr);
        const ctx = p.pageCanvas().getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, p.pageCanvas().width, p.pageCanvas().height);
          p.pageCanvas().classList.remove("is-loading");
        }
      } catch (e) {
        // Keep the previous paint; session/stale errors still go to the sink.
        dispatchApiFailure(p.failures(), e, noteId, page);
      }
    }

    // Warm the neighbours so paging is instant.
    for (const j of [st.pageIndex - 1, st.pageIndex + 1]) {
      const neighbour = st.meta.pages[j];
      if (neighbour) p.filmEngine().prefetch(noteId, neighbour, "full");
    }
  }

  /** Rebuild the strip from `meta` (open, skeleton resolve, STALE_PAGE); badges survive. */
  function buildFilmstrip(): void {
    p.filmEngine().reset();
    if (!st.meta) {
      p.pageIndexPanel().clear();
      return;
    }
    p.pageIndexPanel().setPages(st.meta.pages.length);
    // `hasInk` comes with the page list, so it covers unpainted rows; pages
    // without it are omitted, not guessed.
    const inked = new Map<number, boolean>();
    st.meta.pages.forEach((page, i) => {
      if (page.hasInk !== undefined) inked.set(i, page.hasInk);
    });
    p.pageIndexPanel().setInk(inked);
    p.pageIndexPanel().setCurrent(st.pageIndex);
  }

  return { refetchMeta, presentLayers, showPage, buildFilmstrip };
}
