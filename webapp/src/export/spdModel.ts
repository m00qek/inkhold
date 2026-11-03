// Build a `.spd` export model from raw bytes, for a library card with no open
// viewer. Reuses the viewer's decode primitives and mirrors its compositing;
// `current` equals `authored` since a card has no live tuning.

import {
  parseSpd,
  spdBbox,
  spdBaseDims,
  loadSpdDecoder,
  decodeSpdTile,
  REFERENCE_LAYER_ID,
  TILE,
} from "../render/spdDecode";
import type { ExportLayer, LayeredExportModel } from "./layered";

/**
 * Composite each layer onto its own base-res canvas, bottom-to-top. Null when
 * there are no layers; throws on a decode failure.
 */
export async function buildSpdExportModel(bytes: Uint8Array): Promise<LayeredExportModel | null> {
  const wasm = await loadSpdDecoder();
  // parseSpd copies everything out and frees the wasm decoder.
  const doc = parseSpd(wasm, bytes);
  if (doc.layers.length === 0) return null;

  const bbox = spdBbox(doc);
  const base = spdBaseDims(doc, bbox);
  const originX = bbox ? bbox.minTx * TILE : 0;
  const originY = bbox ? bbox.minTy * TILE : 0;

  // doc.layers is index 0 topmost; reversed after compositing.
  const layers: ExportLayer[] = [];
  for (const layer of doc.layers) {
    const canvas = document.createElement("canvas");
    canvas.width = base.w; // base resolution, not × devicePixelRatio
    canvas.height = base.h;
    const ctx = canvas.getContext("2d");
    // A tile-less Reference Layer is the sole white base; the rest stay transparent.
    if (ctx && layer.id === REFERENCE_LAYER_ID && layer.tiles.length === 0) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, base.w, base.h);
    }
    for (const t of layer.tiles) {
      const bmp = await decodeSpdTile(t.png);
      if (ctx) ctx.drawImage(bmp, t.tx * TILE - originX, t.ty * TILE - originY);
      (bmp as { close?: () => void }).close?.();
    }
    const state = { opacity: layer.opacity / 255, visible: layer.visible };
    layers.push({ id: layer.id, name: layer.name, canvas, authored: state, current: { ...state } });
  }
  layers.reverse();
  return { width: base.w, height: base.h, layers };
}
