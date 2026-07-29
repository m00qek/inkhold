// The real `NoteRenderer` (P5) — the WASM `.note` page decoder behind the render
// seam. It takes one page's SNPG bytes (from `Api.getPageBytes`), runs them
// through the freestanding `note-decode.wasm` module (built from
// `webapp/wasm/note_decode.zig`; see docs/wasm-note-decoder.md), and wraps the
// resulting RGBA into an `ImageBitmap`.
//
// The decoder commits to NO theme — it emits opaque grayscale, black ink on a
// white page, and that is exactly what we paint: notes always render in the LIGHT
// world (dark ink on paper), regardless of the app theme. The dark reader chrome
// frames the page like paper — sketches (`.spd`) already render this way. This
// layer only honours `RenderSize` (downscale for thumbnails) before building the
// bitmap. The module is instantiated once and reused; the decode call is fully
// synchronous, so concurrent `render()`s can't interleave a decode and corrupt
// the shared result buffer (which is only valid until the next `decode_page`).
//
// Bundling: the wasm ships as a Vite public asset (`public/note-decode.wasm`),
// served verbatim at `/note-decode.wasm`. Rebuild it with `npm run build:wasm`.

import type { DecodedPage, NoteRenderer, RenderRequest } from "./types";
import { thumbTargetWidth } from "./types";
import type { RenderSize } from "../core/types";
import { compositeTemplateUnderInk, type TemplateProvider } from "./template";

/** The freestanding decoder's C-ABI exports (see docs/wasm-note-decoder.md). */
export interface DecoderExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  free(ptr: number, len: number): void;
  decode_page(ptr: number, len: number): number;
  /**
   * Decode ONE layer record of an SNPG payload (bottom-to-top record order,
   * hidden records included — that is what they ship for) into RGBA where the
   * transparent value (0xff) has alpha 0 — the stacked-canvas input for the
   * reader's layers panel. Shares the one result slot with `decode_page`:
   * re-read `result_*` after EVERY call. OPTIONAL because a cached older wasm
   * may predate it — callers feature-detect and fall back to the composite.
   */
  decode_layer?(ptr: number, len: number, layerIndex: number): number;
  result_ptr(): number;
  result_len(): number;
  result_width(): number;
  result_height(): number;
  /**
   * Pointer to / byte length of the last `decode_page`'s image-template asset
   * hash (UTF-8) — the bit2 image-background reference the browser turns into
   * `GET /note/{id}/template/{hash}`. Length 0 means the page had no image
   * background. Valid until the next decode. OPTIONAL because a cached older
   * wasm may predate the extraction — callers feature-detect and, when absent,
   * simply render ink-on-white with no underlay.
   */
  template_hash_ptr?(): number;
  template_hash_len?(): number;
  /**
   * Enumerate an SNPG v2 payload's record heads for the layers panel — NO RLE
   * decode, independent of the `decode_page`/`decode_layer` result slot. Returns
   * the record count (1..5), or -1 for anything the stacked panel cannot present
   * (v1 / foreign / truncated / unknown slot / over-claim / bad count / trailing
   * junk). On success the dims + per-record identity are read via the getters
   * below; state resets each call. OPTIONAL — a cached older wasm may predate it,
   * so callers feature-detect and fall back to the composite.
   */
  snpg_enumerate?(ptr: number, len: number): number;
  snpg_width?(): number;
  snpg_height?(): number;
  /** Record i's wire slot id (0=main..4=background), or -1 out of range. */
  snpg_record_slot?(i: number): number;
  /** Record i's panel flag bits (bit1 excluded, bit2 raster-image), or -1. */
  snpg_record_flags?(i: number): number;
  /** Record i's asset-hash pointer/length for a raster-image background (len 0
   *  otherwise). Valid until the next `snpg_enumerate`. */
  snpg_record_hash_ptr?(i: number): number;
  snpg_record_hash_len?(i: number): number;
}

/**
 * Read the last `decode_page`'s image-template asset hash out of wasm memory —
 * the Zig side extracted it from the SNPG payload during decode and copied it
 * into a static buffer that survives until the next decode. Returns null when
 * the page had no image background, or when an older cached wasm predates the
 * exports. Must be called BEFORE the next decode reuses the buffer.
 */
function readWasmTemplateHash(wasm: DecoderExports): string | null {
  const ptrFn = wasm.template_hash_ptr;
  const lenFn = wasm.template_hash_len;
  if (typeof ptrFn !== "function" || typeof lenFn !== "function") return null;
  const len = lenFn.call(wasm);
  if (len === 0) return null;
  const ptr = ptrFn.call(wasm);
  return new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, ptr, len));
}

export interface RawDecoded {
  /** Pinned to a plain `ArrayBuffer` backing so it satisfies `ImageData`. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Target output width per size tier — downscaled from native to bound cache
 * bytes. Never upscales (native ≈ 1404 px). "thumb" is the pristine tier's
 * bucket-dependent target, read PER RENDER CALL so a DPR change lands in the
 * right bucket (the render cache keys thumb entries by that same bucket). */
function outputWidth(size: RenderSize): number {
  if (size === "thumb") return thumbTargetWidth();
  return size === "full" ? 1080 : 4096;
}
const DEFAULT_WASM_URL = "/note-decode.wasm";

const DECODE_ERRORS: Record<number, string> = {
  [-1]: "bad or unsupported page payload",
  [-2]: "RLE layer size mismatch",
  [-3]: "decoder out of memory",
  [-4]: "layer index out of range",
};

/**
 * Run the wasm decode for one SNPG payload and copy the RGBA pixels out. Pure
 * w.r.t. the exports + input (no DOM), so it's unit-testable in Node against the
 * real compiled module. The whole sequence is synchronous: the result buffer is
 * read and copied before any `await`, so it can't be clobbered by another decode.
 */
export function decodeWithExports(wasm: DecoderExports, bytes: Uint8Array): RawDecoded {
  const inPtr = wasm.alloc(bytes.length);
  if (inPtr === 0) throw new Error("wasm alloc failed (OOM)");
  new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);

  const rc = wasm.decode_page(inPtr, bytes.length);
  wasm.free(inPtr, bytes.length);
  if (rc !== 0) throw new Error(`decode_page failed: ${DECODE_ERRORS[rc] ?? `code ${rc}`}`);

  // Re-read pointers AFTER decode — linear memory may have grown.
  const width = wasm.result_width();
  const height = wasm.result_height();
  const ptr = wasm.result_ptr();
  const len = wasm.result_len();
  // Copy out of the wasm heap into a fresh, plain-ArrayBuffer-backed clamped
  // array: it's ours to keep (survives the next decode/`memory.grow`) and it
  // satisfies `ImageData` (which rejects a `SharedArrayBuffer`-backed view).
  const rgba = new Uint8ClampedArray(len);
  rgba.set(new Uint8Array(wasm.memory.buffer, ptr, len));
  return { rgba, width, height };
}

/**
 * Run `decode_layer` for ONE record of an SNPG payload and copy the RGBA out —
 * `decodeWithExports`' per-layer twin, with the same synchronous copy-out
 * discipline (the result slot is shared and valid only until the next decode).
 * Throws when the module predates `decode_layer` — the caller's fallback to the
 * composite path is the contract, not a special return.
 */
export function decodeLayerWithExports(wasm: DecoderExports, bytes: Uint8Array, layerIndex: number): RawDecoded {
  const decodeLayer = wasm.decode_layer;
  if (typeof decodeLayer !== "function") throw new Error("this note-decode.wasm has no decode_layer");
  const inPtr = wasm.alloc(bytes.length);
  if (inPtr === 0) throw new Error("wasm alloc failed (OOM)");
  new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);

  const rc = decodeLayer.call(wasm, inPtr, bytes.length, layerIndex);
  wasm.free(inPtr, bytes.length);
  if (rc !== 0) throw new Error(`decode_layer failed: ${DECODE_ERRORS[rc] ?? `code ${rc}`}`);

  // Re-read pointers AFTER decode — linear memory may have grown.
  const width = wasm.result_width();
  const height = wasm.result_height();
  const ptr = wasm.result_ptr();
  const len = wasm.result_len();
  const rgba = new Uint8ClampedArray(len);
  rgba.set(new Uint8Array(wasm.memory.buffer, ptr, len));
  return { rgba, width, height };
}

/** Dark theme = inverted e-ink: invert RGB, leave alpha. In place. Pure. */
export function invertRgb(rgba: Uint8ClampedArray<ArrayBuffer>): void {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255 - rgba[i]!;
    rgba[i + 1] = 255 - rgba[i + 1]!;
    rgba[i + 2] = 255 - rgba[i + 2]!;
  }
}

export interface WasmRendererOptions {
  /** URL of the wasm module. Default `/note-decode.wasm`. */
  wasmUrl?: string;
  /** Override module loading (tests). Default fetches + instantiates `wasmUrl`. */
  loader?: () => Promise<DecoderExports>;
  /**
   * Fetch + decode a page's custom IMAGE template, memoized once per hash (see
   * `createTemplateProvider`). Wired from the Api in `main.ts`. When absent (the
   * default, and for callers with no custom templates) an image-background page
   * still decodes — it just renders ink-on-white with no underlay.
   */
  getTemplate?: TemplateProvider;
}

/**
 * Fetch + instantiate the decoder module from its URL. Exported (as well as
 * being `createWasmRenderer`'s default) for the reader's per-layer decode path
 * (pages/noteLayers.ts), which drives `decode_layer` directly rather than
 * through the `NoteRenderer` seam — a layer stack is not a themed page render,
 * so it must not masquerade as one in the render cache. Not cached here; each
 * consumer memoises its own instance.
 */
export function browserLoader(wasmUrl: string): () => Promise<DecoderExports> {
  return async () => {
    const res = await fetch(wasmUrl);
    if (!res.ok) throw new Error(`failed to load ${wasmUrl}: ${res.status}`);
    try {
      // Fast path: needs the server to send `Content-Type: application/wasm`.
      const { instance } = await WebAssembly.instantiateStreaming(res.clone());
      return instance.exports as unknown as DecoderExports;
    } catch {
      // Fallback for a wrong/absent MIME type — instantiate from the bytes.
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer());
      return instance.exports as unknown as DecoderExports;
    }
  };
}

export function createWasmRenderer(opts: WasmRendererOptions = {}): NoteRenderer {
  const load = opts.loader ?? browserLoader(opts.wasmUrl ?? DEFAULT_WASM_URL);
  const getTemplate = opts.getTemplate;
  let exportsPromise: Promise<DecoderExports> | null = null;
  const exports = () => (exportsPromise ??= load());

  return {
    async render(req: RenderRequest): Promise<DecodedPage> {
      const wasm = await exports();
      const payload = new Uint8Array(req.bytes);
      const { rgba, width, height } = decodeWithExports(wasm, payload);

      // A custom IMAGE background: the WASM composite is ink-on-white (the bit2
      // record is skipped). The decode also extracted the template's asset hash
      // Zig-side; read it out of wasm memory now, BEFORE any await reuses the
      // decoder. Fetch the template ONCE per hash and draw it UNDER the ink.
      const templateHash = getTemplate ? readWasmTemplateHash(wasm) : null;
      if (templateHash && getTemplate) {
        const template = await getTemplate(req.noteId, templateHash);
        if (template) {
          const ink = new ImageData(rgba, width, height);
          return compositeTemplateUnderInk(ink, template, outputWidth(req.size));
        }
        // Template unavailable (404/failed): fall through to plain ink-on-white.
      }
      // No theme invert — see the file header: notes always paint on white paper.

      const source = new ImageData(rgba, width, height);
      const target = outputWidth(req.size);
      const scale = width > target ? target / width : 1;
      const outW = Math.max(1, Math.round(width * scale));
      const outH = Math.max(1, Math.round(height * scale));

      const bitmap =
        scale < 1
          ? await createImageBitmap(source, { resizeWidth: outW, resizeHeight: outH, resizeQuality: "high" })
          : await createImageBitmap(source);
      return { bitmap, width: outW, height: outH };
    },
  };
}
