import { describe, it, expect, vi } from "vitest";
import { createThumbnails, strategyFor, TEXT_THUMB_BYTES } from "../../src/render/thumbnails";
import { FACADE_THUMB_TYPES } from "../../src/pages/galleryCards";
import { fileKind, PREVIEWABLE_IMAGE_TYPES, UPLOAD_ACCEPT } from "../../src/core/fileKind";
import type { Id, PageRef, Theme } from "../../src/core/types";

// The facade's orchestration with every pixel/network seam faked; the real seams are e2e's.
import { tagOf, page, fakePainter, fakeNet, build, noteSrc, fileSrc } from "./thumbnails.shared";

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

describe("the two dispatch points agree (docs/content/contributor/file-type.md, rows 4 and 5)", () => {
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
    // Only the head: a 2 MB book is a few KB, not the whole file.
    expect(t.net.text.mock.calls[0]![1]).toBe(TEXT_THUMB_BYTES);
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
