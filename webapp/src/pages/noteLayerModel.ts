// The `.note` layers' pure model: the SNPG v2 records read from a page's
// payload, paired with the device's `PageLayer[]`, named, and turned into the
// layers panel's rows and the layered export's model. No DOM, no wasm instance
// (a decoder's exports are passed in); the stack that draws them is
// `noteLayers.ts`.

import { LAYER_SLOTS, type LayerSlot, type PageLayer } from "../core/types";
import type { PanelLayer } from "./layersPanel";
import type { ExportWhich, LayeredExportModel } from "../export/layered";
import { filenameStem } from "../export/exporter";
import type { DecoderExports } from "../render/wasm";

export interface SnpgRecord {
  slot: LayerSlot;
  /** Flag bit1: excluded from the default composite. */
  hidden: boolean;
  /**
   * Flag bit2: an image background. `data` is then the template asset hash (not
   * RLE), drawn via `GET /note/{id}/template/{hash}`, never `decode_layer`.
   */
  rasterImage: boolean;
  data: Uint8Array;
}

export interface SnpgEnumeration {
  records: SnpgRecord[];
  width: number;
  height: number;
}

const FLAG_HIDDEN = 0b10; // bit1
const FLAG_RASTER_IMAGE = 0b100; // bit2

/**
 * Enumerate a payload's records via the wasm (the one SNPG parser lives in Zig).
 * Null for anything the stack cannot present, or a module without the enumerator.
 */
export function enumerateSnpg(wasm: DecoderExports, bytes: Uint8Array): SnpgEnumeration | null {
  const {
    snpg_enumerate: enumerate,
    snpg_width: widthOf,
    snpg_height: heightOf,
    snpg_record_slot: slotOf,
    snpg_record_flags: flagsOf,
    snpg_record_hash_ptr: hashPtrOf,
    snpg_record_hash_len: hashLenOf,
  } = wasm;
  if (
    typeof enumerate !== "function" ||
    typeof widthOf !== "function" ||
    typeof heightOf !== "function" ||
    typeof slotOf !== "function" ||
    typeof flagsOf !== "function" ||
    typeof hashPtrOf !== "function" ||
    typeof hashLenOf !== "function"
  ) {
    return null; // an older cached module without the enumerator
  }

  const inPtr = wasm.alloc(bytes.length);
  if (inPtr === 0) return null;
  new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
  const count = enumerate.call(wasm, inPtr, bytes.length);
  wasm.free(inPtr, bytes.length);
  if (count < 0) return null;

  const records: SnpgRecord[] = [];
  for (let i = 0; i < count; i++) {
    const slot = LAYER_SLOTS[slotOf.call(wasm, i)];
    if (slot === undefined) return null; // guarded, though Zig already rejected it
    const flags = flagsOf.call(wasm, i);
    const hashLen = hashLenOf.call(wasm, i);
    // Copy out now: the wasm's static buffer is reused by the next enumerate.
    const data =
      hashLen > 0
        ? new Uint8Array(wasm.memory.buffer, hashPtrOf.call(wasm, i), hashLen).slice()
        : new Uint8Array(0);
    records.push({
      slot,
      hidden: (flags & FLAG_HIDDEN) !== 0,
      rasterImage: (flags & FLAG_RASTER_IMAGE) !== 0,
      data,
    });
  }
  return { records, width: widthOf.call(wasm), height: heightOf.call(wasm) };
}

/** A wire record paired with its `LayerVO`; `index` (wire order, bottom-to-top) is the per-page id. */
export interface PairedLayer {
  index: number;
  record: SnpgRecord;
  vo: PageLayer;
}

/**
 * Pair records with `layers` by slot, not position, so a server ordering bug
 * degrades visibly (null) instead of mislabelling the panel.
 */
export function pairLayers(records: readonly SnpgRecord[], vos: readonly PageLayer[]): PairedLayer[] | null {
  if (records.length !== vos.length || records.length === 0) return null;
  const bySlot = new Map<LayerSlot, PageLayer>();
  for (const vo of vos) {
    if (bySlot.has(vo.slot)) return null;
    bySlot.set(vo.slot, vo);
  }
  const out: PairedLayer[] = [];
  for (const [index, record] of records.entries()) {
    const vo = bySlot.get(record.slot);
    if (!vo) return null;
    out.push({ index, record, vo });
  }
  return out;
}

/**
 * Wire positions of the records carrying visible ink, for flattening an overlay
 * (a `.mark` over a PDF). Drops the background slot (the document is the paper),
 * raster-image backgrounds and device-hidden records.
 */
export function inkRecordIndices(records: readonly SnpgRecord[]): number[] {
  return records.flatMap((r, i) =>
    r.slot === "background" || r.rasterImage || r.hidden ? [] : [i],
  );
}

/** Fallback names matching the device's own defaults. */
const SLOT_NAMES: Record<LayerSlot, string> = {
  main: "Main Layer",
  layer1: "Layer 1",
  layer2: "Layer 2",
  layer3: "Layer 3",
  background: "Background Layer",
};

export function layerDisplayName(vo: PageLayer): string {
  return vo.name || SLOT_NAMES[vo.slot];
}

/** One live layer; `visible` is view-only, seeded from the device's `vo.visible`. */
export interface NoteLayerView {
  index: number;
  slot: LayerSlot;
  name: string;
  /** Device-authored visibility: the export's `original` state. */
  authoredVisible: boolean;
  isCurrent: boolean;
  /** Live panel state: the export's `current` state. */
  visible: boolean;
  canvas: HTMLCanvasElement;
}

/** Top-first for the panel, with no `opacity` because `.note` layers have none. */
export function toPanelLayers(views: readonly NoteLayerView[]): PanelLayer[] {
  return [...views]
    .reverse()
    .map((v): PanelLayer => ({ id: v.index, name: v.name, visible: v.visible }));
}

/**
 * One `ExportLayer` per record, bottom-to-top, opacity 1 in both states. A
 * device-hidden layer is present but invisible in an "original" ORA. `canvases`
 * substitutes freshly decoded light-theme canvases by position.
 */
export function buildNoteExportModel(
  width: number,
  height: number,
  views: readonly NoteLayerView[],
  canvases?: readonly HTMLCanvasElement[],
): LayeredExportModel {
  return {
    width,
    height,
    layers: views.map((v, i) => ({
      id: v.index,
      name: v.name,
      canvas: canvases?.[i] ?? v.canvas,
      authored: { opacity: 1, visible: v.authoredVisible },
      current: { opacity: 1, visible: v.visible },
    })),
  };
}

/** `<stem>_p<page>_<which>.<ext>`, using the exporter's sanitiser. */
export function noteLayerExportFilename(
  noteName: string,
  pageIndex: number,
  which: ExportWhich,
  ext: "png" | "ora" | "pdf",
): string {
  return `${filenameStem(noteName)}_p${pageIndex + 1}_${which}.${ext}`;
}

