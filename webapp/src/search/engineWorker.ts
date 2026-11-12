// The search worker: one reused `SearchIndex` off the main thread,
// instantiated on the first `build` or `items`. There is no queue or cancel message here;
// a running `idx_fuzzy` is synchronous, so abort is `searchEngine.ts`'s.

import { SearchIndex, type ItemRef, type PageRef, type TermsDocument } from "./indexEngine";
import type { ItemKind, ItemRow } from "./itemRows";
import type { Expansion } from "./localSearch";

// The protocol. Types only, so `searchEngine.ts` imports them without bundling
// the worker. The build payload crosses as a structured clone, which measured
// faster than packing a transferable UTF-8 buffer.

export type EngineRequest =
  | { kind: "build"; id: number; docs: readonly TermsDocument[] }
  /** Replaces one kind's item rows; before a build, they wait for it. */
  | { kind: "items"; id: number; of: ItemKind; rows: readonly ItemRow[] }
  /** `fuzzy` adds the typo ladder, which the wasm runs only on zero hits. */
  | { kind: "query"; id: number; text: string; limit: number; fuzzy: boolean };

export type EngineResponse =
  | { kind: "built"; id: number }
  | {
      kind: "result";
      id: number;
      total: number;
      hits: PageRef[];
      items: ItemRef[];
      expansions: Expansion[];
    }
  /** `name` travels separately: callers read `err.name`, which a structured clone drops. */
  | { kind: "error"; id: number; name: string; message: string };

/** Typed by hand: adding the `WebWorker` lib collides with `DOM` across `src/`. */
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
    case "items": {
      const engine = index ?? (await SearchIndex.open());
      index = engine;
      engine.setItems(req.of, req.rows);
      return { kind: "built", id: req.id };
    }
    case "query": {
      // A query before a build is a client bug; zero results would hide it.
      if (!index) throw new Error("this search engine has nothing built to query");
      const answer = index.query(req.text, req.limit, req.fuzzy);
      return {
        kind: "result",
        id: req.id,
        total: answer.total,
        hits: answer.hits,
        items: answer.items,
        expansions: answer.expansions,
      };
    }
  }
}

/** Serializes messages: `SearchIndex.open` is async, so two builds could interleave. */
let chain: Promise<void> = Promise.resolve();

ctx.addEventListener("message", (ev: MessageEvent<EngineRequest>) => {
  const req = ev.data;
  chain = chain.then(async () => {
    try {
      ctx.postMessage(await handle(req));
    } catch (err) {
      // Recoverable failures are responses, so the `error` event stays terminal.
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
