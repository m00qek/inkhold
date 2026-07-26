// The rendering seam. A `NoteRenderer` turns one page's `.note` bytes into a
// painted `ImageBitmap`. The real implementation (P5) is a Zig RATTA_RLE decoder
// compiled to WASM; a synthetic fake (render/fake.ts) stands in for dev + e2e so
// the whole UI is exercisable before the decoder exists. Nothing above this seam
// knows which one it's talking to.

import type { Id, PageRef, RenderSize, Theme } from "../core/types";

/**
 * The gallery column width in CSS px — the "thumb" tier's design axis.
 *
 * ⚠ PAIRED with the CSS `--tile-w-icon` token (introduced by the masonry layout
 * pass in styles/): the icon-mode gallery fixes its tiles to that column width,
 * and this constant must hold the SAME value, or the raster tier renders for a
 * column that doesn't exist (soft when smaller, wasted pixels when bigger).
 * Chosen from the pre-masonry grid's ~184–245px `minmax` range: 184 is the
 * widest a tile actually painted, so the tier never undershoots the layout.
 *
 * This replaces the old flat `THUMB_WIDTH = 360` (an implicit ~2× bake-in that
 * was pixel-perfect only on 2× panels). The tier is now width-normalized and
 * density-bucketed — see {@link thumbTargetWidth}.
 */
export const TILE_W = 184;

/**
 * Headroom multiplier on the tier target. `devicePixelRatio` already folds
 * browser zoom in (a zoom re-buckets naturally), so this ~1.25× covers only
 * CSS hover/zoom effects and bucket-boundary softness — a raster slightly
 * larger than 1:1 downscales imperceptibly, one slightly smaller reads blurry.
 */
export const TILE_LEEWAY = 1.25;

/**
 * The pristine tier's density bucket: `clamp(ceil(devicePixelRatio), 1, 3)`.
 *
 * The point is 1:1 device-pixel mapping — a raster at exactly CSS×bucket
 * displays with no second resample, which is where crispness comes from. A
 * fractional-DPR laptop (1.25, 1.5) rounds UP so it downsamples slightly
 * rather than upscaling. Read fresh per render call (no caching): a monitor
 * hop or zoom change lands in a new bucket, which is a re-render into a new
 * cache key, not thrash — buckets are coarse and sources cheap to revisit.
 */
export function densityBucket(
  dpr: number = typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1,
): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(3, Math.max(1, Math.ceil(dpr)));
}

/**
 * The "thumb" tier's target output width in PHYSICAL px:
 * `TILE_W (CSS px) × bucket × TILE_LEEWAY`. Bucket 1 → 230, 2 → 460, 3 → 690.
 *
 * A downscale ceiling, never a floor: every producer stores at
 * `min(target, source)` — the `.spd` 600-wide embedded thumb must not be
 * inflated; fake sharpness is worse than CSS scaling.
 */
export function thumbTargetWidth(bucket: number = densityBucket()): number {
  return Math.round(TILE_W * bucket * TILE_LEEWAY);
}

/** A rendered page ready to blit to a display canvas. */
export interface DecodedPage {
  bitmap: ImageBitmap;
  /** Output pixel dimensions (may be downscaled from native for "thumb"). */
  width: number;
  height: number;
}

export interface RenderRequest {
  /** The page's `.note` byte-range, from {@link Api.getPageBytes}. */
  bytes: ArrayBuffer;
  /**
   * The note this page belongs to — the `{id}` in `GET /note/{id}/template/
   * {hash}`. The renderer needs it only for a page with a custom IMAGE
   * background (the SNPG carries the asset hash, the URL needs the note id);
   * every RLE page ignores it.
   */
  noteId: Id;
  page: PageRef;
  /** Target tier — controls output resolution (thumbnail vs. full reader page). */
  size: RenderSize;
  /** Colour world to paint in; dark inverts the e-ink. */
  theme: Theme;
}

export interface NoteRenderer {
  /**
   * Decode + paint one page. Async because the real path awaits WASM decode and
   * `createImageBitmap`. Implementations must be pure w.r.t. `req` (same request
   * → equivalent bitmap) so results are safe to cache by (hash, size, theme).
   */
  render(req: RenderRequest): Promise<DecodedPage>;
}
