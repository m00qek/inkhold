import { describe, it, expect } from "vitest";
import { fitPageInPanel, markExportSpace, placePanelOverPage } from "../../src/render/markGeometry";

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
