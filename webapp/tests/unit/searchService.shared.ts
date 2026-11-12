// The search service's test seams: a fake wasm core, a loader that counts
// instantiations, and a sync over a fixed manifest and stored terms.

import type { CoreLoader, SearchCoreExports } from "../../src/search/indexEngine";
import type { IndexSync, SyncOutcome } from "../../src/search/indexSync";
import type { DocumentManifest, ManifestRow } from "../../src/search/manifestCodec";
import type { StoredTermsDocument, TermsStore } from "../../src/cache/termsStore";

// A fake core (the tokenizer is `indexEngine.test.ts`'s). Like `idx_query`, it returns
// the total regardless of `limit`, which caps only the retained rowids.
export function fakeCore(): SearchCoreExports {
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
    idx_errmsg_ptr: () => 0,
    idx_errmsg_len: () => 0,
  };
}

export function spyLoader(): { load: CoreLoader; loads: () => number } {
  let loads = 0;
  return {
    load: async () => {
      loads += 1;
      return fakeCore();
    },
    loads: () => loads,
  };
}

export const ALFA = "a".repeat(32);
export const BRAVO = "b".repeat(32);
export const CHARLIE = "c".repeat(32);

export const DOCS: StoredTermsDocument[] = [
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

export function row(md5: string, fileId: number, updatedAt: number): ManifestRow {
  return { md5, fileId, tier: "note", updatedAt, indexVersion: 3, derivation: "derived" };
}

export const LIVE: ManifestRow[] = [row(ALFA, 10, 1000), row(BRAVO, 20, 5000), row(CHARLIE, 30, 9000)];

export function manifest(rows: readonly ManifestRow[]): DocumentManifest {
  return { coverage: { notes: rows.length, unsearchable: 0 }, rows };
}

/** An `IndexSync` with stored rows; each `sync()` returns the manifest the test set. */
export interface FakeSyncOptions {
  docs?: StoredTermsDocument[];
  rows?: readonly ManifestRow[];
  available?: boolean;
}

export function fakeSync(opts: FakeSyncOptions = {}) {
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

