import { describe, it, expect } from "vitest";
import { annotRect, annotsEntry, pdfTextString } from "../../src/export/pdfAnnots";
import type { PdfLink } from "../../src/render/pdfWire";

/** A panel and a page whose scale is exactly 0.5, so every number is readable. */
const PANEL = { width: 100, height: 200 };
const PAGE = { width: 50, height: 100 };

const HIGH: PdfLink = { x: 10, y: 20, w: 30, h: 40, page: -1, uri: "https://example.com/" };

describe("annotRect", () => {
  // A link near the top of the panel must land at large y: PDF measures from the bottom.
  // A centred rect would pass with or without the flip.
  it("flips Y, against a rect that is not vertically centred", () => {
    const rect = annotRect(HIGH, PANEL, PAGE)!;
    expect(rect).toEqual({ x0: 5, y0: 70, x1: 20, y1: 90 });
    expect(rect.y0).not.toBe(10);
    expect(rect.y1).not.toBe(30);
    expect(rect.y0).toBeLessThan(rect.y1);
  });

  it("scales panel pixels to points by the page's width alone", () => {
    // A4 width with the Nomad's aspect.
    const panel = { width: 1404, height: 1872 };
    const page = { width: 595.28, height: 793.71 };
    const rect = annotRect({ ...HIGH, x: 702, y: 0, w: 702, h: 936 }, panel, page)!;
    expect(rect.x0).toBeCloseTo(297.64, 2);
    expect(rect.x1).toBeCloseTo(595.28, 2);
    expect(rect.y1).toBeCloseTo(793.71, 2);
    expect(rect.y0).toBeCloseTo(396.86, 1);
  });

  it("puts a link at the very top of the panel at the very top of the page", () => {
    const rect = annotRect({ ...HIGH, x: 0, y: 0, w: 100, h: 10 }, PANEL, PAGE)!;
    expect(rect.y1).toBe(100);
    expect(rect.x0).toBe(0);
    expect(rect.x1).toBe(50);
  });

  it("clips a rect that overhangs the panel rather than dropping it", () => {
    // A device box overshooting by a pixel is still a real link.
    const over: PdfLink = { ...HIGH, x: 90, y: 190, w: 30, h: 30 };
    expect(annotRect(over, PANEL, PAGE)).toEqual({ x0: 45, y0: 0, x1: 50, y1: 5 });
  });

  it("refuses a rect with nothing left on the page, and a degenerate one", () => {
    expect(annotRect({ ...HIGH, x: 200, y: 10, w: 30, h: 10 }, PANEL, PAGE)).toBeNull();
    expect(annotRect({ ...HIGH, x: 10, y: 300, w: 30, h: 10 }, PANEL, PAGE)).toBeNull();
    expect(annotRect({ ...HIGH, w: 0 }, PANEL, PAGE)).toBeNull();
    expect(annotRect({ ...HIGH, h: -5 }, PANEL, PAGE)).toBeNull();
    expect(annotRect({ ...HIGH, x: -40, w: 30 }, PANEL, PAGE)).toBeNull();
  });

  it("refuses NaN and infinity rather than writing them into a page dictionary", () => {
    // `/Rect [ NaN … ]` is a file no reader opens.
    expect(annotRect({ ...HIGH, x: Number.NaN }, PANEL, PAGE)).toBeNull();
    expect(annotRect({ ...HIGH, h: Number.POSITIVE_INFINITY }, PANEL, PAGE)).toBeNull();
  });

  it("refuses a degenerate panel or page instead of dividing by zero", () => {
    expect(annotRect(HIGH, { width: 0, height: 200 }, PAGE)).toBeNull();
    expect(annotRect(HIGH, PANEL, { width: 50, height: 0 })).toBeNull();
  });
});

describe("pdfTextString", () => {
  it("escapes the three metacharacters, so a URI with a bracket stays one string", () => {
    // An unescaped `)` would end the string and leak operators into the page dict.
    expect(pdfTextString("https://e.com/a(b)c\\d")).toBe("(https://e.com/a\\(b\\)c\\\\d)");
  });

  it("writes a non-ASCII URI as UTF-16BE with a BOM, not as raw bytes", () => {
    // Literal strings are PDFDocEncoding, not Latin-1, over 0x80–0xA0; `FEFF` hex settles it.
    const s = pdfTextString("https://ç.example");
    expect(s.startsWith("<FEFF")).toBe(true);
    expect(s.endsWith(">")).toBe(true);
    expect(s).toContain("00E7");
    expect(s.slice(1, -1)).toMatch(/^[0-9A-F]+$/);
    expect((s.length - 2) % 4).toBe(0);
  });

  it("keeps a surrogate pair as its two code units", () => {
    const s = pdfTextString("https://e.com/\u{1F600}");
    expect(s).toContain("D83DDE00");
  });

  it("hex-encodes a control character rather than embedding it in a literal", () => {
    expect(pdfTextString("https://e.com/\na").startsWith("<FEFF")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/** Every page is in the document, at the writer's `4 + 3i`. */
const ALL = (i: number): number => 4 + 3 * i;
/** No page is: a SINGLE-PAGE export, where an internal link has no target. */
const NONE = (): null => null;

const ctx = (pageObjOf: (i: number) => number | null = ALL) => ({
  panel: PANEL,
  page: PAGE,
  pageObjOf,
});

describe("annotsEntry", () => {
  it("says NOTHING at all for a page with no links", () => {
    // Byte-identical output for notebooks without links.
    expect(annotsEntry([], ctx())).toBe("");
    expect(annotsEntry(null, ctx())).toBe("");
    expect(annotsEntry(undefined, ctx())).toBe("");
  });

  it("writes an external link as a URI action, borderless", () => {
    const s = annotsEntry([HIGH], ctx());
    expect(s).toBe(
      " /Annots [ << /Type /Annot /Subtype /Link /Rect [ 5 70 20 90 ] /Border [0 0 0]" +
        " /A << /S /URI /URI (https://example.com/) >> >> ]",
    );
    expect(s.startsWith(" ")).toBe(true);
  });

  it("writes an internal link as a destination naming the target page's OBJECT", () => {
    const link: PdfLink = { ...HIGH, page: 41, uri: "" };
    // 4 + 3*41 = 127.
    expect(annotsEntry([link], ctx())).toContain("/Dest [ 127 0 R /XYZ null null null ]");
    expect(annotsEntry([link], ctx())).not.toContain("/URI");
  });

  it("DROPS an internal link when its page is not in the document", () => {
    // Single-page export: an internal link has no target page, so no annotation.
    const link: PdfLink = { ...HIGH, page: 41, uri: "" };
    expect(annotsEntry([link], ctx(NONE))).toBe("");
    expect(annotsEntry([link, HIGH], ctx(NONE))).toContain("/URI (https://example.com/)");
  });

  it("refuses every scheme the reader refuses, and writes no defused annotation", () => {
    for (const uri of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "vbscript:x",
      "http:evil",
      "",
    ]) {
      expect(annotsEntry([{ ...HIGH, uri }], ctx())).toBe("");
    }
  });

  it("keeps http, https and mailto", () => {
    for (const uri of ["http://e.com/", "https://e.com/", "mailto:a@b.c"]) {
      expect(annotsEntry([{ ...HIGH, uri }], ctx())).toContain(uri);
    }
  });

  it("drops the links it cannot place and keeps the rest of the page's", () => {
    const off: PdfLink = { ...HIGH, x: 500, uri: "https://gone.example/" };
    const s = annotsEntry([off, HIGH], ctx());
    expect(s).not.toContain("gone.example");
    expect((s.match(/\/Subtype \/Link/g) ?? []).length).toBe(1);
  });

  it("puts every link of a page in ONE array", () => {
    const s = annotsEntry([HIGH, { ...HIGH, page: 1, uri: "" }, { ...HIGH, uri: "mailto:a@b.c" }], ctx());
    expect((s.match(/\/Annots/g) ?? []).length).toBe(1);
    expect((s.match(/\/Subtype \/Link/g) ?? []).length).toBe(3);
  });

  it("rounds points rather than writing a full float per coordinate", () => {
    // 51,256 links in the real capture: two decimals saves ~10 bytes a rect.
    const s = annotsEntry([{ ...HIGH, x: 33, w: 7 }], { ...ctx(), page: { width: 100, height: 100 } });
    expect(s).toContain("/Rect [ 33 40 40 80 ]");
    expect(s).not.toMatch(/\d\.\d{3}/);
  });
});
