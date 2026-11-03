// The reader: paging, panels and controls.

import { test, expect, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";

// Note 141 has 20 pages, enough for an off-screen filmstrip thumbnail.
test.describe("reader", () => {
  // ---- the shared viewer toolbar ----
  test.describe("the shared toolbar", () => {
    test("exposes a toolbar landmark with two zones and a decorative divider", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      const bar = page.getByRole("toolbar", { name: "Reader controls" });
      await expect(bar).toBeVisible();

      await expect(bar.getByRole("group", { name: "Reading controls" })).toBeVisible();
      await expect(bar.getByRole("group", { name: "File actions" })).toBeVisible();

      await expect(
        bar.getByRole("group", { name: "File actions" }).getByRole("button", { name: "Download" }),
      ).toBeVisible();

      const sep = page.locator(".reader__bar .toolbar__sep");
      await expect(sep).toHaveAttribute("aria-hidden", "true");
      await expect(sep).toHaveText("");
    });

    test("is one tab stop and arrow keys rove between its controls", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      await expect(page.getByRole("button", { name: "Library" })).toBeFocused();
      expect(await page.locator('.reader__bar [tabindex="0"]').count()).toBe(1);

      // The toolbar claims arrow keys while focused, and skips disabled Previous.
      const field = page.locator(".reader__bar .pager__count");
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("1 / 20");
      expect(await page.locator('.reader__bar [tabindex="0"]').count()).toBe(1);

      // The page field keeps the arrow while the caret can move, and hands it back at the edge.
      await page.keyboard.press("ArrowRight");
      await expect(field).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("button", { name: "Next page" })).toBeFocused();
      await expect(field).toHaveValue("1 / 20");
      expect(await page.locator('.reader__bar [tabindex="0"]').count()).toBe(1);

      await page.keyboard.press("ArrowLeft");
      await expect(field).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByRole("button", { name: "Library" })).toBeFocused();
    });

    test("roves through the right zone to the added Move to bin control", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.getByRole("button", { name: "Library" })).toBeFocused();

      await page.keyboard.press("End");
      await expect(
        page.locator(".reader__bar").getByRole("button", { name: "Move to bin" }),
      ).toBeFocused();
      expect(await page.locator('.reader__bar [tabindex="0"]').count()).toBe(1);

      await page.keyboard.press("Home");
      await expect(page.getByRole("button", { name: "Library" })).toBeFocused();
    });

    test("Download and recognised-text are icon-only but keep their accessible names", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      const bar = page.locator(".reader__bar");

      const download = bar.getByRole("button", { name: "Download" });
      await expect(download).toBeVisible();
      await expect(download).toHaveText(""); // no visible label — glyph only
      await expect(download).toHaveAttribute("title", "Download");
      await expect(download.locator("svg")).toBeVisible();

      const ocr = bar.getByRole("button", { name: "Recognized text" });
      await expect(ocr).toHaveText("");
      await expect(ocr).toHaveAttribute("title", "Recognized text");
      await expect(ocr).toHaveAttribute("aria-pressed", "false");
    });

    test("the Download trigger wears an active look while its menu is open, cleared when it closes", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
      // After navigation, which reloads and would drop the freeze style; settles the 0.14s transition.
      await freezeMotion(page);

      const download = page.locator(".reader__bar").getByRole("button", { name: "Download" });
      const bg = () => download.evaluate((node) => getComputedStyle(node).backgroundColor);

      await page.mouse.move(2, 2);
      const restBg = await bg();
      await expect(download).toHaveAttribute("aria-expanded", "false");

      await download.click();
      await expect(download).toHaveAttribute("aria-expanded", "true");
      // Pointer off the button, so this measures the aria-expanded rule, not :hover.
      await page.mouse.move(2, 2);
      expect(await bg()).not.toBe(restBg);

      await page.locator(".stage").click({ position: { x: 5, y: 5 } });
      await expect(download).toHaveAttribute("aria-expanded", "false");
      await page.mouse.move(2, 2);
      expect(await bg()).toBe(restBg);
    });

    test("Move to bin trashes the open note, offers an undo with the device line, and leaves the reader", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".reader.is-open")).toBeVisible();
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      const moveBin = page.locator(".reader__bar").getByRole("button", { name: "Move to bin" });
      await expect(moveBin).toBeVisible();
      await expect(moveBin).not.toHaveClass(/is-danger/);

      await moveBin.click();

      const toast = page.locator(".bin-toast");
      await expect(toast).toContainText("Moved");
      await expect(toast).toContainText("Also comes off your Supernote at the next sync.");
      await expect(toast.locator(".bin-toast__action")).toHaveText("Undo");

      await expect(page.locator(".reader.is-open")).toBeHidden();
      await expect(page.locator(".gallery")).toBeVisible();
    });

    test("Move to bin is absent in the recycle-bin context, where the note is already trashed", async ({ page }) => {
      await signedIn(page);
      // Re-trashing a trashed file is nonsense, so the action is hidden from the bin.
      await page.goto("/#/bin");
      await expect(page.locator(".bin")).toBeVisible();
      await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
      await expect(page.locator(".backbtn__label")).toHaveText("Recycle bin");

      await expect(
        page.locator(".reader__bar").getByRole("button", { name: "Move to bin" }),
      ).toBeHidden();
    });
  });
  // The fake serves template links only for `122` (seven pages). Rects are device panel
  // pixels and the page is the panel, so there is no letterbox mapping.
  test.describe("template links", () => {
    const layer = (page: Page) => page.locator(".page .pdf-links");

    test("puts each link on its own rect, as a real anchor, labelled", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/122");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 7");
      await expect(layer(page).locator("a")).toHaveCount(2, { timeout: 10_000 });

      const ext = layer(page).locator('a[href^="https://example.com/planner"]');
      await expect(ext).toHaveAttribute("target", "_blank");
      await expect(ext).toHaveAttribute("rel", "noopener noreferrer");
      await expect(ext).toHaveAttribute("aria-label", /^https:\/\/example\.com\/planner/);

      // Above the ink by DOM order: the page canvases take pointer events.
      await expect(
        page.locator(".page > *:last-child").evaluate((n) => n.className),
      ).resolves.toContain("pdf-links");

      const internal = layer(page).locator('a[href="#/note/122/page/2"]');
      await expect(internal).toHaveCount(1);
      await expect(internal).toHaveAttribute("aria-label", "Go to page 2");
      await expect(internal).not.toHaveAttribute("target", "_blank");

      // The external rect is (980,96) 340×64 on 1404×1872, off-centre on both axes, so a
      // dropped offset cannot pass by symmetry.
      const geo = await page.evaluate(() => {
        const box = (document.querySelector(".page") as HTMLElement).getBoundingClientRect();
        const a = (
          document.querySelector('.page .pdf-links a[href^="https://example.com/planner"]') as HTMLElement
        ).getBoundingClientRect();
        return {
          left: (a.left - box.left) / box.width,
          top: (a.top - box.top) / box.height,
          width: a.width / box.width,
          height: a.height / box.height,
        };
      });
      expect(geo.left).toBeCloseTo(980 / 1404, 2);
      expect(geo.top).toBeCloseTo(96 / 1872, 2);
      expect(geo.width).toBeCloseTo(340 / 1404, 2);
      expect(geo.height).toBeCloseTo(64 / 1872, 2);
    });

    test("following an internal link is a page turn, at a real address", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/122");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 7");

      await layer(page).locator('a[href="#/note/122/page/2"]').click();
      await expect(page.locator(".pager__count")).toHaveValue("2 / 7");
      expect(page.url()).toContain("#/note/122/page/2");
      await expect(layer(page).locator('a[href="#/note/122/page/3"]')).toHaveCount(1, {
        timeout: 10_000,
      });
      await expect(layer(page).locator('a[href="#/note/122/page/2"]')).toHaveCount(0);
    });

    test("a note with no imported template has no layer at all", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
      await expect(page.locator(".page canvas")).toBeVisible();
      await expect(layer(page).locator("a")).toHaveCount(0);
    });

    test("the layer follows the page box through a zoom step", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/122");
      const anchor = layer(page).locator('a[href^="https://example.com/planner"]');
      await expect(anchor).toBeVisible({ timeout: 10_000 });

      // Null while the layer is down: each repaint removes old anchors before placing new ones.
      const measure = async (): Promise<{ page: number; left: number; width: number } | null> =>
        page.evaluate(() => {
          const box = document.querySelector(".page") as HTMLElement | null;
          const a = document.querySelector(
            '.page .pdf-links a[href^="https://example.com/planner"]',
          ) as HTMLElement | null;
          if (!box || !a) return null;
          const b = box.getBoundingClientRect();
          const r = a.getBoundingClientRect();
          return { page: b.width, left: (r.left - b.left) / b.width, width: r.width / b.width };
        });

      const before = await measure();
      expect(before).not.toBeNull();

      await page.getByRole("button", { name: "Zoom in" }).click();
      await expect.poll(async () => (await measure())?.page ?? 0, { timeout: 10_000 }).toBeGreaterThan(
        before!.page,
      );
      const after = await measure();
      expect(after!.left).toBeCloseTo(before!.left, 2);
      expect(after!.width).toBeCloseTo(before!.width, 2);
    });
  });
});
