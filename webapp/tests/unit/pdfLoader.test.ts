// The PDF decoder's loader (`render/pdfLoader.ts`): one instance, until it is
// spent (out of memory at its ceiling, or trapped), then a fresh one.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { browserLoader, decoderImports, spentDecoder, type PdfDecoderExports } from "../../src/render/pdfLoader";
import { AsyncPdfDocument, syncCalls } from "../../src/render/pdfDocument";

const here = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(here, "../../public/pdf-decode.wasm"));

describe("spentDecoder", () => {
  it("is MuPDF's out-of-memory error at the ceiling, in each of its spellings, or a trap", () => {
    // MuPDF 1.28.1's fitz/memory.c, its image decoders, and this side's own.
    for (const message of [
      "malloc (64 bytes) failed",
      "calloc (16 x 8 bytes) failed",
      "realloc (4096 bytes) failed",
      "hash table resize failed; out of memory (1024 entries)",
      "Insufficient memory (case 4)",
      "out of wasm memory",
    ]) {
      expect(spentDecoder(new Error(message)), message).toBe(true);
    }
    expect(spentDecoder(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
  });

  it("is not a document's own failure: those leave the instance as it was", () => {
    expect(spentDecoder(new Error("cannot recognize document format"))).toBe(false);
    expect(spentDecoder(new Error("Overly large image"))).toBe(false);
    expect(spentDecoder("no document is open")).toBe(false);
  });
});

describe("browserLoader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps one instance, and makes a fresh one after reset", async () => {
    const fetches = vi.fn(async () => new Response(wasm, { headers: { "Content-Type": "application/wasm" } }));
    vi.stubGlobal("fetch", fetches);
    const load = browserLoader("/pdf-decode.wasm");
    const first = await load();
    expect(await load()).toBe(first);
    expect(fetches).toHaveBeenCalledTimes(1);

    load.reset();
    const fresh = await load();
    expect(fresh).not.toBe(first);
    expect(fresh.memory).not.toBe(first.memory);
    expect(fetches).toHaveBeenCalledTimes(2);
  });
});

describe("a refused call that answers \"nothing here\"", () => {
  it("throws instead when the instance ran out of memory, so the worker can replace it", async () => {
    const pdf = new Uint8Array(readFileSync(join(here, "../../wasm/tests/fixtures/text-four-page.pdf")));
    let x: PdfDecoderExports | null = null;
    const { instance } = await WebAssembly.instantiate(
      wasm,
      decoderImports(() => x!.memory, () => -1),
    );
    x = instance.exports as unknown as PdfDecoderExports;
    x._initialize?.();
    const doc = await AsyncPdfDocument.openWhole(x, syncCalls(x), pdf);
    expect((await doc.pageWords(0)).length).toBeGreaterThan(0);
    // Squeezed to the ceiling, and every free block taken, as at the end of a
    // heavy session: the next allocation inside MuPDF fails.
    x.memory.grow((1 << 30) / 65536 - x.memory.buffer.byteLength / 65536);
    for (const size of [1 << 20, 1 << 16, 1 << 12, 256, 16]) while (x.ink_alloc(size)) {}
    await expect(doc.pageWords(2)).rejects.toThrow(/alloc \(.*\) failed/);
  });
});
