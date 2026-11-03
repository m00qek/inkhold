// The message protocol between `pdfClient.ts` and `pdfWorker.ts`, types only,
// so the worker bundle doesn't pull in the client's `new Worker(...)`.

import type { PdfCacheStats } from "./pdfBlocks";
import type { DisplayMatrix } from "./markGeometry";
import type { PdfLink } from "../core/types";
import type { PdfWord } from "./pdfWire";
import type { PdfOutlineEntry } from "./pdfWire";

/** `stream`: MuPDF pulls blocks via JSPI `ink.host_read`. `whole`: no-JSPI fallback. */
export type PdfOpenMode = "stream" | "whole";

/**
 * Ink for one exported page as a coverage mask (pen colour is per stroke), a
 * quarter the bytes of RGBA.
 */
export interface PdfInkOverlay {
  /** `width * height` coverage bytes, row-major; 255 = full ink. */
  alpha: Uint8Array;
  width: number;
  height: number;
  /** Placement in display space (top-left origin); built by `markExportMatrix`. */
  matrix: DisplayMatrix;
}

export type PdfRequest =
  | { kind: "open"; id: number; url: string; size: number }
  | { kind: "pageSize"; id: number; page: number }
  /** The page's own authored `/Annots`; cheap, reads the already-fetched page object. */
  | { kind: "pageLinks"; id: number; page: number }
  /**
   * Page words for find-in-PDF. Runs a structured-text device and may pull
   * bytes, so asked only for the visible page and cached on the main thread.
   */
  | { kind: "pageWords"; id: number; page: number }
  /** The flat outline in document order, asked once per document. */
  | { kind: "outline"; id: number }
  | { kind: "render"; id: number; page: number; scale: number }
  /**
   * One page as a PDF: the original content streams grafted into a fresh
   * document with `ink` over them (not a raster). `ink.alpha` is transferred.
   */
  | { kind: "exportPage"; id: number; page: number; ink: PdfInkOverlay }
  /**
   * Draw `ink` onto a page of the open document in place, before one
   * `exportDocument`. Not a loop over `exportPage`, since grafting drops
   * `/Annots`. Mutates the document; the worker reopens it afterwards.
   */
  | { kind: "annotatePage"; id: number; page: number; ink: PdfInkOverlay }
  /**
   * Write an incremental update and answer with the delta to append. `original`
   * is the caller's disk-backed Blob, because MuPDF re-reads the whole document
   * and on the streamed transport that would be a second download.
   */
  | { kind: "exportDocument"; id: number; original: Blob }
  | { kind: "stats"; id: number }
  | { kind: "close"; id: number };

export type PdfResponse =
  | { kind: "opened"; id: number; pageCount: number; mode: PdfOpenMode }
  | { kind: "pageSize"; id: number; width: number; height: number }
  | { kind: "pageLinks"; id: number; links: PdfLink[] }
  | { kind: "pageWords"; id: number; words: PdfWord[] }
  /** Empty is the common, successful answer. */
  | { kind: "outline"; id: number; entries: PdfOutlineEntry[] }
  /** `bitmap` is transferred. */
  | { kind: "rendered"; id: number; bitmap: ImageBitmap; width: number; height: number }
  /** Transferred. */
  | { kind: "exportedPage"; id: number; bytes: Uint8Array }
  | { kind: "annotatedPage"; id: number }
  /** The incremental update's delta (tens of KB). Transferred. */
  | { kind: "exportedDocument"; id: number; delta: Uint8Array }
  | { kind: "stats"; id: number; stats: PdfCacheStats | null; mode: PdfOpenMode | null }
  | { kind: "closed"; id: number }
  /** `status` is the HTTP status of a failed fetch (401/403 re-auth). */

  | { kind: "error"; id: number; message: string; status: number | null };
