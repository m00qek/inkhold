// The reader's modes and side panels: which controls show, and how the docks share the stage.

import { type FileKind } from "../../core/fileKind";
import { tokenPx, MIN_PAGE_W } from "../../ui/sidePanel";
import { toPanelLayers } from "../noteLayers";
import type { ReaderCtx } from "./readerContext";

export interface ReaderPanels {
  /** Which stage is on screen: the note canvas, an image, or no preview. */
  setMode(next: FileKind): void;
  refreshFindUi(): void;
  /** Whether the layers panel is actually visible (intent and availability). */
  layersPanelShown(): boolean;
  bothSidesTooTight(): boolean;
  setPageIndexOpen(next: boolean): void;
  /** Never squeeze the page from both sides: shuts the page index if needed. */
  relieveDoubleSqueeze(): void;
  collapseRightPanels(): void;
  refreshLayersUi(): void;
  /** Whether the decoded layer stack belongs to the focused page. */
  stackIsCurrent(): boolean;
}

export function createReaderPanels(ctx: ReaderCtx): ReaderPanels {
  const { st } = ctx;
  /** Enter (or leave) a non-note mode: swap stages and prune the toolbar. */
  function setMode(next: FileKind): void {
    st.mode = next;
    const isNote = next === "note";
    ctx.stage.hidden = !isNote;
    ctx.files.el.hidden = isNote;
    // A link layer over a non-note would describe the wrong document.
    if (!isNote) ctx.linkLayer.clear();
    refreshPageIndexUi();
    for (const control of ctx.noteOnly) control.hidden = !isNote;
    // A no-preview file has nothing to scale.
    ctx.zoomStepper.el.hidden = !(isNote || next === "image");
    if (next === "image") ctx.nav.sizeImage();

    if (!isNote) ctx.noteLayerCtl.release();
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
    ctx.findBar.toggle.disabled = !searchable;
    ctx.findBar.toggle.title = searchable ? "Find in this note" : "This note has no recognised text to search";
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
    const ocrW = ctx.ocr.isOpen() ? tokenPx("--panel-w", 268) + gap : 0;
    const layersW = layersPanelShown() ? tokenPx("--panel-w-wide", 320) + gap : 0;
    return ocrW + layersW;
  }

  /** The page index plus the right dock(s) would leave the page below {@link MIN_PAGE_W}. */
  function bothSidesTooTight(): boolean {
    const leftW = tokenPx("--panel-w-narrow", 180) + tokenPx("--panel-gap", 22);
    return ctx.stage.getBoundingClientRect().width - 56 - leftW - rightPanelsWidth() < MIN_PAGE_W;
  }

  /** Sync the page-index toggle and panel; shown only for a `.note`. */
  function refreshPageIndexUi(): void {
    const shown = st.mode === "note" && st.pageIndexOpen;
    ctx.pageIndexPanel.setOpen(shown);
    ctx.buttons.pagesToggle.setAttribute("aria-pressed", String(shown));
    ctx.buttons.pagesToggle.setAttribute("aria-expanded", String(shown));
  }

  /** Relayouts because the panel takes stage width. */
  function setPageIndexOpen(next: boolean): void {
    if (st.pageIndexOpen === next) return;
    st.pageIndexOpen = next;
    refreshPageIndexUi();
    void ctx.paint.showPage(st.pageIndex);
  }

  /** Never squeeze the page from both sides: when a RIGHT tool has just opened on
   *  a stage too narrow to hold both docks, collapse the LEFT page index. */
  function relieveDoubleSqueeze(): void {
    if (st.pageIndexOpen && st.mode === "note" && bothSidesTooTight()) setPageIndexOpen(false);
  }

  /** The symmetric half: reopening the page index on a narrow stage closes right docks. */
  function collapseRightPanels(): void {
    if (ctx.ocr.isOpen()) ctx.ocr.toggle();
    if (st.layersPanelOpen) {
      st.layersPanelOpen = false;
      refreshLayersUi();
    }
  }

  /** Sync every layers affordance with the stack; called on every path that changes it. */
  function refreshLayersUi(): void {
    const has = st.mode === "note" && st.layersAvail === "some";
    ctx.buttons.layersToggle.disabled = !has;
    // Unknown (skeleton meta) gets neutral wording, never "no layers".
    ctx.buttons.layersToggle.title = has
      ? "Layers"
      : st.mode === "note" && st.layersAvail === "unknown"
        ? "Layers — still opening this page"
        : "This page has no layers";
    const open = layersPanelShown();
    if (open) {
      // Only this page's stack; the previous page's stays mounted until the new one commits.
      const stack = stackIsCurrent() ? ctx.noteLayerCtl.stack() : null;
      if (stack) ctx.layersPanel.setLayers(toPanelLayers(stack.views));
      else ctx.layersPanel.setState("loading", "Loading this page's layers…");
    }
    ctx.layersPanel.el.hidden = !open;
    ctx.buttons.layersToggle.setAttribute("aria-pressed", String(open));
    ctx.buttons.layersToggle.setAttribute("aria-expanded", String(open));
    ctx.downloads.refreshGroups();
  }

  /** Is the mounted stack the focused page's, at the current theme? */
  function stackIsCurrent(): boolean {
    const page = st.meta?.pages[st.pageIndex];
    return page !== undefined && page.hash !== "" && ctx.noteLayerCtl.isPresented(page.hash, ctx.getTheme());
  }

  return { setMode, refreshFindUi, layersPanelShown, bothSidesTooTight, setPageIndexOpen, relieveDoubleSqueeze, collapseRightPanels, refreshLayersUi, stackIsCurrent };
}
