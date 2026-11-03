import { test, expect, type Download, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";

// Drives the real MuPDF wasm in a browser. The raw-file fetch is a real request, so
// routes serve fixture bytes as the server would.

const PDF_PATH = fileURLToPath(new URL("../../wasm/tests/fixtures/two-page.pdf", import.meta.url));
const PDF_BYTES = readFileSync(PDF_PATH);

/**
 * 351 x 468 pt, exactly the device panel's 1404 x 1872 aspect, so no letterbox: all three
 * mark bands land on the page. On `two-page.pdf` only the hidden band would.
 */
const PANEL_PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/two-page-panel.pdf", import.meta.url)),
);

/** One page, three lines 20pt apart, so a selection can keep its line breaks. */
const THREE_LINE_PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/text-three-line.pdf", import.meta.url)),
);

/**
 * Six pages, outline three levels deep: Part One (p0) / Chapter A (p1) / Chapter B (p2) /
 * Part Two (p3) / Chapter C (p4) / Section C.1 (p5). `two-page.pdf` is the no-outline case.
 */
const OUTLINED_PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/outlined-six-page.pdf", import.meta.url)),
);

async function servePdf(page: Page, body: Buffer = PDF_BYTES): Promise<void> {
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
async function inkFraction(page: Page): Promise<number> {
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

test.describe("PDF viewer (real MuPDF wasm)", () => {
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

  test("lays the panel and the page out as the reader does, and fits at Fit", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    /** Read with the panel closed: `.pdf-stage` is sized by the canvas, so measuring it is circular. */
    const fit = () =>
      page.evaluate(() => {
        const c = document.querySelector(".pdf-page") as HTMLCanvasElement;
        const r = c.getBoundingClientRect();
        const wrap = document.querySelector(".pdf-wrap") as HTMLElement;
        const cs = getComputedStyle(wrap);
        const w = wrap.getBoundingClientRect();
        const panel = document.querySelector("#pdf-pages-panel")!.getBoundingClientRect();
        const availW =
          w.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) -
          panel.width - (panel.width ? parseFloat(cs.columnGap) || 0 : 0);
        const availH = w.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        return {
          fill: Math.max(r.width / availW, r.height / availH),
          // 1 is DPR-sharp; >1 is memory spent to be CSS-shrunk.
          sharp: c.width / (r.width * devicePixelRatio),
        };
      });

    expect((await fit()).fill).toBeGreaterThan(0.98);

    const pages = region.getByRole("button", { name: "Pages", exact: true });
    if ((await pages.getAttribute("aria-pressed")) !== "true") await pages.click();
    await expect(page.locator("#pdf-pages-panel")).toBeVisible();

    // Opening the panel must re-raster; only the buffer/box ratio reveals a skipped one.
    await expect.poll(async () => (await fit()).sharp, { timeout: 20_000 }).toBeLessThanOrEqual(1.02);

    const g = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const wrap = document.querySelector(".pdf-wrap") as HTMLElement;
      const inner = document.querySelector(".viewer--pdf .viewer__main") as HTMLElement;
      const cs = getComputedStyle(wrap);
      const stageTop = box(".pdf-wrap").top + parseFloat(cs.paddingTop);
      const stageBottom = box(".pdf-wrap").bottom - parseFloat(cs.paddingBottom);
      return {
        panelTop: box("#pdf-pages-panel").top,
        panelWidth: box("#pdf-pages-panel").width,
        pageMidY: (box(".pdf-page").top + box(".pdf-page").bottom) / 2,
        stageTop,
        stageMidY: (stageTop + stageBottom) / 2,
        pageBottom: box(".pdf-page").bottom,
        wrapBottom: box(".pdf-wrap").bottom,
        padBottom: parseFloat(cs.paddingBottom),
        wrapOverflow: wrap.scrollHeight - wrap.clientHeight,
        innerOverflow: inner.scrollHeight - inner.clientHeight,
        innerOverflowY: getComputedStyle(inner).overflowY,
      };
    });

    // The panel starts at the stage top; the page centres in what is left.
    expect(Math.abs(g.panelTop - g.stageTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.pageMidY - g.stageMidY)).toBeLessThanOrEqual(1);

    // `--panel-w-narrow`, the thumbnail-column token, not the 268px `--panel-w`.
    expect(g.panelWidth).toBeLessThanOrEqual(190);
    // One scroller; a nested `overflow: auto` hid a tall page's overflow.
    expect(g.innerOverflowY).not.toBe("auto");
    expect(g.innerOverflow).toBeLessThanOrEqual(1);
    expect(g.pageBottom).toBeLessThanOrEqual(g.wrapBottom - g.padBottom + 1);
    expect(g.wrapOverflow).toBeLessThanOrEqual(1);
  });

  test("pages with the arrow keys, like the reader, and leaves on Escape", async ({ page }) => {
    // Arrow keys page and Escape leaves, as in the reader.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");

    await page.keyboard.press("ArrowRight");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    // The page moved, not just the counter.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await page.keyboard.press("ArrowLeft");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");

    await page.keyboard.press("ArrowLeft");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");

    // `createToolbar` roves on arrows while focused, so this handler sits on `document`.
    const pages = region.getByRole("button", { name: "Pages", exact: true });
    if ((await pages.getAttribute("aria-pressed")) !== "true") await pages.click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");
    await page.keyboard.press("ArrowRight"); // focus is on Pages — the toolbar's
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");

    await page.locator(".pdf-page").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ArrowRight");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    await expect(region.locator(".filmstrip__page").nth(1)).toHaveAttribute("aria-current", "true");

    // Home/End are prevented, or they also scroll the stage.
    await page.keyboard.press("Home");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");
    await page.keyboard.press("End");
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");

    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
  });

  // The same pager (`viewerChrome.createPager`) is asserted in `reader.spec.ts`.
  test("the page readout is a field: a number lands, out of range clamps, Escape reverts", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    const field = region.locator(".pdf-pager__count");
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(field).toHaveValue("1 / 2");

    await expect(region.getByRole("textbox", { name: "Page" })).toBeVisible();

    await field.fill("2");
    await field.press("Enter");
    await expect(field).toHaveValue("2 / 2");
    await expect(region.locator(".filmstrip__page").nth(1)).toHaveAttribute("aria-current", "true");
    await expect(field).not.toBeFocused();

    // Clamps: this viewer's `go` silently drops an out-of-range jump.
    await field.fill("1");
    await field.press("Enter");
    await field.fill("9");
    await field.press("Enter");
    await expect(field).toHaveValue("2 / 2");

    // This viewer closes on document Escape, so the field must stop the key.
    await field.fill("1");
    await field.press("Escape");
    await expect(field).toHaveValue("2 / 2");
    await expect(region).toBeVisible();

    await expect(region.locator(".pager__live")).toHaveText("Page 2 of 2");
  });

  test("orders its controls and words its subtitle as the reader does", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    /** Is the pager to the left of the zoom stepper inside `scope`? */
    const pagerBeforeZoom = async (scope: Locator) => {
      const pager = await scope.getByRole("button", { name: "Previous page" }).first().boundingBox();
      const zoom = await scope.getByRole("button", { name: "Zoom out" }).first().boundingBox();
      return pager!.x < zoom!.x;
    };

    // Asserted in both viewers, so neither can drift.
    expect(await pagerBeforeZoom(region)).toBe(true);

    await expect(region.locator(".viewer__title")).toContainText("2 pages");
    await expect(region.locator(".viewer__title")).not.toContainText("PDF");

    await page.goto("/#/note/141");
    await freezeMotion(page);
    await expect(page.locator(".reader.is-open")).toBeVisible();
    expect(await pagerBeforeZoom(page.locator(".reader.is-open"))).toBe(true);
  });

  test("an unpainted row is a BLANK sheet, not the note reader's ruled paper", async ({ page }) => {
    // Regression: the shared `.filmstrip__thumb` showed ruled-paper placeholders in the PDF strip.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    const pages = region.getByRole("button", { name: "Pages", exact: true });
    if ((await pages.getAttribute("aria-pressed")) !== "true") await pages.click();
    await expect(region.locator(".filmstrip__thumb").first()).toBeVisible();

    const bg = (sel: string) =>
      page.evaluate(
        (s) => getComputedStyle(document.querySelector(s)!).backgroundImage,
        sel,
      );
    expect(await bg(".viewer--pdf .filmstrip__thumb")).toBe("none");

    // Scoped fix: the reader keeps its ruled paper.
    await page.goto("/#/note/141");
    await freezeMotion(page);
    await expect(page.locator("#note-pages-panel .filmstrip__thumb").first()).toBeVisible();
    expect(await bg("#note-pages-panel .filmstrip__thumb")).toContain("gradient");
  });

  test("a paired .mark lands on ITS page, over the document, without hiding it", async ({ page }) => {
    // The fixture's mark annotates PDF page 2 only; ignoring `sourcePage` would look plausible.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const overlay = page.locator(".pdf-mark");
    await expect(overlay).toBeHidden();

    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    // The host is revealed before the ink is decoded; wait for a layer canvas.
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });

    const geo = await page.evaluate(() => {
      const host = document.querySelector(".pdf-mark") as HTMLElement;
      const canvas = document.querySelector(".pdf-page") as HTMLCanvasElement;
      const h = host.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return {
        hostBg: getComputedStyle(host).backgroundColor,
        pad: {
          left: c.left - h.left,
          top: c.top - h.top,
          right: h.right - c.right,
          bottom: h.bottom - c.bottom,
        },
        grew: Math.max(h.width / c.width, h.height / c.height),
        layers: host.querySelectorAll("canvas").length,
      };
    });

    // `createNoteLayersController` paints the host white by default, which hid the PDF.
    expect(geo.hostBg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

    // Ink is in device-panel pixels and the page is letterboxed in that panel, so the host
    // is oversized and `.pdf-stage` clips the overhang. Containment holds for either orientation.
    for (const v of Object.values(geo.pad)) expect(v).toBeGreaterThanOrEqual(-1);
    expect(geo.grew).toBeGreaterThan(1.02);
    expect(geo.layers).toBeGreaterThan(0);

    const clear = await page.evaluate(() => {
      const vis = Array.from(document.querySelectorAll<HTMLCanvasElement>(".pdf-mark canvas")).filter(
        (c) => getComputedStyle(c).display !== "none",
      );
      return vis.every((c) => {
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let opaqueWhite = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 10 && d[i]! > 200) opaqueWhite++;
        return opaqueWhite === 0; // ink only; no paper
      });
    });
    expect(clear).toBe(true);
  });

  // --- the filmstrip shows the ink ---
  // On `two-page-panel.pdf` the panel maps 1:1 onto the 90x120 thumbnail (row = panel/15.6):
  // Main 12.8–25.6, hidden Layer 2 51.3–70.5, Layer Renamed 89.7–96.2; the PDF's own
  // drawing is rows 30.0–45.1.

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

  test("drags across three lines and copies the passage WITH its line breaks", async ({
    page,
    context,
  }) => {
    // End to end from the shim's per-word line id to the system clipboard.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signedIn(page);
    await servePdf(page, THREE_LINE_PDF_BYTES);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const layer = region.locator(".pdf-select");
    await expect(layer).toBeVisible();
    // Words load on hover intent. Hover the page: the layer is `pointer-events: none` until then.
    await region.locator(".pdf-page").hover();
    await expect(layer).toHaveClass(/is-selectable/, { timeout: 20_000 });

    const box = (await layer.boundingBox())!;
    // The page is 300pt wide; the first baseline is 30pt from the top.
    const k = box.width / 300;
    await page.mouse.move(box.x + 15 * k, box.y + 25 * k);
    await page.mouse.down();
    // Past the last word: the layer resolves the margin to the nearest word.
    await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, { steps: 10 });
    await page.mouse.up();

    await expect(region.locator(".pdf-select__box").first()).toBeVisible();
    const copyBtn = region.getByRole("button", { name: "Copy selected text" });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe("Marmalade kettle descaling\ngamma delta epsilon\nzeta eta theta");
  });

  test("Escape drops the selection and keeps the document", async ({ page }) => {
    // One Escape clears the selection only.
    await signedIn(page);
    await servePdf(page, THREE_LINE_PDF_BYTES);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    const layer = region.locator(".pdf-select");
    await region.locator(".pdf-page").hover();
    await expect(layer).toHaveClass(/is-selectable/, { timeout: 20_000 });

    const box = (await layer.boundingBox())!;
    const k = box.width / 300;
    await page.mouse.move(box.x + 15 * k, box.y + 25 * k);
    await page.mouse.down();
    await page.mouse.move(box.x + 120 * k, box.y + 25 * k, { steps: 6 });
    await page.mouse.up();
    await expect(region.locator(".pdf-select__box").first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(region.locator(".pdf-select__box")).toHaveCount(0);
    await expect(region.getByRole("button", { name: "Copy selected text" })).toBeHidden();
    await expect(region).toBeVisible();
  });

  test("the ink rail marks ONLY the annotated row, through the mark's sourcePage", async ({
    page,
  }) => {
    // The mark is sparse and names page 2; ordering by the mark's own pages would mark row 1.
    const region = await openStrip(page);
    const row = (n: number) => region.locator(".filmstrip__page").nth(n);
    await expect(row(1)).toHaveClass(/filmstrip__page--inked/);
    await expect(row(0)).not.toHaveClass(/filmstrip__page--inked/);

    await expect(row(1)).toHaveAttribute("aria-label", "Page 2, annotated");
    await expect(row(0)).toHaveAttribute("aria-label", "Page 1");
  });

  test("a PDF with no .mark claims nothing about any page", async ({ page }) => {
    // A plain PDF has no mark, so the rail stays empty rather than claiming un-annotated.
    await signedIn(page);
    await servePdf(page);
    // 142 has no `.mark`; 178 does.
    await page.goto("/#/note/142");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    const pages = region.getByRole("button", { name: "Pages", exact: true });
    if ((await pages.getAttribute("aria-pressed")) !== "true") await pages.click();
    await expect(region.locator(".filmstrip__page").first()).toBeVisible();
    await expect(region.locator(".filmstrip__page--inked")).toHaveCount(0);
    await expect(region.locator(".filmstrip__page").first()).toHaveAttribute(
      "aria-label",
      "Page 1",
    );
  });

  test("the STRIP carries the mark's handwriting, on the row that was written on", async ({
    page,
  }) => {
    const region = await openStrip(page);
    const thumb = (n: number) => region.locator(".filmstrip__page").nth(n).locator("canvas");

    // Polled: the mark may land after the row's first paint.
    await expect
      .poll(async () => band(await thumbRowInk(thumb(1)), 15, 23), { timeout: 20_000 })
      .toBeGreaterThan(0.9);
    const inked = await thumbRowInk(thumb(1));
    expect(band(inked, 91, 95)).toBeGreaterThan(0.9);
    // The hidden layer's band must stay paper.
    expect(band(inked, 55, 66)).toBeLessThan(0.05);
    expect(band(inked, 33, 42)).toBeGreaterThan(0.2);
    expect(band(inked, 33, 42)).toBeLessThan(0.4);

    const plain = await thumbRowInk(thumb(0));
    expect(band(plain, 15, 23)).toBeLessThan(0.05);
    expect(band(plain, 91, 95)).toBeLessThan(0.05);
    expect(band(plain, 33, 42)).toBeGreaterThan(0.2);
  });

  test("the composited row is a CACHE ENTRY of its own, and survives a late mark", async ({
    page,
  }) => {
    // Keyed by both blobs (`thumbKey`), so an ink-free entry cached before the mark landed is not
    // served forever. A reopen reproduces the late mark: the strip comes from IndexedDB first.
    await openStrip(page);
    await page.goto("/#/");
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(page.locator("#pdf-pages-panel")).toBeVisible(); // chrome state survives

    const thumb = region.locator(".filmstrip__page").nth(1).locator("canvas");
    await expect
      .poll(async () => band(await thumbRowInk(thumb), 15, 23), { timeout: 20_000 })
      .toBeGreaterThan(0.9);

    // `renders` and `inked` are zero: the composite came back from `sn-thumbs` whole.
    const counts = await page.evaluate(
      () =>
        (globalThis as unknown as { __inkholdPdfThumbs?: { renders: number; inked: number } })
          .__inkholdPdfThumbs ?? { renders: -1, inked: -1 },
    );
    expect(counts.renders).toBe(0);
    expect(counts.inked).toBe(0);
  });

  test("leaving the document DROPS the mark's canvases, rather than hiding them", async ({
    page,
  }) => {
    // Hiding a stack frees nothing; only `release()` zeroes the RGBA backing stores (50 MB app
    // budget). Observable as `host.replaceChildren()`.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    await region.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });

    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
    await expect(page.locator(".pdf-mark canvas")).toHaveCount(0);
  });

  test("the annotations panel lists the document under the ink, and toggles both", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });

    await region.getByRole("button", { name: "Annotations" }).click();
    const panel = page.locator("#pdf-layers-panel");
    await expect(panel).toBeVisible();

    await expect(panel.getByText("Document")).toBeVisible();
    // The mark's Background Layer is the device's paper, which the document replaces.
    await expect(panel.getByText("Background Layer")).toHaveCount(0);

    const canvas = page.locator(".pdf-page");
    const row = panel.locator(".layers-panel__row", { hasText: "Document" });
    await row.getByRole("button").click();
    await expect(canvas).toHaveCSS("visibility", "hidden");
    await expect(page.locator(".pdf-mark")).toBeVisible();
    await row.getByRole("button").click();
    await expect(canvas).toHaveCSS("visibility", "visible");
  });

  test("thumbnails come back from the cache on a REOPEN, still drawable", async ({ page }) => {
    // The cache owns its bitmaps (`renderCache.ts`); a viewer closing one leaves a dead entry
    // that only a later read finds. Reopening forces that read.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(region.locator(".filmstrip__thumb:not(.is-loading)").first()).toBeVisible({
      timeout: 20_000,
    });

    // Counters reset per open.
    await page.goto("/#/");
    await page.goto("/#/note/178");
    await freezeMotion(page);
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    // The panel's open state is viewer chrome and survives the document change.
    await expect(page.locator("#pdf-pages-panel")).toBeVisible();

    // Polled: the previous visit's rows linger in the DOM for a moment.
    const counts = () =>
      page.evaluate(
        () => (globalThis as unknown as {
          __inkholdPdfThumbs?: { hits: number; renders: number; probe: number };
        }).__inkholdPdfThumbs ?? { hits: 0, renders: 0, probe: 0 },
      );
    // Wait for paint first, so the poll budget covers the cache read, not the cold boot.
    await expect(region.locator(".filmstrip__thumb:not(.is-loading)").first()).toBeVisible({
      timeout: 30_000,
    });
    // One sample: two polls could describe different moments.
    await expect.poll(async () => (await counts()).hits, { timeout: 20_000 }).toBeGreaterThan(0);
    const settled = await counts();
    expect(settled.hits).toBeGreaterThan(0);
    expect(settled.renders).toBe(0); // nothing was rendered twice

    // `probe` is the largest parallel batch; a serial read would report 1.
    expect((await counts()).probe).toBeGreaterThan(1);
    const ink = await region.locator(".filmstrip__thumb canvas").first().evaluate((c) => {
      const cv = c as HTMLCanvasElement;
      if (!cv.width) return -1;
      const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      let marks = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 200) marks++;
      return marks / (d.length / 4);
    });
    expect(ink).toBeGreaterThan(0.002);
  });
});

// ---- download menu ----
// Page 2 is 300 x 150 pt; width binds, so its rect in the 1404 x 1872 panel is
// 1404 x 702 at (0, 585). Only hidden Layer 2 (panel rows 800–1100) falls inside it.

/** Disambiguated from the bin cluster's "…" menu by its group headings. */
const pdfMenu = (page: Page) =>
  page.locator(".viewer--pdf .menu__pop", { has: page.locator(".menu__head") });

const pdfGroupItem = (page: Page, head: string, name: string) =>
  pdfMenu(page)
    .locator("> div")
    .filter({ has: page.locator(".menu__head", { hasText: head }) })
    .getByRole("menuitem", { name });

/** Read a completed download into memory. */
async function downloadBytes(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("download produced no file");
  return readFile(path);
}

/** Inflates every `stream…endstream` that inflates; others (the CCITT ink stencil) drop out. */
function inflatedStreams(pdf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = pdf.indexOf("stream"); at >= 0; at = pdf.indexOf("stream", at + 6)) {
    let from = at + 6;
    if (pdf[from] === 0x0d) from++;
    if (pdf[from] === 0x0a) from++;
    const end = pdf.indexOf("endstream", from);
    if (end < 0) continue;
    try {
      out.push(inflateSync(pdf.subarray(from, end)));
    } catch {
      // Not deflated, or not a stream.
    }
  }
  return out;
}

/** Open the annotated fixture; `page2` walks to the one page that has ink. */
async function openMarkedPdf(page: Page, page2: boolean): Promise<Locator> {
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

/** Open the Annotations panel and hand back its row locator factory. */
async function annotationsPanel(page: Page, region: Locator) {
  await region.getByRole("button", { name: "Annotations" }).click();
  const panel = page.locator("#pdf-layers-panel");
  await expect(panel).toBeVisible();
  return (name: string) => panel.locator(".layers-panel__row", { hasText: name }).getByRole("button");
}

test.describe("PDF export menu", () => {
  test("a page with no ink offers its flattened image, its own PDF and the raw file", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Download" }).click();

    // The original group is in the DOM but hidden until something is toggled.
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "Whole document",
    ]);
    // The ORA folds away on a bare page; the per-page PDF stays.
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(4);
    await expect(pdfGroupItem(page, "Current view", "Flattened image")).toBeVisible();
    await expect(pdfGroupItem(page, "Current view", "PDF document")).toBeVisible();
    await expect(pdfGroupItem(page, "Whole document", "PDF document")).toBeVisible();
    await expect(pdfGroupItem(page, "Whole document", "PDF with annotations")).toBeVisible();
    await expect(pdfMenu(page).getByRole("menuitem", { name: "Layered image" })).toBeHidden();
  });

  test("the ink adds the layered row, and a toggle adds the whole ORIGINAL group", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, true);
    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "Whole document",
    ]);
    await expect(pdfGroupItem(page, "Current view", "Layered image")).toBeVisible();
    // Nothing toggled, so the original-view header would duplicate rows.
    await expect(pdfMenu(page).locator(".menu__head:visible")).not.toContainText([
      "This page — Original view",
    ]);

    // The panel is behind the menu; a click outside dismisses the menu first.
    const row = await annotationsPanel(page, region);
    await row("Layer 2").click();

    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "This page — Original view",
      "Whole document",
    ]);
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(8);
    await expect(pdfGroupItem(page, "Original view", "PDF document")).toBeVisible();
  });

  test("turning the PAGE off is itself enough to offer the ORIGINAL view", async ({ page }) => {
    // Hiding the Document layer diverges from the authored view, so "original" is real.
    const region = await openMarkedPdf(page, false);
    const row = await annotationsPanel(page, region);
    await row("Document").click();

    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "This page — Original view",
      "Whole document",
    ]);
    await expect(pdfMenu(page).getByRole("menuitem", { name: "Layered image" })).toBeHidden();

    // A PDF of this page cannot omit the page itself, so only the PNG answers "ink alone".
    await expect(pdfGroupItem(page, "Current view", "PDF document")).toBeHidden();
    await expect(pdfGroupItem(page, "Original view", "PDF document")).toBeVisible();
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(5);
  });

  test("the raw PDF still downloads unchanged, from WHOLE DOCUMENT", async ({ page }) => {
    // The raw-file row from the old `<a download>`.
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Whole document", "PDF document").click(),
    ]);
    expect(download.url()).toContain("/file/");
  });

  test("the per-page PDF is the PAGE ITSELF, with the ink drawn over it", async ({ page }) => {
    // The per-page PDF grafts the source page and stencils ink on top, so text and vectors
    // survive; a raster export would pass a weaker test.
    const region = await openMarkedPdf(page, true);
    // Layer 2 is the only band in this page's rect, and it is device-hidden.
    const row = await annotationsPanel(page, region);
    await row("Layer 2").click();

    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "PDF document").click(),
    ]);
    expect(download.suggestedFilename()).toBe("Appliance manual_p2_current.pdf");

    const bytes = await downloadBytes(download);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = bytes.toString("latin1");
    expect(text).toContain("/MediaBox[0 0 300 150]");
    expect(text).toContain("/Count 1");

    const streams = inflatedStreams(bytes);
    const content = streams.find((s) => s.includes("Do"))?.toString("latin1") ?? "";
    // The fixture's vector `10 10 20 20 re f` survives verbatim.
    expect(content).toContain("10 10 20 20 re f");
    // `markExportMatrix`.
    expect(content).toMatch(/300 0 0 150 0 0 cm\s*\/\w+ Do/);
    // The mask stays at the ink's resolution (`markExportSpace`).
    expect(text).toContain("/Width 1404");
    expect(text).toContain("/Height 702");

    // Layer 2 (800–1100) minus the 585 offset covers export rows 215–514.
    const soft = streams.find((s) => s.length === 1404 * 702);
    expect(soft).toBeTruthy();
    let firstRow = -1;
    let lastRow = -1;
    for (let i = 0; i < soft!.length; i++) {
      if (soft![i] === 0) continue;
      const r = Math.floor(i / 1404);
      if (firstRow < 0) firstRow = r;
      lastRow = r;
    }
    expect(firstRow).toBe(215);
    expect(lastRow).toBe(514);
  });

  test("the per-page PDF row always answers, and never wedges itself", async ({ page }) => {
    // Grafting drops `/Annots`, so the toast says so. `menu.item` must re-enable the row in `finally`.
    const region = await openMarkedPdf(page, true);
    await region.getByRole("button", { name: "Download" }).click();
    await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "PDF document").click(),
    ]);

    const toast = page.locator(".toast");
    await expect(toast).toContainText("Saved Appliance manual_p2_current.pdf");
    await expect(toast).toContainText("this page only");
    await expect(toast).toContainText("not carried over");

    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfGroupItem(page, "Current view", "PDF document")).toBeEnabled();
  });

  test("the WHOLE document export appends to the original instead of rebuilding it", async ({
    page,
  }) => {
    // The annotated whole-document export is an incremental update: the original bytes are a
    // verbatim prefix, which is why its `/Annots` survive (asserted in `pdf_decode_abi.mjs`).
    const region = await openMarkedPdf(page, true);
    const row = await annotationsPanel(page, region);
    // Whole-document export burns in the authored view; panel toggles do not apply.
    await row("Layer 2").click();

    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Whole document", "PDF with annotations").click(),
    ]);
    expect(download.suggestedFilename()).toBe("Appliance manual_annotated.pdf");

    const bytes = await downloadBytes(download);
    expect(bytes.length).toBeGreaterThan(PDF_BYTES.length);
    expect(bytes.subarray(0, PDF_BYTES.length).equals(PDF_BYTES)).toBe(true);

    const text = bytes.toString("latin1");
    expect(text).toContain("/Count 2");
    expect(text).toContain("/Width 1404");
    // The appended /Resources names the ink XObject per page, so pages sharing a dictionary
    // do not overwrite each other.
    const delta = bytes.subarray(PDF_BYTES.length).toString("latin1");
    expect(delta).toMatch(/\/InkholdInk\d+ \d+ 0 R/);

    // The opposite copy from the per-page toast: annotations are kept.
    const toast = page.locator(".toast");
    await expect(toast).toContainText("Saved Appliance manual_annotated.pdf");
    await expect(toast).toContainText("whole document");
    await expect(toast).toContainText("preserved");
    await expect(toast).not.toContainText("not carried over");

    // The export mutates the open PDF, so the worker reopens it; else the ink would draw twice.
    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfGroupItem(page, "Whole document", "PDF with annotations")).toBeEnabled();
  });

  test("the flattened PNG is the PAGE's rect at the INK's own resolution", async ({ page }) => {
    const region = await openMarkedPdf(page, true);
    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "Flattened image").click(),
    ]);

    expect(download.suggestedFilename()).toBe("Appliance manual_p2_current.png");

    const bytes = await downloadBytes(download);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
    // 1404 x 702: the page rect inside the panel.
    expect(bytes.readUInt32BE(16)).toBe(1404);
    expect(bytes.readUInt32BE(20)).toBe(702);
  });

  test("a page with no ink still exports, at a resolution near the annotated one", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "Flattened image").click(),
    ]);
    expect(download.suggestedFilename()).toBe("Appliance manual_p1_current.png");
    const bytes = await downloadBytes(download);
    // No panel to agree with, so the export uses a flat 2x (144 dpi).
    expect(bytes.readUInt32BE(16)).toBe(400);
    expect(bytes.readUInt32BE(20)).toBe(200);
  });

  test("the layered ORA holds the document UNDER the ink, and no background sheet", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, true);
    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "Layered image").click(),
    ]);
    expect(download.suggestedFilename()).toBe("Appliance manual_p2_current.ora");

    const bytes = await downloadBytes(download);
    const text = bytes.toString("latin1");
    // Boolean asserts: a failed `toContain` would print hundreds of KB of zip.
    expect(text.startsWith("PK\x03\x04")).toBe(true);
    expect(text.includes("image/openraster")).toBe(true);
    const stack = /<\?xml[\s\S]*?<\/image>/.exec(text)?.[0] ?? "";
    expect(stack).toContain("<image w='1404' h='702'>");

    // OpenRaster stacks are top-first, so the document must come last.
    const names = [...stack.matchAll(/<layer name='([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual(["Layer Renamed", "Layer 2", "Main Layer", "Document"]);
    // The device paper layer must not be in the ORA: it would white out the document.
    expect(stack).not.toContain("Background Layer");
    expect(stack).toContain("name='Layer 2' src='data/layer_2.png' opacity='1.00' visibility='hidden'");
    // Ids are renumbered from the document up, so no `layer_-1.png`.
    expect(stack).toContain("src='data/layer_0.png'");
    expect(stack).not.toContain("layer_-1.png");
    for (const n of [0, 1, 2, 3]) expect(text.includes(`data/layer_${n}.png`)).toBe(true);
  });

  test("HIDING THE DOCUMENT EXPORTS INK ON TRANSPARENCY", async ({ page }) => {
    // `exportFlatPng` fills no background, so hiding the document leaves transparency.
    const region = await openMarkedPdf(page, true);
    const row = await annotationsPanel(page, region);
    await row("Layer 2").click();
    await row("Document").click();
    await expect(page.locator(".pdf-page")).toHaveCSS("visibility", "hidden");

    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "Flattened image").click(),
    ]);
    const bytes = await downloadBytes(download);

    // Decoded in the browser; Node has no PNG decoder here.
    const seen = await page.evaluate(async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d")!.drawImage(bmp, 0, 0);
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let clear = 0;
      let opaque = 0;
      let firstInkRow = -1;
      let lastInkRow = -1;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) {
          clear++;
          continue;
        }
        opaque++;
        const row = Math.floor(i / 4 / bmp.width);
        if (firstInkRow < 0) firstInkRow = row;
        lastInkRow = row;
      }
      return { w: bmp.width, h: bmp.height, clear, opaque, firstInkRow, lastInkRow };
    }, bytes.toString("base64"));

    expect(seen.w).toBe(1404);
    expect(seen.h).toBe(702);
    expect(seen.opaque).toBeGreaterThan(0);
    expect(seen.clear).toBeGreaterThan(seen.opaque);
    // Without the 585-row translation, Main's band would show up at row 200.
    expect(seen.firstInkRow).toBe(215);
    expect(seen.lastInkRow).toBe(514);

    await region.getByRole("button", { name: "Download" }).click();
    const [original] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Original view", "Flattened image").click(),
    ]);
    expect(original.suggestedFilename()).toBe("Appliance manual_p2_original.png");
    const originalSeen = await page.evaluate(async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d")!.drawImage(bmp, 0, 0);
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let clear = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]! === 0) clear++;
      return clear;
    }, (await downloadBytes(original)).toString("base64"));
    expect(originalSeen).toBe(0);
  });
});

// ---- the document's own links ----
// MuPDF `/Annots` must come back as real anchors at the right place; the rects themselves
// are pinned in `pdf_decode_abi.mjs`.

/**
 * Same page sizes as `two-page.pdf`, so the paired `.mark` placement is unchanged. ASCII
 * only, so string offsets are byte offsets.
 */
function linkedPdfBytes(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    // Page 1: external, internal (to page 2) and a `javascript:` link that must not render.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R" +
      " /Resources << >> /Annots [7 0 R 8 0 R 9 0 R] >>",
    "<< /Length 26 >>\nstream\n0 0 0 rg\n10 10 40 30 re f\nendstream",
    // Page 2, 300x150 pt, where the `.mark` writes.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Contents 6 0 R" +
      " /Resources << >> /Annots [10 0 R] >>",
    "<< /Length 27 >>\nstream\n0 0 0 rg\n10 10 60 40 re f\nendstream",
    "<< /Type /Annot /Subtype /Link /Rect [20 20 80 60] /Border [0 0 0]" +
      " /A << /S /URI /URI (https://example.invalid/a) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [100 20 160 60] /Border [0 0 0]" +
      " /A << /S /GoTo /D [5 0 R /XYZ 0 150 0] >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [20 70 80 90] /Border [0 0 0]" +
      " /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [50 50 150 100] /Border [0 0 0]" +
      " /A << /S /URI /URI (https://example.invalid/two) >> >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objs.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const startxref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function openLinkedPdf(page: Page): Promise<Locator> {
  await signedIn(page);
  await servePdf(page, linkedPdfBytes());
  await page.goto("/#/note/178");
  await freezeMotion(page);
  const region = page.getByRole("region", { name: "PDF viewer" });
  await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  return region;
}

test.describe("PDF links", () => {
  test("lands each anchor on its own rect, labelled, and drops `javascript:`", async ({ page }) => {
    await openLinkedPdf(page);
    const layer = page.locator(".pdf-links");
    await expect(layer.locator("a")).toHaveCount(2, { timeout: 20_000 });

    // The `javascript:` annot produces no element at all.
    const hrefs = await layer.locator("a").evaluateAll((as) =>
      as.map((a) => (a as HTMLAnchorElement).getAttribute("href")),
    );
    expect(hrefs.some((h) => h?.startsWith("javascript:"))).toBe(false);

    const ext = layer.locator('a[href="https://example.invalid/a"]');
    await expect(ext).toHaveAttribute("target", "_blank");
    await expect(ext).toHaveAttribute("rel", "noopener noreferrer");
    await expect(ext).toHaveAttribute("aria-label", "https://example.invalid/a");

    const internal = layer.locator('a[href="#/note/178/page/2"]');
    await expect(internal).toHaveCount(1);
    await expect(internal).toHaveAttribute("aria-label", "Go to page 2");
    await expect(internal).not.toHaveAttribute("target", "_blank");

    // PDF (20,20)-(80,60) on a 100pt-tall page: x 20..80, y 40..80, as canvas fractions.
    const geo = await page.evaluate(() => {
      const c = (document.querySelector(".pdf-page") as HTMLElement).getBoundingClientRect();
      const a = (
        document.querySelector('.pdf-links a[href="https://example.invalid/a"]') as HTMLElement
      ).getBoundingClientRect();
      return {
        left: (a.left - c.left) / c.width,
        top: (a.top - c.top) / c.height,
        width: a.width / c.width,
        height: a.height / c.height,
      };
    });
    expect(geo.left).toBeCloseTo(20 / 200, 2);
    expect(geo.top).toBeCloseTo(40 / 100, 2);
    expect(geo.width).toBeCloseTo(60 / 200, 2);
    expect(geo.height).toBeCloseTo(40 / 100, 2);
  });

  test("following an internal link is a real navigation to that page", async ({ page }) => {
    const region = await openLinkedPdf(page);
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");
    await page.locator('.pdf-links a[href="#/note/178/page/2"]').click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2", { timeout: 20_000 });
    expect(page.url()).toContain("#/note/178/page/2");
    // A link that moved the counter over a stale canvas would pass the rest.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(page.locator(".pdf-links a")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('.pdf-links a[href="https://example.invalid/two"]')).toHaveCount(1);
  });

  test("the layer follows the raster through a zoom, and through a panel", async ({ page }) => {
    // Placement is computed from the canvas's real size after the raster lands.
    const region = await openLinkedPdf(page);
    const anchor = page.locator('.pdf-links a[href="https://example.invalid/a"]');
    await expect(anchor).toBeVisible({ timeout: 20_000 });

    // Null while the layer is down: each repaint removes old anchors first.
    const measure = async (): Promise<{ canvas: number; left: number; width: number } | null> =>
      page.evaluate(() => {
        const canvas = document.querySelector(".pdf-page") as HTMLElement | null;
        const a = document.querySelector(
          '.pdf-links a[href="https://example.invalid/a"]',
        ) as HTMLElement | null;
        if (!canvas || !a) return null;
        const c = canvas.getBoundingClientRect();
        const r = a.getBoundingClientRect();
        return { canvas: c.width, left: (r.left - c.left) / c.width, width: r.width / c.width };
      });
    const settled = async () => {
      let seen: { canvas: number; left: number; width: number } | null = null;
      await expect.poll(async () => (seen = await measure()) !== null).toBe(true);
      return seen!;
    };

    const fit = await settled();
    // Two steps: `Fit ⇔` sits between Fit and 150%.
    await region.getByRole("button", { name: "Zoom in" }).click();
    await region.getByRole("button", { name: "Zoom in" }).click();
    await expect(region.locator(".pdf-zoom", { hasText: "150%" })).toBeVisible();
    await expect.poll(async () => (await measure())?.canvas ?? 0).toBeGreaterThan(fit.canvas * 1.2);
    const zoomed = await settled();
    expect(zoomed.left).toBeCloseTo(fit.left, 2);
    expect(zoomed.width).toBeCloseTo(fit.width, 2);
    expect(zoomed.width * zoomed.canvas).toBeGreaterThan(fit.width * fit.canvas * 1.2);

    await region.getByRole("button", { name: "Zoom out" }).click();
    await region.getByRole("button", { name: "Zoom out" }).click();
    await region.getByRole("button", { name: "Pages" }).click();
    await expect(page.locator("#pdf-pages-panel")).toBeVisible();
    await expect.poll(async () => (await measure())?.canvas ?? 0).toBeLessThan(fit.canvas);
    const narrowed = await settled();
    expect(narrowed.left).toBeCloseTo(fit.left, 2);
    expect(narrowed.width).toBeCloseTo(fit.width, 2);
  });

  test("a link UNDER a scribble is still the thing you click", async ({ page }) => {
    // `.pdf-mark` is `pointer-events: none`, and the DOM order also puts links above ink.
    await signedIn(page);
    await servePdf(page, linkedPdfBytes());
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });
    const anchor = page.locator('.pdf-links a[href="https://example.invalid/two"]');
    await expect(anchor).toBeVisible({ timeout: 20_000 });

    const stacked = await page.evaluate(() => {
      const stage = document.querySelector(".pdf-stage") as HTMLElement;
      const kids = Array.from(stage.children).map((k) => k.className.split(" ")[0]);
      const a = document.querySelector(
        '.pdf-links a[href="https://example.invalid/two"]',
      ) as HTMLElement;
      const box = a.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const mark = document.querySelector(".pdf-mark") as HTMLElement;
      const m = mark.getBoundingClientRect();
      return {
        kids,
        hitIsTheLink: hit === a,
        // Without the ink over the link, the hit test proves nothing about stacking.
        markCoversIt:
          !mark.hidden &&
          m.left <= box.left &&
          m.top <= box.top &&
          m.right >= box.right &&
          m.bottom >= box.bottom,
      };
    });
    expect(stacked.markCoversIt).toBe(true);
    // Bottom to top: page; find highlights and the text selection (under the ink, which is
    // the user's own); the `.mark` ink; links last, so they hit-test above any scribble.
    expect(stacked.kids).toEqual([
      "pdf-page",
      "pdf-find-marks",
      "pdf-select",
      "note-stack",
      "pdf-links",
    ]);
    expect(stacked.hitIsTheLink).toBe(true);
  });

  test("leaving the page takes its links with it", async ({ page }) => {
    // Left up, anchors would point into the previous document and stay in the tab order.
    const region = await openLinkedPdf(page);
    await expect(page.locator(".pdf-links a")).toHaveCount(2, { timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
    await expect(page.locator(".pdf-links a")).toHaveCount(0);
  });
});

// ---- outline panel ----

test.describe("PDF outline", () => {
  /** Open the outlined fixture and wait for its first page to paint. */
  async function openOutlinedPdf(page: Page): Promise<Locator> {
    await signedIn(page);
    await servePdf(page, OUTLINED_PDF_BYTES);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect(region).toBeVisible();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 6", { timeout: 20_000 });
    return region;
  }

  test("lists the document's own headings, and an entry JUMPS to its page", async ({ page }) => {
    const region = await openOutlinedPdf(page);
    const panel = region.locator("#pdf-outline-panel");
    const rows = region.locator(".pdf-outline__row");

    const opener = region.getByRole("button", { name: "Outline", exact: true });
    await expect(opener).toBeEnabled({ timeout: 20_000 });

    await expect(panel).toBeHidden();
    await opener.click();
    await expect(panel).toBeVisible();

    // The wire is 0-based; the panel shows 1-based page numbers.
    await expect(rows).toHaveCount(6);
    await expect(rows.locator(".pdf-outline__t")).toHaveText([
      "Part One",
      "Chapter A",
      "Chapter B",
      "Part Two",
      "Chapter C",
      "Section C.1",
    ]);
    await expect(rows.locator(".pdf-outline__p")).toHaveText(["1", "2", "3", "4", "5", "6"]);
    // Depth is indent and type, never colour, via a custom property.
    const depths = await rows.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).style.getPropertyValue("--depth")),
    );
    expect(depths).toEqual(["0", "1", "1", "0", "1", "2"]);

    await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

    await rows.nth(5).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("6 / 6");
    await expect(rows.nth(5)).toHaveAttribute("aria-current", "true");
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "false");
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  });

  test("the mark tracks PAGING, not only clicking", async ({ page }) => {
    // Pages between two entries belong to the earlier one.
    const region = await openOutlinedPdf(page);
    const rows = region.locator(".pdf-outline__row");
    await region.getByRole("button", { name: "Outline", exact: true }).click();
    await expect(rows).toHaveCount(6, { timeout: 20_000 });
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

    // Focus off the toolbar, or the arrows rove between controls.
    await page.locator(".pdf-page").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ArrowRight"); // page 2 — Chapter A
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 6");
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");

    await page.keyboard.press("ArrowRight"); // page 3 — Chapter B
    await expect(rows.nth(2)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("ArrowLeft"); // back to page 2
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("End"); // page 6 — Section C.1
    await expect(rows.nth(5)).toHaveAttribute("aria-current", "true");
    await expect(region.locator('.pdf-outline__row[aria-current="true"]')).toHaveCount(1);
  });

  test("a document with NO outline keeps the opener, dimmed, and says why", async ({ page }) => {
    // A document with no outline shows the opener dimmed, with the reason in its name.
    await signedIn(page);
    await servePdf(page); // the plain two-page fixture
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const opener = region.getByRole("button", { name: "Outline — this document has none" });
    // Presence first: `not.toBeEnabled` would pass on a hidden control.
    await expect(opener).toHaveCount(1);
    await expect(opener).toBeVisible();
    await expect(opener).toBeDisabled();
    await expect(opener).toHaveAttribute("title", "Outline — this document has none");
    await expect(region.getByRole("button", { name: "Outline", exact: true })).toHaveCount(0);
  });

  test("Outline and Pages share one dock: opening either shuts the other", async ({ page }) => {
    // Pages and Outline share one dock: they want different track widths.
    const region = await openOutlinedPdf(page);
    const outlineBtn = region.getByRole("button", { name: "Outline", exact: true });
    const pagesBtn = region.getByRole("button", { name: "Pages", exact: true });
    const outlinePanel = region.locator("#pdf-outline-panel");
    const pagesPanel = region.locator("#pdf-pages-panel");
    await expect(outlineBtn).toBeEnabled({ timeout: 20_000 });

    await pagesBtn.click();
    await expect(pagesPanel).toBeVisible();
    await expect(outlinePanel).toBeHidden();

    await outlineBtn.click();
    await expect(outlinePanel).toBeVisible();
    await expect(pagesPanel).toBeHidden();
    await expect(outlineBtn).toHaveAttribute("aria-pressed", "true");
    await expect(pagesBtn).toHaveAttribute("aria-pressed", "false");

    await pagesBtn.click();
    await expect(pagesPanel).toBeVisible();
    await expect(outlinePanel).toBeHidden();
    await expect(outlineBtn).toHaveAttribute("aria-pressed", "false");
    await expect(pagesBtn).toHaveAttribute("aria-pressed", "true");
  });

  test("the page is never squeezed from BOTH sides at once", async ({ page }) => {
    // On a narrow window, opening one side's panel closes the other side's.
    await page.setViewportSize({ width: 900, height: 800 });
    const region = await openOutlinedPdf(page);
    const outlineBtn = region.getByRole("button", { name: "Outline", exact: true });
    const layersBtn = region.getByRole("button", { name: "Annotations", exact: true });
    const outlinePanel = region.locator("#pdf-outline-panel");
    const layersPanel = region.locator("#pdf-layers-panel");
    await expect(outlineBtn).toBeEnabled({ timeout: 20_000 });

    await outlineBtn.click();
    await expect(outlinePanel).toBeVisible();

    await layersBtn.click();
    await expect(layersPanel).toBeVisible();
    await expect(outlinePanel).toBeHidden();

    await outlineBtn.click();
    await expect(outlinePanel).toBeVisible();
    await expect(layersPanel).toBeHidden();

    const box = (await region.locator(".pdf-page").boundingBox())!;
    expect(box.width).toBeGreaterThan(200);
  });

  test("…but on a wide window both docks stay open together", async ({ page }) => {
    // Only a floor: with room for both, both stay open.
    await page.setViewportSize({ width: 1600, height: 900 });
    const region = await openOutlinedPdf(page);
    const outlineBtn = region.getByRole("button", { name: "Outline", exact: true });
    const layersBtn = region.getByRole("button", { name: "Annotations", exact: true });
    await expect(outlineBtn).toBeEnabled({ timeout: 20_000 });

    await outlineBtn.click();
    await layersBtn.click();
    await expect(region.locator("#pdf-layers-panel")).toBeVisible();
    await expect(region.locator("#pdf-outline-panel")).toBeVisible();
  });

  test("the next annotated document opens with the Annotations toggle UN-pressed", async ({
    page,
  }) => {
    // Regression: teardown left `aria-pressed` set over a closed panel.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    const layersBtn = region.getByRole("button", { name: "Annotations", exact: true });
    const layersPanel = page.locator("#pdf-layers-panel");
    await expect(layersBtn).toBeVisible({ timeout: 20_000 });

    await layersBtn.click();
    await expect(layersPanel).toBeVisible();
    await expect(layersBtn).toHaveAttribute("aria-pressed", "true");

    // `178` is the only fixture with a `.mark`.
    await page.goto("/#/");
    await page.goto("/#/note/178");
    await freezeMotion(page);
    await expect(layersBtn).toBeVisible({ timeout: 20_000 });
    await expect(layersPanel).toBeHidden();
    await expect(layersBtn).toHaveAttribute("aria-pressed", "false");
  });
});

// ---- annotation history ----
// The control offers the paired `.mark`'s versions; nothing may claim the PDF has any.

const vh = (page: Page): Locator => page.locator(".vh");
const vhRows = (page: Page): Locator => page.locator(".vh-row");

test.describe("annotation history, from the PDF viewer", () => {
  test("the control is PRESENT and dimmed on a document with no annotations", async ({ page }) => {
    // 142 has no `.mark`: the control is present and dimmed, with the reason in its name.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/142");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const btn = region.getByRole("button", {
      name: "Annotation history — this document has no annotations",
    });
    await expect(btn).toHaveCount(1);
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute(
      "title",
      "Annotation history — this document has no annotations",
    );
    await expect(region.getByRole("button", { name: "Annotation history", exact: true })).toHaveCount(0);
  });

  test("the control is enabled on a document that HAS annotations, and lists the mark's versions", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, false);
    const btn = region.getByRole("button", { name: "Annotation history", exact: true });
    await expect(btn).toBeEnabled({ timeout: 20_000 });

    await btn.click();
    await expect(vh(page)).toBeVisible();

    await expect(vh(page).locator(".vh__eyebrow")).toHaveText("Annotation history", { timeout: 20_000 });
    await expect(vh(page).locator(".vh__caption")).toContainText("only the annotations");

    await expect(vhRows(page)).toHaveCount(3, { timeout: 20_000 });
    await expect(vhRows(page).nth(0).locator(".tag-current")).toHaveText("Current");
    // Headed by the document's name, not `Appliance manual.pdf.mark`.
    await expect(vh(page)).toHaveAttribute("aria-label", /Appliance manual/);
    await expect(vh(page)).toHaveAttribute("aria-label", /^Annotation history/);
  });

  test("previewing a version banners the ANNOTATIONS as old and the document as current", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Annotation history", exact: true }).click();
    await expect(vh(page)).toBeVisible();
    await expect(vhRows(page)).toHaveCount(3, { timeout: 20_000 });
    await vhRows(page).nth(1).click();
    await expect(vh(page)).toBeHidden();

    await expect(region).toBeVisible();
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const banner = region.locator(".version-banner");
    await expect(banner).toBeVisible();
    // The banner's default ends "this is not the current note", false here.
    await expect(banner).toContainText("the annotations from");
    await expect(banner).toContainText("the document itself is current");
    await expect(banner).not.toContainText("not the current note");
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeVisible();

    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();

    // The popover dismisses on scroll, which late raster and ink placement cause, so the
    // loop reopens it rather than racing a repaint.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect
      .poll(
        async () => {
          if ((await vh(page).count()) === 0) {
            await region.getByRole("button", { name: "Annotation history", exact: true }).click();
          }
          // One atomic read, so a scroll cannot shut the panel between assertions.
          return page.evaluate(() => {
            const all = Array.from(document.querySelectorAll(".vh-row"));
            const at = all.findIndex((r) => r.classList.contains("is-viewing"));
            const marks = document.querySelectorAll(".vh-row.is-viewing .mark-viewing").length;
            return marks === 1 ? at : -1;
          });
        },
        { timeout: 20_000 },
      )
      .toBe(1);
  });

  test("Restore restores the ANNOTATIONS and lands back on the document", async ({ page }) => {
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Annotation history", exact: true }).click();
    await expect(vhRows(page)).toHaveCount(3, { timeout: 20_000 });
    await vhRows(page).nth(1).click();
    const banner = region.locator(".version-banner");
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: "Restore this version" }).click();
    const confirm = page.locator("dialog.confirm");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Restore this version" }).click();

    await expect(page.locator(".toast")).toContainText("kept in this file's history");

    // Restores route back to the document, not to the `.mark`.
    await expect(page).toHaveURL(/#\/note\/178/);
    await expect(region).toBeVisible();
    await expect(banner).toBeHidden();
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    await region.getByRole("button", { name: "Annotation history", exact: true }).click();
    await expect(vhRows(page).nth(0).locator(".tag-current")).toHaveText("Current", { timeout: 20_000 });
  });
});
