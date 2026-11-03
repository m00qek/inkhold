import { test, expect, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";

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

    const sheet = region.locator(".txt__sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Shopping list");
    await expect(sheet).toContainText("a new nib for the Supernote");

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

    await expect(label).toHaveText("16px");
    const px = () => sheet.evaluate((el) => getComputedStyle(el).fontSize);
    expect(await px()).toBe("16px");

    await region.getByRole("button", { name: "Larger text" }).click();
    await expect(label).toHaveText("18px");
    expect(await px()).toBe("18px");

    await region.getByRole("button", { name: "Smaller text" }).click();
    await expect(label).toHaveText("16px");

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

    // The frame is sized from the viewport, not `ch`, so font size must not move its width.
    const width = () => sheet.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const fontPx = () => sheet.evaluate((el) => getComputedStyle(el).fontSize);

    const widthAt16 = await width();
    expect(await fontPx()).toBe("16px");
    const height16 = await sheet.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(height16).toBeGreaterThan(widthAt16);

    for (let i = 0; i < 3; i++) await region.getByRole("button", { name: "Larger text" }).click();
    await expect(region.locator(".pager .zoom")).toHaveText("22px");
    expect(await fontPx()).toBe("22px");
    expect(await width()).toBe(widthAt16);

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
    // `.txt-zoom`, not `.zoom`, so the two `.pager`s in this bar stay addressable.
    const zoomLabel = region.locator(".pager .txt-zoom");
    await expect(sheet).toBeVisible();
    await expect(zoomLabel).toHaveText("Fit ⇕");

    const width = () => sheet.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const fontPx = () => sheet.evaluate((el) => getComputedStyle(el).fontSize);

    const fitWidth = await width();
    expect(await fontPx()).toBe("16px");

    await region.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoomLabel).toHaveText("125%");
    expect(await width()).toBeGreaterThan(fitWidth);
    expect(await fontPx()).toBe("16px"); // glyphs unchanged
    await expect(region.locator(".pager .zoom")).toHaveText("16px"); // font readout unmoved

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

    await region2.getByRole("button", { name: "Zoom out" }).click();
    await region2.getByRole("button", { name: "Zoom out" }).click();
    await expect(region2.locator(".pager .txt-zoom")).toHaveText("Fit ⇕");
    expect(await region2.locator(".txt__sheet").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(fitWidth);
  });

  test("`Fit ⇔` at the top of the ladder spans the stage, which no multiplier promises", async ({ page }) => {
    // The top rung must equal the stage's content width exactly, whatever the stage.
    await signedIn(page);
    await mockTextFile(page);
    await page.goto(`/#/note/${README}`);
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Text viewer" });
    const sheet = region.locator(".txt__sheet");
    const zoomLabel = region.locator(".pager .txt-zoom");
    await expect(sheet).toBeVisible();

    const availWidth = await sheet.evaluate((el) => {
      const stage = el.parentElement!;
      const cs = getComputedStyle(stage);
      return stage.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    });

    const fit = await sheet.evaluate((el) => el.getBoundingClientRect().width);
    expect(fit).toBeLessThan(availWidth - 40);

    for (const step of ["125%", "150%", "175%", "Fit ⇔"]) {
      await region.getByRole("button", { name: "Zoom in" }).click();
      await expect(zoomLabel).toHaveText(step);
    }

    const spanned = await sheet.evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(spanned - availWidth)).toBeLessThan(1);
    // The aspect is what the multiplier rungs steer; left on, it would fight the explicit width.
    expect(await sheet.evaluate((el) => getComputedStyle(el).aspectRatio)).toBe("auto");

    const fitsHeight = await sheet.evaluate((el) => {
      const stage = el.parentElement!;
      const cs = getComputedStyle(stage);
      const availH = stage.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      return Math.abs(el.getBoundingClientRect().height - availH) < 1.5;
    });
    expect(fitsHeight).toBe(true);
  });

  // Regression: `.txt-zoom` had no rule, so the readout rendered unstyled and shifted the control.
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
    // 62px holds the widest readout label (`400%`, `Fit ⇔`) in any viewer.
    expect(zoom.minWidth).toBe("62px");
    expect(zoom.textAlign).toBe("center");

    await expect(fontReadout).toHaveText("16px");
    await region.getByRole("button", { name: "Larger text" }).click();
    await expect(fontReadout).toHaveText("18px");
    await expect(zoomReadout).toHaveText("Fit ⇕"); // column zoom untouched
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
