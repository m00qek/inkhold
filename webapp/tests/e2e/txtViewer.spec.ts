import { test, expect, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";

// The REAL `.txt` viewer (src/pages/txtViewer.ts). Where `viewers.spec.ts` proves
// the multi-viewer SEAM against the `.spd` stub, this proves the `.txt` viewer's
// actual behaviour: it fetches the raw file, decodes and lays the text out, and
// its font-size control steps the text and PERSISTS across a reload.
//
// The library runs against the in-memory fake `Api`, but the raw file is a REAL
// URL the viewer fetches itself (not an `Api` call), so it needs a real response.
// `177` is the `.txt` fixture (see `api/fake.ts`).

const README = "177";
const BODY = "Shopping list\n\n- oat milk\n- lentils\n- a new nib for the Supernote\n\nSee you Sunday.";

/** Serve `/file/:id` for the fixture: text/plain inline, attachment on download. */
async function mockTextFile(page: Page, opts: { status?: number } = {}): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      if (opts.status && opts.status >= 400) {
        await route.fulfill({ status: opts.status, contentType: "text/plain", body: "nope" });
        return;
      }
      const download = route.request().url().includes("download=1");
      await route.fulfill({
        status: 200,
        contentType: download ? "application/octet-stream" : "text/plain; charset=utf-8",
        headers: {
          "content-disposition": download ? 'attachment; filename="readme.txt"' : "inline",
          "x-content-type-options": "nosniff",
        },
        body: BODY,
      });
    },
  );
}

test.describe(".txt viewer", () => {
  test("fetches and lays out the file's text", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Text viewer" });
    await expect(region).toBeVisible();

    // The decoded text, in a readable column — line breaks preserved.
    const sheet = region.locator(".txt__sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Shopping list");
    await expect(sheet).toContainText("a new nib for the Supernote");

    // Reading is a mode: the library topbar leaves and the reader is not on screen.
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();
    await expect(page.locator(".reader.is-open")).toBeHidden();
  });

  test("the font-size control steps the text and persists across a reload", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Text viewer" });
    const sheet = region.locator(".txt__sheet");
    const label = region.locator(".pager .zoom");
    await expect(sheet).toBeVisible();

    // Default 16px.
    await expect(label).toHaveText("16px");
    const px = () => sheet.evaluate((el) => getComputedStyle(el).fontSize);
    expect(await px()).toBe("16px");

    // Larger steps up in px and actually resizes the text.
    await region.getByRole("button", { name: "Larger text" }).click();
    await expect(label).toHaveText("18px");
    expect(await px()).toBe("18px");

    // Smaller steps back down.
    await region.getByRole("button", { name: "Smaller text" }).click();
    await expect(label).toHaveText("16px");

    // Now push to 22 and prove it SURVIVES A RELOAD (localStorage).
    await region.getByRole("button", { name: "Larger text" }).click();
    await region.getByRole("button", { name: "Larger text" }).click();
    await region.getByRole("button", { name: "Larger text" }).click();
    await expect(label).toHaveText("22px");

    await page.reload();
    await mockTextFile(page); // routes are per-page; re-register after reload
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    const sheet2 = page.getByRole("region", { name: "Text viewer" }).locator(".txt__sheet");
    await expect(sheet2).toBeVisible();
    await expect(page.getByRole("region", { name: "Text viewer" }).locator(".pager .zoom")).toHaveText("22px");
    expect(await sheet2.evaluate((el) => getComputedStyle(el).fontSize)).toBe("22px");
  });

  test("the font-size control resizes the TEXT but not the page FRAME", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Text viewer" });
    const sheet = region.locator(".txt__sheet");
    await expect(sheet).toBeVisible();

    // The frame is a fixed portrait page (aspect 0.75), sized from the viewport —
    // not from `ch`, so the font size must not move its width.
    const width = () => sheet.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const fontPx = () => sheet.evaluate((el) => getComputedStyle(el).fontSize);

    const widthAt16 = await width();
    expect(await fontPx()).toBe("16px");
    // A portrait page: taller than it is wide.
    const height16 = await sheet.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(height16).toBeGreaterThan(widthAt16);

    // Grow the text three steps (16 → 22): the text scales, the frame width does NOT.
    for (let i = 0; i < 3; i++) await region.getByRole("button", { name: "Larger text" }).click();
    await expect(region.locator(".pager .zoom")).toHaveText("22px");
    expect(await fontPx()).toBe("22px");
    expect(await width()).toBe(widthAt16);

    // And shrinking it back leaves the frame width where it was, too.
    for (let i = 0; i < 6; i++) await region.getByRole("button", { name: "Smaller text" }).click();
    await expect(region.locator(".pager .zoom")).toHaveText("10px");
    expect(await width()).toBe(widthAt16);
  });

  test("the zoom control widens the reading COLUMN (frame), distinct from font size, and persists", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Text viewer" });
    const sheet = region.locator(".txt__sheet");
    // The zoom readout is `.txt-zoom` — its own class, kept apart from the font
    // stepper's `.zoom` so the two `.pager`s in this bar stay addressable.
    const zoomLabel = region.locator(".pager .txt-zoom");
    await expect(sheet).toBeVisible();
    await expect(zoomLabel).toHaveText("Fit");

    const width = () => sheet.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const fontPx = () => sheet.evaluate((el) => getComputedStyle(el).fontSize);

    const fitWidth = await width();
    expect(await fontPx()).toBe("16px");

    // Zooming in WIDENS the frame while the glyph size is untouched — the two are
    // different knobs (font size reflows the column; zoom changes how wide it is).
    await region.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoomLabel).toHaveText("125%");
    expect(await width()).toBeGreaterThan(fitWidth);
    expect(await fontPx()).toBe("16px"); // glyphs unchanged
    await expect(region.locator(".pager .zoom")).toHaveText("16px"); // font readout unmoved

    // Push to 150% and prove it SURVIVES A RELOAD (its own localStorage key).
    await region.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoomLabel).toHaveText("150%");
    const wide = await width();

    await page.reload();
    await mockTextFile(page); // routes are per-page; re-register after reload
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    const region2 = page.getByRole("region", { name: "Text viewer" });
    await expect(region2.locator(".txt__sheet")).toBeVisible();
    await expect(region2.locator(".pager .txt-zoom")).toHaveText("150%");
    expect(await region2.locator(".txt__sheet").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(wide);

    // Fit restores the default column.
    await region2.getByRole("button", { name: "Zoom out" }).click();
    await region2.getByRole("button", { name: "Zoom out" }).click();
    await expect(region2.locator(".pager .txt-zoom")).toHaveText("Fit");
    expect(await region2.locator(".txt__sheet").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(fitWidth);
  });

  // The `−` [Fit] `+` control must render PIXEL-IDENTICAL to the reader's / the
  // `.spd` viewer's zoom control. Its readout carries its own `.txt-zoom` class
  // (so a `.zoom` locator stays unambiguous with two `.pager`s in the bar), but
  // its CHROME must come from the shared toolbar rule, not a divergent restyle.
  // The regression this guards: `.txt-zoom` had NO rule at all, so the readout
  // rendered unstyled — wrong font, no min-width, no centring — shifting the whole
  // control. The two readouts in this one bar (the font stepper's `.zoom` and the
  // column-zoom's `.txt-zoom`) share the treatment, so their computed chrome is
  // the same down to the pixel.
  test("the Fit control's chrome matches the shared zoom readout, not a divergent restyle", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Text viewer" });
    const fontReadout = region.locator(".pager .zoom");
    const zoomReadout = region.locator(".pager .txt-zoom");
    await expect(fontReadout).toBeVisible();
    await expect(zoomReadout).toBeVisible();

    // The chrome the shared `.zoom, .spd-zoom, .txt-zoom` rule sets: the pill's
    // font, size, colour, min-width and centring. Read the SAME properties off
    // both readouts and require them identical — the txt readout inherits the
    // shared treatment rather than defaulting to unstyled inline text.
    const chrome = (loc: typeof fontReadout) =>
      loc.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          fontFamily: s.fontFamily,
          fontSize: s.fontSize,
          color: s.color,
          minWidth: s.minWidth,
          textAlign: s.textAlign,
        };
      });
    const font = await chrome(fontReadout);
    const zoom = await chrome(zoomReadout);
    expect(zoom).toEqual(font);
    // And it is the real treatment, not two coincidentally-unstyled pills: the
    // shared rule pins a 46px min-width and centres the label.
    expect(zoom.minWidth).toBe("46px");
    expect(zoom.textAlign).toBe("center");

    // The font-size stepper beside it is unaffected — still its own `.zoom`
    // readout, still stepping the glyph size independently of the column zoom.
    await expect(fontReadout).toHaveText("16px");
    await region.getByRole("button", { name: "Larger text" }).click();
    await expect(fontReadout).toHaveText("18px");
    await expect(zoomReadout).toHaveText("Fit"); // column zoom untouched
  });

  test("an unreadable file shows an honest state, still offering the download", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page, { status: 500 });
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Text viewer" });
    await expect(region.locator(".viewer__placeholder")).toContainText("read this file");
    await expect(region.locator(".txt__sheet")).toBeHidden();
    await expect(region.getByRole("link", { name: "Download" })).toBeVisible();
  });

  test("Back returns to the library", async ({ page }) => {
    await signedIn(page);
    await mockTextFile(page);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);
    await expect(page.getByRole("region", { name: "Text viewer" })).toBeVisible();

    await page.locator(".viewer--txt").getByRole("button", { name: "Library" }).click();

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Text viewer" })).toBeHidden();
  });
});
