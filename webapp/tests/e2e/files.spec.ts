import { test, expect, type Page } from "@playwright/test";
import { signedIn, mockRawFiles, inkFraction } from "./helpers/app";

// Non-`.note` files. The tree is not all notes — the device syncs PNGs into
// `SCREENSHOT/` and `EXPORT/`, and PDFs into `DOCUMENT/` — and every one of them
// used to open the reader into a BLANK CANVAS: the backend fabricates a
// placeholder page for a blob it cannot parse, and the client could not tell that
// page was fake. `fileType` is now server-verified, so there are three outcomes.
//
// The fixture's cases: `141` is a real note, `151` is a png,
// `142` is a pdf.

const card = (page: Page, name: string) => page.locator(".card", { hasText: name });

test.describe("non-.note files", () => {
  test("an image opens as an <img> off the raw-file endpoint, not the canvas pipeline", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/151");

    const img = page.locator(".filestage__img");
    await expect(img).toBeVisible();

    // The content-addressed raw-file URL — `?v=` is required by the route, which
    // is what lets it answer `immutable`.
    const src = await img.getAttribute("src");
    expect(src).toMatch(/^\/file\/151\?v=[0-9a-f]{32}$/);
    expect(src).not.toContain("download=1"); // the PREVIEW is inline, not a download

    // It really decoded — not merely an element with an attribute.
    await expect.poll(async () => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);

    // And the canvas pipeline is not running: the page stage is gone, and so is
    // every control that only means something over pages.
    await expect(page.locator(".stage")).toBeHidden();
    await expect(page.locator(".page canvas")).toBeHidden();
    // Scoped to the READER: the PDF viewer mounts a `.filmstrip` of its own
    // (same look, `pdf-filmstrip` hook), so a bare selector matches both.
    await expect(page.getByRole("region", { name: "Reader" }).locator(".filmstrip")).toBeHidden();
    await expect(page.locator(".pager__count")).toBeHidden();
    await expect(page.getByRole("button", { name: "Recognized text" })).toBeHidden();

    // The title still names the file, and says what it is instead of "1 page".
    await expect(page.locator(".reader__title")).toContainText("pricing page");
    await expect(page.locator(".reader__title")).toContainText("PNG");
  });

  test("a pdf opens in the PDF viewer now, not the reader's no-preview state", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/142");

    // Its OWN viewer — the reader is not involved. (`mockRawFiles` serves PNG
    // bytes for every raw file, so MuPDF refuses them and the viewer shows its
    // honest failure card; that the routing happens at all is the point here.
    // `pdfViewer.spec.ts` renders real PDF bytes end to end.)
    await expect(page.getByRole("region", { name: "PDF viewer" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    await expect(page.locator(".filestage__empty")).toBeHidden();

    // The download still works, and still does not navigate away from the app.
    // Download is a MENU here now (per-page layered exports over the raw file —
    // `pdfExports.ts`); the raw bytes are its WHOLE DOCUMENT row, and THAT is
    // the thing this test has always been about. The rest of the matrix is
    // `pdfViewer.spec.ts`'s.
    const region = page.getByRole("region", { name: "PDF viewer" });
    await region.getByRole("button", { name: "Download" }).click();
    // BY GROUP, not by label. "PDF document" also names the per-page export rows
    // now (which graft this page into a new one-page document); the untouched
    // bytes are the WHOLE DOCUMENT group's row, and that is what this is about.
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
    // The reader's own fallback, which every unrecognised type still lands on.
    // This used to be the PDF's test; PDFs preview now, so an `.epub` — device
    // readable, no viewer here — keeps the state under test.
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/143");

    // Not a blank canvas: a named state that says what the file is.
    const body = page.locator(".filestage__empty");
    await expect(body).toBeVisible();
    await expect(body).toContainText("EPUB");
    await expect(body).toContainText("Sourdough");
    await expect(body).toContainText("no preview");

    await expect(page.locator(".filestage__img")).toBeHidden();
    await expect(page.locator(".stage")).toBeHidden();
    await expect(page.locator(".pager__count")).toBeHidden();

    // The download link is the versioned URL with the attachment flag.
    const link = body.locator(".filestage__download");
    await expect(link).toBeVisible();
    expect(await link.getAttribute("href")).toMatch(/^\/file\/143\?v=[0-9a-f]{32}&download=1$/);

    // …and it actually downloads, rather than navigating away from the app.
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBeTruthy();
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
  });

  test("a real .note is untouched — the canvas pipeline still paints it", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    await page.goto("/#/note/141");

    await expect(page.locator(".pager__count")).toHaveText("1 / 20");
    await expect(page.locator(".filmstrip__page").first()).toBeVisible();
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
    expect(await thumb.getAttribute("src")).toMatch(/^\/file\/151\?v=[0-9a-f]{32}$/);
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
    // …and the pdf beside it is a THIRD source in the same grid: also an <img>
    // painted from a facade blob, but produced by rendering page 0 through the
    // MuPDF wasm. `mockRawFiles` serves PNG bytes for every raw file, so MuPDF
    // refuses them here and the tile lands on the facade's glyph — which is the
    // point worth pinning: a PDF that will not render still paints, inside the
    // same <img>, rather than leaving an empty tile. (`pdfThumbnail.spec.ts`
    // renders real PDF bytes end to end.)
    const pdfImg = card(page, "Apartment lease").locator(".thumb__img");
    await expect(pdfImg).toHaveCount(1);
    await expect.poll(() => pdfImg.evaluate((e: HTMLImageElement) => e.src.startsWith("blob:"))).toBe(true);
  });
});
