// The PDF DECODE CORE — no DOM, no viewer. The wasm loader, the WASI import
// shim, and a typed wrapper over the C ABI in `webapp/wasm/pdf_decode.zig`.
//
// Lives outside `pages/` for the same reason `spdDecode.ts` does: a viewer is
// not the only plausible consumer (a thumbnail path, an export path), and a page
// should not be something they have to import from.
//
// MuPDF is a DOCUMENT-oriented engine, unlike the `.note` decoder: a PDF page
// cannot be decoded from its own bytes because pages share a resource graph
// (fonts, colour spaces, XObjects) through the xref. So this opens a document
// once and keeps a handle, where `render/wasm.ts` takes a page's byte range per
// call. That is also why a PDF renderer does not implement `NoteRenderer`
//
// TWO WAYS TO OPEN, and both stay. `PdfDocument` takes the whole file and is
// entirely synchronous — what a caller that already holds the bytes wants, and
// what the tests exercise under Node. `AsyncPdfDocument` awaits every call,
// because the document may be a STREAM pulling blocks over the network as MuPDF
// walks it, and on that path any call can suspend.

import { parsePageLinks, type PdfLink } from "./pdfLinks";

// ============================================================================
// The decoder C-ABI. Pointers are byte offsets into `memory`; every pointer must
// be RE-READ after the call that produced it (linear memory can grow) and copied
// out before the next call.
// ============================================================================

export interface PdfDecoderExports {
  memory: WebAssembly.Memory;
  /** WASI reactor: run libc/C constructors once before any `ink_*` call. */
  _initialize?(): void;
  ink_alloc(len: number): number;
  ink_free(ptr: number, len: number): void;
  /** Consumes the buffer on EVERY path, success or failure. */
  ink_open(ptr: number, len: number): number;
  /**
   * Open over the `ink.host_read` CALLBACK instead of a buffer. `totalLen` is
   * the document's byte length (i64, so a BigInt here). Returns a handle or a
   * negative code, exactly like `ink_open`.
   *
   * Every call reachable from here can re-enter `ink.host_read`, which on the
   * JSPI path SUSPENDS — see `PdfCalls`.
   */
  ink_open_stream(totalLen: bigint): number;
  ink_page_count(handle: number): number;
  ink_page_size(handle: number, page: number, wPtr: number, hPtr: number): number;
  /**
   * The page's own links, as UTF-8 JSON — packed `(ptr << 32) | len`, or
   * negative. An empty page answers `[]`, which is a SUCCESS.
   *
   * The rects are in the same space `ink_page_size` reports, and a uri whose
   * scheme is not http/https/mailto never appears at all. Reads the page, so
   * like the rest of these it can SUSPEND.
   */
  ink_page_links(handle: number, page: number): bigint;
  /** Release the buffer `ink_page_links` returned. Idempotent. */
  ink_links_free(): void;
  /** Packed (ptr << 32) | len, or negative on failure. */
  ink_render(handle: number, page: number, scale: number): bigint;
  ink_render_width(): number;
  ink_render_height(): number;
  /**
   * One page as a ONE-PAGE PDF: the source page grafted in whole — its own
   * content streams, fonts, vectors and page size — with `alpha` drawn over it
   * as ink. `alpha` is a pointer to `w * h` coverage bytes (255 = full ink).
   *
   * `a`..`f` place the ALPHA IMAGE'S OWN PIXEL SPACE (top-left origin, y down)
   * onto the page in DISPLAY space — the same space `ink_page_size` reports and
   * `markExportMatrix` builds for. A `/Rotate`, a `/CropBox` offset and an
   * off-origin `/MediaBox` are all resolved inside the module.
   *
   * Packed `(ptr << 32) | len`, or negative. Like `ink_open_stream`, this can
   * SUSPEND: grafting walks the source document's xref.
   */
  ink_export_page(
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
  ): bigint;
  /**
   * Draw the same ink onto the OPEN document's page, IN PLACE — the first half
   * of the whole-document export. Writes nothing; 0 on success, negative on
   * error. Call once per annotated page, then `ink_export_incremental`.
   *
   * THE DOCUMENT IS MUTATED AND THERE IS NO UNDO: every later render of that
   * page shows the ink burnt in, so a session that goes on displaying the
   * document has to reopen it. Can SUSPEND, like `ink_export_page`.
   */
  ink_annotate_page(
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
  ): number;
  /**
   * The whole document, as an INCREMENTAL UPDATE — packed `(ptr << 32) | len`
   * of **the delta only**, the bytes that belong AFTER the original file, or
   * negative. Not a PDF on its own: `original || delta` is.
   *
   * Reads the whole original back through `ink.host_read` (MuPDF's incremental
   * write begins by copying the file it appends to, which the module sinks), so
   * on a streamed document this is a full pass over the file.
   */
  ink_export_incremental(handle: number): bigint;
  /** Release the buffer an export returned. Idempotent. */
  ink_export_free(): void;
  ink_close(handle: number): void;
  ink_error_ptr(): number;
  ink_error_len(): number;
}

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

export const DEFAULT_WASM_URL = "/pdf-decode.wasm";

// ============================================================================
// WASI
// ============================================================================

/** `errno` values we return. WASI's numbering, not POSIX's. */
const ESUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;

/**
 * The 16 `wasi_snapshot_preview1` imports the module declares, stubbed.
 *
 * NONE OF THE FILESYSTEM ONES ARE REACHABLE. The ABI opens a document from a
 * memory buffer (`ink_open`), never a path, so `path_open` and friends exist
 * only because wasi-libc was linked — the linker keeps the import, the code
 * never calls it. They return `ENOSYS` rather than throwing, so a future call
 * surfaces as a MuPDF error instead of a torn-down instance.
 *
 * The three that ARE called are the ones libc's startup touches, and they answer
 * honestly: no environment, no preopened directories, a zero clock.
 */
export function wasiShim(getMemory: () => WebAssembly.Memory): WebAssembly.Imports {
  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);

  return {
    wasi_snapshot_preview1: {
      // --- called during libc startup ---------------------------------------
      environ_sizes_get: (countPtr: number, sizePtr: number) => {
        const d = view();
        d.setUint32(countPtr, 0, true);
        d.setUint32(sizePtr, 0, true);
        return ESUCCESS;
      },
      environ_get: () => ESUCCESS,
      // No preopens. EBADF is how libc learns the list has ended — returning
      // ENOSYS here makes some libc builds retry forever.
      fd_prestat_get: () => EBADF,
      fd_prestat_dir_name: () => EBADF,

      // --- diagnostics ------------------------------------------------------
      /**
       * MuPDF's warnings go to stderr. Surfacing them is worth the few lines:
       * "cannot find font" on a page that renders wrong is the difference
       * between a bug report and a mystery. The byte count MUST be written back
       * or libc treats the write as short and loops.
       */
      fd_write: (fd: number, iovs: number, iovsLen: number, writtenPtr: number) => {
        const d = view();
        const mem = bytes();
        let total = 0;
        let text = "";
        for (let i = 0; i < iovsLen; i++) {
          const base = d.getUint32(iovs + i * 8, true);
          const len = d.getUint32(iovs + i * 8 + 4, true);
          text += new TextDecoder().decode(mem.subarray(base, base + len));
          total += len;
        }
        d.setUint32(writtenPtr, total, true);
        const line = text.trimEnd();
        if (line) console.warn(`[pdf-decode:${fd === 2 ? "stderr" : `fd${fd}`}] ${line}`);
        return ESUCCESS;
      },

      clock_time_get: (_id: number, _precision: bigint, timePtr: number) => {
        view().setBigUint64(timePtr, 0n, true);
        return ESUCCESS;
      },

      /**
       * An abort. MuPDF should never reach this — its failures come back as
       * `fz_try` errors through the ABI's negative returns — so if it fires,
       * something is wrong in a way a silent 0 would hide.
       */
      proc_exit: (code: number) => {
        throw new Error(`pdf-decode called proc_exit(${code})`);
      },

      // --- linked but unreachable: no path is ever opened --------------------
      fd_close: () => ENOSYS,
      fd_read: () => ENOSYS,
      fd_seek: () => ENOSYS,
      fd_fdstat_get: () => ENOSYS,
      fd_fdstat_set_flags: () => ENOSYS,
      fd_filestat_set_size: () => ENOSYS,
      path_open: () => ENOSYS,
      path_remove_directory: () => ENOSYS,
      path_unlink_file: () => ENOSYS,
    },
  };
}

/**
 * The `ink.host_read` import: fill `len` bytes of wasm memory at `dst` from
 * offset `off` in the document, and answer how many were written (or <0).
 *
 * MAY RETURN A PROMISE, but only when the module is instantiated with the
 * function wrapped in `WebAssembly.Suspending` — that is what turns the wasm
 * side's ordinary synchronous call into a suspension. Returning a plain number
 * never suspends, which is the fast path the block cache takes on a hit.
 */
export type HostRead = (off: bigint, dst: number, len: number) => number | Promise<number>;

/**
 * Everything the module imports: WASI, plus the one `ink` namespace.
 *
 * `ink.host_read` is DECLARED BY THE MODULE unconditionally (`pdf_shim.c` gives
 * it `import_module`/`import_name` attributes), so it must be supplied even by
 * callers that only ever use the whole-file `ink_open` — an import a module
 * declares and the embedder omits is a link error, not a lazily-resolved symbol.
 * The default answers -1, which surfaces as a MuPDF read error rather than a
 * trap, so "opened a stream with no host reader" fails honestly.
 */
export function decoderImports(
  getMemory: () => WebAssembly.Memory,
  hostRead: HostRead | WebAssembly.Suspending = () => -1,
): WebAssembly.Imports {
  return { ...wasiShim(getMemory), ink: { host_read: hostRead as never } };
}

// ============================================================================
// Browser support
// ============================================================================

/**
 * Does this engine run the module at all?
 *
 * MuPDF's `fz_try`/`fz_catch` is setjmp-based, which on wasm compiles to the
 * EXCEPTION-HANDLING proposal — so the module carries a `tag` section and an
 * engine without the proposal rejects it at compile time. That floor is roughly
 * Chrome 95+, Firefox 131+, Safari 18.4+, and **no other feature in this app
 * imposes it**, so it is detected rather than assumed: the viewer degrades to
 * the honest "no preview, here is a download" state instead of a dead canvas.
 *
 * Detected by validating a module that declares a tag — the feature itself,
 * not a version sniff.
 */
export function supportsWasmExceptions(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: one func () -> ()
        // Tag section (id 13): one tag, attribute 0 (exception), type index 0.
        // The TYPE SECTION ABOVE IS NOT OPTIONAL — a tag references a type, so
        // without it the module is invalid for a plain reason and this returns
        // false on an engine that supports the proposal perfectly well. Which is
        // the worse failure: a false negative here disables PDFs on a browser
        // that could have run them.
        0x0d, 0x03, 0x01, 0x00, 0x00,
      ]),
    );
  } catch {
    return false;
  }
}

// ============================================================================
// Loader
// ============================================================================

/**
 * The default loader: fetch, instantiate against the shim, run `_initialize`.
 *
 * `hostRead` is the `ink.host_read` import. It is a FUNCTION, not a value,
 * because the caller does not have one until the instance exists — the block
 * cache writes into `memory`, which the instantiation produces. The whole-file
 * path passes nothing and gets the -1 stub.
 */
export function browserLoader(
  wasmUrl: string,
  hostRead?: (getMemory: () => WebAssembly.Memory) => HostRead | WebAssembly.Suspending,
): () => Promise<PdfDecoderExports> {
  let cached: Promise<PdfDecoderExports> | null = null;
  return () =>
    (cached ??= (async () => {
      if (!supportsWasmExceptions()) {
        throw new Error("this browser cannot run the PDF decoder (no wasm exceptions)");
      }
      const res = await fetch(wasmUrl);
      if (!res.ok) throw new Error(`failed to load ${wasmUrl}: ${res.status}`);
      // The shim reads `memory` out of the instance it is being built for, so it
      // is handed a getter rather than the memory itself.
      let exports: PdfDecoderExports | null = null;
      const memory = () => exports!.memory;
      const imports = decoderImports(memory, hostRead?.(memory));
      let instance: WebAssembly.Instance;
      try {
        // Fast path: needs `Content-Type: application/wasm` from the server.
        ({ instance } = await WebAssembly.instantiateStreaming(res.clone(), imports));
      } catch {
        ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), imports));
      }
      exports = instance.exports as unknown as PdfDecoderExports;
      exports._initialize?.();
      return exports;
    })());
}

const defaultPdfDecoder = browserLoader(DEFAULT_WASM_URL);
export function loadPdfDecoder(): Promise<PdfDecoderExports> {
  return defaultPdfDecoder();
}

// ============================================================================
// The typed wrapper
// ============================================================================

/** The last MuPDF message, or a fallback. Read immediately after a failure. */
export function lastError(x: PdfDecoderExports, fallback: string): string {
  const ptr = x.ink_error_ptr();
  const len = x.ink_error_len();
  if (!ptr || !len) return fallback;
  return new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len));
}

// ============================================================================
// The document wrapper
// ============================================================================

/**
 * The five entry points that can SUSPEND once the document is a stream.
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
 */
export interface PdfCalls {
  openWhole(ptr: number, len: number): number | Promise<number>;
  openStream(totalLen: bigint): number | Promise<number>;
  pageCount(handle: number): number | Promise<number>;
  pageSize(handle: number, page: number, wPtr: number, hPtr: number): number | Promise<number>;
  render(handle: number, page: number, scale: number): bigint | Promise<bigint>;
  /**
   * OPTIONAL IN THE TYPE, MANDATORY ON THE JSPI PATH, for the same reason
   * `pageSize` is not optional at all: listing a page's links LOADS the page,
   * and resolving an internal destination walks the xref again. Unwrapped on a
   * streamed document that traps the instance on its first suspension.
   * {@link AsyncPdfDocument.pageLinks} falls back to the raw export when it is
   * absent, which is right for `syncCalls` and wrong for a promising wrapper.
   */
  pageLinks?(handle: number, page: number): bigint | Promise<bigint>;
  /**
   * OPTIONAL IN THE TYPE, MANDATORY ON THE JSPI PATH. `ink_export_page` grafts a
   * page, which walks the source document's xref and so can re-enter
   * `ink.host_read`; on a streamed document an unwrapped call TRAPS the instance
   * the moment it suspends rather than waiting. It is optional here only so that
   * a caller building a `PdfCalls` by hand — and every non-JSPI caller, where
   * nothing suspends — is not forced to name a call it will never make.
   * {@link AsyncPdfDocument.exportPage} falls back to the raw export when it is
   * absent, which is right for `syncCalls` and wrong for a promising wrapper.
   */
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
  /**
   * OPTIONAL IN THE TYPE, MANDATORY ON THE JSPI PATH, for exactly the reason
   * `exportPage` is: annotating loads the page, which walks the xref.
   */
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
  /**
   * The one call that reads the WHOLE document back — MuPDF's incremental write
   * copies the file it appends to, and the module sinks that copy. Unwrapped on
   * a streamed document it would trap on its first suspension.
   */
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
 * ASYNC EVEN WHEN NOTHING WAITS. There was a sync twin of this class, for "a
 * caller that already holds the bytes", and it had no such caller: the whole-file
 * path is `openWhole` driven by {@link syncCalls}, which is what the worker uses
 * for every browser without JSPI. So the twin duplicated the scratch-pointer
 * dance, the packed-return unpacking, `close`/`alive` and the error strings to
 * serve tests alone — two copies of the ABI to keep in step, and a suite that
 * could stay green while they drifted, since it exercised each separately.
 * `await 5` is 5; one class covers both transports.
 *
 * MEMORY DISCIPLINE IS THE SAME, and matters more here. Every pointer is re-read
 * after the call that produced it, because an `await` in the middle of a method
 * is a place where wasm memory can have grown and the old `ArrayBuffer` detached.
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
   * AN EMPTY LIST IS AN ANSWER, not a failure: most pages have no links, and
   * this must not throw for them. What it will not do is invent one — a page
   * the decoder refuses answers with `[]` too, because the caller's only
   * response to either is the same (draw no link layer) and a viewer that
   * threw here would take the PAGE down with it.
   *
   * The bytes are copied out and parsed before the module's buffer is released,
   * on every path — it is small, but it is one at a time, and the next page's
   * links would otherwise be waiting on this one.
   */
  async pageLinks(page: number): Promise<PdfLink[]> {
    const x = this.x;
    const call = this.c.pageLinks ?? x.ink_page_links;
    try {
      const packed = await call(this.alive(), page);
      if (packed < 0n) return [];
      // `memory.buffer` is re-read HERE and not captured: the call allocates,
      // and on the JSPI path it also suspended — the same window, longer name.
      const json = new TextDecoder().decode(
        new Uint8Array(x.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
      );
      return parsePageLinks(json);
    } finally {
      x.ink_links_free();
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
   * THE DIFFERENCE FROM `render`. `render` gives pixels, and a PDF built from
   * pixels is a picture of a page: no selectable text, no fonts, no vectors, and
   * whatever page size the writer chose. This asks the module to GRAFT the
   * source page into a fresh one-page document and draw the ink over it, so all
   * of that survives. What does not survive is the source page's `/Annots` —
   * links and pre-existing highlights — because `pdf_graft_page` does not copy
   * them; see `webapp/wasm/pdf_shim.c`.
   *
   * `alpha` is `width * height` coverage bytes, 255 = full ink. `matrix` maps
   * that image's OWN PIXEL SPACE onto the page in display space — build it with
   * `markExportMatrix`, never by hand.
   *
   * The bytes are COPIED OUT of wasm memory before returning, and both the
   * scratch buffer and the module's own copy are released on every path: the
   * export is page-sized, and one left behind is one that stays resident.
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
   * WHY THIS EXISTS BESIDE `exportPage`. Grafting every page into a fresh
   * document would drop each one's `/Annots`, so a 77-page export would lose
   * every link and highlight the original had. This route does not graft: it
   * annotates the pages that were written on and then writes an INCREMENTAL
   * UPDATE, which keeps the original's bytes and appends only what changed.
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
   * `memory.buffer` is re-read HERE and not captured before the call: an export
   * allocates, so the buffer a earlier view was taken from may have been
   * replaced — and on the JSPI path the call suspended, which is the same window
   * with a longer name.
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
