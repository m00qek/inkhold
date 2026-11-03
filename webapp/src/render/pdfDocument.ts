// A typed wrapper over the PDF decoder's C ABI (`webapp/wasm/pdf_decode.zig`).
// Document-oriented, unlike the `.note` decoder: pages share a resource graph
// through the xref, so a document is opened once and held by handle (and is
// not a `NoteRenderer`).

import { parsePageLinks } from "./pdfWire";
import type { PdfLink } from "../core/types";
import { parsePageWords, type PdfWord } from "./pdfWire";
import { parseOutline, type PdfOutlineEntry } from "./pdfWire";
import { lastError, type PdfDecoderExports } from "./pdfLoader";

/** A page's size in points (1/72"), not pixels. */
export interface PdfPageSize {
  width: number;
  height: number;
}

/** One rendered page; `rgba` is copied out of wasm memory. */
export interface PdfBitmap {
  width: number;
  height: number;
  /** Straight RGBA, row-major, opaque; a fresh `ArrayBuffer` so `ImageData` accepts it. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * The entry points that can suspend on a streamed document: under JSPI each is
 * a `WebAssembly.promising` wrapper, synchronously each returns its value, and
 * `AsyncPdfDocument` awaits both alike. `ink_close` must stay synchronous so
 * teardown can't interleave. The optional members are mandatory on the JSPI
 * path: unwrapped, a call that reads document bytes traps the instance when it
 * suspends.
 */
export interface PdfCalls {
  openWhole(ptr: number, len: number): number | Promise<number>;
  openStream(totalLen: bigint): number | Promise<number>;
  pageCount(handle: number): number | Promise<number>;
  pageSize(handle: number, page: number, wPtr: number, hPtr: number): number | Promise<number>;
  render(handle: number, page: number, scale: number): bigint | Promise<bigint>;
  /** Loads the page; internal destinations walk the xref again. */
  pageLinks?(handle: number, page: number): bigint | Promise<bigint>;
  /** Runs the page, pulling every font, image and content stream it references. */
  pageWords?(handle: number, page: number): bigint | Promise<bigint>;
  /** Walks the outline and resolves each destination through the xref. */
  loadOutline?(handle: number): bigint | Promise<bigint>;
  /** Grafting walks the source document's xref. */
  exportPage?(
    handle: number,
    page: number,
    alpha: number,
    w: number,
    h: number,
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): bigint | Promise<bigint>;
  /** Annotating loads the page. */
  annotatePage?(
    handle: number,
    page: number,
    alpha: number,
    w: number,
    h: number,
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): number | Promise<number>;
  /** Reads the whole document back (MuPDF's incremental write copies it). */
  exportIncremental?(handle: number): bigint | Promise<bigint>;
}

/** `PdfCalls` straight through to the exports; nothing suspends. */
export function syncCalls(x: PdfDecoderExports): PdfCalls {
  return {
    openWhole: (ptr, len) => x.ink_open(ptr, len),
    openStream: (total) => x.ink_open_stream(total),
    pageCount: (h) => x.ink_page_count(h),
    pageSize: (h, p, w, hp) => x.ink_page_size(h, p, w, hp),
    pageLinks: (h, p) => x.ink_page_links(h, p),
    pageWords: (h, p) => x.ink_page_words(h, p),
    loadOutline: (h) => x.ink_load_outline(h),
    render: (h, p, s) => x.ink_render(h, p, s),
    exportPage: (h, p, ink, w, ih, a, b, c, d, e, f) =>
      x.ink_export_page(h, p, ink, w, ih, a, b, c, d, e, f),
    annotatePage: (h, p, ink, w, ih, a, b, c, d, e, f) =>
      x.ink_annotate_page(h, p, ink, w, ih, a, b, c, d, e, f),
    exportIncremental: (h) => x.ink_export_incremental(h),
  };
}

/**
 * An open document; must be closed, since wasm32 memory only grows and a leaked
 * document keeps MuPDF's store alive. Async even when nothing waits, so one
 * class serves both transports. Every pointer is re-read after an `await`
 * (memory may have grown and detached the old buffer).
 */
export class AsyncPdfDocument {
  private handle: number;
  private readonly x: PdfDecoderExports;
  private readonly c: PdfCalls;

  private constructor(x: PdfDecoderExports, c: PdfCalls, handle: number) {
    this.x = x;
    this.c = c;
    this.handle = handle;
  }

  /** Whole-file: `bytes` is copied in and consumed by the module on every path. */
  static async openWhole(
    x: PdfDecoderExports,
    c: PdfCalls,
    bytes: Uint8Array,
  ): Promise<AsyncPdfDocument> {
    const ptr = x.ink_alloc(bytes.length);
    if (!ptr) throw new Error("out of wasm memory opening the PDF");
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    const handle = await c.openWhole(ptr, bytes.length);
    if (handle < 1) throw new Error(lastError(x, `could not open this PDF (${handle})`));
    return new AsyncPdfDocument(x, c, handle);
  }

  static async openStream(
    x: PdfDecoderExports,
    c: PdfCalls,
    totalLen: number,
  ): Promise<AsyncPdfDocument> {
    const handle = await c.openStream(BigInt(totalLen));
    if (handle < 1) throw new Error(lastError(x, `could not open this PDF (${handle})`));
    return new AsyncPdfDocument(x, c, handle);
  }

  async pageCount(): Promise<number> {
    const n = await this.c.pageCount(this.alive());
    return n < 0 ? 0 : n;
  }

  /** Page size in points. Throws for an out-of-range index. */
  async pageSize(page: number): Promise<PdfPageSize> {
    const x = this.x;
    const scratch = x.ink_alloc(8);
    if (!scratch) throw new Error("out of wasm memory");
    try {
      if ((await this.c.pageSize(this.alive(), page, scratch, scratch + 4)) < 0) {
        throw new Error(lastError(x, `no page ${page}`));
      }
      const d = new DataView(x.memory.buffer);
      return { width: d.getFloat32(scratch, true), height: d.getFloat32(scratch + 4, true) };
    } finally {
      x.ink_free(scratch, 8);
    }
  }

  /**
   * The page's own links in display-space points. A refusal answers `[]` rather
   * than taking the page down.
   */
  async pageLinks(page: number): Promise<PdfLink[]> {
    const x = this.x;
    const call = this.c.pageLinks ?? x.ink_page_links;
    try {
      const packed = await call(this.alive(), page);
      if (packed < 0n) return [];
      // Re-read `memory.buffer` here: the call allocates and may have suspended.
      const json = new TextDecoder().decode(
        new Uint8Array(x.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
      );
      return parsePageLinks(json);
    } finally {
      x.ink_links_free();
    }
  }

  /**
   * The page's words in display-space points. Must answer `[]` rather than
   * throw: a matched page may have no locatable words.
   */
  async pageWords(page: number): Promise<PdfWord[]> {
    const x = this.x;
    const call = this.c.pageWords ?? x.ink_page_words;
    try {
      const packed = await call(this.alive(), page);
      if (packed < 0n) return [];
      // Re-read `memory.buffer` here: the call allocates and may have suspended.
      const json = new TextDecoder().decode(
        new Uint8Array(x.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
      );
      return parsePageWords(json);
    } finally {
      x.ink_words_free();
    }
  }

  /** The flattened outline, cached per document by the caller; `[]` on refusal. */
  async outline(): Promise<PdfOutlineEntry[]> {
    const x = this.x;
    const call = this.c.loadOutline ?? x.ink_load_outline;
    try {
      const packed = await call(this.alive());
      if (packed < 0n) return [];
      // Re-read `memory.buffer` here: the call allocates and may have suspended.
      const json = new TextDecoder().decode(
        new Uint8Array(x.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
      );
      return parseOutline(json);
    } finally {
      x.ink_outline_free();
    }
  }

  /** Render one page at `scale`; pixels are copied out. */
  async render(page: number, scale: number): Promise<PdfBitmap> {
    const x = this.x;
    const packed = await this.c.render(this.alive(), page, scale);
    if (packed < 0n) throw new Error(lastError(x, `could not render page ${page}`));
    const ptr = Number(packed >> 32n);
    const len = Number(packed & 0xffffffffn);
    return {
      width: x.ink_render_width(),
      height: x.ink_render_height(),
      rgba: new Uint8ClampedArray(new Uint8Array(x.memory.buffer, ptr, len)),
    };
  }

  /**
   * One page as a PDF: grafted into a fresh document with ink drawn over it, so
   * text and vectors survive but `/Annots` don't (`pdf_graft_page`). `matrix`
   * comes from `markExportMatrix`. Output is copied out and every buffer freed.
   */
  async exportPage(
    page: number,
    alpha: Uint8Array,
    width: number,
    height: number,
    matrix: readonly [number, number, number, number, number, number],
  ): Promise<Uint8Array> {
    const x = this.x;
    const handle = this.alive();
    return this.withInk(alpha, width, height, async (ptr) => {
      const [a, b, c, d, e, f] = matrix;
      const call = this.c.exportPage ?? x.ink_export_page;
      try {
        const packed = await call(handle, page, ptr, width, height, a, b, c, d, e, f);
        if (packed < 0n) throw new Error(lastError(x, `could not export page ${page}`));
        return this.copyExport(packed);
      } finally {
        x.ink_export_free();
      }
    });
  }

  /**
   * Draw ink onto `page` in place, once per page before {@link exportIncremental}
   * (keeps `/Annots`, unlike grafting). No undo; reopen before displaying again.
   */
  async annotatePage(
    page: number,
    alpha: Uint8Array,
    width: number,
    height: number,
    matrix: readonly [number, number, number, number, number, number],
  ): Promise<void> {
    const x = this.x;
    const handle = this.alive();
    await this.withInk(alpha, width, height, async (ptr) => {
      const [a, b, c, d, e, f] = matrix;
      const call = this.c.annotatePage ?? x.ink_annotate_page;
      const rc = await call(handle, page, ptr, width, height, a, b, c, d, e, f);
      if (rc < 0) throw new Error(lastError(x, `could not annotate page ${page}`));
    });
  }

  /**
   * The incremental update's delta; `new Blob([originalBlob, delta])` is the PDF.
   * The module refuses documents it can't update in place: repaired on open,
   * junk before `%PDF-`, no backing file, or nothing annotated.
   */
  async exportIncremental(): Promise<Uint8Array> {
    const x = this.x;
    const handle = this.alive();
    const call = this.c.exportIncremental ?? x.ink_export_incremental;
    try {
      const packed = await call(handle);
      if (packed < 0n) throw new Error(lastError(x, "could not export this document"));
      return this.copyExport(packed);
    } finally {
      x.ink_export_free();
    }
  }

  /** Copy `alpha` into wasm, run `use`, free the scratch on every path. */
  private async withInk<T>(
    alpha: Uint8Array,
    width: number,
    height: number,
    use: (ptr: number) => Promise<T>,
  ): Promise<T> {
    const x = this.x;
    if (width <= 0 || height <= 0 || alpha.length !== width * height) {
      // A short buffer would be an out-of-bounds read inside wasm.
      throw new Error("the ink overlay's size does not match its alpha buffer");
    }
    const ptr = x.ink_alloc(alpha.length);
    if (!ptr) throw new Error("out of wasm memory building the export's ink");
    try {
      new Uint8Array(x.memory.buffer, ptr, alpha.length).set(alpha);
      return await use(ptr);
    } finally {
      x.ink_free(ptr, alpha.length);
    }
  }

  /** Copy a packed `(ptr << 32) | len` result out, re-reading `memory.buffer`. */
  private copyExport(packed: bigint): Uint8Array {
    const buf = this.x.memory.buffer;
    return new Uint8Array(
      new Uint8Array(buf, Number(packed >> 32n), Number(packed & 0xffffffffn)),
    );
  }

  /** Idempotent; afterwards every method throws. */

  close(): void {
    if (this.handle > 0) this.x.ink_close(this.handle);
    this.handle = 0;
  }

  private alive(): number {
    if (this.handle < 1) throw new Error("this PDF document is closed");
    return this.handle;
  }
}
