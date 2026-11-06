import { test, expect } from "@playwright/test";
import { railSettled, signedIn } from "./helpers/app";

// The library on a phone (below 700px): the rail is a drawer from ☰, the bar
// opens its search and tools from buttons, a tab bar holds the four places,
// menus are sheets, and a viewer's reading controls sit at the bottom.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test.describe("on a phone", () => {
  test("the drawer: opens from ☰, keeps the page out of reach, closes on Escape and gives focus back", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    const menu = page.getByRole("button", { name: "Places" });
    const rail = page.getByRole("navigation", { name: "Library" });
    await expect(rail).toBeHidden();
    await menu.click();
    await expect(rail).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    // The rest is inert while it is open.
    expect(await page.locator("main").evaluate((m) => (m as HTMLElement).inert)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(rail).toBeHidden();
    await expect(menu).toBeFocused();
    // Following a link closes it.
    await menu.click();
    await rail.getByRole("link", { name: /^Files/ }).click();
    await expect(rail).toBeHidden();
    await expect(page.locator("main h1")).toHaveText("Files");
  });

  test("the tab bar: marks where you are and goes there", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    const tabs = page.getByRole("navigation", { name: "Sections" });
    await expect(tabs.getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page");
    await tabs.getByRole("link", { name: "To-Do" }).click();
    await expect(page).toHaveURL(/#\/todo/);
    await expect(tabs.getByRole("link", { name: "To-Do" })).toHaveAttribute("aria-current", "page");
    await tabs.getByRole("link", { name: "You" }).click();
    await expect(tabs.getByRole("link", { name: "You" })).toHaveAttribute("aria-current", "page");
  });

  test("search opens across the bar, from the bar or the tab bar, and stays while it holds a query", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    const box = page.getByRole("searchbox").first();
    await expect(box).toBeHidden();
    await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Search" }).click();
    await expect(box).toBeFocused();
    await box.pressSequentially("budget");
    await expect(box).toHaveValue("budget");
    await page.locator("main").click({ position: { x: 10, y: 10 } });
    await expect(box).toBeVisible();
  });

  test("a card's ⋯ menu is a sheet along the bottom", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/files");
    await railSettled(page);
    await page.locator(".card .card__more").first().click();
    const sheet = page.locator(".menu__pop--float.is-open");
    await expect(sheet).toHaveAttribute("data-sheet", "");
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844);
  });

  test("a note's reading controls sit at the bottom, its title keeps the top", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const next = page.getByRole("button", { name: "Next page" });
    await expect(next).toBeVisible();
    expect((await next.boundingBox())!.y).toBeGreaterThan(700);
    await expect(page.locator(".reader__title b")).toBeVisible();
    // The tab bar gives way to the reader's own.
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeHidden();
  });
});

test.describe("at desktop width", () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
  test("none of it shows", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await expect(page.getByRole("button", { name: "Places" })).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Library" })).toBeVisible();
  });
});
