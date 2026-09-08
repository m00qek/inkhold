// The message protocol between `searchEngine.ts` (main thread) and
// `engineWorker.ts`.
//
// Its own module so neither side imports the other — the split
// `render/pdfWorkerTypes.ts` makes, for the same reason: the client owns a
// `new Worker(new URL(...))`, and a worker that imported the client would pull
// that construction into its own bundle. Types only; nothing here survives
// compile.
//
// ## Two messages, and what they cost to cross
//
// `golden-search.md` §7 worried about the 10.36 MB serialized index image, and
// the answer is that IT NEVER CROSSES. Nothing in `src/` calls
// `SearchIndex.serialize`/`restore` — the library index is rebuilt from the rows
// in IndexedDB on the first search of a session (§4.2) — so the image is born,
// lives and dies inside the worker's own linear memory. There is no transferable
// here because there is nothing large enough to want one.
//
// What does cross is the BUILD PAYLOAD, and the choice not to transfer it was
// MEASURED rather than reasoned about (Node 24, `structuredClone` of the §8.1
// corpus shapes, p50 of five runs):
//
// | payload | rows | structured clone | pack to one transferable UTF-8 buffer |
// | --- | ---: | ---: | ---: |
// | worst in-doc document (Les Misérables) | 14,055 segments | **9.1 ms** | 12.4 ms |
// | the whole library's terms | 23,997 rows | **13.9 ms** | 17.2 ms |
// | the pathological `con*` answer, coming back | 5,642 hits | **2.3 ms** | — |
//
// So the plain structured clone WINS, and it wins twice: `structuredClone`
// measures serialize *and* deserialize in one thread, where a `postMessage` puts
// only the serialize half on the main thread and the deserialize on the worker's.
// Packing the segments into one flat UTF-8 buffer to transfer it is SLOWER than
// letting V8 clone the strings, and it would move the `TextEncoder` pass onto the
// thread we are trying to keep free.
//
// The half that actually lands on the UI thread was then measured in Chromium
// through the real boundary (`engineWorker.ts`'s table): **6.0 ms** of main-thread
// block to hand over the worst document, **11.5 ms** for the whole library. That
// is what a 108 ms and a 181 ms build now cost the box somebody is typing in.

import type { PageRef, TermsDocument } from "./indexEngine";
import type { Expansion } from "./localSearch";

export type EngineRequest =
  /**
   * Replace the index's contents with these documents — `SearchIndex.rebuild`,
   * which is `reset()` and then `build()` on the SAME instance.
   *
   * There is no separate `reset` message because there is no caller that wants
   * one: §8.1 measured that successive builds through one instance converge on
   * the cost of the worst document, so resetting is something a build does, not
   * a lifecycle a client drives.
   */
  | { kind: "build"; id: number; docs: readonly TermsDocument[] }
  /** `SearchIndex.query`. `fuzzy` attaches the typo ladder, which the module
   *  itself gates on a total of zero. */
  | { kind: "query"; id: number; text: string; limit: number; fuzzy: boolean };

export type EngineResponse =
  | { kind: "built"; id: number }
  | { kind: "result"; id: number; total: number; hits: PageRef[]; expansions: Expansion[] }
  /**
   * The call refused. `name` travels beside `message` because the client rebuilds
   * an `Error` from it and a caller may be reading `err.name` — `SearchIndexError`
   * and `StaleSnapshotError` both mean something by theirs, and neither survives
   * a structured clone as itself.
   */
  | { kind: "error"; id: number; name: string; message: string };
