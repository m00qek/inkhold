import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";

// FIND-IN-PDF, END TO END, and the only test in the suite where both halves of
// the feature are real at once.
//
// The division of labour is the whole design (`docs/scratch/pdf-in-doc-search.md`
// §1): the SERVER decides which pages matched and names the folded terms it
// counted; the CLIENT asks MuPDF where those words sit and marks them. Every
// other test stands on one side of that line — the Zig suite proves the route
// answers for a `kind = 2` blob, `pdfFind.test.ts` proves the controller obeys
// the count it is given, the wasm ABI test proves `ink_page_words` reports boxes
// in the page's own space. Only here do a real search result, a real route, a
// real MuPDF instance and a real page of glyphs have to agree.
//
// WHICH IS WHY THE TWO FIXTURES ARE THE SAME TEXT. The library runs against the
// in-memory fake `Api`, whose `PDF_CONTENT` stands in for the server's index;
// the raw file is a REAL browser request, served here as a REAL PDF carrying the
// same lines. If they ever drift, this fails with the count right and the marks
// missing — which is precisely the failure the honesty rule tolerates on a real
// document and must not tolerate in a fixture.

const PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/text-four-page.pdf", import.meta.url)),
);

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

const searchBox = (page: Page) => page.getByRole("searchbox", { name: "Search notes" });
const results = (page: Page) => page.locator(".card--result");
const viewer = (page: Page) => page.getByRole("region", { name: "PDF viewer" });
const marks = (page: Page) => page.locator(".pdf-find-mark");

test.describe("find in PDF", () => {
  test("a global hit on a PDF opens the viewer at that page, primed and marked", async ({
    page,
  }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/");
    await freezeMotion(page);

    // A term that lives ONLY in the PDF's pages — not in a note transcript, not
    // in the `.txt`, not in a file name.
    await searchBox(page).fill("marmalade");

    // One result, the manual, with the marked excerpt and a PAGE-unit locator.
    // `kind = 2` collapses to the note's unit downstream, and "Matches on 3
    // pages" is what a PDF should say anyway.
    const row = results(page).filter({ hasText: "Appliance manual" }).first();
    await expect(row).toBeVisible();
    await expect(row.locator(".hit__snippet mark").first()).toHaveText("Marmalade");
    await expect(row.locator(".card__matches")).toHaveText("Matches on 3 pages");

    // Click it → the PDF VIEWER (not the reader) opens.
    await row.locator("button.card__open").click();
    await expect(viewer(page)).toBeVisible();
    await expect(page.locator(".reader.is-open")).toBeHidden();

    // FIND IS RUNNING. The bar is open and pre-filled — the half of the deep
    // link this viewer used to drop on the floor, with the query arriving as an
    // argument named `_query` and going nowhere.
    const bar = viewer(page).locator(".pdfbar");
    await expect(bar).toBeVisible();
    await expect(bar.locator("input")).toHaveValue("marmalade");

    // The counter is the SERVER's: three pages, one match each.
    await expect(bar.locator(".pdfbar__count")).toHaveText("1 of 3", { timeout: 20_000 });

    // AND THE MATCH IS MARKED, by a real MuPDF instance that located the word on
    // a real page of glyphs. This is the assertion nothing else in the suite can
    // make.
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });
    await expect(marks(page)).toHaveCount(1);
    await expect(marks(page).first()).toHaveClass(/is-current/);

    // The mark sits ON the page, inside the canvas's box — a highlight placed
    // against a page that is not on screen would still be "visible" and would be
    // somewhere else entirely.
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
        // A word, not the page: the box has to be a fraction of the sheet.
        widthFraction: mb.width / cb.width,
      };
    });
    expect(onPage.inside).toBe(true);
    expect(onPage.widthFraction).toBeGreaterThan(0.05);
    expect(onPage.widthFraction).toBeLessThan(0.9);

    // The address bar carries the search, so this screen is a place you can send
    // someone — the other half of the deep link, in the other direction.
    expect(page.url()).toContain("q=marmalade");
  });

  test("Next walks the matches, turning the page and moving the mark with it", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual/page/1?q=marmalade");
    await freezeMotion(page);

    const region = viewer(page);
    const bar = region.locator(".pdfbar");
    await expect(bar.locator(".pdfbar__count")).toHaveText("1 of 3", { timeout: 20_000 });
    await expect(region.getByText("1 / 4")).toBeVisible();

    // Page 2 of the fixture carries the second match; page 3 does not.
    await bar.getByRole("button", { name: "Next match" }).click();
    await expect(bar.locator(".pdfbar__count")).toHaveText("2 of 3");
    await expect(region.getByText("2 / 4")).toBeVisible();
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });

    // …and the third skips the unmatched page entirely, which is what makes this
    // a document-wide find rather than a per-page one.
    await bar.getByRole("button", { name: "Next match" }).click();
    await expect(bar.locator(".pdfbar__count")).toHaveText("3 of 3");
    await expect(region.getByText("4 / 4")).toBeVisible();
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });

    // The URL followed every step of that. `/page/4` is internal index 3: the
    // route counts from one, as `notePageHref` documents.
    expect(page.url()).toContain("/page/4");
    expect(page.url()).toContain("q=marmalade");
  });

  test("the marks go down with the search, and with the document", async ({ page }) => {
    // A mark left up over the next page — or the next FILE — would point at a
    // word that is not there.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual/page/1?q=marmalade");
    await freezeMotion(page);

    const region = viewer(page);
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });

    // Page 3 of the fixture has no match: the page turns and the marks go.
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.getByText("2 / 4")).toBeVisible();
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.getByText("3 / 4")).toBeVisible();
    await expect(marks(page)).toHaveCount(0, { timeout: 20_000 });
    // The count is unchanged — the document still has three matches, and the
    // current one is still the first; this page simply is not one of them. THIS
    // IS THE HONESTY RULE ON SCREEN: no boxes is never "No matches".
    await expect(region.locator(".pdfbar__count")).toHaveText("1 of 3");

    // Escape closes find before it leaves the viewer, so a search is not thrown
    // away together with the document it was running in.
    await page.keyboard.press("Escape");
    await expect(region.locator(".pdfbar")).toBeHidden();
    await expect(region).toBeVisible();
    await expect(marks(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
  });
});
