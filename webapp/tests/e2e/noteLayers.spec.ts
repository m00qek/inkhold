import { test, expect, type Download, type Page } from "@playwright/test";
import { asSaved } from "./helpers/download";
import { readFile } from "node:fs/promises";
import { cardButton, signedIn, freezeMotion } from "./helpers/app";

// Fixture `104` (src/api/layeredFixture.ts): page 1 has a real SNPG v2 layered
// payload with a device-hidden Layer 2; page 2 has no layers.

const reader = (page: Page) => page.getByRole("region", { name: "Reader" });
const layersBtn = (page: Page) => reader(page).getByRole("button", { name: "Layers" });
const panel = (page: Page) => reader(page).locator(".note-layers");
const stackCanvases = (page: Page) => reader(page).locator(".note-stack canvas");
const exportBtn = (page: Page) => reader(page).getByRole("button", { name: "Download" });
// The bar also holds the bin-mode "…" pop; only the export menu has `.menu__head`.
const menu = (page: Page) => page.locator(".reader__bar .menu__pop", { has: page.locator(".menu__head") });

async function openLayered(page: Page): Promise<void> {
  await signedIn(page);
  await page.goto("/#/note/104");
  await freezeMotion(page);
  await expect(page.locator(".pager__count")).toHaveValue("1 / 2");
  await expect(stackCanvases(page)).toHaveCount(4);
}

/** Red channel of one composed pixel at `row`: 0 = band inked, 255 = paper, −1 = not ready. */
async function stackPixel(page: Page, row: number): Promise<number> {
  return page.evaluate((r) => {
    const wrap = document.querySelector(".note-stack");
    if (!wrap) return -1;
    const canvases = Array.from(wrap.querySelectorAll("canvas")) as HTMLCanvasElement[];
    if (canvases.length === 0 || !canvases[0]!.width) return -1;
    const w = canvases[0]!.width;
    const h = canvases[0]!.height;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    if (!ctx) return -1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    for (const c of canvases) {
      if (getComputedStyle(c).display === "none") continue;
      ctx.drawImage(c, 0, 0);
    }
    return ctx.getImageData(Math.floor(w / 2), r, 1, 1).data[0]!;
  }, row);
}

async function bytesOf(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("download produced no file");
  return readFile(path);
}

test.describe(".note layers panel (real decoder)", () => {
  test("stacks one canvas per record; the panel lists device names top-first", async ({ page }) => {
    await openLayered(page);

    await expect(stackCanvases(page).nth(2)).toHaveCSS("display", "none");
    await expect(stackCanvases(page).nth(1)).not.toHaveCSS("display", "none");

    await expect(reader(page).locator(".page > canvas").first()).toBeHidden();

    await expect(layersBtn(page)).toBeEnabled();
    await expect(layersBtn(page)).toHaveAttribute("aria-pressed", "false");
    await layersBtn(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(layersBtn(page)).toHaveAttribute("aria-pressed", "true");

    await expect(panel(page).locator(".note-layer__name")).toHaveText([
      "Layer Renamed",
      "Layer 2",
      "Main Layer",
      "Background Layer",
    ]);

    const layer2 = panel(page).locator(".note-layer", { hasText: "Layer 2" });
    await expect(layer2).toHaveClass(/is-hidden/);
    await expect(layer2.locator(".note-layer__eye")).toHaveAttribute("aria-pressed", "false");
    await expect(panel(page).locator(".layers-panel__bar")).toHaveCount(0);
  });

  test("eye toggles repaint the stack: hidden ON adds its ink, visible OFF removes it", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();

    await expect.poll(() => stackPixel(page, 300), { timeout: 10_000 }).toBeLessThan(10);
    await expect.poll(() => stackPixel(page, 900)).toBeGreaterThan(250);

    await panel(page).getByRole("button", { name: "Toggle Layer 2" }).click();
    await expect.poll(() => stackPixel(page, 900)).toBeLessThan(10);

    await panel(page).getByRole("button", { name: "Toggle Main Layer" }).click();
    await expect.poll(() => stackPixel(page, 300)).toBeGreaterThan(250);

    await panel(page).getByRole("button", { name: "Toggle Main Layer" }).click();
    await expect.poll(() => stackPixel(page, 300)).toBeLessThan(10);
  });

  test("the ORIGINAL-view group is hidden until a layer is toggled", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();
    await expect(panel(page)).toBeVisible();

    // Nothing toggled, so current == original and the original group stays hidden.
    await exportBtn(page).click();
    await expect(menu(page).locator(".menu__head", { hasText: "Current view" })).toBeVisible();
    await expect(menu(page).locator(".menu__head", { hasText: "Original view" })).toBeHidden();
    await expect(menu(page).getByRole("menuitem", { name: "Layered image" })).toHaveCount(1); // current only
    await page.keyboard.press("Escape");

    await panel(page).getByRole("button", { name: "Toggle Layer 2" }).click();
    await expect.poll(() => stackPixel(page, 900), { timeout: 10_000 }).toBeLessThan(10);
    await exportBtn(page).click();
    await expect(menu(page).locator(".menu__head", { hasText: "Original view" })).toBeVisible();
  });

  test("the export menu gains the layered matrix; ORA carries live vs authored visibility", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();
    await panel(page).getByRole("button", { name: "Toggle Layer 2" }).click();
    await expect.poll(() => stackPixel(page, 900), { timeout: 10_000 }).toBeLessThan(10);

    await exportBtn(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator(".menu__head", { hasText: "Current view" })).toBeVisible();
    await expect(menu(page).locator(".menu__head", { hasText: "Original view" })).toBeVisible();
    const flats = menu(page).getByRole("menuitem", { name: "Flattened image" });
    const oras = menu(page).getByRole("menuitem", { name: "Layered image" });
    await expect(flats).toHaveCount(2); // current + original
    await expect(oras).toHaveCount(2);

    const [oraCurrent] = await Promise.all([page.waitForEvent("download"), oras.nth(0).click()]);
    expect(oraCurrent.suggestedFilename()).toBe(asSaved(oraCurrent, "Layered field sketch_p1_current.ora"));
    const currentBytes = (await bytesOf(oraCurrent)).toString("latin1");
    expect(currentBytes.startsWith("PK")).toBe(true); // a STORE-only zip
    expect(currentBytes).toContain("image/openraster");
    expect(currentBytes).toContain("<layer name='Layer 2' src='data/layer_2.png' opacity='1.00' visibility='visible'");
    expect(currentBytes).toContain("<layer name='Layer Renamed'");

    await exportBtn(page).click();
    const [oraOriginal] = await Promise.all([page.waitForEvent("download"), oras.nth(1).click()]);
    expect(oraOriginal.suggestedFilename()).toBe(asSaved(oraOriginal, "Layered field sketch_p1_original.ora"));
    const originalBytes = (await bytesOf(oraOriginal)).toString("latin1");
    expect(originalBytes).toContain("<layer name='Layer 2' src='data/layer_2.png' opacity='1.00' visibility='hidden'");
    expect(originalBytes).toContain("data/layer_2.png"); // pixels ride along regardless

    await exportBtn(page).click();
    const [png] = await Promise.all([page.waitForEvent("download"), flats.nth(0).click()]);
    expect(png.suggestedFilename()).toBe(asSaved(png, "Layered field sketch_p1_current.png"));
    const pngBytes = await bytesOf(png);
    expect([...pngBytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngBytes.readUInt32BE(16)).toBe(1404);
  });

  test("the per-page PDF exports the current layer view, one page, with a text layer", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();
    await panel(page).getByRole("button", { name: "Toggle Layer 2" }).click();
    await expect.poll(() => stackPixel(page, 900), { timeout: 10_000 }).toBeLessThan(10);

    await exportBtn(page).click();
    const pdfs = menu(page).getByRole("menuitem", { name: "PDF document" });
    await expect(pdfs).toHaveCount(3); // current + original + whole notebook

    const [current] = await Promise.all([page.waitForEvent("download"), pdfs.nth(0).click()]);
    expect(current.suggestedFilename()).toBe(asSaved(current, "Layered field sketch_p1_current.pdf"));
    const pdf = (await bytesOf(current)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("/Count 1"); // this page only, not the notebook
    expect(pdf).toContain("/ColorSpace /DeviceGray");
    expect(pdf).toContain("/Width 1404");

    await exportBtn(page).click();
    const [original] = await Promise.all([page.waitForEvent("download"), pdfs.nth(1).click()]);
    expect(original.suggestedFilename()).toBe(asSaved(original, "Layered field sketch_p1_original.pdf"));
  });

  test("a page without layers degrades: toggle disabled, no stack, composite paints", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();
    await expect(panel(page)).toBeVisible();

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("2 / 2");

    await expect(panel(page)).toBeHidden();
    await expect(layersBtn(page)).toBeDisabled();
    await expect(stackCanvases(page)).toHaveCount(0);
    await expect(reader(page).locator(".page > canvas").first()).toBeVisible();
    await exportBtn(page).click();
    await expect(menu(page).locator(".menu__head", { hasText: "Current view" })).toBeVisible();
    await expect(menu(page).locator(".menu__head", { hasText: "Original view" })).toBeHidden();
    await expect(menu(page).getByRole("menuitem", { name: "Layered image" })).toBeHidden();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Previous page" }).click();
    await expect(stackCanvases(page)).toHaveCount(4);
    await expect(panel(page)).toBeVisible();
  });

  // Regression: without layers on the listing's `firstPage`, the skeleton meta painted
  // the composite and said "no layers" before swapping in the stack. A MutationObserver
  // catches the transient claim that polling would miss.
  test("opening it from a listing goes straight to the stack, never claiming no layers", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as Window & { __layerTitles?: string[] };
      w.__layerTitles = [];
      new MutationObserver((records) => {
        for (const r of records) {
          const el = r.target as HTMLElement;
          if (el.getAttribute?.("aria-controls") !== "note-layers-panel") continue;
          w.__layerTitles!.push(el.getAttribute("title") ?? "");
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ["title"] });
    });
    await signedIn(page);
    await page.goto("/#/folder/note");
    await cardButton(page, "Layered field sketch").click();

    await expect(stackCanvases(page)).toHaveCount(4);
    await expect(layersBtn(page)).toBeEnabled();
    await expect(reader(page).locator(".page > canvas").first()).toBeHidden();

    const titles = await page.evaluate(() => (window as Window & { __layerTitles?: string[] }).__layerTitles ?? []);
    expect(titles).not.toContain("This page has no layers");
  });

  test("a layered note opened from the recycle bin keeps its panel", async ({ page }) => {
    await openLayered(page);

    // Navigate in-app: a reload would rebuild the fake Api and lose the trash.
    await reader(page).getByRole("button", { name: "Move to bin" }).click();
    await expect(page.locator(".bin-toast")).toContainText("Moved");
    await page
      .getByRole("navigation", { name: "Library" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Recycle bin$/ }) })
      .click();
    await expect(page.locator(".bin")).toBeVisible();
    await page.locator(".bin__row", { hasText: "Layered field sketch" }).locator("button.bin__open").click();

    await expect(reader(page)).toBeVisible();
    await expect(reader(page).locator(".backbtn__label")).toHaveText("Recycle bin");
    await expect(stackCanvases(page)).toHaveCount(4);
    await expect(layersBtn(page)).toBeEnabled();
    await layersBtn(page).click();
    await expect(panel(page).locator(".note-layer__name")).toHaveText([
      "Layer Renamed",
      "Layer 2",
      "Main Layer",
      "Background Layer",
    ]);
  });
});
