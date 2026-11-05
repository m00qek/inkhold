// Which line a search result shows, and how it is cut.

import { describe, it, expect } from "vitest";
import { excerptQuery, pickExcerpt, MAX_PAGES, WIDTH } from "../../src/search/excerpt";
import type { TextSegment } from "../../src/search/docText";

const seg = (p: number, t: string): TextSegment => ({ p, o: null, l: null, t });
const doc = (...segments: TextSegment[]) => ({ segments });
const marked = (x: { text: string; marks: readonly (readonly [number, number])[] } | null) => x?.marks.map(([a, b]) => x.text.slice(a, b));
const q = (s: string, e: { typed: string; matched: string }[] = []) => excerptQuery(s, e)!;

describe("the query an excerpt looks for", () => {
  it("the last word is a start while it is being typed", () => {
    expect(excerptQuery("reuniao pa")).toEqual({ terms: ["reuniao"], start: "pa" });
    expect(excerptQuery("reuniao pais ")).toEqual({ terms: ["reuniao", "pais"], start: null });
  });

  it("the typo ladder's words replace the typed ones", () => {
    expect(excerptQuery("reunião", [{ typed: "reuniao", matched: "reuniaa" }])).toEqual({ terms: ["reuniaa"], start: null });
  });
});

describe("which page's line", () => {
  it("the page where the words sit closest together", () => {
    const d = doc(seg(0, "reunião no início " + "e mais texto ".repeat(20) + "pais no fim"), seg(3, "a reunião de pais foi ótima"));
    const x = pickExcerpt(d, [0, 3], q("reuniao pais "));
    expect(x?.segment).toBe(3);
    expect(marked(x)).toEqual(["reunião", "pais"]);
  });

  it("the words as typed before a word that only starts so", () => {
    const d = doc(seg(1, "a casamento"), seg(2, "a casa"));
    expect(pickExcerpt(d, [1, 2], q("a casa"))?.segment).toBe(2);
  });

  it("on a tie, the earliest page", () => {
    const d = doc(seg(5, "ler o livro"), seg(2, "ler o livro"));
    expect(pickExcerpt(d, [2, 5], q("livro "))?.segment).toBe(2);
  });

  it("only the matching pages, and only the first fifty of them", () => {
    const pages = Array.from({ length: 60 }, (_, i) => seg(i, i === 55 ? "livro livro" : "nada aqui"));
    expect(pickExcerpt(doc(...pages), [55], q("livro "))?.segment).toBe(55);
    const many = Array.from({ length: 60 }, (_, i) => i);
    expect(pickExcerpt(doc(...pages), many, q("livro "))).toBeNull();
    expect(MAX_PAGES).toBe(50);
  });

  it("null when no matching page has the words", () => {
    expect(pickExcerpt(doc(seg(0, "nada")), [0], q("livro "))).toBeNull();
  });
});

describe("cutting the line", () => {
  it("about one line, at word edges, whitespace collapsed, ellipsis where cut", () => {
    const long = "palavra ".repeat(40) + "o\n\nalvo   está aqui " + "depois ".repeat(40);
    const x = pickExcerpt(doc(seg(0, long)), [0], q("alvo "))!;
    expect(x.text.length).toBeLessThanOrEqual(WIDTH);
    expect(x.text).toContain("o alvo está aqui");
    // No word cut in half: whole words at both ends.
    expect(x.text).toMatch(/^palavra /);
    expect(x.text).toMatch(/ depois$/);
    expect(x.cutStart && x.cutEnd).toBe(true);
    expect(marked(x)).toEqual(["alvo"]);
  });

  it("a short page whole, uncut", () => {
    const x = pickExcerpt(doc(seg(0, "Haus of gabin")), [0], q("gab"))!;
    expect(x).toMatchObject({ text: "Haus of gabin", cutStart: false, cutEnd: false });
    expect(marked(x)).toEqual(["gabin"]);
  });

  it("marks accented words by their folded form", () => {
    const x = pickExcerpt(doc(seg(0, "Revisar o passé composé")), [0], q("passe compose "))!;
    expect(marked(x)).toEqual(["passé", "composé"]);
  });
});
