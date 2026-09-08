import { test, expect, type Page } from "@playwright/test";
import { signedIn, cardButton, railSettled } from "./helpers/app";

// Rename a file or folder from the card ⋯ menu. The
// action opens a small `<dialog>`: an editable stem, Rename/Cancel, an inline
// collision line. These drive it end to end against the in-memory fake `Api`,
// which renames the fixture entry in place and rejects a sibling clash with the
// same 409 the real endpoint will.
//
// FIXTURE FACTS. The `note` folder (`#/folder/note`) holds the user subfolder
// `Projects` plus the notes `Ideas & scratch` (`102`) and `Weekly review`
// (`101`). At the library root the resolved category anchors (Note, Export,
// …) are the fixed folders the device relies on, where Rename must not appear.

const dialog = (page: Page) => page.locator("dialog.rename");
const renameItem = (page: Page) => page.locator(".menu-portal").getByRole("menuitem", { name: "Rename" });

/** Open a card's ⋯ menu, located by the item's visible title. Clicks the `.card__more`
 *  trigger directly rather than by accessible name, since a category anchor's
 *  trigger is named by the device folder ("EXPORT") while its title reads "Export". */
async function openMenu(page: Page, title: string): Promise<void> {
  const card = page.locator(".card", { hasText: title }).first();
  await expect(card).toBeVisible();
  await card.locator(".card__more").click();
}

/** Switch the gallery to LIST view — a folder card only carries its ⋯ menu there. */
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

    // The dialog opens with the stem in the field, focused and selected.
    await expect(dialog(page)).toBeVisible();
    const field = dialog(page).locator(".rename__field");
    await expect(field).toHaveValue("Ideas & scratch");

    // Unchanged → Rename disabled; typing a new name enables it.
    await expect(dialog(page).getByRole("button", { name: "Rename" })).toBeDisabled();
    await field.fill("Ideas — reorganised");
    await expect(dialog(page).getByRole("button", { name: "Rename" })).toBeEnabled();
    await dialog(page).getByRole("button", { name: "Rename" }).click();

    // The dialog closes and the card is renamed in place, with a toast.
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
    // A folder has no extension, so there is no mono chip.
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

    // `Weekly review` is a sibling in the same folder — a clash.
    await dialog(page).locator(".rename__field").fill("Weekly review");
    await dialog(page).getByRole("button", { name: "Rename" }).click();

    // The dialog STAYS open, says why, and re-selects the field.
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator(".rename__help")).toHaveText("That name's already used here.");
    await expect(dialog(page).locator(".rename__field")).toBeFocused();
    // The original card is untouched.
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

    // Export is a resolved category anchor — a folder the device relies on.
    await openMenu(page, "Export");
    // The menu DID open (it still carries Move to bin), but Rename is absent.
    await expect(page.locator(".menu-portal").getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
    await expect(renameItem(page)).toHaveCount(0);
  });
});
