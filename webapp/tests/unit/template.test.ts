import { describe, it, expect, vi } from "vitest";
import { templatePlacement, createTemplateProvider } from "../../src/render/template";

// The image-template hash is now extracted Zig-side (page_payload.zig's
// `backgroundImageHash`, exercised by its own unit tests) and read out of wasm
// via `note_decode.zig`'s `template_hash_*` exports — the browser no longer
// parses the page payload, so there is nothing to unit-test here for that.

describe("templatePlacement (Ratta's four size cases: contain, never upscale, centered)", () => {
  const pageW = 1404;
  const pageH = 1872;

  it("both dims <= page: original size, centered, blank margins (scale 1)", () => {
    const p = templatePlacement(pageW, pageH, 700, 900);
    expect(p.w).toBe(700);
    expect(p.h).toBe(900);
    expect(p.x).toBeCloseTo((1404 - 700) / 2);
    expect(p.y).toBeCloseTo((1872 - 900) / 2);
  });

  it("narrow + tall: height fills the page, blank left/right", () => {
    const p = templatePlacement(pageW, pageH, 500, 3744); // 2x page height
    expect(p.h).toBeCloseTo(pageH);
    expect(p.w).toBeCloseTo(250); // 500 * (1872/3744)
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeCloseTo((1404 - 250) / 2);
  });

  it("wide + short: width fills the page, blank top/bottom", () => {
    const p = templatePlacement(pageW, pageH, 2808, 500); // 2x page width
    expect(p.w).toBeCloseTo(pageW);
    expect(p.h).toBeCloseTo(250); // 500 * (1404/2808)
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo((1872 - 250) / 2);
  });

  it("oversized non-3:4: contained (letterboxed), never upscaled past a dim", () => {
    const p = templatePlacement(pageW, pageH, 2000, 2000); // square, bigger than page
    // scale = min(1, 1404/2000, 1872/2000) = 0.702 -> both dims 1404
    expect(p.w).toBeCloseTo(1404);
    expect(p.h).toBeCloseTo(1404);
    expect(p.x).toBeCloseTo(0); // width fills
    expect(p.y).toBeCloseTo((1872 - 1404) / 2);
    // and never exceeds either page dim
    expect(p.w).toBeLessThanOrEqual(pageW);
    expect(p.h).toBeLessThanOrEqual(pageH);
  });

  it("an exact 3:4 oversize covers the page perfectly (no letterbox)", () => {
    const p = templatePlacement(pageW, pageH, 2808, 3744); // exactly 2x the page
    expect(p.w).toBeCloseTo(pageW);
    expect(p.h).toBeCloseTo(pageH);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
  });
});

describe("createTemplateProvider (fetch + decode once per hash)", () => {
  function fakeBitmap(id: number): ImageBitmap {
    return { width: id, height: id, close() {} } as unknown as ImageBitmap;
  }

  it("fetches and decodes each distinct hash exactly once, across notes and orders", async () => {
    const getTemplate = vi.fn(async (_id: string, hash: string) => new Blob([hash]));
    let n = 0;
    const decode = vi.fn(async (_b: Blob) => fakeBitmap(++n));
    const provider = createTemplateProvider({ getTemplate }, decode);

    const a1 = await provider("note1", "A");
    const a2 = await provider("note1", "A"); // hit
    const a3 = await provider("note2", "A"); // hit — content-addressed, note-independent
    const b1 = await provider("note1", "B"); // miss

    expect(a1).toBe(a2);
    expect(a1).toBe(a3);
    expect(a1).not.toBe(b1);
    expect(getTemplate).toHaveBeenCalledTimes(2); // A once, B once
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("dedups concurrent misses for the same hash into one fetch", async () => {
    const getTemplate = vi.fn(async (_id: string, hash: string) => new Blob([hash]));
    const decode = vi.fn(async (_b: Blob) => fakeBitmap(1));
    const provider = createTemplateProvider({ getTemplate }, decode);

    const [x, y] = await Promise.all([provider("n", "H"), provider("n", "H")]);
    expect(x).toBe(y);
    expect(getTemplate).toHaveBeenCalledTimes(1);
  });

  it("caches a failed fetch as null (no repeated round-trips)", async () => {
    const getTemplate = vi.fn(async () => {
      throw new Error("404");
    });
    const decode = vi.fn(async (_b: Blob) => fakeBitmap(1));
    const provider = createTemplateProvider({ getTemplate }, decode);

    expect(await provider("n", "gone")).toBeNull();
    expect(await provider("n", "gone")).toBeNull();
    expect(getTemplate).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();
  });
});
