// Where the terms stream lands: one IndexedDB record per document, keyed by
// `(md5, index_version)` — `golden-search.md` §4.2.
//
// What this must not break:
//   * No wasm on this path. Sync writes rows and nothing else; the FTS index
//     is built on first search (39 ms at tier 1). Instantiating the engine at
//     sync time would bill every member who only browses 17.4 MB of linear
//     memory, so this module imports nothing that can reach `sqlite-core.wasm`.
//   * The md5 alone is HALF a key: a blob with a stale index row reports
//     `derived` while genuinely underived (`manifestCodec.ts`), and only a
//     client keyed on both halves refetches. The key is taken from the
//     RECORD's own `v` (§3.3: key what ARRIVED), never the manifest's.
//   * Never a source of truth: no IndexedDB, an open failure or a throwing
//     transaction degrade to a silent no-op store, and a partial loss is
//     self-healing because the diff asks for whatever is not held.

import { budgetForQuota, planEviction, type PersistedMeta } from "./idb";
import type { TermsDocument, TermsPage } from "../search/termsStream";

/** The identity of one stored record: the two halves of the cache key. */
export interface TermsKey {
  readonly md5: string;
  readonly indexVersion: number;
}

/** A stored terms record — the wire record plus when it landed. */
export interface StoredTermsDocument extends TermsDocument {
  /** Epoch ms. The eviction ordering key, and nothing else reads it. */
  readonly storedAt: number;
}

/**
 * The per-document term rows — the seam the engine consumes. It says nothing
 * about where the rows came from: the engine never sees a manifest, a bitmap
 * or a stream.
 */
export interface TermsStore {
  /** Whether a real backing store is available (false = silent no-op store). */
  readonly available: boolean;
  /** Every `(md5, indexVersion)` held. This is the left-hand side of the diff. */
  keys(): Promise<TermsKey[]>;
  /** One document's rows, or null. */
  get(md5: string, indexVersion: number): Promise<StoredTermsDocument | null>;
  /** Every document held, for the index build. */
  all(): Promise<StoredTermsDocument[]>;
  put(doc: TermsDocument): Promise<void>;
  drop(keys: readonly TermsKey[]): Promise<void>;
  clear(): Promise<void>;
}

/** The primary key — `<md5>.<index_version>`, the server's own filename for
 *  the same fact (`data/terms/<md5>.<index_version>`). */
export function termsKeyOf(md5: string, indexVersion: number): string {
  return `${md5}.${indexVersion}`;
}

/**
 * One record per md5, keeping the highest `indexVersion`.
 *
 * The store is keyed `(md5, indexVersion)`, so TWO GENERATIONS OF ONE DOCUMENT
 * CAN COEXIST — dropping the older is clean-up nobody waits for. Fine for
 * storage, fatal for the build: the engine refuses a repeated md5 (it would
 * double the match counts results are ranked by), so a drop that has not run
 * yet would turn an extractor-version bump into a search that throws. The
 * manifest never names two versions, so the newest is always the right one.
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
  /** Desired cap before quota clamping. See {@link DEFAULT_BUDGET}. */
  budgetBytes?: number;
}

const DB_NAME = "sn-terms";
const STORE = "terms";
const VERSION = 1;

/**
 * 16 MB, a BACKSTOP rather than a budget to manage. The real tier-1 payload
 * decodes to 341,466 bytes for 186 documents and the whole dev corpus is
 * 1-2 MB (§3.2, §4.4). Eviction here is not free: the diff asks for whatever
 * is not held, so a cap the library genuinely exceeds means re-fetching the
 * same documents on every sync for ever.
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

/** The stored weight of one record, as UTF-16 code units of term text. An
 *  approximation on purpose: it is only ever compared against a cap an order
 *  of magnitude above the corpus. */
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

/**
 * Open the terms store. Never throws: any failure yields the no-op store.
 *
 * Its OWN database (`sn-terms`), like `sn-dims` and `sn-nocover`: a second
 * object store inside `sn-thumbs` needs a version bump the thumbnail store's
 * already-open connection does not perform.
 */
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
          // `storedAt` IS the LRU key: a terms record has no meaningful
          // "access" — the build reads all of them at once.
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
      // The META MIRROR, not a read of the store: the diff runs on every sync.
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
