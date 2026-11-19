// Where the terms stream lands: one IndexedDB record per document, keyed by
// the record's own `(md5, index_version)`. No wasm on this path; the index is
// built on first search. Degrades to a no-op store; a partial loss self-heals
// because the next diff asks for whatever is missing. What doesn't fit the
// budget is the sync's to choose and drop (`search/termsBudget.ts`), never an
// eviction here: by age, it would let go a notebook to keep an old book.

import { budgetForQuota } from "./idb";
import { yieldOnVersionChange } from "./idbLife";
import type { TermsDocument, TermsPage } from "../search/termsStream";

export interface TermsKey {
  readonly md5: string;
  readonly indexVersion: number;
}

export interface StoredTermsDocument extends TermsDocument {
  /** Epoch ms, when the record was written. */
  readonly storedAt: number;
}

/** Per-document term rows; the engine never sees a manifest, bitmap or stream. */
export interface TermsStore {
  /** False means the silent no-op store. */
  readonly available: boolean;
  /** The left-hand side of the diff. */
  keys(): Promise<TermsKey[]>;
  /** What each held record weighs, in UTF-8 bytes, by `<md5>.<index_version>`. */
  sizes(): Promise<ReadonlyMap<string, number>>;
  /** The most the records may weigh together: the default, lowered to fit the quota; unbounded for the no-op store. */
  budget(): Promise<number>;
  get(md5: string, indexVersion: number): Promise<StoredTermsDocument | null>;
  all(): Promise<StoredTermsDocument[]>;
  /**
   * False when the write failed (the quota ran out, say): the budget is then
   * lowered to what the records weigh, for this tab, so the next plan asks
   * for no more than fits. The no-op store accepts every write.
   */
  put(doc: TermsDocument): Promise<boolean>;
  drop(keys: readonly TermsKey[]): Promise<void>;
  clear(): Promise<void>;
}

/** `<md5>.<index_version>`, the server's filename for the same fact. */
export function termsKeyOf(md5: string, indexVersion: number): string {
  return `${md5}.${indexVersion}`;
}

/**
 * One record per md5, highest `indexVersion`. Two generations can coexist
 * until clean-up runs, and the engine throws on a repeated md5.
 */
export function newestPerDocument(docs: readonly StoredTermsDocument[]): StoredTermsDocument[] {
  const best = new Map<string, StoredTermsDocument>();
  for (const doc of docs) {
    const seen = best.get(doc.md5);
    if (!seen || doc.indexVersion > seen.indexVersion) best.set(doc.md5, doc);
  }
  return [...best.values()];
}

export interface TermsStoreOptions {
  dbName?: string;
  budgetBytes?: number;
}

/** The search index's input, every searchable page's words. Cleared at sign-out (`forget.ts`). */
export const TERMS_DB = "sn-terms";
const DB_NAME = TERMS_DB;
const STORE = "terms";
const VERSION = 1;

/**
 * The search index built from these records takes about four times their
 * weight in memory (16 MB of terms: 83 MB; 40 MB: 164 MB) and rebuilds at
 * ~80 ms a MB on a laptop. 32 MB holds about twelve books the size of Les
 * Misérables, and keeps a phone's tab within reach.
 */
export const DEFAULT_TERMS_BUDGET = 32 * 1024 * 1024;

interface StoredRecord {
  key: string;
  md5: string;
  indexVersion: number;
  pageCount: number;
  pages: TermsPage[];
  size: number;
  storedAt: number;
}

function nullStore(): TermsStore {
  return {
    available: false,
    async keys() {
      return [];
    },
    async sizes() {
      return new Map();
    },
    // Nothing is kept, so nothing needs to fit.
    async budget() {
      return Number.POSITIVE_INFINITY;
    },
    async get() {
      return null;
    },
    async all() {
      return [];
    },
    // Accepted, and nothing kept: `available` already says so, and a refusal
    // would lower a budget that bounds nothing.
    async put() {
      return true;
    },
    async drop() {},
    async clear() {},
  };
}

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The record's weight in UTF-8 bytes: its terms, plus a little per page. */
export function weigh(doc: Pick<TermsDocument, "md5" | "pages">): number {
  let size = doc.md5.length + 24;
  for (const page of doc.pages) size += utf8Length(page.t) + 8;
  return size;
}

function record(doc: TermsDocument, storedAt: number): StoredRecord {
  return {
    key: termsKeyOf(doc.md5, doc.indexVersion),
    md5: doc.md5,
    indexVersion: doc.indexVersion,
    pageCount: doc.pageCount,
    pages: [...doc.pages],
    size: weigh(doc),
    storedAt,
  };
}

function stored(rec: StoredRecord): StoredTermsDocument {
  return {
    md5: rec.md5,
    indexVersion: rec.indexVersion,
    pageCount: rec.pageCount,
    pages: rec.pages,
    storedAt: rec.storedAt,
  };
}

/** Never throws: any failure yields the no-op store. */
export function openTermsStore(opts: TermsStoreOptions = {}): TermsStore {
  if (!idbAvailable()) return nullStore();

  const desired = opts.budgetBytes ?? DEFAULT_TERMS_BUDGET;
  /** Each record's weight by key: the diff and the budget read it on every sync. */
  const sizes = new Map<string, number>();
  let budget = desired;

  const dbPromise: Promise<IDBDatabase | null> = (async () => {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(opts.dbName ?? DB_NAME, VERSION);
        open.onupgradeneeded = () => {
          const d = open.result;
          if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "key" });
        };
        open.onsuccess = () => resolve(yieldOnVersionChange(open.result));
        open.onerror = () => reject(open.error);
      });
      await seedSizes(db);
      try {
        const nav = typeof navigator !== "undefined" ? navigator : undefined;
        if (nav?.storage?.estimate) {
          const est = await nav.storage.estimate();
          let ours = 0;
          for (const size of sizes.values()) ours += size;
          budget = budgetForQuota(est, desired, ours);
        }
      } catch {
        budget = desired;
      }
      return db;
    } catch {
      return null;
    }
  })();

  async function seedSizes(db: IDBDatabase): Promise<void> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const cursorReq = tx.objectStore(STORE).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          const rec = cursor.value as StoredRecord;
          // Weighed again, not read from `size`: a record written before the
          // budget counted UTF-8 bytes carries its weight in UTF-16 units.
          sizes.set(rec.key, weigh(rec));
          cursor.continue();
        };
        cursorReq.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async function withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T | undefined> {
    const db = await dbPromise;
    if (!db) return undefined;
    try {
      const tx = db.transaction(STORE, mode);
      return await fn(tx.objectStore(STORE));
    } catch {
      return undefined;
    }
  }

  return {
    available: true,

    async keys() {
      // From the in-memory sizes: the diff runs on every sync.
      await dbPromise;
      const out: TermsKey[] = [];
      for (const key of sizes.keys()) {
        const dot = key.lastIndexOf(".");
        const version = Number.parseInt(key.slice(dot + 1), 10);
        if (dot > 0 && Number.isInteger(version)) out.push({ md5: key.slice(0, dot), indexVersion: version });
      }
      return out;
    },

    async sizes() {
      await dbPromise;
      const out = new Map<string, number>();
      for (const [key, size] of sizes) out.set(key, size);
      return out;
    },

    async budget() {
      await dbPromise;
      return budget;
    },

    async get(md5, indexVersion) {
      const rec = await withStore("readonly", (store) =>
        promisify<StoredRecord | undefined>(store.get(termsKeyOf(md5, indexVersion))),
      );
      return rec ? stored(rec) : null;
    },

    async all() {
      const recs = await withStore("readonly", (store) => promisify<StoredRecord[]>(store.getAll()));
      return newestPerDocument((recs ?? []).map(stored));
    },

    async put(doc) {
      const rec = record(doc, Date.now());
      const ok = await withStore("readwrite", (store) => promisify(store.put(rec)));
      if (ok === undefined) {
        let held = 0;
        for (const size of sizes.values()) held += size;
        budget = Math.min(budget, held);
        return false;
      }
      sizes.set(rec.key, rec.size);
      return true;
    },

    async drop(keys) {
      if (keys.length === 0) return;
      await withStore("readwrite", async (store) => {
        for (const { md5, indexVersion } of keys) {
          const key = termsKeyOf(md5, indexVersion);
          await promisify(store.delete(key));
          sizes.delete(key);
        }
      });
    },

    async clear() {
      sizes.clear();
      await withStore("readwrite", (store) => promisify(store.clear()));
    },
  };
}
