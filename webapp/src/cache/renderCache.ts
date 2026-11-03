// The concrete `RenderCache`: a byte-budgeted memory LRU of `ImageBitmap`s
// (closed on eviction, since the GC cannot see a bitmap's weight) over a
// persistent WebP tier for thumbnails only. Memory keeps decoded bitmaps;
// only the persistent tier pays the encode.

import type { RenderCache, RenderKey } from "./types";
import { keyOf } from "./types";
import { ByteLru } from "./lru";
import type { PersistentThumbStore } from "./idb";
import { densityBucket } from "../render/types";

/**
 * Thumb keys carry the density bucket (`hash:thumb:theme:b{1..3}`): a thumb's
 * pixels depend on it. Read per call, so a DPR change re-keys. Older unbucketed
 * persistent entries just miss and age out.
 */
export function cacheId(key: RenderKey, bucket: number = densityBucket()): string {
  const base = keyOf(key);
  return key.size === "thumb" ? `${base}:b${bucket}` : base;
}

export interface RenderCacheOptions {
  /**
   * Default 48 MB. An unmeasured bound on a long scroll, sized for a browser
   * tab, not the server's 50 MB Pi ceiling.
   */
  memoryBudgetBytes?: number;
  /** Null runs memory-only. */
  persistent?: PersistentThumbStore | null;
}

const DEFAULT_MEMORY_BUDGET = 48 * 1024 * 1024;

function bitmapBytes(bm: ImageBitmap): number {
  return bm.width * bm.height * 4;
}

// High enough that thin e-ink strokes survive without ringing.
const WEBP_QUALITY = 0.9;
const WEBP_TYPE = "image/webp";

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** Null when no canvas or WebP encoder exists; the persistent tier is then skipped. */
async function bitmapToWebp(bm: ImageBitmap): Promise<Blob | null> {
  const canvas = makeCanvas(bm.width, bm.height);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return null;
  ctx.drawImage(bm, 0, 0);
  if (canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({ type: WEBP_TYPE, quality: WEBP_QUALITY });
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  }
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      canvas.width = 0;
      canvas.height = 0;
      resolve(blob);
    }, WEBP_TYPE, WEBP_QUALITY);
  });
}

export function createRenderCache(opts: RenderCacheOptions = {}): RenderCache {
  const persistent = opts.persistent ?? null;
  const lru = new ByteLru<string, ImageBitmap>({
    budgetBytes: opts.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET,
    sizeOf: bitmapBytes,
    // Safe: callers blit synchronously after get()/put(), so no pending paint holds it.
    onEvict: (_id, bm) => bm.close(),
  });

  return {
    async get(key: RenderKey): Promise<ImageBitmap | undefined> {
      const id = cacheId(key);
      const mem = lru.get(id);
      if (mem) return mem;

      if (persistent && key.size === "thumb") {
        const blob = await persistent.get(id);
        if (blob) {
          const bm = await createImageBitmap(blob);
          lru.put(id, bm);
          return bm;
        }
      }
      return undefined;
    },

    async put(key: RenderKey, bitmap: ImageBitmap): Promise<void> {
      const id = cacheId(key);
      lru.put(id, bitmap);
      if (persistent && key.size === "thumb") {
        const blob = await bitmapToWebp(bitmap);
        if (blob) await persistent.put(id, blob);
      }
    },

    async evictTheme(theme): Promise<void> {
      // Ids end in `:theme` or contain `:theme:b`; hex hashes and fixed size words cannot collide.
      const terminal = `:${theme}`;
      const bucketed = `:${theme}:b`;
      for (const id of lru.keys()) {
        if (id.endsWith(terminal) || id.includes(bucketed)) lru.delete(id);
      }
      // Persistent thumbs re-derive on demand; a theme scan is not worth it.
    },
  };
}
