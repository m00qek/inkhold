// The LAYERED EXPORT core, shared across file formats — pure given a
// {@link LayeredExportModel}: it takes a viewer's per-layer canvases plus each
// layer's two states and returns download blobs. NO viewer/DOM coupling beyond
// a canvas factory (injectable for tests), so it unit-tests against fake
// canvases without a real GPU.
//
// Extracted from the `.spd` export (pages/spdExport.ts, now the `.spd` adapter)
// so the `.note` reader's layer work can reuse the whole matrix — the reason is
// `docs/scratch/archive/note-layers-panel.md` §Exports. The core is format-neutral by
// construction; a format adapter only has to fill the model:
//   - `.spd`: opacity is the wire's 0..255 normalised to 0..1; `current` is the
//     live panel tuning, `authored` the file's own state.
//   - `.note` (future): NO per-layer opacity exists — the adapter writes
//     `opacity: 1` in both states (the ORA then carries `opacity='1.00'`).
//     "Original" = LAYERINFO-authored visibility: a device-hidden layer is
//     PRESENT in the ORA with its full pixels, marked invisible — the file's
//     own semantics. Page dims are whatever the format says (landscape
//     1872×1404 included); nothing here assumes a portrait page.
//
// Two shapes, each in `current` (live panel tuning) or `original` (as authored)
// flavour:
//   - FLAT PNG — flatten the visible layers onto one export canvas, honouring
//     per-layer opacity, NO background fill (hiding the base yields a transparent
//     PNG — the whole point of the transparency model).
//   - LAYERED ORA — OpenRaster: a STORED (uncompressed) zip of `mimetype`,
//     `stack.xml` (opacity/visibility live here, not baked into the pixels) and
//     one `data/layer_<id>.png` per layer with the layer's FULL pixels. Opens
//     in Krita/GIMP.

import { writeStoredZip, type ZipEntry } from "./zip";

/** Which per-layer state an export reads: the live tuning, or the file as authored. */
export type ExportWhich = "current" | "original";

/**
 * The state of one layer at one moment: shown or not, and how opaque (0..1).
 * A format without per-layer opacity (`.note`) resolves it to 1 — the panel
 * side (pages/layersPanel.ts `PanelLayer`) models that same absence as an
 * omitted `opacity`, which is what keeps the two models one story.
 */
export interface LayerState {
  opacity: number;
  visible: boolean;
}

/** One layer in an export snapshot: identity, its full pixels, both states. */
export interface ExportLayer {
  id: number;
  /** May be empty — exports then name it `Layer <id>`, matching the panel. */
  name: string;
  /** That layer's own rendered pixels (the viewer's per-layer canvas). */
  canvas: HTMLCanvasElement;
  authored: LayerState;
  current: LayerState;
}

/** An export snapshot: page dimensions and the layers BOTTOM-to-TOP. */
export interface LayeredExportModel {
  width: number;
  height: number;
  layers: ExportLayer[];
}

/** The chosen state (opacity 0..1, visibility) for a layer. */
function stateOf(layer: ExportLayer, which: ExportWhich): LayerState {
  return which === "current" ? layer.current : layer.authored;
}

// ============================================================================
// Flat PNG
// ============================================================================

/** Makes the single export canvas the flatten draws onto. Overridable in tests. */
export type CanvasFactory = (w: number, h: number) => HTMLCanvasElement;

const domCanvasFactory: CanvasFactory = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

/** Promise wrapper over the callback `toBlob`, rejecting when the browser hands back null. */
function canvasToBlob(
  canvas: { toBlob(cb: (b: Blob | null) => void, type?: string): void },
  type: string,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))), type);
  });
}

/**
 * Flatten the model onto ONE `width × height` canvas, BOTTOM-to-TOP, honouring
 * the chosen state's opacity and skipping layers hidden in that state. Returns
 * the CANVAS, so a caller can turn it into a PNG (transparency preserved) or read
 * its pixels for another target (the reader's per-page PDF grays it).
 *
 * `background` fills the canvas before the layers draw — omit it for a
 * transparent PNG (the whole point of the transparency model: a base-hidden model
 * yields see-through pixels), pass `"#ffffff"` for a target with no alpha (PDF's
 * /DeviceGray), where an unfilled canvas would gray its transparent pixels to
 * black.
 */
export function flattenLayers(
  model: LayeredExportModel,
  which: ExportWhich,
  opts: { background?: string } = {},
  makeCanvas: CanvasFactory = domCanvasFactory,
): HTMLCanvasElement {
  const canvas = makeCanvas(model.width, model.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2d context for the export canvas");
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, model.width, model.height);
  }
  for (const layer of model.layers) {
    const st = stateOf(layer, which);
    if (!st.visible) continue;
    ctx.globalAlpha = st.opacity;
    ctx.drawImage(layer.canvas, 0, 0);
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/**
 * Flatten the model onto ONE `width × height` export canvas, BOTTOM-to-TOP,
 * honouring the chosen state's opacity and skipping layers hidden in that state.
 * No background is filled — transparency is preserved wherever no visible layer
 * covers a pixel, so an all-hidden or base-hidden model yields a transparent PNG.
 */
export async function exportFlatPng(
  model: LayeredExportModel,
  which: ExportWhich,
  makeCanvas: CanvasFactory = domCanvasFactory,
): Promise<Blob> {
  return canvasToBlob(flattenLayers(model, which, {}, makeCanvas), "image/png");
}

// ============================================================================
// Layered ORA (OpenRaster)
// ============================================================================

/** Escape the five XML-significant characters in a layer name. */
function xmlEscape(s: string): string {
  return s.replace(
    /[&<>'"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[ch]!,
  );
}

/**
 * The ORA `stack.xml`. OpenRaster stacks are TOP-first, so the layers (model is
 * bottom-to-top) are emitted in reverse. Opacity/visibility come from the chosen
 * state; the pixels in `data/layer_<id>.png` are the full, untouched layer.
 */
export function buildStackXml(model: LayeredExportModel, which: ExportWhich): string {
  const lines: string[] = [
    "<?xml version='1.0' encoding='UTF-8'?>",
    `<image w='${model.width}' h='${model.height}'>`,
    " <stack>",
  ];
  for (let i = model.layers.length - 1; i >= 0; i--) {
    const layer = model.layers[i]!;
    const st = stateOf(layer, which);
    const name = xmlEscape(layer.name || `Layer ${layer.id}`);
    lines.push(
      `  <layer name='${name}' src='data/layer_${layer.id}.png' ` +
        `opacity='${st.opacity.toFixed(2)}' visibility='${st.visible ? "visible" : "hidden"}' ` +
        `composite-op='svg:src-over'/>`,
    );
  }
  lines.push(" </stack>", "</image>");
  return lines.join("\n");
}

/**
 * The OpenRaster blob: a STORED zip whose FIRST entry is an uncompressed
 * `mimetype` = `image/openraster` (the spec's magic), then `stack.xml`, then one
 * PNG per layer under `data/`.
 */
export async function exportOra(model: LayeredExportModel, which: ExportWhich): Promise<Blob> {
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: "mimetype", data: enc.encode("image/openraster") },
    { name: "stack.xml", data: enc.encode(buildStackXml(model, which)) },
  ];
  for (const layer of model.layers) {
    const blob = await canvasToBlob(layer.canvas, "image/png");
    entries.push({ name: `data/layer_${layer.id}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return new Blob([writeStoredZip(entries) as BlobPart], { type: "image/openraster" });
}
