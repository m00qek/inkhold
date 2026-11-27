import { describe, it, expect } from "vitest";
import { afterEach, beforeEach } from "vitest";
import { keepOrder, planKeep, rememberedSizes, TERMS_SIZES_KEY, TERMS_SIZES_MAX } from "../../src/search/termsBudget";
import { termsKeyOf, weigh } from "../../src/cache/termsStore";
import type { ManifestRow, Tier } from "../../src/search/manifestCodec";

function row(md5: string, tier: Tier, updatedAt: number, indexVersion: number | null = 1): ManifestRow {
  return { md5, fileId: 0, tier, updatedAt, indexVersion, derivation: "derived" };
}

/** Sizes by md5, at index version 1. */
function sizes(by: Record<string, number>): (key: string) => number | undefined {
  const keyed = new Map(Object.entries(by).map(([md5, size]) => [termsKeyOf(md5, 1), size]));
  return (key) => keyed.get(key);
}

describe("keepOrder", () => {
  it("puts every notebook first, then the rest by most recently changed, whatever the tier", () => {
    const rows = [
      row("old-note", "note", 100),
      row("new-note", "note", 300),
      row("old-marked", "marked", 50),
      row("new-other", "other", 400),
      row("mid-other", "other", 200),
    ];
    expect(keepOrder(rows).map((i) => rows[i]!.md5)).toEqual(["new-note", "old-note", "new-other", "mid-other", "old-marked"]);
  });

  it("keeps the manifest's order between documents changed in the same second", () => {
    const rows = [row("a", "other", 5), row("b", "other", 5), row("c", "other", 5)];
    expect(keepOrder(rows)).toEqual([0, 1, 2]);
  });
});

describe("planKeep", () => {
  it("keeps an old notebook before a newer book, and leaves the book out when both don't fit", () => {
    const rows = [row("note", "note", 1), row("book", "other", 9)];
    const plan = planKeep(rows, sizes({ note: 60, book: 50 }), 100);
    expect([...plan.keep]).toEqual([0]);
    expect(plan.leftOut).toEqual([1]);
  });

  it("goes on past a document that doesn't fit: a big book doesn't push out the smaller ones after it", () => {
    const rows = [row("small", "other", 9), row("big", "other", 8), row("smaller", "other", 7)];
    const plan = planKeep(rows, sizes({ small: 40, big: 80, smaller: 30 }), 100);
    expect([...plan.keep].sort()).toEqual([0, 2]);
    expect(plan.leftOut).toEqual([1]);
  });

  it("keeps, so asks for, a document never weighed, whatever the budget", () => {
    const rows = [row("held", "other", 9), row("new", "other", 8)];
    const plan = planKeep(rows, sizes({ held: 100 }), 100);
    expect([...plan.keep].sort()).toEqual([0, 1]);
    expect(plan.leftOut).toEqual([]);
  });

  it("neither keeps nor leaves out a row with no index version: it can't be cached", () => {
    const plan = planKeep([row("x", "note", 1, null)], () => 10, 0);
    expect(plan.keep.size).toBe(0);
    expect(plan.leftOut).toEqual([]);
  });

  it("counts copies of one file once: they share a record", () => {
    const rows = [row("same", "other", 9), row("same", "other", 8), row("other", "other", 7)];
    const plan = planKeep(rows, sizes({ same: 60, other: 40 }), 100);
    expect([...plan.keep].sort()).toEqual([0, 1, 2]);
    expect(plan.leftOut).toEqual([]);
  });

  it("lists what is left out in keep order, the most wanted first, as search names them", () => {
    const rows = [row("a", "other", 1), row("b", "other", 3), row("note", "note", 0), row("c", "other", 2)];
    expect(planKeep(rows, sizes({ a: 10, b: 10, note: 10, c: 10 }), 0).leftOut).toEqual([2, 1, 3, 0]);
  });

  it("lists each copy of a file left out: one record, but each has its own place", () => {
    const rows = [row("same", "other", 9), row("same", "other", 8), row("small", "other", 7)];
    expect(planKeep(rows, sizes({ same: 60, small: 10 }), 50).leftOut).toEqual([0, 1]);
  });
});

describe("rememberedSizes", () => {
  const g = globalThis as { localStorage?: unknown };
  let saved: unknown;
  let mem: Map<string, string>;
  beforeEach(() => {
    saved = g.localStorage;
    mem = new Map();
    g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  });
  afterEach(() => {
    g.localStorage = saved;
  });

  it("keeps sizes across visits, under its own key", () => {
    rememberedSizes().set([["a.1", 10], ["b.1", 20]]);
    const next = rememberedSizes();
    expect(next.get("a.1")).toBe(10);
    expect(next.get("b.1")).toBe(20);
    expect(next.get("c.1")).toBeUndefined();
    expect([...mem.keys()]).toEqual([TERMS_SIZES_KEY]);
  });

  it("merges what another tab wrote since, instead of writing over it", () => {
    const tabA = rememberedSizes();
    const tabB = rememberedSizes();
    tabA.set([["a.1", 10]]);
    tabB.set([["b.1", 20]]);
    const next = rememberedSizes();
    expect(next.get("a.1")).toBe(10);
    expect(next.get("b.1")).toBe(20);
  });

  it("never writes back what sign-out removed: a late write carries only its own sizes", () => {
    const tab = rememberedSizes();
    tab.set([["a.1", 10], ["b.1", 20]]);
    // Sign-out clears the key (`forget.ts`) while a sync is still running here.
    mem.delete(TERMS_SIZES_KEY);
    tab.set([["c.1", 30]]);
    expect(JSON.parse(mem.get(TERMS_SIZES_KEY)!)).toEqual([["c.1", 30]]);
  });

  it("skips malformed entries, and starts empty on a value that isn't a list", () => {
    mem.set(TERMS_SIZES_KEY, JSON.stringify([["a.1", 10], ["b.1", "big"], [3, 4], "x", ["c.1", -1]]));
    const sizes = rememberedSizes();
    expect(sizes.get("a.1")).toBe(10);
    expect(sizes.get("b.1")).toBeUndefined();
    expect(sizes.get("c.1")).toBeUndefined();
    mem.set(TERMS_SIZES_KEY, "{not json");
    expect(rememberedSizes().get("a.1")).toBeUndefined();
  });

  it("forgets the oldest past its cap, and counts a size set again as new", () => {
    const sizes = rememberedSizes();
    sizes.set(Array.from({ length: TERMS_SIZES_MAX }, (_, i) => [`k${i}.1`, i] as const));
    sizes.set([["k0.1", 0]]);
    sizes.set([["new.1", 1]]);
    const next = rememberedSizes();
    expect(next.get("k0.1")).toBe(0);
    expect(next.get("k1.1")).toBeUndefined();
    expect(next.get("new.1")).toBe(1);
    expect((JSON.parse(mem.get(TERMS_SIZES_KEY)!) as unknown[]).length).toBe(TERMS_SIZES_MAX);
  });

  it("works for the visit where localStorage refuses", () => {
    g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const sizes = rememberedSizes();
    sizes.set([["k.1", 42]]);
    expect(sizes.get("k.1")).toBe(42);
  });
});

describe("weigh", () => {
  // What the budget compares: UTF-8 bytes, as `TextEncoder` counts them.
  it("counts a record's terms in UTF-8 bytes, plus a little per page", () => {
    const md5 = "a".repeat(32);
    for (const t of ["reuniao", "reunião ação", "日本語", "🐋 whale", "lone \ud83d high"]) {
      const bytes = new TextEncoder().encode(t).length;
      expect(weigh({ md5, pages: [{ p: 0, t }] })).toBe(32 + 24 + bytes + 8);
    }
  });
});
