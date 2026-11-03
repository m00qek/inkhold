// The local search index: one FTS5 table behind the synchronous `idx_*` ABI
// of `sqlite-core.wasm` (contract in `webapp/wasm/sqlite_core.zig`). The
// module is cached, never the instance: linear memory never shrinks, so
// dropping the index means dropping the instance.

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
  /** Typo-ladder substitutions; non-empty only for a fuzzy query whose exact pass found nothing. */
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

/** The serialized database plus the rowid table that gives its integers meaning. Structured-clonable. */
export interface IndexSnapshot {
  schemaVersion: number;
  mappingVersion: number;
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

/** A stored snapshot of a different index shape: discard it and rebuild from the rows. */
export class StaleSnapshotError extends Error {
  constructor(what: string, want: number, got: number) {
    super(`stored index has ${what} ${got}, this build wants ${want}`);
    this.name = "StaleSnapshotError";
  }
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

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

/** A fresh instance of the cached module per call. */
export function browserCoreLoader(url: string = DEFAULT_WASM_URL): CoreLoader {
  return async () => {
    const mod = await compileCore(url);
    const instance = await WebAssembly.instantiate(mod, {});
    const core = instance.exports as unknown as SearchCoreExports;
    core._initialize?.();
    return core;
  };
}

/** Documents in build order, so `firstRowid` ascends and lookup is a binary search. */
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
    return this.docs.map((d) => ({ md5: d.md5, firstRowid: d.firstRowid, pages: d.pages.slice() }));
  }

  static from(docs: readonly SnapshotDoc[]): RowidTable {
    const t = new RowidTable();
    for (const d of docs) {
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
 * One open index on one wasm instance. Any call can grow linear memory and
 * replace `memory.buffer`, so a view is built after the call that produced its
 * pointer and never kept across another call.
 */
export class SearchIndex {
  private readonly core: SearchCoreExports;
  private table: RowidTable;
  /** Reused UTF-8 staging buffer. */
  private scratchPtr = 0;
  private scratchCap = 0;
  private closed = false;

  private constructor(core: SearchCoreExports, table: RowidTable) {
    this.core = core;
    this.table = table;
  }

  /** Instantiate (about 16 MB of linear memory) and open an empty index. */
  static async open(load: CoreLoader = browserCoreLoader()): Promise<SearchIndex> {
    const core = await load();
    const index = new SearchIndex(core, new RowidTable());
    index.check("idx_open", core.idx_open());
    return index;
  }

  static async restore(
    snapshot: IndexSnapshot,
    load: CoreLoader = browserCoreLoader(),
  ): Promise<SearchIndex> {
    const core = await load();
    const index = new SearchIndex(core, new RowidTable());
    index.deserialize(snapshot);
    return index;
  }

  get schemaVersion(): number {
    return this.core.idx_schema_version();
  }

  get documentCount(): number {
    return this.table.documentCount;
  }

  get pageCount(): number {
    return this.table.pageCount;
  }

  documents(): string[] {
    return this.table.md5s();
  }

  /** Empty the index on the same instance, so the next build reuses SQLite's heap instead of growing memory. */
  reset(): void {
    this.assertOpen();
    this.table = new RowidTable();
    this.check("idx_open", this.core.idx_open());
  }

  /**
   * One transaction for the whole build: FTS5 writes a segment per commit. A
   * failure resets rather than committing a partial index, which would answer.
   */
  build(docs: Iterable<TermsDocument>): void {
    this.assertOpen();
    this.check("idx_begin", this.core.idx_begin());
    try {
      for (const doc of docs) this.addDocument(doc);
    } catch (err) {
      // A failing reset must not replace the original error.
      try {
        this.reset();
      } catch {
        /* ignore */
      }
      throw err;
    }
    this.check("idx_commit", this.core.idx_commit());
  }

  rebuild(docs: Iterable<TermsDocument>): void {
    this.assertOpen();
    if (this.table.documentCount > 0) this.reset();
    this.build(docs);
  }

  /** Repeated md5s are refused here: rowids are fresh, so the wasm cannot catch a document added twice. */
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

  /** One FTS5 row. Terms arrive server-folded; re-tokenizing them is a no-op. */
  addPage(rowid: number, terms: string): void {
    this.assertOpen();
    const len = this.stage(terms);
    this.check("idx_add", this.core.idx_add(rowid, this.scratchPtr, len));
  }

  /**
   * `text` goes to the wasm raw; folding it here would be a second tokenizer.
   * `limit` caps hits only; `total` is exact. `fuzzy` adds the typo ladder,
   * which scans the whole vocabulary on a zero-hit query (tens of ms, seconds
   * on a Pi) — the reason this runs in a worker.
   */
  query(text: string, limit: number, fuzzy = false): QueryResult {
    this.assertOpen();
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`bad limit ${limit}`);
    const len = this.stage(text);
    const call = fuzzy ? "idx_fuzzy" : "idx_query";
    const total = fuzzy
      ? this.core.idx_fuzzy(this.scratchPtr, len, limit)
      : this.core.idx_query(this.scratchPtr, len, limit);
    this.check(call, total);
    const expansions = this.expansions();
    const hits: PageRef[] = [];
    const n = Math.min(total, limit);
    for (let i = 0; i < n; i++) {
      const rowid = this.core.idx_hit(i);
      if (rowid < 0) break;
      const ref = this.table.lookup(rowid);
      if (!ref) throw new Error(`rowid ${rowid} is not in the index's rowid table`);
      hits.push(ref);
    }
    return { total, hits, expansions };
  }

  /** Parses `typed \t matched \n`; a line without both halves is dropped. */
  private expansions(): Expansion[] {
    const n = this.core.idx_expansion_len();
    if (n === 0) return [];
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

  serialize(): IndexSnapshot {
    this.assertOpen();
    const len = this.core.idx_serialize();
    this.check("idx_serialize", len);
    const image = new Uint8Array(len);
    image.set(new Uint8Array(this.core.memory.buffer, this.core.idx_image_ptr(), len));
    return {
      schemaVersion: this.core.idx_schema_version(),
      mappingVersion: MAPPING_FORMAT_VERSION,
      image,
      docs: this.table.snapshot(),
    };
  }

  /**
   * The buffer must come from `idx_image_alloc` (SQLite's heap): `FREEONCLOSE`
   * hands it to `sqlite3_free`. `idx_deserialize` takes ownership; never free it.
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

  /** The instance and its memory survive; drop every reference to free them. */
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
    // +1 so the empty query still gets a real allocation.
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

  /** Never cleared, so meaningful only right after a negative return. */
  private errorText(): string {
    const n = this.core.idx_errmsg_len();
    if (n === 0) return "";
    return DECODER.decode(new Uint8Array(this.core.memory.buffer, this.core.idx_errmsg_ptr(), n).slice());
  }
}
