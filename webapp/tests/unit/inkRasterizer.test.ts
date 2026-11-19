// One decoder for every ink raster: the loader fetches and instantiates the
// wasm on each call, so a gallery of inked tiles must not call it per tile.

import { describe, it, expect, vi } from "vitest";
import { createInkRasterizer } from "../../src/pages/noteLayers";
import type { DecoderExports } from "../../src/render/wasm";

// No `decode_layer`: the raster gives up right after asking for the decoder.
const exportsWithoutDecoder = {} as unknown as DecoderExports;

describe("createInkRasterizer", () => {
  it("loads the decoder once, however many pages it draws", async () => {
    const load = vi.fn(async () => exportsWithoutDecoder);
    const raster = createInkRasterizer(load);
    const draw = () => raster(new ArrayBuffer(8), { width: 10, height: 10 }).catch(() => null);
    await Promise.all([draw(), draw()]);
    await draw();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("throws on a failed load, which may pass, and tries it again next time", async () => {
    const load = vi
      .fn<() => Promise<DecoderExports>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(exportsWithoutDecoder);
    const raster = createInkRasterizer(load);
    await expect(raster(new ArrayBuffer(8), { width: 10, height: 10 })).rejects.toThrow("offline");
    // A decoder with no `decode_layer` is the wrong wasm: a failure, not "no ink".
    await expect(raster(new ArrayBuffer(8), { width: 10, height: 10 })).rejects.toThrow("decode_layer");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
