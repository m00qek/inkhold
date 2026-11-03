// Reflow-free tile shaping shared by the library gallery and the recycle bin.

import { fileKind } from "../core/fileKind";

/**
 * The row tile's width cap (× its fixed height). Row aspects are pre-clamped so
 * a panorama reserves its final letterboxed width up front.
 */
export const ASPECT_CAP = 2.5;

/** Pin a tile's inline `aspect-ratio` and tag it `has-aspect`. */
export function pinAspect(tile: HTMLElement, aspect: number, row: boolean): void {
  tile.style.aspectRatio = String(row ? Math.min(aspect, ASPECT_CAP) : aspect);
  tile.classList.add("has-aspect");
}

/** ISO A4 portrait: a `.pdf` tile's shape until page 0 has rendered once. */
export const A4_ASPECT = 210 / 297;

/**
 * Types whose tile shape is learned from the pixels (images, and `.pdf` page 0,
 * whose `/MediaBox` the server deliberately never parses) via the dims memo.
 */
export function learnsAspect(fileType: string): boolean {
  const t = (fileType || "").trim().toLowerCase();
  return fileKind(t) === "image" || t === "pdf";
}

/**
 * The shape a learning tile reserves before it knows, or null for the CSS floor.
 * Only `.pdf`: a src-less `<img>` would otherwise lay out square.
 */

export function provisionalAspect(fileType: string): number | null {
  return (fileType || "").trim().toLowerCase() === "pdf" ? A4_ASPECT : null;
}
