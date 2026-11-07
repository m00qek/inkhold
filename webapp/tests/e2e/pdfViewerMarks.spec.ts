// The PDF viewer (real MuPDF wasm): pages with and without a .mark.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";

// Drives the real MuPDF wasm in a browser. The raw-file fetch is a real request, so
// routes serve fixture bytes as the server would.
import { PANEL_PDF_BYTES, servePdf, inkFraction, thumbRowInk, band, openStrip } from "./pdfViewer.shared";

test.describe("PDF viewer (real MuPDF wasm)", () => {
  test("a PDF with no .mark claims nothing about any page", async ({ page }) => {
    // A plain PDF has no mark, so the rail stays empty rather than claiming un-annotated.
    await signedIn(page);
    await servePdf(page);
    // 142 has no `.mark`; 178 does.
    await page.goto("/#/note/142");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    const pages = region.getByRole("button", { name: "Pages", exact: true });
    if ((await pages.getAttribute("aria-pressed")) !== "true") await pages.click();
    await expect(region.locator(".filmstrip__page").first()).toBeVisible();
    await expect(region.locator(".filmstrip__page--inked")).toHaveCount(0);
    await expect(region.locator(".filmstrip__page").first()).toHaveAttribute(
      "aria-label",
      "Page 1",
    );
  });

  test("the STRIP carries the mark's handwriting, on the row that was written on", async ({
    page,
  }) => {
    const region = await openStrip(page);
    const thumb = (n: number) => region.locator(".filmstrip__page").nth(n).locator("canvas");

    // Polled: the mark may land after the row's first paint.
    await expect
      .poll(async () => band(await thumbRowInk(thumb(1)), 15, 23), { timeout: 20_000 })
      .toBeGreaterThan(0.9);
    const inked = await thumbRowInk(thumb(1));
    expect(band(inked, 91, 95)).toBeGreaterThan(0.9);
    // The hidden layer's band must stay paper.
    expect(band(inked, 55, 66)).toBeLessThan(0.05);
    expect(band(inked, 33, 42)).toBeGreaterThan(0.2);
    expect(band(inked, 33, 42)).toBeLessThan(0.4);

    const plain = await thumbRowInk(thumb(0));
    expect(band(plain, 15, 23)).toBeLessThan(0.05);
    expect(band(plain, 91, 95)).toBeLessThan(0.05);
    expect(band(plain, 33, 42)).toBeGreaterThan(0.2);
  });

  test("the composited row is a CACHE ENTRY of its own, and survives a late mark", async ({
    page,
  }) => {
    // Keyed by both blobs (`thumbKey`), so an ink-free entry cached before the mark landed is not
    // served forever. A reopen reproduces the late mark: the strip comes from IndexedDB first.
    await openStrip(page);
    await page.goto("/#/");
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(page.locator("#pdf-pages-panel")).toBeVisible(); // chrome state survives

    const thumb = region.locator(".filmstrip__page").nth(1).locator("canvas");
    await expect
      .poll(async () => band(await thumbRowInk(thumb), 15, 23), { timeout: 20_000 })
      .toBeGreaterThan(0.9);

    // `renders` and `inked` are zero: the composite came back from `sn-thumbs` whole.
    const counts = await page.evaluate(
      () =>
        (globalThis as unknown as { __inkholdPdfThumbs?: { renders: number; inked: number } })
          .__inkholdPdfThumbs ?? { renders: -1, inked: -1 },
    );
    expect(counts.renders).toBe(0);
    expect(counts.inked).toBe(0);
  });

  test("leaving the document DROPS the mark's canvases, rather than hiding them", async ({
    page,
  }) => {
    // Hiding a stack frees nothing; only `release()` zeroes the RGBA backing stores (50 MB app
    // budget). Observable as `host.replaceChildren()`.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    await region.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });

    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
    await expect(page.locator(".pdf-mark canvas")).toHaveCount(0);
  });

  test("the annotations panel lists the document under the ink, and toggles both", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });

    await region.getByRole("button", { name: "Annotations" }).click();
    const panel = page.locator("#pdf-layers-panel");
    await expect(panel).toBeVisible();

    await expect(panel.getByText("Document")).toBeVisible();
    // The mark's Background Layer is the device's paper, which the document replaces.
    await expect(panel.getByText("Background Layer")).toHaveCount(0);

    const canvas = page.locator(".pdf-page");
    const row = panel.locator(".layers-panel__row", { hasText: "Document" });
    await row.getByRole("button").click();
    await expect(canvas).toHaveCSS("visibility", "hidden");
    await expect(page.locator(".pdf-mark")).toBeVisible();
    await row.getByRole("button").click();
    await expect(canvas).toHaveCSS("visibility", "visible");
  });

  // Regression: leaving while a thumbnail was still being drawn left the reopened
  // strip as skeletons for good. The old loop, mid-await, turned the new
  // document's paint away as busy, then left on the generation check without
  // looking at the queue; the rows were already on screen, so nothing asked again.
  test("reopening while a thumbnail is still being drawn still paints every thumbnail", async ({ page }) => {
    test.setTimeout(90_000);
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Pages", exact: true }).click();
    // Leave the moment the first one lands, with the rest still in flight.
    await expect(region.locator(".filmstrip__thumb:not(.is-loading)").first()).toBeVisible({ timeout: 20_000 });
    await page.goto("/#/");
    await page.goto("/#/note/178");
    await expect(page.locator("#pdf-pages-panel")).toBeVisible();
    await expect(region.locator(".filmstrip__thumb").first()).toBeVisible({ timeout: 30_000 });
    await expect(region.locator(".filmstrip__thumb.is-loading")).toHaveCount(0, { timeout: 30_000 });
  });

  test("thumbnails come back from the cache on a REOPEN, still drawable", async ({ page }) => {
    // The cache owns its bitmaps (`renderCache.ts`); a viewer closing one leaves a dead entry
    // that only a later read finds. Reopening forces that read.
    // Two opens of the real MuPDF engine: the waits below allow 90s between
    // them, so the test's own limit must too (a busy machine boots it slowly).
    test.setTimeout(90_000);
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(region.locator(".filmstrip__thumb:not(.is-loading)").first()).toBeVisible({
      timeout: 20_000,
    });
    // Every row, not just the first: one still rendering when we leave is
    // honestly rendered again on the reopen, and `renders` below must be 0.
    await expect(region.locator(".filmstrip__thumb.is-loading")).toHaveCount(0, { timeout: 20_000 });

    // Counters reset per open.
    await page.goto("/#/");
    await page.goto("/#/note/178");
    await freezeMotion(page);
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    // The panel's open state is viewer chrome and survives the document change.
    await expect(page.locator("#pdf-pages-panel")).toBeVisible();

    // Polled: the previous visit's rows linger in the DOM for a moment.
    const counts = () =>
      page.evaluate(
        () => (globalThis as unknown as {
          __inkholdPdfThumbs?: { hits: number; renders: number; probe: number };
        }).__inkholdPdfThumbs ?? { hits: 0, renders: 0, probe: 0 },
      );
    // Wait for paint first, so the poll budget covers the cache read, not the cold boot.
    await expect(region.locator(".filmstrip__thumb:not(.is-loading)").first()).toBeVisible({
      timeout: 30_000,
    });
    // One sample: two polls could describe different moments.
    await expect.poll(async () => (await counts()).hits, { timeout: 20_000 }).toBeGreaterThan(0);
    const settled = await counts();
    expect(settled.hits).toBeGreaterThan(0);
    expect(settled.renders).toBe(0); // nothing was rendered twice

    // `probe` is the largest parallel batch; a serial read would report 1.
    expect((await counts()).probe).toBeGreaterThan(1);
    const ink = await region.locator(".filmstrip__thumb canvas").first().evaluate((c) => {
      const cv = c as HTMLCanvasElement;
      if (!cv.width) return -1;
      const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      let marks = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 200) marks++;
      return marks / (d.length / 4);
    });
    expect(ink).toBeGreaterThan(0.002);
  });
});

// ---- download menu ----
// Page 2 is 300 x 150 pt; width binds, so its rect in the 1404 x 1872 panel is
// 1404 x 702 at (0, 585). Only hidden Layer 2 (panel rows 800–1100) falls inside it.
