import { describe, it, expect, vi } from "vitest";
import { createFindController, matchWords, type FindState, type FindView } from "../../src/pages/findInNote";
import { ApiError, type ApiFailureSink } from "../../src/api/client";
import type { Api } from "../../src/api/types";
import type { PageRef, WordBox } from "../../src/core/types";
import type { DocSearch, DocSearchResult, DocSegmentMatch } from "../../src/search/docSearch";

// The engine is faked; `docSearch.test.ts` covers it against the real wasm.

const flush = () => new Promise((r) => setTimeout(r, 0));

const MD5 = "d".repeat(32);

function page(index: number, textHash: string | null): PageRef {
  return { index, hash: `h${index}`.repeat(8), width: 1404, height: 1872, textHash };
}

function word(text: string, i: number): WordBox {
  return { text, xMm: 8, yMm: 12 + i * 9.5, wMm: text.length * 2.4, hMm: 6 };
}

const RECOGNISED = [page(0, "a".repeat(32)), page(1, "b".repeat(32)), page(2, null)];

/** A matching segment naming the words the index counted; `.note` has no offsets. */
function match(segment: number, matches: number, terms = ["attention", "attentive"]): DocSegmentMatch {
  return { segment, offset: null, length: null, matches, terms };
}

interface Built {
  find: ReturnType<typeof createFindController>;
  states: FindState[];
  view: FindView;
  getPageText: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  ovals: { words: WordBox[]; current: number }[];
  counts: ReadonlyMap<number, number>[];
  failures: ApiFailureSink;
}

function build(opts: { pages?: DocSegmentMatch[]; words?: WordBox[]; usedFuzzy?: boolean } = {}): Built {
  const words = opts.words ?? [word("attention", 0), word("is", 1), word("attentive", 2)];
  const getPageText = vi.fn(async () => ({ text: "", words }));
  const api = { getPageText } as unknown as Api;

  const usedFuzzy = opts.usedFuzzy ?? false;
  const search = vi.fn(
    async (md5: string, query: string): Promise<DocSearchResult> => ({
      query,
      md5,
      segments: opts.pages ?? [],
      usedFuzzy,
      expansions: usedFuzzy ? [{ typed: query, matched: "attention" }] : [],
    }),
  );
  const docs: DocSearch = { search, drop: vi.fn() };

  const states: FindState[] = [];
  const ovals: { words: WordBox[]; current: number }[] = [];
  const counts: ReadonlyMap<number, number>[] = [];
  const view: FindView = {
    setOpen: vi.fn(),
    setState: vi.fn((s: FindState) => void states.push(s)),
    setPageMatches: vi.fn((w: WordBox[], current: number) => void ovals.push({ words: w, current })),
    setPageCounts: vi.fn((c: ReadonlyMap<number, number>) => void counts.push(c)),
    showPage: vi.fn(),
    setStepEnabled: vi.fn(),
    focusField: vi.fn(),
  };
  const failures: ApiFailureSink = { onSessionExpired: vi.fn(), onStalePage: vi.fn() };
  const find = createFindController({ api, docs, view, failures, debounceMs: 0 });
  return { find, states, view, getPageText, search, ovals, counts, failures };
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

describe("matchWords", () => {
  // The ovals are the words the index counted, not a re-derivation from the query.
  it("circles exactly the terms the count says it counted", () => {
    const words = [word("Avaliação", 0), word("attention", 1), word("budget", 2)];

    expect(matchWords(words, "irrelevant", ["avaliacao"]).map((w) => w.text)).toEqual(["Avaliação"]);
    expect(matchWords(words, "", ["attention", "budget"]).map((w) => w.text)).toEqual([
      "attention",
      "budget",
    ]);
    expect(matchWords(words, "budgte", ["budget"]).map((w) => w.text)).toEqual(["budget"]);
    // Whole terms, not substrings: `atten` counted nothing, so nothing is circled.
    expect(matchWords(words, "atten", ["atten"])).toEqual([]);
    expect(matchWords(words, "attention", [])).toEqual([]);
  });

  it("splits a word label the way the index's tokenizer does", () => {
    // `unicode61` breaks on every non-letter, non-digit.
    const words = [word("page-range", 0), word("Endor,", 1)];
    expect(matchWords(words, "", ["range"]).map((w) => w.text)).toEqual(["page-range"]);
    expect(matchWords(words, "", ["endor"]).map((w) => w.text)).toEqual(["Endor,"]);
  });

  // `terms === null` is phase 1 only: no answer yet, so draw from this page.
  it("falls back to a provisional substring guess only before the counts land", () => {
    const words = [word("Avaliação", 0), word("attention", 1), word("budget", 2)];
    expect(matchWords(words, "avaliacao", null).map((w) => w.text)).toEqual(["Avaliação"]);
    expect(matchWords(words, "ATTEN", null).map((w) => w.text)).toEqual(["attention"]);
    expect(matchWords(words, "atten budget", null).map((w) => w.text)).toEqual(["attention", "budget"]);
  });

  it("matches nothing for a blank or whitespace query", () => {
    expect(matchWords([word("a", 0)], "", null)).toEqual([]);
    expect(matchWords([word("a", 0)], "   ", null)).toEqual([]);
  });
});

describe("find in note", () => {
  // The text record is fetched on first find, not on open.
  it("fetches NOTHING when the bar is merely opened — peeking is free", async () => {
    const t = build();
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    await flush();

    expect(t.getPageText).not.toHaveBeenCalled();
    expect(t.search).not.toHaveBeenCalled();
  });

  it("costs ONE document-scoped query for the whole notebook, not one per page", async () => {
    const t = build({ pages: [match(0, 2), match(1, 3)] });
    const many = Array.from({ length: 40 }, (_, i) => page(i, "c".repeat(32)));
    t.find.setNote("n1", MD5, many);
    t.find.open();
    t.find.setQuery("attention");
    await flush();
    await flush();

    expect(t.search).toHaveBeenCalledTimes(1);
    expect(t.search).toHaveBeenCalledWith(MD5, "attention", expect.anything());
    expect(t.getPageText).toHaveBeenCalledTimes(1);
  });

  it("asks nothing at all for a note with no content address", async () => {
    const t = build({ pages: [match(0, 1)] });
    t.find.setNote("n1", null, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    expect(t.search).not.toHaveBeenCalled();
  });

  it("shows NO TOTAL while the answer is outstanding", async () => {
    let land!: (r: DocSearchResult) => void;
    const t = build();
    // Hold the query open: the window while the text is fetched and indexed.
    t.search.mockImplementation(
      (md5: string, query: string) =>
        new Promise<DocSearchResult>((resolve) => {
          land = (r) => resolve({ ...r, md5, query });
        }),
    );

    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();

    const mid = last(t.states)!;
    expect(mid.kind).toBe("counting");
    expect(mid).toMatchObject({ kind: "counting", onThisPage: 2, recognisedPages: 2 });
    expect(t.states.some((s) => s.kind === "settled")).toBe(false);

    land({ query: "attent", md5: MD5, segments: [match(0, 2), match(1, 3)], usedFuzzy: false, expansions: [] });
    await flush();
    expect(last(t.states)).toEqual({ kind: "settled", at: 0, total: 5, fuzzy: false });
  });

  it("cannot step until the counts have landed", async () => {
    const t = build({ pages: [match(0, 2), match(1, 3)] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    expect(t.view.setStepEnabled).toHaveBeenLastCalledWith(false);

    await flush();
    await flush();
    expect(t.view.setStepEnabled).toHaveBeenLastCalledWith(true);
  });

  it("keeps the match already highlighted when the counts settle", async () => {
    const t = build({ pages: [match(0, 2), match(1, 3)] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.setPage(1);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    expect(last(t.states)).toEqual({ kind: "settled", at: 2, total: 5, fuzzy: false });
    expect(t.view.showPage).not.toHaveBeenCalled();
  });

  // Regression: with no match on the current page, settling stayed put and circled nothing.
  it("GOES TO the first match when the page in front of you holds none", async () => {
    const t = build({ pages: [match(1, 2)] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    expect(last(t.states)).toEqual({ kind: "settled", at: 0, total: 2, fuzzy: false });
    expect(t.view.showPage).toHaveBeenCalledWith(1);
  });

  it("settles onto a match on another page, and steps across pages from there", async () => {
    const four = [0, 1, 2, 3].map((i) => page(i, `${i}`.repeat(32)));
    const t = build({ pages: [match(1, 1), match(3, 1)] });
    t.find.setNote("n1", MD5, four);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    expect(t.view.showPage).toHaveBeenLastCalledWith(1);
    t.find.setPage(1);

    t.find.step(1);
    expect(last(t.states)).toEqual({ kind: "settled", at: 1, total: 2, fuzzy: false });
    expect(t.view.showPage).toHaveBeenLastCalledWith(3);
    t.find.setPage(3);

    t.find.step(1);
    expect(last(t.states)).toEqual({ kind: "settled", at: 0, total: 2, fuzzy: false });
    expect(t.view.showPage).toHaveBeenLastCalledWith(1);
  });

  // Misspelt query: the ovals come from the terms the index counted, after opt-in.
  it("circles what the count counted, even when the query spells it wrong — after opting in", async () => {
    const t = build({
      pages: [{ segment: 0, offset: null, length: null, matches: 2, terms: ["attention", "attentive"] }],
      usedFuzzy: true,
    });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attenton");
    await flush();
    await flush();

    expect(last(t.states)).toEqual({ kind: "fuzzyPrompt" });

    t.find.searchSimilar();
    await flush();
    expect(last(t.states)).toEqual({ kind: "settled", at: 0, total: 2, fuzzy: true });
    expect(last(t.ovals)!.words.map((w) => w.text)).toEqual(["attention", "attentive"]);
    expect(last(t.ovals)!.words).toHaveLength(2);
    expect(t.search).toHaveBeenCalledTimes(1);
  });

  it("keeps saying the answer is approximate while stepping through it — once opted in", async () => {
    const t = build({ pages: [match(0, 2)], usedFuzzy: true });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attenton");
    await flush();
    await flush();
    t.find.searchSimilar();
    await flush();

    t.find.step(1);
    expect(last(t.states)).toEqual({ kind: "settled", at: 1, total: 2, fuzzy: true });
  });

  it("steps across page boundaries and turns the page as it goes", async () => {
    const t = build({ pages: [match(0, 2), match(1, 3)] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    t.find.step(1);
    expect(last(t.states)).toEqual({ kind: "settled", at: 1, total: 5, fuzzy: false });
    expect(t.view.showPage).not.toHaveBeenCalled();

    t.find.step(1);
    expect(last(t.states)).toEqual({ kind: "settled", at: 2, total: 5, fuzzy: false });
    expect(t.view.showPage).toHaveBeenCalledWith(1);

    t.find.step(-1);
    t.find.step(-1);
    t.find.step(-1);
    expect(last(t.states)).toEqual({ kind: "settled", at: 4, total: 5, fuzzy: false });
  });

  it('says "Not recognised on the device", never "No matches", for an unrecognised note', async () => {
    const t = build();
    t.find.setNote("n1", MD5, [page(0, null), page(1, null)]);
    t.find.open();
    t.find.setQuery("anything");
    await flush();
    await flush();

    expect(last(t.states)).toEqual({ kind: "unrecognised" });
    expect(t.states.some((s) => s.kind === "empty")).toBe(false);
    expect(t.search).not.toHaveBeenCalled();
    expect(t.getPageText).not.toHaveBeenCalled();
  });

  it('says "No matches" — a real absence — when a recognised note has none', async () => {
    const t = build({ pages: [] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("zzzznowhere");
    await flush();
    await flush();

    expect(last(t.states)).toEqual({ kind: "empty" });
    expect(t.search).toHaveBeenCalledTimes(1);
  });

  it("never asks for the text of a page the device did not recognise", async () => {
    const t = build({ pages: [match(0, 1)] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.setPage(2);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    expect(t.getPageText).not.toHaveBeenCalled();
    expect(last(t.ovals)).toEqual({ words: [], current: -1 });
  });

  it("drops an answer whose query has moved on", async () => {
    const t = build();
    const answers: ((r: DocSearchResult) => void)[] = [];
    t.search.mockImplementation(
      (md5: string, query: string) =>
        new Promise<DocSearchResult>((resolve) => {
          answers.push((r) => resolve({ ...r, md5, query }));
        }),
    );

    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("att");
    await flush();
    t.find.setQuery("attention");
    await flush();

    // The slower, older query lands last and must be dropped.
    answers[1]!({ query: "", md5: MD5, segments: [match(0, 1)], usedFuzzy: false, expansions: [] });
    await flush();
    answers[0]!({ query: "", md5: MD5, segments: [match(1, 99)], usedFuzzy: false, expansions: [] });
    await flush();

    expect(last(t.states)).toEqual({ kind: "settled", at: 0, total: 1, fuzzy: false });
  });

  it("routes an expired session to the sink instead of rendering as an error", async () => {
    const t = build();
    t.search.mockRejectedValue(new ApiError("UNAUTHORIZED", "gone", 401));
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    expect(t.failures.onSessionExpired).toHaveBeenCalled();
    expect(t.states.some((s) => s.kind === "error")).toBe(false);
  });

  // A 404 from `text/<md5>` cannot say why, so it is never "No matches".
  it("surfaces an ordinary failure as an error, distinct from an empty result", async () => {
    const t = build();
    t.search.mockRejectedValue(new ApiError("SERVER", "boom", 500));
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    expect(last(t.states)).toEqual({ kind: "error" });
  });

  it("clears everything when the bar closes, and re-runs the query when it reopens", async () => {
    const t = build({ pages: [match(0, 2)] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    t.find.close();
    expect(last(t.ovals)).toEqual({ words: [], current: -1 });
    expect(last(t.counts)!.size).toBe(0);

    t.find.open();
    await flush();
    await flush();
    expect(last(t.counts)!.get(0)).toBe(2);
  });

  it("does not re-issue a query that has not effectively changed", async () => {
    const t = build({ pages: [] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();
    t.find.setQuery("attent ");
    t.find.setQuery(" attent");
    await flush();
    await flush();

    expect(t.search).toHaveBeenCalledTimes(1);
  });

  it("searches a version preview's own blob through the same path, on its md5", async () => {
    const version = "9".repeat(32);
    const t = build({ pages: [match(1, 4)] });
    t.find.setNote("n1", version, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    expect(t.search).toHaveBeenCalledWith(version, "attent", expect.anything());
    expect(last(t.states)).toEqual({ kind: "settled", at: 0, total: 4, fuzzy: false });
  });

  it("re-runs against the new md5 when the preview changes under the same note id", async () => {
    const t = build({ pages: [match(0, 1)] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    const version = "7".repeat(32);
    t.find.setNote("n1", version, RECOGNISED);
    await flush();
    await flush();

    expect(t.search).toHaveBeenLastCalledWith(version, "attent", expect.anything());
  });

  it("gates manual fuzzy WITH hits behind opt-in; a fuzzy MISS is a plain 'No matches'", async () => {
    const hit = build({ pages: [match(0, 1)], usedFuzzy: true });
    hit.find.setNote("n1", MD5, RECOGNISED);
    hit.find.open();
    hit.find.setQuery("attenton");
    await flush();
    await flush();
    expect(last(hit.states)).toEqual({ kind: "fuzzyPrompt" });
    expect(last(hit.ovals)).toEqual({ words: [], current: -1 });

    const miss = build({ pages: [], usedFuzzy: true });
    miss.find.setNote("n1", MD5, RECOGNISED);
    miss.find.open();
    miss.find.setQuery("zzzznope");
    await flush();
    await flush();
    expect(last(miss.states)).toEqual({ kind: "empty" });
  });
});
