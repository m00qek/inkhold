import { describe, it, expect } from "vitest";
import {
  fitPageInPanel,
  markExportMatrix,
  markExportSpace,
  placePageRect,
  placePanelOverPage,
} from "../../src/render/markGeometry";
import { placeLink } from "../../src/render/pdfWire";

// Numbers measured on a real capture: an N6 panel (1404x1872) annotating A4.

const NOMAD = { width: 1404, height: 1872 };
const A4 = { width: 595.276, height: 841.89 };
const LETTER = { width: 612, height: 792 };

describe("fitPageInPanel", () => {
  it("fits A4 by HEIGHT, leaving a dead margin at each side", () => {
    const fit = fitPageInPanel(NOMAD, A4);
    // A4 is 0.707 against the panel's 0.750, so height binds.
    expect(fit.height).toBeCloseTo(1872, 1);
    expect(fit.top).toBeCloseTo(0, 6);
    expect(fit.width).toBeCloseTo(1323.6, 1);
    expect(fit.left).toBeCloseTo(40.2, 1);
  });

  it("fits US Letter by WIDTH, leaving the margin top and bottom instead", () => {
    // Letter is 0.773, wider than the panel, so width binds.
    const fit = fitPageInPanel(NOMAD, LETTER);
    expect(fit.width).toBeCloseTo(1404, 1);
    expect(fit.left).toBeCloseTo(0, 6);
    expect(fit.height).toBeCloseTo(1816.9, 1);
    expect(fit.top).toBeCloseTo(27.5, 1);
  });

  it("is the identity for a page the device itself exported", () => {
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
    expect(p.width).toBeCloseTo(457.2, 1);
    expect(p.height).toBeCloseTo(609.6, 1);
    expect(p.left).toBeCloseTo(-13.1, 1);
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
    const canvas = { width: 1000, height: 1414.7 };
    const p = placePanelOverPage(NOMAD, A4, canvas);
    const onCanvas = (panelX: number) => (p.left + (panelX / NOMAD.width) * p.width) / canvas.width;
    expect(onCanvas(843)).toBeCloseTo(0.607, 3);
    expect(onCanvas(1035)).toBeCloseTo(0.752, 3);
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
    // The filmstrip passes raster pixel dims instead of points; the fit is scale-
    // invariant, so that is exact.
    const canvas = { width: 85, height: 120 };
    const inPoints = placePanelOverPage(NOMAD, A4, canvas);
    // Not `toEqual`: the rescale leaves a 7e-15 crumb on a zero margin.
    const scaled = placePanelOverPage(
      NOMAD,
      { width: A4.width * 7.3, height: A4.height * 7.3 },
      canvas,
    );
    for (const k of ["width", "height", "left", "top"] as const) {
      expect(scaled[k]).toBeCloseTo(inPoints[k], 9);
    }
    // Rounded pixel dims cost at most a quarter pixel.
    const asPixels = placePanelOverPage(NOMAD, canvas, canvas);
    for (const k of ["width", "height", "left", "top"] as const) {
      expect(Math.abs(asPixels[k] - inPoints[k])).toBeLessThan(0.25);
    }
  });
});

// Export space: one rectangle, so the letterbox is removed rather than clipped.
describe("markExportSpace", () => {
  it("is the PAGE's rect at the PANEL's resolution, with the dead margin removed", () => {
    const s = markExportSpace(NOMAD, A4);
    // The page rect inside the panel: not the panel, not the page's points.
    expect(s.width).toBe(1324);
    expect(s.height).toBe(1872);
    expect(s.dx).toBe(-40);
    expect(s.dy).toBe(0);
    expect(A4.width * s.scale).toBeCloseTo(1323.6, 1);
    expect(A4.height * s.scale).toBeCloseTo(1872, 1);
  });

  it("shifts the ink UP for a width-limited page, not left", () => {
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
    // `drawImage` at a fractional offset resamples, blurring 1-px strokes.
    for (const page of [A4, LETTER, { width: 200, height: 300 }, { width: 1000, height: 1000 }]) {
      const s = markExportSpace(NOMAD, page);
      expect(Number.isInteger(s.dx)).toBe(true);
      expect(Number.isInteger(s.dy)).toBe(true);
      expect(Number.isInteger(s.width)).toBe(true);
      expect(Number.isInteger(s.height)).toBe(true);
    }
  });

  it("PUTS THE INK WHERE IT WAS WRITTEN — the measured page-2 annotation", () => {
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
    // The export image is the page rect already, so an offset would correct twice.
    const space = markExportSpace(NOMAD, A4);
    const m = markExportMatrix(space, A4);
    expect(m[1]).toBe(0);
    expect(m[2]).toBe(0);
    expect(m[4]).toBe(0);
    expect(m[5]).toBe(0);
    expect(m[0]).toBeCloseTo(0.4496, 4);
    expect(m[3]).toBeCloseTo(0.4497, 4);
  });

  it("lands the page's four corners on the page's four corners", () => {
    const space = markExportSpace(NOMAD, A4);
    const [a, , , d] = markExportMatrix(space, A4);
    expect(a * 0).toBeCloseTo(0, 6);
    expect(a * space.width).toBeCloseTo(A4.width, 6);
    expect(d * space.height).toBeCloseTo(A4.height, 6);
  });

  it("puts the ROUNDING into a 0.03% stretch of the ink, never into a shift", () => {
    // Inverted per axis, because the page fills a box rounded to whole pixels.
    const space = markExportSpace(NOMAD, A4);
    const [a, , , d] = markExportMatrix(space, A4);
    expect(a).not.toBe(d);
    expect(Math.abs(a / d - 1)).toBeLessThan(0.0005);
  });

  it("is the identity-shaped mapping for a page the device itself exported", () => {
    const panelPage = { width: 1404, height: 1872 };
    expect(markExportMatrix(markExportSpace(NOMAD, panelPage), panelPage)).toEqual([
      1, 0, 0, 1, 0, 0,
    ]);
  });

  it("answers a degenerate image with a ZERO matrix rather than an Infinity", () => {
    // A collapsed overlay draws nothing rather than send a non-finite number to wasm.
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
  it("scales a rect by the raster's own ratio and nothing else", () => {
    const box = placePageRect({ x: 10, y: 20, w: 30, h: 5 }, A4, { width: 1190.552, height: 1683.78 });
    expect(box.left).toBeCloseTo(20, 6);
    expect(box.top).toBeCloseTo(40, 6);
    expect(box.width).toBeCloseTo(60, 6);
    expect(box.height).toBeCloseTo(10, 6);
  });

  it("A ROTATED PAGE'S HIGHLIGHT LANDS WHERE THE INK LANDS", () => {
    // Ink and highlight mappings must agree on where the page is, including rotated
    // pages. Fixture: `probe.zig`'s `rotate90.pdf` (200x100 /Rotate 90, reported 100x200).
    const rotated = { width: 100, height: 200 };
    const canvas = { width: 400, height: 800 };
    const panel = placePanelOverPage(NOMAD, rotated, canvas);

    const fit = fitPageInPanel(NOMAD, rotated);
    const inkX = (pagePtX: number) =>
      panel.left + ((fit.left + (pagePtX / rotated.width) * fit.width) / NOMAD.width) * panel.width;
    const inkY = (pagePtY: number) =>
      panel.top + ((fit.top + (pagePtY / rotated.height) * fit.height) / NOMAD.height) * panel.height;

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

    const upright = placePageRect({ x: 10, y: 10, w: 60, h: 12 }, { width: 200, height: 100 }, { width: 800, height: 400 });
    const sideways = placePageRect({ x: 10, y: 10, w: 12, h: 60 }, rotated, { width: 400, height: 800 });
    expect(upright.width).toBeGreaterThan(upright.height);
    expect(sideways.height).toBeGreaterThan(sideways.width);
  });

  it("is the SAME function `placeLink` uses, so links and highlights cannot drift", () => {
    const rect = { x: 7.5, y: 11.25, w: 33, h: 9 };
    const pagePt = { width: 200, height: 100 };
    const canvas = { width: 617, height: 308.5 };
    const viaLink = placeLink({ ...rect, page: -1, uri: "https://a.invalid/" }, pagePt, canvas);
    const viaRect = placePageRect(rect, pagePt, canvas);
    expect(viaRect).toEqual(viaLink);
  });

  it("answers with a zero box for a degenerate page or canvas, never an Infinity", () => {
    // A non-finite style value would be a document-sized box; draw nothing.
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
