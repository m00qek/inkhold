// The persistent tier (L3b) of the render cache: an IndexedDB-backed thumbnail
// store so the gallery paints instantly on a cold start instead of re-decoding
// every note. Only "thumb"-size renders are persisted (full reader pages are big
// and short-lived, so they live only in the memory LRU).
//
// Thumbnails are stored as a compressed WebP **Blob**, not raw `ImageData`. Raw
// RGBA was 20-40x larger on disk (~87 KB for a single 128 px thumb, several MB
// for a library) and the phone is the device that can least afford it. A Blob
// structured-clones into IDB the same way ImageData did, the browser decodes it
// natively on read (`createImageBitmap`), and `blob.size` is the byte weight the
// LRU budget accounts against.
//
// We enforce OUR OWN byte cap with LRU eviction on top of whatever the browser
// allows, and consult `navigator.storage.estimate()` to shrink that cap so we
// never crowd the origin's quota (a full quota gets pages evicted unpredictably).
// The cache is never a source of truth, so if IndexedDB is missing, `estimate()`
// is unavailable, or any op throws, we degrade to a no-op store — a miss just
// re-renders.
//
// The cap/eviction DECISION is factored into the two pure functions below
// (`planEviction`, `budgetForQuota`) so it's unit-testable without a real
// IndexedDB; the class just wires them to storage.

/** Lightweight per-entry bookkeeping, mirrored in memory to avoid deserializing
 * full ImageData just to make an eviction decision. */
export interface PersistedMeta {
  key: string;
  size: number;
  /** Epoch ms of the last get/put — the LRU ordering key. */
  lastAccess: number;
}

/**
 * Decide which entries to drop so the total fits `budgetBytes`. Pure: takes the
 * current metadata, returns the keys to evict, oldest-access first. Returns `[]`
 * when already within budget.
 */
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
 * Shrink our desired byte budget so it stays under the browser's quota. Pure.
 * Leaves headroom (targets 80% of quota) and discounts our own current usage so
 * we don't double-count it. Falls back to the desired budget when no estimate is
 * available (older browsers), trusting the browser's own eviction as a backstop.
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

/** The persistent thumbnail store the render cache talks to. */
export interface PersistentThumbStore {
  /** Whether a real backing store is available (false = silent no-op store). */
  readonly available: boolean;
  /** The stored WebP bytes for a key, or undefined on a miss. */
  get(key: string): Promise<Blob | undefined>;
  /** Persist a freshly encoded WebP thumbnail. */
  put(key: string, image: Blob): Promise<void>;
  clear(): Promise<void>;
}

export interface ThumbStoreOptions {
  dbName?: string;
  /** Desired cap before quota clamping. Default ~100 MB. */
  budgetBytes?: number;
}

const DB_NAME = "sn-thumbs";
const STORE = "thumbs";
const VERSION = 1;
const DEFAULT_BUDGET = 100 * 1024 * 1024;

/** A store that does nothing — used when IndexedDB is unavailable. */
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

interface StoredRecord {
  key: string;
  image: Blob;
  size: number;
  lastAccess: number;
}

/**
 * Open the IndexedDB-backed thumbnail store. Never throws: any failure yields a
 * no-op store. The in-memory `metas` mirror keeps eviction cheap; it's seeded on
 * open and kept in sync on every put/evict.
 */
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
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });

      // Seed the meta mirror (cheap: keys only, then per-key size — we store size
      // alongside so a getAll of records is avoided at scale by reading a cursor).
      await seedMetas(db, metas);

      // Clamp the cap to the browser quota if we can measure it.
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
      // Touch lastAccess so the LRU ordering reflects reads (best-effort).
      const meta = metas.get(key);
      if (meta) {
        meta.lastAccess = Date.now();
        void withStore("readwrite", (store) => promisify(store.put({ ...rec, lastAccess: meta.lastAccess })));
      }
      return rec.image;
    },

    async put(key, image) {
      const size = image.size;
      const record: StoredRecord = { key, image, size, lastAccess: Date.now() };
      const ok = await withStore("readwrite", (store) => promisify(store.put(record)));
      if (ok === undefined) return;
      metas.set(key, { key, size, lastAccess: record.lastAccess });

      // Enforce our own cap.
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

// --- the image-dims store ----------------------------------------------------
//
// A second, tiny persistent store: `hash → {w, h}` — the TRUE source dimensions
// of a plain image document, recorded the first time the thumbnail facade
// decodes it, and read by the masonry layout so an image tile lays out at its
// real aspect BEFORE any bytes arrive (docs/scratch/archive/masonry.md decision 5).
//
// Its OWN database (`sn-dims`), not a second object store in `sn-thumbs`: adding
// a store there would need a version bump, and the thumb store's connection
// opens at the old version — a coordination hazard for zero gain. Records are a
// few numbers each, so there is no byte budget and no eviction here; like every
// cache in this app it is advisory, never a source of truth (a missing entry
// just means one first-view reflow when the image decodes).

/** True dims of an image document's bytes, keyed by its content hash (md5). */
export interface DimsStore {
  /** Whether a real backing store is available (false = silent no-op store). */
  readonly available: boolean;
  get(hash: string): Promise<{ w: number; h: number } | null>;
  put(hash: string, dims: { w: number; h: number }): Promise<void>;
  clear(): Promise<void>;
}

const DIMS_DB = "sn-dims";
const DIMS_STORE = "dims";
const DIMS_VERSION = 1;

interface DimsRecord {
  hash: string;
  w: number;
  h: number;
}

/** A dims store that answers "unknown" to everything — no IndexedDB. */
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

/**
 * Open the IndexedDB-backed dims store. Never throws: any failure — no
 * IndexedDB, an open error, a per-op error — degrades to null/no-op, exactly
 * like the thumb store, because a miss only costs one first-view reflow.
 */
export function openDimsStore(opts: { dbName?: string } = {}): DimsStore {
  if (!idbAvailable()) return nullDimsStore();

  const dbPromise: Promise<IDBDatabase | null> = new Promise((resolve) => {
    try {
      const open = indexedDB.open(opts.dbName ?? DIMS_DB, DIMS_VERSION);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains(DIMS_STORE)) d.createObjectStore(DIMS_STORE, { keyPath: "hash" });
      };
      open.onsuccess = () => resolve(open.result);
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

// ---------------------------------------------------------------------------
// The no-cover store — the persistence behind cache/coverMemo.ts. Its OWN
// database (`sn-nocover`) for the same reason `sn-dims` has one: a second
// object store in an existing DB needs a version bump the other connection
// does not perform. Records are just the hash — presence IS the fact.

export interface NoCoverStore {
  /** Whether a real backing store is available (false = silent no-op store). */
  readonly available: boolean;
  has(hash: string): Promise<boolean>;
  put(hash: string): Promise<void>;
}

const NOCOVER_DB = "sn-nocover";
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
      open.onsuccess = () => resolve(open.result);
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
