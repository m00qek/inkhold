// @vitest-environment happy-dom
// The fake decoder speaks the real `spd_*` C-ABI over a real `WebAssembly.Memory`.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseSpd,
  spdBbox,
  spdBaseDims,
  type SpdDecoderExports,
  type SpdDoc,
} from "../../src/render/spdDecode";
import { createSpdViewer, type SpdViewerSeam } from "../../src/pages/spdViewer";
import type { ViewerDeps, ReaderOrigin } from "../../src/pages/viewer";
import type { NoteMeta } from "../../src/core/types";
import { synthesizeSummary } from "../../src/pages/library";

// --- a fake decoder that speaks the real C-ABI ------------------------------

interface FakeTile { tx: number; ty: number; png: number[]; }
interface FakeLayer { id: number; name: string; visible: boolean; opacity: number; tiles: FakeTile[]; }
interface FakeSpec { width: number; height: number; layers: FakeLayer[]; openRc?: number; }

interface FakeCalls {
  open: number;
  close: number;
  free: Array<[number, number]>;
  alloc: number[];
}

function makeFakeDecoder(spec: FakeSpec): { exports: SpdDecoderExports; calls: FakeCalls } {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const u8 = () => new Uint8Array(memory.buffer);
  const enc = new TextEncoder();
  let bump = 2048;

  const nameRefs = spec.layers.map((l) => {
    const b = enc.encode(l.name);
    const ptr = bump;
    u8().set(b, ptr);
    bump += b.length + 8;
    return { ptr: b.length ? ptr : 0, len: b.length };
  });
  const tileRefs = spec.layers.map((l) =>
    l.tiles.map((t) => {
      const b = Uint8Array.from(t.png);
      const ptr = bump;
      u8().set(b, ptr);
      bump += b.length + 8;
      return { ptr, len: b.length, tx: t.tx, ty: t.ty };
    }),
  );

  const calls: FakeCalls = { open: 0, close: 0, free: [], alloc: [] };
  let itLayer = -1;
  let itIdx = -1;
  let cur = { ptr: 0, len: 0, tx: 0, ty: 0 };

  const exports = {
    memory,
    _initialize: () => {},
    spd_alloc(len: number) {
      calls.alloc.push(len);
      const p = bump;
      bump += len + 8;
      return p;
    },
    spd_free(ptr: number, len: number) {
      calls.free.push([ptr, len]);
    },
    spd_open() {
      calls.open++;
      return spec.openRc ?? 0;
    },
    spd_close() {
      calls.close++;
      itLayer = -1;
      itIdx = -1;
    },
    spd_doc_width: () => spec.width,
    spd_doc_height: () => spec.height,
    spd_layer_count: () => spec.layers.length,
    spd_layer_id: (i: number) => spec.layers[i]?.id ?? -1,
    spd_layer_visible: (i: number) => (spec.layers[i]?.visible ? 1 : 0),
    spd_layer_opacity: (i: number) => spec.layers[i]?.opacity ?? 0,
    spd_layer_name_ptr: (i: number) => nameRefs[i]?.ptr ?? 0,
    spd_layer_name_len: (i: number) => nameRefs[i]?.len ?? 0,
    spd_tiles_begin(id: number) {
      itLayer = spec.layers.findIndex((l) => l.id === id);
      itIdx = -1;
      return 0;
    },
    spd_tile_next() {
      if (itLayer < 0) return 0;
      const tiles = tileRefs[itLayer]!;
      itIdx++;
      if (itIdx >= tiles.length) return 0;
      const t = tiles[itIdx]!;
      cur = { ptr: t.ptr, len: t.len, tx: t.tx, ty: t.ty };
      return 1;
    },
    spd_tile_x: () => cur.tx,
    spd_tile_y: () => cur.ty,
    spd_tile_png_ptr: () => cur.ptr,
    spd_tile_png_len: () => cur.len,
  } as unknown as SpdDecoderExports;

  return { exports, calls };
}

// The real fixture's shape: layers 4/3/2 shown, 1 hidden @76/255, 9999 empty; top-first.
const SAMPLE: FakeSpec = {
  width: 1404,
  height: 1872,
  layers: [
    { id: 4, name: "Layer 4", visible: true, opacity: 255, tiles: [{ tx: 10, ty: 20, png: [1, 2, 3] }, { tx: 12, ty: 22, png: [4, 5] }] },
    { id: 3, name: "Layer 3", visible: true, opacity: 128, tiles: [{ tx: 11, ty: 25, png: [9] }] },
    { id: 1, name: "Layer 1", visible: false, opacity: 76, tiles: [{ tx: 5, ty: 5, png: [7, 7] }] },
    { id: 9999, name: "Reference Layer", visible: true, opacity: 255, tiles: [] },
  ],
};

// The sample bbox is x∈[5,12] y∈[5,25] → 8×21 tiles → base 1024×2688 px.
const BASE = { w: 8 * 128, h: 21 * 128 };

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

function deps(over: Partial<ViewerDeps> = {}): ViewerDeps {
  return {
    api: {} as ViewerDeps["api"],
    renderer: {} as ViewerDeps["renderer"],
    cache: {} as ViewerDeps["cache"],
    getTheme: () => "light",
    onBack: vi.fn(),
    toast: vi.fn(),
    onSessionExpired: vi.fn(),
    onMoveToBin: vi.fn(),
    onPosition: vi.fn(),
    ...over,
  };
}

function meta(over: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: "174",
    name: "Kitchen sketch",
    pages: [],
    fileType: "spd",
    fileHash: "a".repeat(32),
    size: 4096,
    pxPerMm: null,
    ...over,
  };
}

const FOLDER: ReaderOrigin = { kind: "folder", folderPath: "Note / Files" };

/** A fake `createImageBitmap` result the canvas can (attempt to) draw + we close. */
function fakeBitmap(): { close: ReturnType<typeof vi.fn> } {
  return { width: 128, height: 128, close: vi.fn() } as unknown as { close: ReturnType<typeof vi.fn> };
}

/** The internal test seam the viewer hangs off the returned object. */
function seamOf(v: { el: HTMLElement }): SpdViewerSeam {
  return (v as unknown as { _spdSeam: SpdViewerSeam })._spdSeam;
}

/** Every layer canvas in stack (DOM) order — bottom-to-top. */
function stackCanvases(v: { el: HTMLElement }): HTMLCanvasElement[] {
  return Array.from(v.el.querySelectorAll<HTMLCanvasElement>(".spd-canvas-wrap .spd-layer-canvas"));
}

async function until(pred: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error("condition not met in time");
}

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
