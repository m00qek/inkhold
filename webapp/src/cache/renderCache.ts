// The render cache (layer L3) — the concrete `RenderCache` the UI renders
// through. Two tiers, keyed by (content hash, size, theme) via `keyOf`:
//
//   memory  — a byte-budgeted LRU of ImageBitmaps for instant re-blit; evicted
//             bitmaps are `close()`d to actually reclaim memory (the 50 MB RSS
//             budget is enforced structurally here).
//   idb     — thumbnails only, persisted as a compressed WebP Blob for a warm
//             cold-start (see `idb.ts` for why WebP rather than raw ImageData).
//
// The two tiers hold two FORMS on purpose: the browser cannot blit a Blob, and
// re-encoding a WebP on every re-blit would be waste, so memory keeps the
// decoded `ImageBitmap` while only the persistent tier pays the encode. The
// boundary is here: `put` encodes the bitmap to WebP on the way to IDB, `get`
// decodes it back on the way out.
//
// Never a source of truth: a miss re-fetches the immutable page bytes and
// re-renders, so eviction — ours or the browser's — is always safe. On a
// theme toggle the page evicts the now-off-theme bitmaps (`evictTheme`) rather
// than letting them idle in the budget.

import type { RenderCache, RenderKey } from "./types";
import { keyOf } from "./types";
import { ByteLru } from "./lru";
import type { PersistentThumbStore } from "./idb";
import { densityBucket } from "../render/types";

/**
 * The cache id for one entry. Thumb-tier keys carry the pristine tier's density
 * bucket — `hash:thumb:theme:b{1..3}` — because a thumb's PIXELS depend on the
 * bucket it was rendered for (target width = TILE_W × bucket × leeway), so two
 * buckets are two distinct rasters, in memory and in IndexedDB alike. The
 * bucket is read PER CALL (`densityBucket()` defaults from the live
 * `devicePixelRatio`), so a monitor hop or zoom change naturally re-keys.
 *
 * Persistent entries written before this key format (`hash:thumb:theme`) are
 * simply MISSES under the new keys — no migration, by design: the render cache
 * is never a source of truth, every entry re-derives from the immutable page
 * bytes, and the old entries age out of the byte-budgeted store via its own
 * LRU. `full`/`native` tiers are unbucketed (they are not the thumb tier's
 * width-normalized rasters) and keep the plain `keyOf` form.
 */
export function cacheId(key: RenderKey, bucket: number = densityBucket()): string {
  const base = keyOf(key);
  return key.size === "thumb" ? `${base}:b${bucket}` : base;
}

export interface RenderCacheOptions {
  /** Memory LRU cap. Default 48 MB — under the app's 50 MB RSS budget. */
  memoryBudgetBytes?: number;
  /** Persistent thumbnail tier, or null to run memory-only (tests, no IDB). */
  persistent?: PersistentThumbStore | null;
}

const DEFAULT_MEMORY_BUDGET = 48 * 1024 * 1024;

/** RGBA byte weight of a decoded bitmap. */
function bitmapBytes(bm: ImageBitmap): number {
  return bm.width * bm.height * 4;
}

// WebP quality for the persistent thumbnail. High enough that thin e-ink strokes
// survive without visible ringing (they are what the gallery pixel-probe reads),
// still ~20-40x smaller than the raw RGBA this replaced. Lossless-per-source (the
// doc's codec-per-source refinement) is deliberately left out of the first pass.
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

/**
 * Encode a bitmap to a WebP Blob so it can be structured-cloned into IDB. Handles
 * both canvas flavours: `OffscreenCanvas` returns the blob via `convertToBlob`,
 * a DOM `<canvas>` via the callback-style `toBlob`. Returns null when neither the
 * canvas nor the WebP encoder is available (older engines) — the caller then
 * simply skips the persistent tier, exactly as it did on an ImageData failure.
 */
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
    return canvas.convertToBlob({ type: WEBP_TYPE, quality: WEBP_QUALITY });
  }
  return new Promise((resolve) => canvas.toBlob(resolve, WEBP_TYPE, WEBP_QUALITY));
}

export function createRenderCache(opts: RenderCacheOptions = {}): RenderCache {
  const persistent = opts.persistent ?? null;
  const lru = new ByteLru<string, ImageBitmap>({
    budgetBytes: opts.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET,
    sizeOf: bitmapBytes,
    // Free GPU/heap memory on eviction. Safe: callers blit synchronously right
    // after get()/put(), so a returned bitmap is never closed out from under a
    // pending paint.
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
          // The browser decodes the WebP natively; this is the only place a
          // persisted thumbnail turns back into a blittable bitmap.
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
      // Ids are `hash:size:theme` (full/native) or `hash:size:theme:bN`
      // (thumb) — the theme segment is either terminal or bucket-suffixed.
      // Hashes are hex and sizes are fixed words, so neither can contain a
      // `:${theme}` fragment of its own.
      const terminal = `:${theme}`;
      const bucketed = `:${theme}:b`;
      for (const id of lru.keys()) {
        if (id.endsWith(terminal) || id.includes(bucketed)) lru.delete(id);
      }
      // Persistent thumbs are left to re-derive on demand; clearing selectively
      // by theme isn't worth a full scan, and they don't count against RSS.
    },
  };
}
