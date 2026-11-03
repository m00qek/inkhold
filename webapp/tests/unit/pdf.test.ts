import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import {
  buildPdf,
  pdfChunks,
  placeWords,
  toWinAnsi,
  type PdfOptions,
  type PdfPage,
  type TextLayer,
} from "../../src/export/pdf";
import type { WordBox } from "../../src/core/types";
import type { PdfLink } from "../../src/render/pdfWire";

/** The verified scale for the 1404x1872 class: 1404 px over a 118.64 mm canvas. */
const PX_PER_MM = 1404 / 118.64;
const W = 1404;
const H = 1872;

/** A blank page's worth of grayscale. Content is irrelevant to structure. */
function blank(w = W, h = H): Uint8Array {
  return new Uint8Array(w * h).fill(0xff);
}

/** Words at the verified scale; the last is the lowest word of `sample-2.note` (1757 of 1872 px). */
const WORDS: WordBox[] = [
  { text: "alpha", xMm: 10, yMm: 12, wMm: 25, hMm: 7 },
  { text: "beta", xMm: 40, yMm: 100, wMm: 18, hMm: 6 },
  { text: "Test", xMm: 89.922, yMm: 136.904, wMm: 21.3505, hMm: 11.5485 },
];

/** Latin-1 view of the file, for structural greps. */
function text(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** The finished file as bytes; `buildPdf` returns a Blob so large ones stay off the heap. */
async function bytesOf(pages: PdfPage[]): Promise<Uint8Array> {
  return new Uint8Array(await (await buildPdf(pages)).arrayBuffer());
}

describe("buildPdf", () => {
  it("produces a valid single-page document with the right header, trailer and object count", async () => {
    const bytes = await bytesOf([{ width: W, height: H, gray: blank() }]);
    const s = text(bytes);

    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("/Type /Catalog");
    expect(s).toContain("/Count 1");
    expect((s.match(/\/Type \/Page\b/g) ?? []).length).toBe(1);

    const size = /\/Size (\d+)/.exec(s)?.[1];
    expect(size).toBe("7");  // 1 catalog + 1 tree + 3 per page + 1 font
    const startxref = Number(/startxref\n(\d+)/.exec(s)?.[1]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");

    const rows = [...s.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(rows).toHaveLength(6);
    rows.forEach((offset, i) => {
      expect(s.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });
  });

  it("sizes the page to A4 width and preserves the note's aspect ratio", async () => {
    const bytes = await bytesOf([{ width: W, height: H, gray: blank() }]);
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text(bytes));
    expect(box).not.toBeNull();

    const [w, h] = [Number(box![1]), Number(box![2])];
    expect(w).toBeCloseTo(595.28, 2);
    expect(h / w).toBeCloseTo(H / W, 3);
  });

  it("embeds the raster as a Flate-compressed DeviceGray image", async () => {
    const bytes = await bytesOf([{ width: W, height: H, gray: blank() }]);
    const s = text(bytes);
    expect(s).toContain("/Subtype /Image");
    expect(s).toContain("/ColorSpace /DeviceGray");
    expect(s).toContain("/Filter /FlateDecode");
    expect(s).toContain(`/Width ${W} /Height ${H}`);
    expect(bytes.length).toBeLessThan((W * H) / 100);
  });

  it("writes one page per input, in order", async () => {
    const bytes = await bytesOf([
      { width: W, height: H, gray: blank() },
      { width: W, height: H, gray: blank() },
    ]);
    const s = text(bytes);
    expect(s).toContain("/Count 2");
    expect((s.match(/\/Type \/Page\b/g) ?? []).length).toBe(2);
  });

  describe("the invisible text layer", () => {
    const layer: TextLayer = { pxPerMm: PX_PER_MM, words: WORDS };

    it("is present, invisible, and carries the words when the scale is known", async () => {
      const bytes = await bytesOf([{ width: W, height: H, gray: blank(), textLayer: layer }]);
      const s = text(bytes);

      // Mode 3 Tr = render neither fill nor stroke: selectable, not painted.
      expect(s).toContain("3 Tr");
      expect(s).toContain("(alpha) Tj");
      expect(s).toContain("(beta) Tj");
      // Helvetica needs no embedding; WinAnsi keeps accents.
      expect(s).toContain("/BaseFont /Helvetica");
      expect(s).toContain("/Encoding /WinAnsiEncoding");
      expect(s).toContain("/Font << /F1");
    });

    // Unknown hardware has no verified mm scale, so no text layer at all.
    it("is ABSENT when the page has no text layer at all", async () => {
      const bytes = await bytesOf([{ width: W, height: H, gray: blank(), textLayer: null }]);
      const s = text(bytes);
      expect(s).not.toContain("3 Tr");
      expect(s).not.toContain("Tj");
      expect(s).not.toContain("alpha");
    });

    it("is dropped ENTIRELY when a box falls outside the page at the given scale", async () => {
      // The same words at a scale 10% out push the lowest word past the bottom edge.
      const wrong: TextLayer = { pxPerMm: PX_PER_MM * 1.1, words: WORDS };
      expect(placeWords(wrong, W, H)).toBeNull();

      const bytes = await bytesOf([{ width: W, height: H, gray: blank(), textLayer: wrong }]);
      const s = text(bytes);
      expect(s).not.toContain("3 Tr");
      expect(s).not.toContain("(alpha) Tj");
    });

    // Only a backstop: the real defence is the server refusing unmeasured scales.
    it("cannot catch a wrong scale from sparse top-of-page words alone", () => {
      const sparse = [{ text: "alpha", xMm: 10, yMm: 12, wMm: 25, hMm: 7 }];
      expect(placeWords({ pxPerMm: PX_PER_MM * 1.1, words: sparse }, W, H)).not.toBeNull();
    });

    it("accepts the real data's worst case and rejects one pixel beyond it", () => {
      // The real capture's furthest edge is ~1397 px on a 1404 px page.
      const edge: TextLayer = {
        pxPerMm: PX_PER_MM,
        words: [{ text: "edge", xMm: 100, yMm: 10, wMm: 18.02, hMm: 6 }],
      };
      const placed = placeWords(edge, W, H);
      expect(placed).not.toBeNull();
      expect(placed![0]!.x + placed![0]!.w).toBeGreaterThan(1390);
      expect(placeWords(edge, 1300, H)).toBeNull();
    });

    it("flips Y: PDF measures from the bottom, the boxes from the top", async () => {
      // A word near the top must land at large y: PDF measures from the bottom.
      const near: TextLayer = {
        pxPerMm: PX_PER_MM,
        words: [{ text: "top", xMm: 10, yMm: 5, wMm: 20, hMm: 6 }],
      };
      const bytes = await bytesOf([{ width: W, height: H, gray: blank(), textLayer: near }]);
      const tm = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(text(bytes));
      expect(tm).not.toBeNull();

      const pageH = 595.28 * (H / W);
      const y = Number(tm![2]);
      expect(y).toBeGreaterThan(pageH * 0.9);
    });

    it("rejects a non-finite or non-positive scale rather than emitting NaN", () => {
      for (const pxPerMm of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(placeWords({ pxPerMm, words: WORDS }, W, H)).toBeNull();
      }
    });

    it("skips words with nothing to place without discarding the layer", () => {
      const mixed: TextLayer = {
        pxPerMm: PX_PER_MM,
        words: [
          { text: "kept", xMm: 10, yMm: 10, wMm: 20, hMm: 6 },
          { text: "zero-area", xMm: 10, yMm: 30, wMm: 0, hMm: 0 },
          { text: "", xMm: 10, yMm: 40, wMm: 20, hMm: 6 },
        ],
      };
      const placed = placeWords(mixed, W, H);
      expect(placed?.map((p) => p.text)).toEqual(["kept"]);
    });

    it("escapes the PDF string metacharacters so the content stream stays parseable", async () => {
      const tricky: TextLayer = {
        pxPerMm: PX_PER_MM,
        words: [{ text: "a(b)c\\d", xMm: 10, yMm: 10, wMm: 20, hMm: 6 }],
      };
      const s = text(await bytesOf([{ width: W, height: H, gray: blank(), textLayer: tricky }]));
      expect(s).toContain("(a\\(b\\)c\\\\d) Tj");
    });

    it("declares a byte length matching the accented bytes it wrote", async () => {
      // Regression: a UTF-8-encoded JS string made `/Length` disagree with the bytes.
      const accented: TextLayer = {
        pxPerMm: PX_PER_MM,
        words: [{ text: "avaliação", xMm: 10, yMm: 10, wMm: 30, hMm: 6 }],
      };
      const bytes = await bytesOf([{ width: W, height: H, gray: blank(), textLayer: accented }]);
      const s = text(bytes);

      const declared = Number(/<< \/Length (\d+) >>\nstream\n/.exec(s)?.[1]);
      const start = s.indexOf("stream\n", s.indexOf("<< /Length ")) + "stream\n".length;
      expect(s.slice(start, start + declared).endsWith("ET")).toBe(true);
      expect(s.slice(start + declared, start + declared + 10)).toBe("\nendstream");
    });
  });
});

// --- the whole-document path: one page live at a time ------------------------

/** A small page: these tests are about ORDER and OFFSETS, not about pixels. */
const SW = 64;
const SH = 32;

/** The image XObject dict for page `i` opens with this object number. */
const imageObjOf = (num: number): number => (num - 6) / 3;

/** A page source that logs every call and scribbles 0xEE over each page's buffer
 *  once the next is requested, so a writer that banked pages shows it in the bytes. */
async function* recordingPages(n: number, log: string[]): AsyncGenerator<PdfPage> {
  let prev: Uint8Array | null = null;
  const release = (i: number): void => {
    prev!.fill(0xee);
    prev = null;
    log.push(`release ${i}`);
  };

  for (let i = 0; i < n; i++) {
    if (prev) release(i - 1);
    log.push(`request ${i}`);
    const gray = new Uint8Array(SW * SH).fill(i + 1);
    prev = gray;
    yield { width: SW, height: SH, gray };
  }
  if (prev) release(n - 1);
}

interface Collected {
  chunks: Uint8Array[];
  /** The deflated image stream of each page, in order. */
  images: Uint8Array[];
  bytes: Uint8Array;
}

/** Drain `pdfChunks`, noting when each page's image stream is written out. */
async function collect(
  pages: AsyncIterable<PdfPage>,
  log?: string[],
  opts?: PdfOptions,
): Promise<Collected> {
  const chunks: Uint8Array[] = [];
  const images: Uint8Array[] = [];
  let expectImage = false;

  for await (const chunk of pdfChunks(pages, opts)) {
    if (expectImage) {
      images.push(chunk);
      expectImage = false;
    }
    const head = text(chunk.subarray(0, 160));
    const m = /^(\d+) 0 obj/.exec(head);
    if (m && head.includes("/Subtype /Image")) {
      log?.push(`write ${imageObjOf(Number(m[1]))}`);
      expectImage = true;
    }
    chunks.push(chunk);
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return { chunks, images, bytes };
}

describe("buildPdf, streaming a whole document", () => {
  // Page k+1 is requested only after page k is written: at most one page is live.
  it("pulls one page at a time, writing and releasing each before asking for the next", async () => {
    const log: string[] = [];
    await collect(recordingPages(4, log), log);

    expect(log).toEqual([
      "request 0", "write 0", "release 0",
      "request 1", "write 1", "release 1",
      "request 2", "write 2", "release 2",
      "request 3", "write 3", "release 3",
    ]);
  });

  it("has finished with each page's pixels before the source destroys them", async () => {
    const { images } = await collect(recordingPages(4, []));
    expect(images).toHaveLength(4);

    images.forEach((image, i) => {
      const raw = inflateSync(Buffer.from(image));
      expect(raw).toHaveLength(SW * SH);
      expect(raw.every((b) => b === i + 1)).toBe(true);
    });
  });

  // `concat()` would hold the finished file twice.
  it("assembles the file from many chunks, never one whole-file buffer", async () => {
    const { chunks } = await collect(recordingPages(5, []));
    const total = chunks.reduce((sum, c) => sum + c.length, 0);

    expect(chunks.length).toBeGreaterThan(3 * 5);
    for (const c of chunks) expect(c.length).toBeLessThan(total / 2);
  });

  it("hands the chunks to a Blob rather than a heap-allocated array", async () => {
    const blob = await buildPdf(recordingPages(3, []));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);
  });

  // The page tree goes at the end (its /Count is unknown until the source drains) but
  // keeps object number 2.
  it("keeps a correct cross-reference table over a long document", async () => {
    const N = 30;
    const { bytes } = await collect(recordingPages(N, []));
    const s = text(bytes);

    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain(`/Count ${N}`);
    expect((s.match(/\/Type \/Page\b/g) ?? []).length).toBe(N);

    const count = 4 + 3 * N;  // 1 catalog + 1 tree + 1 font + 3 per page
    expect(/\/Size (\d+)/.exec(s)?.[1]).toBe(String(count));

    const startxref = Number(/startxref\n(\d+)/.exec(s)?.[1]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");

    const rows = [...s.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(rows).toHaveLength(count - 1);
    rows.forEach((offset, i) => {
      expect(s.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });

    for (let i = 0; i < N; i++) {
      expect(s).toContain(`/Im0 ${6 + 3 * i} 0 R`);
      expect(s).toContain(`/Contents ${5 + 3 * i} 0 R`);
    }
  });

  // Recognition is per page, so a notebook mixes pages with and without text.
  it("gives a text layer to the recognised pages of a document and not the rest", async () => {
    const layer: TextLayer = { pxPerMm: PX_PER_MM, words: WORDS };
    async function* mixed(): AsyncGenerator<PdfPage> {
      yield { width: W, height: H, gray: blank(), textLayer: layer };
      yield { width: W, height: H, gray: blank(), textLayer: null };
      yield { width: W, height: H, gray: blank(), textLayer: layer };
    }
    const { bytes } = await collect(mixed());
    const s = text(bytes);

    expect(s).toContain("/Count 3");
    expect((s.match(/\(alpha\) Tj/g) ?? []).length).toBe(2);
    expect((s.match(/3 Tr/g) ?? []).length).toBe(WORDS.length * 2);
    expect((s.match(/q 595\.28 0 0 [\d.]+ 0 0 cm \/Im0 Do Q\nendstream/g) ?? []).length).toBe(1);
  });

  it("writes no text at all when no page of the document has a layer", async () => {
    const { bytes } = await collect(recordingPages(6, []));
    const s = text(bytes);
    expect(s).not.toContain("3 Tr");
    expect(s).not.toContain(" Tj");
  });

  it("refuses an empty source rather than writing a page-less PDF", async () => {
    await expect(buildPdf([])).rejects.toThrow(/no pages/);
  });
});

// --- the links: inline annotations, forward references ----------------------

/** A link on a 1404x1872 page, in the panel pixels `EXTERNALLINKINFO` uses. */
const LINK: PdfLink = { x: 100, y: 60, w: 400, h: 90, page: -1, uri: "https://example.com/" };

/** A small page carrying `links`. */
function linkedPage(links: readonly PdfLink[]): PdfPage {
  return { width: SW, height: SH, gray: new Uint8Array(SW * SH).fill(0xff), links };
}

/** Three pages whose FIRST carries `links`. */
async function* pagesWith(links: readonly PdfLink[]): AsyncGenerator<PdfPage> {
  yield linkedPage(links);
  yield linkedPage([]);
  yield linkedPage([]);
}

/** {@link LINK}'s rect shrunk to fit a {@link SW}x{@link SH} page. */
const SMALL: PdfLink = { ...LINK, x: 4, y: 2, w: 20, h: 8 };

/** Three pages, one external and one internal link on the first. */
function linkedPages(): AsyncGenerator<PdfPage> {
  return pagesWith([SMALL, { ...SMALL, x: 30, page: 2, uri: "" }]);
}

/** {@link recordingPages}, with a link on every page. */
async function* linkedRecordingPages(n: number, log: string[]): AsyncGenerator<PdfPage> {
  for await (const page of recordingPages(n, log)) {
    yield { ...page, links: [{ ...LINK, x: 1, y: 1, w: 8, h: 4, page: 0, uri: "" }] };
  }
}

describe("the link annotations", () => {
  it("writes a page with no links EXACTLY as it did before links existed", async () => {
    // Notebooks without links must not change by a byte.
    const bare = await bytesOf([{ width: W, height: H, gray: blank() }]);
    for (const links of [[], null, undefined]) {
      const same = await bytesOf([{ width: W, height: H, gray: blank(), links }]);
      expect(same).toEqual(bare);
    }
    expect(text(bare)).not.toContain("/Annots");
  });

  it("puts the annotations INLINE in the page dictionary, keeping three objects a page", async () => {
    // Annotation objects would break `pageObj(i) = 4 + 3i`, which streaming relies on.
    const { bytes } = await collect(linkedPages(), undefined, { pageCount: 3 });
    const s = text(bytes);
    expect(s).toMatch(/\/Type \/Page\b[^\n]*\/Annots \[ << \/Type \/Annot/);
    expect(s).not.toMatch(/\d+ 0 obj\n<< \/Type \/Annot/);
    expect(/\/Size (\d+)/.exec(s)?.[1]).toBe(String(4 + 3 * 3));
  });

  it("keeps the cross-reference table correct with annotations in the page dicts", async () => {
    const { bytes } = await collect(linkedPages(), undefined, { pageCount: 3 });
    const s = text(bytes);
    const rows = [...s.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(rows).toHaveLength(4 + 3 * 3 - 1);
    rows.forEach((offset, i) => {
      expect(s.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });
  });

  // A 1703-page planner: page 2 names page 1701's object before it is written, legal
  // because the xref is written last.
  it("resolves a link from page 2 to page 1701, written 1699 pages early", async () => {
    const N = 1703;
    const target = 1700;
    async function* planner(): AsyncGenerator<PdfPage> {
      for (let i = 0; i < N; i++) {
        const links = i === 1 ? [{ ...LINK, x: 1, y: 1, w: 4, h: 4, page: target, uri: "" }] : [];
        yield { width: 8, height: 12, gray: new Uint8Array(8 * 12).fill(0xff), links };
      }
    }
    const { bytes } = await collect(planner(), undefined, { pageCount: N });
    const s = text(bytes);

    const obj = 4 + 3 * target;
    expect(s).toContain(`/Dest [ ${obj} 0 R /XYZ null null null ]`);
    const rows = [...s.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(s.slice(rows[obj - 1]!)).toMatch(new RegExp(`^${obj} 0 obj\\n<< /Type /Page`));
  });

  it("drops an internal link whose page is past the end of the document", async () => {
    // A dangling reference has no xref row, so the link is dropped.
    const { bytes } = await collect(
      pagesWith([{ ...SMALL, page: 9, uri: "" }, SMALL]),
      undefined,
      { pageCount: 3 },
    );
    const s = text(bytes);
    expect(s).not.toContain("/Dest");
    expect(s).toContain("/URI (https://example.com/)");
  });

  it("keeps a link's page and object aligned across a long document", async () => {
    const N = 12;
    async function* chain(): AsyncGenerator<PdfPage> {
      for (let i = 0; i < N; i++) {
        yield {
          width: 8,
          height: 12,
          gray: new Uint8Array(8 * 12).fill(0xff),
          links: [{ ...LINK, x: 1, y: 1, w: 4, h: 4, page: (i + 1) % N, uri: "" }],
        };
      }
    }
    const { bytes } = await collect(chain(), undefined, { pageCount: N });
    const dests = [...text(bytes).matchAll(/\/Dest \[ (\d+) 0 R/g)].map((m) => Number(m[1]));
    expect(dests).toEqual(Array.from({ length: N }, (_, i) => 4 + 3 * ((i + 1) % N)));
  });

  // The per-page export holds one page, so internal links have no target.
  it("drops internal links from a SINGLE-PAGE export and keeps the external ones", async () => {
    const bytes = await bytesOf([
      {
        width: W,
        height: H,
        gray: blank(),
        links: [{ ...LINK, page: 4, uri: "" }, LINK, { ...LINK, page: 0, uri: "" }],
      },
    ]);
    const s = text(bytes);
    expect(s).not.toContain("/Dest");
    expect((s.match(/\/Subtype \/Link/g) ?? []).length).toBe(1);
    expect(s).toContain("/A << /S /URI /URI (https://example.com/) >>");
  });

  it("writes no annotation at all for a refused scheme", async () => {
    const bytes = await bytesOf([
      { width: W, height: H, gray: blank(), links: [{ ...LINK, uri: "javascript:alert(1)" }] },
    ]);
    const s = text(bytes);
    expect(s).not.toContain("/Annots");
    expect(s).not.toContain("javascript");
  });

  it("escapes a URI containing a bracket, so the page dictionary stays parseable", async () => {
    const bytes = await bytesOf([
      {
        width: W,
        height: H,
        gray: blank(),
        links: [{ ...LINK, uri: "https://e.com/a(b)?x=1" }],
      },
    ]);
    expect(text(bytes)).toContain("/URI (https://e.com/a\\(b\\)?x=1)");
  });

  it("carries links and the invisible text layer on the same page", async () => {
    const bytes = await bytesOf([
      {
        width: W,
        height: H,
        gray: blank(),
        textLayer: { pxPerMm: PX_PER_MM, words: WORDS },
        links: [LINK],
      },
    ]);
    const s = text(bytes);
    expect(s).toContain("/Annots [ <<");
    expect(s).toContain("(alpha) Tj");
  });

  it("still pulls one page at a time when every page carries links", async () => {
    const log: string[] = [];
    await collect(linkedRecordingPages(4, log), log, { pageCount: 4 });
    expect(log).toEqual([
      "request 0", "write 0", "release 0",
      "request 1", "write 1", "release 1",
      "request 2", "write 2", "release 2",
      "request 3", "write 3", "release 3",
    ]);
  });

  it("refuses to finish a document shorter than the caller promised", async () => {
    await expect(buildPdf(recordingPages(2, []), { pageCount: 5 })).rejects.toThrow(/promised 5/);
  });
});

describe("toWinAnsi", () => {
  it("passes Portuguese accents through, which is why no font has to be embedded", () => {
    const s = toWinAnsi("avaliação — pré-visualização");
    expect(s).toContain("ção");
    expect([...s].every((c) => c.codePointAt(0)! <= 0xff)).toBe(true);
  });

  it("substitutes rather than drops characters outside the encoding", () => {
    // CJK has no WinAnsi byte; a placeholder keeps the word's shape and position.
    expect(toWinAnsi("a漢b")).toBe("a?b");
  });

  it("drops control characters", () => {
    expect(toWinAnsi("a\nb\tc")).toBe("abc");
  });
});
