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

// The recycle bin, end to end against the fake `Api`'s bin fixture (see
// `src/api/binFake.ts`): a folder deleted with the two notes inside it, plus an
// older note four days from the end of its retention window.
//
// What these tests are for is the behaviour that is invisible from the markup
// and expensive to get wrong:
//
//   - trash NEVER opens a dialog and purge ALWAYS does. That asymmetry is the
//     whole protection model — a confirm spent on the frequent, safe action is
//     what trains people to dismiss the rare, final one;
//   - the confirm's Cancel is FIRST, is what Enter activates, and holds focus,
//     so the destructive button is never the default;
//   - leaving the bin needs no teardown: `renderGallery()` overwriting the
//     gallery is what closes it, and the rail highlight is derived from that.
//     That same repaint is now what leaves BIN MODE, so the topbar's search box
//     and its `Empty bin` are proved to come and go with it here;
//   - a row shows the note's real first page. Nothing in the markup distinguishes
//     a canvas painted with handwriting from one that never got any, so that
//     claim is made with a pixel probe (`inkFraction`) rather than a selector.

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

/**
 * A bin row's two decisions now live behind the shared "…" overflow menu (the
 * same one the library grid/list rows use), so a row action is: open the row's
 * "…", then choose the item. The trigger names the row; the items are the plain
 * "Restore" / "Delete permanently".
 */
function binRowOf(page: Page, rowText: string) {
  return page.locator(".bin__row", { hasText: rowText }).first();
}
/**
 * Open a bin row's "…" menu and leave it open. RETRIED as a unit, for the same
 * reason the group-padding read is (see the `readGroup` retry below): the bin
 * repaints shortly after it opens (its own refresh lands), which can detach a
 * just-opened menu. `toPass` re-opens on a fresh row until the popover sticks.
 */
async function openRowMenu(page: Page, rowText: string, name: string) {
  const row = binRowOf(page, rowText);
  await expect(async () => {
    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    // The open popover is PORTALED to `.menu-portal` at the body root (ui/menu.ts),
    // not left under the row — so it is located at page scope, not `row.locator`.
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

/**
 * Open a viewer's bin-actions "…" (File actions) menu, RETRIED — a viewer can
 * repaint just after it mounts and detach a freshly-opened menu (the same hazard
 * `openRowMenu` guards against). Leaves the portaled popover showing.
 */
async function openFileActions(page: Page, cluster: Locator): Promise<void> {
  await expect(async () => {
    await cluster.getByRole("button", { name: "File actions" }).click();
    await expect(page.locator(".menu-portal .menu__pop")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

/**
 * Open a "…" / File-actions `trigger` and CLICK a portaled `item`, retried as ONE
 * unit — a viewer/list repaint can detach the just-opened menu between the open
 * and the click. Safe against double-firing: once the item click lands the block
 * resolves and `toPass` stops, so the action runs exactly once.
 */
async function chooseMenuItem(page: Page, trigger: Locator, item: string): Promise<void> {
  await expect(async () => {
    await trigger.click();
    const el = page.locator(".menu-portal").getByRole("menuitem", { name: item });
    await expect(el).toBeVisible({ timeout: 1000 });
    await el.click({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

// --- serving raw bytes for the non-note viewers -------------------------------
//
// The library runs against the in-memory fake `Api`, but the `.spd`/`.txt`
// viewers fetch their raw bytes as REAL browser requests. Two routes exist —
// `/file/:id` for a live file and `/api/controlplane/bin/file/:id` for a trashed
// one — and which of them the viewer mints is precisely the behaviour under
// test, so each is served separately and the bin route COUNTS its hits.
// (Registered after `signedIn`, so the bin route wins over its `/api/` catch-all.)

const SPD_PATH = fileURLToPath(new URL("../../../parsers/spd/tests/fixtures/layers_hidden.spd", import.meta.url));
const SPD_BYTES = readFileSync(SPD_PATH);
const TXT_BODY = "Reading list\n\n- Piranesi\n- A Canticle for Leibowitz\n\nReturn the library books on Friday.";

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

/** Trash the open file from its viewer, then walk to the bin and open its row. */
async function trashAndReopenFromBin(page: Page, viewerRegion: string, rowName: string): Promise<void> {
  const region = page.getByRole("region", { name: viewerRegion });
  await expect(region).toBeVisible();
  await region.getByRole("button", { name: "Move to bin" }).click();
  await expect(page.locator(".bin-toast")).toContainText("Moved");

  // IN-APP navigation, not a goto: a reload would rebuild the fake Api and lose
  // the trash. This is also exactly the path a user walks.
  await openBin(page);
  await page.locator(".bin__row", { hasText: rowName }).locator("button.bin__open").click();
  await expect(region).toBeVisible();
  await expect(region.locator(".viewer__back-label")).toHaveText("Recycle bin");
}

test.describe("recycle bin", () => {
  // --- the boot race -----------------------------------------------------------

  test("a hard reload straight onto #/bin shows the trashed rows — and keeps them when the tree lands", async ({
    page,
  }) => {
    await signedIn(page);
    // THE REAL BOOT PATH, deliberately: a fresh goto with NO prior navigation,
    // so the shell's folder-tree prefetch is still in flight when the bin route
    // dispatches. Its late response used to repaint the folder gallery over the
    // just-opened bin — the bin's own close mechanism, fired by nobody — and the
    // bin's subsequent paints were then guarded off as unmounted, leaving a
    // blank screen. Navigating away and back never showed it, because the tree
    // is cached by then; only a cold `#/bin` boot walks this code.
    await page.goto("/#/bin");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row")).toHaveCount(4);

    // The regression window is the tree walk SETTLING — after it, the bin must
    // still be the surface the route says it is, mode and all.
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
    // Not among the folders: nothing can be moved into it and it does not sync.
    await expect(row.locator(".nav__count")).toHaveText("4");

    await row.click();
    // The breadcrumb names where you are, and sort/view describe a folder
    // listing the bin is not.
    await expect(page.locator(".crumbs__here")).toHaveText("Recycle bin");
    await expect(page.locator(".segmented")).toBeHidden();
    await expect(page.locator(".select")).toBeHidden();
    await expect(row).toHaveAttribute("aria-current", "true");
  });

  // --- the bin is a MODE in the topbar (`.sn-root.is-destination`) ------------

  test("takes the search box away, because it searches a library you are not looking at", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    // Present over a folder — this is not a box that never existed.
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();

    await binRow(page).click();
    await expect(page.locator(".bin")).toBeVisible();
    // Gone from the accessibility tree too, not merely invisible: typing in it
    // would leave the bin entirely, which is the trap, not the box.
    await expect(page.locator(".sn-root")).toHaveClass(/is-destination/);
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();

    // And it comes back on the way out, by the same repaint that closes the bin.
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
    // A view-level control on a view you are not on.
    await expect(empty).toBeHidden();

    await binRow(page).click();
    await expect(empty).toBeVisible();
    // The words the user asked for, beside the trash glyph — a red icon-only
    // button in a toolbar is a guess, not a label.
    await expect(empty).toHaveText("Empty bin");
    await expect(empty.locator("svg")).toHaveCount(1);
    await expect(empty).toBeEnabled();
    // Destructive at rest, and legible there: red is danger and nothing else.
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
    // THE CONFIRM TRAVELLED WITH THE BUTTON. Empty-bin is irreversible and bulk,
    // so the dialog is half of what the control is — moving it to the topbar
    // must not have left the dialog behind in the view it came from.
    await empty.click();
    const dialog = page.locator("dialog.confirm");
    await expect(dialog.locator("h2")).toHaveText("Delete all 4 items permanently?");
    await dialog.locator(".is-danger").click();

    await expect(page.locator(".bin .empty h3")).toHaveText("Nothing deleted");
    // Still where it will be looked for, and unable to do anything.
    await expect(empty).toBeVisible();
    await expect(empty).toBeDisabled();
  });

  test("shows the original path, the deletion time and the countdown on every row", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    // Both facts, because there are two distinct collisions: same name in
    // different places (the path), and same name in the same place deleted twice
    // (the time).
    const old = page.locator(".bin__row", { hasText: "download_test.note" });
    await expect(old.locator(".bin__path")).toHaveText("Note");
    await expect(old.locator(".life__label")).toHaveText("4 days left");
    // Four days out, so the rule crosses to the danger colour — the one place
    // red appears without a destructive control under it.
    await expect(old.locator(".life")).toHaveClass(/is-soon/);

    const fresh = page.locator(".bin__row", { hasText: "nested_to_remove" });
    await expect(fresh.locator(".life__label")).toHaveText("30 days left");
  });

  test("paints the note's REAL first page in the row, not a doc glyph", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    // Deciding whether to restore something deleted a fortnight ago starts with
    // recognising it, and a column of identical glyphs answers nothing a column
    // of names has not already answered. This is the pixel probe that the row is
    // showing ink rather than the placeholder it used to be stuck on.
    const row = page.locator(".bin__row", { hasText: "download_test.note" });
    const canvas = row.locator(".bin__thumb.is-page canvas");
    await expect(canvas).toHaveCount(1);
    await expect.poll(async () => inkFraction(canvas), { timeout: 5000 }).toBeGreaterThan(0.002);

    // The honest fallbacks are still honest: a folder is a container, and gets
    // the folder glyph rather than a page it does not have.
    const folder = page.locator(".bin__row", { hasText: "nested_to_remove" }).first();
    await expect(folder.locator(".bin__thumb.is-folder")).toHaveCount(1);
    await expect(folder.locator("canvas")).toHaveCount(0);
  });

  test("nests a folder-delete batch and refuses to make the folder a control", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    const rows = page.locator(".bin__row");
    // The device sends a folder delete as separate per-entity requests, children
    // first. The nesting is what reunites them into the one action they were.
    await expect(rows.nth(0)).toContainText("nested_to_remove");
    await expect(rows.nth(1)).toHaveClass(/is-child/);
    await expect(rows.nth(2)).toHaveClass(/is-child/);
    await expect(rows.nth(0).locator(".bin__open.is-static")).toHaveCount(1);
    await expect(rows.nth(1).locator("button.bin__open")).toHaveCount(1);
    // A child's path would just repeat the folder named directly above it.
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
    // The user clicked one row; the operation destroys three.
    await expect(dialog.locator("p")).toContainText("Deletes the folder and the 2 items inside it");
    // Trash keeps charging quota, so purge is the only moment the bytes return.
    await expect(dialog.locator(".confirm__frees")).toContainText("2.0 MB");
    // The button repeats the title, so the sentence read is the sentence performed.
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

    // The destructive button is never the default action.
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

    // Restore routinely does more than the user selected, so it says so.
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
    // A folder's bytes are its children's; the total must not count them twice.
    await expect(dialog.locator(".confirm__frees")).toContainText("4.1 MB");

    await dialog.locator(".is-danger").click();
    await expect(page.locator(".bin__row")).toHaveCount(0);
    // U7: the absence is informative rather than blank.
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
    // The row's delete is now the "…" menu's Move to bin item.
    await card.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.locator(".menu-portal").getByRole("menuitem", { name: "Move to bin" }).click();

    // Reversible, so no dialog — it acts and offers the reverse.
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

    // Returning to the library would drop the user somewhere the file they were
    // just looking at does not exist.
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");

    // THE CONTEXT SWAP: the note is already trashed, so Move to bin leaves and the
    // toolbar shows the SAME `|— retention —| ⋯` a bin ROW does — the countdown
    // then the "…" menu whose two decisions are Restore (neutral) and Delete
    // permanently (the one red item).
    const reader = page.locator(".reader");
    await expect(reader.getByRole("button", { name: "Move to bin" })).toBeHidden();
    const cluster = reader.locator(".viewer__bin-actions");
    await expect(cluster).toBeVisible();
    // The retention countdown, carried from the bin row: 4 days left, "soon".
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
    // And the bin is still what is behind the reader — nothing had to restore it.
    await expect(page.locator(".bin__row").first()).toBeVisible();
  });

  test("restoring from inside the reader closes it back onto the bin, minus the row", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");

    // Restore is the SAFE direction: no dialog, it acts — and the file no longer
    // exists in the bin context, so the viewer leaves for the bin page. It lives
    // in the toolbar's "…" menu now.
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
    // Delete permanently is the toolbar "…" menu's red item. A helper, because it
    // is invoked twice here (a cancel, then a confirm).
    const cluster = page.locator(".reader").locator(".viewer__bin-actions");
    const openPurge = async (): Promise<void> => {
      await chooseMenuItem(page, cluster.getByRole("button", { name: "File actions" }), "Delete permanently");
    };
    await openPurge();

    // The SAME dialog a bin row raises — no caller reaches the destructive half
    // without it — and a cancel leaves the reader open on the still-trashed note.
    const dialog = page.locator("dialog.confirm");
    await expect(dialog.locator("h2")).toHaveText("Delete download_test.note permanently?");
    await dialog.locator("button", { hasText: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");

    // Confirmed, the note is gone for good: back to the bin, one row and one
    // badge count lighter, with the bytes stated.
    await openPurge();
    await dialog.locator(".is-danger").click();
    await expect(page.locator(".bin-toast")).toContainText("2.1 MB freed");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "download_test.note" })).toHaveCount(0);
    await expect(binRow(page).locator(".nav__count")).toHaveText("3");
  });

  // --- viewer parity: a trashed note reads like a live one (bin-parity.md) ------
  //
  // A trashed file's transcript + history are RETAINED (md5-keyed, `deleted = 1`),
  // so the bin viewer draws the same recognized-text ovals, finds in-note, and
  // browses version history the live viewer does — all through `createBinScope`'s
  // reroutes onto the `/bin/…` twins. `download_test.note` (the fixture's older
  // trashed note) is recognized, so it is the one that exercises all of it.

  test("a trashed .note preview draws recognized-text ovals and find-in-note works", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    // Find is ENABLED — the trashed note is searchable because its transcript
    // survived the delete (it used to degrade to an empty stub, disabling this).
    const findBtn = page.getByRole("button", { name: "Find in this note" });
    await expect(findBtn).toBeEnabled();
    await findBtn.click();
    await page.getByRole("textbox", { name: "Find in this note" }).fill("budget");

    // The counter settles to a real "N of M" off the bin search route…
    await expect(page.locator(".findbar__count")).toContainText("of", { timeout: 5000 });
    // …and the on-page ovals paint from the bin page-text route's word boxes —
    // the half of find that needs `getPageText`, which the bin reroute now serves.
    await expect(page.locator(".reader .findbox").first()).toBeVisible();
    await expect(page.locator(".findbar__note")).toBeHidden();
    // A one-document scan never widens — no fuzzy affordance ever appears.
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
  });

  test("a trashed .note browses its version history VIEW-ONLY: previews any version, no per-version Restore", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    // CARD PARITY: the bin viewer's "…" menu carries a "Version history" row next
    // to Restore / Delete permanently — the same entry the library card ⋯ offers.
    const cluster = page.locator(".reader").locator(".viewer__bin-actions");
    await openFileActions(page, cluster);
    await expect(page.locator(".menu-portal").getByRole("menuitem", { name: "Version history" })).toBeVisible();
    await expect(page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" })).toBeVisible();
    await page.keyboard.press("Escape");

    // The reader's Versions toolbar button — un-gated for a trashed real note —
    // opens the SAME floating panel; it lists versions with no per-row buttons.
    await page.locator(".reader__bar").getByRole("button", { name: "Version history" }).click();
    const panel = page.locator(".vh");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".vh__eyebrow")).toHaveText("Version history");
    const versionRows = page.locator(".vh-row");
    await expect(versionRows).toHaveCount(3);
    await expect(versionRows.nth(0).locator("button")).toHaveCount(0);

    // Preview a PAST version — the row click opens the reused reader read-only.
    await versionRows.nth(1).click();
    await expect(panel).toBeHidden();
    const banner = page.locator(".reader .version-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not the current note");
    // THE VIEW-ONLY DECISION: no per-version Restore in the bin. Restore the FILE
    // first (still offered by the bin cluster), then a version — the live flow.
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeHidden();
  });

  test("restoring the whole trashed .note from the bin viewer still works", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator(".reader.is-open")).toBeVisible();

    // Un-touched by the view-only history decision: the bin viewer's own Restore
    // (restore the FILE) acts, toasts, and closes back onto the bin minus the row.
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
    // The mode's own control leaves with the mode; `renderGallery()` is the
    // whole of the teardown, exactly as it is for the bin's markup.
    await expect(page.locator("#empty-bin")).toBeHidden();
    await expect(binRow(page)).toHaveAttribute("aria-current", "false");
  });

  test("Delete permanently is legible and red in the menu, and clears the 24px target", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    // The destructive decision is a menu item now. Open the row's "…", then
    // measure the item where it is read — inside the popover.
    const row = await openRowMenu(page, "download_test.note", "download_test.note");
    const del = page.locator(".menu-portal").getByRole("menuitem", { name: "Delete permanently" });
    await expect(del).toBeVisible();
    // It IS the danger variant (the one red item), and legible on the popover.
    await expect(del).toHaveClass(/menu__item--danger/);
    const { color, background } = await paintedColours(del);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);

    const box = await del.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.width).toBeGreaterThanOrEqual(24);
  });

  // A TRASHED SUBTREE IS ONE UNIT, and it takes TWO things to say so — dropping
  // the rule between a folder and its children, and tightening the padding on
  // both sides of every seam inside the group. They are one decision: air and a
  // rule are the same signal, so a group that drops the rule while keeping the
  // full 15px would put 30px of blank between a folder and its own children and
  // make them read as FURTHER apart than two unrelated ruled rows. Asserted
  // together, because reverting either half alone is the failure mode and either
  // half alone still looks deliberate in a screenshot.
  test("a trashed folder clusters with its children, and the group ends where the next entry begins", async ({
    page,
  }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);
    // Nothing below is read before motion stops: a frozen transition hands back
    // an intermediate padding as readily as an intermediate opacity.
    await freezeMotion(page);

    const rows = page.locator(".bin__row");
    // The fixture: `nested_to_remove` with its two notes, children first from the
    // device, reunited into folder-then-children by the nesting.
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

    // Read as ONE snapshot of the whole group, so the two halves of the pairing
    // are compared against each other rather than asserted a row at a time.
    //
    // RETRIED, for the same reason `paintedColours` and `inkFraction` are (see
    // helpers/app.ts): the bin repaints under this read. `open()` paints what is
    // already in hand and then re-renders when its own refresh lands, and a node
    // detached between resolving the locator and reading it reports EMPTY
    // computed styles — `getComputedStyle` on an orphan returns "" for every
    // property — which arrives here as `NaN` and fails the test for a reason
    // that has nothing to do with padding. `null` is "unreadable, try again";
    // the values themselves are stable once the DOM is.
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
        // The fixture group is a folder plus its two children, so fewer than
        // three rows is a half-rendered list rather than an answer. (It can be
        // MORE: the second read below appends a stranger row on purpose.)
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
    // The folder: no divider through the middle of the group it owns, and the
    // tight underside that keeps its children close to it.
    expect(folder).toEqual({ rule: 0, top: tokens.full, bottom: tokens.tight });
    // A middle child is tight on BOTH sides, and still undivided.
    expect(middle).toEqual({ rule: 0, top: tokens.tight, bottom: tokens.tight });
    // The last child ENDS the group: the full padding comes back. This is the
    // half that is easiest to revert on its own, and doing so would put 30px of
    // blank inside the group while leaving 15px at its edge — the nesting saying
    // the opposite of what it means.
    expect(last!.top).toBe(tokens.tight);
    expect(last!.bottom).toBe(tokens.full);

    // …and so does the rule. It cannot be read straight off this fixture, because
    // the last child is also the last row of its date group and `:last-child`
    // suppresses the border there for a different reason — a true reading and a
    // false one that agree. So a sibling is appended to make the group genuinely
    // continue, which is exactly the case `:has(+ .bin__row.is-child)` exists to
    // distinguish: the rule must return for a row that is NOT followed by a child.
    //
    // APPENDED AND READ IN ONE evaluate, and retried as a pair. The bin
    // re-renders when its own refresh lands, which throws the appended row away
    // — and a read that then found the true last child would measure the
    // `:last-child` suppression and report exactly the failure this assertion is
    // looking for. Doing both inside one turn means either both survive or
    // neither does, and the retry above handles "neither".
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
    // The subtree is unchanged — the suppression is scoped to "followed by a
    // child", not to "anywhere above the end of the list".
    expect(folderAfter).toEqual(folder);
    expect(middleAfter).toEqual(middle);
    // The last child now divides, because what follows it really is a separate
    // thing. Padding stays full: the group ended here either way.
    expect(lastAfter!.rule).toBeGreaterThan(0);
    expect(lastAfter!.bottom).toBe(tokens.full);
    const colour = await page
      .locator(".bin__rows .bin__row.is-child")
      .last()
      .evaluate((e) => getComputedStyle(e).borderBottomColor);
    // A 1px border of `rgba(…, 0)` measures as present and paints as nothing.
    expect(colour).not.toMatch(/,\s*0\s*\)$/);
  });

  // --- the non-note viewers, from the bin -------------------------------------
  //
  // A trashed `.spd`/`.txt` used to fall into the small in-bin preview panel,
  // because their viewers minted the LIVE raw-bytes URL and a trashed file 404s
  // from it. Now they open their REAL viewers, fetching off the bin-scoped route,
  // with the bin-origin toolbar (the retention countdown + the "…" menu's Restore
  // / Delete permanently) and the "Recycle bin" Back control the reader had.

  test("a trashed .spd opens its real viewer off the bin route, and Restore returns it", async ({ page }) => {
    await signedIn(page);
    const raw = await serveRawBytes(page, "application/octet-stream", SPD_BYTES);
    await page.goto("/#/note/n-files-sketch");
    await freezeMotion(page);

    await trashAndReopenFromBin(page, "Sketch viewer", "Kitchen sketch");

    // The REAL render, through the real decoder — one canvas per layer — and the
    // bytes came off the BIN route, because the live one 404s for trashed files.
    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas")).toHaveCount(4);
    expect(raw.binHits()).toBeGreaterThan(0);

    // The context swap, exactly as the reader wears it: the retention countdown +
    // the "…" menu (Restore neutral, Delete permanently the red item).
    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();
    const cluster = region.locator(".viewer__bin-actions");
    await expect(cluster.locator(".life__label")).toContainText("days left");
    await openFileActions(page, cluster);
    const restore = page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" });
    const purge = page.locator(".menu-portal").getByRole("menuitem", { name: "Delete permanently" });
    await expect(restore).toBeVisible();
    await expect(purge).toBeVisible();
    await expect(purge).toHaveClass(/menu__item--danger/);

    // Restore acts without a dialog, and the sketch no longer exists in the bin
    // context — so the viewer closes back onto the bin, minus the row.
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
    await page.goto("/#/note/n-files-readme");
    await freezeMotion(page);

    await trashAndReopenFromBin(page, "Text viewer", "readme");

    // The decoded text itself, laid out by the real viewer — off the bin route.
    const region = page.getByRole("region", { name: "Text viewer" });
    await expect(region.locator(".txt__sheet")).toContainText("Return the library books on Friday.");
    expect(raw.binHits()).toBeGreaterThan(0);
    // …and Download still offered, pointed at the bin-scoped URL (the reader's
    // precedent: the original is still there to save until the purge).
    await expect(region.locator('[aria-label="Download"]')).toHaveAttribute(
      "href",
      /^\/api\/controlplane\/bin\/file\/n-files-readme\?/,
    );

    // Purge NEVER skips the dialog; a cancel leaves the viewer open on the file.
    // It is the toolbar "…" menu's red item now.
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

    // Confirmed, it is gone for good: back onto the bin, one row lighter.
    await openPurge();
    await dialog.locator(".is-danger").click();
    await expect(page.locator(".bin-toast")).toContainText("Deleted readme");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "readme" })).toHaveCount(0);
    await expect(binRow(page).locator(".nav__count")).toHaveText("4");
  });

  // --- the tiles come off the library's own thumbnail facade -------------------
  //
  // A trashed `.spd`/`.txt`/image used to fall to the generic doc glyph (or, for
  // an image, a raw full-size fetch per row): the bin's painter never learned
  // the facade the library galleries paint through. Now every tile with a real
  // preview asks the SAME facade — same strategies, same tier cache, same dims
  // memo — with the one bin-specific fact (`bin: true`) routing raw-file
  // fetches to the bin-scoped endpoint the trashed blob still answers from.

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
    const hits = await mockThumbnailBackend(page, { textIds: ["n-files-readme"] });
    await page.goto("/");
    await railSettled(page);

    await trashFromFiles(page, "Kitchen sketch");
    await trashFromFiles(page, "readme");
    await openBin(page);

    // The `.spd`: its extracted embedded thumbnail, off `/thumbnail/{hash}` —
    // the same strategy, cache and (content-addressed, so trashed-blob-serving)
    // endpoint the library tile uses. Real pixels, probed as pixels.
    const spdRow = page.locator(".bin__row", { hasText: "Kitchen sketch" });
    const spd = spdRow.locator(".bin__thumb img");
    await expect(spd).toHaveCount(1);
    await expect.poll(() => imgInkFraction(spd), { timeout: 6000 }).toBeGreaterThan(0.02);
    expect(hits.thumbnailHits("n-files-sketch-md5")).toBeGreaterThan(0);
    // …and the row pre-clamped its lead from the `.spd`'s stated thumb dims, so
    // the tile reserved its final width before any bytes arrived.
    await expect(spdRow.locator(".bin__thumb")).toHaveClass(/has-aspect/);

    // The `.txt`: a rasterised snippet of its ACTUAL head — read off the
    // BIN-scoped raw route, because the live `/file/{id}` 404s for anything
    // trashed. This is the fetch the doc glyph never made.
    const txt = page.locator(".bin__row", { hasText: "readme" }).locator(".bin__thumb img");
    await expect(txt).toHaveCount(1);
    await expect.poll(() => imgInkFraction(txt), { timeout: 6000 }).toBeGreaterThan(0.004);
    expect(hits.binFileHits("n-files-readme")).toBeGreaterThan(0);
  });

  // A 120×160 grayscale PNG (the same decodable raster the thumbnail helper uses
  // for extracted thumbnails). REAL bytes `createImageBitmap` can decode are
  // load-bearing here: the image-doc strategy fetches the raw file and decodes
  // it through `createImageBitmap` — unlike the LIBRARY, whose image tiles are
  // native `<img>`s and never touch it — so a placeholder too small to decode
  // would silently exercise the glyph fallback instead of the tier path.
  const IMG_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAAAAADiYvdMAAAAZElEQVR42u3aAQ0AMAgEsfdvmqkAktEzUAOXWipgMBgMBoPBR+E0" +
    "BwaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAyegS03YDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAZ/Cz+nJdLCphXs6QAAAABJ" +
    "RU5ErkJggg==";

  test("a trashed image is tier-served off the bin route, aspect-corrected, and memoised", async ({ page }) => {
    await signedIn(page);
    // The screenshot's raw bytes on BOTH scopes — the live route (the library's
    // native tile fetches it) and the bin twin (the facade's image-doc fetches
    // it once the file is trashed). Only the bin route is tallied, because
    // routing the raw fetch there for a trashed file is the behaviour under test.
    const png = Buffer.from(IMG_PNG_BASE64, "base64");
    const raw = await serveRawBytes(page, "image/png", png);
    await page.goto("/");
    await railSettled(page);

    await trashFromFiles(page, "Screenshot — dashboard");
    await openBin(page);

    const row = page.locator(".bin__row", { hasText: "Screenshot — dashboard" });
    const img = row.locator(".bin__thumb img");
    // TIER-SERVED: the <img> shows the facade's downscaled WebP over a blob:
    // URL — the tile never points at the raw file, so a multi-MB photo costs
    // one fetch and one decode per hash, not one raw decode per paint.
    await expect.poll(() => imgPainted(img), { timeout: 6000 }).toBe(true);
    await expect.poll(() => imgInkFraction(img), { timeout: 6000 }).toBeGreaterThan(0.02);
    // And that raw fetch went to the BIN route the trashed blob answers on — the
    // live `/file/{id}` 404s for anything trashed.
    expect(raw.binHits()).toBeGreaterThan(0);

    // The corrected aspect: an image states no `thumbAspect`, so the DECODED
    // source is the truth (120×160 → 0.75) — the row's single allowed reflow,
    // after which the shape is pinned inline. This is the natural-size
    // correction the bin used to be missing (it letterboxed in the 3:4 floor
    // forever).
    await expect(row.locator(".bin__thumb")).toHaveClass(/has-aspect/);
    await expect
      .poll(() =>
        row.locator(".bin__thumb").evaluate((t) => {
          const [w, h] = getComputedStyle(t).aspectRatio.split("/").map((n) => parseFloat(n));
          return Math.round((w / (h || 1)) * 1000) / 1000;
        }),
      )
      .toBe(0.75);

    // …and the memo WRITE landed: the facade recorded the SOURCE's true dims
    // under the content hash, which is what pre-clamps every later session.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise((resolve) => {
                const open = indexedDB.open("sn-dims", 1);
                open.onerror = () => resolve(null);
                open.onsuccess = () => {
                  const db = open.result;
                  try {
                    const req = db.transaction("dims", "readonly").objectStore("dims").get("n-files-shot-md5");
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
          ),
        { timeout: 6000 },
      )
      .toEqual({ w: 120, h: 160 });

    // A repaint serves the cached tier tile: leave the bin and come back, and
    // the row paints again WITHOUT a second raw fetch off the bin route.
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

// --- the recycle-bin viewer's URL --------------------------------------------
//
// A trashed file open in a viewer is URL-ADDRESSABLE, exactly as a live note and
// a retained version are, via its own deep path under the bin listing:
// `#/bin/note/:id/page/:n`. The live `#/note/:id` route can't stand in for it —
// a trashed file's blob is not served there, so a reload of that address 404s and
// falls back to the library, dropping the user somewhere the file does not exist.
// So the address tracks the open trashed file (and its page), reload / copy-link
// reopen it, and a file no longer in the bin ages out to the listing with a
// notice — the recycle-bin twin of the version-preview age-out.
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
    // The deep bin path, NOT the live `#/note/:id` (whose blob 404s for a trashed
    // file). The first page collapses to the bare form.
    await expect(page).toHaveURL(/#\/bin\/note\/t-old$/);

    // The page rides the URL — `download_test.note` has two pages.
    await reader.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/#\/bin\/note\/t-old\/page\/2$/);
    const at = page.url();

    // A RELOAD reopens the SAME trashed file at the SAME page, not the library.
    await page.reload();
    await expect(page.locator(".reader")).toBeVisible();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");
    expect(page.url()).toBe(at);
  });

  test("a bin deep link opened COLD reopens the trashed file, and Back leaves for the listing", async ({ page }) => {
    await signedIn(page);
    // No prior in-app navigation: the shell boots straight onto the bin-note URL,
    // so `openBinNote` must load the bin listing before it can find the entry and
    // build its origin. The static bin fixture survives a cold boot.
    await page.goto("/#/bin/note/t-old");
    await expect(page.locator(".reader")).toBeVisible();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");
    await expect(page).toHaveURL(/#\/bin\/note\/t-old$/);

    // The view-only history control is present on a trashed `.note` (bin-parity),
    // and Move to bin is not — the bin context swap survived the cold open.
    await expect(reader(page).getByRole("button", { name: "Move to bin" })).toBeHidden();

    // Back leaves for the bin LISTING — nothing had to pre-paint it behind the
    // reader; the Back href routes to `#/bin`, which paints it.
    await page.locator(".backbtn").first().click();
    await expect(page).toHaveURL(/#\/bin$/);
    await expect(page.locator(".bin__row").first()).toBeVisible();
  });

  test("a bin deep link to a file no longer in the bin falls back to the listing with a notice", async ({ page }) => {
    await signedIn(page);
    // Purged / restored since the link was made, or never trashed: no dead viewer
    // and no library — the bin listing, plus a notice.
    await page.goto("/#/bin/note/t-does-not-exist");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page).toHaveURL(/#\/bin$/);
    await expect(page.locator(".toast")).toContainText("no longer in the recycle bin");
  });
});

function reader(page: Page): Locator {
  return page.locator(".reader");
}
