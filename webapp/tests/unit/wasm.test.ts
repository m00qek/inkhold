import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeWithExports, invertRgb, type DecoderExports } from "../../src/render/wasm";

// Cross-language integration: load the REAL freestanding decoder that the Zig
// track builds (`public/note-decode.wasm`, from webapp/wasm/note_decode.zig) into
// Node's WebAssembly runtime and feed it SNPG payloads in the exact wire format
// the server's `page_payload.serialize` emits (see parsers/note/src/page_payload.zig). This
// exercises the whole client→wasm path — alloc, copy-in, decode_page, result
// read-out — against the actual compiled artifact, not a stub. The real-capture
// (sample.note) round-trip is validated on the Zig side in tests/page_payload_test.zig;
// here we assert the ABI + our RGBA/inversion glue with hand-built, valid payloads.

const wasmPath = fileURLToPath(new URL("../../public/note-decode.wasm", import.meta.url));
const hasWasm = existsSync(wasmPath);

/** Little-endian u32. */
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Build a valid SNPG v1 payload: header + one record per layer (bottom-to-top).
 * `variant` 1 = RATTA_RLE X2 (highres/Nomad). RLE bytes use the same codes the
 * Zig decode tests use: 0x61 = black, 0x62 = transparent; the following byte is a
 * run length where `n` < 0x80 means a run of `n+1`. */
function snpg(width: number, height: number, layers: Array<{ allBlank?: boolean; rle: number[] }>): Uint8Array {
  const bytes: number[] = [];
  bytes.push(0x53, 0x4e, 0x50, 0x47); // "SNPG"
  bytes.push(1); // version
  bytes.push(1); // variant: X2
  bytes.push(0, 0); // reserved
  bytes.push(...u32(width), ...u32(height), ...u32(layers.length));
  for (const layer of layers) {
    bytes.push(layer.allBlank ? 0x01 : 0x00);
    bytes.push(...u32(layer.rle.length));
    bytes.push(...layer.rle);
  }
  return new Uint8Array(bytes);
}

function loadDecoder(): DecoderExports {
  const bytes = readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(mod);
  return instance.exports as unknown as DecoderExports;
}

const suite = hasWasm ? describe : describe.skip;

suite("note-decode.wasm (real module, cross-language)", () => {
  it("instantiates with no imports and exports the documented C-ABI", () => {
    const wasm = loadDecoder();
    for (const name of ["alloc", "free", "decode_page", "result_ptr", "result_len", "result_width", "result_height"]) {
      expect(typeof (wasm as unknown as Record<string, unknown>)[name]).toBe("function");
    }
    expect(wasm.memory).toBeInstanceOf(WebAssembly.Memory);
  });

  it("decodes a 1×1 black page to opaque black RGBA", () => {
    const wasm = loadDecoder();
    const { rgba, width, height } = decodeWithExports(wasm, snpg(1, 1, [{ rle: [0x61, 0x00] }]));
    expect([width, height]).toEqual([1, 1]);
    expect(Array.from(rgba)).toEqual([0, 0, 0, 255]);
  });

  it("decodes a multi-pixel page: black run then transparent → white base", () => {
    const wasm = loadDecoder();
    // 4×2 = 8 px: black run of 4, then transparent run of 4 (shows the white base).
    const { rgba, width, height } = decodeWithExports(wasm, snpg(4, 2, [{ rle: [0x61, 0x03, 0x62, 0x03] }]));
    expect([width, height]).toEqual([4, 2]);
    expect(rgba.length).toBe(8 * 4);

    const ink = (i: number) => rgba[i * 4] === 0 && rgba[i * 4 + 1] === 0 && rgba[i * 4 + 2] === 0;
    const inkCount = Array.from({ length: 8 }, (_, i) => (ink(i) ? 1 : 0)).reduce((a, b) => a + b, 0);
    expect(inkCount).toBe(4); // first four black, rest white — a real pixel probe
    // Alpha is always opaque.
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255);
  });

  it("composites two layers bottom-to-top over the white base", () => {
    const wasm = loadDecoder();
    // bottom: black across 2 px; top: transparent then black → px0 black, px1 black.
    const payload = snpg(2, 1, [
      { rle: [0x61, 0x01] }, // bottom: 2 black
      { rle: [0x62, 0x00, 0x61, 0x00] }, // top: 1 transparent, 1 black
    ]);
    const { rgba } = decodeWithExports(wasm, payload);
    expect(rgba[0]).toBe(0); // px0: bottom black shows (top transparent)
    expect(rgba[4]).toBe(0); // px1: top black
  });

  it("surfaces a decode error for a truncated payload", () => {
    const wasm = loadDecoder();
    expect(() => decodeWithExports(wasm, new Uint8Array([0x53, 0x4e]))).toThrow(/decode_page failed/);
  });
});

describe("invertRgb (dark-theme inversion, pure)", () => {
  it("inverts RGB and preserves alpha", () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 32, 64, 200, 128]);
    invertRgb(rgba);
    expect(Array.from(rgba)).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 223, 191, 55, 128]);
  });

  it("black ink on white paper becomes white ink on black paper", () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    invertRgb(rgba);
    expect(Array.from(rgba.slice(0, 4))).toEqual([255, 255, 255, 255]); // ink → light
    expect(Array.from(rgba.slice(4, 8))).toEqual([0, 0, 0, 255]); // paper → dark
  });
});
