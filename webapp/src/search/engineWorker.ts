// The SEARCH WORKER — `sqlite-core.wasm` and the FTS5 index, off the main
// thread. `golden-search.md` §7's last UX debt, and the only one a household
// would actually feel.
//
// Three measured costs move here, and none of them gets smaller; they simply
// stop being the UI thread's (§8.1, §8.6):
//
//   * **315 ms** to build the worst real document's in-doc index, on FIRST FIND.
//   * **703 ms** to build the whole library's index, once per session on the
//     first search.
//   * **71.3 ms** for a query that matches NOTHING, because the typo ladder then
//     scans the whole vocabulary — and that one is per KEYSTROKE while somebody
//     types a word the corpus does not contain. (A query that matches costs
//     1.42 ms, so the ladder is free when it does not fire.)
//
// ## What it bought, MEASURED through the real boundary
//
// Chromium 2026-09-08, the shipped `sqlite-core.wasm` behind the Vite dev server,
// the same `createSearchEngine` twice — once with a worker, once with an injected
// loader, which is the in-thread path and is exactly what shipped before. The
// corpus is synthetic at §8.1's SHAPES (a 14,055-segment document, a 23,997-row
// library over a 60,000-word vocabulary) and is lighter than the real one, so
// read the ratio and not the absolute. "Blocked" is the longest the main thread
// went without being able to run a 1 ms timer; ~4 ms is this harness's floor.
//
// | | in thread (BEFORE) | worker (AFTER) |
// | --- | ---: | ---: |
// | first find, worst document | **107.9 ms** | **7.0 ms** |
// | rebuild the same document, warm | 83.6 ms | **6.0 ms** |
// | build the whole library | **180.9 ms** | **11.5 ms** |
// | a query that MATCHES | 4.1 ms (floor) | 4.1 ms |
// | a query that matches NOTHING (the ladder) | **35.8 ms** | **4.1 ms** (floor) |
// | first engine, one-off | 22.7 ms (`instantiate`) | 50.2 ms (spawn, dev) |
//
// **The work did not get cheaper — the wall clock grew** (the library goes 179 ms
// → 230 ms end to end, for the clone, the thread hop and this realm's own compile
// of the module). What moved is the whole of it off the thread that paints. The
// one row that went the wrong way is the first worker's spawn, once per consumer
// per session, measured against a Vite dev module graph rather than the single
// 6 kB chunk the production build emits.
//
// ## ONE INSTANCE, REUSED — never one per document
//
// §8.1 refuted the teardown rule: `idx_open()` returns the closed database's
// pages to SQLite's heap INSIDE linear memory, so four documents through one
// instance converged on the cost of the single worst one whichever order they
// arrived in (33.63–33.69 MB either way). So a `build` is `SearchIndex.rebuild`
// on the instance already here, and a worker per document would pay the 16.13 MB
// static footprint again for nothing.
//
// ## …and the instance is not created until the first message
//
// §4.2's promise is that a household member who never searches never pays the
// 16.13 MB. Moving the engine here could have broken it in a NEW way — a worker
// spawned at boot would instantiate at boot — so the guarantee is kept on BOTH
// sides: `searchEngine.ts` does not construct the `Worker` until the first
// request reaches it, and this module does not call `SearchIndex.open` until the
// first `build` message arrives. Neither half is enough on its own.
//
// ## Requests are SERIALISED here as well as there
//
// `searchEngine.ts` posts one message at a time, but this side must not depend on
// that: `SearchIndex.open` is async, so two `build` messages arriving during one
// instantiation would otherwise both proceed and the second would index into a
// half-built table. One promise chain, and every reply is posted from it.

import { SearchIndex } from "./indexEngine";
import type { EngineRequest, EngineResponse } from "./engineWorkerTypes";

/**
 * The worker's global, typed by hand.
 *
 * `tsconfig.json` gives this app the `DOM` lib, under which `self` is a
 * `Window`. Adding `WebWorker` would make the two libs collide across every file
 * in `src/`, so the two modules that are not documents (`render/pdfWorker.ts` and
 * this one) each declare the sliver they use. One interface is cheaper than a
 * second tsconfig.
 */
interface WorkerScope {
  postMessage(message: EngineResponse): void;
  addEventListener(type: "message", cb: (ev: MessageEvent<EngineRequest>) => void): void;
}
const ctx = globalThis as unknown as WorkerScope;

/** The one instance this worker owns. See the header: reused, never re-opened. */
let index: SearchIndex | null = null;

async function handle(req: EngineRequest): Promise<EngineResponse> {
  switch (req.kind) {
    case "build": {
      // THE FIRST THING THAT REACHES THE LOADER, and it is behind a request —
      // §4.2's half of the promise that lives on this side.
      const engine = index ?? (await SearchIndex.open());
      index = engine;
      engine.rebuild(req.docs);
      return { kind: "built", id: req.id };
    }
    case "query": {
      // A query before a build is a client bug, not a state: both consumers
      // await their build before they query. Saying so is better than answering
      // zero results out of an index that was never filled.
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

/** One chain, so an async `handle` can never interleave with the next message. */
let chain: Promise<void> = Promise.resolve();

ctx.addEventListener("message", (ev: MessageEvent<EngineRequest>) => {
  const req = ev.data;
  chain = chain.then(async () => {
    try {
      ctx.postMessage(await handle(req));
    } catch (err) {
      // Every recoverable failure becomes an `error` RESPONSE, so the `error`
      // EVENT the client listens for keeps meaning what it means there: a module
      // that would not compile, or an instance the engine killed.
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
