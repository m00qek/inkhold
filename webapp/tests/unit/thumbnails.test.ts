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

// The facade's ORCHESTRATION is what these exercise — dispatch, cache keys,
// 404-fallback, theme separation — with every pixel/network seam faked, so it
// runs on plain Node with no canvas and no server. The real canvas/fetch seams
// (`createCanvasThumbPainter`/`createFetchThumbNet`) are browser code, covered by
// the e2e layer.

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
  // The image-document tile: a fixed 3000×2000 "photo" source, so dims-memo
  // assertions can check the SOURCE truth is what gets recorded.
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

/** Unless a test supplies its own `probe`, delegate to `bytes` and read null as
 *  a DEFINITIVE 404 — the pre-probe tests were written when null meant exactly
 *  that, so their call-count assertions keep working unchanged. */
function withProbe(net: ReturnType<typeof fakeNet>): ReturnType<typeof fakeNet> {
  if (!("probe" in net) || net.probe === undefined) {
    (net as { probe?: ThumbNet["probe"] }).probe = vi.fn(async (url: string) => {
      const b = await net.bytes(url);
      return b ?? "not-found";
    });
  }
  return net;
}

/** A fresh in-memory cover memo per test — the module-level shared instance
 *  must never leak state across tests. */
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
  // The PDF seam. Its bitmap is the FACADE'S to close (unlike renderNote's,
  // which belongs to the render cache), so the fake records the close.
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
    // `pdf: false` builds the facade WITHOUT the seam — the state a browser that
    // cannot run the decoder is in, and the one the glyph floor must survive.
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
    // Plain raster documents are the LOCAL-ONLY branch: raw bytes fetched once,
    // downscaled client-side, true dims memoised.
    expect(strategyFor("png")).toBe("image-doc");
    expect(strategyFor("JPG")).toBe("image-doc");
    expect(strategyFor("webp")).toBe("image-doc");
    expect(strategyFor("gif")).toBe("image-doc");
    expect(strategyFor("txt")).toBe("text");
    // A `.pdf` renders its page 0 client-side through the MuPDF wasm — the same
    // decoder the viewer uses. No cover branch: it has none, and neither does
    // its `.mark` sibling.
    expect(strategyFor("pdf")).toBe("pdf-page");
    expect(strategyFor("epub")).toBe("glyph");
    expect(strategyFor("")).toBe("glyph");
    expect(strategyFor("mystery")).toBe("glyph");
  });
});

describe("the two dispatch points agree (ARCHITECTURE.md registration 4 and 5)", () => {
  // THE HAZARD THIS EXISTS FOR. `strategyFor` can return a real strategy while
  // `FACADE_THUMB_TYPES` still omits the type, and the card goes on drawing a
  // glyph with nothing to indicate why — a silent degradation nothing
  // type-checks. It has now been live for two file types (`.txt`, then `.pdf`);
  // this is what stops a third landing it.
  //
  // The vocabulary is derived, not restated: every type the web may upload plus
  // every type the device authors, so a new previewable type joins the sweep by
  // being addable at all rather than by someone remembering this file.
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
      // Notes and images are routed by `fileKind` before the set is consulted
      // (a note always goes through the facade, an image is a native <img>), so
      // the set speaks for everything else — and must not claim those two.
      if (kind === "note") {
        // The card OVERRIDES the type on this branch: `thumbMedia` sends the
        // literal `"note"` even for a `.mark`, so `strategyFor("mark")` is never
        // consulted and its `glyph` answer is unreachable rather than wrong.
        // What must hold is that the type actually sent has the strategy.
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
    // The miss is remembered per hash: a repaint goes straight to the (cached)
    // render — the whole session costs ONE cheap 404, not one per repaint.
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
    expect(await tagOf(blob)).toBe("note"); // the fake painter's fromBitmap tag
    expect(t.renderPdfPage).toHaveBeenCalledWith("p1", "pdfh", { bin: undefined });
    // A PDF has no cover to try — not in the file, not in its `.mark` — so the
    // arm must NOT spend a `/thumbnail/{hash}` round trip discovering that.
    expect(t.net.bytes).not.toHaveBeenCalled();
    expect(t.painter.fromBitmap).toHaveBeenCalledTimes(1);
  });

  it("a .pdf tile FREES the bitmap it was handed — it is the facade's, not a cache's", async () => {
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    expect(t.pdfBitmaps).toHaveLength(1);
    // `renderNote`'s bitmap belongs to the render cache and must be left alone;
    // this one was transferred out of the worker and nothing else holds it.
    expect(t.pdfBitmaps[0]!.closed).toBe(true);
  });

  it("a .pdf records page 0's OWN box as the tile's aspect (the masonry memo)", async () => {
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    // The page's points (the cropped, rotated box), not the raster's pixels —
    // which is what makes a landscape or `/Rotate 90` page lay out honestly.
    expect(t.setDims).toHaveBeenCalledWith("pdfh", { w: 400, h: 600 });
  });

  it("a .pdf keys THEME-FREE: a theme toggle must not re-open the document", async () => {
    let theme: Theme = "light";
    const t = build({ theme: () => theme });
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    theme = "dark";
    await t.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    // MuPDF draws ink on white paper: the raster is the same in both themes, and
    // re-opening a document (~1.5 MB of range requests) for a toggle would be by
    // far the most expensive produce in the facade.
    expect(t.renderPdfPage).toHaveBeenCalledTimes(1);
    // …and evictTheme leaves it alone, for the same reason it spares an image.
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
    // The corrected canvas aspect reaches fromImageBytes as its 3rd arg, so the
    // transcode de-letterboxes the fixed-portrait embedded preview at cache time.
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
    // …and it goes through the tier-sized local decode, not the spd transcode.
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
    // The live `/file/{id}` 404s for anything trashed (Files.get hardcodes
    // deleted=0), so both raw-file strategies mint the bin twin.
    expect(t.net.bytes.mock.calls[0]![0]).toMatch(/^\/api\/controlplane\/bin\/file\/f1\?v=png$/);
    expect(t.net.text.mock.calls[0]![0]).toMatch(/^\/api\/controlplane\/bin\/file\/f1\?v=txt$/);
  });

  it("a trashed .spd/.note cover still probes the content-addressed /thumbnail route, flag or not", async () => {
    // `/thumbnail/{hash}` serves trashed blobs too — it is content-addressed —
    // so the cover/embedded-thumbnail probes take no bin flag and key by hash
    // alone (the bytes are the same bytes whichever scope carried them).
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
    // Distinct kinds → two distinct glyphs, not one shared folder glyph.
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
    // One fetch/transcode PER theme, not shared.
    expect(t.net.bytes).toHaveBeenCalledTimes(2);
    expect(t.painter.fromImageBytes).toHaveBeenCalledTimes(2);
  });

  it("glyphs key by type:theme — one folder glyph shared across folders", async () => {
    const t = build();
    await t.thumbs.getThumbnail({ fileHash: null }, "");
    await t.thumbs.getThumbnail({ fileHash: null }, "folder");
    // Both are the folder glyph in the same theme → produced once.
    expect(t.painter.glyph).toHaveBeenCalledTimes(1);
  });

  it("a failed render is not cached — the next request retries", async () => {
    const renderNote = vi
      .fn<() => Promise<ImageBitmap>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ width: 1, height: 1, close() {} } as unknown as ImageBitmap);
    const painter = fakePainter();
    // A coverless note (404), so the render pipeline is what runs.
    const net = fakeNet({ bytes: vi.fn(async () => null) });
    const thumbs = createThumbnails({ getTheme: () => "light", net, painter, renderNote });
    await expect(thumbs.getThumbnail(noteSrc(), "note")).rejects.toThrow("boom");
    // Not pinned: a second attempt runs the pipeline again and succeeds.
    const ok = await thumbs.getThumbnail(noteSrc(), "note");
    expect(await tagOf(ok)).toBe("note");
    expect(renderNote).toHaveBeenCalledTimes(2);
  });

  it("records the image SOURCE's true dims into the memo, once per hash", async () => {
    const t = build();
    await t.thumbs.getThumbnail(fileSrc("dimhash"), "jpeg");
    await t.thumbs.getThumbnail(fileSrc("dimhash"), "jpeg");
    // The fake tile decodes a 3000×2000 source — the SOURCE dims are recorded,
    // never the tier raster's.
    expect(t.setDims).toHaveBeenCalledTimes(1);
    expect(t.setDims).toHaveBeenCalledWith("dimhash", { w: 3000, h: 2000 });
  });

  it("an image document fetches its raw bytes ONCE per hash — theme toggles included", async () => {
    let theme: Theme = "light";
    const t = build({ theme: () => theme });
    const light = await t.thumbs.getThumbnail(fileSrc("imgh"), "png");
    theme = "dark";
    const dark = await t.thumbs.getThumbnail(fileSrc("imgh"), "png");
    // A photo's pixels are its own in both themes: ONE multi-MB fetch, ONE
    // decode, both themes served from the same theme-free entry.
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
    await t.thumbs.getThumbnail(fileSrc("e"), "spd"); // light entry
    theme = "dark";
    await t.thumbs.getThumbnail(fileSrc("e"), "spd"); // dark entry
    expect(t.net.bytes).toHaveBeenCalledTimes(2);

    t.thumbs.evictTheme("light");
    theme = "dark";
    await t.thumbs.getThumbnail(fileSrc("e"), "spd"); // still cached → no new fetch
    expect(t.net.bytes).toHaveBeenCalledTimes(2);
    theme = "light";
    await t.thumbs.getThumbnail(fileSrc("e"), "spd"); // evicted → refetch
    expect(t.net.bytes).toHaveBeenCalledTimes(3);
  });
});

describe("density-bucket cache keys", () => {
  // The pristine tier keys every entry by (hash, theme, bucket), the bucket
  // read from the LIVE devicePixelRatio per call — so a DPR change (monitor
  // hop, zoom) re-produces into a new bucket instead of serving a
  // wrong-density raster, and same-bucket DPRs share one entry.
  afterEach(() => {
    delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  });

  it("a DPR change re-produces into a new bucket; same bucket stays cached", async () => {
    const t = build();
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1;
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd"); // bucket 1
    expect(t.net.bytes).toHaveBeenCalledTimes(1);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1.25; // fractional → bucket 2
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(2);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1.5; // still bucket 2 → cached
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2; // ceil(2)=2 → cached
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(2);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2.5; // → bucket 3
    await t.thumbs.getThumbnail(fileSrc("bk"), "spd");
    expect(t.net.bytes).toHaveBeenCalledTimes(3);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 4; // clamped → still bucket 3
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
  // A `.spd` ships a FIXED 600×800 portrait embedded thumbnail that letterboxes
  // the real drawing in white bands. The crop rect recovers the true-aspect
  // content band, centered; the output is then sized to the density tier (below).

  it("a landscape target crops top/bottom into a centered band (big.spd)", () => {
    // 600×800 portrait preview, true canvas 16:9 (A≈1.778, wider than 0.75).
    const r = coverCropRect(600, 800, { w: 16, h: 9 });
    expect(r.sw).toBe(600); // full width kept
    expect(r.sh).toBeCloseTo(337.5, 1); // 600 / (16/9)
    expect(r.sy).toBeCloseTo(231.25, 1); // (800 - 337.5) / 2 — centered band
    expect(r.sx).toBe(0);
    // The band's own aspect equals the target aspect — no distortion.
    expect(r.sw / r.sh).toBeCloseTo(16 / 9, 3);
  });

  it("a tall-portrait target crops left/right into a centered band", () => {
    // Source 600×800, target taller/narrower than the source (A=0.5 < 0.75).
    const r = coverCropRect(600, 800, { w: 1, h: 2 });
    expect(r.sh).toBe(800); // full height kept
    expect(r.sw).toBeCloseTo(400, 3); // 800 * 0.5
    expect(r.sx).toBeCloseTo(100, 3); // (600 - 400) / 2 — centered band
    expect(r.sy).toBe(0);
    expect(r.sw / r.sh).toBeCloseTo(0.5, 3);
  });

  it("an exact-match aspect (3:4 sketch) is a NO-OP — the full frame", () => {
    const r = coverCropRect(600, 800, { w: 3, h: 4 }); // A=0.75 == 600/800
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

  // The coordinator's density-aware requirement: the crop changes the SOURCE
  // rect, but the OUTPUT is still sized to the bucket tier target (never the raw
  // band) and never upscaled past the band's own pixels.
  it("the cropped output is sized to the bucket tier target, not the raw band", () => {
    // big.spd content band ≈ 600×338 (rounded). At bucket 1 the tier target is
    // 230px wide — the output takes THAT width, preserving the corrected aspect.
    const r = coverCropRect(600, 800, { w: 16, h: 9 });
    const bandW = Math.round(r.sw); // 600
    const bandH = Math.round(r.sh); // 338
    const plan = downscalePlan(bandW, bandH, thumbTargetWidth(1)); // target 230
    expect(thumbTargetWidth(1)).toBe(230);
    expect(plan.w).toBe(230); // bucket target, NOT the 600 raw band
    expect(plan.h).toBe(Math.round((bandH * 230) / bandW));
    expect(plan.method).toBe("high"); // >2× reduction → quality path
    // The band's shape is carried into the output — a landscape tile.
    expect(plan.w / plan.h).toBeCloseTo(16 / 9, 1);
  });

  it("never UPSCALES past the band: a hi-DPR bucket target above the band clamps to source", () => {
    // Bucket 3 target is 690px, but the cropped band is only 600px wide — the
    // plan keeps the band's own size rather than inventing sharpness.
    const r = coverCropRect(600, 800, { w: 16, h: 9 });
    const bandW = Math.round(r.sw); // 600
    const bandH = Math.round(r.sh); // 338
    expect(thumbTargetWidth(3)).toBe(690);
    const plan = downscalePlan(bandW, bandH, thumbTargetWidth(3));
    expect(plan.w).toBe(bandW); // clamped to the 600 band, not inflated to 690
    expect(plan.h).toBe(bandH);
    expect(plan.method).toBe("none");
  });
});

describe("the shared quality downscale preserves thin lines (the panel-thumb bug)", () => {
  // The bug the user saw: the `.spd`/`.note` layer-panel thumbnails painted a
  // full-res (~1872-wide) layer canvas down to ~200px with a SINGLE bilinear
  // `drawImage` step, so at ~9× reduction the sampler skipped most source rows
  // and a RULED template lost lines (or moiréd against the rule spacing). Both
  // panels now route through the shared quality downscale, whose deterministic
  // area-averaging floor (`boxDownscaleRgba`) is pinned here on plain Node — no
  // canvas — against a synthetic ruled source. `createImageBitmap`'s
  // high-quality resize is the browser fast path; this floor is the guarantee.

  /** A white RGBA buffer with a 1-px black horizontal line every `every` rows,
   *  the first line at row `offset` — a minimal ruled/lined template. */
  function ruled(w: number, h: number, every: number, offset: number): Uint8ClampedArray {
    const buf = new Uint8ClampedArray(w * h * 4).fill(255); // opaque white
    for (let y = offset; y < h; y += every) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        buf[i] = 0;
        buf[i + 1] = 0;
        buf[i + 2] = 0; // black, alpha stays 255
      }
    }
    return buf;
  }

  /** Count output rows whose centre pixel is darker than pure white — i.e. rows
   *  that received a line's ink. `< 250` tolerates the box average (a single
   *  black row in a band of white lands well under 250). */
  function darkRows(rgba: Uint8ClampedArray, w: number, h: number): number {
    let count = 0;
    for (let y = 0; y < h; y++) {
      if (rgba[(y * w + (w >> 1)) * 4]! < 250) count++;
    }
    return count;
  }

  /** The naive single-step path the bug had: sample one source row per output
   *  row (nearest), which is what a bilinear downscale degenerates toward at
   *  high reduction — used only to SHOW the box filter fixes what it dropped. */
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
    // 40 lines every 4 rows, each 4-row band holding exactly one line. At a 4×
    // vertical reduction (160 → 40) every output band spans one line.
    const W = 8;
    const H = 160;
    const src = ruled(W, H, 4, 2);
    const DST_H = 40;

    // The naive nearest sampler lands on row 4·dy (≡0 mod 4) — never a line row
    // (lines sit at ≡2) — so it DROPS the whole template: zero dark rows.
    const naive = nearestDownscaleRows(src, W, H, DST_H);
    expect(darkRows(naive, W, DST_H)).toBe(0);

    // The shared box filter averages each band, so EVERY one of the 40 output
    // rows carries its line's ink — no dropped lines.
    const box = boxDownscaleRgba(src, W, H, W, DST_H);
    expect(darkRows(box, W, DST_H)).toBe(DST_H);
  });

  it("no line vanishes at an extreme non-integer reduction", () => {
    // A denser template (every 3 rows) reduced by a non-integer ~9.4× (1500 →
    // 160): the naive sampler drops a large share of lines to blank white rows,
    // while the box filter leaves NO fully-white row — every band it covers held
    // at least one line, so all of them register.
    const W = 4;
    const H = 1500;
    const src = ruled(W, H, 3, 1);
    const DST_H = 160;

    const naive = nearestDownscaleRows(src, W, H, DST_H);
    const box = boxDownscaleRgba(src, W, H, W, DST_H);

    // The box filter drops none; the naive path drops many — the exact regression.
    expect(darkRows(box, W, DST_H)).toBe(DST_H);
    expect(darkRows(naive, W, DST_H)).toBeLessThan(DST_H);
  });

  it("a device PEN STROKE survives the filmstrip's 15.6x reduction, in ALPHA", () => {
    // The PDF page-index composites a `.mark`'s handwriting onto a 120px-tall
    // page raster, so the ink goes 1872 -> 120 — the deepest reduction any
    // surface in this app asks for, and the one where "is it still there?" stops
    // being obvious. Unlike a ruled template this source is TRANSPARENT: a mark
    // layer decodes to alpha 0 everywhere it was not written on, which is what
    // makes it an overlay, so what has to survive the average is the ALPHA and
    // not a luminance.
    //
    // A Nomad panel is 1404px across ~118.64mm — 11.8 px/mm — so a fine nib is
    // 2-3px and a broad one 5. The measured floor for the finest is alpha 34 of
    // 255: over white paper that is luminance 221, a light grey wash. Present,
    // and honest — a faithful area average of a stroke covering 1/15th of its
    // destination pixel cannot be darker than that, and this asserts the
    // arithmetic is doing it rather than dropping the row.
    const W = 8;
    const H = 1872;
    const DST_H = 120;
    /** A horizontal ink stroke `thick` px tall on transparent, at row 900. */
    const stroke = (thick: number): Uint8ClampedArray => {
      const buf = new Uint8ClampedArray(W * H * 4); // all zero: transparent
      for (let y = 900; y < 900 + thick; y++) {
        for (let x = 0; x < W; x++) buf[(y * W + x) * 4 + 3] = 255; // black, opaque
      }
      return buf;
    };
    const peakAlpha = (rgba: Uint8ClampedArray): number => {
      let max = 0;
      for (let y = 0; y < DST_H; y++) max = Math.max(max, rgba[(y * W + (W >> 1)) * 4 + 3]!);
      return max;
    };

    // The naive sampler lands on row 15.6·dy and misses a 2px stroke outright —
    // the whole annotation gone from the strip, which is the failure mode.
    expect(peakAlpha(nearestDownscaleRows(stroke(2), W, H, DST_H))).toBe(0);

    // The box filter keeps every nib, monotonically in its width.
    expect(peakAlpha(boxDownscaleRgba(stroke(2), W, H, W, DST_H))).toBeGreaterThanOrEqual(34);
    expect(peakAlpha(boxDownscaleRgba(stroke(3), W, H, W, DST_H))).toBeGreaterThanOrEqual(51);
    expect(peakAlpha(boxDownscaleRgba(stroke(5), W, H, W, DST_H))).toBeGreaterThanOrEqual(68);
    // …and paper stays paper: nothing bleeds into a row the pen never touched.
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

    // "New session": fresh facade, fresh net — same persistent memo.
    const net2 = fakeNet({ bytes: vi.fn(async () => null) });
    const s2 = build({ net: net2, coverMemo: memo });
    await s2.thumbs.getThumbnail(noteSrc("n404"), "note");
    expect(net2.bytes).not.toHaveBeenCalled(); // no probe at all — the memo answered
  });

  it("a transport failure is session-only: a second instance probes again", async () => {
    const memo = fakeCoverMemo();
    const failing = fakeNet();
    (failing as { probe?: ThumbNet["probe"] }).probe = vi.fn(async () => null); // 5xx/offline, NOT 404
    const s1 = build({ net: failing, coverMemo: memo });
    await s1.thumbs.getThumbnail(noteSrc("nOff"), "note");
    expect(memo.persisted.has("nOff")).toBe(false); // never persisted
    expect(memo.session.has("nOff")).toBe(true); // suppressed this session

    const net2 = withProbe(fakeNet());
    const s2 = build({ net: net2, coverMemo: fakeCoverMemo() }); // fresh session state
    await s2.thumbs.getThumbnail(noteSrc("nOff"), "note");
    expect(net2.bytes).toHaveBeenCalled(); // probes again, server is back
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
  // The facade path now has the render path's structure: `[hot in-memory memo] →
  // sn-thumbs → produce`. These pin the read-through/write-through at the `memo`
  // choke point, the collision-safe key, fail-open, and the version token — all
  // with a fake in-memory store standing in for IndexedDB.

  it("write-through: a produced facade thumbnail is PUT to the store", async () => {
    const store = fakePersistentStore();
    const t = build({ persistent: store });
    const blob = await t.thumbs.getThumbnail(fileSrc("wt"), "spd");
    expect(store.put).toHaveBeenCalledTimes(1);
    const [key, stored] = store.put.mock.calls[0]!;
    expect(stored).toBe(blob); // the exact produced blob, written back
    // Namespaced + versioned + bucketed — the facade key shape.
    expect(key).toMatch(/^facade:v\d+:wt:light:b\d+$/);
  });

  it("read-through across a NEW SESSION: a fresh facade serves the persisted blob without producing", async () => {
    const store = fakePersistentStore();
    const s1 = build({ persistent: store });
    await s1.thumbs.getThumbnail(fileSrc("rt"), "spd");
    expect(store.map.size).toBe(1);

    // "New session": a fresh facade instance, fresh net/painter, SAME store.
    const s2 = build({ persistent: store });
    const blob = await s2.thumbs.getThumbnail(fileSrc("rt"), "spd");
    expect(await tagOf(blob)).toBe("image:light"); // the persisted tile, verbatim
    // produce never ran in the second session — no probe/fetch, no transcode.
    expect(s2.net.bytes).not.toHaveBeenCalled();
    expect(s2.painter.fromImageBytes).not.toHaveBeenCalled();
    expect(store.put).toHaveBeenCalledTimes(1); // s1 wrote; s2 was a pure read
  });

  it("key isolation: a facade key never equals a renderCache hash:thumb:theme id for the same hash/theme", async () => {
    const store = fakePersistentStore();
    const t = build({ persistent: store });
    // Drive the note-page RENDER path with the SAME page hash a renderCache thumb
    // would key on (the collision the discriminator must prevent in the one store).
    await t.thumbs.getThumbnail({ fileHash: null, noteId: "n1", page: page("collide") }, "note");
    const facadeKey = store.put.mock.calls.at(-1)![0] as string;
    const renderKey = cacheId({ hash: "collide", size: "thumb", theme: "light" });
    expect(facadeKey).not.toBe(renderKey);
    expect(facadeKey.startsWith("facade:")).toBe(true); // facade namespace
    expect(renderKey.startsWith("facade:")).toBe(false); // renderCache ids start with a hex hash
    // And it is not even a suffix/prefix of the render id — a robust separation.
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
    expect(await tagOf(blob)).toBe("image:light"); // produced despite the broken read
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
    expect(await tagOf(blob)).toBe("image:light"); // the write-through error is swallowed
  });

  it("version bump: an entry persisted under an OLD version token is not served under the new one", async () => {
    const store = fakePersistentStore();
    const s1 = build({ persistent: store });
    await s1.thumbs.getThumbnail(fileSrc("ver"), "spd");
    const currentKey = store.put.mock.calls[0]![0] as string; // facade:v{N}:ver:light:b{b}
    const persistedBlob = store.map.get(currentKey)!;

    // Re-file that blob under an OLDER version token and drop the current one —
    // a stale persisted entry from before a crop/encode change.
    const oldKey = currentKey.replace(/^facade:v\d+:/, "facade:v0:");
    store.map.clear();
    store.map.set(oldKey, persistedBlob);
    store.get.mockClear();
    store.put.mockClear();

    const s2 = build({ persistent: store });
    await s2.thumbs.getThumbnail(fileSrc("ver"), "spd");
    // The current-version key missed (only v0 exists) → produce RAN and the tile
    // was re-persisted under the CURRENT token.
    expect(s2.painter.fromImageBytes).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.put.mock.calls[0]![0]).toBe(currentKey);
  });

  it("glyphs are never persisted — they regenerate instantly and earn no byte of the shared budget", async () => {
    const store = fakePersistentStore();
    const t = build({ persistent: store });
    await t.thumbs.getThumbnail(fileSrc("g"), "doc"); // → glyph
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("a persisted .pdf tile is served WITHOUT the decoder — the wasm never loads twice", async () => {
    // §5 of the plan, as a test. The tiers are `[hot memo] → sn-thumbs →
    // produce`, and `produce` is the ONLY thing that reaches `renderPdfPage` —
    // so on the second visit to a folder of PDFs the 5.3 MB module is not
    // fetched at all. This is why the seam needs no gating and no idle delay.
    const store = fakePersistentStore();
    const s1 = build({ persistent: store });
    await s1.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    expect(s1.renderPdfPage).toHaveBeenCalledTimes(1);
    const [key] = store.put.mock.calls[0]!;
    expect(key).toMatch(/^facade:v\d+:pdfh:pdf:b\d+$/); // theme-free, namespaced

    // "New session": a fresh facade, the same store.
    const s2 = build({ persistent: store });
    const blob = await s2.thumbs.getThumbnail({ fileHash: "pdfh", fileId: "p1" }, "pdf");
    expect(await tagOf(blob)).toBe("note"); // the persisted tile, verbatim
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
