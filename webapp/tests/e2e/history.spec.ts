import { test, expect, type Page } from "@playwright/test";
import { signedIn, freezeMotion, railSettled } from "./helpers/app";
import { mockDocText, noteTextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// Fixture: `141` is a 20-page note recognised except at indices 2, 5, 8…; the fake
// gives every `.note` three versions, newest-first.
import { menu, rows } from "./history.shared";

/**
 * A preview searches the retained blob's own `text/<md5>`. Served via `fallback`
 * because the fake does not export retained md5s; the test asserts the live md5 is not asked for.
 */
async function mockPreviewText(page: Page): Promise<{ count(md5?: string): number }> {
  return mockDocText(
    page,
    {},
    // The fake's `versionPageCount`: 19 pages to the live note's 20.
    { fallback: noteTextRecord("Attention Is All You Need", 19) },
  );
}

async function openHistory(page: Page): Promise<void> {
  await signedIn(page);
  await page.goto("/#/folder/document");
  await railSettled(page);
  const card = page.locator(".card", { hasText: "Attention Is All You Need" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Actions for Attention Is All You Need" }).click();
  await page.locator(".menu-portal").getByRole("menuitem", { name: "Version history" }).click();
  await expect(menu(page)).toBeVisible();
}

test.describe("version history", () => {
  test("the ⋯ menu opens the floating panel: versions newest-first, the live one labelled Current", async ({ page }) => {
    await openHistory(page);

    await expect(menu(page).locator(".vh__eyebrow")).toHaveText("Version history");

    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(0)).toHaveClass(/is-current/);
    await expect(rows(page).nth(0).locator(".tag-current")).toHaveText("Current");
    await expect(page.locator(".tag-current")).toHaveCount(1);

    await expect(page.locator(".mark-viewing")).toHaveCount(0);

    await expect(rows(page).nth(0).locator("button")).toHaveCount(0);
    await expect(rows(page).nth(0).locator(".vh-pages")).toContainText("pages");
    await expect(rows(page).nth(1).locator(".vh-delta")).toBeVisible();
    const when = rows(page).nth(1).locator(".vh-when");
    await expect(when).not.toHaveText("");
    expect(await when.getAttribute("title")).toBeTruthy();
  });

  test("previewing a past version (a row click) opens the reused reader in read-only mode with a banner", async ({ page }) => {
    await openHistory(page);

    await rows(page).nth(1).click();
    await expect(menu(page)).toBeHidden();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    const banner = page.locator(".reader .version-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not the current note");
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeVisible();

    await expect(page.locator(".reader__bar").getByRole("button", { name: "Move to bin" })).toBeHidden();

    // Regression: the preview rendered the live note's 20 slots instead of the version's 19.
    await expect(page.locator(".pager__count")).toHaveValue("1 / 19");
  });

  test("find-in-preview searches the VERSION's own blob, not the live note's", async ({ page }) => {
    await openHistory(page);
    const text = await mockPreviewText(page);
    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    await page.getByRole("button", { name: "Find in this note" }).click();
    const field = page.getByRole("textbox", { name: "Find in this note" });
    await expect(field).toBeFocused();
    await field.fill("budget");

    // Generous: the session's first find pays wasm instantiation and the index build.
    await expect(page.locator(".findbar__count")).toContainText("of", { timeout: 20_000 });
    await expect(page.locator(".filmstrip__hits").first()).toBeVisible();
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
    await expect(page.locator(".findbar__ask")).toBeHidden();

    // `historyScope.ts` rewrote `fileHash` to the version's address before find saw it.
    expect(text.count()).toBe(1);
    expect(text.count(fakeFileHash("141"))).toBe(0);
  });

  test("find-in-preview draws on-page word ovals from the per-version transcript", async ({ page }) => {
    await openHistory(page);
    await mockPreviewText(page);
    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    // Regression: the preview counted matches but drew no ovals (empty transcript).
    await page.getByRole("button", { name: "Find in this note" }).click();
    await page.getByRole("textbox", { name: "Find in this note" }).fill("budget");

    await expect(page.locator(".findbar__count")).toContainText("of", { timeout: 20_000 });
    await expect(page.locator(".reader .findbox").first()).toBeVisible();
    await expect(page.locator(".findbar__note")).toBeHidden();
  });

  test("the .note version's raw download navigates to the history raw route (download=1)", async ({ page }) => {
    await openHistory(page);
    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    // Registered after `signedIn` so it wins newest-first matching over the catch-all.
    await page.route(
      (url) => /\/api\/controlplane\/note\/[^/]+\/history\/[^/]+\/raw$/.test(url.pathname),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          headers: { "content-disposition": 'attachment; filename="version.note"' },
          body: Buffer.from([0x01, 0x02, 0x03]),
        }),
    );

    await page.locator(".reader__bar").getByRole("button", { name: "Download" }).click();
    const rawItem = page.locator(".reader__bar").getByRole("menuitem", { name: "Supernote" });
    await expect(rawItem).toBeEnabled();

    const download = page.waitForEvent("download");
    await rawItem.click();
    const url = new URL((await download).url());
    expect(url.pathname).toMatch(/^\/api\/controlplane\/note\/141\/history\/[0-9a-f]+\/raw$/);
    expect(url.searchParams.get("download")).toBe("1");
  });

  test("restore confirms with undoable framing, then toasts and refreshes", async ({ page }) => {
    await openHistory(page);
    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    await page.locator(".reader .version-banner").getByRole("button", { name: "Restore this version" }).click();

    const confirm = page.locator("dialog.confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/kept in this file's history/i);
    await confirm.getByRole("button", { name: "Restore this version" }).click();

    await expect(page.locator(".toast")).toContainText(/history/i);
    await expect(page.locator(".reader .version-banner")).toBeHidden();

    // The displaced current is retained, so the list still holds three.
    await page.goto("/#/folder/document");
    await railSettled(page);
    const card = page.locator(".card", { hasText: "Attention Is All You Need" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Actions for Attention Is All You Need" }).click();
    await page.locator(".menu-portal").getByRole("menuitem", { name: "Version history" }).click();
    await expect(menu(page)).toBeVisible();
    await expect(rows(page).nth(0)).toHaveClass(/is-current/);
    await expect(page.locator(".tag-current")).toHaveCount(1);
  });
});

// Previews are addressable as `#/note/:id/version/:short` (7-hex md5 prefix); the
// current version keeps the bare note URL.
test.describe("versions in the reader: toolbar control + addressable previews", () => {
  const versionUrlRe = /#\/note\/141\/version\/[0-9a-f]{7}$/;
  const bareNoteRe = /#\/note\/141$/;

  test("the reader toolbar's Versions control opens the SAME history panel", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(page.locator(".reader.is-open")).toBeVisible();

    const versions = page.locator(".reader__bar").getByRole("button", { name: "Version history" });
    await expect(versions).toBeVisible();
    await versions.click();

    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator(".vh__eyebrow")).toHaveText("Version history");
    await expect(rows(page)).toHaveCount(3);
  });

  test("opening a version via the panel addresses it; a reload reopens the same version", async ({ page }) => {
    await openHistory(page);
    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page.locator(".reader .version-banner")).toBeVisible();
    await freezeMotion(page);

    await expect(page).toHaveURL(versionUrlRe);
    const versionUrl = page.url();

    await page.reload();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page.locator(".reader .version-banner")).toContainText("not the current note");
    await expect(page.locator(".pager__count")).toHaveValue("1 / 19");
    expect(page.url()).toBe(versionUrl);
  });

  test("a version deep link opened cold resolves to the past preview", async ({ page }) => {
    await openHistory(page);
    await rows(page).nth(1).click();
    await expect(page).toHaveURL(versionUrlRe);
    const short = page.url().split("/version/")[1]!;

    await page.goto("/#/folder/document");
    await railSettled(page);
    await page.goto(`/#/note/141/version/${short}`);
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page.locator(".reader .version-banner")).toContainText("not the current note");
    await expect(page.locator(".pager__count")).toHaveValue("1 / 19");
  });

  test("a short matching the CURRENT md5 canonicalises to the bare note URL (live-first)", async ({ page }) => {
    await openHistory(page);
    await rows(page).nth(1).click();
    await expect(page).toHaveURL(versionUrlRe);
    const short = page.url().split("/version/")[1]!;

    // That md5 is now live, so its `:short` must resolve as current, never 404.
    await page.locator(".reader .version-banner").getByRole("button", { name: "Restore this version" }).click();
    const confirm = page.locator("dialog.confirm");
    await confirm.getByRole("button", { name: "Restore this version" }).click();
    await expect(page.locator(".reader .version-banner")).toBeHidden();

    await page.goto(`/#/note/141/version/${short}`);
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page.locator(".reader .version-banner")).toBeHidden();
    await expect(page).toHaveURL(bareNoteRe);
  });

  test("an unknown short (aged out of the hot cache) falls back to the live note + a notice", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141/version/0000000");
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page.locator(".reader .version-banner")).toBeHidden();
    await expect(page.locator(".toast")).toContainText(/no longer available/i);
    await expect(page).toHaveURL(bareNoteRe);
  });

  test("the Versions control is shown WHILE previewing a past .note version, and reopens the list", async ({ page }) => {
    await openHistory(page);
    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page.locator(".reader .version-banner")).toBeVisible();

    const versions = page.locator(".reader__bar").getByRole("button", { name: "Version history" });
    await expect(versions).toBeVisible();
    await versions.click();
    await expect(menu(page)).toBeVisible();
    await expect(rows(page)).toHaveCount(3);

    await expect(page.locator(".mark-viewing")).toHaveCount(1);
    await expect(rows(page).nth(1)).toHaveClass(/is-viewing/);
    await expect(rows(page).nth(1).locator(".mark-viewing")).toContainText("Viewing");
    await expect(rows(page).nth(0)).toHaveClass(/is-current/);
    await expect(rows(page).nth(0)).not.toHaveClass(/is-viewing/);
  });
});

// `.spd`, `.txt` and images preview a version from its raw bytes (`…/history/:md5/raw`).
