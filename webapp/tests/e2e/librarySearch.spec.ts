// Library search, the remembered sort order and the top-bar heights.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, cardButton, railSettled } from "./helpers/app";
import { openCategory } from "./library.shared";

test.describe("library rail + gallery", () => {
  test.describe("grid card overflow menu", () => {
    const card = (page: Page, name: string) => page.locator(".card", { hasText: name });
    const more = (page: Page, name: string) => card(page, name).getByRole("button", { name: `Actions for ${name}` });

    test("opens, tracks aria-expanded, and closes on an outside click or Escape", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Document");

      const trigger = more(page, "Attention Is All You Need");
      const pop = page.locator(".menu-portal .menu__pop");
      await expect(trigger).toHaveCount(1);
      await expect(pop).toBeHidden();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");

      await trigger.click();
      await expect(pop).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(pop.locator(".menu__section")).toHaveText(["DOWNLOAD", "ACTIONS"]);
      await expect(pop.getByRole("menuitem")).toHaveCount(5);
      await expect(pop.getByRole("menuitem", { name: /PDF document/ })).toBeVisible();
      const moveBin = pop.getByRole("menuitem").last();
      await expect(moveBin).toHaveText("Move to bin");
      await expect(moveBin).not.toHaveClass(/menu__item--danger/);

      await page.locator(".topbar").click({ position: { x: 4, y: 4 } });
      await expect(pop).toBeHidden();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");

      await trigger.click();
      await expect(pop).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(pop).toBeHidden();
    });

    test("a non-note downloads only its original bytes, and the trigger stays in the corner", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Document");

      const pdfMenu = card(page, "Apartment lease").locator(".card__menu");
      await expect(pdfMenu).toHaveCount(1);
      await more(page, "Apartment lease").click();
      // The open popover is portaled to `.menu-portal`.
      const pdfPop = page.locator(".menu-portal .menu__pop");
      await expect(pdfPop.locator(".menu__section")).toHaveText(["DOWNLOAD", "ACTIONS"]);
      await expect(pdfPop.getByRole("menuitem")).toHaveCount(3);
      await expect(pdfPop.getByRole("menuitem", { name: /Original file/ })).toBeVisible();
      await expect(pdfPop.getByRole("menuitem", { name: "Rename" })).toBeVisible();
      await expect(pdfPop.getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
      await page.keyboard.press("Escape");

      // Regression guard: `.menu` (later, equal specificity) must not put `.card__menu` into flow.
      const noteCard = card(page, "Attention Is All You Need");
      const menu = noteCard.locator(".card__menu");
      // Polled: a detached node reports "" for every computed property.
      await expect
        .poll(async () => (await menu.evaluate((e) => getComputedStyle(e).position)) || null)
        .toBe("absolute");

      await expect
        .poll(async () => {
          const t = await noteCard.locator(".card__more").boundingBox();
          const thumb = await noteCard.locator(".thumb").boundingBox();
          const withMenu = await noteCard.boundingBox();
          const without = await card(page, "Apartment lease").boundingBox();
          if (!t || !thumb || !withMenu || !without) return null;
          return {
            insetFromRight: Math.abs(thumb.x + thumb.width - (t.x + t.width) - 8) < 1.5,
            insetFromTop: Math.abs(t.y - thumb.y - 8) < 1.5,
            noExtraHeight: Math.abs(withMenu.height - without.height) < 1.5,
          };
        })
        .toEqual({ insetFromRight: true, insetFromTop: true, noExtraHeight: true });
    });

    test("the PDF document item exports the whole notebook, the same as a list row does", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");

      await more(page, "Ideas & scratch").click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator(".menu-portal").getByRole("menuitem", { name: /PDF document/ }).click(),
      ]);
      expect(download.suggestedFilename()).toBe("Ideas & scratch.pdf");
      await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    });
  });

  // Always visible: hover never fires on touch. Runs with `hasTouch` + `isMobile`.
  test.describe("always-visible actions on a touch device", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 851 } });

    test("both the list row's button and the grid card's trigger are visible unhovered", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");
      await page.addStyleTag({ content: `*, *::before, *::after { transition: none !important; }` });

      // Polled: the gallery repaints under it.
      const opacityOf = (loc: Locator) =>
        expect
          .poll(async () => {
            const v = await loc.evaluate((e) => getComputedStyle(e).opacity);
            return v === "" ? null : Number(v);
          })
          .toBe(1);

      const trigger = page.locator(".card", { hasText: "Weekly review" }).locator(".card__more");
      await expect(trigger).toHaveCount(1);
      await opacityOf(trigger);

      // On a phone the view switch is a choice in the bar's ⋯ menu.
      await page.getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitemradio", { name: "List" }).click();
      await page.addStyleTag({ content: `*, *::before, *::after { transition: none !important; }` });
      const listMore = page.locator(".card", { hasText: "Weekly review" }).locator(".card__more");
      await expect(listMore).toHaveCount(1);
      await opacityOf(listMore);
    });
  });

  test("search filters the current folder by name", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openCategory(page, "Archive");
    await expect(cardButton(page, /Archive note 01/)).toBeVisible();

    await page.getByRole("searchbox", { name: "Search notes" }).fill("note 02");
    await expect(cardButton(page, /Archive note 02/)).toBeVisible();
    await expect(cardButton(page, /Archive note 01/)).toHaveCount(0);
  });
});

test.describe("the sort order is remembered", () => {
  test("survives a reload, in both the gallery and the control", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    // The root holds only folders, which `sort` does not order.
    await openCategory(page, "MyStyle");

    const sort = page.locator("#sort");
    await expect(sort).toHaveValue("recent");

    // Note cards only: folder cards sit ahead and are not sorted.
    const titles = async (): Promise<string[]> =>
      page.locator(".card__open:not(:has(.thumb--folder-shape)) .card__title").allInnerTexts();

    await sort.selectOption("title");
    const byTitle = await titles();
    // Guard: an already-alphabetical fixture would let a broken restore pass.
    expect(byTitle.length).toBeGreaterThan(1);
    expect([...byTitle].sort((a, b) => a.localeCompare(b))).toEqual(byTitle);

    await page.reload();
    await openCategory(page, "MyStyle");

    await expect(page.locator("#sort")).toHaveValue("title");
    expect(await titles()).toEqual(byTitle);
  });

  test("an unrecognised stored value falls back to Recent instead of breaking", async ({ page }) => {
    await signedIn(page);
    await page.addInitScript(() => window.localStorage.setItem("sn.sort", "by-vibes"));
    await page.goto("/");
    await openCategory(page, "MyStyle");

    await expect(page.locator("#sort")).toHaveValue("recent");
    expect(await page.locator(".card__open").count()).toBeGreaterThan(0);
  });
});

// `--topbar-control-h` sets every control's border-box height.
test.describe("the top-bar controls share one height", () => {
  test("the sort select, the view toggle and the search box all report the same offsetHeight", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    const sort = page.locator("#sort");
    const segmented = page.locator(".segmented");
    const search = page.locator(".search input");
    await expect(sort).toBeVisible();
    await expect(segmented).toBeVisible();
    await expect(search).toBeVisible();

    // Upload shipped 6px short: `.btn` wins on stylesheet order. Add every new topbar control here.
    const upload = page.locator("#upload");
    await expect(upload).toBeVisible();

    const heightOf = (loc: Locator) => loc.evaluate((el) => (el as HTMLElement).offsetHeight);
    const [hSort, hSeg, hSearch, hUpload] = await Promise.all([
      heightOf(sort),
      heightOf(segmented),
      heightOf(search),
      heightOf(upload),
    ]);

    expect(hSort).toBe(hSeg);
    expect(hSearch).toBe(hSeg);
    expect(hUpload).toBe(hSeg);
    // Guard: a zero height would make the equality vacuous.
    expect(hSeg).toBeGreaterThan(0);
  });
});
