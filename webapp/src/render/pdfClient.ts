// The MAIN-THREAD half of the PDF worker: one session per open document.
//
// It owns the `Worker`, tags every request with an id and hands back promises.
// The viewer never sees a `postMessage`; it asks for a page and gets pixels.

import type { PdfPageSize } from "./pdfDecode";
import type { PdfCacheStats } from "./pdfBlocks";
import type { PdfInkOverlay, PdfOpenMode, PdfRequest, PdfResponse } from "./pdfWorkerTypes";

/**
 * Re-exported so a PAGE never imports the worker protocol directly: this module
 * is the main thread's whole view of the decoder, and `pages/` should meet it
 * here or not at all.
 */
export type { PdfInkOverlay } from "./pdfWorkerTypes";

/** A rendered page, ready for `drawImage`. CLOSE IT once drawn. */
export interface PdfFrame {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/** What the block cache saw, plus which transport was used. */
export interface PdfSessionStats {
  mode: PdfOpenMode | null;
  cache: PdfCacheStats | null;
}

/** An HTTP failure fetching the file, carrying the status so 401/403 can re-auth. */
export class PdfLoadError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "pdf load failed" : `pdf load failed: HTTP ${status}`);
    this.name = "PdfLoadError";
  }
}

/**
 * The viewer's whole view of the decoder. Everything is async, because
 * everything now can be: a page size may have to wait on a byte range.
 */
export interface PdfSession {
  open(url: string, size: number): Promise<{ pageCount: number; mode: PdfOpenMode }>;
  pageSize(page: number): Promise<PdfPageSize>;
  render(page: number, scale: number): Promise<PdfFrame>;
  /**
   * One page as a PDF of its own, with `ink` drawn over it — the page's own
   * content streams, not a picture of them.
   *
   * `ink.alpha`'s buffer is TRANSFERRED and is DETACHED here: it is several
   * megabytes that would otherwise be structured-cloned across the boundary, and
   * the caller has no further use for it (the same handoff `render` gets back
   * the other way). Reading it after this call yields a zero-length view.
   */
  exportPage(page: number, ink: PdfInkOverlay): Promise<Uint8Array>;
  stats(): Promise<PdfSessionStats>;
  /** Drop the document; the worker (and its compiled module) stays warm. */
  close(): Promise<void>;
  /** Tear the worker down for good. */
  destroy(): void;
}

/**
 * The most recent `stats()` answer, also published as `__inkholdPdfStats`.
 *
 * A DIAGNOSTIC SURFACE, not a test hook — though the acceptance test in
 * `docs/scratch/pdf-ranges.md` §7 is exactly this question. "How many requests
 * and how many bytes did page 1 of that document cost?" has no other answer on
 * a real device, and the whole design is a bet about that number: on a 3G link
 * a bad access pattern is the difference between three seconds and thirty.
 */
let published: PdfSessionStats | null = null;
export function lastPdfStats(): PdfSessionStats | null {
  return published;
}

type Pending = { resolve: (r: PdfResponse) => void; reject: (e: unknown) => void };

/**
 * A request minus the id, which `send` assigns.
 *
 * DISTRIBUTIVE on purpose: a plain `Omit<PdfRequest, "id">` collapses the union
 * into one object with every member's fields optional-at-best, and then rejects
 * `{ kind: "open", url, size }`.
 */
type Unsent<T> = T extends PdfRequest ? Omit<T, "id"> : never;

/**
 * The `Worker` itself, injectable — the same seam habit as `LazyEngineDeps` and
 * `PdfSeam`. Without it the death path below cannot be tested at all: a real
 * worker only fires `error` for a module that will not compile or an instance
 * the engine killed, neither of which a test can stage.
 */
export type PdfWorkerFactory = () => Worker;

const defaultWorker: PdfWorkerFactory = () =>
  new Worker(new URL("./pdfWorker.ts", import.meta.url), { type: "module" });

export function createPdfSession(makeWorker: PdfWorkerFactory = defaultWorker): PdfSession {
  const worker = makeWorker();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let dead = false;

  worker.addEventListener("message", (ev: MessageEvent<PdfResponse>) => {
    const res = ev.data;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.kind === "error") {
      // A fetch failure keeps its status, because 401/403 is the shell's to
      // handle (re-authenticate) and not a message to paint.
      p.reject(res.status === null ? new Error(res.message) : new PdfLoadError(res.status));
      return;
    }
    p.resolve(res);
  });
  // A worker that dies (an OOM on a very large raster, a module that will not
  // compile) must fail every waiter rather than leave the viewer on "Opening…".
  //
  // AND MARK THE SESSION DEAD, or only the in-flight half is covered: the next
  // `send` would post to a worker that will never answer, and that request has
  // no one left to reject it — the viewer sits on "Opening this PDF…" forever,
  // which is the very state this handler exists to prevent.
  //
  // Terminal is the right reading of this event. The worker catches everything
  // it can and answers with an `{ kind: "error" }` RESPONSE (`pdfWorker.ts`,
  // `handle`), so a recoverable failure never reaches here; what does is a
  // module that would not compile or an instance the engine killed, and neither
  // recovers. `createPdfViewer` holds one session for its whole life, so a dead
  // one surfaces as an honest placeholder on the next open rather than a hang.
  worker.addEventListener("error", (ev: ErrorEvent) => {
    dead = true;
    const err = new Error(ev.message || "the PDF worker stopped");
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  /**
   * `transfer` HANDS OVER the listed buffers rather than cloning them — the same
   * economy the worker uses for a rendered bitmap, in the other direction. Only
   * the ink overlay uses it; every other request is a handful of numbers.
   */
  function send(req: Unsent<PdfRequest>, transfer?: Transferable[]): Promise<PdfResponse> {
    if (dead) return Promise.reject(new Error("this PDF session is closed"));
    const id = nextId++;
    return new Promise<PdfResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id } as PdfRequest, transfer ?? []);
    });
  }

  /** The worker answers in kind; a mismatch is a protocol bug, not a state. */
  function expect<K extends PdfResponse["kind"]>(
    res: PdfResponse,
    kind: K,
  ): Extract<PdfResponse, { kind: K }> {
    if (res.kind !== kind) throw new Error(`pdf worker answered ${res.kind}, expected ${kind}`);
    return res as Extract<PdfResponse, { kind: K }>;
  }

  return {
    async open(url, size) {
      const res = expect(await send({ kind: "open", url, size }), "opened");
      return { pageCount: res.pageCount, mode: res.mode };
    },
    async pageSize(page) {
      const res = expect(await send({ kind: "pageSize", page }), "pageSize");
      return { width: res.width, height: res.height };
    },
    async render(page, scale) {
      const res = expect(await send({ kind: "render", page, scale }), "rendered");
      return { bitmap: res.bitmap, width: res.width, height: res.height };
    },
    async exportPage(page, ink) {
      // REFUSED HERE, before the buffer is handed over. The mask is sized from a
      // canvas on this side and the module reads `width * height` bytes from a
      // pointer on the other: a buffer that disagrees with those numbers is an
      // out-of-bounds read inside wasm, which is a torn-down instance and not a
      // failed export. This is also the only door into the worker, so checking
      // it twice would only make the second copy the untested one.
      if (ink.width <= 0 || ink.height <= 0 || ink.alpha.length !== ink.width * ink.height) {
        throw new Error("the ink overlay's size does not match its alpha buffer");
      }
      const res = expect(
        await send({ kind: "exportPage", page, ink }, [ink.alpha.buffer as ArrayBuffer]),
        "exportedPage",
      );
      return res.bytes;
    },
    async stats() {
      const res = expect(await send({ kind: "stats" }), "stats");
      published = { mode: res.mode, cache: res.stats };
      (globalThis as unknown as { __inkholdPdfStats?: PdfSessionStats }).__inkholdPdfStats =
        published;
      return published;
    },
    async close() {
      if (dead) return;
      await send({ kind: "close" });
    },
    destroy() {
      dead = true;
      for (const [, p] of pending) p.reject(new Error("this PDF session is closed"));
      pending.clear();
      worker.terminate();
    },
  };
}
