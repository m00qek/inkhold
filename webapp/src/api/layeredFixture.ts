// The LAYERED `.note` fixture — the one note in the fake tree whose pages carry
// `layers` in their `NoteMetaVO` refs and whose page-bytes are REAL SNPG v2
// payloads,
// decodable by the actual `note-decode.wasm` the dev server ships. That is
// what lets the reader's layers panel run END TO END in dev and e2e — fake
// data plane, real decoder — the way the `.spd` viewer's e2e drives the real
// `spd-decode.wasm` against a committed fixture.
//
// The layer cast mirrors the settled capture (`layers_edited.note`,
// ): a nameless background and main
// layer (the panel derives slot defaults), a DEVICE-HIDDEN Layer 2 whose
// record still ships on the wire flagged `hidden` (the panel must be able to
// toggle it ON), and a renamed top layer ("Layer Renamed") that is the
// device's current layer. Page 2 carries NO layers, so the per-page panel
// appearing/disappearing is a state the fixture reaches.
//
// Its own module (not fake.ts, not binFake.ts) because BOTH fakes serve it:
// the live routes, and the bin routes after the note is trashed — mirroring
// the real server, where the per-page index is keyed by blob md5 and survives
// trashing untouched.

import type { PageLayer, PageRef } from "../core/types";

export const LAYERED_NOTE_ID = "n-layers";

/** The fixture's page size — the A5X native portrait page, like every other
 *  fake page (and the payload header agrees, as the real index guarantees). */
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
  /** Rows [from, to) painted with `code`; everything else transparent.
   *  `null` band = the whole page (the background's white sheet). */
  band: [number, number] | null;
  code: number;
}

/**
 * Page 1's records in WIRE ORDER (bottom-to-top). The ink bands are disjoint
 * so an e2e pixel probe can attribute ink to a layer: toggling Layer 2 on adds
 * ink in rows 800–1100 and nowhere else.
 */
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
    // DEVICE-HIDDEN, not deleted: `visible: false` in the VO, `hidden` on the
    // wire — the record ships so the panel can toggle it on (SNPG v2's reason
    // to exist). Nameless, so the panel shows the slot default "Layer 2".
    vo: { slot: "layer2", name: "", visible: false, isCurrent: false },
    band: [800, 1100],
    code: BLACK,
  },
  {
    // Renamed on-device and the current layer — the capture's top layer.
    vo: { slot: "layer3", name: "Layer Renamed", visible: true, isCurrent: true },
    band: [1400, 1500],
    code: BLACK,
  },
];

/** The `NoteMetaVO.pages[].layers` for a page of the fixture note — wire order
 *  (bottom-to-top), or null for pages that carry no layers (page 2+). */
export function layeredPageLayers(pageIndex: number): PageLayer[] | null {
  if (pageIndex !== 0) return null;
  return PAGE0_LAYERS.map((l) => ({ ...l.vo }));
}

/**
 * Attach the fixture's layers to one page ref, the way the WIRE does it: the
 * field is present with the descriptors, or OMITTED ENTIRELY — never `null`,
 * never `[]`. That distinction is load-bearing now that the reader treats an
 * absent `layers` on real data as "this page has none" rather than "not known
 * yet" (see `PageRef.layers`), so a fake that emitted `null` would be modelling
 * a payload the server never sends.
 *
 * Used for BOTH shapes the field rides: the meta's page list, and a listing/bin
 * entry's `firstPage` — one helper, so the two can't drift.
 */
export function withLayeredPageLayers(page: PageRef): PageRef {
  const layers = layeredPageLayers(page.index);
  return layers === null ? page : { ...page, layers };
}

// --- the payload builder -----------------------------------------------------

/** Append a run of `n` pixels of `code` as RLE pairs: `(code, 0xff)` is the
 *  spec's 0x4000 special length, `(code, m-1)` a short run (m ≤ 128). High-bit
 *  "held" pairs are deliberately never emitted — short pairs are unambiguous. */
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

/** One layer's full RATTA_RLE stream: transparent, its band, transparent. */
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

/** Build the full SNPG v2 payload for page 1. Deterministic; built per call so
 *  a caller can hand the buffer away without aliasing the fixture. */
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

/** The SNPG payload for a page of the fixture note, or null where the page has
 *  no layers (those pages keep the fake's ordinary junk bytes — the fake
 *  renderer paints from the hash, exactly as for every other note). */
export function layeredPagePayload(pageIndex: number): Uint8Array | null {
  if (pageIndex !== 0) return null;
  return buildPayload();
}
