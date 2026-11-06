// The bounded store for prefetched document text. On-demand text lives in the
// HTTP cache; this exists only because that cannot be enumerated or budgeted.
// Keyed `(md5, indexVersion)` like the server's filename. Degrades to a
// silent no-op store.

import { budgetForQuota, planEviction, type PersistedMeta } from "./idb";
import type { DocumentText, TextSegment } from "../search/docText";

export interface TextKey {
  readonly md5: string;
  readonly indexVersion: number;
}

/** What the store knows about a held record without reading its text. */
export interface HeldText extends TextKey {
  readonly size: number;
  /** Tier 1: exempt from eviction. */
  readonly protect: boolean;
  /** Epoch ms of the last put or find; the LRU key. */
  readonly lastAccess: number;
}

export interface StoredDocumentText extends DocumentText {
  readonly storedAt: number;
  readonly protect: boolean;
}

/** Storage with a budget; which documents belong is `textPrefetch.ts`'s call. */
export interface TextStore {
  /** False means the silent no-op store. */
  readonly available: boolean;
  /** Exactly this version, or null. Touches the LRU. */
  get(md5: string, indexVersion: number): Promise<StoredDocumentText | null>;
  /** Without reading payloads. */
  keys(): Promise<HeldText[]>;
  put(doc: DocumentText, opts?: { protect?: boolean }): Promise<void>;
  /** Re-assert or release a record's exemption (also clears protection left by an older build). */
  setProtection(md5: string, indexVersion: number, protect: boolean): Promise<void>;
  drop(keys: readonly TextKey[]): Promise<void>;
  /** The desired budget, clamped to the origin's quota. */
  budget(): Promise<number>;
  clear(): Promise<void>;
}

export function textKeyOf(md5: string, indexVersion: number): string {
  return `${md5}.${indexVersion}`;
}

/**
 * 2 MB of parsed text, ~3.7x the server's deflated size. Fits tier 1 with
 * headroom and refuses an annotated novel outright. Clamped by `budgetForQuota`.
 */
export const DEFAULT_TEXT_BUDGET = 2 * 1024 * 1024;

/**
 * A non-tier-1 document may take at most a quarter of the budget, so at least
 * four coexist; in practice only imported books hit it.
 */
const PER_DOCUMENT_FRACTION = 0.25;

export function perDocumentCap(budgetBytes: number): number {
  return Math.floor(budgetBytes * PER_DOCUMENT_FRACTION);
}

/**
 * UTF-16 units of text plus a per-segment allowance. Deliberately over-counts
 * so the budget is hit early rather than the browser's quota.
 */
export function weighText(doc: DocumentText): number {
  let size = doc.md5.length + 32;
  for (const segment of doc.segments) size += segment.t.length + 24;
  return size;
}

export interface ProtectedMeta extends PersistedMeta {
  readonly protect: boolean;
}

/**
 * `planEviction` with protected records charged against the budget first and
 * kept out of the LRU, so tier-2 prefetching cannot evict tier 1. If tier 1
 * alone exceeds the budget, everything else goes.
 */
export function planTextEviction(metas: readonly ProtectedMeta[], budgetBytes: number): string[] {
  let protectedBytes = 0;
  const evictable: PersistedMeta[] = [];
  for (const meta of metas) {
    if (meta.protect) protectedBytes += meta.size;
    else evictable.push(meta);
  }
  return planEviction(evictable, Math.max(0, budgetBytes - protectedBytes));
}

export interface TextStoreOptions {
  dbName?: string;
  budgetBytes?: number;
}

const DB_NAME = "sn-doctext";
const TEXT = "text";
const META = "meta";
/** v2 drops v1's `pins` store. */
const VERSION = 2;

interface TextRecord {
  key: string;
  md5: string;
  indexVersion: number;
  segmentCount: number;
  segments: TextSegment[];
}

interface MetaRecord {
  key: string;
  md5: string;
  indexVersion: number;
  size: number;
  protect: boolean;
  storedAt: number;
  lastAccess: number;
}

function nullStore(): TextStore {
  return {
    available: false,
    async get() {
      return null;
    },
    async keys() {
      return [];
    },
    async put() {},
    async setProtection() {},
    async drop() {},
    async budget() {
      return 0;
    },
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
 * Never throws: any failure yields the no-op store. Its own database, since
 * adding a store to a shared one needs a version bump other open connections
 * would block.
 */
export function openTextStore(opts: TextStoreOptions = {}): TextStore {
  if (!idbAvailable()) return nullStore();

  const desired = opts.budgetBytes ?? DEFAULT_TEXT_BUDGET;
  const metas = new Map<string, MetaRecord>();
  let budget = desired;

  const dbPromise: Promise<IDBDatabase | null> = (async () => {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(opts.dbName ?? DB_NAME, VERSION);
        open.onupgradeneeded = () => {
          const d = open.result;
          if (!d.objectStoreNames.contains(TEXT)) d.createObjectStore(TEXT, { keyPath: "key" });
          if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: "key" });
          // Records it protected are corrected by the next prefetch pass.
          if (d.objectStoreNames.contains("pins")) d.deleteObjectStore("pins");
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

  /** The whole cold-open cost: one cursor over the small meta records. */
  async function seedMetas(db: IDBDatabase): Promise<void> {
    return new Promise((resolve) => {
      try {
        const req = db.transaction(META, "readonly").objectStore(META).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve();
          const rec = cursor.value as MetaRecord;
          metas.set(rec.key, rec);
          cursor.continue();
        };
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async function withStores<T>(
    names: string | string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T | undefined> {
    const db = await dbPromise;
    if (!db) return undefined;
    try {
      return await fn(db.transaction(names, mode));
    } catch {
      return undefined;
    }
  }

  async function enforce(): Promise<void> {
    const evict = planTextEviction([...metas.values()].map(toMeta), budget);
    if (evict.length === 0) return;
    await withStores([TEXT, META], "readwrite", async (tx) => {
      const text = tx.objectStore(TEXT);
      const meta = tx.objectStore(META);
      for (const key of evict) {
        await promisify(text.delete(key));
        await promisify(meta.delete(key));
        metas.delete(key);
      }
    });
  }

  function toMeta(rec: MetaRecord): ProtectedMeta {
    return { key: rec.key, size: rec.size, lastAccess: rec.lastAccess, protect: rec.protect };
  }

  return {
    available: true,

    async get(md5, indexVersion) {
      const key = textKeyOf(md5, indexVersion);
      const rec = await withStores(TEXT, "readonly", (tx) =>
        promisify<TextRecord | undefined>(tx.objectStore(TEXT).get(key)),
      );
      if (!rec) return null;
      const meta = metas.get(key);
      if (meta) {
        // Best effort; a failed touch costs one misordered eviction.
        const touched: MetaRecord = { ...meta, lastAccess: Date.now() };
        metas.set(key, touched);
        void withStores(META, "readwrite", (tx) => promisify(tx.objectStore(META).put(touched)));
      }
      return {
        md5: rec.md5,
        indexVersion: rec.indexVersion,
        segmentCount: rec.segmentCount,
        segments: rec.segments,
        storedAt: meta?.storedAt ?? 0,
        protect: meta?.protect ?? false,
      };
    },

    async keys() {
      // From the in-memory mirror; asked on every prefetch pass.
      await dbPromise;
      return [...metas.values()].map((m) => ({
        md5: m.md5,
        indexVersion: m.indexVersion,
        size: m.size,
        protect: m.protect,
        lastAccess: m.lastAccess,
      }));
    },

    async put(doc, opts = {}) {
      const now = Date.now();
      const key = textKeyOf(doc.md5, doc.indexVersion);
      const text: TextRecord = {
        key,
        md5: doc.md5,
        indexVersion: doc.indexVersion,
        segmentCount: doc.segmentCount,
        segments: [...doc.segments],
      };
      const meta: MetaRecord = {
        key,
        md5: doc.md5,
        indexVersion: doc.indexVersion,
        size: weighText(doc),
        protect: opts.protect ?? false,
        storedAt: now,
        lastAccess: now,
      };
      const ok = await withStores([TEXT, META], "readwrite", async (tx) => {
        await promisify(tx.objectStore(TEXT).put(text));
        return promisify(tx.objectStore(META).put(meta));
      });
      if (ok === undefined) return;
      metas.set(key, meta);
      await enforce();
    },

    async setProtection(md5, indexVersion, protect) {
      const key = textKeyOf(md5, indexVersion);
      const held = metas.get(key);
      if (!held || held.protect === protect) return;
      const next: MetaRecord = { ...held, protect };
      const ok = await withStores(META, "readwrite", (tx) => promisify(tx.objectStore(META).put(next)));
      if (ok === undefined) return;
      metas.set(key, next);
      // A release can push the store over budget.
      if (!protect) await enforce();
    },

    async drop(keys) {
      if (keys.length === 0) return;
      await withStores([TEXT, META], "readwrite", async (tx) => {
        const text = tx.objectStore(TEXT);
        const meta = tx.objectStore(META);
        for (const { md5, indexVersion } of keys) {
          const key = textKeyOf(md5, indexVersion);
          await promisify(text.delete(key));
          await promisify(meta.delete(key));
          metas.delete(key);
        }
      });
    },

    async budget() {
      await dbPromise;
      return budget;
    },

    async clear() {
      metas.clear();
      await withStores([TEXT, META], "readwrite", async (tx) => {
        await promisify(tx.objectStore(TEXT).clear());
        return promisify(tx.objectStore(META).clear());
      });
    },
  };
}
