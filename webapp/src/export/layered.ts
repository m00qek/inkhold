// The format-neutral layered export core: per-layer canvases plus each layer's
// two states (`current` live tuning, `original` as authored) to a flat PNG or an
// OpenRaster (.ora) zip. A format without per-layer opacity (`.note`) writes 1.

import { writeStoredZip, type ZipEntry } from "./zip";

/** Which per-layer state an export reads: the live tuning, or the file as authored. */
export type ExportWhich = "current" | "original";

/** One layer's visibility and opacity (0..1) at one moment. */
export interface LayerState {
  opacity: number;
  visible: boolean;
}

export interface ExportLayer {
  id: number;
  /** May be empty; exports then name it `Layer <id>`, matching the panel. */
  name: string;
  canvas: HTMLCanvasElement;
  authored: LayerState;
  current: LayerState;
}

/** An export snapshot: page dimensions and the layers bottom-to-top. */
export interface LayeredExportModel {
  width: number;
  height: number;
  layers: ExportLayer[];
}

function stateOf(layer: ExportLayer, which: ExportWhich): LayerState {
  return which === "current" ? layer.current : layer.authored;
}

// ---- flat PNG ----

/** Overridable in tests. */
export type CanvasFactory = (w: number, h: number) => HTMLCanvasElement;

const domCanvasFactory: CanvasFactory = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

function canvasToBlob(
  canvas: { toBlob(cb: (b: Blob | null) => void, type?: string): void },
  type: string,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))), type);
  });
}

/**
 * Flatten the visible layers bottom-to-top with their opacity. Omit `background`
 * for a transparent PNG; pass `"#ffffff"` for an alpha-less target (PDF
 * /DeviceGray), where transparent pixels would otherwise gray to black.
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

/** Flat PNG with no background, so hidden layers leave transparency. */
export async function exportFlatPng(
  model: LayeredExportModel,
  which: ExportWhich,
  makeCanvas: CanvasFactory = domCanvasFactory,
): Promise<Blob> {
  return canvasToBlob(flattenLayers(model, which, {}, makeCanvas), "image/png");
}

// ---- layered ORA (OpenRaster) ----

function xmlEscape(s: string): string {
  return s.replace(
    /[&<>'"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[ch]!,
  );
}

/** The ORA `stack.xml`: top-first, so the bottom-to-top model is reversed. */
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

/** OpenRaster: a stored zip whose first entry is an uncompressed `mimetype`. */

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
