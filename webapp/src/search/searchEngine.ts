// The main-thread half of the search worker: `SearchIndex` behind promises,
// answered by `engineWorker.ts`, or in-thread where no `Worker` exists or a
// `CoreLoader` is injected (functions cannot cross `postMessage`). Nothing is
// constructed until the first `build`/`query`.
//
// Abort lives on this side: a running `idx_fuzzy` is synchronous, so the
// worker cannot see a cancel until it returns. At most one request is posted;
// a new query supersedes one still queued here, and an abort frees its caller
// without stopping the scan. Builds are never superseded.

import {
  SearchIndex,
  type CoreLoader,
  type QueryResult,
  type TermsDocument,
} from "./indexEngine";
import type { EngineRequest, EngineResponse } from "./engineWorker";
import type { ItemKind, ItemRow } from "./itemRows";

/** Narrower than `SearchIndex`: no `serialize`, so no 10 MB image crosses the wire. */
export interface SearchEngine {
  build(docs: readonly TermsDocument[]): Promise<void>;
  /** Replaces one kind's item rows (`itemRows.ts`); kept across builds. Never superseded. */
  setItems(kind: ItemKind, rows: readonly ItemRow[]): Promise<void>;
  /** Rejects with `AbortError` on `signal`, or when superseded before posting. */
  query(text: string, limit: number, fuzzy: boolean, signal?: AbortSignal): Promise<QueryResult>;
  /** Terminate the worker or close the instance, freeing its memory. */
  close(): void;
}

export type EngineWorkerFactory = () => Worker;

export interface SearchEngineOptions {
  /** Forces the in-thread path. */
  load?: CoreLoader;
  makeWorker?: EngineWorkerFactory;
}

/**
 * Null where there is no `Worker`. The `new URL(..., import.meta.url)` is what
 * makes Vite emit the worker chunk; it sits inside so it runs only on demand.
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
        // A blocked worker script: fall through to the in-thread path.
      }
    }
    delegate = inThreadEngine(opts.load);
    return delegate;
  }

  return {
    build: (docs) => target().build(docs),
    setItems: (kind, rows) => target().setItems(kind, rows),
    query: (text, limit, fuzzy, signal) => target().query(text, limit, fuzzy, signal),
    close() {
      delegate?.close();
      delegate = null;
    },
  };
}

interface Job {
  readonly req: EngineRequest;
  /** Queries are superseded by later queries; builds never are. */
  readonly supersedable: boolean;
  readonly signal?: AbortSignal;
  readonly resolve: (res: EngineResponse) => void;
  readonly reject: (err: unknown) => void;
}

function workerEngine(makeWorker: EngineWorkerFactory): SearchEngine {
  const worker = makeWorker();
  /** At most one entry. */
  const pending = new Map<number, { resolve: (r: EngineResponse) => void; reject: (e: unknown) => void }>();
  const queue: Job[] = [];
  let running = false;
  let nextId = 1;
  let dead: Error | null = null;

  worker.addEventListener("message", (ev: MessageEvent<EngineResponse>) => {
    const res = ev.data;
    const p = pending.get(res.id);
    // No entry: the caller aborted; drop the answer.
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

  // The `error` event is terminal (recoverable failures arrive as responses),
  // so fail every waiter and every later request.
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
      // Frees the caller; the scan itself cannot be stopped.
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
    async setItems(of, rows) {
      expect(await enqueue({ kind: "items", id: nextId++, of, rows }, false), "built");
    },
    async query(text, limit, fuzzy, signal) {
      const req: EngineRequest = { kind: "query", id: nextId++, text, limit, fuzzy };
      const res = expect(await enqueue(req, true, signal), "result");
      return { total: res.total, hits: res.hits, items: res.items, itemTotals: res.itemTotals, expansions: res.expansions };
    },
    close() {
      dead ??= new Error("this search engine is closed");
      for (const [, p] of pending) p.reject(dead);
      pending.clear();
      for (const job of queue.splice(0)) job.reject(dead);
      // Terminating the realm is the only way to free wasm linear memory.
      worker.terminate();
    },
  };
}

/** In-thread fallback, also what unit tests drive. Same ordering and abort semantics. */
function inThreadEngine(load?: CoreLoader): SearchEngine {
  let index: SearchIndex | null = null;
  /** One instance, however many calls wait on its opening; they then run in the order called. */
  let opening: Promise<SearchIndex> | null = null;
  const instance = (): Promise<SearchIndex> => {
    opening ??= SearchIndex.open(load).then((i) => (index = i));
    return opening;
  };
  return {
    async build(docs) {
      (await instance()).rebuild(docs);
    },
    async setItems(kind, rows) {
      (await instance()).setItems(kind, rows);
    },
    async query(text, limit, fuzzy, signal) {
      if (signal?.aborted) throw abortError();
      if (!index) throw new Error("this search engine has nothing built to query");
      return index.query(text, limit, fuzzy);
    },
    close() {
      index?.close();
      index = null;
      opening = null;
    },
  };
}
