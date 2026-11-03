// Custom image templates (PNG/JPG/WEBP page backgrounds), the browser half. The
// WASM decoder only reports the asset hash; the browser fetches
// `GET /note/{id}/template/{hash}`, decodes it, and draws it under the ink.

import type { Hash, Id } from "../core/types";
import type { Api } from "../api/types";

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Ratta's placement: contain, never upscale, centered over a white fill
 * (`scale = min(1, pageW/imgW, pageH/imgH)`).
 */
export function templatePlacement(pageW: number, pageH: number, imgW: number, imgH: number): Placement {
  if (imgW <= 0 || imgH <= 0 || pageW <= 0 || pageH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(1, pageW / imgW, pageH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { x: (pageW - w) / 2, y: (pageH - h) / 2, w, h };
}

/**
 * Fetch and decode a template, memoized per hash. A failed or absent template
 * caches as null, degrading to ink-on-white without refetching.
 */
export type TemplateProvider = (noteId: Id, hash: Hash) => Promise<ImageBitmap | null>;

/**
 * How many decoded templates to keep. A PDF-based note has a distinct template
 * per page, and each 1404×1872 `ImageBitmap` (~10.5 MB native, not GC-reclaimed)
 * would otherwise accumulate until `createImageBitmap` fails mid-export. Safe
 * because consumers draw the bitmap synchronously and never retain it.
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
      // Re-insert so eviction is least-recently-used, not oldest.
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

    // Close what we drop; removing it from the map alone leaks the native bitmap.
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
 * Multiply the WASM ink-on-white page over the contain-placed template, so blank
 * ink shows the image through. Always the light world (image templates opt out
 * of dark invert). Browser only.
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
