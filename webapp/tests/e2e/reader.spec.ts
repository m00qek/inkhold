import { test, expect, type Page } from "@playwright/test";
import { signedIn, inkFraction, contrastRatio, paintedColours, cardButton, freezeMotion, railSettled } from "./helpers/app";

// Note 141 has 20 pages, enough for an off-screen filmstrip thumbnail.
test.describe("reader", () => {
  test("opens a note by route and paints the current page", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");

    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Attention");
    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

    const viewer = page.locator(".page canvas");
    await expect.poll(async () => inkFraction(viewer), { timeout: 5000 }).toBeGreaterThan(0.01);
  });

  test("the ink rail marks every written page, and breaks on the blank one", async ({ page }) => {
    // The fixture is inked on every page except page 5, so the assertion is about the gap.
    await signedIn(page);
    await page.goto("/#/note/141");
    const strip = page.locator("#note-pages-panel");
    const row = (n: number) => strip.locator(".filmstrip__page").nth(n);
    await expect(row(0)).toBeVisible();

    for (const n of [0, 1, 2, 3]) {
      await expect(row(n)).toHaveClass(/filmstrip__page--inked/);
    }
    await expect(row(4)).not.toHaveClass(/filmstrip__page--inked/);
    await expect(row(5)).toHaveClass(/filmstrip__page--inked/);

    // The stroke is a `::before`, so the row's accessible name must carry it.
    await expect(row(3)).toHaveAttribute("aria-label", "Page 4, written");
    await expect(row(4)).toHaveAttribute("aria-label", "Page 5");

    // Presence is yes/no, so every stroke is full row height.
    const strokes = await strip.evaluate((el) =>
      [...el.querySelectorAll(".filmstrip__page--inked")].map(
        (r) => getComputedStyle(r, "::before").height,
      ),
    );
    expect(strokes.length).toBeGreaterThan(3);
    expect(new Set(strokes).size).toBe(1);
  });

  test("navigates pages with the pager, the filmstrip, and the keyboard", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");

    // The toolbar roves on arrow keys while it has focus, so focus the stage before paging.
    await page.locator(".stage").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".pager__count")).toHaveValue("3 / 20");

    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");

    await page.getByRole("button", { name: "Page 5" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("5 / 20");
  });

  test("Home and End jump to the first and last page", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

    // The bar also takes Home/End while one of its controls has focus.
    await page.locator(".stage").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("End");
    await expect(page.locator(".pager__count")).toHaveValue("20 / 20");
    await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();

    await page.keyboard.press("Home");
    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
    await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });

  // The same pager (`viewerChrome.createPager`) is asserted in `pdfViewer.spec.ts`.
  test("the page readout is a field: a number lands, out of range clamps, Escape reverts", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    const field = page.locator(".reader__bar .pager__count");
    await expect(field).toHaveValue("1 / 20");

    await expect(page.locator(".reader__bar").getByRole("textbox", { name: "Page" })).toBeVisible();

    await field.fill("7");
    await field.press("Enter");
    await expect(field).toHaveValue("7 / 20");
    await expect(page.getByRole("button", { name: "Page 7" })).toHaveAttribute("aria-current", "true");
    // Enter returns focus to the page, so the next arrow pages.
    await expect(field).not.toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(field).toHaveValue("8 / 20");

    await field.fill("9999");
    await field.press("Enter");
    await expect(field).toHaveValue("20 / 20");

    // Escape must not reach the viewer's document handler, which would close the reader.
    await field.fill("3");
    await field.press("Escape");
    await expect(field).toHaveValue("20 / 20");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    await expect(page.locator(".reader__bar .pager__live")).toHaveText("Page 20 of 20");
  });

  // The fake leaves every third page (index 2, 5, 8…) unrecognised.
  test.describe("recognized text", () => {
    const toggle = (page: import("@playwright/test").Page) =>
      page.getByRole("button", { name: "Recognized text" });
    const panel = (page: import("@playwright/test").Page) =>
      page.getByRole("complementary", { name: "Recognized text" });

    test("toggling shows and hides the panel and tracks aria-pressed", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      await expect(panel(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

      await toggle(page).click();
      await expect(panel(page)).toBeVisible();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await expect(panel(page).locator(".ocr__body")).toContainText("page 1");

      await toggle(page).click();
      await expect(panel(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    });

    test("the panel head reads `[icon] Recognized text` — a decorative icon before the label", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      await toggle(page).click();
      const head = panel(page).locator(".ocr__head");
      await expect(head.locator(".ocr__head-ic svg")).toBeVisible();
      await expect(head).toContainText("Recognized text");
    });

    test("the page canvas re-lays out when the panel takes its share of the stage", async ({ page }) => {
      // Width-constrained, so the panel's 268px+22px really competes with the canvas.
      await page.setViewportSize({ width: 800, height: 1000 });
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      // Close the default-open page index, so the right panel is the only variable.
      await page.getByRole("button", { name: "Pages" }).click();
      await expect(page.getByRole("complementary", { name: "Pages" })).toBeHidden();

      const pageEl = page.locator(".page");
      const wide = await pageEl.evaluate((el: HTMLElement) => el.offsetWidth);

      await toggle(page).click();
      await expect(panel(page)).toBeVisible();
      await expect.poll(async () => pageEl.evaluate((el: HTMLElement) => el.offsetWidth)).toBeLessThan(wide);

      await toggle(page).click();
      await expect.poll(async () => pageEl.evaluate((el: HTMLElement) => el.offsetWidth)).toBe(wide);
    });

    test("content follows the current page while the panel stays open", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      // Opening a note resets the panel; a toggle racing that reset would be undone.
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
      await toggle(page).click();
      await expect(panel(page).locator(".ocr__body")).toContainText("page 1");

      await page.getByRole("button", { name: "Next page" }).click();
      await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).locator(".ocr__body")).toContainText("page 2");
    });

    test("a page with no recognized text disables the toggle and states so plainly", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
      await expect(toggle(page)).toBeEnabled();

      // Page 3 (index 2) is unrecognised. By name prefix: an inked row is "Page 3, written".
      await page.getByRole("button", { name: /^Page 3\b/ }).click();
      await expect(page.locator(".pager__count")).toHaveValue("3 / 20");
      await expect(toggle(page)).toBeDisabled();

      await page.getByRole("button", { name: /^Page 2\b/ }).click();
      await expect(toggle(page)).toBeEnabled();
      await toggle(page).click();
      await page.getByRole("button", { name: /^Page 3\b/ }).click();
      await expect(panel(page).locator(".side-panel__state")).toContainText("No recognized text");
      await expect(toggle(page)).toBeEnabled();
    });

    test("the panel resets to closed when a different note opens", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
      await toggle(page).click();
      await expect(panel(page)).toBeVisible();

      await page.goto("/#/note/101");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 3");
      await expect(panel(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    });
  });

  test.describe("the page index side panel", () => {
    const pagesPanel = (page: Page) => page.getByRole("complementary", { name: "Pages" });
    const pagesToggle = (page: Page) => page.locator(".reader__bar").getByRole("button", { name: "Pages" });

    test("rides the shared side-panel primitive, docked LEFT, open by default", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      const panel = pagesPanel(page);
      await expect(panel).toBeVisible();
      await expect(panel).toHaveClass(/side-panel/);
      await expect(panel).toHaveClass(/\bpages\b/);
      const head = panel.locator(".pages__head");
      await expect(head.locator(".pages__head-ic svg")).toBeVisible();
      await expect(head).toContainText("Pages");
      await expect(pagesToggle(page)).toHaveAttribute("aria-pressed", "true");

      await expect(panel.locator(".filmstrip .filmstrip__page").first()).toBeVisible();

      const panelBox = (await panel.boundingBox())!;
      const pageBox = (await page.locator(".page").boundingBox())!;
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(pageBox.x + 2);

      await expect(page.getByRole("complementary", { name: "Recognized text" })).toBeHidden();
      await expect(
        page.locator(".reader__bar").getByRole("button", { name: "Recognized text" }),
      ).toHaveAttribute("aria-pressed", "false");
    });

    test("the toggle collapses and reopens it, and the page re-lays out", async ({ page }) => {
      // Width-constrained, so the panel's slice moves the page width.
      await page.setViewportSize({ width: 800, height: 1000 });
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      const pageEl = page.locator(".page");
      const narrow = await pageEl.evaluate((el: HTMLElement) => el.offsetWidth);

      await pagesToggle(page).click();
      await expect(pagesPanel(page)).toBeHidden();
      await expect(pagesToggle(page)).toHaveAttribute("aria-pressed", "false");
      await expect.poll(async () => pageEl.evaluate((el: HTMLElement) => el.offsetWidth)).toBeGreaterThan(narrow);

      await pagesToggle(page).click();
      await expect(pagesPanel(page)).toBeVisible();
      await expect.poll(async () => pageEl.evaluate((el: HTMLElement) => el.offsetWidth)).toBe(narrow);
    });

    test("on a narrow stage, opening a right-hand tool auto-collapses the page index", async ({ page }) => {
      await page.setViewportSize({ width: 800, height: 1000 });
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
      await expect(pagesPanel(page)).toBeVisible();

      // A right dock on a stage too narrow for both collapses the left page index.
      await page.locator(".reader__bar").getByRole("button", { name: "Recognized text" }).click();
      await expect(page.getByRole("complementary", { name: "Recognized text" })).toBeVisible();
      await expect(pagesPanel(page)).toBeHidden();
      await expect(pagesToggle(page)).toHaveAttribute("aria-pressed", "false");
    });
  });

  test("Back returns to the library", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    await page.getByRole("button", { name: "Library" }).click();

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
  });

  // Regression: the shell's `.sn-root button` reset (0,1,1) outranked `.btn--ink`,
  // painting the Export label `--ink` on `--ink`. Contrast catches any cause.
  test.describe("toolbar buttons are legible", () => {
    for (const scheme of ["light", "dark"] as const) {
      test(`toolbar buttons show their label and icon in ${scheme} mode`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await signedIn(page);
        await page.goto("/#/note/141");

        await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

        // Scoped to the bar so the rail's "Recycle bin" row does not match.
        const labelledBtn = page.locator(".reader__bar").getByRole("button", { name: "Move to bin" });
        await expect(labelledBtn).toBeVisible();

        await expect(labelledBtn).toHaveText("Move to bin");

        const icon = labelledBtn.locator("svg");
        await expect(icon).toBeVisible();
        const box = await icon.boundingBox();
        expect(box?.width).toBeGreaterThan(8);
        expect(box?.height).toBeGreaterThan(8);

        const { color, background, stroke } = await paintedColours(labelledBtn);

        expect(contrastRatio(color, background)).toBeGreaterThan(4.5);
        expect(stroke).not.toBeNull();
        expect(contrastRatio(stroke!, background)).toBeGreaterThan(4.5);

        // The --fs-eyebrow token (11px), not the inherited 16px sans.
        const font = await labelledBtn.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { size: cs.fontSize, family: cs.fontFamily };
        });
        expect(font.size).toBe("11px");
        expect(font.family).toContain("monospace");
      });
    }
  });

  // ---- the reader owns the header ----
  test.describe("the reader owns the header", () => {
    test("opening a note hides the library topbar and the reader still has height", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
      await freezeMotion(page);

      await expect(page.locator(".topbar")).toBeHidden();
      await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();
      await expect(page.getByRole("combobox", { name: "Sort notes" })).toBeHidden();
      await expect(page.getByRole("group", { name: "View" })).toBeHidden();

      // `.reader` is `position: absolute; inset: 0`; with the topbar hidden, `.content` once
      // fell into a collapsed `auto` row and the reader was Wx0 while every style read correctly.
      const box = await page.locator(".reader").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThan(200);
      expect(box!.width).toBeGreaterThan(200);

      const pageBox = await page.locator(".page").boundingBox();
      expect(pageBox!.height).toBeGreaterThan(100);
    });

    test("closing the reader brings the library header back", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".topbar")).toBeHidden();

      await page.locator(".backbtn").click();

      await expect(page.locator(".topbar")).toBeVisible();
      await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    });

    test("Back names the folder it returns to, and the subtitle does not repeat it", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);
      await page.getByRole("button", { name: "Document" }).first().click();
      await cardButton(page, /Attention Is All You Need/).click();

      await expect(page.locator(".backbtn")).toHaveText("Document");
      await expect(page.locator(".reader__title span")).toHaveText("20 pages");
    });

    test("Back from a search result says Search, and the subtitle names the folder", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);
      await page.getByRole("searchbox", { name: "Search notes" }).fill("Aurora");
      await page.locator(".card--result .card__open").first().click();

      await expect(page.locator(".backbtn")).toHaveText("Search");
      await expect(page.locator(".reader__title span")).toContainText("Note / Projects");
    });
  });

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
