import { describe, it, expect } from "vitest";
import { createSearchEngine } from "../../src/search/searchEngine";
import type { EngineRequest, EngineResponse } from "../../src/search/engineWorkerTypes";
import type { CoreLoader, TermsDocument } from "../../src/search/indexEngine";

// The MAIN-THREAD half of the search worker, driven by a FAKE worker.
//
// What is being pinned is the thing the wasm cannot do for itself: a running
// `idx_fuzzy` is a synchronous call, so nothing can interrupt one and a "cancel"
// frame would arrive after the scan it was meant to cancel. The whole of abort
// therefore lives on THIS side — one request posted at a time, and the query
// waiting behind it replaced rather than queued — and none of it is reachable
// from a real worker, whose 71.3 ms no-match scan (§8.6) is exactly what a test
// cannot stage.
//
// The death path is the same argument `pdfClient.test.ts` makes: a real worker
// fires `error` only for a module that will not compile or an instance the engine
// killed, and neither can be produced on demand.

class FakeWorker extends EventTarget {
  readonly sent: EngineRequest[] = [];
  terminated = false;
  postMessage(msg: EngineRequest): void {
    this.sent.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(res: EngineResponse): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: res }));
  }
  /** Answer the last request in kind, so a test need not track ids. */
  answer(): void {
    const last = this.sent[this.sent.length - 1]!;
    if (last.kind === "build") this.reply({ kind: "built", id: last.id });
    else this.reply({ kind: "result", id: last.id, total: 0, hits: [], expansions: [] });
  }
  die(message = "boom"): void {
    this.dispatchEvent(Object.assign(new Event("error"), { message }));
  }
}

const DOC: TermsDocument = { md5: "a".repeat(32), pages: [{ p: 0, t: "reuniao caligrafia" }] };

function engine() {
  const worker = new FakeWorker();
  return { worker, e: createSearchEngine({ makeWorker: () => worker as unknown as Worker }) };
}

/** Let the client's own promise chain run to where it is going to wait. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("a search engine over a worker", () => {
  it("constructs nothing until the first request — §4.2", async () => {
    // The promise this move could have broken in a new way: a worker spawned at
    // boot would instantiate the 16.13 MB engine at boot, for somebody who may
    // never type in the box.
    let made = 0;
    const e = createSearchEngine({
      makeWorker: () => {
        made += 1;
        return new FakeWorker() as unknown as Worker;
      },
    });
    expect(made).toBe(0);
    void e.build([DOC]);
    await settle();
    expect(made).toBe(1);
  });

  it("posts one request at a time", async () => {
    const { worker, e } = engine();
    void e.build([DOC]);
    await settle();
    void e.query("reuniao", 10, true);
    await settle();
    // The query is waiting HERE, where it can still be discarded — not in the
    // worker's message queue, where it could not.
    expect(worker.sent.map((m) => m.kind)).toEqual(["build"]);
    worker.answer();
    await settle();
    expect(worker.sent.map((m) => m.kind)).toEqual(["build", "query"]);
  });

  it("supersedes a query still waiting, so a burst of keystrokes is one scan", async () => {
    // THE POINT OF THE WHOLE ARRANGEMENT. A query that matches nothing costs
    // 71.3 ms (§8.6) because the ladder walks the whole vocabulary, and somebody
    // typing a word the corpus does not contain fires one per keystroke. The
    // queue must not grow past a single pending query however fast they type.
    const { worker, e } = engine();
    const build = e.build([DOC]);
    await settle();

    // The handlers are attached AS each promise is made, because superseding is
    // synchronous — the next `query` call rejects the last one before this
    // statement finishes.
    const named = (p: Promise<unknown>): Promise<string> =>
      p.then(() => "resolved", (err: Error) => err.name);
    const first = named(e.query("re", 10, true));
    const second = named(e.query("reu", 10, true));
    const third = e.query("reun", 10, true);
    await settle();
    expect(await first).toBe("AbortError");
    expect(await second).toBe("AbortError");

    worker.answer(); // the build
    await build;
    await settle();
    // Only the newest was ever posted.
    expect(worker.sent.filter((m) => m.kind === "query")).toHaveLength(1);
    expect(worker.sent[1]).toMatchObject({ kind: "query", text: "reun" });
    worker.answer();
    await expect(third).resolves.toMatchObject({ total: 0 });
  });

  it("frees a caller whose signal fires on a query already posted", async () => {
    // It cannot claw the scan back — nothing can. What it prevents is a
    // superseded answer reaching a view that has moved on, and it lets the next
    // request be posted rather than waiting the scan out first.
    const { worker, e } = engine();
    void e.build([DOC]);
    await settle();
    worker.answer();
    await settle();

    const ac = new AbortController();
    const p = e.query("reunaio", 10, true, ac.signal);
    await settle();
    expect(worker.sent).toHaveLength(2);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    // The late answer is dropped rather than resolving anybody.
    worker.answer();
    await settle();
  });

  it("refuses a query whose signal fired before it could be posted", async () => {
    const { worker, e } = engine();
    void e.build([DOC]);
    await settle();
    const ac = new AbortController();
    ac.abort();
    const p = e.query("reuniao", 10, true, ac.signal);
    worker.answer();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.sent.filter((m) => m.kind === "query")).toHaveLength(0);
  });

  it("never supersedes a build", async () => {
    // A build is not abortable and should not be: it is the same work the next
    // keystroke needs, and both consumers say so already.
    const { worker, e } = engine();
    const one = e.build([DOC]);
    const two = e.build([DOC]);
    await settle();
    worker.answer();
    await settle();
    worker.answer();
    await expect(one).resolves.toBeUndefined();
    await expect(two).resolves.toBeUndefined();
    expect(worker.sent).toHaveLength(2);
  });

  it("carries a wasm-side refusal across as an Error with its own name", async () => {
    const { worker, e } = engine();
    const p = e.build([DOC]);
    await settle();
    worker.reply({
      kind: "error",
      id: worker.sent[0]!.id,
      name: "SearchIndexError",
      message: "idx_add failed (-1): disk I/O error",
    });
    await expect(p).rejects.toMatchObject({ name: "SearchIndexError", message: /idx_add/ });
  });

  it("fails everything in flight AND everything after it when the worker dies", async () => {
    const { worker, e } = engine();
    const inFlight = e.build([DOC]);
    await settle();
    worker.die("the module would not compile");
    await expect(inFlight).rejects.toThrow(/would not compile/);
    // The regression `pdfClient.test.ts` names: a later request posted to a
    // corpse has nobody left to reject it, and the box sits on "searching…".
    await expect(e.query("reuniao", 10, true)).rejects.toThrow(/would not compile/);
  });

  it("terminates the worker on close, which is what hands the 16 MB back", async () => {
    const { worker, e } = engine();
    const p = e.build([DOC]);
    await settle();
    e.close();
    expect(worker.terminated).toBe(true);
    await expect(p).rejects.toThrow(/closed/);
  });
});

describe("a search engine with no worker to be had", () => {
  it("falls back to this thread when the constructor throws", async () => {
    // `cache/idb.ts`'s posture: this app runs on a plain-HTTP LAN origin where
    // several APIs are simply absent, and a missing engine must degrade rather
    // than break search. It reaches the injected core, which is what proves the
    // in-thread path took over.
    let loaded = 0;
    const load: CoreLoader = () => {
      loaded += 1;
      return Promise.reject(new Error("no wasm here"));
    };
    const e = createSearchEngine({
      load,
      makeWorker: () => {
        throw new Error("workers are blocked");
      },
    });
    await expect(e.build([DOC])).rejects.toThrow(/no wasm here/);
    expect(loaded).toBe(1);
  });

  it("takes the in-thread path whenever a loader is injected", async () => {
    // A function cannot be structured-cloned into a worker, so supplying one is
    // itself the choice — which is what keeps every unit test that injects a fake
    // core driving exactly the code it was written against.
    const worker = new FakeWorker();
    const e = createSearchEngine({
      load: () => Promise.reject(new Error("mine")),
      makeWorker: () => worker as unknown as Worker,
    });
    await expect(e.build([DOC])).rejects.toThrow(/mine/);
    expect(worker.sent).toEqual([]);
  });

  it("says so rather than answering zero out of an index nobody filled", async () => {
    const e = createSearchEngine({ load: () => Promise.reject(new Error("unused")) });
    await expect(e.query("reuniao", 10, true)).rejects.toThrow(/nothing built/);
  });
});
