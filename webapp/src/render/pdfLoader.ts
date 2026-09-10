// The PDF DECODER LOADER — the wasm module, and nothing that uses it. The WASI
// import shim, the `ink` import table, the exception-support probe, and the
// fetch-and-instantiate path that produces a `PdfDecoderExports`.
//
// Lives outside `pages/` for the same reason `spdDecode.ts` does: a viewer is
// not the only plausible consumer (a thumbnail path, an export path). The typed
// document wrapper over these exports is `pdfDocument.ts`.

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
  /**
   * The page's WORDS and where they sit, as UTF-8 JSON — packed
   * `(ptr << 32) | len`, or negative. A page with no text answers `[]`, which is
   * a SUCCESS.
   *
   * The boxes are in the same space `ink_page_size` reports. NO NEEDLE CROSSES
   * HERE: the module locates, it does not match — see `render/pdfWire.ts`.
   * Building the structured text RUNS the page, so this SUSPENDS more readily
   * than anything else in this interface.
   */
  ink_page_words(handle: number, page: number): bigint;
  /** Release the buffer `ink_page_words` returned. Idempotent. */
  ink_words_free(): void;
  /**
   * The document's OUTLINE — its own table of contents — as UTF-8 JSON, packed
   * `(ptr << 32) | len`, or negative. A document with no outline answers `[]`,
   * which is a SUCCESS.
   *
   * PER DOCUMENT, not per page: one small flat array in document order (see
   * `render/pdfWire.ts`). Loading it walks the outline tree AND resolves each
   * entry's destination to a page number — a second walk of the xref — so it
   * SUSPENDS on a streamed document.
   */
  ink_load_outline(handle: number): bigint;
  /** Release the buffer `ink_load_outline` returned. Idempotent. */
  ink_outline_free(): void;
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
       * MuPDF's warnings go to stderr, and "cannot find font" on a page that
       * renders wrong is the difference between a bug report and a mystery. The
       * byte count MUST be written back or libc treats the write as short and
       * loops.
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
 * imposes it**, so it is detected (by validating a module that declares a tag —
 * the feature itself, not a version sniff) rather than assumed.
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
        // false on an engine that supports the proposal perfectly well,
        // disabling PDFs on a browser that could have run them.
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
