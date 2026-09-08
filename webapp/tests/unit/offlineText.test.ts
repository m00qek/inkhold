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
import { createOfflineText, orderCandidates } from "../../src/search/offlineText";
import type { DocumentText, TextTransport } from "../../src/search/docText";
import type { ManifestRow, Tier } from "../../src/search/manifestCodec";

// WHAT "OFFLINE" MEANS FOR IN-DOCUMENT TEXT — `golden-search.md` §4.4.
//
// The two halves are tested at different levels on purpose. The BUDGET decision
// is pure (`planTextEviction`) and asserted directly, because the real store
// needs an IndexedDB node does not have; the POLICY — which documents are kept
// without being asked for, and which need asking — runs against an in-memory
// `TextStore` that mirrors the real one's put/evict structure, so the eviction
// under test is the same shared function the IndexedDB store calls.

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

/**
 * An in-memory `TextStore`. It enforces the cap through the SAME
 * `planTextEviction` the IndexedDB store calls, so an assertion here is about
 * the shared decision and not about a test double's own opinion.
 */
function memoryStore(available = true, budgetBytes = DEFAULT_TEXT_BUDGET): TextStore & {
  records: Map<string, StoredDocumentText>;
  metas: Map<string, ProtectedMeta & { md5: string; indexVersion: number }>;
} {
  const records = new Map<string, StoredDocumentText>();
  const metas = new Map<string, ProtectedMeta & { md5: string; indexVersion: number }>();
  const pinSet = new Set<number>();
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
    async pins() {
      return [...pinSet];
    },
    async pin(fileId) {
      pinSet.add(fileId);
    },
    async unpin(fileId) {
      pinSet.delete(fileId);
    },
    async budget() {
      return budgetBytes;
    },
    async clear() {
      records.clear();
      metas.clear();
      pinSet.clear();
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

const meta = (key: string, size: number, lastAccess: number, protect = false): ProtectedMeta => ({
  key,
  size,
  lastAccess,
  protect,
});

describe("the budget", () => {
  it("is 2 MB with a 512 KB per-document cap", () => {
    // §4.4 proposes both; `textStore.ts` argues them against INFLATED figures,
    // since the section's table is the server's deflated file and what lands in
    // IndexedDB is the parsed record. The projected household tier 1 (~372 KB
    // raw) is still under a fifth of it.
    expect(DEFAULT_TEXT_BUDGET).toBe(2 * 1024 * 1024);
    expect(perDocumentCap(DEFAULT_TEXT_BUDGET)).toBe(512 * 1024);
    expect(perDocumentCap(DEFAULT_TEXT_BUDGET)).toBeGreaterThan(372 * 1024 * 0.25);
  });

  it("evicts least-recently-used first", () => {
    const metas = [meta("new", 40, 300), meta("old", 40, 100), meta("mid", 40, 200)];
    expect(planTextEviction(metas, 100)).toEqual(["old"]);
  });

  it("never evicts a protected record, and charges it against the budget first", () => {
    // The promise §4.4 makes about tier 1 is exactly this: a burst of on-demand
    // documents must not be able to shed the notes, however long ago they were
    // read. 60 of the 100 are spoken for, so the LRU runs against 40.
    const metas = [meta("note", 60, 1, true), meta("a", 30, 2), meta("b", 30, 3)];
    expect(planTextEviction(metas, 100)).toEqual(["a"]);
  });

  it("sheds everything evictable when the protected set alone exceeds the budget", () => {
    const metas = [meta("pinned", 500, 1, true), meta("a", 30, 2)];
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

  it("keeps tier 1 and tier 2, and never tier 3 on its own", () => {
    const ordered = orderCandidates(rows, new Set());
    expect(ordered.map((c) => c.md5)).toEqual([NOTE, MARKED]);
    // Tier 1 is protected — kept with no budget check; tier 2 is not.
    expect(ordered.map((c) => c.protect)).toEqual([true, false]);
  });

  it("puts a pin first and protects it, whatever tier it is", () => {
    const ordered = orderCandidates(rows, new Set([3]));
    expect(ordered[0]).toMatchObject({ md5: OTHER, protect: true });
  });

  it("orders each group newest first", () => {
    const olderNote = row(md5("d"), "note", 4, 50);
    const ordered = orderCandidates([olderNote, ...rows], new Set());
    expect(ordered.map((c) => c.md5)).toEqual([NOTE, md5("d"), MARKED]);
  });

  it("refuses a row that cannot be keyed, and one that is not derived yet", () => {
    const unkeyed = row(md5("e"), "note", 5, 400, null);
    const pending = row(md5("f"), "note", 6, 400, 15, "pending");
    const ordered = orderCandidates([unkeyed, pending, ...rows], new Set());
    expect(ordered.map((c) => c.md5)).toEqual([NOTE, MARKED]);
  });
});

describe("the prefetch", () => {
  it("keeps a `.note` without being asked", async () => {
    const store = memoryStore();
    const { transport, calls } = transportOf({ [NOTE]: text(NOTE, 15, 300) });
    const offline = createOfflineText({ store, transport });

    const outcome = await offline.prefetch([row(NOTE, "note", 1, 100)]);
    expect(outcome.kept).toBe(1);
    expect(calls).toEqual([`${NOTE}.15`]);
    expect(await offline.isKept(NOTE, 15)).toBe(true);
    expect(store.metas.get(textKeyOf(NOTE, 15))!.protect).toBe(true);
  });

  it("does not keep another format until it is opted in — and the opt-in survives a reload", async () => {
    const store = memoryStore();
    const { transport } = transportOf({ [OTHER]: text(OTHER, 15, 300) });
    const rows = [row(OTHER, "other", 3, 300)];

    const first = createOfflineText({ store, transport });
    await first.prefetch(rows);
    expect(await first.isKept(OTHER, 15)).toBe(false);

    expect(await first.keepOffline({ md5: OTHER, fileId: 3, indexVersion: 15 })).toBe(true);
    expect(await first.isKept(OTHER, 15)).toBe(true);

    // "A reload": the facade is rebuilt from nothing, and the store is the only
    // thing that carried anything across — which is the point of pinning in
    // IndexedDB rather than in a variable.
    const reloaded = createOfflineText({ store, transport });
    expect([...(await reloaded.pinned())]).toEqual([3]);
    const outcome = await reloaded.prefetch(rows);
    expect(outcome.kept).toBe(1);
    expect(await reloaded.isKept(OTHER, 15)).toBe(true);
  });

  it("pins by fileId, so editing the document does not release the promise", async () => {
    const store = memoryStore();
    const edited = md5("9");
    const { transport } = transportOf({ [OTHER]: text(OTHER, 15, 300), [edited]: text(edited, 15, 300) });
    const offline = createOfflineText({ store, transport });

    await offline.keepOffline({ md5: OTHER, fileId: 3, indexVersion: 15 });
    // The device wrote in it: same file, new blob, new md5.
    await offline.prefetch([row(edited, "other", 3, 400)]);
    expect(await offline.isKept(edited, 15)).toBe(true);
    // …and the superseded generation is gone rather than holding budget.
    expect(await offline.isKept(OTHER, 15)).toBe(false);
  });

  it("releases the protection when the pin goes, and the text becomes evictable", async () => {
    const store = memoryStore(true, 1_000);
    const { transport } = transportOf({ [OTHER]: text(OTHER, 15, 600) });
    const offline = createOfflineText({ store, transport });

    await offline.keepOffline({ md5: OTHER, fileId: 3, indexVersion: 15 });
    expect(store.metas.get(textKeyOf(OTHER, 15))!.protect).toBe(true);
    await offline.forget({ md5: OTHER, fileId: 3, indexVersion: 15 });
    expect(store.metas.get(textKeyOf(OTHER, 15))!.protect).toBe(false);
    expect([...(await offline.pinned())]).toEqual([]);
  });

  it("spends the budget on tier 2 newest-first and stops", async () => {
    // Five annotated documents of 250 B against a 1,000 B budget. Four fit; the
    // OLDEST is the one that does not, which is the failure §4.4 asks for in as
    // many words — "the two oldest annotated books are not offline" rather than
    // "the household silently synced 40 MB".
    const hashes = [md5("1"), md5("2"), md5("3"), md5("4"), md5("5")];
    const store = memoryStore(true, 1_000);
    const bodies: Record<string, DocumentText> = {};
    for (const h of hashes) bodies[h] = text(h, 15, 250);
    const { transport, calls } = transportOf(bodies);
    const offline = createOfflineText({ store, transport });

    // Handed to the pass OLDEST first, so the ordering under test is the
    // policy's and not the manifest's.
    const outcome = await offline.prefetch(
      hashes.map((h, i) => row(h, "marked", i + 10, (i + 1) * 100)),
    );
    expect(outcome.kept).toBe(4);
    expect(await offline.isKept(hashes[4]!, 15)).toBe(true);
    expect(await offline.isKept(hashes[0]!, 15)).toBe(false);
    // The four newest were asked for, newest first, and once the allowance was
    // gone the walk stopped ASKING — the oldest was never fetched.
    expect(calls).toEqual([...hashes].reverse().slice(0, 4).map((h) => `${h}.15`));
  });

  it("keeps tier 1 past a budget tier 2 could not have crossed", async () => {
    const store = memoryStore(true, 400);
    const { transport, calls } = transportOf({
      [NOTE]: text(NOTE, 15, 900),
      [MARKED]: text(MARKED, 15, 300),
    });
    const offline = createOfflineText({ store, transport });

    await offline.prefetch([row(NOTE, "note", 1, 100), row(MARKED, "marked", 2, 200)]);
    // §4.4: tier 1 is kept with NO budget check — and having spent the budget, it
    // is what stops tier 2 rather than being shed for it. Once the allowance is
    // gone the walk stops ASKING, so nothing is fetched to be thrown away.
    expect(await offline.isKept(NOTE, 15)).toBe(true);
    expect(await offline.isKept(MARKED, 15)).toBe(false);
    expect(calls).toEqual([`${NOTE}.15`]);
  });

  it("refuses a tier-2 document over the per-document cap, and does not re-fetch it", async () => {
    // MEASURED, §4.4: one `.mark` on a novel moves 1.35 MB of stored text into
    // the always-offline set from a single gesture. The cap is what turns that
    // into a document with an explicit action available instead.
    const store = memoryStore(true, 4_000); // cap = 1,000
    const { transport, calls } = transportOf({ [MARKED]: text(MARKED, 15, 3_000) });
    const offline = createOfflineText({ store, transport });
    const rows = [row(MARKED, "marked", 2, 200)];

    const outcome = await offline.prefetch(rows);
    expect(outcome).toMatchObject({ kept: 0, skipped: 1 });
    expect(await offline.isKept(MARKED, 15)).toBe(false);

    await offline.prefetch(rows);
    expect(calls).toEqual([`${MARKED}.15`]); // fetched once, refused, remembered.

    // …and the explicit opt-in overrides the cap, which is the whole point of
    // having one.
    expect(await offline.keepOffline({ md5: MARKED, fileId: 2, indexVersion: 15 })).toBe(true);
    expect(await offline.isKept(MARKED, 15)).toBe(true);
  });

  it("drops a generation the manifest moved past", async () => {
    const store = memoryStore();
    const { transport } = transportOf({ [NOTE]: text(NOTE, 16, 300) });
    await store.put(text(NOTE, 15, 300), { protect: true });
    const offline = createOfflineText({ store, transport });

    const outcome = await offline.prefetch([row(NOTE, "note", 1, 100, 16)]);
    expect(outcome.dropped).toBe(1);
    expect(await offline.isKept(NOTE, 15)).toBe(false);
    expect(await offline.isKept(NOTE, 16)).toBe(true);
  });

  it("does nothing at all without a manifest", async () => {
    // An empty manifest is not evidence of deletion — §2.7's removal mechanism is
    // a COMPLETE manifest that omits a document, and a session that never synced
    // has no opinion to act on.
    const store = memoryStore();
    await store.put(text(NOTE, 15, 300), { protect: true });
    const { transport, calls } = transportOf({});
    const offline = createOfflineText({ store, transport });

    expect(await offline.prefetch([])).toMatchObject({ kept: 0, dropped: 0 });
    expect(calls).toEqual([]);
    expect(await offline.isKept(NOTE, 15)).toBe(true);
  });

  it("survives a document that will not fetch, and carries on with the rest", async () => {
    const store = memoryStore();
    const { transport } = transportOf({ [MARKED]: text(MARKED, 15, 300) });
    const offline = createOfflineText({ store, transport });

    const outcome = await offline.prefetch([
      row(NOTE, "note", 1, 900), // no body: the transport throws
      row(MARKED, "marked", 2, 200),
    ]);
    expect(outcome.kept).toBe(1);
    expect(await offline.isKept(MARKED, 15)).toBe(true);
  });

  it("degrades to nothing where IndexedDB is missing", async () => {
    const store = memoryStore(false);
    const { transport, calls } = transportOf({ [NOTE]: text(NOTE, 15, 300) });
    const offline = createOfflineText({ store, transport });

    expect(offline.available).toBe(false);
    expect(await offline.prefetch([row(NOTE, "note", 1, 100)])).toMatchObject({ kept: 0 });
    expect(await offline.keepOffline({ md5: NOTE, fileId: 1, indexVersion: 15 })).toBe(false);
    expect(await offline.isKept(NOTE, 15)).toBe(false);
    // Nothing was fetched to be thrown away: an unavailable store is a no-op, and
    // in-document search then fetches on demand exactly as it does today.
    expect(calls).toEqual([]);
  });

  it("refuses to promise anything about a document with no index version", async () => {
    const store = memoryStore();
    const { transport, calls } = transportOf({ [OTHER]: text(OTHER, 15, 300) });
    const offline = createOfflineText({ store, transport });

    expect(await offline.keepOffline({ md5: OTHER, fileId: 3, indexVersion: null })).toBe(false);
    expect(await offline.isKept(OTHER, null)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("openTextStore", () => {
  it("degrades to a no-op store where IndexedDB is missing — never throws", async () => {
    // Node has no indexedDB, so this is the REAL store degrading. Every call
    // answers "nothing held", which is what makes the fetch path below the
    // ordinary one rather than a recovery.
    const store = openTextStore();
    expect(store.available).toBe(false);
    expect(await store.get(NOTE, 15)).toBeNull();
    expect(await store.keys()).toEqual([]);
    expect(await store.pins()).toEqual([]);
    await store.put(text(NOTE, 15, 300), { protect: true });
    await store.pin(1);
    await store.setProtection(NOTE, 15, false);
    await store.drop([{ md5: NOTE, indexVersion: 15 }]);
    await store.unpin(1);
    await store.clear();
    expect(await store.get(NOTE, 15)).toBeNull();
  });
});
