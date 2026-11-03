// @vitest-environment happy-dom
// The ink rail: rows built later wear their held mark, and an incomplete map draws nothing.

import { describe, it, expect, afterEach } from "vitest";
import { createPageIndex, type PageIndex, type PageIndexRow } from "../../src/pages/pageIndex";

let strip: PageIndex | null = null;

afterEach(() => {
  strip?.destroy();
  strip = null;
  document.body.replaceChildren();
});

function mount(inkWord?: string): PageIndex {
  const s = createPageIndex({
    id: "pages",
    onPick: () => {},
    mount: (_row: PageIndexRow) => {},
    unmount: (_row: PageIndexRow) => {},
    ...(inkWord ? { inkWord } : {}),
  });
  document.body.append(s.el);
  strip = s;
  return s;
}

/** The built rows, by page index — only the ones inside the virtual window. */
function rows(s: PageIndex): Map<number, HTMLElement> {
  const out = new Map<number, HTMLElement>();
  for (const el of s.el.querySelectorAll<HTMLElement>(".filmstrip__page")) {
    out.set(Number(el.getAttribute("data-page")), el);
  }
  return out;
}

function inked(s: PageIndex): number[] {
  return [...rows(s)]
    .filter(([, el]) => el.classList.contains("filmstrip__page--inked"))
    .map(([i]) => i)
    .sort((a, b) => a - b);
}

/** A complete map over `count` pages, with `on` the inked ones. */
function full(count: number, on: number[]): Map<number, boolean> {
  const m = new Map<number, boolean>();
  for (let i = 0; i < count; i++) m.set(i, on.includes(i));
  return m;
}

describe("page index — the ink rail", () => {
  it("marks exactly the inked rows, and no others", () => {
    const s = mount();
    s.setPages(6);
    s.setInk(full(6, [0, 2, 3]));
    expect(inked(s)).toEqual([0, 2, 3]);
  });

  it("holds the map, so rows BUILT LATER wear the mark they are due", () => {
    const s = mount();
    s.setInk(full(4, [1]));
    s.setPages(4);
    expect(inked(s)).toEqual([1]);
  });

  it("survives a clear() and rebuild", () => {
    const s = mount();
    s.setPages(4);
    s.setInk(full(4, [3]));
    expect(inked(s)).toEqual([3]);
    s.clear();
    expect(rows(s).size).toBe(0);
    s.setPages(4);
    expect(inked(s)).toEqual([3]);
  });

  it("re-marks live rows when the map is replaced", () => {
    const s = mount();
    s.setPages(4);
    s.setInk(full(4, [0, 1]));
    s.setInk(full(4, [2]));
    expect(inked(s)).toEqual([2]);
  });

  it("ALL OR NOTHING: one missing page blanks the whole rail", () => {
    const s = mount();
    s.setPages(5);
    // Page 4 is absent (not yet scanned), so nothing draws: a partial rail would claim it empty.
    const partial = new Map<number, boolean>([
      [0, true],
      [1, false],
      [2, true],
      [3, false],
    ]);
    s.setInk(partial);
    expect(inked(s)).toEqual([]);
    s.setInk(full(5, [0, 2]));
    expect(inked(s)).toEqual([0, 2]);
  });

  it("an empty map is no claim, not an all-empty document", () => {
    const s = mount();
    s.setPages(3);
    s.setInk(new Map());
    expect(inked(s)).toEqual([]);
  });

  it("names the fact in WORDS on the row, and only on the marked ones", () => {
    const s = mount();
    s.setPages(3);
    s.setInk(full(3, [1]));
    const r = rows(s);
    expect(r.get(0)?.getAttribute("aria-label")).toBe("Page 1");
    expect(r.get(1)?.getAttribute("aria-label")).toBe("Page 2, written");
    expect(r.get(2)?.getAttribute("aria-label")).toBe("Page 3");
  });

  it("takes the viewer's word for it — a PDF page is ANNOTATED", () => {
    const s = mount("annotated");
    s.setPages(2);
    s.setInk(full(2, [0]));
    expect(rows(s).get(0)?.getAttribute("aria-label")).toBe("Page 1, annotated");
  });

  it("the stroke is decorative — it is not an element of its own", () => {
    // The mark is a `::before`, so a screen reader meets only the row's name.
    const s = mount();
    s.setPages(2);
    s.setInk(full(2, [0, 1]));
    for (const el of rows(s).values()) {
      expect(el.querySelector("[class*='ink']")).toBeNull();
    }
  });
});
