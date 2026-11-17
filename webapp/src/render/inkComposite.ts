// A page with a `.mark` page's ink drawn over it, as the viewer shows it. Shared
// by the viewer's page strip and the gallery's tiles, so a page and its ink look
// the same everywhere: the person sees one file, not a document and its `.mark`.

import { placePanelOverPage } from "./markGeometry";

/** A `.mark` page's ink reduced into a canvas of `dst`'s size, or null. */
export type InkRaster = (
  bytes: ArrayBuffer,
  dst: { width: number; height: number },
) => Promise<HTMLCanvasElement | null>;

/**
 * `page` with the ink of one mark page (`panel`, its device-panel size; `bytes`,
 * its SNPG) over it, as a new bitmap. Null only when there is definitely
 * nothing to draw (no ink, nowhere to put it); a failure (the decoder, a
 * canvas) throws, so a caller can tell the two apart. `page` is never closed.
 */
export async function compositeInk(
  page: ImageBitmap,
  panel: { width: number; height: number },
  bytes: ArrayBuffer,
  inkRaster: InkRaster,
): Promise<ImageBitmap | null> {
  if (page.width <= 0 || page.height <= 0) return null;
  // Same placement as on screen (`markGeometry.ts`): ink is in panel pixels and
  // the page is a letterboxed sub-rect. Raster pixels can stand in for page
  // points because the fit is scale-invariant, saving a `pageSize` call.
  const size = { width: page.width, height: page.height };
  const place = placePanelOverPage(panel, size, size);
  if (place.width < 1 || place.height < 1) return null;
  const ink = await inkRaster(bytes, place);
  if (!ink) return null;
  const sheet = document.createElement("canvas");
  try {
    sheet.width = page.width;
    sheet.height = page.height;
    const ctx = sheet.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas for the composite");
    ctx.drawImage(page, 0, 0);
    // Whole pixels: a fractional offset smears a one-pixel stroke.
    ctx.drawImage(ink, Math.round(place.left), Math.round(place.top));
    return await createImageBitmap(sheet);
  } finally {
    sheet.width = 0;
    sheet.height = 0;
    ink.width = 0;
    ink.height = 0;
  }
}
