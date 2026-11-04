import { test, expect, type Page } from "@playwright/test";
import { signedIn, railSettled, contrastRatio, paintedColours, inkFraction } from "./helpers/app";
import { fakeFileHash } from "../../src/api/fake";

// Fixture `src/api/binFake.ts`: a folder trashed with two notes, plus an older note four
// days from expiry. Trash never confirms and purge always does; `renderGallery()`
// overwriting the gallery is what closes the bin and leaves bin mode.
import { binRow, openBin, openRowMenu, openFileActions, chooseMenuItem, reader } from "./bin.shared";

async function rowMenuItem(
  page: Page,
  rowText: string,
  name: string,
  item: "Restore" | "Delete permanently",
): Promise<void> {
  await openRowMenu(page, rowText, name);
  await page.locator(".menu-portal").getByRole("menuitem", { name: item }).click();
}

test.describe("recycle bin", () => {
  test("a hard reload straight onto #/bin shows the trashed rows — and keeps them when the tree lands", async ({
    page,
  }) => {
    await signedIn(page);
    // Regression: on a cold `#/bin` boot the late folder-tree response repainted the gallery
    // over the bin, closing it and leaving a blank screen.
    await page.goto("/#/bin");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row")).toHaveCount(4);

    await railSettled(page);
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row")).toHaveCount(4);
    await expect(page.locator(".crumbs__here")).toHaveText("Recycle bin");
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();
    await expect(page.locator("#empty-bin")).toBeVisible();
  });

  test("sits under Other in the rail, badged with its count, and opens", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    const row = binRow(page);
    await expect(row).toHaveCount(1);
    await expect(row.locator(".nav__count")).toHaveText("4");

    await row.click();
    await expect(page.locator(".crumbs__here")).toHaveText("Recycle bin");
    await expect(page.locator(".segmented")).toBeHidden();
    await expect(page.locator(".select")).toBeHidden();
    await expect(row).toHaveAttribute("aria-current", "true");
  });

  test("the crumb is a way OUT, not just a label", async ({ page }) => {
    // Regression: with the bin reachable from the account page, the header was a dead end.
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await binRow(page).click();

    await expect(page.locator(".crumbs__here")).toHaveText("Recycle bin");
    const home = page.locator(".crumbs button", { hasText: "Library" });
    await expect(home).toBeVisible();

    await home.click();

    await expect(page.locator(".bin")).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  });

  // --- bin mode (`.sn-root.is-destination`) ---

  test("takes the search box away, because it searches a library you are not looking at", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();

    await binRow(page).click();
    await expect(page.locator(".bin")).toBeVisible();
    // Out of the accessibility tree too: typing in it would leave the bin.
    await expect(page.locator(".sn-root")).toHaveClass(/is-destination/);
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();

    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Note$/ }) })
      .click();
    await expect(page.locator(".sn-root")).not.toHaveClass(/is-destination/);
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  });

  test("puts Empty bin in the topbar, iconed and labelled, and only where it means something", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    const empty = page.locator("#empty-bin");
    await expect(empty).toBeHidden();

    await binRow(page).click();
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText("Empty bin");
    await expect(empty.locator("svg")).toHaveCount(1);
    await expect(empty).toBeEnabled();
    const { color, background } = await paintedColours(empty);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
    const box = await empty.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.width).toBeGreaterThanOrEqual(24);
  });

  test("Empty bin goes inert over an empty bin, and still confirms when it is not", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    const empty = page.locator("#empty-bin");
    // The confirm must have moved to the topbar with the button.
    await empty.click();
    const dialog = page.locator("dialog.confirm");
    await expect(dialog.locator("h2")).toHaveText("Delete all 4 items permanently?");
    await dialog.locator(".is-danger").click();

    await expect(page.locator(".bin .empty h3")).toHaveText("Nothing deleted");
    await expect(empty).toBeVisible();
    await expect(empty).toBeDisabled();
  });

  test("shows the original path, the deletion time and the countdown on every row", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    // Two collisions: same name in different places (path), same place twice (time).
    const old = page.locator(".bin__row", { hasText: "download_test.note" });
    await expect(old.locator(".bin__path")).toHaveText("Note");
    await expect(old.locator(".life__label")).toHaveText("4 days left");
    await expect(old.locator(".life")).toHaveClass(/is-soon/);

    const fresh = page.locator(".bin__row", { hasText: "nested_to_remove" });
    await expect(fresh.locator(".life__label")).toHaveText("30 days left");
  });

  test("paints the note's REAL first page in the row, not a doc glyph", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    // Pixel probe: markup cannot tell a painted row from a placeholder.
    const row = page.locator(".bin__row", { hasText: "download_test.note" });
    const canvas = row.locator(".bin__thumb.is-page canvas");
    await expect(canvas).toHaveCount(1);
    await expect.poll(async () => inkFraction(canvas), { timeout: 5000 }).toBeGreaterThan(0.002);

    const folder = page.locator(".bin__row", { hasText: "nested_to_remove" }).first();
    await expect(folder.locator(".bin__thumb.is-folder")).toHaveCount(1);
    await expect(folder.locator("canvas")).toHaveCount(0);
  });

  test("nests a folder-delete batch and refuses to make the folder a control", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    const rows = page.locator(".bin__row");
    // The device deletes a folder as per-entity requests, children first; nesting reunites them.
    await expect(rows.nth(0)).toContainText("nested_to_remove");
    await expect(rows.nth(1)).toHaveClass(/is-child/);
    await expect(rows.nth(2)).toHaveClass(/is-child/);
    await expect(rows.nth(0).locator(".bin__open.is-static")).toHaveCount(1);
    await expect(rows.nth(1).locator("button.bin__open")).toHaveCount(1);
    await expect(rows.nth(1).locator(".bin__path")).toHaveCount(0);
  });

  test("says what the bin is for, and states the device asymmetry once", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    const aside = page.locator(".bin__aside");
    await expect(aside).toContainText("Deleted files are removed from your Supernote too.");
    await expect(aside).toContainText("30 days");
  });

  test("purge confirms, names the object, declares the fanout and the bytes freed", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await rowMenuItem(page, "nested_to_remove", "nested_to_remove", "Delete permanently");

    const dialog = page.locator("dialog.confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("h2")).toHaveText("Delete nested_to_remove permanently?");
    await expect(dialog.locator("p")).toContainText("Deletes the folder and the 2 items inside it");
    // Trash keeps charging quota, so purge is when the bytes return.
    await expect(dialog.locator(".confirm__frees")).toContainText("2.0 MB");
    await expect(dialog.locator(".is-danger")).toHaveText("Delete permanently");
  });

  test("puts Cancel first, gives it focus, and makes Enter cancel", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    const row = page.locator(".bin__row", { hasText: "download_test.note" });
    await rowMenuItem(page, "download_test.note", "download_test.note", "Delete permanently");

    const dialog = page.locator("dialog.confirm");
    const buttons = dialog.locator(".confirm__actions .btn");
    await expect(buttons.nth(0)).toHaveText("Cancel");
    await expect(buttons.nth(1)).toHaveText("Delete permanently");
    await expect(buttons.nth(0)).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();
  });

  test("Esc dismisses without destroying anything", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    const row = page.locator(".bin__row", { hasText: "download_test.note" });
    await rowMenuItem(page, "download_test.note", "download_test.note", "Delete permanently");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.confirm")).toBeHidden();
    await expect(row).toBeVisible();
  });

  test("confirming a purge removes the row and reports the space freed", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    const row = page.locator(".bin__row", { hasText: "download_test.note" });
    await rowMenuItem(page, "download_test.note", "download_test.note", "Delete permanently");
    await page.locator("dialog.confirm .is-danger").click();

    await expect(page.locator(".bin-toast")).toContainText("2.1 MB freed");
    await expect(row).toHaveCount(0);
    await expect(binRow(page).locator(".nav__count")).toHaveText("3");
  });

  test("restore reports what it actually did, including the contents it took with it", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await rowMenuItem(page, "nested_to_remove", "nested_to_remove", "Restore");

    await expect(page.locator(".bin-toast")).toContainText("with the 2 items inside it");
    await expect(page.locator(".bin__row")).toHaveCount(1);
  });

  test("empty bin confirms in bulk and states one honest total", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.getByRole("button", { name: "Delete everything in the recycle bin permanently" }).click();
    const dialog = page.locator("dialog.confirm");
    await expect(dialog.locator("h2")).toHaveText("Delete all 4 items permanently?");
    // A folder's bytes are its children's; do not count them twice.
    await expect(dialog.locator(".confirm__frees")).toContainText("4.1 MB");

    await dialog.locator(".is-danger").click();
    await expect(page.locator(".bin__row")).toHaveCount(0);
    await expect(page.locator(".bin .empty h3")).toHaveText("Nothing deleted");
    await expect(page.locator(".bin .empty p")).toContainText("30 days");
  });

  test("deleting from the library never asks, and offers the reverse plus the device line", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Note$/ }) })
      .click();
    await page.getByRole("button", { name: "List view" }).click();

    const card = page.locator(".card").filter({ has: page.locator(".card__title") }).first();
    const name = (await card.locator(".card__title").textContent())?.trim() ?? "";
    await card.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.locator(".menu-portal").getByRole("menuitem", { name: "Move to bin" }).click();

    await expect(page.locator("dialog.confirm")).toBeHidden();
    const toast = page.locator(".bin-toast");
    await expect(toast).toContainText("Moved");
    await expect(toast).toContainText("Also comes off your Supernote at the next sync.");
    await expect(toast.locator(".bin-toast__action")).toHaveText("Undo");

    await toast.locator(".bin-toast__action").click();
    await expect(toast).toContainText("Restored");
  });

  test("opening a trashed note lands in the reader with Back saying Recycle bin", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();

    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");

    // The note is already trashed, so the toolbar swaps Move to bin for the bin row's cluster.
    const reader = page.locator(".reader");
    await expect(reader.getByRole("button", { name: "Move to bin" })).toBeHidden();
    const cluster = reader.locator(".viewer__bin-actions");
    await expect(cluster).toBeVisible();
    await expect(cluster.locator(".life__label")).toHaveText("4 days left");
    await expect(cluster.locator(".life")).toHaveClass(/is-soon/);

    await openFileActions(page, cluster);
    const restore = page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" });
    const purge = page.locator(".menu-portal").getByRole("menuitem", { name: "Delete permanently" });
    await expect(restore).toBeVisible();
    await expect(restore).not.toHaveClass(/menu__item--danger/);
    await expect(purge).toBeVisible();
    await expect(purge).toHaveClass(/menu__item--danger/);
    await page.keyboard.press("Escape");

    await page.locator(".backbtn").first().click();
    await expect(page.locator(".bin__row").first()).toBeVisible();
  });

  test("restoring from inside the reader closes it back onto the bin, minus the row", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");

    const cluster = page.locator(".reader").locator(".viewer__bin-actions");
    await chooseMenuItem(page, cluster.getByRole("button", { name: "File actions" }), "Restore");
    await expect(page.locator("dialog.confirm")).toBeHidden();
    await expect(page.locator(".bin-toast")).toContainText("Restored download_test.note");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "download_test.note" })).toHaveCount(0);
    await expect(binRow(page).locator(".nav__count")).toHaveText("3");
  });

  test("Delete permanently from inside the reader confirms through the bin's own dialog", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    const cluster = page.locator(".reader").locator(".viewer__bin-actions");
    const openPurge = async (): Promise<void> => {
      await chooseMenuItem(page, cluster.getByRole("button", { name: "File actions" }), "Delete permanently");
    };
    await openPurge();

    const dialog = page.locator("dialog.confirm");
    await expect(dialog.locator("h2")).toHaveText("Delete download_test.note permanently?");
    await dialog.locator("button", { hasText: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");

    await openPurge();
    await dialog.locator(".is-danger").click();
    await expect(page.locator(".bin-toast")).toContainText("2.1 MB freed");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "download_test.note" })).toHaveCount(0);
    await expect(binRow(page).locator(".nav__count")).toHaveText("3");
  });

  // --- viewer parity ---
  // Transcripts and history are retained for trashed files, via `createBinScope`'s reroutes.
});
