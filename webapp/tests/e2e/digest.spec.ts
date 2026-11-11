import { test, expect, type Page } from "@playwright/test";
import { signedIn } from "./helpers/app";

// Digest against the fake API (`api/fakeDigest.ts`): seven digests in Home,
// Kitchen and Uncategorized ("Reading" is empty), from two PDFs, an EPUB, two
// notes (one not in the library) and one typed on the tablet. The first,
// from the lease's page 3, has a handwritten note.

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
    await box.fill("Every three months, or the boiler scales");
    await p.getByRole("button", { name: "Save comment" }).click();
    await expect(box).toHaveCount(0);
    await expect(p).toContainText("Every three months, or the boiler scales");
    await expect(p).toContainText("Waiting for the tablet");
    await expect(card(page, "Descale")).toContainText("Waiting for the tablet");
    await expect(p.getByRole("button", { name: "Edit" })).toBeFocused();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/comment.png` });
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

  test("by source: documents, notes and typed ones; a document's digests in page order", async ({ page }) => {
    await openDigest(page);
    await page.getByRole("navigation", { name: "Browse digests by" }).getByRole("link", { name: "Sources" }).click();
    await expect(page).toHaveURL(/#\/digest\/sources$/);
    const groups = page.getByRole("navigation", { name: "Sources" });
    await expect(groups.locator(".digest-groups__label")).toHaveText(["Documents", "Notes"]);
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
});

