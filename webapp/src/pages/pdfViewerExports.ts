// The PDF EXPORT DRIVER — WHICH pixels, in WHICH space.
//
// `pdfExports.ts` holds the MODEL (`composeMarkExportModel`, `inkAlpha`) and the
// MENU (which rows exist, the filenames, the toasts), and neither of those knows
// what a decoder session is. This does: it renders pages, decodes ink, fetches
// the original file and drives the incremental update.
//
// BESIDE `pdfExports.ts` RATHER THAN INSIDE IT, deliberately: that module
// imports the export transforms and the geometry and nothing else, where folding
// this in would hand it the decoder session, the layer controller, the
// document's metadata and the page canvas — the whole viewer — to reach four
// functions it only ever calls through a getter.

import type { Id, NoteMeta, PageRef, Theme } from "../core/types";
import { rawFileUrl } from "../core/fileKind";
import type { NoteLayersController, NoteLayerView } from "./noteLayers";
import {
  composeMarkExportModel,
  inkAlpha,
  type MarkInkLayer,
  type PdfExportsDeps,
  type PdfExportState,
} from "./pdfExports";
import type { LayeredExportModel } from "../export/layered";
import { markExportMatrix, markExportSpace } from "../render/markGeometry";
import { MAX_RASTER_PIXELS } from "./pdfPageRenderer";
import type { PdfInkOverlay, PdfSession } from "../render/pdfClient";

/**
 * The export scale for a page with NO ink over it, in PDF points per pixel.
 *
 * An annotated page has no choice: it is composed at the ink's own resolution
 * (`markExportSpace`), which for A4 on a Nomad works out at 2.22. An unannotated
 * one has nothing to agree with, so it takes the round number nearest that —
 * 2x the PDF's own 72 dpi — which keeps the two kinds of export within a hair of
 * each other rather than letting "did this page have ink on it?" decide how big
 * the PNG is. Clamped by the same area ceiling the on-screen raster uses.
 */
const EXPORT_SCALE = 2;

/**
 * The viewer state an export reads, ASKED FOR rather than captured — an export
 * awaits a render, a fetch and a decode, and the focused page moves under all
 * three.
 */
export interface PdfViewerExportsState {
  session(): PdfSession | null;
  isOpen(): boolean;
  generation(): number;
  pageIndex(): number;
  pageCount(): number;
  /** The open document — its id, md5 and size are what the raw fetch is made of. */
  meta(): NoteMeta | null;
  fromBin(): boolean;
  markId(): Id | null;
  markPages(): ReadonlyMap<number, PageRef>;
}

/** The two elements an export reads — never the ones it writes. */
export interface PdfViewerExportsDom {
  /**
   * The page canvas, read ONLY for the panel's Document row (its `visibility`).
   * Nothing here exports its pixels: an export decodes, it never screenshots.
   */
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

/**
 * The viewer's half of {@link PdfExportsDeps} — the four members the menu reads
 * through getters because only the viewer can answer them.
 */
export type PdfViewerExports = Pick<
  PdfExportsDeps,
  "model" | "exportPagePdf" | "exportDocumentPdf" | "state"
>;

export function createPdfViewerExports(opts: PdfViewerExportsOptions): PdfViewerExports {
  const { deps, state } = opts;
  const { canvas, markCtl } = opts.dom;

  /**
   * The ink that belongs to `page`, or null.
   *
   * Guarded on `isPresented`, not merely on `markPages.has` — the mounted stack
   * survives a page turn until the next one commits (it is hidden, not
   * released), so a bare `stack()` would hand the previous page's handwriting to
   * an export named after this one.
   *
   * The BACKGROUND slot is dropped here rather than hidden, so it is absent from
   * both the export and the "has anything been toggled?" question. It is
   * force-hidden on screen (`suppressBackground`), and a layer that is always
   * hidden would otherwise make every page look permanently tuned.
   */
  function inkForExport(page: number): { ref: PageRef; views: NoteLayerView[] } | null {
    const ref = state.markPages().get(page);
    if (!ref || !markCtl.isPresented(ref.hash, deps.getTheme())) return null;
    const views = (markCtl.stack()?.views ?? []).filter((v) => v.slot !== "background");
    return views.length > 0 ? { ref, views } : null;
  }

  /** Which export rows the focused page can offer. See {@link PdfExportState}. */
  function exportState(): PdfExportState {
    const ink = inkForExport(state.pageIndex());
    return {
      hasInk: ink !== null,
      // COUNTED OFF `markPages`, not off the focused page: the whole-document
      // row asks "does this document have handwriting anywhere". Pages beyond
      // the document's own count are dropped — a `.mark` CAN name a page the PDF
      // does not have.
      markedPages: [...state.markPages().keys()].filter((p) => p < state.pageCount()).length,
      // Read off the CANVAS, not off a variable of our own — the panel's toggle
      // writes it there (`layersPanel.onToggle`) and `pdfRow()` reads it back the
      // same way, so there is one answer to "is the document showing?" rather
      // than two that can drift.
      pageVisible: canvas.style.visibility !== "hidden",
      // The document is a layer like any other and its authored state is
      // visible, so hiding its row IS a divergence — turning the page off and
      // exporting the ink alone is one of the two things this panel is for.
      tuned:
        canvas.style.visibility === "hidden" ||
        (ink?.views.some((v) => v.visible !== v.authoredVisible) ?? false),
    };
  }

  /** The export scale for a page with no ink over it — see {@link EXPORT_SCALE}. */
  function plainExportScale(size: { width: number; height: number }): number {
    const px = size.width * EXPORT_SCALE * (size.height * EXPORT_SCALE);
    return px <= MAX_RASTER_PIXELS ? EXPORT_SCALE : EXPORT_SCALE * Math.sqrt(MAX_RASTER_PIXELS / px);
  }

  /**
   * The focused page as a layered export model: the document, then its ink.
   *
   * NOTHING HERE COMES OFF THE SCREEN. The on-screen canvas is at whatever zoom,
   * DPR and panel layout the reader happens to be at — a Fit page beside two
   * open panels is a fraction of the page's real resolution — so the page is
   * rendered FRESH at the export's own scale, and the ink is re-decoded by
   * `exportModel()` in the light world rather than reused from a possibly
   * dark-inverted stack. Exports decode, they never screenshot.
   *
   * The model's canvases are the caller's to free — several megabytes each —
   * which is what `release()` is for. The SOURCES are freed here, as soon as
   * they have been drawn in.
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
    // WITH INK, the page is rendered to fit the panel's own page-rect, so the
    // handwriting moves by a whole-pixel translation and is never resampled.
    // WITHOUT it there is no panel to agree with, so the round number stands in.
    const space = ink ? markExportSpace({ width: ink.ref.width, height: ink.ref.height }, size) : null;
    // THE PDF ROW ASKS FOR NO PAGE AT ALL: the decoder grafts the page's own
    // content streams, so a raster here would be a full MuPDF render (10 MB for
    // A4 at the ink's resolution) built only to be thrown away. The model still
    // comes back at the SAME dimensions — the ink's space, where the alpha lands.
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
    // The unannotated page's space, WITHOUT a render to measure. MuPDF's own
    // rounding may differ from this by a pixel, which matters to nothing that
    // takes this path: with no ink the overlay is a single transparent pixel
    // stretched over the page, and the document layer under it is blank.
    const plainScale = plainExportScale(size);
    const plainSpace = {
      width: Math.max(1, Math.round(size.width * plainScale)),
      height: Math.max(1, Math.round(size.height * plainScale)),
      dx: 0,
      dy: 0,
    };

    // The ink's FRESH light-theme canvases, at the mark's own panel resolution.
    let snapshot: Awaited<ReturnType<typeof markCtl.exportModel>> = null;
    try {
      if (ink) snapshot = await markCtl.exportModel();
    } catch {
      snapshot = null; // ink that will not re-decode must not cost the page export
    }
    try {
      if (mine !== state.generation()) return null;
      const model = composeMarkExportModel({
        // The rendered frame's own dims stand in when there is no ink: there is
        // no letterbox to correct for, so the page IS the export.
        space: space ?? (frame ? { width: frame.width, height: frame.height, dx: 0, dy: 0 } : plainSpace),
        page: frame?.bitmap ?? null,
        pageVisible: canvas.style.visibility !== "hidden",
        ink: inkExportLayers(ink, snapshot?.model ?? null),
      });
      return {
        model,
        // The page in its OWN units, which is what places the ink on it: the
        // export image is one rectangle of pixels and the decoder needs to know
        // how many points wide that rectangle is (`markExportMatrix`).
        pagePt: { width: size.width, height: size.height },
        release: () => {
          for (const l of model.layers) {
            l.canvas.width = 0;
            l.canvas.height = 0;
          }
        },
      };
    } finally {
      // Composition COPIES both halves, so the sources are dead the moment it
      // returns. Dropping them here rather than at GC keeps the peak at one
      // extra stack instead of two.
      frame?.bitmap.close();
      snapshot?.release();
    }
  }

  /**
   * Hand one page and its ink to the decoder, and get a PDF back.
   *
   * The generation is NOT re-checked after the call, deliberately: this
   * DOWNLOADS rather than paints, so turning to page 5 while page 4's export is
   * being built is not a reason to silently throw page 4's file away.
   */
  async function exportPagePdf(page: number, ink: PdfInkOverlay): Promise<Uint8Array> {
    const s = state.session();
    // Thrown, not answered with null: this is reached only by clicking a row, and
    // the menu's own mechanics turn a rejection into a toast. Returning nothing
    // would be a click that does nothing at all.
    if (!s || !state.isOpen()) throw new Error("no document is open");
    return s.exportPage(page, ink);
  }

  /**
   * The ink for ANY annotated page, ready for the decoder — not just the one on
   * screen.
   *
   * `pageExportModel` above can only answer for the FOCUSED page: it reads the
   * mounted stack, which is one page at a time and belongs to the screen. A
   * whole-document export needs seven pages of a seventy-seven page document
   * without disturbing the one being read, which is what `inkRaster` is for — it
   * decodes, reduces and releases, touching no state the viewer owns.
   *
   * THE AUTHORED VIEW, NOT THE PANEL'S. `inkRaster` drops the background slot
   * and every device-hidden layer, and nothing here consults the eye toggles.
   * That is the honest reading: the toggles belong to the page in front of you,
   * and a document-wide export cannot mean "as page 12 is currently tuned".
   *
   * ONE PAGE RESIDENT AT A TIME, and it is not a small one: the panel raster is
   * ~10.5 MB, the composed model another ~10, and `inkAlpha`'s flatten and
   * read-back two more. Everything is zeroed on the way out so the peak is one
   * page's worth however long the document is.
   */
  async function markInkFor(page: number): Promise<PdfInkOverlay | null> {
    const s = state.session();
    const id = state.markId();
    const ref = state.markPages().get(page);
    if (!s || !id || !ref) return null;
    const pagePt = await s.pageSize(page);
    // The page's own space at the ink's resolution — the same `markExportSpace`
    // the per-page rows compose in, so the two exports place ink identically.
    const space = markExportSpace({ width: ref.width, height: ref.height }, pagePt);
    if (space.width <= 0 || space.height <= 0) return null;
    const panel = await markCtl.inkRaster(await deps.api.getPageBytes(id, ref), {
      // 1:1 with the device panel. `markExportSpace` composes in the ink's OWN
      // pixels, so asking for anything else here would resample every stroke on
      // the way in and then again on the way out.
      width: ref.width,
      height: ref.height,
    });
    if (!panel) return null;
    let model: LayeredExportModel | null = null;
    try {
      model = composeMarkExportModel({
        space,
        // NO PAGE RASTER: the document's own content streams are what the export
        // keeps, and `inkAlpha` drops the document layer anyway.
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
   * THE WHOLE DOCUMENT, with the ink burnt in — every page, every link, every
   * highlight the original had.
   *
   * NOT SEVENTY-SEVEN CALLS TO `exportPagePdf`: that route grafts a page into a
   * fresh document, and grafting drops `/Annots`. This one annotates the pages
   * that were written on inside the OPEN document and asks the decoder for an
   * INCREMENTAL UPDATE — the original's bytes untouched, with only the changed
   * objects appended.
   *
   * THE ORIGINAL IS A BLOB throughout. It is fetched, concatenated and
   * downloaded without ever being read into an array: `res.blob()` and
   * `new Blob([original, delta])` are both backed by disk, so a 76 MB document
   * costs this tab a handle rather than 76 MB of heap. An `arrayBuffer()`
   * anywhere on this path would undo the entire design.
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

    // TWO COUNTERS, because they answer different questions. `seen` drives the
    // progress toast and must reach the total whatever happens; `burnt` is what
    // actually went into the file and is what the final toast may claim.
    let seen = 0;
    let burnt = 0;
    for (const page of pages) {
      const ink = await markInkFor(page);
      // A page whose ink will not decode is SKIPPED rather than failing the
      // export: the other pages of handwriting are worth more than the refusal.
      if (ink) {
        await s.annotatePage(page, ink);
        burnt += 1;
      }
      onProgress(++seen, pages.length);
    }
    if (burnt === 0) throw new Error("none of the annotated pages would decode");

    const delta = await s.exportDocument(original);
    // THE CONCATENATION IS THE DOCUMENT. Two blobs, no bytes: the browser
    // stitches them when the download is read.
    return {
      blob: new Blob([original, delta as BlobPart], { type: "application/pdf" }),
      pages: burnt,
    };
  }

  /**
   * Marry the live layer VIEWS (names, visibility, authored state) to the
   * freshly decoded canvases, BY WIRE INDEX.
   *
   * By index and not by position: `exportModel()` re-decodes every record
   * including the background, while `views` here has already dropped it, so the
   * two lists are different lengths and zipping them would attach each name to
   * the layer below it.
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
