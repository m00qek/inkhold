// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { attachSwipe } from "../../src/ui/swipePages";

/** A 300 px wide stage that records the turns it was asked for. */
function setup(opts: { scrollWidth?: number; scrollLeft?: number; enabled?: boolean } = {}) {
  const scroller = document.createElement("div");
  document.body.append(scroller);
  Object.defineProperty(scroller, "clientWidth", { value: 300 });
  Object.defineProperty(scroller, "scrollWidth", { value: opts.scrollWidth ?? 300 });
  Object.defineProperty(scroller, "scrollLeft", { value: opts.scrollLeft ?? 0, writable: true });
  const turns: number[] = [];
  attachSwipe({ scroller, turn: (d) => void turns.push(d), enabled: () => opts.enabled ?? true });
  return { scroller, turns };
}

function fire(on: Element, type: string, pts: [number, number][]): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: pts.map(([x, y], i) => ({ identifier: i, target: on, clientX: x, clientY: y })) });
  on.dispatchEvent(e);
}
/** One finger from (x0, y0) to (x1, y1). */
function swipe(on: Element, x0: number, y0: number, x1: number, y1: number): void {
  fire(on, "touchstart", [[x0, y0]]);
  fire(on, "touchmove", [[(x0 + x1) / 2, (y0 + y1) / 2]]);
  fire(on, "touchmove", [[x1, y1]]);
  fire(on, "touchend", []);
}

afterEach(() => document.body.replaceChildren());

describe("a sideways swipe on a viewer's stage", () => {
  it("to the left turns to the next page, to the right to the previous", () => {
    const { scroller, turns } = setup();
    swipe(scroller, 250, 200, 80, 210);
    swipe(scroller, 80, 200, 250, 190);
    expect(turns).toEqual([1, -1]);
  });

  it("leaves a scroll down, a short nudge and a tap alone", () => {
    const { scroller, turns } = setup();
    swipe(scroller, 150, 300, 110, 100); // mostly down
    swipe(scroller, 150, 200, 120, 200); // too short
    swipe(scroller, 150, 200, 150, 200); // a tap
    expect(turns).toEqual([]);
  });

  it("is not a pinch: a second finger cancels it", () => {
    const { scroller, turns } = setup();
    fire(scroller, "touchstart", [[250, 200]]);
    fire(scroller, "touchmove", [[200, 200], [100, 200]]);
    fire(scroller, "touchmove", [[60, 200]]);
    fire(scroller, "touchend", []);
    expect(turns).toEqual([]);
  });

  it("on a page zoomed wider than the stage, turns only from the edge it started at", () => {
    const mid = setup({ scrollWidth: 900, scrollLeft: 300 });
    swipe(mid.scroller, 250, 200, 80, 200);
    expect(mid.turns).toEqual([]);
    document.body.replaceChildren();
    const end = setup({ scrollWidth: 900, scrollLeft: 600 });
    swipe(end.scroller, 250, 200, 80, 200);
    swipe(end.scroller, 80, 200, 250, 200); // at the right edge, not the left
    expect(end.turns).toEqual([1]);
  });

  it("leaves a strip that scrolls sideways inside the stage to scroll", () => {
    const { scroller, turns } = setup();
    const strip = document.createElement("div");
    strip.style.overflowX = "auto";
    Object.defineProperty(strip, "clientWidth", { value: 300 });
    Object.defineProperty(strip, "scrollWidth", { value: 1200 });
    const thumb = document.createElement("div");
    strip.append(thumb);
    scroller.append(strip);
    const e = (type: string, x: number) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [{ identifier: 0, target: thumb, clientX: x, clientY: 200 }] });
      thumb.dispatchEvent(ev);
    };
    e("touchstart", 250);
    e("touchmove", 80);
    e("touchend", 80);
    expect(turns).toEqual([]);
  });

  it("does nothing while the viewer has no pages to turn", () => {
    const { scroller, turns } = setup({ enabled: false });
    swipe(scroller, 250, 200, 80, 200);
    expect(turns).toEqual([]);
  });
});
