import type { PageRef } from "./types";

/**
 * The Supernote portrait page in device pixels (Nomad / A5X). Used as the aspect
 * of a skeleton page while the real per-page dimensions are still in flight — a
 * sensible default so the filmstrip and stage lay out at the right shape before
 * the network answers, and the overwhelmingly common (portrait) case is exact.
 */
export const DEFAULT_PAGE_DIMS = { w: 1404, h: 1872 } as const;

/**
 * A placeholder {@link PageRef} for a page whose bytes/metadata haven't arrived
 * yet: an empty `hash` (the reader's "don't render this page" signal) and the
 * given dimensions. The single definition of the skeleton page, shared by the
 * reader's instant-paint meta and `synthesizeSummary` so the two can't drift.
 */
export function skeletonPage(
  index: number,
  dims: { w: number; h: number } = DEFAULT_PAGE_DIMS,
): PageRef {
  // `sourcePage: null` — a skeleton stands in for a `.note` page, whose number
  // is always `index + 1` (see `PageRef.sourcePage`).
  // `linksHash: null` for the same reason as `textHash`: a skeleton page states
  // nothing it has not been told, and null is the "do not ask" reading — the
  // real hash arrives with the metadata.
  return { index, hash: "", width: dims.w, height: dims.h, textHash: null, linksHash: null, sourcePage: null };
}
