// The .note reader: a full-bleed overlay with a page index on the left and the
// current page in the main viewer. Also the default viewer for images and for
// files with no preview.

import { el } from "../ui/dom";
import type { Api } from "../api/types";
import type { NoteRenderer } from "../render/types";
import type { RenderCache } from "../cache/types";
import type { DocSearch } from "../search/docSearch";
import type { Hash, Id, NoteMeta, NoteSummary, PageRef, Theme } from "../core/types";
import { createTemplateProvider } from "../render/template";
import { type ApiFailureSink } from "../api/client";
import { rawFileUrl } from "../core/fileKind";
import { type OcrState } from "./ocrPanel";
import { createToolbar } from "./toolbar";
import { createFileStage, type FileStage } from "./fileStage";
import { createFindBarView, createReaderButtons, createVersionBanner } from "./readerBars";
import { svg, VIEWER_IC } from "./viewerIcons";
import { createPager, createZoomStepper, FIT_PAGE, FIT_WIDTH } from "./viewerControls";
import { createViewerExportMenu } from "./viewerExportMenu";
import { originSubtitle, createViewerHeader } from "./viewerChrome";
import { createBinViewerActions, type BinRetention } from "../ui/binViewerActions";
import { createLayersPanel } from "./layersPanel";
import { createSidePanel } from "../ui/sidePanel";
import { createPageIndex } from "./pageIndex";
import { createLinkLayer } from "./linkLayer";
import type { PdfLink } from "../core/types";
import { buildNoteLayerThumb, createNoteLayersController } from "./noteLayers";
import type { ReaderState } from "./readerState";
import { createReaderOverlays } from "./readerOverlays";
import { createReaderNav } from "./readerNav";
import { createReaderPanels } from "./readerPanels";
import { createReaderPaint } from "./readerPaint";
import { createReaderLifecycle } from "./readerLifecycle";
import { createReaderFeatures } from "./readerFeatures";

export interface ReaderDeps {
  api: Api;
  /** Shared with the `.txt`/`.pdf` viewers so a session holds one wasm FTS5
   *  instance and one built index. */
  docSearch: DocSearch;
  renderer: NoteRenderer;
  cache: RenderCache;
  getTheme: () => Theme;
  /** Navigate back to the library (the reader never mutates the hash itself). */
  onBack: () => void;
  toast: (message: string) => void;
  /** A 401/403 mid-read. STALE_PAGE the reader handles itself. */
  onSessionExpired: () => void;
  /** Trash the open note; the shell owns the trash path, undo toast and navigation. */
  onMoveToBin?: (meta: NoteMeta) => void;
  /** Bin-origin actions, shown instead of Move to bin; routed through the bin controller. */
  onRestore?: (meta: NoteMeta) => void;
  onPurge?: (meta: NoteMeta) => void;
  /** Restore the previewed version; the shell owns confirm, quota errors and refresh. */
  onRestoreVersion?: (meta: NoteMeta, version: { md5: string; createdAt: number }) => void;
  /** Open version history anchored to `anchor`; `viewingMd5` marks the previewed row. */
  onVersions?: (meta: NoteMeta, anchor: HTMLElement, viewingMd5?: string) => void;
  /**
   * The page or find query changed; the shell rewrites the URL with
   * `replaceState`. `versionMd5` (history preview) and `bin` (opened from the
   * bin) are mutually exclusive and select those route forms.
   */
  onPosition?: (noteId: Id, page: number, query: string, versionMd5?: string, bin?: boolean) => void;
}

/**
 * Where the reader was opened from. `kind` sets Back's word and whether the
 * subtitle names the folder (`search`/`bin` do; for `folder`, Back already
 * says it). `folderPath` is null when unknown and is then rendered as absent.
 */
export interface ReaderOrigin {
  kind: "folder" | "search" | "bin" | "history";
  /** Human path of the note's folder (`Note / Projects`), or null if unknown. */
  folderPath: string | null;
  /** History origin only: the previewed version (`createdAt` in epoch ms). */
  version?: { md5: string; createdAt: number };
  /** Bin origin only: the trashed file's countdown; null when unresolved. */
  retention?: BinRetention | null;
  /** History preview of a trashed file: view-only (no per-version restore),
   *  bytes via the bin-scoped history route. */
  viewOnly?: boolean;
}

/** The default when nothing better is known: Back goes to the whole library. */
export const LIBRARY_ORIGIN: ReaderOrigin = { kind: "folder", folderPath: null };

export interface Reader {
  /** The `.reader` section, mounted once inside the library's content area. */
  el: HTMLElement;
  /**
   * Show a file at `startPage` (0-based, clamped). Only a `.note` gets the page
   * pipeline; an image is an `<img>` and anything else a "no preview" state,
   * because the backend fabricates a placeholder page for blobs it cannot parse.
   * `query` primes find through `find.setQuery`, the same path as typing.
   */
  open(summary: NoteSummary, metaPromise: Promise<NoteMeta>, startPage?: number, origin?: ReaderOrigin, query?: string): Promise<void> | void;
  close(): void;
  /** Same as {@link close}; the name the {@link Viewer} contract uses. */
  hide(): void;
  isOpen(): boolean;
  /** Repaint for a new theme: filmstrip visible-only + the current viewer page. */
  bumpTheme(): void;
  destroy(): void;
}

const ZOOMS = [FIT_PAGE, "100%", "150%"] as const;

/**
 * Images get their own ladder: `Fit ⇕` on a large photo can be 20%, so steps
 * below it are needed, and reading a screenshot needs more than 150%.
 */
const IMAGE_ZOOMS = ["25%", "50%", FIT_PAGE, FIT_WIDTH, "100%", "200%", "400%"] as const;
export type Zoom = (typeof ZOOMS)[number] | (typeof IMAGE_ZOOMS)[number];
/**
 * Note-page factors, tuned to the 640px height heuristic in `showPage`; images
 * treat the label as a real percentage and must not use them.
 */
export const ZOOM_SCALE: Record<(typeof ZOOMS)[number], number> = {
  [FIT_PAGE]: 1,
  "100%": 1.18,
  "150%": 1.68,
};
export const DPR_CAP = 2;

/** Local alias for the shared {@link originSubtitle}. */
export const subtitle = originSubtitle;

export function createReader(deps: ReaderDeps): Reader {
  const { api, renderer, cache, getTheme } = deps;

  // --- DOM -----------------------------------------------------------------
  // Keeps the reader's legacy class names (`.backbtn`, `.reader__title`).
  const header = createViewerHeader({
    classes: { back: "backbtn", backLabel: "backbtn__label", title: "reader__title" },
    onBack: () => deps.onBack(),
  });
  const back = header.back;
  const pageCanvas = el("canvas");
  // Per-layer canvas stack, shown instead of the composite when the page has
  // layers and all decode; any failure falls back to the composite.
  const noteLayerCtl = createNoteLayersController({ getTemplate: createTemplateProvider(api) });
  // Mounted last so links stack above both the composite and the layer stack.
  const linkLayer = createLinkLayer();
  const pageEl = el("div", { class: "page" }, pageCanvas, noteLayerCtl.el, linkLayer.el);

  // Beside the page in `.page-wrap`, so opening it narrows the page.
  const ocrPanel = createSidePanel({
    ariaLabel: "Recognized text",
    icon: svg(VIEWER_IC.text, 1.7),
    label: "Recognized text",
    hookPrefix: "ocr",
  });
  const ocrBody = ocrPanel.body;
  // No `onOpacity`: `.note` layers carry no opacity (device-confirmed).
  const layersPanel = createLayersPanel({
    id: "note-layers-panel",
    hookPrefix: "note",
    onToggle: (id, visible) => {
      noteLayerCtl.setVisible(id, visible);
      // A toggle may enable the Original-view export group.
      downloads.refreshGroups();
    },
    paintThumb: (pl) => {
      const v = noteLayerCtl.stack()?.views.find((x) => x.index === pl.id);
      if (!v) return el("div", { "aria-hidden": "true" });
      return buildNoteLayerThumb(v);
    },
  });
  // The shared page index, docked left and open by default.
  const pageIndexPanel = createPageIndex({
    id: "note-pages-panel",
    // The ruled-paper placeholder is note-specific, hence its own hook.
    stripHook: "note-filmstrip",
    onPick: (index) => goToPage(index),
    // Skeleton pages (empty hash) have nothing to render yet.
    loading: (index) => st.meta?.pages[index]?.hash === "",
    aspect: (index) => {
      const page = st.meta?.pages[index];
      if (!page?.width || !page.height) return null;
      // Clamped so a wide page cannot exceed the fixed-height row's column.
      return Math.min(page.width / page.height, 2.5);
    },
    // The lazy engine decides when to paint within the strip's window.
    mount: (row) => {
      const page = st.meta?.pages[row.index];
      if (st.meta && page && page.hash !== "") {
        filmEngine.add({ target: row.canvas, noteId: st.meta.id, page, size: "thumb" });
      }
    },
    unmount: (row) => filmEngine.remove(row.canvas),
  });

  // Page index docks left; OCR and Layers dock right.
  const pageWrap = el("div", { class: "page-wrap" }, pageIndexPanel.el, pageEl, ocrPanel.el, layersPanel.el);
  const stage = el(
    "div",
    { class: "stage" },
    pageWrap,
  );

  // --- the non-`.note` stage ------------------------------------------------
  // Shown instead of the canvas stage: an `<img>` or the no-preview block.
  const files: FileStage = createFileStage({
    isCurrent: (id) => st.meta?.id === id,
    onSized: () => sizeImage(),
  });
  const fileImg = files.img;
  const fileStage = files.el;

  const pager = createPager({ readoutClass: "pager__count", onGo: (index) => goToPage(index) });
  // Walks the caller's ladder (note or image) and re-sizes the affected surface.
  const zoomStepper = createZoomStepper({
    readoutClass: "zoom",
    initial: FIT_PAGE as Zoom,
    format: (z: Zoom) => z,
    onStep: (dir) => {
      // Unknown values fall back to `Fit ⇕`, a rung both ladders carry.
      const ladder: readonly Zoom[] = st.mode === "image" ? IMAGE_ZOOMS : ZOOMS;
      const at = ladder.indexOf(st.zoom);
      const from = at < 0 ? Math.max(0, ladder.indexOf(FIT_PAGE)) : at;
      const i = Math.max(0, Math.min(ladder.length - 1, from + dir));
      st.zoom = ladder[i]!;
      if (st.mode === "image") sizeImage();
      else void showPage(st.pageIndex);
      return st.zoom;
    },
  });
  const zoomEl = zoomStepper.el;
  // Icon-only by the user's explicit call, overriding the toolbar's icon+label
  // default for consequential actions; don't add the label back.
  const exportMenu = createViewerExportMenu({ toast: deps.toast, haspopup: "true" });
  const { ocrToggle, layersToggle, pagesToggle, moveBin, versionsBtn, downloadLink } = createReaderButtons();
  // Bin-origin cluster (retention countdown + menu), swapped in for Move to bin.
  const binActions = createBinViewerActions({
    getMeta: () => st.meta,
    onRestore: deps.onRestore,
    onPurge: deps.onPurge,
    // Only wired when the shell can open history, so there is no dead row.
    onHistory: deps.onVersions ? (m, anchor) => deps.onVersions!(m, anchor, undefined) : undefined,
  });

  const { el: versionBanner, text: versionBannerText, restore: restoreVersionBtn } = createVersionBanner();
  const {
    el: findBar,
    toggle: findToggle,
    input: findInput,
    count: findCount,
    note: findNote,
    fuzzy: findFuzzy,
    ask: findAsk,
    prev: findPrev,
    next: findNext,
    close: findClose,
  } = createFindBarView();

  // Hidden in non-note modes. Zoom is not here: images zoom too.
  const noteOnly: HTMLElement[] = [findToggle, ocrToggle, layersToggle, pagesToggle, pager.el, exportMenu.el];

  downloadLink.download = "";

  const title = header.title;

  const toolbar = createToolbar({
    label: "Reader controls",
    // Not "View controls": Playwright's substring name matching would collide
    // with the library topbar's "View" group.
    viewLabel: "Reading controls",
    fileLabel: "File actions",
    className: "reader__bar",
    leading: [{ el: back, focus: [back] }, { el: title }],
    view: [
      { kind: "custom", key: "pager", el: pager.el, focus: pager.focus },
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus },
      { kind: "custom", key: "find", el: findToggle, focus: [findToggle] },
      { kind: "custom", key: "ocr", el: ocrToggle, focus: [ocrToggle] },
      { kind: "custom", key: "layers", el: layersToggle, focus: [layersToggle] },
      { kind: "custom", key: "pages", el: pagesToggle, focus: [pagesToggle] },
    ],
    file: [
      { kind: "custom", key: "versions", el: versionsBtn, focus: [versionsBtn] },
      { kind: "custom", key: "download", el: exportMenu.el, focus: [exportMenu.trigger] },
      { kind: "custom", key: "download-file", el: downloadLink, focus: [downloadLink] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });
  const bar = toolbar.el;

  // The bars span the whole reader, above the page index.
  const root = el(
    "section",
    { class: "reader", "aria-label": "Reader", "aria-hidden": "true" },
    bar,
    versionBanner,
    findBar,
    el("div", { class: "reader__main" }, stage, fileStage),
  );

  const st: ReaderState = {
    meta: null,
    mode: "note",
    metaResolved: false,
    summaryRecognized: false,
    pageIndex: 0,
    zoom: FIT_PAGE,
    open: false,
    paintToken: 0,
    fromBin: false,
    previewVersion: null,
    previewViewOnly: false,
    layersPanelOpen: false,
    layersAvail: "unknown",
    pageIndexOpen: true,
    urlSuspended: false,
    urlTimer: undefined,
  };


  const { readerApi } = createReaderLifecycle(st, {
    currentPage,
    setDownload,
    showNoPreview,
    showImage,
    header: () => header,
    back: () => back,
    noteLayerCtl: () => noteLayerCtl,
    linkLayer: () => linkLayer,
    pageIndexPanel: () => pageIndexPanel,
    files: () => files,
    zoomStepper: () => zoomStepper,
    exportMenu: () => exportMenu,
    moveBin: () => moveBin,
    versionsBtn: () => versionsBtn,
    binActions: () => binActions,
    versionBanner: () => versionBanner,
    versionBannerText: () => versionBannerText,
    restoreVersionBtn: () => restoreVersionBtn,
    findInput: () => findInput,
    root: () => root,
    showPage: () => showPage,
    buildFilmstrip: () => buildFilmstrip,
    setMode: () => setMode,
    refreshFindUi: () => refreshFindUi,
    refreshLayersUi: () => refreshLayersUi,
    findQuery: () => findQuery,
    syncUrl: () => syncUrl,
    onKey: () => onKey,
    failures: () => failures,
    ocr: () => ocr,
    linksByPage: () => linksByPage,
    find: () => find,
    downloads: () => downloads,
    filmEngine: () => filmEngine,
  });

  const { refetchMeta, showPage, buildFilmstrip } = createReaderPaint(st, {
    deps,
    api: () => api,
    renderer: () => renderer,
    cache: () => cache,
    getTheme: () => getTheme,
    pageCanvas: () => pageCanvas,
    noteLayerCtl: () => noteLayerCtl,
    pageEl: () => pageEl,
    pageIndexPanel: () => pageIndexPanel,
    pageWrap: () => pageWrap,
    stage: () => stage,
    pager: () => pager,
    layersPanelShown: () => layersPanelShown,
    refreshLayersUi: () => refreshLayersUi,
    stackIsCurrent: () => stackIsCurrent,
    paintLinks: () => paintLinks,
    staleHandled: () => staleHandled,
    failures: () => failures,
    ocr: () => ocr,
    linksByPage: () => linksByPage,
    find: () => find,
    filmEngine: () => filmEngine,
  });

  const { setMode, refreshFindUi, layersPanelShown, bothSidesTooTight, setPageIndexOpen, relieveDoubleSqueeze, collapseRightPanels, refreshLayersUi, stackIsCurrent } = createReaderPanels(st, {
    showPage,
    getTheme: () => getTheme,
    noteLayerCtl: () => noteLayerCtl,
    linkLayer: () => linkLayer,
    layersPanel: () => layersPanel,
    pageIndexPanel: () => pageIndexPanel,
    stage: () => stage,
    fileStage: () => fileStage,
    zoomEl: () => zoomEl,
    layersToggle: () => layersToggle,
    pagesToggle: () => pagesToggle,
    findToggle: () => findToggle,
    noteOnly: () => noteOnly,
    sizeImage: () => sizeImage,
    ocr: () => ocr,
    downloads: () => downloads,
  });

  const { findQuery, syncUrl, queueUrlSync, goToPage, onKey, sizeImage } = createReaderNav(st, {
    deps,
    showPage,
    fileImg: () => fileImg,
    findInput: () => findInput,
    find: () => find,
  });

  const { countText, countIsNone, paintOvals, paintLinks } = createReaderOverlays(st, {
    goToPage,
    api: () => api,
    linkLayer: () => linkLayer,
    pageEl: () => pageEl,
    failures: () => failures,
    linksByPage: () => linksByPage,
    findNote: () => findNote,
  });

  /** Stale hashes already refetched: one metadata refetch per hash is the loop guard. */
  const staleHandled = new Set<Hash>();

  const failures: ApiFailureSink = {
    onSessionExpired: () => deps.onSessionExpired(),
    onStalePage: (noteId, page) => void refetchMeta(noteId, page),
  };

  // --- recognized text ------------------------------------------------------
  const OCR_MESSAGE: Record<Exclude<OcrState["kind"], "text">, string> = {
    loading: "Loading recognized text…",
    empty: "No recognized text on this page.",
    error: "Couldn't load the recognized text. Change page to try again.",
  };

  // --- find in note ---------------------------------------------------------

  /**
   * Links per page, keyed by index and `linksHash`. Memoised because every
   * relayout re-runs `showPage` and the response is `no-cache`.
   */
  const linksByPage = new Map<string, readonly PdfLink[]>();

  function currentPage(): PageRef | undefined {
    return st.meta?.pages[st.pageIndex];
  }

  // --- the two non-note stages ---------------------------------------------

  /** Point the toolbar's download control at `url` (hidden when there is none). */
  function setDownload(url: string | null): void {
    downloadLink.hidden = url === null;
    if (url !== null) downloadLink.href = url;
  }

  function showNoPreview(m: NoteMeta, title: string, body: string): void {
    files.showNoPreview(m, title, body, rawFileUrl(m.id, m.fileHash, { download: true, bin: st.fromBin }));
  }

  function showImage(m: NoteMeta, url: string): void {
    files.showImage(m, url, () =>
      showNoPreview(m, m.name, "Couldn't load a preview of this image. You can still download it."),
    );
  }

  // --- the page-index panel (docked LEFT, open by default) ------------------

  // --- the layers panel + stack (see pages/noteLayers.ts) -------------------

  ocrToggle.addEventListener("click", () => {
    ocr.toggle();
    // Never squeeze the page from both sides.
    if (ocr.isOpen()) relieveDoubleSqueeze();
  });
  const { ocr, find, downloads, filmEngine } = createReaderFeatures(st, {
    deps,
    currentPage,
    api: () => api,
    renderer: () => renderer,
    cache: () => cache,
    getTheme: () => getTheme,
    noteLayerCtl: () => noteLayerCtl,
    ocrPanel: () => ocrPanel,
    ocrBody: () => ocrBody,
    pageIndexPanel: () => pageIndexPanel,
    exportMenu: () => exportMenu,
    ocrToggle: () => ocrToggle,
    findToggle: () => findToggle,
    findInput: () => findInput,
    findCount: () => findCount,
    findNote: () => findNote,
    findFuzzy: () => findFuzzy,
    findAsk: () => findAsk,
    findPrev: () => findPrev,
    findNext: () => findNext,
    root: () => root,
    showPage: () => showPage,
    stackIsCurrent: () => stackIsCurrent,
    goToPage: () => goToPage,
    countText: () => countText,
    countIsNone: () => countIsNone,
    paintOvals: () => paintOvals,
    failures: () => failures,
    OCR_MESSAGE: () => OCR_MESSAGE,
  });
  layersToggle.addEventListener("click", () => {
    st.layersPanelOpen = !st.layersPanelOpen;
    refreshLayersUi();
    if (st.layersPanelOpen) relieveDoubleSqueeze();
    // The panel takes stage width; the stack is already up, so this is a CSS resize.
    void showPage(st.pageIndex);
  });
  pagesToggle.addEventListener("click", () => {
    if (!st.pageIndexOpen && bothSidesTooTight()) collapseRightPanels();
    setPageIndexOpen(!st.pageIndexOpen);
  });
  moveBin.addEventListener("click", () => {
    if (st.meta) deps.onMoveToBin?.(st.meta);
  });
  versionsBtn.addEventListener("click", () => {
    if (st.meta) deps.onVersions?.(st.meta, versionsBtn, st.previewVersion?.md5);
  });
  restoreVersionBtn.addEventListener("click", () => {
    if (st.meta && st.previewVersion) deps.onRestoreVersion?.(st.meta, st.previewVersion);
  });
  findToggle.addEventListener("click", () => {
    find.toggle();
    syncUrl();
  });
  findClose.addEventListener("click", () => {
    find.close();
    syncUrl();
  });
  findInput.addEventListener("input", () => {
    find.setQuery(findInput.value);
    queueUrlSync();
  });
  findPrev.addEventListener("click", () => find.step(-1));
  findNext.addEventListener("click", () => find.step(1));
  findAsk.addEventListener("click", () => find.searchSimilar());
  // Explicit Enter handling, not a <form>: a form submit reloads a hash-routed SPA.
  findInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    find.step(e.shiftKey ? -1 : 1);
  });

  return readerApi;
}
