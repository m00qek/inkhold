import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signedIn } from "./helpers/app";
import { servePdf } from "./pdfViewer.shared";

// Digest against the fake API (`api/fakeDigest.ts`): seven digests in Home,
// Kitchen and Uncategorized ("Reading" is empty), from two PDFs, an EPUB, two
// notes (one not in the library) and one typed on the tablet. The first,
// from the lease's page 3, has a handwritten note; the appliance manual has
// changed since its digest was taken.

const SHOTS = process.env.DIGEST_SHOTS;

async function openDigest(page: Page, path = ""): Promise<void> {
  await signedIn(page);
  await page.goto(`/#/digest${path}`);
  await expect(page.locator(".digest")).toBeVisible();
  // Past "Loading…": the tabs come with the first answer.
  await expect(page.locator(".digest-tabs")).toBeVisible();
}

const card = (page: Page, text: string) => page.locator(".digest-card").filter({ hasText: text });

test.describe("Digest", () => {
  test("is one of the tablet's apps in the rail, with its count", async ({ page }) => {
    await openDigest(page);
    const row = page.locator(".rail").getByRole("link", { name: /^Digest/ });
    await expect(row).toHaveAttribute("aria-current", "page");
    await expect(row).toContainText("7");
    await expect(page.locator(".digest-place__sum")).toHaveText("7 digests");
    await expect(page).toHaveTitle(/Digest/);
  });

  test("by category: All newest first; a category; an empty one says so", async ({ page }) => {
    await openDigest(page);
    const groups = page.getByRole("navigation", { name: "Categories" });
    const names = await groups.locator(".digest-group__name").allInnerTexts();
    expect(names).toEqual(["All", "Uncategorized", "Home", "Kitchen", "Reading"]);
    await expect(page.locator(".digest-card__text").first()).toHaveText("Call the plumber about the kitchen tap");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/categories.png` });

    await groups.getByRole("link", { name: /^Home/ }).click();
    await expect(page).toHaveURL(/#\/digest\/category\/c0ffee00000000000000000000000001$/);
    await expect(page.locator(".digest-list__title")).toHaveText("Home");
    await expect(page.locator(".digest-card")).toHaveCount(3);

    await groups.getByRole("link", { name: /^Reading/ }).click();
    await expect(page.locator(".digest-empty__title")).toHaveText("Nothing in this category");
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
    await expect(p.getByRole("link", { name: "Close the digest" })).toBeFocused();
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

  test("Move to… moves the digest to another category; it waits for the tablet, open where it was", async ({ page }) => {
    await openDigest(page, "/category/c0ffee00000000000000000000000001/d/2");
    const p = page.locator(".digest-panel");
    await p.getByRole("button", { name: "Move to…" }).click();
    const menu = page.locator(".menu__pop--float.is-open");
    await expect(menu.getByRole("menuitemradio", { name: "Home" })).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByRole("menuitemradio")).toHaveText(["Uncategorized", "Home", "Kitchen", "Reading"]);
    await menu.getByRole("menuitemradio", { name: "Kitchen" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Moved to Kitchen." })).toBeVisible();
    await expect(p.locator(".digest-panel__category")).toContainText("Kitchen");
    await expect(p).toContainText("Waiting for the tablet");
    // Still open where it was; it has left Home's list.
    await expect(page).toHaveURL(/category\/c0ffee00000000000000000000000001\/d\/2$/);
    await expect(card(page, "Descale")).toHaveCount(0);
    await expect(p.getByRole("button", { name: "Move to…" })).toBeFocused();
    const kitchen = page.getByRole("navigation", { name: "Categories" }).getByRole("link", { name: /^Kitchen/ });
    await expect(kitchen.locator(".digest-group__count")).toHaveText("2");
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
    await expect(page).toHaveURL(/#\/digest\/d\/2$/);
    await expect(page.locator(".digest-panel")).toBeVisible();
  });

  test("by source: documents and notes together, then typed ones; a document's digests in page order", async ({ page }) => {
    await openDigest(page);
    await page.getByRole("navigation", { name: "Browse digests by" }).getByRole("link", { name: "Sources" }).click();
    await expect(page).toHaveURL(/#\/digest\/sources$/);
    const groups = page.getByRole("navigation", { name: "Sources" });
    await expect(groups.locator(".digest-groups__label")).toHaveText(["Documents & notes"]);
    await expect(groups.getByRole("link", { name: /^Typed on the tablet/ })).toBeVisible();
    await groups.getByRole("link", { name: /^Apartment lease/ }).click();
    await expect(page.locator(".digest-card__page")).toHaveText(["p. 1", "p. 3"]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/sources.png` });

    // A note the library doesn't have: there is nothing to open.
    await groups.getByRole("link", { name: /^Old notebook/ }).click();
    await card(page, "old drawings").click();
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
    await expect(page).toHaveURL(/#\/digest\/d\/1$/);
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
    await expect(page).toHaveURL(/#\/digest$/);
  });

  test("on a phone: one column, the open digest in the list's place", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDigest(page, "/d/1");
    await expect(page.locator(".digest-panel")).toBeVisible();
    await expect(page.locator(".digest-groups")).toBeHidden();
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
