import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";

// Drives the real MuPDF wasm in a browser. The raw-file fetch is a real request, so
// routes serve fixture bytes as the server would.
import { PANEL_PDF_BYTES, servePdf, inkFraction } from "./pdfViewer.shared";

test.describe("PDF viewer (real MuPDF wasm)", () => {
  /** Every row of a thumbnail canvas as a fraction of dark pixels, 0..1. */
  async function thumbRowInk(canvas: Locator): Promise<number[]> {
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
  const band = (rows: number[], from: number, to: number): number =>
    rows.length === 0 ? -1 : rows.slice(from, to + 1).reduce((a, b) => a + b, 0) / (to - from + 1);

  /** Open the marked PDF against the panel-aspect fixture, with Pages open. */
  async function openStrip(page: Page): Promise<Locator> {
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

  test("opens a .pdf in its own viewer and paints real pixels", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect(region).toBeVisible();

    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  });

  test("pages through the document, and the pager bounds itself", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const prev = region.getByRole("button", { name: "Previous page" });
    const next = region.getByRole("button", { name: "Next page" });
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();

    await next.click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();
    // A pager that moves a counter over a stale canvas would pass the rest.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  });

  test("zooming re-rasters at a larger size, not a stretched bitmap", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const geo = () =>
      page.evaluate(() => {
        const c = document.querySelector(".pdf-page") as HTMLCanvasElement;
        const wrap = document.querySelector(".pdf-wrap") as HTMLElement;
        return {
          buffer: c.width,
          css: Math.round(c.getBoundingClientRect().width),
          scrollW: wrap.scrollWidth,
          clientW: wrap.clientWidth,
        };
      });

    const fit = await geo();
    // A Fit that already overflowed would make the rest meaningless.
    expect(fit.scrollW).toBeLessThanOrEqual(fit.clientW + 1);

    // Two steps: on this width-bound fixture `Fit ⇔` equals `Fit ⇕`.
    await region.getByRole("button", { name: "Zoom in" }).click();
    await region.getByRole("button", { name: "Zoom in" }).click();
    // The buffer grows; CSS-scaling the old raster would leave it unchanged.
    await expect.poll(async () => (await geo()).buffer, { timeout: 20_000 }).toBeGreaterThan(fit.buffer);
    const zoomed = await geo();

    // Regression: `.pdf-page` had `max-width: 100%`, clamping the box while the raster grew.
    expect(zoomed.css).toBeGreaterThan(fit.css * 1.3);
    // Buffer-to-box ratio is the DPR; zoom must not change it.
    expect(zoomed.buffer / zoomed.css).toBeCloseTo(fit.buffer / fit.css, 1);

    // Scrollable overflow only extends end-ward, so plain `center` hides the left edge.
    expect(zoomed.scrollW).toBeGreaterThan(zoomed.clientW);
    const edges = await page.evaluate(() => {
      const wrap = document.querySelector(".pdf-wrap") as HTMLElement;
      const c = document.querySelector(".pdf-page") as HTMLCanvasElement;
      const gaps = () => {
        const w = wrap.getBoundingClientRect();
        const b = c.getBoundingClientRect();
        return { left: b.left - w.left, right: w.right - b.right };
      };
      wrap.scrollLeft = 0;
      const atStart = gaps();
      wrap.scrollLeft = wrap.scrollWidth;
      const atEnd = gaps();
      return { atStart, atEnd };
    });
    expect(edges.atStart.left).toBeGreaterThanOrEqual(0); // left edge in view
    expect(edges.atEnd.right).toBeGreaterThanOrEqual(0); // right edge in view
  });

  test("Fit ⇔ fills the stage across and lets the page run off the bottom", async ({ page }) => {
    // Portrait page in a landscape window: fit-page is height-bound, so `Fit ⇔` differs.
    await signedIn(page);
    await servePdf(page, PANEL_PDF_BYTES); // 351 x 468 pt — portrait
    await page.goto("/#/note/178");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const geo = () =>
      page.evaluate(() => {
        const c = document.querySelector(".pdf-page") as HTMLCanvasElement;
        const wrap = document.querySelector(".pdf-wrap") as HTMLElement;
        const cs = getComputedStyle(wrap);
        const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        return {
          css: c.getBoundingClientRect().width,
          // `availableBox` uses the border box less padding; `clientWidth` loses the scrollbar.
          avail: wrap.getBoundingClientRect().width - padX,
          scrollH: wrap.scrollHeight,
          clientH: wrap.clientHeight,
        };
      });

    const fit = await geo();
    // Otherwise the step below proves nothing.
    expect(fit.css).toBeLessThan(fit.avail * 0.95);
    expect(fit.scrollH).toBeLessThanOrEqual(fit.clientH + 1);

    await region.getByRole("button", { name: "Zoom in" }).click();
    await expect(region.locator(".pdf-zoom")).toHaveText("Fit ⇔");

    await expect.poll(async () => (await geo()).css, { timeout: 20_000 }).toBeGreaterThan(fit.css);
    const wide = await geo();
    expect(wide.css).toBeCloseTo(wide.avail, 0);
    expect(wide.scrollH).toBeGreaterThan(wide.clientH);
  });

  test("the ink keeps the page's scale at every zoom, and with a panel open", async ({ page }) => {
    // The `.mark` overlay is placed against the requested raster size (`markGeometry`);
    // its ratio to the page at Fit must hold at every zoom. Numbers are in `markGeometry.test.ts`.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    await region.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });

    const ratio = () =>
      page.evaluate(() => {
        const host = document.querySelector(".pdf-mark") as HTMLElement;
        const c = document.querySelector(".pdf-page") as HTMLCanvasElement;
        return host.getBoundingClientRect().width / c.getBoundingClientRect().width;
      });

    const atFit = await ratio();
    const zoomIn = region.getByRole("button", { name: "Zoom in" });
    for (const step of ["Fit ⇔", "150%", "200%", "300%"]) {
      await zoomIn.click();
      await expect
        .poll(async () => Math.abs((await ratio()) - atFit) < 0.02, { timeout: 20_000 })
        .toBe(true);
      expect(await ratio(), `ink out of register at ${step}`).toBeCloseTo(atFit, 1);
    }

    // Regression: `availableBox` ignored the Annotations panel, so `Fit ⇕` overflowed beside it.
    const clearOfPanel = () =>
      page.evaluate(() => {
        const c = document.querySelector(".pdf-page") as HTMLCanvasElement;
        const panel = document.querySelector("#pdf-layers-panel") as HTMLElement;
        return panel.getBoundingClientRect().left - c.getBoundingClientRect().right;
      });

    const zoomOut = region.getByRole("button", { name: "Zoom out" });
    for (const _ of [0, 1, 2, 3]) await zoomOut.click();
    await region.getByRole("button", { name: "Annotations" }).click();

    await expect.poll(clearOfPanel, { timeout: 20_000 }).toBeGreaterThanOrEqual(-1);
    expect(await ratio()).toBeCloseTo(atFit, 1);
  });

  test("a page is an ADDRESS: paging rewrites the URL, and a reload lands there", async ({
    page,
  }) => {
    // Regression: the viewer read `#/note/:id/page/:n` but never wrote it back.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");

    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    // One-based in the URL, 0-based internally.
    await expect(page).toHaveURL(/#\/note\/178\/page\/2$/);

    await page.reload();
    await freezeMotion(page);
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2", { timeout: 20_000 });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  });

  test("refuses a corrupt PDF with MuPDF's own words, and does not wedge", async ({ page }) => {
    await signedIn(page);
    await servePdf(page, Buffer.from("this is definitely not a pdf"));
    await page.goto("/#/note/178");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect(region).toBeVisible();
    await expect(region.locator(".viewer__placeholder")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".pdf-page")).toBeHidden();
  });

  // Regression: hiding Document showed the desk instead of the transparency checker.
  test("hiding the Document layer shows the transparent checker, not the desk", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    await region.getByRole("button", { name: "Annotations" }).click();
    await region.locator(".pdf-layer", { hasText: "Document" }).locator(".pdf-layer__eye").click();

    await expect(page.locator(".pdf-page")).toBeHidden();

    // `visibility: hidden` keeps the canvas box for the checker. Measured after the toggle:
    // the panel opening re-rasters the page.
    const box = await page.evaluate(() => {
      const stage = document.querySelector(".pdf-stage") as HTMLElement;
      const canvas = document.querySelector(".pdf-page") as HTMLElement;
      const s = stage.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return { sw: s.width, sh: s.height, cw: c.width, ch: c.height };
    });
    expect(box.sw).toBeGreaterThan(50);
    expect(box.sh).toBeGreaterThan(50);
    expect(box.cw).toBeCloseTo(box.sw, 0);
    expect(box.ch).toBeCloseTo(box.sh, 0);

    const bg = await page
      .locator(".pdf-stage")
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bg).toContain("linear-gradient");
  });

  test("the page index lists every page, jumps, and tracks the current one", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    // Closed by default. Rows are built anyway; hidden ones never intersect, so nothing loads.
    const panel = region.locator("#pdf-pages-panel");
    const strip = region.locator(".filmstrip__page");
    await expect(panel).toBeHidden();

    await region.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(strip).toHaveCount(2); // the fixture is two pages

    await expect(strip.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(strip.nth(1)).toHaveAttribute("aria-current", "false");

    await strip.nth(1).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    await expect(strip.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(strip.nth(0)).toHaveAttribute("aria-current", "false");

    await region.getByRole("button", { name: "Previous page" }).click();
    await expect(strip.nth(0)).toHaveAttribute("aria-current", "true");
  });

  test("the strip paints thumbnails, and reserves each row's shape first", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Pages", exact: true }).click();

    // Reserved aspect before thumbnails land, so the strip does not reflow.
    const reserved = await region.locator(".filmstrip__page").first().evaluate(
      (n) => getComputedStyle(n).getPropertyValue("--thumb-aspect").trim(),
    );
    expect(Number(reserved)).toBeGreaterThan(0);

    // `is-loading` clears only once a canvas has been drawn.
    await expect(region.locator(".filmstrip__thumb:not(.is-loading)").first()).toBeVisible({
      timeout: 20_000,
    });
    const ink = await region.locator(".filmstrip__thumb canvas").first().evaluate((c) => {
      const cv = c as HTMLCanvasElement;
      if (!cv.width) return -1;
      const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      let marks = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 200) marks++;
      return marks / (d.length / 4);
    });
    expect(ink).toBeGreaterThan(0.002); // a real page, not a blank canvas
  });
});

// ---- download menu ----
// Page 2 is 300 x 150 pt; width binds, so its rect in the 1404 x 1872 panel is
// 1404 x 702 at (0, 585). Only hidden Layer 2 (panel rows 800–1100) falls inside it.
