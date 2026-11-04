// @vitest-environment happy-dom
// Two halves: the composition (fake canvases record every `drawImage`) and the menu
// policy. Real pixels are in e2e/pdfViewer.spec.ts; happy-dom has no 2D context.

import { describe, it, expect } from "vitest";
import { composeMarkExportModel, inkAlpha } from "../../src/pages/pdf/pdfExports";
import { flattenLayers } from "../../src/export/layered";
import { markExportSpace } from "../../src/render/markGeometry";
import type { PdfInkOverlay } from "../../src/render/pdfClient";

// --- fakes ------------------------------------------------------------------
import { recorder, sourceCanvas, A4, MAIN, tinyModel } from "./pdfExports.shared";

const NOMAD = { width: 1404, height: 1872 };

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
    // Bottom to top: the page, then the ink.
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

    expect(made[0]!.draws).toEqual([{ src: "pdf", args: [0, 0, 1324, 1872] }]);
    // The ink gets an offset only, no destination size, so no resampling. 40 is A4's
    // dead left margin inside the panel.
    expect(made[1]!.draws).toEqual([{ src: "ink", args: [-40, 0] }]);
  });

  it("gives the DOCUMENT an authored state of its own: visible, whatever the panel says", () => {
    const { make } = recorder();
    const model = composeMarkExportModel({
      space: markExportSpace(NOMAD, A4),
      page: null,
      pageVisible: false,
      ink: [MAIN],
      makeCanvas: make,
    });
    const doc = model.layers[0]!;
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
    // The panel calls the document row -1 and mark ink keeps its wire indices; an ORA
    // needs `data/layer_<id>.png`, so neither numbering is reused as-is.
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
    expect(model.layers).toHaveLength(2);
    expect(made[0]!.draws).toEqual([]);
  });

  it("needs no letterbox correction when the caller has none to give", () => {
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
    // `exportFlatPng` fills no background, so this flatten touches only the ink.
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

    const orig = recorder();
    flattenLayers(model, "original", {}, orig.make);
    expect(orig.made[0]!.draws.map((d) => d.src)).toEqual([
      model.layers[0]!.canvas.__id,
      model.layers[1]!.canvas.__id,
    ]);
  });
});

// --- 2. the ink mask sent to the decoder ------------------------------------

describe("inkAlpha", () => {
  it("masks the INK ALONE — the page is not in it, at any strength", () => {
    // The page is not drawn into the mask: it is already in the file being grafted.
    const model = tinyModel([MAIN]);
    const flat = recorder();
    const mask = inkAlpha(model, "current", flat.make);

    expect(flat.made[0]!.draws.map((d) => d.src)).toEqual([model.layers[1]!.canvas.__id]);
    expect(flat.made[0]!.draws.map((d) => d.src)).not.toContain(model.layers[0]!.canvas.__id);
    expect({ width: mask.width, height: mask.height }).toEqual({ width: 4, height: 3 });
    expect([...mask.alpha]).toEqual(Array(12).fill(255));
  });

  it("reads the ALPHA channel, keeping partial coverage rather than rounding it to on/off", () => {
    // Anti-aliased, translucent ink: a coverage ramp of transparent black.
    const model = tinyModel([{ ...MAIN, canvas: sourceCanvas("faint", 96) }]);
    const mask = inkAlpha(model, "current", recorder().make);
    expect([...new Set(mask.alpha)]).toEqual([96]);
  });

  it("honours the chosen view's visibility, exactly as the flattened image does", () => {
    const model = tinyModel([{ ...MAIN, visible: true, authoredVisible: false }]);
    expect([...new Set(inkAlpha(model, "current", recorder().make).alpha)]).toEqual([255]);
    expect(inkAlpha(model, "original", recorder().make)).toMatchObject({ width: 1, height: 1 });
  });

  it("answers ONE TRANSPARENT PIXEL for a page with nothing on it, not a page of zeros", () => {
    // Most pages carry no ink; a bare A4 mask is 2.5 MB of zeros, so none is made.
    const flat = recorder();
    const mask = inkAlpha(tinyModel([]), "current", flat.make);
    expect(mask).toEqual({ alpha: new Uint8Array(1), width: 1, height: 1 });
    expect(flat.made).toEqual([]);
  });
});

// --- 3. the menu -------------------------------------------------------------
