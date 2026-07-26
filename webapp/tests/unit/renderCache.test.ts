import { describe, it, expect, vi, afterEach } from "vitest";
import { cacheId, createRenderCache } from "../../src/cache/renderCache";
import type { PersistentThumbStore } from "../../src/cache/idb";
import type { RenderKey } from "../../src/cache/types";

// The render cache's pristine-tier keying: thumb entries carry the density
// bucket — `hash:thumb:theme:bN` — in memory and in the persistent store alike,
// the bucket read from the LIVE devicePixelRatio per call. Old-format
// persistent entries (`hash:thumb:theme`) are tolerated as plain misses.

const bmp = (w = 8, h = 8): ImageBitmap => ({ width: w, height: h, close: vi.fn() }) as unknown as ImageBitmap;

const key = (over: Partial<RenderKey> = {}): RenderKey => ({ hash: "h1", size: "thumb", theme: "light", ...over });

function fakeStore(entries: Record<string, Blob> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    available: true,
    get: vi.fn(async (k: string) => map.get(k)),
    put: vi.fn(async (k: string, b: Blob) => void map.set(k, b)),
    clear: vi.fn(async () => map.clear()),
  } satisfies PersistentThumbStore;
}

function setDpr(v: number | undefined): void {
  const g = globalThis as { devicePixelRatio?: number };
  if (v === undefined) delete g.devicePixelRatio;
  else g.devicePixelRatio = v;
}

afterEach(() => setDpr(undefined));

describe("cacheId", () => {
  it("appends the density bucket to thumb keys only", () => {
    expect(cacheId(key(), 2)).toBe("h1:thumb:light:b2");
    expect(cacheId(key({ theme: "dark" }), 1)).toBe("h1:thumb:dark:b1");
    // full/native are not the tier's width-normalized rasters — unbucketed.
    expect(cacheId(key({ size: "full" }), 2)).toBe("h1:full:light");
    expect(cacheId(key({ size: "native" }), 3)).toBe("h1:native:light");
  });

  it("defaults the bucket from the live devicePixelRatio, per call", () => {
    setDpr(1);
    expect(cacheId(key())).toBe("h1:thumb:light:b1");
    setDpr(1.5); // fractional → bucket 2
    expect(cacheId(key())).toBe("h1:thumb:light:b2");
    setDpr(undefined); // Node / no DPR → bucket 1
    expect(cacheId(key())).toBe("h1:thumb:light:b1");
  });
});

describe("render cache bucket keying", () => {
  it("queries the persistent tier with the bucketed id", async () => {
    setDpr(2);
    const store = fakeStore();
    const cache = createRenderCache({ persistent: store });
    await cache.get(key());
    expect(store.get).toHaveBeenCalledWith("h1:thumb:light:b2");
  });

  it("treats OLD-FORMAT persistent entries as plain misses — no migration", async () => {
    // A store written before the bucketed key format. The cache is regenerable
    // (every entry re-derives from immutable page bytes), so the old entry is
    // simply never found under the new key and ages out via the store's LRU.
    setDpr(1);
    const store = fakeStore({ "h1:thumb:light": new Blob(["old"]) });
    const cache = createRenderCache({ persistent: store });
    await expect(cache.get(key())).resolves.toBeUndefined();
    expect(store.get).toHaveBeenCalledWith("h1:thumb:light:b1");
  });

  it("evaluates the bucket per call — a DPR change misses the old bucket's memory entry", async () => {
    setDpr(1);
    const store = fakeStore();
    const cache = createRenderCache({ persistent: store });
    const bitmap = bmp();
    await cache.put(key(), bitmap); // memory id …:b1
    await expect(cache.get(key())).resolves.toBe(bitmap); // same bucket → memory hit
    expect(store.get).not.toHaveBeenCalled();

    setDpr(2); // monitor hop → bucket 2: the b1 entry must not answer
    await expect(cache.get(key())).resolves.toBeUndefined();
    expect(store.get).toHaveBeenCalledWith("h1:thumb:light:b2");
  });

  it("evictTheme matches bucketed thumb ids and unbucketed full ids alike", async () => {
    setDpr(1);
    const cache = createRenderCache({ persistent: null });
    const lightThumb = bmp();
    const darkThumb = bmp();
    const lightFull = bmp();
    await cache.put(key(), lightThumb); // h1:thumb:light:b1
    await cache.put(key({ hash: "h2", theme: "dark" }), darkThumb); // h2:thumb:dark:b1
    await cache.put(key({ hash: "h3", size: "full" }), lightFull); // h3:full:light

    await cache.evictTheme?.("light");
    await expect(cache.get(key())).resolves.toBeUndefined();
    await expect(cache.get(key({ hash: "h3", size: "full" }))).resolves.toBeUndefined();
    await expect(cache.get(key({ hash: "h2", theme: "dark" }))).resolves.toBe(darkThumb);
  });
});
