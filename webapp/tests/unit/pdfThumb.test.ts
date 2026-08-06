import { describe, it, expect, vi } from "vitest";
import { createPdfThumbs, tileScale, type PdfThumbSeam } from "../../src/render/pdfThumb";
import { ASPECT_CAP } from "../../src/ui/tileAspect";
import type { PdfSession } from "../../src/render/pdfClient";

// The `renderPdfPage` seam's ORCHESTRATION — the serial queue, the close, the
// session lifetime, the tier scale — with the decoder faked, so it runs on plain
// Node with no worker and no wasm. The decoder itself is proved by
// `pdfDecode.test.ts` against the real module; what is proved here is that this
// module drives it one document at a time and always lets go.

/** A stand-in for the transferred `ImageBitmap`, with a spy on the close. */
function fakeBitmap(w: number, h: number): ImageBitmap & { closed: boolean } {
  const bmp = { width: w, height: h, closed: false, close(): void { bmp.closed = true; } };
  return bmp as unknown as ImageBitmap & { closed: boolean };
}

interface FakeSession {
  session: PdfSession;
  /** Every call this session saw, in order — the record the serial claim reads. */
  log: string[];
  bitmaps: Array<ImageBitmap & { closed: boolean }>;
}

function fakeSession(
  over: {
    pageW?: number;
    pageH?: number;
    pageCount?: number;
    failOn?: "open" | "pageSize" | "render";
  } = {},
): FakeSession {
  const log: string[] = [];
  const bitmaps: Array<ImageBitmap & { closed: boolean }> = [];
  /** Whether a document is open RIGHT NOW — the invariant the queue must keep. */
  let open = false;
  const session: PdfSession = {
    async open(url, size) {
      // The serial claim, enforced from inside: a second open while one document
      // is still open is exactly the overlap the queue exists to prevent, and a
      // real session would answer it by dropping the first document silently.
      if (open) throw new Error("OVERLAP: a second document was opened before the first closed");
      log.push(`open ${url} size=${size}`);
      if (over.failOn === "open") throw new Error("cannot open");
      open = true;
      return { pageCount: over.pageCount ?? 3, mode: "stream" };
    },
    async pageSize(page) {
      log.push(`pageSize ${page}`);
      if (over.failOn === "pageSize") throw new Error("no page box");
      return { width: over.pageW ?? 400, height: over.pageH ?? 600 };
    },
    async render(page, scale) {
      log.push(`render ${page} @${scale.toFixed(4)}`);
      if (over.failOn === "render") throw new Error("render failed");
      const w = Math.round((over.pageW ?? 400) * scale);
      const h = Math.round((over.pageH ?? 600) * scale);
      const bitmap = fakeBitmap(w, h);
      bitmaps.push(bitmap);
      return { bitmap, width: w, height: h };
    },
    async exportPage() {
      throw new Error("not used by a thumbnail");
    },
    async stats() {
      return { mode: null, cache: null };
    },
    async close() {
      log.push("close");
      open = false;
    },
    destroy() {
      log.push("destroy");
      open = false;
    },
  };
  return { session, log, bitmaps };
}

/** A seam over ONE fake session, plus the count of sessions it was asked for. */
function seamOver(fakes: FakeSession[]): PdfThumbSeam & { created: () => number } {
  let created = 0;
  return {
    createSession: () => fakes[created++]!.session,
    supported: () => true,
    created: () => created,
  };
}

/** Deterministic tier target, so the scale assertions state a number. */
const TARGET = 230;
const target = () => TARGET;

describe("tileScale — the tier target, width-led with the layout's cap", () => {
  it("a portrait page is sized by its WIDTH: the tile is one column wide", () => {
    // A4-ish: 400x600 into a 230px column → 0.575, and the height follows.
    expect(tileScale(400, 600, 230)).toBeCloseTo(230 / 400, 6);
  });

  it("a landscape page is sized by its width too — orientation needs no branch", () => {
    expect(tileScale(600, 400, 230)).toBeCloseTo(230 / 600, 6);
  });

  it("an extreme scroll is capped by the layout's own 2.5x letterbox", () => {
    // 100x2000 would rasterise 230 x 4600 = a million rows nothing can show; the
    // masonry clamps the free axis at ASPECT_CAP, so the raster does too.
    const scale = tileScale(100, 2000, 230);
    expect(scale).toBeCloseTo((230 * ASPECT_CAP) / 2000, 6);
    expect(2000 * scale).toBeCloseTo(230 * ASPECT_CAP, 3);
  });

  it("an unmeasurable page is 0 — a signal, not a nonsense scale", () => {
    expect(tileScale(0, 600, 230)).toBe(0);
    expect(tileScale(400, 0, 230)).toBe(0);
    expect(tileScale(Number.NaN, 600, 230)).toBe(0);
    expect(tileScale(400, 600, 0)).toBe(0);
  });
});

describe("renderPdfPage — one document at a time", () => {
  it("opens page 0 at the tier width and reports the PAGE's own box", async () => {
    const fake = fakeSession({ pageW: 400, pageH: 600 });
    const thumbs = createPdfThumbs(seamOver([fake]), { idleMs: 10_000, targetWidth: target });
    const out = await thumbs.renderPdfPage("f1", "abc");

    expect(fake.log).toEqual([
      "open /file/f1?v=abc size=1",
      "pageSize 0",
      `render 0 @${(TARGET / 400).toFixed(4)}`,
      "close",
    ]);
    // The PAGE's points, not the raster's pixels — this is the masonry aspect.
    expect(out.pageW).toBe(400);
    expect(out.pageH).toBe(600);
    expect(out.bitmap.width).toBe(TARGET);
    thumbs.destroy();
  });

  it("a TRASHED file is opened off the bin-scoped route, not the live one", async () => {
    const fake = fakeSession();
    const thumbs = createPdfThumbs(seamOver([fake]), { idleMs: 0, targetWidth: target });
    await thumbs.renderPdfPage("f1", "abc", { bin: true });
    expect(fake.log[0]).toBe("open /api/controlplane/bin/file/f1?v=abc size=1");
  });

  it("SERIALISES: concurrent tiles never overlap, and each closes before the next opens", async () => {
    const fake = fakeSession();
    const thumbs = createPdfThumbs(seamOver([fake]), { idleMs: 100, targetWidth: target });
    // Three tiles revealed at once, the way an IntersectionObserver reveals them.
    await Promise.all([
      thumbs.renderPdfPage("a", "h1"),
      thumbs.renderPdfPage("b", "h2"),
      thumbs.renderPdfPage("c", "h3"),
    ]);
    // The fake THROWS on an overlapping open, so reaching here is already the
    // claim; the log states it positively, and in arrival order.
    expect(fake.log).toEqual([
      "open /file/a?v=h1 size=1",
      "pageSize 0",
      `render 0 @${(TARGET / 400).toFixed(4)}`,
      "close",
      "open /file/b?v=h2 size=1",
      "pageSize 0",
      `render 0 @${(TARGET / 400).toFixed(4)}`,
      "close",
      "open /file/c?v=h3 size=1",
      "pageSize 0",
      `render 0 @${(TARGET / 400).toFixed(4)}`,
      "close",
    ]);
    thumbs.destroy();
  });

  it("a document that will not open still CLOSES, and does not poison the queue", async () => {
    // One corrupt PDF in a folder must cost exactly one glyph, not the folder:
    // a chain that inherited the rejection would fail every tile queued behind
    // it. The bad document is opened FIRST, on the same warm session.
    const fake = fakeSession();
    let corrupt = true;
    const openOk = fake.session.open.bind(fake.session);
    fake.session.open = async (url, size) => {
      if (corrupt) {
        corrupt = false;
        fake.log.push(`open ${url} size=${size}`);
        throw new Error("cannot open");
      }
      return openOk(url, size);
    };
    const thumbs = createPdfThumbs(seamOver([fake]), { idleMs: 10_000, targetWidth: target });
    await expect(thumbs.renderPdfPage("bad", "h")).rejects.toThrow(/cannot open/);
    const ok = await thumbs.renderPdfPage("good", "h2");
    expect(ok.bitmap.width).toBe(TARGET);
    // Closed after BOTH, the failed one included.
    expect(fake.log.filter((l) => l === "close")).toHaveLength(2);
    thumbs.destroy();
  });

  it("a failed RENDER closes too — the document never leaks past its job", async () => {
    const fake = fakeSession({ failOn: "render" });
    const thumbs = createPdfThumbs(seamOver([fake]), { idleMs: 10_000, targetWidth: target });
    await expect(thumbs.renderPdfPage("f", "h")).rejects.toThrow(/render failed/);
    expect(fake.log.at(-1)).toBe("close");
    thumbs.destroy();
  });

  it("a pageless document is refused rather than rendered at index 0", async () => {
    const fake = fakeSession({ pageCount: 0 });
    const thumbs = createPdfThumbs(seamOver([fake]), { idleMs: 0, targetWidth: target });
    await expect(thumbs.renderPdfPage("f", "h")).rejects.toThrow(/no pages/);
    expect(fake.log).not.toContain("render 0 @0.5750");
  });

  it("a hashless file has no address, so nothing is ever opened", async () => {
    const fake = fakeSession();
    const seam = seamOver([fake]);
    const thumbs = createPdfThumbs(seam, { idleMs: 0, targetWidth: target });
    await expect(thumbs.renderPdfPage("f", null as unknown as string)).rejects.toThrow(/address/);
    expect(seam.created()).toBe(0);
  });

  it("a browser that cannot run the decoder creates NO worker at all", async () => {
    const create = vi.fn();
    const thumbs = createPdfThumbs(
      { createSession: create as unknown as () => PdfSession, supported: () => false },
      { idleMs: 0, targetWidth: target },
    );
    await expect(thumbs.renderPdfPage("f", "h")).rejects.toThrow(/cannot run the PDF decoder/);
    // No worker, and therefore no 5.3 MB module fetch, on a browser that would
    // only fail later. The facade turns this into the glyph.
    expect(create).not.toHaveBeenCalled();
  });
});

describe("the session's lifetime", () => {
  it("stays WARM across tiles: one worker for a whole folder", async () => {
    const first = fakeSession();
    const second = fakeSession();
    const seam = seamOver([first, second]);
    const thumbs = createPdfThumbs(seam, { idleMs: 10_000, targetWidth: target });
    await thumbs.renderPdfPage("a", "h1");
    await thumbs.renderPdfPage("b", "h2");
    // Compiling MuPDF is ~5.3 MB of wasm; two tiles must not pay for it twice.
    expect(seam.created()).toBe(1);
    expect(first.log).not.toContain("destroy");
    thumbs.destroy();
  });

  it("is RELEASED once the queue drains — no idle wasm instance behind a cached folder", async () => {
    const first = fakeSession();
    const second = fakeSession();
    const seam = seamOver([first, second]);
    // `idleMs: 0` is the release-on-drain end of the same policy.
    const thumbs = createPdfThumbs(seam, { idleMs: 0, targetWidth: target });
    await thumbs.renderPdfPage("a", "h1");
    expect(first.log.at(-1)).toBe("destroy");
    // …and the next tile gets a fresh one rather than a dead handle.
    await thumbs.renderPdfPage("b", "h2");
    expect(seam.created()).toBe(2);
    expect(second.log[0]).toBe("open /file/b?v=h2 size=1");
  });

  it("does not release MID-BATCH: the drain is what schedules it, not each job", async () => {
    const fake = fakeSession();
    const seam = seamOver([fake, fakeSession()]);
    const thumbs = createPdfThumbs(seam, { idleMs: 0, targetWidth: target });
    await Promise.all([thumbs.renderPdfPage("a", "h1"), thumbs.renderPdfPage("b", "h2")]);
    // Two documents, ONE session, destroyed exactly once — at the end.
    expect(seam.created()).toBe(1);
    expect(fake.log.filter((l) => l === "destroy")).toHaveLength(1);
    expect(fake.log.at(-1)).toBe("destroy");
  });

  it("destroy() drops the worker immediately, without waiting out the window", async () => {
    const fake = fakeSession();
    const thumbs = createPdfThumbs(seamOver([fake]), { idleMs: 10_000, targetWidth: target });
    await thumbs.renderPdfPage("a", "h1");
    expect(fake.log).not.toContain("destroy");
    thumbs.destroy();
    expect(fake.log.at(-1)).toBe("destroy");
    thumbs.destroy(); // idempotent — a second teardown must not throw
  });
});
