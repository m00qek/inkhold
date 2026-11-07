import { test, expect, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";
import { servePdf } from "./pdfViewer.shared";

// One design language: the same thing looks and sits the same on every screen.
// Each test here pins a rule a UX pass found broken on one screen only.

/** True when `a` comes before `b` in the document. */
const before = (page: Page, a: string, b: string, scope: string) =>
  page.evaluate(
    ([a, b, scope]) => {
      const root = document.querySelector(scope)!;
      const first = root.querySelector(a);
      const second = root.querySelector(b);
      if (!first || !second) return null;
      return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    },
    [a, b, scope] as const,
  );

test.describe("every viewer", () => {
  const VIEWERS = [
    { id: "101", bar: ".reader__bar" },
    { id: "178", bar: ".viewer--pdf .viewer__bar", pdf: true },
    { id: "174", bar: ".viewer--spd .viewer__bar" },
    { id: "177", bar: ".viewer--txt .viewer__bar" },
  ];
  for (const v of VIEWERS) {
    test(`orders the file's actions as the others: history, download, then the bin (${v.id})`, async ({ page }) => {
      await signedIn(page);
      if (v.pdf) await servePdf(page);
      await page.goto(`/#/note/${v.id}`);
      await freezeMotion(page);
      await expect(page.locator(v.bar)).toBeVisible();
      const history = '[aria-label$="history"]';
      const download = '[aria-label="Download"], [aria-label^="Download"]';
      await expect.poll(() => before(page, history, download, v.bar)).toBe(true);
    });
  }

  test("puts focus on ‹ when it opens, the PDF viewer too", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await expect(page.locator(".viewer--pdf .viewer__back")).toBeFocused();
  });
});

test.describe("the library", () => {
  test("draws every folder as a folder, the pinned categories and the person's own alike", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    const folders = page.locator("#gallery .card--folder");
    await expect(folders.first()).toBeVisible();
    const n = await folders.count();
    expect(n).toBeGreaterThan(6); // the six categories and at least one of the person's own
    await expect(page.locator("#gallery .card--folder .thumb--folder-shape")).toHaveCount(n);
  });

  test("highlights no folder in the rail while searching: results span the library", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/files");
    await expect(page.locator('.rail [aria-current="page"]')).toHaveCount(1);
    await page.goto("/#/search?q=budget");
    await expect(page.locator(".crumbs")).toHaveText("Search");
    await expect(page.locator('.rail [aria-current="page"]')).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  // Regression: a query kept for Back put the next place's bar in search mode,
  // and a place without the search box was left with no title at all.
  test("a search left behind never blanks the next place's title", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    const tabs = page.locator(".tabbar");
    await tabs.getByRole("button", { name: "Search" }).click();
    // Away at once, the query still in the box, as a person who changes their mind.
    await page.getByRole("searchbox", { name: "Search notes" }).fill("budget");
    await tabs.getByRole("link", { name: "You" }).click();
    await expect(page).toHaveURL(/#\/account$/);
    await expect(page.locator(".topbar .crumbs__here, .topbar [aria-current='page']").first()).toHaveText("Your account");
    await expect(page.locator(".topbar .crumbs")).toBeVisible();
  });

  // Regression: the bin's preview kept its one desktop row on a phone, which
  // squeezed the file's name out of sight and pushed Restore off the screen.
  test("the bin's preview shows the file's name, and keeps Restore and Delete on screen", async ({ page }) => {
    await signedIn(page);
    // A file with no viewer of its own (.epub) previews in the bin's overlay.
    await page.goto("/#/note/143");
    await page.locator(".reader__bar").getByRole("button", { name: "More" }).click();
    await page.locator(".menu__pop--float.is-open").getByRole("menuitem", { name: "Move to bin" }).click();
    await expect(page.locator(".bin-toast")).toContainText("Moved");
    // In-app navigation: a reload would rebuild the fake Api and lose the trash.
    await page.locator(".tabbar").getByRole("link", { name: "Library" }).click();
    await page.getByRole("button", { name: "Places" }).click();
    await page.locator(".rail").getByRole("link", { name: /Recycle bin/ }).click();
    await page.locator(".bin__row", { hasText: "Sourdough" }).locator("button.bin__open").click();

    const bar = page.locator(".bin-preview__bar");
    await expect(bar.locator(".bin-preview__title b")).toHaveText("Sourdough — a field guide");
    expect((await bar.locator(".bin-preview__title b").boundingBox())!.width).toBeGreaterThan(40);
    for (const label of [/^Restore /, /^Delete .* permanently$/]) {
      const b = (await bar.getByRole("button", { name: label }).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
  });

  // Regression: on a page without the box, the Search tab did nothing at all.
  test("the Search tab opens search from a page that has no search box", async ({ page }) => {
    await signedIn(page);
    for (const place of ["/#/account", "/#/bin"]) {
      await page.goto(place);
      await page.locator(".tabbar").getByRole("button", { name: "Search" }).click();
      await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeFocused();
    }
  });
});
