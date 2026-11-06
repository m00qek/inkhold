import { test, expect } from "@playwright/test";
import { cardButton, railSettled, signedIn } from "./helpers/app";

// What goes somewhere is a link: it has an address, opens in a new tab with a
// modifier or the middle button, and a plain click still stays in the app.

test.describe("navigation is made of links", () => {
  test("rail rows, cards, breadcrumbs and the account each carry their address", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    const rail = page.getByRole("navigation", { name: "Library" });
    await expect(rail.getByRole("link", { name: /^Files/ })).toHaveAttribute("href", /^#\/folder\//);
    await expect(rail.getByRole("link", { name: /^Recycle bin/ })).toHaveAttribute("href", "#/bin");
    await expect(rail.getByRole("link", { name: /^Your account/ })).toHaveAttribute("href", "#/account");

    await rail.getByRole("link", { name: /^Files/ }).click();
    await expect(cardButton(page, /Whiteboard — sprint plan/)).toHaveAttribute("href", /^#\/note\/172$/);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Library" })).toHaveAttribute("href", "#/");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).locator('[aria-current="page"]')).toHaveText("Files");
  });

  test("a modified click opens a new tab and leaves this one where it was", async ({ page, context }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name: /^Files/ }).click();
    const card = cardButton(page, /Whiteboard — sprint plan/);
    await expect(card).toBeVisible();
    const before = page.url();
    const opened = context.waitForEvent("page");
    await card.click({ modifiers: ["ControlOrMeta"] });
    const tab = await opened;
    // A new tab starts blank, then loads the link's address.
    await tab.waitForURL(/#\/note\/172$/);
    expect(page.url()).toBe(before);
    await tab.close();
  });

  test("a plain click stays in the app and opens the note", async ({ page, context }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name: /^Files/ }).click();
    let tabs = 0;
    context.on("page", () => tabs++);
    await cardButton(page, /Whiteboard — sprint plan/).click();
    await expect(page).toHaveURL(/#\/note\/172$/);
    expect(tabs).toBe(0);
  });
});
