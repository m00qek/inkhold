import { test, expect, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";
import { mockDocText, txtTextRecord, TXT_BODY, type TextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// `.txt` CONTENT SEARCH, end to end: the `.txt` viewer opened on a term that
// lives ONLY in the `.txt` fixture, scrolled to the matching paragraph with find
// running — matches highlighted, prev/next jumping between paragraphs, an exact
// count.
//
// WHERE THE ANSWER COMES FROM
//
// `/note/:id/txt-search` is gone, and with it the last of the three response
// shapes in-document search used to have. The viewer fetches `text/<md5>` — the
// SAME route and the SAME record the reader and the PDF viewer fetch — and asks
// the browser's own FTS5 index. A `.txt` differs from a `.note` in exactly one
// field: its segments carry a byte range (`o`/`l`), because the ordinal is a
// paragraph index and the ADDRESS is a range in the raw blob.
//
// THE TWO FIXTURES ARE ONE STRING, and that is what this file rests on. The raw
// file is a REAL browser request the viewer makes itself; the text record is
// what the index is built from and what carries the byte ranges
// `txtFind.ts`'s `byteToCharMap` converts to UTF-16 offsets. Both come from
// `TXT_BODY`, and `txtTextRecord` computes the ranges with the same chunker the
// server's `txt_index.zig` implements, rather than having them typed out — a
// hand-written offset one byte out marks the wrong word and no assertion can say
// which digit to change.
//
// WHAT THIS FILE NO LONGER ASSERTS, AND WHY IT IS NOT A DELETION
//
// It used to reach the viewer by typing "zephyrine" into the LIBRARY search box
// and clicking the row, asserting on the way past that the row said "Matches in
// 2 paragraphs" and carried no excerpt. The library-wide transcript half cannot
// answer here: since §6 step 6 it is the browser's index, the fake ships no
// search-index fixture, and — the harder half — `gallerySearch.ts` joins an
// index hit to a card by `String(doc.fileId)` while every fixture id is an
// opaque string, so no manifest row could name this file whatever bytes a mock
// served. `search.spec.ts`'s header states that in full. The row's own contract
// is pinned in `tests/unit/resultRow.test.ts` against the real card factory.
//
// So this enters by the URL that row PRODUCES, which is the same screen reached
// the same way, and everything from the viewer inward is asserted unchanged.

const README = "177";
const README_MD5 = fakeFileHash(README);

/** The `.txt`'s text record: four paragraphs, two of them carrying "zephyrine". */
const TEXT: Record<string, TextRecord> = { [README_MD5]: txtTextRecord() };

async function mockTextFile(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      const download = route.request().url().includes("download=1");
      await route.fulfill({
        status: 200,
        contentType: download ? "application/octet-stream" : "text/plain; charset=utf-8",
        headers: { "content-disposition": download ? 'attachment; filename="readme.txt"' : "inline" },
        body: TXT_BODY,
      });
    },
  );
}

const viewer = (page: Page) => page.getByRole("region", { name: "Text viewer" });

/** The counter, waited for generously: the FIRST find of a session pays the wasm
 *  instantiate (16.13 MB, §8.1) plus the index build before it can say a number,
 *  and this suite runs `fullyParallel` against a dev server. */
async function counts(page: Page, text: string): Promise<void> {
  await expect(viewer(page).locator(".txtbar__count")).toHaveText(text, { timeout: 20_000 });
}

test.describe(".txt content search", () => {
  test("a `?q=` deep link opens the .txt viewer found, marked and stepping", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    // AFTER `signedIn`, so it beats `mockApi`'s catch-all. An md5 this map does
    // not name gets a 404, which reaches the viewer as its `error` state — never
    // as a silent "No matches".
    await mockDocText(page, TEXT);
    // The URL a result row produces: the document, and the query it was found
    // by. `?q=` primes find before the bytes land, exactly as the reader's does.
    await page.goto(`/#/note/${README}?q=zephyrine`);
    await freezeMotion(page);

    await expect(viewer(page)).toBeVisible();
    await expect(page.locator(".reader.is-open")).toBeHidden();

    // Find is ACTIVE: the bar is open, pre-filled, the whole file is laid out.
    const bar = viewer(page).locator(".txtbar");
    await expect(bar).toBeVisible();
    await expect(bar.locator("input")).toHaveValue("zephyrine");
    await expect(viewer(page).locator(".txt__sheet")).toContainText("Shopping list");

    // EXACT count, single-document scope — two paragraphs, one instance each.
    await counts(page, "2 matches in 2 paragraphs");

    // Matches are highlighted inside the loaded text — real <mark> elements. THE
    // BYTE RANGES ARE WHAT PUT THEM THERE: the index answered with a paragraph
    // ordinal and a range into the raw blob, and the viewer mapped that range
    // onto the string it decoded itself.
    const marks = viewer(page).locator(".txt__sheet mark");
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveText("zephyrine");

    // Landed on the target paragraph (the first match's), current-marked.
    const paras = viewer(page).locator(".txt__match");
    await expect(paras).toHaveCount(2);
    await expect(paras.nth(0)).toHaveClass(/is-current/);

    // Next JUMPS to the second matching paragraph, and wraps back.
    await viewer(page).getByRole("button", { name: "Next match" }).click();
    await expect(paras.nth(1)).toHaveClass(/is-current/);
    await expect(paras.nth(0)).not.toHaveClass(/is-current/);
    await viewer(page).getByRole("button", { name: "Next match" }).click();
    await expect(paras.nth(0)).toHaveClass(/is-current/);

    // Previous wraps the other way.
    await viewer(page).getByRole("button", { name: "Previous match" }).click();
    await expect(paras.nth(1)).toHaveClass(/is-current/);
  });

  test("the toolbar find button is present and enabled, and Ctrl+F opens it, for a plain .txt open", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await mockDocText(page, TEXT);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    await expect(viewer(page).locator(".txt__sheet")).toBeVisible();
    // The bar is shut until asked for.
    await expect(viewer(page).locator(".txtbar")).toBeHidden();

    const findBtn = viewer(page).getByRole("button", { name: "Find in this file" });
    await expect(findBtn).toBeVisible();
    await expect(findBtn).toBeEnabled();

    // Opening it and searching finds the same two paragraphs.
    await findBtn.click();
    await expect(viewer(page).locator(".txtbar")).toBeVisible();
    await viewer(page).locator(".txtbar input").fill("zephyrine");
    await counts(page, "2 matches in 2 paragraphs");
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(2);

    // Escape closes the bar and clears the marks.
    await viewer(page).locator(".txtbar input").press("Escape");
    await expect(viewer(page).locator(".txtbar")).toBeHidden();
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(0);
  });

  // §4.1 AS AN OBSERVATION: the text is fetched on the FIRST find and never
  // again. It is content-addressed and served `immutable`, so a second query is a
  // query against an index that is already built — nothing on screen says so,
  // which is why it is worth asserting.
  test("the file's text is fetched once, on the first find, and reused after that", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    const text = await mockDocText(page, TEXT);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);
    await expect(viewer(page).locator(".txt__sheet")).toBeVisible();

    // Opening the file needs the bytes, not a text index.
    expect(text.count(README_MD5)).toBe(0);

    await viewer(page).getByRole("button", { name: "Find in this file" }).click();
    await viewer(page).locator(".txtbar input").fill("zephyrine");
    await counts(page, "2 matches in 2 paragraphs");
    expect(text.count(README_MD5)).toBe(1);

    // A different word, the same built index.
    await viewer(page).locator(".txtbar input").fill("lentils");
    await counts(page, "1 match in 1 paragraph");
    expect(text.count(README_MD5)).toBe(1);
  });

  // MANUAL FUZZY IS OPT-IN in the .txt viewer too (in-doc-search Phase 3), the
  // reader's `.findbar__ask` rule mirrored: a typo is offered, not auto-answered.
  //
  // AND THE LADDER IS REAL AGAIN HERE. The server's `.txt` route never ran its
  // fuzzy fallback, so §6 step 6 left this affordance offering something nothing
  // could answer; step 7 asks `idx_fuzzy`, which the wasm gates itself — it
  // corrects only a query that matched NOTHING — over this document's own
  // vocabulary. So the close matches below are the engine's, not a fixture's.
  test("a typo in .txt find is OPT-IN: 'search similar' reveals the close matches", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await mockDocText(page, TEXT);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);
    await expect(viewer(page).locator(".txt__sheet")).toBeVisible();

    await viewer(page).getByRole("button", { name: "Find in this file" }).click();
    await viewer(page).locator(".txtbar input").fill("zephyryne"); // a typo for "zephyrine"

    // The exact search is empty; the typo-tolerant one is OFFERED, not run — no
    // marks, "No matches", and the affordance.
    await counts(page, "No matches");
    await expect(viewer(page).locator(".txtbar__ask")).toBeVisible();
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(0);

    // Opt in → the two "zephyrine" paragraphs appear, exact count and all.
    await viewer(page).locator(".txtbar__ask").click();
    await counts(page, "2 matches in 2 paragraphs");
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(2);
    await expect(viewer(page).locator(".txtbar__ask")).toBeHidden();
  });
});
