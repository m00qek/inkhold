// The mutable state of `createPdfViewer`, one object so its pieces can share it.

import type { Id, NoteMeta } from "../core/types";
import type { PdfSession } from "../render/pdfClient";
import type { Zoom } from "./pdfPageRenderer";

export interface PdfViewerState {
  /** One session for the viewer's life: MuPDF is ~5 MB of wasm to compile. */
  session: PdfSession | null;
  open_: boolean;
  pageIndex: number;
  pageCount: number;
  zoom: Zoom;
  fromBin: boolean;
  /** What the file-zone actions act on; cleared by `release()`. */
  meta: NoteMeta | null;
  /** The paired `.mark` by 0-based PDF page. Sparse: a missing key means no annotations. */
  markId: Id | null;
  /**
  * The mark id from the metadata, available before `loadMark` sets `markId`, so
  * the versions control does not flicker from dimmed to live.
  */
  annotationsId: Id | null;
  /**
  * The annotation version being previewed, or null. The PDF itself is always
  * live; this drives the banner, Restore, and salts thumbnail cache keys so a
  * preview is never served live ink.
  */
  previewVersion: { md5: string; createdAt: number } | null;
  /** The previewed annotations belong to a trashed document: no Restore. */
  previewViewOnly: boolean;
  docHash: string;
  /**
  * Bumped per open and teardown; async steps check it so a superseded load never
  * renders through a handle `hide()` closed.
  */
  generation: number;
}
