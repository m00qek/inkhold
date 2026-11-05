// The one rule names are matched by: the index's, applied in the browser.

import { describe, it, expect } from "vitest";
import { insideQuery, matchesName, nameMarks, nameQuery, nameQueryFor } from "../../src/search/match";

const m = (text: string, q: string) => matchesName(text, nameQuery(q));

describe("matching a name", () => {
  it("folds accents and case on both sides", () => {
    expect(m("Reunião", "REUNIAO")).toBe(true);
    expect(m("Reuniao", "reunião")).toBe(true);
  });

  it("needs every word, in any order", () => {
    expect(m("Haus of gabin", "gabin haus")).toBe(true);
    expect(m("Haus of gabin", "haus casa")).toBe(false);
  });

  it("the last word as the start of a word, the rest whole", () => {
    expect(m("Haus of gabin", "haus ga")).toBe(true);
    expect(m("Haus of gabin", "ha gabin")).toBe(false);
    expect(m("Haus of gabin", "abin")).toBe(false);
  });

  it("splits where the index splits: apostrophes, hyphens, dots", () => {
    expect(m("l'école", "ecole")).toBe(true);
    expect(m("page-range", "range")).toBe(true);
    expect(m("Apostila.note", "apostila")).toBe(true);
  });

  it("a query of only punctuation matches nothing", () => {
    expect(nameQuery(" -- ")).toBeNull();
    expect(m("anything", "--")).toBe(false);
  });
});

describe("marking a matched name", () => {
  it("marks the whole words that matched, in the original string", () => {
    const text = "Reunião de pais";
    expect(nameMarks(text, nameQuery("reuniao pa")).map(([a, b]) => text.slice(a, b))).toEqual(["Reunião", "pais"]);
  });

  it("marks nothing when the name did not match", () => {
    expect(nameMarks("Haus of gabin", nameQuery("casa"))).toEqual([]);
  });
});

describe("the fallback: typed text anywhere in a name", () => {
  it("is used only when the word rule matches no name", () => {
    expect(nameQueryFor("style", ["MyStyle", "Style guide"])?.inside).toBeUndefined();
    expect(nameQueryFor("style", ["MyStyle"])?.inside).toBe("style");
  });

  it("folds accents and case, and marks the original letters", () => {
    expect(matchesName("Lição 3", insideQuery("icao"))).toBe(true);
    const text = "Lição 3";
    expect(nameMarks(text, insideQuery("icao")).map(([a, b]) => text.slice(a, b))).toEqual(["ição"]);
  });

  it("keeps a decomposed accent with its letter", () => {
    const text = "Lic\u0327a\u0303o";
    expect(nameMarks(text, insideQuery("cao")).map(([a, b]) => text.slice(a, b))).toEqual(["c\u0327a\u0303o"]);
  });
});
