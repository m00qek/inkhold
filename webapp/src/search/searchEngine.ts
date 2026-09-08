// The MAIN-THREAD half of the search worker — `SearchIndex`'s surface,
// `Promise`-shaped, answered by `engineWorker.ts` where a `Worker` exists and
// by an instance in this thread where one does not (`golden-search.md` §7;
// `docSearch.ts` says why each consumer gets its own engine and worker).
//
// What this must not break:
//   * `createSearchEngine` constructs NOTHING — no `Worker`, no fetch, no linear
//     memory — until the first `build`/`query` (§4.2).
//   * ABORT LIVES ON THIS SIDE. A running `idx_fuzzy` is a synchronous wasm
//     call: the worker cannot read a cancel until the scan returns, so a cancel
//     frame would arrive AFTER the scan it meant to stop. Hence at most one
//     request is posted at a time, a new query supersedes the one waiting here
//     (`AbortError`), and a signal on a posted request frees its caller without
//     clawing back the scan — typing `reunaio` through a corpus without it pays
//     one 71.3 ms ladder scan in flight, never a stack of them.
//   * A build is never superseded or aborted: it is the work the next keystroke needs.
//   * An injected `CoreLoader` forces the in-thread path (a function cannot cross
//     `postMessage`); a missing or throwing `Worker` constructor lands there too.

import {
  SearchIndex,
  type CoreLoader,
  type QueryResult,
  type TermsDocument,
} from "./indexEngine";
import type { EngineRequest, EngineResponse } from "./engineWorker";

/**
 * One index, asynchronously. Narrower than `SearchIndex` on purpose:
 * `serialize`/`deserialize` have no caller in `src/`, and exposing them would
 * put the 10.36 MB image on the wire for nobody.
 */
export interface SearchEngine {
  /** Replace the contents with `docs`, on the instance already open. */
  build(docs: readonly TermsDocument[]): Promise<void>;
  /**
   * Run a query. `text` goes to the wasm RAW (`indexEngine.ts`). Rejects with
   * `AbortError` when `signal` fires, or when a later query supersedes this one
   * before it is posted.
   */
  query(text: string, limit: number, fuzzy: boolean, signal?: AbortSignal): Promise<QueryResult>;
  /** Hand the 16 MB back: terminate the worker, or close the instance (§4.2). */
  close(): void;
}

/** Injectable so a real worker's death path can be staged (the `pdfClient.ts` seam). */
export type EngineWorkerFactory = () => Worker;

export interface SearchEngineOptions {
  /** A `CoreLoader` of the caller's own. FORCES the in-thread path — see the header. */
  load?: CoreLoader;
  /** Injectable so the client's protocol is testable without a real worker. */
  makeWorker?: EngineWorkerFactory;
}

/**
 * The default factory, or null where there is no `Worker` (the `node` unit
 * suite). `new URL(..., import.meta.url)` is what makes Vite emit
 * `engineWorker.ts` as its own chunk; it is inside the factory so it is
 * evaluated only when a worker is actually made.
 */
function defaultWorkerFactory(): EngineWorkerFactory | null {
  if (typeof Worker !== "function") return null;
  return () => new Worker(new URL("./engineWorker.ts", import.meta.url), { type: "module" });
}

/** Spelled the way `fetch` spells an abort so one `catch` reads both. */
function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("search aborted", "AbortError");
  const err = new Error("search aborted");
  err.name = "AbortError";
  return err;
}

export function createSearchEngine(opts: SearchEngineOptions = {}): SearchEngine {
  const factory = opts.load ? null : (opts.makeWorker ?? defaultWorkerFactory());
  let delegate: SearchEngine | null = null;

  function target(): SearchEngine {
    if (delegate) return delegate;
    if (factory) {
      try {
        delegate = workerEngine(factory);
        return delegate;
      } catch {
        // A blocked worker script or an origin that refuses one: fall through
        // to the in-thread path, which is exactly what shipped before.
      }
    }
    delegate = inThreadEngine(opts.load);
    return delegate;
  }

  return {
    build: (docs) => target().build(docs),
    query: (text, limit, fuzzy, signal) => target().query(text, limit, fuzzy, signal),
    close() {
      delegate?.close();
      delegate = null;
    },
  };
}

// -----------------------------------------------------------------------------

/** One request waiting its turn on this side, where it can still be discarded. */
interface Job {
  readonly req: EngineRequest;
  /** A query, which a later query replaces. Builds are never dropped. */
  readonly supersedable: boolean;
  readonly signal?: AbortSignal;
  readonly resolve: (res: EngineResponse) => void;
  readonly reject: (err: unknown) => void;
}

function workerEngine(makeWorker: EngineWorkerFactory): SearchEngine {
  const worker = makeWorker();
  /** Posted and not yet answered — at most one entry. */
  const pending = new Map<number, { resolve: (r: EngineResponse) => void; reject: (e: unknown) => void }>();
  const queue: Job[] = [];
  let running = false;
  let nextId = 1;
  let dead: Error | null = null;

  worker.addEventListener("message", (ev: MessageEvent<EngineResponse>) => {
    const res = ev.data;
    const p = pending.get(res.id);
    // No entry: the caller aborted and moved on. Dropping the answer is the point.
    if (!p) return;
    pending.delete(res.id);
    if (res.kind === "error") {
      const err = new Error(res.message);
      err.name = res.name;
      p.reject(err);
      return;
    }
    p.resolve(res);
  });

  // The `error` EVENT is terminal (everything recoverable comes back as an
  // `error` RESPONSE), so it must fail every waiter AND every later request or
  // the box sits on "searching…" for ever. Both consumers drop an engine whose
  // build failed and rebuild on the next search, so this is a failed search,
  // not a broken session.
  worker.addEventListener("error", (ev: ErrorEvent) => {
    dead = new Error(ev.message || "the search worker stopped");
    for (const [, p] of pending) p.reject(dead);
    pending.clear();
    for (const job of queue.splice(0)) job.reject(dead);
  });

  function post(job: Job): Promise<EngineResponse> {
    return new Promise<EngineResponse>((resolve, reject) => {
      if (job.signal?.aborted) {
        reject(abortError());
        return;
      }
      pending.set(job.req.id, { resolve, reject });
      worker.postMessage(job.req);
      // Frees the CALLER and lets the next request be posted; the scan itself
      // cannot be stopped (see the header).
      job.signal?.addEventListener(
        "abort",
        () => {
          if (pending.delete(job.req.id)) reject(abortError());
        },
        { once: true },
      );
    });
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        if (dead) {
          job.reject(dead);
          continue;
        }
        try {
          job.resolve(await post(job));
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      running = false;
    }
  }

  function enqueue(req: EngineRequest, supersedable: boolean, signal?: AbortSignal): Promise<EngineResponse> {
    return new Promise<EngineResponse>((resolve, reject) => {
      if (dead) {
        reject(dead);
        return;
      }
      if (supersedable) {
        for (let i = queue.length - 1; i >= 0; i--) {
          if (!queue[i]!.supersedable) continue;
          queue.splice(i, 1)[0]!.reject(abortError());
        }
      }
      queue.push({ req, supersedable, signal, resolve, reject });
      void pump();
    });
  }

  /** The worker answers in kind; a mismatch is a protocol bug, not a state. */
  function expect<K extends EngineResponse["kind"]>(
    res: EngineResponse,
    kind: K,
  ): Extract<EngineResponse, { kind: K }> {
    if (res.kind !== kind) throw new Error(`search worker answered ${res.kind}, expected ${kind}`);
    return res as Extract<EngineResponse, { kind: K }>;
  }

  return {
    async build(docs) {
      expect(await enqueue({ kind: "build", id: nextId++, docs }, false), "built");
    },
    async query(text, limit, fuzzy, signal) {
      const req: EngineRequest = { kind: "query", id: nextId++, text, limit, fuzzy };
      const res = expect(await enqueue(req, true, signal), "result");
      return { total: res.total, hits: res.hits, expansions: res.expansions };
    },
    close() {
      dead ??= new Error("this search engine is closed");
      for (const [, p] of pending) p.reject(dead);
      pending.clear();
      for (const job of queue.splice(0)) job.reject(dead);
      // Terminating is what hands the 16.13 MB back: wasm linear memory never
      // shrinks, and the instance goes when its realm does (§4.2).
      worker.terminate();
    },
  };
}

/**
 * The fallback, and the path the unit suite drives: `SearchIndex` in this
 * thread behind the async surface. Same ordering and abort semantics; it just
 * cannot leave the UI thread alone.
 */
function inThreadEngine(load?: CoreLoader): SearchEngine {
  let index: SearchIndex | null = null;
  return {
    async build(docs) {
      const engine = index ?? (await SearchIndex.open(load));
      index = engine;
      engine.rebuild(docs);
    },
    async query(text, limit, fuzzy, signal) {
      if (signal?.aborted) throw abortError();
      if (!index) throw new Error("this search engine has nothing built to query");
      return index.query(text, limit, fuzzy);
    },
    close() {
      index?.close();
      index = null;
    },
  };
}
