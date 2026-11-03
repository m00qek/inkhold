// The block cache behind `ink.host_read`. MuPDF reads in small scattered bites;
// one request each would be slower than a whole download on 3G, so I/O is in
// blocks sized for latency and the small reads inside a block must be hits.
// No DOM, wasm or worker; tested against a fake transport.

export interface RangeResult {
  /** The requested window, `[start, end]` inclusive, never more. */
  bytes: Uint8Array;
  /**
   * The true length when the response says so (`content-range: .../N`, or a
   * `200`). The opening length is only a hint, and a too-long one makes MuPDF
   * look for `startxref` in bytes that don't exist.
   */
  total: number | null;
  whole: boolean;
}

/** Fetch `[start, end]` inclusive (HTTP's byte-range convention). */
export type RangeFetcher = (start: number, end: number) => Promise<RangeResult>;

/**
 * 32 KB, measured: page 1 of a real 79.5 MB document is ~100 scattered object
 * reads, so bigger blocks barely cut requests but balloon bytes (512 KB: 47 req,
 * 25.5 MB; 32 KB: 65 req, 3.8 MB). It equals `INK_STREAM_CHUNK` in
 * `pdf_shim.c`, so one MuPDF read spans at most two blocks (one coalesced request).
 */
export const BLOCK_SIZE = 32 * 1024;

/** 32 MB of blocks, LRU; an evicted block is a miss, not an error. */
export const CACHE_CAP_BYTES = 32 * 1024 * 1024;

/**
 * Blocks prefetched past a read that continues the previous one. Read-ahead on
 * every read doubled requests on real documents; sequential-only covers large
 * image streams.
 */
export const READ_AHEAD_BLOCKS = 4;

/**
 * The head and tail windows fetched at open, where the header, trailer and xref
 * live: 19 of page 1's 65 requests in measurement, covered by two (~0.7 MB
 * unused against ~17 saved round trips).
 */
export const PREFETCH_HEAD_BYTES = 1024 * 1024;
export const PREFETCH_TAIL_BYTES = 512 * 1024;

/** Log cap for reads and ranges; only tests and the acceptance report read them. */
const LOG_LIMIT = 512;

export interface PdfCacheStats {
  /** HTTP requests issued: page 1 must cost a handful, not 200. */
  requests: number;
  /** Bytes fetched, read-ahead included. */
  bytesFetched: number;
  /** Requests answered `200` (no `Range` support). */
  wholeResponses: number;
  reads: number;
  bytesRead: number;
  /** Reads served entirely from resident blocks. */
  hits: number;
  misses: number;
  blockSize: number;
  readAhead: number;
  blocksResident: number;
  bytesResident: number;
  evictions: number;
  /** Every range requested, in order, as `[start, end]`. */
  ranges: ReadonlyArray<readonly [number, number]>;
  /** Every MuPDF read as `[offset, length]`, capped at {@link LOG_LIMIT}. */
  readPattern: ReadonlyArray<readonly [number, number]>;
  /**
   * Whether either log hit its cap. Counters keep going past it, so a statistic
   * over a truncated log covers only the first {@link LOG_LIMIT} entries.
   */
  logTruncated: boolean;
}

export interface BlockCacheOptions {
  /** The document's byte length (a hint; the first response corrects it). */
  total: number;
  fetchRange: RangeFetcher;
  blockSize?: number;
  capBytes?: number;
  readAhead?: number;
}

const EMPTY = new Uint8Array(0);

/**
 * A bounded LRU block cache with sequential read-ahead. `read` returns
 * synchronously on a hit and a promise only on a miss: that is the JSPI contract
 * that makes hits free.
 */
export class BlockCache {
  private total: number;
  private readonly fetchRange: RangeFetcher;
  private readonly bs: number;
  private readonly cap: number;
  private readonly ahead: number;
  /** Insertion-ordered, so the first key is least recently used. */
  private readonly blocks = new Map<number, Uint8Array>();
  private readonly inflight = new Map<number, Promise<void>>();
  private resident = 0;
  private nextExpected = -1;
  private readonly ranges: Array<readonly [number, number]> = [];
  private readonly readPattern: Array<readonly [number, number]> = [];
  private counters = { requests: 0, bytesFetched: 0, wholeResponses: 0, reads: 0, bytesRead: 0, hits: 0, misses: 0, evictions: 0 };

  constructor(opts: BlockCacheOptions) {
    this.total = Math.max(0, opts.total);
    this.fetchRange = opts.fetchRange;
    this.bs = opts.blockSize ?? BLOCK_SIZE;
    this.cap = opts.capBytes ?? CACHE_CAP_BYTES;
    this.ahead = opts.readAhead ?? READ_AHEAD_BLOCKS;
  }

  /** Read up to `len` bytes at `off`; a short answer means EOF, as `pdf_shim.c` expects. */
  read(off: number, len: number): Uint8Array | Promise<Uint8Array> {
    const want = Math.max(0, Math.min(len, this.total - off));
    this.counters.reads++;
    this.counters.bytesRead += want;
    if (this.readPattern.length < LOG_LIMIT) this.readPattern.push([off, len]);
    // Recorded before the early return, so a read past the end breaks the run.
    const sequential = off === this.nextExpected;
    this.nextExpected = off + want;
    if (want === 0 || off < 0) {
      this.counters.hits++;
      return EMPTY;
    }
    const first = Math.floor(off / this.bs);
    const last = Math.floor((off + want - 1) / this.bs);

    const resident: Uint8Array[] = [];
    for (let i = first; i <= last; i++) {
      const b = this.touch(i);
      if (!b) break;
      resident.push(b);
    }
    if (resident.length === last - first + 1) {
      this.counters.hits++;
      if (sequential) this.prefetch(last + 1);
      return this.assemble(resident, first, off, want);
    }
    this.counters.misses++;
    return this.readSlow(first, last, off, want, sequential);
  }

  /** The caller's length hint, corrected by the first response. */
  get length(): number {
    return this.total;
  }

  /**
   * Fetch block 0 (MuPDF sniffs it first anyway) and settle the true length,
   * then the head and tail windows.
   */
  async prime(): Promise<void> {
    if (this.total <= 0) return;
    // Block 0 alone first: its `content-range` length aims the tail request,
    // which a stale `NoteMeta.size` would misplace.
    await this.request(0, 0).catch(() => {});
    if (this.total <= 0) return;

    const last = Math.floor((this.total - 1) / this.bs);
    const headEnd = Math.min(last, Math.ceil(PREFETCH_HEAD_BYTES / this.bs) - 1);
    const tailStart = Math.max(0, last - Math.ceil(PREFETCH_TAIL_BYTES / this.bs) + 1);

    // A file smaller than head+tail collapses to one span. Both start at block
    // 1, since block 0 is already resident.
    const spans: Array<[number, number]> =
      tailStart <= headEnd + 1 ? [[1, last]] : [[1, headEnd], [tailStart, last]];

    await Promise.all(
      spans
        .filter(([a, b]) => a <= b)
        .map(([a, b]) => this.request(a, b).catch(() => {})),
    );
  }

  stats(): PdfCacheStats {
    return {
      ...this.counters,
      blockSize: this.bs,
      readAhead: this.ahead,
      blocksResident: this.blocks.size,
      bytesResident: this.resident,
      ranges: this.ranges.slice(),
      readPattern: this.readPattern.slice(),
      logTruncated:
        this.counters.reads > LOG_LIMIT || this.counters.requests > LOG_LIMIT,
    };
  }

  // ---- internals ----

  private async readSlow(
    first: number,
    last: number,
    off: number,
    want: number,
    sequential: boolean,
  ): Promise<Uint8Array> {
    // Consecutive missing blocks become one request.
    const waits: Array<Promise<void>> = [];
    let runStart = -1;
    for (let i = first; i <= last + 1; i++) {
      // `touch`, not `has`: it also drops a short block from a wrong-length response.
      const missing = i <= last && this.touch(i) === null && !this.inflight.has(i);
      if (missing && runStart < 0) runStart = i;
      if (!missing && runStart >= 0) {
        waits.push(this.request(runStart, i - 1));
        runStart = -1;
      }
      if (i <= last) {
        const pending = this.inflight.get(i);
        if (pending) waits.push(pending);
      }
    }
    await Promise.all(waits);
    // Read-ahead is issued after the blocking work and never awaited.
    if (sequential) this.prefetch(last + 1);

    const parts: Uint8Array[] = [];
    for (let i = first; i <= last; i++) {
      const b = this.touch(i);
      // Evicted between fetch and here; not expected with a 32 MB cap, but checked.
      if (!b) return this.read(off, want);
      parts.push(b);
    }
    return this.assemble(parts, first, off, want);
  }

  /**
   * Queue `[from, to]` as one request. The range is never clamped to the
   * believed length: the server clamps and reports the real one, whereas
   * clamping to a stale short length stores a short block that reports EOF
   * mid-file (MuPDF then "repairs" a healthy document).
   */
  private request(from: number, to: number): Promise<void> {
    const start = from * this.bs;
    const end = (to + 1) * this.bs - 1;
    this.counters.requests++;
    if (this.ranges.length < LOG_LIMIT) this.ranges.push([start, end]);
    const run = (async () => {
      const { bytes, total, whole } = await this.fetchRange(start, end);
      this.counters.bytesFetched += bytes.length;
      if (whole) this.counters.wholeResponses++;
      if (total !== null && total > 0 && total !== this.total) this.total = total;
      for (let i = from; i <= to; i++) {
        const at = i * this.bs - start;
        if (at >= bytes.length) break;
        // `slice`, not `subarray`, so evicting one block frees its memory.
        this.store(i, bytes.slice(at, Math.min(at + this.bs, bytes.length)));
      }
    })().finally(() => {
      for (let i = from; i <= to; i++) {
        if (this.inflight.get(i) === run) this.inflight.delete(i);
      }
    });
    for (let i = from; i <= to; i++) this.inflight.set(i, run);
    return run;
  }

  /** Speculate on `ahead` blocks from `from`, coalesced; nothing waits on it. */
  private prefetch(from: number): void {
    let runStart = -1;
    let runEnd = -1;
    const flush = (): void => {
      if (runStart < 0) return;
      // Never an unhandled rejection; a later real read refetches and reports.
      void this.request(runStart, runEnd).catch(() => {});
      runStart = -1;
    };
    for (let i = from; i < from + this.ahead; i++) {
      if (i * this.bs >= this.total) break;
      if (this.touch(i) !== null || this.inflight.has(i)) {
        flush();
        continue;
      }
      if (runStart < 0) runStart = i;
      runEnd = i;
    }
    flush();
  }

  private assemble(parts: Uint8Array[], first: number, off: number, want: number): Uint8Array {
    const startIn = off - first * this.bs;
    if (parts.length === 1) {
      const only = parts[0]!;
      return only.subarray(startIn, Math.min(startIn + want, only.length));
    }
    const out = new Uint8Array(want);
    let at = 0;
    let skip = startIn;
    for (const part of parts) {
      const from = Math.min(skip, part.length);
      skip = 0;
      const take = Math.min(part.length - from, want - at);
      if (take <= 0) break;
      out.set(part.subarray(from, from + take), at);
      at += take;
    }
    return at === want ? out : out.subarray(0, at);
  }

  private expected(i: number): number {
    return Math.max(0, Math.min(this.bs, this.total - i * this.bs));
  }

  /**
   * A block marked most-recently-used, or null. A block shorter than its slot
   * (from a since-corrected length) is dropped rather than inventing a
   * mid-document EOF.
   */

  private touch(i: number): Uint8Array | null {
    const b = this.blocks.get(i);
    if (!b) return null;
    if (b.length < this.expected(i)) {
      this.blocks.delete(i);
      this.resident -= b.length;
      return null;
    }
    this.blocks.delete(i);
    this.blocks.set(i, b);
    return b;
  }

  private store(i: number, bytes: Uint8Array): void {
    const had = this.blocks.get(i);
    if (had) this.resident -= had.length;
    this.blocks.set(i, bytes);
    this.resident += bytes.length;
    while (this.resident > this.cap && this.blocks.size > 1) {
      const oldest = this.blocks.keys().next();
      if (oldest.done) break;
      const victim = this.blocks.get(oldest.value)!;
      this.blocks.delete(oldest.value);
      this.resident -= victim.length;
      this.counters.evictions++;
    }
  }
}
