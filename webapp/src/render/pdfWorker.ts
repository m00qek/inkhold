// The PDF worker: MuPDF, the block cache and every `ink_*` call off the main
// thread (rastering janks the UI; `createImageBitmap` here transfers without a
// pixel copy). One document at a time, requests serialised: the module has one
// handle table, one render buffer and one suspendable stack.

import {
  DEFAULT_WASM_URL,
  browserLoader,
  type HostRead,
  type PdfDecoderExports,
} from "./pdfLoader";
import { AsyncPdfDocument, syncCalls, type PdfCalls } from "./pdfDocument";
import { BlockCache, type PdfCacheStats } from "./pdfBlocks";
import { HttpError, fetchWhole, rangeFetcher } from "./pdfTransport";
import type { PdfInkOverlay, PdfOpenMode, PdfRequest, PdfResponse } from "./pdfWorkerTypes";

/** The worker global, typed by hand: the app's `DOM` lib types `self` as `Window`. */
interface WorkerScope {
  postMessage(message: PdfResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", cb: (ev: MessageEvent<PdfRequest>) => void): void;
}
const ctx = globalThis as unknown as WorkerScope;

/**
 * Is JSPI here? Works in a non-secure LAN context. Without it MuPDF can't
 * suspend on a `fetch`, so the document is downloaded whole.
 */
function hasJspi(): boolean {
  return (
    typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function"
  );
}

const jspi = hasJspi();

let cache: BlockCache | null = null;
let doc: AsyncPdfDocument | null = null;
let mode: PdfOpenMode | null = null;
let lastStats: PdfCacheStats | null = null;
let source: { url: string; size: number } | null = null;
/**
 * A local copy of the file that `host_read` prefers while set: installed only
 * during the whole-document export, whose incremental write reads the whole
 * original back.
 */
let localCopy: ((off: number, len: number) => Promise<Uint8Array>) | null = null;

/**
 * Read `blob` through one 4 MB sliding window: a sequential local pass, where
 * the cache's 32 KB network blocks would mean thousands of slice round trips.
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
 * `ink.host_read`. Returns a number on a cache hit and a promise only on a miss:
 * a `Suspending` import that returns a value doesn't move the wasm stack.
 */
function makeHostRead(getMemory: () => WebAssembly.Memory): HostRead {
  const copy = (bytes: Uint8Array, dst: number): number => {
    // Re-read `memory.buffer`: a suspension may have grown and detached it.
    new Uint8Array(getMemory().buffer, dst, bytes.length).set(bytes);
    return bytes.length;
  };
  return (off, dst, len) => {
    const at = Number(off);
    // The local copy wins while installed (same file, length-checked).
    if (localCopy) return localCopy(at, len).then((bytes) => copy(bytes, dst), () => -1);
    const c = cache;
    if (!c) return -1;
    const got = c.read(at, len);
    if (got instanceof Uint8Array) return copy(got, dst);
    return got.then(
      (bytes) => copy(bytes, dst),
      // Becomes MuPDF's "cannot read" inside `fz_try`, not a trap.
      () => -1,
    );
  };
}

const loadDecoder = browserLoader(DEFAULT_WASM_URL, (getMemory) => {
  // Without JSPI nothing can suspend; the import still must be supplied.
  if (!jspi) return () => -1;
  return new WebAssembly.Suspending(makeHostRead(getMemory));
});

/**
 * The exports wrapped so anything that can reach `ink.host_read` returns a
 * promise; an unwrapped one traps the instance on its first suspension. `useJspi`
 * is a parameter so `pdfWorker.test.ts` can assert the table, since a missing
 * wrapper only breaks range-served documents in a real browser.
 */
export function callsFor(x: PdfDecoderExports, useJspi: boolean = jspi): PdfCalls {
  if (!useJspi) return syncCalls(x);
  return {
    openWhole: (ptr, len) => x.ink_open(ptr, len),
    openStream: WebAssembly.promising(x.ink_open_stream),
    pageCount: WebAssembly.promising(x.ink_page_count),
    pageSize: WebAssembly.promising(x.ink_page_size),
    pageLinks: WebAssembly.promising(x.ink_page_links),
    pageWords: WebAssembly.promising(x.ink_page_words),
    loadOutline: WebAssembly.promising(x.ink_load_outline),
    render: WebAssembly.promising(x.ink_render),
    // Not optional here: `AsyncPdfDocument` falls back to the raw export when absent.
    exportPage: WebAssembly.promising(x.ink_export_page),
    annotatePage: WebAssembly.promising(x.ink_annotate_page),
    exportIncremental: WebAssembly.promising(x.ink_export_incremental),
  };
}

// ---- handlers ----

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
    // Prime block 0 before the open: MuPDF sniffs it first, and the response
    // settles the true length.
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
  // `createImageBitmap` here so the result transfers instead of being cloned.
  const bitmap = await createImageBitmap(new ImageData(bmp.rgba, bmp.width, bmp.height), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  return { kind: "rendered", id: 0, bitmap, width: bmp.width, height: bmp.height };
}

/** One page as a PDF: the source page grafted, ink drawn as an image mask. */
async function exportPage(page: number, ink: PdfInkOverlay): Promise<Uint8Array> {
  if (!doc) throw new Error("no document is open");
  // Mask size is checked in `pdfClient.ts` and `AsyncPdfDocument.exportPage`.
  return doc.exportPage(page, ink.alpha, ink.width, ink.height, ink.matrix);
}

/**
 * Annotation mutates the open document with no undo, so it must be reopened
 * before the viewer uses it again, including after a failed export.
 */
let annotated = false;

/** Draw ink into the open document for one page of the whole-document export. */
async function annotatePage(page: number, ink: PdfInkOverlay): Promise<void> {
  if (!doc) throw new Error("no document is open");
  await doc.annotatePage(page, ink.alpha, ink.width, ink.height, ink.matrix);
  // Set after the call: a refusal happens before the module touches anything.
  annotated = true;
}

/**
 * The whole document as an incremental-update delta. `original` is checked
 * against the opened length: reading a different file mid-write would produce
 * an undetectably wrong delta.
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
    // Always reopen, especially on failure: the pages were already mutated.
    await reopen();
  }
}

async function reopen(): Promise<void> {
  if (!annotated || !source) return;
  annotated = false;
  const x = await loadDecoder();
  const calls = callsFor(x);
  doc?.close();
  doc = null;
  // The block cache survives on the streamed path (the original's bytes are
  // unchanged); the whole-file path re-fetches from the HTTP cache.
  if (mode === "stream" && cache) {
    doc = await AsyncPdfDocument.openStream(x, calls, cache.length);
  } else {
    inflight ??= new AbortController();
    doc = await AsyncPdfDocument.openWhole(x, calls, await fetchWhole(source.url, inflight.signal));
  }
}

/**
 * Requests run one at a time: a `close` overtaking a suspended render would
 * free the document under wasm about to resume into it.
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
      case "outline": {
        if (!doc) throw new Error("no document is open");
        ctx.postMessage({ kind: "outline", id: req.id, entries: await doc.outline() });
        return;
      }
      case "render": {
        const out = await render(req.page, req.scale);
        ctx.postMessage({ ...out, id: req.id }, [out.bitmap]);
        return;
      }
      case "exportPage": {
        const bytes = await exportPage(req.page, req.ink);
        // Transferred: a grafted page carries fonts and images.
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
