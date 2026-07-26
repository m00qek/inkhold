// The `.note` reader's LAYER glue — everything between the wire (a page's
// `PageLayer[]` off `NoteMetaVO` + the SNPG v2 payload) and the two shared
// components the `.spd` viewer already feeds: the layers panel
// (pages/layersPanel.ts) and the layered-export core (export/layered.ts). The
// decision record is docs/scratch/archive/note-layers-panel.md: per-layer decode with
// stacked canvases (the `.spd` mechanism), identity by SLOT, view-only tuning.
//
// THE RENDER MODEL. The focused page becomes a stack of per-layer canvases,
// one per SNPG record in wire order (bottom-to-top; DOM order does the
// stacking), each decoded by the wasm's `decode_layer` — transparent (0xff)
// pixels arrive with alpha 0, so the browser compositor blends the stack
// exactly as `decode_page` composites internally. Visibility is
// `style.display`, mirroring spdViewer; a toggle costs no decode. The canvases
// are BASE resolution (the payload's own dims, ~10.5 MB RGBA each), which is
// affordable for THE focused page only — filmstrip/thumbnails/neighbours stay
// on the composite path, by scope pin.
//
// DEGRADE, NEVER BREAK. Every checkpoint that can fail — a v1/hostile payload,
// a slot mismatch between records and the VO list, a missing `decode_layer`
// export, a decode error — returns null and the reader falls back to today's
// single-composite paint. A wrong panel is worse than no panel.
//
// THEME. On-screen canvases get the same dark-mode treatment as the composite
// (invert RGB, keep alpha; the stack backdrop flips white→black). EXPORTS are
// decoded fresh in light form — `exportModel()` re-decodes from the presented
// payload — matching `exporter.ts`, whose PNG/PDF always export the authored
// light pixels regardless of the theme on screen.

import { LAYER_SLOTS, type Id, type LayerSlot, type PageLayer, type Theme } from "../core/types";
import type { PanelLayer } from "./layersPanel";
import type { ExportWhich, LayeredExportModel } from "../export/layered";
import { filenameStem } from "../export/exporter";
import { drawDownscaledInto } from "../render/thumbnails";
import { templatePlacement, type TemplateProvider } from "../render/template";
import {
  browserLoader,
  decodeLayerWithExports,
  invertRgb,
  type DecoderExports,
  type RawDecoded,
} from "../render/wasm";

// ============================================================================
// The pure core — no DOM, no wasm. Unit-tested (tests/unit/noteLayers.test.ts).
// ============================================================================

/** One SNPG v2 record's identity, as the wasm `snpg_enumerate` hands it back. */
export interface SnpgRecord {
  slot: LayerSlot;
  /** bit1 of the record flags: excluded from the default composite. */
  hidden: boolean;
  /**
   * bit2 of the record flags: a browser-native IMAGE background. `data` is then
   * the asset HASH (not RLE), and this layer is drawn with `createImageBitmap`
   * from `GET /note/{id}/template/{hash}`, never `decode_layer`.
   */
  rasterImage: boolean;
  /** The asset hash for a `rasterImage` background; empty otherwise (an ordinary
   *  layer's pixels ride `decode_layer`, indexed by wire position — never here). */
  data: Uint8Array;
}

/** The enumerated records plus the page's effective dims. */
export interface SnpgEnumeration {
  records: SnpgRecord[];
  width: number;
  height: number;
}

const FLAG_HIDDEN = 0b10; // bit1
const FLAG_RASTER_IMAGE = 0b100; // bit2

/**
 * Enumerate an SNPG v2 payload's records via the wasm decoder — the ONE parser
 * of the wire format now lives in Zig (`page_payload.enumerateRecords`), so this
 * only marshals structured output: dims + each record's slot, flag bits and (for
 * an image background) its asset hash. `null` for anything the stacked panel
 * cannot present — a v1/foreign/truncated/over-claiming payload, an unknown slot,
 * a bad record count, trailing junk — or a wasm module too old to expose the
 * enumerator (feature-detected). No RLE is touched; pixels stay in `decode_layer`.
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
    // Copy the hash OUT of wasm memory now — the static buffer is reused by the
    // next enumerate, and this record is kept for `exportModel`.
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

/** One wire record married to its `LayerVO` — the unit everything downstream
 *  (panel row, canvas, export layer) is built from. `index` is the record's
 *  position in wire order (bottom-to-top), which is the stable per-page id. */
export interface PairedLayer {
  index: number;
  record: SnpgRecord;
  vo: PageLayer;
}

/**
 * Pair the payload's records with the noteMeta `layers` BY SLOT — the contract
 * both docs state outright ("pair by slot, not by position"). The two lists
 * come from the same index and agree in practice; pairing by slot is what
 * turns a server-side ordering bug into a visible degrade (null → composite)
 * instead of a silently mislabelled panel. `null` on any mismatch: different
 * lengths, a slot on one side only, or (already impossible past the seam's
 * validation) a duplicate.
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
 * What a slot is called when the device wrote no display name (`LAYERINFO`
 * absent or nameless). These match the device's own defaults — "Layer 3", the
 * background as "Background Layer" — so the panel never shows an internal id.
 */
export const SLOT_NAMES: Record<LayerSlot, string> = {
  main: "Main Layer",
  layer1: "Layer 1",
  layer2: "Layer 2",
  layer3: "Layer 3",
  background: "Background Layer",
};

/** A layer's display name: the device's own (`LAYERINFO`), else the slot default. */
export function layerDisplayName(vo: PageLayer): string {
  return vo.name || SLOT_NAMES[vo.slot];
}

/**
 * One layer of the live stack: the paired identity, that layer's own decoded
 * canvas, and the view-only `visible` the panel tunes (seeded from the
 * device-authored `vo.visible`; never persisted). The shape the panel feeder
 * and the export mapping both read.
 */
export interface NoteLayerView {
  index: number;
  slot: LayerSlot;
  /** Resolved display name (device name or slot default). */
  name: string;
  /** Device-authored visibility — the export's `original` state. */
  authoredVisible: boolean;
  isCurrent: boolean;
  /** Live panel state — the export's `current` state. Starts authored. */
  visible: boolean;
  canvas: HTMLCanvasElement;
}

/**
 * Feed the shared panel: TOP-first (reverse of wire order — the panel's
 * Z-order contract), id = wire record index, and deliberately NO `opacity`
 * field — that absence is what keeps the stepper off every row (`.note` has no
 * per-layer opacity; device-confirmed). Names are pre-resolved so the panel's
 * own `Layer <id>` fallback (an `.spd`-shaped default) never shows.
 */
export function toPanelLayers(views: readonly NoteLayerView[]): PanelLayer[] {
  return [...views]
    .reverse()
    .map((v): PanelLayer => ({ id: v.index, name: v.name, visible: v.visible }));
}

/**
 * The export snapshot for the shared layered core: one `ExportLayer` per wire
 * record, BOTTOM-to-TOP (= `views` order), opacity 1 in BOTH states (`.note`
 * has none), `authored.visible` the device's state and `current.visible` the
 * panel's live state. A device-hidden layer is therefore PRESENT in an
 * "original" ORA with its full pixels, marked invisible — the file's own
 * semantics. `width`/`height` are the PAYLOAD's effective dims, so a landscape
 * page exports 1872×1404 with no special case.
 *
 * `canvases` lets the caller substitute freshly decoded (light-theme) canvases
 * for the on-screen (possibly dark-inverted) ones — keyed by position.
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

/**
 * The layered exports' filename — spdExport's convention
 * (`<base>_<which>.<ext>`) with the 1-based page slotted in, since a `.note`
 * export is of ONE page: `Weekly review_p3_current.ora`. The stem is the
 * exporter's own sanitiser, so the two export families never disagree about
 * what a note is called on disk.
 */
export function noteLayerExportFilename(
  noteName: string,
  pageIndex: number,
  which: ExportWhich,
  ext: "png" | "ora" | "pdf",
): string {
  return `${filenameStem(noteName)}_p${pageIndex + 1}_${which}.${ext}`;
}

// ============================================================================
// The panel thumbnail — the one thing only the `.note` side knows about its
// layers' pixels, mirroring spdViewer's `buildThumb` (the shared panel sizes
// whatever comes back via `layers-panel__thumb`).
// ============================================================================

/** Backing height in device px — ~2× the CSS box (`--preview-h-panel`) for
 *  retina crispness; width follows the page's aspect, capped like the class. */
const THUMB_H = 202;
const THUMB_MAX_ASPECT = 2.5;

/**
 * A per-layer thumbnail: that layer's own decoded canvas scaled onto a page-
 * coloured sheet. The sheet follows the THEME because the layer pixels do — a
 * dark-inverted layer on a white sheet would be the one place the panel
 * disagreed with the page beside it. Drawn once per panel rebuild from pixels
 * already in hand; never re-decoded.
 */
export function buildNoteLayerThumb(view: NoteLayerView, theme: Theme): HTMLElement {
  const cw = view.canvas.width;
  const ch = view.canvas.height;
  const aspect = cw > 0 && ch > 0 ? Math.min(cw / ch, THUMB_MAX_ASPECT) : 3 / 4;
  const thumb = document.createElement("canvas");
  thumb.setAttribute("aria-hidden", "true");
  const thumbW = Math.max(1, Math.round(THUMB_H * aspect));
  thumb.width = thumbW;
  thumb.height = THUMB_H;
  const ctx = thumb.getContext("2d"); // null in happy-dom — the canvas still exists.
  if (ctx && cw > 0 && ch > 0) {
    ctx.fillStyle = theme === "dark" ? "#000000" : "#ffffff";
    ctx.fillRect(0, 0, thumbW, THUMB_H);
    // The ~9× reduction from a full-res (~1872-wide) layer canvas goes through
    // the SHARED quality downscale, not a single bilinear `drawImage` step that
    // skips source rows and drops/moirés a ruled template's thin lines. The
    // sheet fill above keeps the box stable until the async draw lands.
    const scale = Math.min(thumbW / cw, THUMB_H / ch);
    const dw = Math.max(1, Math.round(cw * scale));
    const dh = Math.max(1, Math.round(ch * scale));
    const dx = Math.round((thumbW - dw) / 2);
    const dy = Math.round((THUMB_H - dh) / 2);
    void drawDownscaledInto(ctx, view.canvas, dw, dh, dx, dy);
  }
  return thumb;
}

// ============================================================================
// The stack controller — the DOM/wasm half. Injectable loader; the reader
// falls back to the composite whenever `present` answers null.
// ============================================================================

/** A presented stack: the payload's effective dims + the live layer views. */
export interface NoteLayerStack {
  width: number;
  height: number;
  views: NoteLayerView[];
}

export interface NoteLayersControllerOptions {
  /** URL of the decoder wasm. Default `/note-decode.wasm` (the renderer's). */
  wasmUrl?: string;
  /** Override module loading (tests). Default fetches + instantiates `wasmUrl`. */
  loader?: () => Promise<DecoderExports>;
  /**
   * Fetch + decode a page's custom IMAGE template (memoized per hash). The
   * background layer of an image-template page is drawn from this rather than
   * `decode_layer`. Absent → an image background renders blank (the ink layers
   * still stack); wired from the Api by the reader.
   */
  getTemplate?: TemplateProvider;
}

export interface NoteLayersController {
  /** The stack host — mounted once inside the reader's `.page`, above the
   *  composite canvas. Hidden while no stack is presented. */
  el: HTMLElement;
  /**
   * Decode + mount the stack for the focused page. Returns the stack, or null
   * on ANY failure/mismatch — the caller then paints the composite. A repeat
   * call for the same `(key, theme)` is free (the stack is already up).
   */
  present(
    noteId: Id,
    key: string,
    bytes: ArrayBuffer,
    vos: PageLayer[],
    theme: Theme,
  ): Promise<NoteLayerStack | null>;
  /** Whether `(key, theme)` is exactly what is on screen — skip the refetch. */
  isPresented(key: string, theme: Theme): boolean;
  /** The live stack, or null. */
  stack(): NoteLayerStack | null;
  /** The panel's eye toggle: flip one layer's canvas. View-only, instant. */
  setVisible(index: number, visible: boolean): void;
  /**
   * A fresh LIGHT-theme export model decoded from the presented payload (the
   * on-screen canvases may be dark-inverted). Call `release()` when the export
   * has consumed the canvases. Null when no stack is up.
   */
  exportModel(): Promise<{ model: LayeredExportModel; release: () => void } | null>;
  /** Drop the stack and its canvases (page change, mode change, teardown). */
  release(): void;
}

/** Zero a canvas's backing store — frees ~10 MB eagerly rather than at GC. */
function zeroCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** Paint one decoded layer onto its own canvas (native payload resolution). */
function layerCanvas(raw: RawDecoded): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = raw.width;
  canvas.height = raw.height;
  const ctx = canvas.getContext("2d");
  // happy-dom/jsdom have no 2d context; the canvas still exists and sizes.
  if (ctx) ctx.putImageData(new ImageData(raw.rgba, raw.width, raw.height), 0, 0);
  return canvas;
}

export function createNoteLayersController(opts: NoteLayersControllerOptions = {}): NoteLayersController {
  const load = opts.loader ?? browserLoader(opts.wasmUrl ?? "/note-decode.wasm");
  const getTemplate = opts.getTemplate;
  let exportsPromise: Promise<DecoderExports> | null = null;
  const decoder = (): Promise<DecoderExports> => (exportsPromise ??= load());

  const host = document.createElement("div");
  host.className = "note-stack";
  host.hidden = true;

  let current: NoteLayerStack | null = null;
  let currentKey: string | null = null;
  let currentTheme: Theme | null = null;
  /** The presented payload, kept for `exportModel`'s fresh light decode — a
   *  few hundred KB against the stack's tens of MB of RGBA. */
  let currentBytes: Uint8Array | null = null;
  /** The presented note id + paired records + page dims — kept so `exportModel`
   *  can redraw an image background from its template. */
  let currentNoteId: Id | null = null;
  let currentPaired: PairedLayer[] | null = null;
  let currentDims: { width: number; height: number } | null = null;
  /** Bumps on every present/release; a superseded present discards itself. */
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

  /** An image-background layer's canvas: the template, contain-placed on the
   *  page rectangle (margins transparent — the host paints the paper). Blank
   *  when the template can't be fetched, so the ink layers still stack. */
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

  /** One canvas per paired record, in wire order: an image background from its
   *  template, every other layer from `decode_layer` (theme-inverted). */
  async function buildCanvases(
    wasm: DecoderExports,
    u8: Uint8Array,
    paired: PairedLayer[],
    theme: Theme,
    dims: { width: number; height: number },
    noteId: Id,
  ): Promise<HTMLCanvasElement[]> {
    const out: HTMLCanvasElement[] = [];
    for (const p of paired) {
      if (p.record.rasterImage) {
        out.push(await templateLayerCanvas(noteId, new TextDecoder().decode(p.record.data), dims));
      } else {
        const raw = decodeLayerWithExports(wasm, u8, p.index);
        if (theme === "dark") invertRgb(raw.rgba);
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

        // Enumeration now lives in the wasm decoder (the one SNPG parser); a
        // module too old to expose it, or a payload the panel can't present,
        // degrades to the composite.
        const enumerated = enumerateSnpg(wasm, u8);
        if (!enumerated) return null;
        const { records } = enumerated;
        const paired = pairLayers(records, vos);
        if (!paired) return null;
        const dims = { width: enumerated.width, height: enumerated.height };

        // A color image template opts out of the dark-mode invert — and so, for
        // consistency with the main viewer, does the whole page: an image-
        // background page presents in the LIGHT world regardless of theme.
        const hasImageBg = paired.some((p) => p.record.rasterImage);
        const effectiveTheme: Theme = hasImageBg ? "light" : theme;

        const canvases = await buildCanvases(wasm, u8, paired, effectiveTheme, dims, noteId);
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

        // Commit: replace whatever was up. `release` bumps `gen`, so re-own it.
        release();
        gen = my;
        current = { width: dims.width, height: dims.height, views };
        currentKey = key;
        currentTheme = theme;
        currentBytes = u8;
        currentNoteId = noteId;
        currentPaired = paired;
        currentDims = dims;
        // The stack backdrop is the page: white paper, black under dark's
        // inverted e-ink — the exact pixels `decode_page`'s composite base has.
        // An image-background page always shows white paper (it opted out).
        host.style.background = effectiveTheme === "dark" ? "#000" : "#fff";
        for (const v of views) {
          v.canvas.style.display = v.visible ? "" : "none";
          host.append(v.canvas); // wire order; later siblings paint on top
        }
        host.hidden = false;
        return current;
      } catch {
        // Any failure — decode error, OOM, hostile payload — degrades to the
        // composite. The reader repaints that path; nothing here to unwind
        // beyond making sure a half-built stack is not left mounted.
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
      // Always LIGHT: exports carry the authored pixels, never the screen theme.
      // An image background is redrawn from its template (never inverted).
      const canvases = await buildCanvases(wasm, bytes, currentPaired, "light", currentDims, currentNoteId);
      return {
        model: buildNoteExportModel(stack.width, stack.height, stack.views, canvases),
        release: () => canvases.forEach(zeroCanvas),
      };
    },

    release,
  };
}
