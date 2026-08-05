// The PDF WORKER — MuPDF, the block cache and every `ink_*` call, off the main
// thread. `docs/scratch/pdf-ranges.md` §3.
//
// TWO REASONS IT IS A WORKER, and only one of them is JSPI. Rastering a 77-page
// A4 document on the main thread janks the UI for as long as it takes; and
// `createImageBitmap` here transfers to the main thread's canvas with no pixel
// copy, where an `ImageData` would have to be structured-cloned. JSPI works on
// either thread — this is about responsiveness, which is the other half of the
// mantra.
//
// It owns exactly one document at a time. Requests are SERIALISED (see `queue`)
// because the module has one handle table, one last-render buffer and, on the
// JSPI path, one suspendable stack: two overlapping renders would interleave
// inside wasm and hand back each other's pixels.

import {
  AsyncPdfDocument,
  DEFAULT_WASM_URL,
  browserLoader,
  syncCalls,
  type HostRead,
  type PdfCalls,
  type PdfDecoderExports,
} from "./pdfDecode";
import { BlockCache, type PdfCacheStats } from "./pdfBlocks";
import { HttpError, fetchWhole, rangeFetcher } from "./pdfTransport";
import type { PdfOpenMode, PdfRequest, PdfResponse } from "./pdfWorkerTypes";

/**
 * The worker's global, typed by hand.
 *
 * `tsconfig.json` gives this app the `DOM` lib, under which `self` is a
 * `Window`. Adding `WebWorker` would make the two libs collide across every
 * file in `src/`, and this is the only module that is not a document. One
 * interface is cheaper than a second tsconfig.
 */
interface WorkerScope {
  postMessage(message: PdfResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", cb: (ev: MessageEvent<PdfRequest>) => void): void;
}
const ctx = globalThis as unknown as WorkerScope;

/**
 * Is JSPI here? (`pdf-ranges.md` §2.2 measured it present in Chromium 149, in a
 * non-secure, non-isolated context — which is what a household box on
 * `http://<lan-ip>` has to work in.)
 *
 * Feature-detected, never version-sniffed, and the answer picks a whole
 * transport: without it MuPDF cannot suspend on a `fetch`, so the document is
 * downloaded whole and opened from a buffer. Both paths are exercised — the
 * fallback is what Firefox and Safari may still be on (§6.1).
 */
function hasJspi(): boolean {
  return (
    typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function"
  );
}

const jspi = hasJspi();

/** The live document's cache. `host_read` closes over this box, not the cache. */
let cache: BlockCache | null = null;
let doc: AsyncPdfDocument | null = null;
let mode: PdfOpenMode | null = null;
let lastStats: PdfCacheStats | null = null;

/**
 * `ink.host_read`, the one import the module declares.
 *
 * Returns a NUMBER when the block cache already holds the bytes, and only then a
 * promise. That distinction is the whole performance story: a `Suspending`
 * import that returns a plain value does not move the wasm stack, so the
 * thousands of small reads inside one 512 KB block cost nothing beyond a memcpy.
 */
function makeHostRead(getMemory: () => WebAssembly.Memory): HostRead {
  const copy = (bytes: Uint8Array, dst: number): number => {
    // `memory.buffer` is re-read HERE and not captured: a suspension is exactly
    // the window in which the heap can have grown and the old buffer detached.
    new Uint8Array(getMemory().buffer, dst, bytes.length).set(bytes);
    return bytes.length;
  };
  return (off, dst, len) => {
    const c = cache;
    if (!c) return -1;
    const at = Number(off);
    const got = c.read(at, len);
    if (got instanceof Uint8Array) return copy(got, dst);
    return got.then(
      (bytes) => copy(bytes, dst),
      // A failed range read becomes MuPDF's own "cannot read N bytes at M",
      // raised inside `fz_try` — not a trap and not a wedged instance.
      () => -1,
    );
  };
}

const loadDecoder = browserLoader(DEFAULT_WASM_URL, (getMemory) => {
  // Without JSPI nothing can suspend, so the import is the honest -1 stub and
  // `ink_open_stream` is never called. The module still DECLARES the import, so
  // something must be supplied.
  if (!jspi) return () => -1;
  return new WebAssembly.Suspending(makeHostRead(getMemory));
});

/**
 * The exports, wrapped so that anything which can reach `ink.host_read` returns
 * a promise. All four suspend, not just the two the plan named: `ink_page_count`
 * walks the page tree and `ink_page_size` loads a page, and both of those read
 * bytes on a document that is still mostly unfetched.
 */
function callsFor(x: PdfDecoderExports): PdfCalls {
  if (!jspi) return syncCalls(x);
  return {
    openWhole: (ptr, len) => x.ink_open(ptr, len),
    openStream: WebAssembly.promising(x.ink_open_stream),
    pageCount: WebAssembly.promising(x.ink_page_count),
    pageSize: WebAssembly.promising(x.ink_page_size),
    render: WebAssembly.promising(x.ink_render),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

let inflight: AbortController | null = null;

function release(): void {
  inflight?.abort();
  inflight = null;
  if (cache) lastStats = cache.stats();
  doc?.close();
  doc = null;
  cache = null;
  mode = null;
}

async function open(url: string, size: number): Promise<{ pageCount: number; mode: PdfOpenMode }> {
  release();
  const x = await loadDecoder();
  const calls = callsFor(x);
  inflight = new AbortController();
  const signal = inflight.signal;

  if (jspi && size > 0) {
    const c = new BlockCache({ total: size, fetchRange: rangeFetcher(url, signal) });
    cache = c;
    // Block 0 BEFORE the open, not during it: MuPDF's first act is to sniff the
    // file's opening bytes, so this is the round trip it would have paid anyway
    // — and the response settles the true length, which `size` only guesses at.
    await c.prime();
    doc = await AsyncPdfDocument.openStream(x, calls, c.length);
    mode = "stream";
  } else {
    const bytes = await fetchWhole(url, signal);
    doc = await AsyncPdfDocument.openWhole(x, calls, bytes);
    mode = "whole";
  }
  return { pageCount: await doc.pageCount(), mode };
}

async function render(page: number, scale: number): Promise<PdfResponse & { kind: "rendered" }> {
  if (!doc) throw new Error("no document is open");
  const bmp = await doc.render(page, scale);
  // `createImageBitmap` here rather than `putImageData` on the main thread: the
  // result TRANSFERS, so the pixels cross the thread boundary once, by handoff,
  // instead of being cloned into the message and copied again into the canvas.
  const bitmap = await createImageBitmap(new ImageData(bmp.rgba, bmp.width, bmp.height), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  return { kind: "rendered", id: 0, bitmap, width: bmp.width, height: bmp.height };
}

/**
 * Requests run ONE AT A TIME, in arrival order.
 *
 * The alternative is a race with teeth: `ink_render` reuses a single pixmap and
 * `ink_close` frees the handle table entry, so a `close` overtaking a suspended
 * render would drop the document out from under wasm that is about to resume
 * into it.
 */
let queue: Promise<unknown> = Promise.resolve();

function handle(req: PdfRequest): Promise<void> {
  return (async () => {
    switch (req.kind) {
      case "open": {
        const { pageCount, mode: m } = await open(req.url, req.size);
        ctx.postMessage({ kind: "opened", id: req.id, pageCount, mode: m });
        return;
      }
      case "pageSize": {
        if (!doc) throw new Error("no document is open");
        const size = await doc.pageSize(req.page);
        ctx.postMessage({ kind: "pageSize", id: req.id, ...size });
        return;
      }
      case "render": {
        const out = await render(req.page, req.scale);
        ctx.postMessage({ ...out, id: req.id }, [out.bitmap]);
        return;
      }
      case "stats": {
        ctx.postMessage({
          kind: "stats",
          id: req.id,
          stats: cache?.stats() ?? lastStats,
          mode: mode ?? (doc ? "whole" : null),
        });
        return;
      }
      case "close": {
        release();
        ctx.postMessage({ kind: "closed", id: req.id });
        return;
      }
    }
  })().catch((err: unknown) => {
    ctx.postMessage({
      kind: "error",
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
      status: err instanceof HttpError ? err.status : null,
    });
  });
}

ctx.addEventListener("message", (ev) => {
  const req = ev.data;
  queue = queue.then(() => handle(req));
});
