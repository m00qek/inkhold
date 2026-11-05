import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_BUDGET,
  openTextStore,
  perDocumentCap,
  planTextEviction,
  textKeyOf,
  weighText,
  type HeldText,
  type ProtectedMeta,
  type StoredDocumentText,
  type TextKey,
  type TextStore,
} from "../../src/cache/textStore";
import { createTextPrefetch, orderCandidates } from "../../src/search/textPrefetch";
import type { DocumentText, TextTransport } from "../../src/search/docText";
import type { ManifestRow, Tier } from "../../src/search/manifestCodec";

// The budget decision (`planTextEviction`) is tested pure; the policy runs against an
// in-memory `TextStore` that calls the same eviction. Tier 1 is the only protected class.

const md5 = (n: string): string => n.repeat(32).slice(0, 32);
const NOTE = md5("a");
const MARKED = md5("b");
const OTHER = md5("c");

function row(
  hash: string,
  tier: Tier,
  fileId: number,
  updatedAt: number,
  indexVersion: number | null = 15,
  derivation: ManifestRow["derivation"] = "derived",
): ManifestRow {
  return { md5: hash, fileId, tier, updatedAt, indexVersion, derivation };
}

/** A text record of a chosen weight — one segment padded to size. */
function text(hash: string, indexVersion: number, bytes: number, word = "reuniao"): DocumentText {
  const pad = Math.max(0, bytes - hash.length - 32 - 24 - word.length - 1);
  return {
    md5: hash,
    indexVersion,
    segmentCount: 1,
    segments: [{ p: 0, o: null, l: null, t: `${word} ${"x".repeat(pad)}` }],
  };
}

/** An in-memory `TextStore` enforcing the cap through the same `planTextEviction`. */
function memoryStore(available = true, budgetBytes = DEFAULT_TEXT_BUDGET): TextStore & {
  records: Map<string, StoredDocumentText>;
  metas: Map<string, ProtectedMeta & { md5: string; indexVersion: number }>;
} {
  const records = new Map<string, StoredDocumentText>();
  const metas = new Map<string, ProtectedMeta & { md5: string; indexVersion: number }>();
  let clock = 0;

  function enforce(): void {
    for (const key of planTextEviction([...metas.values()], budgetBytes)) {
      records.delete(key);
      metas.delete(key);
    }
  }

  return {
    records,
    metas,
    available,
    async get(hash, indexVersion) {
      const key = textKeyOf(hash, indexVersion);
      const rec = records.get(key);
      if (!rec) return null;
      const meta = metas.get(key);
      if (meta) metas.set(key, { ...meta, lastAccess: (clock += 1) });
      return rec;
    },
    async keys(): Promise<HeldText[]> {
      return [...metas.values()].map((m) => ({
        md5: m.md5,
        indexVersion: m.indexVersion,
        size: m.size,
        protect: m.protect,
        lastAccess: m.lastAccess,
      }));
    },
    async put(doc, opts = {}) {
      const key = textKeyOf(doc.md5, doc.indexVersion);
      records.set(key, { ...doc, storedAt: (clock += 1), protect: opts.protect ?? false });
      metas.set(key, {
        key,
        md5: doc.md5,
        indexVersion: doc.indexVersion,
        size: weighText(doc),
        protect: opts.protect ?? false,
        lastAccess: clock,
      });
      enforce();
    },
    async setProtection(hash, indexVersion, protect) {
      const key = textKeyOf(hash, indexVersion);
      const meta = metas.get(key);
      if (!meta) return;
      metas.set(key, { ...meta, protect });
      const rec = records.get(key);
      if (rec) records.set(key, { ...rec, protect });
      if (!protect) enforce();
    },
    async drop(keys: readonly TextKey[]) {
      for (const k of keys) {
        const key = textKeyOf(k.md5, k.indexVersion);
        records.delete(key);
        metas.delete(key);
      }
    },
    async budget() {
      return budgetBytes;
    },
    async clear() {
      records.clear();
      metas.clear();
    },
  };
}

function transportOf(bodies: Record<string, DocumentText>): {
  transport: TextTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const transport: TextTransport = async (hash, version) => {
    calls.push(`${hash}.${version}`);
    const body = bodies[hash];
    if (!body) throw new Error(`no text for ${hash}`);
    return body;
  };
  return { transport, calls };
}

/** Whether a document's text is held at this version, asked of the store. */
async function isHeld(store: TextStore, hash: string, indexVersion: number): Promise<boolean> {
  const held = await store.keys();
  return held.some((h) => h.md5 === hash && h.indexVersion === indexVersion);
}

const meta = (key: string, size: number, lastAccess: number, protect = false): ProtectedMeta => ({
  key,
  size,
  lastAccess,
  protect,
});

describe("the budget", () => {
  it("is 2 MB with a 512 KB per-document cap", () => {
    expect(DEFAULT_TEXT_BUDGET).toBe(2 * 1024 * 1024);
    expect(perDocumentCap(DEFAULT_TEXT_BUDGET)).toBe(512 * 1024);
    expect(perDocumentCap(DEFAULT_TEXT_BUDGET)).toBeGreaterThan(372 * 1024 * 0.25);
  });

  it("evicts least-recently-used first", () => {
    const metas = [meta("new", 40, 300), meta("old", 40, 100), meta("mid", 40, 200)];
    expect(planTextEviction(metas, 100)).toEqual(["old"]);
  });

  it("never evicts a protected record, and charges it against the budget first", () => {
    // Tier 1 is never shed for on-demand documents; 60 of 100 are spoken for.
    const metas = [meta("note", 60, 1, true), meta("a", 30, 2), meta("b", 30, 3)];
    expect(planTextEviction(metas, 100)).toEqual(["a"]);
  });

  it("sheds everything evictable when the protected set alone exceeds the budget", () => {
    const metas = [meta("notes", 500, 1, true), meta("a", 30, 2)];
    expect(planTextEviction(metas, 100)).toEqual(["a"]);
  });

  it("weighs a record by its text, not by its record count", () => {
    const small = weighText(text(NOTE, 15, 200));
    const large = weighText(text(NOTE, 15, 20_000));
    expect(large).toBeGreaterThan(small * 50);
  });
});

describe("orderCandidates", () => {
  const rows = [
    row(NOTE, "note", 1, 100),
    row(MARKED, "marked", 2, 200),
    row(OTHER, "other", 3, 300),
  ];

  it("tier 1, then tier 2, then tier 3; only notes are protected", () => {
    const ordered = orderCandidates(rows);
    expect(ordered.map((c) => c.md5)).toEqual([NOTE, MARKED, OTHER]);
    expect(ordered.map((c) => c.protect)).toEqual([true, false, false]);
  });

  it("orders each group newest first", () => {
    const olderNote = row(md5("d"), "note", 4, 50);
    const ordered = orderCandidates([olderNote, ...rows]);
    expect(ordered.map((c) => c.md5)).toEqual([NOTE, md5("d"), MARKED, OTHER]);
  });

  it("refuses a row that cannot be keyed, and one that is not derived yet", () => {
    const unkeyed = row(md5("e"), "note", 5, 400, null);
    const pending = row(md5("f"), "note", 6, 400, 15, "pending");
    const ordered = orderCandidates([unkeyed, pending, ...rows]);
    expect(ordered.map((c) => c.md5)).toEqual([NOTE, MARKED, OTHER]);
  });
});

describe("the prefetch", () => {
  it("keeps a `.note` without being asked", async () => {
    const store = memoryStore();
    const { transport, calls } = transportOf({ [NOTE]: text(NOTE, 15, 300) });
    const prefetch = createTextPrefetch({ store, transport });

    const outcome = await prefetch.prefetch([row(NOTE, "note", 1, 100)]);
    expect(outcome.kept).toBe(1);
    expect(calls).toEqual([`${NOTE}.15`]);
    expect(await isHeld(store, NOTE, 15)).toBe(true);
    expect(store.metas.get(textKeyOf(NOTE, 15))!.protect).toBe(true);
  });

  it("keeps another format too, after the notes and marked documents, within the budget", async () => {
    // A document may take a quarter of the budget: 300 of 2,000 fits.
    const store = memoryStore(true, 2_000);
    const { transport, calls } = transportOf({
      [NOTE]: text(NOTE, 15, 300),
      [MARKED]: text(MARKED, 15, 300),
      [OTHER]: text(OTHER, 15, 300),
    });
    const prefetch = createTextPrefetch({ store, transport });
    await prefetch.prefetch([row(OTHER, "other", 3, 900), row(MARKED, "marked", 2, 200), row(NOTE, "note", 1, 100)]);
    expect(await isHeld(store, OTHER, 15)).toBe(true);
    // The newest document still waits for the notes and the marked ones.
    expect(calls).toEqual([`${NOTE}.15`, `${MARKED}.15`, `${OTHER}.15`]);
  });

  it("a document refused as too big is not fetched again on the next visit", async () => {
    const store = memoryStore(true, 4_000);
    const { transport, calls } = transportOf({ [OTHER]: text(OTHER, 15, 3_000) });
    const kept = new Set<string>();
    const refusals = { has: (k: string) => kept.has(k), add: (k: string) => void kept.add(k) };
    const rows = [row(OTHER, "other", 3, 300)];

    await createTextPrefetch({ store, transport, refusals }).prefetch(rows);
    // A new visit: a new prefetch, the same remembered refusals.
    await createTextPrefetch({ store, transport, refusals }).prefetch(rows);
    expect(calls).toEqual([`${OTHER}.15`]);
  });

  it("releases a record a previous build had pinned, and lets it be evicted", async () => {
    // Migration: old stores hold `protect: true` on tier-2 records; this pass clears it.
    const store = memoryStore(true, 1_000);
    const { transport } = transportOf({ [MARKED]: text(MARKED, 15, 600) });
    await store.put(text(MARKED, 15, 600), { protect: true });
    expect(store.metas.get(textKeyOf(MARKED, 15))!.protect).toBe(true);

    const prefetch = createTextPrefetch({ store, transport });
    await prefetch.prefetch([row(MARKED, "marked", 2, 200)]);
    expect(store.metas.get(textKeyOf(MARKED, 15))!.protect).toBe(false);
  });

  it("spends the budget on tier 2 newest-first and stops", async () => {
    // Four of five fit; the oldest is the one that pays a fetch on first find.
    const hashes = [md5("1"), md5("2"), md5("3"), md5("4"), md5("5")];
    const store = memoryStore(true, 1_000);
    const bodies: Record<string, DocumentText> = {};
    for (const h of hashes) bodies[h] = text(h, 15, 250);
    const { transport, calls } = transportOf(bodies);
    const prefetch = createTextPrefetch({ store, transport });

    const outcome = await prefetch.prefetch(
      hashes.map((h, i) => row(h, "marked", i + 10, (i + 1) * 100)),
    );
    expect(outcome.kept).toBe(4);
    expect(await isHeld(store, hashes[4]!, 15)).toBe(true);
    expect(await isHeld(store, hashes[0]!, 15)).toBe(false);
    // Once the allowance is gone the walk stops asking: the oldest is never fetched.
    expect(calls).toEqual([...hashes].reverse().slice(0, 4).map((h) => `${h}.15`));
  });

  it("keeps tier 1 past a budget tier 2 could not have crossed", async () => {
    const store = memoryStore(true, 400);
    const { transport, calls } = transportOf({
      [NOTE]: text(NOTE, 15, 900),
      [MARKED]: text(MARKED, 15, 300),
    });
    const prefetch = createTextPrefetch({ store, transport });

    await prefetch.prefetch([row(NOTE, "note", 1, 100), row(MARKED, "marked", 2, 200)]);
    expect(await isHeld(store, NOTE, 15)).toBe(true);
    expect(await isHeld(store, MARKED, 15)).toBe(false);
    expect(calls).toEqual([`${NOTE}.15`]);
  });

  it("refuses a tier-2 document over the per-document cap, and does not re-fetch it", async () => {
    // One `.mark` on a novel moves 1.35 MB of text; the per-document cap stops it.
    const store = memoryStore(true, 4_000);
    const { transport, calls } = transportOf({ [MARKED]: text(MARKED, 15, 3_000) });
    const prefetch = createTextPrefetch({ store, transport });
    const rows = [row(MARKED, "marked", 2, 200)];

    const outcome = await prefetch.prefetch(rows);
    expect(outcome).toMatchObject({ kept: 0, skipped: 1 });
    expect(await isHeld(store, MARKED, 15)).toBe(false);

    await prefetch.prefetch(rows);
    expect(calls).toEqual([`${MARKED}.15`]);
  });

  it("drops a generation the manifest moved past", async () => {
    const store = memoryStore();
    const { transport } = transportOf({ [NOTE]: text(NOTE, 16, 300) });
    await store.put(text(NOTE, 15, 300), { protect: true });
    const prefetch = createTextPrefetch({ store, transport });

    const outcome = await prefetch.prefetch([row(NOTE, "note", 1, 100, 16)]);
    expect(outcome.dropped).toBe(1);
    expect(await isHeld(store, NOTE, 15)).toBe(false);
    expect(await isHeld(store, NOTE, 16)).toBe(true);
  });

  it("does nothing at all without a manifest", async () => {
    // An empty manifest is not evidence of deletion; only a complete one that omits is.
    const store = memoryStore();
    await store.put(text(NOTE, 15, 300), { protect: true });
    const { transport, calls } = transportOf({});
    const prefetch = createTextPrefetch({ store, transport });

    expect(await prefetch.prefetch([])).toMatchObject({ kept: 0, dropped: 0 });
    expect(calls).toEqual([]);
    expect(await isHeld(store, NOTE, 15)).toBe(true);
  });

  it("survives a document that will not fetch, and carries on with the rest", async () => {
    const store = memoryStore();
    const { transport } = transportOf({ [MARKED]: text(MARKED, 15, 300) });
    const prefetch = createTextPrefetch({ store, transport });

    const outcome = await prefetch.prefetch([
      row(NOTE, "note", 1, 900),
      row(MARKED, "marked", 2, 200),
    ]);
    expect(outcome.kept).toBe(1);
    expect(await isHeld(store, MARKED, 15)).toBe(true);
  });

  it("degrades to nothing where IndexedDB is missing", async () => {
    const store = memoryStore(false);
    const { transport, calls } = transportOf({ [NOTE]: text(NOTE, 15, 300) });
    const prefetch = createTextPrefetch({ store, transport });

    expect(prefetch.available).toBe(false);
    expect(await prefetch.prefetch([row(NOTE, "note", 1, 100)])).toMatchObject({ kept: 0 });
    expect(calls).toEqual([]);
  });
});

describe("openTextStore", () => {
  it("degrades to a no-op store where IndexedDB is missing — never throws", async () => {
    // Node has no indexedDB, so this is the real store degrading.
    const store = openTextStore();
    expect(store.available).toBe(false);
    expect(await store.get(NOTE, 15)).toBeNull();
    expect(await store.keys()).toEqual([]);
    await store.put(text(NOTE, 15, 300), { protect: true });
    await store.setProtection(NOTE, 15, false);
    await store.drop([{ md5: NOTE, indexVersion: 15 }]);
    await store.clear();
    expect(await store.get(NOTE, 15)).toBeNull();
  });
});

describe("remembered refusals", () => {
  it("survive a new visit, and are only a convenience where storage is refused", async () => {
    const { storedRefusals } = await import("../../src/search/textPrefetch");
    const mem = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const saved = g.localStorage;
    g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    try {
      storedRefusals().add("a.15");
      expect(storedRefusals().has("a.15")).toBe(true);
      expect(storedRefusals().has("a.16")).toBe(false);
      g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
      const r = storedRefusals();
      r.add("b.15");
      expect(r.has("b.15")).toBe(true);
    } finally {
      g.localStorage = saved;
    }
  });
});
