// @vitest-environment happy-dom
//
// The PDF viewer's export layer (`pages/pdfExports.ts`), in two halves:
//
//   1. THE COMPOSITION — a PDF page and the `.mark` written on it are in
//      different coordinate spaces (points vs device panel pixels, with the page
//      letterboxed inside the panel), and an export is one rectangle. Tested
//      with FAKE canvases that record every `drawImage`, so the transform is
//      checked at the numbers rather than by looking at a screenshot: the ink
//      must arrive by a PURE TRANSLATION and the document must sit under it.
//
//   2. THE MENU POLICY — which rows exist for the page in front of you. The
//      rules are the `.note` reader's (`readerExports.ts`), and the reason they
//      are asserted here rather than trusted is that a row which should have
//      folded away looks perfectly normal until someone clicks it and gets an
//      ORA with one layer in it.
//
// Real pixels stay in Playwright (`tests/e2e/pdfViewer.spec.ts`): happy-dom has
// no 2D context, so a unit test can prove WHAT is drawn WHERE but not what the
// result looks like.

import { describe, it, expect, vi } from "vitest";
import {
  composeMarkExportModel,
  createPdfExports,
  inkAlpha,
  type PdfExportState,
} from "../../src/pages/pdfExports";
import { flattenLayers, type CanvasFactory, type LayeredExportModel } from "../../src/export/layered";
import { createViewerExportMenu } from "../../src/pages/viewerChrome";
import { markExportSpace } from "../../src/render/markGeometry";
import type { PdfInkOverlay } from "../../src/render/pdfClient";

// --- fakes ------------------------------------------------------------------

/** Everything one recorded canvas saw: its size, its draws, its fills. */
interface Recorded {
  id: string;
  width: number;
  height: number;
  draws: { src: string; args: number[] }[];
  fills: string[];
  /**
   * The COVERAGE this canvas ended up holding, 0..255 — the fake's whole model
   * of a pixel. A real canvas composites; this one keeps the strongest alpha it
   * was ever handed, scaled by the `globalAlpha` in force at the time. That is
   * enough to answer the questions a DOM-less test can ask (which layers reached
   * the sheet, and whether the ALPHA channel is what gets read back out) and
   * makes no claim about what a real composite looks like — that is the e2e's.
   */
  alpha: number;
}

/** A canvas factory whose canvases record instead of rasterising. */
function recorder(): { make: CanvasFactory; made: Recorded[] } {
  const made: Recorded[] = [];
  let n = 0;
  const make: CanvasFactory = (w, h) => {
    const rec: Recorded = { id: `made${n++}`, width: w, height: h, draws: [], fills: [], alpha: 0 };
    made.push(rec);
    const ctx = {
      globalAlpha: 1,
      fillStyle: "",
      fillRect(): void {
        rec.fills.push(String(ctx.fillStyle));
      },
      drawImage(src: { __id?: string; __alpha?: number }, ...args: number[]): void {
        rec.draws.push({ src: src.__id ?? "?", args });
        rec.alpha = Math.max(rec.alpha, Math.round((src.__alpha ?? 0) * ctx.globalAlpha));
      },
      /**
       * RGB ZERO, alpha carried — on purpose. A reader that took the red channel
       * (or a luminance) instead of the alpha would answer 0 for ink that is
       * plainly there, and every "the mask is not empty" assertion would fail
       * loudly rather than quietly agreeing.
       */
      getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray } {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) data[i * 4 + 3] = rec.alpha;
        return { data };
      },
    };
    return {
      __id: rec.id,
      // A recorder canvas can itself be DRAWN INTO another one (the composed ink
      // layers are flattened again to make the mask), so it has to expose what it
      // is holding the same way a source does.
      get __alpha(): number {
        return rec.alpha;
      },
      width: w,
      height: h,
      getContext: () => ctx,
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([1])])),
    } as unknown as HTMLCanvasElement;
  };
  return { make, made };
}

/** A stand-in for one decoded ink layer's own canvas — identity, coverage, `toBlob`. */
function sourceCanvas(id: string, alpha = 255): HTMLCanvasElement {
  return {
    __id: id,
    __alpha: alpha,
    width: 1404,
    height: 1872,
    toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([2])])),
  } as unknown as HTMLCanvasElement;
}

const NOMAD = { width: 1404, height: 1872 };
const A4 = { width: 595.276, height: 841.89 };
/** The real capture's shape: ONE ink layer, MAINLAYER, and no background slot. */
const MAIN = { name: "Main Layer", canvas: sourceCanvas("ink"), visible: true, authoredVisible: true };

// ============================================================================
// 1. The composition
// ============================================================================

describe("composeMarkExportModel", () => {
  it("puts the document UNDER the ink, both at the model's size", () => {
    const { make, made } = recorder();
    const space = markExportSpace(NOMAD, A4);
    const model = composeMarkExportModel({
      space,
      page: { __id: "pdf" } as unknown as CanvasImageSource,
      pageVisible: true,
      ink: [MAIN],
      makeCanvas: make,
    });

    expect(model.width).toBe(1324);
    expect(model.height).toBe(1872);
    // BOTTOM-to-TOP: the page, then the scribbles. The other order composites
    // the document over the handwriting and hides it completely.
    expect(model.layers.map((l) => l.name)).toEqual(["Document", "Main Layer"]);
    for (const rec of made) {
      expect(rec.width).toBe(1324);
      expect(rec.height).toBe(1872);
    }
  });

  it("draws the page to FILL the model, and the ink by a pure translation", () => {
    const { make, made } = recorder();
    const model = composeMarkExportModel({
      space: markExportSpace(NOMAD, A4),
      page: { __id: "pdf" } as unknown as CanvasImageSource,
      pageVisible: true,
      ink: [MAIN],
      makeCanvas: make,
    });
    expect(model.layers).toHaveLength(2);

    // The page carries an explicit destination size: `space.width` is a rounded
    // fit and a rasteriser may round the other way, and a sub-pixel rescale of a
    // vector document beats a one-pixel crop.
    expect(made[0]!.draws).toEqual([{ src: "pdf", args: [0, 0, 1324, 1872] }]);
    // The ink carries an OFFSET AND NOTHING ELSE — no destination size, so no
    // resampling of a stroke the device already committed to pixels. The 40 is
    // A4's dead left margin inside the panel; the panel's own margins fall off
    // the canvas and are clipped.
    expect(made[1]!.draws).toEqual([{ src: "ink", args: [-40, 0] }]);
  });

  it("gives the DOCUMENT an authored state of its own: visible, whatever the panel says", () => {
    const { make } = recorder();
    const model = composeMarkExportModel({
      space: markExportSpace(NOMAD, A4),
      page: null,
      pageVisible: false, // the panel's Document row is off
      ink: [MAIN],
      makeCanvas: make,
    });
    const doc = model.layers[0]!;
    // Nothing in the file says the page was ever meant to be invisible — the
    // document layer is ours. So "original view" always brings the page back,
    // which is the whole difference between the two exports here.
    expect(doc.authored).toEqual({ opacity: 1, visible: true });
    expect(doc.current).toEqual({ opacity: 1, visible: false });
  });

  it("carries each ink layer's live AND authored visibility, at opacity 1", () => {
    const { make } = recorder();
    const model = composeMarkExportModel({
      space: markExportSpace(NOMAD, A4),
      page: null,
      pageVisible: true,
      ink: [
        { name: "Main Layer", canvas: sourceCanvas("a"), visible: false, authoredVisible: true },
        { name: "Layer 1", canvas: sourceCanvas("b"), visible: true, authoredVisible: false },
      ],
      makeCanvas: make,
    });
    expect(model.layers[1]!.current).toEqual({ opacity: 1, visible: false });
    expect(model.layers[1]!.authored).toEqual({ opacity: 1, visible: true });
    expect(model.layers[2]!.current).toEqual({ opacity: 1, visible: true });
    expect(model.layers[2]!.authored).toEqual({ opacity: 1, visible: false });
  });

  it("numbers layers from 0 upward, so no ORA ever holds a `layer_-1.png`", () => {
    // The viewer's panel calls the document row -1 (outside a mark's index
    // range, so the toggle can dispatch on the id alone) and a mark's own ink
    // keeps its wire indices with the background's hole in them. An ORA writes
    // `data/layer_<id>.png` per layer, so neither numbering can be reused as-is.
    const { make } = recorder();
    const model = composeMarkExportModel({
      space: markExportSpace(NOMAD, A4),
      page: null,
      pageVisible: true,
      ink: [MAIN, { ...MAIN, name: "Layer 3", canvas: sourceCanvas("c") }],
      makeCanvas: make,
    });
    expect(model.layers.map((l) => l.id)).toEqual([0, 1, 2]);
  });

  it("survives a page that never rendered, rather than dropping the layer", () => {
    const { make, made } = recorder();
    const model = composeMarkExportModel({
      space: markExportSpace(NOMAD, A4),
      page: null,
      pageVisible: true,
      ink: [MAIN],
      makeCanvas: make,
    });
    // A blank sheet, not a missing one: the ink's layer numbering and the
    // panel's rows still line up.
    expect(model.layers).toHaveLength(2);
    expect(made[0]!.draws).toEqual([]);
  });

  it("needs no letterbox correction when the caller has none to give", () => {
    // The unannotated case: no panel to agree with, so the page IS the export.
    const { make, made } = recorder();
    const model = composeMarkExportModel({
      space: { width: 400, height: 300, dx: 0, dy: 0 },
      page: { __id: "pdf" } as unknown as CanvasImageSource,
      pageVisible: true,
      ink: [],
      makeCanvas: make,
    });
    expect(model).toMatchObject({ width: 400, height: 300 });
    expect(model.layers).toHaveLength(1);
    expect(made[0]!.draws).toEqual([{ src: "pdf", args: [0, 0, 400, 300] }]);
  });

  it("HIDING THE DOCUMENT LEAVES INK ON TRANSPARENCY, with no sheet under it", () => {
    // The point of separating the two rows. `exportFlatPng` fills no background
    // at all, so a flatten of this model touches only the ink — no fillRect, and
    // no draw of the document layer. A white fill here would be invisible on
    // screen and ruin every export made to check an annotation against nothing.
    const { make } = recorder();
    const model = composeMarkExportModel({
      space: markExportSpace(NOMAD, A4),
      page: { __id: "pdf" } as unknown as CanvasImageSource,
      pageVisible: false,
      ink: [MAIN],
      makeCanvas: make,
    });
    const flat = recorder();
    flattenLayers(model, "current", {}, flat.make);
    const sheet = flat.made[0]!;
    expect(sheet.fills).toEqual([]);
    expect(sheet.draws.map((d) => d.src)).toEqual([model.layers[1]!.canvas.__id]);

    // …and the ORIGINAL view of the same model puts the page back under it.
    const orig = recorder();
    flattenLayers(model, "original", {}, orig.make);
    expect(orig.made[0]!.draws.map((d) => d.src)).toEqual([
      model.layers[0]!.canvas.__id,
      model.layers[1]!.canvas.__id,
    ]);
  });
});

// ============================================================================
// 2. The ink mask — what the PDF export sends to the decoder
// ============================================================================

/** A composed model at a size a test can read pixel by pixel. */
function tinyModel(
  ink: { name: string; canvas: HTMLCanvasElement; visible: boolean; authoredVisible: boolean }[],
  pageVisible = true,
): LayeredExportModel {
  return composeMarkExportModel({
    space: { width: 4, height: 3, dx: 0, dy: 0 },
    page: sourceCanvas("pdf"),
    pageVisible,
    ink,
    makeCanvas: recorder().make,
  });
}

describe("inkAlpha", () => {
  it("masks the INK ALONE — the page is not in it, at any strength", () => {
    // The whole difference from the `.png` row. There the page is a layer and is
    // flattened with everything else; here the page is the PAGE — already in the
    // file being grafted — and drawing a raster of it over itself would swap the
    // selectable text this export exists to keep for a picture of it.
    const model = tinyModel([MAIN]);
    const flat = recorder();
    const mask = inkAlpha(model, "current", flat.make);

    expect(flat.made[0]!.draws.map((d) => d.src)).toEqual([model.layers[1]!.canvas.__id]);
    expect(flat.made[0]!.draws.map((d) => d.src)).not.toContain(model.layers[0]!.canvas.__id);
    expect({ width: mask.width, height: mask.height }).toEqual({ width: 4, height: 3 });
    expect([...mask.alpha]).toEqual(Array(12).fill(255));
  });

  it("reads the ALPHA channel, keeping partial coverage rather than rounding it to on/off", () => {
    // A pen stroke's edge is anti-aliased and a highlighter is translucent, so
    // the mask is a coverage ramp and not a stencil. Reading any other channel
    // would answer 0 here — these pixels are transparent BLACK.
    const model = tinyModel([{ ...MAIN, canvas: sourceCanvas("faint", 96) }]);
    const mask = inkAlpha(model, "current", recorder().make);
    expect([...new Set(mask.alpha)]).toEqual([96]);
  });

  it("honours the chosen view's visibility, exactly as the flattened image does", () => {
    // One layer, on now and off as authored — the device-hidden layer someone
    // turned back on. `current` must carry it and `original` must not, which is
    // the only thing that makes two rows worth having.
    const model = tinyModel([{ ...MAIN, visible: true, authoredVisible: false }]);
    expect([...new Set(inkAlpha(model, "current", recorder().make).alpha)]).toEqual([255]);
    expect(inkAlpha(model, "original", recorder().make)).toMatchObject({ width: 1, height: 1 });
  });

  it("answers ONE TRANSPARENT PIXEL for a page with nothing on it, not a page of zeros", () => {
    // The common case: most pages of an annotated document were never written
    // on. A bare A4 page at the N6's resolution is 2.5 MB of zeros to allocate,
    // post across a thread boundary and copy into wasm in order to draw nothing.
    const flat = recorder();
    const mask = inkAlpha(tinyModel([]), "current", flat.make);
    expect(mask).toEqual({ alpha: new Uint8Array(1), width: 1, height: 1 });
    // …and no sheet was made at all, which is the cost this is avoiding.
    expect(flat.made).toEqual([]);
  });
});

// ============================================================================
// 3. The menu
// ============================================================================

/** The menu, its policy, and handles on everything it was given. */
function mount(state: PdfExportState, over: Partial<Parameters<typeof createPdfExports>[0]> = {}) {
  const toast = vi.fn();
  const release = vi.fn();
  const menu = createViewerExportMenu({ toast, className: "viewer__export" });
  document.body.append(menu.el);
  // ONE recorder for the whole mount: the model is composed with it AND the mask
  // is flattened with it, which is what lets the ink drawn into a composed layer
  // reach the mask a click later.
  const { make } = recorder();
  // SMALL, because the PDF row really reads every pixel of the mask: the A4-at-
  // the-ink's-resolution model this used to build is 2.5 million of them, and a
  // menu-policy test has no business allocating 10 MB of ImageData to find out
  // which rows are visible.
  const model: LayeredExportModel = composeMarkExportModel({
    space: { width: 4, height: 3, dx: 0, dy: 0 },
    page: null,
    pageVisible: true,
    ink: [MAIN],
    makeCanvas: make,
  });
  /** Every `{page, ink}` the decoder was asked for. */
  const grafts: { page: number; ink: PdfInkOverlay }[] = [];
  /** Every whole-document export run, by the progress sink it was handed. */
  const documentExports: ((done: number, total: number) => void)[] = [];
  /** Which `model()` options each export asked for — `withPage` is the interesting one. */
  const asked: (Parameters<Parameters<typeof createPdfExports>[0]["model"]>[0] | undefined)[] = [];
  const exports = createPdfExports({
    menu,
    toast,
    docName: () => "Appliance manual.pdf",
    pageIndex: () => 1,
    model: (opts) => {
      asked.push(opts);
      return Promise.resolve({ model, pagePt: A4, release });
    },
    exportPagePdf: (page, ink) => {
      grafts.push({ page, ink });
      return Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    },
    exportDocumentPdf: (onProgress) => {
      documentExports.push(onProgress);
      onProgress(1, 2);
      onProgress(2, 2);
      return Promise.resolve({
        blob: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]),
        pages: 2,
      });
    },
    state: () => state,
    makeCanvas: make,
    ...over,
  });
  exports.refreshGroups();
  const rows = (): HTMLButtonElement[] =>
    Array.from(menu.pop.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const visibleRows = (): string[] =>
    rows()
      .filter((b) => !b.hidden && !(b.parentElement as HTMLElement).hidden)
      .map((b) => b.querySelector("span")!.textContent!);
  const visibleHeads = (): string[] =>
    Array.from(menu.pop.querySelectorAll<HTMLElement>(".menu__head"))
      .filter((h) => !(h.parentElement as HTMLElement).hidden)
      .map((h) => h.textContent!);
  /** A visible row by its label, within the group whose head starts with `head`. */
  const row = (head: string, label: string): HTMLButtonElement =>
    Array.from(menu.pop.querySelectorAll<HTMLElement>(":scope > div"))
      .filter((g) => (g.querySelector(".menu__head")?.textContent ?? "").startsWith(head))
      .flatMap((g) => Array.from(g.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')))
      .find((b) => b.querySelector("span")!.textContent === label)!;
  return { menu, exports, toast, release, rows, row, visibleRows, visibleHeads, grafts, asked, documentExports };
}

/** The page in front of you, in the state most tests want it. */
const PAGE: PdfExportState = {
  hasInk: false,
  tuned: false,
  pageVisible: true,
  // No ink ANYWHERE in the document, which is the state that folds the
  // whole-document annotated row away — it would otherwise emit a copy of the
  // raw file beside it.
  markedPages: 0,
};

describe("the PDF export menu", () => {
  it("offers the page's flattened image, its PDF, and the raw file on a bare page", () => {
    // No ink: the layered ORA has nothing to layer and folds away, and with
    // nothing toggled the ORIGINAL group would be byte-identical to CURRENT.
    //
    // THE PER-PAGE PDF STAYS, which is the row's whole policy question. An ORA of
    // an unannotated page is an archive with one layer in it; a PDF of one is the
    // page LIFTED OUT of the document with its text still selectable, and nothing
    // else in this menu produces that.
    const m = mount({ ...PAGE });
    expect(m.visibleHeads()).toEqual(["This page — Current view", "Whole document"]);
    expect(m.visibleRows()).toEqual(["Flattened image", "PDF document", "PDF document"]);
  });

  it("adds the layered image once the page HAS ink", () => {
    const m = mount({ ...PAGE, hasInk: true });
    expect(m.visibleHeads()).toEqual(["This page — Current view", "Whole document"]);
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "Layered image",
      "PDF document",
      "PDF document",
    ]);
  });

  it("adds the whole ORIGINAL group only once something is toggled", () => {
    const m = mount({ ...PAGE, hasInk: true, tuned: true });
    expect(m.visibleHeads()).toEqual([
      "This page — Current view",
      "This page — Original view",
      "Whole document",
    ]);
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "Layered image",
      "PDF document",
      "Flattened image",
      "Layered image",
      "PDF document",
      "PDF document",
    ]);
  });

  it("re-reads the live state on every refresh, rather than snapshotting it", () => {
    // The menu is built once and the page under it turns; a row decided when the
    // viewer was constructed would describe whatever was open first.
    const st: PdfExportState = { ...PAGE };
    const m = mount(st, { state: () => st });
    expect(m.visibleRows()).not.toContain("Layered image");
    st.hasInk = true;
    st.tuned = true;
    m.exports.refreshGroups();
    expect(m.visibleHeads()).toContain("This page — Original view");
  });

  it("hides the ORIGINAL group's layered row too, when the page has no ink", () => {
    // Reachable: with no ink, hiding the DOCUMENT row is itself a divergence, so
    // the group opens on a page that has nothing to put in an ORA. The reader's
    // original group never faces this — it only ever appears WITH a stack.
    const m = mount({ ...PAGE, tuned: true });
    expect(m.visibleHeads()).toContain("This page — Original view");
    // Both PDF rows stay — an unannotated page is exactly the case where lifting
    // the page out of the document with its text intact is the only thing this
    // menu can usefully do with it.
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "PDF document",
      "Flattened image",
      "PDF document",
      "PDF document",
    ]);
  });

  it("drops the CURRENT-view PDF row when the document itself is turned off", () => {
    // "Show me the ink alone" is a real thing to ask a `.png` for — it answers
    // with transparency, which is what that row is for. The PDF row cannot
    // answer it at all: the page's own content streams are the thing being
    // grafted, so there is no "the page, without the page". The house rule is
    // that a row which cannot mean anything for the page in front of you is
    // hidden rather than disabled.
    //
    // Hiding the document is itself a divergence, so ORIGINAL is open — and its
    // PDF row stays, because the document's authored state is always visible.
    const m = mount({ hasInk: true, tuned: true, pageVisible: false, markedPages: 0 });
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "Layered image",
      "Flattened image",
      "Layered image",
      "PDF document",
      "PDF document",
    ]);
    expect(m.row("This page — Current view", "PDF document").hidden).toBe(true);
    expect(m.row("This page — Original view", "PDF document").hidden).toBe(false);
  });

  it("names an export after the document and the 1-BASED page, and says so", async () => {
    const m = mount({ ...PAGE, hasInk: true });
    // The ORA path is the one a DOM-less environment can run end to end: it
    // reads each layer's own `toBlob` and never needs a 2D context.
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const ora = m.rows().find((b) => b.querySelector("span")!.textContent === "Layered image")!;
    ora.click();
    await vi.waitFor(() => expect(m.toast).toHaveBeenCalled());
    clicks.mockRestore();

    // `pageIndex()` is 1, so the file is p2 — the number the pager shows.
    expect(m.toast).toHaveBeenCalledWith("Saved Appliance manual_p2_current.ora");
    // …and the model's canvases are handed back, not left resident. They are
    // several megabytes each against a 50 MB app-wide budget.
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it("releases the model even when the export itself fails", async () => {
    const release = vi.fn();
    const m = mount(
      { ...PAGE, hasInk: true },
      {
        model: () =>
          Promise.resolve({
            release,
            pagePt: A4,
            model: {
              width: 4,
              height: 4,
              layers: [
                {
                  id: 0,
                  name: "Document",
                  // A canvas whose `toBlob` hands back null — the browser's own
                  // failure mode, which `exportOra` rejects on.
                  canvas: {
                    toBlob: (cb: (b: Blob | null) => void) => cb(null),
                  } as unknown as HTMLCanvasElement,
                  authored: { opacity: 1, visible: true },
                  current: { opacity: 1, visible: true },
                },
              ],
            },
          }),
      },
    );
    const ora = m.rows().find((b) => b.querySelector("span")!.textContent === "Layered image")!;
    ora.click();
    // The shared menu mechanics catch it and say so instead of wedging the row.
    await vi.waitFor(() => expect(m.toast).toHaveBeenCalledWith("Couldn't build that export. Try again."));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("disables the raw row for a file with no address, rather than pointing it at the app", () => {
    const m = mount({ ...PAGE });
    // BY GROUP, not by label. "PDF document" now names three rows — the per-page
    // export in each view group and the untouched bytes here — and a bare label
    // search finds the first, which is a different row doing a different thing.
    const raw = m.row("Whole document", "PDF document");
    m.exports.setRawHref("/file/n-1?v=abc&download=1");
    expect(raw.disabled).toBe(false);
    // `null` is both "this file has no stored bytes" and "no file is open" — the
    // viewer clears it on every release, so the row can never offer the document
    // you just navigated away from.
    m.exports.setRawHref(null);
    expect(raw.disabled).toBe(true);
  });
});

// ============================================================================
// 4. The per-page PDF row, end to end on this side of the wasm
// ============================================================================

/** Click a row and wait for the toast that ends its run. */
async function clickAndSettle(
  m: ReturnType<typeof mount>,
  head: string,
  label: string,
): Promise<void> {
  const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  m.row(head, label).click();
  await vi.waitFor(() => expect(m.toast).toHaveBeenCalled());
  clicks.mockRestore();
}

describe("the per-page PDF export", () => {
  it("sends the DECODER the focused page and the ink mask, placed on the page", async () => {
    const m = mount({ ...PAGE, hasInk: true });
    await clickAndSettle(m, "This page — Current view", "PDF document");

    expect(m.grafts).toHaveLength(1);
    const { page, ink } = m.grafts[0]!;
    // The page the pager is on, 0-based — the decoder grafts by index, so this
    // is the one number that decides WHICH page comes out.
    expect(page).toBe(1);
    // The mask is the model's own rectangle, ink at full coverage.
    expect({ width: ink.width, height: ink.height }).toEqual({ width: 4, height: 3 });
    expect([...new Set(ink.alpha)]).toEqual([255]);
    // …and the matrix maps that rectangle onto A4's points. A pure scale: the
    // model is already the PAGE's rect (the letterbox was taken out when it was
    // composed), so an offset here would move the ink off the page.
    expect(ink.matrix).toEqual([A4.width / 4, 0, 0, A4.height / 3, 0, 0]);
  });

  it("asks for a model with NO PAGE RASTER — the page is grafted, not drawn", async () => {
    // The row does not composite a picture of the page, so rendering one would
    // be a full MuPDF raster (10 MB for A4 at the ink's resolution) built to be
    // thrown away. The `.png` row beside it needs the opposite, and does ask.
    const m = mount({ ...PAGE, hasInk: true });
    await clickAndSettle(m, "This page — Current view", "PDF document");
    expect(m.asked).toEqual([{ withPage: false }]);
  });

  it("names the file like every other per-page export, and says what was lost", async () => {
    const m = mount({ ...PAGE, hasInk: true });
    await clickAndSettle(m, "This page — Current view", "PDF document");

    // The reader's naming helper, not a second scheme: `<stem>_p<n>_<view>.<ext>`
    // with the 1-BASED page the pager shows.
    const said = String(m.toast.mock.calls[0]![0]);
    expect(said).toContain("Saved Appliance manual_p2_current.pdf");
    // TWO THINGS THE USER MUST NOT DISCOVER BY SURPRISE. That it is one page and
    // not the document — the file that lands looks like the one it came from —
    // and that grafting drops `/Annots`, so links and highlights that were in the
    // SOURCE page are gone from this one. A link that has simply stopped working
    // is not a loss anybody traces back to the export that caused it.
    expect(said).toContain("this page only");
    expect(said).toMatch(/links/i);
    expect(said).toMatch(/annotations .* not carried over/i);
  });

  it("exports the ORIGINAL view's ink from the same page, under its own name", async () => {
    // One layer, on now and off as authored. The two rows must differ in the
    // MASK, not merely in the filename — that is the whole reason both exist.
    const { make } = recorder();
    const model = composeMarkExportModel({
      space: { width: 4, height: 3, dx: 0, dy: 0 },
      page: null,
      pageVisible: true,
      ink: [{ ...MAIN, visible: true, authoredVisible: false }],
      makeCanvas: make,
    });
    const m = mount(
      { ...PAGE, hasInk: true, tuned: true },
      { model: () => Promise.resolve({ model, pagePt: A4, release: vi.fn() }) },
    );

    await clickAndSettle(m, "This page — Original view", "PDF document");
    expect(String(m.toast.mock.calls[0]![0])).toContain("Appliance manual_p2_original.pdf");
    // Nothing was visible as authored, so the mask collapses to the one clear
    // pixel — the page, exactly as it came, which is what "original" means here.
    expect(m.grafts[0]!.ink).toMatchObject({ width: 1, height: 1 });
    expect([...m.grafts[0]!.ink.alpha]).toEqual([0]);
  });

  it("frees the model BEFORE the decoder is asked, not after", async () => {
    // The wasm call is the long one — it can suspend on the network mid-graft —
    // and nothing past the mask needs the model. Holding several full-resolution
    // canvases across it would stack the export's two peaks on top of each other.
    const order: string[] = [];
    const m = mount(
      { ...PAGE, hasInk: true },
      {
        model: () =>
          Promise.resolve({
            model: tinyModel([MAIN]),
            pagePt: A4,
            release: () => order.push("release"),
          }),
        exportPagePdf: () => {
          order.push("graft");
          return Promise.resolve(new Uint8Array([1]));
        },
      },
    );
    await clickAndSettle(m, "This page — Current view", "PDF document");
    expect(order).toEqual(["release", "graft"]);
  });

  it("toasts and RE-ENABLES the row when the decoder refuses, rather than wedging it", async () => {
    // The wasm can refuse — a source that is not a PDF, a page it cannot graft —
    // and until the ABI lands it refuses everything. A row left disabled by a
    // failure is a menu item that never works again for the life of the viewer.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const release = vi.fn();
    const m = mount(
      { ...PAGE, hasInk: true },
      {
        model: () => Promise.resolve({ model: tinyModel([MAIN]), pagePt: A4, release }),
        exportPagePdf: () => Promise.reject(new Error("ink_export_page is missing")),
      },
    );
    const row = m.row("This page — Current view", "PDF document");
    row.click();
    await vi.waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith("Couldn't build that export. Try again."),
    );
    expect(row.disabled).toBe(false);
    // The model is handed back on the failing path too — it is released before
    // the decoder is even asked.
    expect(release).toHaveBeenCalledTimes(1);
    // The decoder's own sentence goes to the CONSOLE, not to the page: the toast
    // speaks the app's voice, and without this the reason is lost entirely.
    expect(String(warn.mock.calls[0]?.[1])).toContain("ink_export_page");
    warn.mockRestore();
  });

  it("exports nothing at all when there is no page to export", async () => {
    // `model()` answers null for a document that is not open — a click during the
    // window between `release()` and the next `open()`. Nothing is grafted and
    // nothing is claimed.
    const m = mount({ ...PAGE, hasInk: true }, { model: () => Promise.resolve(null) });
    m.row("This page — Current view", "PDF document").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.grafts).toEqual([]);
    expect(m.toast).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 5. The whole-document row — the one export that loses nothing
// ============================================================================
//
// Its entire reason for existing is what the per-page row above cannot do:
// keep the ORIGINAL's own annotations. On this side of the wasm that claim is
// tested where it is visible — in the copy, which must not read as the per-page
// row at a larger scale, and in the row's own policy.

describe("the whole-document PDF export", () => {
  it("hides the row on a document with no ink anywhere", () => {
    // Zero annotated pages means the export would be a byte-for-byte copy of
    // the raw file in the same group. Hidden, not disabled — the house rule for
    // a row that cannot mean anything.
    const m = mount({ ...PAGE });
    expect(m.visibleRows()).not.toContain("PDF with annotations");
    expect(m.row("Whole document", "PDF with annotations").hidden).toBe(true);
  });

  it("shows it as soon as ANY page of the document is annotated", () => {
    // `markedPages`, not `hasInk`: the focused page may be bare while page 40
    // is covered in handwriting, and this row is about the document.
    const m = mount({ ...PAGE, hasInk: false, markedPages: 3 });
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "PDF document",
      "PDF with annotations",
      "PDF document",
    ]);
  });

  it("re-reads `markedPages` on refresh, so a late `.mark` reveals the row", () => {
    // The mark rides along AFTER the document opens (`pdfViewer.loadMark`), so
    // the menu is built before anyone knows whether there is ink. A row decided
    // once would stay hidden for the life of the document.
    const st: PdfExportState = { ...PAGE };
    const m = mount(st, { state: () => st });
    expect(m.row("Whole document", "PDF with annotations").hidden).toBe(true);
    st.markedPages = 7;
    m.exports.refreshGroups();
    expect(m.row("Whole document", "PDF with annotations").hidden).toBe(false);
  });

  it("names the file after the DOCUMENT, not after a page", async () => {
    const m = mount({ ...PAGE, markedPages: 2 });
    await clickAndSettle(m, "Whole document", "PDF with annotations");
    const said = m.toast.mock.calls.map((c) => String(c[0]));
    expect(said.at(-1)).toContain("Saved Appliance manual_annotated.pdf");
    // Not the per-page scheme: there is no page number, because this is not a
    // page. The stem keeps the original's name so the two sit together on disk.
    expect(said.at(-1)).not.toMatch(/_p\d/);
  });

  it("says the original's annotations are KEPT — the opposite of the per-page row", async () => {
    // THE ASSERTION THAT CARRIES THE FEATURE'S MEANING. Both rows produce a
    // `.pdf` from the same document and a user who has read the per-page toast
    // has been told annotations are lost; if this one said nothing, the sensible
    // reading would be that it loses them too, and the whole reason for the
    // second mechanism would be invisible.
    const m = mount({ ...PAGE, markedPages: 2 });
    await clickAndSettle(m, "Whole document", "PDF with annotations");
    const said = String(m.toast.mock.calls.at(-1)![0]);
    expect(said).toMatch(/preserved/i);
    expect(said).toMatch(/highlights/i);
    // …and it must NOT carry the per-page row's warning, which is the sentence
    // this export exists to stop being true.
    expect(said).not.toMatch(/not carried over/i);
    // It says how much went in, and that it is the whole document.
    expect(said).toContain("whole document");
    expect(said).toContain("2 annotated pages");
  });

  it("counts a single annotated page in the singular", async () => {
    const m = mount(
      { ...PAGE, markedPages: 1 },
      {
        exportDocumentPdf: (onProgress) => {
          onProgress(1, 1);
          return Promise.resolve({ blob: new Blob([new Uint8Array([1])]), pages: 1 });
        },
      },
    );
    await clickAndSettle(m, "Whole document", "PDF with annotations");
    expect(String(m.toast.mock.calls.at(-1)![0])).toContain("1 annotated page.");
  });

  it("reports progress per ANNOTATED page, before the file is saved", async () => {
    // The sparse set, not the document's page count — seven of seventy-seven in
    // the real corpus. And a first toast BEFORE any page number, because on a 3G
    // link fetching the original is the longest step and it happens before there
    // is anything to count.
    const m = mount({ ...PAGE, markedPages: 2 });
    await clickAndSettle(m, "Whole document", "PDF with annotations");
    const said = m.toast.mock.calls.map((c) => String(c[0]));
    expect(said[0]).toBe("Exporting Appliance manual.pdf — fetching the original…");
    expect(said[1]).toBe("Exporting Appliance manual.pdf — page 1 of 2…");
    expect(said[2]).toBe("Exporting Appliance manual.pdf — page 2 of 2…");
    expect(said).toHaveLength(4);
  });

  it("toasts and re-enables the row when the decoder refuses the document", async () => {
    // The refusals are real and specific: a PDF that had to be repaired to open,
    // or one with junk before its `%PDF-` header, cannot take an incremental
    // update at all. Falling back to grafting every page is NOT offered — that
    // is the fidelity loss this row exists to avoid — so a refusal has to leave
    // a working row and an honest message.
    const m = mount(
      { ...PAGE, markedPages: 2 },
      {
        exportDocumentPdf: () =>
          Promise.reject(new Error("this PDF had to be repaired to open")),
      },
    );
    const row = m.row("Whole document", "PDF with annotations");
    row.click();
    await vi.waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith("Couldn't build that export. Try again."),
    );
    expect(row.disabled).toBe(false);
  });

  it("does nothing at all when no document is open", async () => {
    const m = mount({ ...PAGE, markedPages: 2 }, { docName: () => null });
    m.row("Whole document", "PDF with annotations").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.documentExports).toEqual([]);
    expect(m.toast).not.toHaveBeenCalled();
  });
});
