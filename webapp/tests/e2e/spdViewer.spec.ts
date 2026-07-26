import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";
import type { Page } from "@playwright/test";

// The `.spd` viewer, END TO END through the REAL decoder. Unlike the seam tests
// (viewers.spec.ts), this drives the actual `spd-decode.wasm` in Chromium against
// the committed `.spd` fixture (the same one the Zig/WASM smoke asserts: 4 layers
// 3/2/1/9999, Layer 2 hidden, Layer 3 semi-transparent), so what is proved is the
// whole render model: fetch → WASM parse → per-tile `createImageBitmap` → the
// STACK OF PER-LAYER CANVASES, plus the layers panel driving visibility and the
// transparency base.
//
// The library/reader run against the in-memory fake `Api`, but the raw-file
// endpoint the viewer fetches is a REAL browser request — so this route serves
// the fixture's bytes at `/file/n-files-sketch`, exactly as the server would.
// `/spd-decode.wasm` is a Vite public asset, served by the dev server verbatim.

const SPD_PATH = fileURLToPath(new URL("../../../parsers/spd/tests/fixtures/layers_hidden.spd", import.meta.url));
const SPD_BYTES = readFileSync(SPD_PATH);

async function serveSpd(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "x-content-type-options": "nosniff" },
        body: SPD_BYTES,
      });
    },
  );
}

// The render model is now a stack of per-layer canvases, not one composite canvas —
// so the pixel probes FLATTEN the live stack the way the browser compositor does.
//
// `composedInk`: draw the visible layer canvases (honouring display + opacity) onto
// a WHITE page and measure ink — a rendered drawing reads clearly above 0, a blank
// or all-hidden stack reads ≈0. `opaqueCoverage`: draw them onto a TRANSPARENT page
// and measure the fraction of OPAQUE pixels — near-full while the white Reference
// Layer backs the sheet, and dropping sharply once it is hidden, which is exactly
// "the checker shows through". Both run in-page against same-origin (blob-decoded)
// canvases, so `getImageData` is untainted.
async function stackProbe(page: Page, mode: "ink" | "opaque"): Promise<number> {
  return page.evaluate((probeMode) => {
    const wrap = document.querySelector(".spd-canvas-wrap");
    if (!wrap) return -1;
    const canvases = Array.from(wrap.querySelectorAll("canvas")) as HTMLCanvasElement[];
    if (!canvases.length || !canvases[0]!.width) return -1;
    const w = canvases[0]!.width;
    const h = canvases[0]!.height;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    if (!ctx) return -1;
    if (probeMode === "ink") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    // Canvases are in DOM order bottom-to-top — draw them in that order, skipping
    // hidden ones and honouring each layer's live opacity, exactly as the
    // compositor blends the on-screen stack.
    for (const c of canvases) {
      if (getComputedStyle(c).display === "none") continue;
      ctx.globalAlpha = Number(c.style.opacity || "1");
      ctx.drawImage(c, 0, 0);
    }
    ctx.globalAlpha = 1;
    const { data } = ctx.getImageData(0, 0, w, h);
    const lum = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const pixels = data.length / 4;
    if (probeMode === "opaque") {
      let opaque = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 10) opaque++;
      return opaque / pixels;
    }
    const bg = lum(0);
    let marks = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 10 && Math.abs(lum(i) - bg) > 90) marks++;
    return marks / pixels;
  }, mode);
}

test.describe(".spd viewer (real decoder)", () => {
  test("renders a per-layer canvas stack onto a non-blank drawing", async ({ page }) => {
    await signedIn(page);
    await serveSpd(page);
    await page.goto("/#/note/n-files-sketch");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region).toBeVisible();

    // One canvas per layer, stacked in the wrapper (4 layers in the fixture).
    const canvases = region.locator(".spd-canvas-wrap .spd-layer-canvas");
    await expect(canvases).toHaveCount(4);

    // Real ink from the decoded PNG tiles, flattened the way the compositor shows
    // it — a blank/failed render reads ≈0.
    await expect.poll(() => stackProbe(page, "ink"), { timeout: 10_000 }).toBeGreaterThan(0.002);
  });

  test("lists the layers; hiding the Reference Layer makes the drawing see-through", async ({ page }) => {
    await signedIn(page);
    await serveSpd(page);
    await page.goto("/#/note/n-files-sketch");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();
    await expect.poll(() => stackProbe(page, "ink"), { timeout: 10_000 }).toBeGreaterThan(0.002);

    // The Layers button opens the panel and wears the toolbar's active state.
    const layersBtn = region.getByRole("button", { name: "Layers" });
    await expect(layersBtn).toHaveAttribute("aria-pressed", "false");
    await layersBtn.click();
    const panel = region.locator(".spd-layers");
    await expect(panel).toBeVisible();
    await expect(layersBtn).toHaveAttribute("aria-pressed", "true");

    // Four layers (Z-order top-first), including the reserved Reference Layer.
    const rows = region.locator(".spd-layer");
    await expect(rows).toHaveCount(4);
    await expect(rows.first().locator(".spd-layer__name")).toHaveText("Layer 3");
    await expect(region.getByText("Reference Layer")).toBeVisible();

    // The white Reference Layer backs the whole sheet: with it on, the flattened
    // stack is (near-)fully opaque.
    await expect.poll(() => stackProbe(page, "opaque"), { timeout: 10_000 }).toBeGreaterThan(0.9);

    // Toggle the Reference Layer off → its white base is gone, so most of the sheet
    // becomes transparent (only the strokes stay opaque) and the wrapper's
    // checkerboard shows through. This is the transparency the new model unlocks.
    const refEye = region.locator(".spd-layer", { hasText: "Reference Layer" }).locator(".spd-layer__eye");
    await refEye.click();
    await expect.poll(() => stackProbe(page, "opaque"), { timeout: 10_000 }).toBeLessThan(0.6);

    // And turning every remaining shown layer off flattens to a blank sheet — the
    // proof the eye toggles drive a real change, not just a class flip.
    const shownEyes = region.locator('.spd-layer__eye[aria-pressed="true"]');
    for (let i = (await shownEyes.count()) - 1; i >= 0; i--) await shownEyes.nth(i).click();
    await expect.poll(() => stackProbe(page, "ink"), { timeout: 10_000 }).toBeLessThan(0.0005);
  });

  test("the opacity fill bar drives the readout + the layer canvas (keyboard + drag); a hidden layer's bar is disabled", async ({ page }) => {
    await signedIn(page);
    await serveSpd(page);
    await page.goto("/#/note/n-files-sketch");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();
    await expect.poll(() => stackProbe(page, "ink"), { timeout: 10_000 }).toBeGreaterThan(0.002);

    await region.getByRole("button", { name: "Layers" }).click();
    await expect(region.locator(".spd-layers")).toBeVisible();

    // The TOPMOST layer's opacity bar. The topmost row is first in the panel; its
    // canvas paints last (last child of the wrapper).
    const topRow = region.locator(".spd-layer").first();
    const bar = topRow.getByRole("slider", { name: "Opacity" });
    const fill = topRow.locator(".spd-layer__bar-fill");
    const pct = topRow.locator(".spd-layer__pct");
    const topCanvas = region.locator(".spd-canvas-wrap .spd-layer-canvas").last();
    const beforeLabel = (await pct.textContent()) ?? "";
    const beforeOpacity = await topCanvas.evaluate((c) => getComputedStyle(c as HTMLElement).opacity);

    // Keyboard: focus the slider and nudge it down one point (arrow = 1%).
    await bar.press("ArrowLeft");
    // The readout ticks down and the layer canvas's live opacity actually changed.
    await expect(pct).not.toHaveText(beforeLabel);
    await expect
      .poll(() => topCanvas.evaluate((c) => getComputedStyle(c as HTMLElement).opacity))
      .not.toBe(beforeOpacity);

    // Drag: press near the LEFT of the track (~20% across) and release — the value
    // drops sharply and the fill's WIDTH shrinks to match. The bar's LENGTH IS the
    // number, and the readout agrees with the drawn fill.
    const box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect
      .poll(async () => Number(((await pct.textContent()) ?? "").replace("%", "")))
      .toBeLessThan(35);
    // The drawn fill width and the mono readout carry the same value.
    await expect
      .poll(async () => (await fill.evaluate((f) => (f as HTMLElement).style.width)) === (await pct.textContent()))
      .toBe(true);

    // A layer that is authored-hidden (its eye off) has a DISABLED opacity bar —
    // opacity is meaningless on an invisible layer.
    const hiddenRow = region.locator('.spd-layer:has(.spd-layer__eye[aria-pressed="false"])').first();
    await expect(hiddenRow.locator(".spd-layer__barwrap")).toHaveClass(/is-disabled/);
    await expect(hiddenRow.locator(".spd-layer__bar")).toHaveAttribute("aria-disabled", "true");
  });

  test("the Download menu offers the flat/layered × current/original matrix plus the raw .spd", async ({ page }) => {
    await signedIn(page);
    await serveSpd(page);
    await page.goto("/#/note/n-files-sketch");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();

    // The Download trigger is a menu, closed to start.
    const downloadBtn = region.getByRole("button", { name: "Download" });
    await expect(downloadBtn).toHaveAttribute("aria-haspopup", "menu");
    await expect(downloadBtn).toHaveAttribute("aria-expanded", "false");

    const pop = region.locator(".viewer__export .menu__pop");
    await expect(pop).toBeHidden();

    // Open it: the trigger wears the active state and the popover shows.
    await downloadBtn.click();
    await expect(downloadBtn).toHaveAttribute("aria-expanded", "true");
    await expect(pop).toBeVisible();

    // The three heads and the five actionable rows the spec lays out.
    await expect(pop.locator(".menu__head")).toHaveText(["Current view", "Original view", "Original file"]);
    const items = pop.getByRole("menuitem");
    await expect(items).toHaveCount(5);
    await expect(items).toHaveText([
      "Flattened image.png",
      "Layered image.ora",
      "Flattened image.png",
      "Layered image.ora",
      "Atelier sketch.spd",
    ]);

    // A "current view" flat PNG genuinely downloads through the export pipeline.
    const downloadPromise = page.waitForEvent("download");
    await items.first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/_current\.png$/);

    // Choosing a row closes the menu.
    await expect(pop).toBeHidden();
    await expect(downloadBtn).toHaveAttribute("aria-expanded", "false");

    // Re-open and dismiss with Escape.
    await downloadBtn.click();
    await expect(pop).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
  });

  test("the panel head reads `[icon] Layers`, and the layer preview matches the filmstrip thumbnail height", async ({
    page,
  }) => {
    await signedIn(page);
    await serveSpd(page);

    // The reference: the note reader's page-index (filmstrip) thumbnail box. Its
    // rendered height comes from CSS (width 76px, aspect 0.75) — no page raster needed.
    await page.goto("/#/note/n-doc-attn");
    await freezeMotion(page);
    const film = page.locator(".filmstrip__thumb").first();
    await expect(film).toBeVisible();
    const filmH = await film.evaluate((el) => el.getBoundingClientRect().height);
    expect(filmH).toBeGreaterThan(0);

    // The .spd viewer: open the Layers panel.
    await page.goto("/#/note/n-files-sketch");
    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();
    await region.getByRole("button", { name: "Layers" }).click();
    const panel = region.locator(".spd-layers");
    await expect(panel).toBeVisible();

    // The head is `[icon] Layers`: a decorative svg icon before the label span.
    await expect(panel.locator(".spd-layers__head-ic svg")).toBeVisible();
    await expect(panel.locator(".spd-layers__head")).toContainText("Layers");

    // The per-layer thumbnail renders at the SAME height as the filmstrip thumbnail.
    const thumb = region.locator(".spd-layer__thumb").first();
    await expect(thumb).toBeVisible();
    const thumbH = await thumb.evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(thumbH - filmH)).toBeLessThan(1);
  });
});
