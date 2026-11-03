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

// The real module: proves `wasiShim` suffices in place of WASI, which Node's ABI
// test (`pdf_decode_abi.mjs`) cannot.

const here = dirname(fileURLToPath(import.meta.url));
// `public/`, not `zig-out/`: the served artifact, built by the `pretest` hook.
const wasmPath = join(here, "../../public/pdf-decode.wasm");
const pdfPath = join(here, "../../wasm/tests/fixtures/two-page.pdf");

/** The whole-file path, which the worker runs on any browser without JSPI. */
const openWhole = (): Promise<AsyncPdfDocument> =>
  AsyncPdfDocument.openWhole(exports, syncCalls(exports), pdf);

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

describe("ink_open_stream — the same document, pulled through `ink.host_read`", () => {
  // The `pdf_shim.c` stream must keep `stm->pos`, its window and `fz_tell` consistent.

  it("opens, counts, sizes and renders identically to the whole-file path", async () => {
    const streamed = await AsyncPdfDocument.openStream(exports, syncCalls(exports), pdf.length);
    const whole = await openWhole();
    try {
      expect(await streamed.pageCount()).toBe(await whole.pageCount());
      expect(await streamed.pageSize(1)).toEqual(await whole.pageSize(1));
      const a = await streamed.render(0, 2);
      const b = await whole.render(0, 2);
      expect(a.width).toBe(b.width);
      expect(a.height).toBe(b.height);
      // Byte for byte: wrong offsets can still produce a plausible page.
      expect(Array.from(a.rgba)).toEqual(Array.from(b.rgba));
    } finally {
      streamed.close();
      whole.close();
    }
  });

  it("does not re-read what it is already holding", async () => {
    // Without the window in `ink_stream_seek`, this 688-byte file cost seven host reads:
    // `fz_seek` drops the window on every backwards seek.
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
    // A host read < 0 is `fz_throw` inside the stream's `next`; the instance must survive.
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
    // Not a document: a header here would make `new Blob([original, delta])` nonsense.
    expect(new TextDecoder().decode(delta.subarray(0, 5))).not.toBe("%PDF-");
    expect(delta.length).toBeGreaterThan(0);

    const whole = join(pdf, delta);
    expect(Array.from(whole.subarray(0, pdf.length))).toEqual(Array.from(pdf));

    const out = await AsyncPdfDocument.openWhole(exports, syncCalls(exports), whole);
    try {
      expect(await out.pageCount()).toBe(2);
      expect(await out.pageSize(1)).toEqual({ width: 300, height: 150 });
    } finally {
      out.close();
    }
  });

  it("inks the pages it was given and leaves the others exactly as they were", async () => {
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
      const inked = await out.render(0, 1);
      let dark = 0;
      for (let i = 0; i < inked.rgba.length; i += 4) if (inked.rgba[i] < 64) dark += 1;
      expect(dark).toBe(inked.width * inked.height);
      const other = await out.render(1, 1);
      expect(Array.from(other.rgba)).toEqual(Array.from(untouched));
    } finally {
      out.close();
    }
  });

  it("refuses a document nothing was written on", async () => {
    // An empty delta would just be the original under a name that promises ink.
    const doc = await openWhole();
    try {
      await expect(doc.exportIncremental()).rejects.toThrow(/no ink/i);
    } finally {
      doc.close();
    }
  });

  it("rejects an alpha buffer that does not match its dimensions, before the call", async () => {
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
    // The delta is concatenated later, so an aliased view would be read after reuse.
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
      // Top-left origin, y down, points: PDF y 20..60 on a 100pt page displays at 40..80.
      expect(links[0]).toEqual({
        x: 20,
        y: 40,
        w: 60,
        h: 40,
        page: -1,
        uri: "https://example.invalid/a",
      });
      // Resolved in the module; the client never sees `5 0 R`.
      expect(links[1]!.page).toBe(1);
      expect(links[1]!.x).toBe(100);
    } finally {
      doc.close();
    }
  });

  it("never lets a `javascript:` uri reach the client at all", async () => {
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
    // `PdfCalls.pageLinks` is optional (fine without JSPI; `pdfWorker.test.ts` covers JSPI).
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
