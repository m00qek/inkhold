// @vitest-environment happy-dom
//
// The `.spd` viewer's PURE CORE, and its DOM seam. The parse (bytes → layer tree +
// tiles), the tile bounding box and the base canvas dims are pure — tested here
// against a FAKE decoder that speaks the real `spd_*` C-ABI (`webapp/wasm/spd_decode.zig`),
// backed by a real `WebAssembly.Memory` so the pointer-and-copy discipline `parseSpd`
// relies on is genuinely exercised. The viewer itself is then driven with an
// injected decoder + tile decoder — no GPU, no network — to prove the STACKED
// PER-LAYER CANVAS model: one canvas per layer at base res, the eye toggles and the
// live seam (`setLayerVisible`/`setLayerOpacity`/`exportModel`), and the bitmap
// release (each tile is drawn once then closed).

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
  const memory = new WebAssembly.Memory({ initial: 4 }); // 256 KiB
  const u8 = () => new Uint8Array(memory.buffer);
  const enc = new TextEncoder();
  let bump = 2048; // leave the low region for `spd_alloc` returns

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

// The corpus shape the real fixture has: layers 4/3/2 shown, 1 hidden @76/255,
// 9999 the empty Reference Layer — Z-order top-first.
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

// The SAMPLE bbox is x∈[5,12] y∈[5,25] → 8×21 tiles → base 1024×2688 px.
const BASE = { w: 8 * 128, h: 21 * 128 };

describe("parseSpd", () => {
  it("reads the layer tree, per-layer state and tiles out of the ABI", () => {
    const { exports, calls } = makeFakeDecoder(SAMPLE);
    const doc = parseSpd(exports, new Uint8Array([0x53, 0x51, 0x4c]));

    expect(doc.width).toBe(1404);
    expect(doc.height).toBe(1872);
    expect(doc.layers.map((l) => l.id)).toEqual([4, 3, 1, 9999]);
    expect(doc.layers.map((l) => l.name)).toEqual(["Layer 4", "Layer 3", "Layer 1", "Reference Layer"]);
    expect(doc.layers.map((l) => l.visible)).toEqual([true, true, false, true]);
    expect(doc.layers[2]!.opacity).toBe(76);

    // Tiles copied out with their grid coords and exact PNG bytes.
    expect(doc.layers[0]!.tiles).toEqual([
      { tx: 10, ty: 20, png: new Uint8Array([1, 2, 3]) },
      { tx: 12, ty: 22, png: new Uint8Array([4, 5]) },
    ]);
    // The empty Reference Layer yields zero tiles, not an error.
    expect(doc.layers[3]!.tiles).toEqual([]);

    // The one hazard: the input is freed right after open, and the document is
    // closed once — the decoder holds nothing after parseSpd returns.
    expect(calls.open).toBe(1);
    expect(calls.close).toBe(1);
    expect(calls.free.length).toBe(1);
    expect(calls.alloc.length).toBe(1);
  });

  it("throws with the mapped message on a decoder error, and still closes on read failure", () => {
    const bad = makeFakeDecoder({ ...SAMPLE, openRc: -2 });
    expect(() => parseSpd(bad.exports, new Uint8Array([0]))).toThrow(/not an \.spd file/);
    // open failed → the input was still freed, and close was NOT called (nothing open).
    expect(bad.calls.free.length).toBe(1);
    expect(bad.calls.close).toBe(0);
  });

  it("copies PNG bytes so they survive a later decoder call", () => {
    const { exports } = makeFakeDecoder(SAMPLE);
    const doc = parseSpd(exports, new Uint8Array([0]));
    const png = doc.layers[0]!.tiles[0]!.png;
    // Mutating wasm memory now must not change what we copied out.
    new Uint8Array(exports.memory.buffer).fill(0xff, 2048, 4096);
    expect(Array.from(png)).toEqual([1, 2, 3]);
  });
});

describe("spdBbox", () => {
  it("is the min/max tile box across every layer", () => {
    const { exports } = makeFakeDecoder(SAMPLE);
    const doc = parseSpd(exports, new Uint8Array([0]));
    // Across layers 4 (10,20)/(12,22), 3 (11,25), 1 (5,5): x∈[5,12] y∈[5,25].
    expect(spdBbox(doc)).toEqual({ minTx: 5, minTy: 5, cols: 8, rows: 21 });
    // Base canvas dims = the bbox in px.
    expect(spdBaseDims(doc, spdBbox(doc))).toEqual(BASE);
  });

  it("is null when nothing is drawn", () => {
    const doc: SpdDoc = { width: 100, height: 200, layers: [{ id: 9999, name: "Reference Layer", visible: true, opacity: 255, tiles: [] }] };
    expect(spdBbox(doc)).toBeNull();
    // …and the base dims fall back to the surface size.
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
    id: "n-files-sketch",
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
    // A DPR > 1 must NOT enlarge the backing store — memory is bounded by base res.
    vi.stubGlobal("devicePixelRatio", 2);
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);

    const canvases = stackCanvases(v);
    expect(canvases.length).toBe(4); // one per layer
    // Backing store is the bbox in px — NOT × devicePixelRatio.
    expect([canvases[0]!.width, canvases[0]!.height]).toEqual([BASE.w, BASE.h]);

    // layerViews is Z-order (index 0 = topmost); the DOM is reversed so the
    // topmost paints on top (last child).
    const views = seamOf(v).layerViews();
    expect(views.map((lv) => lv.layer.id)).toEqual([4, 3, 1, 9999]);
    const wrap = v.el.querySelector(".spd-canvas-wrap")!;
    expect(wrap.lastElementChild).toBe(views[0]!.canvas); // topmost (Layer 4) on top
    expect(wrap.firstElementChild).toBe(views[3]!.canvas); // Reference Layer at the bottom
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
    v.open(meta({ id: "n-files-sketch", fileHash: "a".repeat(32) }), 0, { kind: "history", folderPath: "Note / Files", version }, "");
    await until(() => calls.length > 0);

    // NOT the live `/file/:id?v=` (the current blob) — the version-scoped history
    // raw route, keyed by the version's md5.
    expect(calls[0]).toBe(`/api/controlplane/note/n-files-sketch/history/${"e".repeat(32)}/raw`);

    // The read-only version chrome: banner up, Move to bin gone, Versions shown.
    const banner = v.el.querySelector(".version-banner") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("not the current note");
    expect((v.el.querySelector('button[aria-label="Move to bin"]') as HTMLElement).hidden).toBe(true);
    const versions = v.el.querySelector('button[aria-label="Version history"]') as HTMLElement;
    expect(versions.hidden).toBe(false);

    // Versions reopens the shared list; Restore routes to the shared restore path.
    versions.click();
    expect(onVersions).toHaveBeenCalledOnce();
    (banner.querySelector(".version-banner__restore") as HTMLElement).click();
    expect(onRestoreVersion).toHaveBeenCalledWith(expect.objectContaining({ id: "n-files-sketch" }), version);
    v.destroy();
  });

  it("in a HISTORY preview: the URL sync rides the version md5 (addressable version)", () => {
    // A `.spd` has no page/query to refine, so its whole URL sync is asserting the
    // version's address once on open — the shell's `onPosition` keys off the version
    // md5 (its 4th arg) to write the `#/note/:id/version/:short` form, so a reload /
    // copy-link reproduces the previewed sketch. Synchronous (no render needed).
    const onPosition = vi.fn();
    const { exports } = makeFakeDecoder(SAMPLE);
    const version = { md5: "e".repeat(32), createdAt: 1_752_000_000_000 };
    const v = createSpdViewer(deps({ onPosition }), { loader: async () => exports, decodeTile: vi.fn() });
    document.body.append(v.el);
    v.open(meta({ id: "n-files-sketch" }), 0, { kind: "history", folderPath: "Note / Files", version }, "");
    expect(onPosition).toHaveBeenCalledWith("n-files-sketch", 0, "", version.md5);
    v.destroy();
  });

  it("a LIVE .spd open publishes no version md5 (bare note URL)", () => {
    // The negative: a non-preview open must NOT emit a version address — a `.spd`
    // has nothing to sync, so `onPosition` is untouched and the bare note URL stands.
    const onPosition = vi.fn();
    const { exports } = makeFakeDecoder(SAMPLE);
    const v = createSpdViewer(deps({ onPosition }), { loader: async () => exports, decodeTile: vi.fn() });
    document.body.append(v.el);
    v.open(meta({ id: "n-files-sketch" }), 0, { kind: "folder", folderPath: "Note / Files" }, "");
    expect(onPosition).not.toHaveBeenCalled();
    v.destroy();
  });

  it("builds the layers panel from the tree, seeded from authored visibility", async () => {
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    // The rendered body is up; the placeholder is gone.
    expect((v.el.querySelector(".viewer__main") as HTMLElement).hidden).toBe(true);
    expect((v.el.querySelector(".spd-body") as HTMLElement).hidden).toBe(false);

    // One row per layer, Z-order top-first, with the device-authored names.
    const rows = Array.from(v.el.querySelectorAll(".spd-layer"));
    expect(rows.map((r) => r.querySelector(".spd-layer__name")!.textContent)).toEqual([
      "Layer 4",
      "Layer 3",
      "Layer 1",
      "Reference Layer",
    ]);
    // The authored-hidden layer starts toggled off; the rest on.
    const pressed = rows.map((r) => r.querySelector(".spd-layer__eye")!.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["true", "true", "false", "true"]);
    // …and each canvas's initial style mirrors the authored state.
    const views = seamOf(v).layerViews();
    expect(views.map((lv) => lv.canvas.style.display)).toEqual(["", "", "none", ""]);
    expect(views[2]!.canvas.style.opacity).toBe(String(76 / 255)); // hidden layer 1 @76
    v.destroy();
  });

  it("decodes one bitmap per tile, drawing then closing each (4 across the layers)", async () => {
    const { v, decodeTile, bitmaps } = mount();
    v.open(meta(), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    // Layer 4 has 2 tiles, layer 3 one, layer 1 one, 9999 none → 4 decodes.
    expect(decodeTile).toHaveBeenCalledTimes(4);
    // Each tile is drawn once onto its layer canvas, then released — no bitmap is
    // kept alive past the draw (the pixels live on the canvas).
    expect(bitmaps.length).toBe(4);
    for (const b of bitmaps) expect(b.close).toHaveBeenCalledTimes(1);
    v.destroy();
  });

  it("the Layers button opens the panel with the toolbar's active state", async () => {
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
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
    v.open(meta(), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    const head = v.el.querySelector(".spd-layers__head")!;
    // A decorative icon (aria-hidden) THEN the label, kept in its own <span> so the
    // title text stays a clean text node.
    const icon = head.querySelector(".spd-layers__head-ic")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.querySelector("svg")).not.toBeNull();
    const label = head.querySelector("span:not(.spd-layers__head-ic)")!;
    expect(label.textContent).toBe("Layers");
    v.destroy();
  });

  it("an eye toggle flips its state AND hides the matching layer canvas", async () => {
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    const firstEye = v.el.querySelector(".spd-layer__eye") as HTMLButtonElement;
    const topCanvas = seamOf(v).layerViews()[0]!.canvas; // Layer 4
    expect(firstEye.getAttribute("aria-pressed")).toBe("true");
    expect(topCanvas.style.display).toBe("");

    firstEye.click();
    expect(firstEye.getAttribute("aria-pressed")).toBe("false");
    expect(firstEye.closest(".spd-layer")!.classList.contains("is-hidden")).toBe(true);
    // The seam actually toggled the canvas + the current state.
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
    v.open(meta(), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    // Row 1 is Layer 3 (Z-order 4,3,1,9999), authored opacity 128/255 → 50%.
    const b3 = barOf(v, 1);
    const view3 = seamOf(v).layerViews().find((lv) => lv.layer.id === 3)!;
    expect(b3.pct.textContent).toBe("50%");
    expect(b3.bar.getAttribute("aria-valuenow")).toBe("50");
    expect(b3.fill.style.width).toBe("50%");

    // ArrowRight nudges up 1% — the fill WIDTH, the readout, the ARIA value and
    // the live canvas all move together.
    b3.bar.dispatchEvent(key("ArrowRight"));
    expect(b3.pct.textContent).toBe("51%");
    expect(b3.fill.style.width).toBe("51%");
    expect(b3.bar.getAttribute("aria-valuenow")).toBe("51");
    expect(view3.current.opacity).toBeCloseTo(0.51, 6);
    expect(view3.canvas.style.opacity).toBe("0.51"); // pushed live through the seam.

    b3.bar.dispatchEvent(key("ArrowLeft"));
    b3.bar.dispatchEvent(key("ArrowLeft"));
    expect(b3.pct.textContent).toBe("49%");
    expect(view3.current.opacity).toBeCloseTo(0.49, 6);

    // Home/End jump straight to the bounds.
    b3.bar.dispatchEvent(key("Home"));
    expect(b3.pct.textContent).toBe("0%");
    expect(b3.fill.style.width).toBe("0%");
    expect(view3.current.opacity).toBe(0);
    b3.bar.dispatchEvent(key("End"));
    expect(b3.pct.textContent).toBe("100%");
    expect(view3.current.opacity).toBe(1);

    // Clamp at the top: Layer 4 starts at 100%, so ArrowRight is a silent no-op.
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
    v.open(meta(), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    const b3 = barOf(v, 1); // Layer 3 @ 50%
    const view3 = seamOf(v).layerViews().find((lv) => lv.layer.id === 3)!;
    // happy-dom has no layout, so give the track a real box: left 100, width 200.
    b3.bar.getBoundingClientRect = () =>
      ({ left: 100, width: 200, top: 0, right: 300, bottom: 6, height: 6, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    // Press 75% across the track → 75%.
    b3.bar.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 100 + 0.75 * 200, bubbles: true }));
    expect(b3.pct.textContent).toBe("75%");
    expect(b3.fill.style.width).toBe("75%");
    expect(view3.current.opacity).toBeCloseTo(0.75, 6);

    // A move while held keeps steering (down to 25%), even off the thin bar.
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 + 0.25 * 200 }));
    expect(b3.pct.textContent).toBe("25%");
    expect(view3.current.opacity).toBeCloseTo(0.25, 6);

    // Release ends the drag: a later move no longer steers.
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 + 0.9 * 200 }));
    expect(b3.pct.textContent).toBe("25%");
    v.destroy();
  });

  it("a hidden layer's opacity bar is disabled + out of the tab order; the eye enables/disables it", async () => {
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    // Layer 1 is authored-hidden → its bar starts dimmed, aria-disabled, untabbable.
    const b1 = barOf(v, 2);
    expect(b1.barwrap.classList.contains("is-disabled")).toBe(true);
    expect(b1.bar.getAttribute("aria-disabled")).toBe("true");
    expect(b1.bar.hasAttribute("tabindex")).toBe(false);
    // Keyboard is inert while hidden (opacity is meaningless on an invisible layer).
    const view1 = seamOf(v).layerViews().find((lv) => lv.layer.id === 1)!;
    const before = view1.current.opacity;
    b1.bar.dispatchEvent(key("ArrowRight"));
    expect(view1.current.opacity).toBe(before);

    // A shown layer starts enabled + tabbable; toggling its eye off disables the bar…
    const b4 = barOf(v, 0);
    expect(b4.barwrap.classList.contains("is-disabled")).toBe(false);
    expect(b4.bar.getAttribute("tabindex")).toBe("0");
    b4.eye.click();
    expect(b4.barwrap.classList.contains("is-disabled")).toBe(true);
    expect(b4.bar.hasAttribute("tabindex")).toBe(false);
    // …and toggling it back on re-enables it.
    b4.eye.click();
    expect(b4.barwrap.classList.contains("is-disabled")).toBe(false);
    expect(b4.bar.getAttribute("tabindex")).toBe("0");

    // Revealing the authored-hidden layer likewise re-enables its bar.
    b1.eye.click();
    expect(b1.barwrap.classList.contains("is-disabled")).toBe(false);
    expect(b1.bar.getAttribute("tabindex")).toBe("0");
    v.destroy();
  });

  it("gives each non-blank layer a thumbnail canvas; the empty Reference Layer gets none", async () => {
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    // Layers 4/3/1 have tiles → a <canvas> thumb each; the empty 9999 gets a blank box.
    expect(v.el.querySelectorAll("canvas.spd-layer__thumb").length).toBe(3);
    const blank = Array.from(v.el.querySelectorAll(".spd-layer__thumb--blank"));
    expect(blank.length).toBe(1);
    expect(blank[0]!.tagName).not.toBe("CANVAS");
    // Every row carries exactly one thumbnail slot (canvas or blank box).
    for (const row of Array.from(v.el.querySelectorAll(".spd-layer"))) {
      expect(row.querySelectorAll(".spd-layer__thumb").length).toBe(1);
    }
    v.destroy();
  });

  it("mints every layer thumbnail at ONE height with the drawing's own aspect (capped at 2.5×)", async () => {
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
    await until(() => v.el.querySelectorAll(".spd-layer").length > 0);

    // Height is design (one shared backing height per panel); aspect is data —
    // the backing width follows the drawing's shape, clamped at 2.5× the height
    // so a pathological aspect letterboxes instead of wrecking the row.
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
    // The blank Reference Layer has no canvas; its empty frame carries the same
    // aspect inline so the box matches its siblings' shape. Serializations
    // differ ("0.38" vs "0.38 / 1"), so evaluate the ratio rather than the text.
    const blank = v.el.querySelector(".spd-layer__thumb--blank") as HTMLElement;
    const parts = blank.style.aspectRatio.split("/").map((s) => Number(s.trim()));
    const ratio = parts.length === 2 ? parts[0]! / parts[1]! : parts[0]!;
    expect(ratio).toBeCloseTo(expected, 4);
    v.destroy();
  });

  it("setLayerVisible / setLayerOpacity mutate the target canvas and its current state", async () => {
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    const seam = seamOf(v);
    const view3 = seam.layerViews().find((lv) => lv.layer.id === 3)!;

    seam.setLayerVisible(3, false);
    expect(view3.canvas.style.display).toBe("none");
    expect(view3.current.visible).toBe(false);

    seam.setLayerOpacity(3, 0.5);
    expect(view3.canvas.style.opacity).toBe("0.5");
    expect(view3.current.opacity).toBe(0.5);

    // Opacity is clamped to 0..1.
    seam.setLayerOpacity(3, 2);
    expect(view3.current.opacity).toBe(1);
    seam.setLayerOpacity(3, -1);
    expect(view3.current.opacity).toBe(0);

    // An unknown id is a no-op (does not throw).
    expect(() => seam.setLayerVisible(424242, false)).not.toThrow();
    v.destroy();
  });

  it("exportModel snapshots bottom-to-top with authored vs current and base dims", async () => {
    const { v } = mount();
    // Nothing loaded yet → null.
    expect(seamOf(v).exportModel()).toBeNull();

    v.open(meta(), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    const seam = seamOf(v);

    // Tune before exporting: dim the top layer, reveal the hidden one.
    seam.setLayerOpacity(4, 0.5);
    seam.setLayerVisible(1, true);

    const model = seam.exportModel()!;
    expect({ width: model.width, height: model.height }).toEqual({ width: BASE.w, height: BASE.h });
    // BOTTOM-to-TOP: the reverse of layerViews (4,3,1,9999).
    expect(model.layers.map((l) => l.id)).toEqual([9999, 1, 3, 4]);
    // Each carries its own layer canvas (the thumbnail/flatten source).
    for (const l of model.layers) expect(l.canvas).toBeInstanceOf(HTMLCanvasElement);

    const top = model.layers.find((l) => l.id === 4)!;
    // authored is the source `.spd` state (opacity 255 → 1, visible), untouched by tuning.
    expect(top.authored).toEqual({ opacity: 1, visible: true });
    // current reflects the live tuning.
    expect(top.current).toEqual({ opacity: 0.5, visible: true });

    const hidden = model.layers.find((l) => l.id === 1)!;
    expect(hidden.authored).toEqual({ opacity: 76 / 255, visible: false });
    expect(hidden.current).toEqual({ opacity: 76 / 255, visible: true });
    v.destroy();
  });

  it("current resets to authored on each open (view-only, not persisted)", async () => {
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    seamOf(v).setLayerOpacity(4, 0.25);
    seamOf(v).setLayerVisible(4, false);
    expect(seamOf(v).layerViews()[0]!.current).toEqual({ opacity: 0.25, visible: false });

    // Re-open the same file: current is rebuilt from authored, tuning is dropped.
    v.open(meta(), 0, FOLDER, "");
    await until(() => stackCanvases(v).length > 0);
    expect(seamOf(v).layerViews()[0]!.current).toEqual({ opacity: 1, visible: true });
    v.destroy();
  });

  it("hide() drops every layer canvas and empties the wrapper", async () => {
    const { v } = mount();
    v.open(meta(), 0, FOLDER, "");
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
    v.open(meta(), 0, FOLDER, "");
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
    v.open(meta(), 0, FOLDER, "");
    await until(() => onSessionExpired.mock.calls.length > 0);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    v.destroy();
  });
});
