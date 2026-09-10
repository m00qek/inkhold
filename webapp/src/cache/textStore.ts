// The BOUNDED half of the in-document text cache — §4.4.
//
//     on demand    →  GET text/<md5>?v=…  →  the browser's HTTP cache  (no code)
//     prefetched   →  GET text/<md5>?v=…  →  HERE                     (this file)
//
// What this must not break:
//   * This exists to be BOUNDED, nothing else. The HTTP cache is already the
//     on-demand story; what it cannot do is enforce a byte budget, because it
//     cannot be enumerated. Offline is a side effect, not a promise.
//   * The key is `(md5, indexVersion)`, spelled `<md5>.<v>` like the server's
//     filename: a version bump re-derives the SAME md5 into different text, so
//     a record keyed on md5 alone answers finds from an old parser with no
//     symptom. A null version cannot be stored (`textPrefetch.ts` refuses it).
//   * Protected (tier-1) bytes are charged BEFORE the LRU sees the remainder
//     ({@link planTextEviction}); otherwise casual reading evicts the very
//     notes the store exists to keep.
//   * TWO object stores (`meta`, `text`): the worst record is 3.15 MB, and
//     `termsStore.ts`'s cursor-the-whole-store cold open would deserialize
//     megabytes to learn three numbers.
//   * Degrades to a silent no-op store like `idb.ts`; never a source of truth.

import { budgetForQuota, planEviction, type PersistedMeta } from "./idb";
import type { DocumentText, TextSegment } from "../search/docText";

/** The identity of one stored record: the two halves of the cache key. */
export interface TextKey {
  readonly md5: string;
  readonly indexVersion: number;
}

/** What the store knows about a held record without reading its text. */
export interface HeldText extends TextKey {
  /** See {@link weighText}. */
  readonly size: number;
  /** Exempt from eviction — tier 1, and nothing else. See {@link planTextEviction}. */
  readonly protect: boolean;
  /** Epoch ms of the last put or find. The LRU ordering key. */
  readonly lastAccess: number;
}

/** A stored text record — the wire record plus its bookkeeping. */
export interface StoredDocumentText extends DocumentText {
  readonly storedAt: number;
  readonly protect: boolean;
}

/**
 * The prefetched text. It says nothing about WHICH documents belong in it —
 * that is §4.4's tiering, in `search/textPrefetch.ts` where the manifest is.
 * This is storage with a budget attached.
 */
export interface TextStore {
  /** Whether a real backing store is available (false = silent no-op store). */
  readonly available: boolean;
  /** One document's text at exactly this version, or null. Touches the LRU. */
  get(md5: string, indexVersion: number): Promise<StoredDocumentText | null>;
  /** Everything held, cheaply — the payloads are not read. */
  keys(): Promise<HeldText[]>;
  /** Store one record. `protect` exempts it from eviction. */
  put(doc: DocumentText, opts?: { protect?: boolean }): Promise<void>;
  /**
   * Re-assert (or release) a held record's exemption. What MIGRATES a store
   * written by a build that had pins: a record left `protect: true` by a pin
   * would otherwise be exempt for ever, with nothing left to release it.
   */
  setProtection(md5: string, indexVersion: number, protect: boolean): Promise<void>;
  drop(keys: readonly TextKey[]): Promise<void>;
  /** The byte budget in force — the desired one, clamped to the origin's quota. */
  budget(): Promise<number>;
  clear(): Promise<void>;
}

/** The primary key, spelled as the server spells the filename it names. */
export function textKeyOf(md5: string, indexVersion: number): string {
  return `${md5}.${indexVersion}`;
}

/**
 * 2 MB of stored text per user — §4.4's proposal, kept after correcting its
 * units: §4.4's table measures the server's DEFLATED file, and what lands here
 * is the parsed record, ~3.7x larger (tier 1: ~372 KB raw against ~100 KB
 * stored). Re-argued against inflated figures: tier 1 is ~372 KB (18% of the
 * budget, 5x headroom); tier 1 + tier 2 on the dev corpus is ~1.05 MB; the
 * annotated novel is ~5 MB, 2.5x the WHOLE budget and 10x the per-document
 * cap, so the one document the cap exists for is refused more decisively than
 * §4.4 assumed. Clamped further by `budgetForQuota`.
 */
export const DEFAULT_TEXT_BUDGET = 2 * 1024 * 1024;

/**
 * No single opportunistically-kept document may exceed a quarter of the
 * budget — a CROWDING rule: at least four documents coexist. 512 KB of raw
 * text is ~2,400 pages at §4.4's 212 B/page of recognition, larger than any
 * note the household writes, so the cap only ever bites an IMPORTED book.
 * Does NOT apply to tier 1, which is bounded by nature.
 */
export const PER_DOCUMENT_FRACTION = 0.25;

/** The per-document cap for a budget — see {@link PER_DOCUMENT_FRACTION}. */
export function perDocumentCap(budgetBytes: number): number {
  return Math.floor(budgetBytes * PER_DOCUMENT_FRACTION);
}

/**
 * The stored weight of one record: UTF-16 code units of segment text plus a
 * per-segment allowance. An approximation (exact needs the browser's own
 * structured-clone accounting), and deliberately an OVER-count for Latin
 * text, so the budget is spent slightly early — one document fewer kept
 * rather than a quota the browser resolves by evicting something.
 */
export function weighText(doc: DocumentText): number {
  let size = doc.md5.length + 32;
  for (const segment of doc.segments) size += segment.t.length + 24;
  return size;
}

/** One record's eviction inputs — {@link planTextEviction}'s row type. */
export interface ProtectedMeta extends PersistedMeta {
  readonly protect: boolean;
}

/**
 * Which records to shed so the rest fits the budget: `idb.ts`'s
 * `planEviction`, with the protected set held OUT of the candidates and
 * charged against the budget first. Running tier 1 through a plain LRU would
 * let a burst of tier-2 prefetching evict the records the prefetch exists to
 * make fast — silently, and only on the devices used most.
 *
 * When the protected set alone exceeds the budget the remainder floors at
 * zero and everything else goes; what bounds tier 1 in the end is the origin
 * quota `budgetForQuota` clamps against.
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
  /** Desired cap before quota clamping. See {@link DEFAULT_TEXT_BUDGET}. */
  budgetBytes?: number;
}

const DB_NAME = "sn-doctext";
const TEXT = "text";
const META = "meta";
/** v2 DROPS the `pins` store; the bump is what removes it from a browser that has one. */
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
 * Open the text store. Never throws: any failure yields the no-op store.
 *
 * Its OWN database (`sn-doctext`), like `sn-terms`, `sn-dims` and `sn-nocover`:
 * adding an object store to an existing database needs a version bump the
 * other module's already-open connection does not perform.
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
          // v1's third store. The records it protected are corrected on the
          // first prefetch pass (`setProtection`), not in an upgrade transaction.
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

  /** The whole cold-open cost: one cursor over small records. */
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

  /** Enforce the cap after anything that could have broken it. */
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
        // Best-effort touch: a failed one costs at most one wrongly-ordered eviction.
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
      // The mirror, not the store: asked on every prefetch pass.
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
      // A release can put the store over budget for the first time.
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
