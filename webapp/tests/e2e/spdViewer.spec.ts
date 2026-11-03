import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";
import type { Page } from "@playwright/test";

// Drives the real `sqlite-core.wasm` against the committed `.spd` fixture (4 layers,
// Layer 2 hidden, Layer 3 semi-transparent). The raw-file fetch is a real browser
// request, so this route serves the fixture bytes at `/file/174`.

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

// Flattens the per-layer canvas stack as the compositor does: "ink" onto white,
// "opaque" onto transparent (drops once the white Reference Layer is hidden).
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
    // DOM order is bottom-to-top.
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
    await page.goto("/#/note/174");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region).toBeVisible();

    const canvases = region.locator(".spd-canvas-wrap .spd-layer-canvas");
    await expect(canvases).toHaveCount(4);

    await expect.poll(() => stackProbe(page, "ink"), { timeout: 10_000 }).toBeGreaterThan(0.002);
  });

  test("lists the layers; hiding the Reference Layer makes the drawing see-through", async ({ page }) => {
    await signedIn(page);
    await serveSpd(page);
    await page.goto("/#/note/174");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();
    await expect.poll(() => stackProbe(page, "ink"), { timeout: 10_000 }).toBeGreaterThan(0.002);

    const layersBtn = region.getByRole("button", { name: "Layers" });
    await expect(layersBtn).toHaveAttribute("aria-pressed", "false");
    await layersBtn.click();
    const panel = region.locator(".spd-layers");
    await expect(panel).toBeVisible();
    await expect(layersBtn).toHaveAttribute("aria-pressed", "true");

    const rows = region.locator(".spd-layer");
    await expect(rows).toHaveCount(4);
    await expect(rows.first().locator(".spd-layer__name")).toHaveText("Layer 3");
    await expect(region.getByText("Reference Layer")).toBeVisible();

    await expect.poll(() => stackProbe(page, "opaque"), { timeout: 10_000 }).toBeGreaterThan(0.9);

    const refEye = region.locator(".spd-layer", { hasText: "Reference Layer" }).locator(".spd-layer__eye");
    await refEye.click();
    await expect.poll(() => stackProbe(page, "opaque"), { timeout: 10_000 }).toBeLessThan(0.6);

    const shownEyes = region.locator('.spd-layer__eye[aria-pressed="true"]');
    for (let i = (await shownEyes.count()) - 1; i >= 0; i--) await shownEyes.nth(i).click();
    await expect.poll(() => stackProbe(page, "ink"), { timeout: 10_000 }).toBeLessThan(0.0005);
  });

  test("the opacity fill bar drives the readout + the layer canvas (keyboard + drag); a hidden layer's bar is disabled", async ({ page }) => {
    await signedIn(page);
    await serveSpd(page);
    await page.goto("/#/note/174");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();
    await expect.poll(() => stackProbe(page, "ink"), { timeout: 10_000 }).toBeGreaterThan(0.002);

    await region.getByRole("button", { name: "Layers" }).click();
    await expect(region.locator(".spd-layers")).toBeVisible();

    // The topmost row is first in the panel; its canvas is the wrapper's last child.
    const topRow = region.locator(".spd-layer").first();
    const bar = topRow.getByRole("slider", { name: "Opacity" });
    const fill = topRow.locator(".spd-layer__bar-fill");
    const pct = topRow.locator(".spd-layer__pct");
    const topCanvas = region.locator(".spd-canvas-wrap .spd-layer-canvas").last();
    const beforeLabel = (await pct.textContent()) ?? "";
    const beforeOpacity = await topCanvas.evaluate((c) => getComputedStyle(c as HTMLElement).opacity);

    await bar.press("ArrowLeft");
    await expect(pct).not.toHaveText(beforeLabel);
    await expect
      .poll(() => topCanvas.evaluate((c) => getComputedStyle(c as HTMLElement).opacity))
      .not.toBe(beforeOpacity);

    const box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect
      .poll(async () => Number(((await pct.textContent()) ?? "").replace("%", "")))
      .toBeLessThan(35);
    await expect
      .poll(async () => (await fill.evaluate((f) => (f as HTMLElement).style.width)) === (await pct.textContent()))
      .toBe(true);

    const hiddenRow = region.locator('.spd-layer:has(.spd-layer__eye[aria-pressed="false"])').first();
    await expect(hiddenRow.locator(".spd-layer__barwrap")).toHaveClass(/is-disabled/);
    await expect(hiddenRow.locator(".spd-layer__bar")).toHaveAttribute("aria-disabled", "true");
  });

  test("the Download menu offers the flat/layered × current/original matrix plus the raw .spd", async ({ page }) => {
    await signedIn(page);
    await serveSpd(page);
    await page.goto("/#/note/174");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();

    const downloadBtn = region.getByRole("button", { name: "Download" });
    await expect(downloadBtn).toHaveAttribute("aria-haspopup", "menu");
    await expect(downloadBtn).toHaveAttribute("aria-expanded", "false");

    const pop = region.locator(".viewer__export .menu__pop");
    await expect(pop).toBeHidden();

    await downloadBtn.click();
    await expect(downloadBtn).toHaveAttribute("aria-expanded", "true");
    await expect(pop).toBeVisible();

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

    const downloadPromise = page.waitForEvent("download");
    await items.first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/_current\.png$/);

    await expect(pop).toBeHidden();
    await expect(downloadBtn).toHaveAttribute("aria-expanded", "false");

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

    await page.goto("/#/note/141");
    await freezeMotion(page);
    const film = page.locator(".filmstrip__thumb").first();
    await expect(film).toBeVisible();
    const filmH = await film.evaluate((el) => el.getBoundingClientRect().height);
    expect(filmH).toBeGreaterThan(0);

    await page.goto("/#/note/174");
    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas").first()).toBeVisible();
    await region.getByRole("button", { name: "Layers" }).click();
    const panel = region.locator(".spd-layers");
    await expect(panel).toBeVisible();

    await expect(panel.locator(".spd-layers__head-ic svg")).toBeVisible();
    await expect(panel.locator(".spd-layers__head")).toContainText("Layers");

    const thumb = region.locator(".spd-layer__thumb").first();
    await expect(thumb).toBeVisible();
    const thumbH = await thumb.evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(thumbH - filmH)).toBeLessThan(1);
  });
});
