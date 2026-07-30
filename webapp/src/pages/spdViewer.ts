// The `.spd` viewer — Supernote's Atelier layered-drawing format. A `.spd` is a
// SQLite database of PNG tiles on a sparse 128×128 grid, one `surface_<id>` table
// per layer, plus a protobuf layer tree. This module DECODES it (the shared
// parser, compiled to `spd-decode.wasm`) and renders it as a STACK OF PER-LAYER
// CANVASES: the WASM extracts, the browser rasterises (`createImageBitmap`) each
// tile once onto its layer's own canvas, and the browser compositor blends the
// stack. See `docs/reference/spd-format.md` and the ABI header in
// `webapp/wasm/spd_decode.zig`.
//
// THE RENDER MODEL (a light compositor you tune before exporting). Every layer
// gets its OWN `<canvas>` at base resolution (the bbox in px — NOT × DPR, so
// N canvases stay memory-bounded), drawn once and never re-rastered. Opacity is
// `canvas.style.opacity`, visibility is `style.display`, zoom is a CSS resize of
// the wrapper (canvases are `width/height:100%`). Transparency falls out: the
// only white is the Reference Layer's own canvas, over the wrapper's checkerboard,
// so hiding it makes the drawing see-through. Each layer carries two states —
// `authored` (from the `.spd`) and `current` (mutable, view-only, reset on open).
//
// THE SEAM (exposed inside `createSpdViewer`): `layerViews` +
// `setLayerVisible`/`setLayerOpacity` feed the SHARED layers panel
// (`layersPanel.ts`) through a thin adapter, and `exportModel()` returns
// {@link SpdExportModel} — the shared layered-export model (`export/layered.ts`)
// under its `.spd` name — for `spdExport.ts`. Both components were extracted
// from this viewer so the `.note` reader can reuse them
// (docs/scratch/archive/note-layers-panel.md); the format-specific parts stay here:
// the wasm `spd_layer_*` state, the 0..255 wire opacity, and the Reference
// Layer special case.
//
// THE PURE CORE stays GPU-free and unit-tested: `parseSpd` (bytes → layer tree +
// tiles), `spdBbox` (the drawing's tile bounding box) and `spdBaseDims` (the base
// canvas size). The DOM/canvas painting below them is thin and exercised in e2e
// against the real fixture. Both the wasm loader and the tile decoder are
// injectable so the whole viewer can run without a real GPU or a network.

import { el } from "../ui/dom";
import { bytesBudget } from "../api/client";
import type { NoteMeta, NoteSummary } from "../core/types";
import { formatBytes, rawFileUrl, historyFileUrl } from "../core/fileKind";
import { createToolbar } from "./toolbar";
import { svg, VIEWER_IC, backWord, createViewerHeader, createZoomStepper, createViewerExportMenu, createViewerBody, createVersionBanner } from "./viewerChrome";
import { createBinViewerActions } from "../ui/binViewerActions";
import { createLayersPanel, type PanelLayer } from "./layersPanel";
import { exportSpdPng, exportSpdOra, type ExportWhich } from "./spdExport";
import type { ExportLayer, LayeredExportModel } from "../export/layered";
import { drawDownscaledInto } from "../render/thumbnails";
import {
  parseSpd,
  spdBbox,
  spdBaseDims,
  browserLoader,
  browserDecodeTile,
  REFERENCE_LAYER_ID,
  TILE,
  DEFAULT_WASM_URL,
  type SpdDecoderExports,
  type SpdDoc,
  type SpdLayer,
  type SpdBbox,
  type TileBitmap,
} from "../render/spdDecode";
import type { ReaderOrigin, Viewer, ViewerDeps } from "./viewer";

// ============================================================================
// THE SEAM — the render model's exported shape. The viewer owns
// `LayerView`/`setLayerVisible`/`setLayerOpacity`/`layerViews` (internal,
// driven by the shared layers panel) and `exportModel()` returning the shared
// layered-export model (consumed by `spdExport.ts` → `export/layered.ts`).
// ============================================================================

/**
 * One layer's live view: its own base-res canvas (drawn once — also the panel's
 * thumbnail source), the authored state (`layer.visible`/`layer.opacity`) and the
 * mutable `current` state the panel tunes. `current` is view-only and never
 * written back to the `.spd`; it resets to authored on each open.
 */
export interface LayerView {
  layer: SpdLayer; // authored: layer.visible, layer.opacity (0..255)
  canvas: HTMLCanvasElement; // base-res, drawn once; the thumbnail source
  current: { opacity: number; visible: boolean }; // opacity 0..1
}

/**
 * The export snapshot types are the SHARED layered-export model now
 * (src/export/layered.ts — the extraction note-layers-panel.md decides); the
 * `.spd`-named aliases remain because they are this viewer's seam vocabulary:
 * one layer with both states (opacity normalised to 0..1), and the snapshot
 * with base dimensions and the layers BOTTOM-to-TOP.
 */
export type SpdExportLayer = ExportLayer;
export type SpdExportModel = LayeredExportModel;

// ============================================================================
// The browser seams — the wasm loader and the tile decoder — moved to the decode
// core (`render/spdDecode.ts`) so the off-viewer export shares them. The viewer's
// injectable option shape stays here.
// ============================================================================

export interface SpdViewerOptions {
  /** URL of the decoder wasm. Default `/spd-decode.wasm`. */
  wasmUrl?: string;
  /** Override module loading (tests). Default fetches + instantiates `wasmUrl`. */
  loader?: () => Promise<SpdDecoderExports>;
  /** Override tile PNG → bitmap (tests). Default `createImageBitmap`. */
  decodeTile?: (png: Uint8Array) => Promise<TileBitmap>;
}

const ZOOMS = ["Fit", "100%", "150%"] as const;

// ============================================================================
// The `.spd` THUMB PAINTER. The panel itself (rows, eyes, opacity steppers,
// hold-to-ramp) is the shared component now (`layersPanel.ts` — extracted per
// docs/scratch/archive/note-layers-panel.md); what stays here is the one thing only the
// `.spd` side knows: how a layer's pixels become a preview, including the blank
// Reference Layer special case.
// ============================================================================

/** The per-layer thumbnail's BACKING height, in device px — ~2× the CSS box
 *  height (the `--preview-h-panel` class, 14-layers-panel.css) so the preview
 *  stays crisp on a retina display. The backing WIDTH follows the drawing's own
 *  aspect (height is design, aspect is data), capped at the class's 2.5×-height
 *  clamp so a pathologically wide drawing letterboxes instead of wrecking the
 *  row; CSS then scales the whole canvas from its fixed box height. */
const THUMB_H = 202;
const THUMB_MAX_ASPECT = 2.5;

/** The drawing's aspect for a layer's preview box, clamped to the width cap;
 *  portrait 3:4 when the layer canvas has no dimensions to speak of. */
function thumbAspect(v: LayerView): number {
  const cw = v.canvas.width;
  const ch = v.canvas.height;
  if (cw <= 0 || ch <= 0) return 3 / 4;
  return Math.min(cw / ch, THUMB_MAX_ASPECT);
}

/**
 * A per-layer thumbnail: THAT layer's own canvas, scaled to fit the box on a
 * white sheet (drawn once, from the already-rastered pixels — never re-drawn on
 * an opacity/visibility change). A blank Reference Layer (id 9999, no tiles) has
 * nothing to preview, so it gets an empty white box instead of a canvas.
 */
function buildThumb(v: LayerView, isBlankRef: boolean): HTMLElement {
  const aspect = thumbAspect(v);
  if (isBlankRef) {
    // No canvas to derive a width from — carry the drawing's aspect inline so
    // the empty frame matches its siblings' shape (CSS falls back to 3:4).
    const blank = el("div", { class: "spd-layer__thumb spd-layer__thumb--blank", "aria-hidden": "true" });
    blank.style.aspectRatio = String(aspect);
    return blank;
  }
  const thumb = el("canvas", { class: "spd-layer__thumb", "aria-hidden": "true" }) as HTMLCanvasElement;
  const thumbW = Math.max(1, Math.round(THUMB_H * aspect));
  thumb.width = thumbW;
  thumb.height = THUMB_H;
  const ctx = thumb.getContext("2d"); // null in jsdom/happy-dom — the canvas still exists.
  const cw = v.canvas.width;
  const ch = v.canvas.height;
  if (ctx && cw > 0 && ch > 0) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, thumbW, THUMB_H);
    // The backing already carries the drawing's aspect, so the fit is exact —
    // the min() only letterboxes when the 2.5× width cap clamped `aspect`. The
    // ~9× reduction goes through the SHARED quality downscale, not a single
    // bilinear `drawImage` step — the sheet fill above holds the box stable
    // until the async draw lands (see drawDownscaledInto).
    const scale = Math.min(thumbW / cw, THUMB_H / ch);
    const dw = Math.max(1, Math.round(cw * scale));
    const dh = Math.max(1, Math.round(ch * scale));
    const dx = Math.round((thumbW - dw) / 2);
    const dy = Math.round((THUMB_H - dh) / 2);
    void drawDownscaledInto(ctx, v.canvas, dw, dh, dx, dy);
  }
  return thumb;
}

export function createSpdViewer(deps: ViewerDeps, opts: SpdViewerOptions = {}): Viewer {
  const loadDecoder = opts.loader ?? browserLoader(opts.wasmUrl ?? DEFAULT_WASM_URL);
  const decodeTile = opts.decodeTile ?? browserDecodeTile;

  let meta: NoteMeta | null = null;
  /**
   * The sketch was opened FROM the recycle bin. Held because the raw fetch and
   * the raw-`.spd` download run after `open()` returns, and a trashed file's
   * bytes live only on the bin-scoped route — the live URL 404s (see
   * `rawFileUrl`'s `bin` option).
   */
  let fromBin = false;
  /**
   * The sketch was opened as a PAST VERSION (history preview). Mirrors `fromBin`:
   * the raw fetch and the raw-`.spd` download must then come off the version-scoped
   * `historyFileUrl` route (the version's md5), not the live `/file/:id?v=` one —
   * the live route only ever serves the CURRENT blob. `previewVersion` carries the
   * md5 + stamp the banner and Restore need after `open()` returns.
   */
  let previewVersion: { md5: string; createdAt: number } | null = null;
  /**
   * The previewed version's file is TRASHED (view-only). The banner's Restore is
   * suppressed and the version's raw bytes come off the BIN-scoped history route
   * (`historyFileUrl(…, { bin: true })`) — the live history route 404s for a
   * trashed file, exactly as `/file/:id?v=` does.
   */
  let previewViewOnly = false;

  // --- leading: Back + title (outside the two toolbar zones) ---------------
  const header = createViewerHeader({
    classes: { back: "viewer__back", backLabel: "viewer__back-label", title: "viewer__title" },
    onBack: () => deps.onBack(),
  });
  const back = header.back;
  const title = header.title;

  // --- view zone: zoom (− [Fit] +) then the layers toggle -------------------
  // A raster is zoomed by percentage, and the layers panel is opened by a toggle
  // that wears the toolbar's open-panel active look off its own `aria-pressed`/
  // `aria-expanded` (see `10-toolbar.css`) — nothing per-viewer to style.
  //
  // Layers is ICON-ONLY: it keeps `class: "btn"` (the active-state rule is
  // `.toolbar .btn[aria-pressed]`, not `.icon-btn`) but drops its text label,
  // carried by `aria-label` + `title` — the exact treatment the reader's OCR
  // toggle uses (`reader.ts`). Don't restore the label.
  const layersToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-expanded": "false",
    "aria-controls": "spd-layers-panel",
    "aria-label": "Layers",
    title: "Layers",
    html: svg(VIEWER_IC.layers, 1.7),
  }) as HTMLButtonElement;

  // OWN readout class (`spd-zoom`), not the reader's bare `.zoom`: every viewer is
  // mounted at once (hidden), so sharing `.zoom` would make a bare `.zoom` test
  // locator resolve to two elements. The stub's `.viewer__*` classes exist for the
  // same reason. 12-spd-viewer.css restyles it to the same treatment as `.zoom`.
  const zoomStepper = createZoomStepper({
    readoutClass: "spd-zoom",
    initial: 0,
    format: (i: number) => ZOOMS[i]!,
    onStep: (dir) => {
      zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, zoomIdx + dir));
      applyZoom();
      return zoomIdx;
    },
  });

  // --- the universal (right) zone: Download menu + Move to bin -------------
  // Download is a MENU TRIGGER (mirroring the reader's `exportMenu`): icon-only,
  // `aria-label`/`title` "Download", `aria-haspopup`/`aria-expanded`, its
  // open/active look driven off `aria-expanded` by the shared `.menu*` CSS
  // (06-reader.css) + the toolbar's `.btn[aria-expanded]` rule (10-toolbar.css).
  // The popover offers {Flat PNG, Layered ORA} × {current, original} — flattened
  // through `exportModel()` + `spdExport.ts` — plus the raw `.spd` (unchanged
  // bytes).
  // The shared, in-flow export menu mechanics (viewerChrome.ts): trigger +
  // popover, the menu-item/guard/outside-click+Escape plumbing. Only the CONTENT
  // is `.spd`-specific — {Flat PNG, Layered ORA} × {current, original} flattened
  // through `exportModel()` + `spdExport.ts`, plus the raw `.spd` row.
  const exportMenu = createViewerExportMenu({ toast: deps.toast, className: "viewer__export" });
  // The raw-`.spd` row — its href minted per open (`null` when the file has no
  // stored bytes, which disables the row).
  const rawItem = exportMenu.rawItem("Atelier sketch", ".spd");

  /** The download-file basename: the note name with any trailing `.spd` dropped. */
  function exportBaseName(): string {
    const name = meta?.name ?? "sketch";
    return name.replace(/\.spd$/i, "") || "sketch";
  }

  /** Hand a generated blob to the browser as a download, then release the URL. */
  function saveBlob(filename: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /** Build one flattened export (PNG or ORA) in the chosen state, then save it. */
  function runFlatten(kind: "png" | "ora", which: ExportWhich): () => Promise<void> {
    return async () => {
      const model = exportModel();
      if (!model) return;
      const blob = kind === "png" ? await exportSpdPng(model, which) : await exportSpdOra(model, which);
      saveBlob(`${exportBaseName()}_${which}.${kind}`, blob);
    };
  }

  exportMenu.pop.append(
    el("div", { class: "menu__head", text: "Current view" }),
    exportMenu.item("Flattened image", ".png", runFlatten("png", "current")),
    exportMenu.item("Layered image", ".ora", runFlatten("ora", "current")),
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "Original view" }),
    exportMenu.item("Flattened image", ".png", runFlatten("png", "original")),
    exportMenu.item("Layered image", ".ora", runFlatten("ora", "original")),
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "Original file" }),
    rawItem.el,
  );

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
  // The BIN-ORIGIN controls, swapped in for Move to bin when the sketch is open
  // from the recycle bin (`toolbar.md`'s context swap — see `open()`; mirrors the
  // reader). The SAME `|— retention —| ⋯` cluster the bin ROW shows, built by the
  // shared `createBinViewerActions`: Restore neutral, Delete permanently the one
  // red item, its confirm carried through `onPurge` to the bin controller.
  const binActions = createBinViewerActions({
    getMeta: () => meta,
    onRestore: deps.onRestore,
    onPurge: deps.onPurge,
    // Card parity: the bin's "Version history" row opens the same view-only panel
    // the Versions control does, anchored to the "…" trigger. Only wired when the
    // shell can open history at all — no dead row otherwise.
    onHistory: deps.onVersions ? (m, anchor) => deps.onVersions!(m, anchor, undefined) : undefined,
  });
  // The "Versions" control, shown ONLY in a history preview — the raw-viewer
  // mirror of the reader's toolbar button: reopen the version list to pick another
  // version, routed through the SAME `deps.onVersions` the reader and the card ⋯
  // menu use (never a second panel). Icon-only with the `restore` glyph, exactly
  // as the reader's does.
  const versionsBtn = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Version history",
    title: "Version history",
    html: svg(VIEWER_IC.restore, 1.7),
  });
  versionsBtn.addEventListener("click", () => {
    // Shown only while previewing, so `previewVersion` is set — anchor the panel to
    // this button and mark the on-screen version's row `Viewing`.
    if (meta) deps.onVersions?.(meta, versionsBtn, previewVersion?.md5);
  });

  const toolbar = createToolbar({
    label: "Sketch viewer",
    viewLabel: "Sketch controls",
    fileLabel: "File actions",
    className: "viewer__bar",
    leading: [{ el: back, focus: [back] }, { el: title }],
    view: [
      { kind: "custom", key: "zoom", el: zoomStepper.el, focus: zoomStepper.focus },
      { kind: "custom", key: "layers", el: layersToggle, focus: [layersToggle] },
    ],
    file: [
      // Shown only in a history preview (mutually exclusive with Move to bin and
      // the bin cluster) — the reopen-the-list control, before the download menu.
      { kind: "custom", key: "versions", el: versionsBtn, focus: [versionsBtn] },
      { kind: "custom", key: "download-file", el: exportMenu.el, focus: [exportMenu.trigger] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      // The bin-origin cluster (mutually exclusive with Move to bin): the
      // retention countdown then the "…" menu, whose one focusable is its trigger.
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });

  // The "previewing an older version" banner (history mode), the shared chrome
  // the note reader uses — Restore routes through `deps.onRestoreVersion`, the one
  // confirm+restore path (`runRestore`/`confirmRestore`) the reader and the list
  // already share, so a `.spd` preview cannot reach restore around it.
  const versionBanner = createVersionBanner({
    onRestore: () => {
      if (meta && previewVersion) deps.onRestoreVersion?.(meta, previewVersion);
    },
  });

  // --- the placeholder body (loading / error / honest empty states) --------
  // The shared `.viewer__main`/`.viewer__placeholder` card (viewerChrome.ts); the
  // RENDERED drawing lives in a separate `.spd-body` below, and `showBody` toggles
  // between them.
  const viewerBody = createViewerBody({ mark: "SPD" });
  const main = viewerBody.main;

  // --- the rendered body: layers panel beside the scrollable canvas stage --
  // The wrap is the ZOOM SURFACE and the transparency backdrop: it holds one
  // absolutely-positioned canvas per layer (each `width/height:100%`), so zoom is
  // a CSS resize of the wrap alone and its checkerboard shows through wherever a
  // layer is hidden or transparent. Filled per-open by `render`.
  const canvasWrap = el("div", { class: "spd-canvas-wrap" });
  const stage = el("div", { class: "spd-stage" }, canvasWrap);
  // The SHARED layers panel (layersPanel.ts), fed from this viewer's wasm-decoded
  // layer state. The `.spd` side supplies: the hook namespace (`spd-layers`/
  // `spd-layer__…`, which its tests and the blank-thumb rule select on), the
  // toggle/opacity callbacks mapping onto the canvas stack, and the thumb painter
  // — including the blank Reference Layer special case, which is `.spd` knowledge
  // the shared component deliberately does not have.
  const layersPanel = createLayersPanel({
    id: "spd-layers-panel",
    hookPrefix: "spd",
    onToggle: (id, visible) => setLayerVisible(id, visible),
    onOpacity: (id, opacity01) => setLayerOpacity(id, opacity01),
    paintThumb: (pl) => {
      const v = layerViews.find((x) => x.layer.id === pl.id);
      if (!v) return el("div", { class: "spd-layer__thumb--blank", "aria-hidden": "true" });
      const isBlankRef = v.layer.id === REFERENCE_LAYER_ID && v.layer.tiles.length === 0;
      return buildThumb(v, isBlankRef);
    },
  });
  // The panel docks to the RIGHT of the stage (stage first, panel second), like the
  // reader's "Recognized text" aside sits right of the page — see 14-layers-panel.css.
  const body = el("div", { class: "spd-body", hidden: true }, stage, layersPanel.el);

  const root = el(
    "section",
    { class: "viewer viewer--spd", "aria-label": "Sketch viewer", hidden: true },
    toolbar.el,
    versionBanner.el,
    main,
    body,
  );

  // --- render state --------------------------------------------------------
  let doc: SpdDoc | null = null;
  let bbox: SpdBbox | null = null;
  /**
   * THE SEAM. One entry per layer in Z-order (index 0 = topmost, mirroring
   * `doc.layers`). Each holds the layer's own drawn canvas + its mutable
   * `current` state. The panel feeder reads this and calls the mutators below.
   */
  let layerViews: LayerView[] = [];
  let zoomIdx = 0;
  let panelOpen = false;
  /** Bumps on every open/hide/destroy so a stale async render aborts + cannot paint. */
  let renderToken = 0;
  /**
   * The in-flight whole-blob download, so a superseded one can be CANCELLED and
   * not merely ignored.
   *
   * `renderToken` already makes a late response unpaintable, and that was read as
   * the whole of the problem — but a `.spd` is the biggest single thing this app
   * ever fetches, and a token cannot make bytes stop arriving. Leaving a note and
   * opening another meant the abandoned sketch went on downloading in full,
   * competing for one of the browser's ~6 connections with the file the user had
   * just asked for. `txtViewer` has threaded a signal since it was written; this
   * is the same seam, aborted at the same three points (`open`, `hide`,
   * `destroy`) that bump the token.
   */
  let load: AbortController | null = null;

  /**
   * Drop every layer canvas and empty the wrapper — a hidden/re-opened viewer
   * holds no decoded pixels. Zeroing each backing store frees it eagerly rather
   * than waiting for GC (the canvases are base-res and can be ~10 MB each).
   */
  function releaseRender(): void {
    canvasWrap.replaceChildren();
    for (const v of layerViews) {
      v.canvas.width = 0;
      v.canvas.height = 0;
    }
    layerViews = [];
  }

  // --- THE SEAM: live mutation the shared panel's callbacks drive ----------
  /** Apply a view's `current` state to its canvas (opacity + visibility). */
  function applyLayerStyle(v: LayerView): void {
    v.canvas.style.opacity = String(v.current.opacity);
    v.canvas.style.display = v.current.visible ? "" : "none";
  }
  /** Show/hide a layer live — updates `current` and the canvas. */
  function setLayerVisible(id: number, visible: boolean): void {
    const v = layerViews.find((x) => x.layer.id === id);
    if (!v) return;
    v.current.visible = visible;
    v.canvas.style.display = visible ? "" : "none";
  }
  /** Set a layer's opacity live (0..1, clamped) — updates `current` and the canvas. */
  function setLayerOpacity(id: number, opacity01: number): void {
    const v = layerViews.find((x) => x.layer.id === id);
    if (!v) return;
    v.current.opacity = Math.max(0, Math.min(1, opacity01));
    v.canvas.style.opacity = String(v.current.opacity);
  }

  /**
   * THE SEAM: the export snapshot (`spdExport.ts` → the shared core). Layers
   * BOTTOM-to-TOP (reverse of `layerViews`) with both states; `null` when nothing
   * is loaded. `current` is captured live, so tune-then-export works in-session.
   */
  function exportModel(): SpdExportModel | null {
    if (!doc || layerViews.length === 0) return null;
    const { w, h } = baseDims();
    const layers: SpdExportLayer[] = [];
    for (let i = layerViews.length - 1; i >= 0; i--) {
      const v = layerViews[i]!;
      layers.push({
        id: v.layer.id,
        name: v.layer.name,
        canvas: v.canvas,
        authored: { opacity: v.layer.opacity / 255, visible: v.layer.visible },
        current: { opacity: v.current.opacity, visible: v.current.visible },
      });
    }
    return { width: w, height: h, layers };
  }

  function showBody(rendered: boolean): void {
    main.hidden = rendered;
    body.hidden = !rendered;
  }

  /** The loading placeholder (mark + name), replaced by the render or an error. */
  function showLoading(name: string): void {
    showBody(false);
    viewerBody.showPlaceholder(name, "Opening this .spd sketch…");
  }

  /** An honest failure that still names the file and the type (mark stays SPD). */
  function showError(name: string, message: string): void {
    showBody(false);
    viewerBody.showPlaceholder(name, message);
  }

  function setPanelOpen(open: boolean): void {
    panelOpen = open;
    layersPanel.el.hidden = !open;
    layersToggle.setAttribute("aria-pressed", String(open));
    layersToggle.setAttribute("aria-expanded", String(open));
  }
  layersToggle.addEventListener("click", () => setPanelOpen(!panelOpen));

  /** Base (unzoomed) canvas size for the current doc/bbox. */
  function baseDims(): { w: number; h: number } {
    return doc ? spdBaseDims(doc, bbox) : { w: 1404, h: 1872 };
  }

  /** The scale for the current zoom step. `Fit` fits the drawing to the stage. */
  function zoomScale(): number {
    const z = ZOOMS[zoomIdx]!;
    if (z !== "Fit") return Number.parseInt(z, 10) / 100;
    const { w, h } = baseDims();
    const rect = stage.getBoundingClientRect();
    const availW = Math.max(rect.width - 48, 64);
    const availH = Math.max(rect.height - 48, 64);
    return Math.min(1, availW / w, availH / h) || 1;
  }

  /**
   * Apply the current zoom by RESIZING THE WRAP only — the layer canvases are
   * `width/height:100%`, so the browser scales the whole stack in one GPU pass;
   * there is no per-zoom re-raster (that is the point of the stacked model).
   */
  function applyZoom(): void {
    if (!doc) return;
    const scale = zoomScale();
    const { w, h } = baseDims();
    canvasWrap.style.width = `${Math.max(1, Math.round(w * scale))}px`;
    canvasWrap.style.height = `${Math.max(1, Math.round(h * scale))}px`;
  }

  /**
   * Feed the shared panel: each layer (Z-order, top first) becomes a
   * {@link PanelLayer} carrying the CURRENT state — the component seeds each
   * row's eye, stepper value and disabled interlock from it, so a re-open
   * (which resets `current` to authored) rebuilds the rows correctly. `.spd`
   * layers always carry `opacity` (0..1 here, 0..255 on the wire), which is
   * what makes the stepper render — a `.note` feeder will omit it.
   */
  function buildLayersPanel(): void {
    layersPanel.setLayers(
      layerViews.map(
        (v): PanelLayer => ({
          id: v.layer.id,
          name: v.layer.name,
          visible: v.current.visible,
          opacity: v.current.opacity,
        }),
      ),
    );
  }

  // Re-fit while the drawing is fitted to the stage and the window resizes.
  function onResize(): void {
    if (!doc || zoomIdx !== 0) return;
    applyZoom();
  }
  window.addEventListener("resize", onResize);

  /**
   * Decode the `.spd` and build the per-layer canvas stack. Guarded by
   * `renderToken` so a hide/re-open mid-flight can neither paint over the next
   * file nor leak bitmaps. Never rejects — failures land on the honest error
   * placeholder or the session sink.
   *
   * Each tile PNG is decoded, drawn ONCE onto its layer's base-res canvas at its
   * bbox-relative pixel origin, then `.close()`d immediately — the pixels live on
   * the canvas from then on, so at most one decoded bitmap is held at a time and
   * a mid-flight abort only has that one to release. The Reference Layer (id 9999)
   * with no tiles is the ONLY white fill; every other empty region stays
   * transparent so the wrapper's checkerboard shows through.
   */
  async function render(m: NoteMeta, signal: AbortSignal): Promise<void> {
    const token = renderToken;
    try {
      // History preview fetches the VERSION's bytes off the version-scoped route
      // (its md5), not the live `/file/:id?v=` — which would hand back the current
      // blob. Otherwise the live/bin raw route, exactly as before.
      const url = previewVersion
        ? historyFileUrl(m.id, previewVersion.md5, { bin: previewViewOnly })
        : rawFileUrl(m.id, m.fileHash, { bin: fromBin });
      if (url === null) {
        showError(m.name, "This .spd has no stored contents to preview yet.");
        return;
      }
      // The signal covers the whole download: an abort mid-`arrayBuffer()` rejects
      // it too, so a hide/re-open stops the transfer rather than waiting it out.
      // `bytesBudget` folds in the shared byte timeout, so a STALLED transfer
      // ends in the honest failure below instead of an open-ended wait.
      const budget = bytesBudget(signal);
      let res: Response;
      try {
        res = await fetch(url, { signal: budget.signal });
      } finally {
        budget.done();
      }
      if (res.status === 401 || res.status === 403) {
        deps.onSessionExpired();
        return;
      }
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (token !== renderToken) return;

      const wasm = await loadDecoder();
      if (token !== renderToken) return;

      // parseSpd copies everything out and closes the decoder — after this line
      // the `.spd` no longer occupies any wasm memory.
      const parsed = parseSpd(wasm, bytes);
      if (token !== renderToken) return;

      const parsedBbox = spdBbox(parsed);
      const base = spdBaseDims(parsed, parsedBbox);
      const originX = parsedBbox ? parsedBbox.minTx * TILE : 0;
      const originY = parsedBbox ? parsedBbox.minTy * TILE : 0;

      // Build one base-res canvas per layer, drawing + closing each tile as it
      // decodes. Not committed to `layerViews`/the DOM until every layer is done,
      // so an abort simply discards these (GC) after releasing the in-hand bitmap.
      const views: LayerView[] = [];
      for (const layer of parsed.layers) {
        const canvas = el("canvas", { class: "spd-layer-canvas" }) as HTMLCanvasElement;
        canvas.width = base.w; // BASE resolution — NOT × devicePixelRatio.
        canvas.height = base.h;
        const ctx = canvas.getContext("2d"); // null in jsdom/happy-dom — still tracked.
        // The Reference Layer with zero tiles is the sole white base; anything
        // else stays transparent so hiding it reveals the checkerboard.
        if (ctx && layer.id === REFERENCE_LAYER_ID && layer.tiles.length === 0) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, base.w, base.h);
        }
        for (const t of layer.tiles) {
          const bmp = await decodeTile(t.png);
          if (token !== renderToken) {
            (bmp as { close?: () => void }).close?.();
            return; // uncommitted `views` canvases are dropped by GC.
          }
          if (ctx) ctx.drawImage(bmp, t.tx * TILE - originX, t.ty * TILE - originY);
          // The pixels are on the layer canvas now — release the decoded bitmap.
          (bmp as { close?: () => void }).close?.();
        }
        views.push({
          layer,
          canvas,
          current: { opacity: layer.opacity / 255, visible: layer.visible },
        });
      }
      if (token !== renderToken) return;

      // Commit: drop the previous file's canvases, adopt this stack. Append the
      // canvases BOTTOM-to-TOP so `doc.layers[0]` (topmost) is last in the DOM.
      releaseRender();
      doc = parsed;
      bbox = parsedBbox;
      layerViews = views;
      for (let i = views.length - 1; i >= 0; i--) {
        const v = views[i]!;
        applyLayerStyle(v);
        canvasWrap.append(v.canvas);
      }
      zoomIdx = 0;
      zoomStepper.set(0);
      buildLayersPanel();
      showBody(true);
      applyZoom();
    } catch {
      if (token !== renderToken) return;
      showError(m.name, "Couldn't open this .spd sketch. You can still download the original.");
    }
  }

  const viewer: Viewer = {
    el: root,

    async open(summary: NoteSummary, metaPromise: Promise<NoteMeta>, _page: number, origin: ReaderOrigin, _query: string): Promise<void> {
      root.hidden = false;
      // A new open aborts any prior in-flight render and drops its layer canvases.
      renderToken++;
      const token = renderToken;
      // …and cancels its download. Created BEFORE the `metaPromise` await below,
      // so a re-open during that window cancels this one too.
      load?.abort();
      const ctl = new AbortController();
      load = ctl;
      releaseRender();
      doc = null;
      bbox = null;
      setPanelOpen(false);
      zoomIdx = 0;
      zoomStepper.set(0);

      header.setName(summary.name);
      header.setSubtitle(summary.fileType.toUpperCase());
      header.setBackWord(backWord(origin));
      // THE CONTEXT SWAP (`toolbar.md`): a live sketch's file action is Move to
      // bin; one open FROM the bin is already trashed, so it gets Restore and
      // Delete permanently instead; a HISTORY preview is read-only with just
      // Restore-this-version on the banner (no bin controls, no Move to bin) and a
      // Versions control to reopen the list. `hidden` drops whichever sides are off
      // from the roving tabindex for free.
      fromBin = origin.kind === "bin";
      previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
      const previewing = previewVersion !== null;
      // A view-only (trashed) history preview: no per-version Restore, and the raw
      // bytes come off the bin-scoped history route.
      previewViewOnly = previewing && origin.viewOnly === true;
      moveBin.hidden = fromBin || previewing;
      // Versions — shown in a history PREVIEW and, now, from the BIN: a trashed
      // sketch's version history is view-only but browsable (bin-parity.md). Still
      // hidden on a plain live open (its entry point is the card ⋯ menu).
      versionsBtn.hidden = !previewing && !fromBin;
      binActions.setBinMode(fromBin, fromBin ? origin.retention ?? null : null);
      // The banner carries Restore EXCEPT in a view-only (trashed) preview, where
      // it is the WHEN alone.
      versionBanner.setVersion(previewVersion, previewViewOnly);
      // The raw-`.spd` menu row is the one non-transformed option; disable it when
      // the file has no stored bytes to hand back. The menu itself always shows —
      // the transformed exports run off the live render, not this URL. Bin origin
      // mints the bin-scoped route (the live one 404s for trashed); a history
      // preview mints the version-scoped route so the download is the VERSION's
      // bytes, not the current blob — and a TRASHED file's version off the
      // bin-scoped history route.
      rawItem.setHref(
        previewing
          ? historyFileUrl(summary.id, previewVersion!.md5, { download: true, bin: previewViewOnly })
          : rawFileUrl(summary.id, summary.fileHash, { download: true, bin: fromBin }),
      );
      exportMenu.setOpen(false);

      // URL SYNC. A `.spd` has no page or find query to refine, so its whole URL
      // sync is asserting its address once on open — the raw mirror of the reader's
      // per-page `syncUrl`. A BIN-origin open publishes the deep `#/bin/note/:id`
      // form (the `bin` flag): a trashed sketch's blob is not at the live
      // `#/note/:id` route, so a reload of that would 404 to the library. A history
      // PREVIEW publishes the version md5 (`#/note/:id/version/:short`). A LIVE open
      // has neither and nothing to publish — its bare note URL already stands.
      if (fromBin) deps.onPosition?.(summary.id, 0, "", undefined, true);
      else if (previewVersion) deps.onPosition?.(summary.id, 0, "", previewVersion.md5);

      showLoading(summary.name);
      back.focus();

      let next: NoteMeta;
      try {
        next = await metaPromise;
      } catch (e) {
        if (renderToken !== token) return;
        showError("Couldn’t read this file", "The file metadata couldn’t be loaded.");
        return;
      }
      
      if (renderToken !== token) return;
      meta = next;
      header.setSubtitle(`${next.fileType.toUpperCase()} · ${formatBytes(next.size)}`);

      // Kick the async decode/render. It never rejects (its own try/catch),
      // and the token guard makes a late completion a no-op after hide/re-open.
      void render(next, ctl.signal);
    },

    hide(): void {
      root.hidden = true;
      exportMenu.setOpen(false);
      // Abort any in-flight render and drop the layer canvases — a hidden viewer
      // holds no pixels, and the decoder was already closed in parseSpd. The
      // token stops the paint; the controller stops the download.
      renderToken++;
      load?.abort();
      load = null;
      releaseRender();
      doc = null;
      bbox = null;
      meta = null;
      // Leave history mode: a reused instance opening a LIVE sketch next must not
      // carry over the version banner or the version-scoped raw route.
      previewVersion = null;
      previewViewOnly = false;
    },

    destroy(): void {
      renderToken++;
      load?.abort();
      load = null;
      releaseRender();
      window.removeEventListener("resize", onResize);
      exportMenu.destroy();
    },
  };

  // THE SEAM, exposed for the unit tests (and only them) WITHOUT widening the
  // fixed `Viewer` type: the panel feeder and the export menu live inside this
  // module and call the closures directly, but the tests drive them from outside.
  (viewer as unknown as { _spdSeam: SpdViewerSeam })._spdSeam = {
    layerViews: () => layerViews,
    setLayerVisible,
    setLayerOpacity,
    exportModel,
  };
  return viewer;
}

/** The internal seam handle the unit tests reach through (see `_spdSeam`). */
export interface SpdViewerSeam {
  layerViews: () => LayerView[];
  setLayerVisible: (id: number, visible: boolean) => void;
  setLayerOpacity: (id: number, opacity01: number) => void;
  exportModel: () => SpdExportModel | null;
}
