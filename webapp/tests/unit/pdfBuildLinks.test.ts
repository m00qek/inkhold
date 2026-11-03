// buildPdf link annotations and WinAnsi text.

import { describe, it, expect } from "vitest";
import { buildPdf, toWinAnsi, type PdfPage } from "../../src/export/pdf";
import type { PdfLink } from "../../src/render/pdfWire";
import { PX_PER_MM, W, H, blank, WORDS, text, bytesOf, SW, SH, recordingPages, collect } from "./pdf.shared";

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
