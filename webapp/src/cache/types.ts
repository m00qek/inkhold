// The render-cache seam (layer L3). Rendered pages are keyed by (content hash,
// size tier, theme) — never by note id or page number — so an unchanged page
// stays cached across note edits, and light/dark are distinct entries.
//
// The cache is NEVER a source of truth: every entry is re-derivable by
// re-fetching the (immutable) page bytes and re-rendering. That makes eviction
// — ours (bounded LRU / IndexedDB byte-cap) or the browser's (storage pressure)
// — always safe: a miss costs one re-render, never correctness. See
// [[file-serving-and-cache]] for the layered strategy and the size caps.

import type { Hash, RenderSize, Theme } from "../core/types";

export interface RenderKey {
  hash: Hash;
  size: RenderSize;
  theme: Theme;
}

export interface RenderCache {
  /** Cached bitmap for this key, or undefined on a miss. */
  get(key: RenderKey): Promise<ImageBitmap | undefined>;
  /** Store a freshly rendered bitmap. May evict older entries to stay in budget. */
  put(key: RenderKey, bitmap: ImageBitmap): Promise<void>;
  /**
   * Drop every entry for a theme (used when the user toggles theme and we choose
   * to reclaim the now-off-theme bitmaps). Cheap no-op if unsupported.
   */
  evictTheme?(theme: Theme): Promise<void>;
}

/** Canonical string form of a key — for the memory Map and the IndexedDB key. */
export function keyOf(k: RenderKey): string {
  return `${k.hash}:${k.size}:${k.theme}`;
}
