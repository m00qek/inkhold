import { describe, it, expect } from "vitest";
import { clampRasterScale, fitScaleIn, MAX_RASTER_PIXELS } from "../../src/pages/pdfPageRenderer";

// The raster path's ARITHMETIC — the fit and the area ceiling. Both are pure,
// both are what decides how many pixels the wasm heap is asked for, and both are
// invisible on screen when they are slightly wrong: a page fitted to a box 320px
// wider than it has does not overflow, it just runs under the panel.

describe("the fit", () => {
  const box = { w: 800, h: 600 };

  it("takes the BINDING term — the page has to fit both ways", () => {
    // Portrait A4-ish: height binds.
    expect(fitScaleIn(595, 842, box, false)).toBeCloseTo(600 / 842, 12);
    // Landscape: width binds.
    expect(fitScaleIn(842, 595, box, false)).toBeCloseTo(800 / 842, 12);
  });

  it("drops the height term for `Fit ⇔` (fit width), and runs off the bottom", () => {
    expect(fitScaleIn(595, 842, box, true)).toBeCloseTo(800 / 595, 12);
    expect(fitScaleIn(595, 842, box, true)).toBeGreaterThan(fitScaleIn(595, 842, box, false));
  });

  it("is ASCENDING on a portrait page, which is what the stepper's arrows promise", () => {
    // `Fit ⇕` -> `Fit ⇔` must be a step UP or the ladder lies about direction.
    expect(fitScaleIn(595, 842, box, true)).toBeGreaterThanOrEqual(
      fitScaleIn(595, 842, box, false),
    );
  });

  it("COINCIDES where width was already binding — the page telling the truth", () => {
    expect(fitScaleIn(842, 595, box, true)).toBeCloseTo(fitScaleIn(842, 595, box, false), 12);
  });

  it("answers 1 for a page that will not measure, rather than a division by zero", () => {
    expect(fitScaleIn(0, 842, box, false)).toBe(1);
    expect(fitScaleIn(595, 0, box, false)).toBe(1);
    expect(fitScaleIn(-1, -1, box, true)).toBe(1);
  });

  it("scales with the box, which is why a panel toggle has to repaint", () => {
    const wide = fitScaleIn(595, 842, { w: 800, h: 600 }, true);
    const narrow = fitScaleIn(595, 842, { w: 480, h: 600 }, true);
    expect(narrow).toBeLessThan(wide);
  });
});

describe("the area clamp", () => {
  it("leaves a raster under the ceiling exactly alone", () => {
    expect(clampRasterScale(595, 842, 2)).toBe(2);
  });

  it("cuts one over it back to the ceiling, not to a fixed scale", () => {
    // A panel-sized page at 300% on a 2x screen: 1404 x 1872 at 6 is ~95 Mpx.
    const cut = clampRasterScale(1404, 1872, 6);
    expect(cut).toBeLessThan(6);
    expect(1404 * cut * (1872 * cut)).toBeCloseTo(MAX_RASTER_PIXELS, 3);
  });

  it("clamps by AREA, so a small page at the same zoom is NOT cut", () => {
    // The whole reason it is not a scale ceiling: 200pt fixtures and 1404pt
    // panel exports are a 7x spread and the pixel count is what costs memory.
    expect(clampRasterScale(200, 200, 6)).toBe(6);
    expect(clampRasterScale(1404, 1872, 6)).toBeLessThan(6);
  });

  it("is monotonic — asking for more never gets you less", () => {
    const a = clampRasterScale(1404, 1872, 4);
    const b = clampRasterScale(1404, 1872, 6);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
