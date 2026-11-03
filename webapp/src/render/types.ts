// The rendering seam: a `NoteRenderer` turns one page's `.note` bytes into an
// `ImageBitmap` (the Zig WASM decoder, or the synthetic fake in dev/e2e).

import type { Id, PageRef, RenderSize, Theme } from "../core/types";

/**
 * The gallery column width in CSS px, the "thumb" tier's design axis. Must equal
 * the CSS `--tile-w-icon` token, or thumbs render for a column that doesn't exist.
 */
export const TILE_W = 184;

/**
 * Headroom on the tier target. DPR already folds in browser zoom; this covers
 * hover effects and bucket-boundary softness.
 */
export const TILE_LEEWAY = 1.25;

/**
 * The pristine tier's density bucket, `clamp(ceil(devicePixelRatio), 1, 3)`, for
 * 1:1 device-pixel mapping (fractional DPR rounds up). Read fresh per call; a
 * zoom or monitor hop is a new cache key.
 */
export function densityBucket(
  dpr: number = typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1,
): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(3, Math.max(1, Math.ceil(dpr)));
}

/**
 * The "thumb" tier's target width in physical px (`TILE_W × bucket × TILE_LEEWAY`).
 * A ceiling only: producers store `min(target, source)` and never upscale.
 */
export function thumbTargetWidth(bucket: number = densityBucket()): number {
  return Math.round(TILE_W * bucket * TILE_LEEWAY);
}

export interface DecodedPage {
  bitmap: ImageBitmap;
  /** Output pixel dimensions (may be downscaled from native). */
  width: number;
  height: number;
}

export interface RenderRequest {
  bytes: ArrayBuffer;
  /** Only used for a custom image background (`GET /note/{id}/template/{hash}`). */
  noteId: Id;
  page: PageRef;
  size: RenderSize;
  /** Dark inverts the e-ink. */
  theme: Theme;
}

export interface NoteRenderer {
  /** Must be pure w.r.t. `req`, so results cache by (hash, size, theme). */
  render(req: RenderRequest): Promise<DecodedPage>;
}
