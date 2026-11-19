// The tile's ink, with the real rasterizer: "nothing to draw" (null, kept for
// that ink) must never be confused with a failure that may pass (a throw,
// tried again), or a hiccup leaves an annotated tile plain until its ink moves.

import { describe, it, expect, vi } from "vitest";
import { createInkCover } from "../../src/render/inkCover";
import { createInkRasterizer } from "../../src/pages/noteLayers";
import type { DecoderExports } from "../../src/render/wasm";
import type { Hash, NoteMeta, PageRef } from "../../src/core/types";

const ref: PageRef = { index: 0, hash: "ink1" as Hash, width: 1404, height: 1872, textHash: null, linksHash: null, sourcePage: null };
const page = { width: 120, height: 160, close() {} } as unknown as ImageBitmap;
const ink = { markId: "m1", hash: "ink1" as Hash };

function api(over: Partial<Record<"getNoteMeta" | "getBinNoteMeta" | "getPageBytes" | "getBinPageBytes", unknown>> = {}) {
  const meta = { id: "m1", pages: [ref] } as unknown as NoteMeta;
  return {
    getNoteMeta: vi.fn(async () => meta),
    getBinNoteMeta: vi.fn(async () => meta),
    getPageBytes: vi.fn(async () => new ArrayBuffer(8)),
    getBinPageBytes: vi.fn(async () => new ArrayBuffer(8)),
    ...over,
  };
}

describe("createInkCover", () => {
  it("throws when the decoder will not load, so the tile tries again", async () => {
    const raster = createInkRasterizer(() => Promise.reject(new Error("offline")));
    const cover = createInkCover(api(), raster);
    await expect(cover(page, ink, {})).rejects.toThrow("offline");
  });

  it("throws when the mark cannot be fetched, and asks again next time", async () => {
    const a = api({ getNoteMeta: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ id: "m1", pages: [ref] }) });
    const cover = createInkCover(a, async () => null);
    await expect(cover(page, ink, {})).rejects.toThrow("offline");
    await cover(page, ink, {});
    expect(a.getNoteMeta).toHaveBeenCalledTimes(2);
  });

  it("is null when the page holds no ink, or is not in the mark", async () => {
    // Bytes that are no page (the enumerator says -1): the real rasterizer's
    // definite "nothing".
    const noInk = {
      decode_layer: () => 0,
      memory: new WebAssembly.Memory({ initial: 1 }),
      alloc: () => 8,
      free: () => {},
      snpg_enumerate: () => -1,
      snpg_width: () => 0,
      snpg_height: () => 0,
      snpg_record_slot: () => 0,
      snpg_record_flags: () => 0,
      snpg_record_hash_ptr: () => 0,
      snpg_record_hash_len: () => 0,
    } as unknown as DecoderExports;
    const cover = createInkCover(api(), createInkRasterizer(async () => noInk));
    expect(await cover(page, ink, {})).toBeNull();
    expect(await createInkCover(api(), async () => null)(page, { markId: "m1", hash: "gone" as Hash }, {})).toBeNull();
  });

  it("throws when the decoder is an older cached module: that says nothing about the ink", async () => {
    const stale = { decode_layer: () => 0 } as unknown as DecoderExports;
    const cover = createInkCover(api(), createInkRasterizer(async () => stale));
    await expect(cover(page, ink, {})).rejects.toThrow(/older cached module/);
  });

  it("keeps one page list per mark, its latest ink's: a new scribble replaces it", async () => {
    const a = api();
    const cover = createInkCover(a, async () => null);
    await cover(page, ink, {});
    await cover(page, ink, {});
    expect(a.getNoteMeta).toHaveBeenCalledTimes(1);
    await cover(page, { markId: "m1", hash: "ink2" as Hash }, {});
    expect(a.getNoteMeta).toHaveBeenCalledTimes(2);
    // The first ink's list was dropped, not kept beside the new one.
    await cover(page, ink, {});
    expect(a.getNoteMeta).toHaveBeenCalledTimes(3);
  });

  it("asks a trashed document's mark through the bin", async () => {
    const a = api();
    await createInkCover(a, async () => null)(page, ink, { bin: true });
    expect(a.getBinNoteMeta).toHaveBeenCalledWith("m1");
    expect(a.getBinPageBytes).toHaveBeenCalledWith("m1", ref);
    expect(a.getNoteMeta).not.toHaveBeenCalled();
  });
});
