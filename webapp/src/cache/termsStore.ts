// Where the terms stream lands: one IndexedDB record per document, keyed by
// `(md5, index_version)` — `golden-search.md` §4.2.
//
// **No wasm is involved in getting here, and that is the whole point of the
// section.** §9.5 of the design it supersedes says load the engine on the first
// visit; §6.1 says a user who never searches must never pay the 17.4 MB of
// linear memory `WebAssembly.instantiate` allocates. The resolution is that sync
// writes rows and nothing else, and the FTS index is built on first search
// (39 ms at tier 1, MEASURED). The obvious implementation — instantiate the
// engine at sync time and insert as documents arrive — quietly bills every
// household member who only ever browses. So this module imports nothing that
// can reach `sqlite-core.wasm`, and it must stay that way.
//
// ## `(md5, index_version)`, spelled exactly as the server spells its filename
//
// The md5 alone is HALF a key. `manifestCodec.ts` says why in as many words: a
// blob with a stale index row reports `derived` while genuinely underived, and
// the only thing that makes that window survivable is that its version is not
// the current one, so a client keyed on both refetches. A row whose
// `indexVersion` is null therefore cannot be cached at all — and it never
// reaches this store, because the key is taken from the RECORD's own `v`
// (§3.3: key what you store on what ARRIVED), and an arrived record always
// carries one.
//
// ## The same degradation posture as `idb.ts`, for a stronger reason
//
// This store is never a source of truth: the index is rebuildable from a
// manifest and a stream, and §4.2 notes that on a plain-HTTP origin
// `navigator.storage.persist()` does not even exist — the "index absent,
// rebuild" path is REQUIRED, which is what makes droppability free. So no
// IndexedDB, an open failure or a throwing transaction all degrade to a silent
// no-op store, and the cost is one sync's worth of bytes re-fetched.
//
// A partial loss is self-healing for the same reason: the diff asks for whatever
// is not held, so an evicted document is simply wanted again at the next
// manifest. That is also the hazard the budget below has to respect.

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
 * The per-document term rows, for whoever builds the index out of them.
 *
 * **This is the seam the engine consumes**, and it deliberately says nothing
 * about where the rows came from: `all()` hands back per-document arrays of
 * `{p, t}`, which §4.1 inserts one FTS5 row at a time with no transposition of
 * any kind. The engine never sees a manifest, a bitmap or a stream.
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

/**
 * The primary key — `<md5>.<index_version>`, which is the server's own filename
 * for the same fact (`data/terms/<md5>.<index_version>`). One spelling on both
 * sides of the wire is one thing to get wrong instead of two.
 */
export function termsKeyOf(md5: string, indexVersion: number): string {
  return `${md5}.${indexVersion}`;
}

/**
 * One record per md5, keeping the highest `indexVersion` — what `all()` hands to
 * the index build.
 *
 * **The store is keyed `(md5, indexVersion)`, so two generations of one document
 * can sit in it at once**, and dropping the older one is clean-up rather than a
 * protocol step: nothing downstream waits for it. That is fine for storage and
 * fatal for the build, which refuses a repeated md5 — the guard exists because
 * adding a document twice would double the per-document match counts the results
 * are ranked by. So a drop that has not run yet, or was interrupted, would have
 * turned an extractor-version bump into a global search that throws instead of
 * one that is briefly stale.
 *
 * Resolved HERE rather than by relaxing the guard, because the manifest never
 * names two versions of a document: a second one in the store is always a
 * cleanup artefact, and the newest is always the one the manifest asked for.
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
 * 16 MB, and it is a BACKSTOP rather than a budget to manage.
 *
 * MEASURED (§3.2, §4.4): the real tier-1 payload decodes to 341,466 bytes for
 * 186 documents, and the whole dev corpus is 1-2 MB. A household library that
 * fits the design's own numbers never comes near this, which is deliberate,
 * because eviction here is not free the way it is for a thumbnail: the diff asks
 * for whatever is not held, so evicting under a cap the library genuinely
 * exceeds means re-fetching the same documents on every sync for ever. A cap far
 * above the projection stops an unbounded store from crowding the origin's quota
 * and does nothing else.
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

/**
 * The stored weight of one record, counted as UTF-16 code units of term text.
 *
 * An approximation on purpose. The exact figure would need the browser's own
 * structured-clone accounting, which is not exposed, and the number is only ever
 * compared against a cap chosen an order of magnitude above the corpus — so
 * being 20% out changes nothing and measuring it exactly would cost a second
 * pass over every page of every document.
 */
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
 * Open the terms store. Never throws: any failure yields the no-op store, and a
 * caller cannot tell the difference except through `available`.
 *
 * Its OWN database (`sn-terms`), for the reason `sn-dims` and `sn-nocover` each
 * have one: a second object store inside `sn-thumbs` needs a version bump that
 * the thumbnail store's already-open connection does not perform.
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
          // `storedAt` IS the LRU ordering key: a terms record has no meaningful
          // "access" — the index build reads all of them at once — so oldest
          // arrival is the only honest order to shed in.
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
      // The META MIRROR, not a read of the store: the diff runs on every sync
      // and only needs the two halves of each key, which the key itself spells.
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
