import { describe, it, expect } from "vitest";
import { createFakeApi } from "../../src/api/fake";
import type { Api } from "../../src/api/types";
import type { SearchHit, SearchResults } from "../../src/core/types";

// The fake's cursor paging IS the frozen contract the UI is built against until
// the real keyset endpoint lands: pages of ≤20 hits, an opaque cursor present
// exactly while more hits remain, NO total ever, and — the property everything
// else leans on — DETERMINISM: the same (query, cursor) always answers the same
// slice, so an e2e can walk pages and a user can click "More" after any delay
// and still get the continuation of the list they were reading.
//
// "endor" is the broad query: the fixture plants "the witches of Endor" on the
// odd pages of every recognised transcript, which adds up to more matching
// pages than one 20-hit window across the household tree — no seeding needed.

const fake = (): Api => createFakeApi({ latencyMs: 0 });

/** A hit's identity — the pair the UI deep-links by. */
const key = (h: SearchHit): string => `${h.noteId}:${h.pageIndex}`;

/** Walk the cursor to exhaustion, returning every page in order. */
async function walk(api: Api, q: string): Promise<SearchResults[]> {
  const pages: SearchResults[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.searchText(q, 20, cursor);
    pages.push(page);
    cursor = page.cursor;
    // A runaway loop here would mean the fake mints cursors forever — fail
    // loudly instead of hanging the suite.
    expect(pages.length).toBeLessThan(50);
  } while (cursor !== undefined);
  return pages;
}

describe("fake search paging", () => {
  it("a broad query answers exactly one page (≤20) plus a cursor", async () => {
    const first = await fake().searchText("endor", 20);
    expect(first.hits).toHaveLength(20);
    expect(first.cursor).toBeDefined();
    expect(typeof first.cursor).toBe("string");
    // The contract's negative space: nothing on the response counts the rest.
    expect("total" in first).toBe(false);
  });

  it("walking the cursor enumerates the whole stream once, with no repeats", async () => {
    const pages = await walk(fake(), "endor");

    expect(pages.length).toBeGreaterThan(1); // it genuinely paged
    for (const page of pages) expect(page.hits.length).toBeLessThanOrEqual(20);
    // Every page but the last carries a cursor; the last carries none — absence
    // is the one end-of-results signal there is.
    for (const page of pages.slice(0, -1)) expect(page.cursor).toBeDefined();
    expect(pages[pages.length - 1]!.cursor).toBeUndefined();

    const all = pages.flatMap((p) => p.hits);
    expect(all.length).toBeGreaterThan(20);
    // No hit is served twice and none is dropped between pages.
    expect(new Set(all.map(key)).size).toBe(all.length);
  });

  it("is deterministic: the same cursor answers the same page, across instances too", async () => {
    const a = fake();
    const first = await a.searchText("endor", 20);
    const again = await a.searchText("endor", 20, first.cursor);
    const once = await a.searchText("endor", 20, first.cursor);
    expect(again.hits).toEqual(once.hits);
    expect(again.cursor).toEqual(once.cursor);

    // A fresh instance (a page reload, a second e2e worker) walks the same
    // stream — the paging is a function of the fixture, not of call history.
    const other = await fake().searchText("endor", 20, first.cursor);
    expect(other.hits).toEqual(again.hits);
  });

  it("a query under the cap answers complete, with no cursor", async () => {
    const r = await fake().searchText("aurora", 20);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.length).toBeLessThan(20);
    expect(r.cursor).toBeUndefined();
  });

  it("clamps every page at 20, whatever limit asks for", async () => {
    const r = await fake().searchText("endor", 50);
    expect(r.hits).toHaveLength(20);
    expect(r.cursor).toBeDefined();
  });

  it("keeps usedFuzzy consistent across a paged walk", async () => {
    // "endors" matches nothing exactly; the widened pass ("endor") is broad
    // enough to page. Which phase answered is a function of the QUERY, so every
    // page of one walk must report the same flag — a notice that flipped
    // between pages would be describing the transport, not the results.
    const pages = await walk(fake(), "endors");
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.usedFuzzy).toBe(true);
  });

  it("keeps coverage a zero-hit-only field — never on a later page", async () => {
    const api = fake();
    const none = await api.searchText("zzzznotawordanywhere");
    expect(none.hits).toHaveLength(0);
    expect(none.coverage).not.toBeNull();
    expect(none.cursor).toBeUndefined();

    for (const page of await walk(api, "endor")) expect(page.coverage).toBeNull();
  });

  it("the paged union equals what the stream holds for a mid-size query", async () => {
    // "page 4" hits exactly one page per note that has a recognised 4th page —
    // small enough to fit one window, so paging must not change its answer.
    const api = fake();
    const [only] = await walk(api, "page 4");
    expect(only!.cursor).toBeUndefined();
    const again = await api.searchText("page 4", 20);
    expect(again.hits).toEqual(only!.hits);
  });
});
