// @vitest-environment happy-dom
// A digest's handwritten note: none without one, a failed fetch asked again,
// and the holders a repaint replaced let go before they ever came into view.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createDigestInk } from "../../src/pages/digest/digestInk";
import type { Digest } from "../../src/api/digestTypes";

const digest = (note: string | null): Digest => ({
  id: "1", text: "x", comment: null, categoryUid: "", author: null, createdAt: 1, modifiedAt: 1, note, waiting: false,
  source: { kind: "manual", path: null, fileId: null, page: null, changed: false },
});

/** An IntersectionObserver that never sees anything, and says what it watches. */
function watching() {
  const watched = new Set<Element>();
  class Never {
    observe(e: Element) { watched.add(e); }
    unobserve(e: Element) { watched.delete(e); }
    disconnect() { watched.clear(); }
  }
  vi.stubGlobal("IntersectionObserver", Never);
  return watched;
}

afterEach(() => vi.unstubAllGlobals());

describe("a digest's handwritten note", () => {
  it("none without one", async () => {
    const ink = createDigestInk({ api: { digestNoteBytes: vi.fn() }, renderer: {} as never, store: null });
    expect(ink.holder(digest(null), "n")).toBeNull();
    await expect(ink.picture(digest(null))).resolves.toBeNull();
  });

  it("a fetch that failed is asked again next time", async () => {
    const digestNoteBytes = vi.fn(async () => {
      throw new Error("offline");
    });
    const ink = createDigestInk({ api: { digestNoteBytes }, renderer: {} as never, store: null });
    await expect(ink.picture(digest("m"))).resolves.toBeNull();
    await expect(ink.picture(digest("m"))).resolves.toBeNull();
    expect(digestNoteBytes).toHaveBeenCalledTimes(2);
  });

  it("holders a repaint replaced are no longer watched; those on the page still are", async () => {
    vi.useFakeTimers();
    try {
      const watched = watching();
      const ink = createDigestInk({ api: { digestNoteBytes: vi.fn() }, renderer: {} as never, store: null });
      const gone = ink.holder(digest("m"), "n")!;
      const kept = ink.holder(digest("m"), "n")!;
      document.body.append(kept);
      expect(watched).toEqual(new Set([gone, kept]));
      await vi.advanceTimersByTimeAsync(1);
      expect(watched).toEqual(new Set([kept]));
    } finally {
      vi.useRealTimers();
    }
  });
});
