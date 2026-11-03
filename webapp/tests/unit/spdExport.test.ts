// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import { exportSpdPng, exportSpdOra, buildStackXml, crc32 } from "../../src/pages/spdExport";
import type { SpdExportLayer, SpdExportModel } from "../../src/pages/spdViewer";

// --- fakes ------------------------------------------------------------------

/** A stand-in for a layer's own canvas: an identity + a `toBlob` shim (some bytes). */
function layerCanvas(id: number): HTMLCanvasElement {
  return {
    __id: id,
    toBlob(cb: (b: Blob | null) => void, _type?: string): void {
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

// Layers bottom to top:
//   9 base   — visible in both, empty name → "Layer 9"
//   2 Ink    — visible in both; 0.5 in current only
//   5 hidden — visible authored, hidden current
//   7 shown  — hidden authored, visible current
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
    expect(rec.draws).toEqual([
      { id: 9, alpha: 1 },
      { id: 2, alpha: 0.5 },
      { id: 7, alpha: 1 },
    ]);
  });

  it("flattens the ORIGINAL state: skips the authored-hidden layer, uses authored opacity", async () => {
    const rec = recordingCanvas();
    await exportSpdPng(model(), "original", () => rec.canvas);
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
    m.layers[1]!.name = "A & B <x>";
    const xml = buildStackXml(m, "current");

    const order = [...xml.matchAll(/src='data\/layer_(\d+)\.png'/g)].map((mm) => Number(mm[1]));
    expect(order).toEqual([7, 5, 2, 9]);

    expect(xml).toContain("<image w='8' h='4'>");
    expect(xml).toContain("src='data/layer_5.png' opacity='1.00' visibility='hidden'");
    expect(xml).toContain("src='data/layer_2.png' opacity='0.50' visibility='visible'");
    expect(xml).toContain("name='Layer 9'");
    expect(xml).toContain("name='A &amp; B &lt;x&gt;'");
    expect(xml).toContain("composite-op='svg:src-over'");
  });

  it("reads the AUTHORED state when asked for original", () => {
    const xml = buildStackXml(model(), "original");
    expect(xml).toContain("src='data/layer_7.png' opacity='0.30' visibility='hidden'");
    expect(xml).toContain("src='data/layer_5.png' opacity='1.00' visibility='visible'");
  });
});

describe("exportSpdOra", () => {
  it("is a STORED zip starting PK\\x03\\x04 with an uncompressed image/openraster mimetype FIRST", async () => {
    const blob = await exportSpdOra(model(), "current");
    expect(blob.type).toBe("image/openraster");
    const bytes = await zipBytes(blob);

    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const entries = readStoredZip(bytes);
    for (const e of entries) expect(e.method).toBe(0);

    // The mimetype entry is first, uncompressed, exactly the OpenRaster magic.
    expect(entries[0]!.name).toBe("mimetype");
    expect(new TextDecoder().decode(entries[0]!.data)).toBe("image/openraster");

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

    expect(Array.from(byName.get("data/layer_5.png")!.data)).toEqual([0x89, 0x50, 0x4e, 0x47, 5]);

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
  });

  it("the end-of-central-directory records the right entry count and closes the archive", async () => {
    const bytes = await zipBytes(await exportSpdOra(model(), "original"));
    const eocd = bytes.length - 22;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 8, true)).toBe(6);
    expect(dv.getUint16(eocd + 10, true)).toBe(6);
  });
});

describe("crc32", () => {
  it("matches the known ZIP/PNG check value for '123456789'", () => {
    // The canonical CRC-32 test vector.
    expect(crc32(new TextEncoder().encode("123456789")) >>> 0).toBe(0xcbf43926);
  });
});
