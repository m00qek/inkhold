// The PDF viewer (real MuPDF wasm): layout, fit and zoom.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";

// Drives the real MuPDF wasm in a browser. The raw-file fetch is a real request, so
// routes serve fixture bytes as the server would.
import { PANEL_PDF_BYTES, servePdf, inkFraction, openStrip } from "./pdfViewer.shared";

/** One page, three lines 20pt apart, so a selection can keep its line breaks. */
const THREE_LINE_PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/text-three-line.pdf", import.meta.url)),
);

test.describe("PDF viewer (real MuPDF wasm)", () => {
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
});

// ---- download menu ----
// Page 2 is 300 x 150 pt; width binds, so its rect in the 1404 x 1872 panel is
// 1404 x 702 at (0, 585). Only hidden Layer 2 (panel rows 800–1100) falls inside it.
