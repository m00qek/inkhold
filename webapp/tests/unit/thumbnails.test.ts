import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createThumbnails,
  strategyFor,
  boxDownscaleRgba,
  coverCropRect,
  downscalePlan,
  type ThumbNet,
  type ThumbPainter,
  type ThumbSource,
} from "../../src/render/thumbnails";
import { thumbTargetWidth } from "../../src/render/types";
import { FACADE_THUMB_TYPES } from "../../src/pages/galleryCards";
import { fileKind, PREVIEWABLE_IMAGE_TYPES, UPLOAD_ACCEPT } from "../../src/core/fileKind";
import type { PersistentThumbStore } from "../../src/cache/idb";
import { cacheId } from "../../src/cache/renderCache";
import type { Id, PageRef, Theme } from "../../src/core/types";

// The facade's orchestration with every pixel/network seam faked; the real seams are e2e's.

/** A tagged fake blob, so a test can tell WHICH strategy produced a result. */
const tagged = (tag: string): Blob => new Blob([tag], { type: "image/webp" });
const tagOf = async (b: Blob): Promise<string> => b.text();

function page(hash: string): PageRef {
  return { index: 0, hash, width: 1404, height: 1872, textHash: null };
}

function fakePainter() {
  const glyph = vi.fn(async (kind: string, theme: Theme) => tagged(`glyph:${kind}:${theme}`));
  const fromImageBytes = vi.fn(
    async (_b: Blob, theme: Theme, _cropAspect?: { w: number; h: number }) => tagged(`image:${theme}`),
  );
  const fromBitmap = vi.fn(async (_bm: ImageBitmap) => tagged("note"));
  const textSnippet = vi.fn(async (content: string, theme: Theme) => tagged(`text:${content.slice(0, 3)}:${theme}`));
  // A fixed 3000×2000 source, so the dims memo can be checked for source truth.
  const imageTile = vi.fn(async (_b: Blob) => ({ blob: tagged("imgdoc"), sourceW: 3000, sourceH: 2000 }));
  return { glyph, fromImageBytes, fromBitmap, textSnippet, imageTile } satisfies ThumbPainter;
}

function fakeNet(over: Partial<ThumbNet> = {}) {
  return {
    bytes: vi.fn(async () => tagged("bytes")),
    text: vi.fn(async () => "hello\nworld\nthird line"),
    ...over,
  } as ThumbNet & { bytes: ReturnType<typeof vi.fn>; text: ReturnType<typeof vi.fn> };
}

/** Without a test `probe`, delegate to `bytes` and read null as a definitive 404. */
function withProbe(net: ReturnType<typeof fakeNet>): ReturnType<typeof fakeNet> {
  if (!("probe" in net) || net.probe === undefined) {
    (net as { probe?: ThumbNet["probe"] }).probe = vi.fn(async (url: string) => {
      const b = await net.bytes(url);
      return b ?? "not-found";
    });
  }
  return net;
}

/** A fresh cover memo per test; the module-level instance must not leak state. */
function fakeCoverMemo() {
  const persisted = new Set<string>();
  const session = new Set<string>();
  return {
    persisted,
    session,
    async hasNoCover(hash: string) {
      return persisted.has(hash) || session.has(hash);
    },
    async setNoCover(hash: string) {
      persisted.add(hash);
    },
    noteTransientMiss(hash: string) {
      session.add(hash);
    },
  };
}

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

function build(
  opts: {
    theme?: () => Theme;
    net?: ThumbNet;
    coverMemo?: ReturnType<typeof fakeCoverMemo>;
    persistent?: PersistentThumbStore | null;
    pdf?: false;
  } = {},
) {
  const painter = fakePainter();
  const net = withProbe((opts.net ?? fakeNet()) as ReturnType<typeof fakeNet>);
  const coverMemo = opts.coverMemo ?? fakeCoverMemo();
  const renderNote = vi.fn(async () => ({ width: 240, height: 320, close() {} }) as unknown as ImageBitmap);
  // The PDF bitmap is the facade's to close (renderNote's belongs to the render cache).
  const pdfBitmaps: Array<{ closed: boolean }> = [];
  const renderPdfPage = vi.fn(async (_id: Id, _hash: string, _o?: { bin?: boolean }) => {
    const bitmap = { width: 230, height: 345, closed: false, close(): void { bitmap.closed = true; } };
    pdfBitmaps.push(bitmap);
    return { bitmap: bitmap as unknown as ImageBitmap, pageW: 400, pageH: 600 };
  });
  // Injected dims sink, so tests never touch the module-level persistent memo.
  const setDims = vi.fn(async (_hash: string, _dims: { w: number; h: number }) => {});
  const thumbs = createThumbnails({
    coverMemo,
    getTheme: opts.theme ?? (() => "light"),
    net,
    painter,
    renderNote,
    // `pdf: false`: a browser that cannot run the decoder; the glyph floor must survive.
    renderPdfPage: opts.pdf === false ? undefined : renderPdfPage,
    setDims,
    persistent: opts.persistent,
  });
  return {
    coverMemo,
    thumbs,
    painter,
    net: net as ReturnType<typeof fakeNet>,
    renderNote,
    renderPdfPage,
    pdfBitmaps,
    setDims,
  };
}

const noteSrc = (fileHash = "notehash"): ThumbSource => ({ fileHash, fileId: "n1", noteId: "n1", page: page("pageh") });
const fileSrc = (hash: string | null): ThumbSource => ({ fileHash: hash, fileId: "f1" });

describe("strategyFor", () => {
  it("maps each type to its closed strategy", () => {
    expect(strategyFor("note")).toBe("note-page");
    expect(strategyFor("spd")).toBe("image");
    expect(strategyFor("png")).toBe("image-doc");
    expect(strategyFor("JPG")).toBe("image-doc");
    expect(strategyFor("webp")).toBe("image-doc");
    expect(strategyFor("gif")).toBe("image-doc");
    expect(strategyFor("txt")).toBe("text");
    expect(strategyFor("pdf")).toBe("pdf-page");
    expect(strategyFor("epub")).toBe("glyph");
    expect(strategyFor("")).toBe("glyph");
    expect(strategyFor("mystery")).toBe("glyph");
  });
});

describe("the two dispatch points agree (DESIGN.md §11.5, rows 4 and 5)", () => {
  // Catches `strategyFor` returning a strategy for a type `FACADE_THUMB_TYPES` omits
  // (it happened for `.txt` and `.pdf`). The vocabulary is derived, not restated.
  const VOCABULARY = [
    ...UPLOAD_ACCEPT,
    ...PREVIEWABLE_IMAGE_TYPES,
    "note",
    "mark",
    "file",
    "folder",
    "",
    "mystery",
  ];

  it("every type the card sends to the facade has a real strategy, and vice versa", () => {
    for (const type of VOCABULARY) {
      const strategy = strategyFor(type);
      const kind = fileKind(type.trim().toLowerCase());
      // Notes and images are routed by `fileKind` first, so the set must not claim them.
      if (kind === "note") {
        // `thumbMedia` sends `"note"` even for a `.mark`, so `strategyFor("mark")` is unreachable.
        expect(strategyFor("note"), `${type} is sent to the facade as "note"`).toBe("note-page");
        continue;
      }
      if (kind === "image") {
        expect(strategy, `${type}: a raster image`).toBe("image-doc");
        continue;
      }
      expect(
        FACADE_THUMB_TYPES.has(type.trim().toLowerCase()),
        `"${type}" has strategy "${strategy}" — FACADE_THUMB_TYPES must agree`,
      ).toBe(strategy !== "glyph");
    }
  });

  it("the set never claims a type `fileKind` already routes elsewhere", () => {
    for (const type of FACADE_THUMB_TYPES) {
      expect(fileKind(type), `${type} is dispatched by fileKind, not by the set`).toBe("file");
    }
  });
});

describe("thumbnail facade", () => {
  it("every strategy resolves to a WebP blob, never null", async () => {
    const t = build();
    for (const [src, type] of [
      [fileSrc(null), "folder"],
      [noteSrc(), "note"],
      [fileSrc("h1"), "spd"],
      [fileSrc("h2"), "png"],
      [fileSrc("h3"), "txt"],
      [fileSrc("h4"), "pdf"],
    ] as const) {
      const blob = await t.thumbs.getThumbnail(src, type);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe("image/webp");
    }
  });

  it("the glyph path draws client-side and makes NO network call", async () => {
    const t = build();
    const blob = await t.thumbs.getThumbnail(fileSrc("h9"), "doc");
    expect(await tagOf(blob)).toBe("glyph:DOC:light");
    expect(t.painter.glyph).toHaveBeenCalledTimes(1);
    expect(t.net.bytes).not.toHaveBeenCalled();
    expect(t.net.text).not.toHaveBeenCalled();
    expect(t.renderNote).not.toHaveBeenCalled();
    expect(t.renderPdfPage).not.toHaveBeenCalled();
  });

  it("a folder (null hash) is a folder glyph, no network", async () => {
    const t = build();
    const blob = await t.thumbs.getThumbnail(fileSrc(null), "");
    expect(await tagOf(blob)).toBe("glyph:folder:light");
    expect(t.net.bytes).not.toHaveBeenCalled();
  });

  it("a .note with a cover prefers it: /thumbnail fetched + transcoded, render pipeline untouched", async () => {
    const t = build();
    const blob = await t.thumbs.getThumbnail(noteSrc("abcnote"), "note");
    expect(await tagOf(blob)).toBe("image:light");
    expect(t.net.bytes).toHaveBeenCalledWith("/thumbnail/abcnote");
    expect(t.painter.fromImageBytes).toHaveBeenCalledTimes(1);
    expect(t.renderNote).not.toHaveBeenCalled();
    expect(t.painter.fromBitmap).not.toHaveBeenCalled();
  });

  it("a coverless .note (404) falls back to the injected render pipeline, once per session", async () => {
    const t = build({ net: fakeNet({ bytes: vi.fn(async () => null) }) });
    const blob = await t.thumbs.getThumbnail(noteSrc(), "note");
    expect(await tagOf(blob)).toBe("note");
    expect(t.renderNote).toHaveBeenCalledWith("n1", expect.objectContaining({ hash: "pageh" }), "light");
    expect(t.painter.fromBitmap).toHaveBeenCalledTimes(1);
    // The miss is remembered per hash: one 404 per session.
    await t.thumbs.getThumbnail(noteSrc(), "note");
    expect(t.net.bytes).toHaveBeenCalledTimes(1);
  });

  it("a .note with no hash at all skips the cover probe and renders", async () => {
    const t = build();
    const blob = await t.thumbs.getThumbnail({ fileHash: null, noteId: "n1", page: page("pageh") }, "note");
    expect(await tagOf(blob)).toBe("note");
    expect(t.net.bytes).not.toHaveBeenCalled();
  });

  it("a .pdf renders its page 0 — straight to the render, no cover probe first", async () => {
    const t = build();
    const blob = await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    expect(await tagOf(blob)).toBe("note");
    expect(t.renderPdfPage).toHaveBeenCalledWith("p1", "pdfh", { bin: undefined });
    // A PDF has no cover, so no `/thumbnail/{hash}` round trip.
    expect(t.net.bytes).not.toHaveBeenCalled();
    expect(t.painter.fromBitmap).toHaveBeenCalledTimes(1);
  });

  it("a .pdf tile FREES the bitmap it was handed — it is the facade's, not a cache's", async () => {
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    expect(t.pdfBitmaps).toHaveLength(1);
    expect(t.pdfBitmaps[0]!.closed).toBe(true);
  });

  it("a .pdf records page 0's OWN box as the tile's aspect (the masonry memo)", async () => {
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    // The page's points (cropped, rotated), not raster pixels.
    expect(t.setDims).toHaveBeenCalledWith("pdfh", { w: 400, h: 600 });
  });

  it("a .pdf keys THEME-FREE: a theme toggle must not re-open the document", async () => {
    let theme: Theme = "light";
    const t = build({ theme: () => theme });
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    theme = "dark";
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    // MuPDF draws on white in both themes; re-opening for a toggle is the costliest produce.
    expect(t.renderPdfPage).toHaveBeenCalledTimes(1);
    t.thumbs.evictTheme("light");
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    expect(t.renderPdfPage).toHaveBeenCalledTimes(1);
  });

  it("a TRASHED .pdf renders off the bin-scoped route, so its tile is not a 404", async () => {
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1", bin: true }, "pdf");
    expect(t.renderPdfPage).toHaveBeenCalledWith("p1", "pdfh", { bin: true });
  });

  it("a .pdf that will not render falls back to the glyph, never an empty tile", async () => {
    const t = build();
    t.renderPdfPage.mockRejectedValueOnce(new Error("encrypted"));
    const blob = await t.thumbs.getThumbnail({ fileHash: "bad", fileId: "p1" }, "pdf");
    expect(await tagOf(blob)).toBe("glyph:PDF:light");
    expect(t.setDims).not.toHaveBeenCalled();
  });

  it("a .pdf with no renderer at all (no JSPI) is the glyph, and nothing is attempted", async () => {
    const t = build({ pdf: false });
    const blob = await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    expect(await tagOf(blob)).toBe("glyph:PDF:light");
    expect(t.net.bytes).not.toHaveBeenCalled();
  });

  it("a hashless or id-less .pdf has nothing to open → its own glyph", async () => {
    const t = build();
    const noHash = await t.thumbs.getThumbnail({ fileHash: null, fileId: "p1" }, "pdf");
    const noId = await t.thumbs.getThumbnail({ fileHash: "h" }, "pdf");
    expect(await tagOf(noHash)).toBe("glyph:PDF:light");
    expect(await tagOf(noId)).toBe("glyph:PDF:light");
    expect(t.renderPdfPage).not.toHaveBeenCalled();
  });

  it("a .spd fetches the embedded-thumbnail endpoint, then transcodes", async () => {
    const t = build();
    const blob = await t.thumbs.getThumbnail(fileSrc("abc"), "spd");
    expect(await tagOf(blob)).toBe("image:light");
    expect(t.net.bytes).toHaveBeenCalledWith("/thumbnail/abc");
    expect(t.painter.fromImageBytes).toHaveBeenCalledTimes(1);
  });

  it("the .spd (image) strategy passes source.aspect THROUGH to the painter's crop", async () => {
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: "big", fileId: "f1", aspect: { w: 16, h: 9 } }, "spd");
    // The canvas aspect lets the transcode de-letterbox the fixed-portrait preview.
    expect(t.painter.fromImageBytes).toHaveBeenCalledTimes(1);
    const [, , cropAspect] = t.painter.fromImageBytes.mock.calls[0]!;
    expect(cropAspect).toEqual({ w: 16, h: 9 });
  });

  it("a .spd with NO aspect transcodes whole — no crop arg (behaves as before)", async () => {
    const t = build();
    await t.thumbs.getThumbnail(fileSrc("noasp"), "spd");
    expect(t.painter.fromImageBytes).toHaveBeenCalledTimes(1);
    const [, , cropAspect] = t.painter.fromImageBytes.mock.calls[0]!;
    expect(cropAspect).toBeUndefined();
  });

  it("an image file fetches the raw-file URL, not the thumbnail endpoint", async () => {
    const t = build();
    await t.thumbs.getThumbnail(fileSrc("def"), "png");
    expect(t.net.bytes).toHaveBeenCalledTimes(1);
    expect(t.net.bytes.mock.calls[0]![0]).toMatch(/^\/file\/f1\?v=def$/);
    expect(t.painter.imageTile).toHaveBeenCalledTimes(1);
    expect(t.painter.fromImageBytes).not.toHaveBeenCalled();
  });

  it("a .spd with no embedded thumbnail (404) falls back to the glyph", async () => {
    const t = build({ net: fakeNet({ bytes: vi.fn(async () => null) }) });
    const blob = await t.thumbs.getThumbnail(fileSrc("ghi"), "spd");
    expect(await tagOf(blob)).toBe("glyph:SPD:light");
    expect(t.painter.fromImageBytes).not.toHaveBeenCalled();
    expect(t.painter.glyph).toHaveBeenCalledTimes(1);
  });

  it(".txt rasterises a snippet of the fetched head, not a static glyph", async () => {
    const t = build();
    const blob = await t.thumbs.getThumbnail(fileSrc("txth"), "txt");
    expect(await tagOf(blob)).toBe("text:hel:light");
    expect(t.net.text).toHaveBeenCalledTimes(1);
    expect(t.painter.textSnippet).toHaveBeenCalledTimes(1);
    expect(t.painter.glyph).not.toHaveBeenCalled();
  });

  it("an unreadable .txt (404) falls back to the glyph", async () => {
    const t = build({ net: fakeNet({ text: vi.fn(async () => null) }) });
    const blob = await t.thumbs.getThumbnail(fileSrc("t2"), "txt");
    expect(await tagOf(blob)).toBe("glyph:TXT:light");
    expect(t.painter.textSnippet).not.toHaveBeenCalled();
  });

  it("a TRASHED image/text file fetches the BIN-scoped raw route, not the live one", async () => {
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: "png", fileId: "f1", bin: true }, "png");
    await t.thumbs.getThumbnail({ fileHash: "txt", fileId: "f1", bin: true }, "txt");
    // The live `/file/{id}` 404s for trashed files, so raw-file strategies use the bin twin.
    expect(t.net.bytes.mock.calls[0]![0]).toMatch(/^\/api\/controlplane\/bin\/file\/f1\?v=png$/);
    expect(t.net.text.mock.calls[0]![0]).toMatch(/^\/api\/controlplane\/bin\/file\/f1\?v=txt$/);
  });

  it("a trashed .spd/.note cover still probes the content-addressed /thumbnail route, flag or not", async () => {
    // `/thumbnail/{hash}` is content-addressed and serves trashed blobs too.
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: "spdh", fileId: "f1", bin: true }, "spd");
    expect(t.net.bytes).toHaveBeenCalledWith("/thumbnail/spdh");
  });

  it("a hashless image/text file cannot be fetched → its own glyph", async () => {
    const t = build();
    const spd = await t.thumbs.getThumbnail({ fileHash: null, fileId: "x" }, "spd");
    const txt = await t.thumbs.getThumbnail({ fileHash: null, fileId: "x" }, "txt");
    expect(t.net.bytes).not.toHaveBeenCalled();
    expect(t.net.text).not.toHaveBeenCalled();
    expect(await tagOf(spd)).toBe("glyph:SPD:light");
    expect(await tagOf(txt)).toBe("glyph:TXT:light");
    expect(t.painter.glyph).toHaveBeenCalledTimes(2);
  });

  it("caches by content hash — a repeat request produces once", async () => {
    const t = build();
    const a = t.thumbs.getThumbnail(fileSrc("same"), "spd");
    const b = t.thumbs.getThumbnail(fileSrc("same"), "spd");
    await Promise.all([a, b]);
    await t.thumbs.getThumbnail(fileSrc("same"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(1);
    expect(t.painter.fromImageBytes).toHaveBeenCalledTimes(1);
  });

  it("keys by theme — light and dark are distinct entries", async () => {
    let theme: Theme = "light";
    const t = build({ theme: () => theme });
    const light = await t.thumbs.getThumbnail(fileSrc("k"), "spd");
    theme = "dark";
    const dark = await t.thumbs.getThumbnail(fileSrc("k"), "spd");
    expect(await tagOf(light)).toBe("image:light");
    expect(await tagOf(dark)).toBe("image:dark");
    expect(t.net.bytes).toHaveBeenCalledTimes(2);
    expect(t.painter.fromImageBytes).toHaveBeenCalledTimes(2);
  });

  it("glyphs key by type:theme — one folder glyph shared across folders", async () => {
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: null }, "");
    await t.thumbs.getThumbnail({ fileHash: null }, "folder");
    expect(t.painter.glyph).toHaveBeenCalledTimes(1);
  });

  it("a failed render is not cached — the next request retries", async () => {
    const renderNote = vi
      .fn<() => Promise<ImageBitmap>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ width: 1, height: 1, close() {} } as unknown as ImageBitmap);
    const painter = fakePainter();
    const net = fakeNet({ bytes: vi.fn(async () => null) });
    const thumbs = createThumbnails({ getTheme: () => "light", net, painter, renderNote });
    await expect(thumbs.getThumbnail(noteSrc(), "note")).rejects.toThrow("boom");
    const ok = await thumbs.getThumbnail(noteSrc(), "note");
    expect(await tagOf(ok)).toBe("note");
    expect(renderNote).toHaveBeenCalledTimes(2);
  });

  it("records the image SOURCE's true dims into the memo, once per hash", async () => {
    const t = build();
    await t.thumbs.getThumbnail(fileSrc("dimhash"), "jpeg");
    await t.thumbs.getThumbnail(fileSrc("dimhash"), "jpeg");
    expect(t.setDims).toHaveBeenCalledTimes(1);
    expect(t.setDims).toHaveBeenCalledWith("dimhash", { w: 3000, h: 2000 });
  });

  it("an image document fetches its raw bytes ONCE per hash — theme toggles included", async () => {
    let theme: Theme = "light";
    const t = build({ theme: () => theme });
    const light = await t.thumbs.getThumbnail(fileSrc("imgh"), "png");
    theme = "dark";
    const dark = await t.thumbs.getThumbnail(fileSrc("imgh"), "png");
    expect(t.net.bytes).toHaveBeenCalledTimes(1);
    expect(t.painter.imageTile).toHaveBeenCalledTimes(1);
    expect(await tagOf(light)).toBe("imgdoc");
    expect(await tagOf(dark)).toBe("imgdoc");
  });

  it("evictTheme leaves theme-free image-document tiles cached", async () => {
    const t = build();
    await t.thumbs.getThumbnail(fileSrc("keepme"), "png");
    t.thumbs.evictTheme("light");
    await t.thumbs.getThumbnail(fileSrc("keepme"), "png");
    expect(t.net.bytes).toHaveBeenCalledTimes(1);
  });

  it("a 404 image document falls back to the glyph and records no dims", async () => {
    const t = build({ net: fakeNet({ bytes: vi.fn(async () => null) }) });
    const blob = await t.thumbs.getThumbnail(fileSrc("gone"), "png");
    expect(await tagOf(blob)).toBe("glyph:PNG:light");
    expect(t.setDims).not.toHaveBeenCalled();
  });

  it("evictTheme drops only that theme's cached blobs", async () => {
    let theme: Theme = "light";
    const t = build({ theme: () => theme });
    await t.thumbs.getThumbnail(fileSrc("e"), "spd");
    theme = "dark";
    await t.thumbs.getThumbnail(fileSrc("e"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(2);

    t.thumbs.evictTheme("light");
    theme = "dark";
    await t.thumbs.getThumbnail(fileSrc("e"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(2);
    theme = "light";
    await t.thumbs.getThumbnail(fileSrc("e"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(3);
  });
});

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
