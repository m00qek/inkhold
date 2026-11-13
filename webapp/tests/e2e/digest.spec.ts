import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signedIn } from "./helpers/app";
import { servePdf } from "./pdfViewer.shared";

// Digest against the fake API (`api/fakeDigest.ts`): seven digests in Home,
// Kitchen and Uncategorized ("Reading" is empty), from two PDFs, an EPUB, two
// notes (one not in the library) and one typed on the tablet. The first,
// from the lease's page 3, has a handwritten note; the appliance manual has
// changed since its digest was taken. Built like To-Do: the categories'
// overview of cards, the rail's rows for All, Uncategorized and Sources.

const SHOTS = process.env.DIGEST_SHOTS;

async function openDigest(page: Page, path = ""): Promise<void> {
  await signedIn(page);
  await page.goto(`/#/digest${path}`);
  await expect(page.locator(".digest")).toBeVisible();
  // Past "Loading…": the cards or the list come with the first answer.
  await expect(page.locator(".digest .app-cards, .digest .digest-body")).toBeVisible();
}

const card = (page: Page, text: string) => page.locator(".digest-card").filter({ hasText: text });
const overviewCard = (page: Page, name: string) => page.locator(".app-card").filter({ has: page.locator(".app-card__name", { hasText: new RegExp(`^${name}$`) }) });
const digestRows = (page: Page) => page.locator(".rail").getByRole("link", { name: /^(All|Uncategorized|Sources)\b/ });
const HOME = "/category/c0ffee00000000000000000000000001";

/** The open digest's ⋯, then one of its rows. */
async function digestAction(page: Page, label: string): Promise<void> {
  await page.locator(".digest-panel").getByRole("button", { name: "Actions for this digest" }).click();
  await page.locator(".menu__pop--float.is-open").getByRole("menuitem", { name: label }).click();
}

/** Closes the open digest with Escape, from its card. */
async function closeDigest(page: Page): Promise<void> {
  await page.locator(".digest-card.is-open .digest-card__link").focus();
  await page.keyboard.press("Escape");
}

test.describe("Digest", () => {
  test("is one of the tablet's apps in the rail, with its count; its views unfold under it, as To-Do's", async ({ page }) => {
    await openDigest(page);
    const row = page.locator(".rail").getByRole("link", { name: /^Digest/ });
    await expect(row).toHaveAttribute("aria-current", "page");
    await expect(row).toContainText("7");
    await expect(digestRows(page)).toHaveText([/^All\s*7$/, /^Uncategorized\s*3$/, /^Sources\s*7$/]);
    await expect(page.locator(".digest-place__name")).toHaveText("Categories");
    await expect(page.locator(".digest-place__sum")).toHaveText("3 categories · 7 digests");
    await expect(page).toHaveTitle(/^Categories/);

    await digestRows(page).filter({ hasText: "All" }).click();
    // A wide screen opens the list's first digest beside it.
    await expect(page).toHaveURL(/#\/digest\/all\/d\/7$/);
    await expect(digestRows(page).filter({ hasText: "All" })).toHaveAttribute("aria-current", "page");
    await expect(row).not.toHaveAttribute("aria-current", "page");
    await expect(page.locator(".digest-card__text").first()).toHaveText("Call the plumber about the kitchen tap");
  });

  test("the categories' overview: Uncategorized, then a card per category with its newest passages; an empty one says so", async ({ page }) => {
    await openDigest(page);
    await expect(page.locator(".app-card__name")).toHaveText(["Uncategorized", "Home", "Kitchen", "Reading"]);
    await expect(overviewCard(page, "Home").locator(".app-card__counts")).toHaveText("3 digests1 handwritten");
    // The newest passage whole, where it came from, and how many more.
    await expect(overviewCard(page, "Home").locator(".app-card__quote p")).toHaveText("“The tenant pays for repairs caused by misuse.”");
    await expect(overviewCard(page, "Home").locator(".app-card__from")).toContainText("Apartment lease — signed, page 1 · added");
    await expect(overviewCard(page, "Home").locator(".app-card__more")).toHaveText("and 2 more");
    await expect(overviewCard(page, "Reading").locator(".app-card__counts")).toHaveText("No digests");
    // Uncategorized can't be renamed or deleted: its ⋯ is there, disabled.
    await expect(overviewCard(page, "Uncategorized").locator(".card__more")).toBeDisabled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/categories.png` });

    await overviewCard(page, "Home").locator(".app-card__link").click();
    await expect(page).toHaveURL(/#\/digest\/category\/c0ffee00000000000000000000000001\/d\/3$/);
    await expect(page.locator(".digest-place__name")).toHaveText("Home");
    await expect(page.locator(".digest-card")).toHaveCount(3);

    await page.goto("/#/digest/category/c0ffee00000000000000000000000003");
    await expect(page.locator(".digest-empty__title")).toHaveText("Nothing in this category");
  });

  test("on a wide screen a list opens with its first digest beside it; Back leaves the list; closed, it stays closed", async ({ page }) => {
    await openDigest(page);
    await overviewCard(page, "Kitchen").locator(".app-card__link").click();
    await expect(page).toHaveURL(/category\/c0ffee00000000000000000000000002\/d\/4$/);
    await expect(page.locator(".digest-panel__text")).toHaveText("Feed the starter twice a day while it is young.");
    // The list's own entry was replaced: Back goes to the overview, not to a list with nothing open.
    await page.goBack();
    await expect(page).toHaveURL(/#\/digest$/);
    await page.goForward();
    await expect(page.locator(".digest-panel")).toBeVisible();
    await closeDigest(page);
    await expect(page.locator(".digest-panel")).toHaveCount(0);
    await expect(page).toHaveURL(/category\/c0ffee00000000000000000000000002$/);
  });

  test("a digest closed on purpose stays closed when Back returns to its list", async ({ page }) => {
    await openDigest(page);
    await overviewCard(page, "Kitchen").locator(".app-card__link").click();
    await expect(page.locator(".digest-panel")).toBeVisible();
    await closeDigest(page);
    await expect(page.locator(".digest-panel")).toHaveCount(0);
    await page.goto("/#/bin");
    await page.goBack();
    await expect(page.locator(".digest-card")).toHaveCount(1);
    await expect(page.locator(".digest-panel")).toHaveCount(0);
    await expect(page).toHaveURL(/category\/c0ffee00000000000000000000000002$/);
  });

  test("the top bar's ‹ goes up to the overview, named, as a viewer's does", async ({ page }) => {
    await openDigest(page, `${HOME}/d/1`);
    const up = page.locator(".topbar").getByRole("link", { name: "Back to Categories" });
    await expect(up).toHaveText("Categories");
    await up.click();
    await expect(page).toHaveURL(/#\/digest$/);
    await expect(up).toBeHidden();
    await page.goto("/#/digest/sources/Document%2FAppliance%20manual.pdf");
    await page.locator(".topbar").getByRole("link", { name: "Back to Sources" }).click();
    await expect(page).toHaveURL(/#\/digest\/sources$/);
  });

  test("New category: the tablet's name rules said while typing; made, it opens", async ({ page }) => {
    await openDigest(page);
    await page.getByRole("button", { name: "New category" }).click();
    const dialog = page.getByRole("dialog", { name: "New category" });
    const name = dialog.getByRole("textbox", { name: "Name" });
    await expect(name).toBeFocused();
    const go = dialog.getByRole("button", { name: "Create category" });
    await name.fill("Home");
    await expect(dialog.locator("#name-dialog-problem")).toHaveText("A category with that name exists.");
    await expect(go).toBeDisabled();
    await name.fill("a/b");
    await expect(dialog.locator("#name-dialog-problem")).toHaveText('A name can\'t hold / < > * ? | \\ : or ".');
    await name.fill("Garden");
    await expect(dialog.locator("#name-dialog-problem")).toBeEmpty();
    await expect(dialog.locator("#name-dialog-hint")).toHaveText("6 of 150 characters. Your Supernote takes it at its next sync.");
    await go.click();
    await expect(page.getByRole("status").filter({ hasText: 'Created "Garden".' })).toBeVisible();
    await expect(page).toHaveURL(/#\/digest\/category\/fa0+1$/);
    await expect(page.locator(".digest-place__name")).toHaveText("Garden");
    await expect(page.locator(".digest-empty__title")).toHaveText("Nothing in this category");
  });

  test("a category's ⋯ renames it, from its card or from the top bar inside it", async ({ page }) => {
    await openDigest(page);
    await overviewCard(page, "Kitchen").getByRole("button", { name: "Actions for Kitchen" }).click();
    await page.getByRole("menuitem", { name: "Rename category" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename category" });
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Kitchen");
    // Unchanged, there is nothing to rename.
    await expect(dialog.getByRole("button", { name: "Rename" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Name" }).fill("Cooking");
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByRole("status").filter({ hasText: 'Renamed to "Cooking".' })).toBeVisible();
    await expect(page.locator(".app-card__name")).toHaveText(["Uncategorized", "Home", "Cooking", "Reading"]);

    await overviewCard(page, "Cooking").locator(".app-card__link").click();
    await page.getByRole("button", { name: "Category options for Cooking" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Rename category", "Delete category"]);
  });

  test("deleting a category sends its digests to the bin, after saying so; back to the overview", async ({ page }) => {
    await openDigest(page, HOME);
    await page.getByRole("button", { name: "Category options for Home" }).click();
    await page.getByRole("menuitem", { name: "Delete category" }).click();
    const dialog = page.getByRole("dialog", { name: 'Delete "Home" and its 3 digests?' });
    await expect(dialog).toContainText("The digests go to the Recycle bin, where you can restore them. Your Supernote deletes them too at its next sync.");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/delete-category.png` });
    await dialog.getByRole("button", { name: "Delete category" }).click();
    await expect(page.getByRole("status").filter({ hasText: 'Deleted "Home". Its 3 digests are in the Recycle bin.' })).toBeVisible();
    await expect(page).toHaveURL(/#\/digest$/);
    await expect(page.locator(".app-card__name")).toHaveText(["Uncategorized", "Kitchen", "Reading"]);
    await expect(page.locator(".rail").getByRole("link", { name: /^Digest/ })).toContainText("4");
  });

  test("Move to bin from the open digest: gone from the list, the panel closed", async ({ page }) => {
    await openDigest(page, `${HOME}/d/3`);
    await digestAction(page, "Move to bin");
    // The bin's own toast, as for a file: the device line, and Undo.
    const toast = page.locator(".bin-toast");
    await expect(toast).toContainText('Moved "The tenant pays for repairs caused by misuse." to Recycle bin');
    await expect(toast).toContainText("Also comes off your Supernote at the next sync.");
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${HOME}$`));
    await expect(page.locator(".digest-panel")).toHaveCount(0);
    await expect(card(page, "misuse")).toHaveCount(0);
    await expect(page.locator(".digest-card")).toHaveCount(2);
  });

  test("a digest opens beside the list, with its note, and Escape closes it", async ({ page }) => {
    await openDigest(page, "/category/c0ffee00000000000000000000000001");
    await card(page, "sublet").click();
    await expect(page).toHaveURL(/\/d\/1$/);
    const p = page.locator(".digest-panel");
    await expect(p.locator(".digest-panel__text")).toHaveText("The tenant may sublet the flat only with the landlord's written consent.");
    await expect(p).toContainText("Ask before the summer");
    await expect(p.getByRole("img", { name: "Handwritten note" })).toBeVisible();
    await expect(p.locator(".digest-panel__ink.has-ink")).toBeVisible();
    await expect(p.locator("dd").first()).toHaveText("Apartment lease — signed, page 3");
    await expect(card(page, "sublet")).toHaveClass(/is-open/);
    // Focus moves into the panel, and comes back to the card on closing.
    await expect(p.locator("#digest-panel-title")).toBeFocused();
    // No ×: the list, or the top bar's ‹ where the digest takes its place, is the way on.
    await expect(p.getByRole("link", { name: "Close the digest" })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/open.png` });

    await page.keyboard.press("Escape");
    await expect(page.locator(".digest-panel")).toHaveCount(0);
    await expect(page).toHaveURL(/category\/c0ffee00000000000000000000000001$/);
    await expect(card(page, "sublet").locator(".digest-card__link")).toBeFocused();
  });

  test("the comment is edited in the panel; it waits for the tablet; Escape leaves the edit, not the digest", async ({ page }) => {
    await openDigest(page, "/d/2");
    const p = page.locator(".digest-panel");
    await p.getByRole("button", { name: "Add a comment" }).click();
    const box = p.getByRole("textbox", { name: "Comment" });
    await expect(box).toBeFocused();
    await box.fill("Every three months, or the boiler scales");
    await expect(p.locator("#digest-comment-count")).toHaveText("40 of 2000 characters");
    await page.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
    await expect(p).toBeVisible();
    await expect(p.getByRole("button", { name: "Add a comment" })).toBeFocused();

    await p.getByRole("button", { name: "Add a comment" }).click();
    await box.fill("Every three months,\nor the boiler scales");
    await p.getByRole("button", { name: "Save comment" }).click();
    await expect(box).toHaveCount(0);
    // Plain text, its line break kept.
    await expect(p.locator(".digest-panel__part p").first()).toHaveText("Every three months,\nor the boiler scales", { useInnerText: true });
    await expect(p).toContainText("Waiting for the tablet");
    await expect(card(page, "Descale")).toContainText("Waiting for the tablet");
    await expect(p.getByRole("button", { name: "Edit" })).toBeFocused();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/comment.png` });
  });

  test("the Recycle bin holds a binned digest among the files; restored, it is back in its category", async ({ page }) => {
    await openDigest(page, `${HOME}/d/3`);
    await digestAction(page, "Move to bin");
    await expect(page.locator(".digest-panel")).toHaveCount(0);
    await page.goto("/#/bin");
    const row = page.locator(".bin__row.is-digest");
    await expect(row.locator(".bin__name")).toHaveText("The tenant pays for repairs caused by misuse.");
    await expect(row.locator(".bin__meta")).toContainText("digest · Home");
    await expect(page.locator(".bin__aside")).toContainText("Deleted files and digests are removed from your Supernote too.");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/bin.png` });
    await row.getByRole("button", { name: /^Actions for the digest/ }).click();
    await page.getByRole("menuitem", { name: "Restore to Home" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Restored the digest to Home — back on your Supernote at the next sync" })).toBeVisible();
    await expect(page.locator(".bin__row.is-digest")).toHaveCount(0);
    await page.goto(`/#/digest${HOME}`);
    await expect(card(page, "misuse")).toHaveCount(1);
  });

  test("a deleted category's digests wait in the bin; Empty bin takes them with the files", async ({ page }) => {
    await openDigest(page);
    await overviewCard(page, "Home").locator(".app-card__link").click();
    await expect(page).toHaveURL(new RegExp(`${HOME}/d/\\d+$`));
    await page.getByRole("button", { name: "Category options for Home" }).click();
    await page.getByRole("menuitem", { name: "Delete category" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete category" }).click();
    await expect(page).toHaveURL(/#\/digest$/);
    // The gone category left history too: Back is the overview, not its notice.
    await page.goBack();
    await expect(page).toHaveURL(/#\/digest$/);
    await expect(overviewCard(page, "Home")).toHaveCount(0);
    await page.goto("/#/bin");
    await expect(page.locator(".bin__row.is-digest")).toHaveCount(3);
    await page.getByRole("button", { name: "Empty bin" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("the 3 digests included");
    await dialog.getByRole("button", { name: "Empty bin" }).click();
    await expect(page.locator(".bin__row")).toHaveCount(0);
  });

  test("Move to… moves the digest to another category; it waits for the tablet, open where it was", async ({ page }) => {
    await openDigest(page, "/category/c0ffee00000000000000000000000001/d/2");
    const p = page.locator(".digest-panel");
    await digestAction(page, "Move to…");
    const menu = page.locator(".menu__pop--float.is-open");
    // Where it is already is not offered; a new category is.
    await expect(menu.getByRole("menuitem")).toHaveText(["Move to…", "Uncategorized", "Kitchen", "Reading", "New category…"]);
    await menu.getByRole("menuitem", { name: "Kitchen" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Moved to Kitchen." })).toBeVisible();
    await expect(p.locator(".digest-panel__facts")).toContainText("Kitchen");
    await expect(p).toContainText("Waiting for the tablet");
    // Still open where it was; it has left Home's list.
    await expect(page).toHaveURL(/category\/c0ffee00000000000000000000000001\/d\/2$/);
    await expect(card(page, "Descale")).toHaveCount(0);
    await expect(p.getByRole("button", { name: "Actions for this digest" })).toBeFocused();
    await page.goto("/#/digest");
    await expect(overviewCard(page, "Kitchen").locator(".app-card__counts")).toHaveText("2 digests");
  });

  test("the open digest shows its source page, the link to it", async ({ page }) => {
    await openDigest(page, "/d/5");
    const link = page.locator(".digest-panel").getByRole("link", { name: "Open at page 2" });
    await expect(link.locator(".digest-panel__thumb.has-thumb img")).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/#\/note\/121\/page\/2$/);
  });

  test("a PDF digest's source page is drawn too", async ({ page }) => {
    await signedIn(page);
    await servePdf(page, readFileSync(new URL("../fixtures/demo/deutsch-lernen.pdf", import.meta.url)));
    await page.goto("/#/digest/d/1");
    await expect(page.locator(".digest-panel__thumb.has-thumb img")).toBeVisible({ timeout: 20_000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/source-thumb.png` });
  });

  test("an EPUB opens as a whole, with no page to show; a changed file says its page may have moved", async ({ page }) => {
    await openDigest(page, "/d/4");
    const panel = page.locator(".digest-panel");
    const link = panel.getByRole("link", { name: "Open the file" });
    await expect(link).toHaveAttribute("href", /#\/note\/143$/);
    await expect(panel.locator(".digest-panel__thumb")).toHaveCount(0);
    await expect(panel).not.toContainText("has changed since");

    await page.goto("/#/digest/d/2");
    await expect(page.locator(".digest-panel")).toContainText("This file has changed since the digest was taken: page 2 may no longer hold the passage.");
  });

  test("Open at page opens the source there, and Back returns to the digest", async ({ page }) => {
    await openDigest(page, "/d/2");
    await page.locator(".digest-panel").getByRole("link", { name: "Open at page 2" }).click();
    await expect(page).toHaveURL(/#\/note\/178\/page\/2$/);
    // The PDF viewer's own header.
    const back = page.locator(".viewer__back:visible");
    await expect(back).toContainText("Digest");
    await back.click();
    await expect(page).toHaveURL(/#\/digest\/all\/d\/2$/);
    await expect(page.locator(".digest-panel")).toBeVisible();
  });

  test("by source: a card per document and note, then typed ones; a document's digests in page order", async ({ page }) => {
    await openDigest(page);
    await digestRows(page).filter({ hasText: "Sources" }).click();
    await expect(page).toHaveURL(/#\/digest\/sources$/);
    await expect(page.locator(".digest-place__sum")).toHaveText("6 sources · 7 digests");
    await expect(page.locator(".digest-source__name").last()).toHaveText("Typed on the tablet");
    const lease = page.locator(".digest-source").filter({ hasText: "Apartment lease — signed" });
    await expect(lease.locator(".digest-source__meta span")).toHaveText([".pdf", "2 digests", "pages 1–3"]);
    await expect(lease.locator(".digest-source__page.has-thumb img, .digest-source__page img").first()).toBeVisible({ timeout: 20_000 });
    await lease.click();
    await expect(page.locator(".digest-card__page")).toHaveText(["p. 1", "p. 3"]);
    // A source's digests are the Sources row's.
    await expect(digestRows(page).filter({ hasText: "Sources" })).toHaveAttribute("aria-current", "page");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/sources.png` });

    // A note the library doesn't have: there is nothing to open.
    await page.goto("/#/digest/sources");
    await page.locator(".digest-source").filter({ hasText: "Old notebook" }).click();
    // Its only digest opens beside it; choosing its card again would close it.
    await expect(page).toHaveURL(/\/d\/6$/);
    await expect(page.locator(".digest-panel")).toContainText("That file is not in the library");
    await expect(page.locator(".digest-panel").getByRole("link", { name: /^Open/ })).toHaveCount(0);
  });

  test("search finds a digest by its passage and its comment together, and opens it on the Digest page", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await page.getByRole("searchbox", { name: "Search notes" }).fill("sublet summer");
    const group = page.getByRole("region", { name: "Digests" });
    await expect(group.locator(".section-head")).toHaveText("1 digest");
    await expect(group.locator(".digest-hit__text mark")).toHaveText(["sublet"]);
    await expect(group.locator(".digest-hit__comment mark")).toHaveText(["summer"]);
    await expect(group.locator(".digest-hit__meta")).toHaveText("Home · Apartment lease — signed, page 3");
    await group.locator(".digest-hit").click();
    await expect(page).toHaveURL(/#\/digest\/all\/d\/1$/);
    await expect(page.locator(".digest-panel__text")).toHaveText("The tenant may sublet the flat only with the landlord's written consent.");
  });

  test("search holds a quoted phrase to its order in a digest", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    const box = page.getByRole("searchbox", { name: "Search notes" });
    await box.fill('"written consent"');
    await expect(page.getByRole("region", { name: "Digests" }).locator(".digest-hit")).toHaveCount(1);
    await box.fill('"consent written"');
    await expect(page.getByRole("region", { name: "Digests" })).toHaveCount(0);
  });

  test("a place that is gone says so, with a way back", async ({ page }) => {
    await openDigest(page, "/category/kb-gone");
    await expect(page.locator(".digest-empty__title")).toHaveText("This category is gone");
    await page.getByRole("link", { name: "See all digests" }).click();
    await expect(page).toHaveURL(/#\/digest\/all\/d\/7$/);
  });

  test("on a phone: one column, the open digest in the list's place", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDigest(page, "/d/1");
    await expect(page.locator(".digest-panel")).toBeVisible();
    await expect(page.locator(".digest-list")).toBeHidden();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone.png` });
  });

  test("a PDF's Digests panel: its digests in page order, those on screen marked; a row turns the page", async ({ page }) => {
    await signedIn(page);
    // Three pages, so the lease's page-3 digest has a page to go to.
    await servePdf(page, readFileSync(new URL("../fixtures/demo/deutsch-lernen.pdf", import.meta.url)));
    await page.goto("/#/note/142");
    const opener = page.getByRole("button", { name: "Digests", exact: true });
    await expect(opener).toBeEnabled();
    await opener.click();
    await expect(opener).toHaveAttribute("aria-pressed", "true");
    const p = page.locator("#pdf-digests-panel");
    await expect(p.locator(".digest-doc__page")).toHaveText(["p. 1", "p. 3"]);
    await expect(p.locator(".digest-doc__row.is-current")).toHaveCount(1);
    await expect(p.locator(".digest-doc__row.is-current")).toContainText("repairs caused by misuse");
    await p.getByRole("button", { name: /sublet/ }).click();
    await expect(page).toHaveURL(/#\/note\/142\/page\/3$/);
    await expect(p.locator(".digest-doc__row.is-current")).toContainText("sublet");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pdf-panel.png` });
    // On to the digest itself, where its comment can be changed.
    await p.locator(".digest-doc__row.is-current").getByRole("link", { name: "Open in Digest" }).click();
    await expect(page).toHaveURL(/#\/digest\/sources\/.+\/d\/1$/);
    await expect(page.locator(".digest-panel")).toContainText("Ask before the summer");
  });

  test("a notebook's Digests panel beside the page; a note with none dims the opener", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/121");
    const opener = page.getByRole("button", { name: "Digests", exact: true });
    await opener.click();
    const p = page.locator("#note-digests-panel");
    await expect(p).toBeVisible();
    await p.getByRole("button", { name: /Ship the beta/ }).click();
    await expect(page).toHaveURL(/#\/note\/121\/page\/2$/);
    await expect(p.locator(".digest-doc__row.is-current")).toHaveCount(1);

    await page.goto("/#/note/101");
    await expect(page.getByRole("button", { name: /^Digests — none were taken/ })).toBeDisabled();
    await expect(page.locator("#note-digests-panel")).toBeHidden();
  });
});

test.describe("Digest on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a notebook's Digests is under ⋯, so the bar's touch-sized switches fit one row", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/121/page/2");
    // Enabled once the note's digests are in: a menu leaves out a tool that can't act.
    await expect(page.locator('[aria-controls="note-digests-panel"]')).toBeEnabled();
    await page.locator(".reader__bar").getByRole("button", { name: "More" }).click();
    await page.locator(".menu__pop--float.is-open").getByRole("menuitemcheckbox", { name: "Digests" }).click();
    await expect(page.locator("#note-digests-panel")).toBeVisible();
    await expect(page.locator("#note-digests-panel")).toContainText("Ship the beta before the review");
  });
});
