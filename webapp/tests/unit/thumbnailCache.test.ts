// Thumbnail cache keys, the .spd crop, quality downscale and the persistent tiers.

import { describe, it, expect, vi, afterEach } from "vitest";
import { boxDownscaleRgba, coverCropRect, downscalePlan, type ThumbNet } from "../../src/render/thumbnails";
import { thumbTargetWidth } from "../../src/render/types";
import type { PersistentThumbStore } from "../../src/cache/idb";
import { cacheId } from "../../src/cache/renderCache";
import type { Id, PageRef, Theme } from "../../src/core/types";

// The facade's orchestration with every pixel/network seam faked; the real seams are e2e's.
import { tagOf, page, fakeNet, withProbe, fakeCoverMemo, build, noteSrc, fileSrc } from "./thumbnails.shared";

/**
 * A fake of the persistent `sn-thumbs` store — a plain in-memory Map with spied
 * get/put, so a test can populate it in one "session" and assert a fresh facade
 * reads through it in the next, and can make either op throw to prove fail-open.
 */
function fakePersistentStore(over: Partial<PersistentThumbStore> = {}): PersistentThumbStore & {
  map: Map<string, Blob>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  const map = new Map<string, Blob>();
  const store = {
    map,
    available: true,
    get: vi.fn(async (key: string) => map.get(key)),
    put: vi.fn(async (key: string, image: Blob) => {
      map.set(key, image);
    }),
    async clear() {
      map.clear();
    },
    ...over,
  } as PersistentThumbStore & { map: Map<string, Blob>; get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  return store;
}

describe("density-bucket cache keys", () => {
  // Keyed by (hash, theme, bucket) with the bucket from the live devicePixelRatio.
  afterEach(() => {
    delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  });

  it("a DPR change re-produces into a new bucket; same bucket stays cached", async () => {
    const t = build();
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1;
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(1);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1.25;
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(2);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1.5;
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(2);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2.5;
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(3);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 4;
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(3);
  });

  it("glyphs key per bucket too — their raster is tier-sized", async () => {
    const t = build();
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1;
    await t.thumbs.getThumbnail(fileSrc(null), "pdf");
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 3;
    await t.thumbs.getThumbnail(fileSrc(null), "pdf");
    expect(t.painter.glyph).toHaveBeenCalledTimes(2);
  });
});

describe("coverCropRect — the .spd de-letterbox geometry", () => {
  // A `.spd` ships a fixed 600×800 portrait thumbnail that letterboxes the drawing.

  it("a landscape target crops top/bottom into a centered band (big.spd)", () => {
    // 600×800 portrait preview, true canvas 16:9 (A≈1.778, wider than 0.75).
    const r = coverCropRect(600, 800, { w: 16, h: 9 });
    expect(r.sw).toBe(600);
    expect(r.sh).toBeCloseTo(337.5, 1);
    expect(r.sy).toBeCloseTo(231.25, 1);  // (800 - 337.5) / 2
    expect(r.sx).toBe(0);
    expect(r.sw / r.sh).toBeCloseTo(16 / 9, 3);
  });

  it("a tall-portrait target crops left/right into a centered band", () => {
    const r = coverCropRect(600, 800, { w: 1, h: 2 });
    expect(r.sh).toBe(800);
    expect(r.sw).toBeCloseTo(400, 3);
    expect(r.sx).toBeCloseTo(100, 3);
    expect(r.sy).toBe(0);
    expect(r.sw / r.sh).toBeCloseTo(0.5, 3);
  });

  it("an exact-match aspect (3:4 sketch) is a NO-OP — the full frame", () => {
    const r = coverCropRect(600, 800, { w: 3, h: 4 });
    expect(r).toEqual({ sx: 0, sy: 0, sw: 600, sh: 800 });
  });

  it("a missing or degenerate aspect yields the full frame (no crop)", () => {
    const full = { sx: 0, sy: 0, sw: 600, sh: 800 };
    expect(coverCropRect(600, 800, undefined)).toEqual(full);
    expect(coverCropRect(600, 800, { w: 0, h: 9 })).toEqual(full);
    expect(coverCropRect(600, 800, { w: 16, h: 0 })).toEqual(full);
    expect(coverCropRect(600, 800, { w: -16, h: 9 })).toEqual(full);
    expect(coverCropRect(600, 800, { w: Number.NaN, h: 9 })).toEqual(full);
    expect(coverCropRect(600, 800, { w: Infinity, h: 9 })).toEqual(full);
  });

  it("a non-positive source is left whole", () => {
    expect(coverCropRect(0, 0, { w: 16, h: 9 })).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 });
  });

  it("the cropped output is sized to the bucket tier target, not the raw band", () => {
    // big.spd content band ≈ 600×338; at bucket 1 the tier target is 230px wide.
    const r = coverCropRect(600, 800, { w: 16, h: 9 });
    const bandW = Math.round(r.sw);
    const bandH = Math.round(r.sh);
    const plan = downscalePlan(bandW, bandH, thumbTargetWidth(1));
    expect(thumbTargetWidth(1)).toBe(230);
    expect(plan.w).toBe(230);
    expect(plan.h).toBe(Math.round((bandH * 230) / bandW));
    expect(plan.method).toBe("high");
    expect(plan.w / plan.h).toBeCloseTo(16 / 9, 1);
  });

  it("never UPSCALES past the band: a hi-DPR bucket target above the band clamps to source", () => {
    // Bucket 3's target is 690px but the band is 600px: never upscale.
    const r = coverCropRect(600, 800, { w: 16, h: 9 });
    const bandW = Math.round(r.sw);
    const bandH = Math.round(r.sh);
    expect(thumbTargetWidth(3)).toBe(690);
    const plan = downscalePlan(bandW, bandH, thumbTargetWidth(3));
    expect(plan.w).toBe(bandW);
    expect(plan.h).toBe(bandH);
    expect(plan.method).toBe("none");
  });
});

describe("the shared quality downscale preserves thin lines (the panel-thumb bug)", () => {
  // Regression: layer-panel thumbnails used one bilinear `drawImage` at ~9× reduction
  // and dropped template rules. `boxDownscaleRgba` is the area-averaging floor.

  /** A white RGBA buffer with a 1-px black horizontal line every `every` rows,
   *  the first line at row `offset` — a minimal ruled/lined template. */
  function ruled(w: number, h: number, every: number, offset: number): Uint8ClampedArray {
    const buf = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = offset; y < h; y += every) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        buf[i] = 0;
        buf[i + 1] = 0;
        buf[i + 2] = 0;
      }
    }
    return buf;
  }

  function darkRows(rgba: Uint8ClampedArray, w: number, h: number): number {
    let count = 0;
    for (let y = 0; y < h; y++) {
      if (rgba[(y * w + (w >> 1)) * 4]! < 250) count++;
    }
    return count;
  }

  /** The naive nearest-row sampler the bug degenerated to, to show what is dropped. */
  function nearestDownscaleRows(src: Uint8ClampedArray, w: number, h: number, dstH: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(w * dstH * 4);
    const sy = h / dstH;
    for (let dy = 0; dy < dstH; dy++) {
      const y = Math.floor(dy * sy);
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;
        const o = (dy * w + x) * 4;
        out[o] = src[s]!;
        out[o + 1] = src[s + 1]!;
        out[o + 2] = src[s + 2]!;
        out[o + 3] = src[s + 3]!;
      }
    }
    return out;
  }

  it("keeps every ruled line the naive single-step path drops (9× reduction)", () => {
    const W = 8;
    const H = 160;
    const src = ruled(W, H, 4, 2);
    const DST_H = 40;

    // The naive sampler lands on rows ≡0 mod 4; lines sit at ≡2, so it drops them all.
    const naive = nearestDownscaleRows(src, W, H, DST_H);
    expect(darkRows(naive, W, DST_H)).toBe(0);

    const box = boxDownscaleRgba(src, W, H, W, DST_H);
    expect(darkRows(box, W, DST_H)).toBe(DST_H);
  });

  it("no line vanishes at an extreme non-integer reduction", () => {
    const W = 4;
    const H = 1500;
    const src = ruled(W, H, 3, 1);
    const DST_H = 160;

    const naive = nearestDownscaleRows(src, W, H, DST_H);
    const box = boxDownscaleRgba(src, W, H, W, DST_H);

    expect(darkRows(box, W, DST_H)).toBe(DST_H);
    expect(darkRows(naive, W, DST_H)).toBeLessThan(DST_H);
  });

  it("a device PEN STROKE survives the filmstrip's 15.6x reduction, in ALPHA", () => {
    // A `.mark` goes 1872 -> 120 px on the page index; the ink is alpha on transparent,
    // so alpha must survive. A fine nib (2-3 px at 11.8 px/mm) floors at alpha 34.
    const W = 8;
    const H = 1872;
    const DST_H = 120;
    /** A horizontal ink stroke `thick` px tall on transparent, at row 900. */
    const stroke = (thick: number): Uint8ClampedArray => {
      const buf = new Uint8ClampedArray(W * H * 4);
      for (let y = 900; y < 900 + thick; y++) {
        for (let x = 0; x < W; x++) buf[(y * W + x) * 4 + 3] = 255;
      }
      return buf;
    };
    const peakAlpha = (rgba: Uint8ClampedArray): number => {
      let max = 0;
      for (let y = 0; y < DST_H; y++) max = Math.max(max, rgba[(y * W + (W >> 1)) * 4 + 3]!);
      return max;
    };

    expect(peakAlpha(nearestDownscaleRows(stroke(2), W, H, DST_H))).toBe(0);

    expect(peakAlpha(boxDownscaleRgba(stroke(2), W, H, W, DST_H))).toBeGreaterThanOrEqual(34);
    expect(peakAlpha(boxDownscaleRgba(stroke(3), W, H, W, DST_H))).toBeGreaterThanOrEqual(51);
    expect(peakAlpha(boxDownscaleRgba(stroke(5), W, H, W, DST_H))).toBeGreaterThanOrEqual(68);
    expect(boxDownscaleRgba(stroke(3), W, H, W, DST_H)[(10 * W + 4) * 4 + 3]).toBe(0);
  });

  it("leaves an all-white source white and preserves aspect dims", () => {
    const W = 12;
    const H = 90;
    const white = new Uint8ClampedArray(W * H * 4).fill(255);
    const out = boxDownscaleRgba(white, W, H, 4, 30);
    expect(out.length).toBe(4 * 30 * 4);
    expect(darkRows(out, 4, 30)).toBe(0);
    expect([...out.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });
});

describe("persistent negative-thumbnail memo (the hard-reload 404 fix)", () => {
  it("a definitive 404 is persisted: a SECOND facade instance never probes", async () => {
    const memo = fakeCoverMemo();
    const s1 = build({ net: fakeNet({ bytes: vi.fn(async () => null) }), coverMemo: memo });
    await s1.thumbs.getThumbnail(noteSrc("n404"), "note");
    expect(memo.persisted.has("n404")).toBe(true);

    const net2 = fakeNet({ bytes: vi.fn(async () => null) });
    const s2 = build({ net: net2, coverMemo: memo });
    await s2.thumbs.getThumbnail(noteSrc("n404"), "note");
    expect(net2.bytes).not.toHaveBeenCalled();
  });

  it("a transport failure is session-only: a second instance probes again", async () => {
    const memo = fakeCoverMemo();
    const failing = fakeNet();
    (failing as { probe?: ThumbNet["probe"] }).probe = vi.fn(async () => null);
    const s1 = build({ net: failing, coverMemo: memo });
    await s1.thumbs.getThumbnail(noteSrc("nOff"), "note");
    expect(memo.persisted.has("nOff")).toBe(false);
    expect(memo.session.has("nOff")).toBe(true);

    const net2 = withProbe(fakeNet());
    const s2 = build({ net: net2, coverMemo: fakeCoverMemo() });
    await s2.thumbs.getThumbnail(noteSrc("nOff"), "note");
    expect(net2.bytes).toHaveBeenCalled();
  });

  it("an .spd's missing embedded thumbnail persists the same way", async () => {
    const memo = fakeCoverMemo();
    const s1 = build({ net: fakeNet({ bytes: vi.fn(async () => null) }), coverMemo: memo });
    await s1.thumbs.getThumbnail(fileSrc("s404"), "spd");
    expect(memo.persisted.has("s404")).toBe(true);

    const net2 = fakeNet({ bytes: vi.fn(async () => null) });
    const s2 = build({ net: net2, coverMemo: memo });
    await s2.thumbs.getThumbnail(fileSrc("s404"), "spd");
    expect(net2.bytes).not.toHaveBeenCalled();
  });
});

describe("facade persistent tier — the shared sn-thumbs store", () => {
  // `[hot memo] → sn-thumbs → produce`, with a fake store for IndexedDB.

  it("write-through: a produced facade thumbnail is PUT to the store", async () => {
    const store = fakePersistentStore();
    const t = build({ persistent: store });
    const blob = await t.thumbs.getThumbnail(fileSrc("wt"), "spd");
    expect(store.put).toHaveBeenCalledTimes(1);
    const [key, stored] = store.put.mock.calls[0]!;
    expect(stored).toBe(blob);
    expect(key).toMatch(/^facade:v\d+:wt:light:b\d+$/);
  });

  it("read-through across a NEW SESSION: a fresh facade serves the persisted blob without producing", async () => {
    const store = fakePersistentStore();
    const s1 = build({ persistent: store });
    await s1.thumbs.getThumbnail(fileSrc("rt"), "spd");
    expect(store.map.size).toBe(1);

    const s2 = build({ persistent: store });
    const blob = await s2.thumbs.getThumbnail(fileSrc("rt"), "spd");
    expect(await tagOf(blob)).toBe("image:light");
    expect(s2.net.bytes).not.toHaveBeenCalled();
    expect(s2.painter.fromImageBytes).not.toHaveBeenCalled();
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it("key isolation: a facade key never equals a renderCache hash:thumb:theme id for the same hash/theme", async () => {
    const store = fakePersistentStore();
    const t = build({ persistent: store });
    // The same page hash a renderCache thumb would use: the keys must not collide.
    await t.thumbs.getThumbnail({ fileHash: null, noteId: "n1", page: page("collide") }, "note");
    const facadeKey = store.put.mock.calls.at(-1)![0] as string;
    const renderKey = cacheId({ hash: "collide", size: "thumb", theme: "light" });
    expect(facadeKey).not.toBe(renderKey);
    expect(facadeKey.startsWith("facade:")).toBe(true);
    expect(renderKey.startsWith("facade:")).toBe(false);
    expect(facadeKey.includes(":thumb:")).toBe(false);
  });

  it("fail-open on get: a store whose get THROWS still returns the produced blob", async () => {
    const store = fakePersistentStore({
      get: vi.fn(async () => {
        throw new Error("idb get boom");
      }),
    });
    const t = build({ persistent: store });
    const blob = await t.thumbs.getThumbnail(fileSrc("fo1"), "spd");
    expect(await tagOf(blob)).toBe("image:light");
    expect(t.painter.fromImageBytes).toHaveBeenCalledTimes(1);
  });

  it("fail-open on put: a store whose put THROWS never sinks the produced blob", async () => {
    const store = fakePersistentStore({
      put: vi.fn(async () => {
        throw new Error("idb put boom");
      }),
    });
    const t = build({ persistent: store });
    const blob = await t.thumbs.getThumbnail(fileSrc("fo2"), "spd");
    expect(await tagOf(blob)).toBe("image:light");
  });

  it("version bump: an entry persisted under an OLD version token is not served under the new one", async () => {
    const store = fakePersistentStore();
    const s1 = build({ persistent: store });
    await s1.thumbs.getThumbnail(fileSrc("ver"), "spd");
    const currentKey = store.put.mock.calls[0]![0] as string;
    const persistedBlob = store.map.get(currentKey)!;

    // A stale entry under an older version token.
    const oldKey = currentKey.replace(/^facade:v\d+:/, "facade:v0:");
    store.map.clear();
    store.map.set(oldKey, persistedBlob);
    store.get.mockClear();
    store.put.mockClear();

    const s2 = build({ persistent: store });
    await s2.thumbs.getThumbnail(fileSrc("ver"), "spd");
    expect(s2.painter.fromImageBytes).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.put.mock.calls[0]![0]).toBe(currentKey);
  });

  it("glyphs are never persisted — they regenerate instantly and earn no byte of the shared budget", async () => {
    const store = fakePersistentStore();
    const t = build({ persistent: store });
    await t.thumbs.getThumbnail(fileSrc("g"), "doc");
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("a persisted .pdf tile is served WITHOUT the decoder — the wasm never loads twice", async () => {
    // Only `produce` reaches `renderPdfPage`, so a revisit never fetches the 5.3 MB module.
    const store = fakePersistentStore();
    const s1 = build({ persistent: store });
    await s1.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    expect(s1.renderPdfPage).toHaveBeenCalledTimes(1);
    const [key] = store.put.mock.calls[0]!;
    expect(key).toMatch(/^facade:v\d+:pdfh:pdf:b\d+$/);

    const s2 = build({ persistent: store });
    const blob = await s2.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    expect(await tagOf(blob)).toBe("note");
    expect(s2.renderPdfPage).not.toHaveBeenCalled();
  });

  it("a 404 fallback persists NOTHING — not the caught failure, not the glyph it becomes", async () => {
    const store = fakePersistentStore();
    const t = build({ net: fakeNet({ bytes: vi.fn(async () => null) }), persistent: store });
    const blob = await t.thumbs.getThumbnail(fileSrc("miss"), "spd");
    expect(await tagOf(blob)).toBe("glyph:SPD:light");
    expect(store.put).not.toHaveBeenCalled();
  });

  it("null store (memory-only) is a clean no-op: everything still resolves", async () => {
    const t = build({ persistent: null });
    const blob = await t.thumbs.getThumbnail(fileSrc("nostore"), "spd");
    expect(await tagOf(blob)).toBe("image:light");
  });
});
