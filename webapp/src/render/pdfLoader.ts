// The PDF decoder loader: the WASI shim, the `ink` import table, the
// exception-support probe, and fetch-and-instantiate. Typed wrapper:
// `pdfDocument.ts`.

// ---- decoder C-ABI ----
// Pointers are byte offsets into `memory`; re-read each after the call that
// produced it (memory can grow) and copy out before the next call.

export interface PdfDecoderExports {
  memory: WebAssembly.Memory;
  /** WASI reactor: run C constructors once before any `ink_*` call. */
  _initialize?(): void;
  ink_alloc(len: number): number;
  ink_free(ptr: number, len: number): void;
  /** Consumes the buffer on every path, success or failure. */
  ink_open(ptr: number, len: number): number;
  /**
   * Open over the `ink.host_read` callback; `totalLen` is i64 (BigInt). Anything
   * reachable from here can re-enter `host_read`, which suspends under JSPI.
   */
  ink_open_stream(totalLen: bigint): number;
  ink_page_count(handle: number): number;
  ink_page_size(handle: number, page: number, wPtr: number, hPtr: number): number;
  /**
   * The page's links as UTF-8 JSON, packed `(ptr << 32) | len` or negative;
   * `[]` is success. Disallowed schemes never appear. Can suspend.
   */
  ink_page_links(handle: number, page: number): bigint;
  ink_links_free(): void;
  /**
   * The page's words as JSON (packed, `[]` is success); locates only, no
   * matching. Runs the page, so suspends most readily.
   */
  ink_page_words(handle: number, page: number): bigint;
  ink_words_free(): void;
  /**
   * The flat outline as JSON (packed, `[]` is success). Resolves destinations
   * via the xref, so suspends on a streamed document.
   */
  ink_load_outline(handle: number): bigint;
  ink_outline_free(): void;
  /** Packed (ptr << 32) | len, or negative on failure. */
  ink_render(handle: number, page: number, scale: number): bigint;
  ink_render_width(): number;
  ink_render_height(): number;
  /**
   * One page as a one-page PDF: the source page grafted whole, with `alpha`
   * (`w * h` coverage bytes) drawn over it. `a`..`f` map the alpha image's pixel
   * space onto display space (rotation and boxes resolved inside). Packed or
   * negative; can suspend.
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
   * Draw ink onto the open document's page in place (0 or negative), before
   * `ink_export_incremental`. No undo: the session must reopen to display it
   * clean. Can suspend.
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
   * The incremental update's delta only (packed or negative); `original ||
   * delta` is the PDF. Reads the whole original back through `host_read`.
   */
  ink_export_incremental(handle: number): bigint;
  ink_export_free(): void;
  ink_close(handle: number): void;
  ink_error_ptr(): number;
  ink_error_len(): number;
}

export const DEFAULT_WASM_URL = "/pdf-decode.wasm";

// ---- WASI ----

/** WASI errno values (not POSIX). */
const ESUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;

/**
 * The 16 `wasi_snapshot_preview1` imports, stubbed. Filesystem ones are linked
 * but unreachable and return `ENOSYS`; the startup ones report no environment,
 * no preopens, a zero clock.
 */
export function wasiShim(getMemory: () => WebAssembly.Memory): WebAssembly.Imports {
  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);

  return {
    wasi_snapshot_preview1: {
      environ_sizes_get: (countPtr: number, sizePtr: number) => {
        const d = view();
        d.setUint32(countPtr, 0, true);
        d.setUint32(sizePtr, 0, true);
        return ESUCCESS;
      },
      environ_get: () => ESUCCESS,
      // EBADF ends the preopen list; ENOSYS makes some libc builds retry forever.
      fd_prestat_get: () => EBADF,
      fd_prestat_dir_name: () => EBADF,

      /** MuPDF warnings to stderr; the byte count must be written back or libc loops. */
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

      /** MuPDF failures return via `fz_try`, so an abort means something is badly wrong. */
      proc_exit: (code: number) => {
        throw new Error(`pdf-decode called proc_exit(${code})`);
      },

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
 * `ink.host_read`: fill `len` bytes at `dst` from document offset `off`. May
 * return a Promise only under `WebAssembly.Suspending`; a number is the fast path.
 */
export type HostRead = (off: bigint, dst: number, len: number) => number | Promise<number>;

/**
 * All module imports. `ink.host_read` is always declared by the module, so it
 * must be supplied even for whole-file `ink_open`; the default answers -1 (a
 * MuPDF read error, not a trap).
 */
export function decoderImports(
  getMemory: () => WebAssembly.Memory,
  hostRead: HostRead | WebAssembly.Suspending = () => -1,
): WebAssembly.Imports {
  return { ...wasiShim(getMemory), ink: { host_read: hostRead as never } };
}

// ---- browser support ----

/**
 * MuPDF's setjmp-based `fz_try` compiles to wasm exception handling (a `tag`
 * section), roughly Chrome 95+, Firefox 131+, Safari 18.4+. Detected by
 * validating a module that declares a tag.
 */
export function supportsWasmExceptions(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: one func () -> ()
        // Tag section (id 13): one tag, exception, type 0. Needs the type section
        // above, or a supporting engine would also return false.
        0x0d, 0x03, 0x01, 0x00, 0x00,
      ]),
    );
  } catch {
    return false;
  }
}

// ---- loader ----

/**
 * Fetch, instantiate against the shim, run `_initialize`. `hostRead` is a
 * factory because the block cache needs the instance's `memory` first.
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
      // The shim gets a memory getter: memory comes from the instance being built.
      let exports: PdfDecoderExports | null = null;
      const memory = () => exports!.memory;
      const imports = decoderImports(memory, hostRead?.(memory));
      let instance: WebAssembly.Instance;
      try {
        // Needs `Content-Type: application/wasm`.
        ({ instance } = await WebAssembly.instantiateStreaming(res.clone(), imports));
      } catch {
        ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), imports));
      }
      exports = instance.exports as unknown as PdfDecoderExports;
      exports._initialize?.();
      return exports;
    })());
}

// ---- typed wrapper ----

/** The last MuPDF message, or a fallback. Read immediately after a failure. */
export function lastError(x: PdfDecoderExports, fallback: string): string {
  const ptr = x.ink_error_ptr();
  const len = x.ink_error_len();
  if (!ptr || !len) return fallback;
  return new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len));
}
