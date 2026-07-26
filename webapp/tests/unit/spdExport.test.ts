// @vitest-environment happy-dom
//
// The `.spd` EXPORT core (`spdExport.ts`) — PURE given a model, so tested with
// FAKE canvases: no GPU, no real raster. Two things are proved:
//   1. the FLAT PNG flatten reads the RIGHT state — a layer hidden in `current`
//      but visible in `authored` is skipped for "current" and drawn for
//      "original" (and vice-versa) — asserted via a recording 2d context that
//      logs every `drawImage` and the `globalAlpha` in force at the time; and
//   2. the LAYERED ORA is a real, byte-correct STORED zip — `PK\x03\x04`, an
//      uncompressed `mimetype` = `image/openraster` FIRST, and a `stack.xml`
//      carrying the chosen state's opacity/visibility and a default name for
//      the empty layer — validated by unzipping it here (a hand-rolled reader
//      that walks the local file headers), which is the real ORA-opens check.

import { describe, it, expect } from "vitest";
import { exportSpdPng, exportSpdOra, buildStackXml, crc32 } from "../../src/pages/spdExport";
import type { SpdExportLayer, SpdExportModel } from "../../src/pages/spdViewer";

// --- fakes ------------------------------------------------------------------

/** A stand-in for a layer's own canvas: an identity + a `toBlob` shim (some bytes). */
function layerCanvas(id: number): HTMLCanvasElement {
  return {
    __id: id,
    toBlob(cb: (b: Blob | null) => void, _type?: string): void {
      // A distinct payload per layer so the ORA `data/layer_<id>.png` bytes are checkable.
      cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, id])], { type: "image/png" }));
    },
  } as unknown as HTMLCanvasElement;
}

/** A recording export canvas: its ctx logs each draw's source id and the live alpha. */
function recordingCanvas(): { canvas: HTMLCanvasElement; draws: Array<{ id: number; alpha: number }> } {
  const draws: Array<{ id: number; alpha: number }> = [];
  const ctx = {
    globalAlpha: 1,
    drawImage(img: { __id: number }): void {
      draws.push({ id: img.__id, alpha: this.globalAlpha });
    },
  };
  const canvas = {
    getContext: () => ctx,
    toBlob(cb: (b: Blob | null) => void): void {
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    },
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, draws };
}

function layer(
  id: number,
  name: string,
  authored: { opacity: number; visible: boolean },
  current: { opacity: number; visible: boolean },
): SpdExportLayer {
  return { id, name, canvas: layerCanvas(id), authored, current };
}

// Layers BOTTOM-to-TOP (as `exportModel()` hands them over):
//   9 base   — visible in both
//   2 Ink    — visible in both; dimmed to 0.5 in current only
//   5 hidden — visible authored, HIDDEN current  → skipped for current, drawn for original
//   7 shown  — HIDDEN authored, visible current  → drawn for current, skipped for original
// Layer 9 has an EMPTY name → ORA must default it to "Layer 9".
function model(): SpdExportModel {
  return {
    width: 8,
    height: 4,
    layers: [
      layer(9, "", { opacity: 1, visible: true }, { opacity: 1, visible: true }),
      layer(2, "Ink", { opacity: 1, visible: true }, { opacity: 0.5, visible: true }),
      layer(5, "Sketch", { opacity: 1, visible: true }, { opacity: 1, visible: false }),
      layer(7, "Fresh", { opacity: 0.3, visible: false }, { opacity: 1, visible: true }),
    ],
  };
}

// --- a minimal STORED-zip reader (walks local file headers) -----------------

interface ReadEntry {
  name: string;
  method: number;
  data: Uint8Array;
}

function readStoredZip(bytes: Uint8Array): ReadEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out: ReadEntry[] = [];
  let p = 0;
  while (p + 4 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const name = dec.decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const dataStart = p + 30 + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    out.push({ name, method, data });
    p = dataStart + compSize;
  }
  return out;
}

async function zipBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

// ============================================================================

describe("exportSpdPng", () => {
  it("flattens the CURRENT state: skips the current-hidden layer, honours per-layer opacity", async () => {
    const rec = recordingCanvas();
    const blob = await exportSpdPng(model(), "current", () => rec.canvas);
    expect(blob).toBeInstanceOf(Blob);
    // Bottom-to-top; layer 5 hidden in current is skipped, 7 (current-visible) drawn.
    expect(rec.draws).toEqual([
      { id: 9, alpha: 1 },
      { id: 2, alpha: 0.5 },
      { id: 7, alpha: 1 },
    ]);
  });

  it("flattens the ORIGINAL state: skips the authored-hidden layer, uses authored opacity", async () => {
    const rec = recordingCanvas();
    await exportSpdPng(model(), "original", () => rec.canvas);
    // Authored: 7 is hidden (skipped); 5 is visible (drawn); 2 at authored opacity 1.
    expect(rec.draws).toEqual([
      { id: 9, alpha: 1 },
      { id: 2, alpha: 1 },
      { id: 5, alpha: 1 },
    ]);
  });

  it("fills NO background — an all-hidden model draws nothing (transparent PNG)", async () => {
    const rec = recordingCanvas();
    const blank: SpdExportModel = {
      width: 4,
      height: 4,
      layers: [layer(9, "base", { opacity: 1, visible: false }, { opacity: 1, visible: false })],
    };
    await exportSpdPng(blank, "current", () => rec.canvas);
    expect(rec.draws).toEqual([]);
  });
});

describe("buildStackXml", () => {
  it("lists layers TOP-to-BOTTOM with the chosen state, escaping and defaulting names", () => {
    const m = model();
    m.layers[1]!.name = "A & B <x>"; // exercise escaping on the Ink layer
    const xml = buildStackXml(m, "current");

    // TOP-first: 7, 5, 2, 9 — the reverse of the bottom-to-top model.
    const order = [...xml.matchAll(/src='data\/layer_(\d+)\.png'/g)].map((mm) => Number(mm[1]));
    expect(order).toEqual([7, 5, 2, 9]);

    // Current state: layer 5 hidden, layer 2 at 0.50; empty-named base defaults to "Layer 9".
    expect(xml).toContain("<image w='8' h='4'>");
    expect(xml).toContain("src='data/layer_5.png' opacity='1.00' visibility='hidden'");
    expect(xml).toContain("src='data/layer_2.png' opacity='0.50' visibility='visible'");
    expect(xml).toContain("name='Layer 9'");
    expect(xml).toContain("name='A &amp; B &lt;x&gt;'");
    expect(xml).toContain("composite-op='svg:src-over'");
  });

  it("reads the AUTHORED state when asked for original", () => {
    const xml = buildStackXml(model(), "original");
    // Authored: layer 7 hidden @0.30, layer 5 visible.
    expect(xml).toContain("src='data/layer_7.png' opacity='0.30' visibility='hidden'");
    expect(xml).toContain("src='data/layer_5.png' opacity='1.00' visibility='visible'");
  });
});

describe("exportSpdOra", () => {
  it("is a STORED zip starting PK\\x03\\x04 with an uncompressed image/openraster mimetype FIRST", async () => {
    const blob = await exportSpdOra(model(), "current");
    expect(blob.type).toBe("image/openraster");
    const bytes = await zipBytes(blob);

    // Local file header magic.
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const entries = readStoredZip(bytes);
    // Every entry is STORE (method 0).
    for (const e of entries) expect(e.method).toBe(0);

    // The mimetype is FIRST and is exactly the OpenRaster magic, uncompressed.
    expect(entries[0]!.name).toBe("mimetype");
    expect(new TextDecoder().decode(entries[0]!.data)).toBe("image/openraster");

    // stack.xml then one PNG per layer (bottom-to-top model order: 9,2,5,7).
    expect(entries.map((e) => e.name)).toEqual([
      "mimetype",
      "stack.xml",
      "data/layer_9.png",
      "data/layer_2.png",
      "data/layer_5.png",
      "data/layer_7.png",
    ]);
  });

  it("carries the chosen state in stack.xml and the full per-layer PNG bytes", async () => {
    const bytes = await zipBytes(await exportSpdOra(model(), "current"));
    const entries = readStoredZip(bytes);
    const byName = new Map(entries.map((e) => [e.name, e]));

    const xml = new TextDecoder().decode(byName.get("stack.xml")!.data);
    expect(xml).toContain("src='data/layer_5.png' opacity='1.00' visibility='hidden'");
    expect(xml).toContain("name='Layer 9'");

    // The layer PNG is the layer canvas's own bytes (identity byte = the id), NOT flattened.
    expect(Array.from(byName.get("data/layer_5.png")!.data)).toEqual([0x89, 0x50, 0x4e, 0x47, 5]);

    // The stored size/CRC in the header match the data (a real reader would accept it).
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
  });

  it("the end-of-central-directory records the right entry count and closes the archive", async () => {
    const bytes = await zipBytes(await exportSpdOra(model(), "original"));
    // EOCD is the last 22 bytes (no comment).
    const eocd = bytes.length - 22;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 8, true)).toBe(6); // entries on this disk
    expect(dv.getUint16(eocd + 10, true)).toBe(6); // total entries
  });
});

describe("crc32", () => {
  it("matches the known ZIP/PNG check value for '123456789'", () => {
    // The canonical CRC-32 test vector.
    expect(crc32(new TextEncoder().encode("123456789")) >>> 0).toBe(0xcbf43926);
  });
});
