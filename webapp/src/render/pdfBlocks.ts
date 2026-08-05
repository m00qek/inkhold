// The BLOCK CACHE behind `ink.host_read` — `docs/scratch/pdf-ranges.md` §3.
//
// MuPDF reads in small bites: a few hundred bytes of trailer, a couple of
// kilobytes of xref, an object here and there. Turning each of those into an
// HTTP request would be SLOWER THAN DOWNLOADING THE WHOLE FILE on a 3G link —
// ~30 s of almost pure latency against ~7 min of transfer, yes, but also against
// ~3 s for the same work done in blocks. So the unit of I/O is a block, the
// block size is a LATENCY decision rather than a memory one, and the small reads
// inside a block must be hits.
//
// No DOM, no wasm, no worker: this is a cache over a range-fetching function,
// which is why it can be unit-tested against a fake transport.

/** What one range request brought back. */
export interface RangeResult {
  /** The requested window, `[start, end]` inclusive — never more. */
  bytes: Uint8Array;
  /**
   * The document's TRUE length, when the response said so: `content-range`
   * ends in `/N`, and a `200` means the body IS the whole file.
   *
   * The length the caller opened with is only a hint — `NoteMeta.size` can be
   * stale, and a fake or a proxy can be wrong about it outright. Believing a
   * wrong length is not a small error: MuPDF seeks to the end to find
   * `startxref`, so a document that claims to be longer than it is has its
   * trailer looked for in bytes that do not exist.
   */
  total: number | null;
  /** The server ignored `Range` and sent everything. */
  whole: boolean;
}

/** Fetch `[start, end]` INCLUSIVE, HTTP's own convention for a byte range. */
export type RangeFetcher = (start: number, end: number) => Promise<RangeResult>;

/**
 * 32 KB — NOT the 512 KB the plan guessed, and the difference is measured.
 *
 * `pdf-ranges.md` §3 reasoned about latency: a 512 KB block is ~2.7 s of 3G
 * transfer against 0.15 s of round trip, ~5% overhead, where 64 KB would be 30%.
 * That arithmetic is right and it is about the wrong thing, because it assumes
 * the bytes in a block get USED. Recording every read MuPDF makes for page 1 of
 * the two real documents (§6.2) says they do not: the pattern is ~100 SCATTERED
 * 32 KB object lookups — the page-tree walk alone touches all 77 page objects,
 * spread through 79 MB — with almost no sequential run. So the block size barely
 * moves the request count and moves the byte count enormously:
 *
 * | 79.5 MB, linearized | requests | fetched | 3G, serial |
 * |---|---:|---:|---:|
 * | 512 KB blocks | 47 | 25.5 MB | ~138 s |
 * |  64 KB blocks | 58 |  5.5 MB |  ~37 s |
 * |  32 KB blocks | 65 |  3.8 MB |  ~29 s |
 * |  16 KB blocks | 69 |  3.0 MB |  ~26 s |
 *
 * 16 KB is marginally cheaper still, and 32 KB is chosen over it for a
 * structural reason rather than a modelled second: it is exactly
 * `INK_STREAM_CHUNK` in `pdf_shim.c`, so ONE MuPDF read can never span more than
 * two blocks and the coalescing below always folds it into a single request.
 */
export const BLOCK_SIZE = 32 * 1024;

/**
 * 32 MB of blocks, evicted LRU. A 76 MB document must not become 76 MB of
 * cache; MuPDF re-reading an evicted block is a miss, not an error.
 *
 * Generous now that a block is 32 KB — page 1 of the 79 MB document is under
 * 4 MB resident — but it is a CEILING, and the thing it is a ceiling on (paging
 * through a long book) is what would otherwise accumulate the whole file.
 */
export const CACHE_CAP_BYTES = 32 * 1024 * 1024;

/**
 * Blocks fetched speculatively past a read that CONTINUES the previous one.
 *
 * The "sequential" qualifier is the whole of it. Read-ahead applied to every
 * read — which is what the plan said, and what this did first — was a pure loss
 * on both real documents: it roughly DOUBLED the request count (69 → 129 at
 * 16 KB) and added 25-60% to the bytes, because a scattered lookup's next read
 * is nowhere near this one. Restricted to reads that begin exactly where the
 * last one ended, four blocks cost one extra request across both documents and
 * are still there for the case this is insurance against — a page whose content
 * is one large image stream, read straight through.
 */
export const READ_AHEAD_BLOCKS = 4;

/**
 * The speculative windows fetched at open, in bytes: the FRONT of the file and
 * its TAIL.
 *
 * Measured, not guessed. Opening page 1 of a 79.5 MB document issues 65
 * requests, and **19 of them land in these two windows** — 13 in the first 1 MB
 * and 6 in the last 512 KB, which is where the trailer and the xref live.
 * MuPDF reaches the tail immediately (its second read of that document is
 * `[79521777, 1024]`, the trailer) and then walks back and forth between the two
 * regions. Two speculative requests cover all 19.
 *
 * Why these ARE worth speculating on, when read-ahead generally is not: they are
 * the only two regions every PDF is guaranteed to need. The trailer says where
 * the xref is, the xref says where everything else is, and the header identifies
 * the file — none of that is optional and none of it depends on which page is
 * wanted. The scattered mid-file object reads that make up the other 46 requests
 * are genuinely unpredictable, which is why blind read-ahead lost (§5.7).
 *
 * The cost is ~0.7 MB fetched and not used, against ~17 saved round trips —
 * 7 seconds on a 400 ms link. On a fast link it is a small waste; on the link
 * this design targets it is the trade the whole file exists to make.
 */
export const PREFETCH_HEAD_BYTES = 1024 * 1024;
export const PREFETCH_TAIL_BYTES = 512 * 1024;

/**
 * How many `(offset, length)` reads and issued ranges to remember.
 *
 * 512, down from 20,000. NOTHING IN THE APP READS THESE — the only consumers
 * are `pdfBlocks.test.ts`, which asserts exact contents on fixtures a few reads
 * long, and the throttled acceptance spec's `report()`, which prints the first
 * 40 and a median. Page 1 of the largest document measured is 101 reads, so the
 * whole subject of every measurement fits well inside this.
 *
 * 20,000 two-element arrays apiece is a couple of megabytes of worker heap held
 * for nobody, and `stats()` shallow-copies both on every call — once per
 * document opened. A ceiling that no measurement approaches is not a safety
 * margin, it is just a bigger number.
 */
const LOG_LIMIT = 512;

export interface PdfCacheStats {
  /** HTTP requests issued. THE number: page 1 must cost a handful, not 200. */
  requests: number;
  /** Bytes the requests brought back, read-ahead included. */
  bytesFetched: number;
  /** Requests answered `200` — a server with no `Range` support. */
  wholeResponses: number;
  /** Calls into `ink.host_read`. */
  reads: number;
  /** Bytes those calls asked for. */
  bytesRead: number;
  /** Reads served entirely from resident blocks — no suspension, no request. */
  hits: number;
  /** Reads that had to wait for at least one block. */
  misses: number;
  blockSize: number;
  readAhead: number;
  blocksResident: number;
  bytesResident: number;
  evictions: number;
  /** Every range requested, in order, as `[start, end]`. */
  ranges: ReadonlyArray<readonly [number, number]>;
  /**
   * Every read MuPDF asked for, as `[offset, length]` — the answer to
   * `pdf-ranges.md` §6.2, "does MuPDF re-read the same ranges pathologically?".
   *
   * Capped at {@link LOG_LIMIT}; see {@link logTruncated} before drawing any
   * conclusion from its length or from a statistic over it.
   */
  readPattern: ReadonlyArray<readonly [number, number]>;
  /**
   * Whether either log hit its cap and stopped recording.
   *
   * A truncated log must SAY so: `reads` and `requests` keep counting past the
   * cap, so a median or a count taken over `readPattern` after this goes true is
   * a statistic about the first {@link LOG_LIMIT} entries wearing the name of
   * the whole session. Silent truncation reads as complete coverage.
   */
  logTruncated: boolean;
}

export interface BlockCacheOptions {
  /** The document's byte length. `NoteMeta.size` already carries it (§2.4). */
  total: number;
  fetchRange: RangeFetcher;
  blockSize?: number;
  capBytes?: number;
  readAhead?: number;
}

const EMPTY = new Uint8Array(0);

/**
 * A bounded, LRU, read-ahead block cache over a byte-range transport.
 *
 * `read` returns a `Uint8Array` SYNCHRONOUSLY when every block it needs is
 * resident, and a promise otherwise. That union is not a convenience: it is the
 * JSPI contract. A `Suspending` import that returns a plain value does not
 * suspend the wasm stack, so a cache hit costs MuPDF nothing at all, and only a
 * genuine miss pays for moving the stack.
 */
export class BlockCache {
  private total: number;
  private readonly fetchRange: RangeFetcher;
  private readonly bs: number;
  private readonly cap: number;
  private readonly ahead: number;
  /** Insertion-ordered, so the first key is the least recently used. */
  private readonly blocks = new Map<number, Uint8Array>();
  private readonly inflight = new Map<number, Promise<void>>();
  private resident = 0;
  /** Where a read would have to start to be a continuation of the last one. */
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

  /**
   * Read up to `len` bytes at `off`, clamped to the document.
   *
   * A short answer is legitimate and means end-of-file; the stream in
   * `pdf_shim.c` treats zero bytes as EOF, so a read past the end is not an
   * error to report but a document that ended.
   */
  read(off: number, len: number): Uint8Array | Promise<Uint8Array> {
    const want = Math.max(0, Math.min(len, this.total - off));
    this.counters.reads++;
    this.counters.bytesRead += want;
    if (this.readPattern.length < LOG_LIMIT) this.readPattern.push([off, len]);
    // Does this read CONTINUE the last one? That single bit is what makes
    // read-ahead worth having rather than a way to double the traffic — see
    // `READ_AHEAD_BLOCKS`. Recorded before the early return, so a read past the
    // end breaks the run rather than pretending to extend it.
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

  /** The document's length: the caller's hint, corrected by the first response. */
  get length(): number {
    return this.total;
  }

  /**
   * Fetch block 0 and settle the document's length before anything is opened.
   *
   * Not a speculation that might be wasted: MuPDF sniffs the file's first bytes
   * to recognise it, so block 0 is the one block EVERY document needs, and a
   * linearized file has page 1 in it too (§3). Waiting for it here costs the
   * round trip that `ink_open_stream`'s first read would have cost anyway, and
   * buys the true length off `content-range` — see `RangeResult.total`.
   */
  async prime(): Promise<void> {
    if (this.total <= 0) return;
    // Block 0 first, and AWAITED alone: it carries the true length off
    // `content-range`, which the tail window's arithmetic depends on. A stale
    // `NoteMeta.size` would otherwise aim the tail request at the wrong end of
    // the file — the same class of bug as the short-block one, and it would only
    // show on a document whose size had changed.
    await this.request(0, 0).catch(() => {});
    if (this.total <= 0) return;

    const last = Math.floor((this.total - 1) / this.bs);
    const headEnd = Math.min(last, Math.ceil(PREFETCH_HEAD_BYTES / this.bs) - 1);
    const tailStart = Math.max(0, last - Math.ceil(PREFETCH_TAIL_BYTES / this.bs) + 1);

    // Two windows, and they are allowed to be one: a file smaller than
    // head+tail collapses to a single span rather than fetching the middle twice.
    // Both forms START AT 1: block 0 is already resident from the await above,
    // and re-requesting it would double the cost of a document small enough to
    // fit in one block — which the committed 688-byte fixture caught.
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

  // --- internals ----------------------------------------------------------

  private async readSlow(
    first: number,
    last: number,
    off: number,
    want: number,
    sequential: boolean,
  ): Promise<Uint8Array> {
    // Consecutive MISSING blocks become ONE request, so a read that straddles a
    // boundary costs one round trip rather than two.
    const waits: Array<Promise<void>> = [];
    let runStart = -1;
    for (let i = first; i <= last + 1; i++) {
      // `touch`, not `has`: it is also what drops a block left short by a
      // response taken against a length we have since learned was wrong.
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
    // Read-ahead is issued AFTER the blocking work, and never awaited: waiting
    // on it would add to the time to first paint to save a later round trip.
    if (sequential) this.prefetch(last + 1);

    const parts: Uint8Array[] = [];
    for (let i = first; i <= last; i++) {
      const b = this.touch(i);
      // Evicted between the fetch and here. Not reachable with a 32 MB cap and
      // reads of two blocks, but "not reachable" is not "is checked".
      if (!b) return this.read(off, want);
      parts.push(b);
    }
    return this.assemble(parts, first, off, want);
  }

  /**
   * Queue `[from, to]` as one request, and register every block against it.
   *
   * The range asked for is the FULL span of those blocks, never clamped to the
   * length we think the document has. Two reasons, and the second one is a bug
   * this had: a server clamps an over-long range itself and tells us the real
   * length in `content-range`, so asking long is how the length gets corrected
   * for free; and clamping to a length that turns out to be TOO SMALL stores a
   * SHORT BLOCK, which then answers reads past its end with EOF. A 76 MB
   * document opened with a stale 400 KB size did exactly that — MuPDF saw the
   * file end at 400 KB, declared it damaged and went into repair.
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
        // `slice`, not `subarray`: a view would pin the whole run's buffer, so
        // evicting one block of a three-block run would free nothing.
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

  /**
   * Speculate on `ahead` blocks from `from`, coalesced into as few requests as
   * their gaps allow — four adjacent blocks are one 128 KB request, not four.
   * Nothing waits on the result; a read that arrives there finds it in flight.
   */
  private prefetch(from: number): void {
    let runStart = -1;
    let runEnd = -1;
    const flush = (): void => {
      if (runStart < 0) return;
      // Nothing awaits this, so a failed speculation must not become an
      // unhandled rejection — a later real read will fetch it again and report.
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

  /** How long block `i` is in a document of the length we currently believe. */
  private expected(i: number): number {
    return Math.max(0, Math.min(this.bs, this.total - i * this.bs));
  }

  /**
   * Fetch a block and mark it most-recently-used; null when it is not resident.
   *
   * A block that is SHORTER than its slot is treated as absent and dropped. It
   * can only have come from a response taken against a length we have since
   * learned was wrong, and serving reads out of it would report EOF in the
   * middle of the document — the one failure a cache must never invent.
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
