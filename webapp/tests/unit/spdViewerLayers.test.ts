// @vitest-environment happy-dom
// createSpdViewer: the opacity bar, layer controls and teardown.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createSpdViewer } from "../../src/pages/spdViewer";
import { synthesizeSummary } from "../../src/pages/library";

// --- a fake decoder that speaks the real C-ABI ------------------------------
import { makeFakeDecoder, SAMPLE, BASE, deps, meta, FOLDER, fakeBitmap, seamOf, stackCanvases, until } from "./spdViewer.shared";

describe("createSpdViewer (DOM seam)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mount() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })),
    );
    const bitmaps: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const decodeTile = vi.fn(async () => {
      const b = fakeBitmap();
      bitmaps.push(b);
      return b as unknown as CanvasImageSource;
    });
    const { exports } = makeFakeDecoder(SAMPLE);
    const v = createSpdViewer(deps(), { loader: async () => exports, decodeTile });
    document.body.append(v.el);
    return { v, decodeTile, bitmaps };
  }

  /** The opacity fill bar, its fill/readout and the eye of a row, by list index. */
  function barOf(v: { el: HTMLElement }, rowIdx: number) {
    const row = Array.from(v.el.querySelectorAll(".spd-layer"))[rowIdx]!;
    return {
      row,
      bar: row.querySelector(".spd-layer__bar")! as HTMLElement,
      fill: row.querySelector(".spd-layer__bar-fill")! as HTMLElement,
      pct: row.querySelector(".spd-layer__pct")! as HTMLElement,
      barwrap: row.querySelector(".spd-layer__barwrap")! as HTMLElement,
      eye: row.querySelector(".spd-layer__eye")! as HTMLButtonElement,
    };
  }
  const key = (k: string) => new KeyboardEvent("keydown", { key: k, bubbles: true });

  it("dragging the opacity bar sets the value from the pointer's position along the track", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    const b3 = barOf(v, 1);
    const view3 = seamOf(v).layerViews().find((lv) => lv.layer.id === 3)!;
    // happy-dom has no layout, so give the track a real box: left 100, width 200.
    b3.bar.getBoundingClientRect = () =>
      ({ left: 100, width: 200, top: 0, right: 300, bottom: 6, height: 6, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    b3.bar.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 100 + 0.75 * 200, bubbles: true }));
    expect(b3.pct.textContent).toBe("75%");
    expect(b3.fill.style.width).toBe("75%");
    expect(view3.current.opacity).toBeCloseTo(0.75, 6);

    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 + 0.25 * 200 }));
    expect(b3.pct.textContent).toBe("25%");
    expect(view3.current.opacity).toBeCloseTo(0.25, 6);

    window.dispatchEvent(new MouseEvent("mouseup", {}));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 + 0.9 * 200 }));
    expect(b3.pct.textContent).toBe("25%");
    v.destroy();
  });

  it("a hidden layer's opacity bar is disabled + out of the tab order; the eye enables/disables it", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    const b1 = barOf(v, 2);
    expect(b1.barwrap.classList.contains("is-disabled")).toBe(true);
    expect(b1.bar.getAttribute("aria-disabled")).toBe("true");
    expect(b1.bar.hasAttribute("tabindex")).toBe(false);
    const view1 = seamOf(v).layerViews().find((lv) => lv.layer.id === 1)!;
    const before = view1.current.opacity;
    b1.bar.dispatchEvent(key("ArrowRight"));
    expect(view1.current.opacity).toBe(before);

    const b4 = barOf(v, 0);
    expect(b4.barwrap.classList.contains("is-disabled")).toBe(false);
    expect(b4.bar.getAttribute("tabindex")).toBe("0");
    b4.eye.click();
    expect(b4.barwrap.classList.contains("is-disabled")).toBe(true);
    expect(b4.bar.hasAttribute("tabindex")).toBe(false);
    b4.eye.click();
    expect(b4.barwrap.classList.contains("is-disabled")).toBe(false);
    expect(b4.bar.getAttribute("tabindex")).toBe("0");

    b1.eye.click();
    expect(b1.barwrap.classList.contains("is-disabled")).toBe(false);
    expect(b1.bar.getAttribute("tabindex")).toBe("0");
    v.destroy();
  });

  it("gives each non-blank layer a thumbnail canvas; the empty Reference Layer gets none", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    expect(v.el.querySelectorAll("canvas.spd-layer__thumb").length).toBe(3);
    const blank = Array.from(v.el.querySelectorAll(".spd-layer__thumb--blank"));
    expect(blank.length).toBe(1);
    expect(blank[0]!.tagName).not.toBe("CANVAS");
    for (const row of Array.from(v.el.querySelectorAll(".spd-layer"))) {
      expect(row.querySelectorAll(".spd-layer__thumb").length).toBe(1);
    }
    v.destroy();
  });

  it("mints every layer thumbnail at ONE height with the drawing's own aspect (capped at 2.5×)", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    // Backing height is fixed per panel; width follows the aspect, clamped at 2.5×.
    const base = seamOf(v).layerViews()[0]!.canvas;
    const expected = Math.min(base.width / base.height, 2.5);
    const thumbs = Array.from(v.el.querySelectorAll("canvas.spd-layer__thumb")) as HTMLCanvasElement[];
    expect(thumbs.length).toBeGreaterThan(0);
    const height = thumbs[0]!.height;
    for (const t of thumbs) {
      expect(t.height).toBe(height);
      expect(t.width / t.height).toBeCloseTo(expected, 2);
      expect(t.width / t.height).toBeLessThanOrEqual(2.5 + 1e-6);
    }
    // Serializations differ ("0.38" vs "0.38 / 1"), so compare the ratio.
    const blank = v.el.querySelector(".spd-layer__thumb--blank") as HTMLElement;
    const parts = blank.style.aspectRatio.split("/").map((s) => Number(s.trim()));
    const ratio = parts.length === 2 ? parts[0]! / parts[1]! : parts[0]!;
    expect(ratio).toBeCloseTo(expected, 4);
    v.destroy();
  });

  it("setLayerVisible / setLayerOpacity mutate the target canvas and its current state", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    const seam = seamOf(v);
    const view3 = seam.layerViews().find((lv) => lv.layer.id === 3)!;

    seam.setLayerVisible(3, false);
    expect(view3.canvas.style.display).toBe("none");
    expect(view3.current.visible).toBe(false);

    seam.setLayerOpacity(3, 0.5);
    expect(view3.canvas.style.opacity).toBe("0.5");
    expect(view3.current.opacity).toBe(0.5);

    seam.setLayerOpacity(3, 2);
    expect(view3.current.opacity).toBe(1);
    seam.setLayerOpacity(3, -1);
    expect(view3.current.opacity).toBe(0);

    expect(() => seam.setLayerVisible(424242, false)).not.toThrow();
    v.destroy();
  });

  it("exportModel snapshots bottom-to-top with authored vs current and base dims", async () => {
    const { v } = mount();
    expect(seamOf(v).exportModel()).toBeNull();

    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    const seam = seamOf(v);

    seam.setLayerOpacity(4, 0.5);
    seam.setLayerVisible(1, true);

    const model = seam.exportModel()!;
    expect({ width: model.width, height: model.height }).toEqual({ width: BASE.w, height: BASE.h });
    expect(model.layers.map((l) => l.id)).toEqual([9999, 1, 3, 4]);
    for (const l of model.layers) expect(l.canvas).toBeInstanceOf(HTMLCanvasElement);

    const top = model.layers.find((l) => l.id === 4)!;
    expect(top.authored).toEqual({ opacity: 1, visible: true });
    expect(top.current).toEqual({ opacity: 0.5, visible: true });

    const hidden = model.layers.find((l) => l.id === 1)!;
    expect(hidden.authored).toEqual({ opacity: 76 / 255, visible: false });
    expect(hidden.current).toEqual({ opacity: 76 / 255, visible: true });
    v.destroy();
  });

  it("current resets to authored on each open (view-only, not persisted)", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    seamOf(v).setLayerOpacity(4, 0.25);
    seamOf(v).setLayerVisible(4, false);
    expect(seamOf(v).layerViews()[0]!.current).toEqual({ opacity: 0.25, visible: false });

    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    expect(seamOf(v).layerViews()[0]!.current).toEqual({ opacity: 1, visible: true });
    v.destroy();
  });

  it("hide() drops every layer canvas and empties the wrapper", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    expect(stackCanvases(v).length).toBe(4);

    v.hide();
    expect(v.el.hidden).toBe(true);
    expect(stackCanvases(v).length).toBe(0);
    expect(seamOf(v).layerViews().length).toBe(0);
    expect(seamOf(v).exportModel()).toBeNull();
    v.destroy();
  });

  it("a decode failure falls back to the honest placeholder (name + SPD mark kept)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    const { exports } = makeFakeDecoder(SAMPLE);
    const v = createSpdViewer(deps(), { loader: async () => exports, decodeTile: async () => fakeBitmap() as unknown as CanvasImageSource });
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => (v.el.querySelector(".viewer__placeholder p") as HTMLElement)?.textContent?.includes("Couldn't") ?? false);

    const ph = v.el.querySelector(".viewer__placeholder")!;
    expect(ph.querySelector(".viewer__mark")!.textContent).toBe("SPD");
    expect(ph.textContent).toContain("Kitchen sketch");
    expect((v.el.querySelector(".spd-body") as HTMLElement).hidden).toBe(true);
    v.destroy();
  });

  it("a 401 during render hands off to the session sink rather than erroring", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    const onSessionExpired = vi.fn();
    const { exports } = makeFakeDecoder(SAMPLE);
    const v = createSpdViewer(deps({ onSessionExpired }), { loader: async () => exports, decodeTile: async () => fakeBitmap() as unknown as CanvasImageSource });
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => onSessionExpired.mock.calls.length > 0);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    v.destroy();
  });
});
