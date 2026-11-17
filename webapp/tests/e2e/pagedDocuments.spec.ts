// An XPS and a CBZ open in the PDF viewer, as their own kind of file: their
// pages paint, the download row names their type, and the rows that graft a
// PDF page are not offered. Fixtures from the server's tests: three XPS pages
// of one word each, and a CBZ of a 300x400 and a 400x300 image.

import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion, mockThumbnailBackend, railSettled } from "./helpers/app";
import { inkFraction } from "./pdfViewer.shared";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../backend/pdf/testdata/${name}`, import.meta.url)));

const XPS = fixture("text-three-page.xps");
const CBZ = fixture("two-page.cbz");
/** The fake library's ids (`api/fakeFixtures.ts`). */
const BY_ID: Record<string, Buffer> = { "146": XPS, "147": CBZ };

async function serve(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.split("/")[2]! in BY_ID && url.pathname.startsWith("/file/"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "x-content-type-options": "nosniff" },
        body: BY_ID[new URL(route.request().url()).pathname.split("/")[2]!]!,
      }),
  );
}

async function open(page: Page, id: string, viewerName: string, query = "") {
  await signedIn(page);
  await serve(page);
  await page.goto(`/#/note/${id}${query}`);
  await freezeMotion(page);
  // Named for what is open, for a screen reader too.
  const viewer = page.getByRole("region", { name: viewerName });
  await expect(viewer).toBeVisible();
  return viewer;
}

/** The page canvas's centre pixel, as grey levels; null until something is drawn. */
async function centreGrey(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const c = document.querySelector(".viewer--pdf .pdf-page") as HTMLCanvasElement | null;
    if (!c || !c.width || !c.height) return null;
    const d = c.getContext("2d")!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return d[3] === 0 ? null : Math.round((d[0]! + d[1]! + d[2]!) / 3);
  });
}

async function downloadRows(page: Page): Promise<string[]> {
  await page.locator(".viewer--pdf .viewer__export > .btn").click();
  const rows = page.locator(".viewer--pdf .menu__item:visible");
  return (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
}

test("an XPS opens in the document viewer, its pages painted", async ({ page }) => {
  const viewer = await open(page, "146", "XPS document viewer");
  await expect(viewer).toContainText("3 pages");
  await expect.poll(() => inkFraction(page)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Find in this file" })).toBeVisible();

  const rows = await downloadRows(page);
  expect(rows).toContain("XPS document .xps");
  expect(rows.some((r) => r.startsWith("PDF"))).toBe(false);
});

test("a CBZ opens in the document viewer, one page per image", async ({ page }) => {
  const viewer = await open(page, "147", "Comic book viewer");
  await expect(viewer).toContainText("2 pages");
  // Page 1 is one flat grey (200) image: drawn, not a blank sheet.
  await expect.poll(() => centreGrey(page)).toBe(200);
  // Its pages are images: Find stays in its place, dimmed with the reason, as
  // Outline does. Ctrl+F is left to the browser, so the bar stays shut.
  const findField = page.getByRole("textbox", { name: "Find in this file" });
  const find = page.getByRole("button", { name: "Find in this file — this comic book's pages are pictures" });
  await expect(find).toBeVisible();
  await expect(find).toBeDisabled();
  await page.keyboard.press("Control+f");
  await expect(findField).toBeHidden();

  const rows = await downloadRows(page);
  expect(rows).toContain("Comic book .cbz");
  expect(rows.some((r) => r.startsWith("PDF"))).toBe(false);
});

test("a search link to a comic book opens it, without a Find it cannot answer", async ({ page }) => {
  const viewer = await open(page, "147", "Comic book viewer", "?q=harbour");
  await expect(viewer).toContainText("2 pages");
  await expect(page.getByRole("textbox", { name: "Find in this file" })).toBeHidden();
});

test("an XPS and a comic book get their page 1 as a gallery tile, at its shape", async ({ page }) => {
  await signedIn(page);
  await mockThumbnailBackend(page, {});
  await serve(page);
  await page.goto("/");
  await railSettled(page);
  await page.locator(".card--folder", { hasText: "Document" }).click();
  for (const [name, portrait] of [
    ["Quince — a pocket guide", false],
    ["Harbour at dusk", true],
  ] as const) {
    const img = page.locator(".card", { hasText: name }).locator("img.thumb__img");
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.src.startsWith("blob:")), { timeout: 20_000 }).toBe(true);
    const shape = await img.evaluate((e: HTMLImageElement) => ({ w: e.naturalWidth, h: e.naturalHeight }));
    expect(shape.w).toBeGreaterThan(0);
    expect(shape.h > shape.w).toBe(portrait);
  }
});
