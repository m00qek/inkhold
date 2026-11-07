import { describe, it, expect, vi } from "vitest";
import { createLazyEngine, PLACEHOLDER_AFTER_MS, type LazyEngine } from "../../src/render/lazy";
import { ApiError, type ApiFailureSink } from "../../src/api/client";
import type { PageRef } from "../../src/core/types";

// No DOM: canvases are identity objects; observer, blit and placeholder are injected.
import { flush, page, fakeObserver, stubs, canvas } from "./lazy.shared";

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
    schedule: (fn) => fn(),
    failures,
    debounceMs: 0,
  });
  return { engine, observer, blit, placeholder, ...s };
}

/** A fake `<img>` target: the engine only checks `tagName`. */
const imgEl = () => ({ tagName: "IMG", src: "", alt: "", toggleAttribute: vi.fn() }) as unknown as HTMLImageElement;

describe("a tile whose produce is slow shows the glyph meanwhile", () => {
  function imgBuild(getThumbnail: () => Promise<Blob>, getGlyph: () => Promise<Blob>) {
    const s = stubs();
    const observer = fakeObserver();
    const engine = createLazyEngine({
      api: s.api,
      renderer: s.renderer,
      cache: s.cache,
      getTheme: () => "light",
      observerFactory: observer.factory,
      blit: vi.fn(),
      placeholder: vi.fn(),
      schedule: (fn) => fn(),
      debounceMs: 0,
      getThumbnail,
      getGlyph,
      createObjectUrl: (b) => `url:${String(b)}`,
      revokeObjectUrl: () => {},
    });
    return { engine, observer };
  }

  const slot = (target: HTMLImageElement) => ({
    target,
    noteId: "n1" as const,
    page: page("h1"),
    size: "thumb" as const,
    thumb: { fileType: "pdf", fileHash: "abc" as never },
  });

  it("paints the glyph while the render is outstanding, then upgrades in place", async () => {
    // A `.pdf` tile takes seconds (MuPDF fetch + render), so it gets a placeholder.
    let land: (b: Blob) => void = () => {};
    const real = new Promise<Blob>((r) => (land = r));
    const getGlyph = vi.fn(async () => "GLYPH" as unknown as Blob);
    const { engine, observer } = imgBuild(() => real, getGlyph);

    const el = imgEl();
    engine.add(slot(el));
    observer.intersect(el, true);

    await flush();
    expect(el.src).toBe("");
    expect(getGlyph).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, PLACEHOLDER_AFTER_MS + 80));
    expect(getGlyph).toHaveBeenCalledWith("pdf");
    expect(el.src).toBe("url:GLYPH");
    // The stand-in says so, for whoever must tell it from the real picture.
    expect(el.toggleAttribute).toHaveBeenLastCalledWith("data-interim", true);

    land("REAL" as unknown as Blob);
    await flush();
    expect(el.src).toBe("url:REAL");
    expect(el.toggleAttribute).toHaveBeenLastCalledWith("data-interim", false);
  });

  it("never draws the glyph when the produce beats the window", async () => {
    const getGlyph = vi.fn(async () => "GLYPH" as unknown as Blob);
    const { engine, observer } = imgBuild(async () => "REAL" as unknown as Blob, getGlyph);
    const el = imgEl();
    engine.add(slot(el));
    observer.intersect(el, true);
    await flush();

    expect(el.src).toBe("url:REAL");
    await new Promise((r) => setTimeout(r, PLACEHOLDER_AFTER_MS + 80));
    expect(getGlyph).not.toHaveBeenCalled();
    expect(el.src).toBe("url:REAL");
  });
});

describe("lazy engine scheduler", () => {
  it("paints a slot only once it intersects, and never renders off-screen slots", async () => {
    const t = build();
    const onScreen = canvas();
    const offScreen = canvas();
    t.engine.add({ target: onScreen, noteId: "n1", page: page("h1"), size: "thumb" });
    t.engine.add({ target: offScreen, noteId: "n2", page: page("h2"), size: "thumb" });

    expect(t.placeholder).toHaveBeenCalledTimes(2);
    expect(t.render).not.toHaveBeenCalled();

    t.observer.intersect(onScreen, true);
    await flush();

    expect(t.getPageBytes).toHaveBeenCalledTimes(1);
    expect(t.render).toHaveBeenCalledTimes(1);
    expect(t.blit).toHaveBeenCalledTimes(1);
    expect(t.render.mock.calls.every(([req]) => (req as { page: PageRef }).page.hash === "h1")).toBe(true);
  });

  it("does not re-render a slot that is already painted when it re-intersects", async () => {
    const t = build();
    const c = canvas();
    t.engine.add({ target: c, noteId: "n1", page: page("h1"), size: "thumb" });

    t.observer.intersect(c, true);
    await flush();
    expect(t.render).toHaveBeenCalledTimes(1);

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

    expect(t.render).toHaveBeenCalledTimes(2);
    expect(t.render.mock.calls.at(-1)?.[0]).toMatchObject({ page: { hash: "h1" } });
    expect(t.placeholder).toHaveBeenCalledWith(hidden, expect.anything());
  });

  it("prefetch warms the cache off-canvas (on idle)", async () => {
    vi.useFakeTimers();
    try {
      const t = build();
      t.engine.prefetch("n1", page("h9"), "full");
      await vi.advanceTimersByTimeAsync(200);
      expect(t.getPageBytes).toHaveBeenCalledTimes(1);
      expect(t.render).toHaveBeenCalledTimes(1);
      expect(t.blit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Regression: these failures hit a bare `catch {}`, so an expired cookie never reached login.
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
    expect(t.blit).not.toHaveBeenCalled();
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
