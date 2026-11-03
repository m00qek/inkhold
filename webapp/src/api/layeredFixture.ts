// The one fake `.note` whose pages carry `layers` and real SNPG v2 payloads, so
// the layers panel runs end to end against the real `note-decode.wasm`. Shared
// by both fakes because the real per-page index survives trashing.
//
// Page 1: nameless background and main, a device-hidden Layer 2 (shipped with
// `hidden` so the panel can toggle it on), a renamed current top layer. Page 2
// has no layers.

import type { PageLayer, PageRef } from "../core/types";

export const LAYERED_NOTE_ID = "104";

/** A5X native portrait page. */
const W = 1404;
const H = 1872;

/** RLE colour codes (RATTA_RLE X2 table): black ink, transparent, white. */
const BLACK = 0x61;
const TRANSPARENT = 0x62;
const WHITE = 0x65;

/** Wire slot ids: 0 = MAINLAYER, 1..3 = LAYERn, 4 = BGLAYER. */
const SLOT_WIRE: Record<PageLayer["slot"], number> = {
  main: 0,
  layer1: 1,
  layer2: 2,
  layer3: 3,
  background: 4,
};

interface FixtureLayer {
  vo: PageLayer;
  /** Rows [from, to) painted with `code`; `null` = whole page. */
  band: [number, number] | null;
  code: number;
}

/** Page 1's records, bottom-to-top. Disjoint ink bands let an e2e pixel probe attribute ink to a layer. */
const PAGE0_LAYERS: FixtureLayer[] = [
  {
    vo: { slot: "background", name: "", visible: true, isCurrent: false },
    band: null,
    code: WHITE,
  },
  {
    vo: { slot: "main", name: "", visible: true, isCurrent: false },
    band: [200, 400],
    code: BLACK,
  },
  {
    // Hidden, not deleted; nameless, so the panel shows "Layer 2".
    vo: { slot: "layer2", name: "", visible: false, isCurrent: false },
    band: [800, 1100],
    code: BLACK,
  },
  {
    vo: { slot: "layer3", name: "Layer Renamed", visible: true, isCurrent: true },
    band: [1400, 1500],
    code: BLACK,
  },
];

/** Wire order (bottom-to-top), or null for pages without layers. */
export function layeredPageLayers(pageIndex: number): PageLayer[] | null {
  if (pageIndex !== 0) return null;
  return PAGE0_LAYERS.map((l) => ({ ...l.vo }));
}

/** Like the wire: `layers` is present or omitted entirely, never `null` or `[]`. */
export function withLayeredPageLayers(page: PageRef): PageRef {
  const layers = layeredPageLayers(page.index);
  return layers === null ? page : { ...page, layers };
}

// --- the payload builder -----------------------------------------------------

/** `(code, 0xff)` is the spec's 0x4000 run, `(code, m-1)` a short run (m ≤ 128); held pairs are never emitted. */
function rleRun(out: number[], code: number, n: number): void {
  while (n >= 0x4000) {
    out.push(code, 0xff);
    n -= 0x4000;
  }
  while (n > 0) {
    const take = Math.min(128, n);
    out.push(code, take - 1);
    n -= take;
  }
}

function layerStream(layer: FixtureLayer): number[] {
  const out: number[] = [];
  if (layer.band === null) {
    rleRun(out, layer.code, W * H);
    return out;
  }
  const [from, to] = layer.band;
  rleRun(out, TRANSPARENT, from * W);
  rleRun(out, layer.code, (to - from) * W);
  rleRun(out, TRANSPARENT, (H - to) * W);
  return out;
}

function u32le(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

/** Built per call so the caller may keep the buffer. */
function buildPayload(): Uint8Array {
  const out: number[] = [];
  out.push(0x53, 0x4e, 0x50, 0x47); // "SNPG"
  out.push(2); // version
  out.push(1); // variant: RATTA_RLE X2 (the colour table the codes above use)
  out.push(0, 0); // reserved
  u32le(out, W);
  u32le(out, H);
  u32le(out, PAGE0_LAYERS.length);
  for (const layer of PAGE0_LAYERS) {
    const data = layerStream(layer);
    out.push(layer.vo.visible ? 0 : 0b10); // flags: bit1 = hidden
    out.push(SLOT_WIRE[layer.vo.slot]);
    u32le(out, data.length);
    for (const b of data) out.push(b);
  }
  return Uint8Array.from(out);
}

/** Null for pages without layers; those keep the fake's ordinary junk bytes. */
export function layeredPagePayload(pageIndex: number): Uint8Array | null {
  if (pageIndex !== 0) return null;
  return buildPayload();
}
