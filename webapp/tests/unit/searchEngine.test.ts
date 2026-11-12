import { describe, it, expect } from "vitest";
import { createSearchEngine } from "../../src/search/searchEngine";
import type { EngineRequest, EngineResponse } from "../../src/search/engineWorker";
import type { CoreLoader, TermsDocument } from "../../src/search/indexEngine";

// Driven by a fake worker: `idx_fuzzy` is synchronous and uninterruptible, so abort
// lives here (one request in flight, the waiting query replaced, not queued).

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
    else if (last.kind === "items") this.reply({ kind: "written", id: last.id });
    else this.reply({ kind: "result", id: last.id, total: 0, hits: [], items: [], expansions: [] });
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
    // The 16.13 MB engine must not be instantiated at boot.
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
    expect(worker.sent.map((m) => m.kind)).toEqual(["build"]);
    worker.answer();
    await settle();
    expect(worker.sent.map((m) => m.kind)).toEqual(["build", "query"]);
  });

  it("supersedes a query still waiting, so a burst of keystrokes is one scan", async () => {
    // A no-match query costs 71.3 ms; the queue must never grow past one pending query.
    const { worker, e } = engine();
    const build = e.build([DOC]);
    await settle();

    // Handlers attach as each promise is made: superseding rejects synchronously.
    const named = (p: Promise<unknown>): Promise<string> =>
      p.then(() => "resolved", (err: Error) => err.name);
    const first = named(e.query("re", 10, true));
    const second = named(e.query("reu", 10, true));
    const third = e.query("reun", 10, true);
    await settle();
    expect(await first).toBe("AbortError");
    expect(await second).toBe("AbortError");

    worker.answer();
    await build;
    await settle();
    expect(worker.sent.filter((m) => m.kind === "query")).toHaveLength(1);
    expect(worker.sent[1]).toMatchObject({ kind: "query", text: "reun" });
    worker.answer();
    await expect(third).resolves.toMatchObject({ total: 0 });
  });

  it("frees a caller whose signal fires on a query already posted", async () => {
    // The scan cannot be clawed back; the stale answer just never reaches the view.
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

  it("posts item rows in turn, and a query never supersedes them", async () => {
    const { worker, e } = engine();
    const write = e.setItems("todo", [{ key: "t1", text: "ana" }]);
    // Superseded while waiting by the next one; the write is not.
    const ask = expect(e.query("ana", 10, true)).rejects.toMatchObject({ name: "AbortError" });
    const later = e.query("ana b", 10, true);
    await settle();
    expect(worker.sent.map((r) => r.kind)).toEqual(["items"]);
    expect(worker.sent[0]).toMatchObject({ kind: "items", of: "todo", rows: [{ key: "t1", text: "ana" }] });
    worker.answer();
    await expect(write).resolves.toBeUndefined();
    await settle();
    await ask;
    expect(worker.sent.map((r) => r.kind)).toEqual(["items", "query"]);
    worker.answer();
    await expect(later).resolves.toMatchObject({ items: [] });
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
    // Regression: a request posted to a dead worker was never rejected.
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
    // The plain-HTTP LAN origin lacks some APIs; a missing worker falls back in-thread.
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
    // A function cannot be cloned into a worker, so injecting a core forces in-thread.
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
