import { describe, expect, it, vi } from "vitest";
import { createIndexSearch } from "../../src/search/indexSearch";
import { createSearchService } from "../../src/search/searchService";
import type { CoreLoader, SearchCoreExports } from "../../src/search/indexEngine";
import type { IndexSync, SyncOutcome } from "../../src/search/indexSync";
import type { DocumentManifest, ManifestRow } from "../../src/search/manifestCodec";
import type { StoredTermsDocument, TermsStore } from "../../src/cache/termsStore";
import type { LiveChannel } from "../../src/sync/types";

// A fake core (the tokenizer is `indexEngine.test.ts`'s). Like `idx_query`, it returns
// the total regardless of `limit`, which caps only the retained rowids.
function fakeCore(): SearchCoreExports {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const decoder = new TextDecoder();
  const rows = new Map<number, string>();
  let hits: number[] = [];
  let totals: number[] = [];
  let brk = 1024;

  const read = (ptr: number, len: number) => decoder.decode(new Uint8Array(memory.buffer, ptr, len));

  const run = (ptr: number, len: number, limit: number) => {
    const terms = read(ptr, len).toLowerCase().split(/\s+/).filter(Boolean);
    hits = [];
    totals = [];
    if (terms.length === 0) return 0;
    let total = 0;
    for (const [rowid, text] of rows) {
      const words = text.split(/\s+/);
      if (!terms.every((t) => words.includes(t))) continue;
      const kind = Math.floor(rowid / 2 ** 28);
      if (hits.filter((h) => Math.floor(h / 2 ** 28) === kind).length < limit) hits.push(rowid);
      totals[kind] = (totals[kind] ?? 0) + 1;
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
    idx_fuzzy: run,
    idx_expansion_ptr: () => 0,
    idx_expansion_len: () => 0,
    idx_hit: (i) => (i < hits.length ? hits[i]! : -1),
    idx_kind_total: (k) => totals[k] ?? 0,
    idx_delete(rowid) {
      rows.delete(rowid);
      return 0;
    },
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

const ALFA = "a".repeat(32);
const BRAVO = "b".repeat(32);
const CHARLIE = "c".repeat(32);

const DOCS: StoredTermsDocument[] = [
  {
    md5: ALFA,
    indexVersion: 3,
    pageCount: 12,
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

/** An `IndexSync` with stored rows; each `sync()` returns the manifest the test set. */
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

    // Nothing here may allocate the 16.13 MB engine.
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

  it("finds item rows set before the engine exists, and their replacements at once", async () => {
    const { load, loads } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    local.setItems("todo", [{ key: "t1", text: "comprar reuniao" }]);

    const first = await local.search("comprar");
    expect(first.items).toEqual({ name: [], todo: ["t1"], digest: [] });
    expect(first.documents).toEqual([]);

    local.setItems("todo", [{ key: "t2", text: "vender reuniao" }]);
    expect((await local.search("comprar")).items.todo).toEqual([]);
    expect((await local.search("vender")).items.todo).toEqual(["t2"]);
    expect(loads()).toBe(1);
  });

  it("keeps an item change that lands while the first build is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load: async () => (await gate, fakeCore()) });
    await local.sync();
    local.setItems("todo", [{ key: "t1", text: "old title" }]);
    const first = local.search("old");
    await new Promise((r) => setTimeout(r, 0));
    local.setItems("todo", [{ key: "t1", text: "new title" }]);
    release();
    await first;
    expect((await local.search("new")).items.todo).toEqual(["t1"]);
    expect((await local.search("old")).items.todo).toEqual([]);
  });

  it("writes the items again into an engine made after a drop", async () => {
    const { load } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    local.setItems("digest", [{ key: "d1", text: "baleia branca" }]);
    await local.search("baleia");
    local.drop();
    expect((await local.search("baleia")).items.digest).toEqual(["d1"]);
  });

  it("groups pages by document, joins the manifest, and ranks by how much of each matched", async () => {
    const { load } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();

    const results = await local.search("reuniao");
    expect(results.query).toBe("reuniao");
    expect(results.totalPages).toBe(6);
    // 2 of 5 pages, then 1 of 2, then 3 of 12: density, not the count of pages.
    expect(results.documents.map((d) => d.md5)).toEqual([CHARLIE, BRAVO, ALFA]);
    // Ascending: the row deep-links to the first matching page in the document.
    expect(results.documents[2]).toEqual({ md5: ALFA, fileId: 10, pages: [0, 4, 11], updatedAt: 1000, tier: "note", pageCount: 12 });
    expect(results.documents[1]).toEqual({ md5: BRAVO, fileId: 20, pages: [1], updatedAt: 5000, tier: "note", pageCount: 2 });
  });

  it("breaks a tie on match count by recency", async () => {
    const { load } = spyLoader();
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

    // Trashed: its rows stay in the index (clean-up rides blob GC), but must not return.
    state.rows = LIVE.filter((r) => r.md5 !== CHARLIE);
    state.received = 0;
    await local.sync();

    const results = await local.search("reuniao");
    expect(results.documents.map((d) => d.md5)).toEqual([BRAVO, ALFA]);
    expect(results.totalPages).toBe(4);
  });

  it("rebuilds when a sync brought rows, and not when it only dropped some", async () => {
    const { load, loads } = spyLoader();
    const { sync, state } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    expect((await local.search("reuniao")).documents).toHaveLength(3);

    state.received = 0;
    await local.sync();
    await local.search("reuniao");

    // On the same instance (`reset`), so the loader is still called once.
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
    expect(degraded.ready).toBe(false);
  });

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
    expect(results.documents.map((d) => d.md5)).toEqual([BRAVO, ALFA]);
    // Offline: no manifest, so no tier; nothing is penalised for it.
    expect(results.documents.every((d) => d.tier === null)).toBe(true);
    expect(results.totalPages).toBe(4);
  });

  it("raises when there is neither a manifest nor a listing to intersect with", async () => {
    const { load } = spyLoader();
    const local = createIndexSearch({ sync: fakeSync().sync, load });
    expect(local.ready).toBe(false);
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

      for (let i = 0; i < 100; i += 1) service.refresh();
      expect(state.syncs).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(state.syncs).toBe(1);

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

    // Hold the first sync open; frames now describe documents its manifest lacks.
    state.hold = true;
    const first = service.syncNow();
    await Promise.resolve();
    for (let i = 0; i < 10; i += 1) service.refresh();
    state.gate?.();
    await first;
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

    await expect(service.syncNow()).resolves.toBeUndefined();
    expect(service.ready).toBe(false);
    // No server fallback: the query raises, never a quiet "no matches".
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
      // One subscription: the server allows four held streams per user.
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
