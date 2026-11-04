import { describe, it, expect, vi } from "vitest";
import {
  createPdfFindController,
  matchWords,
  pdfCountText,
  type PdfFindState,
  type PdfFindView,
} from "../../src/pages/pdf/pdfFind";
import { parsePageWords, type PdfWord } from "../../src/render/pdfWire";
import { ovalsFor } from "../../src/pages/findOvals";
import { fold, words as wordTerms } from "../../src/search/fold";
import type { ApiFailureSink } from "../../src/api/client";
import type { WordBox } from "../../src/core/types";
import type { DocSearch, DocSearchResult, DocSegmentMatch } from "../../src/search/docSearch";

// A locator, not a judge: the index says which pages match; MuPDF says where. When
// they disagree the page still matches, with no box. The engine is faked.

const flush = () => new Promise((r) => setTimeout(r, 0));

function word(t: string, i: number): PdfWord {
  // One word per line; find never reads `line`, but the decoder always sends it.
  return { t, x: 10, y: 12 + i * 14, w: t.length * 6, h: 11, line: i };
}

/** A matching page; a PDF ordinal is the address, so no byte range. */
function match(segment: number, matches: number, terms: string[]): DocSegmentMatch {
  return { segment, offset: null, length: null, matches, terms };
}

const MD5 = "b".repeat(32);

interface Built {
  find: ReturnType<typeof createPdfFindController>;
  states: PdfFindState[];
  marks: { words: PdfWord[]; current: number }[];
  /** Every filmstrip badge map the controller published, in order. */
  badges: ReadonlyMap<number, number>[];
  view: PdfFindView;
  words: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
}

function build(
  opts: {
    pages?: DocSegmentMatch[];
    /** The words MuPDF finds, per page. A page absent from the map has none. */
    words?: Record<number, PdfWord[]>;
    usedFuzzy?: boolean;
  } = {},
): Built {
  const perPage = opts.words ?? {};
  const words = vi.fn(async (page: number) => perPage[page] ?? []);
  const usedFuzzy = opts.usedFuzzy ?? false;
  const search = vi.fn(
    async (md5: string, query: string): Promise<DocSearchResult> => ({
      query,
      md5,
      segments: opts.pages ?? [],
      usedFuzzy,
      expansions: usedFuzzy ? [{ typed: query, matched: "rutabaga" }] : [],
    }),
  );
  const docs: DocSearch = { search, drop: vi.fn() };

  const states: PdfFindState[] = [];
  const marks: { words: PdfWord[]; current: number }[] = [];
  const badges: ReadonlyMap<number, number>[] = [];
  const view: PdfFindView = {
    setOpen: vi.fn(),
    setState: vi.fn((s: PdfFindState) => void states.push(s)),
    setPageMarks: vi.fn((w: PdfWord[], current: number) => void marks.push({ words: w, current })),
    setPageCounts: vi.fn((c: ReadonlyMap<number, number>) => void badges.push(new Map(c))),
    showPage: vi.fn(),
    setStepEnabled: vi.fn(),
    focusField: vi.fn(),
  };
  const failures: ApiFailureSink = { onSessionExpired: vi.fn(), onStalePage: vi.fn() };
  const find = createPdfFindController({ docs, view, failures, words, debounceMs: 0 });
  return { find, states, marks, badges, view, words, search };
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

describe("matchWords", () => {
  it("marks exactly the terms the count says it counted", () => {
    const words = [word("Avaliação", 0), word("attention", 1), word("budget", 2)];
    expect(matchWords(words, ["avaliacao"]).map((w) => w.t)).toEqual(["Avaliação"]);
    expect(matchWords(words, ["budget", "attention"]).map((w) => w.t)).toEqual([
      "attention",
      "budget",
    ]);
  });

  it("marks nothing at all for a page no terms were named on", () => {
    expect(matchWords([word("attention", 0)], [])).toEqual([]);
  });

  it("re-tokenises a run, so the decoder's splitting only decides the BOX", () => {
    // `pdf_shim.c` splits on a separator table that approximates `unicode61`.
    expect(wordTerms("page‑range")).toEqual(["page", "range"]);
    expect(matchWords([word("page‑range", 0)], ["range"]).map((w) => w.t)).toEqual([
      "page‑range",
    ]);
  });

  it("marks a RAW word box against an already-folded term", () => {
    // Terms arrive folded, boxes carry MuPDF's raw glyphs, so `matchWords` folds its side.
    for (const s of ["Avaliação", "ÀÉÎÕÜ", "straße", "MiXeD"]) {
      expect(matchWords([word(s, 0)], [fold(s)]).length).toBe(1);
    }
  });
});

describe("the honesty rule", () => {
  it("badges every matching page with the INDEX's count, including one it cannot locate", () => {
    // Badges come from the index counts, not the boxes; page 3 has counts but no boxes.
    return (async () => {
      const b = build({
        pages: [match(0, 1, ["ledger"]), match(3, 2, ["ledger"])],
        words: { 0: [word("ledger", 0)] },
      });
      b.find.setDocument("n-book", MD5);
      b.find.setPage(0);
      b.find.open();
      b.find.setQuery("ledger");
      await flush();
      await flush();

      expect(last(b.badges)).toEqual(
        new Map([
          [0, 1],
          [3, 2],
        ]),
      );

      b.find.setQuery("");
      await flush();
      expect(last(b.badges)).toEqual(new Map());
    })();
  });

  it("A PAGE THE INDEX MATCHED BUT THE LOCATOR CANNOT PLACE STILL READS AS A MATCH", () => {
    // Breaks if the counter is ever derived from the boxes. A soft-hyphenated `co-operate`
    // arrives as two runs while the index counted `cooperate`.
    return (async () => {
      const b = build({
        pages: [match(3, 2, ["cooperate"])],
        words: { 3: [word("co", 0), word("operate", 1), word("Elsewhere", 2)] },
      });
      b.find.setDocument("n-book", MD5);
      b.find.setPage(3);
      b.find.open();
      b.find.setQuery("cooperate");
      await flush();
      await flush();

      expect(last(b.states)).toEqual({ kind: "settled", at: 0, total: 2, fuzzy: false });
      expect(pdfCountText(last(b.states)!)).toBe("1 of 2");
      expect(b.states.map((s) => s.kind)).not.toContain("empty");
      expect(b.states.map((s) => pdfCountText(s))).not.toContain("No matches");
      expect(last(b.marks)).toEqual({ words: [], current: -1 });
    })();
  });

  it("keeps the count when the PAGE ITSELF will not yield words", async () => {
    for (const words of [
      vi.fn(async () => []),
      vi.fn(async () => {
        throw new Error("this page will not render to text");
      }),
    ]) {
      const b = build({ pages: [match(0, 5, ["rutabaga"])] });
      (b.words as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
        words as unknown as () => Promise<PdfWord[]>,
      );
      b.find.setDocument("n-book", MD5);
      b.find.open();
      b.find.setQuery("rutabaga");
      await flush();
      await flush();
      expect(last(b.states)).toMatchObject({ kind: "settled", total: 5 });
      expect(last(b.marks)!.words).toEqual([]);
    }
  });

  it("marks the boxes it CAN name on a page where it can name only some", async () => {
    // Three counted, two locatable: `current` clamps into the boxes that exist.
    const b = build({
      pages: [match(0, 3, ["quince"])],
      words: { 0: [word("Quince", 0), word("paste", 1), word("quince", 2)] },
    });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("quince");
    await flush();
    await flush();
    expect(last(b.states)).toMatchObject({ kind: "settled", total: 3 });
    expect(last(b.marks)!.words.map((w) => w.t)).toEqual(["Quince", "quince"]);

    b.find.step(1);
    b.find.step(1);
    await flush();
    expect(last(b.states)).toMatchObject({ kind: "settled", at: 2, total: 3 });
    expect(last(b.marks)!.current).toBe(1);
  });

  it("says 'No matches' only when the INDEX found none", async () => {
    const b = build({ pages: [] });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("quokka");
    await flush();
    await flush();
    expect(last(b.states)).toEqual({ kind: "empty" });
    expect(pdfCountText(last(b.states)!)).toBe("No matches");
  });
});

describe("the find controller", () => {
  it("shows NO TOTAL while the query is in flight", async () => {
    const b = build({ pages: [match(0, 4, ["rutabaga"])] });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("rutabaga");
    expect(last(b.states)).toEqual({ kind: "counting" });
    expect(pdfCountText({ kind: "counting" })).toBe("Searching…");
    await flush();
    await flush();
    expect(last(b.states)).toMatchObject({ kind: "settled", total: 4 });
  });

  it("never shows an 'N+' floor: the answer is complete when it lands", async () => {
    const b = build({ pages: [match(0, 2, ["rutabaga"]), match(9, 3, ["rutabaga"])] });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    expect(b.states.map((st) => pdfCountText(st)).some((t) => t.includes("+"))).toBe(false);
    expect(last(b.states)).toMatchObject({ kind: "settled", total: 5 });
    expect(pdfCountText(last(b.states)!)).toBe("1 of 5");
  });

  it("asks the engine nothing until the first find", async () => {
    const b = build({ pages: [match(0, 1, ["rutabaga"])] });
    b.find.setDocument("n-book", MD5);
    b.find.setPage(3);
    b.find.open();
    await flush();
    expect(b.search).not.toHaveBeenCalled();

    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    expect(b.search).toHaveBeenCalledWith(MD5, "rutabaga", expect.anything());
  });

  it("searches whatever md5 the meta names, which is how the bin and history work", async () => {
    const trashed = "c".repeat(32);
    const b = build({ pages: [match(2, 1, ["rutabaga"])] });
    b.find.setDocument("n-book", trashed);
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    expect(b.search).toHaveBeenCalledWith(trashed, "rutabaga", expect.anything());
    expect(last(b.states)).toMatchObject({ kind: "settled", total: 1 });
  });

  it("lands on the FIRST match's page when the page on screen has none", async () => {
    const b = build({ pages: [match(7, 1, ["rutabaga"])] });
    b.find.setDocument("n-book", MD5);
    b.find.setPage(0);
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    expect(b.view.showPage).toHaveBeenCalledWith(7);
  });

  it("keeps the match already on screen when this page has some", async () => {
    const b = build({
      pages: [match(0, 1, ["rutabaga"]), match(4, 1, ["rutabaga"])],
      words: { 4: [word("rutabaga", 0)] },
    });
    b.find.setDocument("n-book", MD5);
    b.find.setPage(4);
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    expect(b.view.showPage).not.toHaveBeenCalled();
    expect(last(b.states)).toMatchObject({ kind: "settled", at: 1, total: 2 });
  });

  it("steps across page boundaries, turning the page as it goes", async () => {
    const b = build({ pages: [match(0, 1, ["a"]), match(5, 1, ["a"])] });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("a");
    await flush();
    await flush();
    b.find.step(1);
    expect(b.view.showPage).toHaveBeenCalledWith(5);
    b.find.step(1);
    expect(last(b.states)).toMatchObject({ at: 0 });
  });

  it("HOLDS a typo-tolerant result behind the opt-in rather than substituting it", async () => {
    const b = build({ pages: [match(2, 1, ["rutabaga"])], usedFuzzy: true });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("rutabagga");
    await flush();
    await flush();
    expect(last(b.states)).toEqual({ kind: "fuzzyPrompt" });
    const calls = b.search.mock.calls.length;
    b.find.searchSimilar();
    await flush();
    expect(b.search.mock.calls.length).toBe(calls);
    expect(last(b.states)).toMatchObject({ kind: "settled", total: 1, fuzzy: true });
  });

  it("a fuzzy fallback that found NOTHING is a real absence, with no offer", async () => {
    const b = build({ pages: [], usedFuzzy: true });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("quokka");
    await flush();
    await flush();
    expect(last(b.states)).toEqual({ kind: "empty" });
  });

  it("asks the decoder ONCE per page however often find repaints", async () => {
    // A page's words cost a structured-text run, so they are cached.
    const b = build({
      pages: [match(0, 1, ["rutabaga"])],
      words: { 0: [word("rutabaga", 0)] },
    });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    b.find.repaint();
    b.find.repaint();
    await flush();
    expect(b.words.mock.calls.filter((c) => c[0] === 0).length).toBe(1);
  });

  it("reports an ERROR rather than an absence when the search itself failed", async () => {
    const b = build();
    b.search.mockImplementation(async () => {
      throw new Error("the network went away");
    });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    expect(last(b.states)).toEqual({ kind: "error" });
    expect(pdfCountText({ kind: "error" })).toContain("Couldn't search");
  });

  it("drops everything with the document, so the next one opens clean", async () => {
    const b = build({ pages: [match(0, 3, ["rutabaga"])] });
    b.find.setDocument("n-book", MD5);
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    b.find.reset();
    expect(b.find.isOpen()).toBe(false);
    expect(b.find.query()).toBe("");
    expect(last(b.states)).toEqual({ kind: "idle" });
    expect(last(b.marks)).toEqual({ words: [], current: -1 });
  });
});

describe("parsePageWords", () => {
  it("reads the decoder's records", () => {
    expect(parsePageWords('[{"t":"Marmalade","x":10,"y":38.5,"w":52.7,"h":11.6,"l":3}]')).toEqual([
      { t: "Marmalade", x: 10, y: 38.5, w: 52.7, h: 11.6, line: 3 },
    ]);
  });

  it("keeps a word whose line id is missing or unusable, on line zero", () => {
    // Missing `line` degrades to 0, not one line per word (copy would break every word).
    const box = '"x":1,"y":2,"w":3,"h":4';
    for (const l of ["", ',"l":null', ',"l":"2"', ',"l":-1', ',"l":1.7']) {
      const got = parsePageWords(`[{"t":"a",${box}${l}}]`);
      expect(got).toHaveLength(1);
      expect(got[0]!.line).toBe(l === ',"l":1.7' ? 1 : 0);
    }
  });

  it("answers with nothing for a payload that is not an array of words", () => {
    for (const bad of ["", "not json", "[", '{"t":"a"}', "[]"]) {
      expect(parsePageWords(bad)).toEqual([]);
    }
  });

  it("drops a record with no text to match or no box to draw", () => {
    const good = '{"t":"a","x":1,"y":2,"w":3,"h":4}';
    for (const bad of [
      '{"t":"","x":1,"y":2,"w":3,"h":4}',
      '{"x":1,"y":2,"w":3,"h":4}',
      '{"t":"a","x":1,"y":2,"w":0,"h":4}',
      '{"t":"a","x":1,"y":2,"w":3,"h":-4}',
      "null",
      "7",
    ]) {
      expect(parsePageWords(`[${bad},${good}]`)).toEqual([
        { t: "a", x: 1, y: 2, w: 3, h: 4, line: 0 },
      ]);
    }
  });
});

describe("the oval path is untouched", () => {
  // No shared component picks the mark (oval vs box) by sniffing the file type.

  it("still draws the reader's ovals, from millimetres, with the same guards", () => {
    const words: WordBox[] = [{ text: "attention", xMm: 8, yMm: 12, wMm: 22, hMm: 6 }];
    const ovals = ovalsFor(words, 8, 1404, 702, 936);
    expect(ovals).toHaveLength(1);
    expect(ovals![0]!.path).toBeTruthy();
    expect(ovals![0]!.rotateDeg).not.toBe(0);
    expect(ovalsFor(words, null, 1404, 702, 936)).toBeNull();
  });

  it("the PDF's mark carries no loop to draw, so nothing downstream can circle it", () => {
    const marks = matchWords([word("attention", 0)], ["attention"]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toEqual({ t: "attention", x: 10, y: 12, w: 54, h: 11, line: 0 });
    expect("path" in marks[0]!).toBe(false);
    expect("rotateDeg" in marks[0]!).toBe(false);
  });

  it("NEITHER MARK COMPONENT LOOKS AT A FILE TYPE", async () => {
    const read = async (path: string): Promise<string> => {
      const { readFile } = await import("node:fs/promises");
      return readFile(new URL(path, import.meta.url), "utf8");
    };
    for (const path of [
      "../../src/pages/findOvals.ts",
      "../../src/pages/pdf/pdfHighlightLayer.ts",
    ]) {
      const src = await read(path);
      // Both files discuss file types in comments; strip them before looking.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/fileKind|fileType|\.pdf"|\.note"/);
    }
  });
});
