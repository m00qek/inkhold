// The LOCAL SEARCH INDEX — `golden-search.md` §4.1's one FTS5 table, driven
// through the `idx_*` ABI of the shipped `sqlite-core.wasm`. Build it from the
// per-page term rows the stream delivers (§2.2), query it, serialize it, restore
// it. No network, no IndexedDB, no DOM: the streaming and the storing are
// `cache/`'s, and nothing here knows where the rows came from or where the image
// goes.
//
// The ABI contract, including the two traps this file is written around, is the
// header of `webapp/wasm/sqlite_core.zig`. Read that before changing anything
// here.
//
// ## The engine is NOT instantiated until someone searches
//
// §4.2 is explicit and it is the reason `open()` is a function rather than a
// module-level constant: `WebAssembly.instantiate` allocates a **16.13 MB**
// static footprint (MEASURED, §8.1), and a household member who never types in
// the search box must never pay it. Streaming the rows into IndexedDB involves
// no wasm at all; this module wakes up on the first query.
//
// The compiled `WebAssembly.Module` is cached and the *instance* is not, which
// is the split that makes §4.2's "dropping" real: dropping the index means
// discarding the instance (wasm linear memory never shrinks, so `DROP TABLE`
// returns nothing to the browser), and a memoised instance — the shape
// `spdDecode.ts` uses, correctly, for a decoder two callers share — could never
// be dropped. Re-opening then re-instantiates 16 MB of memory but not 828 KB of
// code.
//
// ## `page_of` / `doc_of` live HERE, in TypeScript, not in the wasm
//
// §4.1 draws three tables; the shipped artifact has one, because `idx_add` takes
// a `u32` rowid and `idx_hit` hands that same rowid back. So the client assigns
// a global rowid per (document, page) and keeps `rowid -> (md5, page)` beside
// the manifest it already holds — which is where `file_id` and `updated_at` are
// anyway (`manifestCodec.ts`), so `doc_of` would have been a second opinion
// about them. No wasm rebuild, and it is exactly the shape §8.1's 23,997-row
// measurement used.
//
// The consequence to hold onto: **the mapping is part of the index.** A stored
// image whose rowid table was lost answers with integers nobody can name, so
// `serialize()` returns both and `restore()` takes both.
//
// ## The query string goes to the wasm RAW
//
// `idx_query` folds the user's text through the index's own tokenizer before
// building the MATCH expression. Folding or escaping it here would be the second
// tokenizer implementation this whole design exists to avoid, and a JS escaper
// would have to guess what FTS5 makes of `-` — guessing wrong is a syntax error
// on a keystroke. A query that folds to no terms is **zero results and not an
// error**; that is the behaviour, not a fallback.
//
// ## Two versions, and they are not the same version
//
// A snapshot carries `schemaVersion` (the wasm's `idx_schema_version()` — the
// DDL and its `tokenize=`) and `mappingVersion` (this file's rowid-table shape).
// Either can change with **nothing server-side moving**, which is precisely why
// the server's `index_version` cannot stand in for them: it would still agree
// while a stored image had become unreadable.

/** The `idx_*` half of `sqlite-core.wasm` (`webapp/wasm/sqlite_core.zig`). */
export interface SearchCoreExports {
  memory: WebAssembly.Memory;
  /** WASI reactor: run libc/C constructors once before any `idx_*` call. */
  _initialize?(): void;
  idx_alloc(len: number): number;
  idx_free(ptr: number, len: number): void;
  idx_schema_version(): number;
  idx_open(): number;
  idx_close(): void;
  idx_begin(): number;
  idx_commit(): number;
  idx_add(rowid: number, ptr: number, len: number): number;
  idx_query(ptr: number, len: number, limit: number): number;
  idx_hit(i: number): number;
  idx_serialize(): number;
  idx_image_ptr(): number;
  idx_image_alloc(len: number): number;
  idx_deserialize(ptr: number, len: number): number;
  idx_errmsg_ptr(): number;
  idx_errmsg_len(): number;
}

/** How this file spells a rowid table. Bump when `SnapshotDoc` changes shape. */
export const MAPPING_FORMAT_VERSION = 1;

export const DEFAULT_WASM_URL = "/sqlite-core.wasm";

/** One line of a terms record (§2.2): the page ordinal and its folded terms. */
export interface TermsPage {
  /** The page ordinal — a `.note` page, a PDF page, a `.txt` paragraph. */
  p: number;
  /** That page's terms, already folded by the server's tokenizer. */
  t: string;
}

/** One document's rows, as the stream delivers them. */
export interface TermsDocument {
  md5: string;
  pages: readonly TermsPage[];
}

/** Where a hit is: the document's md5 and the page ordinal within it. */
export interface PageRef {
  md5: string;
  page: number;
}

/**
 * A query's answer. `total` is EXACT and independent of `limit` — §9.5 retires
 * the server's "N+" floors precisely because a client holding the index has
 * already paid for the count.
 */
export interface QueryResult {
  total: number;
  /** bm25 rank order, capped at `limit`. Reordering is the caller's business. */
  hits: PageRef[];
}

/** One document in a snapshot's rowid table. */
export interface SnapshotDoc {
  md5: string;
  /** The rowid of `pages[0]`; page `i` of this document is `firstRowid + i`. */
  firstRowid: number;
  /** Page ordinals, in insertion order. Not necessarily dense or sorted. */
  pages: Uint32Array;
}

/**
 * What persistence stores: the serialized database and the rowid table that
 * gives its integers meaning, under the two versions that can invalidate them.
 *
 * Structured-clonable as it stands, so IndexedDB takes it without a codec. There
 * is deliberately no byte format here — `manifestCodec.ts` and `wantBitmap.ts`
 * are hand-rolled because a SERVER encodes or decodes the other end and the two
 * must be pinned to each other. Nothing else reads this one.
 */
export interface IndexSnapshot {
  /** `idx_schema_version()` at the time of the write. */
  schemaVersion: number;
  /** `MAPPING_FORMAT_VERSION` at the time of the write. */
  mappingVersion: number;
  /** `sqlite3_serialize` output — 10.36 MB for the whole library (§8.1). */
  image: Uint8Array;
  docs: SnapshotDoc[];
}

/** An `idx_*` call refused. `rc` is the module's return, `-rc` of a SQLite code. */
export class SearchIndexError extends Error {
  readonly rc: number;
  constructor(call: string, rc: number, detail: string) {
    super(detail ? `${call} failed (${rc}): ${detail}` : `${call} failed (${rc})`);
    this.name = "SearchIndexError";
    this.rc = rc;
  }
}

/**
 * A stored snapshot was built by a different index shape. NOT a corruption and
 * not a bug: it is the signal to throw the record away and rebuild from the rows
 * in IndexedDB, which is a path that has to exist anyway because the store is
 * evictable (§4.2).
 */
export class StaleSnapshotError extends Error {
  constructor(what: string, want: number, got: number) {
    super(`stored index has ${what} ${got}, this build wants ${want}`);
    this.name = "StaleSnapshotError";
  }
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * Fetch and COMPILE the module, once per URL. What is cached is the compiled
 * code — not an instance, see the header: the instance is the 16 MB, and it has
 * to stay droppable.
 */
const compiled = new Map<string, Promise<WebAssembly.Module>>();

function compileCore(url: string): Promise<WebAssembly.Module> {
  const hit = compiled.get(url);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
    try {
      // Fast path: needs `Content-Type: application/wasm` from the server.
      return await WebAssembly.compileStreaming(res.clone());
    } catch {
      return await WebAssembly.compile(await res.arrayBuffer());
    }
  })();
  compiled.set(url, p);
  return p;
}

/** How `SearchIndex` gets an instance. Injectable so tests can supply their own. */
export type CoreLoader = () => Promise<SearchCoreExports>;

/** The default loader: a FRESH instance of the cached module. Zero imports. */
export function browserCoreLoader(url: string = DEFAULT_WASM_URL): CoreLoader {
  return async () => {
    const mod = await compileCore(url);
    const instance = await WebAssembly.instantiate(mod, {});
    const core = instance.exports as unknown as SearchCoreExports;
    // Reactor model: run libc/C constructors (registers the null VFS) once.
    core._initialize?.();
    return core;
  };
}

/**
 * The rowid table. Documents are appended in build order, so `firstRowid` is
 * ascending and a rowid is found by binary search rather than by a `Map` with
 * one entry per page — 23,997 entries where 1,222 will do.
 */
class RowidTable {
  private readonly docs: SnapshotDoc[] = [];
  private readonly seen = new Set<string>();
  private next = 1;

  /** Rowids start at 1 so that `idx_hit`'s -1 sentinel can never be one. */
  get nextRowid(): number {
    return this.next;
  }

  get documentCount(): number {
    return this.docs.length;
  }

  get pageCount(): number {
    return this.next - 1;
  }

  add(md5: string, pages: readonly number[]): number {
    if (this.seen.has(md5)) throw new Error(`document ${md5} is already in this index`);
    const firstRowid = this.next;
    this.seen.add(md5);
    this.docs.push({ md5, firstRowid, pages: Uint32Array.from(pages) });
    this.next += pages.length;
    return firstRowid;
  }

  lookup(rowid: number): PageRef | null {
    let lo = 0;
    let hi = this.docs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const doc = this.docs[mid]!;
      if (rowid < doc.firstRowid) hi = mid - 1;
      else if (rowid >= doc.firstRowid + doc.pages.length) lo = mid + 1;
      else return { md5: doc.md5, page: doc.pages[rowid - doc.firstRowid]! };
    }
    return null;
  }

  md5s(): string[] {
    return this.docs.map((d) => d.md5);
  }

  snapshot(): SnapshotDoc[] {
    // Copied: the caller may hold this across further builds, and `pages` is a
    // view onto a typed array this table keeps mutating nothing but appending to.
    return this.docs.map((d) => ({ md5: d.md5, firstRowid: d.firstRowid, pages: d.pages.slice() }));
  }

  static from(docs: readonly SnapshotDoc[]): RowidTable {
    const t = new RowidTable();
    for (const d of docs) {
      // `lookup` binary-searches, so ascending `firstRowid` is a precondition,
      // not a coincidence of build order. A stored record that lost the order
      // would otherwise answer with the wrong page rather than fail.
      if (d.firstRowid < t.next) {
        throw new Error(`snapshot rowid table is out of order at ${d.md5}`);
      }
      t.seen.add(d.md5);
      t.docs.push({ md5: d.md5, firstRowid: d.firstRowid, pages: Uint32Array.from(d.pages) });
      t.next = d.firstRowid + d.pages.length;
    }
    return t;
  }
}

/**
 * One open index on one wasm instance.
 *
 * LIFETIME RULE, and it is the hazard every method here is written around:
 * `memory.buffer` is replaced whenever linear memory grows, and ANY call can
 * grow it. So every `Uint8Array` view is built AFTER the call that produced the
 * pointer it wraps, and never kept across another call. Wasm pointers themselves
 * stay valid; only the JS views detach.
 */
export class SearchIndex {
  private readonly core: SearchCoreExports;
  private table: RowidTable;
  /** A reused UTF-8 staging buffer: one `idx_alloc` for a whole build, not 24k. */
  private scratchPtr = 0;
  private scratchCap = 0;
  private closed = false;

  private constructor(core: SearchCoreExports, table: RowidTable) {
    this.core = core;
    this.table = table;
  }

  /** Instantiate the module and open an empty index. This is the 16 MB (§4.2). */
  static async open(load: CoreLoader = browserCoreLoader()): Promise<SearchIndex> {
    const core = await load();
    const index = new SearchIndex(core, new RowidTable());
    index.check("idx_open", core.idx_open());
    return index;
  }

  /**
   * Instantiate and restore a stored snapshot — the second-visit path, 5.93 ms
   * for the library's 10.36 MB image (§8.1), against 703 ms to build it.
   */
  static async restore(
    snapshot: IndexSnapshot,
    load: CoreLoader = browserCoreLoader(),
  ): Promise<SearchIndex> {
    const core = await load();
    const index = new SearchIndex(core, new RowidTable());
    index.deserialize(snapshot);
    return index;
  }

  /** The wasm's index-schema version — what a snapshot must match to be usable. */
  get schemaVersion(): number {
    return this.core.idx_schema_version();
  }

  get documentCount(): number {
    return this.table.documentCount;
  }

  get pageCount(): number {
    return this.table.pageCount;
  }

  /** The md5s this index holds, in build order. */
  documents(): string[] {
    return this.table.md5s();
  }

  /**
   * Throw the contents away and start over on the SAME instance.
   *
   * §4.1 measured this and it is why the instance need not be discarded:
   * `idx_open()` returns the closed database's pages to SQLite's heap *inside*
   * linear memory, so the next build reuses that space instead of growing past
   * it. Four documents through one instance converged on the cost of the single
   * worst one whichever order they came in.
   */
  reset(): void {
    this.assertOpen();
    this.table = new RowidTable();
    this.check("idx_open", this.core.idx_open());
  }

  /**
   * Index every page of every document under one transaction.
   *
   * The transaction is not an optimisation to taste: FTS5 flushes its pending
   * in-memory index to a new level-0 segment at every COMMIT, so 24k
   * autocommitted inserts are 24k segments and the merges behind them.
   *
   * A failure mid-build leaves an open transaction and a half-built table, so it
   * resets rather than committing what got in — a partial index is worse than no
   * index, because it answers.
   */
  build(docs: Iterable<TermsDocument>): void {
    this.assertOpen();
    this.check("idx_begin", this.core.idx_begin());
    try {
      for (const doc of docs) this.addDocument(doc);
    } catch (err) {
      // Best effort, and the original failure is what the caller needs to see:
      // a reset that fails too would otherwise replace the diagnosis with its
      // own symptom.
      try {
        this.reset();
      } catch {
        /* ignore */
      }
      throw err;
    }
    this.check("idx_commit", this.core.idx_commit());
  }

  /**
   * One document's rows, assigning them rowids and recording the mapping.
   *
   * Called inside `build`'s transaction. The same md5 twice is refused HERE
   * rather than by the wasm: `idx_add` catches a repeated ROWID, and these
   * rowids are freshly assigned, so a document indexed twice would sail through
   * and simply answer every query twice. That is a caller bug — two manifests
   * mixed — and it should say so instead of doubling the counts §4.3 ranks by.
   */
  addDocument(doc: TermsDocument): void {
    this.assertOpen();
    const base = this.table.add(
      doc.md5,
      doc.pages.map((row) => row.p),
    );
    for (let i = 0; i < doc.pages.length; i++) {
      this.addPage(base + i, doc.pages[i]!.t);
    }
  }

  /**
   * One FTS5 row: `rowid -> terms`. The raw ABI, for a caller that owns its own
   * rowid assignment; `addDocument` is the one that keeps the mapping honest.
   *
   * The terms arrive already folded (§2.2) and FTS5 tokenizes them again. That
   * re-tokenization is a no-op BY CONSTRUCTION, not by luck: a token that came
   * out of `unicode61 remove_diacritics 2` cannot contain a character that
   * tokenizer treats as a separator.
   */
  addPage(rowid: number, terms: string): void {
    this.assertOpen();
    const len = this.stage(terms);
    this.check("idx_add", this.core.idx_add(rowid, this.scratchPtr, len));
  }

  /**
   * Run a query. `text` is the user's RAW string — see the header; folding it
   * here would be the second tokenizer.
   *
   * `limit` caps only what is returned. The total is the whole match count, and
   * stepping the whole rank-ordered result is 37.9 ms at the library's
   * pathological `con*` (5,642 pages) and 1.3–7.5 ms for ordinary queries (§8.1).
   */
  query(text: string, limit: number): QueryResult {
    this.assertOpen();
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`bad limit ${limit}`);
    const len = this.stage(text);
    const total = this.core.idx_query(this.scratchPtr, len, limit);
    this.check("idx_query", total);
    const hits: PageRef[] = [];
    const n = Math.min(total, limit);
    for (let i = 0; i < n; i++) {
      const rowid = this.core.idx_hit(i);
      if (rowid < 0) break;
      const ref = this.table.lookup(rowid);
      // The image and the rowid table disagree — the one corruption that would
      // otherwise surface as a result row pointing at nothing.
      if (!ref) throw new Error(`rowid ${rowid} is not in the index's rowid table`);
      hits.push(ref);
    }
    return { total, hits };
  }

  /** Serialize the database and the rowid table together. Both, or neither. */
  serialize(): IndexSnapshot {
    this.assertOpen();
    const len = this.core.idx_serialize();
    this.check("idx_serialize", len);
    const image = new Uint8Array(len);
    // The pointer is read AFTER the call that produced it, and the copy happens
    // before anything else can grow memory out from under the view.
    image.set(new Uint8Array(this.core.memory.buffer, this.core.idx_image_ptr(), len));
    return {
      schemaVersion: this.core.idx_schema_version(),
      mappingVersion: MAPPING_FORMAT_VERSION,
      image,
      docs: this.table.snapshot(),
    };
  }

  /**
   * Replace this index's contents with a stored snapshot.
   *
   * TRAP 1 (`sqlite_core.zig`'s header): the target must come from
   * `idx_image_alloc` — SQLite's own heap — because `FREEONCLOSE` hands the
   * buffer back to `sqlite3_free`, and an `idx_alloc` pointer would be a
   * cross-allocator free. TRAP 2 is handled inside that call, which is where it
   * bites: on a fresh instance restoring from IndexedDB this is the FIRST call
   * into SQLite, and `sqlite3_malloc64` traps until `sqlite3_initialize` has run.
   *
   * `idx_deserialize` TAKES OWNERSHIP: there is no free here, and there must not
   * be one.
   */
  deserialize(snapshot: IndexSnapshot): void {
    this.assertOpen();
    const want = this.core.idx_schema_version();
    if (snapshot.schemaVersion !== want) {
      throw new StaleSnapshotError("index-schema version", want, snapshot.schemaVersion);
    }
    if (snapshot.mappingVersion !== MAPPING_FORMAT_VERSION) {
      throw new StaleSnapshotError("mapping version", MAPPING_FORMAT_VERSION, snapshot.mappingVersion);
    }
    const len = snapshot.image.length;
    const dst = this.core.idx_image_alloc(len);
    if (dst === 0) throw new Error(`idx_image_alloc(${len}) returned null`);
    new Uint8Array(this.core.memory.buffer, dst, len).set(snapshot.image);
    this.check("idx_deserialize", this.core.idx_deserialize(dst, len));
    this.table = RowidTable.from(snapshot.docs);
  }

  /**
   * Close the database. The INSTANCE survives, and so does its linear memory —
   * dropping that means dropping every reference to this object (§4.2). Closing
   * is what makes the next `SearchIndex.open` on a new instance the only way to
   * hand memory back, and §4.1 measured that as an option rather than a duty.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.scratchCap > 0) {
      this.core.idx_free(this.scratchPtr, this.scratchCap);
      this.scratchPtr = 0;
      this.scratchCap = 0;
    }
    this.core.idx_close();
  }

  // --------------------------------------------------------------------------

  /** UTF-8 `text` into the staging buffer; returns its byte length. */
  private stage(text: string): number {
    const bytes = ENCODER.encode(text);
    // One byte more than the text, always: the empty query is a real case (the
    // search box before anything is typed) and a zero-length allocation has no
    // address worth handing across the boundary.
    this.reserve(bytes.length + 1);
    new Uint8Array(this.core.memory.buffer, this.scratchPtr, this.scratchCap).set(bytes);
    return bytes.length;
  }

  private reserve(need: number): void {
    if (this.scratchCap >= need) return;
    // Doubling, so a build of 24k rows reallocates a handful of times rather
    // than once per row that happens to be longer than the last.
    const cap = Math.max(need, this.scratchCap * 2, 1024);
    const ptr = this.core.idx_alloc(cap);
    if (ptr === 0) throw new Error(`idx_alloc(${cap}) returned null`);
    if (this.scratchCap > 0) this.core.idx_free(this.scratchPtr, this.scratchCap);
    this.scratchPtr = ptr;
    this.scratchCap = cap;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("this SearchIndex is closed");
  }

  /** Negative is `-rc`; anything else is the call's own result and is fine. */
  private check(call: string, rc: number): void {
    if (rc >= 0) return;
    throw new SearchIndexError(call, rc, this.errorText());
  }

  /**
   * The module's last error message. Set on FAILURE and never cleared, so it is
   * read ONLY after a negative return — otherwise it is whatever failed last,
   * which reads like a fresh diagnosis and is not one.
   */
  private errorText(): string {
    const n = this.core.idx_errmsg_len();
    if (n === 0) return "";
    return DECODER.decode(new Uint8Array(this.core.memory.buffer, this.core.idx_errmsg_ptr(), n).slice());
  }
}
