import { test, expect, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";
import { mockDocText, txtTextRecord, TXT_BODY, type TextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// The raw file and the text record both derive from `TXT_BODY`, and `txtTextRecord`
// computes the byte ranges with the server's chunker, so offsets are never hand-typed.
// Entered by URL: the fake ships no search index, so the library row cannot be reached.

const README = "177";
const README_MD5 = fakeFileHash(README);

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

/** Generous timeout: the first find pays wasm instantiation plus the index build. */
async function counts(page: Page, text: string): Promise<void> {
  await expect(viewer(page).locator(".txtbar__count")).toHaveText(text, { timeout: 20_000 });
}

test.describe(".txt content search", () => {
  test("a `?q=` deep link opens the .txt viewer found, marked and stepping", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    // After `signedIn`, so it beats `mockApi`'s catch-all; unknown md5s get a 404.
    await mockDocText(page, TEXT);
    // `?q=` primes find before the bytes land.
    await page.goto(`/#/note/${README}?q=zephyrine`);
    await freezeMotion(page);

    await expect(viewer(page)).toBeVisible();
    await expect(page.locator(".reader.is-open")).toBeHidden();

    const bar = viewer(page).locator(".txtbar");
    await expect(bar).toBeVisible();
    await expect(bar.locator("input")).toHaveValue("zephyrine");
    await expect(viewer(page).locator(".txt__sheet")).toContainText("Shopping list");

    await counts(page, "1 of 2");

    const marks = viewer(page).locator(".txt__sheet mark");
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveText("zephyrine");

    const paras = viewer(page).locator(".txt__match");
    await expect(paras).toHaveCount(2);
    await expect(paras.nth(0)).toHaveClass(/is-current/);

    await viewer(page).getByRole("button", { name: "Next match" }).click();
    await expect(paras.nth(1)).toHaveClass(/is-current/);
    await expect(paras.nth(0)).not.toHaveClass(/is-current/);
    await viewer(page).getByRole("button", { name: "Next match" }).click();
    await expect(paras.nth(0)).toHaveClass(/is-current/);

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
    await expect(viewer(page).locator(".txtbar")).toBeHidden();

    const findBtn = viewer(page).getByRole("button", { name: "Find in this file" });
    await expect(findBtn).toBeVisible();
    await expect(findBtn).toBeEnabled();

    await findBtn.click();
    await expect(viewer(page).locator(".txtbar")).toBeVisible();
    await viewer(page).locator(".txtbar input").fill("zephyrine");
    await counts(page, "1 of 2");
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(2);

    await viewer(page).locator(".txtbar input").press("Escape");
    await expect(viewer(page).locator(".txtbar")).toBeHidden();
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(0);
  });

  // The text is content-addressed and `immutable`, so it is fetched once per session.
  test("the file's text is fetched once, on the first find, and reused after that", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    const text = await mockDocText(page, TEXT);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);
    await expect(viewer(page).locator(".txt__sheet")).toBeVisible();

    expect(text.count(README_MD5)).toBe(0);

    await viewer(page).getByRole("button", { name: "Find in this file" }).click();
    await viewer(page).locator(".txtbar input").fill("zephyrine");
    await counts(page, "1 of 2");
    expect(text.count(README_MD5)).toBe(1);

    await viewer(page).locator(".txtbar input").fill("lentils");
    await counts(page, "1 of 1");
    expect(text.count(README_MD5)).toBe(1);
  });

  // `idx_fuzzy` only corrects a query that matched nothing.
  test("a typo in .txt find is OPT-IN: 'search similar' reveals the close matches", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await mockDocText(page, TEXT);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);
    await expect(viewer(page).locator(".txt__sheet")).toBeVisible();

    await viewer(page).getByRole("button", { name: "Find in this file" }).click();
    await viewer(page).locator(".txtbar input").fill("zephyryne"); // a typo for "zephyrine"

    await counts(page, "No matches");
    await expect(viewer(page).locator(".txtbar__ask")).toBeVisible();
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(0);

    await viewer(page).locator(".txtbar__ask").click();
    await counts(page, "1 of 2");
    await expect(viewer(page).locator(".txt__sheet mark")).toHaveCount(2);
    await expect(viewer(page).locator(".txtbar__ask")).toBeHidden();
  });
});
