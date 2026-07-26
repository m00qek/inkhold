// Build a `.spd` export model straight from its bytes — WITHOUT an open viewer.
//
// The `.spd` DOWNLOAD offered on a LIBRARY CARD (Flat image, Layered image) needs
// the same {@link LayeredExportModel} the spdViewer hands to the export matrix —
// but a card has no rendered layer stack to snapshot, because nothing has opened
// the file. This assembles that stack from the raw bytes using the viewer's OWN
// decode primitives (`parseSpd` + the shared wasm decoder + `decodeSpdTile`), so
// there is no second decoder and no second copy of the tile→canvas geometry: this
// mirrors `spdViewer.ts`'s `render()` compositing exactly, one level up. The
// actual PNG/ORA encoding is unchanged — it stays in `export/layered.ts`, reached
// through `spdExport.ts`; this only produces the model those functions consume.
//
// `current` is set equal to `authored`: a card has no live layer tuning to differ
// from the file as saved, so both states are the sketch as its author left it.

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
 * Decode a `.spd` and composite each layer onto its own base-res canvas, then
 * return the export snapshot with layers BOTTOM-to-TOP (the order the export core
 * draws in). Returns `null` when the file has no layers. Throws on a decode
 * failure — the caller guards it (a toast, never a wedge).
 */
export async function buildSpdExportModel(bytes: Uint8Array): Promise<LayeredExportModel | null> {
  const wasm = await loadSpdDecoder();
  // parseSpd copies everything out and closes the decoder; after it the `.spd`
  // occupies no wasm memory.
  const doc = parseSpd(wasm, bytes);
  if (doc.layers.length === 0) return null;

  const bbox = spdBbox(doc);
  const base = spdBaseDims(doc, bbox);
  const originX = bbox ? bbox.minTx * TILE : 0;
  const originY = bbox ? bbox.minTy * TILE : 0;

  // doc.layers is Z-order, index 0 TOPMOST — the same order the viewer holds. The
  // export core wants BOTTOM-to-TOP, so we reverse after compositing.
  const layers: ExportLayer[] = [];
  for (const layer of doc.layers) {
    const canvas = document.createElement("canvas");
    canvas.width = base.w; // BASE resolution — not × devicePixelRatio.
    canvas.height = base.h;
    const ctx = canvas.getContext("2d");
    // The Reference Layer with zero tiles is the sole white base; everything else
    // stays transparent so a hidden layer reveals what is under it.
    if (ctx && layer.id === REFERENCE_LAYER_ID && layer.tiles.length === 0) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, base.w, base.h);
    }
    for (const t of layer.tiles) {
      const bmp = await decodeSpdTile(t.png);
      if (ctx) ctx.drawImage(bmp, t.tx * TILE - originX, t.ty * TILE - originY);
      // The pixels are on the layer canvas now — release the decoded bitmap.
      (bmp as { close?: () => void }).close?.();
    }
    const state = { opacity: layer.opacity / 255, visible: layer.visible };
    layers.push({ id: layer.id, name: layer.name, canvas, authored: state, current: { ...state } });
  }
  layers.reverse();
  return { width: base.w, height: base.h, layers };
}
