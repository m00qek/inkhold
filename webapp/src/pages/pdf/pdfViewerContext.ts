// The PDF viewer's shared context: everything its parts read, named once.
//
// `createPdfViewer` builds the DOM and the per-document collaborators, seeds a
// `PdfViewerCtx` with them, then creates the two parts that need the whole:
// navigation and the lifecycle. A part reads a member only when one of its
// functions runs, so the construction order in `pdfViewer.ts` is the one place
// that has to be right.

import type { PageRef } from "../../core/types";
import type { ViewerDeps } from "../viewer/viewer";
import type { VersionBanner, ViewerBody, ViewerHeader } from "../viewer/viewerChrome";
import type { Pager, ZoomStepper } from "../viewer/viewerControls";
import type { ViewerExportMenu } from "../viewer/viewerExportMenu";
import type { BinViewerActions } from "../../ui/binViewerActions";
import type { LayersPanel } from "../layersPanel";
import type { LinkLayer } from "../linkLayer";
import type { NoteLayersController } from "../noteLayers";
import type { PdfSeam } from "./pdfViewer";
import type { PdfViewerState } from "./pdfViewerState";
import type { ContextualOpener, CopyControl, PdfDocks, PdfFindBarView } from "./pdfChrome";
import type { PdfExports } from "./pdfExports";
import type { PdfFindController } from "./pdfFind";
import type { PdfHighlightLayer } from "./pdfHighlightLayer";
import type { PdfOutlinePanel } from "./pdfOutlinePanel";
import type { PdfPageRenderer, Zoom } from "./pdfPageRenderer";
import type { PdfSelectionLayer } from "./pdfSelectionLayer";
import type { PdfThumbStrip } from "./pdfThumbStrip";
import type { PdfViewerExports } from "./pdfViewerExports";
import type { PdfNav } from "./pdfViewerNav";
import type { PdfLifecycle } from "./pdfViewerLifecycle";

export interface PdfViewerCtx {
  deps: ViewerDeps;
  /** The browser seams, injectable so the viewer is testable without a worker. */
  seam: PdfSeam;
  st: PdfViewerState;
  /** The `.mark`'s pages by document page index; the lifecycle fills it, the renderer, strip and exports read it. */
  markPages: Map<number, PageRef>;

  // ---- DOM ----
  header: ViewerHeader;
  canvas: HTMLCanvasElement;
  /** The `.mark` ink over the page, through the reader's layers controller. */
  markCtl: NoteLayersController;
  /** Stacking is DOM order in `.pdf-stage`; links go last, above the ink. */
  linkLayer: LinkLayer;
  /** Find marks sit under the ink, so they never wash over a pen stroke. */
  findLayer: PdfHighlightLayer;
  /** The one pointer-taking layer; under the links so a press on a link reaches it. */
  selectLayer: PdfSelectionLayer;
  stage: HTMLElement;
  body: ViewerBody;
  zoomStepper: ZoomStepper<Zoom>;
  pager: Pager;
  exportMenu: ViewerExportMenu;
  downloads: PdfExports;
  moveBin: HTMLButtonElement;
  /** Bin-origin cluster, mutually exclusive with Move to bin. */
  binActions: BinViewerActions;
  /** Offers the ink's history, never a past PDF. */
  versionsOpener: ContextualOpener;
  versionBanner: VersionBanner;
  /** The shared layers panel, with the PDF itself as the bottom row. */
  layersPanel: LayersPanel;
  thumbs: PdfThumbStrip;
  pagesPanel: PdfThumbStrip["panel"];
  pagesToggle: HTMLButtonElement;
  outlinePanel: PdfOutlinePanel;
  outlineOpener: ContextualOpener;
  layersToggle: HTMLButtonElement;
  /** Pages and Outline share the left dock; the layers panel is the right one. */
  docks: PdfDocks;
  copy: CopyControl;
  findToggle: HTMLButtonElement;
  findBar: PdfFindBarView;
  main: HTMLElement;
  root: HTMLElement;

  // ---- per-document machinery ----
  renderer: PdfPageRenderer;
  find: PdfFindController;
  exportDriver: PdfViewerExports;

  // ---- the parts ----
  nav: PdfNav;
  lifecycle: PdfLifecycle;

  // ---- small helpers ----
  setVersionsAvailable(has: boolean): void;
  /** Also closes the outline dock when a document has none. */
  setOutlineAvailable(has: boolean): void;
}

/** The members `createPdfViewer` has before the two parts are built. */
export type PdfViewerCtxSeed = Omit<PdfViewerCtx, "nav" | "lifecycle">;

/** Starts a context from its seed; `createPdfViewer` assigns the parts next. The cast is that lifecycle, stated once. */
export function seedPdfViewerContext(seed: PdfViewerCtxSeed): PdfViewerCtx {
  return seed as PdfViewerCtx;
}
