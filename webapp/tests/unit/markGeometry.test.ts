import { describe, it, expect } from "vitest";
import {
  fitPageInPanel,
  markExportMatrix,
  markExportSpace,
  placePageRect,
  placePanelOverPage,
} from "../../src/render/markGeometry";
import { placeLink } from "../../src/render/pdfWire";

// The numbers here are the ones measured against the real capture — an N6
// (1404x1872) annotating an A4 document (595.276 x 841.89 pt). Getting this
// wrong is the failure the whole feature was warned about: handwriting half an
// inch off the page is worse than no handwriting.

const NOMAD = { width: 1404, height: 1872 };
const A4 = { width: 595.276, height: 841.89 };
const LETTER = { width: 612, height: 792 };

describe("fitPageInPanel", () => {
  it("fits A4 by HEIGHT, leaving a dead margin at each side", () => {
    const fit = fitPageInPanel(NOMAD, A4);
    // A4 is 0.707 against the panel's 0.750, so height binds and the page fills
    // the panel top to bottom.
    expect(fit.height).toBeCloseTo(1872, 1);
    expect(fit.top).toBeCloseTo(0, 6);
    expect(fit.width).toBeCloseTo(1323.6, 1);
    expect(fit.left).toBeCloseTo(40.2, 1);
  });

  it("fits US Letter by WIDTH, leaving the margin top and bottom instead", () => {
    // Letter is 0.773 — WIDER than the panel — so the other axis binds. The
    // A4-shaped assumption would have put its ink 8% down the page.
    const fit = fitPageInPanel(NOMAD, LETTER);
    expect(fit.width).toBeCloseTo(1404, 1);
    expect(fit.left).toBeCloseTo(0, 6);
    expect(fit.height).toBeCloseTo(1816.9, 1);
    expect(fit.top).toBeCloseTo(27.5, 1);
  });

  it("is the identity for a page the device itself exported", () => {
    // A device-exported PDF is already the panel, so the mapping is a no-op —
    // which is exactly why such a pair proves nothing about the general case.
    const fit = fitPageInPanel(NOMAD, { width: 1404, height: 1872 });
    expect(fit).toEqual({ width: 1404, height: 1872, left: 0, top: 0 });
  });

  it("answers a degenerate page with nothing rather than a NaN", () => {
    for (const bad of [
      { width: 0, height: 800 },
      { width: 600, height: 0 },
      { width: -1, height: -1 },
    ]) {
      expect(fitPageInPanel(NOMAD, bad)).toEqual({ width: 0, height: 0, left: 0, top: 0 });
    }
  });
});

describe("placePanelOverPage", () => {
  it("draws the panel oversized and shifted, so its page-rect lands on the canvas", () => {
    const p = placePanelOverPage(NOMAD, A4, { width: 431, height: 609.6 });
    expect(p.width).toBeCloseTo(457.2, 1); // ~6% wider than the canvas
    expect(p.height).toBeCloseTo(609.6, 1);
    expect(p.left).toBeCloseTo(-13.1, 1); // the dead margin, pushed off-canvas
    expect(p.top).toBeCloseTo(0, 6);
  });

  it("scales with the canvas, so zooming needs no re-decode", () => {
    const small = placePanelOverPage(NOMAD, A4, { width: 431, height: 609.6 });
    const big = placePanelOverPage(NOMAD, A4, { width: 992, height: 1403 });
    const ratio = 992 / 431;
    expect(big.width / small.width).toBeCloseTo(ratio, 3);
    expect(big.left / small.left).toBeCloseTo(ratio, 3);
  });

  it("PUTS THE INK WHERE IT WAS WRITTEN — the measured page-2 annotation", () => {
    // The capture's page-2 ink spans x 843..1035 of the panel. Under this
    // placement it must land at 60.7%..75.2% across the PAGE, which is the empty
    // column beside the run of VETADO entries where it was actually written.
    const canvas = { width: 1000, height: 1414.7 };
    const p = placePanelOverPage(NOMAD, A4, canvas);
    const onCanvas = (panelX: number) => (p.left + (panelX / NOMAD.width) * p.width) / canvas.width;
    expect(onCanvas(843)).toBeCloseTo(0.607, 3);
    expect(onCanvas(1035)).toBeCloseTo(0.752, 3);
    // …and the page's own edges map to the canvas's, which is the invariant the
    // two numbers above are consequences of.
    expect(onCanvas(40.2)).toBeCloseTo(0, 3);
    expect(onCanvas(1363.8)).toBeCloseTo(1, 3);
  });

  it("maps the page edges exactly for a WIDTH-limited page too", () => {
    const canvas = { width: 800, height: 1035.3 };
    const p = placePanelOverPage(NOMAD, LETTER, canvas);
    const yOn = (panelY: number) => (p.top + (panelY / NOMAD.height) * p.height) / canvas.height;
    expect(yOn(27.5)).toBeCloseTo(0, 2);
    expect(yOn(1844.5)).toBeCloseTo(1, 2);
  });

  it("READS THE PAGE'S ASPECT, NOT ITS UNITS — points and pixels place alike", () => {
    // The licence the filmstrip takes. A page-index thumbnail composites the ink
    // onto a raster it may have taken straight out of the cache, where the page's
    // size in POINTS is not in hand and asking the decoder for it is a worker
    // round trip per row. It passes the raster's own pixel dims instead.
    //
    // That is exact rather than approximate, and this is why: the fit divides the
    // panel by the page on both axes and keeps the smaller, so multiplying the
    // page by any factor divides both quotients by that factor and leaves the
    // winner — and the resulting rectangle — untouched. A4 at 120px is the same
    // placement as A4 in points.
    const canvas = { width: 85, height: 120 };
    const inPoints = placePanelOverPage(NOMAD, A4, canvas);
    // Equal to the last ULP for an exact rescale — the claim itself, with nothing
    // else in the way. (Not `toEqual`: 7.3x and back leaves a 7e-15 crumb on the
    // margin that is zero, which is float arithmetic and not a placement.)
    const scaled = placePanelOverPage(
      NOMAD,
      { width: A4.width * 7.3, height: A4.height * 7.3 },
      canvas,
    );
    for (const k of ["width", "height", "left", "top"] as const) {
      expect(scaled[k]).toBeCloseTo(inPoints[k], 9);
    }
    // And ROUNDED pixel dims — what a raster really carries, A4 at 120px tall
    // being 84.85 rounded to 85 — cost a quarter of a pixel across the whole
    // placement. That is the entire error budget this shortcut spends.
    const asPixels = placePanelOverPage(NOMAD, canvas, canvas);
    for (const k of ["width", "height", "left", "top"] as const) {
      expect(Math.abs(asPixels[k] - inPoints[k])).toBeLessThan(0.25);
    }
  });
});

// The EXPORT space. On screen the page and the ink stay two elements and the
// stage clips the overhang; an export is ONE rectangle, so the letterbox has to
// be removed rather than hidden. These are the same measured numbers as above,
// read as "what size is the file, and where does the ink land in it".
describe("markExportSpace", () => {
  it("is the PAGE's rect at the PANEL's resolution, with the dead margin removed", () => {
    const s = markExportSpace(NOMAD, A4);
    // 1323.6 x 1872 — the page-rect inside the panel, rounded to whole pixels.
    // NOT the panel (1404 wide: 6% of that is device margin, not document) and
    // not the page's own 595x842 points (a quarter of the ink's resolution).
    expect(s.width).toBe(1324);
    expect(s.height).toBe(1872);
    // The ink shifts LEFT by the margin it was letterboxed by.
    expect(s.dx).toBe(-40);
    expect(s.dy).toBe(0);
    // …and rendering the page at `scale` reproduces exactly that rect, which is
    // what lets the ink be copied in rather than resampled.
    expect(A4.width * s.scale).toBeCloseTo(1323.6, 1);
    expect(A4.height * s.scale).toBeCloseTo(1872, 1);
  });

  it("shifts the ink UP for a width-limited page, not left", () => {
    // Letter binds on width, so the margin is top and bottom. An A4-shaped
    // assumption here would drag every stroke 28 px sideways for no reason and
    // leave it 28 px low.
    const s = markExportSpace(NOMAD, LETTER);
    expect(s.width).toBe(1404);
    expect(s.height).toBe(1817);
    expect(s.dx).toBe(0);
    expect(s.dy).toBe(-28);
  });

  it("is the identity for a page the device itself exported", () => {
    expect(markExportSpace(NOMAD, { width: 1404, height: 1872 })).toEqual({
      width: 1404,
      height: 1872,
      scale: 1,
      dx: 0,
      dy: 0,
    });
  });

  it("keeps the ink's translation WHOLE-pixel, whatever the page", () => {
    // `drawImage` at a fractional offset RESAMPLES, which is the one thing
    // composing at the ink's own resolution was for. A4 asks for 40.19 px;
    // half a pixel of blur on a 1-px pen stroke is visible where 0.19 px of
    // position is not.
    for (const page of [A4, LETTER, { width: 200, height: 300 }, { width: 1000, height: 1000 }]) {
      const s = markExportSpace(NOMAD, page);
      expect(Number.isInteger(s.dx)).toBe(true);
      expect(Number.isInteger(s.dy)).toBe(true);
      expect(Number.isInteger(s.width)).toBe(true);
      expect(Number.isInteger(s.height)).toBe(true);
    }
  });

  it("PUTS THE INK WHERE IT WAS WRITTEN — the measured page-2 annotation", () => {
    // The same capture as `placePanelOverPage`'s test, asked of the export: the
    // ink spanning panel x 843..1035 must land at 60.7%..75.2% across the
    // exported image, and the page's own edges at 0 and 1.
    const s = markExportSpace(NOMAD, A4);
    const across = (panelX: number) => (panelX + s.dx) / s.width;
    expect(across(843)).toBeCloseTo(0.607, 2);
    expect(across(1035)).toBeCloseTo(0.752, 2);
    expect(across(40.2)).toBeCloseTo(0, 2);
    expect(across(1363.8)).toBeCloseTo(1, 2);
  });

  it("answers a degenerate page with nothing rather than a NaN", () => {
    for (const bad of [
      { width: 0, height: 800 },
      { width: 600, height: 0 },
      { width: -1, height: -1 },
    ]) {
      expect(markExportSpace(NOMAD, bad)).toEqual({ width: 0, height: 0, scale: 0, dx: 0, dy: 0 });
    }
  });
});

describe("markExportMatrix", () => {
  it("takes the ink's own image back to the page's points, with no offset", () => {
    // The export image IS the page rect — `markExportSpace` already took the
    // panel's letterbox out — so the mapping is a pure scale. An offset here
    // would correct the same margin twice and slide the handwriting off the
    // page, which is the failure this whole module exists to prevent.
    const space = markExportSpace(NOMAD, A4);
    const m = markExportMatrix(space, A4);
    expect(m[1]).toBe(0); // no shear
    expect(m[2]).toBe(0);
    expect(m[4]).toBe(0); // no translation
    expect(m[5]).toBe(0);
    // 595.276 pt across 1324 px, 841.89 pt down 1872.
    expect(m[0]).toBeCloseTo(0.4496, 4);
    expect(m[3]).toBeCloseTo(0.4497, 4);
  });

  it("lands the page's four corners on the page's four corners", () => {
    // The claim stated where it can be read: apply the matrix to the image's
    // extremes and they must be the page's own, to within a rounding of a pixel.
    const space = markExportSpace(NOMAD, A4);
    const [a, , , d] = markExportMatrix(space, A4);
    expect(a * 0).toBeCloseTo(0, 6);
    expect(a * space.width).toBeCloseTo(A4.width, 6);
    expect(d * space.height).toBeCloseTo(A4.height, 6);
  });

  it("puts the ROUNDING into a 0.03% stretch of the ink, never into a shift", () => {
    // `markExportSpace` rounds the image to whole pixels and the composition
    // draws the page to FILL that rounded box, so inverting it PER AXIS
    // reproduces the flattened PNG exactly. A single shared scale would leave
    // the page's bottom edge up to a pixel short of the image's, and the ink
    // near it correspondingly out of place.
    const space = markExportSpace(NOMAD, A4);
    const [a, , , d] = markExportMatrix(space, A4);
    expect(a).not.toBe(d);
    expect(Math.abs(a / d - 1)).toBeLessThan(0.0005);
  });

  it("is the identity-shaped mapping for a page the device itself exported", () => {
    // A device-exported PDF whose points happen to be the panel's pixels: one
    // point per pixel, and nothing to correct.
    const panelPage = { width: 1404, height: 1872 };
    expect(markExportMatrix(markExportSpace(NOMAD, panelPage), panelPage)).toEqual([
      1, 0, 0, 1, 0, 0,
    ]);
  });

  it("answers a degenerate image with a ZERO matrix rather than an Infinity", () => {
    // An overlay that collapses to a point draws nothing, which is a far better
    // failure than a non-finite number crossing into wasm.
    for (const bad of [
      { width: 0, height: 3 },
      { width: 4, height: 0 },
      { width: -1, height: -1 },
    ]) {
      expect(markExportMatrix(bad, A4)).toEqual([0, 0, 0, 0, 0, 0]);
    }
  });
});

describe("placePageRect — the one page→screen mapping", () => {
  // The page-in-points to canvas-in-CSS-pixels transform, shared by the
  // document's own links (`placeLink`) and find's highlights
  // (`pages/pdfHighlightLayer.ts`). It lives here rather than beside either
  // because there are two of them and one page must have one mapping.

  it("scales a rect by the raster's own ratio and nothing else", () => {
    // No letterbox: the canvas IS the page rendered whole, unlike the panel.
    const box = placePageRect({ x: 10, y: 20, w: 30, h: 5 }, A4, { width: 1190.552, height: 1683.78 });
    expect(box.left).toBeCloseTo(20, 6);
    expect(box.top).toBeCloseTo(40, 6);
    expect(box.width).toBeCloseTo(60, 6);
    expect(box.height).toBeCloseTo(10, 6);
  });

  it("A ROTATED PAGE'S HIGHLIGHT LANDS WHERE THE INK LANDS", () => {
    // §9's second test, and the reason `placeLink`'s two lines moved into this
    // file. The `.mark` overlay places the DEVICE PANEL over the page through
    // `placePanelOverPage`; a highlight places a rect already in the page's own
    // points. They are different jobs, and they have to agree to the pixel about
    // where the PAGE is, or the mark and the handwriting it sits under drift
    // apart — visibly, and only on documents that are rotated.
    //
    // The fixture is `probe.zig`'s `rotate90.pdf`: a 200x100 MediaBox with
    // /Rotate 90, which the decoder reports as 100x200 because `fz_bound_page`
    // hands over the TRANSFORMED box. Both mappings therefore take the same
    // rotated `pagePt`, which is what makes agreement structural rather than
    // arithmetic luck.
    const rotated = { width: 100, height: 200 };
    const canvas = { width: 400, height: 800 }; // the page at 4x
    const panel = placePanelOverPage(NOMAD, rotated, canvas);

    // Where the page's four corners land, according to the INK's mapping: the
    // panel's inner page-rect, expressed on the canvas.
    const fit = fitPageInPanel(NOMAD, rotated);
    const inkX = (pagePtX: number) =>
      panel.left + ((fit.left + (pagePtX / rotated.width) * fit.width) / NOMAD.width) * panel.width;
    const inkY = (pagePtY: number) =>
      panel.top + ((fit.top + (pagePtY / rotated.height) * fit.height) / NOMAD.height) * panel.height;

    // …and according to the HIGHLIGHT's. Same page, same canvas, same answer.
    for (const [x, y] of [
      [0, 0],
      [50, 100],
      [100, 200],
      [12.5, 137.5],
    ]) {
      const box = placePageRect({ x, y, w: 1, h: 1 }, rotated, canvas);
      expect(box.left).toBeCloseTo(inkX(x), 4);
      expect(box.top).toBeCloseTo(inkY(y), 4);
    }

    // And the box is TALL where the unrotated one is wide — the shape a word set
    // horizontally takes on a /Rotate 90 page, which is what a mapping that
    // ignored the rotation would get wrong while still producing a box.
    const upright = placePageRect({ x: 10, y: 10, w: 60, h: 12 }, { width: 200, height: 100 }, { width: 800, height: 400 });
    const sideways = placePageRect({ x: 10, y: 10, w: 12, h: 60 }, rotated, { width: 400, height: 800 });
    expect(upright.width).toBeGreaterThan(upright.height);
    expect(sideways.height).toBeGreaterThan(sideways.width);
  });

  it("is the SAME function `placeLink` uses, so links and highlights cannot drift", () => {
    // Stated as an assertion because it is the whole reason the arithmetic
    // moved: a second copy of `canvas.width / pagePt.width` beside the highlight
    // would pass every test either module has and disagree the first time one of
    // them was tuned.
    const rect = { x: 7.5, y: 11.25, w: 33, h: 9 };
    const pagePt = { width: 200, height: 100 };
    const canvas = { width: 617, height: 308.5 }; // a canvas MuPDF rounded
    const viaLink = placeLink({ ...rect, page: -1, uri: "https://a.invalid/" }, pagePt, canvas);
    const viaRect = placePageRect(rect, pagePt, canvas);
    expect(viaRect).toEqual(viaLink);
  });

  it("answers with a zero box for a degenerate page or canvas, never an Infinity", () => {
    // A non-finite number reaching a style property is a box the size of the
    // document; nothing drawn is the better failure, and it is the posture
    // `markExportMatrix` already takes.
    const rect = { x: 1, y: 2, w: 3, h: 4 };
    expect(placePageRect(rect, { width: 0, height: 100 }, { width: 10, height: 10 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
    expect(placePageRect(rect, { width: 100, height: 100 }, { width: 0, height: 10 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});
