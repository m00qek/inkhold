import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";
import { mockDocText, pdfTextRecord, type TextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// The index decides which pages matched; MuPDF locates the words. The raw PDF and the
// text record carry the same lines, or the count is right and the marks missing.
// Entered by URL: the library row cannot be produced against the fake (see search.spec.ts).

const MANUAL = "178";
const MANUAL_MD5 = fakeFileHash(MANUAL);

const PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/text-four-page.pdf", import.meta.url)),
);

/** "Marmalade" is on pages 1, 2 and 4; page 3 (index 2) lacks it. */
const TEXT: Record<string, TextRecord> = { [MANUAL_MD5]: pdfTextRecord() };

async function servePdf(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        headers: { "x-content-type-options": "nosniff" },
        body: PDF_BYTES,
      });
    },
  );
}

/** `mockDocText` goes after `signedIn` so it wins over `mockApi`'s catch-all. */
async function openManual(page: Page, route: string): Promise<{ count(md5?: string): number }> {
  await signedIn(page);
  await servePdf(page);
  const text = await mockDocText(page, TEXT);
  await page.goto(route);
  await freezeMotion(page);
  return text;
}

const viewer = (page: Page) => page.getByRole("region", { name: "PDF viewer" });
const marks = (page: Page) => page.locator(".pdf-find-mark");

/** Generous: the first find pays wasm instantiation, the index build, and a MuPDF raster. */
async function counts(page: Page, text: string): Promise<void> {
  await expect(viewer(page).locator(".pdfbar__count")).toHaveText(text, { timeout: 20_000 });
}

test.describe("find in PDF", () => {
  test("a `?q=` deep link opens the viewer at that page, primed and marked", async ({ page }) => {
    const text = await openManual(page, `/#/note/${MANUAL}?q=marmalade`);

    await expect(viewer(page)).toBeVisible();
    await expect(page.locator(".reader.is-open")).toBeHidden();

    const bar = viewer(page).locator(".pdfbar");
    await expect(bar).toBeVisible();
    await expect(bar.locator("input")).toHaveValue("marmalade");

    await counts(page, "1 of 3");
    expect(text.count(MANUAL_MD5)).toBe(1);

    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });
    await expect(marks(page)).toHaveCount(1);
    await expect(marks(page).first()).toHaveClass(/is-current/);

    // A highlight on an off-screen page would still be "visible".
    const onPage = await page.evaluate(() => {
      const c = document.querySelector(".pdf-page") as HTMLCanvasElement;
      const m = document.querySelector(".pdf-find-mark") as HTMLElement;
      const cb = c.getBoundingClientRect();
      const mb = m.getBoundingClientRect();
      return {
        inside:
          mb.left >= cb.left - 1 &&
          mb.top >= cb.top - 1 &&
          mb.right <= cb.right + 1 &&
          mb.bottom <= cb.bottom + 1,
        widthFraction: mb.width / cb.width,
      };
    });
    expect(onPage.inside).toBe(true);
    expect(onPage.widthFraction).toBeGreaterThan(0.05);
    expect(onPage.widthFraction).toBeLessThan(0.9);

    expect(page.url()).toContain("q=marmalade");
  });

  test("Next walks the matches, turning the page and moving the mark with it", async ({ page }) => {
    const text = await openManual(page, `/#/note/${MANUAL}/page/1?q=marmalade`);

    const region = viewer(page);
    const bar = region.locator(".pdfbar");
    await counts(page, "1 of 3");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 4");

    await bar.getByRole("button", { name: "Next match" }).click();
    await counts(page, "2 of 3");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 4");
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });

    // Page 3's segment is in the record and does not match; absence is not inferred from rastering.
    await bar.getByRole("button", { name: "Next match" }).click();
    await counts(page, "3 of 3");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("4 / 4");
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });

    // The route counts pages from one.
    expect(page.url()).toContain("/page/4");
    expect(page.url()).toContain("q=marmalade");

    expect(text.count(MANUAL_MD5)).toBe(1);
  });

  test("the marks go down with the search, and with the document", async ({ page }) => {
    await openManual(page, `/#/note/${MANUAL}/page/1?q=marmalade`);

    const region = viewer(page);
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });

    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 4");
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("3 / 4");
    await expect(marks(page)).toHaveCount(0, { timeout: 20_000 });
    // Honesty rule: no boxes on this page is never "No matches".
    await counts(page, "1 of 3");

    await page.keyboard.press("Escape");
    await expect(region.locator(".pdfbar")).toBeHidden();
    await expect(region).toBeVisible();
    await expect(marks(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
  });

  // A 404 means "could not look" (unreachable or underived), never "not in here".
  test("a document with no text record says it could not search, not that there is nothing", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await mockDocText(page, {});
    await page.goto(`/#/note/${MANUAL}?q=marmalade`);
    await freezeMotion(page);

    await expect(viewer(page)).toBeVisible();
    // Asserted positively; a negative would pass against an empty counter.
    await counts(page, "Couldn't search this file. Keep typing to retry.");
    await expect(marks(page)).toHaveCount(0);
    await expect(page.locator(".pdf-page")).toBeVisible();
  });
});
