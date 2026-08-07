// Reflow-free tile shaping, shared by the library gallery and the recycle bin.
//
// Both give a masonry/list tile its final shape up front by pinning an inline
// `aspect-ratio` and tagging it `has-aspect` (the class the CSS keys its
// width-from-aspect sizing off). They also share the ONE cap that keeps a
// panorama from reserving an absurd width, and the small policy below about
// WHICH types have a shape to learn and what they stand on until they learn it.

import { fileKind } from "../core/fileKind";

/**
 * The list/row lead's width cap: 2.5× its fixed height, the same clamp every
 * preview class puts on its free axis. A ROW tile's aspect is PRE-CLAMPED with
 * it ('s rider), so an extreme panorama reserves its final
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

/**
 * ISO A4 portrait, 210×297 — 0.7071.
 *
 * What a `.pdf` tile stands on until its page 0 has been rendered once. Not the
 * app's usual 3:4 sheet: that number is the DEVICE PANEL's shape, and a PDF is
 * overwhelmingly a printed page. The PDF viewer's page strip already reserves
 * exactly this (`--thumb-aspect` in `20-pdf-viewer.css`) and corrects per row as
 * pages resolve, so this is the established default rather than a new one.
 */
export const A4_ASPECT = 210 / 297;

/**
 * Types whose tile shape is LEARNED from the pixels rather than served — the two
 * the dims memo (`cache/dimsMemo.ts`) is fed for, keyed by file hash:
 *
 *  - an IMAGE, whose true dims the thumbnail facade records on first decode;
 *  - a `.pdf`, whose page-0 box the `pdf-page` strategy records after the
 *    render. Nothing indexes a PDF's `/MediaBox` server-side — that would be a
 *    PDF parser in the backend, on hostile input, for a layout hint — so the
 *    client is the only thing that can ever know it.
 *
 * Everything else either states its shape up front (`thumbAspect`, the `.txt`
 * constant) or has none to learn (a glyph tile), and must not be given a
 * corrective reflow it will never earn.
 */
export function learnsAspect(fileType: string): boolean {
  const t = (fileType || "").trim().toLowerCase();
  return fileKind(t) === "image" || t === "pdf";
}

/**
 * The shape a {@link learnsAspect} tile RESERVES before it has learnt anything,
 * or null to leave the CSS floor standing.
 *
 * Only a `.pdf` takes one, and the asymmetry is deliberate. A PDF's tile is an
 * engine-managed `<img>` with no `src` until the facade answers, and an
 * `<img>` with no source has the intrinsic size of the 1×1 transparent GIF the
 * CSS substitutes for the broken-image icon — i.e. SQUARE, which is the one
 * shape a document is almost never. An image's tile keeps the null: its own
 * corrective reflow on decode is long-standing behaviour, and guessing at a
 * photo's shape would be inventing a fact rather than deferring one.
 */
export function provisionalAspect(fileType: string): number | null {
  return (fileType || "").trim().toLowerCase() === "pdf" ? A4_ASPECT : null;
}
