// @vitest-environment happy-dom

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
    expect(built.map((r) => r.style.getPropertyValue("--depth"))).toEqual([
      "0",
      "1",
      "1",
      "0",
      "1",
      "2",
    ]);
    expect(built[5]!.classList.contains("pdf-outline__row--d2")).toBe(true);
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
    // Pages between two entries belong to the earlier one.
    p.setCurrent(1);
    expect(currentTitle(p)).toBe("Chapter A");
    p.setCurrent(3);
    expect(currentTitle(p)).toBe("Part Two");
    p.setCurrent(5);
    expect(currentTitle(p)).toBe("Section C.1");
    p.setCurrent(400);
    expect(currentTitle(p)).toBe("Section C.1");
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
    // A Part and its first Chapter on one page: the Chapter wins.
    const p = mount();
    p.setEntries([
      { depth: 0, title: "Part Two", page: 3 },
      { depth: 1, title: "Chapter C", page: 3 },
    ]);
    p.setCurrent(3);
    expect(currentTitle(p)).toBe("Chapter C");
  });

  it("draws an entry with no destination, disabled, with no number — and never current", () => {
    // A null-destination row is drawn but inert; a hole would read as a missing chapter.
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

    p.setEntries([{ depth: 0, title: "Only", page: 0 }]);
    expect(rows(p)).toHaveLength(1);
    expect(currentTitle(p)).toBeNull();

    p.clear();
    expect(rows(p)).toHaveLength(0);
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
    expect(currentTitle(p)).toBe("Part Two");
    p.setOpen(false);
    expect(p.el.hidden).toBe(true);
  });
});
