// The SEARCH WORKER: one `SearchIndex` on `sqlite-core.wasm`, off the main
// thread. Design and measurements: `golden-search.md` §7, §8.1, §8.6.
//
// What this must not break:
//   * ONE instance, reused. `idx_open()` returns the closed database's pages to
//     SQLite's heap INSIDE linear memory, so successive documents through one
//     instance converge on the worst one (33.63–33.69 MB either way, §8.1) — a
//     worker per document would pay the 16.13 MB static footprint again.
//   * Nothing is instantiated until the first `build` message (§4.2). The other
//     half of that promise — no `Worker` until the first request — is
//     `searchEngine.ts`'s; neither half is enough on its own.
//   * A running `idx_fuzzy` is a SYNCHRONOUS wasm call: this side cannot read a
//     cancel until the scan returns, so there is no queue here and no cancel
//     message — abort is entirely `searchEngine.ts`'s.
//
// Measured through the real boundary (Chromium, synthetic corpus at §8.1's
// shapes; ~4 ms is the harness floor): main-thread block for the worst
// document's first find 107.9 ms → 7.0 ms, whole library 180.9 ms → 11.5 ms,
// no-match ladder query 35.8 ms → 4.1 ms. Wall clock GREW (library 179 → 230 ms
// end to end); what moved is the whole of it off the thread that paints.

import { SearchIndex, type PageRef, type TermsDocument } from "./indexEngine";
import type { Expansion } from "./localSearch";

// The protocol. Types only; nothing here survives compile, which is what lets
// `searchEngine.ts` import them without pulling the worker into its bundle.
//
// The 10.36 MB serialized image NEVER crosses: nothing in `src/` calls
// `serialize`/`restore` (the library is rebuilt from IndexedDB rows on first
// search, §4.2). The build payload does cross, and a structured clone BEAT
// packing it into one transferable UTF-8 buffer (Node 24, p50 of five): worst
// document 9.1 vs 12.4 ms, whole library 13.9 vs 17.2 ms — and the transfer
// would put the `TextEncoder` pass on the thread being kept free.

export type EngineRequest =
  /** `SearchIndex.rebuild`: `reset()` then `build()` on the SAME instance. */
  | { kind: "build"; id: number; docs: readonly TermsDocument[] }
  /** `SearchIndex.query`. `fuzzy` attaches the typo ladder, gated by the wasm on a total of zero. */
  | { kind: "query"; id: number; text: string; limit: number; fuzzy: boolean };

export type EngineResponse =
  | { kind: "built"; id: number }
  | { kind: "result"; id: number; total: number; hits: PageRef[]; expansions: Expansion[] }
  /** `name` travels beside `message` because callers read `err.name`
   *  (`SearchIndexError`, `StaleSnapshotError`) and neither survives a
   *  structured clone as itself. */
  | { kind: "error"; id: number; name: string; message: string };

/**
 * The worker's global, typed by hand: `tsconfig.json` uses the `DOM` lib, and
 * adding `WebWorker` collides with it across every file in `src/`
 * (`render/pdfWorker.ts` does the same).
 */
interface WorkerScope {
  postMessage(message: EngineResponse): void;
  addEventListener(type: "message", cb: (ev: MessageEvent<EngineRequest>) => void): void;
}
const ctx = globalThis as unknown as WorkerScope;

let index: SearchIndex | null = null;

async function handle(req: EngineRequest): Promise<EngineResponse> {
  switch (req.kind) {
    case "build": {
      const engine = index ?? (await SearchIndex.open());
      index = engine;
      engine.rebuild(req.docs);
      return { kind: "built", id: req.id };
    }
    case "query": {
      // A query before a build is a client bug; answering zero results out of an
      // index that was never filled would hide it.
      if (!index) throw new Error("this search engine has nothing built to query");
      const answer = index.query(req.text, req.limit, req.fuzzy);
      return {
        kind: "result",
        id: req.id,
        total: answer.total,
        hits: answer.hits,
        expansions: answer.expansions,
      };
    }
  }
}

/** One chain: `SearchIndex.open` is async, so two `build`s arriving during one
 *  instantiation would otherwise both proceed and the second would index into a
 *  half-built table. */
let chain: Promise<void> = Promise.resolve();

ctx.addEventListener("message", (ev: MessageEvent<EngineRequest>) => {
  const req = ev.data;
  chain = chain.then(async () => {
    try {
      ctx.postMessage(await handle(req));
    } catch (err) {
      // Every recoverable failure is an `error` RESPONSE, so the `error` EVENT
      // the client listens for keeps meaning "terminal": a module that would
      // not compile, or an instance the engine killed.
      const e = err as { name?: unknown; message?: unknown };
      ctx.postMessage({
        kind: "error",
        id: req.id,
        name: typeof e?.name === "string" ? e.name : "Error",
        message: typeof e?.message === "string" ? e.message : String(err),
      });
    }
  });
});
