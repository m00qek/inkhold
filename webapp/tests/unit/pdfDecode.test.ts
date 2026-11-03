import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { decoderImports, wasiShim, type PdfDecoderExports } from "../../src/render/pdfLoader";
import { AsyncPdfDocument, syncCalls } from "../../src/render/pdfDocument";

// The real module: proves `wasiShim` suffices in place of WASI, which Node's ABI
// test (`pdf_decode_abi.mjs`) cannot.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The real module: proves `wasiShim` suffices in place of WASI, which Node's ABI
// test (`pdf_decode_abi.mjs`) cannot.

const here = dirname(fileURLToPath(import.meta.url));

// `public/`, not `zig-out/`: the served artifact, built by the `pretest` hook.
const wasmPath = join(here, "../../public/pdf-decode.wasm");

const pdfPath = join(here, "../../wasm/tests/fixtures/two-page.pdf");

/** The whole-file path, which the worker runs on any browser without JSPI. */
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
  // The module imports `ink.host_read`; omitting it is a link error. Synchronous here.
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

/** A one-page PDF with a given `/MediaBox` and `/Rotate`; all ASCII, so string
 *  offsets are byte offsets for the xref. */
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
    // `fd_write` must write the byte count back, or libc loops on a short write.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mem = new WebAssembly.Memory({ initial: 1 });
      const shim = wasiShim(() => mem);
      const w = (shim.wasi_snapshot_preview1 as Record<string, CallableFunction>).fd_write;
      const d = new DataView(mem.buffer);
      const msg = new TextEncoder().encode("cannot find font\n");
      new Uint8Array(mem.buffer).set(msg, 100);
      d.setUint32(0, 100, true);
      d.setUint32(4, msg.length, true);
      expect(w(2, 0, 1, 200)).toBe(0);
      expect(d.getUint32(200, true)).toBe(msg.length);  // bytes written, or libc spins
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
      // Width then height; checked against the render's dims, a different export.
      const bmp = await doc.render(0, 1);
      expect(bmp.width).toBe(Math.round(a.width));
      expect(bmp.height).toBe(Math.round(a.height));
      await expect(doc.pageSize(99)).rejects.toThrow();
    } finally {
      doc.close();
    }
  });

  // A `.pdf` tile's aspect comes from `pageSize` alone, so it must report the page as
  // seen: `fz_bound_page` applies `/Rotate`.
  it("a /Rotate 90 page measures ROTATED — pageSize and render agree", async () => {
    const upright = await AsyncPdfDocument.openWhole(exports, syncCalls(exports), minimalPdf(400, 600, 0));
    const turned = await AsyncPdfDocument.openWhole(exports, syncCalls(exports), minimalPdf(400, 600, 90));
    try {
      const a = await upright.pageSize(0);
      expect([a.width, a.height]).toEqual([400, 600]);

      const b = await turned.pageSize(0);
      expect([b.width, b.height]).toEqual([600, 400]);
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
    // A view into wasm memory would be overwritten by the next page or detached by growth.
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
    doc.close();
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
  // PDF-level behaviour is in `pdf_decode_abi.mjs`; here, the wrapper's pointers,
  // copies and releases.

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
      // The module reads `w * h` bytes from a raw pointer, so a short buffer is caught first.
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
      await expect(doc.exportPage(99, solid(4, 4), 4, 4, [1, 0, 0, 1, 0, 0])).rejects.toThrow();
      const bytes = await doc.exportPage(0, solid(4, 4), 4, 4, [50, 0, 0, 25, 0, 0]);
      expect(bytes.length).toBeGreaterThan(0);
    } finally {
      doc.close();
    }
  });

  it("returns bytes we own — a later export cannot change them", async () => {
    const doc = await openWhole();
    try {
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
