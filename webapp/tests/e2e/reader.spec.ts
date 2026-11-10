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
      page.getByRole("button", { name: "Page text" });
    const panel = (page: import("@playwright/test").Page) =>
      page.getByRole("region", { name: "Page text" });

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

    test("the panel head reads `[icon] Page text` — a decorative icon before the label", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      await toggle(page).click();
      const head = panel(page).locator(".ocr__head");
      await expect(head.locator(".ocr__head-ic svg")).toBeVisible();
      await expect(head).toContainText("Page text");
    });

    test("the page canvas re-lays out when the panel takes its share of the stage", async ({ page }) => {
      // Width-constrained, so the panel's 268px+22px really competes with the canvas.
      await page.setViewportSize({ width: 800, height: 1000 });
      await signedIn(page);
      await page.goto("/#/note/141");
      await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

      // Close the default-open page index, so the right panel is the only variable.
      await page.getByRole("button", { name: "Pages" }).click();
      await expect(page.getByRole("region", { name: "Pages" })).toBeHidden();

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

    test("a page with no text disables the toggle and states so plainly", async ({ page }) => {
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
      await expect(panel(page).locator(".side-panel__state")).toContainText("No text on this page");
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
    const pagesPanel = (page: Page) => page.getByRole("region", { name: "Pages" });
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

      await expect(page.getByRole("region", { name: "Page text" })).toBeHidden();
      await expect(
        page.locator(".reader__bar").getByRole("button", { name: "Page text" }),
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
      await page.locator(".reader__bar").getByRole("button", { name: "Page text" }).click();
      await expect(page.getByRole("region", { name: "Page text" })).toBeVisible();
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
      await page.getByRole("link", { name: "Document" }).first().click();
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
});
