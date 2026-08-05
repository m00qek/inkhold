// The message protocol between `pdfClient.ts` (main thread) and `pdfWorker.ts`.
//
// Its own module so neither side imports the other: the client owns a
// `new Worker(new URL(...))`, and a worker that imported it would pull that
// construction into its own bundle. Types only — nothing here survives compile.

import type { PdfCacheStats } from "./pdfBlocks";

/**
 * How the document was opened.
 *
 * `stream` is the JSPI path: MuPDF pulls blocks through `ink.host_read` as it
 * needs them. `whole` is the fallback for an engine without JSPI — correct
 * everywhere, just not fast (`docs/scratch/pdf-ranges.md` §3).
 */
export type PdfOpenMode = "stream" | "whole";

export type PdfRequest =
  | { kind: "open"; id: number; url: string; size: number }
  | { kind: "pageSize"; id: number; page: number }
  | { kind: "render"; id: number; page: number; scale: number }
  | { kind: "stats"; id: number }
  | { kind: "close"; id: number };

export type PdfResponse =
  | { kind: "opened"; id: number; pageCount: number; mode: PdfOpenMode }
  | { kind: "pageSize"; id: number; width: number; height: number }
  /** `bitmap` is TRANSFERRED, so it crosses without copying the pixels. */
  | { kind: "rendered"; id: number; bitmap: ImageBitmap; width: number; height: number }
  | { kind: "stats"; id: number; stats: PdfCacheStats | null; mode: PdfOpenMode | null }
  | { kind: "closed"; id: number }
  /** `status` is the HTTP status when the failure was a fetch — 401/403 re-auth. */
  | { kind: "error"; id: number; message: string; status: number | null };
