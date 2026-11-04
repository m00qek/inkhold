// The skeleton page: what the reader shows for a page whose real geometry has
// not arrived yet, and the signal that it must not be rendered.

import type { PageRef } from "./types";

/**
 * The Supernote portrait page in device pixels (Nomad / A5X): the skeleton
 * aspect while real dimensions are in flight.
 */
export const DEFAULT_PAGE_DIMS = { w: 1404, h: 1872 } as const;

/**
 * A placeholder {@link PageRef} for a page not yet arrived: an empty `hash`
 * (the "don't render" signal) and the given dims.
 */
export function skeletonPage(
  index: number,
  dims: { w: number; h: number } = DEFAULT_PAGE_DIMS,
): PageRef {
  // A skeleton stands in for a `.note` page and states nothing it hasn't been
  // told; null hashes mean "do not ask".
  return { index, hash: "", width: dims.w, height: dims.h, textHash: null, linksHash: null, sourcePage: null };
}
