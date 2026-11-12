// What the browser still does with a query beside the index (`search/match.ts`):
// the match-inside fallback, and marking the matched words.

import { describe, it, expect } from "vitest";
import { holdsInside, insideMarks, insideOf, typedMarks } from "../../src/search/match";

const cut = (text: string, marks: [number, number][]) => marks.map(([a, b]) => text.slice(a, b));

describe("marking a result's words", () => {
  it("marks the typed words whole, accents and order aside, the last as the start of one", () => {
    const text = "Reunião de pais";
    expect(cut(text, typedMarks(text, "pa reuniao", []))).toEqual(["Reunião"]);
    expect(cut(text, typedMarks(text, "reuniao pa", []))).toEqual(["Reunião", "pais"]);
  });

  it("after a space, the last word is whole, as the index then takes it", () => {
    expect(typedMarks("Art and artist", "art ", []).length).toBe(1);
    expect(typedMarks("Art and artist", "art", []).length).toBe(2);
  });

  it("splits where the index splits: apostrophes, hyphens, dots", () => {
    expect(cut("l'école", typedMarks("l'école", "ecole", []))).toEqual(["école"]);
    expect(cut("page-range", typedMarks("page-range", "range ", []))).toEqual(["range"]);
  });

  it("marks the typo ladder's spellings too", () => {
    const text = "Caligrafia japonesa";
    expect(cut(text, typedMarks(text, "caligafia", [{ matched: "caligrafia" }]))).toEqual(["Caligrafia"]);
  });

  it("marks nothing for a query of only punctuation", () => {
    expect(typedMarks("anything", " -- ", [])).toEqual([]);
  });
});

describe("the fallback: typed text anywhere in a name", () => {
  it("folds accents and case, and marks the original letters", () => {
    expect(holdsInside("Lição 3", insideOf("icao"))).toBe(true);
    expect(holdsInside("MyStyle", insideOf("tyle"))).toBe(true);
    expect(holdsInside("MyStyle", insideOf("guide"))).toBe(false);
    const text = "Lição 3";
    expect(cut(text, insideMarks(text, insideOf("icao")))).toEqual(["ição"]);
  });

  it("keeps a decomposed accent with its letter", () => {
    const text = "Lição";
    expect(cut(text, insideMarks(text, insideOf("cao")))).toEqual(["ção"]);
  });

  it("a blank query holds nothing", () => {
    expect(insideOf(' " ')).toBeNull();
    expect(holdsInside("anything", insideOf(""))).toBe(false);
  });
});
