import { test, expect } from "@playwright/test";
import { cardButton, railSettled, signedIn } from "./helpers/app";

// Where you are, said once: the tab's title and the page's one <h1>; focus
// goes to that heading on a change of screen, never while typing.

test.describe("the place", () => {
  test("the tab's title and the <h1> follow the screen", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    const h1 = page.locator("main h1");
    await expect(page).toHaveTitle("Library · Inkhold");
    await expect(h1).toHaveText("Library");

    await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name: /^Files/ }).click();
    await expect(page).toHaveTitle("Files · Inkhold");
    await expect(h1).toHaveText("Files");

    await cardButton(page, /Whiteboard — sprint plan/).click();
    await expect(page).toHaveTitle("Whiteboard — sprint plan · Inkhold");
    await expect(h1).toHaveText("Whiteboard — sprint plan");

    await page.goto("/#/todo/list/" + "1".padStart(32, "0"));
    await expect(page).toHaveTitle("Français · Inkhold");
    await expect(page.locator("h1")).toHaveCount(1);

    await page.goto("/#/bin");
    await expect(page).toHaveTitle("Recycle bin · Inkhold");
  });

  test("focus moves to the heading on a change of screen, and stays in the search box while typing", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name: /^Files/ }).click();
    await expect(page.locator("main h1")).toBeFocused();

    const box = page.getByRole("searchbox").first();
    await box.fill("whiteboard");
    await expect(page).toHaveTitle("Search · Inkhold");
    await expect(box).toBeFocused();
  });

  test("the skip link takes the keyboard past the rail and the bar", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
  });
});
