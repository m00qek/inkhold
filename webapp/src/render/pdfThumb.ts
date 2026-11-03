// Page 0 of a PDF as a library tile: the `renderPdfPage` seam behind the
// thumbnail facade's `pdf-page` strategy, its own module so `thumbnails.ts`
// stays Node-testable without the worker/wasm graph. One document at a time
// (each session's 32 MB block cache belongs to one document); a warm session
// released after an idle window, since each document's tile is produced once
// ever and then served from `sn-thumbs`.

import { ASPECT_CAP } from "../ui/tileAspect";
import { rawFileUrl } from "../core/fileKind";
import { thumbTargetWidth } from "./types";
import { supportsWasmExceptions } from "./pdfLoader";
import { createPdfSession, type PdfSession } from "./pdfClient";
import type { Hash, Id } from "../core/types";
import type { PdfPageThumb } from "./thumbnails";

/**
 * The size hint for `PdfSession.open`. Listings carry no size; any `size > 0`
 * selects the range-served path, and the real length comes from the first
 * `content-range`.
 */
const SIZE_UNKNOWN = 1;

/**
 * How long a drained session stays warm: long enough to bridge the lazy
 * engine's bursts (recompiling 5.3 MB of MuPDF would dwarf a render), short
 * enough not to keep a second wasm instance around. Also recovers from a dead
 * worker, since a dead session drains the queue at once.
 */
export const IDLE_RELEASE_MS = 15_000;

/** The browser seams, injectable so the queue is testable without a worker. */
export interface PdfThumbSeam {
  createSession(): PdfSession;
  /** False: no session is created and every tile falls back to its glyph. */
  supported(): boolean;
}

export function defaultPdfThumbSeam(): PdfThumbSeam {
  return { createSession: createPdfSession, supported: supportsWasmExceptions };
}

export type RenderPdfPage = (
  fileId: Id,
  hash: Hash,
  opts?: { bin?: boolean },
) => Promise<PdfPageThumb>;

export interface PdfThumbsOptions {
  /** Override the idle window; `0` releases on drain (tests). */
  idleMs?: number;
  /** Tier target width in physical px; defaults to the live density bucket's. */
  targetWidth?: () => number;
}

export interface PdfThumbs {
  renderPdfPage: RenderPdfPage;
  destroy(): void;
}

/**
 * Scale for page 0 at the tier target: width-led, with height capped at
 * {@link ASPECT_CAP} × width (the layout letterboxes beyond). 0 when the page
 * has no measurable box.
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
  /** The serial chain, kept non-rejecting so one corrupt PDF can't poison the rest. */
  let chain: Promise<unknown> = Promise.resolve();
  /**
   * Unfinished jobs; drained at 0. Decremented inside the job, since a caller's
   * `finally` runs a microtask too late for the last job to schedule a release.
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
    if (queued > 0) return;
    cancelRelease();
    if (idleMs <= 0) {
      release();
      return;
    }
    idleTimer = setTimeout(release, idleMs);
    // `unref` so Node's timer doesn't hold a test process open.
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
      // The page's own box (rotation applied), which the masonry memo wants.
      return { bitmap: frame.bitmap, pageW: size.width, pageH: size.height };
    } finally {
      // Close between files on every path: peak memory is one document's blocks.
      if (s) await s.close().catch(() => {});
      queued--;
      scheduleRelease();
    }
  }

  const renderPdfPage: RenderPdfPage = async (fileId, hash, o = {}) => {
    if (!seam.supported()) throw new Error("this browser cannot run the PDF decoder");
    const url = rawFileUrl(fileId, hash, { bin: o.bin });
    if (!url) throw new Error("this file has no readable address");
    queued++;
    const run = chain.then(() => job(url));
    // Chain on the settled job so the next open never overlaps this close.

    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  return { renderPdfPage, destroy: release };
}
