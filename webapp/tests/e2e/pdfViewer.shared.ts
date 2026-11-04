// Helpers shared by the pdfViewer tests.

import { expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";

// Drives the real MuPDF wasm in a browser. The raw-file fetch is a real request, so
// routes serve fixture bytes as the server would.

export const PDF_PATH = fileURLToPath(new URL("../../wasm/tests/fixtures/two-page.pdf", import.meta.url));

export const PDF_BYTES = readFileSync(PDF_PATH);

/**
 * 351 x 468 pt, exactly the device panel's 1404 x 1872 aspect, so no letterbox: all three
 * mark bands land on the page. On `two-page.pdf` only the hidden band would.
 */
export const PANEL_PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/two-page-panel.pdf", import.meta.url)),
);

export async function servePdf(page: Page, body: Buffer = PDF_BYTES): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        headers: { "x-content-type-options": "nosniff" },
        body,
      });
    },
  );
}

/** Fraction of pixels that differ from the background; blank or unpainted reads ~0. */
export async function inkFraction(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector(".pdf-page") as HTMLCanvasElement | null;
    if (!c || !c.width || !c.height) return -1;
    const ctx = c.getContext("2d");
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const lum = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const bg = lum(0);
    let marks = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 10 && Math.abs(lum(i) - bg) > 90) marks++;
    }
    return marks / (data.length / 4);
  });
}

/** Open the annotated fixture; `page2` walks to the one page that has ink. */
export async function openMarkedPdf(page: Page, page2: boolean): Promise<Locator> {
  await signedIn(page);
  await servePdf(page);
  await page.goto("/#/note/178");
  await freezeMotion(page);
  const region = page.getByRole("region", { name: "PDF viewer" });
  await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  if (page2) {
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    // Waiting on a layer canvas proves the stack is up; the layered rows key off it.
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });
  }
  return region;
}

/** Every row of a thumbnail canvas as a fraction of dark pixels, 0..1. */
export async function thumbRowInk(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((c) => {
    const cv = c as HTMLCanvasElement;
    if (!cv.width || !cv.height) return [];
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    const rows: number[] = [];
    for (let y = 0; y < cv.height; y++) {
      let dark = 0;
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        if (d[i + 3]! > 10 && d[i]! < 128) dark++;
      }
      rows.push(dark / cv.width);
    }
    return rows;
  });
}

/** The mean darkness over an inclusive band of thumbnail rows. */
export const band = (rows: number[], from: number, to: number): number =>
  rows.length === 0 ? -1 : rows.slice(from, to + 1).reduce((a, b) => a + b, 0) / (to - from + 1);

/** Open the marked PDF against the panel-aspect fixture, with Pages open. */
export async function openStrip(page: Page): Promise<Locator> {
  await signedIn(page);
  await servePdf(page, PANEL_PDF_BYTES);
  await page.goto("/#/note/178");
  await freezeMotion(page);
  const region = page.getByRole("region", { name: "PDF viewer" });
  await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  const pages = region.getByRole("button", { name: "Pages", exact: true });
  if ((await pages.getAttribute("aria-pressed")) !== "true") await pages.click();
  await expect(region.locator(".filmstrip__thumb:not(.is-loading)")).toHaveCount(2, {
    timeout: 20_000,
  });
  return region;
}
