// The main-thread half of the PDF worker: one session per open document,
// turning id-tagged `postMessage`s into promises.

import type { PdfPageSize } from "./pdfDocument";
import type { PdfCacheStats } from "./pdfBlocks";
import type { PdfLink } from "../core/types";
import type { PdfWord } from "./pdfWire";
import type { PdfOutlineEntry } from "./pdfWire";
import type { PdfInkOverlay, PdfOpenMode, PdfRequest, PdfResponse } from "./pdfWorkerTypes";
import { exposeForTests } from "../ui/testSeams";

/** Re-exported so pages never import the worker protocol directly. */
export type { PdfInkOverlay } from "./pdfWorkerTypes";

/** A rendered page, ready for `drawImage`. Close it once drawn. */
export interface PdfFrame {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface PdfSessionStats {
  mode: PdfOpenMode | null;
  cache: PdfCacheStats | null;
}

/** An HTTP failure fetching the file; the status lets 401/403 re-auth. */
export class PdfLoadError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "pdf load failed" : `pdf load failed: HTTP ${status}`);
    this.name = "PdfLoadError";
  }
}

export interface PdfSession {
  open(url: string, size: number): Promise<{ pageCount: number; mode: PdfOpenMode }>;
  pageSize(page: number): Promise<PdfPageSize>;
  /** The page's own authored links, in display-space points; `[]` if none. */
  pageLinks(page: number): Promise<PdfLink[]>;
  /**
   * The page's words and boxes, in display-space points; `[]` when none (the
   * match count on screen is the server's either way).
   */
  pageWords(page: number): Promise<PdfWord[]>;
  /** The flat outline with 0-based target pages; `[]` is the common success. */
  outline(): Promise<PdfOutlineEntry[]>;
  render(page: number, scale: number): Promise<PdfFrame>;
  /**
   * One page as its own PDF with `ink` drawn over its content streams.
   * `ink.alpha`'s buffer is transferred and detached here.
   */
  exportPage(page: number, ink: PdfInkOverlay): Promise<Uint8Array>;
  /**
   * Draw `ink` into the open document's page, once per annotated page before
   * one {@link exportDocument}. Not a loop over `exportPage`, which would drop
   * `/Annots`. `ink.alpha` is transferred.
   */
  annotatePage(page: number, ink: PdfInkOverlay): Promise<void>;
  /**
   * Write an incremental update and answer with the delta: concatenate as
   * `new Blob([original, delta])`, never parse. `original` is lent so MuPDF's
   * read-back comes off disk, not the network. The document is reopened after,
   * even on rejection.
   */
  exportDocument(original: Blob): Promise<Uint8Array>;
  stats(): Promise<PdfSessionStats>;
  /** Drop the document; the worker (and its compiled module) stays warm. */
  close(): Promise<void>;
  destroy(): void;
}

/**
 * The latest `stats()` answer, also published as `__inkholdPdfStats`: a
 * diagnostic for what a page cost in requests and bytes on a real device.
 */
let published: PdfSessionStats | null = null;
export function lastPdfStats(): PdfSessionStats | null {
  return published;
}

type Pending = { resolve: (r: PdfResponse) => void; reject: (e: unknown) => void };

/** A request minus the id; distributive so the union isn't collapsed by `Omit`. */
type Unsent<T> = T extends PdfRequest ? Omit<T, "id"> : never;

/** The `Worker`, injectable so the death path is testable. */
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
      p.reject(res.status === null ? new Error(res.message) : new PdfLoadError(res.status));
      return;
    }
    p.resolve(res);
  });
  // A worker `error` is terminal (the worker answers everything else with an
  // error response): fail every waiter and mark the session dead, so later
  // sends reject instead of hanging on "Opening…".
  worker.addEventListener("error", (ev: ErrorEvent) => {
    dead = true;
    const err = new Error(ev.message || "the PDF worker stopped");
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  /** `transfer` hands buffers over rather than cloning (only the ink overlay). */
  function send(req: Unsent<PdfRequest>, transfer?: Transferable[]): Promise<PdfResponse> {
    if (dead) return Promise.reject(new Error("this PDF session is closed"));
    const id = nextId++;
    return new Promise<PdfResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id } as PdfRequest, transfer ?? []);
    });
  }

  /**
   * Refused here: the module reads `width * height` bytes from the pointer, so
   * a mismatched buffer is an out-of-bounds read inside wasm.
   */
  function checkInk(ink: PdfInkOverlay): void {
    if (ink.width <= 0 || ink.height <= 0 || ink.alpha.length !== ink.width * ink.height) {
      throw new Error("the ink overlay's size does not match its alpha buffer");
    }
  }

  /** A kind mismatch is a protocol bug. */
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
    async pageLinks(page) {
      const res = expect(await send({ kind: "pageLinks", page }), "pageLinks");
      return res.links;
    },
    async pageWords(page) {
      const res = expect(await send({ kind: "pageWords", page }), "pageWords");
      return res.words;
    },
    async outline() {
      const res = expect(await send({ kind: "outline" }), "outline");
      return res.entries;
    },
    async render(page, scale) {
      const res = expect(await send({ kind: "render", page, scale }), "rendered");
      return { bitmap: res.bitmap, width: res.width, height: res.height };
    },
    async exportPage(page, ink) {
      checkInk(ink);
      const res = expect(
        await send({ kind: "exportPage", page, ink }, [ink.alpha.buffer as ArrayBuffer]),
        "exportedPage",
      );
      return res.bytes;
    },
    async annotatePage(page, ink) {
      checkInk(ink);
      expect(
        await send({ kind: "annotatePage", page, ink }, [ink.alpha.buffer as ArrayBuffer]),
        "annotatedPage",
      );
    },
    async exportDocument(original) {
      // Not transferred: that would detach it here, where it is concatenated after.
      const res = expect(await send({ kind: "exportDocument", original }), "exportedDocument");
      return res.delta;
    },
    async stats() {
      const res = expect(await send({ kind: "stats" }), "stats");
      published = { mode: res.mode, cache: res.stats };
      exposeForTests("__inkholdPdfStats", published);
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
