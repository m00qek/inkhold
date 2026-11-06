// The mutable state of `createReader`, one object so its pieces can share it.

import type { NoteMeta } from "../../core/types";
import type { FileKind } from "../../core/fileKind";
import type { Zoom } from "./reader";

export interface ReaderState {

  meta: NoteMeta | null;
  /** Which outcome is on screen; every note-only path is gated on it. */
  mode: FileKind;
  /** False while `meta` is the skeleton, whose invented pages say `textHash: null`. */
  metaResolved: boolean;
  /** The listing's whole-note recognised-text flag, used until `metaResolved`. */
  summaryRecognized: boolean;
  pageIndex: number;
  zoom: Zoom;
  /** A pinch's size as a factor of Fit; set, it stands in for `zoom`. */
  pinch: number | null;
  /** The page's size as last painted, as a factor of Fit (what a pinch starts from). */
  fitScale: number;
  open: boolean;
  paintToken: number;
  /** Opened from the bin: raw URLs need the bin-scoped route (the live one 404s). */
  fromBin: boolean;
  /** The previewed retained version (history mode), or null. */
  previewVersion: { md5: string; createdAt: number } | null;
  /** History preview of a trashed file: no Restore, bin-scoped history route. */
  previewViewOnly: boolean;
  /** The user's intent; the panel shows only while the page has layers. */
  layersPanelOpen: boolean;
  /**
  * What the layers toggle may claim, decided from metadata rather than the
  * decode (which lags a page turn). "unknown" while `meta` is the skeleton.
  */
  layersAvail: "unknown" | "none" | "some";
  /** The user's intent; defaults open, forced shut by {@link relieveDoubleSqueeze}. */
  pageIndexOpen: boolean;
  // --- the URL -------------------------------------------------------------
  // Page and query are written with `replaceState` via `onPosition`. Suspended
  // through `open()`, whose `find.reset()` would otherwise publish an empty query
  // and wipe the `?q=` it is about to prime.
  urlSuspended: boolean;
  urlTimer: ReturnType<typeof setTimeout> | undefined;
}
