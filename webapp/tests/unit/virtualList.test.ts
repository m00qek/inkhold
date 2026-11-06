// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { VirtualList } from "../../src/ui/virtualList";

/** A list of `n` rows in a 300px-long scroller, positioned along `axis`. */
function list(n: number, axis: "x" | "y") {
  const scroller = document.createElement("div");
  const host = document.createElement("div");
  const content = document.createElement("div");
  scroller.append(host);
  document.body.append(scroller);
  const rect = (r: Partial<DOMRect>) => () => ({ left: 0, top: 0, width: 300, height: 300, right: 300, bottom: 300, x: 0, y: 0, toJSON: () => ({}), ...r }) as DOMRect;
  scroller.getBoundingClientRect = rect({});
  host.getBoundingClientRect = rect({});
  const v = new VirtualList({
    scrollContainer: scroller,
    hostContainer: host,
    contentContainer: content,
    totalItems: n,
    itemHeight: 100,
    renderItem: (i) => {
      const e = document.createElement("button");
      e.dataset["i"] = String(i);
      return e;
    },
    overscan: 1,
    axis,
  });
  const row = (i: number) => content.querySelector<HTMLElement>(`[data-i="${i}"]`);
  return { v, scroller, host, row };
}

afterEach(() => document.body.replaceChildren());

describe("a windowed list", () => {
  it("stacks a column: rows down the host, the spacer as tall as all of them", () => {
    const { host, row } = list(50, "y");
    expect((host.firstElementChild as HTMLElement).style.height).toBe("5000px");
    expect(row(2)!.style.top).toBe("200px");
    expect(row(2)!.style.left).toBe("0px");
    // Three in view, a window either side: rows far down are not built.
    expect(row(40)).toBeNull();
  });

  it("lays a row out sideways: each item as wide as the size, the spacer as long as all of them", () => {
    const { host, row } = list(50, "x");
    expect((host.firstElementChild as HTMLElement).style.width).toBe("5000px");
    expect(row(2)!.style.left).toBe("200px");
    expect(row(2)!.style.width).toBe("100px");
    expect(row(2)!.style.top).toBe("0px");
    expect(row(40)).toBeNull();
  });

  it("brings an item into view along its own axis", () => {
    const across = list(50, "x");
    across.v.scrollIntoView(10);
    // Item 10 ends at 1100px; the window is 300px long.
    expect(across.scroller.scrollLeft).toBe(800);
    expect(across.scroller.scrollTop).toBe(0);
    const down = list(50, "y");
    down.v.scrollIntoView(10);
    expect(down.scroller.scrollTop).toBe(800);
    expect(down.scroller.scrollLeft).toBe(0);
  });
});
