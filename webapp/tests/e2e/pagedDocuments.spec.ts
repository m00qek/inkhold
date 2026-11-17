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
    // Polled: a slow tile shows the type's glyph first, a portrait of its own.
    await expect
      .poll(
        () =>
          img.evaluate((e: HTMLImageElement) =>
            e.src.startsWith("blob:") && e.naturalWidth > 0 ? e.naturalHeight > e.naturalWidth : null,
          ),
        { timeout: 20_000 },
      )
      .toBe(portrait);
  }
});

test("the tablet's handwriting on an XPS paints on its page, as a PDF's does", async ({ page }) => {
  // The fake mark's one page has no `sourcePage`, as the wire sends ink on page 1.
  const viewer = await open(page, "146", "XPS document viewer");
  await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });
  await expect(viewer.getByRole("button", { name: "Annotations" })).toBeVisible();

  const pages = viewer.getByRole("button", { name: "Pages", exact: true });
  if ((await pages.getAttribute("aria-pressed")) !== "true") await pages.click();
  await expect(viewer.locator(".filmstrip__page--inked")).toHaveCount(1);
  await expect(viewer.locator(".filmstrip__page").first()).toHaveClass(/filmstrip__page--inked/);
});

/** Dark pixels in the bottom tenth of an `<img>`, 0..1: where the fake mark's ink band lies. */
async function bottomInk(img: import("@playwright/test").Locator): Promise<number> {
  return img.evaluate((e: HTMLImageElement) => {
    const c = document.createElement("canvas");
    c.width = e.naturalWidth;
    c.height = e.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(e, 0, 0);
    const top = Math.floor(c.height * 0.9);
    const d = ctx.getImageData(0, top, c.width, c.height - top).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 100) dark++;
    return dark / (d.length / 4);
  });
}

test("a tile is page 1 as the person sees it: with the tablet's ink on it", async ({ page }) => {
  // The fake XPS's mark writes on page 1 (`coverInkHash`); the comic has no mark.
  await signedIn(page);
  await mockThumbnailBackend(page, {});
  await serve(page);
  await page.goto("/");
  await railSettled(page);
  await page.locator(".card--folder", { hasText: "Document" }).click();
  const tile = (name: string) => page.locator(".card", { hasText: name }).locator("img.thumb__img");
  for (const name of ["Quince — a pocket guide", "Harbour at dusk"]) {
    await expect
      .poll(() => tile(name).evaluate((e: HTMLImageElement) => e.src.startsWith("blob:")), { timeout: 20_000 })
      .toBe(true);
  }
  await expect.poll(() => bottomInk(tile("Quince — a pocket guide")), { timeout: 20_000 }).toBeGreaterThan(0.2);

  // The control is the same XPS's page alone: the viewer draws the page on its
  // own canvas, the ink on a layer above it, and the page has nothing there.
  await page.goto("/#/note/146");
  await freezeMotion(page);
  await expect(page.getByRole("region", { name: "XPS document viewer" })).toBeVisible();
  await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0);
  const pageBottom = await page.evaluate(() => {
    const c = document.querySelector(".viewer--pdf .pdf-page") as HTMLCanvasElement;
    const top = Math.floor(c.height * 0.9);
    const d = c.getContext("2d")!.getImageData(0, top, c.width, c.height - top).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 100) dark++;
    return dark / (d.length / 4);
  });
  expect(pageBottom).toBeLessThan(0.05);
});
