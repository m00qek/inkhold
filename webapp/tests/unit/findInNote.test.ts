import { describe, it, expect, vi } from "vitest";
import { createFindController, matchWords, type FindState, type FindView } from "../../src/pages/findInNote";
import { ApiError, type ApiFailureSink } from "../../src/api/client";
import type { Api } from "../../src/api/types";
import type { PageRef, WordBox } from "../../src/core/types";
import type { DocSearch, DocSearchResult, DocSegmentMatch } from "../../src/search/docSearch";

// Find-in-note's logic with the DOM injected, the same way the OCR panel and the
// library search are tested. Five things are load-bearing here and none of them
// are visible to a "does the control exist" check:
//
//   1. TWO PHASES. The current page's ovals are drawn from `getPageText`; the
//      note-wide counts come from ONE in-document query over `text/<md5>`, never
//      one per page.
//   2. THE TEXT IS FETCHED ON THE FIRST FIND, NOT ON OPEN — opening a note to
//      read it needs the renderer, not a text index.
//   3. THE INTERMEDIATE STATE SHOWS NO TOTAL. `1 of 12` is a claim about the
//      whole note, and a total that revises itself is how a search loses trust.
//   4. SETTLING KEEPS THE MATCH ALREADY HIGHLIGHTED rather than jumping the page
//      out from under someone reading it.
//   5. "Not recognised on the device" is NOT "No matches" — the second asserts
//      that a search happened.
//
// The ENGINE is faked here. That it really answers — the ordinals, the byte
// ranges, the typo ladder — is `docSearch.test.ts`'s job, against the shipped
// wasm; this file is about what the controller does with an answer.

const flush = () => new Promise((r) => setTimeout(r, 0));

const MD5 = "d".repeat(32);

function page(index: number, textHash: string | null): PageRef {
  return { index, hash: `h${index}`.repeat(8), width: 1404, height: 1872, textHash };
}

function word(text: string, i: number): WordBox {
  return { text, xMm: 8, yMm: 12 + i * 9.5, wMm: text.length * 2.4, hMm: 6 };
}

const RECOGNISED = [page(0, "a".repeat(32)), page(1, "b".repeat(32)), page(2, null)];

/**
 * A matching segment naming the fixture's own words — i.e. WHAT THE INDEX
 * COUNTED. The ovals are derived from these rather than re-derived from the
 * query, so a fixture row that named nothing would be a page with a count and no
 * marks. `offset`/`length` are null because a `.note` ordinal IS the address.
 */
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
      // The ladder reports what it substituted, and `usedFuzzy` is exactly
      // "expansions is non-empty" in the real module — kept consistent here so a
      // fixture cannot describe a state the engine cannot produce.
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
  // THE PROPERTY THIS WHOLE CHANGE EXISTS FOR: the ovals are the words the index
  // COUNTED, not a second opinion about the query. This side cannot reproduce the
  // prefix expansion, the tokenizer's fold, or which near-miss a typo expanded
  // into — so it does not try.
  it("circles exactly the terms the count says it counted", () => {
    const words = [word("Avaliação", 0), word("attention", 1), word("budget", 2)];

    // Folded, accent-stripped terms — the form the index holds them in — match
    // the accented word on the page.
    expect(matchWords(words, "irrelevant", ["avaliacao"]).map((w) => w.text)).toEqual(["Avaliação"]);
    // Several terms circle several words, however the query was spelled.
    expect(matchWords(words, "", ["attention", "budget"]).map((w) => w.text)).toEqual([
      "attention",
      "budget",
    ]);
    // A TYPO'D QUERY still circles the word that was counted, because the term
    // is the corpus's spelling and not the user's.
    expect(matchWords(words, "budgte", ["budget"]).map((w) => w.text)).toEqual(["budget"]);
    // And a term is a WHOLE term, not a substring: `atten` counted nothing, so
    // nothing is circled. The old substring rule circled "attention" here, which
    // is precisely the disagreement with the count this replaces.
    expect(matchWords(words, "atten", ["atten"])).toEqual([]);
    // No terms means nothing to circle, whatever the query says.
    expect(matchWords(words, "attention", [])).toEqual([]);
  });

  it("splits a word label the way the index's tokenizer does", () => {
    // `unicode61` breaks on everything that is not a letter or a digit, so a
    // hyphenated label carries two terms and a trailing comma is not part of one.
    const words = [word("page-range", 0), word("Endor,", 1)];
    expect(matchWords(words, "", ["range"]).map((w) => w.text)).toEqual(["page-range"]);
    expect(matchWords(words, "", ["endor"]).map((w) => w.text)).toEqual(["Endor,"]);
  });

  // `terms === null` is PHASE 1 only: no answer exists yet — the first find is
  // waiting on `text/<md5>` and an index build — and drawing nothing would cost
  // find the immediacy that is its whole feel. The counter beside it claims
  // nothing beyond this page.
  it("falls back to a provisional substring guess only before the counts land", () => {
    const words = [word("Avaliação", 0), word("attention", 1), word("budget", 2)];
    expect(matchWords(words, "avaliacao", null).map((w) => w.text)).toEqual(["Avaliação"]);
    expect(matchWords(words, "ATTEN", null).map((w) => w.text)).toEqual(["attention"]);
    // Multi-token: each word the query names, not a demand that they be adjacent.
    expect(matchWords(words, "atten budget", null).map((w) => w.text)).toEqual(["attention", "budget"]);
  });

  it("matches nothing for a blank or whitespace query", () => {
    expect(matchWords([word("a", 0)], "", null)).toEqual([]);
    expect(matchWords([word("a", 0)], "   ", null)).toEqual([]);
  });
});

describe("find in note", () => {
  // §4.1, and the reason the fetch is here rather than in `reader.open`: reading
  // a note needs the renderer, not a text index, and a 3.15 MB text record is not
  // something a household member who never searches should pay for.
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
    // 40 pages: the shape where a per-page fetch would be catastrophic.
    const many = Array.from({ length: 40 }, (_, i) => page(i, "c".repeat(32)));
    t.find.setNote("n1", MD5, many);
    t.find.open();
    t.find.setQuery("attention");
    await flush();
    await flush();

    expect(t.search).toHaveBeenCalledTimes(1);
    expect(t.search).toHaveBeenCalledWith(MD5, "attention", expect.anything());
    // …plus exactly one page-text fetch: the page actually on screen.
    expect(t.getPageText).toHaveBeenCalledTimes(1);
  });

  // A note with no content address cannot be searched — the route is keyed by
  // md5 — and inventing one would search somebody else's blob.
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
    // Hold the query open — the "still counting" window while the text is being
    // fetched and indexed.
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
    // The page in front of you is answered immediately — two of the three
    // fixture words contain "attent".
    expect(mid).toMatchObject({ kind: "counting", onThisPage: 2, recognisedPages: 2 });
    // And nothing before the answer lands claims a note-wide total.
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
    // Phase 1 has run, phase 2 has not.
    expect(t.view.setStepEnabled).toHaveBeenLastCalledWith(false);

    await flush();
    await flush();
    expect(t.view.setStepEnabled).toHaveBeenLastCalledWith(true);
  });

  it("keeps the match already highlighted when the counts settle", async () => {
    const t = build({ pages: [match(0, 2), match(1, 3)] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.setPage(1); // the user is reading page 2
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    // Page 1 holds global matches 2,3,4 — settling lands on the first of THOSE,
    // not on match 1, and it does not navigate.
    expect(last(t.states)).toEqual({ kind: "settled", at: 2, total: 5, fuzzy: false });
    expect(t.view.showPage).not.toHaveBeenCalled();
  });

  // THE OTHER HALF OF THAT RULE, and the bug it was missing. When the page in
  // front of you holds NO match there is nothing to be taken away from you, and
  // staying put is what made find look broken on real data: the counter read
  // `1 of 1`, the filmstrip badged a page you were not on, and nothing was
  // circled, because the one match was somewhere else entirely.
  it("GOES TO the first match when the page in front of you holds none", async () => {
    const t = build({ pages: [match(1, 2)] });
    t.find.setNote("n1", MD5, RECOGNISED); // reading page 0, which has no match
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
    t.find.setPage(1); // the reader answers showPage by moving, as it really does

    t.find.step(1);
    expect(last(t.states)).toEqual({ kind: "settled", at: 1, total: 2, fuzzy: false });
    expect(t.view.showPage).toHaveBeenLastCalledWith(3);
    t.find.setPage(3);

    // …and forward from the last wraps back to the first, turning the page again.
    t.find.step(1);
    expect(last(t.states)).toEqual({ kind: "settled", at: 0, total: 2, fuzzy: false });
    expect(t.view.showPage).toHaveBeenLastCalledWith(1);
  });

  // THE AGREEMENT PROPERTY. The query is misspelt, so nothing about it would
  // find these words — the ovals are drawn from the terms the INDEX counted, and
  // the count and the marks therefore describe the same two words. Manual fuzzy
  // is OPT-IN: the exact search is empty, the bar offers "search similar", and
  // opting in reveals the counted matches.
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

    // Not shown automatically — the affordance is offered instead.
    expect(last(t.states)).toEqual({ kind: "fuzzyPrompt" });

    t.find.searchSimilar();
    await flush();
    expect(last(t.states)).toEqual({ kind: "settled", at: 0, total: 2, fuzzy: true });
    expect(last(t.ovals)!.words.map((w) => w.text)).toEqual(["attention", "attentive"]);
    // The number and the marks agree — which is the whole reason the fallback
    // can be switched on for this route at all.
    expect(last(t.ovals)!.words).toHaveLength(2);
    // AND NOTHING WAS ASKED AGAIN: the ladder ran inside the one query.
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
    // Said once above the results, not per match — but it does not stop being
    // true because you moved to the next one.
    expect(last(t.states)).toEqual({ kind: "settled", at: 1, total: 2, fuzzy: true });
  });

  it("steps across page boundaries and turns the page as it goes", async () => {
    const t = build({ pages: [match(0, 2), match(1, 3)] });
    t.find.setNote("n1", MD5, RECOGNISED);
    t.find.open();
    t.find.setQuery("attent");
    await flush();
    await flush();

    t.find.step(1); // 0 → 1, still page 0
    expect(last(t.states)).toEqual({ kind: "settled", at: 1, total: 5, fuzzy: false });
    expect(t.view.showPage).not.toHaveBeenCalled();

    t.find.step(1); // 1 → 2, which is page 1
    expect(last(t.states)).toEqual({ kind: "settled", at: 2, total: 5, fuzzy: false });
    expect(t.view.showPage).toHaveBeenCalledWith(1);

    // Previous from the first match wraps to the last, on the last matching page.
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
    // The distinction is the point: nothing was searched, so nothing is claimed.
    expect(t.states.some((s) => s.kind === "empty")).toBe(false);
    // And it costs no request at all — `textHash` already said so.
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
    t.find.setPage(2); // textHash === null
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

    // The SLOW, OLDER query's answer lands last. Painting it would leave the
    // wrong count on screen with nothing later coming to correct it — the token
    // guard drops it.
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

  // A 404 from `text/<md5>` means "not derived, or not reachable" and the route
  // deliberately cannot say which. Rendering it as "No matches" would be a
  // confident false statement about a document that may well contain the word.
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

  // §1.1: "history and bin are not special: they are other md5s". A version
  // preview reaches this controller through `versionMeta`, which has already
  // rewritten `fileHash` — so the SAME code path searches the retained blob, with
  // no reroute in `historyScope` or `binScope` and no second response shape.
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
    // Close matches found → HELD, offered, nothing circled until opt-in.
    const hit = build({ pages: [match(0, 1)], usedFuzzy: true });
    hit.find.setNote("n1", MD5, RECOGNISED);
    hit.find.open();
    hit.find.setQuery("attenton");
    await flush();
    await flush();
    expect(last(hit.states)).toEqual({ kind: "fuzzyPrompt" });
    expect(last(hit.ovals)).toEqual({ words: [], current: -1 });

    // Even the typo-tolerant search found nothing → a real absence, no affordance.
    const miss = build({ pages: [], usedFuzzy: true });
    miss.find.setNote("n1", MD5, RECOGNISED);
    miss.find.open();
    miss.find.setQuery("zzzznope");
    await flush();
    await flush();
    expect(last(miss.states)).toEqual({ kind: "empty" });
  });
});
