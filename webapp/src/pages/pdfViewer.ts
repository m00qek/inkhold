// The PDF VIEWER — one page at a time, rastered in the browser by MuPDF.
//
// A viewer of its own rather than an arm of the reader, for the same reason the
// `.spd` and `.txt` viewers are: a PDF has a different lifecycle. The reader's
// `NoteRenderer` takes a page's own byte range and is contractually pure, and a
// PDF page cannot be decoded from its own bytes — pages share a resource graph
// through the xref. So the document is opened ONCE and held, and the handle must
// be closed (`render/pdfDecode.ts`).
//
// NOTHING BELOW THIS FILE RUNS ON THIS THREAD. MuPDF, the document handle and
// the byte-range block cache all live in a worker (`render/pdfClient.ts` ->
// `render/pdfWorker.ts`); this asks for a page and receives an `ImageBitmap` to
// draw. That is why every step here is `await`ed — a page size can now cost a
// round trip — and why there is no longer a size ceiling: a 76 MB document
// costs the blocks page 1 is written in.
//
// WHAT THIS IS NOT, YET. No `.mark` annotation overlay — that is the point of
// the exercise and it is gated on the pairing
// work, not on this file. A plain PDF viewer is worth having on its own.

import { el } from "../ui/dom";
import type { Hash, Id, NoteMeta, NoteSummary, PageRef } from "../core/types";
import type { RenderKey } from "../cache/types";
import { formatBytes, rawFileUrl } from "../core/fileKind";
import { createToolbar } from "./toolbar";
import {
  svg,
  VIEWER_IC,
  backWord,
  createViewerHeader,
  originSubtitle,
  createZoomStepper,
  createViewerBody,
  createViewerExportMenu,
} from "./viewerChrome";
import type { ReaderOrigin, Viewer, ViewerDeps } from "./viewer";
import { createPageIndex, type PageIndexRow } from "./pageIndex";
import { createPdfLinkLayer } from "./pdfLinkLayer";
import { createPdfHighlightLayer } from "./pdfHighlightLayer";
import {
  createPdfFindController,
  pdfCountIsNone,
  pdfCountText,
  type PdfFindController,
} from "./pdfFind";
import { binNotePageHref, notePageHref } from "../router";
import { createBinViewerActions } from "../ui/binViewerActions";
import { createLayersPanel } from "./layersPanel";
import {
  buildNoteLayerThumb,
  createNoteLayersController,
  toPanelLayers,
  type NoteLayerView,
} from "./noteLayers";
import {
  composeMarkExportModel,
  createPdfExports,
  inkAlpha,
  type MarkInkLayer,
  type PdfExportState,
} from "./pdfExports";
import type { LayeredExportModel } from "../export/layered";
import { markExportMatrix, markExportSpace, placePanelOverPage } from "../render/markGeometry";
import { supportsWasmExceptions } from "../render/pdfDecode";
import type { PdfWord } from "../render/pdfText";
import {
  PdfLoadError,
  createPdfSession,
  type PdfInkOverlay,
  type PdfSession,
} from "../render/pdfClient";

/**
 * Zoom steps, RELATIVE TO FIT — every step multiplies the scale that fits the
 * page to the stage, so the sequence is monotonic whatever the page measures.
 *
 * The reader can use absolute steps (`reader.ts`: 640px x a factor) because a
 * `.note` page is always the device's panel. PDF pages are not: this app has
 * seen 200pt fixtures, 458pt device exports, 612pt Letter and 1404pt
 * panel-sized exports — a 7x spread. With absolute steps, "zoom in" from Fit
 * SHRINKS a small page, which is what the first version of this did.
 */
const ZOOMS = ["Fit", "150%", "200%", "300%"] as const;
type Zoom = (typeof ZOOMS)[number];
const ZOOM_SCALE: Record<Zoom, number> = {
  Fit: 1,
  "150%": 1.5,
  "200%": 2,
  "300%": 3,
};
/** Cap the raster so a big page at 200% cannot ask for a gigabyte of pixels. */
const MAX_RASTER_PIXELS = 16 * 1024 * 1024;
/**
 * The export scale for a page with NO ink over it, in PDF points per pixel.
 *
 * An annotated page has no choice: it is composed at the ink's own resolution
 * (`markExportSpace`), which for A4 on a Nomad works out at 2.22. An
 * unannotated one has nothing to agree with, so it takes the round number
 * nearest that — 2x the PDF's own 72 dpi, i.e. 144 dpi — which keeps the two
 * kinds of export within a hair of each other rather than making "did this page
 * have ink on it?" decide how big the PNG is. Clamped by the same area ceiling
 * the on-screen raster uses.
 */
const EXPORT_SCALE = 2;
/** A page-index thumbnail's long edge in CSS pixels. Small on purpose — see
 *  `paintThumbs`: a PDF thumbnail is not a free decode. */
const THUMB_PX = 120;
/**
 * The layers panel's row id for the PDF page itself.
 *
 * Negative on purpose: a `.mark`'s layer indices are 0-based positions into its
 * own stack, so nothing it can carry collides with this and the toggle
 * dispatches on the id alone.
 */
const PDF_LAYER_ID = -1;

/** The browser seams, injectable so the viewer is testable without a worker. */
export interface PdfSeam {
  /** A fresh decoder session. One worker, one document at a time. */
  createSession(): PdfSession;
  /** False → the honest "this browser can't" state instead of a dead canvas. */
  supported(): boolean;
}

export function defaultPdfSeam(): PdfSeam {
  return { createSession: createPdfSession, supported: supportsWasmExceptions };
}

export function createPdfViewer(deps: ViewerDeps, seam: PdfSeam = defaultPdfSeam()): Viewer {
  // --- state --------------------------------------------------------------
  /**
   * ONE session for the viewer's whole life, not one per document. Compiling
   * MuPDF is ~5 MB of wasm; paying for it on every file the user opens would be
   * a worse jank than the one the worker was introduced to remove.
   */
  let session: PdfSession | null = null;
  let open_ = false;
  let pageIndex = 0;
  let pageCount = 0;
  let zoom: Zoom = "Fit";
  let fromBin = false;
  /**
   * The open document's metadata — what the bin actions act ON.
   *
   * Held because the toolbar's file zone outlives any one `open()`: the buttons
   * are built once and re-pointed per document, exactly as `spdViewer` does it.
   * Cleared by `release()`, so a control can never act on the file you just
   * navigated away from.
   */
  let meta: NoteMeta | null = null;
  /**
   * The `.mark` that annotates this PDF, and its pages keyed by the PDF page
   * they belong to (0-based, so it keys straight off `pageIndex`).
   *
   * A mark is SPARSE — it holds only the pages that were written on — so a
   * missing key is the common case and means "this page has no annotations",
   * not "not loaded yet".
   */
  let markId: Id | null = null;
  const markPages = new Map<number, PageRef>();
  /** The open document's md5 — half of a thumbnail's cache identity. */
  let docHash = "";
  /**
   * The point size of the page currently on the canvas.
   *
   * Held because find repaints on its OWN schedule — a keystroke, a step, a
   * batch landing — and every one of those has to place boxes against the page
   * that is actually drawn. Reading it from the session each time would be a
   * round trip per keystroke; reading it from `pageIndex` would be a size for a
   * page the raster has not caught up with yet.
   */
  let pageSizePtNow: { width: number; height: number } | null = null;
  /**
   * Where the strip's thumbnails came from, published on `__inkholdPdfThumbs`.
   *
   * Instrumented for the same reason the block cache is: the caching is
   * INVISIBLE when it works, so without a counter a regression that re-renders
   * every thumbnail looks and behaves exactly like a hit — only slower, and only
   * on hardware nobody tests on. Two mutations of this file (closing a bitmap the
   * cache owns, and skipping the read-through entirely) passed the whole suite
   * before this existed.
   *
   * `inked` counts the rows that were COMPOSITED with a `.mark`'s handwriting,
   * and is here for the same reason: on the one fixture this app has, every
   * stroke inside the page's rect belongs to a device-hidden layer, so the ink
   * lands in the dead margin and the composite is pixel-identical to the bare
   * page. A viewer that never asked for the ink at all would look exactly right.
   */
  // `probe` is the largest batch the parallel cache pass asked for at once, and
  // it is instrumented for the same reason `hits` is: the behaviour is INVISIBLE
  // when it works. A strip that probed its rows one at a time paints exactly the
  // same pixels as one that probed them together, only slower — so without a
  // number there is nothing for a test to hold, and a regression to the serial
  // read would look like success.
  const thumbCounts = { hits: 0, renders: 0, inked: 0, probe: 0 };
  function publishThumbCounts(): void {
    (globalThis as unknown as { __inkholdPdfThumbs?: typeof thumbCounts }).__inkholdPdfThumbs = {
      ...thumbCounts,
    };
  }
  /**
   * Bumped per open and per teardown. Every async step checks it before
   * touching the DOM or the document handle, so a superseded load paints
   * nothing and — more importantly — never renders through a handle that
   * `hide()` has already closed.
   */
  let generation = 0;

  // --- DOM ----------------------------------------------------------------
  const header = createViewerHeader({
    classes: { back: "viewer__back", backLabel: "viewer__back-label", title: "viewer__title" },
    onBack: () => deps.onBack(),
  });

  const canvas = el("canvas", { class: "pdf-page" }) as HTMLCanvasElement;
  /**
   * The `.mark`'s ink, stacked over the page.
   *
   * The SAME controller the reader drives (`pages/noteLayers.ts`) — a mark IS a
   * note container, so its layers decode through the identical path, and
   * `decode_layer` already hands back RGBA whose background is alpha 0. That is
   * what makes this an overlay rather than a second opaque sheet.
   *
   * Positioned by `placePanelOverPage`: the ink is in DEVICE PANEL pixels and
   * the canvas is the PAGE, which is only part of that panel, so the host is
   * drawn oversized and shifted until the two line up. `.pdf-stage` clips the
   * dead margins.
   */
  // `backdrop: null` — the page underneath IS the document. The controller's
  // default is white paper, which is right for the reader (where the stack
  // replaces the page) and hides the PDF completely here.
  const markCtl = createNoteLayersController({ backdrop: null });
  markCtl.el.classList.add("pdf-mark");
  /**
   * The document's OWN links, as anchors — LAST in the stage, so above the ink.
   *
   * `.pdf-mark` is `pointer-events: none` and so never eats a click, but a link
   * under a scribble is precisely the case that occurs: people annotate around
   * the things they care about. Stacking order is what decides it, and the
   * order here is the order in the DOM.
   */
  const linkLayer = createPdfLinkLayer();
  /**
   * Find's marks, BETWEEN the page and the ink.
   *
   * Under the handwriting because the handwriting is the person's own and our
   * mark is ours: a wash over somebody's pen stroke would be this app editing
   * their annotation. Over the page because that is what it is pointing at.
   * Stacking is DOM order in `.pdf-stage`, so this line IS the decision.
   */
  const findLayer = createPdfHighlightLayer();
  const stage = el(
    "div",
    { class: "pdf-stage" },
    canvas,
    findLayer.el,
    markCtl.el,
    linkLayer.el,
  );
  const body = createViewerBody({ mark: "PDF" });

  const zoomStepper = createZoomStepper<Zoom>({
    readoutClass: "zoom",
    initial: zoom,
    format: (z) => z,
    labels: { out: "Zoom out", in: "Zoom in" },
    onStep: (dir) => {
      const at = ZOOMS.indexOf(zoom);
      const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + dir))]!;
      if (next !== zoom) {
        zoom = next;
        void paint();
      }
      return zoom;
    },
  });

  const prev = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Previous page",
    title: "Previous page",
    html: svg(VIEWER_IC.prev, 1.9),
  }) as HTMLButtonElement;
  const next = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Next page",
    title: "Next page",
    html: svg(VIEWER_IC.next, 1.9),
  }) as HTMLButtonElement;
  const pageReadout = el("span", { class: "zoom", role: "status", text: "—" });
  const pager = el("span", { class: "pager" }, prev, pageReadout, next);
  prev.addEventListener("click", () => void go(pageIndex - 1));
  next.addEventListener("click", () => void go(pageIndex + 1));

  // --- the download / export menu ------------------------------------------
  // This was a bare `<a download>` — the only viewer of four whose Download did
  // one thing. The shared dropdown (`viewerChrome.ts`) gives it the same shape
  // the `.spd` viewer and the `.note` reader have, and the raw file survives
  // inside it as the WHOLE DOCUMENT group's one row, so nothing that worked
  // before stops working. The CONTENT is `pdfExports.ts`'s; the model it exports
  // is `pageExportModel` below, because composing a PDF page with the ink
  // written on it is the one thing only this viewer knows how to do.
  const exportMenu = createViewerExportMenu({ toast: deps.toast, className: "viewer__export" });
  const downloads = createPdfExports({
    menu: exportMenu,
    toast: deps.toast,
    docName: () => meta?.name ?? null,
    pageIndex: () => pageIndex,
    model: (opts) => pageExportModel(opts),
    exportPagePdf: (page, ink) => exportPagePdf(page, ink),
    exportDocumentPdf: (onProgress) => exportDocumentPdf(onProgress),
    state: () => exportState(),
  });

  // --- the file zone: Move to bin, or the bin-origin cluster ---------------
  // The PDF viewer was the ONLY viewer of four without either. The reader, the
  // `.spd` viewer and the `.txt` viewer all carry both; this had Download alone,
  // so a PDF opened FROM the recycle bin offered no way to restore it and no way
  // to delete it — for every other file type, both are one click away in the same
  // place. It even computed `fromBin` already (for the bin-scoped download route)
  // and then did nothing with it.
  const moveBin = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Move to bin",
    title: "Move to bin",
    html: svg(VIEWER_IC.trash, 1.8) + "Move to bin",
  });
  moveBin.addEventListener("click", () => {
    if (meta) deps.onMoveToBin?.(meta);
  });
  // The BIN-ORIGIN cluster, swapped in for Move to bin when the file is open from
  // the recycle bin: the SAME `|— retention —| ⋯` the bin ROW shows, from the
  // shared `createBinViewerActions` — Restore neutral, Delete permanently the one
  // red item, its confirm carried through `onPurge`. Nothing here is
  // PDF-specific, which is the point: a trashed file behaves the same whatever
  // opened it.
  const binActions = createBinViewerActions({
    getMeta: () => meta,
    onRestore: deps.onRestore,
    onPurge: deps.onPurge,
    // Card parity: the bin's "Version history" row opens the same view-only
    // panel, anchored to the "…" trigger. Wired only when the shell can open
    // history at all — no dead row otherwise.
    onHistory: deps.onVersions ? (m, anchor) => deps.onVersions!(m, anchor, undefined) : undefined,
  });

  // --- the annotations panel ------------------------------------------------
  // The SHARED layers panel (`pages/layersPanel.ts`), the same component the
  // `.spd` viewer and the reader mount. What this viewer supplies is a stack
  // whose BOTTOM row is the PDF itself: the document and the ink written on it
  // are the two things a reader wants to turn on and off independently, and
  // that is exactly the vocabulary this panel already speaks.
  //
  // The PDF is row `PDF_LAYER_ID`, deliberately outside the range a `.mark`'s
  // layer indices occupy, so the toggle can dispatch on the id alone.
  const layersPanel = createLayersPanel({
    id: "pdf-layers-panel",
    hookPrefix: "pdf",
    onToggle: (id, visible) => {
      if (id === PDF_LAYER_ID) canvas.style.visibility = visible ? "" : "hidden";
      else markCtl.setVisible(id, visible);
      // A toggle is what makes "current view" differ from "original view", so it
      // is what decides whether the ORIGINAL group is offered at all — exactly
      // as the reader re-runs `refreshGroups` on every eye click.
      downloads.refreshGroups();
    },
    paintThumb: (pl) => {
      if (pl.id !== PDF_LAYER_ID) {
        const v = markCtl.stack()?.views.find((x) => x.index === pl.id);
        return v ? buildNoteLayerThumb(v) : el("div", { "aria-hidden": "true" });
      }
      // The page's own raster, scaled down — the row should show the document,
      // not a glyph standing in for it.
      const t = el("canvas") as HTMLCanvasElement;
      t.width = 96;
      t.height = Math.max(1, Math.round((96 * canvas.height) / Math.max(canvas.width, 1)));
      if (canvas.width > 0) t.getContext("2d")?.drawImage(canvas, 0, 0, t.width, t.height);
      return t;
    },
  });

  // --- the page index (docked LEFT, like the reader's) ---------------------
  // The strip itself is the SHARED component (`pages/pageIndex.ts`) — the same
  // panel, rows, virtual window and highlight the `.note` reader gets. What this
  // viewer supplies is the PAINT, below, because a PDF page comes from the
  // worker's session and nothing else in the app can produce one.
  //
  // WHY A THUMBNAIL IS NOT FREE HERE, unlike in the reader. A `.note` page is an
  // independent byte range and its thumbnail is one decode. A PDF page is a walk
  // through a shared resource graph: rendering page 40's thumbnail can pull
  // fonts, colour spaces and images from anywhere in the file, over the network,
  // one suspended round trip at a time. So
  // the paint is gated TWICE — on the row being inside the strip's window (the
  // component's job) and on it actually being on screen (the observer's).

  /** Rows inside the strip's window, by page index. The paint's whole world. */
  const thumbRows = new Map<number, PageIndexRow>();
  /** Indices seen by the observer and not yet painted, nearest-first. */
  const thumbQueue: number[] = [];
  /** Indices whose canvas currently holds a finished thumbnail. */
  const thumbPainted = new Set<number>();
  /**
   * Page sizes learned from a thumbnail render, so a row that scrolls out and
   * back is rebuilt at the shape it was CORRECTED to rather than reverting to
   * page 0's guess.
   */
  const thumbAspects = new Map<number, number>();
  /** Page 0's aspect — every row's reserved shape until its own is known. */
  let firstAspect = 1 / Math.SQRT2; // A4 portrait, if page 0 will not measure
  let thumbsBusy = false;

  const pagesPanel = createPageIndex({
    id: "pdf-pages-panel",
    // The look is shared with the reader deliberately; the hook is what lets a
    // selector mean THIS strip (a bare `.filmstrip` matches both viewers).
    stripHook: "pdf-filmstrip",
    onPick: (i) => void go(i),
    aspect: (i) => thumbAspects.get(i) ?? firstAspect,
    // Every PDF row starts unpainted: there is no cheap stand-in for a page we
    // have not rastered.
    loading: () => true,
    mount: (row) => {
      thumbRows.set(row.index, row);
      thumbObserver().observe(row.el);
    },
    unmount: (row) => {
      thumbObserver().unobserve(row.el);
      thumbRows.delete(row.index);
      // Its canvas is about to be zeroed, so whatever was on it is gone: forget
      // the paint too, or the row would come back blank and never be redrawn.
      thumbPainted.delete(row.index);
      const at = thumbQueue.indexOf(row.index);
      if (at >= 0) thumbQueue.splice(at, 1);
    },
  });

  /**
   * ONE observer for the whole strip, rooted on the panel (which owns the
   * overflow). Built lazily because its root is the panel we are constructing.
   */
  let thumbIo: IntersectionObserver | null = null;
  function thumbObserver(): IntersectionObserver {
    thumbIo ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (!Number.isFinite(i)) continue;
          if (e.isIntersecting) {
            if (!thumbPainted.has(i) && !thumbQueue.includes(i)) thumbQueue.push(i);
          } else {
            // Scrolled away before we got to it: drop it rather than spend a
            // round trip on a page nobody is looking at.
            const at = thumbQueue.indexOf(i);
            if (at >= 0) thumbQueue.splice(at, 1);
          }
        }
        void paintThumbs();
      },
      { root: pagesPanel.el, rootMargin: "200px 0px" },
    );
    return thumbIo;
  }

  /**
   * Paint queued thumbnails ONE AT A TIME.
   *
   * Serial on purpose. The decoder is a single worker behind a single wasm
   * instance, so concurrent renders would queue there anyway — but they would
   * ALSO interleave their range fetches, so a page the user is actually reading
   * would wait behind six thumbnails. One at a time keeps the viewer's own
   * render first in line.
   *
   * AND AN ANNOTATED ROW IS COMPOSITED HERE, which is the second reason the
   * queue has to stay serial. A mark page decodes at the DEVICE PANEL's own
   * resolution — ~10.5 MB of RGBA per layer, whatever size the thumbnail ends up
   * — so two of these in flight is 20 MB of transient on a device that may be
   * the whole app. `inkRaster` reduces and releases one layer at a time, and
   * this loop guarantees one page at a time; the peak is a single layer.
   */
  /**
   * A thumbnail's identity in the SHARED cache (`sn-thumbs` — see
   * `webapp/ARCHITECTURE.md`, "there is one cache").
   *
   * A `.note` page has a server-side content hash, so `RenderKey.hash` is
   * natural. A PDF page has none — the FILE has an md5 and the pages do not — so
   * one is synthesised. It is still honestly content-addressed: the md5 pins the
   * bytes, the index pins the page, and a blob is immutable, so the entry can
   * never go stale.
   *
   * THE BARE PAGE, and only that. A row that also carries a `.mark`'s
   * handwriting is a picture of TWO blobs and is keyed by both — see
   * {@link thumbKey}, which is what every caller should ask.
   *
   * `size: "thumb"` is not decoration — it is what admits the entry to the
   * PERSISTENT tier (`renderCache.ts:125`), which is the whole reason for doing
   * this rather than keeping a private map.
   *
   * The theme is the LIVE one even though a PDF raster does not depend on it (we
   * deliberately never invert them). Pinning a constant instead would put these
   * entries outside `evictTheme`'s model, which would then drop them on a theme
   * toggle without knowing they were theme-free. Consistency costs one duplicate
   * thumbnail per page per theme, inside the same budget; the alternative is a
   * mechanism silently doing the wrong thing.
   */
  function pageThumbKey(index: number): RenderKey {
    return { hash: `${docHash}:p${index}` as Hash, size: "thumb", theme: deps.getTheme() };
  }

  /**
   * A thumbnail's identity when a `.mark` writes on that page — the PDF's md5,
   * the page, AND the mark page's own content hash.
   *
   * WITHOUT the second half this feature is a caching bug rather than a feature.
   * A row's picture now depends on two blobs, and `PageRef.hash` is the one
   * thing that moves when the handwriting does — so under the bare
   * `${md5}:p${i}` key an ink-free entry written a moment before the mark landed
   * would be served for the rest of the session (and out of IndexedDB, for the
   * rest of the store's life), and re-annotating a page on the device would show
   * yesterday's strokes. The composite is a different picture, so it is a
   * different key.
   *
   * The ink-free key is NOT retired: it still names the bare page, which is what
   * a row painted before the mark arrives really is, and `paintThumbs` reads it
   * back as the base to composite ON rather than re-rendering the page.
   */
  function thumbKey(index: number): RenderKey {
    const ref = markPages.get(index);
    if (!ref) return pageThumbKey(index);
    return { hash: `${docHash}:p${index}+${ref.hash}` as Hash, size: "thumb", theme: deps.getTheme() };
  }

  /** A cache read that can never sink a thumbnail. */
  async function cachedThumb(key: RenderKey): Promise<ImageBitmap | undefined> {
    try {
      return await deps.cache.get(key);
    } catch {
      return undefined;
    }
  }

  /**
   * An annotated page's thumbnail: the page raster with the mark's ink over it,
   * as ONE bitmap. Null when there is no ink to add — no mark bytes, a payload
   * that would not decode, or no canvas — and the caller then shows the page
   * alone, which is what the on-screen overlay does with the same failures.
   *
   * A NEW BITMAP RATHER THAN A DRAW ON THE ROW. The row's canvas is recycled by
   * the virtual list and is not what the cache stores; composing into a bitmap
   * keeps "what the strip shows" and "what the cache holds under the inked key"
   * the same picture, which is the whole point of {@link thumbKey}.
   *
   * `page` is left ALONE — it may be the cache's, and the cache closes what it
   * owns.
   */
  async function compositeInk(page: ImageBitmap, ref: PageRef): Promise<ImageBitmap | null> {
    const id = markId;
    if (!id || page.width <= 0 || page.height <= 0) return null;
    // THE SAME ARITHMETIC THE PAGE USES, at 120px (`render/markGeometry.ts`).
    // The ink is in device PANEL pixels and the page is a letterboxed sub-rect
    // of that panel, so the whole panel is placed oversized and shifted until
    // its page-rect lands on the raster; the canvas edge clips the overhang the
    // way `.pdf-stage` does on screen.
    //
    // The raster's own pixels stand in for the page's POINTS, which is exact
    // rather than approximate: `fitPageInPanel` divides the panel by the page on
    // both axes and takes the smaller, so scaling the page by any factor leaves
    // the fit unchanged. That is what saves a `pageSize` round trip on the path
    // where the page raster came out of the cache.
    const place = placePanelOverPage(
      { width: ref.width, height: ref.height },
      { width: page.width, height: page.height },
      { width: page.width, height: page.height },
    );
    if (place.width < 1 || place.height < 1) return null;
    let bytes: ArrayBuffer;
    try {
      bytes = await deps.api.getPageBytes(id, ref);
    } catch {
      return null;
    }
    const ink = await markCtl.inkRaster(bytes, place);
    if (!ink) return null;
    try {
      const sheet = el("canvas") as HTMLCanvasElement;
      sheet.width = page.width;
      sheet.height = page.height;
      const ctx = sheet.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(page, 0, 0);
      // WHOLE PIXELS. A stroke reduced to this size is a pixel or two wide and a
      // fractional offset would resample it into a smear — the same reasoning
      // `markExportSpace` states about `dx`/`dy`.
      ctx.drawImage(ink, Math.round(place.left), Math.round(place.top));
      const out = await createImageBitmap(sheet);
      sheet.width = 0;
      sheet.height = 0;
      return out;
    } catch {
      return null;
    } finally {
      // The ink canvas is ours by contract (`inkRaster`); free it eagerly rather
      // than at a GC that has no idea what a canvas weighs.
      ink.width = 0;
      ink.height = 0;
    }
  }

  /**
   * PHASE ONE: every queued row's cache entry, asked for AT ONCE.
   *
   * The serial pass below is right about a MISS and wrong about a hit. Its own
   * comment gives the reason it exists — one worker behind one wasm instance, and
   * concurrent renders would interleave their range fetches and put the page
   * someone is reading behind six thumbnails — and none of that describes an
   * IndexedDB read followed by a `drawImage`. There is no decoder in it and no
   * network.
   *
   * And the hit is the COMMON case: a blob is immutable, so its thumbnail is
   * cached forever and every revisit is all hits. Those used to queue behind each
   * other one round trip at a time, so reopening a 77-page document repainted a
   * strip serially that could have painted in one frame.
   *
   * The batch bounds itself: the observer only queues rows inside the strip's
   * window plus its 200px margin, so this is five to fifteen reads, not seventy-
   * seven. Misses are left in the queue untouched, for the pass that is allowed
   * to be slow.
   *
   * No bitmap is closed here and none is put: the cache owns what it returns, and
   * with no writes in flight nothing can be evicted out from under the blits.
   */
  async function drainCachedThumbs(): Promise<void> {
    if (!docHash || !open_) return;
    const batch = thumbQueue.filter((i) => !thumbPainted.has(i) && thumbRows.has(i));
    if (batch.length === 0) return;
    const mine = generation;
    thumbCounts.probe = Math.max(thumbCounts.probe, batch.length);

    const probed = await Promise.all(
      batch.map(async (i) => {
        const row = thumbRows.get(i)!;
        // Resolved BEFORE the await, exactly as the serial pass does it: a mark
        // landing mid-probe must not let a row be fetched under one identity and
        // painted under another.
        return { i, row, hit: await cachedThumb(thumbKey(i)) };
      }),
    );
    if (mine !== generation) return;

    const painted = new Set<number>();
    for (const { i, row, hit } of probed) {
      if (!hit) continue; // a miss stays queued for the serial pass
      // Recycled while the batch was in flight. The strip builds a fresh row per
      // index and observes it on mount, so this page is queued again and finds
      // the same entry.
      if (thumbRows.get(i) !== row) continue;
      thumbCounts.hits++;
      row.canvas.width = hit.width;
      row.canvas.height = hit.height;
      row.canvas.getContext("2d")?.drawImage(hit, 0, 0);
      row.setLoading(false);
      thumbPainted.add(i);
      painted.add(i);
    }
    if (painted.size === 0) return;
    publishThumbCounts();
    for (let n = thumbQueue.length - 1; n >= 0; n--) {
      if (painted.has(thumbQueue[n]!)) thumbQueue.splice(n, 1);
    }
  }

  async function paintThumbs(): Promise<void> {
    if (thumbsBusy) return;
    thumbsBusy = true;
    try {
      // The hits first and together; then the misses, one at a time.
      await drainCachedThumbs();
      while (thumbQueue.length > 0) {
        const i = thumbQueue.shift()!;
        if (thumbPainted.has(i)) continue;
        const row = thumbRows.get(i);
        const s = open_ ? session : null;
        if (!s || !row) continue;
        const mine = generation;
        // THE INK THIS ROW IS DUE, resolved ONCE, and the key that follows from
        // it. Everything below awaits, and `loadMark` can fill `markPages` in
        // mid-flight — reading either again at each step would let the row be
        // fetched under one identity and stored under another. The change is
        // caught at the bottom instead, where there is a finished picture to
        // leave up while the second pass runs.
        const ref = markPages.get(i);
        const key = thumbKey(i);

        // READ-THROUGH. A row that scrolls out and back is recycled by the
        // virtual list, so without this every return trip would re-render the
        // page — MuPDF work plus, on a cold block, network. The cache OWNS the
        // bitmap it returns (`renderCache.ts:113`: callers blit synchronously
        // and never close it), so this path draws and stops there.
        if (docHash) {
          const hit = await cachedThumb(key);
          if (mine !== generation) return;
          const cur = thumbRows.get(i);
          if (hit) {
            // A cached page is DONE either way. If the row scrolled out from
            // under us there is nothing to draw on — but falling through would
            // then re-render it through MuPDF, and on a cold block re-fetch it,
            // only to discard the pixels below. The strip builds a fresh row per
            // index and observes it on mount, so if this page comes back it is
            // queued again and finds the same cache entry.
            if (cur === row) {
              thumbCounts.hits++;
              publishThumbCounts();
              row.canvas.width = hit.width;
              row.canvas.height = hit.height;
              row.canvas.getContext("2d")?.drawImage(hit, 0, 0);
              row.setLoading(false);
              thumbPainted.add(i);
            }
            continue;
          }
        }

        // THE PAGE UNDER THE INK. For an annotated row the ink-free twin is a
        // legitimate entry of its own — written by whatever painted this row
        // before the mark landed, and by every reopen where the strip is quicker
        // than the mark's metadata — and it is the page at exactly the size this
        // thumbnail wants. Reading it back is what makes the late-mark repaint
        // cost a decode instead of a second MuPDF render and, on a cold block, a
        // second range fetch. It is the CACHE'S bitmap: never closed here.
        let base: ImageBitmap | undefined;
        if (ref && docHash) {
          base = await cachedThumb(pageThumbKey(i));
          if (mine !== generation) return;
          if (base && thumbRows.get(i) !== row) continue; // recycled; it is queued afresh
        }

        let frame;
        if (base) {
          thumbCounts.hits++;
          publishThumbCounts();
        } else {
          try {
            const size = await s.pageSize(i);
            if (mine !== generation) return;
            const scale = THUMB_PX / Math.max(size.width, size.height);
            if (size.height > 0) {
              const a = size.width / size.height;
              thumbAspects.set(i, a);
              row.setAspect(a);
            }
            frame = await s.render(i, scale);
          } catch {
            // A page that will not render is left as an empty frame, not an error
            // card: the strip is navigation, and a broken thumbnail must not stop
            // you reaching the page it stands for.
            row.setLoading(false);
            thumbPainted.add(i);
            continue;
          }
          thumbCounts.renders++;
          publishThumbCounts();
        }

        // THE INK, for a page that has any. A failure here is a MISSING OVERLAY,
        // not a broken row — the same rule `paintMark` states for the page on
        // screen — so the bare page stands and is stored under its own key.
        let thumb = base ?? frame!.bitmap;
        let ours = base === undefined; // the cache owns what it handed back
        let inked = false;
        // The bare page, once a composite has REPLACED it on the row. It is a
        // legitimate thumbnail of its own and it cost a MuPDF render, so it goes
        // into the cache under its own key rather than being closed: that is what
        // makes every later repaint of this row — a reopen where the strip beats
        // the mark's metadata, or a mark the device has rewritten — a decode
        // instead of a second render and, on a cold block, a second range fetch.
        let bare: ImageBitmap | null = null;
        if (ref) {
          const composed = await compositeInk(thumb, ref);
          if (composed) {
            if (ours) bare = thumb;
            thumb = composed;
            ours = true;
            inked = true;
            thumbCounts.inked++;
            publishThumbCounts();
          }
          // DELIBERATELY NO SUPERSEDED CHECK HERE. Fetching and decoding a mark
          // page is the longest await in this loop, so leaving the document
          // mid-composite is the COMMON way out of it — and the write-through
          // below is built for exactly that: pixels that are valid for this page
          // forever are handed over first, and only then does the paint find out
          // it has been overtaken. An early return here threw away a MuPDF render
          // the app had already paid for, which showed up as a page rendered a
          // second time on the next visit.
        }

        // WRITE-THROUGH, and deliberately BEFORE the superseded check: the
        // render already happened and its pixels are valid for this page
        // forever, so handing them to the cache turns a scroll-past into work
        // that is not wasted. Ownership passes here — from this point the
        // bitmap must NOT be closed, because the cache's LRU closes it on
        // eviction and a double close would poison the entry.
        //
        // UNDER THE KEY THE PIXELS ACTUALLY ARE. A page whose ink would not
        // fetch or decode is stored as what it is — the bare page — so the inked
        // key is never occupied by an ink-free picture that would then be served
        // in preference to ever trying again. And a base that came OUT of the
        // cache is not put back: it is already there, under that same key.
        const writeKey = ref && !inked ? pageThumbKey(i) : key;
        let owned = false;
        if (docHash && ours) {
          try {
            await deps.cache.put(writeKey, thumb);
            owned = true;
          } catch {
            owned = false; // it never entered the cache, so it is still ours
          }
        }
        if (bare) {
          try {
            await deps.cache.put(pageThumbKey(i), bare);
          } catch {
            bare.close(); // it never entered the cache, so it is still ours
          }
        }

        // Superseded — by another document, or by the row scrolling out of the
        // window and its canvas being recycled under us. The pixels have nowhere
        // legitimate to go; close them only if the cache did not take them.
        if (mine !== generation || thumbRows.get(i) !== row) {
          if (ours && !owned) thumb.close();
          if (mine !== generation) return;
          continue;
        }
        row.canvas.width = thumb.width;
        row.canvas.height = thumb.height;
        row.canvas.getContext("2d")?.drawImage(thumb, 0, 0);
        if (ours && !owned) thumb.close();
        row.setLoading(false);
        // DID THIS ROW'S IDENTITY MOVE WHILE IT WAS BEING PAINTED? `loadMark`
        // resolves on its own schedule, so a page can acquire ink between the
        // read at the top and the draw here — and nothing else would ever repaint
        // it. The pixels above are the best thing to show meanwhile (a page
        // without its ink beats a skeleton), so they stay up and the row goes
        // round again; the second pass finds the page it just cached and adds the
        // handwriting to it.
        if (thumbKey(i).hash !== key.hash) {
          thumbQueue.push(i);
          continue;
        }
        thumbPainted.add(i);
      }
    } finally {
      thumbsBusy = false;
    }
  }

  /**
   * A `.mark` landed after the strip had already painted: the rows it writes on
   * are now the wrong picture, so send them round again.
   *
   * ONLY THE FINISHED ONES. A row still in the queue has not read its key yet
   * and will pick up the new one for free; a row outside the strip's window has
   * no canvas to correct and is queued afresh when it scrolls back. And the old
   * pixels are deliberately left up rather than reset to the loading treatment —
   * the page without its ink is a truthful thing to look at for the moment the
   * repaint takes, and a strip that flashes back to skeletons the instant the
   * mark arrives looks like a fault.
   */
  function repaintInkedThumbs(): void {
    let any = false;
    for (const i of markPages.keys()) {
      if (!thumbPainted.has(i)) continue;
      thumbPainted.delete(i);
      thumbQueue.push(i);
      any = true;
    }
    if (any) void paintThumbs();
  }

  /** Forget every thumbnail: a new document, or none. */
  function resetThumbs(): void {
    thumbCounts.hits = 0;
    thumbCounts.renders = 0;
    thumbCounts.inked = 0;
    thumbCounts.probe = 0;
    publishThumbCounts();
    pagesPanel.clear(); // unmounts each row, which unobserves and dequeues it
    thumbRows.clear();
    thumbQueue.length = 0;
    thumbPainted.clear();
    thumbAspects.clear();
    firstAspect = 1 / Math.SQRT2;
  }

  let pagesOpen = false;
  const pagesToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-controls": "pdf-pages-panel",
    "aria-label": "Pages",
    title: "Pages",
    html: svg(VIEWER_IC.pages, 1.8),
  }) as HTMLButtonElement;
  function setPagesOpen(open: boolean): void {
    pagesOpen = open;
    pagesPanel.setOpen(open);
    pagesToggle.setAttribute("aria-pressed", String(open));
    // The panel NARROWS the page rather than covering it, so a Fit page is a
    // different size with it open — repaint, exactly as the reader re-runs
    // `showPage` on every panel toggle.
    if (open_) void paint();
  }
  pagesToggle.addEventListener("click", () => setPagesOpen(!pagesOpen));

  let layersOpen = false;
  const layersToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-controls": "pdf-layers-panel",
    "aria-label": "Annotations",
    title: "Annotations",
    html: svg(VIEWER_IC.layers, 1.8),
  }) as HTMLButtonElement;
  function setLayersOpen(open: boolean): void {
    layersOpen = open;
    layersPanel.el.hidden = !open;
    layersToggle.setAttribute("aria-pressed", String(open));
    if (open_) void paint(); // the panel narrows the page, exactly as Pages does
  }
  layersToggle.addEventListener("click", () => setLayersOpen(!layersOpen));

  // --- find (view zone) -----------------------------------------------------
  // The reader's find-toggle precedent, a third time: an icon-only `.btn` whose
  // open look rides on `aria-pressed`. Enabled for every PDF, like the `.txt`
  // viewer's and unlike the reader's — the reader gates on the device having
  // recognised the note, and there is no equivalent flag to gate on here (see
  // `pdfFind.ts`, on the missing `unrecognised` state).
  const findToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Find in this file",
    title: "Find in this file (Ctrl+F)",
    html: svg(VIEWER_IC.find, 1.8),
  }) as HTMLButtonElement;

  const findInput = el("input", {
    type: "text",
    autocomplete: "off",
    placeholder: "Find in this file",
    "aria-label": "Find in this file",
  }) as HTMLInputElement;
  const findCount = el("span", { class: "pdfbar__count", role: "status", "aria-live": "polite" });
  const findAsk = el("button", {
    class: "pdfbar__ask",
    type: "button",
    hidden: true,
    text: "Search similar",
  }) as HTMLButtonElement;
  const findPrev = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Previous match",
    title: "Previous match",
    html: svg(VIEWER_IC.prev, 1.9),
  }) as HTMLButtonElement;
  const findNext = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Next match",
    title: "Next match",
    html: svg(VIEWER_IC.next, 1.9),
  }) as HTMLButtonElement;
  const findClose = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Close find",
    title: "Close find",
    html: svg(VIEWER_IC.close, 1.9),
  }) as HTMLButtonElement;
  const findBar = el(
    "div",
    { class: "pdfbar", hidden: true },
    el("span", { class: "pdfbar__field", html: svg(VIEWER_IC.find, 1.8) }, findInput),
    findCount,
    findAsk,
    findPrev,
    findNext,
    findClose,
  );

  const toolbar = createToolbar({
    label: "PDF viewer",
    viewLabel: "PDF controls",
    fileLabel: "File actions",
    className: "viewer__bar",
    leading: [{ el: header.back, focus: [header.back] }, { el: header.title }],
    // PAGER BEFORE ZOOM, which is the reader's order (`reader.ts`: pager, zoom,
    // find, …). This had them reversed — the app's only two paged viewers putting
    // the same two controls in opposite places, so moving between a `.note` and a
    // `.pdf` meant re-finding both. Where a control sits is part of what it is.
    view: [
      { kind: "custom", key: "pager", el: pager, focus: [prev, next] },
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus },
      // Find sits where the reader puts it — pager, zoom, find — for the same
      // reason the pager was moved before zoom: the app's two paged viewers must
      // not put the same control in different places.
      { kind: "custom", key: "find", el: findToggle, focus: [findToggle] },
      { kind: "custom", key: "pages", el: pagesToggle, focus: [pagesToggle] },
      // Shown only where there is something to show: a PDF with no `.mark`
      // beside it has one layer, and a panel listing it alone is a control that
      // does nothing.
      { kind: "custom", key: "layers", el: layersToggle, focus: [layersToggle] },
    ],
    file: [
      { kind: "custom", key: "download", el: exportMenu.el, focus: [exportMenu.trigger] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      // Mutually exclusive with Move to bin: the retention countdown then the
      // "…" menu, whose one focusable is its trigger. Same order as `spdViewer`.
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });

  // A `<section>` with an `aria-label`, like the `.spd`/`.txt` viewers: that is
  // what makes it a named landmark rather than an anonymous div.
  // The panel docks beside the page, exactly as the reader's does — the page
  // index leads on the LEFT.
  layersPanel.el.hidden = true;
  layersToggle.hidden = true;
  const main = el("div", { class: "pdf-wrap" }, pagesPanel.el, body.main, layersPanel.el);
  const root = el(
    "section",
    { class: "viewer viewer--pdf", "aria-label": "PDF viewer", hidden: true },
    toolbar.el,
    findBar,
    main,
  );

  // --- rendering ----------------------------------------------------------

  /** The scale that fits the page to the stage, in MuPDF's points-per-unit. */
  /**
   * The box a page may occupy: the scroll container, less its padding, less
   * EVERY panel docked in it.
   *
   * NOT measured from `.pdf-stage`, which is what this did first and is
   * circular — the stage is sized BY the canvas, so a page that overflowed
   * measured a stage that had already grown to fit it, and "Fit" never fitted.
   * The reader has the same rule stated in CSS: "the panel's width is not the
   * page's", and it re-runs its layout on every panel toggle for exactly this
   * reason.
   *
   * BOTH panels, not just Pages. Annotations docks in the same flex row and
   * takes the same width out of the page's box, and this counted only Pages —
   * so a page shown with Annotations open was fitted to a stage 342px wider
   * than it had (a 320px panel plus the gap). Measured on the fixture: a 992px
   * page in a 650px slot.
   *
   * That never announced itself, in either era. While `.pdf-page` still carried
   * `max-width: 100%` the excess was quietly clamped away and the mark overlay —
   * placed against the size the raster was ASKED for — went 53% too large. With
   * the clamp gone the page simply runs 320px UNDER the panel, which is not an
   * overflow, so no scrollbar appears to admit it either. Every panel that
   * narrows the page has to be counted here.
   */
  function availableBox(): { w: number; h: number } {
    const rect = main.getBoundingClientRect();
    const cs = getComputedStyle(main);
    const padX = parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
    const padY = parseFloat(cs.paddingTop || "0") + parseFloat(cs.paddingBottom || "0");
    const gap = parseFloat(cs.columnGap || cs.gap || "0") || 0;
    let w = rect.width - padX;
    const h = rect.height - padY;
    for (const panel of [pagesOpen ? pagesPanel.el : null, layersOpen ? layersPanel.el : null]) {
      if (panel) w -= panel.getBoundingClientRect().width + gap;
    }
    return { w: Math.max(w, 120), h: Math.max(h, 120) };
  }

  function fitScale(pageWidthPt: number, pageHeightPt: number): number {
    if (pageWidthPt <= 0 || pageHeightPt <= 0) return 1;
    const box = availableBox();
    return Math.min(box.w / pageWidthPt, box.h / pageHeightPt);
  }

  function scaleFor(pageWidthPt: number, pageHeightPt: number): number {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const wanted = fitScale(pageWidthPt, pageHeightPt) * ZOOM_SCALE[zoom] * dpr;
    // Clamp by AREA, not by a scale ceiling: a big page at 200% and a small one
    // at the same zoom are wildly different rasters, and it is the pixel count
    // that costs wasm memory.
    const px = pageWidthPt * wanted * (pageHeightPt * wanted);
    if (px <= MAX_RASTER_PIXELS) return wanted;
    return wanted * Math.sqrt(MAX_RASTER_PIXELS / px);
  }

  async function paint(): Promise<void> {
    const mine = generation;
    const s = session;
    if (!s || !open_ || pageCount === 0) return;
    // THE PAGE THIS PAINT IS FOR, read once. `pageIndex` is mutable and every
    // step below awaits, so reading it again after a turn would measure one
    // page and raster another — the current page at the previous page's fit
    // scale, for as long as it takes the next paint to land.
    const page = pageIndex;
    let size: { width: number; height: number };
    try {
      size = await s.pageSize(page);
    } catch {
      return;
    }
    if (mine !== generation) return;
    const scale = scaleFor(size.width, size.height);
    let frame;
    try {
      frame = await s.render(page, scale);
    } catch (err) {
      if (mine !== generation) return;
      body.showPlaceholder("Couldn't draw this page", String((err as Error).message ?? err));
      return;
    }
    if (mine !== generation) {
      // Superseded mid-render. An ImageBitmap holds real pixels, so dropping
      // the reference is not enough — close it or the memory waits for a GC.
      frame.bitmap.close();
      return;
    }
    canvas.width = frame.width;
    canvas.height = frame.height;
    // CSS size in layout px, so the raster is DPR-sharp rather than upscaled.
    canvas.style.width = `${frame.width / Math.min(globalThis.devicePixelRatio || 1, 2)}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      frame.bitmap.close();
      return;
    }
    // `drawImage` of a TRANSFERRED bitmap, not `putImageData`: the pixels were
    // handed over from the worker rather than copied, which is the point of
    // rendering there.
    ctx.drawImage(frame.bitmap, 0, 0);
    frame.bitmap.close();
    body.main.replaceChildren(stage);
    syncPager();
    // The marks are placed against the page that is NOW on the canvas, so this
    // is the one place the size may be published — and find repaints from here
    // rather than the other way round, which is what makes a zoom step or a
    // panel toggle move the highlights with the page for free.
    pageSizePtNow = size;
    find.repaint();
    void paintLinks(page, size);
    // The export rows depend on what `paintMark` finds — whether this page has
    // ink at all, and whether any of it is toggled — so they are reconciled
    // AFTER it settles, on every path out of it (a page with no mark, a mark
    // that would not decode, a fetch that failed, and the happy one).
    void paintMark(page, size).finally(() => downloads.refreshGroups());
  }

  /**
   * Make the page's OWN links clickable — the `/Annots` the document was
   * authored with, not anything this app adds.
   *
   * The same lifecycle as {@link paintMark}, and for the same reason: the
   * placement is computed from the canvas's REAL size, which is the one thing
   * that changes on every zoom step and every panel toggle. So this runs after
   * the raster lands, on every paint, and a zoom is free of any re-decode.
   *
   * THE OLD LINKS COME DOWN FIRST, before anything is awaited. A page's links
   * are page-specific and the round trip is not instant, so leaving the previous
   * page's anchors up over the new page would offer targets that belong to a
   * page you are no longer on — the one failure here that is worse than having
   * no links at all.
   *
   * A FAILURE IS A MISSING LAYER, NOT A BROKEN PAGE, exactly as `paintMark` has
   * it: the document still reads perfectly without its links, so nothing here
   * ever touches `body.showPlaceholder`.
   */
  async function paintLinks(
    page: number,
    pageSizePt: { width: number; height: number },
  ): Promise<void> {
    const mine = generation;
    const s = session;
    const m = meta;
    linkLayer.clear();
    if (!s || !open_ || !m) return;
    let links;
    try {
      links = await s.pageLinks(page);
    } catch {
      return;
    }
    // `pageIndex !== page` as well as the generation, for the reason `paintMark`
    // spells out: the counter moves when the DOCUMENT is released and never on
    // a page turn, so every page of one document shares it.
    if (mine !== generation || pageIndex !== page || links.length === 0) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    linkLayer.setLinks(links, {
      pagePt: pageSizePt,
      canvas: { width: canvas.width / dpr, height: canvas.height / dpr },
      // A REAL ROUTE, so following a link leaves you somewhere you can share and
      // reload into — the router already owns this address and `syncUrl` above
      // already publishes it. A file open from the recycle bin keeps the bin
      // form, or the jump would 404 back to the library.
      hrefForPage: (p) => (fromBin ? binNotePageHref(m.id, p) : notePageHref(m.id, p)),
      // The same path the pager and the arrow keys take, so a link to page 12
      // repaints rather than reopening the document. `go` publishes the address
      // itself, so the URL still ends up where the href pointed.
      onJump: (p) => void go(p),
    });
  }

  /**
   * Put the `.mark`'s ink over the page that was just drawn, or take it away.
   *
   * Called AFTER the raster lands, because the placement is computed from the
   * canvas's real size — which is the one thing that changes on every zoom step
   * and every panel toggle. Nothing here re-decodes on a resize: the host is one
   * element and the transform is CSS, so a zoom moves it rather than rebuilding
   * it.
   */
  async function paintMark(
    page: number,
    pageSizePt: { width: number; height: number },
  ): Promise<void> {
    const mine = generation;
    const ref = markPages.get(page);
    // No annotations on this page — the common case, since a mark is sparse.
    if (!ref || !markId) {
      markCtl.el.hidden = true;
      layersPanel.setLayers([pdfRow()]);
      return;
    }
    /**
     * Is this paint still the one the screen wants?
     *
     * `generation` alone cannot answer it. That counter moves when the DOCUMENT
     * is released and never on a page turn, so every page of one document
     * shares a generation — and this function awaits the network. Turn from one
     * annotated page to another while the first page's bytes are in flight and
     * the LATE arrival would present its ink over the page now on screen, then
     * stay there: nothing repaints a page that is already drawn.
     *
     * Identity is the test, because every page owns its own `PageRef`.
     */
    const superseded = (): boolean => mine !== generation || markPages.get(pageIndex) !== ref;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const place = placePanelOverPage(
      { width: ref.width, height: ref.height },
      pageSizePt,
      { width: canvas.width / dpr, height: canvas.height / dpr },
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
      // BEFORE `present`, which COMMITS. The controller discards a present that
      // is overtaken mid-flight, but it cannot undo one that already landed —
      // so a late arrival has to be stopped on this side of the call.
      if (superseded()) return;
      const stack = await markCtl.present(markId, ref.hash, bytes, ref.layers ?? [], deps.getTheme());
      if (superseded()) return;
      if (!stack) {
        // This mark page would not decode. Take the OLD ink down: `present`
        // returns null WITHOUT releasing what is mounted, so leaving it would
        // show the previous page's handwriting over this one while the panel
        // underneath listed only the document.
        //
        // Unless the stack up is already the one we wanted: `present` also
        // returns null when a CONCURRENT present of the same page overtook it,
        // and releasing then would destroy the good ink that other call just
        // committed.
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
      // The PAGE still stands on its own. A mark that will not load is a missing
      // overlay, not a broken document — the panel says so and the reader keeps
      // reading, which is why this never touches `body.showPlaceholder`.
      //
      // `superseded`, not the bare generation check: a fetch that fails for the
      // page you have already turned AWAY from must not strip the ink off the
      // page you turned TO.
      if (superseded()) return;
      markCtl.el.hidden = true;
      layersPanel.setLayers([pdfRow()]);
    }
  }

  /**
   * THE MARK'S BACKGROUND LAYER NEVER PAINTS HERE.
   *
   * A `.note` layer stack carries a BGLAYER holding the device's paper — ruled
   * stationery, a template, or a rendering of the page being annotated. Over a
   * PDF that layer is not content, it is a SECOND OPAQUE SHEET, and compositing
   * it hides the document completely: the first run of this painted white bands
   * and black bars over the page and nothing of the PDF survived.
   *
   * The PDF is the background. So the background is dropped from the stack and
   * from the panel, and the `Document` row stands where it would have been.
   */
  function suppressBackground(views: readonly { index: number; slot: string }[] | undefined): void {
    for (const v of views ?? []) if (v.slot === "background") markCtl.setVisible(v.index, false);
  }

  // --- find in this PDF ------------------------------------------------------
  // The controller owns the debounce/race/state logic (`pdfFind.ts`); this is
  // only the DOM half of it — the counter's words and the marks on the page.

  /**
   * Put the marks over the page that is drawn.
   *
   * The words arrive in the page's POINTS and land through `placePageRect`, the
   * same mapping `placeLink` uses for the document's own links and the same fit
   * `placePanelOverPage` inverts for the `.mark` ink. One page, one page→screen
   * transform: that is what stops a highlight and the handwriting over it from
   * drifting apart on a rotated document.
   *
   * A page with no size yet (nothing rastered) takes the layer DOWN rather than
   * guessing at one — a box placed against a page that is not on screen is a box
   * in the wrong place.
   */
  function paintFindMarks(words: PdfWord[], current: number): void {
    const size = pageSizePtNow;
    if (!size || words.length === 0) {
      findLayer.clear();
      return;
    }
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    findLayer.setMarks(words, {
      pagePt: size,
      canvas: { width: canvas.width / dpr, height: canvas.height / dpr },
      current,
    });
  }

  const find: PdfFindController = createPdfFindController({
    api: deps.api,
    failures: { onSessionExpired: deps.onSessionExpired },
    // THE LOCATOR, and the one seam that makes this testable without a worker.
    // A page that will not read is a page with no boxes: the count above it is
    // the server's and stays exactly as it was.
    words: async (page) => (session && open_ ? session.pageWords(page) : []),
    view: {
      setOpen(isOpen) {
        findBar.hidden = !isOpen;
        root.classList.toggle("is-finding", isOpen);
        findToggle.setAttribute("aria-pressed", String(isOpen));
        if (!isOpen) findLayer.clear();
      },
      setState(state) {
        findCount.textContent = pdfCountText(state);
        findCount.classList.toggle("is-none", pdfCountIsNone(state));
        // The opt-in affordance appears in exactly one state: the exact find is
        // empty AND a typo-tolerant one would find something.
        findAsk.hidden = state.kind !== "fuzzyPrompt";
        // The address bar follows the query, so a find is a place you can send
        // someone — the half of the deep-link contract this viewer never held up.
        syncUrl();
      },
      setPageMarks: paintFindMarks,
      showPage: (index) => void go(index),
      setStepEnabled(enabled) {
        findPrev.disabled = !enabled;
        findNext.disabled = !enabled;
      },
      focusField() {
        findInput.focus();
        findInput.select();
      },
    },
  });

  findToggle.addEventListener("click", () => find.toggle());
  findClose.addEventListener("click", () => {
    find.close();
    findInput.value = "";
  });
  findInput.addEventListener("input", () => find.setQuery(findInput.value));
  findInput.addEventListener("keydown", (e) => {
    // Enter steps, Shift+Enter steps back — what every find bar does, and the
    // only way to walk matches without leaving the field.
    if (e.key === "Enter") {
      e.preventDefault();
      find.step(e.shiftKey ? -1 : 1);
    }
  });
  findPrev.addEventListener("click", () => find.step(-1));
  findNext.addEventListener("click", () => find.step(1));
  findAsk.addEventListener("click", () => find.searchSimilar());

  /** The panel row standing for the page itself. */
  function pdfRow(): { id: number; name: string; visible: boolean } {
    return { id: PDF_LAYER_ID, name: "Document", visible: canvas.style.visibility !== "hidden" };
  }

  /** The page, then the mark's layers above it — bottom-up is the panel's order. */
  function withPdfRow(views: Parameters<typeof toPanelLayers>[0] | undefined) {
    if (!views) return [pdfRow()];
    const ink = views.filter((v) => v.slot !== "background");
    return [...toPanelLayers(ink), pdfRow()];
  }

  // --- exports --------------------------------------------------------------
  // The menu structure, the filenames and the toasts are `pdfExports.ts`'s. What
  // is here is the part only this viewer can answer: WHICH pixels, in WHICH
  // space.

  /**
   * The ink that belongs to `page`, or null.
   *
   * Guarded on `isPresented`, not merely on `markPages.has` — the mounted stack
   * survives a page turn until the next one commits (it is hidden, not
   * released), so a bare `stack()` would hand the previous page's handwriting to
   * an export named after this one. The reader states the same rule about its
   * `liveStack` and for the same reason.
   *
   * The BACKGROUND slot is dropped here rather than hidden, so it is absent from
   * both the export and the "has anything been toggled?" question. It is
   * force-hidden on screen (`suppressBackground`), and a layer that is always
   * hidden would otherwise make every page look permanently tuned.
   */
  function inkForExport(page: number): { ref: PageRef; views: NoteLayerView[] } | null {
    const ref = markPages.get(page);
    if (!ref || !markCtl.isPresented(ref.hash, deps.getTheme())) return null;
    const views = (markCtl.stack()?.views ?? []).filter((v) => v.slot !== "background");
    return views.length > 0 ? { ref, views } : null;
  }

  /** Which export rows the focused page can offer. See {@link PdfExportState}. */
  function exportState(): PdfExportState {
    const ink = inkForExport(pageIndex);
    return {
      hasInk: ink !== null,
      // COUNTED OFF `markPages`, not off the focused page: the whole-document
      // row asks "does this document have handwriting anywhere", which is the
      // one question the mark's own index answers directly. Pages beyond the
      // document's own count are dropped — a `.mark` can name a page the PDF
      // does not have, and offering an export of it would promise something
      // nothing can produce.
      markedPages: [...markPages.keys()].filter((p) => p < pageCount).length,
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
   * NOTHING HERE COMES OFF THE SCREEN. The on-screen canvas is at whatever
   * zoom, DPR and panel layout the reader happens to be at — a Fit page beside
   * two open panels is a fraction of the page's real resolution — so the page is
   * rendered FRESH at the export's own scale, and the ink is re-decoded by
   * `exportModel()` in the light world rather than reused from a possibly
   * dark-inverted stack. `export/exporter.ts` states the identical rule for
   * notes (`nativeBitmap`): exports decode, they never screenshot.
   *
   * The model's canvases are the caller's to free — several megabytes each,
   * on a device that may be a phone — which is what `release()` is for. The
   * SOURCES are freed here, as soon as they have been drawn in.
   */
  async function pageExportModel(opts?: { withPage?: boolean }): Promise<{
    model: LayeredExportModel;
    pagePt: { width: number; height: number };
    release: () => void;
  } | null> {
    const s = session;
    if (!s || !open_ || pageCount === 0) return null;
    const mine = generation;
    const page = pageIndex;

    let size: { width: number; height: number };
    try {
      size = await s.pageSize(page);
    } catch {
      return null;
    }
    if (mine !== generation) return null;

    const ink = inkForExport(page);
    // WITH INK, the page is rendered to fit the panel's own page-rect, so the
    // handwriting moves by a whole-pixel translation and is never resampled.
    // WITHOUT it there is no panel to agree with, so the round number stands in.
    const space = ink ? markExportSpace({ width: ink.ref.width, height: ink.ref.height }, size) : null;
    // THE PDF ROW ASKS FOR NO PAGE AT ALL. It is not exporting a picture of the
    // page — the decoder grafts the page's own content streams — so a raster here
    // would be a full MuPDF render (10 MB for A4 at the ink's resolution) built
    // only to be thrown away. The model still comes back at the SAME dimensions,
    // because those are the ink's space and the alpha has to land in it.
    const wantPage = opts?.withPage ?? true;
    let frame = null;
    if (wantPage) {
      try {
        frame = await s.render(page, space ? space.scale : plainExportScale(size));
      } catch {
        return null;
      }
      if (mine !== generation) {
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
      if (mine !== generation) return null;
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
   * The generation is NOT re-checked after the call, deliberately. Everything
   * else in this file paints, so a superseded answer has to be dropped before it
   * reaches the screen; this DOWNLOADS. The bytes were correct for the page the
   * user asked about, they are named after that page, and turning to page 5
   * while page 4's export is being built is not a reason to silently throw page
   * 4's file away.
   */
  async function exportPagePdf(page: number, ink: PdfInkOverlay): Promise<Uint8Array> {
    const s = session;
    // Thrown, not answered with null: this is reached only by clicking a row, and
    // the menu's own mechanics turn a rejection into a toast. Returning nothing
    // would be a click that does nothing at all.
    if (!s || !open_) throw new Error("no document is open");
    return s.exportPage(page, ink);
  }

  /**
   * The ink for ANY annotated page, ready for the decoder — not just the one on
   * screen.
   *
   * `pageExportModel` above can only answer for the FOCUSED page: it reads the
   * mounted stack, which is one page at a time and belongs to the screen. A
   * whole-document export needs seven pages of a seventy-seven page document
   * without disturbing the one being read, which is exactly what `inkRaster` is
   * for (`noteLayers.ts` says so at its definition) — it decodes, reduces and
   * releases, touching no state the viewer owns.
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
    const s = session;
    const id = markId;
    const ref = markPages.get(page);
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
        // NO PAGE RASTER, for the reason the per-page PDF row gives: the
        // document's own content streams are what the export keeps, and a
        // picture of them drawn on top would replace the text with an image of
        // the text. `inkAlpha` drops the document layer anyway.
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
   * NOT SEVENTY-SEVEN CALLS TO `exportPagePdf`. That route grafts a page into a
   * fresh document, and grafting drops `/Annots`; doing it for a whole document
   * would throw away the original's own annotations once per page. This one
   * annotates the pages that were written on inside the OPEN document and asks
   * the decoder for an INCREMENTAL UPDATE — the original's bytes untouched, with
   * only the changed objects appended.
   *
   * WHICH IS ALSO WHY THE ORIGINAL IS A BLOB. It is fetched, concatenated and
   * downloaded without ever being read into an array: `res.blob()` and
   * `new Blob([original, delta])` are both backed by disk, so a 76 MB document
   * costs this tab a handle and a few hundred kilobytes rather than 76 MB of
   * heap. `arrayBuffer()` anywhere on this path would undo the entire design.
   */
  async function exportDocumentPdf(
    onProgress: (done: number, total: number) => void,
  ): Promise<{ blob: Blob; pages: number }> {
    const s = session;
    const m = meta;
    if (!s || !open_ || !m) throw new Error("no document is open");
    const pages = [...markPages.keys()].filter((p) => p < pageCount).sort((a, b) => a - b);
    if (pages.length === 0) throw new Error("this PDF has no annotations to burn in");
    const url = rawFileUrl(m.id, m.fileHash, { download: false, bin: fromBin });
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
      // export: the other six pages of handwriting are worth more than the
      // refusal, and the count below says how many really went in.
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

  function syncPager(): void {
    pageReadout.textContent = pageCount > 0 ? `${pageIndex + 1} / ${pageCount}` : "—";
    prev.disabled = pageIndex <= 0;
    next.disabled = pageIndex >= pageCount - 1;
  }

  /**
   * Publish the page to the address bar, so a PDF page is a place you can link
   * to and reload into.
   *
   * The route has always been able to CARRY one — `#/note/:id/page/:n` is shared
   * with the reader and `open()` honours it — but this viewer never wrote one
   * back, so the half of the contract a person actually uses was missing: paging
   * to 34 and reloading returned to page 1, and there was no address to send
   * anyone. The reader has published its page since it existed
   * (`reader.ts`'s `syncUrl`); this is now the same rule minus only the history
   * preview, which a PDF really has none of.
   *
   * THE QUERY RIDES IT NOW. It used to pass `""` unconditionally, under a comment
   * saying a PDF has no find query — true when it was written and untrue from the
   * moment PDF text indexing shipped. Without it a global-search hit on a PDF
   * opened the right page and then dropped the search on the first page turn, so
   * the address you could copy was never the screen you were looking at.
   *
   * A BIN origin publishes the `#/bin/note/:id/page/:n` form, exactly as the
   * reader does: a trashed file's blob is not served from the live route, so
   * writing the live address would make a reload 404 to the library. No query
   * rides a bin URL — the route pins the file and the page only.
   */
  function syncUrl(): void {
    if (!open_ || !meta) return;
    deps.onPosition?.(meta.id, pageIndex, fromBin ? "" : find.query(), undefined, fromBin || undefined);
  }

  async function go(to: number): Promise<void> {
    if (!open_ || to < 0 || to >= pageCount || to === pageIndex) return;
    pageIndex = to;
    syncPager();
    pagesPanel.setCurrent(to);
    // BEFORE `syncUrl`, so the address carries the page AND the query together,
    // and before the raster, so the marks are already the new page's when it
    // lands rather than one paint behind.
    find.setPage(to);
    syncUrl();
    await paint();
  }

  // --- keyboard (only while the viewer is on screen) ------------------------
  // This app has exactly TWO paged viewers — the `.note` reader and this one —
  // and they were reachable by different means: the reader pages with the arrow
  // keys (`reader.ts`), while this had the pager buttons and nothing else. Same
  // control, same interaction, so the same keys.
  //
  // The shape is `txtViewer.ts`'s (guard on `root.hidden`, one document listener
  // for the viewer's life, Escape leaves) and the paging is the reader's, down
  // to leaving modified arrows alone being a thing NEITHER does — matching the
  // reader is the point here, and a divergence would be its own inconsistency.
  function onKey(e: KeyboardEvent): void {
    if (root.hidden) return;
    // Ctrl+F BEFORE the input guard: the whole point of it is to reach the field
    // from anywhere, including from inside the field (where it re-focuses rather
    // than closing, as every other find bar does).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      find.open();
      return;
    }
    // ESCAPE CLOSES FIND FIRST, then leaves. Escape out of the viewer while a
    // search is open would throw away the search AND the document in one press,
    // and there would be no way to keep the document — the same order the `.txt`
    // viewer and the reader take.
    if (e.key === "Escape") {
      if (find.isOpen()) {
        find.close();
        findInput.value = "";
        return;
      }
      return deps.onBack();
    }
    // Paging keys belong to the page, not to the field someone is typing in.
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") void go(pageIndex + 1);
    else if (e.key === "ArrowLeft") void go(pageIndex - 1);
  }
  document.addEventListener("keydown", onKey);

  /**
   * Fetch the paired `.mark`'s page list and index it BY PDF PAGE.
   *
   * `sourcePage` is 1-based (it is the number the device wrote in the footer),
   * and `pageIndex` here is 0-based, so the key is `sourcePage - 1`. A page
   * without one is skipped rather than guessed at: an unnumbered page cannot be
   * placed, and placing it wrongly is the failure this whole feature was warned
   * about.
   */
  async function loadMark(id: Id, mine: number): Promise<void> {
    let mm: NoteMeta;
    try {
      mm = await deps.api.getNoteMeta(id);
    } catch {
      return; // no annotations is a fine state; the PDF is the document
    }
    if (mine !== generation) return;
    markId = id;
    markPages.clear();
    layersToggle.hidden = false;
    for (const ref of mm.pages) {
      if (ref.sourcePage !== null && ref.sourcePage > 0) markPages.set(ref.sourcePage - 1, ref);
    }
    // AND THE MENU, which until now could only learn about a mark as a side
    // effect of repainting an annotated page. The whole-document row asks
    // "does this document have handwriting anywhere", and the answer arrives
    // HERE — a document whose ink is all on page 40 would otherwise have kept
    // the row hidden until someone happened to turn to page 40.
    downloads.refreshGroups();
    // The page on screen was painted before this landed, so give it its ink.
    if (open_ && markPages.has(pageIndex)) void paint();
    // And so was the STRIP, which is the one place that answers "which pages did
    // I write on" — leaving it ink-free until each row happens to be recycled
    // would mean the answer depends on how you scrolled.
    repaintInkedThumbs();
  }

  // --- open / teardown ----------------------------------------------------

  function release(): void {
    generation++; // anything in flight stops before it touches the handle
    if (open_ && session) {
      // Fire and forget: the worker serialises, so a later `open` cannot
      // overtake this close, and nothing here needs to wait for it.
      void session.close().catch(() => {});
    }
    open_ = false;
    pageCount = 0;
    pageIndex = 0;
    markId = null;
    markPages.clear();
    // NOT just hidden — RELEASED. The stack is full-resolution RGBA, megabytes
    // per layer, and hiding the host frees none of it: only `release` zeroes the
    // canvases (`noteLayers.ts`, `zeroCanvas`). Without this, viewing one
    // annotated page and walking back to the library left the ink resident for
    // the life of the tab, on a device that may be a phone.
    //
    // This is the one choke point — `open`, `hide`, `destroy` and the no-pages
    // path all come through here, and a page turn deliberately does NOT, so the
    // decoded stack still survives paging within a document.
    markCtl.release();
    markCtl.el.hidden = true;
    // The links belonged to a page of a document that is going away, and every
    // one of them is a live address into it. Left up, they would sit over the
    // next document's first page pointing at the last one's.
    linkLayer.clear();
    // And the search belonged to that document too — its counts, its per-page
    // word cache and its marks. `reset` closes the bar, so the field is cleared
    // beside it or the next document would open showing the last one's query
    // over a counter that says nothing.
    find.reset();
    findInput.value = "";
    findLayer.clear();
    pageSizePtNow = null;
    layersToggle.hidden = true;
    layersPanel.el.hidden = true;
    layersOpen = false;
    // Forget the file the bin actions point at. Without this, Move to bin after
    // navigating away would trash whatever was open LAST — the controls outlive
    // any one document, so their target has to be cleared with it.
    meta = null;
    // Drops every canvas and stops observing: a strip left behind would keep
    // painting into rows for a document that is no longer open.
    resetThumbs();
    // The per-page groups described the document that just went away. Nothing
    // has ink now, so the layered rows fold back before the next one opens —
    // and the popover shuts, or it would hang open over the next file with the
    // last one's rows in it (`spdViewer` closes it on the same events).
    downloads.refreshGroups();
    exportMenu.setOpen(false);
    // AND FORGET THE ADDRESS. The raw row's href is minted per open and the row
    // outlives any one document, so leaving it set would offer the file you just
    // navigated away from — for the whole window between the next `open()` and
    // its metadata landing, which on a slow link is exactly when someone reaches
    // for Download. Same reasoning as clearing `meta` above.
    downloads.setRawHref(null);
  }

  async function open(
    summary: NoteSummary,
    metaPromise: Promise<NoteMeta>,
    page: number,
    origin: ReaderOrigin,
    query: string,
  ): Promise<void> {
    release();
    const mine = generation;
    root.hidden = false;
    fromBin = origin.kind === "bin";
    // The context swap: Move to bin for a live file, the retention + "…" cluster
    // for a trashed one. Set BEFORE the metadata lands so the toolbar never shows
    // the wrong pair while loading — both are inert until `meta` arrives, and
    // each guards on it.
    moveBin.hidden = fromBin;
    binActions.setBinMode(fromBin, fromBin ? (origin.retention ?? null) : null);
    header.setName(summary.name);
    header.setBackWord(backWord(origin));
    // THE SUBTITLE FILLS IN AS THE FILE DOES, which is the reader's habit too.
    // It used to be a bare `"PDF"` for the whole session — the one line of copy
    // the viewer owns, saying the only thing already on screen three times over:
    // the library's listing, the file glyph, and the pager's `/ 77`. Its job is
    // what nothing else carries. That is the FOLDER PATH from the first frame
    // (the Back button shows only the deepest segment), then the SIZE once the
    // metadata lands — on a slow link, what you want in order to decide whether
    // to wait — and finally the page count, below, once it is known.
    header.setSubtitle(originSubtitle(origin, summary.fileType?.toUpperCase() || "PDF"));
    zoom = "Fit";
    // The READOUT too, not just the state behind it. The stepper keeps its own
    // label, so a new document opened after zooming the last one rendered at Fit
    // while the toolbar still said 300% — and the next step moved from the
    // number on screen rather than from the page in front of you.
    zoomStepper.set("Fit");
    pageIndex = Math.max(0, page);
    body.showPlaceholder(summary.name, "Opening this PDF…");
    syncPager();

    if (!seam.supported()) {
      // The one capability this app asks for that nothing else does: MuPDF's
      // error handling compiles to the wasm EXCEPTION-HANDLING proposal.
      body.showPlaceholder(
        summary.name,
        "This browser can't preview PDFs. Download it to read it, or try a newer browser.",
      );
      return;
    }

    let m: NoteMeta;
    try {
      m = await metaPromise;
    } catch {
      if (mine !== generation) return;
      body.showPlaceholder(summary.name, "Couldn't read this file.");
      return;
    }
    if (mine !== generation) return;
    meta = m;
    docHash = m.fileHash ?? "";
    // The `.mark` beside this PDF, if the server found one. Fetched WITHOUT
    // blocking the document: opening a PDF is already several round trips and
    // the ink is useless before there is a page under it, so this rides along
    // and lands whenever it lands. `paint` reads `markPages` each time, so a
    // late arrival simply shows up on the next page turn — or on this page, via
    // the repaint below.
    if (m.annotationsId) void loadMark(m.annotationsId, mine);
    if (m.size > 0) header.setSubtitle(originSubtitle(origin, formatBytes(m.size)));
    const url = rawFileUrl(m.id, m.fileHash, { download: false, bin: fromBin });
    // Decided off the URL ITSELF, never off an element's `href`: reading that
    // property back resolves an empty attribute against the document base, so a
    // falsy test on it is never true — which is how a file with no address (the
    // state the placeholder below exists for) once kept a live Download button
    // pointing at the app. `null` DISABLES the raw row; the menu itself stays,
    // because the per-page exports are built from pixels this viewer already has
    // and need no download URL at all.
    downloads.setRawHref(rawFileUrl(m.id, m.fileHash, { download: true, bin: fromBin }));

    if (!url) {
      body.showPlaceholder(summary.name, "This file has no readable address.");
      return;
    }

    // NO SIZE GATE. There used to be a 64 MB `MAX_PREVIEW_BYTES` here, refusing
    // large files with an honest "download it instead" — honest because the
    // viewer really did have to pull the whole file across the wire and into
    // wasm memory before it could paint anything. With range-served blocks it
    // does not: page 1 costs the blocks page 1 is written in, whatever the file
    // measures. The placeholder below still
    // catches the genuine failures — a corrupt file, an encrypted one, a browser
    // that cannot run the module.
    session ??= seam.createSession();
    const s = session;
    let pages: number;
    try {
      ({ pageCount: pages } = await s.open(url, m.size));
      open_ = true;
    } catch (err) {
      if (mine !== generation) return;
      // 401/403 is the shell's to handle (re-authenticate), not ours to paint.
      if (err instanceof PdfLoadError && (err.status === 401 || err.status === 403)) {
        deps.onSessionExpired();
        return;
      }
      // MuPDF's sentence goes to the CONSOLE, not to the page. The wasm keeps it
      // "for the browser to log" (`pdf_shim.c`) and files it under Diagnostics
      // (`pdf_decode.zig`); this used to print it verbatim in the placeholder,
      // so a household user met "cannot find document handler for file type: ''"
      // where every neighbouring failure speaks the app's own voice.
      //
      // The comment this replaces claimed the raw text distinguished "encrypted"
      // from "not a PDF". It does not, reliably: nothing in the shim calls
      // `fz_needs_password`, so an encrypted file fails wherever it happens to
      // fail, with whatever message MuPDF happens to throw. Saying so properly
      // needs that probe in the ABI — worth doing, and not this fix.
      // The one distinction worth keeping is the one the app can stand behind:
      // the bytes never arrived, versus they arrived and would not open.
      if (err instanceof PdfLoadError) {
        body.showPlaceholder(summary.name, "Couldn't load this PDF.");
      } else {
        console.warn("[pdf] open failed:", (err as Error).message ?? err);
        body.showPlaceholder(summary.name, "Couldn't read this file.");
      }
      return;
    }
    if (mine !== generation) return;
    pageCount = pages;
    // The reader's wording for a paged document, verbatim (`reader.ts`, note
    // mode): the count, pluralised, behind the same folder prefix.
    header.setSubtitle(
      originSubtitle(origin, `${pageCount} ${pageCount === 1 ? "page" : "pages"}`),
    );
    if (pageCount === 0) {
      body.showPlaceholder(summary.name, "This PDF has no pages.");
      release();
      return;
    }
    pageIndex = Math.min(pageIndex, pageCount - 1);
    // PRIME FIND FROM THE ROUTE. A `?q=` deep link is how a global-search hit on
    // a PDF arrives here, and until now this argument was named `_query` and
    // ignored: the viewer opened the right page with nothing marked and no way
    // to re-run the search that sent you. It is set AFTER the clamp, so the bar
    // and the page agree about where find has landed.
    //
    // A BIN origin carries no query — `router.ts` drops it there — so this is a
    // no-op for a trashed file rather than a branch.
    find.setDocument(m.id);
    find.setPage(pageIndex);
    if (query !== "") {
      findInput.value = query;
      find.open();
      find.setQuery(query);
    }
    // The page count is only known now, so this is the first moment the address
    // can be honest. It matters for the CLAMP above: a link to page 500 of a
    // 77-page document opens the last page, and the URL should say the page you
    // are on rather than the one you asked for.
    syncUrl();

    // The strip reserves every row's shape from PAGE 0's aspect before anything
    // is painted, so it does not reflow as thumbnails land. A page of a
    // different size corrects its own row when its thumbnail resolves.
    try {
      const first = await s.pageSize(pageIndex);
      if (mine !== generation) return;
      if (first.height > 0) firstAspect = first.width / first.height;
    } catch {
      // Keep the default; a strip of slightly wrong boxes beats no strip.
    }
    pagesPanel.setPages(pageCount);
    pagesPanel.setCurrent(pageIndex);
    // The FIRST moment the export menu can be honest about this document. Its
    // whole-document row is gated on how many pages carry ink, and that count is
    // clamped to `pageCount` — which was zero until a few lines ago, so a
    // `.mark` that landed before the open finished reconciled against nothing.
    downloads.refreshGroups();

    await paint();
    // What the first page actually cost, once it is on screen. One message, and
    // the only way to answer "did the block cache work on this document?"
    // anywhere other than a test — see `lastPdfStats`.
    if (mine === generation) void s.stats().catch(() => {});
  }

  return {
    el: root,
    open,
    hide(): void {
      release();
      root.hidden = true;
    },
    destroy(): void {
      release();
      // `release` already resets it; this is the belt for the case where the
      // viewer is destroyed without ever having been opened.
      find.reset();
      document.removeEventListener("keydown", onKey);
      exportMenu.destroy(); // its outside-click + Escape listeners are on `document`
      pagesPanel.destroy();
      thumbIo?.disconnect();
      session?.destroy();
      session = null;
      root.remove();
    },
  };
}
