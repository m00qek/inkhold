// PAGE 0 OF A PDF, AS A LIBRARY TILE — the `renderPdfPage` seam behind the
// thumbnail facade's `pdf-page` strategy.
//
// It is the PDF twin of the `renderNote` seam wired in `pages/library.ts`: the
// facade asks for a bitmap of page 0 at the tier target and encodes it to WebP;
// everything about MuPDF, workers and byte ranges stops here.
//
// WHY THIS IS A MODULE AND NOT A FUNCTION AT THE BOTTOM OF `thumbnails.ts`.
// The facade's orchestration is deliberately Node-testable with `net`, `painter`
// and the render seams faked — a unit test imports `createThumbnails` and never
// loads a canvas or a `fetch`. Importing `pdfClient` from there would drag the
// worker/wasm module graph into that import for the sake of one function. The
// seam implementations live at the bottom of `thumbnails.ts` because they are
// small; this one is not.
//
// THREE THINGS IT OWNS, AND ONLY THESE THREE:
//
//  1. STRICTLY ONE DOCUMENT AT A TIME. `PdfSession` is one worker holding one
//     open document, and its `BlockCache` (32 MB) belongs to that document — so
//     N tiles in flight would be N documents' blocks resident, and their range
//     fetches would interleave. The queue below serialises open → size → render
//     → CLOSE, and the close is what bounds peak memory to one document.
//  2. A WARM SESSION, RELEASED WHEN IDLE. Compiling MuPDF is ~5.3 MB of wasm;
//     paying that per tile would be far worse than the render it wraps, so the
//     session survives between jobs. But a warm second wasm instance is exactly
//     what §2's option B was rejected for, and a library tile is produced ONCE
//     PER DOCUMENT EVER (a persistent `sn-thumbs` hit returns the stored WebP
//     before `produce` runs, so this seam is not called at all on a revisit) —
//     a worker kept alive for a path that will never be entered again is pure
//     cost. So the session is torn down once the queue has been drained for
//     {@link IDLE_RELEASE_MS}.
//  3. THE TIER TARGET. Page 0 is rendered at the same density-bucketed width
//     every other thumbnail producer uses (`thumbTargetWidth`), so the tile is
//     crisp at the caller's DPR and never larger than it can be shown.
//
// The costs are NOT this module's to avoid: the ~1.5 MB head+tail window every
// document open pays (`BlockCache.prime`) is a one-time toll per document per
// device, and §7's revised order says to measure it before optimising it.

import { ASPECT_CAP } from "../ui/tileAspect";
import { rawFileUrl } from "../core/fileKind";
import { thumbTargetWidth } from "./types";
import { supportsWasmExceptions } from "./pdfDecode";
import { createPdfSession, type PdfSession } from "./pdfClient";
import type { Hash, Id } from "../core/types";
import type { PdfPageThumb } from "./thumbnails";

/**
 * The byte length handed to `PdfSession.open`.
 *
 * A gallery listing entry carries NO size: `NoteSummary` has none, and only
 * `NoteMeta` does — a per-file round trip a tile has no business making. The
 * hint's only job is to choose the RANGE-SERVED path over the whole-file one
 * (`pdfWorker.open` reads `size > 0` as "this can be streamed"); the real length
 * is settled a moment later by the first response's `content-range`, because
 * `BlockCache.request` deliberately never clamps its range to the length it
 * currently believes. That is not an accident to lean on — it is the documented
 * fix for a 76 MB document opened with a stale 400 KB size, which used to store
 * a short block and send MuPDF into repair. So one byte is enough to say
 * "range-serve this", and nothing downstream ever reads this number again.
 */
const SIZE_UNKNOWN = 1;

/**
 * How long a drained tile session stays warm before its worker is destroyed.
 *
 * Long enough to cover a whole folder: the lazy engine reveals tiles in bursts
 * as the IntersectionObserver fires, with a 150 ms settle and a scroll's worth
 * of gap between them, and recompiling 5.3 MB of MuPDF inside one of those gaps
 * would dwarf the render. Short enough that browsing away from a folder of PDFs
 * does not leave a second wasm instance resident for the session.
 *
 * It is also the RECOVERY for a worker that died (an engine OOM on a very large
 * page): a dead `PdfSession` rejects every later request, and nothing here
 * inspects the failure to tell that apart from an ordinary corrupt PDF — but a
 * dead session drains the queue immediately, so the release fires and the next
 * tile gets a fresh worker. Meanwhile every failed tile is a glyph, which is the
 * facade's floor and not a broken state.
 */
export const IDLE_RELEASE_MS = 15_000;

/** The browser seams, injectable so the queue is testable without a worker —
 *  the same shape `pages/pdfViewer.ts` takes (`PdfSeam`). */
export interface PdfThumbSeam {
  /** A fresh decoder session. One worker, one document at a time. */
  createSession(): PdfSession;
  /** False → no session is ever created and every tile falls to its glyph. */
  supported(): boolean;
}

export function defaultPdfThumbSeam(): PdfThumbSeam {
  return { createSession: createPdfSession, supported: supportsWasmExceptions };
}

/** The seam the facade injects as `ThumbnailsDeps.renderPdfPage`. */
export type RenderPdfPage = (
  fileId: Id,
  hash: Hash,
  opts?: { bin?: boolean },
) => Promise<PdfPageThumb>;

export interface PdfThumbsOptions {
  /** Override the idle release window. `0` releases the moment the queue
   *  drains — what a unit test wants, so no timer outlives the test. */
  idleMs?: number;
  /** The tier target width in PHYSICAL px. Defaults to the live density
   *  bucket's, read per render call exactly as every other producer reads it. */
  targetWidth?: () => number;
}

/** A handle over the seam, so a caller that owns the app's lifetime can drop the
 *  worker on teardown rather than waiting out the idle window. */
export interface PdfThumbs {
  renderPdfPage: RenderPdfPage;
  /** Tear the session down now (app teardown). Safe to call at any time. */
  destroy(): void;
}

/**
 * The scale that puts page 0 at the tier target.
 *
 * WIDTH-LED, because a masonry tile is width-constrained: one column wide,
 * height from its aspect. But the HEIGHT is capped at {@link ASPECT_CAP} times
 * that width, because the layout letterboxes anything taller than 2.5:1 — so a
 * receipt-shaped page would otherwise rasterise thousands of rows nothing can
 * show. PURE, so the arithmetic is unit-testable without a decoder.
 *
 * Returns 0 for a page with no measurable box, which the caller treats as
 * "this page cannot be drawn" rather than rendering at a nonsense scale.
 */
export function tileScale(pageW: number, pageH: number, targetW: number): number {
  if (!(pageW > 0) || !(pageH > 0) || !(targetW > 0)) return 0;
  const scale = Math.min(targetW / pageW, (targetW * ASPECT_CAP) / pageH);
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}

export function createPdfThumbs(
  seam: PdfThumbSeam = defaultPdfThumbSeam(),
  opts: PdfThumbsOptions = {},
): PdfThumbs {
  const idleMs = opts.idleMs ?? IDLE_RELEASE_MS;
  const targetWidth = opts.targetWidth ?? (() => thumbTargetWidth());

  let session: PdfSession | null = null;
  /**
   * The serial chain. Every job is appended to it, so exactly one document is
   * ever open — see the header. It is kept NON-REJECTING (`.catch`) because a
   * chain that rejects poisons every job appended after it: one corrupt PDF
   * would take the whole folder's tiles down with it.
   */
  let chain: Promise<unknown> = Promise.resolve();
  /**
   * Jobs appended to the chain and not yet finished — the queue is DRAINED at
   * 0, which is the only moment the session is worth releasing. Decremented
   * inside the job (before the release is scheduled) rather than by the awaiting
   * caller: a caller's `finally` runs a microtask LATER, so the last job would
   * always see its own count and never schedule anything.
   */
  let queued = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelRelease(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function release(): void {
    cancelRelease();
    const s = session;
    session = null;
    s?.destroy();
  }

  function scheduleRelease(): void {
    if (queued > 0) return; // more tiles behind this one; stay warm
    cancelRelease();
    if (idleMs <= 0) {
      release();
      return;
    }
    idleTimer = setTimeout(release, idleMs);
    // Node's timer would otherwise hold a test process open past the assertion;
    // the browser's is a plain number and has no `unref`.
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  async function job(url: string): Promise<PdfPageThumb> {
    cancelRelease();
    let s: PdfSession | null = null;
    try {
      s = session ??= seam.createSession();
      const { pageCount } = await s.open(url, SIZE_UNKNOWN);
      if (pageCount <= 0) throw new Error("this PDF has no pages");
      const size = await s.pageSize(0);
      const scale = tileScale(size.width, size.height, targetWidth());
      if (scale === 0) throw new Error("page 0 has no measurable box");
      const frame = await s.render(0, scale);
      // The page's OWN box, not the raster's: it is the cropped, rotated one
      // (`fz_bound_page` — a `/Rotate 90` page reports its visual, swapped
      // dimensions), which is what the masonry memo wants as the tile's aspect.
      return { bitmap: frame.bitmap, pageW: size.width, pageH: size.height };
    } finally {
      // CLOSE BETWEEN FILES, on every path. This is what keeps peak memory at
      // one document's blocks rather than the folder's — the whole reason the
      // queue is serial. The worker (and its compiled module) stays warm.
      if (s) await s.close().catch(() => {});
      queued--;
      scheduleRelease();
    }
  }

  const renderPdfPage: RenderPdfPage = async (fileId, hash, o = {}) => {
    // No session, no worker, no 5.3 MB module on a browser that cannot run it —
    // the facade turns this rejection into the glyph, which is the honest floor.
    if (!seam.supported()) throw new Error("this browser cannot run the PDF decoder");
    const url = rawFileUrl(fileId, hash, { bin: o.bin });
    if (!url) throw new Error("this file has no readable address");
    queued++;
    const run = chain.then(() => job(url));
    // The chain waits on the SETTLED job (so the next open never overlaps this
    // close) but never inherits its rejection: one corrupt PDF must not take the
    // rest of the folder's tiles down with it.
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  return { renderPdfPage, destroy: release };
}
