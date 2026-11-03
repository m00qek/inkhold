// The `.note` reader's layer glue: SNPG v2 payload + `PageLayer[]` to the shared
// layers panel and layered export. The focused page becomes a stack of
// per-layer canvases decoded by `decode_layer`; any failure returns null and the
// reader falls back to the single composite.

import { LAYER_SLOTS, type Id, type LayerSlot, type PageLayer, type Theme } from "../core/types";
import type { PanelLayer } from "./layersPanel";
import type { ExportWhich, LayeredExportModel } from "../export/layered";
import { filenameStem } from "../export/exporter";
import { drawDownscaledInto } from "../render/thumbnails";
import { templatePlacement, type TemplateProvider } from "../render/template";
import {
  browserLoader,
  decodeLayerWithExports,
  type DecoderExports,
  type RawDecoded,
} from "../render/wasm";

// ---- pure core (no DOM, no wasm) ----

export interface SnpgRecord {
  slot: LayerSlot;
  /** Flag bit1: excluded from the default composite. */
  hidden: boolean;
  /**
   * Flag bit2: an image background. `data` is then the template asset hash (not
   * RLE), drawn via `GET /note/{id}/template/{hash}`, never `decode_layer`.
   */
  rasterImage: boolean;
  data: Uint8Array;
}

export interface SnpgEnumeration {
  records: SnpgRecord[];
  width: number;
  height: number;
}

const FLAG_HIDDEN = 0b10; // bit1
const FLAG_RASTER_IMAGE = 0b100; // bit2

/**
 * Enumerate a payload's records via the wasm (the one SNPG parser lives in Zig).
 * Null for anything the stack cannot present, or a module without the enumerator.
 */
export function enumerateSnpg(wasm: DecoderExports, bytes: Uint8Array): SnpgEnumeration | null {
  const {
    snpg_enumerate: enumerate,
    snpg_width: widthOf,
    snpg_height: heightOf,
    snpg_record_slot: slotOf,
    snpg_record_flags: flagsOf,
    snpg_record_hash_ptr: hashPtrOf,
    snpg_record_hash_len: hashLenOf,
  } = wasm;
  if (
    typeof enumerate !== "function" ||
    typeof widthOf !== "function" ||
    typeof heightOf !== "function" ||
    typeof slotOf !== "function" ||
    typeof flagsOf !== "function" ||
    typeof hashPtrOf !== "function" ||
    typeof hashLenOf !== "function"
  ) {
    return null; // an older cached module without the enumerator
  }

  const inPtr = wasm.alloc(bytes.length);
  if (inPtr === 0) return null;
  new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
  const count = enumerate.call(wasm, inPtr, bytes.length);
  wasm.free(inPtr, bytes.length);
  if (count < 0) return null;

  const records: SnpgRecord[] = [];
  for (let i = 0; i < count; i++) {
    const slot = LAYER_SLOTS[slotOf.call(wasm, i)];
    if (slot === undefined) return null; // guarded, though Zig already rejected it
    const flags = flagsOf.call(wasm, i);
    const hashLen = hashLenOf.call(wasm, i);
    // Copy out now: the wasm's static buffer is reused by the next enumerate.
    const data =
      hashLen > 0
        ? new Uint8Array(wasm.memory.buffer, hashPtrOf.call(wasm, i), hashLen).slice()
        : new Uint8Array(0);
    records.push({
      slot,
      hidden: (flags & FLAG_HIDDEN) !== 0,
      rasterImage: (flags & FLAG_RASTER_IMAGE) !== 0,
      data,
    });
  }
  return { records, width: widthOf.call(wasm), height: heightOf.call(wasm) };
}

/** A wire record paired with its `LayerVO`; `index` (wire order, bottom-to-top) is the per-page id. */
export interface PairedLayer {
  index: number;
  record: SnpgRecord;
  vo: PageLayer;
}

/**
 * Pair records with `layers` by slot, not position, so a server ordering bug
 * degrades visibly (null) instead of mislabelling the panel.
 */
export function pairLayers(records: readonly SnpgRecord[], vos: readonly PageLayer[]): PairedLayer[] | null {
  if (records.length !== vos.length || records.length === 0) return null;
  const bySlot = new Map<LayerSlot, PageLayer>();
  for (const vo of vos) {
    if (bySlot.has(vo.slot)) return null;
    bySlot.set(vo.slot, vo);
  }
  const out: PairedLayer[] = [];
  for (const [index, record] of records.entries()) {
    const vo = bySlot.get(record.slot);
    if (!vo) return null;
    out.push({ index, record, vo });
  }
  return out;
}

/**
 * Wire positions of the records carrying visible ink, for flattening an overlay
 * (a `.mark` over a PDF). Drops the background slot (the document is the paper),
 * raster-image backgrounds and device-hidden records.
 */
export function inkRecordIndices(records: readonly SnpgRecord[]): number[] {
  return records.flatMap((r, i) =>
    r.slot === "background" || r.rasterImage || r.hidden ? [] : [i],
  );
}

/** Fallback names matching the device's own defaults. */
export const SLOT_NAMES: Record<LayerSlot, string> = {
  main: "Main Layer",
  layer1: "Layer 1",
  layer2: "Layer 2",
  layer3: "Layer 3",
  background: "Background Layer",
};

export function layerDisplayName(vo: PageLayer): string {
  return vo.name || SLOT_NAMES[vo.slot];
}

/** One live layer; `visible` is view-only, seeded from the device's `vo.visible`. */
export interface NoteLayerView {
  index: number;
  slot: LayerSlot;
  name: string;
  /** Device-authored visibility: the export's `original` state. */
  authoredVisible: boolean;
  isCurrent: boolean;
  /** Live panel state: the export's `current` state. */
  visible: boolean;
  canvas: HTMLCanvasElement;
}

/** Top-first for the panel, with no `opacity` because `.note` layers have none. */
export function toPanelLayers(views: readonly NoteLayerView[]): PanelLayer[] {
  return [...views]
    .reverse()
    .map((v): PanelLayer => ({ id: v.index, name: v.name, visible: v.visible }));
}

/**
 * One `ExportLayer` per record, bottom-to-top, opacity 1 in both states. A
 * device-hidden layer is present but invisible in an "original" ORA. `canvases`
 * substitutes freshly decoded light-theme canvases by position.
 */
export function buildNoteExportModel(
  width: number,
  height: number,
  views: readonly NoteLayerView[],
  canvases?: readonly HTMLCanvasElement[],
): LayeredExportModel {
  return {
    width,
    height,
    layers: views.map((v, i) => ({
      id: v.index,
      name: v.name,
      canvas: canvases?.[i] ?? v.canvas,
      authored: { opacity: 1, visible: v.authoredVisible },
      current: { opacity: 1, visible: v.visible },
    })),
  };
}

/** `<stem>_p<page>_<which>.<ext>`, using the exporter's sanitiser. */
export function noteLayerExportFilename(
  noteName: string,
  pageIndex: number,
  which: ExportWhich,
  ext: "png" | "ora" | "pdf",
): string {
  return `${filenameStem(noteName)}_p${pageIndex + 1}_${which}.${ext}`;
}

// ---- panel thumbnail ----

/** Backing height, ~2× the CSS box for retina. */
const THUMB_H = 202;
const THUMB_MAX_ASPECT = 2.5;

/** A layer's own canvas scaled onto a sheet; drawn from pixels in hand, never re-decoded. */
export function buildNoteLayerThumb(view: NoteLayerView): HTMLElement {
  const cw = view.canvas.width;
  const ch = view.canvas.height;
  const aspect = cw > 0 && ch > 0 ? Math.min(cw / ch, THUMB_MAX_ASPECT) : 3 / 4;
  const thumb = document.createElement("canvas");
  thumb.setAttribute("aria-hidden", "true");
  const thumbW = Math.max(1, Math.round(THUMB_H * aspect));
  thumb.width = thumbW;
  thumb.height = THUMB_H;
  const ctx = thumb.getContext("2d"); // null in happy-dom
  if (ctx && cw > 0 && ch > 0) {
    ctx.fillStyle = "#ffffff"; // notes always paint on white paper (see wasm.ts)
    ctx.fillRect(0, 0, thumbW, THUMB_H);
    // Shared quality downscale: a single bilinear step at ~9× drops thin template lines.
    const scale = Math.min(thumbW / cw, THUMB_H / ch);
    const dw = Math.max(1, Math.round(cw * scale));
    const dh = Math.max(1, Math.round(ch * scale));
    const dx = Math.round((thumbW - dw) / 2);
    const dy = Math.round((THUMB_H - dh) / 2);
    void drawDownscaledInto(ctx, view.canvas, dw, dh, dx, dy);
  }
  return thumb;
}

// ---- stack controller (DOM + wasm) ----

export interface NoteLayerStack {
  width: number;
  height: number;
  views: NoteLayerView[];
}

export interface NoteLayersControllerOptions {
  wasmUrl?: string;
  loader?: () => Promise<DecoderExports>;
  /** Image-template fetch (memoized per hash); absent, an image background is blank. */
  getTemplate?: TemplateProvider;
  /**
   * What the stack sits on. Default white, since in the reader the stack replaces
   * the composite's paper; pass `null` for an overlay (the PDF `.mark`), where
   * white would hide the document.
   */
  backdrop?: string | null;
}

export interface NoteLayersController {
  /** Mounted once inside the reader's `.page`, above the composite canvas. */
  el: HTMLElement;
  /** Null on any failure, so the caller paints the composite. Repeat `(key, theme)` is free. */
  present(
    noteId: Id,
    key: string,
    bytes: ArrayBuffer,
    vos: PageLayer[],
    theme: Theme,
  ): Promise<NoteLayerStack | null>;
  isPresented(key: string, theme: Theme): boolean;
  stack(): NoteLayerStack | null;
  setVisible(index: number, visible: boolean): void;
  /** A fresh light-theme export model; call `release()` once the export is done. */
  exportModel(): Promise<{ model: LayeredExportModel; release: () => void } | null>;
  /**
   * One page's ink, flattened into a `dst`-sized canvas for a thumbnail. Outside
   * `present` so a filmstrip never evicts the mounted page; shares the decoder
   * instance. Drops the same records as `inkRecordIndices`. The canvas is the
   * caller's to free.
   */
  inkRaster(bytes: ArrayBuffer, dst: { width: number; height: number }): Promise<HTMLCanvasElement | null>;
  release(): void;
}

/** Zero a canvas's backing store, freeing ~10 MB eagerly rather than at GC. */
function zeroCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function layerCanvas(raw: RawDecoded): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = raw.width;
  canvas.height = raw.height;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.putImageData(new ImageData(raw.rgba, raw.width, raw.height), 0, 0);
  return canvas;
}

export function createNoteLayersController(opts: NoteLayersControllerOptions = {}): NoteLayersController {
  const load = opts.loader ?? browserLoader(opts.wasmUrl ?? "/note-decode.wasm");
  const getTemplate = opts.getTemplate;
  const backdrop = opts.backdrop === undefined ? "#fff" : opts.backdrop;
  let exportsPromise: Promise<DecoderExports> | null = null;
  const decoder = (): Promise<DecoderExports> => (exportsPromise ??= load());

  const host = document.createElement("div");
  host.className = "note-stack";
  host.hidden = true;

  let current: NoteLayerStack | null = null;
  let currentKey: string | null = null;
  let currentTheme: Theme | null = null;
  /** Kept for `exportModel`'s fresh light decode (small next to the stack's RGBA). */
  let currentBytes: Uint8Array | null = null;
  let currentNoteId: Id | null = null;
  let currentPaired: PairedLayer[] | null = null;
  let currentDims: { width: number; height: number } | null = null;
  let gen = 0;

  function release(): void {
    gen++;
    host.replaceChildren();
    host.hidden = true;
    if (current) for (const v of current.views) zeroCanvas(v.canvas);
    current = null;
    currentKey = null;
    currentTheme = null;
    currentBytes = null;
    currentNoteId = null;
    currentPaired = null;
    currentDims = null;
  }

  /** The template contain-placed on the page; blank if unfetchable. */
  async function templateLayerCanvas(
    noteId: Id,
    hash: string,
    dims: { width: number; height: number },
  ): Promise<HTMLCanvasElement> {
    const canvas = document.createElement("canvas");
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext("2d");
    const tmpl = getTemplate ? await getTemplate(noteId, hash) : null;
    if (ctx && tmpl) {
      const p = templatePlacement(dims.width, dims.height, tmpl.width, tmpl.height);
      if (p.w > 0 && p.h > 0) ctx.drawImage(tmpl, p.x, p.y, p.w, p.h);
    }
    return canvas;
  }

  /** One canvas per record, in wire order, always in the light world. */
  async function buildCanvases(
    wasm: DecoderExports,
    u8: Uint8Array,
    paired: PairedLayer[],
    dims: { width: number; height: number },
    noteId: Id,
  ): Promise<HTMLCanvasElement[]> {
    const out: HTMLCanvasElement[] = [];
    for (const p of paired) {
      if (p.record.rasterImage) {
        out.push(await templateLayerCanvas(noteId, new TextDecoder().decode(p.record.data), dims));
      } else {
        const raw = decodeLayerWithExports(wasm, u8, p.index);
        out.push(layerCanvas(raw));
      }
    }
    return out;
  }

  return {
    el: host,

    isPresented(key: string, theme: Theme): boolean {
      return current !== null && currentKey === key && currentTheme === theme;
    },

    stack(): NoteLayerStack | null {
      return current;
    },

    async present(
      noteId: Id,
      key: string,
      bytes: ArrayBuffer,
      vos: PageLayer[],
      theme: Theme,
    ): Promise<NoteLayerStack | null> {
      if (this.isPresented(key, theme)) return current;
      const my = ++gen;
      try {
        const u8 = new Uint8Array(bytes);

        const wasm = await decoder();
        if (my !== gen) return null; // superseded while the wasm loaded
        if (typeof wasm.decode_layer !== "function") return null; // stale module

        const enumerated = enumerateSnpg(wasm, u8);
        if (!enumerated) return null;
        const { records } = enumerated;
        const paired = pairLayers(records, vos);
        if (!paired) return null;
        const dims = { width: enumerated.width, height: enumerated.height };

        const canvases = await buildCanvases(wasm, u8, paired, dims, noteId);
        if (my !== gen) return null; // superseded while a template loaded
        const views = paired.map(
          (p, i): NoteLayerView => ({
            index: p.index,
            slot: p.record.slot,
            name: layerDisplayName(p.vo),
            authoredVisible: p.vo.visible,
            isCurrent: p.vo.isCurrent,
            visible: p.vo.visible, // device-authored start; hidden toggles ON instantly
            canvas: canvases[i]!,
          }),
        );

        // `release` bumps `gen`, so re-own it.
        release();
        gen = my;
        current = { width: dims.width, height: dims.height, views };
        currentKey = key;
        currentTheme = theme;
        currentBytes = u8;
        currentNoteId = noteId;
        currentPaired = paired;
        currentDims = dims;
        host.style.background = backdrop ?? "";
        for (const v of views) {
          v.canvas.style.display = v.visible ? "" : "none";
          host.append(v.canvas); // wire order; later siblings paint on top
        }
        host.hidden = false;
        return current;
      } catch {
        if (my === gen) release();
        return null;
      }
    },

    setVisible(index: number, visible: boolean): void {
      const v = current?.views.find((x) => x.index === index);
      if (!v) return;
      v.visible = visible;
      v.canvas.style.display = visible ? "" : "none";
    },

    async exportModel(): Promise<{ model: LayeredExportModel; release: () => void } | null> {
      if (!current || !currentBytes || !currentPaired || !currentDims || currentNoteId === null) return null;
      const stack = current;
      const bytes = currentBytes;
      const wasm = await decoder();
      // Exports carry the authored light pixels (as does every on-screen render).
      // An image background is redrawn from its template.
      const canvases = await buildCanvases(wasm, bytes, currentPaired, currentDims, currentNoteId);
      return {
        model: buildNoteExportModel(stack.width, stack.height, stack.views, canvases),
        release: () => canvases.forEach(zeroCanvas),
      };
    },

    async inkRaster(
      bytes: ArrayBuffer,
      dst: { width: number; height: number },
    ): Promise<HTMLCanvasElement | null> {
      const w = Math.max(1, Math.round(dst.width));
      const h = Math.max(1, Math.round(dst.height));
      let out: HTMLCanvasElement | null = null;
      try {
        const wasm = await decoder();
        if (typeof wasm.decode_layer !== "function") return null;
        const u8 = new Uint8Array(bytes);
        const enumerated = enumerateSnpg(wasm, u8);
        if (!enumerated) return null;
        out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        const ctx = out.getContext("2d"); // null in happy-dom
        if (!ctx) {
          zeroCanvas(out);
          return null;
        }
        const ink = inkRecordIndices(enumerated.records);
        if (ink.length === 0) {
          zeroCanvas(out);
          return null;
        }
        for (const index of ink) {
          // One layer resident at a time: decoding them all first would be
          // ~40 MB of canvas for a 120 px picture.
          const full = layerCanvas(decodeLayerWithExports(wasm, u8, index));
          // Shared quality downscale; a ~15× bilinear step would drop thin strokes.
          await drawDownscaledInto(ctx, full, w, h, 0, 0);
          zeroCanvas(full);
        }
        return out;
      } catch {
        if (out) zeroCanvas(out);
        return null;
      }
    },

    release,
  };
}
