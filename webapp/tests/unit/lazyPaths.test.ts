// The lazy engine canvas and <img> thumbnail paths.

import { describe, it, expect, vi } from "vitest";
import { createLazyEngine, type LazyEngine } from "../../src/render/lazy";
import { ApiError } from "../../src/api/client";
import type { PageRef } from "../../src/core/types";

// No DOM: canvases are identity objects; observer, blit and placeholder are injected.
import { flush, page, fakeObserver, stubs, canvas } from "./lazy.shared";

// The facade + a canvas target (the recycle bin): decode and blit the facade's blob.
describe("lazy engine thumbnail-facade path (canvas target)", () => {
  const fakeBitmap = () => ({ width: 240, height: 320, close: vi.fn() }) as unknown as ImageBitmap;

  function buildFacade() {
    const s = stubs();
    const blit = vi.fn();
    const placeholder = vi.fn();
    const bitmap = fakeBitmap();
    const decode = vi.fn(async () => bitmap);
    const getThumbnail = vi.fn(async () => new Blob(["x"], { type: "image/webp" }));
    const observer = fakeObserver();
    const engine: LazyEngine = createLazyEngine({
      api: s.api,
      renderer: s.renderer,
      cache: s.cache,
      getTheme: () => "light",
      getThumbnail,
      decode,
      observerFactory: observer.factory,
      blit,
      placeholder,
      schedule: (fn) => fn(),
      debounceMs: 0,
    });
    return { engine, observer, blit, decode, getThumbnail, bitmap, ...s };
  }

  it("asks the facade for the image, decodes it, and blits — never the note pipeline", async () => {
    const t = buildFacade();
    const c = canvas();
    t.engine.add({
      target: c,
      noteId: "n1",
      page: page("ph"),
      size: "thumb",
      thumb: { fileType: "spd", fileHash: "filehash" },
    });

    t.observer.intersect(c, true);
    await flush();

    expect(t.getThumbnail).toHaveBeenCalledTimes(1);
    const [source, fileType] = t.getThumbnail.mock.calls[0]!;
    expect(fileType).toBe("spd");
    expect(source).toMatchObject({ fileHash: "filehash", fileId: "n1", noteId: "n1", page: { hash: "ph" } });

    expect(t.decode).toHaveBeenCalledTimes(1);
    expect(t.blit).toHaveBeenCalledTimes(1);
    expect(t.getPageBytes).not.toHaveBeenCalled();
    expect(t.render).not.toHaveBeenCalled();
  });

  it("defaults a slot with no thumb hint to the note-page strategy", async () => {
    const t = buildFacade();
    const c = canvas();
    t.engine.add({ target: c, noteId: "n2", page: page("p2"), size: "thumb" });

    t.observer.intersect(c, true);
    await flush();

    expect(t.getThumbnail.mock.calls[0]![1]).toBe("note");
  });

  it("closes the transient decoded bitmap after blitting it", async () => {
    const t = buildFacade();
    const c = canvas();
    t.engine.add({ target: c, noteId: "n1", page: page("ph"), size: "thumb", thumb: { fileType: "txt", fileHash: "h" } });

    t.observer.intersect(c, true);
    await flush();

    expect(t.blit).toHaveBeenCalledTimes(1);
    expect((t.bitmap.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("routes a facade rejection to the failure sink, leaving the placeholder", async () => {
    const s = stubs();
    const blit = vi.fn();
    const failures = { onSessionExpired: vi.fn(), onStalePage: vi.fn() };
    const observer = fakeObserver();
    const getThumbnail = vi.fn().mockRejectedValue(new ApiError("UNAUTHORIZED", "gone", 401));
    const engine: LazyEngine = createLazyEngine({
      api: s.api,
      renderer: s.renderer,
      cache: s.cache,
      getTheme: () => "light",
      getThumbnail,
      decode: vi.fn(),
      observerFactory: observer.factory,
      blit,
      placeholder: vi.fn(),
      schedule: (fn) => fn(),
      failures,
      debounceMs: 0,
    });

    const c = canvas();
    engine.add({ target: c, noteId: "n1", page: page("ph"), size: "thumb", thumb: { fileType: "note", fileHash: "h" } });
    observer.intersect(c, true);
    await flush();

    expect(failures.onSessionExpired).toHaveBeenCalledTimes(1);
    expect(blit).not.toHaveBeenCalled();
  });
});

// The gallery's <img> path: object URLs over the facade's blob; every mint is revoked.
describe("lazy engine <img> gallery path", () => {
  /** A fake <img>; `tagName: "IMG"` routes the engine to the object-URL path. */
  const imgTarget = () => ({ tagName: "IMG", src: "", alt: "", toggleAttribute: vi.fn() }) as unknown as HTMLImageElement;

  function buildImg() {
    const s = stubs();
    const observer = fakeObserver();
    const blit = vi.fn();
    const decode = vi.fn();
    let mint = 0;
    const createObjectUrl = vi.fn((_blob: Blob) => `blob:mock/${mint++}`);
    const revokeObjectUrl = vi.fn();
    let produced = 0;
    const getThumbnail = vi.fn(async () => new Blob([`webp${produced++}`], { type: "image/webp" }));
    const engine: LazyEngine = createLazyEngine({
      api: s.api,
      renderer: s.renderer,
      cache: s.cache,
      getTheme: () => "light",
      getThumbnail,
      decode,
      blit,
      createObjectUrl,
      revokeObjectUrl,
      observerFactory: observer.factory,
      placeholder: vi.fn(),
      schedule: (fn) => fn(),
      debounceMs: 0,
    });
    return { engine, observer, blit, decode, getThumbnail, createObjectUrl, revokeObjectUrl, ...s };
  }

  it("paints an <img> from the facade blob via an object URL — never decodes or blits", async () => {
    const t = buildImg();
    const img = imgTarget();
    t.engine.add({
      target: img,
      noteId: "n1",
      page: page("h1"),
      size: "thumb",
      thumb: { fileType: "note", fileHash: "fh" },
      alt: "Meeting notes",
    });

    t.observer.intersect(img, true);
    await flush();

    expect(t.getThumbnail).toHaveBeenCalledTimes(1);
    expect(t.createObjectUrl).toHaveBeenCalledTimes(1);
    expect(img.src).toBe("blob:mock/0");
    expect(img.alt).toBe("Meeting notes");
    expect(t.decode).not.toHaveBeenCalled();
    expect(t.blit).not.toHaveBeenCalled();
    expect(t.revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("revokes the object URL on reset — no leak on teardown", async () => {
    const t = buildImg();
    const img = imgTarget();
    t.engine.add({ target: img, noteId: "n1", page: page("h1"), size: "thumb", thumb: { fileType: "note", fileHash: "fh" } });
    t.observer.intersect(img, true);
    await flush();
    expect(t.createObjectUrl).toHaveBeenCalledTimes(1);

    t.engine.reset();
    expect(t.revokeObjectUrl).toHaveBeenCalledWith("blob:mock/0");
  });

  it("revokes just the removed tile's URL on remove", async () => {
    const t = buildImg();
    const a = imgTarget();
    const b = imgTarget();
    t.engine.add({ target: a, noteId: "n1", page: page("h1"), size: "thumb", thumb: { fileType: "note", fileHash: "fa" } });
    t.engine.add({ target: b, noteId: "n2", page: page("h2"), size: "thumb", thumb: { fileType: "note", fileHash: "fb" } });
    t.observer.intersect(a, true);
    t.observer.intersect(b, true);
    await flush();

    t.engine.remove(a);
    expect(t.revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(t.revokeObjectUrl).toHaveBeenCalledWith("blob:mock/0");
  });

  it("revokes the old URL when a theme bump repaints a visible tile — no leak on replacement", async () => {
    const t = buildImg();
    const img = imgTarget();
    t.engine.add({ target: img, noteId: "n1", page: page("h1"), size: "thumb", thumb: { fileType: "note", fileHash: "fh" }, alt: "n" });
    t.observer.intersect(img, true);
    await flush();
    expect(img.src).toBe("blob:mock/0");

    t.engine.bumpTheme();
    await flush();

    expect(t.getThumbnail).toHaveBeenCalledTimes(2);
    expect(t.createObjectUrl).toHaveBeenCalledTimes(2);
    expect(img.src).toBe("blob:mock/1");
    expect(t.revokeObjectUrl).toHaveBeenCalledWith("blob:mock/0");
  });

  it("does not mint an object URL when reset lands mid-fetch — no leak on a repaint", async () => {
    const t = buildImg();
    const img = imgTarget();
    let resolveBlob!: (b: Blob) => void;
    (t.getThumbnail as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<Blob>((res) => (resolveBlob = res)),
    );
    t.engine.add({ target: img, noteId: "n1", page: page("h1"), size: "thumb", thumb: { fileType: "note", fileHash: "fh" } });
    t.observer.intersect(img, true);
    await flush();

    t.engine.reset();
    resolveBlob(new Blob(["late"], { type: "image/webp" }));
    await flush();

    // A late blob for a torn-down slot mints nothing, so no URL escapes revocation.
    expect(t.createObjectUrl).not.toHaveBeenCalled();
    expect(img.src).toBe("");
  });

  it("leaves an OFF-SCREEN tile's URL untouched on a theme bump — it re-lazies on next view", async () => {
    const t = buildImg();
    const img = imgTarget();
    t.engine.add({ target: img, noteId: "n1", page: page("h1"), size: "thumb", thumb: { fileType: "note", fileHash: "fh" } });
    t.observer.intersect(img, true);
    await flush();
    t.observer.intersect(img, false);

    t.engine.bumpTheme();
    await flush();

    // Off-screen: no repaint and no revoke (that would blank it) until scrolled in.
    expect(img.src).toBe("blob:mock/0");
    expect(t.createObjectUrl).toHaveBeenCalledTimes(1);
    expect(t.revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("paints a PAGELESS facade slot — the bin's .spd/.txt/image rows have no page ref", async () => {
    // A trashed `.spd`/`.txt`/image row has no `page`; the `bin` flag passes through.
    const t = buildImg();
    const img = imgTarget();
    t.engine.add({
      target: img,
      noteId: "t-spd",
      size: "thumb",
      thumb: { fileType: "spd", fileHash: "sh", bin: true },
      alt: "Kitchen sketch",
    });

    t.observer.intersect(img, true);
    await flush();

    expect(t.getThumbnail).toHaveBeenCalledTimes(1);
    const [source, fileType] = t.getThumbnail.mock.calls[0]!;
    expect(fileType).toBe("spd");
    expect(source).toMatchObject({ fileHash: "sh", fileId: "t-spd", bin: true });
    expect((source as { page?: unknown }).page).toBeUndefined();
    expect(img.src).toBe("blob:mock/0");
    expect(img.alt).toBe("Kitchen sketch");
  });
});
