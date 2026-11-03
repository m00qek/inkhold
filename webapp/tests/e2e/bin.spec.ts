import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  signedIn,
  railSettled,
  contrastRatio,
  paintedColours,
  inkFraction,
  freezeMotion,
  mockThumbnailBackend,
  imgInkFraction,
  imgPainted,
} from "./helpers/app";
import { serveRanges } from "./helpers/pdfRange";
import { mockDocText, noteTextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// Fixture `src/api/binFake.ts`: a folder trashed with two notes, plus an older note four
// days from expiry. Trash never confirms and purge always does; `renderGallery()`
// overwriting the gallery is what closes the bin and leaves bin mode.

/** The bin's rail row, by its exact name (ignoring the count badge). */
function binRow(page: Page) {
  return page
    .getByRole("navigation", { name: "Folders" })
    .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Recycle bin$/ }) });
}

async function openBin(page: Page): Promise<void> {
  await railSettled(page);
  await binRow(page).click();
  await expect(page.locator(".bin")).toBeVisible();
}

/** `download_test.note` — the older trashed seed, by id (`src/api/binFake.ts`). */
const BIN_OLD_NOTE_ID = "304";

/** Row actions live behind the shared "…" menu; the trigger names the row. */
function binRowOf(page: Page, rowText: string) {
  return page.locator(".bin__row", { hasText: rowText }).first();
}
/** Retried as a unit: the bin repaints after its own refresh, detaching a fresh menu. */
async function openRowMenu(page: Page, rowText: string, name: string) {
  const row = binRowOf(page, rowText);
  await expect(async () => {
    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    // Portaled to `.menu-portal`, so located at page scope.
    await expect(page.locator(".menu-portal .menu__pop")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
  return row;
}
async function rowMenuItem(
  page: Page,
  rowText: string,
  name: string,
  item: "Restore" | "Delete permanently",
): Promise<void> {
  await openRowMenu(page, rowText, name);
  await page.locator(".menu-portal").getByRole("menuitem", { name: item }).click();
}

/** Retried: a viewer can repaint just after mounting and detach the menu. */
async function openFileActions(page: Page, cluster: Locator): Promise<void> {
  await expect(async () => {
    await cluster.getByRole("button", { name: "File actions" }).click();
    await expect(page.locator(".menu-portal .menu__pop")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

/** Open and click retried as one unit; `toPass` stops once the click lands, so it runs once. */
async function chooseMenuItem(page: Page, trigger: Locator, item: string): Promise<void> {
  await expect(async () => {
    await trigger.click();
    const el = page.locator(".menu-portal").getByRole("menuitem", { name: item });
    await expect(el).toBeVisible({ timeout: 1000 });
    await el.click({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

// --- raw bytes for the non-note viewers ---
// Live and bin raw routes are served separately; which one a viewer mints is under test.

const SPD_PATH = fileURLToPath(new URL("../../../parsers/spd/tests/fixtures/layers_hidden.spd", import.meta.url));
const SPD_BYTES = readFileSync(SPD_PATH);
const TXT_BODY = "Reading list\n\n- Piranesi\n- A Canticle for Leibowitz\n\nReturn the library books on Friday.";
const PDF_PATH = fileURLToPath(new URL("../../wasm/tests/fixtures/two-page.pdf", import.meta.url));
const PDF_BYTES = readFileSync(PDF_PATH);

/** Serve both raw-file routes with `body`; returns the bin route's hit tally. */
async function serveRawBytes(page: Page, contentType: string, body: Buffer | string): Promise<{ binHits: () => number }> {
  let hits = 0;
  const fulfill = { status: 200, contentType, headers: { "x-content-type-options": "nosniff" }, body };
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    (route) => route.fulfill(fulfill),
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/controlplane/bin/file/"),
    (route) => {
      hits++;
      return route.fulfill(fulfill);
    },
  );
  return { binHits: () => hits };
}

async function trashAndReopenFromBin(page: Page, viewerRegion: string, rowName: string): Promise<void> {
  const region = page.getByRole("region", { name: viewerRegion });
  await expect(region).toBeVisible();
  await region.getByRole("button", { name: "Move to bin" }).click();
  await expect(page.locator(".bin-toast")).toContainText("Moved");

  // In-app navigation: a reload would rebuild the fake Api and lose the trash.
  await openBin(page);
  await page.locator(".bin__row", { hasText: rowName }).locator("button.bin__open").click();
  await expect(region).toBeVisible();
  await expect(region.locator(".viewer__back-label")).toHaveText("Recycle bin");
}

test.describe("recycle bin", () => {
  // --- the boot race ---

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

  test("a trashed .note preview draws recognized-text ovals and find-in-note works", async ({ page }) => {
    await signedIn(page);
    // Served under the trashed blob's own md5 (`binFake.ts`'s `BlobHash`), not via `fallback`.
    // `download_test.note`: 2 pages, "budget" twice on each.
    await mockDocText(page, {
      [fakeFileHash(BIN_OLD_NOTE_ID)]: noteTextRecord("download_test.note", 2),
    });
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    const findBtn = page.getByRole("button", { name: "Find in this note" });
    await expect(findBtn).toBeEnabled();
    await findBtn.click();
    await page.getByRole("textbox", { name: "Find in this note" }).fill("budget");

    // Generous: the session's first find pays wasm instantiation and the index build.
    await expect(page.locator(".findbar__count")).toContainText("of", { timeout: 20_000 });
    // Ovals come from the bin page-text route; only search stopped being bin-scoped.
    await expect(page.locator(".reader .findbox").first()).toBeVisible();
    await expect(page.locator(".findbar__note")).toBeHidden();
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
  });

  test("a trashed .note browses its version history VIEW-ONLY: previews any version, no per-version Restore", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    const cluster = page.locator(".reader").locator(".viewer__bin-actions");
    await openFileActions(page, cluster);
    await expect(page.locator(".menu-portal").getByRole("menuitem", { name: "Version history" })).toBeVisible();
    await expect(page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.locator(".reader__bar").getByRole("button", { name: "Version history" }).click();
    const panel = page.locator(".vh");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".vh__eyebrow")).toHaveText("Version history");
    const versionRows = page.locator(".vh-row");
    await expect(versionRows).toHaveCount(3);
    await expect(versionRows.nth(0).locator("button")).toHaveCount(0);

    await versionRows.nth(1).click();
    await expect(panel).toBeHidden();
    const banner = page.locator(".reader .version-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not the current note");
    // View-only: restore the file first, then a version.
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeHidden();
  });

  test("restoring the whole trashed .note from the bin viewer still works", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator(".reader.is-open")).toBeVisible();

    const cluster = page.locator(".reader").locator(".viewer__bin-actions");
    await chooseMenuItem(page, cluster.getByRole("button", { name: "File actions" }), "Restore");
    await expect(page.locator(".bin-toast")).toContainText("Restored download_test.note");
    await expect(page.locator(".bin__row", { hasText: "download_test.note" })).toHaveCount(0);
  });

  test("leaving by the rail closes the bin and restores the folder controls", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Note$/ }) })
      .click();

    await expect(page.locator(".bin")).toHaveCount(0);
    await expect(page.locator(".segmented")).toBeVisible();
    await expect(page.locator(".select")).toBeVisible();
    await expect(page.locator("#empty-bin")).toBeHidden();
    await expect(binRow(page)).toHaveAttribute("aria-current", "false");
  });

  test("Delete permanently is legible and red in the menu, and clears the 24px target", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    const row = await openRowMenu(page, "download_test.note", "download_test.note");
    const del = page.locator(".menu-portal").getByRole("menuitem", { name: "Delete permanently" });
    await expect(del).toBeVisible();
    await expect(del).toHaveClass(/menu__item--danger/);
    const { color, background } = await paintedColours(del);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);

    const box = await del.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.width).toBeGreaterThanOrEqual(24);
  });

  // Dropping the rule and tightening padding are one decision; either alone leaves the
  // group reading further apart than unrelated rows.
  test("a trashed folder clusters with its children, and the group ends where the next entry begins", async ({
    page,
  }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);
    // Freeze first: a running transition reports intermediate padding.
    await freezeMotion(page);

    const rows = page.locator(".bin__row");
    await expect(rows.nth(0)).toContainText("nested_to_remove");
    await expect(rows.nth(1)).toHaveClass(/is-child/);
    await expect(rows.nth(2)).toHaveClass(/is-child/);

    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        full: parseFloat(cs.getPropertyValue("--row-pad-y")),
        tight: parseFloat(cs.getPropertyValue("--row-pad-y-tight")),
      };
    });
    expect(tokens.tight).toBeLessThan(tokens.full);

    // Retried: the bin re-renders when its refresh lands, and orphans report "" styles.
    const readGroup = () =>
      page.locator(".bin__rows").first().evaluate((g) => {
        const out = [];
        for (const r of g.querySelectorAll(".bin__row")) {
          const cs = getComputedStyle(r);
          if (!cs.paddingTop) return null; // orphaned mid-repaint
          out.push({
            rule: parseFloat(cs.borderBottomWidth),
            top: parseFloat(cs.paddingTop),
            bottom: parseFloat(cs.paddingBottom),
          });
        }
        // Fewer than three rows is a half-rendered list.
        return out.length >= 3 ? out : null;
      });

    const group = async () => {
      for (let attempt = 0; ; attempt++) {
        const read = await readGroup().catch(() => null);
        if (read !== null) return read;
        if (attempt >= 20) throw new Error("bin rows kept detaching (20 attempts)");
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    const [folder, middle, last] = await group();
    expect(folder).toEqual({ rule: 0, top: tokens.full, bottom: tokens.tight });
    expect(middle).toEqual({ rule: 0, top: tokens.tight, bottom: tokens.tight });
    expect(last!.top).toBe(tokens.tight);
    expect(last!.bottom).toBe(tokens.full);

    // The last child is also last in its date group, where `:last-child` hides the border
    // anyway, so a stranger row is appended. Appended and read in one evaluate, since a
    // re-render discards it.
    const groupWithStranger = async () => {
      for (let attempt = 0; ; attempt++) {
        const read = await page
          .locator(".bin__rows")
          .first()
          .evaluate((g) => {
            g.querySelector(".bin__row[data-stranger]")?.remove();
            const stranger = document.createElement("div");
            stranger.className = "bin__row";
            stranger.setAttribute("data-stranger", "");
            g.append(stranger);
            const out = [];
            for (const r of g.querySelectorAll(".bin__row:not([data-stranger])")) {
              const cs = getComputedStyle(r);
              if (!cs.paddingTop) return null;
              out.push({
                rule: parseFloat(cs.borderBottomWidth),
                top: parseFloat(cs.paddingTop),
                bottom: parseFloat(cs.paddingBottom),
              });
            }
            return out.length === 3 && g.contains(stranger) ? out : null;
          })
          .catch(() => null);
        if (read !== null) return read;
        if (attempt >= 20) throw new Error("bin rows kept detaching (20 attempts)");
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    const [folderAfter, middleAfter, lastAfter] = await groupWithStranger();
    expect(folderAfter).toEqual(folder);
    expect(middleAfter).toEqual(middle);
    expect(lastAfter!.rule).toBeGreaterThan(0);
    expect(lastAfter!.bottom).toBe(tokens.full);
    const colour = await page
      .locator(".bin__rows .bin__row.is-child")
      .last()
      .evaluate((e) => getComputedStyle(e).borderBottomColor);
    // A 1px border of `rgba(…, 0)` measures as present and paints as nothing.
    expect(colour).not.toMatch(/,\s*0\s*\)$/);
  });

  // --- non-note viewers from the bin ---

  test("a trashed .spd opens its real viewer off the bin route, and Restore returns it", async ({ page }) => {
    await signedIn(page);
    const raw = await serveRawBytes(page, "application/octet-stream", SPD_BYTES);
    await page.goto("/#/note/174");
    await freezeMotion(page);

    await trashAndReopenFromBin(page, "Sketch viewer", "Kitchen sketch");

    // The live route 404s for trashed files.
    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas")).toHaveCount(4);
    expect(raw.binHits()).toBeGreaterThan(0);

    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();
    const cluster = region.locator(".viewer__bin-actions");
    await expect(cluster.locator(".life__label")).toContainText("days left");
    await openFileActions(page, cluster);
    const restore = page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" });
    const purge = page.locator(".menu-portal").getByRole("menuitem", { name: "Delete permanently" });
    await expect(restore).toBeVisible();
    await expect(purge).toBeVisible();
    await expect(purge).toHaveClass(/menu__item--danger/);

    await restore.click();
    await expect(page.locator("dialog.confirm")).toBeHidden();
    await expect(page.locator(".bin-toast")).toContainText("Restored Kitchen sketch");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "Kitchen sketch" })).toHaveCount(0);
    await expect(binRow(page).locator(".nav__count")).toHaveText("4");
  });

  test("a trashed .txt opens its real viewer, and Delete permanently confirms first", async ({ page }) => {
    await signedIn(page);
    const raw = await serveRawBytes(page, "text/plain; charset=utf-8", TXT_BODY);
    await page.goto("/#/note/177");
    await freezeMotion(page);

    await trashAndReopenFromBin(page, "Text viewer", "readme");

    const region = page.getByRole("region", { name: "Text viewer" });
    await expect(region.locator(".txt__sheet")).toContainText("Return the library books on Friday.");
    expect(raw.binHits()).toBeGreaterThan(0);
    await expect(region.locator('[aria-label="Download"]')).toHaveAttribute(
      "href",
      /^\/api\/controlplane\/bin\/file\/177\?/,
    );

    const cluster = region.locator(".viewer__bin-actions");
    const openPurge = async (): Promise<void> => {
      await chooseMenuItem(page, cluster.getByRole("button", { name: "File actions" }), "Delete permanently");
    };
    await openPurge();
    const dialog = page.locator("dialog.confirm");
    await expect(dialog.locator("h2")).toHaveText("Delete readme permanently?");
    await dialog.locator("button", { hasText: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(region).toBeVisible();

    await openPurge();
    await dialog.locator(".is-danger").click();
    await expect(page.locator(".bin-toast")).toContainText("Deleted readme");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "readme" })).toHaveCount(0);
    await expect(binRow(page).locator(".nav__count")).toHaveText("4");
  });

  test("a trashed .pdf offers Restore and Delete permanently, like every other viewer", async ({
    page,
  }) => {
    // Regression: the PDF viewer offered no bin controls for a trashed PDF.
    await signedIn(page);
    const raw = await serveRawBytes(page, "application/pdf", PDF_BYTES);
    await page.goto("/#/note/178");
    await freezeMotion(page);

    await trashAndReopenFromBin(page, "PDF viewer", "Appliance manual");

    const region = page.getByRole("region", { name: "PDF viewer" });
    // A viewer minting the live URL would sit on its placeholder.
    await expect.poll(
      () =>
        page.evaluate(() => {
          const c = document.querySelector(".pdf-page") as HTMLCanvasElement | null;
          return c && c.width ? c.width : 0;
        }),
      { timeout: 20_000 },
    ).toBeGreaterThan(0);
    expect(raw.binHits()).toBeGreaterThan(0);

    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();
    const cluster = region.locator(".viewer__bin-actions");
    await expect(cluster.locator(".life__label")).toContainText("days left");
    await openFileActions(page, cluster);
    const restore = page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" });
    const purge = page.locator(".menu-portal").getByRole("menuitem", { name: "Delete permanently" });
    await expect(restore).toBeVisible();
    await expect(purge).toHaveClass(/menu__item--danger/);

    await restore.click();
    await expect(page.locator(".bin-toast")).toContainText("Restored Appliance manual");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "Appliance manual" })).toHaveCount(0);
  });

  // --- bin tiles use the library's thumbnail facade ---
  // `bin: true` routes raw fetches to the bin endpoint.

  /** Trash one of the Files-folder fixtures from its list row — no viewer. The
   *  row's delete is the "…" menu's Move to bin item. */
  async function trashFromFiles(page: Page, name: string): Promise<void> {
    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Files$/ }) })
      .click();
    await page.getByRole("button", { name: "List view" }).click();
    const row = page.locator(".card", { hasText: name });
    await chooseMenuItem(page, row.getByRole("button", { name: `Actions for ${name}` }), "Move to bin");
    await expect(page.locator(".bin-toast")).toContainText(`Moved ${name}`);
  }

  test("a trashed .spd and .txt paint their REAL previews through the facade, not doc glyphs", async ({ page }) => {
    await signedIn(page);
    const hits = await mockThumbnailBackend(page, { textIds: ["177"] });
    await page.goto("/");
    await railSettled(page);

    await trashFromFiles(page, "Kitchen sketch");
    await trashFromFiles(page, "readme");
    await openBin(page);

    const spdRow = page.locator(".bin__row", { hasText: "Kitchen sketch" });
    const spd = spdRow.locator(".bin__thumb img");
    await expect(spd).toHaveCount(1);
    await expect.poll(() => imgInkFraction(spd), { timeout: 6000 }).toBeGreaterThan(0.02);
    // Trashing does not rewrite a blob, so the md5 is the live one.
    expect(hits.thumbnailHits(fakeFileHash("174"))).toBeGreaterThan(0);
    await expect(spdRow.locator(".bin__thumb")).toHaveClass(/has-aspect/);

    const txt = page.locator(".bin__row", { hasText: "readme" }).locator(".bin__thumb img");
    await expect(txt).toHaveCount(1);
    await expect.poll(() => imgInkFraction(txt), { timeout: 6000 }).toBeGreaterThan(0.004);

    // The facade keys by hash alone, so the raw blob is read once across both scopes.
    expect(hits.fileHits("177") + hits.binFileHits("177")).toBe(1);
  });

  test("a trashed .txt tile reads its bytes off the BIN route when the cache is cold", async ({ page }) => {
    // The bin must be the first place the facade meets this blob: live `/file/{id}` uses
    // `deleted = 0`. Trashed from a deep-linked viewer, whose fetch does not warm the facade.
    await signedIn(page);
    const hits = await mockThumbnailBackend(page, { textIds: ["177"] });
    await page.goto("/#/note/177");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Text viewer" });
    await expect(region).toBeVisible();
    await region.getByRole("button", { name: "Move to bin" }).click();
    await expect(page.locator(".bin-toast")).toContainText("Moved");

    const liveBefore = hits.fileHits("177");

    // In-app, never a goto: a reload rebuilds the fake `Api` and loses the trash.
    await openBin(page);

    const txt = page.locator(".bin__row", { hasText: "readme" }).locator(".bin__thumb img");
    await expect(txt).toHaveCount(1);
    await expect.poll(() => imgInkFraction(txt), { timeout: 6000 }).toBeGreaterThan(0.004);
    expect(hits.binFileHits("177")).toBeGreaterThan(0);
    expect(hits.fileHits("177")).toBe(liveBefore);
  });

  test("a trashed .pdf renders its page 0 off the BIN route, and learns the page's shape", async ({ page }) => {
    // `two-page.pdf`'s page 0 is landscape, so the final lead shape proves the page was read.
    await signedIn(page);
    await mockThumbnailBackend(page, { textIds: ["177"] });
    const served = await serveRanges(page, PDF_BYTES, undefined, (url) =>
      url.pathname === "/api/controlplane/bin/file/178",
    );
    await page.goto("/");
    await railSettled(page);

    await trashFromFiles(page, "Appliance manual");
    await openBin(page);

    const row = page.locator(".bin__row", { hasText: "Appliance manual" });
    const img = row.locator(".bin__thumb img");
    await expect(img).toHaveCount(1);
    await expect.poll(() => imgInkFraction(img), { timeout: 20_000 }).toBeGreaterThan(0.02);
    expect(served.count()).toBeGreaterThan(0);

    await expect(row.locator(".bin__thumb")).toHaveClass(/has-aspect/);
    await expect
      .poll(
        async () => {
          const box = await row.locator(".bin__thumb").boundingBox();
          return box && box.height > 0 ? box.width / box.height : null;
        },
        { timeout: 20_000 },
      )
      .toBeCloseTo(2, 1);
  });

  // 120×160 PNG: the image-doc strategy decodes via `createImageBitmap`, so it must be real.
  const IMG_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAAAAADiYvdMAAAAZElEQVR42u3aAQ0AMAgEsfdvmqkAktEzUAOXWipgMBgMBoPBR+E0" +
    "BwaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAyegS03YDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAZ/Cz+nJdLCphXs6QAAAABJ" +
    "RU5ErkJggg==";

  test("a trashed image is tier-served off the bin route, aspect-corrected, and memoised", async ({ page }) => {
    await signedIn(page);
    // Both scopes are served; only the bin route is tallied.
    const png = Buffer.from(IMG_PNG_BASE64, "base64");
    const raw = await serveRawBytes(page, "image/png", png);
    await page.goto("/");
    await railSettled(page);

    await trashFromFiles(page, "Screenshot — dashboard");
    await openBin(page);

    const row = page.locator(".bin__row", { hasText: "Screenshot — dashboard" });
    const img = row.locator(".bin__thumb img");
    // The tile shows the facade's downscaled WebP, never the raw file.
    await expect.poll(() => imgPainted(img), { timeout: 6000 }).toBe(true);
    await expect.poll(() => imgInkFraction(img), { timeout: 6000 }).toBeGreaterThan(0.02);
    expect(raw.binHits()).toBeGreaterThan(0);

    // Images state no `thumbAspect`, so the decoded 120×160 is the truth.
    await expect(row.locator(".bin__thumb")).toHaveClass(/has-aspect/);
    await expect
      .poll(() =>
        row.locator(".bin__thumb").evaluate((t) => {
          const [w, h] = getComputedStyle(t).aspectRatio.split("/").map((n) => parseFloat(n));
          return Math.round((w / (h || 1)) * 1000) / 1000;
        }),
      )
      .toBe(0.75);

    // The facade memoised the source dims under the content hash.
    await expect
      .poll(
        () =>
          page.evaluate(
            (hash: string) =>
              new Promise((resolve) => {
                const open = indexedDB.open("sn-dims", 1);
                open.onerror = () => resolve(null);
                open.onsuccess = () => {
                  const db = open.result;
                  try {
                    const req = db.transaction("dims", "readonly").objectStore("dims").get(hash);
                    req.onsuccess = () => {
                      const r = req.result as { w: number; h: number } | undefined;
                      db.close();
                      resolve(r ? { w: r.w, h: r.h } : null);
                    };
                    req.onerror = () => {
                      db.close();
                      resolve(null);
                    };
                  } catch {
                    db.close();
                    resolve(null);
                  }
                };
              }),
            fakeFileHash("173"),
          ),
        { timeout: 6000 },
      )
      .toEqual({ w: 120, h: 160 });

    // A repaint is served from the tier cache, with no second raw fetch.
    const before = raw.binHits();
    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Note$/ }) })
      .click();
    await openBin(page);
    const again = page.locator(".bin__row", { hasText: "Screenshot — dashboard" }).locator(".bin__thumb img");
    await expect.poll(() => imgPainted(again), { timeout: 6000 }).toBe(true);
    expect(raw.binHits()).toBe(before);
  });
});

// --- recycle-bin viewer URL ---
// `#/bin/note/:id/page/:n`: the live route would 404 a trashed blob. Gone files age out
// to the listing with a notice.
test.describe("recycle-bin viewer URL", () => {
  test("addresses the open trashed file under #/bin, tracks the page, and a reload reopens it there", async ({
    page,
  }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    const reader = page.locator(".reader");
    await expect(reader).toBeVisible();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");
    // The first page collapses to the bare form.
    await expect(page).toHaveURL(/#\/bin\/note\/304$/);

    await reader.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/#\/bin\/note\/304\/page\/2$/);
    const at = page.url();

    await page.reload();
    await expect(page.locator(".reader")).toBeVisible();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");
    expect(page.url()).toBe(at);
  });

  test("a bin deep link opened COLD reopens the trashed file, and Back leaves for the listing", async ({ page }) => {
    await signedIn(page);
    // Cold boot: `openBinNote` must load the bin listing before it can find the entry.
    await page.goto("/#/bin/note/304");
    await expect(page.locator(".reader")).toBeVisible();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");
    await expect(page).toHaveURL(/#\/bin\/note\/304$/);

    await expect(reader(page).getByRole("button", { name: "Move to bin" })).toBeHidden();

    await page.locator(".backbtn").first().click();
    await expect(page).toHaveURL(/#\/bin$/);
    await expect(page.locator(".bin__row").first()).toBeVisible();
  });

  test("a bin deep link to a file no longer in the bin falls back to the listing with a notice", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/bin/note/t-does-not-exist");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page).toHaveURL(/#\/bin$/);
    await expect(page.locator(".toast")).toContainText("no longer in the recycle bin");
  });
});

function reader(page: Page): Locator {
  return page.locator(".reader");
}
