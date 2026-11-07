// The PDF viewer: one page at a time, rastered by MuPDF in a worker
// (`render/pdfClient.ts`). Pages share resources through the xref, so the
// document is opened once and held; range-served blocks mean no size ceiling.
// Past versions of a PDF are not previewable (`canPreviewHistory` excludes it).
//
// This file builds the DOM and wires the parts through a `PdfViewerCtx`
// (`pdfViewerContext.ts` has the rule).

import { el } from "../../ui/dom";
import type { PageRef } from "../../core/types";
import { createToolbar } from "../toolbar";
import { svg, VIEWER_IC } from "../viewer/viewerIcons";
import { applyPinch, createPager, createZoomStepper, FIT_PAGE } from "../viewer/viewerControls";
import { createViewerExportMenu } from "../viewer/viewerExportMenu";
import { createViewerHeader, createViewerBody, createVersionBanner } from "../viewer/viewerChrome";
import type { VersionSubject, Viewer, ViewerDeps } from "../viewer/viewer";
import { createPdfOutlinePanel } from "./pdfOutlinePanel";
import { closeWith } from "../../ui/sidePanel";
import { isPhone } from "../../ui/breakpoints";
import { attachPinch } from "../../ui/pinchZoom";
import { attachSwipe } from "../../ui/swipePages";
import { createPdfThumbStrip } from "./pdfThumbStrip";
import { createPdfPageRenderer, PDF_LAYER_ID, ZOOMS, type Zoom } from "./pdfPageRenderer";
import { createLinkLayer } from "../linkLayer";
import { createPdfHighlightLayer } from "./pdfHighlightLayer";
import { createPdfSelectionLayer } from "./pdfSelectionLayer";
import { createBinViewerActions } from "../../ui/binViewerActions";
import { createLayersPanel } from "../layersPanel";
import { contextualOpener, createCopyControl, createPdfDocks } from "./pdfChrome";
import { createFindBar } from "../viewer/findBar";
import { buildNoteLayerThumb, createNoteLayersController } from "../noteLayers";
import { createPdfExports } from "./pdfExports";
import { createPdfViewerExports } from "./pdfViewerExports";
import { supportsWasmExceptions } from "../../render/pdfLoader";
import { createPdfSession, type PdfSession } from "../../render/pdfClient";
import type { PdfViewerState } from "./pdfViewerState";
import { seedPdfViewerContext } from "./pdfViewerContext";
import { createPdfLifecycle } from "./pdfViewerLifecycle";
import { createPdfNav } from "./pdfViewerNav";
import { createPdfViewerFind } from "./pdfViewerFind";

/** The versions control offers the ink's history, never a past PDF. */
const ANNOTATIONS_HISTORY = "Annotation history";
const ANNOTATIONS_NO_INK = "this document has no annotations";

/** The browser seams, injectable so the viewer is testable without a worker. */
export interface PdfSeam {
  createSession(): PdfSession;
  /** False shows a "this browser can't" state. */
  supported(): boolean;
}

function defaultPdfSeam(): PdfSeam {
  return { createSession: createPdfSession, supported: supportsWasmExceptions };
}

export function createPdfViewer(deps: ViewerDeps, seam: PdfSeam = defaultPdfSeam()): Viewer {
  // ---- state ----
  const st: PdfViewerState = {
    session: null,
    open_: false,
    pageIndex: 0,
    pageCount: 0,
    zoom: FIT_PAGE,
    pinch: null,
    fromBin: false,
    meta: null,
    markId: null,
    annotationsId: null,
    previewVersion: null,
    previewViewOnly: false,
    docHash: "",
    generation: 0,
  };

  const markPages = new Map<number, PageRef>();

  // ---- DOM ----
  // Callbacks reach the parts through `ctx`, which exists by the time any fires.
  const header = createViewerHeader({
    classes: { back: "viewer__back", backLabel: "viewer__back-label", title: "viewer__title" },
    onBack: () => deps.onBack(),
  });

  const canvas = el("canvas", { class: "pdf-page" }) as HTMLCanvasElement;
  /**
   * The `.mark` ink over the page, through the reader's layers controller (a mark
   * is a `.note` container; decoded backgrounds are alpha 0). The ink is in device
   * panel pixels, so the host is oversized and shifted (`placePanelOverPage`) and
   * `.pdf-stage` clips the margins. `backdrop: null` or white paper hides the PDF.
   */
  const markCtl = createNoteLayersController({ backdrop: null });
  markCtl.el.classList.add("pdf-mark");
  /** Stacking is DOM order in `.pdf-stage`; links go last, above the ink. */
  const linkLayer = createLinkLayer();
  /** Find marks sit under the ink, so they never wash over someone's pen stroke. */
  const findLayer = createPdfHighlightLayer();
  /** The one pointer-taking layer; under the links so a press on a link reaches it. */
  const selectLayer = createPdfSelectionLayer({
    onChange: (has) => {
      copy.btn.hidden = !has;
    },
  });
  const stage = el(
    "div",
    { class: "pdf-stage" },
    canvas,
    findLayer.el,
    selectLayer.el,
    markCtl.el,
    linkLayer.el,
  );
  const body = createViewerBody({ mark: "PDF" });

  const zoomStepper = createZoomStepper<Zoom>({
    readoutClass: "pdf-zoom",
    initial: st.zoom,
    format: (z) => z,
    labels: { out: "Zoom out", in: "Zoom in" },
    onStep: (dir) => {
      // A step leaves a pinch for the ladder, from the rung it was on.
      const pinched = st.pinch !== null;
      st.pinch = null;
      const at = ZOOMS.indexOf(st.zoom);
      const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + dir))]!;
      if (next !== st.zoom || pinched) {
        st.zoom = next;
        void renderer.paint();
      }
      return st.zoom;
    },
  });

  const pager = createPager({ readoutClass: "pdf-pager__count", onGo: (index) => void ctx.nav.go(index) });

  // ---- download / export menu ----
  const exportMenu = createViewerExportMenu({ toast: deps.toast, className: "viewer__export" });
  const downloads = createPdfExports({
    menu: exportMenu,
    toast: deps.toast,
    docName: () => st.meta?.name ?? null,
    pageIndex: () => st.pageIndex,
    model: (opts) => exportDriver.model(opts),
    exportPagePdf: (page, ink) => exportDriver.exportPagePdf(page, ink),
    exportDocumentPdf: (onProgress) => exportDriver.exportDocumentPdf(onProgress),
    state: () => exportDriver.state(),
  });

  // ---- file zone: Move to bin, or the bin-origin cluster ----
  const moveBin = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Move to bin",
    title: "Move to bin",
    html: svg(VIEWER_IC.trash, 1.8) + '<span class="btn__label">Move to bin</span>',
  });
  moveBin.addEventListener("click", () => {
    if (st.meta) deps.onMoveToBin?.(st.meta);
  });
  const binActions = createBinViewerActions({
    getMeta: () => st.meta,
    onRestore: deps.onRestore,
    onPurge: deps.onPurge,
    // Wired only when the shell can open history, so there is no dead row.
    onHistory: deps.onVersions ? (m, anchor) => deps.onVersions!(m, anchor, undefined) : undefined,
  });

  // ---- annotation history ----
  const versionsOpener = contextualOpener({
    icon: VIEWER_IC.restore,
    label: ANNOTATIONS_HISTORY,
    reason: ANNOTATIONS_NO_INK,
  });
  versionsOpener.el.addEventListener("click", () => {
    const subject = versionSubject();
    if (subject) deps.onVersions?.(subject, versionsOpener.el, st.previewVersion?.md5);
  });

  /** The paired `.mark` under the document's name; `annotationsOn` carries the distinction. */
  function versionSubject(): VersionSubject | null {
    if (!st.meta || st.annotationsId === null) return null;
    return { id: st.annotationsId, name: st.meta.name, fileType: "mark", annotationsOn: st.meta.id };
  }

  /** `annotations` wording: the document is current, Restore changes only the ink. */
  const versionBanner = createVersionBanner({
    kind: "annotations",
    onRestore: () => {
      const subject = versionSubject();
      if (subject && st.previewVersion) deps.onRestoreVersion?.(subject, st.previewVersion);
    },
  });

  // ---- panel switches ----
  // Before the panels, whose × closes each through its switch.
  const pagesToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-controls": "pdf-pages-panel",
    "aria-label": "Pages",
    title: "Pages",
    html: svg(VIEWER_IC.pages, 1.8),
  }) as HTMLButtonElement;
  const outlineOpener = contextualOpener({
    icon: VIEWER_IC.outline,
    label: "Outline",
    reason: "this document has none",
    attrs: { "aria-pressed": "false", "aria-controls": "pdf-outline-panel" },
  });
  const layersToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-controls": "pdf-layers-panel",
    "aria-label": "Annotations",
    title: "Annotations",
    html: svg(VIEWER_IC.layers, 1.8),
  }) as HTMLButtonElement;

  // ---- annotations panel ----
  // The shared layers panel, with the PDF itself as the bottom row (`PDF_LAYER_ID`).
  const layersPanel = createLayersPanel({
    id: "pdf-layers-panel",
    hookPrefix: "pdf",
    onClose: closeWith(layersToggle),
    onToggle: (id, visible) => {
      if (id === PDF_LAYER_ID) canvas.style.visibility = visible ? "" : "hidden";
      else markCtl.setVisible(id, visible);
      // A toggle decides whether the original-view export group is offered.
      downloads.refreshGroups();
    },
    paintThumb: (pl) => {
      if (pl.id !== PDF_LAYER_ID) {
        const v = markCtl.stack()?.views.find((x) => x.index === pl.id);
        return v ? buildNoteLayerThumb(v) : el("div", { "aria-hidden": "true" });
      }
      const t = el("canvas") as HTMLCanvasElement;
      t.width = 96;
      t.height = Math.max(1, Math.round((96 * canvas.height) / Math.max(canvas.width, 1)));
      if (canvas.width > 0) t.getContext("2d")?.drawImage(canvas, 0, 0, t.width, t.height);
      return t;
    },
  });

  // ---- page index (docked left) ----
  // State getters are read afresh because they move under a paint in flight.
  const thumbs = createPdfThumbStrip({
    deps,
    state: {
      session: () => st.session,
      isOpen: () => st.open_,
      generation: () => st.generation,
      docHash: () => st.docHash,
      markId: () => st.markId,
      markPages: () => markPages,
      previewVersion: () => st.previewVersion,
    },
    inkRaster: (bytes, dst) => markCtl.inkRaster(bytes, dst),
    onPick: (i) => void ctx.nav.go(i),
    onClose: closeWith(pagesToggle),
  });
  const pagesPanel = thumbs.panel;


  pagesToggle.addEventListener("click", () =>
    docks.set(docks.left() === "pages" ? null : "pages", docks.right(), "left"),
  );

  // ---- outline ----
  const outlinePanel = createPdfOutlinePanel({
    onPick: (page) => void ctx.nav.go(page),
    onClose: closeWith(outlineOpener.el),
  });
  outlineOpener.el.addEventListener("click", () =>
    docks.set(docks.left() === "outline" ? null : "outline", docks.right(), "left"),
  );

  layersToggle.addEventListener("click", () => docks.set(docks.left(), !docks.right(), "right"));

  const docks = createPdfDocks({
    pagesPanel,
    outlinePanel,
    layersPanel,
    pagesToggle,
    outlineToggle: outlineOpener.el,
    layersToggle,
    stageWidth: () => renderer.stageInner().w,
    repaint: () => {
      if (st.open_) void renderer.paint();
    },
  });
  const copy = createCopyControl(() => selectLayer.text());

  // ---- find ----
  // Enabled for every PDF: there is no "unrecognised" state as for notes.
  const findToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Find in this file",
    title: "Find in this file (Ctrl+F)",
    html: svg(VIEWER_IC.find, 1.8),
  }) as HTMLButtonElement;
  const findBar = createFindBar({ block: "pdfbar", label: "Find in this file" });

  const toolbar = createToolbar({
    label: "PDF viewer",
    viewLabel: "PDF controls",
    fileLabel: "File actions",
    className: "viewer__bar",
    leading: [{ el: header.back, focus: [header.back] }, { el: header.title }],
    // Pager, zoom, find: the reader's order, so the two paged viewers agree.
    view: [
      { kind: "custom", key: "pager", el: pager.el, focus: pager.focus },
      // On a phone a pinch zooms; the stepper waits in ⋯ as its one-finger way.
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus, fold: true },
      // On a phone, beside ⋯ in the top row, where search usually is.
      { kind: "custom", key: "find", el: findToggle, focus: [findToggle], top: true },
      // Panel switches stay on the bar everywhere: their state is worth seeing.
      { kind: "custom", key: "pages", el: pagesToggle, focus: [pagesToggle] },
      { kind: "custom", key: "outline", el: outlineOpener.el, focus: [outlineOpener.el] },
      // Shown only when a `.mark` exists.
      { kind: "custom", key: "layers", el: layersToggle, focus: [layersToggle] },
      { kind: "custom", key: "copy", el: copy.btn, focus: [copy.btn], fold: true },
      { kind: "custom", key: "copy-live", el: copy.live, focus: [] },
    ],
    file: [
      { kind: "custom", key: "download", el: exportMenu.el, focus: [exportMenu.trigger] },
      { kind: "custom", key: "versions", el: versionsOpener.el, focus: [versionsOpener.el] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      // Mutually exclusive with Move to bin.
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });

  layersPanel.el.hidden = true;
  layersToggle.hidden = true;
  const main = el(
    "div",
    { class: "pdf-wrap" },
    pagesPanel.el,
    outlinePanel.el,
    body.main,
    layersPanel.el,
  );
  const root = el(
    "section",
    { class: "viewer viewer--pdf", "aria-label": "PDF viewer", hidden: true },
    toolbar.el,
    // Above the page, since it qualifies what is on screen.
    versionBanner.el,
    findBar.el,
    main,
  );

  // ---- rendering ----
  const renderer = createPdfPageRenderer({
    deps,
    state: {
      session: () => st.session,
      isOpen: () => st.open_,
      generation: () => st.generation,
      pageIndex: () => st.pageIndex,
      pageCount: () => st.pageCount,
      zoom: () => st.zoom,
      pinch: () => st.pinch,
      meta: () => st.meta,
      fromBin: () => st.fromBin,
      markId: () => st.markId,
      markPages: () => markPages,
      // Mounted panels only; {@link tooTight} weighs hypothetical ones.
      // A phone's panels are sheets below the page, beside nothing.
      dockedPanels: () =>
        isPhone()
          ? []
          : [
              docks.left() === "pages" ? pagesPanel.el : null,
              docks.left() === "outline" ? outlinePanel.el : null,
              docks.right() ? layersPanel.el : null,
            ].filter((panel): panel is HTMLElement => panel !== null),
    },
    dom: { main, stage, canvas, body, markCtl, linkLayer, selectLayer, layersPanel },
    // Through arrows: find is a part, built from the context below.
    find: {
      repaint: () => ctx.find.repaint(),
      wordsKnown: (page) => ctx.find.wordsKnown(page),
      wordsFor: (page) => ctx.find.wordsFor(page),
    },
    syncPager: () => ctx.nav.syncPager(),
    refreshGroups: () => downloads.refreshGroups(),
    onJump: (page) => void ctx.nav.go(page),
  });
  // ---- exports ----
  const exportDriver = createPdfViewerExports({
    deps,
    state: {
      session: () => st.session,
      isOpen: () => st.open_,
      generation: () => st.generation,
      pageIndex: () => st.pageIndex,
      pageCount: () => st.pageCount,
      meta: () => st.meta,
      fromBin: () => st.fromBin,
      markId: () => st.markId,
      markPages: () => markPages,
    },
    dom: { canvas, markCtl },
  });

  // ---- the context and the parts ----
  const ctx = seedPdfViewerContext({
    deps,
    seam,
    st,
    markPages,
    header,
    canvas,
    markCtl,
    linkLayer,
    findLayer,
    selectLayer,
    stage,
    body,
    zoomStepper,
    pager,
    exportMenu,
    downloads,
    moveBin,
    binActions,
    versionsOpener,
    versionBanner,
    layersPanel,
    thumbs,
    pagesPanel,
    pagesToggle,
    outlinePanel,
    outlineOpener,
    layersToggle,
    docks,
    copy,
    findToggle,
    findBar,
    main,
    root,
    renderer,
    exportDriver,
    setVersionsAvailable: versionsOpener.setAvailable,
    setOutlineAvailable(has) {
      outlineOpener.setAvailable(has);
      // No repaint: callers paint on their own path.
      if (!has && docks.left() === "outline") docks.set(null, docks.right(), null, false);
    },
  });
  ctx.find = createPdfViewerFind(ctx);
  ctx.nav = createPdfNav(ctx);
  ctx.lifecycle = createPdfLifecycle(ctx);
  document.addEventListener("keydown", ctx.nav.onKey);
  document.addEventListener("copy", ctx.nav.onCopy);

  // Pinch and double tap zoom the page; a sideways swipe turns it.
  attachSwipe({ scroller: main, turn: (dir) => void ctx.nav.go(st.pageIndex + dir) });
  attachPinch({
    scroller: main,
    surface: () => (stage.isConnected ? stage : null),
    scale: () => renderer.relativeScale(),
    setScale: (k) => {
      applyPinch(st, zoomStepper, k);
      void renderer.paint();
    },
  });

  return {
    el: root,
    open: ctx.lifecycle.open,
    hide(): void {
      ctx.lifecycle.release();
      root.hidden = true;
    },
    destroy(): void {
      ctx.lifecycle.release();
      // For a viewer destroyed without ever opening.
      ctx.find.reset();
      document.removeEventListener("keydown", ctx.nav.onKey);
      document.removeEventListener("copy", ctx.nav.onCopy);
      selectLayer.destroy();
      exportMenu.destroy(); // its outside-click + Escape listeners are on `document`
      thumbs.destroy();
      st.session?.destroy();
      st.session = null;
      root.remove();
    },
  };
}
