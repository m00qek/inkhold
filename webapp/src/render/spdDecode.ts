// The `.spd` decode core, shared by the viewer and the off-viewer card export:
// parse (bytes to layers and tiles), geometry, and the injectable browser
// seams. Format: `parsers/spd/spd-format.md`; ABI: `webapp/wasm/spd_decode.zig`.

// ---- decoder C-ABI ----
// Pointers are byte offsets into `memory`; re-read each after the call that
// produced it (memory can grow) and copy out before the next call.

export interface SpdDecoderExports {
  memory: WebAssembly.Memory;
  /** WASI reactor: run C constructors once before any `spd_*` call. */
  _initialize?(): void;
  spd_alloc(len: number): number;
  spd_free(ptr: number, len: number): void;
  spd_open(ptr: number, len: number): number;
  spd_close(): void;
  spd_doc_width(): number;
  spd_doc_height(): number;
  spd_layer_count(): number;
  spd_layer_id(i: number): number;
  spd_layer_visible(i: number): number;
  spd_layer_opacity(i: number): number;
  spd_layer_name_ptr(i: number): number;
  spd_layer_name_len(i: number): number;
  spd_tiles_begin(id: number): number;
  spd_tile_next(): number;
  spd_tile_x(): number;
  spd_tile_y(): number;
  spd_tile_png_ptr(): number;
  spd_tile_png_len(): number;
}

/** One tile: grid coordinate (absolute px = coord × 128) and its PNG bytes. */
export interface SpdTile {
  tx: number;
  ty: number;
  /** Copied out of wasm memory, so it survives `memory.grow`/`spd_close`. */
  png: Uint8Array;
}

export interface SpdLayer {
  id: number;
  name: string;
  /** Authored visibility (`ls` field 4). */
  visible: boolean;
  /** 0..255 (`ls` field 8). */
  opacity: number;
  tiles: SpdTile[];
}

/** A parsed `.spd`; `layers` index 0 is topmost. */
export interface SpdDoc {
  /** Device surface px (0 if the file omits it). */
  width: number;
  height: number;
  layers: SpdLayer[];
}

export interface SpdBbox {
  minTx: number;
  minTy: number;
  cols: number;
  rows: number;
}

/** The reserved Reference Layer (template/background), commonly tile-less. */
export const REFERENCE_LAYER_ID = 9999;
/** The `.spd` tile edge, in device px. */
export const TILE = 128;
export const DEFAULT_WASM_URL = "/sqlite-core.wasm";

const OPEN_ERRORS: Record<number, string> = {
  [-1]: "not a SQLite database",
  [-2]: "not an .spd file",
  [-3]: "the .spd is corrupt",
  [-4]: "the decoder ran out of memory",
  [-5]: "the layer tree is malformed",
  [-6]: "the .spd could not be read",
};

// ---- pure core ----

/**
 * Parse a `.spd`: copy the bytes in, read the layer tree and every tile out,
 * then `spd_close` in a `finally`, so the decoder holds nothing on return.
 */
export function parseSpd(wasm: SpdDecoderExports, bytes: Uint8Array): SpdDoc {
  const inPtr = wasm.spd_alloc(bytes.length);
  if (inPtr === 0) throw new Error("spd_alloc failed (out of memory)");
  new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);

  const rc = wasm.spd_open(inPtr, bytes.length);
  // `spd_open` copied the input; free it now.
  wasm.spd_free(inPtr, bytes.length);
  if (rc !== 0) throw new Error(`spd_open failed: ${OPEN_ERRORS[rc] ?? `code ${rc}`}`);

  try {
    const width = wasm.spd_doc_width();
    const height = wasm.spd_doc_height();
    const count = wasm.spd_layer_count();
    const dec = new TextDecoder();
    const layers: SpdLayer[] = [];
    for (let i = 0; i < count; i++) {
      const id = wasm.spd_layer_id(i);
      const namePtr = wasm.spd_layer_name_ptr(i);
      const nameLen = wasm.spd_layer_name_len(i);
      const name =
        namePtr === 0 || nameLen === 0
          ? ""
          : dec.decode(new Uint8Array(wasm.memory.buffer, namePtr, nameLen).slice());
      layers.push({
        id,
        name,
        visible: wasm.spd_layer_visible(i) === 1,
        opacity: wasm.spd_layer_opacity(i),
        tiles: readTiles(wasm, id),
      });
    }
    return { width, height, layers };
  } finally {
    wasm.spd_close();
  }
}

function readTiles(wasm: SpdDecoderExports, id: number): SpdTile[] {
  const rc = wasm.spd_tiles_begin(id);
  if (rc < 0) throw new Error(`spd_tiles_begin(${id}) failed: code ${rc}`);
  const tiles: SpdTile[] = [];
  for (;;) {
    const r = wasm.spd_tile_next();
    if (r === 0) break;
    if (r < 0) throw new Error(`spd_tile_next failed: code ${r}`);
    const ptr = wasm.spd_tile_png_ptr();
    const len = wasm.spd_tile_png_len();
    const png = new Uint8Array(len);
    png.set(new Uint8Array(wasm.memory.buffer, ptr, len));
    tiles.push({ tx: wasm.spd_tile_x(), ty: wasm.spd_tile_y(), png });
  }
  return tiles;
}

/**
 * The tile bounding box across all layers, or null when nothing is drawn. The
 * whole drawing is rendered, not the device viewport, so its minimum is the origin.
 */
export function spdBbox(doc: SpdDoc): SpdBbox | null {
  let minTx = Infinity;
  let minTy = Infinity;
  let maxTx = -Infinity;
  let maxTy = -Infinity;
  for (const layer of doc.layers) {
    for (const t of layer.tiles) {
      if (t.tx < minTx) minTx = t.tx;
      if (t.ty < minTy) minTy = t.ty;
      if (t.tx > maxTx) maxTx = t.tx;
      if (t.ty > maxTy) maxTy = t.ty;
    }
  }
  if (!Number.isFinite(minTx)) return null;
  return { minTx, minTy, cols: maxTx - minTx + 1, rows: maxTy - minTy + 1 };
}

export function spdBaseDims(doc: SpdDoc, bbox: SpdBbox | null): { w: number; h: number } {
  if (bbox) return { w: bbox.cols * TILE, h: bbox.rows * TILE };
  return { w: doc.width || 1404, h: doc.height || 1872 };
}

// ---- browser seams ----

export type TileBitmap = CanvasImageSource;

/** Fetch, instantiate (zero imports), run `_initialize`. */
export function browserLoader(wasmUrl: string): () => Promise<SpdDecoderExports> {
  let cached: Promise<SpdDecoderExports> | null = null;
  return () =>
    (cached ??= (async () => {
      const res = await fetch(wasmUrl);
      if (!res.ok) throw new Error(`failed to load ${wasmUrl}: ${res.status}`);
      let instance: WebAssembly.Instance;
      try {
        // Needs `Content-Type: application/wasm` from the server.
        ({ instance } = await WebAssembly.instantiateStreaming(res.clone(), {}));
      } catch {
        ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {}));
      }
      const exports = instance.exports as unknown as SpdDecoderExports;
      exports._initialize?.();
      return exports;
    })());
}

export async function browserDecodeTile(png: Uint8Array): Promise<TileBitmap> {
  const blob = new Blob([png as BlobPart], { type: "image/png" });
  return await createImageBitmap(blob);
}

/** The memoised default decoder, shared with the card export (one wasm fetch). */
const defaultSpdDecoder = browserLoader(DEFAULT_WASM_URL);
export function loadSpdDecoder(): Promise<SpdDecoderExports> {
  return defaultSpdDecoder();
}
export function decodeSpdTile(png: Uint8Array): Promise<CanvasImageSource> {
  return browserDecodeTile(png);
}
