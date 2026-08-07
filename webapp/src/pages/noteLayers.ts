// The `.note` reader's LAYER glue — everything between the wire (a page's
// `PageLayer[]` off `NoteMetaVO` + the SNPG v2 payload) and the two shared
// components the `.spd` viewer already feeds: the layers panel
// (pages/layersPanel.ts) and the layered-export core (export/layered.ts). The
// decision is: per-layer decode with
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
// on the composite path, by scope pin. The ONE exception is `inkRaster`, which a
// filmstrip does drive per page: it decodes a layer, reduces it and drops it
// before asking for the next, so it never holds a stack and never touches the
// one `present` has mounted. See its own note for why the two cannot share.
//
// DEGRADE, NEVER BREAK. Every checkpoint that can fail — a v1/hostile payload,
// a slot mismatch between records and the VO list, a missing `decode_layer`
// export, a decode error — returns null and the reader falls back to today's
// single-composite paint. A wrong panel is worse than no panel.
//
// THEME. On-screen canvases match the composite: notes always paint in the LIGHT
// world (dark ink on white paper), the app theme never inverts them, and the
// stack backdrop is white. EXPORTS are likewise the authored light pixels —
// `exportModel()` re-decodes from the presented payload — matching `exporter.ts`.

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
 * The wire positions of the records that carry INK a reader would see — the
 * input to any flattening of a page that is an OVERLAY on something else (a
 * `.mark` over the PDF it annotates), rather than a page in its own right.
 *
 * Three kinds of record are dropped, and each for a reason the screen already
 * states somewhere:
 *
 *  - the BACKGROUND slot, because over a PDF that layer is the device's paper
 *    and the document IS the paper. Compositing it is a second opaque sheet
 *    (`pdfViewer.ts`'s `suppressBackground` hides the same record on screen).
 *  - a RASTER-IMAGE background, which is a background by another route: its
 *    `data` is a template asset hash, not pixels, and it would need a fetch of
 *    its own to draw something that must not be drawn.
 *  - a DEVICE-HIDDEN record (wire flag bit1). `present` seeds each layer's
 *    visibility from the authored flag, so a hidden layer is not on the page —
 *    and a thumbnail that showed it would put strokes in the filmstrip that are
 *    nowhere in the document beside it.
 *
 * Pure, and separate from the decode, so "which layers is a mark's ink?" can be
 * asserted against a real payload without a canvas.
 */
export function inkRecordIndices(records: readonly SnpgRecord[]): number[] {
  return records.flatMap((r, i) =>
    r.slot === "background" || r.rasterImage || r.hidden ? [] : [i],
  );
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
export function buildNoteLayerThumb(view: NoteLayerView): HTMLElement {
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
    ctx.fillStyle = "#ffffff"; // notes always paint on white paper (see wasm.ts)
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
  /**
   * What the stack sits ON. Default `"#fff"` — the reader's case, where the
   * stack REPLACES the page render and therefore has to supply the paper that
   * `decode_page`'s composite base would have.
   *
   * Pass `null` when the stack is an OVERLAY on something else, as the PDF
   * viewer's `.mark` layer is: there the page underneath is the document, and a
   * white backdrop hides it completely. That failure is invisible in the reader
   * — white paper over white paper — so it is worth naming rather than leaving
   * to a caller to override after every `present`.
   */
  backdrop?: string | null;
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
  /**
   * ONE page's ink, small — the whole authored stack minus its paper, flattened
   * into a `dst`-sized canvas. For a THUMBNAIL, where the page it annotates is
   * 120px and a stack of full-resolution canvases is not on offer.
   *
   * DELIBERATELY OUTSIDE `present`. That call mounts the stack, holds ONE page
   * at a time and is what the screen is looking at; driving it per thumbnail
   * would evict the page the reader is on and re-decode it on the way back. This
   * decodes, downscales and throws the big pixels away — it touches no state the
   * screen owns, so a filmstrip and an open page can want different pages of the
   * same mark at once. It shares the decoder INSTANCE, which is the point: one
   * wasm module and one linear memory for the viewer, not two.
   *
   * WHAT IS DROPPED, and why it matches the page beside it: the BACKGROUND slot
   * (over a PDF that layer is the device's paper, and the document is the paper —
   * `pdfViewer.ts`'s `suppressBackground` says the same on screen) and any
   * DEVICE-HIDDEN record (`present` seeds visibility from the authored flag, so
   * showing one here would put ink in the strip that is not on the page).
   *
   * Null when there is nothing to draw: an unpresentable payload, a module too
   * old for `decode_layer`, no ink records, or no 2D context. The caller shows
   * the bare page — a missing overlay is not a broken thumbnail.
   *
   * The canvas is the CALLER'S to free (`width = 0`), like every other canvas
   * this module hands out.
   */
  inkRaster(bytes: ArrayBuffer, dst: { width: number; height: number }): Promise<HTMLCanvasElement | null>;
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
  const backdrop = opts.backdrop === undefined ? "#fff" : opts.backdrop;
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
   *  template, every other layer from `decode_layer`. Layers paint in the LIGHT
   *  world (see the composite renderer) — the app theme never inverts them. */
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

        // Enumeration now lives in the wasm decoder (the one SNPG parser); a
        // module too old to expose it, or a payload the panel can't present,
        // degrades to the composite.
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
        // The backdrop the CALLER asked for: white paper for a stack that IS
        // the page (the reader — matching the composite base `decode_page`
        // emits; notes never invert for dark, see wasm.ts), and none for a stack
        // laid OVER something, where paper would hide what it is annotating.
        host.style.background = backdrop ?? "";
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
        const ctx = out.getContext("2d"); // null in happy-dom — degrade, don't throw
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
          // ONE LAYER RESIDENT AT A TIME. A payload's layer is the panel's own
          // ~1404x1872 (10.5 MB of RGBA, and `layerCanvas` holds a second copy
          // while it blits), so the loop that `present` runs — decode them all,
          // then stack — is 40 MB of live canvas for a picture that
          // ends up 120 px wide. Each is reduced and released before the next is
          // asked for, which puts the peak at one layer whatever the page holds.
          const full = layerCanvas(decodeLayerWithExports(wasm, u8, index));
          // The SHARED quality downscale, for the reason it exists: this is a
          // ~15x reduction, and one bilinear `drawImage` step at that ratio skips
          // most source rows — it would drop the thinnest strokes outright and
          // moire the rest. `buildNoteLayerThumb` reduces the same pixels the
          // same way for the panel's own previews.
          await drawDownscaledInto(ctx, full, w, h, 0, 0);
          zeroCanvas(full);
        }
        return out;
      } catch {
        // A decode error, a hostile payload, an OOM: the page still stands on its
        // own, exactly as it does when `present` answers null.
        if (out) zeroCanvas(out);
        return null;
      }
    },

    release,
  };
}
