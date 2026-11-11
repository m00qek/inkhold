// @vitest-environment happy-dom
// The PDF viewer's docks: each toggle opens and shuts its panel, the left
// dock holds one panel at a time, and what is open is listed left to right.

import { describe, it, expect, vi } from "vitest";
import { createPdfDocks } from "../../src/pages/pdf/pdfChrome";

function panel() {
  const p = { el: document.createElement("div"), open: false, setOpen: (o: boolean) => void (p.open = o) };
  return p;
}

function setup(stageWidth = 4000) {
  const pages = panel(), outline = panel(), digests = panel();
  const layers = { el: document.createElement("div") };
  const toggle = () => document.createElement("button");
  const t = { pages: toggle(), outline: toggle(), digests: toggle(), layers: toggle() };
  const repaint = vi.fn();
  const docks = createPdfDocks({
    pagesPanel: pages, outlinePanel: outline, digestsPanel: digests, layersPanel: layers,
    pagesToggle: t.pages, outlineToggle: t.outline, digestsToggle: t.digests, layersToggle: t.layers,
    stageWidth: () => stageWidth, repaint,
  });
  return { docks, pages, outline, digests, layers, t, repaint };
}

describe("the PDF viewer's docks", () => {
  it("a toggle opens its panel, another left one takes its place, a second click shuts it", () => {
    const { docks, outline, digests, t, repaint } = setup();
    t.outline.click();
    expect(docks.left()).toBe("outline");
    expect(t.outline.getAttribute("aria-pressed")).toBe("true");
    t.digests.click();
    expect(docks.left()).toBe("digests");
    expect([outline.open, digests.open]).toEqual([false, true]);
    expect(t.outline.getAttribute("aria-pressed")).toBe("false");
    t.digests.click();
    expect(docks.left()).toBeNull();
    expect(repaint).toHaveBeenCalledTimes(3);
  });

  it("lists the open panels left to right; the layers toggle opens the right dock beside the left", () => {
    const { docks, pages, layers, t } = setup();
    expect(docks.open()).toEqual([]);
    t.pages.click();
    t.layers.click();
    expect(docks.right()).toBe(true);
    expect(docks.open()).toEqual([pages.el, layers.el]);
    expect(layers.el.hidden).toBe(false);
    t.layers.click();
    expect(docks.open()).toEqual([pages.el]);
  });
});
