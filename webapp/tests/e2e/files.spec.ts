import { test, expect, type Page } from "@playwright/test";
import { signedIn, mockRawFiles, inkFraction } from "./helpers/app";

// Non-`.note` files. The tree is not all notes — the device syncs PNGs into
// `SCREENSHOT/` and `EXPORT/`, and PDFs into `DOCUMENT/` — and every one of them
// used to open the reader into a BLANK CANVAS: the backend fabricates a
// placeholder page for a blob it cannot parse, and the client could not tell that
// page was fake. `fileType` is now server-verified, so there are three outcomes.
//
// The fixture's cases: `n-doc-attn` is a real note, `n-shot-pricing` is a png,
// `n-doc-lease` is a pdf.

const card = (page: Page, name: string) => page.locator(".card", { hasText: name });

test.describe("non-.note files", () => {
  test("an image opens as an <img> off the raw-file endpoint, not the canvas pipeline", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/n-shot-pricing");

    const img = page.locator(".filestage__img");
    await expect(img).toBeVisible();

    // The content-addressed raw-file URL — `?v=` is required by the route, which
    // is what lets it answer `immutable`.
    const src = await img.getAttribute("src");
    expect(src).toMatch(/^\/file\/n-shot-pricing\?v=[0-9a-f]{32}$/);
    expect(src).not.toContain("download=1"); // the PREVIEW is inline, not a download

    // It really decoded — not merely an element with an attribute.
    await expect.poll(async () => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);

    // And the canvas pipeline is not running: the page stage is gone, and so is
    // every control that only means something over pages.
    await expect(page.locator(".stage")).toBeHidden();
    await expect(page.locator(".page canvas")).toBeHidden();
    await expect(page.locator(".filmstrip")).toBeHidden();
    await expect(page.locator(".pager__count")).toBeHidden();
    await expect(page.getByRole("button", { name: "Recognized text" })).toBeHidden();

    // The title still names the file, and says what it is instead of "1 page".
    await expect(page.locator(".reader__title")).toContainText("pricing page");
    await expect(page.locator(".reader__title")).toContainText("PNG");
  });

  test("a pdf gets the honest no-preview state with a working download", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/n-doc-lease");

    // Not a blank canvas: a named state that says what the file is.
    const body = page.locator(".filestage__empty");
    await expect(body).toBeVisible();
    await expect(body).toContainText("PDF");
    await expect(body).toContainText("Apartment lease");
    await expect(body).toContainText("no preview");

    await expect(page.locator(".filestage__img")).toBeHidden();
    await expect(page.locator(".stage")).toBeHidden();
    await expect(page.locator(".pager__count")).toBeHidden();

    // The download link is the versioned URL with the attachment flag.
    const link = body.locator(".filestage__download");
    await expect(link).toBeVisible();
    expect(await link.getAttribute("href")).toMatch(/^\/file\/n-doc-lease\?v=[0-9a-f]{32}&download=1$/);

    // …and it actually downloads, rather than navigating away from the app.
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBeTruthy();
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
  });

  test("a real .note is untouched — the canvas pipeline still paints it", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/n-doc-attn");

    await expect(page.locator(".pager__count")).toHaveText("1 / 20");
    await expect(page.locator(".filmstrip")).toBeVisible();
    await expect(page.locator(".filestage")).toBeHidden();

    const viewer = page.locator(".page canvas");
    await expect.poll(async () => inkFraction(viewer), { timeout: 5000 }).toBeGreaterThan(0.01);
  });

  test("an image card uses the image itself as its gallery thumbnail", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/");

    // SCREENSHOT holds PNGs. Their cards used to carry a canvas the renderer had
    // nothing to paint into — a blank sheet with a "png" badge on it.
    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Screenshot$/ }) })
      .click();

    const shot = card(page, "pricing page");
    const thumb = shot.locator(".thumb__img");
    await expect(thumb).toBeVisible();
    expect(await thumb.getAttribute("src")).toMatch(/^\/file\/n-shot-pricing\?v=[0-9a-f]{32}$/);
    await expect.poll(async () => thumb.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
    // No canvas on an image card: registering one would ask the SNPG pipeline for
    // page bytes that do not exist.
    await expect(shot.locator(".thumb canvas")).toHaveCount(0);

    // A real note is ALSO an <img> now — the gallery has no on-screen canvas any
    // more — but painted from the facade's WebP blob (a blob: object URL), NOT the
    // raw-file endpoint. The two paths coexist in one grid, told apart by source.
    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Document$/ }) })
      .click();
    const note = card(page, "Attention Is All You Need");
    const noteImg = note.locator(".thumb__img");
    await expect(noteImg).toHaveCount(1);
    await expect(note.locator(".thumb canvas")).toHaveCount(0);
    // Painted from a blob object URL (the facade render), not `/file/…`.
    await expect
      .poll(() => noteImg.evaluate((e: HTMLImageElement) => e.src.startsWith("blob:")))
      .toBe(true);
    // …and the pdf beside it keeps the blank sheet, deliberately: there is no
    // cheap preview of a PDF, and the badge already says what it is.
    await expect(card(page, "Apartment lease").locator(".thumb__img")).toHaveCount(0);
  });
});
