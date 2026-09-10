import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  decoderImports,
  supportsWasmExceptions,
  wasiShim,
  type PdfDecoderExports,
} from "../../src/render/pdfLoader";
import { AsyncPdfDocument, syncCalls } from "../../src/render/pdfDocument";

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

/**
 * A one-page PDF with a stated `/MediaBox` and `/Rotate`, built here rather than
 * committed: the committed fixtures are upright, and what has to be provable is
 * that a page's ORIENTATION reaches the client — the fact a library tile's aspect
 * rests on. Every byte is ASCII, so a string offset IS a byte offset and the
 * xref table can be computed as the objects are written.
 */
function minimalPdf(w: number, h: number, rotate: number): Uint8Array {
  const content = "0 0 0 RG 4 w 20 20 m 120 120 l S\n";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Rotate ${rotate} ` +
      "/Resources << >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objs.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const startxref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

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

  // THE CLAIM THE LIBRARY TILE RESTS ON. A `.pdf`'s gallery thumbnail has no
  // server-stated shape (nothing indexes a `/MediaBox`), so the tile learns its
  // aspect from `pageSize` alone — and it is only honest if that reports the
  // page as it will be SEEN, not as its `/MediaBox` was written. `/Rotate 90`
  // is where those differ: MuPDF's `fz_bound_page` returns the cropped box with
  // the rotation applied, so a portrait MediaBox marked `/Rotate 90` measures
  // landscape, and the RENDER agrees because it derives its pixmap from the same
  // box. Asserted rather than assumed, against the real module.
  it("a /Rotate 90 page measures ROTATED — pageSize and render agree", async () => {
    const upright = await AsyncPdfDocument.openWhole(exports, syncCalls(exports), minimalPdf(400, 600, 0));
    const turned = await AsyncPdfDocument.openWhole(exports, syncCalls(exports), minimalPdf(400, 600, 90));
    try {
      const a = await upright.pageSize(0);
      expect([a.width, a.height]).toEqual([400, 600]); // the MediaBox verbatim

      const b = await turned.pageSize(0);
      expect([b.width, b.height]).toEqual([600, 400]); // …swapped by /Rotate
      // Not just the measurement: the pixels come out landscape too, off a
      // different export, so the two cannot agree by sharing one mistake.
      const bmp = await turned.render(0, 1);
      expect(bmp.width).toBe(600);
      expect(bmp.height).toBe(400);
    } finally {
      upright.close();
      turned.close();
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

describe("annotatePage + exportIncremental — the whole document, appended to", () => {
  // The PDF-level claim that matters most — that the ORIGINAL's own `/Annots`
  // survive, where the grafting export loses them — is proved in
  // `webapp/wasm/tests/pdf_decode_abi.mjs`, which can build a fixture carrying
  // links and diff the bytes. What is proved HERE is the same split as
  // `exportPage`'s: that the WRAPPER marshals correctly, that what comes back is
  // a delta rather than a document, and that the concatenation is a PDF this
  // very module will open.

  const solid = (w: number, h: number): Uint8Array => new Uint8Array(w * h).fill(255);

  /** `original || delta`, which is the only thing the delta is valid as. */
  const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  it("appends a DELTA — the original's bytes come back untouched", async () => {
    const doc = await openWhole();
    let delta: Uint8Array;
    try {
      const size = await doc.pageSize(0);
      await doc.annotatePage(0, solid(40, 20), 40, 20, [size.width / 40, 0, 0, size.height / 20, 0, 0]);
      delta = await doc.exportIncremental();
    } finally {
      doc.close();
    }
    // NOT A DOCUMENT. If this began with a header the module would be handing
    // back a rewritten file, and the browser's `new Blob([original, delta])`
    // would produce nonsense — while still looking like a successful export.
    expect(new TextDecoder().decode(delta.subarray(0, 5))).not.toBe("%PDF-");
    expect(delta.length).toBeGreaterThan(0);

    const whole = join(pdf, delta);
    // The incremental promise itself: nothing of the original is re-encoded.
    expect(Array.from(whole.subarray(0, pdf.length))).toEqual(Array.from(pdf));

    const out = await AsyncPdfDocument.openWhole(exports, syncCalls(exports), whole);
    try {
      // BOTH pages, not one — the difference from `exportPage`, which lifts a
      // page out of the document and leaves the rest behind.
      expect(await out.pageCount()).toBe(2);
      expect(await out.pageSize(1)).toEqual({ width: 300, height: 150 });
    } finally {
      out.close();
    }
  });

  it("inks the pages it was given and leaves the others exactly as they were", async () => {
    // SPARSE IS THE REAL CASE — seven pages of seventy-seven — so a route that
    // quietly touched every page would be a different and much worse feature.
    const before = await openWhole();
    let untouched: Uint8Array;
    let inkedBefore: number;
    try {
      untouched = new Uint8Array((await before.render(1, 1)).rgba);
      inkedBefore = new Uint8Array((await before.render(0, 1)).rgba).length;
    } finally {
      before.close();
    }
    expect(inkedBefore).toBeGreaterThan(0);

    const doc = await openWhole();
    let delta: Uint8Array;
    try {
      const size = await doc.pageSize(0);
      await doc.annotatePage(0, solid(40, 20), 40, 20, [size.width / 40, 0, 0, size.height / 20, 0, 0]);
      delta = await doc.exportIncremental();
    } finally {
      doc.close();
    }

    const out = await AsyncPdfDocument.openWhole(exports, syncCalls(exports), join(pdf, delta));
    try {
      // Page 0 is solidly inked — every sample black, since the coverage was
      // full and the matrix covers the page.
      const inked = await out.render(0, 1);
      let dark = 0;
      for (let i = 0; i < inked.rgba.length; i += 4) if (inked.rgba[i] < 64) dark += 1;
      expect(dark).toBe(inked.width * inked.height);
      // Page 1 is byte-for-byte what it was. Not "looks similar": a placement
      // bug that put the ink on the wrong page passes every count-based check.
      const other = await out.render(1, 1);
      expect(Array.from(other.rgba)).toEqual(Array.from(untouched));
    } finally {
      out.close();
    }
  });

  it("refuses a document nothing was written on", async () => {
    // An empty delta concatenates to a byte-identical copy of the original,
    // which the raw-download row already offers. Producing it under a name that
    // promises ink would be a lie the user cannot see.
    const doc = await openWhole();
    try {
      await expect(doc.exportIncremental()).rejects.toThrow(/no ink/i);
    } finally {
      doc.close();
    }
  });

  it("rejects an alpha buffer that does not match its dimensions, before the call", async () => {
    // The same guard `exportPage` gets, and it has to be on both doors: the
    // module reads `w * h` bytes from a raw pointer either way.
    const doc = await openWhole();
    try {
      await expect(doc.annotatePage(0, solid(10, 10), 20, 20, [1, 0, 0, 1, 0, 0])).rejects.toThrow(
        /alpha/,
      );
    } finally {
      doc.close();
    }
  });

  it("surfaces MuPDF's refusal for a page that does not exist", async () => {
    const doc = await openWhole();
    try {
      await expect(doc.annotatePage(99, solid(4, 4), 4, 4, [1, 0, 0, 1, 0, 0])).rejects.toThrow();
    } finally {
      doc.close();
    }
  });

  it("a closed document refuses both halves", async () => {
    const doc = await openWhole();
    doc.close();
    await expect(doc.annotatePage(0, solid(4, 4), 4, 4, [1, 0, 0, 1, 0, 0])).rejects.toThrow(/closed/);
    await expect(doc.exportIncremental()).rejects.toThrow(/closed/);
  });

  it("hands back bytes we own — a later export cannot change them", async () => {
    // The module reuses one export buffer, so a view onto wasm memory would
    // mutate under the caller. The delta is the one payload that is concatenated
    // with a Blob LATER, so an aliased view here would be read after the module
    // had already reused it.
    const doc = await openWhole();
    try {
      const size = await doc.pageSize(0);
      await doc.annotatePage(0, solid(4, 4), 4, 4, [size.width / 4, 0, 0, size.height / 4, 0, 0]);
      const delta = await doc.exportIncremental();
      const snapshot = new Uint8Array(delta);
      await doc.exportPage(1, solid(8, 8), 8, 8, [37, 0, 0, 18, 0, 0]);
      expect(delta).toEqual(snapshot);
    } finally {
      doc.close();
    }
  });
});

describe("pageLinks — the document's own links, as far as the client", () => {
  // The COORDINATE claims and the shim's own refusals are asserted in
  // `webapp/wasm/tests/pdf_decode_abi.mjs`, against fixtures with an off-origin
  // box and a `/Rotate 90`. What is asserted here is the rest of the chain:
  // that the JSON the module writes survives the ABI boundary as typed records,
  // in the same units `pageSize` reports, with the module's buffer released on
  // every path.

  /** A two-page PDF whose page 0 carries `annots`. Two, so a target resolves. */
  function linkedPdf(annots: string[]): Uint8Array {
    const refs = annots.map((_, i) => `${6 + i} 0 R`).join(" ");
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R" +
        ` /Resources << >> /Annots [${refs}] >>`,
      "<< /Length 9 >>\nstream\n0 0 0 rg\n\nendstream",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>",
      ...annots,
    ];
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (const [i, body] of objs.entries()) {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    }
    const startxref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  }

  const annot = (rect: number[], action: string): string =>
    `<< /Type /Annot /Subtype /Link /Rect [${rect.join(" ")}] /Border [0 0 0]` +
    ` /A << ${action} >> >>`;

  const open = (bytes: Uint8Array): Promise<AsyncPdfDocument> =>
    AsyncPdfDocument.openWhole(exports, syncCalls(exports), bytes);

  it("hands over typed records in the same units pageSize reports", async () => {
    const doc = await open(
      linkedPdf([
        annot([20, 20, 80, 60], "/S /URI /URI (https://example.invalid/a)"),
        annot([100, 20, 160, 60], "/S /GoTo /D [5 0 R /XYZ 0 100 0]"),
      ]),
    );
    try {
      expect(await doc.pageSize(0)).toEqual({ width: 200, height: 100 });
      const links = await doc.pageLinks(0);
      expect(links).toHaveLength(2);
      // Top-left origin, y down, POINTS — the annot at PDF y 20..60 on a 100pt
      // page displays at y 40..80.
      expect(links[0]).toEqual({
        x: 20,
        y: 40,
        w: 60,
        h: 40,
        page: -1,
        uri: "https://example.invalid/a",
      });
      // RESOLVED IN THE MODULE. The client never sees `5 0 R`.
      expect(links[1]!.page).toBe(1);
      expect(links[1]!.x).toBe(100);
    } finally {
      doc.close();
    }
  });

  it("never lets a `javascript:` uri reach the client at all", async () => {
    // The shim drops it, so the payload does not carry it; `linkTarget` refuses
    // it a second time before it could become an href. This is the first gate.
    const doc = await open(
      linkedPdf([
        annot([20, 20, 80, 60], "/S /URI /URI (javascript:alert\\(1\\))"),
        annot([100, 20, 160, 60], "/S /URI /URI (data:text/html,<script>x</script>)"),
        annot([20, 70, 80, 90], "/S /URI /URI (https://example.invalid/ok)"),
      ]),
    );
    try {
      const links = await doc.pageLinks(0);
      expect(links.map((l) => l.uri)).toEqual(["https://example.invalid/ok"]);
    } finally {
      doc.close();
    }
  });

  it("answers [] for a page with no links — that is not a failure", async () => {
    // Most pages have none, and a viewer that threw here would take the PAGE
    // down with it.
    const doc = await open(linkedPdf([annot([20, 20, 80, 60], "/S /URI /URI (https://a.invalid/)")]));
    try {
      expect(await doc.pageLinks(1)).toEqual([]);
    } finally {
      doc.close();
    }
  });

  it("answers [] rather than throwing for a page the module refuses", async () => {
    const doc = await openWhole();
    try {
      expect(await doc.pageLinks(99)).toEqual([]);
    } finally {
      doc.close();
    }
  });

  it("releases the module's buffer, so the same page answers the same twice", async () => {
    // One buffer at a time, replaced by the next call: a second read of the
    // same page must not see a stale pointer or an accumulated payload.
    const doc = await open(linkedPdf([annot([20, 20, 80, 60], "/S /URI /URI (https://a.invalid/)")]));
    try {
      const first = await doc.pageLinks(0);
      const second = await doc.pageLinks(0);
      expect(second).toEqual(first);
      expect(second).toHaveLength(1);
    } finally {
      doc.close();
    }
  });

  it("falls back to the raw export when PdfCalls does not name pageLinks", async () => {
    // `PdfCalls.pageLinks` is OPTIONAL, for a caller building the table by hand
    // — which is right on the non-JSPI path, where nothing suspends, and wrong
    // on the JSPI one (`pdfWorker.test.ts` asserts the wrapper is there).
    const bare = { ...syncCalls(exports), pageLinks: undefined };
    const doc = await AsyncPdfDocument.openWhole(
      exports,
      bare,
      linkedPdf([annot([20, 20, 80, 60], "/S /URI /URI (https://a.invalid/)")]),
    );
    try {
      expect((await doc.pageLinks(0))[0]!.uri).toBe("https://a.invalid/");
    } finally {
      doc.close();
    }
  });

  it("a closed document throws rather than using a stale handle", async () => {
    const doc = await openWhole();
    doc.close();
    await expect(doc.pageLinks(0)).rejects.toThrow(/closed/);
  });
});
