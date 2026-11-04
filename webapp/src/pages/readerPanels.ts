// The reader's modes and side panels: which controls show, and how the docks share the stage.

import { type FileKind } from "../core/fileKind";
import { createOcrController } from "./ocrPanel";
import { createReaderExports } from "./readerExports";
import { createFindBarView } from "./readerBars";
import { createLayersPanel } from "./layersPanel";
import { tokenPx, MIN_PAGE_W } from "../ui/sidePanel";
import { createPageIndex } from "./pageIndex";
import { createLinkLayer } from "./linkLayer";
import { createNoteLayersController, toPanelLayers } from "./noteLayers";
import type { ReaderState } from "./readerState";
import { createReaderNav } from "./readerNav";

import type { ReaderDeps } from "./reader";

export interface ReaderPanelsParts {
  showPage: (index: number) => Promise<void>;
  getTheme: () => ReaderDeps["getTheme"];
  noteLayerCtl: () => ReturnType<typeof createNoteLayersController>;
  linkLayer: () => ReturnType<typeof createLinkLayer>;
  layersPanel: () => ReturnType<typeof createLayersPanel>;
  pageIndexPanel: () => ReturnType<typeof createPageIndex>;
  stage: () => HTMLElement;
  fileStage: () => HTMLElement;
  zoomEl: () => HTMLElement;
  layersToggle: () => HTMLButtonElement;
  pagesToggle: () => HTMLButtonElement;
  findToggle: () => ReturnType<typeof createFindBarView>["toggle"];
  noteOnly: () => HTMLElement[];
  sizeImage: () => ReturnType<typeof createReaderNav>["sizeImage"];
  ocr: () => ReturnType<typeof createOcrController>;
  downloads: () => ReturnType<typeof createReaderExports>;
}

export function createReaderPanels(st: ReaderState, p: ReaderPanelsParts) {
  /** Enter (or leave) a non-note mode: swap stages and prune the toolbar. */
  function setMode(next: FileKind): void {
    st.mode = next;
    const isNote = next === "note";
    p.stage().hidden = !isNote;
    p.fileStage().hidden = isNote;
    // A link layer over a non-note would describe the wrong document.
    if (!isNote) p.linkLayer().clear();
    refreshPageIndexUi();
    for (const control of p.noteOnly()) control.hidden = !isNote;
    // A no-preview file has nothing to scale.
    p.zoomEl().hidden = !(isNote || next === "image");
    if (next === "image") p.sizeImage()();

    if (!isNote) p.noteLayerCtl().release();
    refreshLayersUi();

    refreshFindUi();
  }

  /**
   * Find needs device recognition (`textHash !== null`). Until the meta
   * resolves use the listing's whole-note flag: the skeleton invents
   * `textHash: null` for every page after the first.
   */
  function refreshFindUi(): void {
    const isNote = st.mode === "note";
    const searchable =
      isNote && (st.metaResolved ? (st.meta?.pages.some((pg) => pg.textHash !== null) ?? false) : st.summaryRecognized);
    p.findToggle().disabled = !searchable;
    p.findToggle().title = searchable ? "Find in this note" : "This note has no recognised text to search";
  }

  /**
   * Whether the layers panel is on screen; the toggle and every width
   * reservation read this. Keyed on `layersAvail`, not the stack, so the page
   * width doesn't jump during a page turn's decode.
   */
  function layersPanelShown(): boolean {
    return st.layersPanelOpen && st.mode === "note" && st.layersAvail === "some";
  }

  /** Width of the open right dock(s), gap included, from the layout tokens. */
  function rightPanelsWidth(): number {
    const gap = tokenPx("--panel-gap", 22);
    const ocrW = p.ocr().isOpen() ? tokenPx("--panel-w", 268) + gap : 0;
    const layersW = layersPanelShown() ? tokenPx("--panel-w-wide", 320) + gap : 0;
    return ocrW + layersW;
  }

  /** The page index plus the right dock(s) would leave the page below {@link MIN_PAGE_W}. */
  function bothSidesTooTight(): boolean {
    const leftW = tokenPx("--panel-w-narrow", 180) + tokenPx("--panel-gap", 22);
    return p.stage().getBoundingClientRect().width - 56 - leftW - rightPanelsWidth() < MIN_PAGE_W;
  }

  /** Sync the page-index toggle and panel; shown only for a `.note`. */
  function refreshPageIndexUi(): void {
    const shown = st.mode === "note" && st.pageIndexOpen;
    p.pageIndexPanel().setOpen(shown);
    p.pagesToggle().setAttribute("aria-pressed", String(shown));
    p.pagesToggle().setAttribute("aria-expanded", String(shown));
  }

  /** Relayouts because the panel takes stage width. */
  function setPageIndexOpen(next: boolean): void {
    if (st.pageIndexOpen === next) return;
    st.pageIndexOpen = next;
    refreshPageIndexUi();
    void p.showPage(st.pageIndex);
  }

  /** Never squeeze the page from both sides: when a RIGHT tool has just opened on
   *  a stage too narrow to hold both docks, collapse the LEFT page index. */
  function relieveDoubleSqueeze(): void {
    if (st.pageIndexOpen && st.mode === "note" && bothSidesTooTight()) setPageIndexOpen(false);
  }

  /** The symmetric half: reopening the page index on a narrow stage closes right docks. */
  function collapseRightPanels(): void {
    if (p.ocr().isOpen()) p.ocr().toggle();
    if (st.layersPanelOpen) {
      st.layersPanelOpen = false;
      refreshLayersUi();
    }
  }

  /** Sync every layers affordance with the stack; called on every path that changes it. */
  function refreshLayersUi(): void {
    const has = st.mode === "note" && st.layersAvail === "some";
    p.layersToggle().disabled = !has;
    // Unknown (skeleton meta) gets neutral wording, never "no layers".
    p.layersToggle().title = has
      ? "Layers"
      : st.mode === "note" && st.layersAvail === "unknown"
        ? "Layers — still opening this page"
        : "This page has no layers";
    const open = layersPanelShown();
    if (open) {
      // Only this page's stack; the previous page's stays mounted until the new one commits.
      const stack = stackIsCurrent() ? p.noteLayerCtl().stack() : null;
      if (stack) p.layersPanel().setLayers(toPanelLayers(stack.views));
      else p.layersPanel().setState("loading", "Loading this page's layers…");
    }
    p.layersPanel().el.hidden = !open;
    p.layersToggle().setAttribute("aria-pressed", String(open));
    p.layersToggle().setAttribute("aria-expanded", String(open));
    p.downloads().refreshGroups();
  }

  /** Is the mounted stack the focused page's, at the current theme? */
  function stackIsCurrent(): boolean {
    const page = st.meta?.pages[st.pageIndex];
    return page !== undefined && page.hash !== "" && p.noteLayerCtl().isPresented(page.hash, p.getTheme()());
  }

  return { setMode, refreshFindUi, layersPanelShown, rightPanelsWidth, bothSidesTooTight, refreshPageIndexUi, setPageIndexOpen, relieveDoubleSqueeze, collapseRightPanels, refreshLayersUi, stackIsCurrent };
}
