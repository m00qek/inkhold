// The PDF decoder's loader (`render/pdfLoader.ts`): one instance, until it is
// spent (out of memory at its ceiling, or trapped), then a fresh one.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { browserLoader, spentDecoder } from "../../src/render/pdfLoader";

const here = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(here, "../../public/pdf-decode.wasm"));

describe("spentDecoder", () => {
  it("is MuPDF's out-of-memory error at the ceiling, or a trap", () => {
    expect(spentDecoder(new Error("malloc (64 bytes) failed"))).toBe(true);
    expect(spentDecoder(new Error("out of memory"))).toBe(true);
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
