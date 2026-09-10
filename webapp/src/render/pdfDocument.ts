// The PDF DOCUMENT — a typed wrapper over the decoder's C ABI in
// `webapp/wasm/pdf_decode.zig`. No DOM, no viewer, and no loading: it is handed
// an instance (see `pdfLoader.ts`) and drives it.
//
// MuPDF is a DOCUMENT-oriented engine, unlike the `.note` decoder: a PDF page
// cannot be decoded from its own bytes because pages share a resource graph
// (fonts, colour spaces, XObjects) through the xref. So this opens a document
// once and keeps a handle, where `render/wasm.ts` takes a page's byte range per
// call. That is also why a PDF renderer does not implement `NoteRenderer`.
//
// TWO WAYS TO OPEN: whole-file, or a STREAM pulling blocks over the network as
// MuPDF walks it. One class covers both, because on the streamed path any call
// can suspend and on the whole-file path awaiting a plain value costs nothing.

import { parsePageLinks } from "./pdfWire";
import type { PdfLink } from "../core/types";
import { parsePageWords, type PdfWord } from "./pdfWire";
import { parseOutline, type PdfOutlineEntry } from "./pdfWire";
import { lastError, type PdfDecoderExports } from "./pdfLoader";

/** A page's size in POINTS (1/72"), the PDF's own unit — not pixels. */
export interface PdfPageSize {
  width: number;
  height: number;
}

/** One rendered page. `rgba` is copied OUT of wasm memory and is ours to keep. */
export interface PdfBitmap {
  width: number;
  height: number;
  /**
   * Straight (non-premultiplied) RGBA, row-major. Every pixel opaque.
   *
   * Typed over `ArrayBuffer` rather than `ArrayBufferLike` because it is a COPY
   * into a fresh buffer (never a view onto wasm memory, which could in principle
   * be shared) — and `ImageData` will only accept the narrower type.
   */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

// ============================================================================
// The document wrapper
// ============================================================================

/**
 * The entry points that can SUSPEND once the document is a stream.
 *
 * On the whole-file path every one of them returns its value outright; on the
 * JSPI path each is a `WebAssembly.promising` wrapper and returns a promise,
 * because anything that walks the xref can re-enter `ink.host_read` and wait on
 * a `fetch`. `AsyncPdfDocument` awaits all of them and so is written ONCE for
 * both — `await 5` is 5.
 *
 * Not every export is here: `ink_alloc`/`ink_free`, the render dimensions, the
 * error accessors and `ink_close` touch no document bytes and stay synchronous.
 * `ink_close` in particular must NOT be promising — a teardown that returns a
 * promise is a teardown that can be interleaved with.
 *
 * THE OPTIONAL MEMBERS BELOW ARE OPTIONAL IN THE TYPE AND MANDATORY ON THE JSPI
 * PATH. Each reads document bytes, so unwrapped on a streamed document it TRAPS
 * the instance the moment it suspends instead of waiting; `AsyncPdfDocument`
 * falls back to the raw export when one is absent, which is right for
 * {@link syncCalls} and wrong for a promising wrapper. They are optional only so
 * a caller building a `PdfCalls` by hand is not forced to name a call it will
 * never make. The note on each says WHY it reads bytes.
 */
export interface PdfCalls {
  openWhole(ptr: number, len: number): number | Promise<number>;
  openStream(totalLen: bigint): number | Promise<number>;
  pageCount(handle: number): number | Promise<number>;
  pageSize(handle: number, page: number, wPtr: number, hPtr: number): number | Promise<number>;
  render(handle: number, page: number, scale: number): bigint | Promise<bigint>;
  /** Listing a page's links LOADS the page, and resolving an internal
   *  destination walks the xref again. */
  pageLinks?(handle: number, page: number): bigint | Promise<bigint>;
  /** The most emphatically of any of them: extracting a page's words RUNS the
   *  page, pulling the fonts, images and every content stream it references. */
  pageWords?(handle: number, page: number): bigint | Promise<bigint>;
  /** Walks the outline tree, then resolves each entry's destination through the
   *  links layer's own `fz_resolve_link` / `fz_page_number_from_location` pair:
   *  the xref twice over. */
  loadOutline?(handle: number): bigint | Promise<bigint>;
  /** Grafting a page walks the SOURCE document's xref. */
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
  /** Annotating loads the page, which walks the xref. */
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
  /** The one call that reads the WHOLE document back — MuPDF's incremental
   *  write copies the file it appends to, and the module sinks that copy. */
  exportIncremental?(handle: number): bigint | Promise<bigint>;
}

/** `PdfCalls` straight through to the exports — no JSPI, nothing suspends. */
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
 * An open document. Holds a wasm-side handle, so it MUST be closed — wasm32
 * linear memory only ever grows, and a leaked document keeps MuPDF's store alive
 * inside it.
 *
 * ASYNC EVEN WHEN NOTHING WAITS, so ONE class covers both transports: the
 * whole-file path is `openWhole` driven by {@link syncCalls}, and `await 5` is
 * 5. A sync twin would be a second copy of the scratch-pointer dance, the
 * packed-return unpacking and the error strings, kept in step by a suite that
 * exercises each separately.
 *
 * EVERY POINTER IS RE-READ after the call that produced it, because an `await`
 * in the middle of a method is a place where wasm memory can have grown and the
 * old `ArrayBuffer` detached.
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

  /** Streamed: MuPDF pulls the bytes it wants through `ink.host_read`. */
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

  /** Page size in POINTS. Throws for an out-of-range index. */
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
   * The page's own links, in the page's DISPLAY space (points).
   *
   * AN EMPTY LIST IS AN ANSWER, not a failure: most pages have no links, and a
   * page the decoder refuses answers `[]` too, because the caller's response to
   * either is the same (draw no link layer) and throwing here would take the
   * PAGE down with it.
   *
   * The bytes are copied out and parsed before the module's buffer is released,
   * on every path: only one is resident at a time.
   */
  async pageLinks(page: number): Promise<PdfLink[]> {
    const x = this.x;
    const call = this.c.pageLinks ?? x.ink_page_links;
    try {
      const packed = await call(this.alive(), page);
      if (packed < 0n) return [];
      // `memory.buffer` re-read HERE, not captured: the call allocates, and on
      // the JSPI path it also suspended.
      const json = new TextDecoder().decode(
        new Uint8Array(x.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
      );
      return parsePageLinks(json);
    } finally {
      x.ink_links_free();
    }
  }

  /**
   * The page's WORDS, in the page's DISPLAY space (points) — find-in-PDF's
   * locator.
   *
   * AN EMPTY LIST IS AN ANSWER, as it is for links, and here it is load-bearing:
   * a page of scanned images has no words, and a page the server MATCHED can
   * still yield none the client can name. Either way the page stays a match with
   * no box drawn, so this must not throw or an unlocatable page would take the
   * whole find down with it.
   */
  async pageWords(page: number): Promise<PdfWord[]> {
    const x = this.x;
    const call = this.c.pageWords ?? x.ink_page_words;
    try {
      const packed = await call(this.alive(), page);
      if (packed < 0n) return [];
      // `memory.buffer` re-read HERE, not captured: the call allocates, and on
      // the JSPI path it also suspended.
      const json = new TextDecoder().decode(
        new Uint8Array(x.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
      );
      return parsePageWords(json);
    } finally {
      x.ink_words_free();
    }
  }

  /**
   * The document's OUTLINE, flattened — its own table of contents.
   *
   * PER DOCUMENT, and asked for ONCE: unlike words and links this describes the
   * whole file and does not change under the reader, so the caller caches it for
   * the document's life.
   *
   * AN EMPTY LIST IS AN ANSWER, and here it is the COMMON one — most documents
   * have no outline. A document the decoder refuses answers `[]` too, because
   * the caller's response to either is a dimmed opener, and throwing would take
   * a perfectly readable document down over its table of contents.
   */
  async outline(): Promise<PdfOutlineEntry[]> {
    const x = this.x;
    const call = this.c.loadOutline ?? x.ink_load_outline;
    try {
      const packed = await call(this.alive());
      if (packed < 0n) return [];
      // `memory.buffer` re-read HERE, not captured: the call allocates, and on
      // the JSPI path it also suspended.
      const json = new TextDecoder().decode(
        new Uint8Array(x.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
      );
      return parseOutline(json);
    } finally {
      x.ink_outline_free();
    }
  }

  /** Render one page at `scale`. The pixels are COPIED OUT before returning. */
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
   * Export one page as a PDF, with the page's own structure intact.
   *
   * THE DIFFERENCE FROM `render`: this GRAFTS the source page into a fresh
   * one-page document and draws the ink over it, so the text, fonts, vectors and
   * page size survive. What does NOT survive is the source page's `/Annots` —
   * `pdf_graft_page` does not copy them; see `webapp/wasm/pdf_shim.c`.
   *
   * `alpha` is `width * height` coverage bytes, 255 = full ink. `matrix` maps
   * that image's OWN PIXEL SPACE onto the page in display space — build it with
   * `markExportMatrix`, never by hand.
   *
   * The bytes are COPIED OUT of wasm memory before returning, and both the
   * scratch buffer and the module's own copy are released on every path: the
   * export is page-sized, and one left behind stays resident.
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
   * Draw the ink onto `page` of THIS document, in place — the first half of the
   * whole-document export. Call once per annotated page, then
   * {@link exportIncremental}.
   *
   * WHY THIS EXISTS BESIDE `exportPage`: grafting every page into a fresh
   * document would drop each one's `/Annots`, so a 77-page export would lose
   * every link and highlight the original had. This route annotates in place and
   * then writes an INCREMENTAL UPDATE, keeping the original's bytes.
   *
   * THE DOCUMENT IS SPENT AFTERWARDS. There is no undo — every later render of
   * `page` shows the ink burnt in, and annotating the same page twice draws it
   * twice — so a caller that goes on displaying the document must reopen it.
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
   * Write everything {@link annotatePage} changed, and hand back THE DELTA —
   * the bytes that belong after the original file.
   *
   * NOT A PDF ON ITS OWN. `new Blob([originalBlob, delta])` is, and building it
   * that way is the whole memory argument: blobs are disk-backed, so a 76 MB
   * document is exported without any of it entering the JS heap.
   *
   * The module refuses, with a sentence, for a document it cannot update in
   * place: one that had to be repaired to open, one with junk before its
   * `%PDF-` header (every offset in the delta would be misplaced), one with no
   * backing file, and one where nothing was annotated.
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

  /**
   * Copy `alpha` into wasm memory, run `use` against the pointer, and free the
   * scratch on every path. Shared by the two ink routes, which take the same
   * overlay and refuse the same mismatch.
   */
  private async withInk<T>(
    alpha: Uint8Array,
    width: number,
    height: number,
    use: (ptr: number) => Promise<T>,
  ): Promise<T> {
    const x = this.x;
    if (width <= 0 || height <= 0 || alpha.length !== width * height) {
      // The module reads `width * height` bytes from a raw pointer, so a short
      // buffer is an out-of-bounds read inside wasm rather than a bad export.
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

  /**
   * The packed `(ptr << 32) | len` an export returns, copied OUT of wasm memory.
   *
   * `memory.buffer` re-read HERE, not captured before the call: an export
   * allocates, so an earlier view's buffer may have been replaced.
   */
  private copyExport(packed: bigint): Uint8Array {
    const buf = this.x.memory.buffer;
    return new Uint8Array(
      new Uint8Array(buf, Number(packed >> 32n), Number(packed & 0xffffffffn)),
    );
  }

  /** Idempotent. After this every method throws rather than using a stale handle. */
  close(): void {
    if (this.handle > 0) this.x.ink_close(this.handle);
    this.handle = 0;
  }

  private alive(): number {
    if (this.handle < 1) throw new Error("this PDF document is closed");
    return this.handle;
  }
}
