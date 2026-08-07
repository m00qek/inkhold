import { describe, it, expect } from "vitest";
import {
  BlockCache,
  PREFETCH_HEAD_BYTES,
  PREFETCH_TAIL_BYTES,
  type RangeResult,
} from "../../src/render/pdfBlocks";

// The block cache is where the range design either works or does not, and it is
// testable without a browser, a worker or wasm — it is a cache over a function
// that returns bytes. What is asserted here is the ARITHMETIC of requests:
// MuPDF's reads are small and many, and the whole plan (
// §1) rests on those turning into a handful of round trips rather than hundreds.

/** A document of `total` bytes whose byte at `i` is `i % 251`, plus a fetch log. */
function doc(total: number, opts: { blockSize?: number; capBytes?: number; readAhead?: number } = {}) {
  const bytes = new Uint8Array(total);
  for (let i = 0; i < total; i++) bytes[i] = i % 251;
  const log: Array<[number, number]> = [];
  let gate: (() => void) | null = null;
  const pending: Array<() => void> = [];
  const cache = new BlockCache({
    total,
    blockSize: opts.blockSize ?? 1024,
    capBytes: opts.capBytes,
    readAhead: opts.readAhead ?? 0,
    fetchRange: async (start, end): Promise<RangeResult> => {
      log.push([start, end]);
      if (gate) await new Promise<void>((r) => pending.push(r));
      return { bytes: bytes.slice(start, end + 1), total, whole: false };
    },
  });
  return {
    cache,
    bytes,
    log,
    hold(): void {
      gate = () => {};
    },
    release(): void {
      gate = null;
      for (const r of pending.splice(0)) r();
    },
  };
}

describe("BlockCache", () => {
  it("serves many small reads inside one block from ONE request", async () => {
    // THE POINT OF THE WHOLE EXERCISE. On a 150 ms link, per-read requests are
    // slower than downloading the file; these have to be hits.
    const d = doc(8192, { blockSize: 1024 });
    for (let off = 0; off < 1024; off += 16) await d.cache.read(off, 16);
    expect(d.log).toEqual([[0, 1023]]);
    const s = d.cache.stats();
    expect(s.reads).toBe(64);
    expect(s.requests).toBe(1);
    expect(s.hits).toBe(63); // only the first one waited
    expect(s.misses).toBe(1);
  });

  it("returns the right bytes, including across a block boundary", async () => {
    const d = doc(8192, { blockSize: 1024 });
    const got = await d.cache.read(1000, 100); // spans blocks 0 and 1
    expect(Array.from(got)).toEqual(Array.from(d.bytes.subarray(1000, 1100)));
  });

  it("coalesces consecutive missing blocks into a single request", async () => {
    const d = doc(8192, { blockSize: 1024 });
    await d.cache.read(0, 3000); // blocks 0, 1, 2
    expect(d.log).toEqual([[0, 3071]]);
  });

  it("does not re-request a block that is already in flight", async () => {
    const d = doc(8192, { blockSize: 1024 });
    d.hold();
    const a = d.cache.read(0, 10) as Promise<Uint8Array>;
    const b = d.cache.read(500, 10) as Promise<Uint8Array>;
    d.release();
    await Promise.all([a, b]);
    expect(d.log).toEqual([[0, 1023]]);
  });

  it("answers SYNCHRONOUSLY once a block is resident — that is what avoids a suspension", async () => {
    const d = doc(8192, { blockSize: 1024 });
    expect(d.cache.read(0, 10)).toBeInstanceOf(Promise);
    await d.cache.read(0, 10);
    expect(d.cache.read(20, 10)).toBeInstanceOf(Uint8Array);
  });

  it("clamps at the end of the document and answers a read past it with nothing", async () => {
    // The C stream treats zero bytes as EOF, so this is how a document ends —
    // not an error to report.
    const d = doc(1500, { blockSize: 1024 });
    const tail = await d.cache.read(1400, 500);
    expect(tail.length).toBe(100);
    expect(d.cache.read(1500, 10)).toEqual(new Uint8Array(0));
  });

  it("reads ahead only when the read CONTINUES the last one", async () => {
    // Measured, not assumed (`READ_AHEAD_BLOCKS`): reading ahead from every read
    // doubled the request count on both real documents and bought nothing,
    // because page 1's access pattern is scattered object lookups. Restricted to
    // a continuation it is nearly free, and still covers the case it exists for
    // — a page whose content is one big stream, read straight through.
    const d = doc(8192, { blockSize: 1024, readAhead: 1 });
    await d.cache.read(0, 10);
    expect(d.log).toEqual([[0, 1023]]); // a scattered first read: no speculation
    await d.cache.read(4000, 10); // nowhere near: still no speculation
    expect(d.log).toEqual([
      [0, 1023],
      [3072, 4095],
    ]);
    await d.cache.read(4010, 10); // continues 4000+10 — now it is a run
    expect(d.log[2]).toEqual([4096, 5119]);
    // …and when the read arrives there it is already resident.
    await new Promise((r) => setTimeout(r, 0));
    expect(d.cache.read(4096, 10)).toBeInstanceOf(Uint8Array);
  });

  it("evicts LRU past the cap, and a re-read is a miss rather than an error", async () => {
    const d = doc(8192, { blockSize: 1024, capBytes: 2048 });
    await d.cache.read(0, 10); // block 0
    await d.cache.read(1024, 10); // block 1
    await d.cache.read(2048, 10); // block 2 — evicts block 0
    expect(d.cache.stats().evictions).toBe(1);
    expect(d.cache.stats().bytesResident).toBeLessThanOrEqual(2048);
    const again = await d.cache.read(0, 10);
    expect(Array.from(again)).toEqual(Array.from(d.bytes.subarray(0, 10)));
    expect(d.log.length).toBe(4);
  });

  it("adopts the length the response reports, over the one it was opened with", async () => {
    // `NoteMeta.size` is a hint. Believing a wrong one is not a small error:
    // MuPDF seeks to the end for `startxref`, so a document that claims to be
    // longer than it is has its trailer looked for in bytes that do not exist.
    const cache = new BlockCache({
      total: 999_999,
      blockSize: 1024,
      fetchRange: async (start, end) => ({
        bytes: new Uint8Array(Math.max(0, Math.min(end, 687) - start + 1)),
        total: 688,
        whole: false,
      }),
    });
    await cache.prime();
    expect(cache.length).toBe(688);
  });

  it("never invents an EOF out of a block cut short by a wrong length", async () => {
    // THE BUG THIS IS HERE FOR. Opened with a stale 400 KB size, a 79 MB
    // document had its block 0 requested as `bytes=0-399999` and cached at
    // 400000 bytes. The response corrected the length, but the short block
    // stayed — so every read between 400000 and the block's end came back
    // EMPTY, MuPDF saw the file end in the middle of itself, declared it
    // damaged, and disappeared into `repair` for minutes.
    const real = 79_522_801;
    const bytes = new Uint8Array(4096).fill(7);
    const asked: Array<[number, number]> = [];
    const cache = new BlockCache({
      total: 400_000, // a stale, far too small hint
      blockSize: 1024,
      readAhead: 0,
      fetchRange: async (start, end) => {
        asked.push([start, end]);
        return { bytes: bytes.subarray(0, end - start + 1), total: real, whole: false };
      },
    });
    await cache.prime();
    expect(cache.length).toBe(real);
    // Asked for the WHOLE block, not `[0, total-1]` — which is also how the
    // true length arrives, since a server clamps an over-long range itself.
    expect(asked[0]).toEqual([0, 1023]);
    const got = await cache.read(1000, 24);
    expect(got.length).toBe(24);
  });

  it("counts a server that ignores Range, rather than failing on it", async () => {
    const cache = new BlockCache({
      total: 2048,
      blockSize: 1024,
      readAhead: 0,
      fetchRange: async (start, end) => ({
        bytes: new Uint8Array(end - start + 1),
        total: 2048,
        whole: true,
      }),
    });
    await cache.read(0, 10);
    expect(cache.stats().wholeResponses).toBe(1);
  });

  it("logs the access pattern, which is the only way to see how MuPDF reads", async () => {
    const d = doc(8192, { blockSize: 1024 });
    await d.cache.read(100, 20);
    await d.cache.read(4000, 8);
    const s = d.cache.stats();
    expect(s.readPattern).toEqual([
      [100, 20],
      [4000, 8],
    ]);
    expect(s.ranges).toEqual([
      [0, 1023],
      [3072, 4095],
    ]);
    expect(s.bytesFetched).toBe(2048);
  });
});

describe("prime(): the speculative head and tail", () => {
  // MEASURED JUSTIFICATION (§5.7): of the 65 requests page 1 of a 79.5 MB
  // document costs, 13 land in the first 1 MB and 6 in the last 512 KB — the
  // header, the trailer and the xref, which every PDF needs whatever page is
  // wanted. Two speculative requests cover all 19, taking 65 to 49 in practice.
  const BS = 1024;
  const head = PREFETCH_HEAD_BYTES / BS; // blocks
  const tail = PREFETCH_TAIL_BYTES / BS;
  // FOUR TIMES the two windows combined, so the midpoint is genuinely outside
  // both. At a 1 KB test block size the 1 MB head is 1024 blocks, so a document
  // merely "a bit bigger" than head+tail has its middle INSIDE the head — which
  // is what the first version of this test got wrong.
  const big = (head + tail) * 4 * BS;

  it("fetches the front and the tail, and nothing in between", async () => {
    const d = doc(big, { blockSize: BS });
    await d.cache.prime();
    // Three requests: block 0 alone (it carries the true length), then the two
    // windows in parallel.
    expect(d.log.length).toBe(3);
    const [b0, a, b] = d.log;
    expect(b0).toEqual([0, BS - 1]);
    // The head window starts AFTER block 0 — re-fetching it would be pure waste.
    expect(a![0]).toBe(BS);
    expect(b![1]).toBe(big - 1); // the tail runs to the last byte
    // Nothing was fetched from the middle.
    const mid = big / 2;
    expect(d.log.some(([s2, e]) => s2 <= mid && mid <= e)).toBe(false);
  });

  it("makes reads inside those windows HITS — the point of doing it", async () => {
    const d = doc(big, { blockSize: BS });
    await d.cache.prime();
    const before = d.log.length;
    await d.cache.read(4096, 64); // in the head
    await d.cache.read(big - 2048, 64); // in the tail
    expect(d.log.length).toBe(before); // no new round trips
    expect(d.cache.stats().misses).toBe(0);
  });

  it("a read in the MIDDLE still costs a request — nothing is over-claimed", async () => {
    const d = doc(big, { blockSize: BS });
    await d.cache.prime();
    const before = d.log.length;
    await d.cache.read(Math.floor(big / 2), 64);
    expect(d.log.length).toBe(before + 1);
  });

  it("a document smaller than the windows is ONE request, not two of the same block", async () => {
    // The collapse case, and it had a real bug: the merged span started at block
    // 0, which block 0's own await had already fetched — so the 688-byte fixture
    // cost two requests for one block. Caught by an e2e assertion that the whole
    // tiny document is a single round trip.
    const d = doc(600, { blockSize: BS });
    await d.cache.prime();
    expect(d.log.length).toBe(1);
    expect(d.log[0]).toEqual([0, BS - 1]);
  });

  it("a document of a few blocks fetches each block at most once", async () => {
    const d = doc(BS * 5, { blockSize: BS });
    await d.cache.prime();
    const covered = d.log.flatMap(([s2, e]) => {
      const out: number[] = [];
      for (let i = Math.floor(s2 / BS); i <= Math.floor(e / BS); i++) out.push(i);
      return out;
    });
    expect(new Set(covered).size).toBe(covered.length); // no block twice
  });
});

describe("the diagnostic logs", () => {
  it("stop at the cap and SAY they stopped, so a statistic over them is not a lie", async () => {
    // `reads` keeps counting past the cap while `readPattern` does not, so a
    // median taken over the array after that point describes only its first
    // entries. Nothing in the app reads these — the cap exists because a log
    // held for nobody should not grow without bound — but a truncated log that
    // does not admit it reads as complete coverage.
    const { cache } = doc(4096 * 1024, { blockSize: 4096, readAhead: 0 });
    for (let i = 0; i < 700; i++) await cache.read(i * 4096, 16);
    const s = cache.stats();
    expect(s.reads).toBe(700);
    expect(s.readPattern.length).toBeLessThanOrEqual(512);
    expect(s.logTruncated).toBe(true);
  });

  it("does not claim truncation when everything fitted", async () => {
    const { cache } = doc(64 * 1024, { blockSize: 4096, readAhead: 0 });
    for (let i = 0; i < 5; i++) await cache.read(i * 4096, 16);
    const s = cache.stats();
    expect(s.readPattern.length).toBe(5);
    expect(s.logTruncated).toBe(false);
  });
});
