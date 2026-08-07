// The message protocol between `pdfClient.ts` (main thread) and `pdfWorker.ts`.
//
// Its own module so neither side imports the other: the client owns a
// `new Worker(new URL(...))`, and a worker that imported it would pull that
// construction into its own bundle. Types only — nothing here survives compile.

import type { PdfCacheStats } from "./pdfBlocks";
import type { DisplayMatrix } from "./markGeometry";
import type { PdfLink } from "./pdfLinks";

/**
 * How the document was opened.
 *
 * `stream` is the JSPI path: MuPDF pulls blocks through `ink.host_read` as it
 * needs them. `whole` is the fallback for an engine without JSPI — correct
 * everywhere, just not fast (`docs/scratch/pdf-ranges.md` §3).
 */
export type PdfOpenMode = "stream" | "whole";

/**
 * The ink to burn onto one exported page: a COVERAGE MASK and where it goes.
 *
 * A mask rather than colour, because that is what the ink is. A `.mark`'s pen is
 * one colour per stroke and the export draws it as the device drew it, so the
 * only thing the page needs from this side is HOW MUCH ink covers each sample —
 * 255 opaque, 0 clear. A full RGBA image would be four times the bytes to say
 * the same thing (an A4 page's ink at the N6's own resolution is 2.5 MB as
 * alpha and 9.9 MB as RGBA — worth moving rather than copying).
 */
export interface PdfInkOverlay {
  /** `width * height` coverage bytes, row-major. 255 = full ink, 0 = clear. */
  alpha: Uint8Array;
  width: number;
  height: number;
  /**
   * Where that image lands on the page, in DISPLAY space (top-left origin) —
   * see `markExportMatrix`, which is the only thing that builds one.
   */
  matrix: DisplayMatrix;
}

export type PdfRequest =
  | { kind: "open"; id: number; url: string; size: number }
  | { kind: "pageSize"; id: number; page: number }
  /**
   * The page's OWN links — the `/Annots` the document was authored with, not
   * anything the app adds. Cheap next to a render: `fz_load_links` reads the
   * page object the renderer has already fetched for that page, so on a
   * range-served document this costs no new traffic on a page you are looking
   * at.
   */
  | { kind: "pageLinks"; id: number; page: number }
  | { kind: "render"; id: number; page: number; scale: number }
  /**
   * ONE PAGE, AS A PDF — the original page's own content streams grafted into a
   * fresh document with `ink` drawn over them. Not a raster: what makes this row
   * worth having is that the exported page keeps the text, fonts and vectors the
   * source page had.
   *
   * `ink.alpha`'s buffer is TRANSFERRED into the worker (see `pdfClient.ts`).
   */
  | { kind: "exportPage"; id: number; page: number; ink: PdfInkOverlay }
  /**
   * Draw `ink` onto one page of the OPEN document, in place — one of these per
   * annotated page, then a single `exportDocument`.
   *
   * NOT A LOOP OVER `exportPage`, and the difference is the whole feature:
   * grafting drops `/Annots`, so a page-by-page whole-document export would
   * lose every link and highlight the original had. `ink.alpha` is TRANSFERRED,
   * for the same reason it is there.
   *
   * THE DOCUMENT IS MUTATED. The worker reopens it after `exportDocument`, so
   * the session the viewer keeps reading through is clean either way.
   */
  | { kind: "annotatePage"; id: number; page: number; ink: PdfInkOverlay }
  /**
   * Write the annotations as an INCREMENTAL UPDATE and answer with the DELTA —
   * the bytes that belong after the original file, which the caller
   * concatenates onto it.
   *
   * `original` is the caller's own copy of the file, as a Blob. It is not a
   * convenience: MuPDF's incremental write begins by reading back the whole
   * document it is appending to, and on the streamed transport that would
   * otherwise be a second download of a 76 MB file over the link this app is
   * designed around. A Blob crosses `postMessage` by REFERENCE and is
   * disk-backed, so lending it costs nothing and the re-read is local.
   */
  | { kind: "exportDocument"; id: number; original: Blob }
  | { kind: "stats"; id: number }
  | { kind: "close"; id: number };

export type PdfResponse =
  | { kind: "opened"; id: number; pageCount: number; mode: PdfOpenMode }
  | { kind: "pageSize"; id: number; width: number; height: number }
  /** Plain data — small, and structured-cloned like every other reply. */
  | { kind: "pageLinks"; id: number; links: PdfLink[] }
  /** `bitmap` is TRANSFERRED, so it crosses without copying the pixels. */
  | { kind: "rendered"; id: number; bitmap: ImageBitmap; width: number; height: number }
  /** The produced PDF's bytes. TRANSFERRED, like `rendered`'s bitmap. */
  | { kind: "exportedPage"; id: number; bytes: Uint8Array }
  | { kind: "annotatedPage"; id: number }
  /**
   * The incremental update's DELTA — tens of kilobytes, not a document.
   * TRANSFERRED, like the rest.
   */
  | { kind: "exportedDocument"; id: number; delta: Uint8Array }
  | { kind: "stats"; id: number; stats: PdfCacheStats | null; mode: PdfOpenMode | null }
  | { kind: "closed"; id: number }
  /** `status` is the HTTP status when the failure was a fetch — 401/403 re-auth. */
  | { kind: "error"; id: number; message: string; status: number | null };
