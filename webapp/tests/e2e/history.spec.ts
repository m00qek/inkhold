import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion, railSettled } from "./helpers/app";
import { mockDocText, noteTextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// The "history of this file" UI (hot-cache versioning, phases 3-6): the version
// MENU from a card's ⋯ item (an anchored floating panel, NOT a modal), a read-only
// PREVIEW of a past version in the reused reader (banner + find-in-preview), and
// RESTORE (confirm + toast + refresh).
//
// FIXTURE FACTS. "Attention Is All You Need" (`141`) is a 20-page `.note`
// with recognition on every page except index 2, 5, 8… The fake gives every
// `.note` THREE versions — the current blob plus two retained — newest-first. Its
// transcript carries "budget" on every recognised page, so a find-in-preview for
// it lands real counts.

// The version menu is a popover (`.vh`) portaled into the shared `.menu-portal`,
// not a `<dialog>`. Rows are `.vh-row`; a row CLICK previews (no per-row buttons).
const menu = (page: Page): Locator => page.locator(".vh");
const rows = (page: Page): Locator => page.locator(".vh-row");

/**
 * The version preview's find, served (`golden-search.md` §1.1, §6 step 7).
 *
 * `/note/:id/history/:md5/search` is gone. A preview searches the RETAINED
 * blob's own `text/<md5>` and nothing reroutes anywhere — which is §1.1's
 * "history and bin are not special: they are other md5s" as a fact rather than a
 * claim, because `historyScope.ts` has already rewritten `NoteMeta.fileHash` to
 * the version's address before find sees it.
 *
 * Served through `fallback` rather than by md5, and that is forced: the fake
 * mints a retained version's address from a hash it does not export, so a test
 * cannot name it. What the test CAN name — and asserts below — is the md5 that
 * must NOT be asked for, which is the live note's.
 */
async function mockPreviewText(page: Page): Promise<{ count(md5?: string): number }> {
  return mockDocText(
    page,
    {},
    // The version has 19 pages to the live note's 20, and the same recognition
    // spread — the fake's `versionPageCount`, mirrored.
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

    // A section eyebrow (like the ⋯ menu's DOWNLOAD / ACTIONS), no file-name title.
    await expect(menu(page).locator(".vh__eyebrow")).toHaveText("Version history");

    // Three versions (current + two retained), and ONLY the first carries the
    // Current label — the newest-first, one-live invariant the VO promises.
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(0)).toHaveClass(/is-current/);
    await expect(rows(page).nth(0).locator(".tag-current")).toHaveText("Current");
    await expect(page.locator(".tag-current")).toHaveCount(1);

    // No Viewing marker when opened from a card (nothing is on screen).
    await expect(page.locator(".mark-viewing")).toHaveCount(0);

    // Two-line rows: a relative time on line 1 (absolute in its title on hover), and
    // a content signal on line 2 — the `.note` shows its page count plus a delta.
    // There are NO per-row Preview/Restore buttons any more; the row itself is the
    // control (a `menuitem`).
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
    // The panel gives way to the reader.
    await expect(menu(page)).toBeHidden();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    // The "you're viewing a past version" banner is the clear affordance that
    // this is NOT the live note, and it carries the one action that is safe here.
    const banner = page.locator(".reader .version-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not the current note");
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeVisible();

    // Read-only: the live note's Move to bin is not offered on a version preview.
    await expect(page.locator(".reader__bar").getByRole("button", { name: "Move to bin" })).toBeHidden();

    // It really is the reused reader — the page actually paints — AND it paints
    // the VERSION's OWN geometry (H7), not the live note's. The live note is 20
    // pages; this retained version has 19, sourced from `historyMeta`, so the
    // pager reads "1 / 19". Previously the preview rendered the live note's 20
    // slots (the surplus one a blank 404), which this pins against.
    await expect(page.locator(".pager__count")).toHaveText("1 / 19");
  });

  test("find-in-preview searches the VERSION's own blob, not the live note's", async ({ page }) => {
    await openHistory(page);
    const text = await mockPreviewText(page);
    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    // The reused find bar, running over the retained blob's own text.
    await page.getByRole("button", { name: "Find in this note" }).click();
    const field = page.getByRole("textbox", { name: "Find in this note" });
    await expect(field).toBeFocused();
    await field.fill("budget");

    // The counter settles to a real "N of M" and the filmstrip badges the
    // matching pages. Generous, because this is the session's first find: it pays
    // the wasm instantiate and the index build.
    await expect(page.locator(".findbar__count")).toContainText("of", { timeout: 20_000 });
    await expect(page.locator(".filmstrip__hits").first()).toBeVisible();
    // One-document find over a corpus that contains the word exactly: nothing
    // approximate is claimed, and the opt-in affordance never appears.
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
    await expect(page.locator(".findbar__ask")).toBeHidden();

    // THE REROUTE, AS AN OBSERVATION. One document's text was fetched, and it was
    // not the live note's — `historyScope.ts` rewrote `fileHash` to the version's
    // address before find ever saw it, which is the whole of what "history is not
    // special" means (§1.1). Under the old reroute this was a different ROUTE;
    // now it is the same route with a different key, and the key is checkable.
    expect(text.count()).toBe(1);
    expect(text.count(fakeFileHash("141"))).toBe(0);
  });

  test("find-in-preview draws on-page word ovals from the per-version transcript", async ({ page }) => {
    await openHistory(page);
    await mockPreviewText(page);
    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    // The ink marks — the ovals looped round the matched words on the page — are
    // the half of find that needs `getPageText`. Previously the preview zeroed
    // that out (empty transcript), so a version preview counted matches but drew
    // NO ovals. Now the reroute reads the version's real transcript
    // (`historyPageText`), so the marks paint. `141`'s scale is verified
    // (`pxPerMm` non-null), so the ovals CAN be placed — this pins that they are.
    await page.getByRole("button", { name: "Find in this note" }).click();
    await page.getByRole("textbox", { name: "Find in this note" }).fill("budget");

    // The counter settles first (the index over `text/<md5>`), then the current
    // page's ovals paint from the per-version transcript's word boxes.
    await expect(page.locator(".findbar__count")).toContainText("of", { timeout: 20_000 });
    await expect(page.locator(".reader .findbox").first()).toBeVisible();
    // The "scale unverified, no marks" note stays hidden — the ovals really drew.
    await expect(page.locator(".findbar__note")).toBeHidden();
  });

  test("the .note version's raw download navigates to the history raw route (download=1)", async ({ page }) => {
    await openHistory(page);
    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    // Intercept the version-scoped raw route so the ".note" download becomes a
    // captured download rather than a live navigation. Registered AFTER `signedIn`
    // (via openHistory) so it wins Playwright's newest-first route match over the
    // `/api/` catch-all.
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

    // Open the reader's Download menu and take the one non-transformed row — the
    // whole-notebook raw ".note". In a preview it used to be DISABLED (the live
    // raw route hands back the current blob); now it points at the version's own
    // bytes through `historyFileUrl`, the same route the raw viewers use.
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

    // The confirm is HONEST about being safe/undoable — the replaced version is
    // kept — not a destructive-overwrite warning.
    const confirm = page.locator("dialog.confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/kept in this file's history/i);
    await confirm.getByRole("button", { name: "Restore this version" }).click();

    // The toast says the previous version is retained, and the note reopens as its
    // now-current version (the preview banner is gone).
    await expect(page.locator(".toast")).toContainText(/history/i);
    await expect(page.locator(".reader .version-banner")).toBeHidden();

    // Back to the folder, then reopen the history: the restored version is now
    // Current at the top, and a version was retained (the displaced current), so
    // the list still holds three — restore is undoable by construction.
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

// TO-DOs A + B: the reader toolbar's "Versions" control (discoverability) and
// URL-ADDRESSABLE version previews — a preview is now a place with a URL
// (`#/note/:id/version/:short`, a 7-hex-char md5 prefix), so reload / copy-link /
// deep-link reproduce the previewed version, while the CURRENT version keeps the
// bare note URL.
test.describe("versions in the reader: toolbar control + addressable previews", () => {
  // The 7-char md5 prefix the panel's Preview writes into the address bar.
  const versionUrlRe = /#\/note\/141\/version\/[0-9a-f]{7}$/;
  const bareNoteRe = /#\/note\/141$/;

  test("the reader toolbar's Versions control opens the SAME history panel", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(page.locator(".reader.is-open")).toBeVisible();

    // Gated to a live `.note` (like the card ⋯ menu), in the reader's toolbar.
    const versions = page.locator(".reader__bar").getByRole("button", { name: "Version history" });
    await expect(versions).toBeVisible();
    await versions.click();

    // It routes through the same controller — the same panel, not a second one.
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

    // The address bar now PINS this version rather than describing the live note.
    await expect(page).toHaveURL(versionUrlRe);
    const versionUrl = page.url();

    // A reload reproduces exactly the previewed version: the banner, and the
    // version's OWN 19-page geometry (not the live note's 20).
    await page.reload();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page.locator(".reader .version-banner")).toContainText("not the current note");
    await expect(page.locator(".pager__count")).toHaveText("1 / 19");
    expect(page.url()).toBe(versionUrl);
  });

  test("a version deep link opened cold resolves to the past preview", async ({ page }) => {
    // Derive a real 7-char short from the panel, then hit the URL with no panel.
    await openHistory(page);
    await rows(page).nth(1).click();
    await expect(page).toHaveURL(versionUrlRe);
    const short = page.url().split("/version/")[1]!;

    await page.goto("/#/folder/document");
    await railSettled(page);
    await page.goto(`/#/note/141/version/${short}`);
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page.locator(".reader .version-banner")).toContainText("not the current note");
    await expect(page.locator(".pager__count")).toHaveText("1 / 19");
  });

  test("a short matching the CURRENT md5 canonicalises to the bare note URL (live-first)", async ({ page }) => {
    await openHistory(page);
    await rows(page).nth(1).click();
    await expect(page).toHaveURL(versionUrlRe);
    const short = page.url().split("/version/")[1]!;

    // Restore it: that md5 is now the LIVE version, so its `:short` must resolve
    // as "current" and open the live note, never 404.
    await page.locator(".reader .version-banner").getByRole("button", { name: "Restore this version" }).click();
    const confirm = page.locator("dialog.confirm");
    await confirm.getByRole("button", { name: "Restore this version" }).click();
    await expect(page.locator(".reader .version-banner")).toBeHidden();

    await page.goto(`/#/note/141/version/${short}`);
    await expect(page.locator(".reader.is-open")).toBeVisible();
    // The live note, no preview banner, and the URL rewritten to the bare form.
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

    // Previously hidden in preview mode; now shown so you can pick another version
    // without leaving. It routes through the SAME controller — the same panel.
    const versions = page.locator(".reader__bar").getByRole("button", { name: "Version history" });
    await expect(versions).toBeVisible();
    await versions.click();
    await expect(menu(page)).toBeVisible();
    await expect(rows(page)).toHaveCount(3);

    // Opened MID-PREVIEW: the version on screen (the retained one previewed above,
    // row 1) is marked `Viewing` — the selection channel — with its accent rail +
    // tint, distinct from the `Current` label on the live version (row 0). Exactly
    // one of each, and the newest version is not the one being viewed.
    await expect(page.locator(".mark-viewing")).toHaveCount(1);
    await expect(rows(page).nth(1)).toHaveClass(/is-viewing/);
    await expect(rows(page).nth(1).locator(".mark-viewing")).toContainText("Viewing");
    await expect(rows(page).nth(0)).toHaveClass(/is-current/);
    await expect(rows(page).nth(0)).not.toHaveClass(/is-viewing/);
  });
});

// TASK 2: history browsing for the CLIENT-SIDE-rendered kinds — `.spd` (spdViewer +
// spd_decode), `.txt` (txtViewer), and images (reader image mode). Each opens the
// SAME version list from the card ⋯ menu, previews a past version rendered from the
// version's RAW bytes (`…/history/:md5/raw`), and gets the read-only version chrome:
// the banner, Restore, and a Versions control to reopen the list.

const SPD_BYTES = readFileSync(
  fileURLToPath(new URL("../../../parsers/spd/tests/fixtures/layers_hidden.spd", import.meta.url)),
);
const TXT_BODY = "Shopping list\n\n- oat milk\n- lentils\n\nSee you Sunday.";
// A 2×2 PNG — enough for the reader's <img> to load without error.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAwMTAwMAAAA8EAQFa0S3fAAAAAElFTkSuQmCC",
  "base64",
);

/**
 * Serve the version-scoped raw route (`…/history/:md5/raw`) for the Files
 * fixtures, by file id — the REAL browser fetch the raw viewers make (the library
 * itself runs against the fake `Api`). Returns the hit log so a test can assert the
 * version's bytes came off the HISTORY route, not the live `/file/:id`.
 *
 * MUST be registered AFTER `signedIn` (whose `mockApi` installs a `/api/`
 * catch-all): Playwright matches routes newest-first, so this more-specific route
 * has to win over that catch-all.
 */
async function serveHistoryRaw(page: Page): Promise<{ hits: () => string[] }> {
  const hits: string[] = [];
  await page.route(
    (url) => /\/api\/controlplane\/note\/[^/]+\/history\/[^/]+\/raw$/.test(url.pathname),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      hits.push(path);
      const id = decodeURIComponent(path.split("/note/")[1]!.split("/history/")[0]!);
      const nosniff = { "x-content-type-options": "nosniff" };
      if (id === "174") {
        await route.fulfill({ status: 200, contentType: "application/octet-stream", headers: nosniff, body: SPD_BYTES });
      } else if (id === "177") {
        await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", headers: nosniff, body: TXT_BODY });
      } else {
        await route.fulfill({ status: 200, contentType: "image/png", headers: nosniff, body: TINY_PNG });
      }
    },
  );
  return { hits: () => hits };
}

/** Open the version history for a named card in the Files folder (one of every
 *  previewable kind lives there). Assumes `signedIn` + `serveHistoryRaw` already
 *  ran; mirrors `openHistory` for the DOCUMENT folder otherwise. */
async function openFilesHistory(page: Page, name: string): Promise<void> {
  await page.goto("/#/folder/files");
  await railSettled(page);
  const card = page.locator(".card", { hasText: name });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.locator(".menu-portal").getByRole("menuitem", { name: "Version history" }).click();
  await expect(menu(page)).toBeVisible();
}

test.describe("version history — raw-based kinds (.spd / .txt / image)", () => {
  test("a past .spd version renders in the sketch viewer, off the history raw route, with the version chrome", async ({ page }) => {
    await signedIn(page);
    const raw = await serveHistoryRaw(page);
    await openFilesHistory(page, "Kitchen sketch");
    // The kind now accrues history (current + two retained), like a `.note`.
    await expect(rows(page)).toHaveCount(3);

    await rows(page).nth(1).click();
    await expect(menu(page)).toBeHidden();

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region).toBeVisible();
    await freezeMotion(page);

    // The real decoder rendered the VERSION — a per-layer canvas stack — and its
    // bytes came off the version-scoped history route (not the live `/file/`).
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();
    expect(raw.hits().some((p) => p.startsWith("/api/controlplane/note/174/history/"))).toBe(true);

    // The read-only version chrome: banner + Restore + Versions; no Move to bin.
    const banner = region.locator(".version-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not the current note");
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeVisible();
    await expect(region.getByRole("button", { name: "Version history" })).toBeVisible();
    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();

    // The Versions control reopens the SAME list.
    await region.getByRole("button", { name: "Version history" }).click();
    await expect(menu(page)).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
  });

  test("a past .txt version renders in the text viewer, off the history raw route, with the version chrome", async ({ page }) => {
    await signedIn(page);
    const raw = await serveHistoryRaw(page);
    await openFilesHistory(page, "readme");
    await expect(rows(page)).toHaveCount(3);

    await rows(page).nth(1).click();
    await expect(menu(page)).toBeHidden();

    const region = page.getByRole("region", { name: "Text viewer" });
    await expect(region).toBeVisible();

    // The version's text is laid out (fetched off the history raw route).
    await expect(region.locator(".txt__sheet")).toContainText("Shopping list");
    expect(raw.hits().some((p) => p.startsWith("/api/controlplane/note/177/history/"))).toBe(true);

    const banner = region.locator(".version-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not the current note");
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeVisible();
    await expect(region.getByRole("button", { name: "Version history" })).toBeVisible();
    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();
  });

  test("a past image version opens in the reader's image mode, off the history raw route, with the version chrome", async ({ page }) => {
    await signedIn(page);
    const raw = await serveHistoryRaw(page);
    await openFilesHistory(page, "Screenshot — dashboard");
    await expect(rows(page)).toHaveCount(3);

    await rows(page).nth(1).click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    // The image's bytes came off the version-scoped history route.
    await expect
      .poll(() => raw.hits().some((p) => p.startsWith("/api/controlplane/note/173/history/")))
      .toBe(true);

    // The read-only version chrome in the reader: banner + Restore + the toolbar
    // Versions control (now shown for an image preview too); no Move to bin.
    const banner = page.locator(".reader .version-banner");
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeVisible();
    await expect(page.locator(".reader__bar").getByRole("button", { name: "Version history" })).toBeVisible();
    await expect(page.locator(".reader__bar").getByRole("button", { name: "Move to bin" })).toBeHidden();
  });
});

// The raw kinds are now URL-ADDRESSABLE like `.note`: opening a `.spd`/`.txt`/image
// version writes the `#/note/:id/version/:short` form (a 7-hex prefix), so reload /
// copy-link / cold deep-link reproduce the previewed version, while the CURRENT
// version keeps the bare `#/note/:id`. The resolve order (live-first) and the
// current-canonicalise / age-out fallbacks are the SHARED `openNoteVersion` path,
// already proved for `.note` above; these cover the raw viewers' open paths.
test.describe("addressable version previews — raw-based kinds (.spd / .txt / image)", () => {
  const spdVersionRe = /#\/note\/174\/version\/[0-9a-f]{7}$/;
  const bareSpdRe = /#\/note\/174$/;

  test("opening a .spd version via the panel addresses it; a reload reopens the same version", async ({ page }) => {
    await signedIn(page);
    await serveHistoryRaw(page);
    await openFilesHistory(page, "Kitchen sketch");
    await rows(page).nth(1).click();

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region).toBeVisible();
    await expect(region.locator(".version-banner")).toBeVisible();
    await freezeMotion(page);

    // The address bar now PINS this version rather than describing the live file.
    await expect(page).toHaveURL(spdVersionRe);
    const versionUrl = page.url();

    // A reload reproduces exactly the previewed version — the sketch viewer with
    // its read-only banner, at the same address.
    await page.reload();
    await expect(page.getByRole("region", { name: "Sketch viewer" })).toBeVisible();
    await expect(page.locator(".viewer--spd .version-banner")).toContainText("not the current note");
    expect(page.url()).toBe(versionUrl);
  });

  test("a .txt version deep link opened cold resolves to the past preview", async ({ page }) => {
    await signedIn(page);
    await serveHistoryRaw(page);
    // Derive a real 7-char short from the panel, then hit the URL with no panel up.
    await openFilesHistory(page, "readme");
    await rows(page).nth(1).click();
    await expect(page).toHaveURL(/#\/note\/177\/version\/[0-9a-f]{7}$/);
    const short = page.url().split("/version/")[1]!;

    await page.goto("/#/folder/files");
    await railSettled(page);
    await page.goto(`/#/note/177/version/${short}`);

    const region = page.getByRole("region", { name: "Text viewer" });
    await expect(region).toBeVisible();
    await expect(region.locator(".txt__sheet")).toContainText("Shopping list");
    await expect(region.locator(".version-banner")).toContainText("not the current note");
  });

  test("an image version deep link opened cold resolves to the reader's image preview", async ({ page }) => {
    await signedIn(page);
    await serveHistoryRaw(page);
    await openFilesHistory(page, "Screenshot — dashboard");
    await rows(page).nth(1).click();
    await expect(page).toHaveURL(/#\/note\/173\/version\/[0-9a-f]{7}$/);
    const short = page.url().split("/version/")[1]!;

    await page.goto("/#/folder/files");
    await railSettled(page);
    await page.goto(`/#/note/173/version/${short}`);

    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page.locator(".reader .version-banner")).toContainText("not the current note");
  });

  test("an unknown short for a .spd falls back to the LIVE sketch + a notice (bare URL)", async ({ page }) => {
    await signedIn(page);
    await serveHistoryRaw(page);
    // The fallback opens the LIVE sketch, which fetches the current blob off
    // `/file/:id` — serve the fixture there so the live render is real, not a 404.
    await page.route(
      (url) => url.pathname.startsWith("/file/"),
      (route) => route.fulfill({ status: 200, contentType: "application/octet-stream", headers: { "x-content-type-options": "nosniff" }, body: SPD_BYTES }),
    );
    // Cold-load a `:short` that names no retained version (aged out / bad prefix):
    // the shared resolve degrades to the live file in its own viewer + a notice,
    // never a hard error, and the address is canonicalised to the bare note URL.
    await page.goto("/#/note/174/version/0000000");
    await expect(page.getByRole("region", { name: "Sketch viewer" })).toBeVisible();
    await expect(page.locator(".viewer--spd .version-banner")).toBeHidden();
    await expect(page.locator(".toast")).toContainText(/no longer available/i);
    await expect(page).toHaveURL(bareSpdRe);
  });
});
