// The `.spd` (Atelier layered drawing) viewer. A `.spd` is a SQLite database of
// PNG tiles on a sparse 128×128 grid, one `surface_<id>` table per layer, plus a
// protobuf layer tree (see `parsers/spd/spd-format.md`). Each layer gets its own
// base-resolution canvas drawn once; opacity, visibility and zoom are pure CSS.

import { el } from "../../ui/dom";
import { bytesBudget } from "../../api/client";
import type { NoteMeta, NoteSummary } from "../../core/types";
import { formatBytes, rawFileUrl, historyFileUrl } from "../../core/fileKind";
import { createToolbar } from "../toolbar";
import { svg, VIEWER_IC } from "../viewer/viewerIcons";
import { createZoomStepper, FIT_PAGE } from "../viewer/viewerControls";
import { createViewerExportMenu } from "../viewer/viewerExportMenu";
import { backWord, createViewerHeader, createViewerBody, createVersionBanner } from "../viewer/viewerChrome";
import { createBinViewerActions } from "../../ui/binViewerActions";
import { createLayersPanel, type PanelLayer } from "../layersPanel";
import { exportSpdPng, exportSpdOra, type ExportWhich } from "./spdExport";
import type { ExportLayer, LayeredExportModel } from "../../export/layered";
import { parseSpd, spdBbox, spdBaseDims, browserLoader, browserDecodeTile, REFERENCE_LAYER_ID, TILE, DEFAULT_WASM_URL, type SpdDecoderExports, type SpdDoc, type SpdLayer, type SpdBbox, type TileBitmap } from "../../render/spdDecode";
import type { ReaderOrigin, Viewer, ViewerDeps } from "../viewer/viewer";
import { buildThumb } from "./spdThumbs";

// ---- render model ----

/** `current` is view-only, never written back, and resets to authored on open. */
export interface LayerView {
  layer: SpdLayer; // authored; opacity 0..255
  canvas: HTMLCanvasElement; // base-res, drawn once; also the thumbnail source
  current: { opacity: number; visible: boolean }; // opacity 0..1
}

export type SpdExportLayer = ExportLayer;
export type SpdExportModel = LayeredExportModel;

export interface SpdViewerOptions {
  wasmUrl?: string;
  loader?: () => Promise<SpdDecoderExports>;
  decodeTile?: (png: Uint8Array) => Promise<TileBitmap>;
}

const ZOOMS = [FIT_PAGE, "100%", "150%"] as const;

export function createSpdViewer(deps: ViewerDeps, opts: SpdViewerOptions = {}): Viewer {
  const loadDecoder = opts.loader ?? browserLoader(opts.wasmUrl ?? DEFAULT_WASM_URL);
  const decodeTile = opts.decodeTile ?? browserDecodeTile;

  let meta: NoteMeta | null = null;
  /** A trashed file's bytes are served only on the bin-scoped route. */
  let fromBin = false;
  /** A history preview's bytes come off `historyFileUrl`; the live route serves only the current blob. */
  let previewVersion: { md5: string; createdAt: number } | null = null;
  /** Trashed version preview: no Restore, bytes off the bin-scoped history route. */
  let previewViewOnly = false;

  const header = createViewerHeader({
    classes: { back: "viewer__back", backLabel: "viewer__back-label", title: "viewer__title" },
    onBack: () => deps.onBack(),
  });
  const back = header.back;
  const title = header.title;

  // Icon-only by explicit design; `class: "btn"` because the active-state rule is
  // `.toolbar .btn[aria-pressed]`.
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

  // Own readout class: a shared `.zoom` would match several mounted viewers.
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

  const exportMenu = createViewerExportMenu({ toast: deps.toast, className: "viewer__export" });
  const rawItem = exportMenu.rawItem("Atelier sketch", ".spd");

  function exportBaseName(): string {
    const name = meta?.name ?? "sketch";
    return name.replace(/\.spd$/i, "") || "sketch";
  }

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
    html: svg(VIEWER_IC.trash, 1.8) + '<span class="btn__label">Move to bin</span>',
  });
  moveBin.addEventListener("click", () => {
    if (meta) deps.onMoveToBin?.(meta);
  });
  // Shown instead of Move to bin for a bin-origin open.
  const binActions = createBinViewerActions({
    getMeta: () => meta,
    onRestore: deps.onRestore,
    onPurge: deps.onPurge,
    onHistory: deps.onVersions ? (m, anchor) => deps.onVersions!(m, anchor, undefined) : undefined,
  });
  // Shown only in a history preview (and from the bin).
  const versionsBtn = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Version history",
    title: "Version history",
    html: svg(VIEWER_IC.restore, 1.7),
  });
  versionsBtn.addEventListener("click", () => {
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
      { kind: "custom", key: "layers", el: layersToggle, focus: [layersToggle], fold: true },
    ],
    file: [
      { kind: "custom", key: "versions", el: versionsBtn, focus: [versionsBtn] },
      { kind: "custom", key: "download-file", el: exportMenu.el, focus: [exportMenu.trigger] },
      { kind: "custom", key: "move-bin", el: moveBin, focus: [moveBin] },
      { kind: "custom", key: "bin-actions", el: binActions.el, focus: [binActions.trigger] },
    ],
  });

  const versionBanner = createVersionBanner({
    onRestore: () => {
      if (meta && previewVersion) deps.onRestoreVersion?.(meta, previewVersion);
    },
  });

  const viewerBody = createViewerBody({ mark: "SPD" });
  const main = viewerBody.main;

  // The wrap is the zoom surface and the checkerboard backdrop for transparency.
  const canvasWrap = el("div", { class: "spd-canvas-wrap" });
  const stage = el("div", { class: "spd-stage" }, canvasWrap);
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
  const body = el("div", { class: "spd-body", hidden: true }, stage, layersPanel.el);

  const root = el(
    "section",
    { class: "viewer viewer--spd", "aria-label": "Sketch viewer", hidden: true },
    toolbar.el,
    versionBanner.el,
    main,
    body,
  );

  let doc: SpdDoc | null = null;
  let bbox: SpdBbox | null = null;
  /** Z-order, index 0 = topmost (mirrors `doc.layers`). */
  let layerViews: LayerView[] = [];
  let zoomIdx = 0;
  let panelOpen = false;
  /** Bumped on every open/hide/destroy so a stale async render cannot paint. */
  let renderToken = 0;
  /**
   * The in-flight download, aborted wherever `renderToken` bumps: a token stops
   * the paint but not the bytes, and a `.spd` is the largest thing the app fetches.
   */
  let load: AbortController | null = null;

  /** Zero each canvas's backing store eagerly (base-res layers can be ~10 MB each). */
  function releaseRender(): void {
    canvasWrap.replaceChildren();
    for (const v of layerViews) {
      v.canvas.width = 0;
      v.canvas.height = 0;
    }
    layerViews = [];
  }

  function applyLayerStyle(v: LayerView): void {
    v.canvas.style.opacity = String(v.current.opacity);
    v.canvas.style.display = v.current.visible ? "" : "none";
  }
  function setLayerVisible(id: number, visible: boolean): void {
    const v = layerViews.find((x) => x.layer.id === id);
    if (!v) return;
    v.current.visible = visible;
    v.canvas.style.display = visible ? "" : "none";
  }
  function setLayerOpacity(id: number, opacity01: number): void {
    const v = layerViews.find((x) => x.layer.id === id);
    if (!v) return;
    v.current.opacity = Math.max(0, Math.min(1, opacity01));
    v.canvas.style.opacity = String(v.current.opacity);
  }

  /** Export snapshot, bottom-to-top; `current` is captured live. */
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

  function showLoading(name: string): void {
    showBody(false);
    viewerBody.showPlaceholder(name, "Opening this .spd sketch…");
  }

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

  function baseDims(): { w: number; h: number } {
    return doc ? spdBaseDims(doc, bbox) : { w: 1404, h: 1872 };
  }

  function zoomScale(): number {
    const z = ZOOMS[zoomIdx]!;
    if (z !== FIT_PAGE) return Number.parseInt(z, 10) / 100;
    const { w, h } = baseDims();
    const rect = stage.getBoundingClientRect();
    const availW = Math.max(rect.width - 48, 64);
    const availH = Math.max(rect.height - 48, 64);
    return Math.min(1, availW / w, availH / h) || 1;
  }

  function applyZoom(): void {
    if (!doc) return;
    const scale = zoomScale();
    const { w, h } = baseDims();
    canvasWrap.style.width = `${Math.max(1, Math.round(w * scale))}px`;
    canvasWrap.style.height = `${Math.max(1, Math.round(h * scale))}px`;
  }

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

  function onResize(): void {
    if (!doc || zoomIdx !== 0) return;
    applyZoom();
  }
  window.addEventListener("resize", onResize);

  /**
   * Never rejects. Each tile is drawn once onto its layer canvas and `.close()`d
   * immediately, so at most one decoded bitmap is held at a time. Only a tileless
   * Reference Layer gets a white fill; everything else stays transparent.
   */
  async function render(m: NoteMeta, signal: AbortSignal): Promise<void> {
    const token = renderToken;
    try {
      const url = previewVersion
        ? historyFileUrl(m.id, previewVersion.md5, { bin: previewViewOnly })
        : rawFileUrl(m.id, m.fileHash, { bin: fromBin });
      if (url === null) {
        showError(m.name, "This .spd has no stored contents to preview yet.");
        return;
      }
      // The signal covers `arrayBuffer()` too; `bytesBudget` adds the stall timeout.
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

      // parseSpd copies everything out and closes the decoder.
      const parsed = parseSpd(wasm, bytes);
      if (token !== renderToken) return;

      const parsedBbox = spdBbox(parsed);
      const base = spdBaseDims(parsed, parsedBbox);
      const originX = parsedBbox ? parsedBbox.minTx * TILE : 0;
      const originY = parsedBbox ? parsedBbox.minTy * TILE : 0;

      // Not committed until every layer is done, so an abort just drops `views`.
      const views: LayerView[] = [];
      for (const layer of parsed.layers) {
        const canvas = el("canvas", { class: "spd-layer-canvas" }) as HTMLCanvasElement;
        canvas.width = base.w; // base resolution, not × devicePixelRatio
        canvas.height = base.h;
        const ctx = canvas.getContext("2d"); // null in jsdom/happy-dom
        if (ctx && layer.id === REFERENCE_LAYER_ID && layer.tiles.length === 0) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, base.w, base.h);
        }
        for (const t of layer.tiles) {
          const bmp = await decodeTile(t.png);
          if (token !== renderToken) {
            (bmp as { close?: () => void }).close?.();
            return;
          }
          if (ctx) ctx.drawImage(bmp, t.tx * TILE - originX, t.ty * TILE - originY);
          (bmp as { close?: () => void }).close?.();
        }
        views.push({
          layer,
          canvas,
          current: { opacity: layer.opacity / 255, visible: layer.visible },
        });
      }
      if (token !== renderToken) return;

      // Append bottom-to-top so `doc.layers[0]` (topmost) is last in the DOM.
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
      renderToken++;
      const token = renderToken;
      // Before the `metaPromise` await, so a re-open during it cancels this one.
      load?.abort();
      const ctl = new AbortController();
      load = ctl;
      releaseRender();
      doc = null;
      bbox = null;
      // Clear `meta` until the new one lands: the shell skips `hide()` between two
      // files of the same type, and Move to bin would otherwise trash the old file.
      meta = null;
      setPanelOpen(false);
      zoomIdx = 0;
      zoomStepper.set(0);

      header.setName(summary.name);
      header.setSubtitle(summary.fileType.toUpperCase());
      header.setBackWord(backWord(origin));
      fromBin = origin.kind === "bin";
      previewVersion = origin.kind === "history" ? (origin.version ?? null) : null;
      const previewing = previewVersion !== null;
      previewViewOnly = previewing && origin.viewOnly === true;
      moveBin.hidden = fromBin || previewing;
      versionsBtn.hidden = !previewing && !fromBin;
      binActions.setBinMode(fromBin, fromBin ? origin.retention ?? null : null);
      versionBanner.setVersion(previewVersion, previewViewOnly);
      rawItem.setHref(
        previewing
          ? historyFileUrl(summary.id, previewVersion!.md5, { download: true, bin: previewViewOnly })
          : rawFileUrl(summary.id, summary.fileHash, { download: true, bin: fromBin }),
      );
      exportMenu.setOpen(false);

      // A `.spd` publishes its URL once: the bin form, or the version form; a live
      // open's bare URL already stands.
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

      void render(next, ctl.signal);
    },

    hide(): void {
      root.hidden = true;
      exportMenu.setOpen(false);
      renderToken++;
      load?.abort();
      load = null;
      releaseRender();
      doc = null;
      bbox = null;
      meta = null;
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

  // Exposed for unit tests only, without widening `Viewer`.
  (viewer as unknown as { _spdSeam: SpdViewerSeam })._spdSeam = {
    layerViews: () => layerViews,
    setLayerVisible,
    setLayerOpacity,
    exportModel,
  };
  return viewer;
}

export interface SpdViewerSeam {
  layerViews: () => LayerView[];
  setLayerVisible: (id: number, visible: boolean) => void;
  setLayerOpacity: (id: number, opacity01: number) => void;
  exportModel: () => SpdExportModel | null;
}
