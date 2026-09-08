// The MAIN-THREAD half of the search worker — one engine, asynchronously.
//
//     indexSearch.ts ──┐                        ┌── SearchIndex (library)
//                      ├─▶ SearchEngine ──post──┤
//     docSearch.ts ────┘                        └── SearchIndex (one document)
//
// `SearchIndex` is synchronous and stays synchronous: it is the wasm ABI's own
// shape and the thing `indexEngine.test.ts` drives directly. THIS is the seam the
// two consumers meet instead — the same surface, `Promise`-shaped, answered
// either by a worker or, where there is no `Worker`, by an instance in this
// thread. The consumers cannot tell, and neither call site changed shape:
// `DocSearch.search` and `LocalSearch.search` were already `Promise`-returning
// and every caller in `pages/` already awaited them.
//
// ## TWO WORKERS, one per consumer, and that is the existing decision unchanged
//
// `docSearch.ts`'s header argues for a SECOND wasm instance rather than sharing
// the library's: sharing would charge every find a 703 ms library rebuild
// afterwards, against 16.13 MB of linear memory for an instance of its own. That
// argument is untouched — each consumer creates its own `SearchEngine`, so each
// gets its own worker holding its own instance, and a library build can never
// queue behind a find or the other way round. The cost is that each worker
// compiles the 828 KB module for itself (a `WebAssembly.Module` cache is
// per-realm), which is one extra compile off a memory-cache hit, on a path that
// is already paying 300–700 ms of build.
//
// ## NOTHING HAPPENS UNTIL THE FIRST REQUEST — §4.2, kept on this side too
//
// `createSearchEngine` constructs no `Worker`, fetches no wasm and allocates no
// linear memory. A household member who never types in a search box must never
// pay the 16.13 MB (§4.2), and today that holds because only `search()` can reach
// the loader; spawning a worker eagerly would have broken the same promise in a
// new way, so the `Worker` is built inside the first `build`/`query` and nowhere
// else.
//
// ## ABORT: superseding on THIS side, because the other side cannot be stopped
//
// A running `idx_fuzzy` is a synchronous wasm call. No token, no generation
// counter and no `postMessage` can interrupt one — the worker will not read its
// next message until the call returns, so a "cancel" frame would arrive AFTER the
// scan it was meant to cancel. A generation check on the worker side therefore
// only helps if the worker is holding a QUEUE, and the fix is to not let it hold
// one:
//
//   * **At most one request is posted at a time.** Everything else waits in
//     `queue` here, where it can still be thrown away.
//   * **A new query SUPERSEDES the query already waiting**, which is rejected
//     with `AbortError`. So somebody typing `reunaio` through a corpus that has
//     no such word pays one 71.3 ms ladder scan in flight, not one per keystroke
//     stacked up behind each other — the queue cannot grow past a single pending
//     query however fast they type.
//   * **An `AbortSignal` firing on a request already posted rejects its caller
//     immediately** and lets the next one be posted. It cannot claw back the
//     scan, and it does not pretend to; what it prevents is a superseded answer
//     reaching a view that has moved on, and it is the same `AbortError` a
//     `fetch` would have raised, so one `catch` reads both.
//
// A build is NEVER supersedable. It is not abortable either, and should not be —
// it is the same work the next keystroke needs (both consumers say so already).
//
// ## Degrade, do not fail
//
// `cache/idb.ts`'s posture, and this app runs on a plain-HTTP LAN origin where
// several APIs are simply absent (§4.2: `getDirectory`, Service Workers,
// `storage.persist()` are all secure-context). `Worker` is NOT one of them —
// dedicated workers have never required a secure context, which is why
// `render/pdfWorker.ts` already works there — but a missing constructor or one
// that throws must still land on the in-thread path rather than breaking search.
// So does an injected `CoreLoader`: a caller supplying its own core wants THAT
// core, and a function cannot cross a `postMessage`.

import {
  SearchIndex,
  type CoreLoader,
  type QueryResult,
  type TermsDocument,
} from "./indexEngine";
import type { EngineRequest, EngineResponse } from "./engineWorkerTypes";

/**
 * One index, asynchronously — the whole of what `indexSearch.ts` and
 * `docSearch.ts` need from the engine.
 *
 * Deliberately narrower than `SearchIndex`: `serialize`/`deserialize` are not
 * here because nothing in `src/` calls them (the index is rebuilt from the rows
 * in IndexedDB on the first search of a session, §4.2), and adding them would
 * put the 10.36 MB image on the wire to serve no caller.
 */
export interface SearchEngine {
  /** Replace the contents with `docs`, on the instance already open. */
  build(docs: readonly TermsDocument[]): Promise<void>;
  /**
   * Run a query. `text` goes to the wasm RAW — folding it here would be the
   * second tokenizer this whole design exists to avoid (`indexEngine.ts`).
   *
   * Rejects with `AbortError` when `signal` fires, or when a later query
   * supersedes this one before it is posted. See the header.
   */
  query(text: string, limit: number, fuzzy: boolean, signal?: AbortSignal): Promise<QueryResult>;
  /** Hand the 16 MB back: terminate the worker, or close the instance (§4.2). */
  close(): void;
}

/** The `Worker` itself, injectable — the seam habit `pdfClient.ts` uses, and for
 *  the same reason: a real worker's death path cannot otherwise be staged. */
export type EngineWorkerFactory = () => Worker;

export interface SearchEngineOptions {
  /**
   * A `CoreLoader` of the caller's own. Supplying one FORCES the in-thread path,
   * because a function cannot be structured-cloned into a worker — which is what
   * keeps every unit test that injects a fake core driving exactly the code it
   * was written against.
   */
  load?: CoreLoader;
  /** Injectable so the client's protocol is testable without a real worker. */
  makeWorker?: EngineWorkerFactory;
}

/**
 * The default factory, or null where there is no `Worker` at all — a browser
 * without one, and the `node` environment the unit suite runs in.
 *
 * The `new URL(..., import.meta.url)` form is Vite's: it emits `engineWorker.ts`
 * as its own chunk and rewrites this to the built asset's URL. It is inside the
 * factory so it is evaluated only when a worker is actually being made.
 */
function defaultWorkerFactory(): EngineWorkerFactory | null {
  if (typeof Worker !== "function") return null;
  return () => new Worker(new URL("./engineWorker.ts", import.meta.url), { type: "module" });
}

/** An aborted query, spelled the way `fetch` spells it so one `catch` reads
 *  both — the shape `docSearch.ts` and `indexSearch.ts` already use. */
function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("search aborted", "AbortError");
  const err = new Error("search aborted");
  err.name = "AbortError";
  return err;
}

/**
 * An engine backed by a worker where one can be had, and by an instance in this
 * thread where one cannot.
 *
 * Constructs NOTHING. See the header: §4.2's promise is that a person who never
 * searches never pays for the engine, and the first `build` or `query` is the
 * only thing that may reach it.
 */
export function createSearchEngine(opts: SearchEngineOptions = {}): SearchEngine {
  // An injected loader decides the path on its own — see `SearchEngineOptions`.
  const factory = opts.load ? null : (opts.makeWorker ?? defaultWorkerFactory());
  let delegate: SearchEngine | null = null;

  function target(): SearchEngine {
    if (delegate) return delegate;
    if (factory) {
      try {
        delegate = workerEngine(factory);
        return delegate;
      } catch {
        // A constructor that throws — a blocked worker script, an origin that
        // refuses one — is not a reason for search to stop working. The
        // in-thread path is exactly what shipped before this file existed.
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
  /** Posted and not yet answered — at most one entry. See the header. */
  const pending = new Map<number, { resolve: (r: EngineResponse) => void; reject: (e: unknown) => void }>();
  const queue: Job[] = [];
  let running = false;
  let nextId = 1;
  let dead: Error | null = null;

  worker.addEventListener("message", (ev: MessageEvent<EngineResponse>) => {
    const res = ev.data;
    const p = pending.get(res.id);
    // No entry means the caller aborted and moved on; the answer is the one it
    // no longer wants, so dropping it is the point rather than a leak.
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

  // A worker that dies — a module that will not compile, an instance the engine
  // killed — must fail every waiter AND every later request, or the box sits on
  // "searching…" for ever. Everything recoverable comes back as an `error`
  // RESPONSE instead (`engineWorker.ts`), so what reaches here is terminal.
  //
  // The engine is then dropped by its consumer and rebuilt on the next search
  // (both of them only keep an engine a build SUCCEEDED on), which makes a fresh
  // worker — so this is a failed search, not a broken session.
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
      // The scan itself cannot be stopped (see the header). What this does is
      // free the CALLER at once and let the next request be posted, instead of
      // making a live keystroke wait out an answer nobody will read.
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
        // At most one can be waiting, but the loop is written over the queue
        // rather than over an assumption about it.
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
      // shrinks, so dropping the index means dropping the instance (§4.2), and
      // the instance goes when its realm does.
      worker.terminate();
    },
  };
}

/**
 * The fallback, and the path the unit suite drives: `SearchIndex` in this thread,
 * wearing the async surface. Every call is synchronous under the promise, so
 * nothing about ordering or abort is different — the only thing it cannot do is
 * leave the UI thread alone.
 */
function inThreadEngine(load?: CoreLoader): SearchEngine {
  let index: SearchIndex | null = null;
  return {
    async build(docs) {
      // §4.2's promise on this path too: the loader is reached from here and
      // from nowhere else.
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
