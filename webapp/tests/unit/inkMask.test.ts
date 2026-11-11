// Handwriting cut out of a rendered page: which pixels are ink, and where.

import { describe, it, expect } from "vitest";
import { inkAlpha, inkBounds } from "../../src/render/inkMask";

describe("the strokes alone", () => {
  it("drops the paper and a template's light lines, keeps black and dark grey ink", () => {
    expect(inkAlpha(0)).toBe(0); // white paper
    expect(inkAlpha(54)).toBe(0); // a light grey line
    expect(inkAlpha(98)).toBeGreaterThan(50); // the dark grey pen
    expect(inkAlpha(255)).toBe(255); // black
  });

  it("trims to the ink, or nothing when there is none", () => {
    const on = new Set(["3,1", "5,4"]);
    expect(inkBounds((x, y) => (on.has(`${x},${y}`) ? 255 : 0), 8, 6)).toEqual({ x: 3, y: 1, w: 3, h: 4 });
    expect(inkBounds(() => 0, 8, 6)).toBeNull();
  });
});
