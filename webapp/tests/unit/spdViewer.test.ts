// @vitest-environment happy-dom
// The fake decoder speaks the real `spd_*` C-ABI over a real `WebAssembly.Memory`.

import { describe, it, expect, vi, afterEach } from "vitest";
import { parseSpd, spdBbox, spdBaseDims, type SpdDoc } from "../../src/render/spdDecode";
import { createSpdViewer } from "../../src/pages/spdViewer";
import { synthesizeSummary } from "../../src/pages/library";

// --- a fake decoder that speaks the real C-ABI ------------------------------
import { makeFakeDecoder, SAMPLE, BASE, deps, meta, FOLDER, fakeBitmap, seamOf, stackCanvases, until, mount, barOf, key } from "./spdViewer.shared";

describe("parseSpd", () => {
  it("reads the layer tree, per-layer state and tiles out of the ABI", async () => {
    const { exports, calls } = makeFakeDecoder(SAMPLE);
    const doc = parseSpd(exports, new Uint8Array([0x53, 0x51, 0x4c]));

    expect(doc.width).toBe(1404);
    expect(doc.height).toBe(1872);
    expect(doc.layers.map((l) => l.id)).toEqual([4, 3, 1, 9999]);
    expect(doc.layers.map((l) => l.name)).toEqual(["Layer 4", "Layer 3", "Layer 1", "Reference Layer"]);
    expect(doc.layers.map((l) => l.visible)).toEqual([true, true, false, true]);
    expect(doc.layers[2]!.opacity).toBe(76);

    expect(doc.layers[0]!.tiles).toEqual([
      { tx: 10, ty: 20, png: new Uint8Array([1, 2, 3]) },
      { tx: 12, ty: 22, png: new Uint8Array([4, 5]) },
    ]);
    expect(doc.layers[3]!.tiles).toEqual([]);

    // The input is freed right after open and the document closed once.
    expect(calls.open).toBe(1);
    expect(calls.close).toBe(1);
    expect(calls.free.length).toBe(1);
    expect(calls.alloc.length).toBe(1);
  });

  it("throws with the mapped message on a decoder error, and still closes on read failure", async () => {
    const bad = makeFakeDecoder({ ...SAMPLE, openRc: -2 });
    expect(() => parseSpd(bad.exports, new Uint8Array([0]))).toThrow(/not an \.spd file/);
    expect(bad.calls.free.length).toBe(1);
    expect(bad.calls.close).toBe(0);
  });

  it("copies PNG bytes so they survive a later decoder call", async () => {
    const { exports } = makeFakeDecoder(SAMPLE);
    const doc = parseSpd(exports, new Uint8Array([0]));
    const png = doc.layers[0]!.tiles[0]!.png;
    new Uint8Array(exports.memory.buffer).fill(0xff, 2048, 4096);
    expect(Array.from(png)).toEqual([1, 2, 3]);
  });
});

describe("spdBbox", () => {
  it("is the min/max tile box across every layer", async () => {
    const { exports } = makeFakeDecoder(SAMPLE);
    const doc = parseSpd(exports, new Uint8Array([0]));
    expect(spdBbox(doc)).toEqual({ minTx: 5, minTy: 5, cols: 8, rows: 21 });
    expect(spdBaseDims(doc, spdBbox(doc))).toEqual(BASE);
  });

  it("is null when nothing is drawn", async () => {
    const doc: SpdDoc = { width: 100, height: 200, layers: [{ id: 9999, name: "Reference Layer", visible: true, opacity: 255, tiles: [] }] };
    expect(spdBbox(doc)).toBeNull();
    expect(spdBaseDims(doc, null)).toEqual({ w: 100, h: 200 });
  });
});

// --- the viewer DOM seam (injected decoder + tile decoder, no GPU) -----------

describe("createSpdViewer (DOM seam)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stacks one base-res canvas per layer, topmost last in the DOM", async () => {
    // A DPR > 1 must not enlarge the backing store: memory is bounded by base res.
    vi.stubGlobal("devicePixelRatio", 2);
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);

    const canvases = stackCanvases(v);
    expect(canvases.length).toBe(4);
    expect([canvases[0]!.width, canvases[0]!.height]).toEqual([BASE.w, BASE.h]);

    // layerViews is top-first; the DOM is reversed so the topmost paints last.
    const views = seamOf(v).layerViews();
    expect(views.map((lv) => lv.layer.id)).toEqual([4, 3, 1, 9999]);
    const wrap = v.el.querySelector(".spd-canvas-wrap")!;
    expect(wrap.lastElementChild).toBe(views[0]!.canvas);
    expect(wrap.firstElementChild).toBe(views[3]!.canvas);
    v.destroy();
  });

  it("in a HISTORY preview: fetches the version's raw bytes and shows the read-only chrome", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
      }),
    );
    const decodeTile = vi.fn(async () => fakeBitmap() as unknown as CanvasImageSource);
    const { exports } = makeFakeDecoder(SAMPLE);
    const onVersions = vi.fn();
    const onRestoreVersion = vi.fn();
    const version = { md5: "e".repeat(32), createdAt: 1_752_000_000_000 };
    const v = createSpdViewer(deps({ onVersions, onRestoreVersion }), { loader: async () => exports, decodeTile });
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta({ id: "174", fileHash: "a".repeat(32) })), Promise.resolve(meta({ id: "174", fileHash: "a".repeat(32) })), 0, { kind: "history", folderPath: "Note / Files", version }, "");
    await until(() => calls.length > 0);

    // The version-scoped history raw route, not the live `/file/:id?v=`.
    expect(calls[0]).toBe(`/api/controlplane/note/174/history/${"e".repeat(32)}/raw`);

    const banner = v.el.querySelector(".version-banner") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("not the current note");
    expect((v.el.querySelector('button[aria-label="Move to bin"]') as HTMLElement).hidden).toBe(true);
    const versions = v.el.querySelector('button[aria-label="Version history"]') as HTMLElement;
    expect(versions.hidden).toBe(false);

    versions.click();
    expect(onVersions).toHaveBeenCalledOnce();
    (banner.querySelector(".version-banner__restore") as HTMLElement).click();
    expect(onRestoreVersion).toHaveBeenCalledWith(expect.objectContaining({ id: "174" }), version);
    v.destroy();
  });

  it("in a HISTORY preview: the URL sync rides the version md5 (addressable version)", async () => {
    // `onPosition` keys off the version md5 (4th arg) to write `#/note/:id/version/:short`.
    const onPosition = vi.fn();
    const { exports } = makeFakeDecoder(SAMPLE);
    const version = { md5: "e".repeat(32), createdAt: 1_752_000_000_000 };
    const v = createSpdViewer(deps({ onPosition }), { loader: async () => exports, decodeTile: vi.fn() });
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta({ id: "174" })), Promise.resolve(meta({ id: "174" })), 0, { kind: "history", folderPath: "Note / Files", version }, "");
    expect(onPosition).toHaveBeenCalledWith("174", 0, "", version.md5);
    v.destroy();
  });

  it("a LIVE .spd open publishes no version md5 (bare note URL)", async () => {
    const onPosition = vi.fn();
    const { exports } = makeFakeDecoder(SAMPLE);
    const v = createSpdViewer(deps({ onPosition }), { loader: async () => exports, decodeTile: vi.fn() });
    document.body.append(v.el);
    await v.open(synthesizeSummary(meta({ id: "174" })), Promise.resolve(meta({ id: "174" })), 0, { kind: "folder", folderPath: "Note / Files" }, "");
    expect(onPosition).not.toHaveBeenCalled();
    v.destroy();
  });

  it("builds the layers panel from the tree, seeded from authored visibility", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    expect((v.el.querySelector(".viewer__main") as HTMLElement).hidden).toBe(true);
    expect((v.el.querySelector(".spd-body") as HTMLElement).hidden).toBe(false);

    const rows = Array.from(v.el.querySelectorAll(".spd-layer"));
    expect(rows.map((r) => r.querySelector(".spd-layer__name")!.textContent)).toEqual([
      "Layer 4",
      "Layer 3",
      "Layer 1",
      "Reference Layer",
    ]);
    const pressed = rows.map((r) => r.querySelector(".spd-layer__eye")!.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["true", "true", "false", "true"]);
    const views = seamOf(v).layerViews();
    expect(views.map((lv) => lv.canvas.style.display)).toEqual(["", "", "none", ""]);
    expect(views[2]!.canvas.style.opacity).toBe(String(76 / 255));
    v.destroy();
  });

  it("decodes one bitmap per tile, drawing then closing each (4 across the layers)", async () => {
    const { v, decodeTile, bitmaps } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    expect(decodeTile).toHaveBeenCalledTimes(4);
    expect(bitmaps.length).toBe(4);
    for (const b of bitmaps) expect(b.close).toHaveBeenCalledTimes(1);
    v.destroy();
  });

  it("the Layers button opens the panel with the toolbar's active state", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    const btn = v.el.querySelector('[aria-label="Layers"]') as HTMLButtonElement;
    const panel = v.el.querySelector(".spd-layers") as HTMLElement;
    expect(panel.hidden).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    btn.click();
    expect(panel.hidden).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    v.destroy();
  });

  it("the panel head reads as `[icon] Layers` — a decorative icon before the label", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    const head = v.el.querySelector(".spd-layers__head")!;
    const icon = head.querySelector(".spd-layers__head-ic")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.querySelector("svg")).not.toBeNull();
    const label = head.querySelector("span:not(.spd-layers__head-ic)")!;
    expect(label.textContent).toBe("Layers");
    v.destroy();
  });

  it("an eye toggle flips its state AND hides the matching layer canvas", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    const firstEye = v.el.querySelector(".spd-layer__eye") as HTMLButtonElement;
    const topCanvas = seamOf(v).layerViews()[0]!.canvas;
    expect(firstEye.getAttribute("aria-pressed")).toBe("true");
    expect(topCanvas.style.display).toBe("");

    firstEye.click();
    expect(firstEye.getAttribute("aria-pressed")).toBe("false");
    expect(firstEye.closest(".spd-layer")!.classList.contains("is-hidden")).toBe(true);
    expect(topCanvas.style.display).toBe("none");
    expect(seamOf(v).layerViews()[0]!.current.visible).toBe(false);
    v.destroy();
  });

  it("the opacity bar steps 1% on arrow keys (Home/End → bounds), drives setLayerOpacity, and clamps", async () => {
    const { v } = mount();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    // Row 1 is Layer 3 (Z-order 4,3,1,9999), authored opacity 128/255 → 50%.
    const b3 = barOf(v, 1);
    const view3 = seamOf(v).layerViews().find((lv) => lv.layer.id === 3)!;
    expect(b3.pct.textContent).toBe("50%");
    expect(b3.bar.getAttribute("aria-valuenow")).toBe("50");
    expect(b3.fill.style.width).toBe("50%");

    b3.bar.dispatchEvent(key("ArrowRight"));
    expect(b3.pct.textContent).toBe("51%");
    expect(b3.fill.style.width).toBe("51%");
    expect(b3.bar.getAttribute("aria-valuenow")).toBe("51");
    expect(view3.current.opacity).toBeCloseTo(0.51, 6);
    expect(view3.canvas.style.opacity).toBe("0.51");

    b3.bar.dispatchEvent(key("ArrowLeft"));
    b3.bar.dispatchEvent(key("ArrowLeft"));
    expect(b3.pct.textContent).toBe("49%");
    expect(view3.current.opacity).toBeCloseTo(0.49, 6);

    b3.bar.dispatchEvent(key("Home"));
    expect(b3.pct.textContent).toBe("0%");
    expect(b3.fill.style.width).toBe("0%");
    expect(view3.current.opacity).toBe(0);
    b3.bar.dispatchEvent(key("End"));
    expect(b3.pct.textContent).toBe("100%");
    expect(view3.current.opacity).toBe(1);

    const b4 = barOf(v, 0);
    const view4 = seamOf(v).layerViews()[0]!;
    expect(b4.pct.textContent).toBe("100%");
    b4.bar.dispatchEvent(key("ArrowRight"));
    expect(b4.pct.textContent).toBe("100%");
    expect(view4.current.opacity).toBe(1);
    v.destroy();
  });
});
