// The `.note` layers glue's pure core; the DOM/wasm half is in e2e/noteLayers.spec.ts.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeLayerWithExports, decodeWithExports, type DecoderExports } from "../../src/render/wasm";
import {
  enumerateSnpg,
  inkRecordIndices,
  pairLayers,
  layerDisplayName,
  toPanelLayers,
  buildNoteExportModel,
  noteLayerExportFilename,
  type NoteLayerView,
  type SnpgRecord,
} from "../../src/pages/noteLayers";
import { normalizeLayers } from "../../src/api/client";
import { layeredPagePayload, layeredPageLayers } from "../../src/api/layeredFixture";
import type { PageLayer } from "../../src/core/types";

// --- payload builders (the fixture's shape, minified) ------------------------

function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** A hand-rolled SNPG payload: header + records of (flags, slotWire, data). */
function payload(
  records: { flags: number; slot: number; data: number[] }[],
  opts: { version?: number; magic?: number[]; count?: number; w?: number; h?: number } = {},
): Uint8Array {
  const out: number[] = [
    ...(opts.magic ?? [0x53, 0x4e, 0x50, 0x47]),
    opts.version ?? 2,
    1,
    0,
    0,
    ...u32(opts.w ?? 4),
    ...u32(opts.h ?? 1),
    ...u32(opts.count ?? records.length),
  ];
  for (const r of records) out.push(r.flags, r.slot, ...u32(r.data.length), ...r.data);
  return Uint8Array.from(out);
}

const TWO_RECORDS = [
  { flags: 0, slot: 4, data: [0x65, 0x03] },
  { flags: 0b10, slot: 0, data: [0x61, 0x03] },
];

// The real compiled decoder; the SNPG parse lives in wasm.
const wasmPath = fileURLToPath(new URL("../../public/note-decode.wasm", import.meta.url));
const wasmSuite = existsSync(wasmPath) ? describe : describe.skip;

function loadDecoder(): DecoderExports {
  const mod = new WebAssembly.Module(readFileSync(wasmPath));
  return new WebAssembly.Instance(mod).exports as unknown as DecoderExports;
}

// --- enumerateSnpg (wasm-backed record enumeration) --------------------------

wasmSuite("enumerateSnpg (real module)", () => {
  it("walks a v2 payload into slot + hidden + dims, wire order", () => {
    const en = enumerateSnpg(loadDecoder(), payload(TWO_RECORDS));
    expect(en?.records.map((r) => ({ slot: r.slot, hidden: r.hidden, rasterImage: r.rasterImage }))).toEqual([
      { slot: "background", hidden: false, rasterImage: false },
      { slot: "main", hidden: true, rasterImage: false },
    ]);
    expect([en?.width, en?.height]).toEqual([4, 1]);
  });

  it("accepts the shipped layered fixture payload (4 records, layer2 hidden)", () => {
    const en = enumerateSnpg(loadDecoder(), layeredPagePayload(0)!);
    expect(en?.records.map((r) => r.slot)).toEqual(["background", "main", "layer2", "layer3"]);
    expect(en?.records.map((r) => r.hidden)).toEqual([false, false, true, false]);
    expect([en?.width, en?.height]).toEqual([1404, 1872]);
  });

  it("rejects a v1 payload — no slot byte means no identity, no stacked view", () => {
    expect(enumerateSnpg(loadDecoder(), payload(TWO_RECORDS, { version: 1 }))).toBeNull();
  });

  it("rejects a foreign blob and a short one", () => {
    const wasm = loadDecoder();
    expect(enumerateSnpg(wasm, payload(TWO_RECORDS, { magic: [1, 2, 3, 4] }))).toBeNull();
    expect(enumerateSnpg(wasm, Uint8Array.from([0x53, 0x4e, 0x50, 0x47, 2]))).toBeNull();
  });

  it("rejects an unknown slot id", () => {
    expect(enumerateSnpg(loadDecoder(), payload([{ flags: 0, slot: 9, data: [0x61, 0x00] }]))).toBeNull();
  });

  it("rejects a record claiming bytes the payload lacks, and trailing junk", () => {
    const wasm = loadDecoder();
    const overclaim = payload([{ flags: 0, slot: 0, data: [] }]);
    overclaim.set(u32(999), 22);
    expect(enumerateSnpg(wasm, overclaim)).toBeNull();

    const junk = Uint8Array.from([...payload(TWO_RECORDS), 0xde, 0xad]);
    expect(enumerateSnpg(wasm, junk)).toBeNull();
  });

  it("rejects zero records and an over-cap record count", () => {
    const wasm = loadDecoder();
    expect(enumerateSnpg(wasm, payload([], { count: 0 }))).toBeNull();
    expect(enumerateSnpg(wasm, payload(TWO_RECORDS, { count: 6 }))).toBeNull();
  });
});

// --- inkRecordIndices --------------------------------------------------------
// A `.mark` is an overlay: the device's paper layers must not hide the document.

describe("inkRecordIndices", () => {
  const rec = (over: Partial<SnpgRecord> = {}): SnpgRecord => ({
    slot: "main",
    hidden: false,
    rasterImage: false,
    data: new Uint8Array(0),
    ...over,
  });

  it("drops the background slot and keeps every ink layer, in wire order", () => {
    expect(
      inkRecordIndices([
        rec({ slot: "background" }),
        rec({ slot: "main" }),
        rec({ slot: "layer3" }),
      ]),
    ).toEqual([1, 2]);
  });

  it("drops a DEVICE-HIDDEN layer — the page beside it does not show one either", () => {
    expect(inkRecordIndices([rec({ slot: "main" }), rec({ slot: "layer2", hidden: true })])).toEqual([0]);
  });

  it("drops a raster-image background, whose `data` is an asset hash and not pixels", () => {
    expect(
      inkRecordIndices([rec({ slot: "background", rasterImage: true }), rec({ slot: "main" })]),
    ).toEqual([1]);
  });

  it("answers empty for a page whose only records are paper", () => {
    expect(inkRecordIndices([rec({ slot: "background" })])).toEqual([]);
  });
});

wasmSuite("inkRecordIndices (the shipped mark payload)", () => {
  it("picks Main and Layer Renamed out of the fixture — not the sheet, not the hidden one", () => {
    // The `.mark` fixture: ink is records 1 and 3; 0 is the white sheet, 2 device-hidden.
    const records = enumerateSnpg(loadDecoder(), layeredPagePayload(0)!)!.records;
    expect(inkRecordIndices(records)).toEqual([1, 3]);
  });
});

// --- pairLayers --------------------------------------------------------------

const vo = (slot: PageLayer["slot"], over: Partial<PageLayer> = {}): PageLayer => ({
  slot,
  name: "",
  visible: true,
  isCurrent: false,
  ...over,
});

describe("pairLayers", () => {
  const records: SnpgRecord[] = [
    { slot: "background", hidden: false, rasterImage: false, data: new Uint8Array(0) },
    { slot: "main", hidden: true, rasterImage: false, data: new Uint8Array(0) },
  ];

  it("pairs BY SLOT, not by array position", () => {
    // The VO list arrives reversed relative to the records.
    const paired = pairLayers(records, [vo("main", { name: "Ink" }), vo("background")]);
    expect(paired?.map((p) => [p.index, p.record.slot, p.vo.slot])).toEqual([
      [0, "background", "background"],
      [1, "main", "main"],
    ]);
    expect(paired?.[1]?.vo.name).toBe("Ink");
  });

  it("nulls on a slot present on one side only", () => {
    expect(pairLayers(records, [vo("background"), vo("layer1")])).toBeNull();
  });

  it("nulls on length mismatch, an empty pairing, and a duplicated slot", () => {
    expect(pairLayers(records, [vo("background")])).toBeNull();
    expect(pairLayers([], [])).toBeNull();
    expect(pairLayers(records, [vo("main"), vo("main")])).toBeNull();
  });
});

// --- names -------------------------------------------------------------------

describe("layerDisplayName", () => {
  it("prefers the device's LAYERINFO name and falls back to slot defaults", () => {
    expect(layerDisplayName(vo("layer3", { name: "Layer Renamed" }))).toBe("Layer Renamed");
    expect(layerDisplayName(vo("main"))).toBe("Main Layer");
    expect(layerDisplayName(vo("layer2"))).toBe("Layer 2");
    expect(layerDisplayName(vo("background"))).toBe("Background Layer");
  });
});

// --- the panel + export mappings --------------------------------------------

/** A stack view without a real canvas — these mappings only carry the ref. */
function view(index: number, over: Partial<NoteLayerView> = {}): NoteLayerView {
  return {
    index,
    slot: "main",
    name: `L${index}`,
    authoredVisible: true,
    isCurrent: false,
    visible: true,
    canvas: {} as HTMLCanvasElement,
    ...over,
  };
}

describe("toPanelLayers", () => {
  it("is TOP-first (reverse of wire order) with resolved names and NO opacity", () => {
    const rows = toPanelLayers([view(0, { name: "Background Layer" }), view(1, { name: "Layer Renamed", visible: false })]);
    expect(rows.map((r) => [r.id, r.name, r.visible])).toEqual([
      [1, "Layer Renamed", false],
      [0, "Background Layer", true],
    ]);
    // The absent field keeps the opacity stepper off `.note` rows.
    for (const r of rows) expect("opacity" in r).toBe(false);
  });
});

describe("buildNoteExportModel", () => {
  it("maps VO + live panel state into both export states, opacity 1 everywhere", () => {
    const views = [
      view(0, { name: "Main Layer" }),
      view(1, { name: "Layer 2", authoredVisible: false, visible: true }),
      view(2, { name: "Layer Renamed", authoredVisible: true, visible: false }),
    ];
    const model = buildNoteExportModel(1404, 1872, views);
    expect(model.width).toBe(1404);
    expect(model.height).toBe(1872);
    expect(model.layers.map((l) => l.id)).toEqual([0, 1, 2]);
    expect(model.layers.map((l) => l.authored)).toEqual([
      { opacity: 1, visible: true },
      { opacity: 1, visible: false },
      { opacity: 1, visible: true },
    ]);
    expect(model.layers.map((l) => l.current)).toEqual([
      { opacity: 1, visible: true },
      { opacity: 1, visible: true },
      { opacity: 1, visible: false },
    ]);
  });

  it("passes payload dims through (landscape exports 1872×1404) and swaps in fresh canvases", () => {
    const screen = {} as HTMLCanvasElement;
    const fresh = {} as HTMLCanvasElement;
    const model = buildNoteExportModel(1872, 1404, [view(0, { canvas: screen })], [fresh]);
    expect([model.width, model.height]).toEqual([1872, 1404]);
    expect(model.layers[0]!.canvas).toBe(fresh);
  });
});

describe("noteLayerExportFilename", () => {
  it("is spdExport's convention with the 1-based page in it", () => {
    expect(noteLayerExportFilename("Weekly review.note", 2, "current", "ora")).toBe(
      "Weekly review_p3_current.ora",
    );
    expect(noteLayerExportFilename("Weekly review.note", 0, "original", "png")).toBe(
      "Weekly review_p1_original.png",
    );
  });

  it("sanitises device-authored names through the exporter's own stem", () => {
    expect(noteLayerExportFilename("a/b:c.note", 0, "current", "png")).toBe("a-b-c_p1_current.png");
  });
});

// --- the client seam's validation -------------------------------------------

describe("normalizeLayers (client seam)", () => {
  it("passes a valid list through and normalizes optionals", () => {
    const out = normalizeLayers([
      { slot: "background", name: "", visible: true, isCurrent: false },
      { slot: "layer3", name: "Layer Renamed", visible: false, isCurrent: true },
    ]);
    expect(out).toEqual([
      { slot: "background", name: "", visible: true, isCurrent: false },
      { slot: "layer3", name: "Layer Renamed", visible: false, isCurrent: true },
    ]);
  });

  it("normalizes absent/empty to null — the no-panel state", () => {
    expect(normalizeLayers(undefined)).toBeNull();
    expect(normalizeLayers(null)).toBeNull();
    expect(normalizeLayers([])).toBeNull();
  });

  it("degrades the WHOLE list on a bad or duplicated slot — never a partial panel", () => {
    expect(
      normalizeLayers([
        { slot: "main", name: "", visible: true, isCurrent: false },
        { slot: "sparkles" as never, name: "", visible: true, isCurrent: false },
      ]),
    ).toBeNull();
    expect(
      normalizeLayers([
        { slot: "main", name: "", visible: true, isCurrent: false },
        { slot: "main", name: "", visible: true, isCurrent: false },
      ]),
    ).toBeNull();
  });

  it("defaults a malformed name/flag rather than dropping the layer", () => {
    const out = normalizeLayers([
      { slot: "main", name: 7 as never, visible: "yes" as never, isCurrent: undefined as never },
    ]);
    expect(out).toEqual([{ slot: "main", name: "", visible: true, isCurrent: false }]);
  });
});

// --- the fixture is self-consistent ------------------------------------------

wasmSuite("layeredFixture (VO/payload pairing, via the real decoder)", () => {
  it("its VO list pairs with its own payload's records", () => {
    const records = enumerateSnpg(loadDecoder(), layeredPagePayload(0)!)!.records;
    const vos = layeredPageLayers(0)!;
    const paired = pairLayers(records, vos);
    expect(paired).not.toBeNull();
    for (const p of paired!) expect(p.record.hidden).toBe(!p.vo.visible);
    expect(paired!.at(-1)!.vo).toMatchObject({ name: "Layer Renamed", isCurrent: true });
  });
});

describe("layeredFixture", () => {
  it("pages past the first carry no layers and no payload", () => {
    expect(layeredPageLayers(1)).toBeNull();
    expect(layeredPagePayload(1)).toBeNull();
  });
});

wasmSuite("decode_layer (real module, fixture payload)", () => {
  const W = 1404;
  const at = (rgba: Uint8ClampedArray, row: number, col = 0): number[] => {
    const i = (row * W + col) * 4;
    return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!];
  };

  it("decodes every record — hidden included — with transparent alpha 0", () => {
    const wasm = loadDecoder();
    const bytes = layeredPagePayload(0)!;

    const bg = decodeLayerWithExports(wasm, bytes, 0);
    expect([bg.width, bg.height]).toEqual([1404, 1872]);
    expect(at(bg.rgba, 0)[3]).toBe(0xff);

    const main = decodeLayerWithExports(wasm, bytes, 1);
    expect(at(main.rgba, 300)).toEqual([0, 0, 0, 0xff]);
    expect(at(main.rgba, 100)[3]).toBe(0);

    // The device-hidden layer's pixels are on the wire; SNPG v2 ships hidden records.
    const hidden = decodeLayerWithExports(wasm, bytes, 2);
    expect(at(hidden.rgba, 900)).toEqual([0, 0, 0, 0xff]);
    expect(at(hidden.rgba, 300)[3]).toBe(0);

    expect(() => decodeLayerWithExports(wasm, bytes, 4)).toThrow(/out of range/);
  });

  it("the default composite skips the hidden record (device-authored pixels)", () => {
    const wasm = loadDecoder();
    const bytes = layeredPagePayload(0)!;
    const page = decodeWithExports(wasm, bytes);
    expect(at(page.rgba, 900)[0]).toBeGreaterThan(0xf0);
    expect(at(page.rgba, 300)[0]).toBe(0);
  });
});
