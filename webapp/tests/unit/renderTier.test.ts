import { describe, it, expect, afterEach } from "vitest";
import { TILE_W, TILE_LEEWAY, densityBucket, thumbTargetWidth } from "../../src/render/types";
import { downscalePlan } from "../../src/render/thumbnails";

// The pristine raster tier's arithmetic:
// density buckets, the width-normalized target, and the pure downscale plan
// every producer follows — never-upscale and the resample-quality selection.

afterEach(() => {
  delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
});

describe("densityBucket", () => {
  it("is clamp(ceil(dpr), 1, 3)", () => {
    expect(densityBucket(1)).toBe(1);
    expect(densityBucket(1.25)).toBe(2); // fractional-DPR laptop → round UP
    expect(densityBucket(1.5)).toBe(2);
    expect(densityBucket(2)).toBe(2);
    expect(densityBucket(2.5)).toBe(3);
    expect(densityBucket(3)).toBe(3);
    expect(densityBucket(4)).toBe(3); // clamped — bucket 3 is the ceiling
    expect(densityBucket(0.5)).toBe(1); // sub-1 zoom-out still gets bucket 1
  });

  it("reads the LIVE devicePixelRatio by default, per call", () => {
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1.25;
    expect(densityBucket()).toBe(2);
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 3.2;
    expect(densityBucket()).toBe(3);
  });

  it("degrades to bucket 1 when DPR is missing or invalid", () => {
    expect(densityBucket()).toBe(1); // Node: no devicePixelRatio at all
    expect(densityBucket(Number.NaN)).toBe(1);
    expect(densityBucket(0)).toBe(1);
    expect(densityBucket(-2)).toBe(1);
  });
});

describe("thumbTargetWidth", () => {
  it("is TILE_W × bucket × leeway, rounded — the bucket table", () => {
    expect(thumbTargetWidth(1)).toBe(230); // 184 × 1 × 1.25 = 230
    expect(thumbTargetWidth(2)).toBe(460); // 184 × 2 × 1.25 = 460
    expect(thumbTargetWidth(3)).toBe(690); // 184 × 3 × 1.25 = 690
    expect(thumbTargetWidth(1)).toBe(Math.round(TILE_W * 1 * TILE_LEEWAY));
  });

  it("pins the CSS pairing: TILE_W must match the --tile-w-icon token", () => {
    // If this fails, render/types.ts and the styles' `--tile-w-icon` token have
    // drifted — the tier would raster for a column width that doesn't exist.
    expect(TILE_W).toBe(184);
    expect(TILE_LEEWAY).toBe(1.25);
  });

  it("defaults its bucket from the live DPR", () => {
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    expect(thumbTargetWidth()).toBe(460);
  });
});

describe("downscalePlan", () => {
  it("NEVER upscales — a 600-wide source stays 600 even at bucket 3", () => {
    // The .spd embedded thumb (~600 wide) cannot honestly fill bucket 3's 690:
    // it must be stored at its own size, not inflated.
    const plan = downscalePlan(600, 800, thumbTargetWidth(3));
    expect(plan).toEqual({ w: 600, h: 800, method: "none" });
  });

  it("keeps an exact-fit source untouched", () => {
    expect(downscalePlan(230, 200, 230)).toEqual({ w: 230, h: 200, method: "none" });
  });

  it("uses plain drawImage for mild (≤2×) reductions", () => {
    const plan = downscalePlan(800, 500, 460); // 1.74× — the cheap side
    expect(plan.method).toBe("direct");
    expect(plan.w).toBe(460);
    expect(plan.h).toBe(Math.round((500 * 460) / 800));
  });

  it("selects the high-quality resample for >2× reductions", () => {
    // A 4000-wide photo down to a 460 tile is an 8.7× reduction — bilinear
    // drawImage skips source pixels there; the plan demands the high path.
    const plan = downscalePlan(4000, 3000, 460);
    expect(plan.method).toBe("high");
    expect(plan.w).toBe(460);
    expect(plan.h).toBe(Math.round((3000 * 460) / 4000));
  });

  it("sits exactly on the 2× boundary with drawImage (the cheap side)", () => {
    expect(downscalePlan(1226, 900, 613).method).toBe("direct"); // 2.0× exactly
    expect(downscalePlan(1227, 900, 613).method).toBe("high"); // just past it
  });

  it("preserves the source aspect", () => {
    const plan = downscalePlan(1872, 1404, 306);
    expect(plan.h / plan.w).toBeCloseTo(1404 / 1872, 2);
  });
});
