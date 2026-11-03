import { test, expect, type Page, type Download } from "@playwright/test";
import { signedIn } from "./helpers/app";
import { readFile } from "node:fs/promises";

// Drives the no-layer note 141; the layered matrix is in noteLayers.spec.ts.

const NOTE = "/#/note/141"; // 20 pages, recognized, known hardware
const UNSCALED = "/#/note/144"; // recognized, but no verified mm scale

const exportBtn = (page: Page) => page.locator(".reader__bar").getByRole("button", { name: "Download" });
// The bar also holds the bin-mode "…" pop; only the export menu has `.menu__head`.
const menu = (page: Page) => page.locator(".reader__bar .menu__pop", { has: page.locator(".menu__head") });
const item = (page: Page, name: string) => menu(page).getByRole("menuitem", { name });
// "PDF document" appears in more than one group, so names are scoped by group header.
const groupItem = (page: Page, head: string, name: string) =>
  menu(page)
    .locator("> div")
    .filter({ has: page.locator(".menu__head", { hasText: head }) })
    .getByRole("menuitem", { name });

/** The reader shows "1 / 1" before metadata lands, and `open()` then closes the menu. */
async function openReader(page: Page, route = NOTE, pages = 20): Promise<void> {
  await signedIn(page);
  await page.goto(route);
  await expect(page.locator(".pager__count")).toHaveValue(`1 / ${pages}`);
}

async function bytesOf(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("download produced no file");
  return readFile(path);
}

test.describe("export menu", () => {
  test("opens from the toolbar and tracks aria-expanded", async ({ page }) => {
    await openReader(page);

    await expect(menu(page)).toBeHidden();
    await expect(exportBtn(page)).toHaveAttribute("aria-expanded", "false");

    await exportBtn(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(exportBtn(page)).toHaveAttribute("aria-expanded", "true");

    await page.locator(".stage").click({ position: { x: 5, y: 5 } });
    await expect(menu(page)).toBeHidden();
    await expect(exportBtn(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("Escape closes the menu without closing the whole reader", async ({ page }) => {
    await openReader(page);
    await exportBtn(page).click();
    await expect(menu(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
  });

  test("shows the two groups a no-layer note gets, and their items", async ({ page }) => {
    await openReader(page);
    await exportBtn(page).click();

    // The original-view group is in the DOM but hidden without a layer stack.
    await expect(menu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "Whole notebook",
    ]);
    await expect(menu(page).locator(".menu__item:visible")).toHaveCount(4);
    await expect(groupItem(page, "Current view", "Flattened image")).toBeVisible();
    await expect(groupItem(page, "Current view", "PDF document")).toBeVisible();
    await expect(groupItem(page, "Whole notebook", "PDF document")).toBeVisible();
    await expect(groupItem(page, "Whole notebook", "Supernote")).toBeVisible();
    await expect(menu(page).getByRole("menuitem", { name: "Layered image" })).toBeHidden();
    await expect(menu(page).getByRole("menuitem", { name: "SVG" })).toHaveCount(0);
  });

  test("the raw Supernote file downloads unchanged from Whole notebook", async ({ page }) => {
    await openReader(page);
    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Whole notebook", "Supernote").click(),
    ]);
    expect(download.url()).toContain("/file/");
  });

  test("Flattened image downloads a real PNG named after the note and page", async ({ page }) => {
    await openReader(page);
    await page.getByRole("button", { name: "Page 3" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("3 / 20");

    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Current view", "Flattened image").click(),
    ]);

    expect(download.suggestedFilename()).toBe("Attention Is All You Need-p3.png");

    const bytes = await bytesOf(download);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(bytes.length).toBeGreaterThan(2000);

    expect(bytes.readUInt32BE(16)).toBe(1404);
  });

  test("PDF downloads one A4-aspect page with a selectable text layer", async ({ page }) => {
    await openReader(page);

    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Current view", "PDF document").click(),
    ]);

    expect(download.suggestedFilename()).toBe("Attention Is All You Need-p1.pdf");

    const pdf = (await bytesOf(download)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("/Count 1"); // this page only, not the notebook
    expect(pdf).toContain("/ColorSpace /DeviceGray");

    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf);
    expect(box).not.toBeNull();
    expect(Number(box![2]) / Number(box![1])).toBeCloseTo(1872 / 1404, 2);

    expect(pdf).toContain("3 Tr");
    expect(pdf).toContain("/BaseFont /Helvetica");
    expect(pdf).toContain(" Tj");

    await expect(page.locator(".toast")).toContainText("can be selected and searched");
  });

  // Unverified mm scale must export raster-only: misplaced invisible text is worse than none.
  test("a note from unverified hardware exports a raster-only PDF, and says so", async ({ page }) => {
    await openReader(page, UNSCALED, 3);

    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Current view", "PDF document").click(),
    ]);

    const pdf = (await bytesOf(download)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toContain("/ColorSpace /DeviceGray");
    expect(pdf).not.toContain("3 Tr");
    expect(pdf).not.toContain(" Tj");

    await expect(page.locator(".toast")).toContainText("cannot be selected or searched");
  });

  test("PDF document exports every page of the notebook as one file", async ({ page }) => {
    test.setTimeout(120_000); // 20 pages, each decoded and compressed in-browser
    await openReader(page);

    await exportBtn(page).click();
    const clicked = groupItem(page, "Whole notebook", "PDF document").click();

    await expect(page.locator(".toast")).toContainText(/page \d+ of 20/);

    const [download] = await Promise.all([page.waitForEvent("download"), clicked]);
    expect(download.suggestedFilename()).toBe("Attention Is All You Need.pdf");

    const pdf = (await bytesOf(download)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("/Count 20");
    expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBe(20);

    const count = 4 + 3 * 20;
    expect(/\/Size (\d+)/.exec(pdf)?.[1]).toBe(String(count));
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
    const rows = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(rows).toHaveLength(count - 1);
    rows.forEach((offset, i) => {
      expect(pdf.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });

    expect(pdf).toContain("3 Tr");
    expect((pdf.match(/Do Q\nendstream/g) ?? []).length).toBe(6);

    await expect(page.locator(".toast")).toContainText("20 pages");
    await expect(page.locator(".toast")).toContainText("can be selected and searched");
  });

  test("a whole-document export from unverified hardware is raster-only", async ({ page }) => {
    await openReader(page, UNSCALED, 3);

    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Whole notebook", "PDF document").click(),
    ]);

    expect(download.suggestedFilename()).toBe("Field notes — unknown device.pdf");

    const pdf = (await bytesOf(download)).toString("latin1");
    expect(pdf).toContain("/Count 3");
    expect(pdf).toContain("/ColorSpace /DeviceGray");
    expect(pdf).not.toContain("3 Tr");
    expect(pdf).not.toContain(" Tj");

    await expect(page.locator(".toast")).toContainText("3 pages");
    await expect(page.locator(".toast")).toContainText("cannot be selected or searched");
  });

  test("the menu is not offered for files that are not notes", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/143"); // an .epub: no viewer, so the reader
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    await expect(exportBtn(page)).toBeHidden();
    await expect(page.locator(".reader__bar").getByRole("link", { name: "Download" })).toBeVisible();
  });
});
