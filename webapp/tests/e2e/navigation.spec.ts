import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, cardButton, railSettled } from "./helpers/app";

// Reader visibility is a function of the route. A reload must not reopen the note,
// and paging uses `replaceState`, so history must not grow.

function navItem(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Library" })
    .locator(".nav__item", { has: page.locator(".nav__name", { hasText: new RegExp(`^${name}$`) }) });
}

function reader(page: Page): Locator {
  return page.getByRole("region", { name: "Reader" });
}

test.describe("navigating while the reader is open", () => {
  test("a rail folder closes the reader, lists that folder, and leaves the note route", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(reader(page)).toBeVisible();

    await railSettled(page);
    await navItem(page, "Archive").click();

    await expect(reader(page)).toBeHidden();
    await expect(cardButton(page, /Archive note 01/)).toBeVisible();
    await expect(page).not.toHaveURL(/#\/note\//);
  });

  test("the header's breadcrumb is not reachable over a note — the reader's own Back is", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Document").click();

    await cardButton(page, /Attention Is All You Need/).click();
    await expect(reader(page)).toBeVisible();
    await expect(page).toHaveURL(/#\/note\/141$/);

    await expect(page.locator(".crumbs")).toBeHidden();
    await page.locator(".backbtn").click();

    await expect(reader(page)).toBeHidden();
    await expect(page).not.toHaveURL(/#\/note\//);
    await expect(cardButton(page, /Attention Is All You Need/)).toBeVisible();
    await expect(page.locator(".crumbs")).toBeVisible();
  });

  test("the URL is truthful afterwards: a reload does not reopen the note", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(reader(page)).toBeVisible();

    await railSettled(page);
    await navItem(page, "Archive").click();
    await expect(reader(page)).toBeHidden();

    // Closing the reader without leaving the note route would reboot into the reader here.
    await page.reload();

    await expect(page).not.toHaveURL(/#\/note\//);
    // Wait for boot so a build that would reopen the note has every chance to.
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    await expect(cardButton(page, /Archive note 01/)).toBeVisible();
    await expect(reader(page)).toBeHidden();
  });

  test("the library's listing chrome is gone over a note, and reader controls leave the route alone", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(reader(page)).toBeVisible();

    await expect(page.getByRole("combobox", { name: "Sort notes" })).toBeHidden();
    await expect(page.getByRole("group", { name: "View" })).toBeHidden();
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
    await expect(reader(page)).toBeVisible();
    // The URL counts pages from one; the reader indexes from zero.
    await expect(page).toHaveURL(/#\/note\/141\/page\/2$/);
  });

  test("Back and forward still route the reader", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Document").click();
    const card = cardButton(page, /Attention Is All You Need/);
    await card.click();
    await expect(reader(page)).toBeVisible();

    await page.goBack();
    await expect(reader(page)).toBeHidden();
    await expect(card).toBeVisible();

    await page.goForward();
    await expect(reader(page)).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Attention");
  });
});

test.describe("the URL follows the reader without becoming history", () => {
  test("turning pages rewrites the URL and adds no history entry", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Document").click();
    const card = cardButton(page, /Attention Is All You Need/);
    await card.click();
    await expect(reader(page)).toBeVisible();
    await expect(page).toHaveURL(/#\/note\/141$/);

    const depth = await page.evaluate(() => history.length);

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("3 / 20");
    await page.getByRole("button", { name: "Page 7" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("7 / 20");

    await expect(page).toHaveURL(/#\/note\/141\/page\/7$/);
    // A build that pushed instead of replaced passes every other assertion here.
    expect(await page.evaluate(() => history.length)).toBe(depth);

    await page.goBack();
    await expect(reader(page)).toBeHidden();
    await expect(card).toBeVisible();
  });

  test("the rewritten URL is truthful: a reload lands on the page you were on", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await page.getByRole("button", { name: "Page 5" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("5 / 20");

    await page.reload();

    await expect(page.locator(".pager__count")).toHaveValue("5 / 20");
  });
});

// Regression: `onRoute` both listened for `DOMContentLoaded` and ran immediately when
// `readyState` was "interactive", dispatching twice. Asserted on zoom and the OCR
// panel, the reader state the route does not carry.
test.describe("the initial route is dispatched once", () => {
  test("a late DOMContentLoaded does not throw away state the route cannot describe", async ({ page }) => {
    await signedIn(page);
    // Page 4 is recognized; the fixture leaves every third page without a transcript.
    await page.goto("/#/note/141/page/4");
    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");

    await page.getByRole("button", { name: "Zoom in" }).click();
    // Scoped to the reader: the hidden `.txt` viewer also has a `.zoom`.
    await expect(page.locator(".reader .zoom")).toHaveText("100%");
    await page.getByRole("button", { name: "Page text" }).click();
    await expect(page.locator(".ocr")).toBeVisible();

    // `bubbles: true`: the listener is on `window`, which a non-bubbling event never reaches.
    await page.evaluate(() => document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true })));
    await page.waitForTimeout(300);

    await expect(page.locator(".reader .zoom")).toHaveText("100%");
    await expect(page.locator(".ocr")).toBeVisible();
    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
  });

  test("re-dispatching the route re-opens the reader where it already is", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await page.getByRole("button", { name: "Page 4" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
    await expect(page).toHaveURL(/#\/note\/141\/page\/4$/);

    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
    await page.waitForTimeout(300);

    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
    await expect(page).toHaveURL(/#\/note\/141\/page\/4$/);
  });
});
