/**
 * The PDF viewer's download menu (this page current view, this page original
 * view, whole document) and the composition of a PDF page with its `.mark` ink,
 * which unlike a `.note`'s layers do not share one grid.
 */
import { el } from "../../ui/dom";
import { download } from "../../export/exporter";
import {
  exportFlatPng,
  exportOra,
  flattenLayers,
  type CanvasFactory,
  type ExportLayer,
  type ExportWhich,
  type LayeredExportModel,
} from "../../export/layered";
import { noteLayerExportFilename } from "../noteLayers";
import { markExportMatrix, type ExportSpace, type Size } from "../../render/markGeometry";
import type { PdfInkOverlay } from "../../render/pdfClient";
import type { ViewerExportMenu } from "../viewer/viewerExportMenu";

// ---- composition ----

/** One `.mark` ink layer, in device-panel pixels. */
export interface MarkInkLayer {
  name: string;
  canvas: HTMLCanvasElement;
  /** Live panel visibility (`current`). */
  visible: boolean;
  /** Device-authored visibility (`original`). */
  authoredVisible: boolean;
}

const domCanvasFactory: CanvasFactory = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

/** The page's own layer id; the ORA writes it as `layer_0.png` and {@link inkAlpha} skips it. */
const DOCUMENT_LAYER_ID = 0;

/**
 * A PDF page and its ink as one layered model. A `.mark` page has one real ink
 * layer (`MAINLAYER`; `LAYER1..3` and `BGLAYER` empty) but N are handled. The
 * caller must already have dropped the background slot: over a PDF it is an
 * opaque sheet, and even hidden in an ORA one click in Krita would white out the
 * document. A null `page` gives a blank document layer so ids still line up.
 */
export function composeMarkExportModel(opts: {
  space: Pick<ExportSpace, "width" | "height" | "dx" | "dy">;
  page: CanvasImageSource | null;
  pageVisible: boolean;
  /** Bottom-to-top, background slot removed. */
  ink: readonly MarkInkLayer[];
  makeCanvas?: CanvasFactory;
}): LayeredExportModel {
  const make = opts.makeCanvas ?? domCanvasFactory;
  const { width, height, dx, dy } = opts.space;

  // Ids are renumbered from 0: the ORA names files `layer_<id>.png`, so the
  // panel's `-1` or the mark's gapped indices would not do.
  const layers: ExportLayer[] = [];

  const sheet = make(width, height);
  const sctx = sheet.getContext("2d");
  // Drawn at the model's exact size: a one-pixel rescale is invisible, a crop is not.
  if (sctx && opts.page) sctx.drawImage(opts.page, 0, 0, width, height);
  layers.push({
    id: 0,
    name: "Document",
    canvas: sheet,
    authored: { opacity: 1, visible: true },
    current: { opacity: 1, visible: opts.pageVisible },
  });

  for (const [i, layer] of opts.ink.entries()) {
    const c = make(width, height);
    const ctx = c.getContext("2d");
    // Pure whole-pixel translation, so strokes keep the device's samples.
    if (ctx) ctx.drawImage(layer.canvas, dx, dy);
    layers.push({
      id: i + 1,
      name: layer.name,
      canvas: c,
      // The format has no per-layer opacity (a `.mark` is a `.note` container).
      authored: { opacity: 1, visible: layer.authoredVisible },
      current: { opacity: 1, visible: layer.visible },
    });
  }

  return { width, height, layers };
}

/**
 * The visible ink as an alpha mask, for the decoder to stencil onto the page's
 * own content streams. The document layer is excluded (drawing a raster over it
 * would replace its selectable text), and which layers count is `flattenLayers`'
 * call so all three rows agree. No visible ink returns 1x1 rather than a page of
 * zeros, since most pages are unannotated.
 */
export function inkAlpha(
  model: LayeredExportModel,
  which: ExportWhich,
  makeCanvas?: CanvasFactory,
): { alpha: Uint8Array; width: number; height: number } {
  const ink = model.layers.filter((l) => l.id !== DOCUMENT_LAYER_ID);
  const shown = ink.filter((l) => (which === "current" ? l.current : l.authored).visible);
  if (shown.length === 0 || model.width <= 0 || model.height <= 0) {
    return { alpha: new Uint8Array(1), width: 1, height: 1 };
  }

  const sheet = flattenLayers(
    { width: model.width, height: model.height, layers: ink },
    which,
    {},
    makeCanvas,
  );
  const ctx = sheet.getContext("2d");
  if (!ctx) throw new Error("could not read the ink's alpha channel");
  const { data } = ctx.getImageData(0, 0, model.width, model.height);
  const alpha = new Uint8Array(model.width * model.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]!;
  // Zero the sheet now to free ~10 MB of backing store before GC.
  sheet.width = 0;
  sheet.height = 0;
  return { alpha, width: model.width, height: model.height };
}

// ---- the menu ----

export interface PdfExportState {
  /** This page carries decoded ink; the `.ora` has nothing to layer without it. */
  hasInk: boolean;
  tuned: boolean;
  /** The Document row is on; only the PDF row cares, as it cannot leave the page transparent. */
  pageVisible: boolean;
  /** Inked pages in the whole document; zero hides the annotated export (it would equal the raw file). */
  markedPages: number;
}

export interface PdfExports {
  refreshGroups(): void;
  /** Point the raw `.pdf` row at `url`; `null` disables it. */
  setRawHref(url: string | null): void;
}

export interface PdfExportsDeps {
  menu: ViewerExportMenu;
  toast(message: string): void;
  docName(): string | null;
  pageIndex(): number;
  /**
   * The focused page as a layered model, or null. The caller must `release()` it
   * (several full-resolution canvases). `withPage: false` skips the page raster
   * for the PDF row, which does not need a picture of the page.
   */
  model(opts?: {
    withPage?: boolean;
  }): Promise<{ model: LayeredExportModel; pagePt: Size; release: () => void } | null>;
  /** Burn `ink` onto one page into a new one-page PDF. */
  exportPagePdf(page: number, ink: PdfInkOverlay): Promise<Uint8Array>;
  /**
   * The whole document with ink burnt in, as an incremental update appended to
   * the original, so its own annotations survive. `onProgress` counts annotated
   * pages; `pages` is how many went in.
   */
  exportDocumentPdf(
    onProgress: (done: number, total: number) => void,
  ): Promise<{ blob: Blob; pages: number }>;
  state(): PdfExportState;
  /** Overridable for tests: the ink mask reads pixels back from a canvas. */
  makeCanvas?: CanvasFactory;
}

export function createPdfExports(deps: PdfExportsDeps): PdfExports {
  const { menu, toast } = deps;

  /** The page index is read before the model awaits a render, so a page turn cannot misname it. */
  async function save(which: ExportWhich, ext: "png" | "ora"): Promise<void> {
    const name = deps.docName();
    if (name === null) return;
    const page = deps.pageIndex();
    const snapshot = await deps.model();
    if (!snapshot) return;
    try {
      const blob =
        ext === "png"
          ? await exportFlatPng(snapshot.model, which)
          : await exportOra(snapshot.model, which);
      const filename = noteLayerExportFilename(name, page, which, ext);
      download(filename, blob);
      toast(`Saved ${filename}`);
    } finally {
      snapshot.release();
    }
  }

  /**
   * One page as a PDF: the decoder grafts the source page (text, fonts, vectors)
   * into a new document and stencils the ink over it. The model is released before
   * the long decoder call so the two memory peaks do not stack.
   */
  async function savePdf(which: ExportWhich): Promise<void> {
    const name = deps.docName();
    if (name === null) return;
    // Read before the await; the index also picks the page to graft.
    const page = deps.pageIndex();
    const snapshot = await deps.model({ withPage: false });
    if (!snapshot) return;
    let ink: PdfInkOverlay;
    try {
      const mask = inkAlpha(snapshot.model, which, deps.makeCanvas);
      ink = {
        ...mask,
        matrix: markExportMatrix({ width: mask.width, height: mask.height }, snapshot.pagePt),
      };
    } finally {
      snapshot.release();
    }

    let bytes: Uint8Array;
    try {
      bytes = await deps.exportPagePdf(page, ink);
    } catch (err) {
      // Decoder messages go to the console, not the page.
      console.warn("[pdf] page export failed:", (err as Error).message ?? err);
      throw err;
    }
    const filename = noteLayerExportFilename(name, page, which, "pdf");
    download(filename, new Blob([bytes as BlobPart], { type: "application/pdf" }));
    // The user must be told it is one page and that grafting drops `/Annots`
    // (links, highlights, form fields).
    toast(
      `Saved ${filename} — this page only, text and vectors intact. ` +
        `Links, highlights and other annotations from the original are not carried over.`,
    );
  }

  /**
   * The whole document, appended to the original so nothing is lost. Progress is
   * by page, never a time percentage.
   */
  async function saveDocumentPdf(): Promise<void> {
    const name = deps.docName();
    if (name === null) return;
    // Before the first await, or a silent closed menu reads as failure.
    toast(`Exporting ${name} — fetching the original…`);
    const { blob, pages } = await deps.exportDocumentPdf((done, total) =>
      toast(`Exporting ${name} — page ${done} of ${total}…`),
    );
    const stem = name.replace(/\.[^.]*$/, "");
    const filename = `${stem}_annotated.pdf`;
    download(filename, blob);
    // The opposite claim to the per-page row's, stated plainly.
    toast(
      `Saved ${filename} — the whole document, with ${pages} annotated ` +
        `${pages === 1 ? "page" : "pages"}. Text, links and the original's own ` +
        `highlights are all preserved.`,
    );
  }

  // Only the ORA rows hide on a page with no ink.
  const currentOra = menu.item("Layered image", ".ora", () => save("current", "ora"));
  const originalOra = menu.item("Layered image", ".ora", () => save("original", "ora"));

  /**
   * The per-page PDF rows do not hide on an unannotated page (it is still the page
   * with selectable text). The current one hides when the Document row is off.
   */
  const currentPdf = menu.item("PDF document", ".pdf", () => savePdf("current"));

  const currentGroup = el(
    "div",
    {},
    el("div", { class: "menu__head", text: "This page — Current view" }),
    menu.item("Flattened image", ".png", () => save("current", "png")),
    currentOra,
    currentPdf,
  );

  // The original group shows only once something has been toggled; until then it duplicates the current one.
  const originalGroup = el(
    "div",
    { hidden: true },
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "This page — Original view" }),
    menu.item("Flattened image", ".png", () => save("original", "png")),
    originalOra,
    menu.item("PDF document", ".pdf", () => savePdf("original")),
  );

  // Whole document: the raw file, and the same bytes with the ink appended.
  const annotatedPdf = menu.item("PDF with annotations", ".pdf", saveDocumentPdf);
  const rawItem = menu.rawItem("PDF document", ".pdf");
  const wholeGroup = el(
    "div",
    {},
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "Whole document" }),
    annotatedPdf,
    rawItem.el,
  );

  menu.pop.append(currentGroup, originalGroup, wholeGroup);

  return {
    refreshGroups(): void {
      const st = deps.state();
      currentOra.hidden = !st.hasInk;
      originalOra.hidden = !st.hasInk;
      // Hidden, not disabled: the house rule for a row meaningless on this page.
      currentPdf.hidden = !st.pageVisible;
      annotatedPdf.hidden = st.markedPages === 0;
      // `tuned` includes the Document row.
      originalGroup.hidden = !st.tuned;
    },
    setRawHref: (url) => rawItem.setHref(url),
  };
}
