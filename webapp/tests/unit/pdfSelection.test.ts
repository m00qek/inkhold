import { describe, it, expect } from "vitest";
import { nearestWord, selectionText, wordAtPoint, wordsInRange } from "../../src/pages/pdf/pdfSelection";
import type { PdfWord } from "../../src/render/pdfWire";

/** A word on `line`, `n`th across, boxes 20 wide and 10 tall on a 12pt grid. */
function w(t: string, line: number, n: number): PdfWord {
  return { t, x: 10 + n * 25, y: 10 + line * 20, w: 20, h: 10, line };
}

/** Two lines of two words, then a third line of one. */
const PAGE: PdfWord[] = [
  w("the", 0, 0),
  w("quick", 0, 1),
  w("brown", 1, 0),
  w("fox", 1, 1),
  w("jumps", 2, 0),
];

describe("wordsInRange", () => {
  it("covers everything between the two ends, inclusive", () => {
    expect(wordsInRange(PAGE, { anchor: 1, head: 3 }).map((x) => x.t)).toEqual([
      "quick",
      "brown",
      "fox",
    ]);
  });

  it("DRAGGING BACKWARDS SELECTS THE SAME PASSAGE", () => {
    const down = wordsInRange(PAGE, { anchor: 1, head: 3 });
    const up = wordsInRange(PAGE, { anchor: 3, head: 1 });
    expect(up).toEqual(down);
  });

  it("a click without a drag selects the one word under it", () => {
    expect(wordsInRange(PAGE, { anchor: 2, head: 2 }).map((x) => x.t)).toEqual(["brown"]);
  });

  it("clamps a range that runs past the page instead of answering holes", () => {
    expect(wordsInRange(PAGE, { anchor: 3, head: 99 }).map((x) => x.t)).toEqual(["fox", "jumps"]);
    expect(wordsInRange(PAGE, { anchor: -4, head: 1 }).map((x) => x.t)).toEqual(["the", "quick"]);
    expect(wordsInRange([], { anchor: 0, head: 2 })).toEqual([]);
  });
});

describe("selectionText", () => {
  it("joins words with spaces and lines with newlines", () => {
    expect(selectionText(PAGE)).toBe("the quick\nbrown fox\njumps");
  });

  it("a selection inside one line has no break in it", () => {
    expect(selectionText(wordsInRange(PAGE, { anchor: 0, head: 1 }))).toBe("the quick");
  });

  it("breaks where the LINE ID changes, not where the geometry suggests", () => {
    // Side-by-side columns share a baseline; the line id keeps them apart.
    const columns: PdfWord[] = [
      { t: "left", x: 10, y: 50, w: 20, h: 10, line: 0 },
      { t: "right", x: 200, y: 50, w: 20, h: 10, line: 1 },
    ];
    expect(selectionText(columns)).toBe("left\nright");
  });

  it("keeps a hyphenated word broken, exactly as the page has it", () => {
    // MuPDF joins nothing across lines; rejoining hyphens would edit the text.
    const split: PdfWord[] = [
      { t: "hyphen-", x: 10, y: 10, w: 30, h: 10, line: 0 },
      { t: "ated", x: 10, y: 30, w: 20, h: 10, line: 1 },
    ];
    expect(selectionText(split)).toBe("hyphen-\nated");
  });

  it("says nothing for nothing", () => {
    expect(selectionText([])).toBe("");
  });

  it("survives a page whose words all landed on line zero", () => {
    const flat = PAGE.map((x) => ({ ...x, line: 0 }));
    expect(selectionText(flat)).toBe("the quick brown fox jumps");
  });
});

describe("wordAtPoint", () => {
  it("finds the word under the point, and nothing in the margin", () => {
    expect(wordAtPoint(PAGE, 15, 14)).toBe(0);
    expect(wordAtPoint(PAGE, 20, 34)).toBe(2);
    expect(wordAtPoint(PAGE, 40, 34)).toBe(3);
    expect(wordAtPoint(PAGE, 400, 400)).toBeNull();
  });

  it("includes the box edges", () => {
    expect(wordAtPoint(PAGE, 10, 10)).toBe(0);
    expect(wordAtPoint(PAGE, 30, 20)).toBe(0);
  });

  it("resolves an overlap to the later word, which is the one on top", () => {
    const stacked: PdfWord[] = [
      { t: "under", x: 0, y: 0, w: 50, h: 20, line: 0 },
      { t: "over", x: 10, y: 5, w: 20, h: 10, line: 0 },
    ];
    expect(wordAtPoint(stacked, 15, 10)).toBe(1);
  });
});

describe("nearestWord", () => {
  it("reaches the end of a line from the white space past it", () => {
    expect(nearestWord(PAGE, 400, 34)).toBe(3);
  });

  it("PICKS THE LINE BEFORE THE POSITION, so a short line does not snap back", () => {
    // Regression: dragging into the margin right of a short line snapped back up the page
    // by straight-line distance. The search is vertical first.
    const shortLast: PdfWord[] = [
      { t: "long", x: 10, y: 10, w: 280, h: 10, line: 0 },
      { t: "zeta", x: 10, y: 40, w: 30, h: 10, line: 1 },
    ];
    expect(nearestWord(shortLast, 500, 45)).toBe(1);
  });

  it("takes the LAST word of the line when the pointer is past its end", () => {
    expect(nearestWord(PAGE, 999, 14)).toBe(1);
  });

  it("takes the FIRST word of the line when the pointer is before its start", () => {
    expect(nearestWord(PAGE, -50, 34)).toBe(2);
  });

  it("reaches the line below the last one, rather than nothing", () => {
    expect(nearestWord(PAGE, 15, 999)).toBe(4);
  });

  it("answers the word under the point when there is one", () => {
    expect(nearestWord(PAGE, 15, 14)).toBe(0);
  });

  it("has nothing to say about a page with no words", () => {
    expect(nearestWord([], 10, 10)).toBeNull();
  });
});
