// The persistent tier of the render cache: thumbnails in IndexedDB as encoded
// WebP bytes (raw RGBA was 20-40x larger; bytes, not Blobs: `StoredRecord`), under our own LRU byte cap clamped to
// the origin quota. Never a source of truth: any failure degrades to a no-op.

import { yieldOnVersionChange } from "./idbLife";

/** Per-entry bookkeeping, mirrored in memory so eviction never reads records. */
export interface PersistedMeta {
  key: string;
  size: number;
  lastAccess: number;
}

/** Pure: keys to evict, oldest access first; `[]` when within budget. */
export function planEviction(metas: readonly PersistedMeta[], budgetBytes: number): string[] {
  let running = 0;
  for (const m of metas) running += m.size;
  if (running <= budgetBytes) return [];

  const oldestFirst = [...metas].sort((a, b) => a.lastAccess - b.lastAccess);
  const evict: string[] = [];
  for (const m of oldestFirst) {
    if (running <= budgetBytes) break;
    evict.push(m.key);
    running -= m.size;
  }
  return evict;
}

export interface StorageEstimateLike {
  quota?: number;
  usage?: number;
}

/**
 * Pure. Targets 80% of quota, discounting our own usage; without an estimate,
 * returns the desired budget.
 */
export function budgetForQuota(
  estimate: StorageEstimateLike | null | undefined,
  desiredBytes: number,
  ourCurrentBytes = 0,
): number {
  if (!estimate || estimate.quota == null || !Number.isFinite(estimate.quota)) return desiredBytes;
  const usage = estimate.usage ?? 0;
  const othersUsage = Math.max(0, usage - ourCurrentBytes);
  const headroom = estimate.quota * 0.8 - othersUsage;
  if (!Number.isFinite(headroom)) return desiredBytes;
  return Math.max(0, Math.min(desiredBytes, Math.floor(headroom)));
}

export interface PersistentThumbStore {
  /** False means the silent no-op store. */
  readonly available: boolean;
  get(key: string): Promise<Blob | undefined>;
  put(key: string, image: Blob): Promise<void>;
  clear(): Promise<void>;
}

export interface ThumbStoreOptions {
  dbName?: string;
  budgetBytes?: number;
}

/** Rendered thumbnails and page pictures. Cleared at sign-out (`forget.ts`). */
export const THUMBS_DB = "sn-thumbs";
const DB_NAME = THUMBS_DB;
const STORE = "thumbs";
const VERSION = 1;
const DEFAULT_BUDGET = 100 * 1024 * 1024;

function nullStore(): PersistentThumbStore {
  return {
    available: false,
    async get() {
      return undefined;
    },
    async put() {},
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
 * A stored thumbnail: `image`, the Blob `put` was given, or `bytes` + `type`
 * once the LRU touch has rewritten it. WebKit (Safari, every iPhone browser)
 * has handed back IndexedDB Blobs that look whole but cannot be read, and has
 * stored empty ones when a Blob read from the store is written back, which
 * the old touch did on every read: installed on an iPhone, every preview
 * became a broken image. So a read takes the bytes into memory first (an
 * unreadable record is dropped and drawn again), and the touch writes those
 * bytes, never the Blob it read.
 */
interface StoredRecord {
  key: string;
  bytes?: ArrayBuffer;
  type?: string;
  image?: Blob;
  size: number;
  lastAccess: number;
}

/** The record's picture as a fresh in-memory Blob; null when it can't be read. */
export async function storedImage(rec: Pick<StoredRecord, "bytes" | "type" | "image">): Promise<{ blob: Blob; bytes: ArrayBuffer } | null> {
  try {
    const bytes = rec.bytes ?? (rec.image ? await rec.image.arrayBuffer() : null);
    if (!bytes || bytes.byteLength === 0) return null;
    return { blob: new Blob([bytes], { type: rec.type ?? rec.image?.type ?? "" }), bytes };
  } catch {
    return null;
  }
}

/** Never throws: any failure yields a no-op store. */
export function openThumbStore(opts: ThumbStoreOptions = {}): PersistentThumbStore {
  if (!idbAvailable()) return nullStore();

  const dbName = opts.dbName ?? DB_NAME;
  const desired = opts.budgetBytes ?? DEFAULT_BUDGET;
  const metas = new Map<string, PersistedMeta>();
  let budget = desired;

  const dbPromise: Promise<IDBDatabase | null> = (async () => {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(dbName, VERSION);
        open.onupgradeneeded = () => {
          const d = open.result;
          if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "key" });
        };
        open.onsuccess = () => resolve(yieldOnVersionChange(open.result));
        open.onerror = () => reject(open.error);
      });

      await seedMetas(db, metas);

      try {
        const nav = typeof navigator !== "undefined" ? navigator : undefined;
        if (nav?.storage?.estimate) {
          const est = await nav.storage.estimate();
          const ourBytes = [...metas.values()].reduce((s, m) => s + m.size, 0);
          budget = budgetForQuota(est, desired, ourBytes);
        }
      } catch {
        budget = desired;
      }
      return db;
    } catch {
      return null;
    }
  })();

  async function seedMetas(db: IDBDatabase, into: Map<string, PersistedMeta>): Promise<void> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          const rec = cursor.value as StoredRecord;
          into.set(rec.key, { key: rec.key, size: rec.size, lastAccess: rec.lastAccess });
          cursor.continue();
        };
        cursorReq.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T | undefined> {
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

    async get(key) {
      const rec = await withStore("readonly", (store) => promisify<StoredRecord | undefined>(store.get(key)));
      if (!rec) return undefined;
      const read = await storedImage(rec);
      if (!read) {
        // Unreadable: forget it, and the caller draws the thumbnail again.
        metas.delete(key);
        void withStore("readwrite", (store) => promisify(store.delete(key)));
        return undefined;
      }
      // Best-effort LRU touch, as bytes (never the Blob just read).
      const meta = metas.get(key);
      const lastAccess = Date.now();
      if (meta) meta.lastAccess = lastAccess;
      const type = read.blob.type;
      void withStore("readwrite", (store) => promisify(store.put({ key, bytes: read.bytes, type, size: rec.size, lastAccess } satisfies StoredRecord)));
      return read.blob;
    },

    async put(key, image) {
      const size = image.size;
      // A fresh picture (from a canvas, never one read from this store) is
      // stored as is; only the touch in `get` rewrites, and it writes bytes.
      const record: StoredRecord = { key, image, size, lastAccess: Date.now() };
      let ok = await withStore("readwrite", (store) => promisify(store.put(record)));
      if (ok === undefined) {
        // WebKit refuses Blobs in IndexedDB in private browsing (a DataCloneError);
        // its bytes it keeps.
        let bytes: ArrayBuffer;
        try {
          bytes = await image.arrayBuffer();
        } catch {
          return;
        }
        const asBytes: StoredRecord = { key, bytes, type: image.type, size, lastAccess: record.lastAccess };
        ok = await withStore("readwrite", (store) => promisify(store.put(asBytes)));
        if (ok === undefined) return;
      }
      metas.set(key, { key, size, lastAccess: record.lastAccess });

      const toEvict = planEviction([...metas.values()], budget);
      if (toEvict.length === 0) return;
      await withStore("readwrite", async (store) => {
        for (const k of toEvict) {
          await promisify(store.delete(k));
          metas.delete(k);
        }
      });
    },

    async clear() {
      metas.clear();
      await withStore("readwrite", (store) => promisify(store.clear()));
    },
  };
}

// ---- image dims store ----
// `hash -> {w, h}`, the true source dimensions of an image document, so
// masonry lays out at the real aspect before bytes arrive. Its own database
// (`sn-dims`); no budget, records are tiny.

/** Keyed by content hash (md5). */
export interface DimsStore {
  readonly available: boolean;
  get(hash: string): Promise<{ w: number; h: number } | null>;
  put(hash: string, dims: { w: number; h: number }): Promise<void>;
  clear(): Promise<void>;
}

/** Page and image sizes by file hash. Cleared at sign-out (`forget.ts`). */
export const DIMS_DB = "sn-dims";
const DIMS_STORE = "dims";
const DIMS_VERSION = 1;

interface DimsRecord {
  hash: string;
  w: number;
  h: number;
}

function nullDimsStore(): DimsStore {
  return {
    available: false,
    async get() {
      return null;
    },
    async put() {},
    async clear() {},
  };
}

/** Never throws; a miss costs one first-view reflow. */
export function openDimsStore(opts: { dbName?: string } = {}): DimsStore {
  if (!idbAvailable()) return nullDimsStore();

  const dbPromise: Promise<IDBDatabase | null> = new Promise((resolve) => {
    try {
      const open = indexedDB.open(opts.dbName ?? DIMS_DB, DIMS_VERSION);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains(DIMS_STORE)) d.createObjectStore(DIMS_STORE, { keyPath: "hash" });
      };
      open.onsuccess = () => resolve(yieldOnVersionChange(open.result));
      open.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  async function withDims<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T | undefined> {
    const db = await dbPromise;
    if (!db) return undefined;
    try {
      const tx = db.transaction(DIMS_STORE, mode);
      return await fn(tx.objectStore(DIMS_STORE));
    } catch {
      return undefined;
    }
  }

  return {
    available: true,

    async get(hash) {
      const rec = await withDims("readonly", (store) => promisify<DimsRecord | undefined>(store.get(hash)));
      if (!rec || !Number.isFinite(rec.w) || !Number.isFinite(rec.h)) return null;
      return { w: rec.w, h: rec.h };
    },

    async put(hash, dims) {
      await withDims("readwrite", (store) => promisify(store.put({ hash, w: dims.w, h: dims.h } satisfies DimsRecord)));
    },

    async clear() {
      await withDims("readwrite", (store) => promisify(store.clear()));
    },
  };
}

// ---- no-cover store (behind `coverMemo.ts`) ----
// Its own database (`sn-nocover`). Presence of the hash is the fact.

export interface NoCoverStore {
  readonly available: boolean;
  has(hash: string): Promise<boolean>;
  put(hash: string): Promise<void>;
}

/** Which files have no cover, by hash. Cleared at sign-out (`forget.ts`). */
export const NOCOVER_DB = "sn-nocover";
const NOCOVER_STORE = "nocover";
const NOCOVER_VERSION = 1;

function nullNoCoverStore(): NoCoverStore {
  return {
    available: false,
    async has() {
      return false;
    },
    async put() {},
  };
}

export function openNoCoverStore(opts: { dbName?: string } = {}): NoCoverStore {
  if (!idbAvailable()) return nullNoCoverStore();

  const dbPromise: Promise<IDBDatabase | null> = new Promise((resolve) => {
    try {
      const open = indexedDB.open(opts.dbName ?? NOCOVER_DB, NOCOVER_VERSION);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains(NOCOVER_STORE)) d.createObjectStore(NOCOVER_STORE, { keyPath: "hash" });
      };
      open.onsuccess = () => resolve(yieldOnVersionChange(open.result));
      open.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T | undefined> {
    const db = await dbPromise;
    if (!db) return undefined;
    try {
      const tx = db.transaction(NOCOVER_STORE, mode);
      return await fn(tx.objectStore(NOCOVER_STORE));
    } catch {
      return undefined;
    }
  }

  return {
    available: true,
    async has(hash: string): Promise<boolean> {
      const found = await withStore("readonly", (store) => promisify<unknown>(store.get(hash)));
      return found !== undefined && found !== null;
    },
    async put(hash: string): Promise<void> {
      await withStore("readwrite", (store) => promisify(store.put({ hash })));
    },
  };
}
