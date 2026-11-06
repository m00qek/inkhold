// The PDF export driver: renders pages, decodes ink, fetches the original and
// drives the incremental update. Kept apart from `pdfExports.ts` so that module
// never sees the decoder session or viewer state.

import type { Id, NoteMeta, PageRef, Theme } from "../../core/types";
import { rawFileUrl } from "../../core/fileKind";
import type { NoteLayersController } from "../noteLayers";
import type { NoteLayerView } from "../noteLayerModel";
import {
  composeMarkExportModel,
  inkAlpha,
  type MarkInkLayer,
  type PdfExportsDeps,
  type PdfExportState,
} from "./pdfExports";
import type { LayeredExportModel } from "../../export/layered";
import { markExportMatrix, markExportSpace } from "../../render/markGeometry";
import { MAX_RASTER_PIXELS } from "./pdfPageRenderer";
import type { PdfInkOverlay, PdfSession } from "../../render/pdfClient";

/**
 * Points-per-pixel for an unannotated page: 2x (144 dpi), close to the ink's own
 * resolution (2.22 for A4 on a Nomad) so page size does not depend on having ink.
 */
const EXPORT_SCALE = 2;

/** Viewer state read on demand; the focused page moves during an export's awaits. */
export interface PdfViewerExportsState {
  session(): PdfSession | null;
  isOpen(): boolean;
  generation(): number;
  pageIndex(): number;
  pageCount(): number;
  meta(): NoteMeta | null;
  fromBin(): boolean;
  markId(): Id | null;
  markPages(): ReadonlyMap<number, PageRef>;
}

export interface PdfViewerExportsDom {
  /** Read only for the Document row's `visibility`; exports decode, never screenshot. */
  canvas: HTMLCanvasElement;
  markCtl: NoteLayersController;
}

export interface PdfViewerExportsOptions {
  deps: {
    getTheme: () => Theme;
    api: { getPageBytes(id: Id, ref: PageRef): Promise<ArrayBuffer> };
  };
  state: PdfViewerExportsState;
  dom: PdfViewerExportsDom;
}

export type PdfViewerExports = Pick<
  PdfExportsDeps,
  "model" | "exportPagePdf" | "exportDocumentPdf" | "state"
>;

export function createPdfViewerExports(opts: PdfViewerExportsOptions): PdfViewerExports {
  const { deps, state } = opts;
  const { canvas, markCtl } = opts.dom;

  /**
   * Guarded on `isPresented`: the mounted stack outlives a page turn (hidden, not
   * released), so `stack()` alone could export the previous page's ink. The
   * background slot is dropped, or its forced hiding would make every page look tuned.
   */
  function inkForExport(page: number): { ref: PageRef; views: NoteLayerView[] } | null {
    const ref = state.markPages().get(page);
    if (!ref || !markCtl.isPresented(ref.hash, deps.getTheme())) return null;
    const views = (markCtl.stack()?.views ?? []).filter((v) => v.slot !== "background");
    return views.length > 0 ? { ref, views } : null;
  }

  function exportState(): PdfExportState {
    const ink = inkForExport(state.pageIndex());
    return {
      hasInk: ink !== null,
      // Whole-document count; a `.mark` can name pages the PDF lacks.
      markedPages: [...state.markPages().keys()].filter((p) => p < state.pageCount()).length,
      // The canvas is the single source of truth for the Document row.
      pageVisible: canvas.style.visibility !== "hidden",
      // Hiding the document is itself a divergence from the authored view.
      tuned:
        canvas.style.visibility === "hidden" ||
        (ink?.views.some((v) => v.visible !== v.authoredVisible) ?? false),
    };
  }

  function plainExportScale(size: { width: number; height: number }): number {
    const px = size.width * EXPORT_SCALE * (size.height * EXPORT_SCALE);
    return px <= MAX_RASTER_PIXELS ? EXPORT_SCALE : EXPORT_SCALE * Math.sqrt(MAX_RASTER_PIXELS / px);
  }

  /**
   * The focused page as a layered model, rendered fresh at export scale with the
   * ink re-decoded in the light theme. The caller frees the model with
   * `release()`; the sources are freed here.
   */
  async function pageExportModel(opts?: { withPage?: boolean }): Promise<{
    model: LayeredExportModel;
    pagePt: { width: number; height: number };
    release: () => void;
  } | null> {
    const s = state.session();
    if (!s || !state.isOpen() || state.pageCount() === 0) return null;
    const mine = state.generation();
    const page = state.pageIndex();

    let size: { width: number; height: number };
    try {
      size = await s.pageSize(page);
    } catch {
      return null;
    }
    if (mine !== state.generation()) return null;

    const ink = inkForExport(page);
    // With ink, fit the panel's page-rect so the ink moves by whole pixels only.
    const space = ink ? markExportSpace({ width: ink.ref.width, height: ink.ref.height }, size) : null;
    // The PDF row skips the raster (it grafts content streams); dimensions are unchanged.
    const wantPage = opts?.withPage ?? true;
    let frame = null;
    if (wantPage) {
      try {
        frame = await s.render(page, space ? space.scale : plainExportScale(size));
      } catch {
        return null;
      }
      if (mine !== state.generation()) {
        frame.bitmap.close();
        return null;
      }
    }
    // A pixel of rounding difference from MuPDF is harmless here: no ink, blank page layer.
    const plainScale = plainExportScale(size);
    const plainSpace = {
      width: Math.max(1, Math.round(size.width * plainScale)),
      height: Math.max(1, Math.round(size.height * plainScale)),
      dx: 0,
      dy: 0,
    };

    let snapshot: Awaited<ReturnType<typeof markCtl.exportModel>> = null;
    try {
      if (ink) snapshot = await markCtl.exportModel();
    } catch {
      snapshot = null; // ink that will not re-decode must not cost the page export
    }
    try {
      if (mine !== state.generation()) return null;
      const model = composeMarkExportModel({
        space: space ?? (frame ? { width: frame.width, height: frame.height, dx: 0, dy: 0 } : plainSpace),
        page: frame?.bitmap ?? null,
        pageVisible: canvas.style.visibility !== "hidden",
        ink: inkExportLayers(ink, snapshot?.model ?? null),
      });
      return {
        model,
        // Page size in points, which `markExportMatrix` needs to place the ink.
        pagePt: { width: size.width, height: size.height },
        release: () => {
          for (const l of model.layers) {
            l.canvas.width = 0;
            l.canvas.height = 0;
          }
        },
      };
    } finally {
      // Composition copied both halves; free the sources now to keep the peak low.
      frame?.bitmap.close();
      snapshot?.release();
    }
  }

  /** No generation re-check: this downloads, so a page turn must not discard it. */
  async function exportPagePdf(page: number, ink: PdfInkOverlay): Promise<Uint8Array> {
    const s = state.session();
    // Thrown so the menu toasts it, rather than a silent click.
    if (!s || !state.isOpen()) throw new Error("no document is open");
    return s.exportPage(page, ink);
  }

  /**
   * Ink for any annotated page, via `inkRaster`, without disturbing the mounted
   * stack. Uses the authored view (eye toggles are per page on screen). One page
   * (~30 MB) resident at a time; everything is zeroed on the way out.
   */
  async function markInkFor(page: number): Promise<PdfInkOverlay | null> {
    const s = state.session();
    const id = state.markId();
    const ref = state.markPages().get(page);
    if (!s || !id || !ref) return null;
    const pagePt = await s.pageSize(page);
    // Same space as the per-page rows, so both exports place ink identically.
    const space = markExportSpace({ width: ref.width, height: ref.height }, pagePt);
    if (space.width <= 0 || space.height <= 0) return null;
    const panel = await markCtl.inkRaster(await deps.api.getPageBytes(id, ref), {
      // 1:1 with the device panel, so strokes are never resampled.
      width: ref.width,
      height: ref.height,
    });
    if (!panel) return null;
    let model: LayeredExportModel | null = null;
    try {
      model = composeMarkExportModel({
        space,
        page: null,
        pageVisible: false,
        ink: [{ name: "Ink", canvas: panel, visible: true, authoredVisible: true }],
      });
      const mask = inkAlpha(model, "original");
      if (mask.width <= 1 && mask.height <= 1) return null; // nothing was drawn
      return {
        ...mask,
        matrix: markExportMatrix({ width: mask.width, height: mask.height }, pagePt),
      };
    } finally {
      for (const l of model?.layers ?? []) {
        l.canvas.width = 0;
        l.canvas.height = 0;
      }
      panel.width = 0;
      panel.height = 0;
    }
  }

  /**
   * The whole document as an incremental update, so the original's `/Annots`
   * survive (grafting per page would drop them). The original stays a disk-backed
   * Blob throughout; an `arrayBuffer()` here would cost its full size in heap.
   */
  async function exportDocumentPdf(
    onProgress: (done: number, total: number) => void,
  ): Promise<{ blob: Blob; pages: number }> {
    const s = state.session();
    const m = state.meta();
    if (!s || !state.isOpen() || !m) throw new Error("no document is open");
    const pages = [...state.markPages().keys()]
      .filter((p) => p < state.pageCount())
      .sort((a, b) => a - b);
    if (pages.length === 0) throw new Error("this PDF has no annotations to burn in");
    const url = rawFileUrl(m.id, m.fileHash, { download: false, bin: state.fromBin() });
    if (!url) throw new Error("this file has no readable address");

    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`could not fetch this PDF (HTTP ${res.status})`);
    const original = await res.blob();

    // `seen` drives progress; `burnt` is what went in and what the toast may claim.
    let seen = 0;
    let burnt = 0;
    for (const page of pages) {
      const ink = await markInkFor(page);
      // An undecodable page is skipped rather than failing the export.
      if (ink) {
        await s.annotatePage(page, ink);
        burnt += 1;
      }
      onProgress(++seen, pages.length);
    }
    if (burnt === 0) throw new Error("none of the annotated pages would decode");

    const delta = await s.exportDocument(original);
    // Original plus delta is the document; the browser stitches the blobs.
    return {
      blob: new Blob([original, delta as BlobPart], { type: "application/pdf" }),
      pages: burnt,
    };
  }

  /**
   * Match views to decoded canvases by wire index, not position: `exportModel()`
   * includes the background that `views` dropped.
   */
  function inkExportLayers(
    ink: { views: NoteLayerView[] } | null,
    model: LayeredExportModel | null,
  ): MarkInkLayer[] {
    if (!ink || !model) return [];
    const byId = new Map(model.layers.map((l) => [l.id, l]));
    return ink.views.flatMap((v) => {
      const decoded = byId.get(v.index);
      return decoded
        ? [
            {
              name: v.name,
              canvas: decoded.canvas,
              visible: v.visible,
              authoredVisible: v.authoredVisible,
            },
          ]
        : [];
    });
  }

  return {
    model: (o) => pageExportModel(o),
    exportPagePdf,
    exportDocumentPdf,
    state: exportState,
  };
}
