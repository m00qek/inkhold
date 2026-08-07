import { test, expect, type Download, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";

// The PDF viewer, END TO END through the REAL MuPDF wasm in a REAL browser.
//
// Everything below this file is already covered: `pdfDecode.test.ts` proves the
// WASI shim and the ABI wrapper under Node, and the Zig-side ABI test proves the
// module renders under genuine WASI. What ONLY a browser can prove is the rest of
// the chain — that `/pdf-decode.wasm` is fetched and instantiated by a real
// engine with real wasm-exception support, that the pixels reach a canvas, and
// that the shell routes a `.pdf` here at all.
//
// The library runs against the in-memory fake `Api`, but the raw-file endpoint is
// a REAL browser request, so this route serves the fixture's bytes exactly as the
// server would — the same arrangement `spdViewer.spec.ts` uses.

const PDF_PATH = fileURLToPath(new URL("../../wasm/tests/fixtures/two-page.pdf", import.meta.url));
const PDF_BYTES = readFileSync(PDF_PATH);

/**
 * A second two-page fixture whose pages are 351 x 468 pt — EXACTLY the device
 * panel's 1404 x 1872 aspect.
 *
 * It exists because the default fixture cannot show what the mark does. Its page
 * 2 is 300 x 150 (landscape 2:1), so the page-rect inside the panel is only rows
 * 585..1287, and of the mark's three ink bands (200–400 Main, 800–1100 the
 * device-HIDDEN Layer 2, 1400–1500 Layer Renamed) the only one that lands on the
 * page is the hidden one. Every visible stroke falls in the dead margin and is
 * clipped — on the page AND in the filmstrip — so a viewer that composited no
 * ink at all would look identical.
 *
 * At the panel's own aspect the letterbox vanishes (fit = the whole panel at
 * (0,0)), so all three bands map onto the page and each becomes a band of
 * thumbnail rows a pixel probe can name. Served per test through `servePdf`, so
 * nothing about the shared fixtures moves.
 */
const PANEL_PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/two-page-panel.pdf", import.meta.url)),
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

/**
 * The fraction of pixels that differ from the page's background.
 *
 * A rendered page reads clearly above zero; a blank canvas, a failed decode or a
 * canvas that was never painted all read ~0. Runs in-page against a same-origin
 * canvas, so `getImageData` is untainted.
 */
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
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect(region).toBeVisible();

    // The whole point: ink on the canvas, from a wasm module the browser fetched,
    // compiled (wasm exceptions and all) and ran.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  });

  test("pages through the document, and the pager bounds itself", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const prev = region.getByRole("button", { name: "Previous page" });
    const next = region.getByRole("button", { name: "Next page" });
    // Two-page fixture: Back is dead on page 1, Forward is dead on page 2.
    await expect(region.getByText("1 / 2")).toBeVisible();
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();

    await next.click();
    await expect(region.getByText("2 / 2")).toBeVisible();
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();
    // Page 2 also renders — a pager that moves a counter over a stale canvas
    // would pass every assertion above.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  });

  test("zooming re-rasters at a larger size, not a stretched bitmap", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    /** The raster, the box it is drawn in, and the desk it sits on. */
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
    // At Fit the page is inside the desk, so there is nothing to scroll. A Fit
    // that already overflowed would make every assertion below meaningless.
    expect(fit.scrollW).toBeLessThanOrEqual(fit.clientW + 1);

    await region.getByRole("button", { name: "Zoom in" }).click();
    // The BUFFER grows — CSS-scaling the old raster would leave it unchanged and
    // the page would simply go soft.
    await expect.poll(async () => (await geo()).buffer, { timeout: 20_000 }).toBeGreaterThan(fit.buffer);
    const zoomed = await geo();

    // AND SO DOES THE PAGE ON SCREEN. This is the assertion this test was
    // missing, and the bug it was missing: `.pdf-page` carried `max-width: 100%`,
    // which clamped the box back to the container while the raster grew behind
    // it. Measured at 300%: a 2976px buffer painted into a 992px box — nine times
    // the pixels for the same picture, with the control reporting success. The
    // buffer check above passed throughout.
    expect(zoomed.css).toBeGreaterThan(fit.css * 1.3);
    // The ratio between buffer and box is the device pixel ratio, and zoom must
    // not change it: that ratio is what keeps the raster sharp rather than
    // upscaled.
    expect(zoomed.buffer / zoomed.css).toBeCloseTo(fit.buffer / fit.css, 1);

    // The overflow is REACHABLE. Scrollable overflow only extends end-ward, so a
    // page centred with plain `center` puts its left edge outside the scroll
    // region entirely — visible, and impossible to scroll to. Both edges have to
    // come into view.
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

  test("the ink keeps the page's scale at every zoom, and with a panel open", async ({ page }) => {
    // The `.mark` overlay is placed against the size the raster was ASKED for
    // (`markGeometry`), so anything that makes the painted box differ from that
    // size drags the ink out of register with the page underneath. Two things
    // did: `max-width: 100%` (the overlay then grew by exactly the zoom factor —
    // 1.5x, 2x, 3x) and `availableBox` not counting the Annotations panel, which
    // rastered a 992px page into a 650px slot and put the ink at 1.53x.
    //
    // The invariant is orientation-free on purpose: whatever the ratio of the
    // overlay's box to the page's is at Fit, every other zoom must match it. The
    // exact numbers per orientation are pinned in `markGeometry.test.ts`.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
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
    for (const step of ["150%", "200%", "300%"]) {
      await zoomIn.click();
      await expect
        .poll(async () => Math.abs((await ratio()) - atFit) < 0.02, { timeout: 20_000 })
        .toBe(true);
      expect(await ratio(), `ink out of register at ${step}`).toBeCloseTo(atFit, 1);
    }

    // …and a PANEL narrows the desk, so "Fit" has to mean fit against what is
    // LEFT of it. `availableBox` subtracted the Pages panel and not this one, so
    // a page opened with Annotations up was rastered for a stage 342px wider
    // than it had. While `max-width` was still in the stylesheet that showed up
    // as ink 53% too big; with the clamp gone it shows up here instead, as a
    // page that overflows at the one zoom level whose whole promise is that it
    // does not.
    // The panel and the page are SIDE BY SIDE — "the panel narrows the page
    // rather than covering it", which is what the stylesheet says this layout is
    // for. So the page's right edge must stop at the panel's left edge.
    const clearOfPanel = () =>
      page.evaluate(() => {
        const c = document.querySelector(".pdf-page") as HTMLCanvasElement;
        const panel = document.querySelector("#pdf-layers-panel") as HTMLElement;
        return panel.getBoundingClientRect().left - c.getBoundingClientRect().right;
      });

    const zoomOut = region.getByRole("button", { name: "Zoom out" });
    for (const _ of [0, 1, 2]) await zoomOut.click();
    await region.getByRole("button", { name: "Annotations" }).click();

    // Measured with the panel left out of `availableBox`: a 992px page beside a
    // panel whose left edge is at 700 — 320px of the document rendered straight
    // under the panel listing its layers. It is not an overflow, so no scrollbar
    // ever appeared to admit it.
    await expect.poll(clearOfPanel, { timeout: 20_000 }).toBeGreaterThanOrEqual(-1);
    expect(await ratio()).toBeCloseTo(atFit, 1);
  });

  test("a page is an ADDRESS: paging rewrites the URL, and a reload lands there", async ({
    page,
  }) => {
    // The route `#/note/:id/page/:n` is shared with the reader and this viewer
    // has always honoured it on the way IN — but it never wrote one back, so the
    // half a person actually uses was missing: paging to 34 and reloading came
    // back to page 1, and there was no address to send anyone. The reader has
    // published its page since it existed.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(region.getByText("1 / 2")).toBeVisible();

    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.getByText("2 / 2")).toBeVisible();
    // ONE-BASED in the URL, 0-based internally — the router's convention.
    await expect(page).toHaveURL(/#\/note\/n-files-manual\/page\/2$/);

    // And the address is REAL: a reload opens the page it names, which is the
    // whole point of writing it. A URL that only decorates the address bar would
    // pass the assertion above and fail this one.
    await page.reload();
    await freezeMotion(page);
    await expect(region.getByText("2 / 2")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  });

  test("refuses a corrupt PDF with MuPDF's own words, and does not wedge", async ({ page }) => {
    await signedIn(page);
    await servePdf(page, Buffer.from("this is definitely not a pdf"));
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect(region).toBeVisible();
    // The honest failure state, not a blank canvas and not a thrown page.
    await expect(region.locator(".viewer__placeholder")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".pdf-page")).toBeHidden();
  });

  test("the page index lists every page, jumps, and tracks the current one", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    // CLOSED until asked for — it is navigation, not something to spend the
    // stage's width on by default. The rows are BUILT either way (so opening is
    // instant), and cost nothing while hidden: a hidden panel never intersects,
    // so no thumbnail renders and no byte range is fetched for one.
    const panel = region.locator("#pdf-pages-panel");
    const strip = region.locator(".filmstrip__page");
    await expect(panel).toBeHidden();

    await region.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(strip).toHaveCount(2); // the fixture is two pages

    // The current page is the one the pager says, and it is marked for AT, not
    // just coloured.
    await expect(strip.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(strip.nth(1)).toHaveAttribute("aria-current", "false");

    // Clicking a row navigates, and the pager agrees — the two controls read the
    // same state rather than each keeping their own.
    await strip.nth(1).click();
    await expect(region.getByText("2 / 2")).toBeVisible();
    await expect(strip.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(strip.nth(0)).toHaveAttribute("aria-current", "false");

    // …and the pager moves the strip's highlight too, not only the reverse.
    await region.getByRole("button", { name: "Previous page" }).click();
    await expect(strip.nth(0)).toHaveAttribute("aria-current", "true");
  });

  test("the strip paints thumbnails, and reserves each row's shape first", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Pages", exact: true }).click();

    // Every row has a reserved aspect BEFORE its thumbnail lands, so the strip
    // does not reflow under the pointer as canvases arrive.
    const reserved = await region.locator(".filmstrip__page").first().evaluate(
      (n) => getComputedStyle(n).getPropertyValue("--thumb-aspect").trim(),
    );
    expect(Number(reserved)).toBeGreaterThan(0);

    // And the thumbnails actually paint — `is-loading` clears only when a canvas
    // has been drawn into.
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
    // The visual language, asserted as GEOMETRY — because it was broken by CSS
    // and the only witness was my eye on a screenshot.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    /**
     * How much of the box Fit actually used, and whether the raster matches the
     * box it is shown in.
     *
     * `fill` is the load-bearing one, and it must be read with the panel CLOSED.
     * Measuring `.pdf-stage` for the fit is circular — the stage is sized BY the
     * canvas, so it reads back whatever the page already is and EVERY page
     * "fits" by definition. With the panel open that mistake is invisible twice
     * over: the fixed point converges on the right number, and `max-width: 100%`
     * would clamp the box anyway. Closed, the wasted width shows.
     */
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
          // buffer vs box: 1 is DPR-sharp, >1 is a raster bigger than anything
          // on screen — memory spent to be CSS-shrunk back down.
          sharp: c.width / (r.width * devicePixelRatio),
        };
      });

    // Fit USES the box. Under-filling is not "fitting", it is a smaller page.
    expect((await fit()).fill).toBeGreaterThan(0.98);

    const pages = region.getByRole("button", { name: "Pages", exact: true });
    if ((await pages.getAttribute("aria-pressed")) !== "true") await pages.click();
    await expect(page.locator("#pdf-pages-panel")).toBeVisible();

    // The panel NARROWS the page rather than covering it, so opening it must
    // RE-RASTER. Skipping that leaves the old wide buffer in the new narrow box,
    // which `max-width: 100%` hides perfectly — the page looks right and is
    // simply soft and oversized. Only the buffer/box ratio tells on it.
    await expect.poll(async () => (await fit()).sharp, { timeout: 20_000 }).toBeLessThanOrEqual(1.02);

    const g = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const wrap = document.querySelector(".pdf-wrap") as HTMLElement;
      const inner = document.querySelector(".viewer--pdf .viewer__main") as HTMLElement;
      const cs = getComputedStyle(wrap);
      // The stage's CONTENT box — the wrap less its own padding, which is the
      // area the panel and the page are actually arranged in.
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

    // The panel is a card that STARTS at the top of the stage; the page is
    // CENTRED in what is left. The reader's arrangement, and two separate rules
    // — conflating them is what the first version of this did, demanding one
    // shared top edge, which held only because the document under test happened
    // to fill the height. A landscape page centres, and should.
    expect(Math.abs(g.panelTop - g.stageTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.pageMidY - g.stageMidY)).toBeLessThanOrEqual(1);

    // The page index takes the NARROW track. `.side-panel` defaults to
    // `--panel-w` (268px, which the tokens call the OCR text dock) and left a
    // ~68px thumbnail adrift in it; `--panel-w-narrow` is the token that exists
    // for a column of thumbnails, and the reader has always had it.
    expect(g.panelWidth).toBeLessThanOrEqual(190);
    // ONE scroller. The stub's `overflow: auto` made this a second one nested
    // inside the wrap's, so a tall page ran off the bottom past the padding and
    // no scrollbar appeared to admit it.
    expect(g.innerOverflowY).not.toBe("auto");
    expect(g.innerOverflow).toBeLessThanOrEqual(1);
    expect(g.pageBottom).toBeLessThanOrEqual(g.wrapBottom - g.padBottom + 1);
    expect(g.wrapOverflow).toBeLessThanOrEqual(1);
  });

  test("pages with the arrow keys, like the reader, and leaves on Escape", async ({ page }) => {
    // This app has exactly TWO paged viewers, and they were reachable by
    // different means: `reader.ts` binds the arrow keys to paging while this had
    // the pager buttons and nothing else. Same control, same interaction model,
    // so the same keys — and Escape leaves, which every other viewer already did.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(region.getByText("1 / 2")).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(region.getByText("2 / 2")).toBeVisible();
    // The PAGE moved, not just the counter — a handler that only bumped the
    // readout would satisfy every assertion above.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await page.keyboard.press("ArrowLeft");
    await expect(region.getByText("1 / 2")).toBeVisible();

    // Bounded at both ends, exactly as the buttons are: no wrap, no negative page.
    await page.keyboard.press("ArrowLeft");
    await expect(region.getByText("1 / 2")).toBeVisible();

    // THE TOOLBAR KEEPS THE ARROWS WHILE IT HAS FOCUS. `createToolbar` roves
    // between its controls with ArrowLeft/Right and stops the event there, so a
    // toolbar button under the cursor means arrows move BETWEEN CONTROLS, not
    // between pages. That is the reader's arrangement too, and it is why this
    // handler sits on `document` rather than on the viewer's root: matching the
    // reader means inheriting where the arrows do NOT apply, as well as where
    // they do.
    const pages = region.getByRole("button", { name: "Pages", exact: true });
    if ((await pages.getAttribute("aria-pressed")) !== "true") await pages.click();
    await expect(region.getByText("1 / 2")).toBeVisible();
    await page.keyboard.press("ArrowRight"); // focus is on Pages — the toolbar's
    await expect(region.getByText("1 / 2")).toBeVisible();

    // Focus outside the toolbar, and the same key pages again — and the strip's
    // highlight follows it, since the pager and the strip read one state.
    await page.locator(".pdf-page").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ArrowRight");
    await expect(region.getByText("2 / 2")).toBeVisible();
    await expect(region.locator(".filmstrip__page").nth(1)).toHaveAttribute("aria-current", "true");

    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
  });

  test("orders its controls and words its subtitle as the reader does", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    /** Is the pager to the LEFT of the zoom stepper inside `scope`? */
    const pagerBeforeZoom = async (scope: Locator) => {
      const pager = await scope.getByRole("button", { name: "Previous page" }).first().boundingBox();
      const zoom = await scope.getByRole("button", { name: "Zoom out" }).first().boundingBox();
      return pager!.x < zoom!.x;
    };

    // PARITY, asserted in both directions rather than as a fixed order here: the
    // defect was not "the PDF is wrong", it was that the app's two paged viewers
    // DISAGREED, so a test that pins only this one would let the reader drift
    // and call it green. This viewer had them reversed.
    expect(await pagerBeforeZoom(region)).toBe(true);

    // The subtitle says what nothing else on screen says. It used to read "PDF"
    // — which the library listing, the file glyph and the pager's `/ 2` already
    // carry between them — and dropped the folder path entirely.
    await expect(region.locator(".viewer__title")).toContainText("2 pages");
    await expect(region.locator(".viewer__title")).not.toContainText("PDF");

    // …and the reader, whose order this one now follows.
    await page.goto("/#/note/n-doc-attn");
    await freezeMotion(page);
    await expect(page.locator(".reader.is-open")).toBeVisible();
    expect(await pagerBeforeZoom(page.locator(".reader.is-open"))).toBe(true);
  });

  test("an unpainted row is a BLANK sheet, not the note reader's ruled paper", async ({ page }) => {
    // The strip is shared with the `.note` reader, and the ruled-stationery
    // placeholder — lines plus a red margin rule — used to live on
    // `.filmstrip__thumb` itself, from when the reader was the only thing that
    // mounted one. So every unpainted PDF row claimed to be lined notebook paper
    // until its thumbnail landed and replaced it with a page of typeset text. On
    // a slow link that is most of the time you spend looking at the strip.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
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
    // No gradients at all — just the sheet colour underneath.
    expect(await bg(".viewer--pdf .filmstrip__thumb")).toBe("none");

    // …and the reader still HAS its ruled paper: this is a scoping fix, not a
    // deletion, and a test that only checked the PDF would pass just as happily
    // if the placeholder had been dropped from both.
    await page.goto("/#/note/n-doc-attn");
    await freezeMotion(page);
    await expect(page.locator("#note-pages-panel .filmstrip__thumb").first()).toBeVisible();
    expect(await bg("#note-pages-panel .filmstrip__thumb")).toContain("gradient");
  });

  test("a paired .mark lands on ITS page, over the document, without hiding it", async ({ page }) => {
    // The whole point of Phase 5. The fixture's mark is SPARSE — one page, and
    // it annotates PDF page 2 — so a viewer that ignored `sourcePage` would show
    // this ink on page 1 and look entirely plausible doing it.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const overlay = page.locator(".pdf-mark");
    // PAGE 1 has no annotations. A mark holds only the pages written on, so a
    // missing entry is the common case and must show nothing at all.
    await expect(overlay).toBeHidden();

    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.getByText("2 / 2")).toBeVisible();
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    // The host is revealed as soon as the placement is known, which is BEFORE
    // the ink has been fetched and decoded — wait for a layer, not for the box.
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });

    const geo = await page.evaluate(() => {
      const host = document.querySelector(".pdf-mark") as HTMLElement;
      const canvas = document.querySelector(".pdf-page") as HTMLCanvasElement;
      const h = host.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return {
        hostBg: getComputedStyle(host).backgroundColor,
        // Does the panel's box CONTAIN the page's, and by how much?
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

    // THE BACKDROP IS TRANSPARENT. `createNoteLayersController` paints the host
    // white by default — right for the reader, where the stack REPLACES the
    // page and must supply the paper. Over a PDF it hid the document
    // completely, and it is invisible in the reader (white on white), so it is
    // asserted here rather than left to a screenshot.
    expect(geo.hostBg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

    // THE PANEL'S BOX CONTAINS THE PAGE'S, and overhangs it. The ink is in
    // device-panel pixels and the page is only a letterboxed part of that panel
    // (`render/markGeometry.ts`), so the host is drawn oversized and shifted
    // until the two line up; `.pdf-stage` clips the overhang.
    //
    // Which AXIS overhangs depends on the page: this fixture is landscape, so
    // it fills the panel's width and the margin is top and bottom — the A4 case
    // is the other way round. Asserting containment rather than a width ratio
    // is what makes this true of both; the exact numbers for each orientation
    // are pinned in `markGeometry.test.ts`.
    for (const v of Object.values(geo.pad)) expect(v).toBeGreaterThanOrEqual(-1);
    expect(geo.grew).toBeGreaterThan(1.02);
    expect(geo.layers).toBeGreaterThan(0);

    // AND THE DOCUMENT SURVIVES UNDER IT. Every visible ink layer must be
    // transparent where the device wrote nothing — that is what makes this an
    // overlay and not a second sheet.
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

  // --- the filmstrip shows the ink -----------------------------------------
  //
  // THE BUG: a PDF with a paired `.mark` painted the handwriting on the page and
  // the STRIP went on showing the bare document. For a sparse mark — the device
  // stores only the pages that were written on, 7 of 77 in the real capture —
  // the strip is precisely where you want to see which pages you wrote on, and
  // it was the one place that did not say.
  //
  // THE FIXTURE'S GEOMETRY, on `two-page-panel.pdf` (see its constant): the page
  // is the panel's own aspect, so the panel maps onto the 90x120 thumbnail 1:1
  // and every panel row `r` is thumbnail row `r/15.6`. That puts the mark's
  // bands at:
  //     Main            panel 200–400   -> thumb rows 12.8–25.6
  //     Layer 2 HIDDEN  panel 800–1100  -> thumb rows 51.3–70.5
  //     Layer Renamed   panel 1400–1500 -> thumb rows 89.7–96.2
  // and the PDF's OWN drawing (identical on both pages) at rows 30.0–45.1, 28%
  // of the width. Probes below stay inside those bands.

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
    await page.goto("/#/note/n-files-manual");
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

  test("the STRIP carries the mark's handwriting, on the row that was written on", async ({
    page,
  }) => {
    const region = await openStrip(page);
    const thumb = (n: number) => region.locator(".filmstrip__page").nth(n).locator("canvas");

    // PAGE 2 IS THE ANNOTATED ONE — the mark names it `sourcePage: 2`, and a
    // viewer that ignored that would put this ink on page 1 and look plausible.
    // Polled: the mark may land after the row's first paint, and the repaint is
    // exactly what this feature owes (see the reopen test below).
    await expect
      .poll(async () => band(await thumbRowInk(thumb(1)), 15, 23), { timeout: 20_000 })
      .toBeGreaterThan(0.9);
    const inked = await thumbRowInk(thumb(1));
    // Both visible ink bands, where the device wrote them.
    expect(band(inked, 91, 95)).toBeGreaterThan(0.9);
    // …and NOT the device-HIDDEN layer, whose band is untouched paper. The page
    // beside the strip does not show it either — a thumbnail that did would put
    // strokes in the filmstrip that are nowhere in the document.
    expect(band(inked, 55, 66)).toBeLessThan(0.05);
    // AND THE DOCUMENT SURVIVES UNDER THE INK. The mark is an overlay, not a
    // second sheet: the PDF's own drawing is still there, at its own width.
    expect(band(inked, 33, 42)).toBeGreaterThan(0.2);
    expect(band(inked, 33, 42)).toBeLessThan(0.4);

    // PAGE 1 CARRIES NONE OF IT. A mark holds only the pages written on, so an
    // unannotated row must be the bare document — and this fixture's two pages
    // are drawn identically, so the ink bands are the only difference there is.
    const plain = await thumbRowInk(thumb(0));
    expect(band(plain, 15, 23)).toBeLessThan(0.05);
    expect(band(plain, 91, 95)).toBeLessThan(0.05);
    expect(band(plain, 33, 42)).toBeGreaterThan(0.2);
  });

  test("the composited row is a CACHE ENTRY of its own, and survives a late mark", async ({
    page,
  }) => {
    // TWO CLAIMS, because they are the same mechanism seen from both ends.
    //
    // The key. A row that now holds ink is a picture of TWO blobs, so it is keyed
    // by both (`pdfViewer.ts`'s `thumbKey`). Under the bare `${md5}:p${i}` an
    // ink-free entry written a moment before the mark landed would be served for
    // the life of the store, which is the stale-thumbnail bug this replaces.
    //
    // The race. `loadMark` does not block the document, and on a REOPEN the strip
    // is served from IndexedDB while the mark's metadata is a fresh request — so
    // the second visit is the late-mark case, reproducibly. The row must end up
    // inked anyway.
    await openStrip(page);
    await page.goto("/#/");
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(page.locator("#pdf-pages-panel")).toBeVisible(); // chrome state survives

    const thumb = region.locator(".filmstrip__page").nth(1).locator("canvas");
    await expect
      .poll(async () => band(await thumbRowInk(thumb), 15, 23), { timeout: 20_000 })
      .toBeGreaterThan(0.9);

    // AND IT COST NOTHING TO GET BACK. `renders` counts MuPDF page rasters and
    // `inked` counts mark pages fetched-and-decoded; both are zero because the
    // composite came back from `sn-thumbs` whole. Painting alone proves nothing
    // here — a second visit that rebuilt every thumbnail from scratch would look
    // exactly the same, which is why these counters exist at all.
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
    // A layer stack is full-resolution RGBA — megabytes per layer — and hiding
    // the host frees none of it. Only `release()` unmounts the canvases and
    // zeroes their backing stores, and the viewer is the only caller that knows
    // when a mark is finished with. Without it, reading one annotated page and
    // walking back to the library left the ink resident for the life of the tab,
    // against a budget of 50 MB for the whole app.
    //
    // Asserted on the DOM because that is where `release` is observable:
    // `host.replaceChildren()` is the same call that lets the pixels go.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
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
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });

    await region.getByRole("button", { name: "Annotations" }).click();
    const panel = page.locator("#pdf-layers-panel");
    await expect(panel).toBeVisible();

    // The page itself is a row, at the BOTTOM — it is what the ink sits on, and
    // the two are the things a reader turns on and off independently.
    await expect(panel.getByText("Document")).toBeVisible();
    // …and the mark's own BACKGROUND layer is NOT a row: over a PDF that layer
    // is the device's paper, which the document replaces.
    await expect(panel.getByText("Background Layer")).toHaveCount(0);

    // Turning the document off leaves the ink, which is the point of separating
    // them — and is how you check an annotation against nothing.
    const canvas = page.locator(".pdf-page");
    const row = panel.locator(".layers-panel__row", { hasText: "Document" });
    await row.getByRole("button").click();
    await expect(canvas).toHaveCSS("visibility", "hidden");
    await expect(page.locator(".pdf-mark")).toBeVisible();
    await row.getByRole("button").click();
    await expect(canvas).toHaveCSS("visibility", "visible");
  });

  test("thumbnails come back from the cache on a REOPEN, still drawable", async ({ page }) => {
    // The cache OWNS the bitmaps it stores (`renderCache.ts`: callers blit
    // synchronously and never close them), so a viewer that closed one after
    // handing it over would leave a DEAD entry — and the failure is silent,
    // because the first paint looks perfect and only a later read finds a closed
    // bitmap. Reopening the same document is the cheapest way to force that read.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(region.locator(".filmstrip__thumb:not(.is-loading)").first()).toBeVisible({
      timeout: 20_000,
    });

    // Leave, and come back to the same document. The counters reset per open, so
    // what they read after this is the SECOND visit's work alone.
    await page.goto("/#/");
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    // The panel's open state SURVIVES the document change (it is viewer chrome,
    // not per-file state), so clicking again here would close it.
    await expect(page.locator("#pdf-pages-panel")).toBeVisible();

    // IT MUST COME FROM THE CACHE. Painting alone proves nothing — a re-render
    // looks identical and passes every visual assertion, which is why closing a
    // cache-owned bitmap and skipping the read-through BOTH passed the suite
    // before this counter existed. Polled rather than read once: the previous
    // visit's rows linger in the DOM for a moment, so an immediate read would
    // sample the wrong visit.
    const counts = () =>
      page.evaluate(
        () => (globalThis as unknown as {
          __inkholdPdfThumbs?: { hits: number; renders: number; probe: number };
        }).__inkholdPdfThumbs ?? { hits: 0, renders: 0, probe: 0 },
      );
    // WAIT FOR THE STRIP TO PAINT BEFORE READING THE COUNTERS, and do it as its
    // own step. Polling the counters straight after the reopen made this test's
    // budget cover the whole cold path — a wasm compile and the app's boot —
    // rather than the cache read it is about, and under a saturated machine
    // (the full suite, not this file alone) that ran out: the failure was
    // `hits` still 0 at the timeout, with nothing yet painted to have hit
    // anything. It passed in isolation every time, which is the signature of a
    // budget problem rather than a behaviour one.
    await expect(region.locator(".filmstrip__thumb:not(.is-loading)").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(async () => (await counts()).hits, { timeout: 20_000 }).toBeGreaterThan(0);
    expect((await counts()).renders).toBe(0); // nothing was rendered twice

    // AND THEY WERE ASKED FOR TOGETHER. A revisit is all hits — the blob is
    // immutable, so its thumbnail is cached forever — and a hit is an IndexedDB
    // read plus a `drawImage`: no decoder, no network, nothing to serialise for.
    // They used to queue behind each other one round trip at a time anyway.
    // `probe` is the largest batch the parallel pass asked for at once, so >1 is
    // the whole claim; a return to the serial read would report 1 and paint
    // pixel-identical rows.
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

// ============================================================================
// THE DOWNLOAD MENU — per-page layered exports of a PDF and the `.mark` on it.
//
// The PDF viewer's Download used to be one `<a download>` for the raw file. It
// is now the same three-group menu the `.note` reader has, and the interesting
// half is the middle one: a PDF page is in points and a mark's ink is in device
// panel pixels, so producing ONE image means reconstructing a shared space.
// `markGeometry.test.ts` pins that arithmetic and `pdfExports.test.ts` pins what
// is drawn where; what only a browser can prove is that the whole chain lands —
// MuPDF renders at the export's own scale, the wasm re-decodes the ink, and the
// bytes that reach the disk are a real PNG/ORA of the right shape.
//
// THE FIXTURE'S GEOMETRY, worked out once so the numbers below read:
//   page 2 is 300 x 150 pt (landscape 2:1); the panel is 1404 x 1872.
//   Width binds, so the page-rect inside the panel is 1404 x 702 at (0, 585)
//   — hence a 1404x702 export and an ink shift of 585 rows UP.
//   The mark's ink bands are panel rows 200–400 (Main), 800–1100 (Layer 2,
//   DEVICE-HIDDEN) and 1400–1500 (Layer Renamed). Only Layer 2's band falls
//   inside 585..1287, so it is the only one that can appear in an export at all
//   — and it is off until someone turns it on, which is also what makes the
//   ORIGINAL group appear. One toggle, two consequences.
// ============================================================================

/** The PDF viewer's export pop, disambiguated from the bin cluster's "…" menu
 *  by the group headings only it carries. */
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

/**
 * Every deflated stream in a PDF, inflated.
 *
 * Blunt on purpose: it tries each `stream…endstream` span and keeps the ones
 * that inflate. Walking the xref to find object N properly would be a PDF parser
 * in a test file, and what the assertions below need is only "is this content in
 * here, at this size" — a claim that does not care which object number carries
 * it. Streams under another filter (the ink's 1-bit stencil is CCITT) simply
 * fail to inflate and drop out.
 */
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
      // Not deflated (or not a stream at all) — not this test's business.
    }
  }
  return out;
}

/** Open the annotated fixture; `page2` walks to the one page that has ink. */
async function openMarkedPdf(page: Page, page2: boolean): Promise<Locator> {
  await signedIn(page);
  await servePdf(page);
  await page.goto("/#/note/n-files-manual");
  await freezeMotion(page);
  const region = page.getByRole("region", { name: "PDF viewer" });
  await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  if (page2) {
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.getByText("2 / 2")).toBeVisible();
    // The ink is fetched and decoded AFTER the placement is known, so waiting on
    // a layer canvas is what proves the stack is really up — and the layered
    // rows key off exactly that.
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

    // VISIBLE heads only: the ORIGINAL group rides in the DOM and stays hidden
    // until something is toggled, exactly as the reader's does.
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "Whole document",
    ]);
    // The layered ORA folds away — an ORA of a bare page has nothing to layer.
    // The per-page PDF does NOT: an unannotated page is exactly the case where
    // lifting this page out of the document with its text still selectable is
    // the only useful thing the menu can do with it.
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(4);
    await expect(pdfGroupItem(page, "Current view", "Flattened image")).toBeVisible();
    await expect(pdfGroupItem(page, "Current view", "PDF document")).toBeVisible();
    await expect(pdfGroupItem(page, "Whole document", "PDF document")).toBeVisible();
    // AND THE ANNOTATED WHOLE-DOCUMENT ROW, which is about the DOCUMENT and not
    // this page: the file has a `.mark` on its other page, so burning the ink
    // into the whole thing is a real thing to ask for while standing on a page
    // with none.
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
    // Nothing toggled yet: current view IS the original view, and a second header
    // over byte-identical rows is noise.
    await expect(pdfMenu(page).locator(".menu__head:visible")).not.toContainText([
      "This page — Original view",
    ]);

    // Turn the device-hidden Layer 2 ON. The panel is behind the menu, so the
    // menu closes first (a click outside it dismisses it).
    const row = await annotationsPanel(page, region);
    await row("Layer 2").click();

    await region.getByRole("button", { name: "Download" }).click();
    await expect(pdfMenu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "This page — Original view",
      "Whole document",
    ]);
    // Six per-page rows now — image, layers and PDF in each view — plus the two
    // whole-document ones.
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(8);
    await expect(pdfGroupItem(page, "Original view", "PDF document")).toBeVisible();
  });

  test("turning the PAGE off is itself enough to offer the ORIGINAL view", async ({ page }) => {
    // The document is a layer of this model like any other, and its authored
    // state is visible — nothing in the file ever says the page was meant to be
    // hidden. So hiding it IS a divergence from how the page was authored, and
    // "original view" is then a real, different export: the page back under its
    // ink. Proved on the UNANNOTATED page, where the Document row is the only
    // thing that can diverge at all — and where the layered ORA must still stay
    // folded away, because there is nothing to layer either way.
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

    // AND THE CURRENT VIEW'S PDF ROW GOES WITH IT. "Show me the ink alone" is a
    // thing a `.png` can answer — with transparency, which is what that row is
    // for. A PDF of this page cannot: the page's own content streams are what
    // gets grafted, so there is no "the page, without the page". The ORIGINAL
    // one stays, because the document's authored state is always visible.
    await expect(pdfGroupItem(page, "Current view", "PDF document")).toBeHidden();
    await expect(pdfGroupItem(page, "Original view", "PDF document")).toBeVisible();
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(5);
  });

  test("the raw PDF still downloads unchanged, from WHOLE DOCUMENT", async ({ page }) => {
    // The one row that survives from the old `<a download>`. Losing it to a menu
    // rewrite would be the quietest possible regression.
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Whole document", "PDF document").click(),
    ]);
    expect(download.url()).toContain("/file/");
  });

  test("the per-page PDF is the PAGE ITSELF, with the ink drawn over it", async ({ page }) => {
    // THE ONE EXPORT THAT IS NOT A PICTURE. Every other row in this menu
    // rasterises: a PNG of the page, an ORA of the page's layers, and both of
    // them turn a document into pixels. This one asks the decoder to GRAFT the
    // source page — its own content streams and the resources they reference —
    // into a fresh one-page document and stencil the ink on top, so the text,
    // the fonts and the vectors survive the round trip.
    //
    // Every assertion below is about that difference, because a rasterised
    // export would pass a weaker test perfectly: it would be a valid PDF, of
    // roughly the right size, with the ink in roughly the right place.
    const region = await openMarkedPdf(page, true);
    // Layer 2's band (panel rows 800–1100) is the only ink inside this page's
    // rect, and it is device-hidden — so without this toggle the mask is
    // legitimately empty and "the ink landed" has nothing to say.
    const row = await annotationsPanel(page, region);
    await row("Layer 2").click();

    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "PDF document").click(),
    ]);
    // The reader's naming, with the 1-BASED page the pager shows — the same
    // helper the `.png` and `.ora` rows go through.
    expect(download.suggestedFilename()).toBe("Appliance manual_p2_current.pdf");

    const bytes = await downloadBytes(download);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = bytes.toString("latin1");
    // THE SOURCE PAGE'S OWN GEOMETRY, in points. A raster export would carry
    // whatever box the writer chose for a 1404x702 image; this is page 2 of the
    // fixture, 300x150 pt, unchanged.
    expect(text).toContain("/MediaBox[0 0 300 150]");
    // …and ONE page, not the document.
    expect(text).toContain("/Count 1");

    const streams = inflatedStreams(bytes);
    const content = streams.find((s) => s.includes("Do"))?.toString("latin1") ?? "";
    // THE PAGE'S OWN VECTOR DRAWING, still a vector. The fixture's page 2 is the
    // operator `10 10 20 20 re f` — a filled rectangle — and it is present in
    // the exported page's content stream verbatim. Nothing that rasterised the
    // page could produce this line.
    expect(content).toContain("10 10 20 20 re f");
    // The ink goes on top, as an image scaled to the whole page: `300 0 0 150`
    // is the matrix this app computed (`markExportMatrix`) arriving intact.
    expect(content).toMatch(/300 0 0 150 0 0 cm\s*\/\w+ Do/);
    // The mask crossed at the INK's own resolution, not the page's 300x150 pt —
    // the whole point of composing at `markExportSpace` is that the handwriting
    // is never resampled on the way out.
    expect(text).toContain("/Width 1404");
    expect(text).toContain("/Height 702");

    // AND THE INK IS IN THE RIGHT ROWS, which "there is an image" does not say.
    // Layer 2's band is panel rows 800–1100 and the page-rect starts at panel
    // row 585, so the coverage must run from export row 215 to 514 — and Main
    // (200–400) and Layer Renamed (1400–1500) fall outside the page entirely
    // and must contribute nothing. This is the same claim the transparent PNG
    // test makes about the same page, asked of the soft mask instead.
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
    // THE TOAST IS PART OF THE FEATURE, not decoration. A per-page PDF looks
    // exactly like the document it came from, and two things about it are
    // invisible until they bite: it is ONE page, and grafting does not copy the
    // source page's `/Annots`, so links and pre-existing highlights are gone.
    // Nobody traces a link that has quietly stopped working back to the export
    // that dropped it, which is why the row says so at the moment it happens.
    //
    // And the row must survive its own run. `menu.item` disables a row while it
    // works and re-enables it in a `finally`; if that ever stops holding, one
    // export would be the last one this viewer ever performs.
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
    // THE ROW THAT LOSES NOTHING, and the one assertion that says so from
    // outside: the exported file BEGINS with the original file, byte for byte.
    // That is not a nicety — it is the mechanism. Nothing of the document is
    // re-encoded, which is precisely why its text, its vectors, its bookmarks
    // and its own `/Annots` are all still where they were. The per-page row
    // beside it cannot make this claim: it grafts a page into a fresh document
    // and `pdf_graft_page` copies a fixed list of keys, `/Annots` not among
    // them.
    //
    // (That `/Annots` survive specifically is asserted against a fixture that
    // has some, in `webapp/wasm/tests/pdf_decode_abi.mjs`. This fixture has
    // none, so what is provable here is the property they survive BY.)
    const region = await openMarkedPdf(page, true);
    const row = await annotationsPanel(page, region);
    // Layer 2 is the only band inside page 2's rect and it is device-hidden.
    // The whole-document export takes the AUTHORED view — the panel's toggles
    // belong to the page in front of you — so this toggle does NOT change what
    // is burnt in, and the ink below comes from the bands that fall on page 1.
    await row("Layer 2").click();

    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Whole document", "PDF with annotations").click(),
    ]);
    // The DOCUMENT's name, with no page number in it — this is not a page.
    expect(download.suggestedFilename()).toBe("Appliance manual_annotated.pdf");

    const bytes = await downloadBytes(download);
    expect(bytes.length).toBeGreaterThan(PDF_BYTES.length);
    // THE VERBATIM PREFIX. A rebuilt document would be a valid PDF of a
    // plausible size with the ink in the right place and would fail only this.
    expect(bytes.subarray(0, PDF_BYTES.length).equals(PDF_BYTES)).toBe(true);

    const text = bytes.toString("latin1");
    // BOTH pages, not one: the difference from the per-page row, which lifts a
    // page out and leaves the rest behind.
    expect(text).toContain("/Count 2");
    // The delta carries the ink as an image at the MARK's own resolution, the
    // same mask the per-page export builds — composed at `markExportSpace`, so
    // no stroke is resampled on the way out.
    expect(text).toContain("/Width 1404");
    // …and the appended part re-states the page's /Resources with the ink's
    // XObject in it, under a name that CARRIES THE PAGE NUMBER. The `Do` that
    // references it is inside a deflated content stream, but this dictionary is
    // written plain — and it is the half that matters, because a single fixed
    // name is what would let two annotated pages sharing one /Resources
    // dictionary overwrite each other's ink.
    const delta = bytes.subarray(PDF_BYTES.length).toString("latin1");
    expect(delta).toMatch(/\/InkholdInk\d+ \d+ 0 R/);

    // AND THE COPY IS THE OPPOSITE OF THE PER-PAGE ROW'S. That one has to warn
    // that the original's annotations are gone; this one says they are kept. A
    // user who has read the first would otherwise reasonably assume the second
    // loses them too.
    const toast = page.locator(".toast");
    await expect(toast).toContainText("Saved Appliance manual_annotated.pdf");
    await expect(toast).toContainText("whole document");
    await expect(toast).toContainText("preserved");
    await expect(toast).not.toContainText("not carried over");

    // The row survives its own run, and so does the document behind it: the
    // export MUTATES the open PDF, so the worker reopens it — without that, the
    // page on screen would come back with the ink burnt in AND the overlay on
    // top of it, drawn twice.
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

    // The reader's naming, with the 1-BASED page the pager shows.
    expect(download.suggestedFilename()).toBe("Appliance manual_p2_current.png");

    const bytes = await downloadBytes(download);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
    // 1404 x 702 — the page-rect INSIDE the panel. Not the panel (1404x1872,
    // which would ship 1170 rows of device margin), not the page's own points
    // (300x150, a fifth of the ink's resolution), and not the on-screen canvas
    // (whatever zoom, DPR and open panels happen to make it).
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
    // Page 1 is 200x100 pt; with no panel to agree with, the export takes the
    // round 2x (144 dpi) that sits beside the 2.2x an A4-on-a-Nomad page asks
    // for — so "did this page have ink on it?" does not decide how big the file is.
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
    // A real OpenRaster: STORED zip, `mimetype` first. Asserted through a
    // BOOLEAN, not `toContain`, throughout: `text` is a whole zip read as
    // latin1, and a failed `toContain` prints the received value — several
    // hundred KB of PNG bytes into the report, which is unreadable and slow.
    expect(text.startsWith("PK\x03\x04")).toBe(true);
    expect(text.includes("image/openraster")).toBe(true);
    // The manifest, pulled out so the assertions below read as XML and fail as XML.
    const stack = /<\?xml[\s\S]*?<\/image>/.exec(text)?.[0] ?? "";
    expect(stack).toContain("<image w='1404' h='702'>");

    // OpenRaster stacks are TOP-first, so the document must come LAST — anything
    // else composites the page over the handwriting.
    const names = [...stack.matchAll(/<layer name='([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual(["Layer Renamed", "Layer 2", "Main Layer", "Document"]);
    // THE DEVICE'S PAPER IS NOT IN HERE AT ALL — not as a hidden layer either.
    // Over a PDF that layer is a second opaque sheet, and one click in Krita
    // would white out the document it annotates.
    expect(stack).not.toContain("Background Layer");
    // Layer 2 is device-hidden, and rides along with its full pixels marked so.
    expect(stack).toContain("name='Layer 2' src='data/layer_2.png' opacity='1.00' visibility='hidden'");
    // Ids are renumbered from the document up, so nothing writes a `layer_-1.png`
    // (the panel's own id for the page).
    expect(stack).toContain("src='data/layer_0.png'");
    expect(stack).not.toContain("layer_-1.png");
    // …and every layer the manifest names really is IN the archive.
    for (const n of [0, 1, 2, 3]) expect(text.includes(`data/layer_${n}.png`)).toBe(true);
  });

  test("HIDING THE DOCUMENT EXPORTS INK ON TRANSPARENCY", async ({ page }) => {
    // The point of giving the page a row of its own. `exportFlatPng` fills no
    // background, so turning the document off must leave see-through pixels
    // rather than a white sheet — which is how you check an annotation against
    // something else. A white fill would look identical on screen.
    const region = await openMarkedPdf(page, true);
    const row = await annotationsPanel(page, region);
    // Layer 2's band (panel rows 800–1100) is the only ink inside this page's
    // rect, so it is turned on or the export has nothing in it to be ink.
    await row("Layer 2").click();
    await row("Document").click();
    await expect(page.locator(".pdf-page")).toHaveCSS("visibility", "hidden");

    await region.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfGroupItem(page, "Current view", "Flattened image").click(),
    ]);
    const bytes = await downloadBytes(download);

    // Decoded BACK IN THE BROWSER — Node has no PNG decoder here, and the alpha
    // channel is the whole claim.
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
    // Ink, and a majority of nothing at all — the 300-row band inside a 702-row
    // page. Either number at zero is the failure: no ink means the translation
    // dropped it off the canvas, no transparency means a sheet was filled in.
    expect(seen.opaque).toBeGreaterThan(0);
    expect(seen.clear).toBeGreaterThan(seen.opaque);
    // AND IT IS IN THE RIGHT PLACE, which is the claim `opaque > 0` alone does
    // not make. Layer 2's band is panel rows 800–1100 and the page-rect starts
    // at panel row 585, so the ink must land at export rows 215–514 — while
    // Main (200–400) and Layer Renamed (1400–1500) fall outside the page
    // entirely and must contribute nothing. Drop the translation and Main's band
    // shows up at 200 instead, which reads as "there is ink" to a weaker test.
    expect(seen.firstInkRow).toBe(215);
    expect(seen.lastInkRow).toBe(514);

    // …and the ORIGINAL view of the same page is the untouched one: the document
    // back under the ink, so nothing is see-through.
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

// ===========================================================================
// The document's OWN links
// ===========================================================================
//
// What only a browser can prove: that MuPDF's `/Annots` come back through the
// worker as REAL ANCHORS at the right place on the page — with an href a
// browser will preview and navigate, an accessible name over a raster that has
// no text, and a stacking order that survives a scribble drawn over the link.
//
// The rects themselves are pinned at the numbers in `pdf_decode_abi.mjs` (an
// off-origin box and a `/Rotate 90` fixture, asserted by coordinates); what is
// asserted here is that those numbers survive the wire and land on the canvas.

/**
 * A two-page PDF carrying links, at the SAME page sizes as the shared fixture
 * (200x100 and 300x150 pt) so the paired `.mark`'s placement is unchanged and
 * page 2 still comes with ink over it.
 *
 * Built here rather than committed because the thing under test is the PAGE
 * DICTIONARY — an `/Annots` array — and a generator makes it visible at the
 * call site. Every byte is ASCII, so a string offset is a byte offset.
 */
function linkedPdfBytes(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    // Page 1, 200x100 pt: an external link, an internal one to page 2, and a
    // `javascript:` one that must never become an anchor.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R" +
      " /Resources << >> /Annots [7 0 R 8 0 R 9 0 R] >>",
    "<< /Length 26 >>\nstream\n0 0 0 rg\n10 10 40 30 re f\nendstream",
    // Page 2, 300x150 pt — the page the fixture's `.mark` writes on.
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
  await page.goto("/#/note/n-files-manual");
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

    // THREE annotations on this page and TWO anchors. The `javascript:` one is
    // not rendered with a neutered href — it produces no element at all, so
    // there is nothing over that part of the page that looks clickable.
    const hrefs = await layer.locator("a").evaluateAll((as) =>
      as.map((a) => (a as HTMLAnchorElement).getAttribute("href")),
    );
    expect(hrefs.some((h) => h?.startsWith("javascript:"))).toBe(false);

    // The EXTERNAL one: a new tab, severed from this one.
    const ext = layer.locator('a[href="https://example.invalid/a"]');
    await expect(ext).toHaveAttribute("target", "_blank");
    await expect(ext).toHaveAttribute("rel", "noopener noreferrer");
    await expect(ext).toHaveAttribute("aria-label", "https://example.invalid/a");

    // The INTERNAL one: the app's own route, in this tab, so following it
    // leaves you somewhere you can share and reload into.
    const internal = layer.locator('a[href="#/note/n-files-manual/page/2"]');
    await expect(internal).toHaveCount(1);
    await expect(internal).toHaveAttribute("aria-label", "Go to page 2");
    await expect(internal).not.toHaveAttribute("target", "_blank");

    // AND IT IS WHERE THE DOCUMENT PUT IT. The annot is at PDF (20,20)-(80,60)
    // on a 100pt-tall page, so it displays at x 20..80, y 40..80 — a fifth of
    // the way across and two fifths down, whatever scale Fit chose. Asserted as
    // a FRACTION of the canvas, which is what makes it independent of the
    // viewport the test happens to run in.
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
    await expect(region.getByText("1 / 2")).toBeVisible();
    await page.locator('.pdf-links a[href="#/note/n-files-manual/page/2"]').click();
    await expect(region.getByText("2 / 2")).toBeVisible({ timeout: 20_000 });
    // A REAL ADDRESS, not a scroll: the URL is the page, so this is shareable
    // and survives a reload.
    expect(page.url()).toContain("#/note/n-files-manual/page/2");
    // And the page under it is page 2's — a link that moved the counter over a
    // stale canvas would pass everything above.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(page.locator(".pdf-links a")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('.pdf-links a[href="https://example.invalid/two"]')).toHaveCount(1);
  });

  test("the layer follows the raster through a zoom, and through a panel", async ({ page }) => {
    // The same trigger the ink overlay uses: the placement is computed from the
    // canvas's REAL size after the raster lands, so a zoom step and a panel
    // toggle are both free — nothing re-decodes, and nothing drifts.
    const region = await openLinkedPdf(page);
    const anchor = page.locator('.pdf-links a[href="https://example.invalid/a"]');
    await expect(anchor).toBeVisible({ timeout: 20_000 });

    // NULL WHILE THE LAYER IS DOWN, rather than throwing. Every repaint takes
    // the old anchors away before it asks for the new ones — a page's links are
    // page-specific and a round trip is not instant — so a measurement taken in
    // that window has to WAIT rather than fail.
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
    await region.getByRole("button", { name: "Zoom in" }).click();
    await expect(region.locator(".zoom", { hasText: "150%" })).toBeVisible();
    await expect.poll(async () => (await measure())?.canvas ?? 0).toBeGreaterThan(fit.canvas * 1.2);
    const zoomed = await settled();
    // The box grew WITH the page: the same fraction of a bigger canvas.
    expect(zoomed.left).toBeCloseTo(fit.left, 2);
    expect(zoomed.width).toBeCloseTo(fit.width, 2);
    expect(zoomed.width * zoomed.canvas).toBeGreaterThan(fit.width * fit.canvas * 1.2);

    // A panel NARROWS the page rather than covering it, so Fit is a different
    // scale with it open — and the anchors have to move with it.
    await region.getByRole("button", { name: "Zoom out" }).click();
    await region.getByRole("button", { name: "Pages" }).click();
    await expect(page.locator("#pdf-pages-panel")).toBeVisible();
    await expect.poll(async () => (await measure())?.canvas ?? 0).toBeLessThan(fit.canvas);
    const narrowed = await settled();
    expect(narrowed.left).toBeCloseTo(fit.left, 2);
    expect(narrowed.width).toBeCloseTo(fit.width, 2);
  });

  test("a link UNDER a scribble is still the thing you click", async ({ page }) => {
    // The case that will occur, because people annotate around the things they
    // care about. `.pdf-mark` is `pointer-events: none` so ink never eats a
    // click — but that is one property away from being wrong, and the ordering
    // is what actually decides it. Both are asserted.
    await signedIn(page);
    await servePdf(page, linkedPdfBytes());
    await page.goto("/#/note/n-files-manual");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.getByText("2 / 2")).toBeVisible();
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
        // Is the ink really over this link? Without that, the hit test proves
        // nothing about stacking at all.
        markCoversIt:
          !mark.hidden &&
          m.left <= box.left &&
          m.top <= box.top &&
          m.right >= box.right &&
          m.bottom >= box.bottom,
      };
    });
    expect(stacked.markCoversIt).toBe(true);
    // The link layer is LAST in the stage, so it paints (and hit-tests) above
    // the ink whatever `pointer-events` says.
    expect(stacked.kids).toEqual(["pdf-page", "note-stack", "pdf-links"]);
    expect(stacked.hitIsTheLink).toBe(true);
  });

  test("leaving the page takes its links with it", async ({ page }) => {
    // Every anchor here is a live address into the document that is going away.
    // Left up, they would sit over the next thing on screen still pointing at
    // the last one — and they would still be in the tab order.
    const region = await openLinkedPdf(page);
    await expect(page.locator(".pdf-links a")).toHaveCount(2, { timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
    await expect(page.locator(".pdf-links a")).toHaveCount(0);
  });
});
