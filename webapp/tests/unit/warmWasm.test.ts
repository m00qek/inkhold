// The background warm-up of the WebAssembly modules after sign-in.

import { describe, it, expect } from "vitest";
import { warmWasm, shouldSkip, WARM_WASM_URLS, WARM_DELAY_MS, type WarmDeps } from "../../src/core/warmWasm";
import { DEFAULT_WASM_URL as SEARCH_URL } from "../../src/search/indexEngine";
import { DEFAULT_WASM_URL as PDF_URL } from "../../src/render/pdfLoader";

/** Timers and idle callbacks run only when the test says so. */
function harness(connection?: WarmDeps["connection"]) {
  const fetched: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const idle: (() => void)[] = [];
  let release: (() => void) | null = null;
  const deps: WarmDeps = {
    fetch: async (url, init) => {
      fetched.push(url);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      // Each fetch waits for the test, so "one at a time" is observable.
      await new Promise<void>((r) => (release = r));
      return new Response(new Uint8Array(4));
    },
    whenIdle: (fn) => void idle.push(fn),
    setTimeout: (fn, ms) => void timers.push({ fn, ms }),
    connection,
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    deps,
    fetched,
    timers,
    idle,
    async next() {
      release?.();
      release = null;
      await settle();
    },
    settle,
  };
}

describe("warming the wasm modules after sign-in", () => {
  it("names the same URLs the loaders use, search first", () => {
    expect(WARM_WASM_URLS).toEqual([SEARCH_URL, PDF_URL]);
  });

  it("waits for its delay, then for idle, then fetches one module at a time", async () => {
    const h = harness();
    warmWasm(h.deps);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(WARM_DELAY_MS);
    expect(h.fetched).toEqual([]);

    h.timers[0].fn();
    expect(h.idle).toHaveLength(1);
    expect(h.fetched).toEqual([]);

    h.idle[0]();
    await h.settle();
    expect(h.fetched).toEqual(["/sqlite-core.wasm"]);
    await h.next();
    expect(h.fetched).toEqual(["/sqlite-core.wasm", "/pdf-decode.wasm"]);
    await h.next();
    expect(h.fetched).toHaveLength(2);
  });

  it("fetches nothing once cancelled (sign-out)", async () => {
    const h = harness();
    const cancel = warmWasm(h.deps);
    cancel();
    h.timers[0].fn();
    expect(h.idle).toEqual([]);
    expect(h.fetched).toEqual([]);
  });

  it("stops between modules when cancelled mid-way", async () => {
    const h = harness();
    const cancel = warmWasm(h.deps);
    h.timers[0].fn();
    h.idle[0]();
    await h.settle();
    cancel();
    await h.next();
    expect(h.fetched).toEqual(["/sqlite-core.wasm"]);
  });

  it("does nothing on a connection that asks to save data", () => {
    const h = harness({ saveData: true });
    warmWasm(h.deps);
    expect(h.timers).toEqual([]);
    expect(shouldSkip({ effectiveType: "2g" })).toBe(true);
    expect(shouldSkip({ effectiveType: "slow-2g" })).toBe(true);
    expect(shouldSkip({ effectiveType: "4g" })).toBe(false);
    expect(shouldSkip(undefined)).toBe(false);
  });

  it("gives up quietly when a fetch fails", async () => {
    const fetched: string[] = [];
    let idleFn: (() => void) | null = null;
    let timerFn: (() => void) | null = null;
    warmWasm({
      fetch: async (url) => {
        fetched.push(url);
        throw new TypeError("offline");
      },
      whenIdle: (fn) => void (idleFn = fn),
      setTimeout: (fn) => void (timerFn = fn),
    });
    timerFn!();
    idleFn!();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetched).toEqual(["/sqlite-core.wasm"]);
  });
});
