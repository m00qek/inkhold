import { describe, it, expect, vi } from "vitest";
import { templatePlacement, createTemplateProvider } from "../../src/render/template";

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
    const p = templatePlacement(pageW, pageH, 500, 3744);
    expect(p.h).toBeCloseTo(pageH);
    expect(p.w).toBeCloseTo(250);
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeCloseTo((1404 - 250) / 2);
  });

  it("wide + short: width fills the page, blank top/bottom", () => {
    const p = templatePlacement(pageW, pageH, 2808, 500);
    expect(p.w).toBeCloseTo(pageW);
    expect(p.h).toBeCloseTo(250);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo((1872 - 250) / 2);
  });

  it("oversized non-3:4: contained (letterboxed), never upscaled past a dim", () => {
    const p = templatePlacement(pageW, pageH, 2000, 2000);
    // scale = min(1, 1404/2000, 1872/2000) = 0.702 -> both dims 1404
    expect(p.w).toBeCloseTo(1404);
    expect(p.h).toBeCloseTo(1404);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo((1872 - 1404) / 2);
    expect(p.w).toBeLessThanOrEqual(pageW);
    expect(p.h).toBeLessThanOrEqual(pageH);
  });

  it("an exact 3:4 oversize covers the page perfectly (no letterbox)", () => {
    const p = templatePlacement(pageW, pageH, 2808, 3744);
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
    const a2 = await provider("note1", "A");
    const a3 = await provider("note2", "A");
    const b1 = await provider("note1", "B");

    expect(a1).toBe(a2);
    expect(a1).toBe(a3);
    expect(a1).not.toBe(b1);
    expect(getTemplate).toHaveBeenCalledTimes(2);
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

  // Regression: a PDF-based note has a template per page (1698 over 1703); an unbounded
  // `ImageBitmap` memo asked for ~17.8 GB and the export died.
  it("CLOSES what it evicts, so a template per page cannot exhaust the browser", async () => {
    const closed: number[] = [];
    const bitmapClosing = (id: number): ImageBitmap =>
      ({ width: id, height: id, close: () => closed.push(id) }) as unknown as ImageBitmap;

    const getTemplate = vi.fn(async (_id: string, hash: string) => new Blob([hash]));
    let n = 0;
    const decode = vi.fn(async (_b: Blob) => bitmapClosing(++n));
    const provider = createTemplateProvider({ getTemplate }, decode, 3);

    for (const h of ["A", "B", "C", "D", "E"]) await provider("n", h);
    // Let the eviction's `.then(close)` settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(closed).toEqual([1, 2]);
  });

  it("evicts least-RECENTLY-used, so the template every page shares survives", async () => {
    const closed: number[] = [];
    const bitmapClosing = (id: number): ImageBitmap =>
      ({ width: id, height: id, close: () => closed.push(id) }) as unknown as ImageBitmap;

    const getTemplate = vi.fn(async (_id: string, hash: string) => new Blob([hash]));
    let n = 0;
    const decode = vi.fn(async (_b: Blob) => bitmapClosing(++n));
    const provider = createTemplateProvider({ getTemplate }, decode, 3);

    const shared = await provider("n", "SHARED");
    await provider("n", "B");
    await provider("n", "C");
    await provider("n", "SHARED");
    await provider("n", "D");  // evicts B (id 2), not the shared one
    await new Promise((r) => setTimeout(r, 0));

    expect(closed).toEqual([2]);
    expect(await provider("n", "SHARED")).toBe(shared);
    expect(getTemplate).toHaveBeenCalledTimes(4);
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
