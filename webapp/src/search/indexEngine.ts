// The LOCAL SEARCH INDEX — §4.1's one FTS5 table, driven
// through the `idx_*` ABI of `sqlite-core.wasm`. Synchronous, because that is
// the ABI's shape; `searchEngine.ts` puts it behind a worker. No network, no
// IndexedDB, no DOM. The ABI contract, including the two traps `deserialize`
// is written around, is the header of `webapp/wasm/sqlite_core.zig`.
//
// What this must not break:
//   * `open()` is a function, not a module-level constant: `instantiate`
//     allocates a 16.13 MB static footprint (§8.1) and a member who never
//     searches must never pay it (§4.2).
//   * The compiled `Module` is cached; the INSTANCE is not. Linear memory never
//     shrinks, so dropping the index means dropping the instance, and a
//     memoised instance could never be dropped.
//   * The rowid table is PART of the index: `serialize()` returns both and
//     `restore()` takes both. Its `mappingVersion` and the wasm's
//     `schemaVersion` can each change with nothing server-side moving, so
//     `index_version` cannot stand in for them.
//   * The query string goes to the wasm RAW: folding or escaping it here is the
//     second tokenizer this design exists to avoid.

import type { Expansion } from "./localSearch";

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
  /** `idx_query` plus the typo ladder, which fires only on a total of 0. */
  idx_fuzzy(ptr: number, len: number, limit: number): number;
  /** `typed \t matched \n` pairs, rewritten by every query of either kind. */
  idx_expansion_ptr(): number;
  idx_expansion_len(): number;
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

/** A query's answer. `total` is EXACT and independent of `limit` (§9.5). */
export interface QueryResult {
  total: number;
  /** bm25 rank order, capped at `limit`. Reordering is the caller's business. */
  hits: PageRef[];
  /**
   * What the typo ladder substituted. ALWAYS empty unless the query was asked
   * with `fuzzy` and the exact pass found nothing — the wasm enforces that, so
   * non-empty means the results are corrections ("matched **reunião**", §4.3).
   */
  expansions: Expansion[];
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
 * Structured-clonable as it stands, so IndexedDB takes it without a codec.
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
 * A stored snapshot was built by a different index shape. NOT a corruption:
 * it is the signal to throw the record away and rebuild from the rows in
 * IndexedDB, a path that must exist anyway because the store is evictable (§4.2).
 */
export class StaleSnapshotError extends Error {
  constructor(what: string, want: number, got: number) {
    super(`stored index has ${what} ${got}, this build wants ${want}`);
    this.name = "StaleSnapshotError";
  }
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Compiled code, once per URL — never an instance (see the header). */
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
 * ascending and a rowid is found by binary search — 1,222 entries rather than
 * a `Map` of 23,997.
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
    // Copied: the caller may hold this across further builds.
    return this.docs.map((d) => ({ md5: d.md5, firstRowid: d.firstRowid, pages: d.pages.slice() }));
  }

  static from(docs: readonly SnapshotDoc[]): RowidTable {
    const t = new RowidTable();
    for (const d of docs) {
      // `lookup` binary-searches: a stored table that lost its order would
      // answer with the wrong page rather than fail.
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
 * LIFETIME RULE: `memory.buffer` is replaced whenever linear memory grows, and
 * ANY call can grow it. So every `Uint8Array` view is built AFTER the call that
 * produced the pointer it wraps, and never kept across another call.
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

  /** Instantiate and restore a snapshot: 5.93 ms for the library's 10.36 MB
   *  image, against 703 ms to build it (§8.1). */
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
   * Throw the contents away and start over on the SAME instance. `idx_open()`
   * returns the closed database's pages to SQLite's heap INSIDE linear memory,
   * so the next build reuses that space instead of growing past it: four
   * documents through one instance converged on the single worst one whichever
   * order they came in (§8.1). Reuse the instance; never re-instantiate.
   */
  reset(): void {
    this.assertOpen();
    this.table = new RowidTable();
    this.check("idx_open", this.core.idx_open());
  }

  /**
   * Index every page of every document under ONE transaction: FTS5 flushes its
   * pending index to a new level-0 segment at every COMMIT, so 24k
   * autocommitted inserts are 24k segments plus the merges behind them.
   *
   * A failure mid-build resets rather than committing what got in — a partial
   * index is worse than none, because it answers.
   */
  build(docs: Iterable<TermsDocument>): void {
    this.assertOpen();
    this.check("idx_begin", this.core.idx_begin());
    try {
      for (const doc of docs) this.addDocument(doc);
    } catch (err) {
      // Best effort; a reset that fails too must not replace the diagnosis.
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
   * Replace this index's contents with `docs`. `reset()` is skipped on an empty
   * index, so the first build after `open()` — and the retry after a failed
   * one, which also leaves nothing — takes the short path.
   */
  rebuild(docs: Iterable<TermsDocument>): void {
    this.assertOpen();
    if (this.table.documentCount > 0) this.reset();
    this.build(docs);
  }

  /**
   * One document's rows, inside `build`'s transaction. A repeated md5 is
   * refused HERE, not by the wasm: `idx_add` catches a repeated ROWID and these
   * are freshly assigned, so a document indexed twice would sail through and
   * answer every query twice, doubling the counts §4.3 ranks by.
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
   * rowid assignment. The terms arrive already folded (§2.2) and FTS5 tokenizes
   * them again — a no-op by construction, since a token out of `unicode61
   * remove_diacritics 2` cannot contain a separator.
   */
  addPage(rowid: number, terms: string): void {
    this.assertOpen();
    const len = this.stage(terms);
    this.check("idx_add", this.core.idx_add(rowid, this.scratchPtr, len));
  }

  /**
   * Run a query. `text` is the user's RAW string (see the header). `limit`
   * caps only what is returned: the total is exact, and stepping the whole
   * result is 37.9 ms at the pathological `con*` (5,642 pages), 1.3–7.5 ms for
   * ordinary queries (§8.1).
   *
   * `fuzzy` attaches the typo ladder, which fires ONLY when the exact query
   * matched nothing. Measured over the real library (23,964 pages, 63,577
   * terms): a matching query costs 1.42 ms against 1.37 ms exact, so the ladder
   * is free when it does not fire; a no-match query costs 71.3 ms p50 for the
   * whole-vocabulary scan (6,133.8 ms on the Pi), paid
   * per KEYSTROKE — which is why this class is driven from a worker.
   */
  query(text: string, limit: number, fuzzy = false): QueryResult {
    this.assertOpen();
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`bad limit ${limit}`);
    const len = this.stage(text);
    // OPT-IN: `shadowCompare.test.ts` checks this engine against a frozen
    // capture of what the SERVER answered to exact questions, and a default
    // that corrected typos would turn every zero-result query in it into a
    // disagreement of our own making.
    const call = fuzzy ? "idx_fuzzy" : "idx_query";
    const total = fuzzy
      ? this.core.idx_fuzzy(this.scratchPtr, len, limit)
      : this.core.idx_query(this.scratchPtr, len, limit);
    this.check(call, total);
    // Read after the call that produced it, before anything can grow memory.
    const expansions = this.expansions();
    const hits: PageRef[] = [];
    const n = Math.min(total, limit);
    for (let i = 0; i < n; i++) {
      const rowid = this.core.idx_hit(i);
      if (rowid < 0) break;
      const ref = this.table.lookup(rowid);
      // Image and rowid table disagree — otherwise a result row pointing at nothing.
      if (!ref) throw new Error(`rowid ${rowid} is not in the index's rowid table`);
      hits.push(ref);
    }
    return { total, hits, expansions };
  }

  /**
   * The ladder's `typed \t matched \n` record. The wasm clears it on every
   * query, so it cannot report a correction belonging to an earlier one.
   * Neither half can contain a delimiter (`unicode61` splits on tab and
   * newline); a line lacking its tab is DROPPED rather than rendered as
   * "matched **undefined**".
   */
  private expansions(): Expansion[] {
    const n = this.core.idx_expansion_len();
    if (n === 0) return [];
    // Copied before anything else can grow linear memory and detach the view.
    const raw = DECODER.decode(
      new Uint8Array(this.core.memory.buffer, this.core.idx_expansion_ptr(), n).slice(),
    );
    const out: Expansion[] = [];
    for (const line of raw.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0 && tab < line.length - 1) {
        out.push({ typed: line.slice(0, tab), matched: line.slice(tab + 1) });
      }
    }
    return out;
  }

  /** Serialize the database and the rowid table together. Both, or neither. */
  serialize(): IndexSnapshot {
    this.assertOpen();
    const len = this.core.idx_serialize();
    this.check("idx_serialize", len);
    const image = new Uint8Array(len);
    // Pointer read AFTER the call that produced it; copied before memory can grow.
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
   * buffer to `sqlite3_free`, and an `idx_alloc` pointer would be a
   * cross-allocator free. TRAP 2 is inside that call: on a fresh instance this
   * is the FIRST call into SQLite, and `sqlite3_malloc64` traps until
   * `sqlite3_initialize` has run. `idx_deserialize` TAKES OWNERSHIP: no free
   * here, and there must not be one.
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
   * Close the database. The INSTANCE and its linear memory survive; handing
   * memory back means dropping every reference to this object (§4.2).
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
    // One byte more than the text: the empty query is a real case, and a
    // zero-length allocation has no address worth handing across the boundary.
    this.reserve(bytes.length + 1);
    new Uint8Array(this.core.memory.buffer, this.scratchPtr, this.scratchCap).set(bytes);
    return bytes.length;
  }

  private reserve(need: number): void {
    if (this.scratchCap >= need) return;
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

  /** Set on FAILURE and never cleared, so read ONLY after a negative return —
   *  otherwise it is whatever failed last, which reads like a fresh diagnosis. */
  private errorText(): string {
    const n = this.core.idx_errmsg_len();
    if (n === 0) return "";
    return DECODER.decode(new Uint8Array(this.core.memory.buffer, this.core.idx_errmsg_ptr(), n).slice());
  }
}
