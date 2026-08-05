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
 * writer, `render/markGeometry.ts` the arithmetic. What this owns is which rows
 * exist for the page in front of you, which view each exports, and what the toast
 * afterwards is allowed to claim. Like the reader's, it reads the viewer's state
 * through getters rather than holding any: the focused page and the live layer
 * visibilities change under it on every page turn and every eye-toggle.
 */

import { el } from "../ui/dom";
import { download } from "../export/exporter";
import {
  exportFlatPng,
  exportOra,
  type CanvasFactory,
  type ExportLayer,
  type ExportWhich,
  type LayeredExportModel,
} from "../export/layered";
import { noteLayerExportFilename } from "./noteLayers";
import type { ExportSpace } from "../render/markGeometry";
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

// ============================================================================
// The menu
// ============================================================================

/** What the menu needs to know about the focused page to decide its rows. */
export interface PdfExportState {
  /** This page carries decoded ink. The layered `.ora` has nothing to layer without it. */
  hasInk: boolean;
  /** Some layer is shown or hidden differently from how it was authored. */
  tuned: boolean;
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
   * `release()`: a model is several full-resolution canvases against a 50 MB
   * app-wide budget.
   */
  model(): Promise<{ model: LayeredExportModel; release: () => void } | null>;
  state(): PdfExportState;
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

  // `.menu__head` uppercases in CSS, so the natural-case text here renders as the
  // headers shown.

  // The layered-only ORA rows. Held apart from their groups because they — and
  // they alone — hide on a page with no ink: an ORA of a bare PDF page has
  // nothing to layer, whereas the Flattened image beside it is still the page.
  const currentOra = menu.item("Layered image", ".ora", () => save("current", "ora"));
  const originalOra = menu.item("Layered image", ".ora", () => save("original", "ora"));

  const currentGroup = el(
    "div",
    {},
    el("div", { class: "menu__head", text: "This page — Current view" }),
    menu.item("Flattened image", ".png", () => save("current", "png")),
    currentOra,
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
  );

  // WHOLE DOCUMENT holds exactly one row today: the raw file, unchanged bytes,
  // the one non-transformed option every viewer offers. The shared mechanics
  // navigate to the href (its Content-Disposition names it) and `null` disables
  // the row.
  //
  // NO RENDERED PDF EXPORT — the "whole document, with the ink burnt in" row that
  // would obviously belong beside this. That is not an oversight and not a small
  // job: the reader's PDF path rasterises every page, which for a 77-page
  // annotated document means 77 MuPDF renders and a file many times the original,
  // while the right answer is almost certainly to keep the PDF's own content
  // streams and add the ink as an annotation or an overlay — a different writer
  // from `export/pdf.ts`. The group exists so that row has somewhere to land.
  const rawItem = menu.rawItem("PDF document", ".pdf");
  const wholeGroup = el(
    "div",
    {},
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "Whole document" }),
    rawItem.el,
  );

  menu.pop.append(currentGroup, originalGroup, wholeGroup);

  return {
    refreshGroups(): void {
      const st = deps.state();
      currentOra.hidden = !st.hasInk;
      originalOra.hidden = !st.hasInk;
      // `tuned` covers the DOCUMENT row too, not only the ink: the document is a
      // layer of this model like any other, so hiding it is a divergence from
      // how the page was authored and "original view" is then a real, different
      // export — the page with its ink back on.
      originalGroup.hidden = !st.tuned;
    },
    setRawHref: (url) => rawItem.setHref(url),
  };
}
