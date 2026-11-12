// Quoted phrases: the words next to each other, in order.

import { describe, it, expect } from "vitest";
import { holdsAll, phrasesOf, withExpansions } from "../../src/search/phrase";
import { checkPhrases } from "../../src/search/searchService";
import type { LocalResults } from "../../src/search/localSearch";
import type { StoredDocumentText } from "../../src/cache/textStore";

describe("reading the phrases", () => {
  it("quoted runs of two or more words; a single quoted word is just a word", () => {
    expect(phrasesOf('"passé composé" verbos "ser"')).toEqual([{ words: ["passe", "compose"], open: false }]);
  });

  it("a quote still being typed is a phrase whose last word may be a start", () => {
    expect(phrasesOf('"passé comp')).toEqual([{ words: ["passe", "comp"], open: true }]);
    expect(holdsAll("o passé composé", phrasesOf('"passé comp'))).toBe(true);
    expect(holdsAll("o passé composé", phrasesOf('"passé comp"'))).toBe(false);
  });

  it("holds when the words are next to each other, in order, accents and case aside", () => {
    const p = phrasesOf('"passe compose"');
    expect(holdsAll("Revisar o Passé Composé", p)).toBe(true);
    expect(holdsAll("composé, depois passé", p)).toBe(false);
    expect(holdsAll("passé e composé", p)).toBe(false);
  });

  it("the typo ladder's words stand in for the typed ones", () => {
    const p = withExpansions(phrasesOf('"reuniao pais"'), [{ typed: "reuniao", matched: "reuniaa" }]);
    expect(holdsAll("a reuniaa pais", p)).toBe(true);
  });
});

describe("the library's check", () => {
  const MD5 = "a".repeat(32);
  const OTHER = "b".repeat(32);
  const text = { md5: MD5, indexVersion: 1, segmentCount: 3, segments: [
    { p: 0, o: null, l: null, t: "o passé composé" },
    { p: 2, o: null, l: null, t: "passé, e depois composé" },
  ] } as unknown as StoredDocumentText;
  const res = (query: string): LocalResults => ({
    query,
    totalPages: 3,
    expansions: [],
    documents: [
      { md5: MD5, fileId: 1, pages: [0, 2], updatedAt: 0, tier: "note", pageCount: 3 },
      { md5: OTHER, fileId: 2, pages: [4], updatedAt: 0, tier: "other", pageCount: 9 },
    ],
  });
  const store = { get: async (md5: string) => (md5 === MD5 ? text : null) };

  it("keeps the pages whose text holds the phrase, and counts what it couldn't check", async () => {
    const out = await checkPhrases(res('"passe compose"'), () => 1, store);
    expect(out.documents.find((d) => d.md5 === MD5)?.pages).toEqual([0]);
    // The other document's text isn't held: kept, and said.
    expect(out.documents.some((d) => d.md5 === OTHER)).toBe(true);
    expect(out.unchecked).toBe(1);
    expect(out.totalPages).toBe(2);
  });

  it("drops a document none of whose pages holds the phrase", async () => {
    const out = await checkPhrases(res('"compose passe"'), () => 1, store);
    expect(out.documents.map((d) => d.md5)).toEqual([OTHER]);
  });

  it("leaves a query without a phrase untouched", async () => {
    const r = res("passe compose");
    expect(await checkPhrases(r, () => 1, store)).toBe(r);
  });
});
