// The reader's shared context: everything its parts read, named once.
//
// `createReader` builds the DOM, seeds a `ReaderCtx` with it and the state,
// then creates the parts in dependency order (overlays, navigation, panels,
// painting, the feature controllers, the lifecycle). A part reads a member
// only when one of its functions runs, never while it is being built, so the
// construction order in `reader.ts` is the one place that has to be right.

import type { ApiFailureSink } from "../../api/client";
import type { NoteMeta, PageRef, PdfLink } from "../../core/types";
import type { LazyEngine } from "../../render/lazy";
import type { SidePanel } from "../../ui/sidePanel";
import type { BinViewerActions } from "../../ui/binViewerActions";
import type { FileStage } from "../fileStage";
import type { LinkLayer } from "../linkLayer";
import type { NoteLayersController } from "../noteLayers";
import type { LayersPanel } from "../layersPanel";
import type { PageIndex } from "../pageIndex";
import type { OcrController } from "../ocrPanel";
import type { FindController } from "../findInNote";
import type { ViewerHeader } from "../viewer/viewerChrome";
import type { Pager, ZoomStepper } from "../viewer/viewerControls";
import type { ViewerExportMenu } from "../viewer/viewerExportMenu";
import type { ReaderDeps, Zoom } from "./reader";
import type { ReaderState } from "./readerState";
import type { FindBarView, ReaderButtons, ReaderVersionBanner } from "./readerBars";
import type { ReaderExports } from "./readerExports";
import type { ReaderOverlays } from "./readerOverlays";
import type { ReaderNav } from "./readerNav";
import type { ReaderPanels } from "./readerPanels";
import type { ReaderPaint } from "./readerPaint";

export interface ReaderCtx {
  // ---- given by the viewer set ----
  deps: ReaderDeps;
  api: ReaderDeps["api"];
  renderer: ReaderDeps["renderer"];
  cache: ReaderDeps["cache"];
  getTheme: ReaderDeps["getTheme"];

  st: ReaderState;
  /** Session expiry to the shell; a stale page refetches the metadata. */
  failures: ApiFailureSink;

  // ---- DOM ----
  header: ViewerHeader;
  pageCanvas: HTMLCanvasElement;
  /** Per-layer canvas stack, shown instead of the composite when every layer decodes. */
  noteLayerCtl: NoteLayersController;
  /** Mounted last so links stack above both the composite and the layer stack. */
  linkLayer: LinkLayer;
  pageEl: HTMLElement;
  ocrPanel: SidePanel;
  layersPanel: LayersPanel;
  /** The shared page index, docked left and open by default. */
  pageIndexPanel: PageIndex;
  pageWrap: HTMLElement;
  stage: HTMLElement;
  /** The non-`.note` stage: an `<img>` or the no-preview block. */
  files: FileStage;
  pager: Pager;
  zoomStepper: ZoomStepper<Zoom>;
  exportMenu: ViewerExportMenu;
  buttons: ReaderButtons;
  /** Bin-origin cluster (retention countdown + menu), swapped in for Move to bin. */
  binActions: BinViewerActions;
  banner: ReaderVersionBanner;
  findBar: FindBarView;
  /** Controls hidden in the non-note modes; zoom is not among them, images zoom too. */
  noteOnly: HTMLElement[];
  root: HTMLElement;

  /**
  * Links per page, keyed by index and `linksHash`. Memoised because every
  * relayout re-runs `showPage` and the response is `no-cache`.
  */
  linksByPage: Map<string, readonly PdfLink[]>;

  // ---- the parts ----
  overlays: ReaderOverlays;
  nav: ReaderNav;
  panels: ReaderPanels;
  paint: ReaderPaint;
  // ---- the feature controllers (`installReaderFeatures`) ----
  ocr: OcrController;
  find: FindController;
  downloads: ReaderExports;
  /** Paints the page index's thumbnails within the strip's window. */
  filmEngine: LazyEngine;

  // ---- small helpers ----
  currentPage(): PageRef | undefined;
  /** Points the toolbar's download control at `url` (hidden when there is none). */
  setDownload(url: string | null): void;
  showNoPreview(m: NoteMeta, title: string, body: string): void;
  showImage(m: NoteMeta, url: string): void;
}

/** The members `createReader` has before any part is built. */
export type ReaderCtxSeed = Omit<ReaderCtx, "overlays" | "nav" | "panels" | "paint" | "ocr" | "find" | "downloads" | "filmEngine">;

/**
* Starts a context from its seed. The parts are assigned by `createReader` in
* dependency order; this cast is that lifecycle, stated once.
*/
export function seedReaderContext(seed: ReaderCtxSeed): ReaderCtx {
  return seed as ReaderCtx;
}
