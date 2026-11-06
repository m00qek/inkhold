// The `.note` reader's layer stack: the focused page as per-layer canvases
// decoded by `decode_layer`, and each layer's panel thumbnail. Any failure
// returns null and the reader falls back to the single composite. What the
// layers are (records, pairing, names, export model) is `noteLayerModel.ts`.

import type { Id, PageLayer, Theme } from "../core/types";
import type { LayeredExportModel } from "../export/layered";
import { drawDownscaledInto } from "../render/thumbnails";
import { templatePlacement, type TemplateProvider } from "../render/template";
import {
  browserLoader,
  decodeLayerWithExports,
  type DecoderExports,
  type RawDecoded,
} from "../render/wasm";
import {
  buildNoteExportModel,
  enumerateSnpg,
  inkRecordIndices,
  layerDisplayName,
  pairLayers,
  type NoteLayerView,
  type PairedLayer,
} from "./noteLayerModel";

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
