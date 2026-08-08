// The PDF WORKER — MuPDF, the block cache and every `ink_*` call, off the main
// thread.
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
import type { PdfInkOverlay, PdfOpenMode, PdfRequest, PdfResponse } from "./pdfWorkerTypes";

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
 * Is JSPI here? (measured present in Chromium 149, in a
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
/** What `open` was told, so the document can be reopened after an export. */
let source: { url: string; size: number } | null = null;
/**
 * A LOCAL copy of the file that `host_read` prefers while it is set.
 *
 * Installed only for the duration of the whole-document export, whose first act
 * inside MuPDF is to read the entire original back (see `exportDocument`). Over
 * the network that would be a second download of the whole file, which on the
 * 3G link this app is designed for is the difference between a feature and a
 * regret. Reading it out of the Blob the main thread already holds is local and
 * disk-backed.
 */
let localCopy: ((off: number, len: number) => Promise<Uint8Array>) | null = null;

/**
 * Read `blob` through ONE sliding window rather than through the block cache.
 *
 * 4 MB, and not `BLOCK_SIZE`. The block cache's 32 KB blocks are sized for a
 * SCATTERED access pattern over a network — the measurement that chose them is
 * about round trips. This read is the opposite: one strictly sequential pass
 * over the whole file with no latency to amortise, where 32 KB blocks would mean
 * 2,400 `slice().arrayBuffer()` round trips for a 76 MB document instead of 19.
 */
function blobReader(blob: Blob): (off: number, len: number) => Promise<Uint8Array> {
  const WINDOW = 4 * 1024 * 1024;
  let win = new Uint8Array(0);
  let winAt = 0;
  return async (off, len) => {
    if (off < winAt || off + len > winAt + win.length) {
      winAt = off;
      const end = Math.min(blob.size, off + Math.max(WINDOW, len));
      win = new Uint8Array(await blob.slice(off, end).arrayBuffer());
    }
    return win.subarray(off - winAt, off - winAt + len);
  };
}

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
    const at = Number(off);
    // The local copy WINS while it is installed: same bytes, no network. It is
    // only ever the file this document was opened from — `exportDocument`
    // checks the length before installing it — so preferring it cannot change
    // what MuPDF reads, only where it comes from.
    if (localCopy) return localCopy(at, len).then((bytes) => copy(bytes, dst), () => -1);
    const c = cache;
    if (!c) return -1;
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
 *
 * EXPORTED, AND `useJspi` IS A PARAMETER, PURELY SO THIS CAN BE TESTED. The
 * branch is otherwise unreachable from a test — `jspi` is decided once at module
 * load from the real engine's capabilities — and the failure it guards is
 * invisible to every other kind of check: forget one wrapper and the suite stays
 * green, the whole-file path stays correct, and only a RANGE-SERVED document in
 * a real browser traps the instance on its first suspension. That is a
 * production-only bug behind a green board, so the table gets an assertion of
 * its own (`pdfWorker.test.ts`).
 */
export function callsFor(x: PdfDecoderExports, useJspi: boolean = jspi): PdfCalls {
  if (!useJspi) return syncCalls(x);
  return {
    openWhole: (ptr, len) => x.ink_open(ptr, len),
    openStream: WebAssembly.promising(x.ink_open_stream),
    pageCount: WebAssembly.promising(x.ink_page_count),
    pageSize: WebAssembly.promising(x.ink_page_size),
    // Listing a page's links LOADS the page, and resolving an internal
    // destination walks the xref a second time — both read bytes, so both
    // suspend on a document that is still mostly unfetched.
    pageLinks: WebAssembly.promising(x.ink_page_links),
    // Extracting a page's WORDS runs the page — every font, every image, every
    // content stream it references — so of everything in this table it is the
    // most certain to suspend on a range-served document.
    pageWords: WebAssembly.promising(x.ink_page_words),
    render: WebAssembly.promising(x.ink_render),
    // NOT OPTIONAL on this branch, whatever `PdfCalls` says. `ink_export_page`
    // grafts a page, which walks the source document's xref and so can re-enter
    // `ink.host_read`; unwrapped, the first suspension on a streamed document
    // TRAPS the instance instead of waiting. `AsyncPdfDocument.exportPage` falls
    // back to the raw export when this is absent — right for `syncCalls` on the
    // non-JSPI branch above, where nothing suspends, and wrong here.
    exportPage: WebAssembly.promising(x.ink_export_page),
    // Both halves of the whole-document export, for the same reason: annotating
    // loads a page (an xref walk), and the incremental write reads the ENTIRE
    // original back through `ink.host_read`. Unwrapped, either would trap the
    // instance on its first suspension.
    annotatePage: WebAssembly.promising(x.ink_annotate_page),
    exportIncremental: WebAssembly.promising(x.ink_export_incremental),
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
  source = null;
  localCopy = null;
  annotated = false;
}

async function open(url: string, size: number): Promise<{ pageCount: number; mode: PdfOpenMode }> {
  release();
  source = { url, size };
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
 * ONE PAGE, AS A PDF — the original page's structure with the ink over it.
 *
 * NOT A RASTER, which is the entire reason this row exists: `render` above hands
 * back pixels, and a PDF made from those pixels has no selectable text, no
 * fonts and no vectors. This asks the module to GRAFT the source page — its own
 * content streams and the resources they reference — into a fresh one-page
 * document, then draw the ink over it as an image mask.
 *
 * The refusals are the module's to make and they surface as a thrown error,
 * which `handle` turns into an `{ kind: "error" }` response: a source that is
 * not a PDF at all, a page that will not graft, a document already closed.
 */
async function exportPage(page: number, ink: PdfInkOverlay): Promise<Uint8Array> {
  if (!doc) throw new Error("no document is open");
  // NO SIZE CHECK HERE, and two on either side of it. `pdfClient.ts` refuses a
  // mismatched mask before the buffer is even handed over, and
  // `AsyncPdfDocument.exportPage` refuses it again immediately before the
  // pointer reaches wasm. A third copy in the middle would be the one no test
  // reaches and the one that drifts.
  return doc.exportPage(page, ink.alpha, ink.width, ink.height, ink.matrix);
}

/**
 * Has any page been drawn on since the document was opened?
 *
 * `ink_annotate_page` MUTATES the open document and there is no undo, so a
 * document that has been annotated is spent: rendering it again would show the
 * ink burnt into the page AND the `.mark` overlay on top of it, drawn twice.
 * This is what says the document has to be reopened before the viewer uses it
 * again — including when the export FAILED, which is the path that would
 * otherwise leave a half-annotated document behind.
 */
let annotated = false;

/**
 * ONE PAGE OF THE WHOLE-DOCUMENT EXPORT: draw the ink into the open document.
 *
 * Sparse by nature — the real corpus is 7 annotated pages out of 77 — so this
 * is called a handful of times even for a long document, once per page the
 * `.mark` actually wrote on.
 */
async function annotatePage(page: number, ink: PdfInkOverlay): Promise<void> {
  if (!doc) throw new Error("no document is open");
  await doc.annotatePage(page, ink.alpha, ink.width, ink.height, ink.matrix);
  // Set AFTER the call, not before: a refusal (a repaired file, junk before the
  // header) is made by the module before it touches anything, so a document
  // that refused its first page is still clean and needs no reopen.
  annotated = true;
}

/**
 * The whole document, as the delta of an incremental update.
 *
 * `original` is lent by the main thread — see `exportDocument` in
 * `pdfWorkerTypes.ts` for why it is not a convenience. It is checked against
 * the length the document was opened with, because pointing MuPDF's reads at a
 * DIFFERENT file mid-write would produce a delta that is wrong in a way nothing
 * downstream could detect.
 */
async function exportDocument(original: Blob): Promise<Uint8Array> {
  if (!doc) throw new Error("no document is open");
  const expected = cache?.length ?? source?.size ?? 0;
  if (expected > 0 && original.size !== expected) {
    throw new Error("the copy of this PDF does not match the one that is open");
  }
  localCopy = blobReader(original);
  try {
    return await doc.exportIncremental();
  } finally {
    localCopy = null;
    // ALWAYS, and on the failure path especially: the pages were mutated before
    // the write was attempted, so leaving this document open would show the ink
    // twice on every page the user turns back to.
    await reopen();
  }
}

/** Replace the spent document with a clean one, keeping everything else. */
async function reopen(): Promise<void> {
  if (!annotated || !source) return;
  annotated = false;
  const x = await loadDecoder();
  const calls = callsFor(x);
  doc?.close();
  doc = null;
  // The block cache SURVIVES on the streamed path — it holds the original's
  // bytes, which have not changed, and re-priming it would cost a round trip
  // for nothing. The whole-file path has no cache to keep and re-fetches; that
  // is the non-JSPI fallback, where the file is in the HTTP cache anyway.
  if (mode === "stream" && cache) {
    doc = await AsyncPdfDocument.openStream(x, calls, cache.length);
  } else {
    inflight ??= new AbortController();
    doc = await AsyncPdfDocument.openWhole(x, calls, await fetchWhole(source.url, inflight.signal));
  }
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
      case "pageLinks": {
        if (!doc) throw new Error("no document is open");
        ctx.postMessage({ kind: "pageLinks", id: req.id, links: await doc.pageLinks(req.page) });
        return;
      }
      case "pageWords": {
        if (!doc) throw new Error("no document is open");
        ctx.postMessage({ kind: "pageWords", id: req.id, words: await doc.pageWords(req.page) });
        return;
      }
      case "render": {
        const out = await render(req.page, req.scale);
        ctx.postMessage({ ...out, id: req.id }, [out.bitmap]);
        return;
      }
      case "exportPage": {
        const bytes = await exportPage(req.page, req.ink);
        // TRANSFERRED, like the rendered bitmap: a grafted page carries the
        // source page's fonts and images, so this is not a small message.
        ctx.postMessage({ kind: "exportedPage", id: req.id, bytes }, [
          bytes.buffer as ArrayBuffer,
        ]);
        return;
      }
      case "annotatePage": {
        await annotatePage(req.page, req.ink);
        ctx.postMessage({ kind: "annotatedPage", id: req.id });
        return;
      }
      case "exportDocument": {
        const delta = await exportDocument(req.original);
        // TRANSFERRED like the rest — though this one is the small message the
        // whole design is for: tens of kilobytes, where the document it belongs
        // to is tens of megabytes and never leaves the disk.
        ctx.postMessage({ kind: "exportedDocument", id: req.id, delta }, [
          delta.buffer as ArrayBuffer,
        ]);
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
