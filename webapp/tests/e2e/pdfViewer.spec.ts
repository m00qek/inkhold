import { test, expect, type Download, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
        () => (globalThis as unknown as { __inkholdPdfThumbs?: { hits: number; renders: number } })
          .__inkholdPdfThumbs ?? { hits: 0, renders: 0 },
      );
    await expect.poll(async () => (await counts()).hits, { timeout: 20_000 }).toBeGreaterThan(0);
    expect((await counts()).renders).toBe(0); // nothing was rendered twice
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
  test("a page with no ink offers its flattened image and the raw file, and no more", async ({
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
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(2);
    await expect(pdfGroupItem(page, "Current view", "Flattened image")).toBeVisible();
    await expect(pdfGroupItem(page, "Whole document", "PDF document")).toBeVisible();
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
    // Four per-page rows now, plus the raw file.
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(5);
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
    await expect(pdfMenu(page).locator(".menu__item:visible")).toHaveCount(3);
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
