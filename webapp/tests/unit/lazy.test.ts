import { describe, it, expect, vi } from "vitest";
import { createLazyEngine, type ObserverLike, type LazyEngine } from "../../src/render/lazy";
import { ApiError, type ApiFailureSink } from "../../src/api/client";
import type { Api } from "../../src/api/types";
import type { NoteRenderer } from "../../src/render/types";
import type { RenderCache } from "../../src/cache/types";
import type { PageRef } from "../../src/core/types";

// The scheduler is exercised without any DOM: canvases are opaque identity
// objects, and the observer, blit, and placeholder are all injected. This lets us
// assert the load-bearing invariant — off-screen slots never reach the renderer —
// on plain Node.

const flush = () => new Promise((r) => setTimeout(r, 0));

function page(hash: string): PageRef {
  return { index: 0, hash, width: 1404, height: 1872, textHash: null };
}

/** A fake observer that records the engine's visibility handler so a test can
 * drive intersections manually. */
function fakeObserver() {
  let handler: ((target: Element, isIntersecting: boolean) => void) | null = null;
  const observed = new Set<Element>();
  const factory = (onVisibility: (target: Element, isIntersecting: boolean) => void): ObserverLike => {
    handler = onVisibility;
    return {
      observe: (t) => void observed.add(t),
      unobserve: (t) => void observed.delete(t),
      disconnect: () => observed.clear(),
    };
  };
  return {
    factory,
    observed,
    intersect: (target: Element, isIntersecting: boolean) => handler?.(target, isIntersecting),
  };
}

function stubs() {
  const getPageBytes = vi.fn(async () => new ArrayBuffer(8));
  const api = { listFolder: vi.fn(), getNoteMeta: vi.fn(), getPageBytes } as unknown as Api;
  const render = vi.fn(async () => ({ bitmap: { width: 240, height: 320, close() {} } as unknown as ImageBitmap, width: 240, height: 320 }));
  const renderer = { render } as unknown as NoteRenderer;
  const cache = {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => {}),
  } as unknown as RenderCache;
  return { api, renderer, cache, getPageBytes, render };
}

function build(observer = fakeObserver(), failures?: ApiFailureSink) {
  const s = stubs();
  const blit = vi.fn();
  const placeholder = vi.fn();
  const engine: LazyEngine = createLazyEngine({
    api: s.api,
    renderer: s.renderer,
    cache: s.cache,
    getTheme: () => "light",
    observerFactory: observer.factory,
    blit,
    placeholder,
    schedule: (fn) => fn(), // run placeholder+observe synchronously
    failures,
    debounceMs: 0,
  });
  return { engine, observer, blit, placeholder, ...s };
}

const canvas = () => ({}) as unknown as HTMLCanvasElement;

describe("lazy engine scheduler", () => {
  it("paints a slot only once it intersects, and never renders off-screen slots", async () => {
    const t = build();
    const onScreen = canvas();
    const offScreen = canvas();
    t.engine.add({ target: onScreen, noteId: "n1", page: page("h1"), size: "thumb" });
    t.engine.add({ target: offScreen, noteId: "n2", page: page("h2"), size: "thumb" });

    // Placeholders drawn for both; nothing rendered yet.
    expect(t.placeholder).toHaveBeenCalledTimes(2);
    expect(t.render).not.toHaveBeenCalled();

    // Only the first scrolls into view.
    t.observer.intersect(onScreen, true);
    await flush();

    expect(t.getPageBytes).toHaveBeenCalledTimes(1);
    expect(t.render).toHaveBeenCalledTimes(1);
    expect(t.blit).toHaveBeenCalledTimes(1);
    // The off-screen slot was never fetched or rendered.
    expect(t.render.mock.calls.every(([req]) => (req as { page: PageRef }).page.hash === "h1")).toBe(true);
  });

  it("does not re-render a slot that is already painted when it re-intersects", async () => {
    const t = build();
    const c = canvas();
    t.engine.add({ target: c, noteId: "n1", page: page("h1"), size: "thumb" });

    t.observer.intersect(c, true);
    await flush();
    expect(t.render).toHaveBeenCalledTimes(1);

    // Scroll out and back in: the cached paint stands, no second render.
    t.observer.intersect(c, false);
    t.observer.intersect(c, true);
    await flush();
    expect(t.render).toHaveBeenCalledTimes(1);
  });

  it("serves a cache hit without touching the api or renderer", async () => {
    const t = build();
    (t.cache.get as ReturnType<typeof vi.fn>).mockResolvedValue({ width: 240, height: 320, close() {} } as unknown as ImageBitmap);
    const c = canvas();
    t.engine.add({ target: c, noteId: "n1", page: page("h1"), size: "thumb" });

    t.observer.intersect(c, true);
    await flush();

    expect(t.getPageBytes).not.toHaveBeenCalled();
    expect(t.render).not.toHaveBeenCalled();
    expect(t.blit).toHaveBeenCalledTimes(1);
  });

  it("bumpTheme repaints only visible slots and drops the rest to placeholders", async () => {
    const t = build();
    const visible = canvas();
    const hidden = canvas();
    t.engine.add({ target: visible, noteId: "n1", page: page("h1"), size: "thumb" });
    t.engine.add({ target: hidden, noteId: "n2", page: page("h2"), size: "thumb" });

    t.observer.intersect(visible, true);
    t.observer.intersect(hidden, false);
    await flush();
    expect(t.render).toHaveBeenCalledTimes(1);
    t.placeholder.mockClear();

    t.engine.bumpTheme();
    await flush();

    // Visible slot re-rendered for the new theme; hidden slot only re-placeheld.
    expect(t.render).toHaveBeenCalledTimes(2);
    expect(t.render.mock.calls.at(-1)?.[0]).toMatchObject({ page: { hash: "h1" } });
    expect(t.placeholder).toHaveBeenCalledWith(hidden, expect.anything());
  });

  it("prefetch warms the cache off-canvas (on idle)", async () => {
    vi.useFakeTimers();
    try {
      const t = build();
      t.engine.prefetch("n1", page("h9"), "full");
      await vi.advanceTimersByTimeAsync(200); // idle fallback = setTimeout(180)
      expect(t.getPageBytes).toHaveBeenCalledTimes(1);
      expect(t.render).toHaveBeenCalledTimes(1);
      expect(t.blit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Regression: these failures used to hit a bare `catch {}`, so an expired cookie
// left a gallery of blank thumbnails and no route to login.
describe("lazy engine failure reporting", () => {
  function sink(): ApiFailureSink & { onSessionExpired: ReturnType<typeof vi.fn>; onStalePage: ReturnType<typeof vi.fn> } {
    return { onSessionExpired: vi.fn(), onStalePage: vi.fn() };
  }

  it("reports an UNAUTHORIZED page fetch to the sink instead of swallowing it", async () => {
    const s = sink();
    const t = build(fakeObserver(), s);
    (t.getPageBytes as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError("UNAUTHORIZED", "gone", 401));
    const c = canvas();
    t.engine.add({ target: c, noteId: "n1", page: page("h1"), size: "thumb" });

    t.observer.intersect(c, true);
    await flush();

    expect(s.onSessionExpired).toHaveBeenCalledTimes(1);
    expect(t.blit).not.toHaveBeenCalled(); // still non-fatal: placeholder stands
  });

  it("reports a STALE_PAGE with the note + page whose ?v= went stale", async () => {
    const s = sink();
    const t = build(fakeObserver(), s);
    (t.getPageBytes as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError("STALE_PAGE", "stale", 404));
    const c = canvas();
    t.engine.add({ target: c, noteId: "n7", page: page("h9"), size: "thumb" });

    t.observer.intersect(c, true);
    await flush();

    expect(s.onStalePage).toHaveBeenCalledWith("n7", expect.objectContaining({ hash: "h9" }));
    expect(s.onSessionExpired).not.toHaveBeenCalled();
  });

  it("keeps other failures non-fatal and silent", async () => {
    const s = sink();
    const t = build(fakeObserver(), s);
    (t.getPageBytes as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError("NETWORK", "offline", 0));
    const c = canvas();
    t.engine.add({ target: c, noteId: "n1", page: page("h1"), size: "thumb" });

    t.observer.intersect(c, true);
    await flush();

    expect(s.onSessionExpired).not.toHaveBeenCalled();
    expect(s.onStalePage).not.toHaveBeenCalled();
  });

  it("reports an expired session from a prefetch too", async () => {
    vi.useFakeTimers();
    try {
      const s = sink();
      const t = build(fakeObserver(), s);
      (t.getPageBytes as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError("UNAUTHORIZED", "gone", 401));
      t.engine.prefetch("n1", page("h9"), "full");
      await vi.advanceTimersByTimeAsync(200);
      expect(s.onSessionExpired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The facade + a CANVAS target (the recycle bin): the engine asks the facade
// WHAT image a slot shows (a WebP blob), decodes it and blits it, instead of
// inlining the note-page pipeline. This is the boundary: the engine keeps owning
// WHEN to paint. The gallery's <img> path (below) shares the facade but skips the
// decode/blit entirely.
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

    // Dispatch source carries the note id, page and the tile's own hash/type.
    expect(t.getThumbnail).toHaveBeenCalledTimes(1);
    const [source, fileType] = t.getThumbnail.mock.calls[0]!;
    expect(fileType).toBe("spd");
    expect(source).toMatchObject({ fileHash: "filehash", fileId: "n1", noteId: "n1", page: { hash: "ph" } });

    expect(t.decode).toHaveBeenCalledTimes(1);
    expect(t.blit).toHaveBeenCalledTimes(1);
    // The note-page pipeline was NOT used — this tile is not a note.
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
    // The engine owns a facade-decoded bitmap and frees it once drawImage copied it.
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

// The gallery's <img> path: the engine points an <img> at an object URL over the
// facade's WebP blob and lets the BROWSER own decode/eviction. No ImageBitmap is
// decoded or held, and the new lifetime concern — object-URL revocation, which
// replaces the old bitmap `.close()` — is asserted here: every mint is revoked, on
// replacement (a theme bump) and on teardown (reset/remove), never leaked. The DOM
// is faked: a `{ tagName: "IMG" }` routes to the <img> branch, and object-URL
// create/revoke are injected so a leak is a missed `revokeObjectUrl` call.
describe("lazy engine <img> gallery path", () => {
  /** A fake <img>: settable `src`/`alt`, and `tagName: "IMG"` so the engine's
   *  target-kind check routes it to the object-URL path with no real DOM. */
  const imgTarget = () => ({ tagName: "IMG", src: "", alt: "" }) as unknown as HTMLImageElement;

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
    // Accessibility: the tile is named, not left as an anonymous image.
    expect(img.alt).toBe("Meeting notes");
    // The browser owns decode: no ImageBitmap tier for a gallery tile.
    expect(t.decode).not.toHaveBeenCalled();
    expect(t.blit).not.toHaveBeenCalled();
    // Nothing revoked yet — the live URL is what the <img> is displaying.
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
    expect(t.revokeObjectUrl).toHaveBeenCalledWith("blob:mock/0"); // a's URL only
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

    // A fresh blob for the new theme, a fresh URL, and the old one revoked.
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
    await flush(); // paint is now awaiting the blob

    // A gallery repaint (folder change / live bump) tears the slot down first.
    t.engine.reset();
    resolveBlob(new Blob(["late"], { type: "image/webp" }));
    await flush();

    // The late blob is dropped: nothing is minted for a torn-down slot, so there
    // is no dangling object URL that reset never had a chance to revoke.
    expect(t.createObjectUrl).not.toHaveBeenCalled();
    expect(img.src).toBe("");
  });

  it("leaves an OFF-SCREEN tile's URL untouched on a theme bump — it re-lazies on next view", async () => {
    const t = buildImg();
    const img = imgTarget();
    t.engine.add({ target: img, noteId: "n1", page: page("h1"), size: "thumb", thumb: { fileType: "note", fileHash: "fh" } });
    t.observer.intersect(img, true);
    await flush();
    t.observer.intersect(img, false); // scrolled off-screen

    t.engine.bumpTheme();
    await flush();

    // Not repainted while off-screen: the old-theme image stays (nobody sees it),
    // no new URL is minted and the current one is NOT revoked (that would blank it
    // to a broken image). The correct theme paints — and revokes this URL — when
    // the tile is next scrolled in.
    expect(img.src).toBe("blob:mock/0");
    expect(t.createObjectUrl).toHaveBeenCalledTimes(1);
    expect(t.revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("paints a PAGELESS facade slot — the bin's .spd/.txt/image rows have no page ref", async () => {
    // A trashed `.spd`/`.txt`/image row registers with the facade but carries
    // no `page` (its strategy fetches by hash, never renders a page). The
    // engine must paint it from the facade blob all the same, and pass the
    // slot's `bin` flag through to the facade's source.
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
