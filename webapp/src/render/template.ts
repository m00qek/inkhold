// Custom image templates (docs/scratch/custom-template.md) — the browser half.
//
// A `.note` page can have a browser-native IMAGE as its background layer
// (PNG/JPG/JPEG/WEBP) instead of a built-in RATTA_RLE template. The WASM decoder
// never draws those bytes; it hands the browser the template's asset HASH (see
// `note_decode.zig`'s `template_hash_*` exports — the Zig side owns the page
// payload wire format entirely). The browser fetches the image ONCE per distinct
// hash from `GET /note/{id}/template/{hash}`, decodes it with `createImageBitmap`,
// and draws it UNDER the ink composite.
//
// Everything here is deliberately split so the placement rules are pure and
// unit-testable; only `compositeTemplateUnderInk` touches a canvas.

import type { Hash, Id } from "../core/types";
import type { Api } from "../api/types";

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Ratta's placement, reduced to one rule: **contain, never upscale, centered**.
 * `scale = min(1, pageW/imgW, pageH/imgH)`; the image is drawn at
 * `(imgW*scale, imgH*scale)`, centered on the page over a white fill.
 * Reproduces every documented size case: both dims ≤ page → original size,
 * centered; narrow+tall → height→page; wide+short → width→page; both larger →
 * contain (exact 3:4 fills, else letterbox).
 */
export function templatePlacement(pageW: number, pageH: number, imgW: number, imgH: number): Placement {
  if (imgW <= 0 || imgH <= 0 || pageW <= 0 || pageH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(1, pageW / imgW, pageH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { x: (pageW - w) / 2, y: (pageH - h) / 2, w, h };
}

/**
 * Fetch + decode a page's image template, memoized so each distinct hash crosses
 * the wire and `createImageBitmap`s exactly ONCE — regardless of how many pages
 * (or which page order) reference it. The HTTP bytes ride the browser's
 * `immutable` cache; this map holds the decoded `ImageBitmap` keyed by hash.
 * A failed/absent template caches as null (a template page whose asset is gone
 * degrades to ink-on-white, never a repeated fetch).
 */
export type TemplateProvider = (noteId: Id, hash: Hash) => Promise<ImageBitmap | null>;

/**
 * How many decoded templates to keep.
 *
 * THE MEMO ABOVE ASSUMES A FEW TEMPLATES SHARED BY MANY PAGES — lined, grid,
 * dotted — which is what a hand-made notebook has, and for that the assumption
 * holds and the cache never grows past a handful.
 *
 * A NOTE BUILT ON A PDF INVERTS IT EXACTLY: every page of the imported document
 * is its own image, so "each distinct hash" is very nearly "every page". The
 * notebook that found this has **1698 distinct templates across 1703 pages**, and
 * an unbounded map held every one: an `ImageBitmap` is a native allocation, not
 * JS heap the collector can reclaim, and at 1404x1872 RGBA each is ~10.5 MB. The
 * whole-document export walked all 1703 pages and asked the browser for ~17.8 GB
 * of them, which failed exactly where you would expect —
 * `createImageBitmap: The ImageBitmap could not be allocated` — partway through,
 * with no download and nothing in the log to say why.
 *
 * Eight is chosen against the CONSUMERS, not the file. Both of them
 * (`render/wasm.ts`'s composite, `pages/noteLayers.ts`'s image layer) draw the
 * bitmap synchronously the moment their `await` resolves and never retain it, so
 * an entry is safe to close once a few others have been asked for since. The
 * document export is strictly sequential — one page in flight at a time — so the
 * evicted entry is eight templates stale. It bounds the cost at ~84 MB while
 * leaving the shared-template case, where the cap never binds, exactly as it was.
 */
export const templateCacheMax = 8;

export function createTemplateProvider(
  api: Pick<Api, "getTemplate">,
  decode: (blob: Blob) => Promise<ImageBitmap> = (b) => createImageBitmap(b),
  max: number = templateCacheMax,
): TemplateProvider {
  const cache = new Map<string, Promise<ImageBitmap | null>>();
  return (noteId, hash) => {
    const hit = cache.get(hash);
    if (hit) {
      // Freshen: `Map` iterates in insertion order, so re-inserting is what makes
      // the eviction below least-RECENTLY-used rather than merely oldest. Without
      // it, the one template every page shares would be evicted on a schedule.
      cache.delete(hash);
      cache.set(hash, hit);
      return hit;
    }

    const pending = (async () => {
      try {
        return await decode(await api.getTemplate(noteId, hash));
      } catch {
        return null;
      }
    })();
    cache.set(hash, pending);

    // CLOSE WHAT WE DROP. Letting an evicted entry fall out of the map alone
    // would free the promise and leak the native bitmap it resolved to, which is
    // the whole failure this cap exists to prevent.
    while (cache.size > max) {
      const oldest: string = cache.keys().next().value!;
      const evicted = cache.get(oldest)!;
      cache.delete(oldest);
      void evicted.then((b) => b?.close());
    }

    return pending;
  };
}

/**
 * Composite `ink` (the WASM ink-on-white page, bit2 skipped) OVER `template`
 * (the decoded image, contain-placed on a white fill) into a display bitmap,
 * optionally downscaled to `targetWidth`. The image is the BOTTOM; the ink is
 * multiplied on top so its white (blank) pixels let the image show through and
 * its dark strokes stay dark — the device's own look. Color image templates opt
 * out of dark-mode invert, so this always paints in the light world (the caller
 * skips the invert for a template page).
 *
 * Canvas-bound (browser only) — the pure `templatePlacement` carries the
 * placement logic under test.
 */
export async function compositeTemplateUnderInk(
  ink: ImageData,
  template: ImageBitmap,
  targetWidth: number,
): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  const pageW = ink.width;
  const pageH = ink.height;
  const canvas = new OffscreenCanvas(pageW, pageH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable for template composite");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pageW, pageH);
  const p = templatePlacement(pageW, pageH, template.width, template.height);
  if (p.w > 0 && p.h > 0) ctx.drawImage(template, p.x, p.y, p.w, p.h);

  const inkBitmap = await createImageBitmap(ink);
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(inkBitmap, 0, 0);
  inkBitmap.close();

  const scale = pageW > targetWidth ? targetWidth / pageW : 1;
  const outW = Math.max(1, Math.round(pageW * scale));
  const outH = Math.max(1, Math.round(pageH * scale));
  const bitmap =
    scale < 1
      ? await createImageBitmap(canvas, { resizeWidth: outW, resizeHeight: outH, resizeQuality: "high" })
      : await createImageBitmap(canvas);
  return { bitmap, width: outW, height: outH };
}
