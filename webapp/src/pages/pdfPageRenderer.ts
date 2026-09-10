// The PDF RASTER PATH — one page onto one canvas, and everything that hangs off
// a finished raster.
//
// `paint()` measures the page, decides the scale, asks the worker for the
// pixels, draws them, and then republishes the page size, find's marks, the
// text selection, the document's own links and the `.mark`'s ink — in that
// order, because each is placed against the canvas that is NOW on screen.
//
// WHY THE OVERLAYS LIVE HERE and not with their layers: every one of them is
// placed from the canvas's REAL size, the one thing that changes on every zoom
// step and every panel toggle. Anywhere else would be a second place that has to
// know when a raster landed, and the failure is silent — boxes over the page
// they were computed for rather than the page that is drawn.
//
// TWO MEASUREMENTS LEAK OUT, deliberately: `stageInner()` to the dock rule
// (which answers a hypothetical about a panel with no box yet) and
// `cssCanvasSize()` to find's marks (which repaint on their own schedule). Two
// callers that each divide by their own device-pixel ratio are two callers that
// can disagree about where the page is.

import type { Id, NoteMeta, PageRef, Theme } from "../core/types";
import type { ViewerBody } from "./viewerChrome";
import type { LayersPanel } from "./layersPanel";
import type { NoteLayersController } from "./noteLayers";
import { toPanelLayers } from "./noteLayers";
import { FIT_PAGE, FIT_WIDTH } from "./viewerControls";
import type { LinkLayer } from "./linkLayer";
import type { PdfSelectionLayer } from "./pdfSelectionLayer";
import type { PdfFindController } from "./pdfFind";
import { binNotePageHref, notePageHref } from "../router";
import { placePanelOverPage } from "../render/markGeometry";
import type { PdfWord } from "../render/pdfWire";
import type { PdfSession } from "../render/pdfClient";

/**
 * Zoom steps, RELATIVE TO FIT — every step multiplies the scale that fits the
 * page to the stage, so the sequence is monotonic whatever the page measures.
 *
 * The reader can use absolute steps (`reader.ts`: 640px x a factor) because a
 * `.note` page is always the device's panel. PDF pages are not: this app has
 * seen 200pt fixtures, 458pt device exports, 612pt Letter and 1404pt
 * panel-sized exports — a 7x spread. With absolute steps, "zoom in" from Fit
 * SHRINKS a small page.
 *
 * `Fit ⇔` (fit width) sits SECOND because the ladder has to be ascending — that is what
 * the stepper's arrows promise. On a portrait page dropping the height term can
 * only make the scale larger, so `Fit ⇕` → `Fit ⇔` is a step up; on a
 * landscape page wide enough that width was already binding the two coincide.
 * Its multiplier is 1 for the same reason `Fit ⇕`'s is: the branch lives in
 * `fitScale`, not here.
 */
export const ZOOMS = [FIT_PAGE, FIT_WIDTH, "150%", "200%", "300%"] as const;
export type Zoom = (typeof ZOOMS)[number];
const ZOOM_SCALE: Record<Zoom, number> = {
  [FIT_PAGE]: 1,
  [FIT_WIDTH]: 1,
  "150%": 1.5,
  "200%": 2,
  "300%": 3,
};
/** Cap the raster so a big page at 200% cannot ask for a gigabyte of pixels. */
export const MAX_RASTER_PIXELS = 16 * 1024 * 1024;

/**
 * The layers panel's row id for the PDF page itself.
 *
 * Negative on purpose: a `.mark`'s layer indices are 0-based positions into its
 * own stack, so nothing it can carry collides with this and the toggle
 * dispatches on the id alone.
 */
export const PDF_LAYER_ID = -1;

/**
 * The scale that fits a page into a box, in MuPDF's points-per-unit — the FIT
 * half of the ladder, with no zoom multiplier and no clamp on it.
 *
 * `Fit ⇔` is fit-page with the height term dropped: the page fills the
 * stage across and runs off the bottom, which is how an A4 page is actually
 * read on a narrow screen. It cannot run away — {@link clampRasterScale} is
 * what bounds the raster, and a tall page at fit-width is exactly the case
 * that needs it, since nothing about the width term knows how tall the page
 * is.
 */
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

/**
 * The area ceiling, applied to a scale that has already been asked for.
 *
 * Clamp by AREA, not by a scale ceiling: a big page at 200% and a small one
 * at the same zoom are wildly different rasters, and it is the pixel count
 * that costs wasm memory.
 */
export function clampRasterScale(
  pageWidthPt: number,
  pageHeightPt: number,
  wanted: number,
): number {
  const px = pageWidthPt * wanted * (pageHeightPt * wanted);
  if (px <= MAX_RASTER_PIXELS) return wanted;
  return wanted * Math.sqrt(MAX_RASTER_PIXELS / px);
}

/**
 * The viewer state a paint reads, ASKED FOR rather than captured — everything
 * here can move between one `await` and the next.
 */
export interface PdfPageRendererState {
  session(): PdfSession | null;
  isOpen(): boolean;
  generation(): number;
  pageIndex(): number;
  pageCount(): number;
  zoom(): Zoom;
  /** The open document — its id and bin origin are what a link's href is made of. */
  meta(): NoteMeta | null;
  fromBin(): boolean;
  markId(): Id | null;
  markPages(): ReadonlyMap<number, PageRef>;
  /**
   * The panels docked in `main` RIGHT NOW, whose widths come off the page's box.
   * A list rather than the dock state itself: what {@link PdfPageRenderer.paint}
   * needs to know is which boxes to subtract, not which control opened them.
   */
  dockedPanels(): readonly HTMLElement[];
}

/** The elements the raster path draws into. All built and owned by the viewer. */
export interface PdfPageRendererDom {
  /** The flex row the page and every docked panel share — what `Fit` fits into. */
  main: HTMLElement;
  /** `.pdf-stage`: the canvas and the four layers over it. */
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
  /**
   * Find, for the two directions it runs in: its marks repaint FROM a finished
   * raster, and its per-page word cache is the selection's too.
   */
  find: Pick<PdfFindController, "repaint" | "wordsKnown" | "wordsFor">;
  /** The pager's readout, once the page that was asked for is the page drawn. */
  syncPager(): void;
  /** The export rows depend on what the mark paint finds. */
  refreshGroups(): void;
  /** A link inside the document was followed — the same path the pager takes. */
  onJump(page: number): void;
}

export interface PdfPageRenderer {
  /** Draw the focused page, and everything that hangs off a finished raster. */
  paint(): Promise<void>;
  /**
   * `main`'s content box, and the gap between the things docked inside it — the
   * one measurement the fit and the dock rule share.
   */
  stageInner(): { w: number; h: number; gap: number };
  /** The canvas's box in CSS pixels — the ONE page→screen conversion. */
  cssCanvasSize(): { width: number; height: number };
  /** The point size of the page currently on the canvas, or null. */
  pageSizePt(): { width: number; height: number } | null;
  /** The document is going away: forget the page that was on the canvas. */
  reset(): void;
}

export function createPdfPageRenderer(opts: PdfPageRendererOptions): PdfPageRenderer {
  const { deps, state, dom, find } = opts;
  const { canvas, stage, main, body, markCtl, linkLayer, selectLayer, layersPanel } = dom;

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
   * `main`'s content box, and the gap between the things docked inside it — the
   * one measurement {@link availableBox} and the dock rule share.
   *
   * They differ only in what they SUBTRACT from it: the panels that are mounted
   * (laying out the page as it stands) against the ones that would be (deciding
   * whether to let them open).
   *
   * A zero `w` means `main` is not laid out yet.
   */
  function stageInner(): { w: number; h: number; gap: number } {
    const rect = main.getBoundingClientRect();
    const cs = getComputedStyle(main);
    const padX = parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
    const padY = parseFloat(cs.paddingTop || "0") + parseFloat(cs.paddingBottom || "0");
    return {
      w: rect.width <= 0 ? 0 : rect.width - padX,
      h: rect.height - padY,
      gap: parseFloat(cs.columnGap || cs.gap || "0") || 0,
    };
  }

  /**
   * The box a page may occupy: the scroll container, less its padding, less
   * EVERY panel docked in it.
   *
   * NOT measured from `.pdf-stage`, which is circular — the stage is sized BY
   * the canvas, so a page that overflowed measures a stage that has already
   * grown to fit it, and `Fit ⇕` never fits.
   *
   * EVERY panel, not just Pages. Annotations docks in the same flex row and
   * takes the same width out of the page's box; counting only Pages fits the
   * page to a stage 342px wider than it has (a 320px panel plus the gap) —
   * measured on the fixture, a 992px page in a 650px slot. Nothing announces
   * it: the page simply runs under the panel, which is not an overflow, so no
   * scrollbar appears either.
   */
  function availableBox(): { w: number; h: number } {
    const box = stageInner();
    let w = box.w;
    for (const panel of state.dockedPanels()) {
      w -= panel.getBoundingClientRect().width + box.gap;
    }
    return { w: Math.max(w, 120), h: Math.max(box.h, 120) };
  }

  /** The scale that fits the page to the stage, in MuPDF's points-per-unit. */
  function fitScale(pageWidthPt: number, pageHeightPt: number): number {
    return fitScaleIn(pageWidthPt, pageHeightPt, availableBox(), state.zoom() === FIT_WIDTH);
  }

  /**
   * The ratio the page is RASTERED at, and the only place it is spelled.
   *
   * Capped at 2 because the raster is what the wasm heap is spent on: a 3x
   * phone would ask MuPDF for 2.25 times the pixels of a 2x one, and
   * {@link MAX_RASTER_PIXELS} would then take most of it back as a scale cut.
   */
  function rasterDpr(): number {
    return Math.min(globalThis.devicePixelRatio || 1, 2);
  }

  /**
   * The canvas's box in CSS pixels.
   *
   * The canvas is sized in DEVICE pixels so the page is sharp; every overlay on
   * top of it is placed in CSS pixels against this ONE conversion.
   */
  function cssCanvasSize(): { width: number; height: number } {
    const dpr = rasterDpr();
    return { width: canvas.width / dpr, height: canvas.height / dpr };
  }

  function scaleFor(pageWidthPt: number, pageHeightPt: number): number {
    const wanted = fitScale(pageWidthPt, pageHeightPt) * ZOOM_SCALE[state.zoom()] * rasterDpr();
    return clampRasterScale(pageWidthPt, pageHeightPt, wanted);
  }

  async function paint(): Promise<void> {
    const mine = state.generation();
    const s = state.session();
    if (!s || !state.isOpen() || state.pageCount() === 0) return;
    // THE PAGE THIS PAINT IS FOR, read once. `pageIndex` is mutable and every
    // step below awaits, so reading it again after a turn would measure one
    // page and raster another — the current page at the previous page's fit
    // scale, for as long as it takes the next paint to land.
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
      // Superseded mid-render. An ImageBitmap holds real pixels, so dropping
      // the reference is not enough — close it or the memory waits for a GC.
      frame.bitmap.close();
      return;
    }
    canvas.width = frame.width;
    canvas.height = frame.height;
    // CSS size in layout px, so the raster is DPR-sharp rather than upscaled.
    canvas.style.width = `${cssCanvasSize().width}px`;
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
    opts.syncPager();
    // The overlays are placed against the page that is NOW on the canvas, so
    // this is the one place the size may be published — and find repaints from
    // here rather than the other way round, which is what carries the marks and
    // the selection with the page on a zoom step or a panel toggle for free.
    pageSizePtNow = size;
    find.repaint();
    paintSelection();
    void paintLinks(page, size);
    // The export rows depend on what `paintMark` finds — whether this page has
    // ink at all, and whether any of it is toggled — so they are reconciled
    // AFTER it settles, on every path out of it (a page with no mark, a mark
    // that would not decode, a fetch that failed, and the happy one).
    void paintMark(page, size).finally(() => opts.refreshGroups());
  }

  /**
   * A STABLE EMPTY, because the selection layer treats a different array as a
   * different page and drops what is selected. A fresh `[]` on every paint would
   * therefore clear the selection on every zoom step.
   */
  const NO_WORDS: PdfWord[] = [];

  /** Hand the selection layer this page's words and the box to place them in.
   *  Synchronous, out of `paint()` — so it reads what has already landed and
   *  never asks. */
  function paintSelection(): void {
    const size = pageSizePtNow;
    if (!size) return;
    selectLayer.setPage(find.wordsKnown(state.pageIndex()) ?? NO_WORDS, {
      pagePt: size,
      canvas: cssCanvasSize(),
    });
  }

  /**
   * Fetch the current page's words, ON INTENT rather than on every paint.
   *
   * Building the structured text RUNS the page — every font and content stream
   * it references, the most suspending call in the decoder — so paying it on
   * every page turn would tax paging through a book for a feature most page
   * views never use. The pointer arriving over the page is the trigger instead:
   * a mouse hovers before it presses.
   *
   * THE WORDS ARE FIND'S CACHE, not a second one, so either feature paying for a
   * page pays once (`pdfFind.ts`'s `wordsFor`, which also joins a fetch already
   * in flight — what `pointerenter` followed by `pointerdown` needs).
   *
   * Failure is a page you cannot select, not a page you cannot read.
   */
  async function ensureSelectionWords(): Promise<void> {
    const page = state.pageIndex();
    if (find.wordsKnown(page) !== null) return;
    if (!state.session() || !state.isOpen()) return;
    const mine = state.generation();
    await find.wordsFor(page);
    // A fetch overtaken by a page turn or a new document must not paint the
    // page that is on screen now with the words of the one that was.
    if (mine !== state.generation() || state.pageIndex() !== page) return;
    paintSelection();
  }
  // ON THE STAGE, NOT ON THE LAYER, and that is forced rather than chosen: the
  // layer is `pointer-events: none` until it knows it has words, so it cannot
  // hear the event that would tell it to go and get them. The stage is under it
  // and always hears. Once the words land the layer switches itself on and takes
  // the pointer from here.
  stage.addEventListener("pointerenter", () => void ensureSelectionWords());
  // And on the press, for a pen or a pointer that arrives already down. That
  // first press selects nothing and the second selects, which beats never.
  stage.addEventListener("pointerdown", () => void ensureSelectionWords());

  /**
   * Make the page's OWN links clickable — the `/Annots` the document was
   * authored with, not anything this app adds.
   *
   * THE OLD LINKS COME DOWN FIRST, before anything is awaited. A page's links
   * are page-specific and the round trip is not instant, so leaving the previous
   * page's anchors up would offer targets belonging to a page you are no longer
   * on — worse than having no links at all.
   *
   * A FAILURE IS A MISSING LAYER, NOT A BROKEN PAGE: nothing here ever touches
   * `body.showPlaceholder`.
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
    // `pageIndex !== page` as well as the generation, for the reason `paintMark`
    // spells out: the counter moves when the DOCUMENT is released and never on
    // a page turn, so every page of one document shares it.
    if (mine !== state.generation() || state.pageIndex() !== page || links.length === 0) return;
    linkLayer.setLinks(links, {
      pagePt: pageSizePt,
      canvas: cssCanvasSize(),
      // A REAL ROUTE, so following a link leaves you somewhere you can share and
      // reload into. A file open from the recycle bin keeps the bin form, or the
      // jump would 404 back to the library.
      hrefForPage: (p) => (state.fromBin() ? binNotePageHref(m.id, p) : notePageHref(m.id, p)),
      // The same path the pager and the arrow keys take, so a link to page 12
      // repaints rather than reopening the document; `go` publishes the address
      // itself, so the URL still ends up where the href pointed.
      onJump: (p) => opts.onJump(p),
    });
  }

  /**
   * Put the `.mark`'s ink over the page that was just drawn, or take it away.
   *
   * Called AFTER the raster lands, because the placement is computed from the
   * canvas's real size. Nothing here re-decodes on a resize: the host is one
   * element and the transform is CSS, so a zoom moves it rather than rebuilding
   * it.
   */
  async function paintMark(
    page: number,
    pageSizePt: { width: number; height: number },
  ): Promise<void> {
    const mine = state.generation();
    const ref = state.markPages().get(page);
    const markId = state.markId();
    // No annotations on this page — the common case, since a mark is sparse.
    if (!ref || !markId) {
      markCtl.el.hidden = true;
      layersPanel.setLayers([pdfRow()]);
      return;
    }
    /**
     * Is this paint still the one the screen wants?
     *
     * `generation` alone cannot answer it: that counter moves when the DOCUMENT
     * is released and never on a page turn, so every page of one document shares
     * a generation — and this function awaits the network. Turn from one
     * annotated page to another while the first page's bytes are in flight and
     * the LATE arrival presents its ink over the page now on screen, then stays
     * there, because nothing repaints a page that is already drawn.
     *
     * Identity is the test, because every page owns its own `PageRef`.
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
   * PDF that layer is not content, it is a SECOND OPAQUE SHEET: compositing it
   * paints white bands and black bars over the page and nothing of the PDF
   * survives. So it is dropped from the stack and from the panel, and the
   * `Document` row stands where it would have been.
   */
  function suppressBackground(views: readonly { index: number; slot: string }[] | undefined): void {
    for (const v of views ?? []) if (v.slot === "background") markCtl.setVisible(v.index, false);
  }

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

  return {
    paint,
    stageInner,
    cssCanvasSize,
    pageSizePt: () => pageSizePtNow,
    reset(): void {
      pageSizePtNow = null;
    },
  };
}
