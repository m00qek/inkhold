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
  type PdfExportState,
} from "../../src/pages/pdfExports";
import { flattenLayers, type CanvasFactory, type LayeredExportModel } from "../../src/export/layered";
import { createViewerExportMenu } from "../../src/pages/viewerChrome";
import { markExportSpace } from "../../src/render/markGeometry";

// --- fakes ------------------------------------------------------------------

/** Everything one recorded canvas saw: its size, its draws, its fills. */
interface Recorded {
  id: string;
  width: number;
  height: number;
  draws: { src: string; args: number[] }[];
  fills: string[];
}

/** A canvas factory whose canvases record instead of rasterising. */
function recorder(): { make: CanvasFactory; made: Recorded[] } {
  const made: Recorded[] = [];
  let n = 0;
  const make: CanvasFactory = (w, h) => {
    const rec: Recorded = { id: `made${n++}`, width: w, height: h, draws: [], fills: [] };
    made.push(rec);
    const ctx = {
      globalAlpha: 1,
      fillStyle: "",
      fillRect(): void {
        rec.fills.push(String(ctx.fillStyle));
      },
      drawImage(src: { __id?: string }, ...args: number[]): void {
        rec.draws.push({ src: src.__id ?? "?", args });
      },
    };
    return {
      __id: rec.id,
      width: w,
      height: h,
      getContext: () => ctx,
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([1])])),
    } as unknown as HTMLCanvasElement;
  };
  return { make, made };
}

/** A stand-in for one decoded ink layer's own canvas — identity plus `toBlob`. */
function sourceCanvas(id: string): HTMLCanvasElement {
  return {
    __id: id,
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
// 2. The menu
// ============================================================================

/** The menu, its policy, and handles on everything it was given. */
function mount(state: PdfExportState, over: Partial<Parameters<typeof createPdfExports>[0]> = {}) {
  const toast = vi.fn();
  const release = vi.fn();
  const menu = createViewerExportMenu({ toast, className: "viewer__export" });
  document.body.append(menu.el);
  const { make } = recorder();
  const model: LayeredExportModel = composeMarkExportModel({
    space: markExportSpace(NOMAD, A4),
    page: null,
    pageVisible: true,
    ink: [MAIN],
    makeCanvas: make,
  });
  const exports = createPdfExports({
    menu,
    toast,
    docName: () => "Appliance manual.pdf",
    pageIndex: () => 1,
    model: () => Promise.resolve({ model, release }),
    state: () => state,
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
  return { menu, exports, toast, release, rows, visibleRows, visibleHeads };
}

describe("the PDF export menu", () => {
  it("offers the page's flattened image and the raw file, and nothing else, on a bare page", () => {
    // No ink: the layered ORA has nothing to layer and folds away, and with
    // nothing toggled the ORIGINAL group would be byte-identical to CURRENT.
    const m = mount({ hasInk: false, tuned: false });
    expect(m.visibleHeads()).toEqual(["This page — Current view", "Whole document"]);
    expect(m.visibleRows()).toEqual(["Flattened image", "PDF document"]);
  });

  it("adds the layered image once the page HAS ink", () => {
    const m = mount({ hasInk: true, tuned: false });
    expect(m.visibleHeads()).toEqual(["This page — Current view", "Whole document"]);
    expect(m.visibleRows()).toEqual(["Flattened image", "Layered image", "PDF document"]);
  });

  it("adds the whole ORIGINAL group only once something is toggled", () => {
    const m = mount({ hasInk: true, tuned: true });
    expect(m.visibleHeads()).toEqual([
      "This page — Current view",
      "This page — Original view",
      "Whole document",
    ]);
    expect(m.visibleRows()).toEqual([
      "Flattened image",
      "Layered image",
      "Flattened image",
      "Layered image",
      "PDF document",
    ]);
  });

  it("re-reads the live state on every refresh, rather than snapshotting it", () => {
    // The menu is built once and the page under it turns; a row decided when the
    // viewer was constructed would describe whatever was open first.
    const st: PdfExportState = { hasInk: false, tuned: false };
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
    const m = mount({ hasInk: false, tuned: true });
    expect(m.visibleHeads()).toContain("This page — Original view");
    expect(m.visibleRows()).toEqual(["Flattened image", "Flattened image", "PDF document"]);
  });

  it("names an export after the document and the 1-BASED page, and says so", async () => {
    const m = mount({ hasInk: true, tuned: false });
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
      { hasInk: true, tuned: false },
      {
        model: () =>
          Promise.resolve({
            release,
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
    const m = mount({ hasInk: false, tuned: false });
    const raw = m.rows().find((b) => b.querySelector("span")!.textContent === "PDF document")!;
    m.exports.setRawHref("/file/n-1?v=abc&download=1");
    expect(raw.disabled).toBe(false);
    // `null` is both "this file has no stored bytes" and "no file is open" — the
    // viewer clears it on every release, so the row can never offer the document
    // you just navigated away from.
    m.exports.setRawHref(null);
    expect(raw.disabled).toBe(true);
  });
});
