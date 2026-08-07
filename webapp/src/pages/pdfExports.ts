/**
 * The PDF viewer's download menu — the groups, and what each row does.
 *
 *   THIS PAGE — CURRENT VIEW · THIS PAGE — ORIGINAL VIEW · WHOLE DOCUMENT
 *
 * The same three-group shape as the `.note` reader's (`pages/readerExports.ts`),
 * for the same reason it is three groups there: a per-page export means nothing
 * without saying WHICH VIEW of the page, and the whole file is a different
 * question from the page in front of you. A reader moving between a `.note` and
 * the PDF beside it meets one menu, not two.
 *
 * What is PDF about this file is the COMPOSITION below: a `.note` page's layers
 * already share one grid, and a PDF page and the `.mark` written on it do not.
 *
 * The transforms are not here — `export/layered.ts` owns the flatten and the ORA
 * writer, `render/markGeometry.ts` the arithmetic, and the wasm the one export
 * that is not an image at all (the per-page `.pdf`, which grafts the source
 * page's own content streams so its text stays selectable).
 *
 * What this owns is which rows exist for the page in front of you, which view
 * each exports, and what the toast afterwards is allowed to claim. Like the
 * reader's, it reads the viewer's state through getters rather than holding any:
 * the focused page and the live layer visibilities change under it on every page
 * turn and every eye-toggle.
 */

import { el } from "../ui/dom";
import { download } from "../export/exporter";
import {
  exportFlatPng,
  exportOra,
  flattenLayers,
  type CanvasFactory,
  type ExportLayer,
  type ExportWhich,
  type LayeredExportModel,
} from "../export/layered";
import { noteLayerExportFilename } from "./noteLayers";
import { markExportMatrix, type ExportSpace, type Size } from "../render/markGeometry";
import type { PdfInkOverlay } from "../render/pdfClient";
import type { ViewerExportMenu } from "./viewerChrome";

// ============================================================================
// The composition — the one thing the `.note` side never has to do.
// ============================================================================

/** One ink layer of a `.mark`, in the DEVICE PANEL's pixels. */
export interface MarkInkLayer {
  /** The layer's display name; it rides into the ORA's `stack.xml`. */
  name: string;
  /** That layer's own pixels, panel-sized, transparent where nothing was drawn. */
  canvas: HTMLCanvasElement;
  /** Live panel visibility — the export's `current` state. */
  visible: boolean;
  /** Device-authored visibility — the export's `original` state. */
  authoredVisible: boolean;
}

const domCanvasFactory: CanvasFactory = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

/**
 * The page's own layer in a composed model, and the one layer that is NOT ink.
 *
 * A named constant because two things now depend on the number: the ORA writes
 * `data/layer_0.png` for it, and {@link inkAlpha} has to leave it out. "Skip
 * `layers[0]`" would work today and break silently the day a layer is inserted
 * below it.
 */
export const DOCUMENT_LAYER_ID = 0;

/**
 * A PDF page and the ink on it, as ONE {@link LayeredExportModel}.
 *
 * TWO LAYERS, in the real case. A `.mark` page carries exactly one ink layer —
 * `MAINLAYER` at a real address with `LAYER1..3` and `BGLAYER` all zero, measured
 * on the capture in `parsers/note/tests/fixtures/` — so the model is the document
 * and the scribbles. N ink layers are still handled, because nothing in the
 * format forbids them and the e2e fixture (a `.note` payload standing in for a
 * mark) has four.
 *
 * THE BACKGROUND SLOT IS NOT A LAYER HERE, and the caller must have dropped it
 * before this is called. On the device that slot holds the paper — ruled
 * stationery, or a raster of the very page being annotated — and over a PDF it is
 * a SECOND OPAQUE SHEET that hides the document completely (the viewer's
 * `suppressBackground` exists for the on-screen half of the same fact). Carrying
 * it as a hidden layer would be worse than dropping it: an ORA opened in Krita
 * shows a hidden layer in the list, and one click would white out the document.
 *
 * The DOCUMENT layer is ours, not the device's: nothing in the file says the page
 * was ever meant to be invisible, so its `authored` state is visible and only its
 * `current` follows the panel's Document row.
 *
 * `page` may be null (nothing rendered) — the document layer is then a blank
 * sheet rather than a missing one, so the layer indices and the panel's rows
 * still line up.
 */
export function composeMarkExportModel(opts: {
  /** Where both halves land — {@link markExportSpace}, or the bare page dims. */
  space: Pick<ExportSpace, "width" | "height" | "dx" | "dy">;
  /** The page, freshly rendered at `space.scale`. Drawn to fill the model. */
  page: CanvasImageSource | null;
  /** The panel's Document row. */
  pageVisible: boolean;
  /** The ink, BOTTOM-to-TOP, background slot already removed. */
  ink: readonly MarkInkLayer[];
  /** Overridable for tests (no GPU, no real canvas). */
  makeCanvas?: CanvasFactory;
}): LayeredExportModel {
  const make = opts.makeCanvas ?? domCanvasFactory;
  const { width, height, dx, dy } = opts.space;

  // IDS ARE RENUMBERED, bottom-to-top from 0, rather than reused from either
  // side. The viewer's panel calls the document `-1` (deliberately outside the
  // range a mark's layer indices occupy, so its toggle can dispatch on the id
  // alone) and an ORA writes one file per layer as `data/layer_<id>.png` — so
  // reusing the panel's ids would put a `layer_-1.png` inside every archive, and
  // reusing the mark's would leave a hole where the background was. The id is
  // only ever a filename and a last-resort name here; both layers carry a real
  // name, so nothing is lost by making it a plain position.
  const layers: ExportLayer[] = [];

  const sheet = make(width, height);
  const sctx = sheet.getContext("2d");
  // Drawn at the model's EXACT dimensions rather than 1:1. `space.width` is the
  // rounded fit and a rasteriser may round the other way; a one-pixel rescale of
  // a vector document is invisible, whereas a one-pixel crop or a transparent
  // hairline at the edge is not.
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
    // A PURE TRANSLATION — no scale argument, and `dx`/`dy` are whole pixels
    // (`markExportSpace`), so every pen stroke keeps the samples the device
    // wrote. The panel's dead margins fall outside the canvas and are clipped,
    // which is the same thing `.pdf-stage` does on screen.
    if (ctx) ctx.drawImage(layer.canvas, dx, dy);
    layers.push({
      id: i + 1,
      name: layer.name,
      canvas: c,
      // Opacity is 1 in BOTH states: the format has no per-layer opacity at all
      // (`.note` is device-confirmed, and a `.mark` is a `.note` container), so
      // the ORA carries `opacity='1.00'` exactly as the reader's does.
      authored: { opacity: 1, visible: layer.authoredVisible },
      current: { opacity: 1, visible: layer.visible },
    });
  }

  return { width, height, layers };
}

/**
 * The visible INK of a composed model, as a coverage mask.
 *
 * The alpha channel and nothing else. The PDF export does not composite pictures
 * — it hands the decoder a mask saying how much ink covers each sample, and the
 * decoder stencils it onto the page's own content streams. Colour would be four
 * times the bytes to say the same thing, and the ink is one colour per stroke
 * already.
 *
 * THE DOCUMENT LAYER IS EXCLUDED, and that is the whole difference from the
 * `.png` row beside it. There the page is a layer and gets flattened with
 * everything else; here the page is the PAGE — it is already in the file the
 * decoder is grafting, and drawing a raster of it over itself would replace the
 * selectable text this export exists to keep with a picture of it.
 *
 * Everything else about which layers count is `flattenLayers`', deliberately: it
 * is the same function, the same `which`, the same per-layer visibility and
 * opacity the `.png` and `.ora` rows honour. A private loop here is how the
 * three rows would drift into disagreeing about what "current view" means.
 *
 * A MODEL WITH NO VISIBLE INK ANSWERS 1x1, not `width * height` of zeros. The
 * empty case is the common one — most pages of an annotated document were never
 * written on — and a bare A4 page at the N6's resolution is 2.5 MB of zeros to
 * allocate, post across a thread boundary and copy into wasm to draw nothing.
 * One transparent pixel stretched over the page is the same result.
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
  // The flatten's sheet is dead the moment its alpha is out: an A4 page at the
  // ink's own resolution is ~10 MB of RGBA, and the `ImageData` above is another
  // 10, and this runs on a phone as readily as a laptop. Zeroing it drops the backing store now
  // rather than at the next GC.
  sheet.width = 0;
  sheet.height = 0;
  return { alpha, width: model.width, height: model.height };
}

// ============================================================================
// The menu
// ============================================================================

/** What the menu needs to know about the focused page to decide its rows. */
export interface PdfExportState {
  /** This page carries decoded ink. The layered `.ora` has nothing to layer without it. */
  hasInk: boolean;
  /** Some layer is shown or hidden differently from how it was authored. */
  tuned: boolean;
  /**
   * The panel's Document row is on.
   *
   * Only the PDF row cares. A `.png` or an `.ora` can honour a hidden document —
   * it simply leaves those pixels transparent, which is what the row is FOR. A
   * PDF export of this page cannot: the page's own content streams are the thing
   * being grafted, and there is no "the page, without the page".
   */
  pageVisible: boolean;
  /**
   * How many pages of the document carry ink — NOT of the focused page.
   *
   * The whole-document row's whole question. Zero means the export would be a
   * byte-for-byte copy of the file the raw row beside it already offers, so the
   * row hides rather than producing a duplicate under a name that promises ink.
   */
  markedPages: number;
}

export interface PdfExports {
  /**
   * Reconcile the per-page groups with the live state. Cheap and idempotent —
   * called on every page turn and every layer toggle.
   */
  refreshGroups(): void;
  /** Point the raw `.pdf` row at `url`; `null` disables it. Minted per open. */
  setRawHref(url: string | null): void;
}

export interface PdfExportsDeps {
  /** The menu shell from `viewerChrome` — this fills its popover. */
  menu: ViewerExportMenu;
  toast(message: string): void;
  /** The open document's name, or null before one is. */
  docName(): string | null;
  /** The focused page, 0-based. */
  pageIndex(): number;
  /**
   * The focused page as a layered model — the document under its ink, composed
   * into one space. Null when there is nothing to export. The caller MUST call
   * `release()`: a model is several full-resolution canvases, tens of megabytes
   * app-wide budget.
   *
   * `withPage: false` SKIPS the page raster and leaves the document layer blank.
   * The PDF row is the only caller that asks for it, because it is the only one
   * that does not want a picture of the page — and rendering one anyway costs a
   * full MuPDF raster (a 10 MB bitmap for A4 at the ink's resolution) to be
   * discarded. `pagePt` and the model's dimensions are unaffected, which is what
   * makes the two paths interchangeable everywhere else.
   */
  model(opts?: {
    withPage?: boolean;
  }): Promise<{ model: LayeredExportModel; pagePt: Size; release: () => void } | null>;
  /**
   * Burn `ink` onto page `page` of the open document and hand back a PDF's bytes.
   * Rejects when the decoder refuses — a page it cannot graft, a session that
   * has gone away.
   */
  exportPagePdf(page: number, ink: PdfInkOverlay): Promise<Uint8Array>;
  /**
   * The WHOLE document with its ink burnt in, as one blob — every page, and
   * every link and highlight the original carried.
   *
   * A different mechanism from `exportPagePdf`, not the same one repeated: this
   * one appends an INCREMENTAL UPDATE to the original file rather than rebuilding
   * it, which is why the original's own annotations survive here and do not
   * there. `onProgress(done, total)` counts ANNOTATED pages — the sparse set,
   * seven of seventy-seven in the real corpus — not pages of the document.
   *
   * `pages` is how many actually went in, which can be fewer than `total` when a
   * mark page will not decode.
   */
  exportDocumentPdf(
    onProgress: (done: number, total: number) => void,
  ): Promise<{ blob: Blob; pages: number }>;
  state(): PdfExportState;
  /**
   * Overridable for tests, the same seam `export/layered.ts` carries and for a
   * sharper reason: the ink mask is the one export here that has to READ pixels
   * back out of a canvas, so a DOM-less environment cannot run this row at all
   * without it (the `.png` and `.ora` rows only ever WRITE, which is why they
   * survive on a bare `toBlob`).
   */
  makeCanvas?: CanvasFactory;
}

export function createPdfExports(deps: PdfExportsDeps): PdfExports {
  const { menu, toast } = deps;

  /**
   * One page, one view, one format. The page index is read BEFORE the model is
   * built and the filename comes from that read: building a model awaits a
   * render, and a page turn during it would otherwise name page N's pixels after
   * page N+1.
   */
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
      // The reader's own naming helper, not a second scheme: `<stem>_p<n>_<view>.<ext>`,
      // through the exporter's one sanitiser, so a `.mark`'s page and a `.note`'s
      // page land on disk under the same convention.
      const filename = noteLayerExportFilename(name, page, which, ext);
      download(filename, blob);
      toast(`Saved ${filename}`);
    } finally {
      snapshot.release();
    }
  }

  /**
   * One page, one view, AS A PDF — the page's own structure with the ink on top.
   *
   * The difference from `save("…", "png")` above is the whole point of the row:
   * that one flattens the page into pixels, this one never rasterises the page at
   * all. The decoder grafts the source page — its text, its fonts, its vectors —
   * into a fresh one-page document and stencils the ink over it, so the export is
   * still a document you can select text in.
   *
   * The MODEL IS RELEASED BEFORE the decoder is asked, not after. Nothing past
   * the alpha needs it, the wasm call is the long one (it can suspend on the
   * network mid-graft), and holding several full-resolution canvases across it
   * would put the export's two peaks on top of each other.
   */
  async function savePdf(which: ExportWhich): Promise<void> {
    const name = deps.docName();
    if (name === null) return;
    // Read BEFORE the model is built, exactly as `save` does: a page turn during
    // the await would otherwise name page N's ink after page N+1 — and here it
    // would also graft the WRONG PAGE, since the index goes to the decoder too.
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
      // THE DECODER'S SENTENCE GOES TO THE CONSOLE, not to the page — the same
      // rule `pdfViewer.ts` states when MuPDF refuses to open a file. The menu's
      // own mechanics catch this and toast in the app's voice; what they cannot
      // do is say WHICH page would not graft, so that is logged here before the
      // error goes back up.
      console.warn("[pdf] page export failed:", (err as Error).message ?? err);
      throw err;
    }
    const filename = noteLayerExportFilename(name, page, which, "pdf");
    download(filename, new Blob([bytes as BlobPart], { type: "application/pdf" }));
    // TWO THINGS THE USER MUST NOT DISCOVER BY SURPRISE, in the honest-reporting
    // tone of the reader's selectable/not-selectable toasts (`savedPdfMessage`).
    //
    // ONE PAGE. The row sits under "This page", but the file that lands on disk
    // is a `.pdf` like the one it came from and nothing about it says it is a
    // single page of a longer document.
    //
    // AND THE ANNOTATIONS ARE GONE. Grafting a page copies its content streams
    // and their resources; it does NOT copy `/Annots`, so links, highlights,
    // comments and form fields that were in the SOURCE page are not in this one.
    // The page still LOOKS the same — most viewers draw a highlight's appearance
    // stream through the annotation, so the colour disappears with it, and a link
    // that has simply stopped working is the kind of loss nobody attributes to
    // the export that caused it.
    toast(
      `Saved ${filename} — this page only, text and vectors intact. ` +
        `Links, highlights and other annotations from the original are not carried over.`,
    );
  }

  /**
   * The whole document, ink and all — and the ONE row in this menu that loses
   * nothing.
   *
   * IT IS NOT THE PER-PAGE ROW AT A LARGER SCALE, and the copy below is written
   * so the two cannot be read that way. The per-page rows GRAFT a page into a
   * fresh document, which silently leaves `/Annots` behind: links, highlights,
   * comments and form fields from the source page do not come with it. This one
   * appends to the original file instead — nothing is re-encoded, so the text,
   * the vectors, the bookmarks, the metadata AND the original's own annotations
   * are all still there. The bigger export is the one that loses less.
   *
   * PROGRESS, BECAUSE THIS IS REAL WORK. Each annotated page is decoded at the
   * device panel's own resolution and handed to the decoder one at a time, and
   * the original has to cross the network first (it is inside the result). The
   * toast says which page, out of how many — the reader's `documentPdf` sets the
   * precedent, and for the same reason: no percentage of TIME, because the
   * per-page cost varies with how much was written on it.
   */
  async function saveDocumentPdf(): Promise<void> {
    const name = deps.docName();
    if (name === null) return;
    // BEFORE the first await. On the link this app is designed for, fetching
    // the original is the longest step and it happens before there is a page
    // number to report — a menu that closes onto nothing for thirty seconds
    // reads as a failure.

    toast(`Exporting ${name} — fetching the original…`);
    const { blob, pages } = await deps.exportDocumentPdf((done, total) =>
      toast(`Exporting ${name} — page ${done} of ${total}…`),
    );
    // The document's own name with a suffix, not the per-page scheme: this IS
    // the document, so `<stem>_annotated.pdf` says the one thing that changed.
    const stem = name.replace(/\.[^.]*$/, "");
    const filename = `${stem}_annotated.pdf`;
    download(filename, blob);
    // THE OPPOSITE CLAIM TO THE PER-PAGE ROW'S, and it is deliberate that both
    // sentences name annotations. That one has to warn that the original's are
    // gone; this one can say they are kept, and a user who has read the first
    // needs to be told plainly that the second is different.
    toast(
      `Saved ${filename} — the whole document, with ${pages} annotated ` +
        `${pages === 1 ? "page" : "pages"}. Text, links and the original's own ` +
        `highlights are all preserved.`,
    );
  }

  // `.menu__head` uppercases in CSS, so the natural-case text here renders as the
  // headers shown.

  // The layered-only ORA rows. Held apart from their groups because they — and
  // they alone — hide on a page with no ink: an ORA of a bare PDF page has
  // nothing to layer, whereas the Flattened image beside it is still the page.
  const currentOra = menu.item("Layered image", ".ora", () => save("current", "ora"));
  const originalOra = menu.item("Layered image", ".ora", () => save("original", "ora"));

  /**
   * The per-page PDF rows — `PDF document`, last in each group, which is where
   * the reader puts its own (`readerExports.ts`) so the two menus read alike.
   *
   * THEY DO NOT HIDE ON A PAGE WITH NO INK, unlike the `.ora` beside them. An ORA
   * of an unannotated page is an archive with one layer in it, which is nothing;
   * a PDF of an unannotated page is THE PAGE — lifted out of a 300-page document,
   * with its text still selectable — and nothing else in this menu can produce
   * that. The Flattened image row makes the same choice for the same reason, and
   * it is the row this one sits beside.
   *
   * The CURRENT one does hide when the Document row is off (`refreshGroups`).
   * That state means "show me the ink alone", and this row cannot answer it: the
   * page's own content streams are what is being grafted. The house rule is that
   * a row which cannot mean anything for the page in front of you is HIDDEN, not
   * disabled (`webapp/ARCHITECTURE.md`) — and the ORIGINAL row is unaffected,
   * because the document's authored state is always visible.
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

  // The WHOLE ORIGINAL group hides unless something has been toggled — the
  // reader's rule (`readerExports.ts:refreshGroups`), for the reader's reason:
  // until then the two views are the same pixels and a second header over
  // duplicate rows is noise.
  const originalGroup = el(
    "div",
    { hidden: true },
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "This page — Original view" }),
    menu.item("Flattened image", ".png", () => save("original", "png")),
    originalOra,
    menu.item("PDF document", ".pdf", () => savePdf("original")),
  );

  // WHOLE DOCUMENT — two rows, and the difference between them is the whole
  // point of the group.
  //
  // The RAW file is unchanged bytes, the one non-transformed option every viewer
  // offers: the shared mechanics navigate to the href (its Content-Disposition
  // names it) and `null` disables the row.
  //
  // ANNOTATED is the same file with the handwriting written into it, built by
  // APPENDING to those very bytes rather than rebuilding the document — so it is
  // the raw row plus the ink and nothing subtracted. It hides on a document with
  // no ink anywhere, where it would produce a byte-for-byte copy of the row
  // above it (`refreshGroups`).
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
      // The one row whose CURRENT view can be unanswerable — see `currentPdf`.
      // A PDF of "this page with the page turned off" is not a thing, so the row
      // goes rather than lying about what it would produce.
      currentPdf.hidden = !st.pageVisible;
      // Nothing written on this document ANYWHERE means this row would emit the
      // raw file under a name promising ink. Hidden, not disabled — the house
      // rule for a row that cannot mean anything (`webapp/ARCHITECTURE.md`).
      annotatedPdf.hidden = st.markedPages === 0;
      // `tuned` covers the DOCUMENT row too, not only the ink: the document is a
      // layer of this model like any other, so hiding it is a divergence from
      // how the page was authored and "original view" is then a real, different
      // export — the page with its ink back on.
      originalGroup.hidden = !st.tuned;
    },
    setRawHref: (url) => rawItem.setHref(url),
  };
}
