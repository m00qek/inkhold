import { describe, it, expect, vi } from "vitest";
import { createDimsMemo, getDims, setDims, type DimsBackend, type ImageDims } from "../../src/cache/dimsMemo";

function fakeBackend(seed: Record<string, ImageDims> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get: vi.fn(async (hash: string) => map.get(hash) ?? null),
    put: vi.fn(async (hash: string, dims: ImageDims) => void map.set(hash, dims)),
  };
}

describe("createDimsMemo", () => {
  it("round-trips: set → get returns the dims and persists them", async () => {
    const backend = fakeBackend();
    const memo = createDimsMemo(backend);
    await memo.setDims("h1", { w: 3000, h: 2000 });
    await expect(memo.getDims("h1")).resolves.toEqual({ w: 3000, h: 2000 });
    expect(backend.put).toHaveBeenCalledWith("h1", { w: 3000, h: 2000 });
  });

  it("persists across memo instances — the next SESSION knows the dims", async () => {
    const backend = fakeBackend();
    await createDimsMemo(backend).setDims("h1", { w: 800, h: 600 });
    // A fresh memo over the same backend = a new session over the same IDB.
    await expect(createDimsMemo(backend).getDims("h1")).resolves.toEqual({ w: 800, h: 600 });
  });

  it("reads through the session Map — one backend hit per hash, hits and misses alike", async () => {
    const backend = fakeBackend({ known: { w: 10, h: 20 } });
    const memo = createDimsMemo(backend);
    await memo.getDims("known");
    await memo.getDims("known");
    await memo.getDims("unknown");
    await memo.getDims("unknown");
    expect(backend.get).toHaveBeenCalledTimes(2);
  });

  it("null means 'unknown yet', and a later set overrides a remembered miss", async () => {
    const backend = fakeBackend();
    const memo = createDimsMemo(backend);
    await expect(memo.getDims("h1")).resolves.toBeNull();
    await memo.setDims("h1", { w: 1, h: 2 });
    await expect(memo.getDims("h1")).resolves.toEqual({ w: 1, h: 2 });
  });

  it("degrades to session-only when the backend fails — never throws", async () => {
    const backend: DimsBackend = {
      get: vi.fn(async () => {
        throw new Error("idb down");
      }),
      put: vi.fn(async () => {
        throw new Error("idb down");
      }),
    };
    const memo = createDimsMemo(backend);
    await expect(memo.setDims("h1", { w: 5, h: 6 })).resolves.toBeUndefined();
    await expect(memo.getDims("h1")).resolves.toEqual({ w: 5, h: 6 });
    await expect(memo.getDims("other")).resolves.toBeNull();
  });
});

describe("module-level surface (the layout/facade contract)", () => {
  it("getDims/setDims work in Node, where IndexedDB is absent (session-only)", async () => {
    await setDims("mod-hash", { w: 123, h: 456 });
    await expect(getDims("mod-hash")).resolves.toEqual({ w: 123, h: 456 });
    await expect(getDims("never-seen")).resolves.toBeNull();
  });
});
