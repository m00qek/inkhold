// Where the terms stream lands: one IndexedDB record per document, keyed by
// the record's own `(md5, index_version)`. No wasm on this path; the index is
// built on first search. Degrades to a no-op store; a partial loss self-heals
// because the next diff asks for whatever is missing.

import { budgetForQuota, planEviction, type PersistedMeta } from "./idb";
import type { TermsDocument, TermsPage } from "../search/termsStream";

export interface TermsKey {
  readonly md5: string;
  readonly indexVersion: number;
}

export interface StoredTermsDocument extends TermsDocument {
  /** Epoch ms; the eviction key. */
  readonly storedAt: number;
}

/** Per-document term rows; the engine never sees a manifest, bitmap or stream. */
export interface TermsStore {
  /** False means the silent no-op store. */
  readonly available: boolean;
  /** The left-hand side of the diff. */
  keys(): Promise<TermsKey[]>;
  get(md5: string, indexVersion: number): Promise<StoredTermsDocument | null>;
  all(): Promise<StoredTermsDocument[]>;
  put(doc: TermsDocument): Promise<void>;
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

const DB_NAME = "sn-terms";
const STORE = "terms";
const VERSION = 1;

/**
 * A backstop, an order of magnitude above a real library. Eviction is not
 * free: the diff refetches whatever is missing, every sync.
 */
const DEFAULT_BUDGET = 16 * 1024 * 1024;

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
    async get() {
      return null;
    },
    async all() {
      return [];
    },
    async put() {},
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

/** Approximate weight in UTF-16 units; only compared against a generous cap. */
function weigh(doc: TermsDocument): number {
  let size = doc.md5.length + 24;
  for (const page of doc.pages) size += page.t.length + 8;
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

  const desired = opts.budgetBytes ?? DEFAULT_BUDGET;
  const metas = new Map<string, PersistedMeta>();
  let budget = desired;

  const dbPromise: Promise<IDBDatabase | null> = (async () => {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(opts.dbName ?? DB_NAME, VERSION);
        open.onupgradeneeded = () => {
          const d = open.result;
          if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "key" });
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await seedMetas(db);
      try {
        const nav = typeof navigator !== "undefined" ? navigator : undefined;
        if (nav?.storage?.estimate) {
          const est = await nav.storage.estimate();
          let ours = 0;
          for (const m of metas.values()) ours += m.size;
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

  async function seedMetas(db: IDBDatabase): Promise<void> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const cursorReq = tx.objectStore(STORE).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          const rec = cursor.value as StoredRecord;
          // `storedAt` is the LRU key: the build reads every record at once.
          metas.set(rec.key, { key: rec.key, size: rec.size, lastAccess: rec.storedAt });
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
      // From the meta mirror: the diff runs on every sync.
      await dbPromise;
      const out: TermsKey[] = [];
      for (const key of metas.keys()) {
        const dot = key.lastIndexOf(".");
        const version = Number.parseInt(key.slice(dot + 1), 10);
        if (dot > 0 && Number.isInteger(version)) out.push({ md5: key.slice(0, dot), indexVersion: version });
      }
      return out;
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
      if (ok === undefined) return;
      metas.set(rec.key, { key: rec.key, size: rec.size, lastAccess: rec.storedAt });

      const toEvict = planEviction([...metas.values()], budget);
      if (toEvict.length === 0) return;
      await withStore("readwrite", async (store) => {
        for (const k of toEvict) {
          await promisify(store.delete(k));
          metas.delete(k);
        }
      });
    },

    async drop(keys) {
      if (keys.length === 0) return;
      await withStore("readwrite", async (store) => {
        for (const { md5, indexVersion } of keys) {
          const key = termsKeyOf(md5, indexVersion);
          await promisify(store.delete(key));
          metas.delete(key);
        }
      });
    },

    async clear() {
      metas.clear();
      await withStore("readwrite", (store) => promisify(store.clear()));
    },
  };
}
