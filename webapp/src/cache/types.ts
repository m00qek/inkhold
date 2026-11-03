// The render-cache seam. Keyed by (content hash, size tier, theme), never note
// id or page, so unchanged pages survive edits. Never a source of truth: a
// miss costs one re-render, so any eviction is safe.

import type { Hash, RenderSize, Theme } from "../core/types";

export interface RenderKey {
  hash: Hash;
  size: RenderSize;
  theme: Theme;
}

export interface RenderCache {
  get(key: RenderKey): Promise<ImageBitmap | undefined>;
  /** May evict older entries. */
  put(key: RenderKey, bitmap: ImageBitmap): Promise<void>;
  /** Drop every entry for a theme. Optional. */
  evictTheme?(theme: Theme): Promise<void>;
}

export function keyOf(k: RenderKey): string {
  return `${k.hash}:${k.size}:${k.theme}`;
}
