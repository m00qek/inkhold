// The .note reader: a full-bleed overlay with a page index on the left and the
// current page in the main viewer. Also the default viewer for images and for
// files with no preview.

import { el } from "../ui/dom";
import type { Api } from "../api/types";
import type { NoteRenderer } from "../render/types";
import type { RenderCache } from "../cache/types";
import type { DocSearch } from "../search/docSearch";
import type { Hash, Id, NoteMeta, NoteSummary, PageRef, Theme, WordBox } from "../core/types";
import { createLazyEngine, defaultPlaceholder, renderPage, type LazyEngine } from "../render/lazy";
import { createTemplateProvider } from "../render/template";
import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import { fileKind, formatBytes, rawFileUrl, historyFileUrl, type FileKind } from "../core/fileKind";
import { createOcrController, type OcrState } from "./ocrPanel";
import { createFindController, type FindState } from "./findInNote";
import { createReaderExports } from "./readerExports";
import { OVAL_VIEWBOX, ovalsFor } from "./findOvals";
import { createToolbar } from "./toolbar";
import { createFileStage, type FileStage } from "./fileStage";
import { createFindBarView, createVersionBanner } from "./readerBars";
import { svg, VIEWER_IC } from "./viewerIcons";
import { createPager, createZoomStepper, FIT_PAGE, FIT_WIDTH } from "./viewerControls";
import { createViewerExportMenu } from "./viewerExportMenu";
import {
  VIEWER_DEBOUNCE_MS,
  backWord,
  originSubtitle,
  createViewerHeader,
} from "./viewerChrome";
import { createBinViewerActions, type BinRetention } from "../ui/binViewerActions";
import { relativeTime, absoluteTime } from "../ui/relativeTime";
import { createLayersPanel } from "./layersPanel";
import { createSidePanel, sidePanelState, tokenPx, MIN_PAGE_W } from "../ui/sidePanel";
import { createPageIndex } from "./pageIndex";
import { createLinkLayer } from "./linkLayer";
import type { PdfLink } from "../core/types";
import { binNotePageHref, notePageHref } from "../router";
import { DEFAULT_PAGE_DIMS, skeletonPage } from "../core/noteSkeleton";
import {
  buildNoteLayerThumb,
  createNoteLayersController,
  toPanelLayers,
} from "./noteLayers";
import type { PageLayer } from "../core/types";
import type { ReaderState } from "./readerState";

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
const LIBRARY_ORIGIN: ReaderOrigin = { kind: "folder", folderPath: null };

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
const ZOOM_SCALE: Record<(typeof ZOOMS)[number], number> = {
  [FIT_PAGE]: 1,
  "100%": 1.18,
  "150%": 1.68,
};
const DPR_CAP = 2;

/** Local alias for the shared {@link originSubtitle}. */
const subtitle = originSubtitle;

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
  // Icon-only too, same call as Download.
  const ocrToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Recognized text",
    title: "Recognized text",
    html: svg(VIEWER_IC.text, 1.7),
  });
  // Enabled only while the focused page has layers (per-page in a `.note`).
  const layersToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-expanded": "false",
    "aria-controls": "note-layers-panel",
    "aria-label": "Layers",
    title: "Layers",
    html: svg(VIEWER_IC.layers, 1.7),
  }) as HTMLButtonElement;
  // Pressed by default: the page index opens with the note.
  const pagesToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "true",
    "aria-expanded": "true",
    "aria-controls": "note-pages-panel",
    "aria-label": "Pages",
    title: "Pages",
    html: svg(VIEWER_IC.pages, 1.7),
  }) as HTMLButtonElement;
  // Neutral, not red (trash is recoverable; red is for purge), and labelled
  // because a bare trash glyph reads as danger.
  const moveBin = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Move to bin",
    title: "Move to bin",
    html: svg(VIEWER_IC.trash, 1.8) + "Move to bin",
  });
  // Shown for a `.note` and in any history preview; see `open()`.
  const versionsBtn = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Version history",
    title: "Version history",
    html: svg(VIEWER_IC.restore, 1.7),
  });
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

  // Non-note modes only. The server sends `Content-Disposition: attachment` for
  // this URL regardless of type.
  const downloadLink = el("a", {
    class: "btn",
    hidden: true,
    "aria-label": "Download",
    title: "Download",
    html: svg(VIEWER_IC.down, 1.8),
  }) as HTMLAnchorElement;
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

  /** Stale hashes already refetched: one metadata refetch per hash is the loop guard. */
  const staleHandled = new Set<Hash>();


  /** What the URL should say the search is: nothing at all while the bar is shut. */
  function urlQuery(): string {
    return find.isOpen() ? findInput.value.trim() : "";
  }

  /** Trimmed as {@link urlQuery} trims, so priming doesn't rewrite the URL. */
  function findQuery(raw: string): string {
    return raw.trim();
  }

  function syncUrl(): void {
    if (st.urlTimer !== undefined) {
      clearTimeout(st.urlTimer);
      st.urlTimer = undefined;
    }
    if (!st.open || st.urlSuspended || !st.meta) return;
    // Bin opens use the bin route (the live one 404s); history previews carry the md5.
    if (st.mode === "note") {
      if (st.fromBin) {
        deps.onPosition?.(st.meta.id, st.pageIndex, "", undefined, true);
        return;
      }
      deps.onPosition?.(st.meta.id, st.pageIndex, urlQuery(), st.previewVersion?.md5);
      return;
    }
    // An image publishes only for bin or history opens.
    if (st.mode === "image") {
      if (st.fromBin) {
        deps.onPosition?.(st.meta.id, 0, "", undefined, true);
        return;
      }
      if (st.previewVersion) deps.onPosition?.(st.meta.id, 0, "", st.previewVersion.md5);
    }
  }

  /** Debounced, for the find field: the URL settles on the word, not each prefix. */
  function queueUrlSync(): void {
    if (st.urlTimer !== undefined) clearTimeout(st.urlTimer);
    st.urlTimer = setTimeout(() => {
      st.urlTimer = undefined;
      syncUrl();
    }, VIEWER_DEBOUNCE_MS);
  }

  /** A `?v=` 404'd (STALE_PAGE): refetch the metadata and rebuild. */
  async function refetchMeta(noteId: Id, page: PageRef): Promise<void> {
    if (staleHandled.has(page.hash)) return;
    staleHandled.add(page.hash);
    let fresh: NoteMeta;
    try {
      fresh = await api.getNoteMeta(noteId);
    } catch (e) {
      dispatchApiFailure({ onSessionExpired: deps.onSessionExpired }, e);
      return;
    }
    if (!st.open || st.meta?.id !== noteId) return; // closed / moved on while fetching
    st.meta = fresh;
    // `setNote` drops the cached word boxes; the links memo would only hold dead entries.
    linksByPage.clear();
    find.setNote(fresh.id, fresh.fileHash, fresh.pages);
    buildFilmstrip();
    void showPage(st.pageIndex);
  }

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

  const ocr = createOcrController({
    api,
    failures,
    view: {
      setOpen(isOpen) {
        ocrPanel.setOpen(isOpen);
        ocrToggle.setAttribute("aria-pressed", String(isOpen));
      },
      setToggleEnabled(enabled) {
        ocrToggle.disabled = !enabled;
        ocrToggle.title = enabled ? "Recognized text" : "This page has no recognized text";
      },
      setState(state) {
        if (state.kind === "text") {
          // textContent: device content, never markup; `pre-wrap` keeps line breaks.
          ocrBody.textContent = state.text;
          return;
        }
        ocrBody.replaceChildren(sidePanelState(state.kind, OCR_MESSAGE[state.kind]));
      },
      // The panel changes the stage width, so the page is re-measured.
      relayout: () => void showPage(st.pageIndex),
    },
  });

  // --- find in note ---------------------------------------------------------

  /**
   * `unrecognised` must not say "No matches" (no search happened over ink the
   * device never recognised), and `counting` shows no total until it is final.
   */
  function countText(state: FindState): string {
    switch (state.kind) {
      case "idle":
        return "";
      case "unrecognised":
        return "Not recognised on the device";
      case "counting": {
        const n = state.recognisedPages;
        const here = state.onThisPage > 0 ? `${state.onThisPage} on this page · ` : "";
        // null: the page list is still the skeleton, so the count is unknown.
        if (n === null) return `${here}searching…`;
        return `${here}searching ${n} ${n === 1 ? "page" : "pages"}…`;
      }
      case "settled":
        return `${state.at + 1} of ${state.total}`;
      case "fuzzyPrompt":
        return "No matches";
      case "empty":
        return "No matches";
      case "error":
        return "Couldn't search this note. Keep typing to retry.";
    }
  }

  /** The dimmer treatment: every state that is not a live count of matches. */
  function countIsNone(state: FindState): boolean {
    return state.kind !== "settled" && state.kind !== "idle";
  }

  /**
   * Ovals are per-page only: their rects need `getPageText`, one request per
   * page against a server serialised on `db_lock`. Counts and badges are
   * note-wide. Always rebuilt, since positions belong to the page's size.
   */
  function paintOvals(words: WordBox[], current: number): void {
    for (const old of Array.from(pageEl.querySelectorAll(".findbox"))) old.remove();
    const m = st.meta;
    if (!m) return;
    const page = m.pages[st.pageIndex];
    if (!page) return;

    const ovals = ovalsFor(words, m.pxPerMm, page.width, pageEl.clientWidth, pageEl.clientHeight);
    // Null = unverified or mismatched mm scale: draw nothing and explain instead.
    findNote.hidden = ovals !== null;
    if (ovals === null) return;

    for (const [i, oval] of ovals.entries()) {
      const box = el("div", {
        class: i === current ? "findbox is-current" : "findbox",
        html: `<svg viewBox="${OVAL_VIEWBOX}" preserveAspectRatio="none" aria-hidden="true"><path d="${oval.path}"/></svg>`,
      });
      box.style.left = `${oval.left}px`;
      box.style.top = `${oval.top}px`;
      box.style.width = `${oval.width}px`;
      box.style.height = `${oval.height}px`;
      box.style.transform = `rotate(${oval.rotateDeg}deg)`;
      pageEl.append(box);
    }
  }

  /**
   * Links per page, keyed by index and `linksHash`. Memoised because every
   * relayout re-runs `showPage` and the response is `no-cache`.
   */
  const linksByPage = new Map<string, readonly PdfLink[]>();

  /**
   * Overlay the page's links. `EXTERNALLINKINFO` rects are in device panel
   * pixels and a `.note` page is the panel, so its native dims are `pagePt` with
   * no letterbox mapping. Old links are cleared before any await; a fetch
   * failure just leaves the page without links.
   */
  async function paintLinks(index: number, token: number): Promise<void> {
    linkLayer.clear();
    const m = st.meta;
    if (!m || st.mode !== "note") return;
    const page = m.pages[index];
    if (!page) return;
    // Only notes built on an imported PDF template have a link block.
    if (page.linksHash === null) return;

    const key = `${page.index}:${page.linksHash}`;
    let links = linksByPage.get(key);
    if (links === undefined) {
      try {
        links = (await api.getPageLinks(m.id, page)).links;
      } catch (e) {
        dispatchApiFailure(failures, e, m.id, page);
        return;
      }
      linksByPage.set(key, links);
    }
    // The page turned (or the note closed) while we were fetching.
    if (token !== st.paintToken || st.pageIndex !== index || !st.open) return;
    if (links.length === 0) return;

    linkLayer.setLinks(links, {
      // Panel pixels over the page box's CSS pixels: the ink's own scale.
      pagePt: { width: page.width, height: page.height },
      canvas: { width: pageEl.clientWidth, height: pageEl.clientHeight },
      // Real routes so links are shareable; bin opens keep the bin form.
      hrefForPage: (target) => (st.fromBin ? binNotePageHref(m.id, target) : notePageHref(m.id, target)),
      // A page turn, not a reopen.
      onJump: (target) => goToPage(target),
    });
  }

  const find = createFindController({
    api,
    docs: deps.docSearch,
    failures,
    view: {
      setOpen(isOpen) {
        root.classList.toggle("is-finding", isOpen);
        findToggle.setAttribute("aria-pressed", String(isOpen));
      },
      setState(state) {
        findCount.textContent = countText(state);
        findCount.classList.toggle("is-none", countIsNone(state));
        // Only a settled result can be approximate.
        findFuzzy.hidden = !(state.kind === "settled" && state.fuzzy);
        findAsk.hidden = state.kind !== "fuzzyPrompt";
        if (state.kind === "idle" || state.kind === "unrecognised") findNote.hidden = true;
      },
      setPageMatches: paintOvals,
      // The strip holds the counts, so they survive its rebuilds.
      setPageCounts: (counts) => pageIndexPanel.setBadges(counts),
      showPage: (index) => goToPage(index),
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

  // --- the Export menu ------------------------------------------------------
  // Reads page and stack through getters; both change on every page turn.
  const downloads = createReaderExports({
    api,
    renderer,
    menu: exportMenu,
    toast: deps.toast,
    meta: () => st.meta,
    currentPage,
    layers: noteLayerCtl,
    // Only the focused page's stack (the previous one survives until the new one commits).
    liveStack: () => (st.mode === "note" && stackIsCurrent() ? noteLayerCtl.stack() : null),
  });

  const filmEngine: LazyEngine = createLazyEngine({
    api,
    renderer,
    cache,
    getTheme,
    // The panel is the scroll container, so it must be the observer root.
    root: pageIndexPanel.el,
    failures,
  });

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

  /** Enter (or leave) a non-note mode: swap stages and prune the toolbar. */
  function setMode(next: FileKind): void {
    st.mode = next;
    const isNote = next === "note";
    stage.hidden = !isNote;
    fileStage.hidden = isNote;
    // A link layer over a non-note would describe the wrong document.
    if (!isNote) linkLayer.clear();
    refreshPageIndexUi();
    for (const control of noteOnly) control.hidden = !isNote;
    // A no-preview file has nothing to scale.
    zoomEl.hidden = !(isNote || next === "image");
    if (next === "image") sizeImage();

    if (!isNote) noteLayerCtl.release();
    refreshLayersUi();

    refreshFindUi();
  }

  /**
   * Find needs device recognition (`textHash !== null`). Until the meta
   * resolves use the listing's whole-note flag: the skeleton invents
   * `textHash: null` for every page after the first.
   */
  function refreshFindUi(): void {
    const isNote = st.mode === "note";
    const searchable =
      isNote && (st.metaResolved ? (st.meta?.pages.some((pg) => pg.textHash !== null) ?? false) : st.summaryRecognized);
    findToggle.disabled = !searchable;
    findToggle.title = searchable ? "Find in this note" : "This note has no recognised text to search";
  }

  // --- the page-index panel (docked LEFT, open by default) ------------------

  /**
   * Whether the layers panel is on screen; the toggle and every width
   * reservation read this. Keyed on `layersAvail`, not the stack, so the page
   * width doesn't jump during a page turn's decode.
   */
  function layersPanelShown(): boolean {
    return st.layersPanelOpen && st.mode === "note" && st.layersAvail === "some";
  }

  /** Width of the open right dock(s), gap included, from the layout tokens. */
  function rightPanelsWidth(): number {
    const gap = tokenPx("--panel-gap", 22);
    const ocrW = ocr.isOpen() ? tokenPx("--panel-w", 268) + gap : 0;
    const layersW = layersPanelShown() ? tokenPx("--panel-w-wide", 320) + gap : 0;
    return ocrW + layersW;
  }

  /** The page index plus the right dock(s) would leave the page below {@link MIN_PAGE_W}. */
  function bothSidesTooTight(): boolean {
    const leftW = tokenPx("--panel-w-narrow", 180) + tokenPx("--panel-gap", 22);
    return stage.getBoundingClientRect().width - 56 - leftW - rightPanelsWidth() < MIN_PAGE_W;
  }

  /** Sync the page-index toggle and panel; shown only for a `.note`. */
  function refreshPageIndexUi(): void {
    const shown = st.mode === "note" && st.pageIndexOpen;
    pageIndexPanel.setOpen(shown);
    pagesToggle.setAttribute("aria-pressed", String(shown));
    pagesToggle.setAttribute("aria-expanded", String(shown));
  }

  /** Relayouts because the panel takes stage width. */
  function setPageIndexOpen(next: boolean): void {
    if (st.pageIndexOpen === next) return;
    st.pageIndexOpen = next;
    refreshPageIndexUi();
    void showPage(st.pageIndex);
  }

  /** Never squeeze the page from both sides: when a RIGHT tool has just opened on
   *  a stage too narrow to hold both docks, collapse the LEFT page index. */
  function relieveDoubleSqueeze(): void {
    if (st.pageIndexOpen && st.mode === "note" && bothSidesTooTight()) setPageIndexOpen(false);
  }

  /** The symmetric half: reopening the page index on a narrow stage closes right docks. */
  function collapseRightPanels(): void {
    if (ocr.isOpen()) ocr.toggle();
    if (st.layersPanelOpen) {
      st.layersPanelOpen = false;
      refreshLayersUi();
    }
  }

  // --- the layers panel + stack (see pages/noteLayers.ts) -------------------

  /** Sync every layers affordance with the stack; called on every path that changes it. */
  function refreshLayersUi(): void {
    const has = st.mode === "note" && st.layersAvail === "some";
    layersToggle.disabled = !has;
    // Unknown (skeleton meta) gets neutral wording, never "no layers".
    layersToggle.title = has
      ? "Layers"
      : st.mode === "note" && st.layersAvail === "unknown"
        ? "Layers — still opening this page"
        : "This page has no layers";
    const open = layersPanelShown();
    if (open) {
      // Only this page's stack; the previous page's stays mounted until the new one commits.
      const stack = stackIsCurrent() ? noteLayerCtl.stack() : null;
      if (stack) layersPanel.setLayers(toPanelLayers(stack.views));
      else layersPanel.setState("loading", "Loading this page's layers…");
    }
    layersPanel.el.hidden = !open;
    layersToggle.setAttribute("aria-pressed", String(open));
    layersToggle.setAttribute("aria-expanded", String(open));
    downloads.refreshGroups();
  }

  /** Is the mounted stack the focused page's, at the current theme? */
  function stackIsCurrent(): boolean {
    const page = st.meta?.pages[st.pageIndex];
    return page !== undefined && page.hash !== "" && noteLayerCtl.isPresented(page.hash, getTheme());
  }

  /**
   * Try the per-layer path for the focused page; false means fall back to the
   * composite. Same page and theme short-circuits, so relayouts are CSS-only.
   */
  async function presentLayers(noteId: Id, page: PageRef, vos: PageLayer[], token: number): Promise<boolean> {
    const theme = getTheme();
    if (noteLayerCtl.isPresented(page.hash, theme)) {
      // Same page: just undo `showPage`'s hide (same task, so no flicker).
      noteLayerCtl.el.hidden = false;
      refreshLayersUi();
      return true;
    }
    try {
      const bytes = await api.getPageBytes(noteId, page);
      if (token !== st.paintToken) return false;
      const stack = await noteLayerCtl.present(noteId, page.hash, bytes, vos, theme);
      if (token !== st.paintToken) return false;
      if (stack) {
        refreshLayersUi();
        return true;
      }
    } catch (e) {
      // The layered path must still report session/stale failures.
      dispatchApiFailure(failures, e, noteId, page);
    }
    noteLayerCtl.release();
    refreshLayersUi();
    return false;
  }

  async function showPage(index: number): Promise<void> {
    if (!st.meta || st.mode !== "note") return;
    st.pageIndex = Math.max(0, Math.min(st.meta.pages.length - 1, index));
    const page = st.meta.pages[st.pageIndex];
    if (!page) return;

    // Every page change comes through here, so the strip follows for free.
    pageIndexPanel.setCurrent(st.pageIndex);
    pager.set(st.pageIndex, st.meta.pages.length);

    // Decided from metadata now, not after the decode. The server omits
    // `layers` when a page has none, so only skeleton pages (index > 0 before
    // the meta resolves) are unknown.
    const pageIsAuthoritative = st.metaResolved || st.pageIndex === 0;
    const layerVos = page.layers ?? null;
    const pageHasLayers = layerVos !== null && layerVos.length > 0;
    st.layersAvail = pageHasLayers ? "some" : pageIsAuthoritative ? "none" : "unknown";
    refreshLayersUi();

    // Hide the previous page's stack so it doesn't cover the new page's blur-up.
    // Hidden, not released: release bumps `gen` and loses the `isPresented`
    // short-circuit that makes relayouts free.
    if (!stackIsCurrent()) {
      noteLayerCtl.el.hidden = true;
      pageCanvas.hidden = false;
    }

    // Size the page: fit the stage height (or a zoom step), clamp to width.
    const rect = stage.getBoundingClientRect();
    const aspect = page.width / page.height;
    let h = Math.min(Math.max(rect.height - 56, 120), 1000);
    // Note mode only, so `zoom` is a note-ladder value.
    if (st.zoom !== FIT_PAGE && st.zoom in ZOOM_SCALE) h = 640 * ZOOM_SCALE[st.zoom as keyof typeof ZOOM_SCALE];
    let w = h * aspect;
    // Side panels take their widths from the layout tokens.
    const gap = tokenPx("--panel-gap", 22);
    const ocrW = ocr.isOpen() ? tokenPx("--panel-w", 268) + gap : 0;
    const layersW = layersPanelShown() ? tokenPx("--panel-w-wide", 320) + gap : 0;
    const pagesW = st.pageIndexOpen ? tokenPx("--panel-w-narrow", 180) + gap : 0;
    const maxW = Math.max(rect.width - 56 - ocrW - layersW - pagesW, 80);
    if (w > maxW) {
      w = maxW;
      h = w / aspect;
    }
    pageEl.style.width = `${Math.round(w)}px`;
    pageEl.style.height = `${Math.round(h)}px`;
    pageWrap.style.height = `${Math.round(h)}px`;

    // OCR and find follow the page here; find after the resize, since ovals use page pixels.
    ocr.setPage(st.meta.id, page);
    find.setPage(st.pageIndex);

    const token = ++st.paintToken;
    const noteId: Id = st.meta.id;

    // Links depend on the page box, not pixels; not awaited so they never delay a turn.
    void paintLinks(st.pageIndex, token);

    // Blur up the thumbnail, or draw the ruled sheet, so the old page doesn't linger.
    let thumbDrawn = false;
    const thumbCanvas = pageIndexPanel.thumbCanvas(st.pageIndex);
    if (thumbCanvas && thumbCanvas.width > 0 && thumbCanvas.height > 0) {
      const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
      pageCanvas.width = Math.round(w * dpr);
      pageCanvas.height = Math.round(h * dpr);
      const ctx = pageCanvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(thumbCanvas, 0, 0, pageCanvas.width, pageCanvas.height);
        pageCanvas.classList.add("is-loading");
        thumbDrawn = true;
      }
    }
    if (!thumbDrawn) {
      // The strip is virtualised, so a far jump may have no painted thumb to blur.
      pageCanvas.classList.remove("is-loading");
      defaultPlaceholder(pageCanvas, page);
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
        refreshLayersUi();
      }
    } else {
      noteLayerCtl.release();
      refreshLayersUi();
    }
    // One paint owns the page; the other is hidden.
    pageCanvas.hidden = layeredUp;
    if (layeredUp) pageCanvas.classList.remove("is-loading");

    if (!layeredUp && page.hash !== "") {
      try {
        const bitmap = await renderPage({ api, renderer, cache, theme: getTheme() }, noteId, page, "full");
        if (token !== st.paintToken) return; // a newer showPage superseded us
        const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, DPR_CAP);
        pageCanvas.width = Math.round(w * dpr);
        pageCanvas.height = Math.round(h * dpr);
        const ctx = pageCanvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, pageCanvas.width, pageCanvas.height);
          pageCanvas.classList.remove("is-loading");
        }
      } catch (e) {
        // Keep the previous paint; session/stale errors still go to the sink.
        dispatchApiFailure(failures, e, noteId, page);
      }
    }

    // Warm the neighbours so paging is instant.
    for (const j of [st.pageIndex - 1, st.pageIndex + 1]) {
      const neighbour = st.meta.pages[j];
      if (neighbour) filmEngine.prefetch(noteId, neighbour, "full");
    }
  }

  /**
   * Publish the position after `showPage`, in one place. Not folded in because
   * `showPage` awaits the paint, and the URL should follow the turn.
   */
  function goToPage(index: number): void {
    void showPage(index);
    syncUrl();
  }

  /** Rebuild the strip from `meta` (open, skeleton resolve, STALE_PAGE); badges survive. */
  function buildFilmstrip(): void {
    filmEngine.reset();
    if (!st.meta) {
      pageIndexPanel.clear();
      return;
    }
    pageIndexPanel.setPages(st.meta.pages.length);
    // `hasInk` comes with the page list, so it covers unpainted rows; pages
    // without it are omitted, not guessed.
    const inked = new Map<number, boolean>();
    st.meta.pages.forEach((page, i) => {
      if (page.hasInk !== undefined) inked.set(i, page.hasInk);
    });
    pageIndexPanel.setInk(inked);
    pageIndexPanel.setCurrent(st.pageIndex);
  }

  // --- keyboard (only while open) ------------------------------------------
  function onKey(e: KeyboardEvent): void {
    if (!st.open) return;
    // An open export menu and the find bar each take Escape before the reader.
    if (e.key === "Escape") {
      if (find.isOpen()) {
        find.close();
        syncUrl();
        return;
      }
      return deps.onBack();
    }
    if (st.mode !== "note") return;

    // Ctrl/Cmd+F is claimed only here, so the browser's find works elsewhere.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      find.open();
      return;
    }

    // Paging keys don't apply inside inputs (including the pager's field).
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") goToPage(st.pageIndex + 1);
    else if (e.key === "ArrowLeft") goToPage(st.pageIndex - 1);
    // Home/End are prevented, or they would also scroll the document.
    else if (e.key === "Home") {
      e.preventDefault();
      goToPage(0);
    } else if (e.key === "End" && st.meta) {
      e.preventDefault();
      goToPage(st.meta.pages.length - 1);
    }
  }

  /** Apply the current zoom step to the image preview. */
  function sizeImage(): void {
    if (st.zoom === FIT_PAGE) {
      // Back to the CSS rule: fit the stage in both axes.
      fileImg.style.width = "";
      fileImg.style.maxWidth = "";
      fileImg.style.maxHeight = "";
      return;
    }
    // Past Fit the image may overflow `.filestage`, so lift the max-* clamps.
    fileImg.style.maxWidth = "none";
    fileImg.style.maxHeight = "none";
    if (st.zoom === FIT_WIDTH) {
      // Unlike Fit, this enlarges small images.
      fileImg.style.width = "100%";
      return;
    }
    // Not `ZOOM_SCALE`: for an image 100% means natural size.
    const factor = Number.parseInt(st.zoom, 10) / 100;
    const natural = fileImg.naturalWidth || fileImg.clientWidth;
    if (natural > 0 && Number.isFinite(factor)) {
      fileImg.style.width = `${Math.round(natural * factor)}px`;
    }
  }

  ocrToggle.addEventListener("click", () => {
    ocr.toggle();
    // Never squeeze the page from both sides.
    if (ocr.isOpen()) relieveDoubleSqueeze();
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

  /** Shared teardown for close and hide. */
  function closeReader(): void {
    st.open = false;
    if (st.urlTimer !== undefined) {
      clearTimeout(st.urlTimer);
      st.urlTimer = undefined;
    }
    exportMenu.setOpen(false);
    ocr.reset();
    find.reset();
    findInput.value = "";
    // A closed reader holds no decoded RGBA (~10 MB per layer).
    st.layersPanelOpen = false;
    st.layersAvail = "unknown";
    noteLayerCtl.release();
    refreshLayersUi();
    st.previewVersion = null;
    st.previewViewOnly = false;
    restoreVersionBtn.hidden = false;
    versionBanner.hidden = true;
    root.classList.remove("is-previewing");
    root.classList.remove("is-open");
    root.setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", onKey);
    filmEngine.reset();
    // Also keeps a reopen from flashing the previous image.
    files.clear();
    linkLayer.clear();
    linksByPage.clear();
    st.meta = null;
  }

  return {
    el: root,

    async open(summary: NoteSummary, metaPromise: Promise<NoteMeta>, startPage = 0, origin: ReaderOrigin = LIBRARY_ORIGIN, query = ""): Promise<void> {
      // Applying the route: no URL writes until the end (see `urlSuspended`).
      st.urlSuspended = true;
      // Background freshness refreshes re-call `open()` for the same file; only
      // a different file resets menus, find and panels.
      const changedFile = st.meta?.id !== summary.id;

      // Never replace a resolved meta with a skeleton on a same-file re-open.
      const keepResolved = !changedFile && st.metaResolved && st.meta !== null;
      st.summaryRecognized = summary.hasRecognizedText;
      // Skeleton: page 0 from the summary, the rest placeholders (empty hash).
      const aspect = summary.thumbAspect ?? DEFAULT_PAGE_DIMS;
      const skeletonMeta: NoteMeta = {
        id: summary.id,
        name: summary.name,
        fileType: summary.fileType,
        fileHash: summary.fileHash,
        // Listing rows don't carry the pairing.
        annotationsId: null,
        size: 0,
        pxPerMm: null,
        pages: Array.from({ length: summary.pageCount }, (_, i) =>
          i === 0 ? summary.firstPage : skeletonPage(i, aspect),
        ),
      };
      if (!keepResolved) st.metaResolved = false;
      // ONE assignment, so `meta` is provably non-null for the rest of `open`.
      st.meta = keepResolved && st.meta ? st.meta : skeletonMeta;
      
      if (changedFile) exportMenu.setOpen(false);
      const kind = fileKind(summary.fileType);

      header.setName(st.meta.name);
      header.setBackWord(backWord(origin));
      // A bin-origin file is already trashed: Restore/Delete replace Move to bin.
      st.fromBin = origin.kind === "bin";
      // A history preview is a third context: only Restore-this-version, on the banner.
      st.previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
      const previewing = st.previewVersion !== null;
      st.previewViewOnly = previewing && origin.viewOnly === true;
      moveBin.hidden = st.fromBin || previewing;
      // Versions: a real `.note` (live or bin), or any history preview.
      const isRealNote = st.meta.fileType.trim().toLowerCase() === "note";
      versionsBtn.hidden = !isRealNote && !previewing;
      binActions.setBinMode(st.fromBin, st.fromBin ? origin.retention ?? null : null);
      // The exact timestamp rides `title`.
      versionBanner.hidden = !previewing;
      restoreVersionBtn.hidden = st.previewViewOnly;
      root.classList.toggle("is-previewing", previewing);
      if (previewing && st.previewVersion) {
        versionBannerText.textContent = `You're viewing a version from ${relativeTime(st.previewVersion.createdAt)} — this is not the current note.`;
        versionBannerText.title = absoluteTime(st.previewVersion.createdAt);
      }
      // A new file starts with the panel closed and no transcript carried over.
      ocr.reset();
      // A query carried across files would count one note over another's pages.
      if (changedFile) {
        find.reset();
        findInput.value = "";
        // One file's layers must never label another's pixels.
        st.layersPanelOpen = false;
        st.layersAvail = "unknown";
        noteLayerCtl.release();
        refreshLayersUi();
        // Page index back to default open, only on a real file change.
        st.pageIndexOpen = true;
      }
      setMode(kind);
      root.classList.add("is-open");
      root.setAttribute("aria-hidden", "false");
      st.open = true;
      document.addEventListener("keydown", onKey);

      if (kind === "note") {
        // Clamped once; a deep link past the end lands on the last page.
        st.pageIndex = Math.max(0, Math.min(st.meta.pages.length - 1, Math.floor(startPage)));
        st.zoom = FIT_PAGE;
        zoomStepper.set(FIT_PAGE);
        header.setSubtitle(
          subtitle(origin, `${st.meta.pages.length} ${st.meta.pages.length === 1 ? "page" : "pages"}`),
        );
        setDownload(null);
        // In a preview the live raw route would serve the current blob, so use the version's.
        downloads.setRawHref(
          previewing
            ? historyFileUrl(st.meta.id, st.previewVersion!.md5, { download: true, bin: st.previewViewOnly })
            : rawFileUrl(st.meta.id, st.meta.fileHash, { download: true, bin: st.fromBin }),
        );
        // Before the filmstrip (badges need the page list). The last argument:
        // the skeleton's `textHash: null`s are invented, so they count only when
        // the listing also says unrecognised.
        find.setNote(st.meta.id, st.meta.fileHash, st.meta.pages, st.metaResolved || !st.summaryRecognized);
        buildFilmstrip();
        // Prime find through the normal path; `setQuery` ignores a repeated query.
        const primed = findQuery(query);
        if (primed) {
          findInput.value = primed;
          find.open();
          find.setQuery(primed);
        }
        // Paint after the overlay has laid out so the stage has real dimensions.
        requestAnimationFrame(() => void showPage(st.pageIndex));
      } else {
        st.pageIndex = 0;
        // Nothing to find in a PDF or an image: no recognition, no word boxes.
        find.reset();
        findInput.value = "";
        filmEngine.reset();
        pageIndexPanel.clear();
        header.setSubtitle(subtitle(origin, `${st.meta.fileType.toUpperCase()} · ${formatBytes(st.meta.size)}`));
        // Bin and history previews need their own routes (see the note branch).
        setDownload(
          previewing
            ? historyFileUrl(st.meta.id, st.previewVersion!.md5, { download: true, bin: st.previewViewOnly })
            : rawFileUrl(st.meta.id, st.meta.fileHash, { download: true, bin: st.fromBin }),
        );

        const preview = previewing
          ? historyFileUrl(st.meta.id, st.previewVersion!.md5, { bin: st.previewViewOnly })
          : rawFileUrl(st.meta.id, st.meta.fileHash, { bin: st.fromBin });
        if (kind === "image" && preview) {
          showImage(st.meta, preview);
        } else {
          showNoPreview(
            st.meta,
            st.meta.name,
            preview === null
              ? "This file has no stored contents to preview or download yet."
              : "There's no preview for this file type. Download it to open it in another app.",
          );
        }
      }

      // Keep focus on the find field when the route asked for a search.
      if (!(kind === "note" && findQuery(query))) back.focus();

      st.urlSuspended = false;
      // Publish once; this canonicalises a clamped page or a blank query.
      syncUrl();

      // The real metadata. Must catch: the shell does not await `open`.
      let realMeta: NoteMeta;
      try {
        realMeta = await metaPromise;
      } catch (e) {
        if (!st.open || st.meta?.id !== summary.id) return;
        // Non-session failures leave the readable skeleton on screen.
        dispatchApiFailure(failures, e);
        return;
      }
      if (!st.open || st.meta?.id !== realMeta.id) return;

      const paintedPage = st.meta?.pages[st.pageIndex];
      st.meta = realMeta;
      st.metaResolved = true;
      // The page list is authoritative now.
      refreshFindUi();

      if (kind === "note") {
        header.setSubtitle(
          subtitle(origin, `${st.meta.pages.length} ${st.meta.pages.length === 1 ? "page" : "pages"}`),
        );
        find.setNote(st.meta.id, st.meta.fileHash, st.meta.pages);
        buildFilmstrip();
        // Repaint only if the page changed: `buildFilmstrip` just emptied the
        // blur-up source, so an unconditional repaint flashes white.
        const nextPage = st.meta.pages[st.pageIndex];
        const alreadyPainted = paintedPage?.hash !== "" && paintedPage?.hash === nextPage?.hash;
        // Also repaint when the page gains layers (synthesized summaries, skeleton pages).
        const gainedLayers = (nextPage?.layers?.length ?? 0) > 0 && !paintedPage?.layers?.length;
        if (!alreadyPainted || gainedLayers) void showPage(st.pageIndex);
      } else {
        header.setSubtitle(subtitle(origin, `${st.meta.fileType.toUpperCase()} · ${formatBytes(st.meta.size)}`));
      }
    },

    close: closeReader,

    // Switching to another viewer is a full close (see the doc on {@link Reader.hide}).
    hide: closeReader,

    isOpen(): boolean {
      return st.open;
    },

    bumpTheme(): void {
      // Non-note modes are ordinary themed DOM.
      if (st.mode !== "note") return;
      filmEngine.bumpTheme();
      if (st.open && currentPage()) void showPage(st.pageIndex);
    },

    destroy(): void {
      document.removeEventListener("keydown", onKey);
      exportMenu.destroy();
      filmEngine.destroy();
      pageIndexPanel.destroy();
      noteLayerCtl.release();
    },
  };
}
