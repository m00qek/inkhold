import { test, expect, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";

// `.txt` CONTENT SEARCH, end to end: a term that lives ONLY in the `.txt`
// fixture (no note transcript, no file name) surfaces as a TEXT result in the
// library, and clicking it opens the `.txt` VIEWER scrolled to the matching
// paragraph with find running — matches highlighted, prev/next jumping between
// paragraphs, an exact count.
//
// The library runs against the in-memory fake `Api` (which indexes the readme's
// paragraphs); the raw file is a REAL URL the viewer fetches itself, so it needs
// a real response. `n-files-readme` is the `.txt` fixture; `BODY` is the exact
// string `api/fake.ts` chunks, so the client-side marking lines up with the byte
// ranges the fake reports.

const README = "n-files-readme";
const BODY =
  "Shopping list\n\n- oat milk\n- lentils\n- a new nib for the Supernote\n\n" +
  "The zephyrine tea arrived on Friday.\n\n" +
  "See you Sunday. More zephyrine steeped, brighter.";

async function mockTextFile(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      const download = route.request().url().includes("download=1");
      await route.fulfill({
        status: 200,
        contentType: download ? "application/octet-stream" : "text/plain; charset=utf-8",
        headers: { "content-disposition": download ? 'attachment; filename="readme.txt"' : "inline" },
        body: BODY,
      });
    },
  );
}

const searchBox = (page: Page) => page.getByRole("searchbox", { name: "Search notes" });
const results = (page: Page) => page.locator(".card--result");
const viewer = (page: Page) => page.getByRole("region", { name: "Text viewer" });

test.describe(".txt content search", () => {
  test("a term only in the .txt surfaces a TEXT result that opens the .txt viewer, found", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await page.goto("/");
    await freezeMotion(page);

    // A term that lives ONLY in the readme's paragraphs.
    await searchBox(page).fill("zephyrine");

    // One result — the readme — with a PARAGRAPH-unit locator (not "pages") and
    // NO excerpt: §6 step 6 deleted the snippet with the route that rendered it,
    // so the count line is the row's whole claim.
    const row = results(page).filter({ hasText: "readme" }).first();
    await expect(row).toBeVisible();
    await expect(row.locator(".hit__snippet")).toHaveCount(0);
    await expect(row.locator(".card__matches")).toHaveText("Matches in 2 paragraphs");

    // Click it → the `.txt` VIEWER (not the reader) opens.
    await row.locator("button.card__open").click();
    await expect(viewer(page)).toBeVisible();
    await expect(page.locator(".reader.is-open")).toBeHidden();

    // Find is ACTIVE: the bar is open, pre-filled, the whole file is laid out.
    const bar = viewer(page).locator(".txtbar");
    await expect(bar).toBeVisible();
    await expect(bar.locator("input")).toHaveValue("zephyrine");
    await expect(viewer(page).locator(".txt__sheet")).toContainText("Shopping list");

    // Matches are highlighted inside the loaded text — real <mark> elements.
    const marks = viewer(page).locator(".txt__sheet mark");
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveText("zephyrine");

    // EXACT count, single-document scope.
    await expect(bar.locator(".txtbar__count")).toHaveText("2 matches in 2 paragraphs");

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
    await expect(viewer(page).locator(".txtbar__count")).toHaveText("2 matches in 2 paragraphs");
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(2);

    // Escape closes the bar and clears the marks.
    await viewer(page).locator(".txtbar input").press("Escape");
    await expect(viewer(page).locator(".txtbar")).toBeHidden();
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(0);
  });

  // MANUAL FUZZY IS OPT-IN in the .txt viewer too (in-doc-search Phase 3), the
  // reader's `.findbar__ask` rule mirrored: a typo is offered, not auto-answered.
  test("a typo in .txt find is OPT-IN: 'search similar' reveals the close matches", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);
    await expect(viewer(page).locator(".txt__sheet")).toBeVisible();

    await viewer(page).getByRole("button", { name: "Find in this file" }).click();
    await viewer(page).locator(".txtbar input").fill("zephyryne"); // a typo for "zephyrine"

    // The exact search is empty; the typo-tolerant one is OFFERED, not run — no
    // marks, "No matches", and the affordance.
    await expect(viewer(page).locator(".txtbar__count")).toHaveText("No matches");
    await expect(viewer(page).locator(".txtbar__ask")).toBeVisible();
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(0);

    // Opt in → the two "zephyrine" paragraphs appear, exact count and all.
    await viewer(page).locator(".txtbar__ask").click();
    await expect(viewer(page).locator(".txtbar__count")).toHaveText("2 matches in 2 paragraphs");
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(2);
    await expect(viewer(page).locator(".txtbar__ask")).toBeHidden();
  });
});
