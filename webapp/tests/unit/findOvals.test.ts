import { describe, it, expect } from "vitest";
import { FIND_LOOPS, ovalsFor } from "../../src/pages/findOvals";
import type { WordBox } from "../../src/core/types";

// The fixture device: 1404 native px over a 118.64 mm canvas.
const PX_PER_MM = 1404 / 118.64;
const NATIVE_W = 1404;

function word(xMm: number, yMm: number, wMm = 20, hMm = 6): WordBox {
  return { text: "word", xMm, yMm, wMm, hMm };
}

describe("find ovals", () => {
  it("scales millimetres to the page's DISPLAYED size, not its native size", () => {
    const display = 468;
    const [oval] = ovalsFor([word(10, 20)], PX_PER_MM, NATIVE_W, display, 624)!;
    const scale = PX_PER_MM * (display / NATIVE_W);

    const x = 10 * scale;
    const w = 20 * scale;
    expect(oval!.left).toBeCloseTo(x - w * 0.1, 6);
    expect(oval!.width).toBeCloseTo(w * 1.2, 6);
  });

  it("grows the box before rounding — more vertically than horizontally", () => {
    const [oval] = ovalsFor([word(10, 20, 20, 6)], PX_PER_MM, NATIVE_W, NATIVE_W, 1872)!;
    const w = 20 * PX_PER_MM;
    const h = 6 * PX_PER_MM;

    expect(oval!.width / w).toBeCloseTo(1.2, 6);
    expect(oval!.height / h).toBeCloseTo(1.32, 6);
    expect(oval!.left + oval!.width / 2).toBeCloseTo(10 * PX_PER_MM + w / 2, 6);
    expect(oval!.top + oval!.height / 2).toBeCloseTo(20 * PX_PER_MM + h / 2, 6);
  });

  it("keys the loop variant and the tilt to the match index, so a repaint is stable", () => {
    const words = Array.from({ length: 7 }, (_, i) => word(10, 10 + i * 9));
    const first = ovalsFor(words, PX_PER_MM, NATIVE_W, NATIVE_W, 1872)!;
    const again = ovalsFor(words, PX_PER_MM, NATIVE_W, NATIVE_W, 1872)!;

    expect(first.map((o) => o.path)).toEqual(again.map((o) => o.path));
    expect(first.map((o) => o.rotateDeg)).toEqual(again.map((o) => o.rotateDeg));
    expect(new Set(first.map((o) => o.path))).toEqual(new Set(FIND_LOOPS));
    for (let i = 1; i < first.length; i++) {
      expect(Math.sign(first[i]!.rotateDeg)).not.toBe(Math.sign(first[i - 1]!.rotateDeg));
    }
    for (const o of first) expect(Math.abs(o.rotateDeg)).toBeLessThan(2.5);
  });

  it("draws NOTHING when the device's millimetre scale was never verified", () => {
    // `pxPerMm === null` is the common case and means "do not place text".
    expect(ovalsFor([word(10, 20)], null, NATIVE_W, 468, 624)).toBeNull();
    expect(ovalsFor([word(10, 20)], 0, NATIVE_W, 468, 624)).toBeNull();
    expect(ovalsFor([word(10, 20)], Number.NaN, NATIVE_W, 468, 624)).toBeNull();
  });

  it("drops the WHOLE set when a box lands off the page, never a partial one", () => {
    const good = word(10, 20);
    const offPage = word(10, 4000);
    expect(ovalsFor([good, offPage], PX_PER_MM, NATIVE_W, NATIVE_W, 1872)).toBeNull();
    expect(ovalsFor([], PX_PER_MM, NATIVE_W, NATIVE_W, 1872)).toEqual([]);
  });

  it("skips a zero-area box without condemning the rest", () => {
    const ovals = ovalsFor([word(10, 20, 0, 6), word(10, 30)], PX_PER_MM, NATIVE_W, NATIVE_W, 1872);
    expect(ovals).toHaveLength(1);
  });

  it("returns nothing usable for a page with no measured size", () => {
    expect(ovalsFor([word(10, 20)], PX_PER_MM, NATIVE_W, 0, 0)).toBeNull();
    expect(ovalsFor([word(10, 20)], PX_PER_MM, 0, 468, 624)).toBeNull();
  });
});
