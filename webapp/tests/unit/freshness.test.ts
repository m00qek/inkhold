import { describe, it, expect } from "vitest";
import { classify, sameEntry, reconcile } from "../../src/sync/freshness";
import type { Entry, Listing, NoteSummary } from "../../src/core/types";

function note(id: string, updatedAt: number, hash = "h", name = id, pageCount = 1): NoteSummary {
  return {
    kind: "note",
    id,
    name,
    pageCount,
    updatedAt,
    firstPage: { index: 0, hash, width: 1404, height: 1872, textHash: null },
  };
}

function listing(entries: Entry[], syncVersion: number, folderId: string | null = null): Listing {
  return { folderId, path: [], entries, syncVersion };
}

describe("classify", () => {
  it("is a miss with no cached listing", () => {
    expect(classify(undefined, 5)).toBe("miss");
  });

  it("is stale when the user's files advanced past the cached version", () => {
    expect(classify(listing([], 3), 5)).toBe("stale");
  });

  it("is fresh when the cached version matches or leads", () => {
    expect(classify(listing([], 5), 5)).toBe("fresh");
    expect(classify(listing([], 6), 5)).toBe("fresh");
  });
});

describe("sameEntry", () => {
  it("distinguishes a changed page hash (an edit to the first page)", () => {
    expect(sameEntry(note("a", 1, "h1"), note("a", 1, "h2"))).toBe(false);
  });

  it("distinguishes a changed updatedAt", () => {
    expect(sameEntry(note("a", 1), note("a", 2))).toBe(false);
  });

  it("treats identical notes as equal", () => {
    expect(sameEntry(note("a", 1, "h"), note("a", 1, "h"))).toBe(true);
  });

  it("never equates a folder with a note", () => {
    const folder: Entry = { kind: "folder", id: "a", name: "a" };
    expect(sameEntry(folder, note("a", 1))).toBe(false);
  });
});

describe("reconcile", () => {
  it("reports changed on a first fetch (no prev)", () => {
    const next = listing([note("a", 1)], 1);
    const r = reconcile(undefined, next);
    expect(r.changed).toBe(true);
    expect(r.listing).toBe(next);
  });

  // The listing WRAPPER's identity is load-bearing, not just its entries': the
  // library repaints when `listing !== result.listing`, so a fresh wrapper on
  // every revalidation repainted the gallery even when `changed` was false —
  // dropping keyboard focus and detaching cards mid-interaction.
  it("returns the SAME listing object when nothing changed, so callers can skip the repaint", () => {
    const prev = listing([note("a", 10), note("b", 20)], 1);
    const next = listing([note("a", 10), note("b", 20)], 1);
    const r = reconcile(prev, next);
    expect(r.changed).toBe(false);
    expect(r.listing).toBe(prev);
  });

  it("still returns a new listing when something did change", () => {
    const prev = listing([note("a", 10)], 1);
    const next = listing([note("a", 10)], 2);
    const r = reconcile(prev, next);
    expect(r.changed).toBe(true);
    expect(r.listing).not.toBe(prev);
  });

  it("reports unchanged and reuses entry identity for an identical refetch", () => {
    const prev = listing([note("a", 1, "h"), note("b", 2, "g")], 4);
    const next = listing([note("a", 1, "h"), note("b", 2, "g")], 4);
    const r = reconcile(prev, next);
    expect(r.changed).toBe(false);
    // Unchanged rows keep the previous object reference (stable identity).
    expect(r.listing.entries[0]).toBe(prev.entries[0]);
    expect(r.listing.entries[1]).toBe(prev.entries[1]);
  });

  it("reports changed when the sync-version advanced even if entries match", () => {
    const prev = listing([note("a", 1)], 4);
    const next = listing([note("a", 1)], 5);
    expect(reconcile(prev, next).changed).toBe(true);
  });

  it("reports changed and keeps only the unchanged row's identity on an edit", () => {
    const prev = listing([note("a", 1, "h"), note("b", 2, "g")], 4);
    const next = listing([note("a", 1, "h"), note("b", 9, "g2")], 5);
    const r = reconcile(prev, next);
    expect(r.changed).toBe(true);
    expect(r.listing.entries[0]).toBe(prev.entries[0]); // untouched
    expect(r.listing.entries[1]).toBe(next.entries[1]); // fresh copy
  });

  it("reports changed when entries are added or removed", () => {
    const prev = listing([note("a", 1)], 4);
    const next = listing([note("a", 1), note("b", 1)], 4);
    expect(reconcile(prev, next).changed).toBe(true);
  });
});
