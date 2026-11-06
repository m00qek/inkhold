// The PDF raster path: one page onto the canvas, then the overlays (find marks,
// selection, links, `.mark` ink), all placed against the canvas now on screen.

import type { Id, NoteMeta, PageRef, Theme } from "../../core/types";
import type { ViewerBody } from "../viewer/viewerChrome";
import type { LayersPanel } from "../layersPanel";
import type { NoteLayersController } from "../noteLayers";
import { toPanelLayers } from "../noteLayerModel";
import { FIT_PAGE, FIT_WIDTH } from "../viewer/viewerControls";
import type { LinkLayer } from "../linkLayer";
import type { PdfSelectionLayer } from "./pdfSelectionLayer";
import type { PdfFindController } from "./pdfFind";
import { binNotePageHref, notePageHref } from "../../router";
import { placePanelOverPage } from "../../render/markGeometry";
import type { PdfWord } from "../../render/pdfWire";
import type { PdfSession } from "../../render/pdfClient";
import { contentBox } from "../../ui/dom";

/**
 * Zoom steps relative to fit, since PDF page sizes vary about 7x (absolute steps
 * would make "zoom in" shrink a small page). `Fit ⇔` is second because the ladder
 * must ascend; both fits have multiplier 1 and branch in `fitScale`.
 */
export const ZOOMS = [FIT_PAGE, FIT_WIDTH, "150%", "200%", "300%"] as const;
export type Zoom = (typeof ZOOMS)[number];
export const ZOOM_SCALE: Record<Zoom, number> = {
  [FIT_PAGE]: 1,
  [FIT_WIDTH]: 1,
  "150%": 1.5,
  "200%": 2,
  "300%": 3,
};
/** Cap the raster so a big page at 200% cannot ask for a gigabyte of pixels. */
export const MAX_RASTER_PIXELS = 16 * 1024 * 1024;

/** The layers-panel id for the PDF page; negative so no `.mark` layer index collides. */
export const PDF_LAYER_ID = -1;

/** Fit scale in MuPDF points-per-unit; fit-width drops the height term. */
export function fitScaleIn(
  pageWidthPt: number,
  pageHeightPt: number,
  box: { w: number; h: number },
  fitWidth: boolean,
): number {
  if (pageWidthPt <= 0 || pageHeightPt <= 0) return 1;
  const byWidth = box.w / pageWidthPt;
  if (fitWidth) return byWidth;
  return Math.min(byWidth, box.h / pageHeightPt);
}

/** Clamp by pixel area (what costs wasm memory), not by a scale ceiling. */
export function clampRasterScale(
  pageWidthPt: number,
  pageHeightPt: number,
  wanted: number,
): number {
  const px = pageWidthPt * wanted * (pageHeightPt * wanted);
  if (px <= MAX_RASTER_PIXELS) return wanted;
  return wanted * Math.sqrt(MAX_RASTER_PIXELS / px);
}

/** Viewer state read on demand, since it can change across any `await`. */
export interface PdfPageRendererState {
  session(): PdfSession | null;
  isOpen(): boolean;
  generation(): number;
  pageIndex(): number;
  pageCount(): number;
  zoom(): Zoom;
  pinch(): number | null;
  meta(): NoteMeta | null;
  fromBin(): boolean;
  markId(): Id | null;
  markPages(): ReadonlyMap<number, PageRef>;
  /** The panels docked in `main` now, whose widths come off the page's box. */
  dockedPanels(): readonly HTMLElement[];
}

export interface PdfPageRendererDom {
  /** The flex row the page and docked panels share; what fit fits into. */
  main: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  body: ViewerBody;
  markCtl: NoteLayersController;
  linkLayer: LinkLayer;
  selectLayer: PdfSelectionLayer;
  layersPanel: LayersPanel;
}

export interface PdfPageRendererOptions {
  deps: {
    getTheme: () => Theme;
    api: { getPageBytes(id: Id, ref: PageRef): Promise<ArrayBuffer> };
  };
  state: PdfPageRendererState;
  dom: PdfPageRendererDom;
  /** Its marks repaint from a finished raster, and its word cache is the selection's too. */
  find: Pick<PdfFindController, "repaint" | "wordsKnown" | "wordsFor">;
  syncPager(): void;
  refreshGroups(): void;
  onJump(page: number): void;
}

export interface PdfPageRenderer {
  paint(): Promise<void>;
  /** `main`'s content box and gap, shared by the fit and the dock rule; `w` 0 means not laid out. */
  stageInner(): { w: number; h: number; gap: number };
  /** The canvas's box in CSS pixels: the one page-to-screen conversion. */
  cssCanvasSize(): { width: number; height: number };
  pageSizePt(): { width: number; height: number } | null;
  /** The page's size now, as a factor of Fit page (what a pinch starts from). */
  relativeScale(): number;
  reset(): void;
}

export function createPdfPageRenderer(opts: PdfPageRendererOptions): PdfPageRenderer {
  const { deps, state, dom, find } = opts;
  const { canvas, stage, main, body, markCtl, linkLayer, selectLayer, layersPanel } = dom;

  /** Size of the page on the canvas, held for find's own repaint schedule. */
  let pageSizePtNow: { width: number; height: number } | null = null;

  function stageInner(): { w: number; h: number; gap: number } {
    const cs = getComputedStyle(main);
    return {
      ...contentBox(main),
      gap: parseFloat(cs.columnGap || cs.gap || "0") || 0,
    };
  }

  /**
   * `main` less padding and every docked panel. Not measured from `.pdf-stage`,
   * which is sized by the canvas and so would never fit. Every panel counts:
   * missing one just runs the page under it with no scrollbar.
   */
  function availableBox(): { w: number; h: number } {
    const box = stageInner();
    let w = box.w;
    for (const panel of state.dockedPanels()) {
      w -= panel.getBoundingClientRect().width + box.gap;
    }
    return { w: Math.max(w, 120), h: Math.max(box.h, 120) };
  }

  function fitScale(pageWidthPt: number, pageHeightPt: number): number {
    return fitScaleIn(pageWidthPt, pageHeightPt, availableBox(), state.pinch() === null && state.zoom() === FIT_WIDTH);
  }

  /** Points to CSS px now: a pinch is a factor of Fit page, a rung a multiple of its fit. */
  function cssScale(pageWidthPt: number, pageHeightPt: number): number {
    return fitScale(pageWidthPt, pageHeightPt) * (state.pinch() ?? ZOOM_SCALE[state.zoom()]);
  }

  function relativeScale(): number {
    const size = pageSizePtNow;
    if (!size) return 1;
    const page = fitScaleIn(size.width, size.height, availableBox(), false);
    return page > 0 ? cssScale(size.width, size.height) / page : 1;
  }

  /** Raster DPR, capped at 2 to limit wasm heap use. */
  function rasterDpr(): number {
    return Math.min(globalThis.devicePixelRatio || 1, 2);
  }

  function cssCanvasSize(): { width: number; height: number } {
    const dpr = rasterDpr();
    return { width: canvas.width / dpr, height: canvas.height / dpr };
  }

  function scaleFor(pageWidthPt: number, pageHeightPt: number): number {
    const wanted = cssScale(pageWidthPt, pageHeightPt) * rasterDpr();
    return clampRasterScale(pageWidthPt, pageHeightPt, wanted);
  }

  async function paint(): Promise<void> {
    const mine = state.generation();
    const s = state.session();
    if (!s || !state.isOpen() || state.pageCount() === 0) return;
    // Read once: `pageIndex` can change across the awaits below.
    const page = state.pageIndex();
    let size: { width: number; height: number };
    try {
      size = await s.pageSize(page);
    } catch {
      return;
    }
    if (mine !== state.generation()) return;
    const scale = scaleFor(size.width, size.height);
    let frame;
    try {
      frame = await s.render(page, scale);
    } catch (err) {
      if (mine !== state.generation()) return;
      body.showPlaceholder("Couldn't draw this page", String((err as Error).message ?? err));
      return;
    }
    if (mine !== state.generation()) {
      // An ImageBitmap holds real pixels; close it rather than wait for GC.
      frame.bitmap.close();
      return;
    }
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.style.width = `${cssCanvasSize().width}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      frame.bitmap.close();
      return;
    }
    // `drawImage` of the transferred bitmap, avoiding a copy.
    ctx.drawImage(frame.bitmap, 0, 0);
    frame.bitmap.close();
    body.main.replaceChildren(stage);
    opts.syncPager();
    // Publish the size only now, and repaint find from here, so overlays follow zooms and panel toggles.
    pageSizePtNow = size;
    find.repaint();
    paintSelection();
    void paintLinks(page, size);
    // Export rows depend on what `paintMark` finds, so reconcile after it settles on every path.
    void paintMark(page, size).finally(() => opts.refreshGroups());
  }

  /** Stable empty: a new array would clear the selection on every zoom step. */
  const NO_WORDS: PdfWord[] = [];

  function paintSelection(): void {
    const size = pageSizePtNow;
    if (!size) return;
    selectLayer.setPage(find.wordsKnown(state.pageIndex()) ?? NO_WORDS, {
      pagePt: size,
      canvas: cssCanvasSize(),
    });
  }

  /**
   * Fetch words on intent (pointer over the page), not per paint: structured
   * text runs the whole page in the decoder. Shares find's cache and in-flight
   * fetch. Failure only means the page cannot be selected.
   */
  async function ensureSelectionWords(): Promise<void> {
    const page = state.pageIndex();
    if (find.wordsKnown(page) !== null) return;
    if (!state.session() || !state.isOpen()) return;
    const mine = state.generation();
    await find.wordsFor(page);
    if (mine !== state.generation() || state.pageIndex() !== page) return;
    paintSelection();
  }
  // On the stage, since the layer is `pointer-events: none` until it has words.
  stage.addEventListener("pointerenter", () => void ensureSelectionWords());
  // Also on press, for a pen that arrives already down (the first press selects nothing).
  stage.addEventListener("pointerdown", () => void ensureSelectionWords());

  /**
   * The document's own link annotations. Old links come down before any await;
   * a failure only leaves the layer empty.
   */
  async function paintLinks(
    page: number,
    pageSizePt: { width: number; height: number },
  ): Promise<void> {
    const mine = state.generation();
    const s = state.session();
    const m = state.meta();
    linkLayer.clear();
    if (!s || !state.isOpen() || !m) return;
    let links;
    try {
      links = await s.pageLinks(page);
    } catch {
      return;
    }
    // Generation moves per document, not per page turn, so check the page too.
    if (mine !== state.generation() || state.pageIndex() !== page || links.length === 0) return;
    linkLayer.setLinks(links, {
      pagePt: pageSizePt,
      canvas: cssCanvasSize(),
      // A real route; bin-origin files keep the bin form or the jump would 404.
      hrefForPage: (p) => (state.fromBin() ? binNotePageHref(m.id, p) : notePageHref(m.id, p)),
      // The pager's path, so an in-document link repaints rather than reopens.
      onJump: (p) => opts.onJump(p),
    });
  }

  /** The `.mark` ink over the drawn page, positioned with CSS so zoom never re-decodes. */
  async function paintMark(
    page: number,
    pageSizePt: { width: number; height: number },
  ): Promise<void> {
    const mine = state.generation();
    const ref = state.markPages().get(page);
    const markId = state.markId();
    if (!ref || !markId) {
      markCtl.el.hidden = true;
      layersPanel.setLayers([pdfRow()]);
      return;
    }
    /**
     * Generation is shared by all pages of a document, so a late fetch for a
     * previous page would paint its ink here; compare the page's `PageRef` identity.
     */
    const superseded = (): boolean =>
      mine !== state.generation() || state.markPages().get(state.pageIndex()) !== ref;
    const place = placePanelOverPage(
      { width: ref.width, height: ref.height },
      pageSizePt,
      cssCanvasSize(),
    );
    const st = markCtl.el.style;
    st.position = "absolute";
    st.left = `${place.left}px`;
    st.top = `${place.top}px`;
    st.width = `${place.width}px`;
    st.height = `${place.height}px`;
    markCtl.el.hidden = false;

    if (markCtl.isPresented(ref.hash, deps.getTheme())) {
      layersPanel.setLayers(withPdfRow(markCtl.stack()?.views));
      return;
    }
    try {
      const bytes = await deps.api.getPageBytes(markId, ref);
      // Before `present`, which commits and cannot be undone.
      if (superseded()) return;
      const stack = await markCtl.present(markId, ref.hash, bytes, ref.layers ?? [], deps.getTheme());
      if (superseded()) return;
      if (!stack) {
        // Undecodable: release the old ink (`present` returned null without
        // releasing it), unless a concurrent present of this page already won.
        if (!markCtl.isPresented(ref.hash, deps.getTheme())) {
          markCtl.release();
          markCtl.el.hidden = true;
          layersPanel.setLayers([pdfRow()]);
        }
        return;
      }
      suppressBackground(stack.views);
      layersPanel.setLayers(withPdfRow(stack.views));
    } catch {
      // A missing overlay, not a broken page.
      if (superseded()) return;
      markCtl.el.hidden = true;
      layersPanel.setLayers([pdfRow()]);
    }
  }

  /**
   * The mark's BGLAYER is the device's paper; over a PDF it would be an opaque
   * second sheet, so it is hidden and dropped from the panel.
   */
  function suppressBackground(views: readonly { index: number; slot: string }[] | undefined): void {
    for (const v of views ?? []) if (v.slot === "background") markCtl.setVisible(v.index, false);
  }

  function pdfRow(): { id: number; name: string; visible: boolean } {
    return { id: PDF_LAYER_ID, name: "Document", visible: canvas.style.visibility !== "hidden" };
  }

  /** Mark layers, then the page: the panel's order. */
  function withPdfRow(views: Parameters<typeof toPanelLayers>[0] | undefined) {
    if (!views) return [pdfRow()];
    const ink = views.filter((v) => v.slot !== "background");
    return [...toPanelLayers(ink), pdfRow()];
  }

  return {
    paint,
    stageInner,
    cssCanvasSize,
    pageSizePt: () => pageSizePtNow,
    relativeScale,
    reset(): void {
      pageSizePtNow = null;
    },
  };
}
