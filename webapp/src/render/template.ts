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

export function createTemplateProvider(
  api: Pick<Api, "getTemplate">,
  decode: (blob: Blob) => Promise<ImageBitmap> = (b) => createImageBitmap(b),
): TemplateProvider {
  const cache = new Map<string, Promise<ImageBitmap | null>>();
  return (noteId, hash) => {
    let pending = cache.get(hash);
    if (!pending) {
      pending = (async () => {
        try {
          return await decode(await api.getTemplate(noteId, hash));
        } catch {
          return null;
        }
      })();
      cache.set(hash, pending);
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
