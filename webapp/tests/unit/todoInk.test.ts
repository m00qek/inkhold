// Finding a lassoed task's words on its page.

import { describe, it, expect } from "vitest";
import type { WordBox } from "../../src/core/types";
import { findWords, withMargin } from "../../src/pages/todo/todoInk";

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

  it("a margin of half a line around the ink", () => {
    expect(withMargin({ xMm: 10, yMm: 40, wMm: 30, hMm: 6 })).toEqual({ xMm: 7, yMm: 37, wMm: 36, hMm: 12 });
  });
});
