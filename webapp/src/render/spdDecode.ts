// The `.spd` DECODE CORE — no DOM, no viewer. The pure parse (bytes → layer tree
// + tiles), the geometry (bounding box, base dimensions), and the two injectable
// browser seams (the wasm loader and the tile PNG → bitmap decode).
//
// This lives OUTSIDE `pages/` on purpose: two consumers need it and only one is a
// page. The `.spd` VIEWER (`pages/spdViewer.ts`) renders it; the LIBRARY CARD's
// off-viewer `.spd` export (`export/spdModel.ts`) composites straight from bytes
// with no open viewer. When these primitives lived in `spdViewer.ts`, the export
// module — not a page — had to reach INTO `pages/` to get them; now both import
// down here and the dependency arrow points the right way.
//
// See `docs/reference/spd-format.md` and the ABI header in
// `webapp/wasm/spd_decode.zig`.

// ============================================================================
// The decoder C-ABI (see `webapp/wasm/spd_decode.zig`). Pointers are byte offsets
// into `memory`; every pointer must be RE-READ after the call that produced it
// (linear memory can grow) and copied out before the next call.
// ============================================================================

export interface SpdDecoderExports {
  memory: WebAssembly.Memory;
  /** WASI reactor: run libc/C constructors once before any `spd_*` call. */
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

/** One tile: its grid coordinate (absolute px = coord × 128) and its PNG bytes. */
export interface SpdTile {
  tx: number;
  ty: number;
  /** Copied OUT of wasm memory — ours to keep across `memory.grow`/`spd_close`. */
  png: Uint8Array;
}

/** A layer of the drawing. `visible`/`opacity` are the device-authored state. */
export interface SpdLayer {
  id: number;
  name: string;
  /** Authored visibility (`ls` field 4): the layers panel starts from this. */
  visible: boolean;
  /** 0..255 (`ls` field 8); ÷255 is the composite alpha. */
  opacity: number;
  tiles: SpdTile[];
}

/** A parsed `.spd`. `layers` are in Z-order — index 0 is TOPMOST. */
export interface SpdDoc {
  /** Device surface px (0 if the file omits it). */
  width: number;
  height: number;
  layers: SpdLayer[];
}

/** The tile bounding box across every layer, in grid coordinates. */
export interface SpdBbox {
  minTx: number;
  minTy: number;
  cols: number;
  rows: number;
}

/** The reserved Reference Layer (template/background) — commonly zero tiles. */
export const REFERENCE_LAYER_ID = 9999;
/** The `.spd` tile edge, in device px. Shared so an off-viewer compositor (the
 *  library card's `.spd` export, `export/spdModel.ts`) places tiles on the SAME
 *  grid the viewer's own render does. */
export const TILE = 128;
export const DEFAULT_WASM_URL = "/spd-decode.wasm";

const OPEN_ERRORS: Record<number, string> = {
  [-1]: "not a SQLite database",
  [-2]: "not an .spd file",
  [-3]: "the .spd is corrupt",
  [-4]: "the decoder ran out of memory",
  [-5]: "the layer tree is malformed",
  [-6]: "the .spd could not be read",
};

// ============================================================================
// The pure core — no DOM, no canvas, no network. Unit-tested.
// ============================================================================

/**
 * Parse a `.spd` through the decoder: copy the bytes in, open, read the whole
 * layer tree and every layer's tiles OUT of wasm memory, then close.
 *
 * WASM MEMORY LIFETIME (the one hazard). The entire `.spd` lives in wasm linear
 * memory only between `spd_open` and `spd_close`. We copy the input in, free it
 * the instant `spd_open` returns (it is copied inside), copy every layer name and
 * tile PNG into plain JS `Uint8Array`s, and `spd_close` in a `finally` — so the
 * decoder holds NOTHING once this returns, and the async tile-decoding that
 * follows never straddles an open document. Names and tile PNGs are copied
 * because each is valid only until the next decoder call.
 */
export function parseSpd(wasm: SpdDecoderExports, bytes: Uint8Array): SpdDoc {
  const inPtr = wasm.spd_alloc(bytes.length);
  if (inPtr === 0) throw new Error("spd_alloc failed (out of memory)");
  new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);

  const rc = wasm.spd_open(inPtr, bytes.length);
  // `spd_open` copied the input, so the source buffer is free immediately —
  // the file never has to sit in wasm memory twice.
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

/** Iterate one layer's tiles, copying each PNG out before advancing. */
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
    // The current tile PNG is valid only until the next `spd_tile_next`; copy now.
    png.set(new Uint8Array(wasm.memory.buffer, ptr, len));
    tiles.push({ tx: wasm.spd_tile_x(), ty: wasm.spd_tile_y(), png });
  }
  return tiles;
}

/**
 * The tile bounding box across ALL layers, in grid coordinates. `null` when
 * nothing is drawn (e.g. only an empty Reference Layer).
 *
 * The decoder does not expose `vp.x`/`vp.y`, and that is deliberate for a viewer:
 * we render the whole DRAWING rather than crop to the device's viewport. The
 * bbox's minimum tile is the render origin, so the strokes fill the canvas
 * wherever on the infinite grid the user drew them.
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

/** Base (unzoomed) canvas dimensions: the bbox in px, or the surface as fallback. */
export function spdBaseDims(doc: SpdDoc, bbox: SpdBbox | null): { w: number; h: number } {
  if (bbox) return { w: bbox.cols * TILE, h: bbox.rows * TILE };
  return { w: doc.width || 1404, h: doc.height || 1872 };
}

// ============================================================================
// The browser seams — the wasm loader and the tile decoder. Injectable.
// ============================================================================

/** A decoded tile the canvas can draw and we can release. */
export type TileBitmap = CanvasImageSource;

/** The default loader: fetch, instantiate (zero imports), run `_initialize`. */
export function browserLoader(wasmUrl: string): () => Promise<SpdDecoderExports> {
  let cached: Promise<SpdDecoderExports> | null = null;
  return () =>
    (cached ??= (async () => {
      const res = await fetch(wasmUrl);
      if (!res.ok) throw new Error(`failed to load ${wasmUrl}: ${res.status}`);
      let instance: WebAssembly.Instance;
      try {
        // Fast path: needs `Content-Type: application/wasm` from the server.
        ({ instance } = await WebAssembly.instantiateStreaming(res.clone(), {}));
      } catch {
        ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {}));
      }
      const exports = instance.exports as unknown as SpdDecoderExports;
      // Reactor model: run libc/C constructors (registers the null VFS) once.
      exports._initialize?.();
      return exports;
    })());
}

/** The default tile decoder: hand the PNG to the browser. */
export async function browserDecodeTile(png: Uint8Array): Promise<TileBitmap> {
  const blob = new Blob([png as BlobPart], { type: "image/png" });
  return await createImageBitmap(blob);
}

/**
 * The shared, memoised default decoder — the SAME wasm the viewer loads, so the
 * library card's off-viewer `.spd` export (`export/spdModel.ts`) does not stand
 * up a second decoder or a second wasm fetch. `browserLoader` caches its promise
 * internally, so every caller awaits one instantiation.
 */
const defaultSpdDecoder = browserLoader(DEFAULT_WASM_URL);
export function loadSpdDecoder(): Promise<SpdDecoderExports> {
  return defaultSpdDecoder();
}
/** The default tile PNG → bitmap decode, exported for the same off-viewer path. */
export function decodeSpdTile(png: Uint8Array): Promise<CanvasImageSource> {
  return browserDecodeTile(png);
}
