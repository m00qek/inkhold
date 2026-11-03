// The real `NoteRenderer`: SNPG page bytes through `note-decode.wasm` (built
// from `webapp/wasm/note_decode.zig`, served as `public/note-decode.wasm`;
// `npm run build:wasm`) into an `ImageBitmap`. The decoder emits opaque
// grayscale and notes always paint in the light world. Decode is synchronous,
// so concurrent renders can't clobber the shared result buffer.

import type { DecodedPage, NoteRenderer, RenderRequest } from "./types";
import { thumbTargetWidth } from "./types";
import type { RenderSize } from "../core/types";
import { compositeTemplateUnderInk, type TemplateProvider } from "./template";

export interface DecoderExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  free(ptr: number, len: number): void;
  decode_page(ptr: number, len: number): number;
  /**
   * Decode one layer record (bottom-to-top, hidden ones included) into RGBA
   * with the transparent value at alpha 0. Shares the result slot with
   * `decode_page`. Optional: an older cached wasm may lack it.
   */
  decode_layer?(ptr: number, len: number, layerIndex: number): number;
  result_ptr(): number;
  result_len(): number;
  result_width(): number;
  result_height(): number;
  /**
   * The last decode's image-template asset hash (UTF-8); length 0 means no
   * image background. Valid until the next decode. Optional (older wasm).
   */
  template_hash_ptr?(): number;
  template_hash_len?(): number;
  /**
   * Enumerate an SNPG v2 payload's record heads without decoding (own state,
   * not the result slot). Returns 1..5, or -1 for anything the layers panel
   * can't present. Optional (older wasm).
   */
  snpg_enumerate?(ptr: number, len: number): number;
  snpg_width?(): number;
  snpg_height?(): number;
  /** Record i's wire slot id (0=main..4=background), or -1 out of range. */
  snpg_record_slot?(i: number): number;
  /** Record i's flag bits (bit1 excluded, bit2 raster-image), or -1. */
  snpg_record_flags?(i: number): number;
  /** Record i's raster-image asset hash; valid until the next `snpg_enumerate`. */
  snpg_record_hash_ptr?(i: number): number;
  snpg_record_hash_len?(i: number): number;
}

/** The last decode's template hash, or null. Call before the next decode. */
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
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Target width per tier; never upscales. "thumb" is read per call (DPR bucket). */
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
 * Decode one SNPG payload and copy the RGBA out, synchronously before any
 * `await`. DOM-free, so testable in Node against the real module.
 */
export function decodeWithExports(wasm: DecoderExports, bytes: Uint8Array): RawDecoded {
  const inPtr = wasm.alloc(bytes.length);
  if (inPtr === 0) throw new Error("wasm alloc failed (OOM)");
  new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);

  const rc = wasm.decode_page(inPtr, bytes.length);
  wasm.free(inPtr, bytes.length);
  if (rc !== 0) throw new Error(`decode_page failed: ${DECODE_ERRORS[rc] ?? `code ${rc}`}`);

  // Re-read pointers after decode: linear memory may have grown.
  const width = wasm.result_width();
  const height = wasm.result_height();
  const ptr = wasm.result_ptr();
  const len = wasm.result_len();
  // Copy into a plain-ArrayBuffer-backed array: survives the next decode and
  // satisfies `ImageData` (which rejects SharedArrayBuffer views).
  const rgba = new Uint8ClampedArray(len);
  rgba.set(new Uint8Array(wasm.memory.buffer, ptr, len));
  return { rgba, width, height };
}

/**
 * The per-layer twin of `decodeWithExports`. Throws when the module lacks
 * `decode_layer`; the caller falls back to the composite.
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

  // Re-read pointers after decode: linear memory may have grown.
  const width = wasm.result_width();
  const height = wasm.result_height();
  const ptr = wasm.result_ptr();
  const len = wasm.result_len();
  const rgba = new Uint8ClampedArray(len);
  rgba.set(new Uint8Array(wasm.memory.buffer, ptr, len));
  return { rgba, width, height };
}

/** Dark theme = inverted e-ink: invert RGB, leave alpha, in place. */
export function invertRgb(rgba: Uint8ClampedArray<ArrayBuffer>): void {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255 - rgba[i]!;
    rgba[i + 1] = 255 - rgba[i + 1]!;
    rgba[i + 2] = 255 - rgba[i + 2]!;
  }
}

export interface WasmRendererOptions {
  wasmUrl?: string;
  /** Override module loading (tests). */
  loader?: () => Promise<DecoderExports>;
  /** Memoized image-template fetch; absent, image-background pages render ink-on-white. */
  getTemplate?: TemplateProvider;
}

/**
 * Fetch and instantiate the decoder. Also used by the per-layer decode path,
 * which must not go through the themed render cache. Not cached here.
 */
export function browserLoader(wasmUrl: string): () => Promise<DecoderExports> {
  return async () => {
    const res = await fetch(wasmUrl);
    if (!res.ok) throw new Error(`failed to load ${wasmUrl}: ${res.status}`);
    try {
      // Needs `Content-Type: application/wasm`.
      const { instance } = await WebAssembly.instantiateStreaming(res.clone());
      return instance.exports as unknown as DecoderExports;
    } catch {
      // Wrong or absent MIME type: instantiate from the bytes.
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

      // Image background: the composite skipped bit2; read the hash before any
      // await reuses the decoder, then draw the template under the ink.
      const templateHash = getTemplate ? readWasmTemplateHash(wasm) : null;
      if (templateHash && getTemplate) {
        const template = await getTemplate(req.noteId, templateHash);
        if (template) {
          const ink = new ImageData(rgba, width, height);
          return compositeTemplateUnderInk(ink, template, outputWidth(req.size));
        }
      }

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
