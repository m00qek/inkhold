// The local search index: one FTS5 table behind the synchronous `idx_*` ABI
// of `sqlite-core.wasm` (contract in `webapp/wasm/sqlite_core.zig`). The
// module is cached, never the instance: linear memory never shrinks, so
// dropping the index means dropping the instance.

import type { Expansion } from "./localSearch";
import { ITEM_KINDS, ItemTable, kindCode, KIND_SIZE, type ItemKind, type ItemRow } from "./itemRows";

/** The `idx_*` half of `sqlite-core.wasm` (`webapp/wasm/sqlite_core.zig`). */
export interface SearchCoreExports {
  memory: WebAssembly.Memory;
  /** WASI reactor: run libc/C constructors once before any `idx_*` call. */
  _initialize?(): void;
  idx_alloc(len: number): number;
  idx_free(ptr: number, len: number): void;
  idx_open(): number;
  idx_close(): void;
  idx_begin(): number;
  idx_commit(): number;
  idx_add(rowid: number, ptr: number, len: number): number;
  idx_query(ptr: number, len: number, limit: number): number;
  /** Buffered hits, up to `limit` of each kind; -1 past them. */
  idx_hit(i: number): number;
  /** The last query's exact total for one kind of row (`itemRows.ts`). */
  idx_kind_total(kind: number): number;
  idx_delete(rowid: number): number;
  /** `idx_query` plus the typo ladder, which fires only on a total of 0. */
  idx_fuzzy(ptr: number, len: number, limit: number): number;
  /** `typed \t matched \n` pairs, rewritten by every query of either kind. */
  idx_expansion_ptr(): number;
  idx_expansion_len(): number;
  idx_errmsg_ptr(): number;
  idx_errmsg_len(): number;
}

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

/** An item row that matched: its kind and its key there. */
export interface ItemRef {
  kind: ItemKind;
  key: string;
}

/** A query's answer. Totals are EXACT and independent of `limit` (§9.5). */
export interface QueryResult {
  /** Matching pages. */
  total: number;
  /** bm25 rank order, capped at `limit`. Reordering is the caller's business. */
  hits: PageRef[];
  /** Matching item rows, each kind capped at `limit`, in bm25 rank order within it. */
  items: ItemRef[];
  /** Matching item rows of each kind. */
  itemTotals: Record<ItemKind, number>;
  /** Typo-ladder substitutions; non-empty only for a fuzzy query whose exact pass found nothing. */
  expansions: Expansion[];
}

/** One document's pages in the rowid table. */
interface DocRows {
  md5: string;
  /** The rowid of `pages[0]`; page `i` of this document is `firstRowid + i`. */
  firstRowid: number;
  /** Page ordinals, in insertion order. Not necessarily dense or sorted. */
  pages: Uint32Array;
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
function browserCoreLoader(url: string = DEFAULT_WASM_URL): CoreLoader {
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
  private readonly docs: DocRows[] = [];
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
    // Pages are kind 0 (`itemRows.ts`): their rowids stay under the first item kind's.
    if (this.next + pages.length > KIND_SIZE) throw new Error("no rowids left for pages");
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
}

/**
 * One open index on one wasm instance. Any call can grow linear memory and
 * replace `memory.buffer`, so a view is built after the call that produced its
 * pointer and never kept across another call.
 */
export class SearchIndex {
  private readonly core: SearchCoreExports;
  private table: RowidTable;
  private items = new ItemTable();
  /** True once a build wrote the item rows `items` holds; until then, and after a reset, the next build writes them. */
  private itemsIn = false;
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
    this.itemsIn = false;
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
      if (!this.itemsIn) for (const row of this.items.all()) this.addPage(row.rowid, row.text);
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
    this.itemsIn = true;
  }

  /** Pages from `docs`, and the item rows already held. */
  rebuild(docs: Iterable<TermsDocument>): void {
    this.assertOpen();
    this.reset();
    this.build(docs);
  }

  /**
   * Replaces one kind's rows with `rows`: only what changed is written, so a
   * saved to-do is found at once. Not yet built: kept for the build. A
   * failure empties the index, which then needs a rebuild.
   */
  setItems(kind: ItemKind, rows: readonly ItemRow[]): void {
    this.assertOpen();
    const diff = this.items.diff(kind, rows);
    if (!this.itemsIn || (diff.remove.length === 0 && diff.add.length === 0)) return;
    try {
      this.check("idx_begin", this.core.idx_begin());
      for (const rowid of diff.remove) this.check("idx_delete", this.core.idx_delete(rowid));
      for (const row of diff.add) this.addPage(row.rowid, row.text);
      this.check("idx_commit", this.core.idx_commit());
    } catch (err) {
      try {
        this.reset();
      } catch {
        /* ignore */
      }
      throw err;
    }
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

  /** One FTS5 row. A page's terms arrive server-folded; re-tokenizing them is a no-op. */
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
    const items: ItemRef[] = [];
    for (let i = 0; ; i++) {
      const rowid = this.core.idx_hit(i);
      if (rowid < 0) break;
      const item = this.items.lookup(rowid);
      if (item) {
        items.push(item);
        continue;
      }
      const ref = this.table.lookup(rowid);
      if (!ref) throw new Error(`rowid ${rowid} is not in the index's rowid tables`);
      hits.push(ref);
    }
    const itemTotals = Object.fromEntries(ITEM_KINDS.map((k) => [k, this.core.idx_kind_total(kindCode(k))])) as Record<ItemKind, number>;
    return { total: this.core.idx_kind_total(0), hits, items, itemTotals, expansions };
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
