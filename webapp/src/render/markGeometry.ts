// Where a `.mark`'s ink (device panel pixels, e.g. 1404x1872) goes on the PDF
// page (points) it annotates. The device fits the page into the panel
// aspect-preserving and centred; a mark's `HIGHLIGHTINFO` records each highlight
// in both spaces, which confirms it (`note-format.md` §13.3, §13.4).

export interface Size {
  width: number;
  height: number;
}

/** Where to draw the whole panel so its page-rect lands on the canvas. */
export interface Placement {
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * The page's aspect-preserving, centred fit inside the panel (within 0.67px of
 * `HIGHLIGHTINFO` pairs; a stretch is 34.5px off). The device does not clip the
 * pen to this rect.
 */
export function fitPageInPanel(panel: Size, pagePt: Size): Placement {
  if (pagePt.width <= 0 || pagePt.height <= 0 || panel.width <= 0 || panel.height <= 0) {
    return { width: 0, height: 0, left: 0, top: 0 };
  }
  const scale = Math.min(panel.width / pagePt.width, panel.height / pagePt.height);
  const width = pagePt.width * scale;
  const height = pagePt.height * scale;
  return { width, height, left: (panel.width - width) / 2, top: (panel.height - height) / 2 };
}

/**
 * Place the mark's whole panel over a rendered page: drawn oversized and shifted
 * so its page-rect lands on the canvas, the margins clipped. One element, no
 * re-raster on zoom.
 */
export function placePanelOverPage(panel: Size, pagePt: Size, canvas: Size): Placement {
  const fit = fitPageInPanel(panel, pagePt);
  if (fit.width <= 0 || canvas.width <= 0) return { width: 0, height: 0, left: 0, top: 0 };
  // Panel to canvas scale from width alone, so a rounded canvas can't skew it.
  const k = canvas.width / fit.width;
  return {
    width: panel.width * k,
    height: panel.height * k,
    left: -fit.left * k,
    top: -fit.top * k,
  };
}

/** A rect in page display space: top-left origin, y down, points. */
export interface PageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The one page→screen mapping, shared by links, find highlights and (via the
 * same canvas) `.mark` ink, so they cannot drift apart on a rotated page. The
 * rect is already in page space (`fz_bound_page`'s transformed box), so no
 * letterbox fit; scale from width alone. Degenerate input gives a zero box.
 */
export function placePageRect(rect: PageRect, pagePt: Size, canvas: Size): Placement {
  if (pagePt.width <= 0 || canvas.width <= 0) return { width: 0, height: 0, left: 0, top: 0 };
  const k = canvas.width / pagePt.width;
  return { left: rect.x * k, top: rect.y * k, width: rect.w * k, height: rect.h * k };
}

export interface ExportSpace {
  width: number;
  height: number;
  /** PDF points to export pixels. */
  scale: number;
  /** Ink canvas translation, whole pixels. */
  dx: number;
  dy: number;
}

// `markExportSpace` (below) composes page and ink in the page's space at the
// ink's resolution: the ink only translates (never resamples) and the vector PDF
// absorbs the scale. Offsets round to whole pixels to avoid blur; ink outside
// the page rect is cropped, as `.pdf-stage` does on screen.
/**
 * A 2x3 affine `[a, b, c, d, e, f]` (x' = a·x + c·y + e, y' = b·x + d·y + f) in
 * display space (top-left, y down), not PDF user space; rotation and crop live
 * inside the decoder's display transform.
 */
export type DisplayMatrix = readonly [number, number, number, number, number, number];

/**
 * Where an exported ink image goes on its page. No translation: `markExportSpace`
 * already removed the letterbox margin, and a second offset would double it.
 * Per-axis scale, inverting the rounded export box exactly. Degenerate input
 * gives the zero matrix.
 */
export function markExportMatrix(image: Size, pagePt: Size): DisplayMatrix {
  if (image.width <= 0 || image.height <= 0) return [0, 0, 0, 0, 0, 0];
  return [pagePt.width / image.width, 0, 0, pagePt.height / image.height, 0, 0];
}

export function markExportSpace(panel: Size, pagePt: Size): ExportSpace {
  const fit = fitPageInPanel(panel, pagePt);
  if (fit.width <= 0 || fit.height <= 0) return { width: 0, height: 0, scale: 0, dx: 0, dy: 0 };
  return {
    width: Math.round(fit.width),
    height: Math.round(fit.height),
    // Unrounded fit, width alone.
    scale: fit.width / pagePt.width,
    // `0 - x`, not `-x`: avoids a `-0` that fails `Object.is` in assertions.

    dx: 0 - Math.round(fit.left),
    dy: 0 - Math.round(fit.top),
  };
}
