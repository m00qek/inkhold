// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPinch, isFit, pinchLabel, type PinchTarget } from "../../src/ui/pinchZoom";

/** A stage and page, both 300×400 at the origin, and a viewer that records what it was asked. */
function setup(scale = 1) {
  const scroller = document.createElement("div");
  const page = document.createElement("div");
  scroller.append(page);
  document.body.append(scroller);
  const box = { left: 0, top: 0, width: 300, height: 400, right: 300, bottom: 400, x: 0, y: 0, toJSON: () => ({}) };
  page.getBoundingClientRect = () => box as DOMRect;
  const asked: number[] = [];
  const target: PinchTarget = { scroller, surface: () => page, scale: () => scale, setScale: (k) => void asked.push(k) };
  attachPinch(target);
  return { scroller, page, asked };
}

function touch(target: Element, id: number, x: number, y: number): Touch {
  return { identifier: id, target, clientX: x, clientY: y } as unknown as Touch;
}
function fire(on: Element, type: string, touches: Touch[]): TouchEvent {
  const e = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(e, "touches", { value: touches });
  on.dispatchEvent(e);
  return e;
}
/** Two fingers from `d0` apart to `d1` apart, about (150, 200). */
function pinch(on: Element, d0: number, d1: number): void {
  const pair = (d: number) => [touch(on, 1, 150 - d / 2, 200), touch(on, 2, 150 + d / 2, 200)];
  fire(on, "touchstart", pair(d0));
  fire(on, "touchmove", pair((d0 + d1) / 2));
  fire(on, "touchmove", pair(d1));
  fire(on, "touchend", []);
}
function tap(on: Element): void {
  fire(on, "touchstart", [touch(on, 3, 150, 200)]);
  fire(on, "touchend", []);
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("pinch and double tap on a viewer's page", () => {
  it("scales the page by a transform while the fingers move, and hands the viewer the factor of Fit when they lift", () => {
    const { scroller, page, asked } = setup(1);
    const pair = (d: number) => [touch(scroller, 1, 100, 200), touch(scroller, 2, 100 + d, 200)];
    fire(scroller, "touchstart", pair(100));
    const move = fire(scroller, "touchmove", pair(200));
    // The gesture is ours: no browser scroll or page zoom under it.
    expect(move.defaultPrevented).toBe(true);
    expect(page.style.transform).toBe("scale(2)");
    expect(asked).toEqual([]);
    fire(scroller, "touchend", []);
    expect(asked).toEqual([2]);
  });

  it("holds the factor between Fit and 5 × Fit", () => {
    const wide = setup(1);
    pinch(wide.scroller, 100, 1000);
    expect(wide.asked).toEqual([5]);
    document.body.replaceChildren();
    const narrow = setup(2);
    pinch(narrow.scroller, 100, 10);
    expect(narrow.asked).toEqual([1]);
  });

  it("asks nothing for a pinch that barely moved", () => {
    const { scroller, page, asked } = setup(1);
    pinch(scroller, 100, 101);
    expect(asked).toEqual([]);
    expect(page.style.transform).toBe("");
  });

  it("goes back to Fit on a double tap, or from Fit zooms in", () => {
    const zoomed = setup(2.5);
    tap(zoomed.scroller);
    tap(zoomed.scroller);
    expect(zoomed.asked).toEqual([1]);
    document.body.replaceChildren();
    const fit = setup(1);
    tap(fit.scroller);
    tap(fit.scroller);
    expect(fit.asked).toEqual([2.5]);
  });

  it("takes two slow taps as two taps, not a double tap", () => {
    vi.useFakeTimers();
    const now = { t: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => now.t);
    const { scroller, asked } = setup(1);
    tap(scroller);
    now.t = 1000;
    tap(scroller);
    expect(asked).toEqual([]);
  });

  it("says a pinch as its factor of Fit, and knows Fit when it lands there", () => {
    expect(pinchLabel(2.04)).toBe("2.0×");
    expect(isFit(1)).toBe(true);
    expect(isFit(1.2)).toBe(false);
  });
});
