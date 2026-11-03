import { describe, it, expect } from "vitest";
import {
  BlockCache,
  PREFETCH_HEAD_BYTES,
  PREFETCH_TAIL_BYTES,
  type RangeResult,
} from "../../src/render/pdfBlocks";

// The block cache: MuPDF's many small reads must become a handful of range requests.

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
    const d = doc(8192, { blockSize: 1024 });
    for (let off = 0; off < 1024; off += 16) await d.cache.read(off, 16);
    expect(d.log).toEqual([[0, 1023]]);
    const s = d.cache.stats();
    expect(s.reads).toBe(64);
    expect(s.requests).toBe(1);
    expect(s.hits).toBe(63);
    expect(s.misses).toBe(1);
  });

  it("returns the right bytes, including across a block boundary", async () => {
    const d = doc(8192, { blockSize: 1024 });
    const got = await d.cache.read(1000, 100);
    expect(Array.from(got)).toEqual(Array.from(d.bytes.subarray(1000, 1100)));
  });

  it("coalesces consecutive missing blocks into a single request", async () => {
    const d = doc(8192, { blockSize: 1024 });
    await d.cache.read(0, 3000);
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
    // The C stream treats zero bytes as EOF.
    const d = doc(1500, { blockSize: 1024 });
    const tail = await d.cache.read(1400, 500);
    expect(tail.length).toBe(100);
    expect(d.cache.read(1500, 10)).toEqual(new Uint8Array(0));
  });

  it("reads ahead only when the read CONTINUES the last one", async () => {
    // Read-ahead only on a continuation: from every read it doubled requests (measured).
    const d = doc(8192, { blockSize: 1024, readAhead: 1 });
    await d.cache.read(0, 10);
    expect(d.log).toEqual([[0, 1023]]);
    await d.cache.read(4000, 10);
    expect(d.log).toEqual([
      [0, 1023],
      [3072, 4095],
    ]);
    await d.cache.read(4010, 10);
    expect(d.log[2]).toEqual([4096, 5119]);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.cache.read(4096, 10)).toBeInstanceOf(Uint8Array);
  });

  it("evicts LRU past the cap, and a re-read is a miss rather than an error", async () => {
    const d = doc(8192, { blockSize: 1024, capBytes: 2048 });
    await d.cache.read(0, 10);
    await d.cache.read(1024, 10);
    await d.cache.read(2048, 10);
    expect(d.cache.stats().evictions).toBe(1);
    expect(d.cache.stats().bytesResident).toBeLessThanOrEqual(2048);
    const again = await d.cache.read(0, 10);
    expect(Array.from(again)).toEqual(Array.from(d.bytes.subarray(0, 10)));
    expect(d.log.length).toBe(4);
  });

  it("adopts the length the response reports, over the one it was opened with", async () => {
    // `NoteMeta.size` is a hint; MuPDF seeks to the end for `startxref`.
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
    // Regression: a stale 400 KB size cached a short block 0, so reads past it came back
    // empty and MuPDF went into `repair` for minutes.
    const real = 79_522_801;
    const bytes = new Uint8Array(4096).fill(7);
    const asked: Array<[number, number]> = [];
    const cache = new BlockCache({
      total: 400_000,
      blockSize: 1024,
      readAhead: 0,
      fetchRange: async (start, end) => {
        asked.push([start, end]);
        return { bytes: bytes.subarray(0, end - start + 1), total: real, whole: false };
      },
    });
    await cache.prime();
    expect(cache.length).toBe(real);
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
  // Page 1 of a 79.5 MB document: 19 of 65 requests hit the first 1 MB and last 512 KB.
  const BS = 1024;
  const head = PREFETCH_HEAD_BYTES / BS;
  const tail = PREFETCH_TAIL_BYTES / BS;
  // Four times both windows, so the midpoint is genuinely outside them.
  const big = (head + tail) * 4 * BS;

  it("fetches the front and the tail, and nothing in between", async () => {
    const d = doc(big, { blockSize: BS });
    await d.cache.prime();
    // Block 0 alone (it carries the true length), then both windows in parallel.
    expect(d.log.length).toBe(3);
    const [b0, a, b] = d.log;
    expect(b0).toEqual([0, BS - 1]);
    expect(a![0]).toBe(BS);
    expect(b![1]).toBe(big - 1);
    const mid = big / 2;
    expect(d.log.some(([s2, e]) => s2 <= mid && mid <= e)).toBe(false);
  });

  it("makes reads inside those windows HITS — the point of doing it", async () => {
    const d = doc(big, { blockSize: BS });
    await d.cache.prime();
    const before = d.log.length;
    await d.cache.read(4096, 64);
    await d.cache.read(big - 2048, 64);
    expect(d.log.length).toBe(before);
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
    // Regression: the merged span refetched block 0, costing a tiny file two requests.
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
    expect(new Set(covered).size).toBe(covered.length);
  });
});

describe("the diagnostic logs", () => {
  it("stop at the cap and SAY they stopped, so a statistic over them is not a lie", async () => {
    // `reads` keeps counting past the cap while `readPattern` does not.
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
