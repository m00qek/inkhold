import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { buildPdf, placeWords, type PdfPage, type TextLayer } from "../../src/export/pdf";
import { PX_PER_MM, W, H, blank, WORDS, text, bytesOf, SW, SH, recordingPages, collect } from "./pdf.shared";

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
