/**
 * The reader's download menu — the three groups, and what each row does.
 *
 *   THIS PAGE — CURRENT VIEW · THIS PAGE — ORIGINAL VIEW · WHOLE NOTEBOOK
 *
 * The transforms themselves are not here: `export/exporter.ts` owns the PDF and
 * PNG pipelines and `export/layered.ts` the flatten/ORA ones. What this owns is
 * the layer between them and the menu — which rows exist for the page in front
 * of you, which view each row exports, and what the toast afterwards is allowed
 * to claim.
 *
 * It reads the reader's state through getters rather than holding any: the
 * focused page and the live stack change under it on every page turn, and a
 * snapshot taken when the menu was built would export the wrong page.
 */

import { el } from "../ui/dom";
import { createExporter, download, savedPdfMessage, type Exporter } from "../export/exporter";
import { exportFlatPng, exportOra, flattenLayers, type ExportWhich } from "../export/layered";
import { noteLayerExportFilename, type NoteLayersController, type NoteLayerStack } from "./noteLayers";
import type { ViewerExportMenu } from "./viewerChrome";
import type { Api } from "../api/types";
import type { NoteRenderer } from "../render/types";
import type { NoteMeta, PageRef } from "../core/types";

export interface ReaderExports {
  /**
   * Reconcile the per-page groups with the live stack. Cheap and idempotent —
   * called on every page turn and on every layer toggle, so it updates
   * visibility WITHOUT rebuilding the panel's own rows.
   */
  refreshGroups(): void;
  /**
   * Point the raw ".note" row at `url`; `null` disables it. Minted per open, and
   * per version in a history preview — see the call site.
   */
  setRawHref(url: string | null): void;
}

export interface ReaderExportsDeps {
  api: Api;
  renderer: NoteRenderer;
  /** The menu shell from `viewerChrome` — this fills its popover. */
  menu: ViewerExportMenu;
  toast(message: string): void;
  /** The open file, or null before one is. */
  meta(): NoteMeta | null | undefined;
  /** The focused page, or undefined when there is none. */
  currentPage(): PageRef | undefined;
  layers: Pick<NoteLayersController, "exportModel">;
  /**
   * THE STACK THAT IS ON SCREEN, or null — not merely the one that is mounted,
   * and null for anything that is not a note. Across a page turn the previous
   * page's stack survives until the new one commits (it is hidden, not released),
   * and offering "save the current view" then would export page N's layers under
   * page N+1's filename.
   */
  liveStack(): NoteLayerStack | null;
}

export function createReaderExports(deps: ReaderExportsDeps): ReaderExports {
  const { api, renderer, menu, toast, meta, currentPage, layers, liveStack } = deps;
  const exporter: Exporter = createExporter({ api, renderer });
  /** A menu row (label + ext) — the shared mechanics close the menu and run it
   *  disabled-meanwhile, toasting on failure. */
  const menuItem = menu.item;

  async function exportDocumentPdf(): Promise<void> {
    const m = meta();
    if (!m || m.pages.length === 0) return;
    // PROGRESS THAT ONLY CLAIMS WHAT IT KNOWS: which page is being decoded, out
    // of how many. No percentage of *time* and no spinner pretending to move —
    // the per-page cost varies with the ink on it, and the compression step is
    // not something this can see inside.
    const { blob, filename, kind } = await exporter.documentPdf(m, (done, total) =>
      toast(`Exporting ${m.name} — page ${done} of ${total}…`),
    );
    download(filename, blob);
    toast(savedPdfMessage(filename, kind, m.pages.length));
  }

  // THE PER-VIEW EXPORTS of the current page — Flat PNG, Layered ORA and per-page
  // PDF, each in a `current` or `original` view. The model is decoded FRESH in
  // light form (`exportModel`) so a dark-themed screen never inverts an export;
  // `current` reads the panel's live visibility, `original` the device-authored
  // state — a device-hidden layer rides an "original" export with full pixels,
  // marked invisible. Where a page has NO layer stack (a v1 or single-composite
  // page) "current view" IS the composite, so PNG and PDF fall back to the plain
  // page export; the layered-only ORA is not offered there (its row hides), and
  // "original" is never offered without a stack (its whole menu group hides), so
  // only "current" ever reaches a fallback.

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
   * The per-page PDF. It reuses the whole PDF pipeline (export/pdf.ts: the raster
   * plus the INVISIBLE searchable OCR layer) scoped to ONE page. With a stack it
   * flattens the chosen view onto a WHITE sheet (PDF has no alpha, so an unfilled
   * transparent flatten would gray to black) at the model's EFFECTIVE dims — a
   * landscape page's model is 1872×1404, so the PDF is wide, not sheared — and
   * hands that image to `pagePdfFromImage`. The OCR text layer is positional, so
   * `current` and `original` carry the SAME selectable words over different
   * pixels. With no stack it is the composite page PDF (current == composite).
   */
  async function exportViewPdf(which: ExportWhich): Promise<void> {
    const m = meta();
    const page = currentPage();
    if (!m || !page) return;
    const say = (filename: string, kind: "searchable" | "raster") =>
      // SAY WHICH ONE THEY GOT. A searchable PDF and a raster-only one look
      // identical until someone tries to select text, and the difference is
      // decided by whether this device's millimetre scale has been verified —
      // which is why the message answers "can I select the text" and leaves the
      // calibration out of it (`savedPdfMessage`).
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

  // THE DOWNLOAD MENU — three groups (the settled structure). `.menu__head`
  // uppercases in CSS, so the natural-case text here renders as the headers
  // shown. The per-page rows adapt to the focused page (see the export functions
  // above): with a live stack they flatten the chosen VIEW; with none, "current
  // view" is the composite and the layered-only rows fold away.

  // The layered-only CURRENT row (ORA). Held apart from its group because it — and
  // it alone in the CURRENT group — hides on a page with no stack: an ORA of a
  // single composite has nothing to layer, whereas the Flat PNG and PDF beside it
  // fall back to the composite and stay.
  const currentOraItem = menuItem("Layered image", ".ora", () => exportViewOra("current"));
  const currentGroup = el(
    "div",
    {},
    el("div", { class: "menu__head", text: "This page — Current view" }),
    menuItem("Flattened image", ".png", () => exportViewPng("current")),
    currentOraItem,
    menuItem("PDF document", ".pdf", () => exportViewPdf("current")),
  );

  // The WHOLE ORIGINAL group hides unless a layer's live visibility differs from
  // its device-authored state (`refreshGroups` flips it): with nothing toggled
  // current view == original view and the exports would be byte-identical, so a
  // second header over duplicate rows is noise.
  const originalGroup = el(
    "div",
    { hidden: true },
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "This page — Original view" }),
    menuItem("Flattened image", ".png", () => exportViewPng("original")),
    menuItem("Layered image", ".ora", () => exportViewOra("original")),
    menuItem("PDF document", ".pdf", () => exportViewPdf("original")),
  );

  // The raw ".note" download — the one non-transformed option, like the
  // `.spd`/`.txt` viewers' raw row. The shared mechanics navigate to the href
  // (its Content-Disposition names it); the href is minted per open (bin-scoped
  // for a trashed file), and `null` disables the row.
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
      // One read, not two: both rows gate on the same "there is a stack on screen
      // and we are showing a note" condition, which `liveStack` is.
      const stack = liveStack();
      currentOraItem.hidden = stack === null;
      originalGroup.hidden = stack === null || !stack.views.some((v) => v.visible !== v.authoredVisible);
    },
    setRawHref: (url) => rawNoteItem.setHref(url),
  };
}
