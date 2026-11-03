import { test, expect, type Page } from "@playwright/test";
import { signedIn, mockThumbnailBackend, imgInkFraction, freezeMotion } from "./helpers/app";
import { fakeFileHash } from "../../src/api/fake";

// The `Files` fixture folder holds one file per kind; every tile is an <img> and
// "ink" is the pixel probe run against it.

const card = (page: Page, name: string) => page.locator(".card", { hasText: name });
const INK = 0.004; // comfortably above a blank placeholder, below real content
// The mock cover's black band (~36% ink) is far above anything the fake renderer
// paints, so passing this proves the pixels came from /thumbnail/.
const COVER_INK = 0.15;

// Whether the mock serves this hash a cover (200) or answers 404 like a coverless note.
const NOTE_HASH = fakeFileHash("171");

async function openFiles(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".card--folder", { hasText: "Files" }).click();
  await expect(card(page, "Meeting notes — Q3")).toBeVisible();
  await freezeMotion(page);
}

test.describe("thumbnails across file types", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test("a gallery of mixed types every one shows a real tile, not a blank", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["177"], coverless: [NOTE_HASH] });
    await openFiles(page);

    await expect
      .poll(() => imgInkFraction(card(page, "Meeting notes — Q3").locator("img.thumb__img")), { timeout: 6000 })
      .toBeGreaterThan(INK);

    const img = card(page, "Screenshot — dashboard").locator("img.thumb__img");
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth))
      .toBeGreaterThan(0);

    const spd = card(page, "Kitchen sketch");
    await expect(spd.locator("img.thumb__img")).toBeVisible();
    await expect(spd.locator("canvas")).toHaveCount(0);
    await expect(spd.locator(".thumb--file")).toHaveCount(0);
    await expect.poll(() => imgInkFraction(spd.locator("img.thumb__img")), { timeout: 6000 }).toBeGreaterThan(INK);

    // `mockThumbnailBackend` serves PNG bytes, so MuPDF refuses them and the tile
    // must fall back to the glyph inside the same <img>.
    const pdf = card(page, "Appliance manual");
    await expect(pdf.locator("img.thumb__img")).toBeVisible();
    await expect(pdf.locator(".thumb--file")).toHaveCount(0);
    await expect
      .poll(() => pdf.locator("img.thumb__img").evaluate((e: HTMLImageElement) => e.src.startsWith("blob:")))
      .toBe(true);
  });

  test("a .txt tile renders a snippet of its first lines, not a blank", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["177"], coverless: [NOTE_HASH] });
    await openFiles(page);

    const txt = card(page, "readme");
    await expect(txt.locator("img.thumb__img")).toBeVisible();
    await expect(txt.locator("canvas")).toHaveCount(0);
    await expect(txt.locator(".thumb--file")).toHaveCount(0);
    await expect.poll(() => imgInkFraction(txt.locator("img.thumb__img")), { timeout: 6000 }).toBeGreaterThan(INK);
  });

  test("a .note with a cover prefers it over the client render", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["177"] });
    await openFiles(page);

    const note = card(page, "Meeting notes — Q3");
    await expect(note.locator("img.thumb__img")).toBeVisible();
    await expect(note.locator("canvas")).toHaveCount(0);
    await expect(note.locator(".thumb--file")).toHaveCount(0);
    await expect
      .poll(() => imgInkFraction(note.locator("img.thumb__img")), { timeout: 6000 })
      .toBeGreaterThan(COVER_INK);
  });
});
