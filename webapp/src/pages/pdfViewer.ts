// The PDF viewer: one page at a time, rastered by MuPDF in a worker
// (`render/pdfClient.ts`). Pages share resources through the xref, so the
// document is opened once and held; range-served blocks mean no size ceiling.
// Past versions of a PDF are not previewable (`canPreviewHistory` excludes it).

import { el } from "../ui/dom";
import type { Id, NoteMeta, NoteSummary, PageRef } from "../core/types";
import { formatBytes, rawFileUrl } from "../core/fileKind";
import { createToolbar } from "./toolbar";
import { svg, VIEWER_IC } from "./viewerIcons";
import { createPager, createZoomStepper, FIT_PAGE } from "./viewerControls";
import { createViewerExportMenu } from "./viewerExportMenu";
import {
  backWord,
  createViewerHeader,
  originSubtitle,
  createViewerBody,
  createVersionBanner,
} from "./viewerChrome";
import type { ReaderOrigin, VersionSubject, Viewer, ViewerDeps } from "./viewer";
import { createPdfOutlinePanel } from "./pdfOutlinePanel";
import { createPdfThumbStrip } from "./pdfThumbStrip";
import { createPdfPageRenderer, PDF_LAYER_ID, ZOOMS, type Zoom } from "./pdfPageRenderer";
import { createLinkLayer } from "./linkLayer";
import { createPdfHighlightLayer } from "./pdfHighlightLayer";
import { createPdfSelectionLayer } from "./pdfSelectionLayer";
import {
  createPdfFindController,
  pdfCountIsNone,
  pdfCountText,
  type PdfFindController,
} from "./pdfFind";
import { createBinViewerActions } from "../ui/binViewerActions";
import { createLayersPanel } from "./layersPanel";
import { contextualOpener, createCopyControl, createPdfDocks, createPdfFindBarView } from "./pdfChrome";
import { buildNoteLayerThumb, createNoteLayersController } from "./noteLayers";
import { createPdfExports } from "./pdfExports";
import { createPdfViewerExports } from "./pdfViewerExports";
import { supportsWasmExceptions } from "../render/pdfLoader";
import type { PdfWord } from "../render/pdfWire";
import { PdfLoadError, createPdfSession, type PdfSession } from "../render/pdfClient";

/** The versions control offers the ink's history, never a past PDF. */
const ANNOTATIONS_HISTORY = "Annotation history";
const ANNOTATIONS_NO_INK = "this document has no annotations";


/** The browser seams, injectable so the viewer is testable without a worker. */
export interface PdfSeam {
  createSession(): PdfSession;
  /** False shows a "this browser can't" state. */
  supported(): boolean;
}

export function defaultPdfSeam(): PdfSeam {
  return { createSession: createPdfSession, supported: supportsWasmExceptions };
}

export function createPdfViewer(deps: ViewerDeps, seam: PdfSeam = defaultPdfSeam()): Viewer {
  // ---- state ----
  /** One session for the viewer's life: MuPDF is ~5 MB of wasm to compile. */
  let session: PdfSession | null = null;
  let open_ = false;
  let pageIndex = 0;
  let pageCount = 0;
  let zoom: Zoom = FIT_PAGE;
  let fromBin = false;
  /** What the file-zone actions act on; cleared by `release()`. */
  let meta: NoteMeta | null = null;
  /** The paired `.mark` by 0-based PDF page. Sparse: a missing key means no annotations. */
  let markId: Id | null = null;
  const markPages = new Map<number, PageRef>();
  /**
   * The mark id from the metadata, available before `loadMark` sets `markId`, so
   * the versions control does not flicker from dimmed to live.
   */
  let annotationsId: Id | null = null;
  /**
   * The annotation version being previewed, or null. The PDF itself is always
   * live; this drives the banner, Restore, and salts thumbnail cache keys so a
   * preview is never served live ink.
   */
  let previewVersion: { md5: string; createdAt: number } | null = null;
  /** The previewed annotations belong to a trashed document: no Restore. */
  let previewViewOnly = false;
  let docHash = "";
  /**
   * Bumped per open and teardown; async steps check it so a superseded load never
   * renders through a handle `hide()` closed.
   */
  let generation = 0;

  // ---- DOM ----
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
      copyBtn.hidden = !has;
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
    initial: zoom,
    format: (z) => z,
    labels: { out: "Zoom out", in: "Zoom in" },
    onStep: (dir) => {
      const at = ZOOMS.indexOf(zoom);
      const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + dir))]!;
      if (next !== zoom) {
        zoom = next;
        void renderer.paint();
      }
      return zoom;
    },
  });

  const pager = createPager({ readoutClass: "pdf-pager__count", onGo: (index) => void go(index) });

  // ---- download / export menu ----
  const exportMenu = createViewerExportMenu({ toast: deps.toast, className: "viewer__export" });
  const downloads = createPdfExports({
    menu: exportMenu,
    toast: deps.toast,
    docName: () => meta?.name ?? null,
    pageIndex: () => pageIndex,
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
    html: svg(VIEWER_IC.trash, 1.8) + "Move to bin",
  });
  moveBin.addEventListener("click", () => {
    if (meta) deps.onMoveToBin?.(meta);
  });
  const binActions = createBinViewerActions({
    getMeta: () => meta,
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
  const versionsBtn = versionsOpener.el;
  versionsBtn.addEventListener("click", () => {
    const subject = versionSubject();
    if (subject) deps.onVersions?.(subject, versionsBtn, previewVersion?.md5);
  });

  /** The paired `.mark` under the document's name; `annotationsOn` carries the distinction. */
  function versionSubject(): VersionSubject | null {
    if (!meta || annotationsId === null) return null;
    return { id: annotationsId, name: meta.name, fileType: "mark", annotationsOn: meta.id };
  }

  const setVersionsAvailable = versionsOpener.setAvailable;

  /** `annotations` wording: the document is current, Restore changes only the ink. */
  const versionBanner = createVersionBanner({
    kind: "annotations",
    onRestore: () => {
      const subject = versionSubject();
      if (subject && previewVersion) deps.onRestoreVersion?.(subject, previewVersion);
    },
  });

  // ---- annotations panel ----
  // The shared layers panel, with the PDF itself as the bottom row (`PDF_LAYER_ID`).
  const layersPanel = createLayersPanel({
    id: "pdf-layers-panel",
    hookPrefix: "pdf",
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
      session: () => session,
      isOpen: () => open_,
      generation: () => generation,
      docHash: () => docHash,
      markId: () => markId,
      markPages: () => markPages,
      previewVersion: () => previewVersion,
    },
    inkRaster: (bytes, dst) => markCtl.inkRaster(bytes, dst),
    onPick: (i) => void go(i),
  });
  const pagesPanel = thumbs.panel;


  const pagesToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-controls": "pdf-pages-panel",
    "aria-label": "Pages",
    title: "Pages",
    html: svg(VIEWER_IC.pages, 1.8),
  }) as HTMLButtonElement;

  pagesToggle.addEventListener("click", () =>
    setDocks(docks.left() === "pages" ? null : "pages", docks.right(), "left"),
  );

  // ---- outline ----
  const outlinePanel = createPdfOutlinePanel({ onPick: (page) => void go(page) });
  const outlineOpener = contextualOpener({
    icon: VIEWER_IC.outline,
    label: "Outline",
    reason: "this document has none",
    attrs: { "aria-pressed": "false", "aria-controls": "pdf-outline-panel" },
  });
  const outlineToggle = outlineOpener.el;
  outlineToggle.addEventListener("click", () =>
    setDocks(docks.left() === "outline" ? null : "outline", docks.right(), "left"),
  );

  function setOutlineAvailable(has: boolean): void {
    outlineOpener.setAvailable(has);
    // No repaint: callers paint on their own path.
    if (!has && docks.left() === "outline") setDocks(null, docks.right(), null, false);
  }

  const layersToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-controls": "pdf-layers-panel",
    "aria-label": "Annotations",
    title: "Annotations",
    html: svg(VIEWER_IC.layers, 1.8),
  }) as HTMLButtonElement;
  layersToggle.addEventListener("click", () => setDocks(docks.left(), !docks.right(), "right"));

  const docks = createPdfDocks({
    pagesPanel,
    outlinePanel,
    layersPanel,
    pagesToggle,
    outlineToggle,
    layersToggle,
    stageWidth: () => renderer.stageInner().w,
    repaint: () => {
      if (open_) void renderer.paint();
    },
  });
  const setDocks = docks.set;

  const { btn: copyBtn, live: copyLive } = createCopyControl(() => selectLayer.text());


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
  const {
    bar: findBar,
    input: findInput,
    count: findCount,
    ask: findAsk,
    prev: findPrev,
    next: findNext,
    close: findClose,
  } = createPdfFindBarView();


  const toolbar = createToolbar({
    label: "PDF viewer",
    viewLabel: "PDF controls",
    fileLabel: "File actions",
    className: "viewer__bar",
    leading: [{ el: header.back, focus: [header.back] }, { el: header.title }],
    // Pager, zoom, find: the reader's order, so the two paged viewers agree.
    view: [
      { kind: "custom", key: "pager", el: pager.el, focus: pager.focus },
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus },
      { kind: "custom", key: "find", el: findToggle, focus: [findToggle] },
      { kind: "custom", key: "pages", el: pagesToggle, focus: [pagesToggle] },
      { kind: "custom", key: "outline", el: outlineToggle, focus: [outlineToggle] },
      // Shown only when a `.mark` exists.
      { kind: "custom", key: "layers", el: layersToggle, focus: [layersToggle] },
      { kind: "custom", key: "copy", el: copyBtn, focus: [copyBtn] },
      { kind: "custom", key: "copy-live", el: copyLive, focus: [] },
    ],
    file: [
      { kind: "custom", key: "download", el: exportMenu.el, focus: [exportMenu.trigger] },
      { kind: "custom", key: "versions", el: versionsBtn, focus: [versionsBtn] },
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
    findBar,
    main,
  );

  // ---- rendering ----
  const renderer = createPdfPageRenderer({
    deps,
    state: {
      session: () => session,
      isOpen: () => open_,
      generation: () => generation,
      pageIndex: () => pageIndex,
      pageCount: () => pageCount,
      zoom: () => zoom,
      meta: () => meta,
      fromBin: () => fromBin,
      markId: () => markId,
      markPages: () => markPages,
      // Mounted panels only; {@link tooTight} weighs hypothetical ones.
      dockedPanels: () =>
        [
          docks.left() === "pages" ? pagesPanel.el : null,
          docks.left() === "outline" ? outlinePanel.el : null,
          docks.right() ? layersPanel.el : null,
        ].filter((panel): panel is HTMLElement => panel !== null),
    },
    dom: { main, stage, canvas, body, markCtl, linkLayer, selectLayer, layersPanel },
    // Through arrows: `find` is built below and the two reference each other.
    find: {
      repaint: () => find.repaint(),
      wordsKnown: (page) => find.wordsKnown(page),
      wordsFor: (page) => find.wordsFor(page),
    },
    syncPager: () => syncPager(),
    refreshGroups: () => downloads.refreshGroups(),
    onJump: (page) => void go(page),
  });
  // ---- find in this PDF ----

  /** Words are in page points and placed by the same transform as the ink; no size yet clears the layer. */
  function paintFindMarks(words: PdfWord[], current: number): void {
    const size = renderer.pageSizePt();
    if (!size || words.length === 0) {
      findLayer.clear();
      return;
    }
    findLayer.setMarks(words, {
      pagePt: size,
      canvas: renderer.cssCanvasSize(),
      current,
    });
  }

  const find: PdfFindController = createPdfFindController({
    docs: deps.docSearch,
    failures: { onSessionExpired: deps.onSessionExpired },
    // The locator; a page that will not read just has no boxes.
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
        findAsk.hidden = state.kind !== "fuzzyPrompt";
        // The URL follows the query, so a find is shareable.
        syncUrl();
      },
      setPageMarks: paintFindMarks,
      setPageCounts: (counts) => pagesPanel.setBadges(counts),
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
    if (e.key === "Enter") {
      e.preventDefault();
      find.step(e.shiftKey ? -1 : 1);
    }
  });
  findPrev.addEventListener("click", () => find.step(-1));
  findNext.addEventListener("click", () => find.step(1));
  findAsk.addEventListener("click", () => find.searchSimilar());

  // ---- exports ----
  const exportDriver = createPdfViewerExports({
    deps,
    state: {
      session: () => session,
      isOpen: () => open_,
      generation: () => generation,
      pageIndex: () => pageIndex,
      pageCount: () => pageCount,
      meta: () => meta,
      fromBin: () => fromBin,
      markId: () => markId,
      markPages: () => markPages,
    },
    dom: { canvas, markCtl },
  });

  function syncPager(): void {
    pager.set(pageIndex, pageCount);
  }

  /**
   * Publish the page (and query) to the URL. Bin origins use
   * `#/bin/note/:id/page/:n` with no query, since a trashed blob is not served
   * at the live route.
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
    // Tracks the entry the page is inside, not the last one clicked.
    outlinePanel.setCurrent(to);
    // Before `syncUrl` and the raster, so URL and marks are already the new page's.
    find.setPage(to);
    syncUrl();
    await renderer.paint();
  }

  // ---- keyboard (only while on screen) ----
  // Paging matches the reader, including leaving modified arrows alone.
  function onKey(e: KeyboardEvent): void {
    if (root.hidden) return;
    // Ctrl+F before the input guard, so it reaches (or re-focuses) the field from anywhere.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      find.open();
      return;
    }
    // Escape unwinds one thing at a time: selection, find, then the viewer.
    if (e.key === "Escape") {
      if (selectLayer.has()) {
        selectLayer.clear();
        return;
      }
      if (find.isOpen()) {
        find.close();
        findInput.value = "";
        return;
      }
      return deps.onBack();
    }
    // Paging keys do not apply in inputs, including the pager's own field.
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") void go(pageIndex + 1);
    else if (e.key === "ArrowLeft") void go(pageIndex - 1);
    // Home/End are prevented, or they also scroll the stage to its ends.
    else if (e.key === "Home") {
      e.preventDefault();
      void go(0);
    } else if (e.key === "End" && pageCount > 0) {
      e.preventDefault();
      void go(pageCount - 1);
    }
  }
  document.addEventListener("keydown", onKey);

  /**
   * Ctrl+C via the `copy` event, whose `clipboardData` works over plain HTTP
   * where the async clipboard does not. Yields to a real DOM selection (e.g. in
   * the find field).
   */
  function onCopy(e: ClipboardEvent): void {
    if (root.hidden || !open_) return;
    if (!selectLayer.has()) return;
    if ((globalThis.getSelection?.()?.toString() ?? "") !== "") return;
    const text = selectLayer.text();
    if (text === "") return;
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  }
  document.addEventListener("copy", onCopy);

  /**
   * The strip's ink rail, from the mark. No mark page means `false` (known); a
   * mark page without `hasInk` is left out, which blanks the rail (the strip's
   * all-or-nothing rule). No mark at all gives an empty map.
   */
  function refreshInk(): void {
    const inked = new Map<number, boolean>();
    if (markPages.size > 0) {
      for (let p = 0; p < pageCount; p++) {
        const ref = markPages.get(p);
        if (!ref) inked.set(p, false);
        else if (ref.hasInk !== undefined) inked.set(p, ref.hasInk);
      }
    }
    pagesPanel.setInk(inked);
  }

  /**
   * Index the `.mark`'s pages by PDF page (`sourcePage` is 1-based). Pages without
   * one are skipped rather than guessed, or ink lands on the wrong page.
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
    // The whole-document export row learns about ink here, not on visiting the page.
    downloads.refreshGroups();
    if (open_ && markPages.has(pageIndex)) void renderer.paint();
    // And the strip, which was painted before the mark landed.
    thumbs.repaintInked();
    refreshInk();
  }

  // ---- open / teardown ----

  function release(): void {
    generation++; // anything in flight stops before it touches the handle
    if (open_ && session) {
      // Fire and forget; the worker serialises, so a later `open` cannot overtake it.
      void session.close().catch(() => {});
    }
    open_ = false;
    pageCount = 0;
    pageIndex = 0;
    markId = null;
    annotationsId = null;
    markPages.clear();
    // Preview state too: `thumbKey` salts on `previewVersion`.
    previewVersion = null;
    previewViewOnly = false;
    setVersionsAvailable(false);
    versionBanner.setVersion(null);
    // Released, not hidden: only `release` zeroes the full-resolution canvases.
    // A page turn does not come through here, so the stack survives paging.
    markCtl.release();
    markCtl.el.hidden = true;
    linkLayer.clear();
    find.reset();
    findInput.value = "";
    findLayer.clear();
    selectLayer.clear();
    renderer.reset();
    layersToggle.hidden = true;
    // Through `setDocks` so `aria-pressed` stays correct.
    setDocks(docks.left(), false, null, false);
    // The file-zone controls outlive the document, so forget their target.
    meta = null;
    thumbs.reset();
    outlinePanel.clear();
    setOutlineAvailable(false); // …which also shuts the panel and un-presses it
    downloads.refreshGroups();
    exportMenu.setOpen(false);
    // The raw href is per open; left set it would offer the previous file until metadata lands.
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
    /**
     * An annotation preview is the live document with the `.mark` rerouted to a
     * past version; only the ink and the chrome differ.
     */
    previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
    const previewing = previewVersion !== null;
    previewViewOnly = previewing && origin.viewOnly === true;
    // Set before metadata lands so the wrong pair never shows. A preview drops Move to bin.
    moveBin.hidden = fromBin || previewing;
    binActions.setBinMode(fromBin, fromBin ? (origin.retention ?? null) : null);
    // Up from the first frame, since it qualifies the page.
    versionBanner.setVersion(previewVersion, previewViewOnly);
    // Dimmed until metadata says there is a mark.
    setVersionsAvailable(false);
    header.setName(summary.name);
    header.setBackWord(backWord(origin));
    // The subtitle fills in: folder path, then size, then page count.
    header.setSubtitle(originSubtitle(origin, summary.fileType?.toUpperCase() || "PDF"));
    zoom = FIT_PAGE;
    // The stepper keeps its own label, so reset the readout too.
    zoomStepper.set(FIT_PAGE);
    pageIndex = Math.max(0, page);
    body.showPlaceholder(summary.name, "Opening this PDF…");
    syncPager();

    if (!seam.supported()) {
      // MuPDF's error handling needs wasm exception handling.
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
    // The `.mark` loads without blocking; `loadMark` repaints when it lands.
    annotationsId = m.annotationsId;
    // "Has handwriting" comes from the pairing; "can paint it" is `loadMark`'s question.
    setVersionsAvailable(annotationsId !== null);
    if (m.annotationsId) void loadMark(m.annotationsId, mine);
    if (m.size > 0) header.setSubtitle(originSubtitle(origin, formatBytes(m.size)));
    const url = rawFileUrl(m.id, m.fileHash, { download: false, bin: fromBin });
    // Decided off the URL, never a read-back `href` (an empty one resolves to the
    // app). `null` disables only the raw row.
    downloads.setRawHref(rawFileUrl(m.id, m.fileHash, { download: true, bin: fromBin }));

    if (!url) {
      body.showPlaceholder(summary.name, "This file has no readable address.");
      return;
    }

    // No size gate: with range-served blocks page 1 costs only its own blocks.
    session ??= seam.createSession();
    const s = session;
    let pages: number;
    try {
      ({ pageCount: pages } = await s.open(url, m.size));
      open_ = true;
    } catch (err) {
      if (mine !== generation) return;
      if (err instanceof PdfLoadError && (err.status === 401 || err.status === 403)) {
        deps.onSessionExpired();
        return;
      }
      // MuPDF's message goes to the console. It cannot tell "encrypted" from "not
      // a PDF" (the shim never calls `fz_needs_password`), so the only distinction
      // shown is bytes not arriving versus not opening.
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
    header.setSubtitle(
      originSubtitle(origin, `${pageCount} ${pageCount === 1 ? "page" : "pages"}`),
    );
    if (pageCount === 0) {
      body.showPlaceholder(summary.name, "This PDF has no pages.");
      release();
      return;
    }
    pageIndex = Math.min(pageIndex, pageCount - 1);
    // Prime find from a `?q=` deep link, after the clamp. Bin URLs carry no query.
    find.setDocument(m.id, m.fileHash);
    find.setPage(pageIndex);
    if (query !== "") {
      findInput.value = query;
      find.open();
      find.setQuery(query);
    }
    // Only now is the page count known, so the URL can reflect the clamped page.
    syncUrl();

    // Reserve every row's shape from this page's aspect; other sizes self-correct.
    try {
      const first = await s.pageSize(pageIndex);
      if (mine !== generation) return;
      if (first.height > 0) thumbs.setFirstAspect(first.width / first.height);
    } catch {
      // Keep the default aspect.
    }
    // The outline, once per document and not awaited; failure only dims the opener.
    void s
      .outline()
      .then((entries) => {
        if (mine !== generation) return;
        outlinePanel.setEntries(entries);
        outlinePanel.setCurrent(pageIndex);
        setOutlineAvailable(entries.length > 0);
      })
      .catch(() => {
        if (mine !== generation) return;
        setOutlineAvailable(false);
      });
    pagesPanel.setPages(pageCount);
    // The mark may have landed already, so compute the rail here as well as in `loadMark`.
    refreshInk();
    pagesPanel.setCurrent(pageIndex);
    // First moment the export menu knows `pageCount`.
    downloads.refreshGroups();

    await renderer.paint();
    // Logs first-page cost; see `lastPdfStats`.
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
      // For a viewer destroyed without ever opening.
      find.reset();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", onCopy);
      selectLayer.destroy();
      exportMenu.destroy(); // its outside-click + Escape listeners are on `document`
      thumbs.destroy();
      session?.destroy();
      session = null;
      root.remove();
    },
  };
}
