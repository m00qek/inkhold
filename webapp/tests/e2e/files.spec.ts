import { test, expect, type Page } from "@playwright/test";
import { signedIn, mockRawFiles, inkFraction } from "./helpers/app";

// Fixture: `141` is a note, `151` a png, `142` a pdf.

const card = (page: Page, name: string) => page.locator(".card", { hasText: name });

test.describe("non-.note files", () => {
  test("an image opens as an <img> off the raw-file endpoint, not the canvas pipeline", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/151");

    const img = page.locator(".filestage__img");
    await expect(img).toBeVisible();

    // `?v=` is required by the route; it is what lets it answer `immutable`.
    const src = await img.getAttribute("src");
    expect(src).toMatch(/^\/file\/151\?v=[0-9a-f]{32}$/);
    expect(src).not.toContain("download=1"); // the PREVIEW is inline, not a download

    await expect.poll(async () => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);

    await expect(page.locator(".stage")).toBeHidden();
    await expect(page.locator(".page canvas")).toBeHidden();
    // Scoped to the reader: the PDF viewer mounts a `.filmstrip` of its own.
    await expect(page.getByRole("region", { name: "Reader" }).locator(".filmstrip")).toBeHidden();
    await expect(page.locator(".pager__count")).toBeHidden();
    await expect(page.getByRole("button", { name: "Recognized text" })).toBeHidden();

    await expect(page.locator(".reader__title")).toContainText("pricing page");
    await expect(page.locator(".reader__title")).toContainText(".png");
  });

  test("a pdf opens in the PDF viewer now, not the reader's no-preview state", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/142");

    // `mockRawFiles` serves PNG bytes, so MuPDF refuses them; only the routing is under test.
    await expect(page.getByRole("region", { name: "PDF viewer" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    await expect(page.locator(".filestage__empty")).toBeHidden();

    const region = page.getByRole("region", { name: "PDF viewer" });
    await region.getByRole("button", { name: "Download" }).click();
    // By group: "PDF document" also names the per-page export rows.
    const raw = region
      .locator(".menu__pop > div")
      .filter({ has: page.locator(".menu__head", { hasText: "Whole document" }) })
      .getByRole("menuitem", { name: "PDF document" });
    await expect(raw).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), raw.click()]);
    expect(download.url()).toMatch(/\/file\/142\?v=[0-9a-f]{32}&download=1$/);
    expect(download.suggestedFilename()).toBeTruthy();
    await expect(region).toBeVisible();
  });

  test("a type with no viewer gets the honest no-preview state with a working download", async ({ page }) => {
    // An `.epub` has no viewer, so it lands on the reader's fallback.
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/143");

    const body = page.locator(".filestage__empty");
    await expect(body).toBeVisible();
    await expect(body).toContainText("EPUB");
    await expect(body).toContainText("Sourdough");
    await expect(body).toContainText("no preview");

    await expect(page.locator(".filestage__img")).toBeHidden();
    await expect(page.locator(".stage")).toBeHidden();
    await expect(page.locator(".pager__count")).toBeHidden();

    const link = body.locator(".filestage__download");
    await expect(link).toBeVisible();
    expect(await link.getAttribute("href")).toMatch(/^\/file\/143\?v=[0-9a-f]{32}&download=1$/);

    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBeTruthy();
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
  });

  test("a real .note is untouched — the canvas pipeline still paints it", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/141");

    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
    await expect(page.locator(".filmstrip__page").first()).toBeVisible();
    await expect(page.locator(".filestage")).toBeHidden();

    const viewer = page.locator(".page canvas");
    await expect.poll(async () => inkFraction(viewer), { timeout: 5000 }).toBeGreaterThan(0.01);
  });

  test("an image card uses the image itself as its gallery thumbnail", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/");

    await page
      .getByRole("navigation", { name: "Library" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Screenshot$/ }) })
      .click();

    const shot = card(page, "pricing page");
    const thumb = shot.locator(".thumb__img");
    await expect(thumb).toBeVisible();
    // Retrying: the card can paint a beat before its image is pointed at the file.
    await expect(thumb).toHaveAttribute("src", /^\/file\/151\?v=[0-9a-f]{32}$/);
    await expect.poll(async () => thumb.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
    // Registering a canvas would ask the SNPG pipeline for pages that do not exist.
    await expect(shot.locator(".thumb canvas")).toHaveCount(0);

    await page
      .getByRole("navigation", { name: "Library" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Document$/ }) })
      .click();
    const note = card(page, "Attention Is All You Need");
    const noteImg = note.locator(".thumb__img");
    await expect(noteImg).toHaveCount(1);
    await expect(note.locator(".thumb canvas")).toHaveCount(0);
    await expect
      .poll(() => noteImg.evaluate((e: HTMLImageElement) => e.src.startsWith("blob:")))
      .toBe(true);
    // `mockRawFiles` serves PNG bytes, so the pdf tile must fall back to the glyph.
    const pdfImg = card(page, "Apartment lease").locator(".thumb__img");
    await expect(pdfImg).toHaveCount(1);
    await expect.poll(() => pdfImg.evaluate((e: HTMLImageElement) => e.src.startsWith("blob:"))).toBe(true);
  });
});
