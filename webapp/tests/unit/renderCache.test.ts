import { describe, it, expect, vi, afterEach } from "vitest";
import { cacheId, createRenderCache } from "../../src/cache/renderCache";
import type { PersistentThumbStore } from "../../src/cache/idb";
import type { RenderKey } from "../../src/cache/types";

// Thumb keys carry the live density bucket (`hash:thumb:theme:bN`); old unbucketed
// persistent keys are plain misses.

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
    expect(cacheId(key({ size: "full" }), 2)).toBe("h1:full:light");
    expect(cacheId(key({ size: "native" }), 3)).toBe("h1:native:light");
  });

  it("defaults the bucket from the live devicePixelRatio, per call", () => {
    setDpr(1);
    expect(cacheId(key())).toBe("h1:thumb:light:b1");
    setDpr(1.5);
    expect(cacheId(key())).toBe("h1:thumb:light:b2");
    setDpr(undefined);
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
    await cache.put(key(), bitmap);
    await expect(cache.get(key())).resolves.toBe(bitmap);
    expect(store.get).not.toHaveBeenCalled();

    setDpr(2);  // monitor hop → bucket 2: the b1 entry must not answer
    await expect(cache.get(key())).resolves.toBeUndefined();
    expect(store.get).toHaveBeenCalledWith("h1:thumb:light:b2");
  });

  it("evictTheme matches bucketed thumb ids and unbucketed full ids alike", async () => {
    setDpr(1);
    const cache = createRenderCache({ persistent: null });
    const lightThumb = bmp();
    const darkThumb = bmp();
    const lightFull = bmp();
    await cache.put(key(), lightThumb);
    await cache.put(key({ hash: "h2", theme: "dark" }), darkThumb);
    await cache.put(key({ hash: "h3", size: "full" }), lightFull);

    await cache.evictTheme?.("light");
    await expect(cache.get(key())).resolves.toBeUndefined();
    await expect(cache.get(key({ hash: "h3", size: "full" }))).resolves.toBeUndefined();
    await expect(cache.get(key({ hash: "h2", theme: "dark" }))).resolves.toBe(darkThumb);
  });
});
