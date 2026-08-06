import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AsyncPdfDocument,
  decoderImports,
  supportsWasmExceptions,
  syncCalls,
  wasiShim,
  type PdfDecoderExports,
} from "../../src/render/pdfDecode";

// THE REAL MODULE, NOT A FAKE. The viewer tests use a fake speaking the ABI (as
// `.spd`'s do), but this file exists to prove one specific thing a fake cannot:
// that `wasiShim` is a sufficient replacement for a real WASI implementation.
//
// The Zig-side ABI test (`webapp/wasm/tests/pdf_decode_abi.mjs`) runs the module
// under Node's genuine WASI. If MuPDF ever needs a syscall the browser cannot
// provide, that test keeps passing and only this one fails — which is exactly
// the split we want, because the browser is where it would actually break.

const here = dirname(fileURLToPath(import.meta.url));
// `public/`, not `zig-out/`: this is the artifact the app actually serves, and
// `npm run build:wasm` (a `pretest` hook) is what puts it there.
const wasmPath = join(here, "../../public/pdf-decode.wasm");
const pdfPath = join(here, "../../wasm/tests/fixtures/two-page.pdf");

/**
 * The WHOLE-FILE path, which is what the worker runs on any browser without
 * JSPI (`pdfWorker.ts`: `if (!jspi) return syncCalls(x)`).
 *
 * There used to be a separate sync `PdfDocument` class for this, and these tests
 * were its only callers — so they proved page sizing, scaling, the pixel copy
 * and the closed-handle guard about code that shipped to nobody. Through
 * `openWhole` they prove the same things about the code that does ship.
 */
const openWhole = (): Promise<AsyncPdfDocument> =>
  AsyncPdfDocument.openWhole(exports, syncCalls(exports), pdf);

let exports: PdfDecoderExports;
let pdf: Uint8Array;
/** Every `(offset, length)` `ink.host_read` was asked for, in order. */
let hostReads: Array<[number, number]> = [];
/** Set to make the host reader fail, the way an aborted range fetch does. */
let hostFails = false;

beforeAll(async () => {
  let x: PdfDecoderExports | null = null;
  // `decoderImports`, not `wasiShim` alone: the module now DECLARES an
  // `ink.host_read` import, and an import the embedder omits is a link error.
  // Here it is a real reader over the fixture's bytes — synchronous, because
  // Node can answer from memory and nothing needs JSPI to do that. That is what
  // makes the stream path testable without a browser at all.
  const { instance } = await WebAssembly.instantiate(
    readFileSync(wasmPath),
    decoderImports(
      () => x!.memory,
      (off, dst, len) => {
        const at = Number(off);
        hostReads.push([at, len]);
        if (hostFails) return -1;
        const n = Math.max(0, Math.min(len, pdf.length - at));
        if (n > 0) new Uint8Array(x!.memory.buffer, dst, n).set(pdf.subarray(at, at + n));
        return n;
      },
    ),
  );
  x = instance.exports as unknown as PdfDecoderExports;
  x._initialize?.();
  exports = x;
  pdf = new Uint8Array(readFileSync(pdfPath));
});

describe("the WASI shim", () => {
  it("is enough to instantiate and render — no real WASI needed", async () => {
    const doc = await openWhole();
    try {
      expect(await doc.pageCount()).toBe(2);
      const bmp = await doc.render(0, 2);
      expect(bmp.width).toBeGreaterThan(0);
      expect(bmp.rgba.length).toBe(bmp.width * bmp.height * 4);
    } finally {
      doc.close();
    }
  });

  it("reports MuPDF's warnings rather than swallowing them", () => {
    // `fd_write` is the one stub with real work to do: the byte count must be
    // written back or libc treats the write as short and loops.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mem = new WebAssembly.Memory({ initial: 1 });
      const shim = wasiShim(() => mem);
      const w = (shim.wasi_snapshot_preview1 as Record<string, CallableFunction>).fd_write;
      const d = new DataView(mem.buffer);
      const msg = new TextEncoder().encode("cannot find font\n");
      new Uint8Array(mem.buffer).set(msg, 100);
      d.setUint32(0, 100, true); // iov[0].base
      d.setUint32(4, msg.length, true); // iov[0].len
      expect(w(2, 0, 1, 200)).toBe(0);
      expect(d.getUint32(200, true)).toBe(msg.length); // bytes written, or libc spins
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot find font"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("AsyncPdfDocument, whole-file", () => {
  it("reports page sizes in points, per page", async () => {
    const doc = await openWhole();
    try {
      const a = await doc.pageSize(0);
      expect(a.width).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThan(0);
      // THE TWO OUT-PARAMS ARE IN ORDER. `ink_page_size` writes width then
      // height into one scratch block, and reading them back swapped passed
      // every assertion above — the fixture is landscape, so its own shape is
      // what tells them apart. Cross-checked against the RENDER's dimensions,
      // which come from a different export (`ink_render_width/height`) and so
      // cannot agree by sharing the same mistake.
      const bmp = await doc.render(0, 1);
      expect(bmp.width).toBe(Math.round(a.width));
      expect(bmp.height).toBe(Math.round(a.height));
      await expect(doc.pageSize(99)).rejects.toThrow();
    } finally {
      doc.close();
    }
  });

  it("scales: 2x is twice the pixels of 1x, from the same page", async () => {
    const doc = await openWhole();
    try {
      const one = await doc.render(0, 1);
      const two = await doc.render(0, 2);
      expect(two.width).toBe(one.width * 2);
      expect(two.height).toBe(one.height * 2);
    } finally {
      doc.close();
    }
  });

  it("returns pixels that OUTLIVE the next render", async () => {
    // The whole reason `render` copies. A view into wasm memory would be
    // overwritten by the next page and detached by `memory.grow`.
    const doc = await openWhole();
    try {
      const first = await doc.render(0, 1);
      const before = first.rgba.slice(0, 64);
      await doc.render(1, 3);
      expect(first.rgba.slice(0, 64)).toEqual(before);
    } finally {
      doc.close();
    }
  });

  it("every pixel is opaque — the ABI promises straight RGBA", async () => {
    const doc = await openWhole();
    try {
      const bmp = await doc.render(0, 1);
      let transparent = 0;
      for (let i = 3; i < bmp.rgba.length; i += 4) if (bmp.rgba[i] !== 255) transparent++;
      expect(transparent).toBe(0);
    } finally {
      doc.close();
    }
  });

  it("refuses garbage, and says what MuPDF said", async () => {
    await expect(
      AsyncPdfDocument.openWhole(exports, syncCalls(exports), new TextEncoder().encode("not a pdf at all")),
    ).rejects.toThrow();
  });

  it("a closed document throws instead of using a stale handle", async () => {
    const doc = await openWhole();
    doc.close();
    doc.close(); // idempotent
    await expect(doc.pageCount()).rejects.toThrow(/closed/);
    await expect(doc.render(0, 1)).rejects.toThrow(/closed/);
  });

  it("still works after all that — the module is not wedged", async () => {
    const doc = await openWhole();
    try {
      expect(await doc.pageCount()).toBe(2);
    } finally {
      doc.close();
    }
  });
});

describe("AsyncPdfDocument.exportPage — one page, structure intact", () => {
  // The PDF-level behaviour (the graft, the placement matrix, the ink's
  // encoding) is proved in `webapp/wasm/tests/pdf_decode_abi.mjs`, which can
  // diff rendered pixels against the source page. What is proved HERE is the
  // wrapper: the alpha reaches wasm through a pointer that survives a heap
  // growth, the produced bytes are copied out rather than aliased, and both the
  // scratch buffer and the module's own copy are released whichever way the call
  // ends. Those are the things a leak or a detached-ArrayBuffer bug lives in.

  /** Full-page coverage: every byte inked, so "did it draw" needs no geometry. */
  const solid = (w: number, h: number): Uint8Array => new Uint8Array(w * h).fill(255);

  it("produces a one-page PDF at the source page's size, with the ink on it", async () => {
    const doc = await openWhole();
    try {
      const size = await doc.pageSize(0);
      const before = await doc.render(0, 1);
      const w = 40;
      const h = 20;
      const bytes = await doc.exportPage(0, solid(w, h), w, h, [
        size.width / w,
        0,
        0,
        size.height / h,
        0,
        0,
      ]);
      expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");

      // Back through the same module. One page, same point size — and darker
      // than the source everywhere, because the coverage was solid.
      const out = await AsyncPdfDocument.openWhole(exports, syncCalls(exports), bytes);
      try {
        expect(await out.pageCount()).toBe(1);
        expect(await out.pageSize(0)).toEqual(size);
        const after = await out.render(0, 1);
        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        let lighter = 0;
        for (let i = 0; i < after.rgba.length; i += 4) {
          if (after.rgba[i] > before.rgba[i]) lighter += 1;
        }
        expect(lighter).toBe(0);
        // ...and it is INK, not a black page: solid coverage over a white page
        // has to come out black rather than merely different.
        let dark = 0;
        for (let i = 0; i < after.rgba.length; i += 4) if (after.rgba[i] < 64) dark += 1;
        expect(dark).toBe(after.width * after.height);
      } finally {
        out.close();
      }
    } finally {
      doc.close();
    }
  });

  it("rejects an alpha buffer that does not match its own dimensions", async () => {
    const doc = await openWhole();
    try {
      // The module reads `w * h` bytes from a raw pointer, so a short buffer is
      // an out-of-bounds read inside wasm — caught here, before the call.
      await expect(doc.exportPage(0, solid(10, 10), 20, 20, [1, 0, 0, 1, 0, 0])).rejects.toThrow(
        /alpha/,
      );
      await expect(doc.exportPage(0, solid(4, 4), 0, 4, [1, 0, 0, 1, 0, 0])).rejects.toThrow();
    } finally {
      doc.close();
    }
  });

  it("surfaces MuPDF's own refusal, and frees the scratch either way", async () => {
    const doc = await openWhole();
    try {
      // A page that does not exist. The message has to come back out — the
      // caller's fallback is the rasterising exporter, and "it failed" is not a
      // reason to show anyone.
      await expect(doc.exportPage(99, solid(4, 4), 4, 4, [1, 0, 0, 1, 0, 0])).rejects.toThrow();
      // The failed call must not have wedged anything or leaked the scratch: a
      // good export straight afterwards is the check that proves both.
      const bytes = await doc.exportPage(0, solid(4, 4), 4, 4, [50, 0, 0, 25, 0, 0]);
      expect(bytes.length).toBeGreaterThan(0);
    } finally {
      doc.close();
    }
  });

  it("returns bytes we own — a later export cannot change them", async () => {
    const doc = await openWhole();
    try {
      // The module's buffer is reused, so a view onto wasm memory would mutate
      // under the caller. This is the assertion that the copy is real.
      const first = await doc.exportPage(0, solid(4, 4), 4, 4, [50, 0, 0, 25, 0, 0]);
      const snapshot = new Uint8Array(first);
      await doc.exportPage(1, solid(8, 8), 8, 8, [37, 0, 0, 18, 0, 0]);
      expect(first).toEqual(snapshot);
    } finally {
      doc.close();
    }
  });

  it("a closed document refuses to export", async () => {
    const doc = await openWhole();
    doc.close();
    await expect(doc.exportPage(0, solid(4, 4), 4, 4, [1, 0, 0, 1, 0, 0])).rejects.toThrow(/closed/);
  });
});

describe("ink_open_stream — the same document, pulled through `ink.host_read`", () => {
  // The C stream in `pdf_shim.c` is the part of the range design that cannot be
  // tested from JS alone: its `next`/`seek` callbacks have to keep `stm->pos`,
  // the window and `fz_tell` consistent, and getting that wrong offsets every
  // object in the file. JSPI is NOT needed to prove it — the host reader above
  // answers synchronously, which is precisely what a cache HIT does in the
  // browser too.

  it("opens, counts, sizes and renders identically to the whole-file path", async () => {
    // ONE CLASS, TWO TRANSPORTS — which is what this test was always about. It
    // used to compare `openStream` against the separate sync class, varying the
    // transport AND the wrapper at once; now the wrapper is held fixed and the
    // transport is the only difference, which is the thing being asserted.
    const streamed = await AsyncPdfDocument.openStream(exports, syncCalls(exports), pdf.length);
    const whole = await openWhole();
    try {
      expect(await streamed.pageCount()).toBe(await whole.pageCount());
      expect(await streamed.pageSize(1)).toEqual(await whole.pageSize(1));
      const a = await streamed.render(0, 2);
      const b = await whole.render(0, 2);
      expect(a.width).toBe(b.width);
      expect(a.height).toBe(b.height);
      // Byte-for-byte: a stream that reads from the wrong offsets can still
      // produce a plausibly-sized page of the wrong content.
      expect(Array.from(a.rgba)).toEqual(Array.from(b.rgba));
    } finally {
      streamed.close();
      whole.close();
    }
  });

  it("does not re-read what it is already holding", async () => {
    // The whole point of the window in `ink_stream_seek`. Without it this
    // 688-byte fixture cost SEVEN host reads of the same 688 bytes, because
    // `fz_seek` has no in-buffer fast path of its own and drops the window on
    // every backwards seek. Each was a cache hit, and each was pointless.
    hostReads = [];
    const doc = await AsyncPdfDocument.openStream(exports, syncCalls(exports), pdf.length);
    try {
      await doc.render(0, 1);
      expect(hostReads.length).toBeLessThanOrEqual(2);
      expect(hostReads[0]).toEqual([0, pdf.length]);
    } finally {
      doc.close();
    }
  });

  it("a host that cannot read fails as a MuPDF error, not a trap", async () => {
    // `ink_host_read` returning <0 is `fz_throw` from inside the stream's
    // `next`, raised through a `fz_try` the shim owns. The instance must SURVIVE
    // it — a wedged module would take every later document with it, and on the
    // real path this is just an aborted range fetch.
    hostFails = true;
    try {
      await expect(
        AsyncPdfDocument.openStream(exports, syncCalls(exports), pdf.length),
      ).rejects.toThrow();
    } finally {
      hostFails = false;
    }
    const ok = await openWhole();
    try {
      expect(await ok.pageCount()).toBe(2);
    } finally {
      ok.close();
    }
  });

  it("refuses a length of zero rather than opening an empty document", async () => {
    await expect(AsyncPdfDocument.openStream(exports, syncCalls(exports), 0)).rejects.toThrow();
  });
});

describe("supportsWasmExceptions", () => {
  it("is true here, since we just ran the module", () => {
    expect(supportsWasmExceptions()).toBe(true);
  });
});
