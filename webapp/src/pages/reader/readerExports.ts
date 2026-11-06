/**
 * The reader's download menu: current view, original view and whole notebook.
 * Reads reader state through getters, since the focused page and live stack
 * change on every page turn.
 */
import { el } from "../../ui/dom";
import { createExporter, download, savedPdfMessage, type Exporter } from "../../export/exporter";
import { exportFlatPng, exportOra, flattenLayers, type ExportWhich } from "../../export/layered";
import { noteLayerExportFilename } from "../noteLayerModel";
import type { NoteLayersController, NoteLayerStack } from "../noteLayers";
import type { ViewerExportMenu } from "../viewer/viewerExportMenu";
import type { Api } from "../../api/types";
import type { NoteRenderer } from "../../render/types";
import type { NoteMeta, PageRef } from "../../core/types";

export interface ReaderExports {
  /** Cheap and idempotent; called on every page turn and layer toggle. */
  refreshGroups(): void;
  /** Point the raw ".note" row at `url`; `null` disables it. */
  setRawHref(url: string | null): void;
}

export interface ReaderExportsDeps {
  api: Api;
  renderer: NoteRenderer;
  menu: ViewerExportMenu;
  toast(message: string): void;
  meta(): NoteMeta | null | undefined;
  currentPage(): PageRef | undefined;
  layers: Pick<NoteLayersController, "exportModel">;
  /**
   * The stack actually on screen, or null. Across a page turn the previous stack
   * is hidden, not released, and exporting it would put page N under N+1's name.
   */
  liveStack(): NoteLayerStack | null;
}

export function createReaderExports(deps: ReaderExportsDeps): ReaderExports {
  const { api, renderer, menu, toast, meta, currentPage, layers, liveStack } = deps;
  const exporter: Exporter = createExporter({ api, renderer });
  const menuItem = menu.item;

  async function exportDocumentPdf(): Promise<void> {
    const m = meta();
    if (!m || m.pages.length === 0) return;
    // Progress claims only the page count, not time: per-page cost varies with ink.
    const { blob, filename, kind } = await exporter.documentPdf(m, (done, total) =>
      toast(`Exporting ${m.name} — page ${done} of ${total}…`),
    );
    download(filename, blob);
    toast(savedPdfMessage(filename, kind, m.pages.length));
  }

  // Per-view exports of the current page. The model is decoded fresh in light
  // form so a dark theme never inverts an export. Without a layer stack, "current"
  // falls back to the composite page and ORA/"original" are not offered.

  async function exportViewPng(which: ExportWhich): Promise<void> {
    const m = meta();
    const page = currentPage();
    if (!m || !page) return;
    const snapshot = await layers.exportModel();
    if (!snapshot) {
      const { blob, filename } = await exporter.pagePng(m, page);
      download(filename, blob);
      toast(`Saved ${filename}`);
      return;
    }
    try {
      const blob = await exportFlatPng(snapshot.model, which);
      const filename = noteLayerExportFilename(m.name, page.index, which, "png");
      download(filename, blob);
      toast(`Saved ${filename}`);
    } finally {
      snapshot.release();
    }
  }

  async function exportViewOra(which: ExportWhich): Promise<void> {
    const m = meta();
    const page = currentPage();
    if (!m || !page) return;
    const snapshot = await layers.exportModel();
    if (!snapshot) return; // ORA needs a stack; its row is hidden without one
    try {
      const blob = await exportOra(snapshot.model, which);
      const filename = noteLayerExportFilename(m.name, page.index, which, "ora");
      download(filename, blob);
      toast(`Saved ${filename}`);
    } finally {
      snapshot.release();
    }
  }

  /**
   * Flattens onto white (PDF has no alpha, so transparency would go black) at the
   * model's effective dims, so landscape pages stay wide. The OCR layer is
   * positional, so both views carry the same selectable words.
   */
  async function exportViewPdf(which: ExportWhich): Promise<void> {
    const m = meta();
    const page = currentPage();
    if (!m || !page) return;
    const say = (filename: string, kind: "searchable" | "raster") =>
      // Say whether the text is selectable (depends on a verified mm scale).
      toast(savedPdfMessage(filename, kind));
    const snapshot = await layers.exportModel();
    if (!snapshot) {
      const { blob, filename, kind } = await exporter.pagePdf(m, page);
      download(filename, blob);
      say(filename, kind);
      return;
    }
    try {
      const image = flattenLayers(snapshot.model, which, { background: "#ffffff" });
      const { blob, kind } = await exporter.pagePdfFromImage(m, page, image);
      const filename = noteLayerExportFilename(m.name, page.index, which, "pdf");
      download(filename, blob);
      say(filename, kind);
    } finally {
      snapshot.release();
    }
  }

  // ---- download menu ----

  // ORA alone hides on a page with no stack; PNG and PDF fall back to the composite.
  const currentOraItem = menuItem("Layered image", ".ora", () => exportViewOra("current"));
  const currentGroup = el(
    "div",
    {},
    el("div", { class: "menu__head", text: "This page — Current view" }),
    menuItem("Flattened image", ".png", () => exportViewPng("current")),
    currentOraItem,
    menuItem("PDF document", ".pdf", () => exportViewPdf("current")),
  );

  // Original group shows only when some layer's visibility differs from the
  // authored state; otherwise its exports are byte-identical to current.
  const originalGroup = el(
    "div",
    { hidden: true },
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "This page — Original view" }),
    menuItem("Flattened image", ".png", () => exportViewPng("original")),
    menuItem("Layered image", ".ora", () => exportViewOra("original")),
    menuItem("PDF document", ".pdf", () => exportViewPdf("original")),
  );

  // The raw ".note" row; href minted per open (bin-scoped for a trashed file).
  const rawNoteItem = menu.rawItem("Supernote", ".note");

  const wholeGroup = el(
    "div",
    {},
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "Whole notebook" }),
    menuItem("PDF document", ".pdf", exportDocumentPdf),
    rawNoteItem.el,
  );

  menu.pop.append(currentGroup, originalGroup, wholeGroup);

  return {
    refreshGroups(): void {
      const stack = liveStack();
      currentOraItem.hidden = stack === null;
      originalGroup.hidden = stack === null || !stack.views.some((v) => v.visible !== v.authoredVisible);
    },
    setRawHref: (url) => rawNoteItem.setHref(url),
  };
}
