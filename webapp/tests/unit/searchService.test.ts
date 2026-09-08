import { describe, expect, it, vi } from "vitest";
import { createIndexSearch } from "../../src/search/indexSearch";
import { createSearchService } from "../../src/search/searchService";
import type { CoreLoader, SearchCoreExports } from "../../src/search/indexEngine";
import type { IndexSync, SyncOutcome } from "../../src/search/indexSync";
import type { DocumentManifest, ManifestRow } from "../../src/search/manifestCodec";
import type { StoredTermsDocument, TermsStore } from "../../src/cache/termsStore";
import type { LiveChannel } from "../../src/sync/types";

// A FAKE core, not `sqlite-core.wasm`, and the distinction is the point of the
// layer under test: `indexEngine.test.ts` already pins FTS5's tokenizer against
// the real artifact, because folding parity is what putting SQLite in the
// browser is FOR. Nothing here is about matching — it is about which documents
// survive the manifest join, how pages group, what order rows come out in, and
// whether the engine was woken up at all. A fake makes the last of those
// observable (`loads`) and the rest deterministic.
//
// It matches the way `idx_query` really behaves in the two ways that matter: the
// return is the TOTAL and independent of `limit`, and `limit` caps only the
// retained rowids.
function fakeCore(): SearchCoreExports {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const decoder = new TextDecoder();
  const rows = new Map<number, string>();
  let hits: number[] = [];
  let brk = 1024;

  const read = (ptr: number, len: number) => decoder.decode(new Uint8Array(memory.buffer, ptr, len));

  const run = (ptr: number, len: number, limit: number) => {
    const terms = read(ptr, len).toLowerCase().split(/\s+/).filter(Boolean);
    hits = [];
    if (terms.length === 0) return 0;
    let total = 0;
    for (const [rowid, text] of rows) {
      const words = text.split(/\s+/);
      if (!terms.every((t) => words.includes(t))) continue;
      if (hits.length < limit) hits.push(rowid);
      total += 1;
    }
    return total;
  };

  return {
    memory,
    idx_alloc(len) {
      const ptr = brk;
      brk += len;
      const short = brk - memory.buffer.byteLength;
      if (short > 0) memory.grow(Math.ceil(short / 65536));
      return ptr;
    },
    idx_free() {},
    idx_schema_version: () => 1,
    idx_open() {
      rows.clear();
      hits = [];
      return 0;
    },
    idx_close() {},
    idx_begin: () => 0,
    idx_commit: () => 0,
    idx_add(rowid, ptr, len) {
      rows.set(rowid, read(ptr, len));
      return 0;
    },
    idx_query: run,
    // The ladder is a MATCHING question, so it is deliberately absent here — the
    // real one is asserted against the real artifact in `sqlite_core_abi.mjs`
    // and `indexFuzzy.test.ts`. What this has to reproduce is the ABI: a fuzzy
    // call answers a matching query exactly as `idx_query` does, and substitutes
    // nothing, which is the only behaviour the join and grouping below can see.
    idx_fuzzy: run,
    idx_expansion_ptr: () => 0,
    idx_expansion_len: () => 0,
    idx_hit: (i) => (i < hits.length ? hits[i]! : -1),
    idx_serialize: () => 0,
    idx_image_ptr: () => 0,
    idx_image_alloc: () => 0,
    idx_deserialize: () => 0,
    idx_errmsg_ptr: () => 0,
    idx_errmsg_len: () => 0,
  };
}

function spyLoader(): { load: CoreLoader; loads: () => number } {
  let loads = 0;
  return {
    load: async () => {
      loads += 1;
      return fakeCore();
    },
    loads: () => loads,
  };
}

// Three documents. `alfa` matches on three pages, `bravo` on one, `charlie` on
// two — and `charlie` is the one the manifest will stop naming.
const ALFA = "a".repeat(32);
const BRAVO = "b".repeat(32);
const CHARLIE = "c".repeat(32);

const DOCS: StoredTermsDocument[] = [
  {
    md5: ALFA,
    indexVersion: 3,
    pageCount: 12,
    // Sparse and out of order, as a real record is: only pages with text get a
    // row, and the row that matches first in rank order is page 11.
    pages: [
      { p: 11, t: "reuniao projeto" },
      { p: 0, t: "reuniao orcamento" },
      { p: 4, t: "reuniao acta" },
      { p: 7, t: "orcamento" },
    ],
    storedAt: 1,
  },
  { md5: BRAVO, indexVersion: 3, pageCount: 2, pages: [{ p: 1, t: "reuniao" }], storedAt: 1 },
  {
    md5: CHARLIE,
    indexVersion: 3,
    pageCount: 5,
    pages: [
      { p: 0, t: "reuniao" },
      { p: 2, t: "reuniao" },
    ],
    storedAt: 1,
  },
];

function row(md5: string, fileId: number, updatedAt: number): ManifestRow {
  return { md5, fileId, tier: "note", updatedAt, indexVersion: 3, derivation: "derived" };
}

const LIVE: ManifestRow[] = [row(ALFA, 10, 1000), row(BRAVO, 20, 5000), row(CHARLIE, 30, 9000)];

function manifest(rows: readonly ManifestRow[]): DocumentManifest {
  return { coverage: { notes: rows.length, unsearchable: 0 }, rows };
}

/** An `IndexSync` with no transport behind it: the rows are already stored, and
 *  each `sync()` hands back whichever manifest the test set. */
interface FakeSyncOptions {
  docs?: StoredTermsDocument[];
  rows?: readonly ManifestRow[];
  available?: boolean;
}

function fakeSync(opts: FakeSyncOptions = {}) {
  const state = {
    docs: opts.docs ?? DOCS,
    rows: opts.rows ?? LIVE,
    received: opts.docs?.length ?? DOCS.length,
    syncs: 0,
    /** Set before a call to make THAT call block; `gate` then releases it. */
    hold: false,
    gate: null as null | (() => void),
  };
  const store = { available: opts.available ?? true } as TermsStore;
  const sync: IndexSync = {
    store,
    async documents() {
      return state.docs;
    },
    async sync(): Promise<SyncOutcome> {
      state.syncs += 1;
      if (state.hold) {
        state.hold = false;
        await new Promise<void>((resolve) => (state.gate = resolve));
      }
      return {
        manifest: manifest(state.rows),
        etag: "etag-1",
        requested: state.received,
        received: state.received,
        skipped: 0,
        dropped: 0,
        persisted: store.available,
      };
    },
  };
  return { sync, state };
}

describe("createIndexSearch", () => {
  it("does not instantiate the engine until the first query", async () => {
    const { load, loads } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });

    // Construction, sync, and the readiness the UI polls: all of it must stay on
    // the side of §4.2 where the 16.13 MB has not been allocated.
    expect(loads()).toBe(0);
    await local.sync();
    expect(local.ready).toBe(true);
    expect(loads()).toBe(0);

    await local.search("reuniao");
    expect(loads()).toBe(1);
  });

  it("builds once and reuses the instance across searches", async () => {
    const { load, loads } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();

    await local.search("reuniao");
    await local.search("orcamento");
    expect(loads()).toBe(1);
  });

  it("groups pages by document, joins the manifest, and ranks by match count then recency", async () => {
    const { load } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();

    const results = await local.search("reuniao");
    expect(results.query).toBe("reuniao");
    // 3 + 2 + 1 pages, all of them counted, none of them capped.
    expect(results.totalPages).toBe(6);
    expect(results.documents.map((d) => d.md5)).toEqual([ALFA, CHARLIE, BRAVO]);
    // Ascending, because the row deep-links to the FIRST matching page — first
    // in the document, not first in the ranking.
    expect(results.documents[0]).toEqual({ md5: ALFA, fileId: 10, pages: [0, 4, 11], updatedAt: 1000 });
    expect(results.documents[2]).toEqual({ md5: BRAVO, fileId: 20, pages: [1], updatedAt: 5000 });
  });

  it("breaks a tie on match count by recency", async () => {
    const { load } = spyLoader();
    // BRAVO and CHARLIE both match `acta` on exactly one page; CHARLIE is newer.
    const docs: StoredTermsDocument[] = [
      { md5: BRAVO, indexVersion: 3, pageCount: 1, pages: [{ p: 0, t: "acta" }], storedAt: 1 },
      { md5: CHARLIE, indexVersion: 3, pageCount: 1, pages: [{ p: 0, t: "acta" }], storedAt: 1 },
    ];
    const { sync } = fakeSync({ docs });
    const local = createIndexSearch({ sync, load });
    await local.sync();

    const results = await local.search("acta");
    expect(results.documents.map((d) => d.md5)).toEqual([CHARLIE, BRAVO]);
  });

  it("never returns a document the manifest has stopped naming", async () => {
    const { load } = spyLoader();
    const { sync, state } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    expect((await local.search("reuniao")).documents.map((d) => d.md5)).toContain(CHARLIE);

    // CHARLIE is trashed. Nothing dropped its rows — §2.7 says clean-up rides
    // the blob GC and is not a protocol step — so it is still in the built index
    // and must still not come back.
    state.rows = LIVE.filter((r) => r.md5 !== CHARLIE);
    state.received = 0;
    await local.sync();

    const results = await local.search("reuniao");
    expect(results.documents.map((d) => d.md5)).toEqual([ALFA, BRAVO]);
    // And the count follows the rows: CHARLIE's two pages are in neither.
    expect(results.totalPages).toBe(4);
  });

  it("rebuilds when a sync brought rows, and not when it only dropped some", async () => {
    const { load, loads } = spyLoader();
    const { sync, state } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    expect((await local.search("reuniao")).documents).toHaveLength(3);

    // A sync that received nothing: the built index is still right, and a 703 ms
    // rebuild would buy nothing.
    state.received = 0;
    await local.sync();
    await local.search("reuniao");

    // A sync that received something: the new document has to appear, and on the
    // SAME instance (§4.1's `reset`), so the loader is still called once.
    const delta = "d".repeat(32);
    state.docs = [
      ...DOCS,
      { md5: delta, indexVersion: 1, pageCount: 1, pages: [{ p: 0, t: "reuniao" }], storedAt: 1 },
    ];
    state.rows = [...LIVE, row(delta, 40, 200)];
    state.received = 1;
    await local.sync();

    expect((await local.search("reuniao")).documents).toHaveLength(4);
    expect(loads()).toBe(1);
  });

  it("is not ready before the first sync, or where IndexedDB is absent", async () => {
    const { load } = spyLoader();
    const fresh = createIndexSearch({ sync: fakeSync().sync, load });
    expect(fresh.ready).toBe(false);

    const degraded = createIndexSearch({ sync: fakeSync({ available: false }).sync, load });
    await degraded.sync();
    // The manifest arrived; the store is a no-op, so every build is empty and a
    // confident "no results" would be a lie.
    expect(degraded.ready).toBe(false);
  });

  // §4.4's "global search is fully offline", and step 6 is what made it
  // load-bearing: the fallback used to answer whenever this path raised, so a
  // guard that was stricter than `ready` cost a round trip instead of a screen.
  // There is nothing behind it now, so the two have to agree.
  it("answers a session that never synced, from the cached listing alone", async () => {
    const { load } = spyLoader();
    const { sync } = fakeSync();
    const listing = () => [
      { md5: ALFA, fileId: 10, updatedAt: 1000 },
      { md5: BRAVO, fileId: 20, updatedAt: 5000 },
    ];
    const local = createIndexSearch({ sync, load, listing });

    expect(local.ready).toBe(true);
    const results = await local.search("reuniao");
    // CHARLIE is in the store but not in the listing, so it is not in the
    // answer: the listing is the intersection, exactly as the manifest is.
    expect(results.documents.map((d) => d.md5)).toEqual([ALFA, BRAVO]);
    expect(results.totalPages).toBe(4);
  });

  it("raises when there is neither a manifest nor a listing to intersect with", async () => {
    const { load } = spyLoader();
    const local = createIndexSearch({ sync: fakeSync().sync, load });
    expect(local.ready).toBe(false);
    // NOT an empty answer: nothing is behind this to try, so a confident "no
    // matches" would be the lie the error state exists to avoid.
    await expect(local.search("reuniao")).rejects.toThrow();
  });

  it("raises rather than answering when the search was superseded mid-build", async () => {
    const { load } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();

    const controller = new AbortController();
    const pending = local.search("reuniao", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ---------------------------------------------------------------------------

describe("createSearchService", () => {
  it("coalesces a burst of triggers into one sync", async () => {
    vi.useFakeTimers();
    try {
      const { sync, state } = fakeSync();
      const { load } = spyLoader();
      const service = createSearchService({ sync, load });

      // A device pushing 100 notes: `event: sync` and `event: index` frames, one
      // after another, all inside the window.
      for (let i = 0; i < 100; i += 1) service.refresh();
      expect(state.syncs).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(state.syncs).toBe(1);

      // The window is over, so the next burst gets its own.
      service.refresh();
      await vi.advanceTimersByTimeAsync(2000);
      expect(state.syncs).toBe(2);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues exactly one re-run for triggers that arrive during a sync", async () => {
    const { sync, state } = fakeSync();
    const { load } = spyLoader();
    const service = createSearchService({ sync, load, coalesceMs: 0 });

    // Hold the first sync open. The frames arriving now describe documents the
    // manifest it already fetched cannot contain, so joining it would answer
    // with a result that provably misses them.
    state.hold = true;
    const first = service.syncNow();
    await Promise.resolve();
    for (let i = 0; i < 10; i += 1) service.refresh();
    state.gate?.();
    await first;
    // Let the queued re-run start and finish.
    await new Promise((r) => setTimeout(r, 0));
    expect(state.syncs).toBe(2);
    service.dispose();
  });

  it("swallows a failed sync, and then cannot answer — there is nothing behind it", async () => {
    const { load } = spyLoader();
    const failing: IndexSync = {
      store: { available: true } as TermsStore,
      async documents() {
        return [];
      },
      async sync() {
        throw new Error("offline");
      },
    };
    const service = createSearchService({ sync: failing, load, coalesceMs: 0 });

    // Never rejects: a background sync failure belongs to the next trigger, not
    // to whoever happens to be typing.
    await expect(service.syncNow()).resolves.toBeUndefined();
    expect(service.ready).toBe(false);
    // THE USER-VISIBLE BOUNDARY §6 step 6 draws. There is no `searchText` left
    // to reach for, so the query RAISES and the box paints "couldn't search" —
    // never a quiet round trip, and never a confident "no matches".
    await expect(service.search("reuniao")).rejects.toThrow();
    service.dispose();
  });

  it("answers locally once a sync has landed", async () => {
    const { sync } = fakeSync();
    const { load, loads } = spyLoader();
    const service = createSearchService({ sync, load, coalesceMs: 0 });

    await service.syncNow();
    expect(loads()).toBe(0);
    const results = await service.search("reuniao");
    expect(results.documents).toHaveLength(3);
    service.dispose();
  });

  it("subscribes both of §3.3's triggers to the one connection", async () => {
    vi.useFakeTimers();
    try {
      const { sync, state } = fakeSync();
      const { load } = spyLoader();
      const service = createSearchService({ sync, load });

      let onBump: ((v: number) => void) | undefined;
      let onIndex: ((s: { pending: number; version: number }) => void) | undefined;
      let subscriptions = 0;
      let closed = 0;
      const live: LiveChannel = {
        subscribe(bump, index) {
          subscriptions += 1;
          onBump = bump;
          onIndex = index;
          return () => {
            closed += 1;
          };
        },
      };

      const off = service.attachLive(live);
      // ONE subscription: a held stream costs one of four per-user slots on the
      // server, so the second trigger may not open a second socket.
      expect(subscriptions).toBe(1);

      onBump?.(7);
      onIndex?.({ pending: 3, version: 2 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(state.syncs).toBe(1);

      off();
      expect(closed).toBe(1);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
