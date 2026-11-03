// @vitest-environment happy-dom
// Helpers shared by the spdViewer tests.

import { vi } from "vitest";
import { type SpdDecoderExports } from "../../src/render/spdDecode";
import { type SpdViewerSeam } from "../../src/pages/spdViewer";
import type { ViewerDeps, ReaderOrigin } from "../../src/pages/viewer";
import type { NoteMeta } from "../../src/core/types";
import { synthesizeSummary } from "../../src/pages/library";

// --- a fake decoder that speaks the real C-ABI ------------------------------

export interface FakeTile { tx: number; ty: number; png: number[]; }

export interface FakeLayer { id: number; name: string; visible: boolean; opacity: number; tiles: FakeTile[]; }

export interface FakeSpec { width: number; height: number; layers: FakeLayer[]; openRc?: number; }

export interface FakeCalls {
  open: number;
  close: number;
  free: Array<[number, number]>;
  alloc: number[];
}

export function makeFakeDecoder(spec: FakeSpec): { exports: SpdDecoderExports; calls: FakeCalls } {
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
export const SAMPLE: FakeSpec = {
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
export const BASE = { w: 8 * 128, h: 21 * 128 };

export function deps(over: Partial<ViewerDeps> = {}): ViewerDeps {
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

export function meta(over: Partial<NoteMeta> = {}): NoteMeta {
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

export const FOLDER: ReaderOrigin = { kind: "folder", folderPath: "Note / Files" };

/** A fake `createImageBitmap` result the canvas can (attempt to) draw + we close. */
export function fakeBitmap(): { close: ReturnType<typeof vi.fn> } {
  return { width: 128, height: 128, close: vi.fn() } as unknown as { close: ReturnType<typeof vi.fn> };
}

/** The internal test seam the viewer hangs off the returned object. */
export function seamOf(v: { el: HTMLElement }): SpdViewerSeam {
  return (v as unknown as { _spdSeam: SpdViewerSeam })._spdSeam;
}

/** Every layer canvas in stack (DOM) order — bottom-to-top. */
export function stackCanvases(v: { el: HTMLElement }): HTMLCanvasElement[] {
  return Array.from(v.el.querySelectorAll<HTMLCanvasElement>(".spd-canvas-wrap .spd-layer-canvas"));
}

export async function until(pred: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error("condition not met in time");
}
