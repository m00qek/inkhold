// @vitest-environment happy-dom
//
// The OUTLINE panel (src/pages/pdfOutlinePanel.ts) as a DOM unit.
//
// Two things here are behaviour rather than markup, and they are what this file
// is for:
//
//   - `setCurrent` takes a PAGE, not a row: the mark is the entry the reader is
//     INSIDE, so it has to track paging and the arrow keys as faithfully as it
//     tracks a click. Page 47 of a document whose Chapter 3 starts at 40 is in
//     Chapter 3, and nothing but this rule puts it there.
//   - the indent CLAMPS. `--sp-3` a level runs out of a 268px track at five
//     levels, so depth 4 and depth 9 have to draw as depth 3 — in the indent AND
//     in the type, or a level-6 entry becomes a column of single characters.
//
// The rest — 1-based numbers over a 0-based wire, a null-destination row drawn
// and inert — is the panel keeping two promises the parser makes.

import { describe, it, expect, afterEach } from "vitest";
import { createPdfOutlinePanel, type PdfOutlinePanel } from "../../src/pages/pdfOutlinePanel";
import type { PdfOutlineEntry } from "../../src/render/pdfWire";

let panel: PdfOutlinePanel | null = null;
let picked: number[] = [];

afterEach(() => {
  panel = null;
  picked = [];
  document.body.replaceChildren();
});

function mount(): PdfOutlinePanel {
  picked = [];
  const p = createPdfOutlinePanel({ onPick: (page) => picked.push(page) });
  document.body.append(p.el);
  panel = p;
  return p;
}

/** The fixture's outline: three levels, six pages, in document order. */
const BOOK: PdfOutlineEntry[] = [
  { depth: 0, title: "Part One", page: 0 },
  { depth: 1, title: "Chapter A", page: 1 },
  { depth: 1, title: "Chapter B", page: 2 },
  { depth: 0, title: "Part Two", page: 3 },
  { depth: 1, title: "Chapter C", page: 4 },
  { depth: 2, title: "Section C.1", page: 5 },
];

function rows(p: PdfOutlinePanel): HTMLButtonElement[] {
  return [...p.el.querySelectorAll<HTMLButtonElement>(".pdf-outline__row")];
}

function currentTitle(p: PdfOutlinePanel): string | null {
  const row = p.el.querySelector('.pdf-outline__row[aria-current="true"]');
  return row?.querySelector(".pdf-outline__t")?.textContent ?? null;
}

describe("the PDF outline panel", () => {
  it("builds a row per entry, in document order, with its depth and 1-based page", () => {
    const p = mount();
    p.setEntries(BOOK);
    const built = rows(p);
    expect(built).toHaveLength(6);
    expect(built.map((r) => r.querySelector(".pdf-outline__t")!.textContent)).toEqual([
      "Part One",
      "Chapter A",
      "Chapter B",
      "Part Two",
      "Chapter C",
      "Section C.1",
    ]);
    // The indent is a custom property the stylesheet multiplies by a spacing
    // step; the type is a class, because it steps down a scale and stops.
    expect(built.map((r) => r.style.getPropertyValue("--depth"))).toEqual([
      "0",
      "1",
      "1",
      "0",
      "1",
      "2",
    ]);
    expect(built[5]!.classList.contains("pdf-outline__row--d2")).toBe(true);
    // 1-BASED ON SCREEN over a 0-based wire. The number beside a heading is the
    // one printed on the page, not the index `go()` takes.
    expect(built.map((r) => r.querySelector(".pdf-outline__p")!.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
  });

  it("hands the 0-based page back on a click", () => {
    const p = mount();
    p.setEntries(BOOK);
    rows(p)[4]!.click();
    expect(picked).toEqual([4]);
  });

  it("marks the entry with the greatest page AT OR BEFORE the current one", () => {
    const p = mount();
    p.setEntries(BOOK);

    p.setCurrent(0);
    expect(currentTitle(p)).toBe("Part One");
    // The pages BETWEEN two entries belong to the earlier one — this is the
    // whole reason the argument is a page and not a row index.
    p.setCurrent(1);
    expect(currentTitle(p)).toBe("Chapter A");
    p.setCurrent(3);
    expect(currentTitle(p)).toBe("Part Two");
    p.setCurrent(5);
    expect(currentTitle(p)).toBe("Section C.1");
    // Past the last entry, the last entry still covers you.
    p.setCurrent(400);
    expect(currentTitle(p)).toBe("Section C.1");
    // Exactly one row is ever marked.
    expect(p.el.querySelectorAll('.pdf-outline__row[aria-current="true"]')).toHaveLength(1);
  });

  it("marks nothing when no entry starts at or before the page", () => {
    const p = mount();
    p.setEntries([
      { depth: 0, title: "Late", page: 4 },
      { depth: 0, title: "Later", page: 9 },
    ]);
    p.setCurrent(0);
    expect(currentTitle(p)).toBeNull();
    p.setCurrent(4);
    expect(currentTitle(p)).toBe("Late");
  });

  it("gives a tie to the LAST entry on that page — the more precise one", () => {
    // A Part and its first Chapter beginning on one page: the Chapter is the
    // better answer to "where am I".
    const p = mount();
    p.setEntries([
      { depth: 0, title: "Part Two", page: 3 },
      { depth: 1, title: "Chapter C", page: 3 },
    ]);
    p.setCurrent(3);
    expect(currentTitle(p)).toBe("Chapter C");
  });

  it("draws an entry with no destination, disabled, with no number — and never current", () => {
    // A hole in a table of contents reads as "there is no Chapter Four" about a
    // chapter that is right there, so the line stays; it is simply inert.
    const p = mount();
    p.setEntries([
      { depth: 0, title: "Part One", page: 0 },
      { depth: 1, title: "Unresolvable", page: null },
      { depth: 1, title: "Chapter B", page: 2 },
    ]);
    const built = rows(p);
    expect(built).toHaveLength(3);
    expect(built[1]!.disabled).toBe(true);
    expect(built[1]!.querySelector(".pdf-outline__p")).toBeNull();
    built[1]!.click();
    expect(picked).toEqual([]);

    // It names no place, so there is no page it could be said to cover: the mark
    // steps over it to the entry that does.
    p.setCurrent(1);
    expect(currentTitle(p)).toBe("Part One");
    p.setCurrent(2);
    expect(currentTitle(p)).toBe("Chapter B");
  });

  it("clamps the indent AND the type past depth 3", () => {
    const p = mount();
    p.setEntries([
      { depth: 3, title: "Three", page: 0 },
      { depth: 4, title: "Four", page: 1 },
      { depth: 9, title: "Nine", page: 2 },
    ]);
    const built = rows(p);
    expect(built.map((r) => r.style.getPropertyValue("--depth"))).toEqual(["3", "3", "3"]);
    for (const row of built) {
      expect(row.classList.contains("pdf-outline__row--d3")).toBe(true);
    }
  });

  it("rebuilds from scratch on setEntries, and clear() empties it", () => {
    const p = mount();
    p.setEntries(BOOK);
    p.setCurrent(5);
    expect(rows(p)).toHaveLength(6);

    // A second document's outline replaces the first's rather than joining it —
    // and takes the previous document's mark with it.
    p.setEntries([{ depth: 0, title: "Only", page: 0 }]);
    expect(rows(p)).toHaveLength(1);
    expect(currentTitle(p)).toBeNull();

    p.clear();
    expect(rows(p)).toHaveLength(0);
    // Cleared is not broken: a mark set against no entries marks nothing.
    p.setCurrent(0);
    expect(currentTitle(p)).toBeNull();
  });

  it("is the panel an opener can point at, and opens and shuts", () => {
    const p = mount();
    expect(p.el.id).toBe("pdf-outline-panel");
    expect(p.el.hidden).toBe(true);
    p.setEntries(BOOK);
    p.setCurrent(3);
    p.setOpen(true);
    expect(p.el.hidden).toBe(false);
    // The mark survives the reveal — opening must not move it.
    expect(currentTitle(p)).toBe("Part Two");
    p.setOpen(false);
    expect(p.el.hidden).toBe(true);
  });
});
