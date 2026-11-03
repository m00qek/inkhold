import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createIndexSync, IndexSyncError } from "../../src/search/indexSync";
import { entityTagValue } from "../../src/search/indexTransport";
import type { IndexTransport, ManifestAnswer, StreamAnswer } from "../../src/search/indexTransport";
import { openTermsStore, termsKeyOf } from "../../src/cache/termsStore";
import type { TermsKey, TermsStore, StoredTermsDocument } from "../../src/cache/termsStore";
import type { TermsDocument } from "../../src/search/termsStream";

// The same golden manifest `manifestCodec.test.ts` decodes; position 2 has a null version.
const MANIFEST = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../../../backend/services/search/testdata/manifest_golden.bin", import.meta.url)),
  ),
);

const ROWS: [position: number, md5: string, v: number][] = [
  [0, "0123456789abcdef0123456789abcdef", 15],
  [1, "fedcba9876543210fedcba9876543210", 15],
  [3, "d41d8cd98f00b204e9800998ecf8427e", 3],
  [4, "ffffffffffffffffffffffffffffffff", 0],
];

function doc(md5: string, v: number, terms = "reuniao"): string {
  return `{"md5":"${md5}","v":${v},"n":1}\n{"p":0,"t":"${terms}"}\n`;
}

/** An in-memory `TermsStore` — the real one needs an IndexedDB node does not have. */
function memoryStore(available = true): TermsStore & { records: Map<string, StoredTermsDocument> } {
  const records = new Map<string, StoredTermsDocument>();
  return {
    records,
    available,
    async keys() {
      return [...records.values()].map((r) => ({ md5: r.md5, indexVersion: r.indexVersion }));
    },
    async get(md5, indexVersion) {
      return records.get(termsKeyOf(md5, indexVersion)) ?? null;
    },
    async all() {
      return [...records.values()];
    },
    async put(d: TermsDocument) {
      records.set(termsKeyOf(d.md5, d.indexVersion), { ...d, storedAt: 1 });
    },
    async drop(keys: readonly TermsKey[]) {
      for (const k of keys) records.delete(termsKeyOf(k.md5, k.indexVersion));
    },
    async clear() {
      records.clear();
    },
  };
}

interface Call {
  m: string;
  want: string;
}

/** A transport with scripted stream answers: bodies (optionally chunked) or a 412. */
function fakeTransport(script: (string[] | 412)[], etags: string[] = ["etag-1"]) {
  const calls: Call[] = [];
  const manifests: string[] = [];
  let next = 0;
  const transport: IndexTransport = {
    async manifest(ifNoneMatch): Promise<ManifestAnswer> {
      manifests.push(ifNoneMatch ?? "(unconditional)");
      const etag = etags[Math.min(manifests.length - 1, etags.length - 1)]!;
      if (ifNoneMatch === etag) return { status: 304, etag, body: null };
      return { status: 200, etag, body: MANIFEST };
    },
    async stream(m, want): Promise<StreamAnswer> {
      calls.push({ m, want });
      const answer = script[Math.min(next, script.length - 1)]!;
      next += 1;
      if (answer === 412) return { status: 412, chunks: null };
      return {
        status: 200,
        chunks: (async function* () {
          for (const chunk of answer) yield chunk;
        })(),
      };
    },
  };
  return { transport, calls, manifests };
}

describe("createIndexSync", () => {
  it("asks for every cacheable row, stores what arrives, and never asks for the null-version one", async () => {
    const body = ROWS.map(([, md5, v]) => doc(md5, v)).join("");
    const { transport, calls } = fakeTransport([[body]]);
    const store = memoryStore();
    const outcome = await createIndexSync({ store, transport }).sync();

    expect(outcome.requested).toBe(4);
    expect(outcome.received).toBe(4);
    expect(outcome.skipped).toBe(0);
    expect(outcome.persisted).toBe(true);
    // Positions 0, 1, 3, 4 — bits 0,1,3,4 of byte 0 = 0b00011011 = 0x1b.
    expect(calls).toEqual([{ m: "etag-1", want: "Gw" }]);
    expect([...store.records.keys()]).toEqual(ROWS.map(([, md5, v]) => termsKeyOf(md5, v)));
  });

  it("asks for nothing, and opens no stream at all, once everything is held", async () => {
    const body = ROWS.map(([, md5, v]) => doc(md5, v)).join("");
    const { transport, calls } = fakeTransport([[body]]);
    const store = memoryStore();
    const sync = createIndexSync({ store, transport });
    await sync.sync();
    const second = await sync.sync();
    expect(second.requested).toBe(0);
    expect(second.received).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("sends the ETag it holds as a conditional If-None-Match on the next sync", async () => {
    const { transport, manifests } = fakeTransport([[ROWS.map(([, m, v]) => doc(m, v)).join("")]]);
    const sync = createIndexSync({ store: memoryStore(), transport });
    await sync.sync();
    await sync.sync();
    expect(manifests).toEqual(["(unconditional)", "etag-1"]);
  });

  it("treats a 412 as control flow: refetches the manifest UNCONDITIONALLY and re-asks", async () => {
    // A bitmap is only meaningful against the exact row order, so the server 412s.
    const body = ROWS.map(([, md5, v]) => doc(md5, v)).join("");
    const { transport, calls, manifests } = fakeTransport([412, [body]], ["etag-1", "etag-2"]);
    const outcome = await createIndexSync({ store: memoryStore(), transport }).sync();

    expect(manifests).toEqual(["(unconditional)", "(unconditional)"]);
    expect(calls.map((c) => c.m)).toEqual(["etag-1", "etag-2"]);
    expect(outcome.etag).toBe("etag-2");
    expect(outcome.received).toBe(4);
  });

  it("gives up on a 412 that repeats — a bitmap the server cannot fit is a bug, not a race", async () => {
    const { transport, calls } = fakeTransport([412]);
    await expect(createIndexSync({ store: memoryStore(), transport }).sync()).rejects.toThrow(IndexSyncError);
    expect(calls).toHaveLength(3);
  });

  it("stores documents DURING the stream, not after it", async () => {
    // The first document must be usable before the stream ends.
    const chunks = ROWS.map(([, md5, v]) => doc(md5, v));
    const seen: string[] = [];
    let released: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      released = r;
    });
    const transport: IndexTransport = {
      async manifest() {
        return { status: 200, etag: "etag-1", body: MANIFEST };
      },
      async stream() {
        return {
          status: 200,
          chunks: (async function* () {
            yield chunks[0]!;
            // There is no terminator: the next document's header releases the previous one.
            yield chunks[1]!;
            await gate;
            for (const c of chunks.slice(2)) yield c;
          })(),
        };
      },
    };
    const store = memoryStore();
    const running = createIndexSync({ store, transport }).sync({
      onDocument: (d) => seen.push(d.md5),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([ROWS[0]![1]]);
    expect(store.records.size).toBe(1);
    released!();
    await running;
    expect(seen).toHaveLength(4);
  });

  it("leaves a skipped document simply missing, and asks for it again next time", async () => {
    // A blob GC'd or still deriving is skipped, not an error that poisons the stream.
    const present = ROWS.filter(([p]) => p !== 3);
    const first = present.map(([, md5, v]) => doc(md5, v)).join("");
    const { transport, calls } = fakeTransport([[first], [doc(ROWS[2]![1], ROWS[2]![2])]]);
    const store = memoryStore();
    const sync = createIndexSync({ store, transport });

    const one = await sync.sync();
    expect(one.requested).toBe(4);
    expect(one.received).toBe(3);
    expect(one.skipped).toBe(1);
    expect(store.records.has(termsKeyOf(ROWS[2]![1], ROWS[2]![2]))).toBe(false);

    // The derive landed. Position 3 alone: bit 3 of byte 0 = 0x08.
    const two = await sync.sync();
    expect(calls[1]!.want).toBe("CA");
    expect(two.received).toBe(1);
    expect(two.skipped).toBe(0);
  });

  it("drops local rows the manifest no longer names, after the stream", async () => {
    const store = memoryStore();
    await store.put({ md5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", indexVersion: 1, pageCount: 1, pages: [] });
    const body = ROWS.map(([, md5, v]) => doc(md5, v)).join("");
    const { transport } = fakeTransport([[body]]);
    const outcome = await createIndexSync({ store, transport }).sync();
    expect(outcome.dropped).toBe(1);
    expect(store.records.has(termsKeyOf("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1))).toBe(false);
  });

  it("keys what it stores on what ARRIVED, not on what it asked for", async () => {
    // The record's own `v` names the cache entry, not the manifest's `index_version`.
    const { transport } = fakeTransport([[doc(ROWS[0]![1], 99)]]);
    const store = memoryStore();
    await createIndexSync({ store, transport }).sync();
    expect([...store.records.keys()]).toEqual([termsKeyOf(ROWS[0]![1], 99)]);
  });

  it("coalesces a concurrent sync into the one already in flight", async () => {
    const { transport, manifests } = fakeTransport([[ROWS.map(([, m, v]) => doc(m, v)).join("")]]);
    const sync = createIndexSync({ store: memoryStore(), transport });
    const [a, b] = await Promise.all([sync.sync(), sync.sync()]);
    expect(a).toBe(b);
    expect(manifests).toHaveLength(1);
  });

  it("does the whole sync against a no-op store when IndexedDB is missing", async () => {
    // Node has no indexedDB, so this is the real store degrading.
    const store = openTermsStore();
    expect(store.available).toBe(false);
    const { transport } = fakeTransport([[ROWS.map(([, m, v]) => doc(m, v)).join("")]]);
    const sync = createIndexSync({ store, transport });
    const outcome = await sync.sync();
    expect(outcome.received).toBe(4);
    expect(outcome.persisted).toBe(false);
    await expect(sync.documents()).resolves.toEqual([]);
    expect((await sync.sync()).requested).toBe(4);
  });

  it("refuses a manifest that arrives without a validator rather than 412-looping", async () => {
    const transport: IndexTransport = {
      async manifest() {
        return { status: 200, etag: null, body: MANIFEST };
      },
      async stream() {
        return { status: 200, chunks: null };
      },
    };
    await expect(createIndexSync({ store: memoryStore(), transport }).sync()).rejects.toThrow(IndexSyncError);
  });

  it("surfaces an unexpected status rather than recording an empty library", async () => {
    const transport: IndexTransport = {
      async manifest() {
        return { status: 401, etag: null, body: null };
      },
      async stream() {
        return { status: 200, chunks: null };
      },
    };
    await expect(createIndexSync({ store: memoryStore(), transport }).sync()).rejects.toMatchObject({
      name: "IndexSyncError",
      status: 401,
    });
  });
});

describe("entityTagValue", () => {
  it("unwraps the quoted validator the header carries into the bare hex `m=` needs", () => {
    // Backwards produces a permanent 412 loop and no other symptom.
    expect(entityTagValue('"abc123"')).toBe("abc123");
    expect(entityTagValue('W/"abc123"')).toBe("abc123");
    expect(entityTagValue(null)).toBeNull();
    expect(entityTagValue("")).toBeNull();
  });
});

describe("openTermsStore", () => {
  it("degrades to a no-op store where IndexedDB is missing — never throws", async () => {
    const store = openTermsStore();
    expect(store.available).toBe(false);
    await expect(store.keys()).resolves.toEqual([]);
    await expect(store.get("a".repeat(32), 7)).resolves.toBeNull();
    await expect(store.put({ md5: "a".repeat(32), indexVersion: 7, pageCount: 1, pages: [] })).resolves
      .toBeUndefined();
    await expect(store.drop([{ md5: "a".repeat(32), indexVersion: 7 }])).resolves.toBeUndefined();
    await expect(store.all()).resolves.toEqual([]);
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("spells its key the way the server spells the filename it came from", () => {
    expect(termsKeyOf("d41d8cd98f00b204e9800998ecf8427e", 7)).toBe("d41d8cd98f00b204e9800998ecf8427e.7");
  });
});
