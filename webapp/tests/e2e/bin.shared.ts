// Helpers shared by the bin tests.

import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { railSettled } from "./helpers/app";
import { fakeFileHash } from "../../src/api/fake";

// Fixture `src/api/binFake.ts`: a folder trashed with two notes, plus an older note four
// days from expiry. Trash never confirms and purge always does; `renderGallery()`
// overwriting the gallery is what closes the bin and leaves bin mode.

/** The bin's rail row, by its exact name (ignoring the count badge). */
export function binRow(page: Page) {
  return page
    .getByRole("navigation", { name: "Folders" })
    .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Recycle bin$/ }) });
}

export async function openBin(page: Page): Promise<void> {
  await railSettled(page);
  await binRow(page).click();
  await expect(page.locator(".bin")).toBeVisible();
}

/** Row actions live behind the shared "…" menu; the trigger names the row. */
export function binRowOf(page: Page, rowText: string) {
  return page.locator(".bin__row", { hasText: rowText }).first();
}

/** Retried as a unit: the bin repaints after its own refresh, detaching a fresh menu. */
export async function openRowMenu(page: Page, rowText: string, name: string) {
  const row = binRowOf(page, rowText);
  await expect(async () => {
    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    // Portaled to `.menu-portal`, so located at page scope.
    await expect(page.locator(".menu-portal .menu__pop")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
  return row;
}

/** Retried: a viewer can repaint just after mounting and detach the menu. */
export async function openFileActions(page: Page, cluster: Locator): Promise<void> {
  await expect(async () => {
    await cluster.getByRole("button", { name: "File actions" }).click();
    await expect(page.locator(".menu-portal .menu__pop")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

/** Open and click retried as one unit; `toPass` stops once the click lands, so it runs once. */
export async function chooseMenuItem(page: Page, trigger: Locator, item: string): Promise<void> {
  await expect(async () => {
    await trigger.click();
    const el = page.locator(".menu-portal").getByRole("menuitem", { name: item });
    await expect(el).toBeVisible({ timeout: 1000 });
    await el.click({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

// --- raw bytes for the non-note viewers ---
// Live and bin raw routes are served separately; which one a viewer mints is under test.

export const PDF_PATH = fileURLToPath(new URL("../../wasm/tests/fixtures/two-page.pdf", import.meta.url));

export const PDF_BYTES = readFileSync(PDF_PATH);

/** Serve both raw-file routes with `body`; returns the bin route's hit tally. */
export async function serveRawBytes(page: Page, contentType: string, body: Buffer | string): Promise<{ binHits: () => number }> {
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

export function reader(page: Page): Locator {
  return page.locator(".reader");
}
