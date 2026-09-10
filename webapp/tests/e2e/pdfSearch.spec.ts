import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";
import { mockDocText, pdfTextRecord, type TextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// FIND-IN-PDF, END TO END, and the only test in the suite where both halves of
// the feature are real at once.
//
// The division of labour survives §6 step 7 intact; what moved is only which
// machine does the first half. The INDEX decides which pages matched and names
// the folded terms it counted; MuPDF is asked where those words sit and the
// viewer marks them. That first half used to be a Zig route over a `kind = 2`
// blob and is now the browser's own FTS5 instance, built from `text/<md5>` —
// the SAME route and the SAME record the reader and the `.txt` viewer fetch,
// because a PDF page is a segment whose ordinal is a page number and nothing
// else about it is special (§1.1).
//
// Every other test stands on one side of that line — `pdfFind.test.ts` proves
// the controller obeys the count it is given, `docSearch.test.ts` proves the
// engine's answer, the wasm ABI test proves `ink_page_words` reports boxes in
// the page's own space. Only here do a real index, a real record, a real MuPDF
// instance and a real page of glyphs have to agree.
//
// WHICH IS WHY THE TWO FIXTURES ARE THE SAME TEXT. The raw file is a REAL
// browser request, served here as a REAL PDF; the text record served alongside
// it carries those same lines. If they ever drift, this fails with the count
// right and the marks missing — which is precisely the failure the honesty rule
// tolerates on a real document and must not tolerate in a fixture.
//
// WHAT THIS FILE NO LONGER ASSERTS, AND WHY IT IS NOT A DELETION
//
// It used to arrive at the viewer by typing "marmalade" into the LIBRARY search
// box and clicking the row, checking on the way past that the row said "Matches
// on 3 pages" and carried no excerpt. The library-wide transcript half cannot
// answer against the fake — see `search.spec.ts`'s header for the two reasons,
// the second of which (`gallerySearch.ts` joins on `String(doc.fileId)`, and
// every fixture id is an opaque string) no mock in this directory can fix. The
// row's own count line is pinned in `tests/unit/resultRow.test.ts`.
//
// So this enters by the URL that row PRODUCES. Same screen, same deep link, and
// everything from the viewer inward is asserted unchanged.

const MANUAL = "178";
const MANUAL_MD5 = fakeFileHash(MANUAL);

const PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/text-four-page.pdf", import.meta.url)),
);

/** The book's text record: four pages, "Marmalade" on 1, 2 and 4 — page 3 (index
 *  2) is the one without it, which is what makes Next skipping a page an
 *  observation rather than a coincidence. */
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

/** The whole backend this file needs: the session, the raw PDF, and the one
 *  search route left. `mockDocText` goes AFTER `signedIn` so it wins over
 *  `mockApi`'s catch-all. */
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

/** The counter, waited for generously: the first find of a session pays the wasm
 *  instantiate (16.13 MB, §8.1) and the index build before it can say a number,
 *  and MuPDF has to raster a page under the same contention. */
async function counts(page: Page, text: string): Promise<void> {
  await expect(viewer(page).locator(".pdfbar__count")).toHaveText(text, { timeout: 20_000 });
}

test.describe("find in PDF", () => {
  test("a `?q=` deep link opens the viewer at that page, primed and marked", async ({ page }) => {
    // A term that lives ONLY in the PDF's pages — not in a note transcript, not
    // in the `.txt`, not in a file name.
    const text = await openManual(page, `/#/note/${MANUAL}?q=marmalade`);

    // The PDF VIEWER, not the reader.
    await expect(viewer(page)).toBeVisible();
    await expect(page.locator(".reader.is-open")).toBeHidden();

    // FIND IS RUNNING. The bar is open and pre-filled — the half of the deep
    // link this viewer used to drop on the floor, with the query arriving as an
    // argument named `_query` and going nowhere.
    const bar = viewer(page).locator(".pdfbar");
    await expect(bar).toBeVisible();
    await expect(bar.locator("input")).toHaveValue("marmalade");

    // The counter is the INDEX's: three pages, one match each.
    await counts(page, "1 of 3");
    // …and it cost exactly one fetch of the document's text (§4.1).
    expect(text.count(MANUAL_MD5)).toBe(1);

    // AND THE MATCH IS MARKED, by a real MuPDF instance that located the word on
    // a real page of glyphs. This is the assertion nothing else in the suite can
    // make: one machine said WHICH page and WHICH folded terms, another said
    // WHERE, and the two agreed.
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
    const text = await openManual(page, `/#/note/${MANUAL}/page/1?q=marmalade`);

    const region = viewer(page);
    const bar = region.locator(".pdfbar");
    await counts(page, "1 of 3");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 4");

    // Page 2 of the fixture carries the second match; page 3 does not.
    await bar.getByRole("button", { name: "Next match" }).click();
    await counts(page, "2 of 3");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 4");
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });

    // …and the third skips the unmatched page entirely, which is what makes this
    // a document-wide find rather than a per-page one. THE SKIP IS THE INDEX'S:
    // page 3's segment is in the record and simply does not match, so nothing
    // here is inferring absence from a page it failed to raster.
    await bar.getByRole("button", { name: "Next match" }).click();
    await counts(page, "3 of 3");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("4 / 4");
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });

    // The URL followed every step of that. `/page/4` is internal index 3: the
    // route counts from one, as `notePageHref` documents.
    expect(page.url()).toContain("/page/4");
    expect(page.url()).toContain("q=marmalade");

    // Three page turns and three marks, off ONE fetch of the document's text.
    expect(text.count(MANUAL_MD5)).toBe(1);
  });

  test("the marks go down with the search, and with the document", async ({ page }) => {
    // A mark left up over the next page — or the next FILE — would point at a
    // word that is not there.
    await openManual(page, `/#/note/${MANUAL}/page/1?q=marmalade`);

    const region = viewer(page);
    await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });

    // Page 3 of the fixture has no match: the page turns and the marks go.
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 4");
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("3 / 4");
    await expect(marks(page)).toHaveCount(0, { timeout: 20_000 });
    // The count is unchanged — the document still has three matches, and the
    // current one is still the first; this page simply is not one of them. THIS
    // IS THE HONESTY RULE ON SCREEN: no boxes is never "No matches".
    await counts(page, "1 of 3");

    // Escape closes find before it leaves the viewer, so a search is not thrown
    // away together with the document it was running in.
    await page.keyboard.press("Escape");
    await expect(region.locator(".pdfbar")).toBeHidden();
    await expect(region).toBeVisible();
    await expect(marks(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
  });

  // THE 404 IS NOT AN EMPTY RESULT, and a PDF is where that matters most: a book
  // whose text has not been derived yet is exactly the document somebody is most
  // likely to search first. `docText.ts` makes the 404 deliberately ambiguous —
  // unreachable, or underived — and both readings mean "we could not look", never
  // "it is not in here". Rendering it as "No matches" would be a confident false
  // statement about a document that plainly contains the word.
  test("a document with no text record says it could not search, not that there is nothing", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    // An EMPTY record map: every `text/<md5>` 404s, exactly as the route answers
    // for a blob the deferred worker has not reached.
    await mockDocText(page, {});
    await page.goto(`/#/note/${MANUAL}?q=marmalade`);
    await freezeMotion(page);

    await expect(viewer(page)).toBeVisible();
    // Asserted POSITIVELY, not as "it did not say No matches": a negative here
    // would pass just as happily against a counter that said nothing at all.
    await counts(page, "Couldn't search this file. Keep typing to retry.");
    await expect(marks(page)).toHaveCount(0);
    // The book itself is still readable — a find that failed does not take the
    // document with it.
    await expect(page.locator(".pdf-page")).toBeVisible();
  });
});
