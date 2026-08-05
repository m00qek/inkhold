// Where a `.mark`'s ink goes on the PDF page it annotates.
//
// A `.mark` is written in DEVICE PANEL PIXELS — 1404x1872 on a Nomad — and its
// PAGE BLOCKS carry no page geometry: the container records only an equipment
// code, and the dimensions come from a table keyed on that (`note-format.md`
// §9.1, §13.3). The PDF page is in points, with its own aspect. So the two do
// not share a coordinate space and one has to be reconstructed.
//
// THE DEVICE FITS THE PAGE TO THE PANEL, PRESERVING ASPECT, CENTRED. Measured
// against a real capture: an N6 annotating a 77-page A4 document, composited
// back onto the rendered pages, lands its handwriting in the whitespace it was
// written in on all three annotated pages.
//
// A LATER CAPTURE FOUND THE DEVICE STATES THIS ITSELF, which is worth knowing
// before anyone re-derives it: a mark's `HIGHLIGHTINFO` block records every PDF
// text highlight in BOTH spaces — `mupdfRectList` in points and `rnRectList` in
// panel pixels for the same rectangle. One highlight anywhere on a page yields
// that page's exact transform with no fitting against ink at all, which is the
// cheapest calibration available for a device or page size we have never seen.
// This function agrees with it to 0.67px on A4/N6 (`note-format.md` §13.4).
//
// No DOM, no canvas, no wasm — just the arithmetic, so it can be tested at the
// numbers rather than by looking at a screenshot.

/** A rectangle in some pixel space. */
export interface Size {
  width: number;
  height: number;
}

/** Where to draw the WHOLE panel so its page-rect lands on the canvas. */
export interface Placement {
  /** Size to draw the full panel at, in canvas pixels. */
  width: number;
  height: number;
  /** Offset of the panel's origin from the canvas's, in canvas pixels. */
  left: number;
  top: number;
}

/**
 * Where the page sits INSIDE the panel: the aspect-preserving fit, centred.
 *
 * Exported because it is the claim worth stating on its own — everything below
 * is a consequence of it.
 *
 * BOTH HALVES ARE NOW CONFIRMED, and the centring came from an unexpected
 * direction. It was marked `I` at first: no ink in the original corpus went near
 * a side margin, so the captures could not tell centred-letterbox from a plain
 * stretch (for A4 the two differ by at most 3mm, and agree exactly in `y`). The
 * answer turned out to be written in the file — a `.mark`'s `HIGHLIGHTINFO`
 * records each PDF text highlight TWICE, once in PDF points and once in panel
 * pixels, which is the device stating its own mapping. Fitted over 14 paired
 * samples, this function is within 0.67px and a stretch is out by 34.5px
 * (`note-format.md` §13.3, §13.4).
 *
 * The device does NOT clip the pen to the page: ink exists outside this
 * rectangle, on both sides. Whoever composites has to choose whether to keep it.
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
 * Place the mark's panel over a rendered page.
 *
 * The canvas IS the page, and the page is only PART of the panel — so the panel
 * is drawn OVERSIZED and shifted up-left, such that its inner page-rect lands
 * exactly on the canvas. For A4 on a Nomad that is ~6% wider than the canvas and
 * offset left by ~3% of it; the dead margins fall outside and are clipped.
 *
 * Returning the whole panel's placement rather than cropping the ink is what
 * keeps this reversible and cheap: the caller positions ONE element, and nothing
 * has to re-decode or re-raster when the page is zoomed.
 */
export function placePanelOverPage(panel: Size, pagePt: Size, canvas: Size): Placement {
  const fit = fitPageInPanel(panel, pagePt);
  if (fit.width <= 0 || canvas.width <= 0) return { width: 0, height: 0, left: 0, top: 0 };
  // Panel pixels -> canvas pixels. Derived from WIDTH alone: the fit preserves
  // aspect, so the height ratio is the same number, and taking it from one axis
  // means a canvas that is a rounded pixel off cannot skew the overlay.
  const k = canvas.width / fit.width;
  return {
    width: panel.width * k,
    height: panel.height * k,
    left: -fit.left * k,
    top: -fit.top * k,
  };
}

/** The one coordinate space a page and the ink on it can be exported in. */
export interface ExportSpace {
  /** The export image, in whole pixels. */
  width: number;
  height: number;
  /** Render the PDF page at this scale (PDF points -> export pixels). */
  scale: number;
  /** Translate each ink canvas by this when drawing it in. Whole pixels. */
  dx: number;
  dy: number;
}

/**
 * Where to compose a page and its `.mark` into ONE image.
 *
 * The screen gets away with keeping the two apart — {@link placePanelOverPage}
 * puts a whole oversized panel over the canvas and lets `.pdf-stage` clip the
 * dead margins. An export cannot: a PNG or an ORA is one rectangle, so the
 * margins have to go and both halves have to land in the same grid.
 *
 * THE PAGE'S SPACE, AT THE INK'S RESOLUTION. Two spaces were available and only
 * one of them is free:
 *
 *  - the PANEL's (1404x1872), which would ship the device's dead side margins as
 *    part of every export and make an A4 page 6% narrower than it is;
 *  - the PAGE's, sized to the panel's own pixels — `fit.width x fit.height`,
 *    ~1324x1872 for A4 on an N6. The ink then moves by a pure TRANSLATION and is
 *    never resampled, and the PDF (a vector source that re-rasters at any scale
 *    for free) absorbs the whole of the mismatch.
 *
 * So `scale` is the fit's own scale — the number that makes the rendered page
 * exactly as wide as the page-rect inside the panel — and `dx`/`dy` un-shift the
 * ink by the letterbox margin.
 *
 * `dx`/`dy` are ROUNDED TO WHOLE PIXELS on purpose. `drawImage` at a fractional
 * offset resamples, which is precisely what composing in the ink's own
 * resolution was meant to avoid; A4-on-an-N6 asks for 40.19 px, and half a pixel
 * of blur on a 1-px pen stroke is visible where 0.19 px of position is not.
 *
 * `width`/`height` are rounded for the same reason a canvas cannot be 1323.6 px
 * wide. The caller draws the page bitmap at those exact dimensions, so a
 * rasteriser that rounds the other way is a sub-pixel rescale of the DOCUMENT
 * and never a shear.
 *
 * THIS CROPS INK, and that is now a measured fact rather than a theoretical one.
 * The device does not clip the pen to the page: in the third capture
 * (`note-format.md`, "What the corpus is") page 16's ink spans the whole panel,
 * 0..1403.8, with 1,375 contour vertices left of the page rect and 2,557 right
 * of it. Everything outside the rect is dropped here.
 *
 * That is the defensible default — an export of "this page" that included the
 * margins would not be the page — and the viewer agrees with it, since
 * `.pdf-stage` clips the same overhang on screen. But it IS a silent loss of
 * something the user drew, and if it ever needs to change, this is the function
 * that decides it.
 */
export function markExportSpace(panel: Size, pagePt: Size): ExportSpace {
  const fit = fitPageInPanel(panel, pagePt);
  if (fit.width <= 0 || fit.height <= 0) return { width: 0, height: 0, scale: 0, dx: 0, dy: 0 };
  return {
    width: Math.round(fit.width),
    height: Math.round(fit.height),
    // From the UNROUNDED fit, and from width alone — the same reasoning as
    // `placePanelOverPage`'s `k`: one axis cannot skew what the other does.
    scale: fit.width / pagePt.width,
    // `0 - x` rather than `-x`: a page that fills its axis has no margin, and
    // `-Math.round(0)` is NEGATIVE zero — indistinguishable in arithmetic, but
    // it fails `Object.is` and so leaks into every equality assertion downstream
    // as a difference that is not one.
    dx: 0 - Math.round(fit.left),
    dy: 0 - Math.round(fit.top),
  };
}
