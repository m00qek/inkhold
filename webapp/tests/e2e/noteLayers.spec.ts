import { test, expect, type Download, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { cardButton, signedIn, freezeMotion } from "./helpers/app";

// The `.note` reader's LAYERS PANEL, end to end through the REAL decoder. The
// fake `Api` serves the layered fixture (`n-layers`, src/api/layeredFixture.ts):
// page 1 carries `layers` in its meta ref and a genuine SNPG v2 payload —
// four records with a DEVICE-HIDDEN Layer 2 and a renamed current layer — so
// what is proved is the whole path: meta layers → payload fetch → wasm
// `decode_layer` in Chromium → the stacked per-layer canvases, the shared
// panel driving visibility, and the layered export matrix (shared core).
// Page 2 carries no layers, which pins the per-page degrade.
//
// `/note-decode.wasm` is a Vite public asset, served by the dev server
// verbatim — the same arrangement the `.spd` viewer's e2e relies on.

const reader = (page: Page) => page.getByRole("region", { name: "Reader" });
const layersBtn = (page: Page) => reader(page).getByRole("button", { name: "Layers" });
const panel = (page: Page) => reader(page).locator(".note-layers");
const stackCanvases = (page: Page) => reader(page).locator(".note-stack canvas");
const exportBtn = (page: Page) => reader(page).getByRole("button", { name: "Download" });
// The EXPORT pop specifically: the bar also holds the bin-mode cluster's "…" pop
// (shared `.menu__pop` class), so it is disambiguated by the `.menu__head` group
// headings only the export menu carries.
const menu = (page: Page) => page.locator(".reader__bar .menu__pop", { has: page.locator(".menu__head") });

async function openLayered(page: Page): Promise<void> {
  await signedIn(page);
  await page.goto("/#/note/n-layers");
  await freezeMotion(page);
  await expect(page.locator(".pager__count")).toHaveText("1 / 2");
  // The stack is up once all four record canvases exist with real backing.
  await expect(stackCanvases(page)).toHaveCount(4);
}

/**
 * The red-channel value of ONE composed stack pixel (page centre of `row`),
 * flattened the way the compositor blends the on-screen stack: white base,
 * visible canvases bottom-to-top (`display` honoured; `.note` has no
 * opacity). The fixture's bands are solid, so a single pixel is a verdict:
 * 0 = that band's ink is showing, 255 = it is not. −1 = not readable yet.
 */
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

/** Read a completed download into memory. */
async function bytesOf(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("download produced no file");
  return readFile(path);
}

test.describe(".note layers panel (real decoder)", () => {
  test("stacks one canvas per record; the panel lists device names top-first", async ({ page }) => {
    await openLayered(page);

    // Wire order bottom-to-top in the DOM; the DEVICE-HIDDEN Layer 2 (record 3
    // of 4) starts OFF — its canvas is mounted but not displayed.
    await expect(stackCanvases(page).nth(2)).toHaveCSS("display", "none");
    await expect(stackCanvases(page).nth(1)).not.toHaveCSS("display", "none");

    // The stack replaced the composite canvas for the focused page.
    await expect(reader(page).locator(".page > canvas").first()).toBeHidden();

    // Toggle opens the panel, wearing the toolbar's active state.
    await expect(layersBtn(page)).toBeEnabled();
    await expect(layersBtn(page)).toHaveAttribute("aria-pressed", "false");
    await layersBtn(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(layersBtn(page)).toHaveAttribute("aria-pressed", "true");

    // TOP-first rows; the device's rename shows, nameless slots get defaults.
    await expect(panel(page).locator(".note-layer__name")).toHaveText([
      "Layer Renamed",
      "Layer 2",
      "Main Layer",
      "Background Layer",
    ]);

    // The hidden layer's row starts off: dimmed row, unpressed eye — and NO
    // opacity fill bar anywhere (`.note` layers carry no opacity).
    const layer2 = panel(page).locator(".note-layer", { hasText: "Layer 2" });
    await expect(layer2).toHaveClass(/is-hidden/);
    await expect(layer2.locator(".note-layer__eye")).toHaveAttribute("aria-pressed", "false");
    await expect(panel(page).locator(".layers-panel__bar")).toHaveCount(0);
  });

  test("eye toggles repaint the stack: hidden ON adds its ink, visible OFF removes it", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();

    // Authored state: main's band (rows 200–400) inked, Layer 2's (800–1100) not.
    await expect.poll(() => stackPixel(page, 300), { timeout: 10_000 }).toBeLessThan(10);
    await expect.poll(() => stackPixel(page, 900)).toBeGreaterThan(250);

    // The device-hidden layer toggles ON instantly — its record was on the wire.
    await panel(page).getByRole("button", { name: "Toggle Layer 2" }).click();
    await expect.poll(() => stackPixel(page, 900)).toBeLessThan(10);

    // A visible layer toggles OFF; its band goes back to paper.
    await panel(page).getByRole("button", { name: "Toggle Main Layer" }).click();
    await expect.poll(() => stackPixel(page, 300)).toBeGreaterThan(250);

    // …and back ON. View-only, instant, no decode.
    await panel(page).getByRole("button", { name: "Toggle Main Layer" }).click();
    await expect.poll(() => stackPixel(page, 300)).toBeLessThan(10);
  });

  test("the ORIGINAL-view group is hidden until a layer is toggled", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();
    await expect(panel(page)).toBeVisible();

    // A stack is up, so CURRENT view is offered (Flattened image, Layered image, PDF
    // document) — but nothing has been toggled, so current == original and the
    // whole ORIGINAL-view group would just be duplicate rows: it stays hidden.
    await exportBtn(page).click();
    await expect(menu(page).locator(".menu__head", { hasText: "Current view" })).toBeVisible();
    await expect(menu(page).locator(".menu__head", { hasText: "Original view" })).toBeHidden();
    await expect(menu(page).getByRole("menuitem", { name: "Layered image" })).toHaveCount(1); // current only
    await page.keyboard.press("Escape");

    // Toggle the device-hidden Layer 2 ON — now the live view differs from the
    // authored one, and the ORIGINAL group appears.
    await panel(page).getByRole("button", { name: "Toggle Layer 2" }).click();
    await expect.poll(() => stackPixel(page, 900), { timeout: 10_000 }).toBeLessThan(10);
    await exportBtn(page).click();
    await expect(menu(page).locator(".menu__head", { hasText: "Original view" })).toBeVisible();
  });

  test("the export menu gains the layered matrix; ORA carries live vs authored visibility", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();
    // Make current ≠ original: the device-hidden Layer 2 is toggled ON — which is
    // also what reveals the ORIGINAL-view group.
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

    // CURRENT ORA: Layer 2 visible (the live panel state).
    const [oraCurrent] = await Promise.all([page.waitForEvent("download"), oras.nth(0).click()]);
    expect(oraCurrent.suggestedFilename()).toBe("Layered field sketch_p1_current.ora");
    const currentBytes = (await bytesOf(oraCurrent)).toString("latin1");
    expect(currentBytes.startsWith("PK")).toBe(true); // a STORE-only zip
    expect(currentBytes).toContain("image/openraster");
    expect(currentBytes).toContain("<layer name='Layer 2' src='data/layer_2.png' opacity='1.00' visibility='visible'");
    expect(currentBytes).toContain("<layer name='Layer Renamed'");

    // ORIGINAL ORA: Layer 2 PRESENT with full pixels but marked hidden — the
    // file's own semantics, whatever the panel says right now.
    await exportBtn(page).click();
    const [oraOriginal] = await Promise.all([page.waitForEvent("download"), oras.nth(1).click()]);
    expect(oraOriginal.suggestedFilename()).toBe("Layered field sketch_p1_original.ora");
    const originalBytes = (await bytesOf(oraOriginal)).toString("latin1");
    expect(originalBytes).toContain("<layer name='Layer 2' src='data/layer_2.png' opacity='1.00' visibility='hidden'");
    expect(originalBytes).toContain("data/layer_2.png"); // pixels ride along regardless

    // FLAT PNG (current): a real PNG at the payload's effective width.
    await exportBtn(page).click();
    const [png] = await Promise.all([page.waitForEvent("download"), flats.nth(0).click()]);
    expect(png.suggestedFilename()).toBe("Layered field sketch_p1_current.png");
    const pngBytes = await bytesOf(png);
    expect([...pngBytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngBytes.readUInt32BE(16)).toBe(1404);
  });

  // The NEW per-page PDF, layer-view-aware: it flattens the chosen view onto a
  // white sheet at the payload's EFFECTIVE dims and runs it through the same PDF
  // pipeline as the composite export — one page, /DeviceGray raster, invisible OCR
  // text over it. Current and original differ only in which layers are drawn.
  test("the per-page PDF exports the current layer view, one page, with a text layer", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();
    // Toggle Layer 2 ON so current ≠ original and both PDF rows are on offer.
    await panel(page).getByRole("button", { name: "Toggle Layer 2" }).click();
    await expect.poll(() => stackPixel(page, 900), { timeout: 10_000 }).toBeLessThan(10);

    await exportBtn(page).click();
    const pdfs = menu(page).getByRole("menuitem", { name: "PDF document" });
    await expect(pdfs).toHaveCount(3); // current + original + whole notebook

    // CURRENT view PDF — the layered view, named like its ORA/PNG siblings.
    const [current] = await Promise.all([page.waitForEvent("download"), pdfs.nth(0).click()]);
    expect(current.suggestedFilename()).toBe("Layered field sketch_p1_current.pdf");
    const pdf = (await bytesOf(current)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("/Count 1"); // this page only, not the notebook
    expect(pdf).toContain("/ColorSpace /DeviceGray");
    // The image rides at the payload's effective width (landscape-correct).
    expect(pdf).toContain("/Width 1404");

    // ORIGINAL view PDF is offered too, carrying the same page number, differing
    // only in the pixels (the text layer is positional, so it is identical).
    await exportBtn(page).click();
    const [original] = await Promise.all([page.waitForEvent("download"), pdfs.nth(1).click()]);
    expect(original.suggestedFilename()).toBe("Layered field sketch_p1_original.pdf");
  });

  test("a page without layers degrades: toggle disabled, no stack, composite paints", async ({ page }) => {
    await openLayered(page);
    await layersBtn(page).click();
    await expect(panel(page)).toBeVisible();

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveText("2 / 2");

    // No layers on this page: the panel folds away and the toggle says why. The
    // download menu's CURRENT-view group stays (Flattened image + PDF document fall
    // back to the composite), but the layered-only rows go: the ORIGINAL group and
    // the Layered-image ORA leave the menu. The composite canvas is back.
    await expect(panel(page)).toBeHidden();
    await expect(layersBtn(page)).toBeDisabled();
    await expect(stackCanvases(page)).toHaveCount(0);
    await expect(reader(page).locator(".page > canvas").first()).toBeVisible();
    await exportBtn(page).click();
    await expect(menu(page).locator(".menu__head", { hasText: "Current view" })).toBeVisible();
    await expect(menu(page).locator(".menu__head", { hasText: "Original view" })).toBeHidden();
    await expect(menu(page).getByRole("menuitem", { name: "Layered image" })).toBeHidden();
    await page.keyboard.press("Escape");

    // …and paging back restores the stack AND the panel (the open state is the
    // user's intent, remembered across the layerless page).
    await page.getByRole("button", { name: "Previous page" }).click();
    await expect(stackCanvases(page)).toHaveCount(4);
    await expect(panel(page)).toBeVisible();
  });

  // OPENED FROM A LISTING, which is the ordinary way in — and the case a listing's
  // `firstPage` carrying its layers exists for. The reader paints a skeleton
  // `NoteMeta` off the summary while `getNoteMeta` is in flight, so without layers
  // on `firstPage` page 1 was painted as the COMPOSITE, Layers was disabled with
  // "This page has no layers" (a claim about a page whose real metadata had not
  // arrived), and the meta's arrival then re-fetched the same page bytes and
  // swapped the stack in — a second visible content swap on every layered note.
  //
  // Asserted with a MutationObserver rather than by polling: the thing under test
  // is a state that must never EXIST, and a `toHaveText` after the fact passes
  // happily against a claim that came and went in 120 ms.
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

    // The stack is what paints — not the composite followed by a swap.
    await expect(stackCanvases(page)).toHaveCount(4);
    await expect(layersBtn(page)).toBeEnabled();
    await expect(reader(page).locator(".page > canvas").first()).toBeHidden();

    // And at no point did the toggle assert an absence.
    const titles = await page.evaluate(() => (window as Window & { __layerTitles?: string[] }).__layerTitles ?? []);
    expect(titles).not.toContain("This page has no layers");
  });

  test("a layered note opened from the recycle bin keeps its panel", async ({ page }) => {
    await openLayered(page);

    // Trash it from the reader, then walk to the bin IN-APP (a reload would
    // rebuild the fake Api and lose the trash) and open its row.
    await reader(page).getByRole("button", { name: "Move to bin" }).click();
    await expect(page.locator(".bin-toast")).toContainText("Moved");
    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Recycle bin$/ }) })
      .click();
    await expect(page.locator(".bin")).toBeVisible();
    await page.locator(".bin__row", { hasText: "Layered field sketch" }).locator("button.bin__open").click();

    // The reader is open FROM the bin — and the layered path rides the
    // bin-scoped meta + page routes exactly like the live ones.
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
