// Finding a lassoed task's words on its page.

import { describe, it, expect } from "vitest";
import type { WordBox } from "../../src/core/types";
import { findWords, inkAlpha, inkBounds, withMargin } from "../../src/pages/todo/todoInk";

const w = (text: string, xMm: number, yMm = 40, wMm = 10, hMm = 6): WordBox => ({ text, xMm, yMm, wMm, hMm });

describe("a task's words on its page", () => {
  const page = [w("Lire", 10, 20), w("Haus", 10), w("of", 22), w("gabin,", 30), w("demain", 10, 60)];

  it("finds the words in order and boxes them together", () => {
    expect(findWords(page, "Haus of gabin")).toEqual({ xMm: 10, yMm: 40, wMm: 30, hMm: 6 });
  });

  it("ignores case, accents and punctuation", () => {
    expect(findWords([w("École", 5), w("Dufle!", 16)], "ecole dufle")).toEqual({ xMm: 5, yMm: 40, wMm: 21, hMm: 6 });
  });

  it("splits a recognized word holding more than one token", () => {
    expect(findWords([w("the", 0), w("page-range", 12, 40, 20)], "the page range")).toEqual({ xMm: 0, yMm: 40, wMm: 32, hMm: 6 });
  });

  it("is null for words not on the page, out of order, or nothing to look for", () => {
    expect(findWords(page, "Haus of gaben")).toBeNull();
    expect(findWords(page, "gabin of Haus")).toBeNull();
    expect(findWords(page, "  ")).toBeNull();
    expect(findWords([], "Haus")).toBeNull();
  });

  it("a margin of a quarter line around the words", () => {
    expect(withMargin({ xMm: 10, yMm: 40, wMm: 30, hMm: 8 })).toEqual({ xMm: 8, yMm: 38, wMm: 34, hMm: 12 });
  });
});

describe("the strokes alone", () => {
  it("drops the paper and a template's light lines, keeps black and dark grey ink", () => {
    expect(inkAlpha(0)).toBe(0); // white paper
    expect(inkAlpha(54)).toBe(0); // a light grey line
    expect(inkAlpha(98)).toBeGreaterThan(50); // the dark grey pen
    expect(inkAlpha(255)).toBe(255); // black
  });

  it("trims to the ink, or nothing when there is none", () => {
    const on = new Set(["3,1", "5,4"]);
    expect(inkBounds((x, y) => (on.has(`${x},${y}`) ? 255 : 0), 8, 6)).toEqual({ x: 3, y: 1, w: 3, h: 4 });
    expect(inkBounds(() => 0, 8, 6)).toBeNull();
  });
});
