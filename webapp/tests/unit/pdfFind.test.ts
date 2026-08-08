import { describe, it, expect, vi } from "vitest";
import {
  createPdfFindController,
  matchWords,
  pdfCountText,
  wordTerms,
  type PdfFindState,
  type PdfFindView,
} from "../../src/pages/pdfFind";
import { parsePageWords, type PdfWord } from "../../src/render/pdfText";
import { ovalsFor } from "../../src/pages/findOvals";
import { fold as txtFold } from "../../src/pages/txtFind";
import type { ApiFailureSink } from "../../src/api/client";
import type { Api } from "../../src/api/types";
import type { NoteSearchBatch, PageMatch, WordBox } from "../../src/core/types";

// Find-in-PDF's logic with the DOM and the decoder both injected.
//
// THE ONE THING HERE THAT IS NOT LIKE THE OTHER TWO FIND CONTROLLERS, and the
// reason most of this file exists: the client is a LOCATOR, not a judge. The
// server says which pages matched and how many times; MuPDF says where the words
// are. Those two can legitimately disagree — SQLite folds diacritics and MuPDF
// does not, a word can be hyphenated across a line break, a ligature can arrive
// as one glyph — and when they do, the page is still a match and simply has no
// box on it. A viewer that reported "No matches" there would be making a
// confident false statement about a document that does contain the word.

const flush = () => new Promise((r) => setTimeout(r, 0));

function word(t: string, i: number): PdfWord {
  return { t, x: 10, y: 12 + i * 14, w: t.length * 6, h: 11 };
}

function match(pageIndex: number, matches: number, terms: string[]): PageMatch {
  return { pageIndex, matches, terms };
}

interface Built {
  find: ReturnType<typeof createPdfFindController>;
  states: PdfFindState[];
  marks: { words: PdfWord[]; current: number }[];
  /** Every filmstrip badge map the controller published, in order. */
  badges: ReadonlyMap<number, number>[];
  view: PdfFindView;
  words: ReturnType<typeof vi.fn>;
  searchInNoteStream: ReturnType<typeof vi.fn>;
}

function build(
  opts: {
    pages?: PageMatch[];
    /** The words MuPDF finds, per page. A page absent from the map has none. */
    words?: Record<number, PdfWord[]>;
    usedFuzzy?: boolean;
    batches?: NoteSearchBatch[];
  } = {},
): Built {
  const perPage = opts.words ?? {};
  const words = vi.fn(async (page: number) => perPage[page] ?? []);
  const searchInNoteStream = vi.fn(
    async (_id: string, _q: string, onBatch: (b: NoteSearchBatch) => void) => {
      const batches =
        opts.batches ??
        [{ query: "q", pages: opts.pages ?? [], usedFuzzy: opts.usedFuzzy ?? false, done: true }];
      for (const b of batches) onBatch(b);
    },
  );
  const api = { searchInNoteStream } as unknown as Api;

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
  const find = createPdfFindController({ api, view, failures, words, debounceMs: 0 });
  return { find, states, marks, badges, view, words, searchInNoteStream };
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

describe("matchWords", () => {
  it("marks exactly the terms the server says it counted", () => {
    // The property the whole term shape exists for. The client cannot reproduce
    // the prefix expansion, the tokenizer's fold, or which near-miss a typo
    // expanded into — so it does not try; it compares.
    const words = [word("Avaliação", 0), word("attention", 1), word("budget", 2)];
    expect(matchWords(words, ["avaliacao"]).map((w) => w.t)).toEqual(["Avaliação"]);
    expect(matchWords(words, ["budget", "attention"]).map((w) => w.t)).toEqual([
      "attention",
      "budget",
    ]);
  });

  it("marks nothing at all for a page the server named no terms on", () => {
    // A phrase token, say: the count stands and there is simply nothing to point
    // at. Never a substring guess, which is what the reader's phase 1 does and is
    // wrong here because there is no phase 1.
    expect(matchWords([word("attention", 0)], [])).toEqual([]);
  });

  it("re-tokenises a run, so the decoder's splitting only decides the BOX", () => {
    // `pdf_shim.c` splits on an explicit table of separators, which is an
    // approximation of `unicode61`. Anything it glues together is pulled apart
    // here BEFORE the comparison, so a separator it does not know costs a
    // slightly wide mark and never a lost match.
    expect(wordTerms("page‑range")).toEqual(["page", "range"]);
    expect(matchWords([word("page‑range", 0)], ["range"]).map((w) => w.t)).toEqual([
      "page‑range",
    ]);
  });

  it("folds exactly as the `.txt` viewer folds, because the index folded once", () => {
    // Three copies of two lines, and the failure if they diverge is silent and
    // one-sided: the count stays right and the marks stop appearing.
    for (const s of ["Avaliação", "ÀÉÎÕÜ", "straße", "MiXeD"]) {
      expect(matchWords([word(s, 0)], [txtFold(s)]).length).toBe(1);
    }
  });
});

describe("the honesty rule", () => {
  it("badges every matching page with the SERVER's count, including one it cannot locate", () => {
    // The filmstrip indicator: which pages hold matches, and how many. It reads
    // from the same `counts` the counter does, which is the whole point — a
    // badge derived from the located BOXES would show nothing on a page whose
    // words MuPDF could not name, quietly contradicting a counter that says the
    // match is there. Page 3 below is exactly that page: the server counted two,
    // the client can place none.
    return (async () => {
      const b = build({
        pages: [match(0, 1, ["ledger"]), match(3, 2, ["ledger"])],
        words: { 0: [word("ledger", 0)] }, // page 3 yields nothing placeable
      });
      b.find.setDocument("n-book");
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

      // And emptying the box takes them away rather than leaving stale numbers
      // sitting on pages nobody is searching any more.
      b.find.setQuery("");
      await flush();
      expect(last(b.badges)).toEqual(new Map());
    })();
  });

  it("A PAGE THE SERVER MATCHED BUT THE CLIENT CANNOT LOCATE STILL READS AS A MATCH", () => {
    // §9's first test, and the one most likely to be undone by accident: it is
    // undone by ANY change that derives the counter from the boxes.
    //
    // Staged with a term the page genuinely contains and MuPDF cannot name:
    // `co-operate` set with a soft hyphen across a line break arrives as two
    // runs, `co` and `operate`, while the index — reading the extracted text —
    // counted the single term `cooperate`. Neither side is wrong.
    return (async () => {
      const b = build({
        pages: [match(3, 2, ["cooperate"])],
        words: { 3: [word("co", 0), word("operate", 1), word("Elsewhere", 2)] },
      });
      b.find.setDocument("n-book");
      b.find.setPage(3);
      b.find.open();
      b.find.setQuery("cooperate");
      await flush();
      await flush();

      // THE COUNT IS THE SERVER'S, and it says two.
      expect(last(b.states)).toEqual({ kind: "settled", at: 0, total: 2, fuzzy: false });
      expect(pdfCountText(last(b.states)!)).toBe("1 of 2");
      // …and it is emphatically NOT this.
      expect(b.states.map((s) => s.kind)).not.toContain("empty");
      expect(b.states.map((s) => pdfCountText(s))).not.toContain("No matches");
      // The page carries no box, which is the honest half of the answer.
      expect(last(b.marks)).toEqual({ words: [], current: -1 });
    })();
  });

  it("keeps the count when the PAGE ITSELF will not yield words", async () => {
    // A scanned insert in a text book, or a page whose structured-text pass
    // failed. `words` resolving empty and `words` rejecting are the same answer
    // to the viewer: no boxes, and the server's count untouched.
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
      b.find.setDocument("n-book");
      b.find.open();
      b.find.setQuery("rutabaga");
      await flush();
      await flush();
      expect(last(b.states)).toMatchObject({ kind: "settled", total: 5 });
      expect(last(b.marks)!.words).toEqual([]);
    }
  });

  it("marks the boxes it CAN name on a page where it can name only some", async () => {
    // The partial case, which is the common one: three counted, two locatable.
    // The counter still says three, and `current` clamps into the boxes that
    // exist rather than indexing past them.
    const b = build({
      pages: [match(0, 3, ["quince"])],
      words: { 0: [word("Quince", 0), word("paste", 1), word("quince", 2)] },
    });
    b.find.setDocument("n-book");
    b.find.open();
    b.find.setQuery("quince");
    await flush();
    await flush();
    expect(last(b.states)).toMatchObject({ kind: "settled", total: 3 });
    expect(last(b.marks)!.words.map((w) => w.t)).toEqual(["Quince", "quince"]);

    // Step to the third match — the one there is no box for. It is still a
    // match: the counter moves, and the page marks the last box it has rather
    // than dropping every mark.
    b.find.step(1);
    b.find.step(1);
    await flush();
    expect(last(b.states)).toMatchObject({ kind: "settled", at: 2, total: 3 });
    expect(last(b.marks)!.current).toBe(1);
  });

  it("says 'No matches' only when the SERVER found none", async () => {
    // The other side of the rule, so the first test cannot be satisfied by a
    // controller that never says it.
    const b = build({ pages: [] });
    b.find.setDocument("n-book");
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
    // `1 of 12` is a claim about the whole document, and a total that quietly
    // revises itself is how a search loses trust.
    const b = build({ pages: [match(0, 4, ["rutabaga"])] });
    b.find.setDocument("n-book");
    b.find.open();
    b.find.setQuery("rutabaga");
    expect(last(b.states)).toEqual({ kind: "counting" });
    expect(pdfCountText({ kind: "counting" })).toBe("Searching…");
    await flush();
    await flush();
    expect(last(b.states)).toMatchObject({ kind: "settled", total: 4 });
  });

  it("shows a FLOOR while the document is still draining, then the exact count", async () => {
    const b = build({
      batches: [
        { query: "q", pages: [match(0, 2, ["rutabaga"])], usedFuzzy: false, done: false },
        {
          query: "q",
          pages: [match(0, 2, ["rutabaga"]), match(9, 3, ["rutabaga"])],
          usedFuzzy: false,
          done: true,
        },
      ],
    });
    b.find.setDocument("n-book");
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    const streaming = b.states.find((s) => s.kind === "streaming");
    expect(streaming).toMatchObject({ kind: "streaming", total: 2 });
    expect(pdfCountText(streaming!)).toBe("1 of 2+");
    expect(last(b.states)).toMatchObject({ kind: "settled", total: 5 });
    expect(pdfCountText(last(b.states)!)).toBe("1 of 5");
  });

  it("lands on the FIRST match's page when the page on screen has none", async () => {
    const b = build({ pages: [match(7, 1, ["rutabaga"])] });
    b.find.setDocument("n-book");
    b.find.setPage(0);
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    expect(b.view.showPage).toHaveBeenCalledWith(7);
  });

  it("keeps the match already on screen when this page has some", async () => {
    // Settling must not turn the page out from under someone who has started
    // reading it — the reader's rule, and the reasoning is identical.
    const b = build({
      pages: [match(0, 1, ["rutabaga"]), match(4, 1, ["rutabaga"])],
      words: { 4: [word("rutabaga", 0)] },
    });
    b.find.setDocument("n-book");
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
    b.find.setDocument("n-book");
    b.find.open();
    b.find.setQuery("a");
    await flush();
    await flush();
    b.find.step(1);
    expect(b.view.showPage).toHaveBeenCalledWith(5);
    // Settled wraps over the EXACT set.
    b.find.step(1);
    expect(last(b.states)).toMatchObject({ at: 0 });
  });

  it("HOLDS a typo-tolerant result behind the opt-in rather than substituting it", async () => {
    const b = build({ pages: [match(2, 1, ["rutabaga"])], usedFuzzy: true });
    b.find.setDocument("n-book");
    b.find.open();
    b.find.setQuery("rutabagga");
    await flush();
    await flush();
    expect(last(b.states)).toEqual({ kind: "fuzzyPrompt" });
    // No new request when the offer is taken up — the batch was already fetched.
    const calls = b.searchInNoteStream.mock.calls.length;
    b.find.searchSimilar();
    await flush();
    expect(b.searchInNoteStream.mock.calls.length).toBe(calls);
    expect(last(b.states)).toMatchObject({ kind: "settled", total: 1, fuzzy: true });
  });

  it("a fuzzy fallback that found NOTHING is a real absence, with no offer", async () => {
    const b = build({ pages: [], usedFuzzy: true });
    b.find.setDocument("n-book");
    b.find.open();
    b.find.setQuery("quokka");
    await flush();
    await flush();
    expect(last(b.states)).toEqual({ kind: "empty" });
  });

  it("asks the decoder ONCE per page however often find repaints", async () => {
    // A page's words cost a structured-text run of that page — on a range-served
    // book, the same class of work as rendering it. Find repaints on every step
    // and every zoom, so without the cache a keystroke would re-run the page.
    const b = build({
      pages: [match(0, 1, ["rutabaga"])],
      words: { 0: [word("rutabaga", 0)] },
    });
    b.find.setDocument("n-book");
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
    // A failed search that renders as an empty one is indistinguishable from a
    // query nobody wrote about.
    const b = build();
    b.searchInNoteStream.mockImplementation(async () => {
      throw new Error("the network went away");
    });
    b.find.setDocument("n-book");
    b.find.open();
    b.find.setQuery("rutabaga");
    await flush();
    await flush();
    expect(last(b.states)).toEqual({ kind: "error" });
    expect(pdfCountText({ kind: "error" })).toContain("Couldn't search");
  });

  it("drops everything with the document, so the next one opens clean", async () => {
    const b = build({ pages: [match(0, 3, ["rutabaga"])] });
    b.find.setDocument("n-book");
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
    expect(parsePageWords('[{"t":"Marmalade","x":10,"y":38.5,"w":52.7,"h":11.6}]')).toEqual([
      { t: "Marmalade", x: 10, y: 38.5, w: 52.7, h: 11.6 },
    ]);
  });

  it("answers with nothing for a payload that is not an array of words", () => {
    // Every one of these costs the HIGHLIGHT and never the count: the page still
    // matched, because the server said so.
    for (const bad of ["", "not json", "[", '{"t":"a"}', "[]"]) {
      expect(parsePageWords(bad)).toEqual([]);
    }
  });

  it("drops a record that is not a usable box", () => {
    const good = '{"t":"a","x":1,"y":2,"w":3,"h":4}';
    for (const bad of [
      '{"t":"","x":1,"y":2,"w":3,"h":4}', // nothing to match
      '{"x":1,"y":2,"w":3,"h":4}', // no text at all
      '{"t":"a","x":1,"y":2,"w":0,"h":4}', // no width
      '{"t":"a","x":1,"y":2,"w":3,"h":-4}', // negative height
      '{"t":"a","x":null,"y":2,"w":3,"h":4}',
      "null",
      "7",
    ]) {
      // The good record beside it must survive: one malformed entry is not a
      // reason to lose the page's other marks.
      expect(parsePageWords(`[${bad},${good}]`)).toEqual([{ t: "a", x: 1, y: 2, w: 3, h: 4 }]);
    }
  });
});

describe("the oval path is untouched", () => {
  // §9's third test. The rule it pins is not "ovals still work" but "no shared
  // component decides which mark to draw by sniffing a file type": the `.note`
  // reader circles because the device's rectangles are a recogniser's guess, and
  // a PDF is marked exactly because its boxes come from the content stream.
  // Two components, each of which draws one thing.

  it("still draws the reader's ovals, from millimetres, with the same guards", () => {
    const words: WordBox[] = [{ text: "attention", xMm: 8, yMm: 12, wMm: 22, hMm: 6 }];
    const ovals = ovalsFor(words, 8, 1404, 702, 936);
    expect(ovals).toHaveLength(1);
    expect(ovals![0]!.path).toBeTruthy(); // a DRAWN loop, not a CSS ellipse
    expect(ovals![0]!.rotateDeg).not.toBe(0); // and the tilt that makes it one
    // The all-or-nothing guard the `.note` path exists for: an unverified device
    // scale draws NOTHING rather than loops round the wrong words.
    expect(ovalsFor(words, null, 1404, 702, 936)).toBeNull();
  });

  it("the PDF's mark carries no loop to draw, so nothing downstream can circle it", () => {
    // `ovalsFor` answers with a PATH and a TILT — the drawn loop — and the PDF
    // path answers with a rect in points and nothing else. There is no value
    // that could be handed to both, which is what makes "which mark does this
    // file get" a question no code has to ask at runtime.
    const marks = matchWords([word("attention", 0)], ["attention"]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toEqual({ t: "attention", x: 10, y: 12, w: 54, h: 11 });
    expect("path" in marks[0]!).toBe(false);
    expect("rotateDeg" in marks[0]!).toBe(false);
  });

  it("NEITHER MARK COMPONENT LOOKS AT A FILE TYPE", async () => {
    // The rule §9 actually asks for, stated where it can fail. The failure it
    // guards is a refactor that "unifies" the two by giving one component a
    // branch on `fileType` — at which point the reader's ovals and the PDF's
    // highlights become one component with two moods, and changing either one
    // means reasoning about both.
    const read = async (path: string): Promise<string> => {
      const { readFile } = await import("node:fs/promises");
      return readFile(new URL(path, import.meta.url), "utf8");
    };
    for (const path of [
      "../../src/pages/findOvals.ts",
      "../../src/pages/pdfHighlightLayer.ts",
    ]) {
      const src = await read(path);
      // The comments in both files DISCUSS file types at length; the code must
      // not consult one. Strip the comments before looking.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/fileKind|fileType|\.pdf"|\.note"/);
    }
  });
});
