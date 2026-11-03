import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signedIn, mockThumbnailBackend, imgInkFraction, freezeMotion, railSettled } from "./helpers/app";
import { FIXTURE, serveRanges } from "./helpers/pdfRange";

// Page 0 of `two-page.pdf` is 200x100 landscape with a 12% black rectangle, so a 2:1
// tile can only have learnt its shape from the page, and the ink probe has a clear target.

const PDF = readFileSync(FIXTURE);
const PAGE0_ASPECT = 200 / 100;
/** Comfortably above a blank tile, well below the fixture's ~12% of black. */
const INK = 0.02;

const card = (page: Page, name: string) => page.locator(".card", { hasText: name });
const manual = (page: Page) => card(page, "Appliance manual");

/** Registered after `mockThumbnailBackend`: Playwright matches routes newest-first. */
async function openFilesWithPdf(page: Page): Promise<{ count: () => number; bytes: () => number }> {
  await mockThumbnailBackend(page, { textIds: ["177"] });
  const served = await serveRanges(page, PDF, undefined, (url) =>
    url.pathname === "/file/178",
  );
  await page.goto("/");
  await railSettled(page);
  await page.locator(".card--folder", { hasText: "Files" }).click();
  await expect(card(page, "Meeting notes — Q3")).toBeVisible();
  await freezeMotion(page);
  return served;
}

test.describe("a .pdf's gallery tile is its page 0", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test("renders page 0 into the card's <img> — real ink, not a glyph", async ({ page }) => {
    await openFilesWithPdf(page);

    const img = manual(page).locator("img.thumb__img");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.src.startsWith("blob:"))).toBe(true);
    await expect.poll(() => imgInkFraction(img), { timeout: 20_000 }).toBeGreaterThan(INK);
    await expect(manual(page).locator(".thumb--file")).toHaveCount(0);
  });

  test("the tile takes PAGE 0's own aspect, so masonry stops guessing A4", async ({ page }) => {
    await openFilesWithPdf(page);
    const tile = manual(page).locator(".thumb");

    // Opens on the CSS 3:4 fallback and corrects once to the page's 2:1.
    await expect
      .poll(
        async () => {
          const box = await tile.boundingBox();
          return box && box.height > 0 ? box.width / box.height : null;
        },
        { timeout: 20_000, message: "the pdf tile's aspect" },
      )
      .toBeCloseTo(PAGE0_ASPECT, 1);
  });

  // Regression: `applyTileAspect` listened `{ once: true }`, so the interim glyph's `load`
  // pinned 3:4. The latency here forces the glyph past `PLACEHOLDER_AFTER_MS`.
  test("a tile that showed the interim glyph STILL ends at page 0's aspect", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["177"] });
    await serveRanges(page, PDF, { latencyMs: 300, bytesPerSecond: 1e9 }, (url) =>
      url.pathname === "/file/178",
    );
    await page.goto("/");
    await railSettled(page);
    await page.locator(".card--folder", { hasText: "Files" }).click();
    await expect(card(page, "Meeting notes — Q3")).toBeVisible();
    await freezeMotion(page);

    const tile = manual(page).locator(".thumb");

    // Otherwise this asserts nothing about the second `load`.
    await expect
      .poll(
        async () => {
          const box = await tile.boundingBox();
          return box && box.height > 0 ? box.width / box.height : null;
        },
        { timeout: 5_000, message: "the interim glyph's aspect" },
      )
      .toBeLessThan(1.5);

    await expect
      .poll(
        async () => {
          const box = await tile.boundingBox();
          return box && box.height > 0 ? box.width / box.height : null;
        },
        { timeout: 20_000, message: "the pdf tile's settled aspect" },
      )
      .toBeCloseTo(PAGE0_ASPECT, 1);
  });

  test("costs ONE document open, and none at all on the way back", async ({ page }) => {
    // The facade's memo answers later paints, so returning must not re-open the document.
    const served = await openFilesWithPdf(page);
    const img = manual(page).locator("img.thumb__img");
    await expect.poll(() => imgInkFraction(img), { timeout: 20_000 }).toBeGreaterThan(INK);
    const first = served.count();
    // 688 bytes: head and tail windows collapse into one span after block 0.
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(4);

    await page.goBack();
    await expect(page.locator(".card--folder", { hasText: "Files" })).toBeVisible();
    await page.locator(".card--folder", { hasText: "Files" }).click();
    await expect(card(page, "Meeting notes — Q3")).toBeVisible();
    await expect.poll(() => imgInkFraction(manual(page).locator("img.thumb__img")), { timeout: 20_000 })
      .toBeGreaterThan(INK);
    expect(served.count()).toBe(first);
  });

  test("a PDF whose bytes will not open falls back to the glyph, never an empty tile", async ({ page }) => {
    // Not a PDF, so MuPDF refuses it; the tile must still paint the glyph.
    await mockThumbnailBackend(page, { textIds: ["177"] });
    await page.goto("/");
    await railSettled(page);
    await page.locator(".card--folder", { hasText: "Files" }).click();
    await expect(card(page, "Meeting notes — Q3")).toBeVisible();
    await freezeMotion(page);

    const img = manual(page).locator("img.thumb__img");
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.src.startsWith("blob:")), {
      timeout: 20_000,
    }).toBe(true);
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
    await expect
      .poll(() => imgInkFraction(card(page, "readme").locator("img.thumb__img")), { timeout: 20_000 })
      .toBeGreaterThan(0.004);
  });
});
