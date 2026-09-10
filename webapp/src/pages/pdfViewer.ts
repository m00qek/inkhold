// The PDF VIEWER — one page at a time, rastered in the browser by MuPDF.
//
// A viewer of its own rather than an arm of the reader, for the same reason the
// `.spd` and `.txt` viewers are: a PDF has a different lifecycle. The reader's
// `NoteRenderer` takes a page's own byte range and is contractually pure, and a
// PDF page cannot be decoded from its own bytes — pages share a resource graph
// through the xref. So the document is opened ONCE and held, and the handle must
// be closed (`render/pdfDocument.ts`).
//
// NOTHING BELOW THIS FILE RUNS ON THIS THREAD. MuPDF, the document handle and
// the byte-range block cache all live in a worker (`render/pdfClient.ts` ->
// `render/pdfWorker.ts`); this asks for a page and receives an `ImageBitmap` to
// draw. That is why every step here is `await`ed — a page size can cost a round
// trip — and why there is no size ceiling: a 76 MB document costs the blocks
// page 1 is written in.
//
// WHAT THIS IS NOT is a version-history viewer: `canPreviewHistory` excludes
// `.pdf`, so a PDF's retained versions stay unlisted even though the backend
// keeps them. Painting a PAST version needs a second document handle open
// beside the live one, which is the piece nobody has written.

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
import { tokenPx, MIN_PAGE_W } from "../ui/sidePanel";
import { copyText } from "../ui/clipboard";
import {
  createPdfFindController,
  pdfCountIsNone,
  pdfCountText,
  type PdfFindController,
} from "./pdfFind";
import { createBinViewerActions } from "../ui/binViewerActions";
import { createLayersPanel } from "./layersPanel";
import { buildNoteLayerThumb, createNoteLayersController } from "./noteLayers";
import { createPdfExports } from "./pdfExports";
import { createPdfViewerExports } from "./pdfViewerExports";
import { supportsWasmExceptions } from "../render/pdfLoader";
import type { PdfWord } from "../render/pdfWire";
import { PdfLoadError, createPdfSession, type PdfSession } from "../render/pdfClient";


/**
 * The versions control's two names — and the label is "Annotation history", not
 * "Version history", everywhere it appears.
 *
 * The document has no versions to offer; the handwriting over it does. Calling
 * the control "Version history" beside a PDF would promise a past PDF, which is
 * the one thing this feature deliberately does not do.
 */
const ANNOTATIONS_HISTORY = "Annotation history";
/** …and why it is dimmed, which {@link contextualOpener} appends to the name. */
const ANNOTATIONS_NO_INK = "this document has no annotations";

/**
 * A control that is ALWAYS PRESENT and dimmed when it has nothing to offer, with
 * the reason on its own accessible name.
 *
 * PRESENT RATHER THAN ABSENT — the OCR toggle's rule, which `07-find-in-note.css`
 * states in as many words: "the feature stays discoverable instead of vanishing
 * between pages". A toolbar that changes shape per document is one the reader has
 * to re-read, and every control beside a vanishing one moves under the pointer.
 *
 * THE REASON RIDES THE ACCESSIBLE NAME rather than being left to inference:
 * "Outline — this document has none" is an answer where a bare dimmed control is
 * a dead end. `toolbar.ts`'s `usable()` already filters `disabled` out of the
 * roving order, so the keyboard skips it with no work here.
 *
 * `attrs` is for an opener that is also a TOGGLE (`aria-pressed`,
 * `aria-controls`); a plain opener needs none.
 */
function contextualOpener(spec: {
  icon: string;
  label: string;
  reason: string;
  attrs?: Record<string, string>;
}): { el: HTMLButtonElement; setAvailable(has: boolean): void } {
  const dimmed = `${spec.label} — ${spec.reason}`;
  const button = el("button", {
    class: "btn",
    type: "button",
    ...spec.attrs,
    "aria-label": dimmed,
    title: dimmed,
    disabled: true,
    html: svg(spec.icon, 1.8),
  }) as HTMLButtonElement;
  return {
    el: button,
    setAvailable(has: boolean): void {
      button.disabled = !has;
      const name = has ? spec.label : dimmed;
      button.setAttribute("aria-label", name);
      button.title = name;
    },
  };
}

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
  let zoom: Zoom = FIT_PAGE;
  let fromBin = false;
  /**
   * The open document's metadata — what the bin actions act ON.
   *
   * Held because the toolbar's file zone outlives any one `open()`: the buttons
   * are built once and re-pointed per document. Cleared by `release()`, so a
   * control can never act on the file you just navigated away from.
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
  /**
   * The paired `.mark`'s id AS THE METADATA STATED IT — set the moment the
   * document's meta lands, before any of the mark's own bytes are asked for.
   *
   * Separate from `markId`, which is only set once `loadMark` has fetched the
   * mark's page list: `markId` answers "can I paint ink on this page", this
   * answers "does this document have handwriting at all". The versions control
   * needs the latter IMMEDIATELY, not one round trip later, or it flickers from
   * dimmed to live on every open.
   */
  let annotationsId: Id | null = null;
  /**
   * The ANNOTATION VERSION being previewed (a `.mark`'s retained blob), or null
   * on a live open.
   *
   * The document is NOT a past version of itself in this mode — there is no such
   * thing here — so unlike `spdViewer`'s field of the same name this changes
   * nothing about how the PDF is fetched. It puts the banner up, marks the
   * on-screen version's row `Viewing`, names the version Restore acts on, and
   * salts the strip's composite thumbnail key (see {@link thumbKey}) so a
   * preview cannot be served the LIVE ink out of the persistent cache.
   */
  let previewVersion: { md5: string; createdAt: number } | null = null;
  /** The previewed annotations belong to a TRASHED document: Restore is suppressed. */
  let previewViewOnly = false;
  /** The open document's md5 — half of a thumbnail's cache identity. */
  let docHash = "";
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
   * `decode_layer` hands back RGBA whose background is alpha 0. That is what
   * makes this an overlay rather than a second opaque sheet.
   *
   * Positioned by `placePanelOverPage`: the ink is in DEVICE PANEL pixels and
   * the canvas is the PAGE, which is only part of that panel, so the host is
   * drawn oversized and shifted until the two line up. `.pdf-stage` clips the
   * dead margins.
   *
   * `backdrop: null` because the page underneath IS the document; the
   * controller's default white paper would hide the PDF completely.
   */
  const markCtl = createNoteLayersController({ backdrop: null });
  markCtl.el.classList.add("pdf-mark");
  /**
   * STACKING IS DOM ORDER in `.pdf-stage`, so the `stage` call below IS the
   * decision. The document's OWN links go LAST, above the ink: `.pdf-mark` is
   * `pointer-events: none` and never eats a click, but a link under a scribble
   * is precisely the case that occurs.
   */
  const linkLayer = createLinkLayer();
  /**
   * Find's marks, BETWEEN the page and the ink: over the page because that is
   * what they point at, under the handwriting because a wash over somebody's pen
   * stroke would be this app editing their annotation.
   */
  const findLayer = createPdfHighlightLayer();
  /**
   * Text selection, BESIDE find's marks and under the ink for the same reason.
   * It is the one layer over the page that takes the pointer, and it sits UNDER
   * the link layer, which is what makes a press on a link reach the link with
   * nothing here having to tell a click from a drag.
   */
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

  // OWN readout class (`pdf-zoom`), like `.spd-zoom` / `.txt-zoom`: a shared
  // `.zoom` locator resolves to several elements with every viewer mounted at
  // once. The class buys NO width of its own — all four readouts share one
  // (10-toolbar.css), so the control keeps its shape between file types.
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

  // The shared control (`viewerControls.createPager`) — the reader mounts the
  // same one.
  const pager = createPager({ readoutClass: "pdf-pager__count", onGo: (index) => void go(index) });

  // --- the download / export menu ------------------------------------------
  // The shared dropdown, so this viewer's Download has the same shape the `.spd`
  // viewer's and the reader's do; the raw file is the WHOLE DOCUMENT group's one
  // row. The CONTENT is `pdfExports.ts`'s; the model it exports is
  // `pdfViewerExports.ts`'s, because composing a PDF page with the ink written
  // on it is the one thing only this viewer knows how to do.
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

  // --- the file zone: Move to bin, or the bin-origin cluster ---------------
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
  // The BIN-ORIGIN cluster, swapped in for Move to bin when the file is open
  // from the recycle bin: the SAME `|— retention —| ⋯` the bin ROW shows, from
  // the shared `createBinViewerActions`. Nothing here is PDF-specific, which is
  // the point — a trashed file behaves the same whatever opened it.
  const binActions = createBinViewerActions({
    getMeta: () => meta,
    onRestore: deps.onRestore,
    onPurge: deps.onPurge,
    // Card parity: the bin's "Version history" row opens the same view-only
    // panel, anchored to the "…" trigger. Wired only when the shell can open
    // history at all — no dead row otherwise.
    onHistory: deps.onVersions ? (m, anchor) => deps.onVersions!(m, anchor, undefined) : undefined,
  });

  // --- annotation history (file zone) --------------------------------------
  /**
   * The versions control — and what it offers is the INK's history, not the
   * document's.
   *
   * A `.pdf` has no version history the app can paint: showing a past PDF means a
   * second document handle open beside the live one, which nothing here does. The
   * `.mark` written over it is a different matter — it is a `.note` container,
   * the reader paints it, and every superseded copy is retained. So the control
   * says ANNOTATION history in as many words: what is versioned is the
   * handwriting.
   *
   * ALWAYS PRESENT, dimmed when the document has no mark — see
   * {@link contextualOpener}.
   */
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

  /**
   * WHOSE versions this viewer is offering: the paired `.mark`, under the
   * DOCUMENT's name — `foo.pdf.mark` is a filename the device invented and the
   * reader never chose to see, so `annotationsOn` carries the distinction that
   * the heading does not state.
   */
  function versionSubject(): VersionSubject | null {
    if (!meta || annotationsId === null) return null;
    return { id: annotationsId, name: meta.name, fileType: "mark", annotationsOn: meta.id };
  }

  const setVersionsAvailable = versionsOpener.setAvailable;

  /**
   * The SHARED banner in its `annotations` voice: the default wording ("this is
   * not the current note") would be false here in the one way that matters — the
   * document under the ink IS current, and Restore changes only the handwriting.
   */
  const versionBanner = createVersionBanner({
    kind: "annotations",
    onRestore: () => {
      const subject = versionSubject();
      if (subject && previewVersion) deps.onRestoreVersion?.(subject, previewVersion);
    },
  });

  // --- the annotations panel ------------------------------------------------
  // The SHARED layers panel, with a stack whose BOTTOM row is the PDF itself:
  // the document and the ink written on it are the two things a reader wants to
  // turn on and off independently. The PDF is row `PDF_LAYER_ID`, deliberately
  // outside the range a `.mark`'s layer indices occupy, so the toggle can
  // dispatch on the id alone.
  const layersPanel = createLayersPanel({
    id: "pdf-layers-panel",
    hookPrefix: "pdf",
    onToggle: (id, visible) => {
      if (id === PDF_LAYER_ID) canvas.style.visibility = visible ? "" : "hidden";
      else markCtl.setVisible(id, visible);
      // A toggle is what makes "current view" differ from "original view", so it
      // is what decides whether the ORIGINAL group is offered at all.
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
  // The strip itself is the SHARED component (`pages/pageIndex.ts`); the PAINT
  // that fills it is `pdfThumbStrip.ts`, which is the PDF's own because a PDF
  // page comes from the worker's session and nothing else can produce one.
  //
  // WHAT STAYS HERE is the state that engine asks for: it is the viewer's, it
  // moves under a paint already in flight, and every getter below is read afresh
  // at each step for exactly that reason.
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
  /** The strip's panel — docked, opened and told about the document from here. */
  const pagesPanel = thumbs.panel;

  /**
   * WHICH navigation panel holds the left dock, and whether the right one is up.
   *
   * ONE VALUE, NOT TWO BOOLEANS: Pages and Outline SHARE the left dock, and as
   * a pair of booleans that rule is two `if`s somebody has to remember. As one
   * value the forbidden state cannot be written down.
   */
  type LeftDock = "pages" | "outline";
  let leftDock: LeftDock | null = null;
  let rightDock = false;

  const pagesToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-controls": "pdf-pages-panel",
    "aria-label": "Pages",
    title: "Pages",
    html: svg(VIEWER_IC.pages, 1.8),
  }) as HTMLButtonElement;

  /**
   * How wide a dock WOULD be — measured from the TOKENS, not from the DOM, and
   * that is the difference from {@link availableBox}. That function subtracts the
   * panels that are already mounted, which is the right answer for laying out the
   * page as it stands; this one has to answer a HYPOTHETICAL — "if this panel
   * opened, would the page still be readable" — about a panel with no box yet.
   * Both read the same tokens the stylesheet does, so neither can drift from CSS.
   */
  function dockPx(track: string, fallback: number): number {
    return tokenPx(track, fallback) + tokenPx("--panel-gap", 22);
  }
  function leftDockPx(left: LeftDock | null): number {
    if (left === "pages") return dockPx("--panel-w-narrow", 180);
    if (left === "outline") return dockPx("--panel-w", 268);
    return 0;
  }
  function rightDockPx(right: boolean): number {
    return right ? dockPx("--panel-w-wide", 320) : 0;
  }
  /** Would the page fall below {@link MIN_PAGE_W} with these docks open? A
   *  stage with no width yet is not laid out, and there is nothing to protect. */
  function tooTight(left: number, right: number): boolean {
    const { w } = renderer.stageInner();
    return w > 0 && w - left - right < MIN_PAGE_W;
  }

  /**
   * Move the docks — the ONE place any of the three panels opens or shuts. It
   * owns the whole transition: state, panels, `aria-pressed`, the squeeze rule,
   * one repaint.
   *
   * THE PAGE IS NEVER SQUEEZED FROM BOTH SIDES — the reader's rule. `asked`
   * NAMES THE SIDE THE READER JUST TOUCHED and decides which one gives way: the
   * dock they asked for wins, because they have just said what they want to look
   * at. It gives way only when the two TOGETHER would leave the page under
   * {@link MIN_PAGE_W} — a floor, not a policy, so with room for both, both stay
   * open. `null` is a close nobody asked for, which squeezes nothing.
   *
   * THE REPAINT IS NOT OPTIONAL on a toggle: a panel NARROWS the page rather
   * than covering it, so a Fit page is a different size with it open. It is
   * skipped only for a programmatic close, whose caller is about to repaint or
   * is tearing the document down.
   */
  function setDocks(
    left: LeftDock | null,
    right: boolean,
    asked: "left" | "right" | null,
    repaint = true,
  ): void {
    if (asked === "left" && left !== null && tooTight(leftDockPx(left), rightDockPx(right))) {
      right = false;
    }
    if (asked === "right" && right && tooTight(leftDockPx(left), rightDockPx(right))) {
      left = null;
    }
    leftDock = left;
    rightDock = right;
    pagesPanel.setOpen(left === "pages");
    outlinePanel.setOpen(left === "outline");
    layersPanel.el.hidden = !right;
    pagesToggle.setAttribute("aria-pressed", String(left === "pages"));
    outlineToggle.setAttribute("aria-pressed", String(left === "outline"));
    layersToggle.setAttribute("aria-pressed", String(right));
    if (repaint && open_) void renderer.paint();
  }
  pagesToggle.addEventListener("click", () =>
    setDocks(leftDock === "pages" ? null : "pages", rightDock, "left"),
  );

  // --- the outline (view zone) ---------------------------------------------
  // The document's own table of contents, docked beside Pages and mutually
  // exclusive with it (`pdfOutlinePanel.ts` says why they are two panels and not
  // two tabs).
  const outlinePanel = createPdfOutlinePanel({ onPick: (page) => void go(page) });
  const outlineOpener = contextualOpener({
    icon: VIEWER_IC.outline,
    label: "Outline",
    reason: "this document has none",
    attrs: { "aria-pressed": "false", "aria-controls": "pdf-outline-panel" },
  });
  const outlineToggle = outlineOpener.el;
  outlineToggle.addEventListener("click", () =>
    setDocks(leftDock === "outline" ? null : "outline", rightDock, "left"),
  );

  function setOutlineAvailable(has: boolean): void {
    outlineOpener.setAvailable(has);
    // A document with no outline cannot have the panel up. No repaint: this runs
    // on teardown, and on the answer that arrives with a document just opened —
    // both of which paint on their own path.
    if (!has && leftDock === "outline") setDocks(null, rightDock, null, false);
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
  layersToggle.addEventListener("click", () => setDocks(leftDock, !rightDock, "right"));

  /**
   * Copy the selected passage.
   *
   * SHOWN ONLY WHEN THERE IS A SELECTION, like the layers toggle is shown only
   * when there is a `.mark`: a Copy button over a page with nothing selected is
   * a control that does nothing, and on a raster page there is no other way to
   * tell whether it would.
   *
   * It REPORTS what happened rather than assuming. The async clipboard needs a
   * secure context and this app is normally served over plain HTTP on a home
   * network, so the copy really can fail — `copyText` falls back to the older
   * path for exactly that case, and the label says which way it went.
   */
  const copyBtn = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Copy selected text",
    title: "Copy selected text",
    html: svg(VIEWER_IC.copy, 1.7),
    hidden: true,
  }) as HTMLButtonElement;
  /** Announced, because the button's own glyph cannot say "that did not work". */
  const copyLive = el("span", { class: "pdf-copy__live", role: "status" });
  let copyLabelTimer = 0;
  async function runCopy(): Promise<void> {
    const text = selectLayer.text();
    if (text === "") return;
    const ok = await copyText(text);
    copyLive.textContent = ok ? "Copied" : "Could not copy";
    copyBtn.classList.toggle("is-failed", !ok);
    window.clearTimeout(copyLabelTimer);
    copyLabelTimer = window.setTimeout(() => {
      copyLive.textContent = "";
      copyBtn.classList.remove("is-failed");
    }, 1800);
  }
  copyBtn.addEventListener("click", () => void runCopy());

  // --- find (view zone) -----------------------------------------------------
  // An icon-only `.btn` whose open look rides on `aria-pressed`. Enabled for
  // EVERY PDF, unlike the reader's — the reader gates on the device having
  // recognised the note, and there is no equivalent flag here (see `pdfFind.ts`,
  // on the missing `unrecognised` state).
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
    // PAGER, ZOOM, FIND — the reader's order (`reader.ts`), because the app's
    // only two paged viewers must not put the same control in different places.
    // Where a control sits is part of what it is.
    view: [
      { kind: "custom", key: "pager", el: pager.el, focus: pager.focus },
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus },
      { kind: "custom", key: "find", el: findToggle, focus: [findToggle] },
      { kind: "custom", key: "pages", el: pagesToggle, focus: [pagesToggle] },
      // IMMEDIATELY AFTER PAGES: they are the two navigation panels, they share
      // one dock, and a control's neighbours are part of what it is.
      { kind: "custom", key: "outline", el: outlineToggle, focus: [outlineToggle] },
      // Shown only where there is something to show: a PDF with no `.mark`
      // beside it has one layer, and a panel listing it alone is a control that
      // does nothing.
      { kind: "custom", key: "layers", el: layersToggle, focus: [layersToggle] },
      // Appears only with a selection.
      { kind: "custom", key: "copy", el: copyBtn, focus: [copyBtn] },
      // The announcement rides with the button rather than living loose in the
      // root: it is visually hidden, so all that matters is that it is in the
      // document when it changes.
      { kind: "custom", key: "copy-live", el: copyLive, focus: [] },
    ],
    file: [
      { kind: "custom", key: "download", el: exportMenu.el, focus: [exportMenu.trigger] },
      // THE FILE ZONE, not the view zone: the view zone is navigation — where
      // you are in the document — and this is about the file, in the same sense
      // Download and Move to bin are.
      { kind: "custom", key: "versions", el: versionsBtn, focus: [versionsBtn] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      // Mutually exclusive with Move to bin: the retention countdown then the
      // "…" menu, whose one focusable is its trigger. Same order as `spdViewer`.
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });

  layersPanel.el.hidden = true;
  layersToggle.hidden = true;
  // Pages and Outline both dock LEFT — they are one dock, and only one of them
  // is ever open, so the row never carries both widths at once.
  const main = el(
    "div",
    { class: "pdf-wrap" },
    pagesPanel.el,
    outlinePanel.el,
    body.main,
    layersPanel.el,
  );
  // A `<section>` with an `aria-label`, like the `.spd`/`.txt` viewers: that is
  // what makes it a named landmark rather than an anonymous div.
  const root = el(
    "section",
    { class: "viewer viewer--pdf", "aria-label": "PDF viewer", hidden: true },
    toolbar.el,
    // Under the toolbar and above everything else: a strip that qualifies what
    // is on screen has to be read before the thing it qualifies.
    versionBanner.el,
    findBar,
    main,
  );

  // --- rendering ----------------------------------------------------------
  // The raster path is `pdfPageRenderer.ts`: the fit, the area clamp, the MuPDF
  // render, and the mark, link and selection repaints that hang off a finished
  // raster. Everything else in this viewer reaches the screen through `paint()`.
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
      // The panels that are MOUNTED — the widths that really come off the
      // page's box, as against the hypothetical ones {@link tooTight} weighs.
      dockedPanels: () =>
        [
          leftDock === "pages" ? pagesPanel.el : null,
          leftDock === "outline" ? outlinePanel.el : null,
          rightDock ? layersPanel.el : null,
        ].filter((panel): panel is HTMLElement => panel !== null),
    },
    dom: { main, stage, canvas, body, markCtl, linkLayer, selectLayer, layersPanel },
    // THROUGH ARROWS, because `find` is constructed BELOW this and repaints from
    // a finished raster: the two point at each other and only one can be built
    // first. Reading it at call time is what lets that be either.
    find: {
      repaint: () => find.repaint(),
      wordsKnown: (page) => find.wordsKnown(page),
      wordsFor: (page) => find.wordsFor(page),
    },
    syncPager: () => syncPager(),
    refreshGroups: () => downloads.refreshGroups(),
    onJump: (page) => void go(page),
  });
  // --- find in this PDF ------------------------------------------------------
  // The controller owns the debounce/race/state logic (`pdfFind.ts`); this is
  // only the DOM half of it — the counter's words and the marks on the page.

  /**
   * Put the marks over the page that is drawn.
   *
   * The words arrive in the page's POINTS and land through `placePageRect` — one
   * page, one page→screen transform, which is what stops a highlight and the
   * handwriting over it from drifting apart on a rotated document.
   *
   * A page with no size yet (nothing rastered) takes the layer DOWN rather than
   * guessing at one.
   */
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
    // The ONE in-document search, shared with the reader and the `.txt` viewer
    // so a session holds one wasm instance and one built index.
    docs: deps.docSearch,
    failures: { onSessionExpired: deps.onSessionExpired },
    // THE LOCATOR, and the one seam that makes this testable without a worker.
    // A page that will not read is a page with no boxes: the count above it is
    // the index's and stays exactly as it was.
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
        // someone.
        syncUrl();
      },
      setPageMarks: paintFindMarks,
      // The same strip the reader badges, through the same call — `pageIndex` is
      // shared, and it HOLDS the counts, so a row built later by a scroll still
      // arrives wearing the badge it is due.
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

  // --- exports --------------------------------------------------------------
  // The menu structure, the filenames and the toasts are `pdfExports.ts`'s; the
  // part only this viewer can answer — WHICH pixels, in WHICH space — is
  // `pdfViewerExports.ts`, and what it returns IS the viewer's half of
  // `PdfExportsDeps`.
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
   * Publish the page to the address bar, so a PDF page is a place you can link
   * to and reload into.
   *
   * `#/note/:id/page/:n` is the reader's route, shared, and `open()` honours it
   * — this is the same rule minus only the history preview, which a PDF has none
   * of.
   *
   * THE QUERY RIDES IT. Without it a global-search hit on a PDF opens the right
   * page and then drops the search on the first page turn, so the address you
   * could copy is never the screen you are looking at.
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
    // The outline's mark tracks paging as well as clicking — the entry you are
    // INSIDE, not the one you last pressed.
    outlinePanel.setCurrent(to);
    // BEFORE `syncUrl`, so the address carries the page AND the query together,
    // and before the raster, so the marks are already the new page's when it
    // lands rather than one paint behind.
    find.setPage(to);
    syncUrl();
    await renderer.paint();
  }

  // --- keyboard (only while the viewer is on screen) ------------------------
  // The shape is `txtViewer.ts`'s (guard on `root.hidden`, one document listener
  // for the viewer's life, Escape leaves) and the paging is the reader's, down
  // to leaving modified arrows alone: this app has two paged viewers and a
  // divergence between them would be its own inconsistency.
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
    // ESCAPE UNWINDS ONE THING AT A TIME — selection, then find, then the
    // viewer — the same order the `.txt` viewer and the reader take. One press
    // must not throw away the selection, the search AND the document at once.
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
    // Paging keys belong to the page, not to the field someone is typing in —
    // which now includes the pager's own page field, reached through this same
    // guard.
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") void go(pageIndex + 1);
    else if (e.key === "ArrowLeft") void go(pageIndex - 1);
    // Home/End are PREVENTED where the arrows are not: unclaimed they scroll the
    // document to its ends, and a jump to page 1 that also threw the stage to the
    // top would read as two things happening.
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
   * Ctrl+C over a selected passage.
   *
   * THROUGH THE `copy` EVENT, not through `navigator.clipboard`. The event's own
   * `clipboardData` predates secure contexts and works on the plain-HTTP address
   * this app is normally reached at, where the async clipboard object does not
   * exist at all. It also gets the shortcut for nothing: the browser fires this
   * for Ctrl+C, Cmd+C and the context menu's Copy alike.
   *
   * IT YIELDS TO A REAL TEXT SELECTION. Someone copying from the find field has
   * a DOM selection, and this must not overwrite what they asked for with what
   * is highlighted on the page behind them.
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
   * Hand the strip its ink rail, THROUGH THE MARK — a PDF has no ink of its own.
   *
   * A page with no mark page is `false`: nobody drew on it, and that is known,
   * not unknown. A page whose mark page carries no `hasInk` is LEFT OUT, which
   * (the strip's rule) blanks the whole rail rather than showing a rail with
   * holes in it that read as empty pages.
   *
   * NO MARK AT ALL sets an empty map, so a plain PDF's rows stay unmarked
   * without ever claiming its pages are bare.
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
   * Fetch the paired `.mark`'s page list and index it BY PDF PAGE.
   *
   * `sourcePage` is 1-based (the number the device wrote in the footer) and
   * `pageIndex` here is 0-based, so the key is `sourcePage - 1`. A page without
   * one is SKIPPED rather than guessed at: an unnumbered page cannot be placed,
   * and placing it wrongly puts somebody's handwriting on the wrong page.
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
    // AND THE MENU: the whole-document row asks "does this document have
    // handwriting anywhere", and the answer arrives HERE. Without this a
    // document whose ink is all on page 40 keeps the row hidden until someone
    // happens to turn to page 40.
    downloads.refreshGroups();
    // The page on screen was painted before this landed, so give it its ink.
    if (open_ && markPages.has(pageIndex)) void renderer.paint();
    // And so was the STRIP — leaving it ink-free until each row happens to be
    // recycled would make the answer depend on how you scrolled.
    thumbs.repaintInked();
    refreshInk();
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
    annotationsId = null;
    markPages.clear();
    // AND THE PREVIEW STATE, before the next open reads it. `thumbKey` salts on
    // `previewVersion`, so a stale one would key the NEXT document's composite
    // thumbnails by a version md5 that has nothing to do with it — and the
    // banner would be up over a live file.
    previewVersion = null;
    previewViewOnly = false;
    setVersionsAvailable(false);
    versionBanner.setVersion(null);
    // NOT just hidden — RELEASED. The stack is full-resolution RGBA, megabytes
    // per layer, and hiding the host frees none of it: only `release` zeroes the
    // canvases (`noteLayers.ts`, `zeroCanvas`), which is the only thing that
    // actually drops a backing store. Without it, viewing one annotated page
    // leaves the ink resident for the life of the tab.
    //
    // A page turn deliberately does NOT come through here, so the decoded stack
    // survives paging within a document.
    markCtl.release();
    markCtl.el.hidden = true;
    // The links belonged to a page of a document that is going away, and every
    // one of them is a live address into it. Left up, they would sit over the
    // next document's first page pointing at the last one's.
    linkLayer.clear();
    // And the search belonged to that document too — its counts, its per-page
    // word cache and its marks. The field is cleared beside it, or the next
    // document opens showing the last one's query over a counter that says
    // nothing.
    find.reset();
    findInput.value = "";
    findLayer.clear();
    // The selection belongs to a page of a document, and both are going.
    selectLayer.clear();
    renderer.reset();
    layersToggle.hidden = true;
    // Through the dock helper, not by hand: the toggle's `aria-pressed` lives
    // there too, and setting the flag directly leaves it announcing "pressed"
    // over a closed panel. No repaint — the caller is tearing down or about to
    // paint.
    setDocks(leftDock, false, null, false);
    // Forget the file the bin actions point at, or Move to bin after navigating
    // away trashes whatever was open LAST: the controls outlive any one
    // document, so their target has to be cleared with it.
    meta = null;
    // Drops every canvas and stops observing: a strip left behind would keep
    // painting into rows for a document that is no longer open.
    thumbs.reset();
    // The outline described THAT document, and every row in it is a page number
    // into it. Cleared here rather than on a page turn, like the links: it is
    // per document and survives paging inside one.
    outlinePanel.clear();
    setOutlineAvailable(false); // …which also shuts the panel and un-presses it
    // The popover shuts too, or it hangs open over the next file with the last
    // one's rows in it.
    downloads.refreshGroups();
    exportMenu.setOpen(false);
    // AND FORGET THE ADDRESS. The raw row's href is minted per open and the row
    // outlives any one document, so leaving it set offers the file you just
    // navigated away from — for the whole window between the next `open()` and
    // its metadata landing, which on a slow link is exactly when someone reaches
    // for Download.
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
     * AN ANNOTATION PREVIEW, and note what it is NOT: a past version of this PDF.
     *
     * The shell opens the LIVE document and arms the history reroute on the
     * paired `.mark` instead, so everything below — the range-served document
     * bytes, the raster, the outline, find — is the current file and none of it
     * knows a preview is on. What changes is the ink, one layer up, and the
     * chrome that says so.
     */
    previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
    const previewing = previewVersion !== null;
    previewViewOnly = previewing && origin.viewOnly === true;
    // The context swap: Move to bin for a live file, the retention + "…" cluster
    // for a trashed one. Set BEFORE the metadata lands so the toolbar never
    // shows the wrong pair while loading — both are inert until `meta` arrives.
    // A preview drops Move to bin: the offer in this mode is Restore, and a
    // trash button beside it is a trap rather than a convenience.
    moveBin.hidden = fromBin || previewing;
    binActions.setBinMode(fromBin, fromBin ? (origin.retention ?? null) : null);
    // The banner carries Restore EXCEPT in a view-only preview, where it is the
    // WHEN alone. Up from the first frame — it qualifies the page, so it must not
    // arrive after the page it qualifies.
    versionBanner.setVersion(previewVersion, previewViewOnly);
    // Dimmed until the metadata says there is a mark. A stale enabled control
    // between two opens would offer the LAST document's annotations.
    setVersionsAvailable(false);
    header.setName(summary.name);
    header.setBackWord(backWord(origin));
    // THE SUBTITLE FILLS IN AS THE FILE DOES, and its job is to carry what
    // nothing else on screen does: the FOLDER PATH from the first frame (the
    // Back button shows only the deepest segment), then the SIZE once the
    // metadata lands — on a slow link, what you want in order to decide whether
    // to wait — and finally the page count, below, once it is known.
    header.setSubtitle(originSubtitle(origin, summary.fileType?.toUpperCase() || "PDF"));
    zoom = FIT_PAGE;
    // The READOUT too, not just the state behind it: the stepper keeps its own
    // label, so without this a document opened after zooming the last one
    // renders at Fit while the toolbar still says 300%.
    zoomStepper.set(FIT_PAGE);
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
    // blocking the document: `paint` reads `markPages` each time, so a late
    // arrival shows up on the next page turn — or on this page, via `loadMark`'s
    // own repaint.
    annotationsId = m.annotationsId;
    // The versions control comes alive HERE, off the metadata alone — not off
    // `loadMark`, which is a second round trip and may fail. "Does this document
    // have handwriting" is answered by the pairing; "can I paint it" is
    // `loadMark`'s question, and the two must not share an answer.
    setVersionsAvailable(annotationsId !== null);
    if (m.annotationsId) void loadMark(m.annotationsId, mine);
    if (m.size > 0) header.setSubtitle(originSubtitle(origin, formatBytes(m.size)));
    const url = rawFileUrl(m.id, m.fileHash, { download: false, bin: fromBin });
    // Decided off the URL ITSELF, never off an element's `href`: reading that
    // property back resolves an empty attribute against the document base, so a
    // falsy test on it is never true, and a file with no address keeps a live
    // Download button pointing at the app. `null` DISABLES the raw row; the menu
    // itself stays, because the per-page exports are built from pixels this
    // viewer already has.
    downloads.setRawHref(rawFileUrl(m.id, m.fileHash, { download: true, bin: fromBin }));

    if (!url) {
      body.showPlaceholder(summary.name, "This file has no readable address.");
      return;
    }

    // NO SIZE GATE, because with range-served blocks page 1 costs the blocks
    // page 1 is written in, whatever the file measures. The placeholder below
    // still catches the genuine failures — a corrupt file, an encrypted one, a
    // browser that cannot run the module.
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
      // MuPDF's sentence goes to the CONSOLE, not to the page: printing it
      // verbatim shows a household user "cannot find document handler for file
      // type: ''" where every neighbouring failure speaks the app's own voice.
      //
      // AND IT CANNOT TELL "encrypted" FROM "not a PDF" — nothing in the shim
      // calls `fz_needs_password`, so an encrypted file fails wherever it
      // happens to fail with whatever message MuPDF throws. Saying so properly
      // needs that probe in the ABI. The one distinction the app can stand
      // behind is the bytes never arrived, versus they arrived and would not
      // open.
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
    // PRIME FIND FROM THE ROUTE — a `?q=` deep link is how a global-search hit
    // on a PDF arrives here. AFTER the clamp, so the bar and the page agree
    // about where find has landed. A BIN origin carries no query (`router.ts`
    // drops it there), so this is a no-op for a trashed file rather than a
    // branch.
    find.setDocument(m.id, m.fileHash);
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
      if (first.height > 0) thumbs.setFirstAspect(first.width / first.height);
    } catch {
      // Keep the default; a strip of slightly wrong boxes beats no strip.
    }
    // THE OUTLINE, ONCE PER DOCUMENT: small, per document rather than per page,
    // and it does not change under the reader, so it is held for the document's
    // life unlike the words.
    //
    // NOT AWAITED, and a failure is a DIMMED OPENER rather than a broken page.
    // The `[]` case — a document with no outline, which is most of them —
    // arrives down the success path and lands in the same place.
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
    // The mark may already be in hand (it loads in parallel with the open), and
    // `pageCount` was zero until a moment ago — so the rail is computed here as
    // well as in `loadMark`, whichever of the two lands second.
    refreshInk();
    pagesPanel.setCurrent(pageIndex);
    // The FIRST moment the export menu can be honest about this document: its
    // whole-document row is gated on how many pages carry ink, clamped to
    // `pageCount`, which was zero until a few lines ago.
    downloads.refreshGroups();

    await renderer.paint();
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
