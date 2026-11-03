// Version history for raw-based kinds, addressable previews and PDF annotations.

import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion, railSettled } from "./helpers/app";
import { fakeFileHash } from "../../src/api/fake";

// Fixture: `141` is a 20-page note recognised except at indices 2, 5, 8…; the fake
// gives every `.note` three versions, newest-first.
import { menu, rows } from "./history.shared";

const SPD_BYTES = readFileSync(
  fileURLToPath(new URL("../../../parsers/spd/tests/fixtures/layers_hidden.spd", import.meta.url)),
);

const TXT_BODY = "Shopping list\n\n- oat milk\n- lentils\n\nSee you Sunday.";

// A 2×2 PNG — enough for the reader's <img> to load without error.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAwMTAwMAAAA8EAQFa0S3fAAAAAElFTkSuQmCC",
  "base64",
);

/** Serve `…/history/:md5/raw` by file id and log hits. Register after `signedIn`. */
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

/** Assumes `signedIn` and `serveHistoryRaw` already ran. */
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
    await expect(rows(page)).toHaveCount(3);

    await rows(page).nth(1).click();
    await expect(menu(page)).toBeHidden();

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region).toBeVisible();
    await freezeMotion(page);

    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();
    expect(raw.hits().some((p) => p.startsWith("/api/controlplane/note/174/history/"))).toBe(true);

    const banner = region.locator(".version-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not the current note");
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeVisible();
    await expect(region.getByRole("button", { name: "Version history" })).toBeVisible();
    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();

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

    await expect
      .poll(() => raw.hits().some((p) => p.startsWith("/api/controlplane/note/173/history/")))
      .toBe(true);

    const banner = page.locator(".reader .version-banner");
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeVisible();
    await expect(page.locator(".reader__bar").getByRole("button", { name: "Version history" })).toBeVisible();
    await expect(page.locator(".reader__bar").getByRole("button", { name: "Move to bin" })).toBeHidden();
  });
});

// Resolve order and fallbacks are the shared `openNoteVersion`, proved for `.note` above.
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

    await expect(page).toHaveURL(spdVersionRe);
    const versionUrl = page.url();

    await page.reload();
    await expect(page.getByRole("region", { name: "Sketch viewer" })).toBeVisible();
    await expect(page.locator(".viewer--spd .version-banner")).toContainText("not the current note");
    expect(page.url()).toBe(versionUrl);
  });

  test("a .txt version deep link opened cold resolves to the past preview", async ({ page }) => {
    await signedIn(page);
    await serveHistoryRaw(page);
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
    // The fallback opens the live file off `/file/:id`, so serve it there.
    await page.route(
      (url) => url.pathname.startsWith("/file/"),
      (route) => route.fulfill({ status: 200, contentType: "application/octet-stream", headers: { "x-content-type-options": "nosniff" }, body: SPD_BYTES }),
    );
    // An unknown `:short` degrades to the live file with a notice and a canonical URL.
    await page.goto("/#/note/174/version/0000000");
    await expect(page.getByRole("region", { name: "Sketch viewer" })).toBeVisible();
    await expect(page.locator(".viewer--spd .version-banner")).toBeHidden();
    await expect(page.locator(".toast")).toContainText(/no longer available/i);
    await expect(page).toHaveURL(bareSpdRe);
  });
});

// ---- annotated PDF history ----
// A `.mark` has no card and a `.pdf` has no versions, so the PDF's card offers the
// mark's "Annotation history"; nothing may claim a past version of the document.

const PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/two-page.pdf", import.meta.url)),
);

async function servePdfBytes(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        headers: { "x-content-type-options": "nosniff" },
        body: PDF_BYTES,
      });
    },
  );
}

async function cardMenuFor(page: Page, name: string): Promise<Locator> {
  await page.goto("/#/folder/files");
  await railSettled(page);
  const card = page.locator(".card", { hasText: name });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `Actions for ${name}` }).click();
  return page.locator(".menu-portal");
}

test.describe("annotation history, from the PDF's card", () => {
  test("the ⋯ menu offers Annotation history on an annotated PDF — and never Version history", async ({
    page,
  }) => {
    await signedIn(page);
    const portal = await cardMenuFor(page, "Appliance manual");
    await expect(portal.getByRole("menuitem", { name: "Annotation history" })).toBeVisible();
    // `canPreviewHistory("pdf")` stays false on purpose.
    await expect(portal.getByRole("menuitem", { name: "Version history" })).toHaveCount(0);
  });

  test("a PDF with no annotations offers neither row", async ({ page }) => {
    // 142 has no `.mark`, so there is nothing to offer.
    await signedIn(page);
    await page.goto("/#/folder/document");
    await railSettled(page);
    const card = page.locator(".card", { hasText: "Apartment lease — signed" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Actions for Apartment lease — signed" }).click();
    const portal = page.locator(".menu-portal");
    await expect(portal.getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
    await expect(portal.getByRole("menuitem", { name: "Annotation history" })).toHaveCount(0);
    await expect(portal.getByRole("menuitem", { name: "Version history" })).toHaveCount(0);
  });

  test("it opens the MARK's versions, headed by the DOCUMENT's name and scoped by a caption", async ({
    page,
  }) => {
    await signedIn(page);
    const portal = await cardMenuFor(page, "Appliance manual");
    await portal.getByRole("menuitem", { name: "Annotation history" }).click();
    await expect(menu(page)).toBeVisible();

    await expect(menu(page).locator(".vh__eyebrow")).toHaveText("Annotation history");
    const caption = menu(page).locator(".vh__caption");
    await expect(caption).toContainText("The handwriting on this document");
    await expect(caption).toContainText("only the annotations");
    await expect(caption).toContainText("the document itself is untouched");

    await expect(rows(page)).toHaveCount(3, { timeout: 20_000 });
    await expect(menu(page)).toHaveAttribute("aria-label", "Annotation history for Appliance manual");
  });

  test("previewing a version opens the LIVE document with the older ink over it", async ({ page }) => {
    await signedIn(page);
    await servePdfBytes(page);
    const portal = await cardMenuFor(page, "Appliance manual");
    await portal.getByRole("menuitem", { name: "Annotation history" }).click();
    await expect(rows(page)).toHaveCount(3, { timeout: 20_000 });
    await rows(page).nth(1).click();
    await expect(menu(page)).toBeHidden();

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect(region).toBeVisible();
    await freezeMotion(page);

    const banner = region.locator(".version-banner");
    await expect(banner).toBeVisible();
    // The default banner ends "this is not the current note", false for the document.
    await expect(banner).toContainText("the annotations from");
    await expect(banner).toContainText("the document itself is current");
    await expect(banner).not.toContainText("not the current note");

    await expect(region.locator(".pdf-mark")).toBeHidden();
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    await expect(region.locator(".pdf-mark")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });
  });

  test("Restore restores the annotations, and says so undoably", async ({ page }) => {
    await signedIn(page);
    await servePdfBytes(page);
    const portal = await cardMenuFor(page, "Appliance manual");
    await portal.getByRole("menuitem", { name: "Annotation history" }).click();
    await expect(rows(page)).toHaveCount(3, { timeout: 20_000 });
    await rows(page).nth(1).click();

    const region = page.getByRole("region", { name: "PDF viewer" });
    const banner = region.locator(".version-banner");
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: "Restore this version" }).click();
    const confirm = page.locator("dialog.confirm");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Restore this version" }).click();

    await expect(page.locator(".toast")).toContainText("kept in this file's history");
    await expect(page).toHaveURL(/#\/note\/178/);
    await expect(banner).toBeHidden();
  });
});
