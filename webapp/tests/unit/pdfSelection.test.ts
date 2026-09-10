// Selecting a passage of a PDF's text (src/pages/pdfSelection.ts) — which words a
// drag covers, and what they say when copied.
//
// This is the half of §9 with the decisions in it. Where the boxes go is
// arithmetic the highlight layer already does and already tests; whether a
// reader gets their paragraph back, in the order the page has it and with its
// line breaks intact, is decided here.

import { describe, it, expect } from "vitest";
import { nearestWord, selectionText, wordAtPoint, wordsInRange } from "../../src/pages/pdfSelection";
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
    // The property that makes a selection a passage rather than a gesture: a
    // reader who drags up the page gets what they enclosed, in reading order,
    // not in the order their hand moved.
    const down = wordsInRange(PAGE, { anchor: 1, head: 3 });
    const up = wordsInRange(PAGE, { anchor: 3, head: 1 });
    expect(up).toEqual(down);
  });

  it("a click without a drag selects the one word under it", () => {
    expect(wordsInRange(PAGE, { anchor: 2, head: 2 }).map((x) => x.t)).toEqual(["brown"]);
  });

  it("clamps a range that runs past the page instead of answering holes", () => {
    // `words` can shrink under a live range — a page turn races a drag — and the
    // safe reading of "to index 99" on a five-word page is "to the end".
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
    // The reason the id is carried at all. These two words share a baseline —
    // they are side-by-side columns — and a y-coordinate rule would join them
    // into one line. The document says they are two, and the document is right.
    const columns: PdfWord[] = [
      { t: "left", x: 10, y: 50, w: 20, h: 10, line: 0 },
      { t: "right", x: 200, y: 50, w: 20, h: 10, line: 1 },
    ];
    expect(selectionText(columns)).toBe("left\nright");
  });

  it("keeps a hyphenated word broken, exactly as the page has it", () => {
    // MuPDF joins nothing across lines, so a word split over a break arrives as
    // two runs. Rejoining would mean guessing which hyphens are breaks and which
    // belong to the word — and a wrong guess edits the document on its way to
    // somebody's clipboard.
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
    // The degradation `parsePageWords` chooses when a decoder sends no line id:
    // one long line, which is a passage without its breaks rather than a passage
    // broken in the wrong places.
    const flat = PAGE.map((x) => ({ ...x, line: 0 }));
    expect(selectionText(flat)).toBe("the quick brown fox jumps");
  });
});

describe("wordAtPoint", () => {
  it("finds the word under the point, and nothing in the margin", () => {
    expect(wordAtPoint(PAGE, 15, 14)).toBe(0);
    // Second line, first word: it spans x 10..30 and y 30..40.
    expect(wordAtPoint(PAGE, 20, 34)).toBe(2);
    // …and a step to the right lands on the word beside it, not on it.
    expect(wordAtPoint(PAGE, 40, 34)).toBe(3);
    // Below the last line and off to the right: a press on nothing.
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
    // THE PROPERTY THAT KEEPS A DRAG ALIVE. Selecting to the end of a paragraph
    // means pulling past the last word; a strict hit test answers nothing there
    // and the selection would stop growing exactly where it is being taken.
    expect(nearestWord(PAGE, 400, 34)).toBe(3);
  });

  it("PICKS THE LINE BEFORE THE POSITION, so a short line does not snap back", () => {
    // The bug a real page found. `long` runs the width of the page; `zeta` is a
    // short line below it. A pointer dragged into the margin to the right of
    // `zeta` is, in straight-line distance, NEARER the end of `long` — so a
    // plain nearest-box rule pulls the selection back UP the page, shrinking it
    // exactly when the reader is trying to extend it. Reading order is vertical
    // first, so the search is too.
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
