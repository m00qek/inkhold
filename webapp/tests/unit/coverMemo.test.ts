import { describe, it, expect, vi } from "vitest";
import { createCoverMemo, type NoCoverBackend } from "../../src/cache/coverMemo";

// The persistent negative-thumbnail memo: definitive 404s survive sessions
// (content-addressed — a new cover means a new hash, so a recorded miss can
// never go stale); transient failures never touch the backend.

function memBackend(): NoCoverBackend & { store: Set<string> } {
  const store = new Set<string>();
  return {
    store,
    async has(hash) {
      return store.has(hash);
    },
    async put(hash) {
      store.add(hash);
    },
  };
}

describe("createCoverMemo", () => {
  it("round-trips a definitive miss through the backend", async () => {
    const b = memBackend();
    const m = createCoverMemo(b);
    expect(await m.hasNoCover("aa")).toBe(false);
    await m.setNoCover("aa");
    expect(await m.hasNoCover("aa")).toBe(true);
    expect(b.store.has("aa")).toBe(true);
  });

  it("persists across instances (the cross-session property)", async () => {
    const b = memBackend();
    await createCoverMemo(b).setNoCover("bb");
    expect(await createCoverMemo(b).hasNoCover("bb")).toBe(true);
  });

  it("reads through the session layer: one backend read per hash per session", async () => {
    const b = memBackend();
    const spy = vi.spyOn(b, "has");
    const m = createCoverMemo(b);
    await m.hasNoCover("cc");
    await m.hasNoCover("cc");
    await m.hasNoCover("cc");
    expect(spy).toHaveBeenCalledTimes(1); // negative memoised in `unknown`
    await m.setNoCover("dd");
    await m.hasNoCover("dd");
    expect(spy).toHaveBeenCalledTimes(1); // session Set answered, no backend read
  });

  it("transient misses suppress for the session but never persist", async () => {
    const b = memBackend();
    const m = createCoverMemo(b);
    m.noteTransientMiss("ee");
    expect(await m.hasNoCover("ee")).toBe(true); // suppressed now
    expect(b.store.has("ee")).toBe(false); // nothing durable
    expect(await createCoverMemo(b).hasNoCover("ee")).toBe(false); // next session probes
  });

  it("degrades to session-only on backend failure, silently", async () => {
    const failing: NoCoverBackend = {
      async has() {
        throw new Error("idb gone");
      },
      async put() {
        throw new Error("idb gone");
      },
    };
    const m = createCoverMemo(failing);
    expect(await m.hasNoCover("ff")).toBe(false); // read failure = unknown
    await expect(m.setNoCover("ff")).resolves.toBeUndefined(); // no throw
    expect(await m.hasNoCover("ff")).toBe(true); // session layer still works
  });
});
