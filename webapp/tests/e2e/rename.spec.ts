import { test, expect, type Page } from "@playwright/test";
import { signedIn, cardButton, railSettled } from "./helpers/app";

const dialog = (page: Page) => page.locator("dialog.rename");
const renameItem = (page: Page) => page.locator(".menu-portal").getByRole("menuitem", { name: "Rename" });

/** Clicks `.card__more` directly: an anchor's trigger is named by its device folder ("EXPORT"). */
async function openMenu(page: Page, title: string): Promise<void> {
  const card = page.locator(".card", { hasText: title }).first();
  await expect(card).toBeVisible();
  await card.locator(".card__more").click();
}

/** A folder card only carries its ⋯ menu in list view. */
async function listView(page: Page): Promise<void> {
  await page.getByRole("button", { name: "List view" }).click();
}

test.describe("rename", () => {
  test("renames a note from the gallery menu", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();

    await openMenu(page, "Ideas & scratch");
    await renameItem(page).click();

    await expect(dialog(page)).toBeVisible();
    const field = dialog(page).locator(".rename__field");
    await expect(field).toHaveValue("Ideas & scratch");

    await expect(dialog(page).getByRole("button", { name: "Rename" })).toBeDisabled();
    await field.fill("Ideas — reorganised");
    await expect(dialog(page).getByRole("button", { name: "Rename" })).toBeEnabled();
    await dialog(page).getByRole("button", { name: "Rename" }).click();

    await expect(dialog(page)).toBeHidden();
    await expect(cardButton(page, "Ideas — reorganised")).toBeVisible();
    await expect(cardButton(page, "Ideas & scratch")).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("Renamed to 'Ideas — reorganised'.");
  });

  test("renames a folder", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    await listView(page);

    await openMenu(page, "Projects");
    await renameItem(page).click();
    await expect(dialog(page)).toBeVisible();

    const field = dialog(page).locator(".rename__field");
    await expect(field).toHaveValue("Projects");
    await expect(dialog(page).locator(".rename__ext")).toHaveCount(0);

    await field.fill("Projects — 2026");
    await dialog(page).getByRole("button", { name: "Rename" }).click();

    await expect(dialog(page)).toBeHidden();
    await expect(page.locator(".card", { hasText: "Projects — 2026" })).toBeVisible();
  });

  test("a name clash keeps the dialog open with the collision message", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    await openMenu(page, "Ideas & scratch");
    await renameItem(page).click();
    await expect(dialog(page)).toBeVisible();

    await dialog(page).locator(".rename__field").fill("Weekly review");
    await dialog(page).getByRole("button", { name: "Rename" }).click();

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator(".rename__help")).toHaveText("That name's already used here.");
    await expect(dialog(page).locator(".rename__field")).toBeFocused();
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
  });

  test("Escape cancels without renaming", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    await openMenu(page, "Ideas & scratch");
    await renameItem(page).click();
    await expect(dialog(page)).toBeVisible();

    await dialog(page).locator(".rename__field").fill("Something else entirely");
    await page.keyboard.press("Escape");

    await expect(dialog(page)).toBeHidden();
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
    await expect(cardButton(page, "Something else entirely")).toHaveCount(0);
  });

  test("a fixed category-root folder shows NO Rename item", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/");
    await railSettled(page);
    await listView(page);

    await openMenu(page, "Export");
    await expect(page.locator(".menu-portal").getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
    await expect(renameItem(page)).toHaveCount(0);
  });
});
