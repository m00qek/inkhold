// The PDF export menu.

import { test, expect, type Download, type Locator, type Page } from "@playwright/test";
import { asSaved } from "./helpers/download";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { signedIn, freezeMotion } from "./helpers/app";

// Drives the real MuPDF wasm in a browser. The raw-file fetch is a real request, so
// routes serve fixture bytes as the server would.
import { PDF_BYTES, openMarkedPdf } from "./pdfViewer.shared";

/** Disambiguated from the bin cluster's "…" menu by its group headings. */
const pdfMenu = (page: Page) =>
  page.locator(".viewer--pdf .menu__pop", { has: page.locator(".menu__head") });

const pdfGroupItem = (page: Page, head: string, name: string) =>
  pdfMenu(page)
    .locator("> div")
    .filter({ has: page.locator(".menu__head", { hasText: head }) })
    .getByRole("menuitem", { name });

/** Read a completed download into memory. */
async function downloadBytes(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("download produced no file");
  return readFile(path);
}

/** Inflates every `stream…endstream` that inflates; others (the CCITT ink stencil) drop out. */
function inflatedStreams(pdf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = pdf.indexOf("stream"); at >= 0; at = pdf.indexOf("stream", at + 6)) {
    let from = at + 6;
    if (pdf[from] === 0x0d) from++;
    if (pdf[from] === 0x0a) from++;
    const end = pdf.indexOf("endstream", from);
    if (end < 0) continue;
    try {
      out.push(inflateSync(pdf.subarray(from, end)));
    } catch {
      // Not deflated, or not a stream.
    }
  }
  return out;
}

/** Open the Annotations panel and hand back its row locator factory. */
async function annotationsPanel(page: Page, region: Locator) {
  await region.getByRole("button", { name: "Annotations" }).click();
  const panel = page.locator("#pdf-layers-panel");
  await expect(panel).toBeVisible();
  return (name: string) => panel.locator(".layers-panel__row", { hasText: name }).getByRole("button");
}

test.describe("PDF export menu", () => {
  test("a page with no ink offers its flattened image, its own PDF and the raw file", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Download" }).click();

    // The original group is in the DOM but hidden until something is toggled.
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "Whole document",
    ]);
    // The ORA folds away on a bare page; the per-page PDF stays.
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(4);
    await expect(pdfGroupItem(page, "Current view", "Flattened image")).toBeVisible();
    await expect(pdfGroupItem(page, "Current view", "PDF document")).toBeVisible();
    await expect(pdfGroupItem(page, "Whole document", "PDF document")).toBeVisible();
    await expect(pdfGroupItem(page, "Whole document", "PDF with annotations")).toBeVisible();
    await expect(pdfMenu(page).getByRole("menuitem", { name: "Layered image" })).toBeHidden();
  });

  test("the ink adds the layered row, and a toggle adds the whole ORIGINAL group", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, true);
    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "Whole document",
    ]);
    await expect(pdfGroupItem(page, "Current view", "Layered image")).toBeVisible();
    // Nothing toggled, so the original-view header would duplicate rows.
    await expect(pdfMenu(page).locator(".menu__head:visible")).not.toContainText([
      "This page — Original view",
    ]);

    // The panel is behind the menu; a click outside dismisses the menu first.
    const row = await annotationsPanel(page, region);
    await row("Layer 2").click();

    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "This page — Original view",
      "Whole document",
    ]);
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(8);
    await expect(pdfGroupItem(page, "Original view", "PDF document")).toBeVisible();
  });

  test("turning the PAGE off is itself enough to offer the ORIGINAL view", async ({ page }) => {
    // Hiding the Document layer diverges from the authored view, so "original" is real.
    const region = await openMarkedPdf(page, false);
    const row = await annotationsPanel(page, region);
    await row("Document").click();

    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "This page — Original view",
      "Whole document",
    ]);
    await expect(pdfMenu(page).getByRole("menuitem", { name: "Layered image" })).toBeHidden();

    // A PDF of this page cannot omit the page itself, so only the PNG answers "ink alone".
    await expect(pdfGroupItem(page, "Current view", "PDF document")).toBeHidden();
    await expect(pdfGroupItem(page, "Original view", "PDF document")).toBeVisible();
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(5);
  });

  test("the raw PDF still downloads unchanged, from WHOLE DOCUMENT", async ({ page }) => {
    // The raw-file row from the old `<a download>`.
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Whole document", "PDF document").click(),
    ]);
    expect(download.url()).toContain("/file/");
  });

  test("the per-page PDF is the PAGE ITSELF, with the ink drawn over it", async ({ page }) => {
    // The per-page PDF grafts the source page and stencils ink on top, so text and vectors
    // survive; a raster export would pass a weaker test.
    const region = await openMarkedPdf(page, true);
    // Layer 2 is the only band in this page's rect, and it is device-hidden.
    const row = await annotationsPanel(page, region);
    await row("Layer 2").click();

    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "PDF document").click(),
    ]);
    expect(download.suggestedFilename()).toBe(asSaved(download, "Appliance manual_p2_current.pdf"));

    const bytes = await downloadBytes(download);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = bytes.toString("latin1");
    expect(text).toContain("/MediaBox[0 0 300 150]");
    expect(text).toContain("/Count 1");

    const streams = inflatedStreams(bytes);
    const content = streams.find((s) => s.includes("Do"))?.toString("latin1") ?? "";
    // The fixture's vector `10 10 20 20 re f` survives verbatim.
    expect(content).toContain("10 10 20 20 re f");
    // `markExportMatrix`.
    expect(content).toMatch(/300 0 0 150 0 0 cm\s*\/\w+ Do/);
    // The mask stays at the ink's resolution (`markExportSpace`).
    expect(text).toContain("/Width 1404");
    expect(text).toContain("/Height 702");

    // Layer 2 (800–1100) minus the 585 offset covers export rows 215–514.
    const soft = streams.find((s) => s.length === 1404 * 702);
    expect(soft).toBeTruthy();
    let firstRow = -1;
    let lastRow = -1;
    for (let i = 0; i < soft!.length; i++) {
      if (soft![i] === 0) continue;
      const r = Math.floor(i / 1404);
      if (firstRow < 0) firstRow = r;
      lastRow = r;
    }
    expect(firstRow).toBe(215);
    expect(lastRow).toBe(514);
  });

  test("the per-page PDF row always answers, and never wedges itself", async ({ page }) => {
    // Grafting drops `/Annots`, so the toast says so. `menu.item` must re-enable the row in `finally`.
    const region = await openMarkedPdf(page, true);
    await region.getByRole("button", { name: "Download" }).click();
    await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "PDF document").click(),
    ]);

    const toast = page.locator(".toast");
    await expect(toast).toContainText("Saved Appliance manual_p2_current.pdf");
    await expect(toast).toContainText("this page only");
    await expect(toast).toContainText("not carried over");

    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfGroupItem(page, "Current view", "PDF document")).toBeEnabled();
  });

  test("the WHOLE document export appends to the original instead of rebuilding it", async ({
    page,
  }) => {
    // The annotated whole-document export is an incremental update: the original bytes are a
    // verbatim prefix, which is why its `/Annots` survive (asserted in `pdf_decode_abi.mjs`).
    const region = await openMarkedPdf(page, true);
    const row = await annotationsPanel(page, region);
    // Whole-document export burns in the authored view; panel toggles do not apply.
    await row("Layer 2").click();

    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Whole document", "PDF with annotations").click(),
    ]);
    expect(download.suggestedFilename()).toBe(asSaved(download, "Appliance manual_annotated.pdf"));

    const bytes = await downloadBytes(download);
    expect(bytes.length).toBeGreaterThan(PDF_BYTES.length);
    expect(bytes.subarray(0, PDF_BYTES.length).equals(PDF_BYTES)).toBe(true);

    const text = bytes.toString("latin1");
    expect(text).toContain("/Count 2");
    expect(text).toContain("/Width 1404");
    // The appended /Resources names the ink XObject per page, so pages sharing a dictionary
    // do not overwrite each other.
    const delta = bytes.subarray(PDF_BYTES.length).toString("latin1");
    expect(delta).toMatch(/\/InkholdInk\d+ \d+ 0 R/);

    // The opposite copy from the per-page toast: annotations are kept.
    const toast = page.locator(".toast");
    await expect(toast).toContainText("Saved Appliance manual_annotated.pdf");
    await expect(toast).toContainText("whole document");
    await expect(toast).toContainText("preserved");
    await expect(toast).not.toContainText("not carried over");

    // The export mutates the open PDF, so the worker reopens it; else the ink would draw twice.
    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfGroupItem(page, "Whole document", "PDF with annotations")).toBeEnabled();
  });

  test("the flattened PNG is the PAGE's rect at the INK's own resolution", async ({ page }) => {
    const region = await openMarkedPdf(page, true);
    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "Flattened image").click(),
    ]);

    expect(download.suggestedFilename()).toBe(asSaved(download, "Appliance manual_p2_current.png"));

    const bytes = await downloadBytes(download);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
    // 1404 x 702: the page rect inside the panel.
    expect(bytes.readUInt32BE(16)).toBe(1404);
    expect(bytes.readUInt32BE(20)).toBe(702);
  });

  test("a page with no ink still exports, at a resolution near the annotated one", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "Flattened image").click(),
    ]);
    expect(download.suggestedFilename()).toBe(asSaved(download, "Appliance manual_p1_current.png"));
    const bytes = await downloadBytes(download);
    // No panel to agree with, so the export uses a flat 2x (144 dpi).
    expect(bytes.readUInt32BE(16)).toBe(400);
    expect(bytes.readUInt32BE(20)).toBe(200);
  });

  test("the layered ORA holds the document UNDER the ink, and no background sheet", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, true);
    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "Layered image").click(),
    ]);
    expect(download.suggestedFilename()).toBe(asSaved(download, "Appliance manual_p2_current.ora"));

    const bytes = await downloadBytes(download);
    const text = bytes.toString("latin1");
    // Boolean asserts: a failed `toContain` would print hundreds of KB of zip.
    expect(text.startsWith("PK\x03\x04")).toBe(true);
    expect(text.includes("image/openraster")).toBe(true);
    const stack = /<\?xml[\s\S]*?<\/image>/.exec(text)?.[0] ?? "";
    expect(stack).toContain("<image w='1404' h='702'>");

    // OpenRaster stacks are top-first, so the document must come last.
    const names = [...stack.matchAll(/<layer name='([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual(["Layer Renamed", "Layer 2", "Main Layer", "Document"]);
    // The device paper layer must not be in the ORA: it would white out the document.
    expect(stack).not.toContain("Background Layer");
    expect(stack).toContain("name='Layer 2' src='data/layer_2.png' opacity='1.00' visibility='hidden'");
    // Ids are renumbered from the document up, so no `layer_-1.png`.
    expect(stack).toContain("src='data/layer_0.png'");
    expect(stack).not.toContain("layer_-1.png");
    for (const n of [0, 1, 2, 3]) expect(text.includes(`data/layer_${n}.png`)).toBe(true);
  });

  test("HIDING THE DOCUMENT EXPORTS INK ON TRANSPARENCY", async ({ page }) => {
    // `exportFlatPng` fills no background, so hiding the document leaves transparency.
    const region = await openMarkedPdf(page, true);
    const row = await annotationsPanel(page, region);
    await row("Layer 2").click();
    await row("Document").click();
    await expect(page.locator(".pdf-page")).toHaveCSS("visibility", "hidden");

    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "Flattened image").click(),
    ]);
    const bytes = await downloadBytes(download);

    // Decoded in the browser; Node has no PNG decoder here.
    const seen = await page.evaluate(async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d")!.drawImage(bmp, 0, 0);
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let clear = 0;
      let opaque = 0;
      let firstInkRow = -1;
      let lastInkRow = -1;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) {
          clear++;
          continue;
        }
        opaque++;
        const row = Math.floor(i / 4 / bmp.width);
        if (firstInkRow < 0) firstInkRow = row;
        lastInkRow = row;
      }
      return { w: bmp.width, h: bmp.height, clear, opaque, firstInkRow, lastInkRow };
    }, bytes.toString("base64"));

    expect(seen.w).toBe(1404);
    expect(seen.h).toBe(702);
    expect(seen.opaque).toBeGreaterThan(0);
    expect(seen.clear).toBeGreaterThan(seen.opaque);
    // Without the 585-row translation, Main's band would show up at row 200.
    expect(seen.firstInkRow).toBe(215);
    expect(seen.lastInkRow).toBe(514);

    await region.getByRole("button", { name: "Download" }).click();
    const [original] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Original view", "Flattened image").click(),
    ]);
    expect(original.suggestedFilename()).toBe(asSaved(original, "Appliance manual_p2_original.png"));
    const originalSeen = await page.evaluate(async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d")!.drawImage(bmp, 0, 0);
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let clear = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]! === 0) clear++;
      return clear;
    }, (await downloadBytes(original)).toString("base64"));
    expect(originalSeen).toBe(0);
  });
});

// ---- the document's own links ----
// MuPDF `/Annots` must come back as real anchors at the right place; the rects themselves
// are pinned in `pdf_decode_abi.mjs`.
