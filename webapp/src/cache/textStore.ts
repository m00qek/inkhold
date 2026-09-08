// The BOUNDED half of the in-document text cache — `golden-search.md` §4.4, and
// it is deliberately the smaller of the two halves that section describes.
//
//     on demand    →  GET text/<md5>?v=…  →  the browser's HTTP cache  (no code)
//     prefetched   →  GET text/<md5>?v=…  →  HERE                     (this file)
//
// **The HTTP cache is already the on-demand story and nothing here replaces
// it.** `text/<md5>` is content-addressed and answered `private, max-age=1y,
// immutable`, so a second find on a document costs nothing and no code was
// written to make that true. `docText.ts`'s header says so, and it stays true.
//
// **Offline is a SIDE EFFECT here, not a goal** — §4.4 was corrected to say so,
// and this file was corrected with it. Work moved to the browser because the
// server is a Pi 1 B+ with a ~50 MB budget; that the text then happens to be
// there with the network down is the architecture showing through, and nothing
// promises it. So what the HTTP cache cannot do is not PROMISE — it is be
// BOUNDED. It is evicted at the browser's discretion by every image on every
// other site, it cannot be enumerated, and a byte budget over something you
// cannot enumerate is not a budget. §4.4's tier 1 / tier 2 prefetch exists for
// LATENCY (the first find on a document costs a fetch plus a 315 ms build), and
// spending bytes on latency is exactly the thing that has to have a ceiling. That
// is this store, and the ONLY reason it exists.
//
// ## `(md5, indexVersion)`, for `termsStore.ts`'s reason, restated because it is
// the one that bites
//
// The key is the pair, spelled `<md5>.<v>` — the server's own filename for the
// same fact. An `index_version` bump re-derives the SAME md5 into different text
// and unlinks the old file, so a record keyed on the md5 alone would go on
// answering finds out of text an old parser produced, with no symptom. A row
// whose `indexVersion` is null therefore cannot be stored at all; the policy in
// `search/textPrefetch.ts` refuses those rather than inventing a version.
//
// ## TWO object stores, and the split is about the cold open
//
// `termsStore.ts` seeds its LRU mirror by cursoring the whole store, which is
// affordable there — a terms record is a few KB of folded words. A TEXT record
// is the document's real text: the worst real one is 3.15 MB (§8.1), so the same
// cursor would deserialize megabytes on every page load to learn three numbers.
// So the bookkeeping lives in its OWN store (`meta`), one small record per
// document, and the payload (`text`) is read only when a find actually wants it.
// Cold-open cost is then proportional to how MANY documents are held, not to how
// big they are.
//
// **There used to be a third, `pins`, and it is gone.** It held an explicit "keep
// this available offline" whose only power was to override eviction — which is
// an AVAILABILITY guarantee, and §4.4 says this project does not make one. A
// control that overrides a cache's budget tells the person the bytes are
// promised; they are not, and the browser can reclaim the whole origin. What the
// pin protected is kept by the thing that was always doing the protecting: tier 1
// is charged before the LRU runs (see {@link planTextEviction}), and it is now
// the only protected class. Removing the store is a version bump, below.
//
// ## The same degradation posture as `idb.ts`, and it has a fallback that works
//
// No IndexedDB, an open failure or a throwing transaction all degrade to a
// silent no-op store. In-document search then fetches `text/<md5>` exactly as it
// does today — which is not a special recovery path but the ordinary one, the
// same "index absent, rebuild" §4.2 says is REQUIRED on a plain-HTTP origin
// where `navigator.storage.persist()` does not exist. Nothing here is ever a
// source of truth.

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
  /** Exempt from eviction — tier 1, and since the pin went, nothing else. See
   *  {@link planTextEviction}. */
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
 * The prefetched text, for whoever needs a document's text without paying the
 * fetch.
 *
 * It says nothing about WHICH documents belong in it: that is §4.4's tiering,
 * and it lives in `search/textPrefetch.ts` where the manifest is. This is storage
 * with a budget attached.
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
   * Re-assert (or release) a held record's exemption.
   *
   * It survived the pin's removal because it is what MIGRATES a store written by
   * a build that had pins: a record left `protect: true` because somebody had
   * pinned it would otherwise be exempt from eviction for ever, with nothing left
   * that could release it. The prefetch re-asserts every candidate's protection
   * on every pass, so the first pass after this change corrects them.
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
 * 2 MB of stored text per user — §4.4's proposal, KEPT, but only after correcting
 * the units it was proposed in.
 *
 * §4.4's table measures the server's file, which is DEFLATED; what lands here is
 * the parsed record, which is not. Its own tier-1 projection gives the ratio —
 * ~372 KB raw against ~100 KB stored, 3.7x — so the same 2 MB buys about a
 * quarter of what the table's figures suggest, and the number has to be argued
 * against inflated ones or it is not being argued at all:
 *
 *   * **tier 1, the household projection** — 1,755 pages at ~212 B/page is
 *     ~372 KB RAW already, so it is unaffected: 18% of the budget, 5x headroom.
 *   * **tier 2, the dev corpus** — 188,072 B stored inflates to ~700 KB, so
 *     tier 1 and tier 2 together are ~1.05 MB. §4.4 says this budget "covers
 *     tier 1 and all of tier 2 with room", and that survives the correction with
 *     about half the budget spare.
 *   * **the annotated novel** — 1,355,048 B stored is ~5 MB raw: 2.5x the WHOLE
 *     budget rather than §4.4's 66% of it, and 10x the per-document cap. The one
 *     case the cap exists for is skipped more decisively than the proposal
 *     assumed, not less.
 *
 * So 2 MB stands, and it stands for the reason it was proposed: it fits the
 * projected household set twice over while refusing the one document that would
 * eat everything. It is clamped further by `budgetForQuota` — on a phone whose
 * origin quota is already crowded, the honest budget is smaller than any number
 * written here.
 */
export const DEFAULT_TEXT_BUDGET = 2 * 1024 * 1024;

/**
 * No single opportunistically-kept document may exceed a quarter of the budget —
 * §4.4's 25%, kept, and it is a CROWDING rule rather than a size rule.
 *
 * At 25% at least four documents coexist, which is what "one annotated novel
 * cannot consume the whole allowance" means arithmetically. And 512 KB of raw
 * text is ~2,400 pages at §4.4's 212 B/page of recognition — larger than any
 * note the household writes — so the cap only ever bites an IMPORTED book, which
 * is precisely the class §4.4 routes to the explicit "make available offline"
 * instead. A cap that fires on the household's own handwriting would be the
 * wrong number; this one cannot.
 *
 * It does NOT apply to tier 1: §4.4 keeps tier 1 unconditionally, because tier 1
 * is bounded by nature (the household's own handwriting, at ~212 B/page) and is
 * the class the prefetch exists for. This used to say "or to a pinned document",
 * and the pin is gone: an imported book that the cap refuses is simply fetched on
 * demand, and the HTTP cache is its whole story.
 */
export const PER_DOCUMENT_FRACTION = 0.25;

/** The per-document cap for a budget — see {@link PER_DOCUMENT_FRACTION}. */
export function perDocumentCap(budgetBytes: number): number {
  return Math.floor(budgetBytes * PER_DOCUMENT_FRACTION);
}

/**
 * The stored weight of one record, counted as UTF-16 code units of segment text
 * plus a per-segment allowance for its ordinal and byte range.
 *
 * An approximation, like `termsStore.ts`'s and for the same reason: the exact
 * figure needs the browser's own structured-clone accounting, which is not
 * exposed. It is deliberately an OVER-count for this corpus — the household
 * writes Latin text, which the engines serialize one byte per code unit — so the
 * budget is spent slightly early rather than slightly late, and the failure mode
 * is one document fewer kept rather than a quota the browser resolves by
 * evicting something.
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
 * Which records to shed so the rest fits the budget — `idb.ts`'s `planEviction`,
 * with the protected set held OUT of the candidates and charged against the
 * budget first.
 *
 * That order is what "charge the protected class first" was always for, and with
 * the pin gone TIER 1 IS THE ONLY PROTECTED CLASS — which is the tidiest the rule
 * has been. Tier 1 is §4.4's "always"; running it through a plain LRU would let a
 * burst of tier-2 prefetching evict the very records the prefetch exists to make
 * fast, and it would happen silently and only on the devices used most. So the
 * tier-1 bytes are subtracted from the budget and the LRU runs over what is left.
 *
 * When the protected set alone exceeds the budget — a library of notes larger
 * than the allowance — the remaining budget floors at zero and everything else
 * goes. That is the right answer: tier 1 is bounded by the household's own page
 * count, and what bounds it in the end is not this number but the origin quota
 * `budgetForQuota` clamps against.
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
/**
 * v2 DROPS the `pins` store — see the header. The bump is what actually removes
 * it from a browser that has one; leaving it would leave dead rows nothing reads
 * and a name the next schema change would have to work around.
 */
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
 * Open the text store. Never throws: any failure yields the no-op store, and the
 * caller cannot tell except through `available` — at which point in-document
 * search fetches, which is what it does anyway.
 *
 * Its OWN database (`sn-doctext`), for the reason `sn-terms`, `sn-dims` and
 * `sn-nocover` each have one: adding an object store to an existing database
 * needs a version bump that the other module's already-open connection does not
 * perform.
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
          // v1 had a third. The records it protected are corrected on the first
          // prefetch pass (`setProtection`), not here — an upgrade transaction is
          // the wrong place to walk a store for policy.
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

  /** The whole cold-open cost: one cursor over small records. See the header. */
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
        // Best-effort: the LRU order should reflect what is actually being read,
        // and a failed touch costs at most one wrongly-ordered eviction.
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
      // The mirror, not the store: this is asked on every prefetch pass and the
      // answer is three numbers per document.
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
      // A release can put the store over budget for the first time — a tier-1
      // record demoted, or a leftover pin corrected on the first pass after the
      // pin went — so this is the other place the cap has to be re-checked.
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
