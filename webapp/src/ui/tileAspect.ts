// Reflow-free tile shaping, shared by the library gallery and the recycle bin.
//
// Both give a masonry/list tile its final shape up front by pinning an inline
// `aspect-ratio` and tagging it `has-aspect` (the class the CSS keys its
// width-from-aspect sizing off). They also share the ONE cap that keeps a
// panorama from reserving an absurd width. This is that pair, once.

/**
 * The list/row lead's width cap: 2.5× its fixed height, the same clamp every
 * preview class puts on its free axis. A ROW tile's aspect is PRE-CLAMPED with
 * it (masonry.md step 2's rider), so an extreme panorama reserves its final
 * LETTERBOXED width up front rather than snapping narrower when the CSS cap
 * bites at load. The icon masonry leaves the raw aspect in place: there the
 * clamp moves the FREE axis in CSS and the box is final either way.
 */
export const ASPECT_CAP = 2.5;

/**
 * Pin a tile's shape. In the `row` (list/search) context the fixed axis is
 * height, so the aspect is pre-clamped to {@link ASPECT_CAP}; the masonry
 * context gets the raw aspect. Adds `has-aspect` so the CSS sizes width from it.
 */
export function pinAspect(tile: HTMLElement, aspect: number, row: boolean): void {
  tile.style.aspectRatio = String(row ? Math.min(aspect, ASPECT_CAP) : aspect);
  tile.classList.add("has-aspect");
}
