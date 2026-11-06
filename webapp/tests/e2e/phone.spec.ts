import { test, expect } from "@playwright/test";
import { railSettled, signedIn } from "./helpers/app";

// The library on a phone (below 700px): the rail is a drawer from ☰, the bar
// opens its tools from ⋯, a tab bar holds the four places and search,
// menus are sheets, and a viewer's reading controls sit at the bottom.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test.describe("on a phone", () => {
  test("one way to search, and ⋯ only where the place has tools", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    // Search lives in the tab bar only.
    await expect(page.getByRole("button", { name: "Search", exact: true })).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Search" })).toBeVisible();
    // A folder has sort and view.
    await page.goto("/#/folder/note");
    await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
    // Your account has no tools in the bar: no ⋯ that opens an empty panel.
    await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "You" }).click();
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.getByRole("button", { name: "More", exact: true })).toBeHidden();
    // Back to a folder, and it returns.
    await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Library" }).click();
    await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
  });

  test("the drawer: opens from ☰, keeps the page out of reach, closes on Escape and gives focus back", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    const menu = page.getByRole("button", { name: "Places" });
    const rail = page.getByRole("navigation", { name: "Library" });
    await expect(rail).toBeHidden();
    await menu.click();
    await expect(rail).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    // The rest is inert while it is open.
    expect(await page.locator("main").evaluate((m) => (m as HTMLElement).inert)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(rail).toBeHidden();
    await expect(menu).toBeFocused();
    // Following a link closes it.
    await menu.click();
    await rail.getByRole("link", { name: /^Files/ }).click();
    await expect(rail).toBeHidden();
    await expect(page.locator("main h1")).toHaveText("Files");
  });

  test("the tab bar: marks where you are and goes there", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    const tabs = page.getByRole("navigation", { name: "Sections" });
    await expect(tabs.getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page");
    await tabs.getByRole("link", { name: "To-Do" }).click();
    await expect(page).toHaveURL(/#\/todo/);
    await expect(tabs.getByRole("link", { name: "To-Do" })).toHaveAttribute("aria-current", "page");
    await tabs.getByRole("link", { name: "You" }).click();
    await expect(tabs.getByRole("link", { name: "You" })).toHaveAttribute("aria-current", "page");
  });

  test("search opens across the bar, from the bar or the tab bar, and stays while it holds a query", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    const box = page.getByRole("searchbox").first();
    await expect(box).toBeHidden();
    await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Search" }).click();
    await expect(box).toBeFocused();
    await box.pressSequentially("budget");
    await expect(box).toHaveValue("budget");
    await page.locator("main").click({ position: { x: 10, y: 10 } });
    await expect(box).toBeVisible();
  });

  test("the bar's ⋯ is one menu: its groups as groups, choices ticked, a tool per row", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/files");
    await railSettled(page);
    await page.getByRole("button", { name: "More" }).click();
    const menu = page.locator(".menu__pop--float.is-open");
    await expect(menu).toHaveAttribute("data-sheet", "");
    const box = (await menu.boundingBox())!;
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844);
    await expect(menu.locator(".menu__section")).toHaveText(["Sort", "View"]);
    await expect(menu.getByRole("menuitemradio")).toHaveText(["Recent", "Title", "Pages", "Grid", "List"]);
    await expect(menu.getByRole("menuitemradio", { name: "Recent" })).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByRole("menuitemradio", { name: "Grid" })).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByRole("menuitem", { name: "Upload" })).toBeVisible();
    await expect(menu.locator(".menu__sep")).toHaveCount(2);
    // Choosing closes it, and the bar's own control took the choice.
    await menu.getByRole("menuitemradio", { name: "List" }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('button[aria-label="List view"]')).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "More" }).click();
    await menu.getByRole("menuitemradio", { name: "Title" }).click();
    await expect(page.locator("#sort")).toHaveValue("title");
  });

  test("To-Do's ⋯ is one menu: the list's actions and its downloads, a divider between, no menu inside a menu", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/todo");
    await page.getByRole("link", { name: /Français/ }).first().click();
    await expect(page.locator("main h1")).toHaveText("Français");
    await page.getByRole("button", { name: "More" }).click();
    const menu = page.locator(".menu__pop--float.is-open");
    await expect(menu).toHaveAttribute("data-sheet", "");
    await expect(menu.getByRole("menuitem")).toHaveText(["Rename list", "Delete list", /^Tasks/, /^Plain text/]);
    await expect(menu.locator(".menu__sep")).toHaveCount(1);
    // The tools sheet with its own menu buttons never opens.
    await expect(page.locator(".tools")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("a viewer's file actions fold into ⋯: one menu, downloads brought in, no menu inside a menu", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    const bar = page.locator(".reader__bar");
    await expect(bar.getByRole("button", { name: "Move to bin" })).toBeHidden();
    await bar.getByRole("button", { name: "More" }).click();
    const menu = page.locator(".menu__pop--float.is-open");
    await expect(menu).toHaveAttribute("data-sheet", "");
    await expect(menu.getByRole("menuitem", { name: "Version history" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Supernote/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
    // The page loading behind it does not close it.
    await page.waitForTimeout(800);
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "More" })).toBeFocused();
  });

  // iPhones have no back button of their own: every place below another has
  // ‹ in ☰'s place, one level up; top-level places keep ☰.
  test("‹ goes one level up from a folder, a To-Do list and search; top-level places keep ☰", async ({ page }) => {
    await signedIn(page);
    const back = page.locator(".topbar__back");
    const places = page.getByRole("button", { name: "Places" });
    for (const top of ["/#/", "/#/todo", "/#/bin", "/#/account"]) {
      await page.goto(top);
      await expect(places, top).toBeVisible();
      await expect(back, top).toBeHidden();
    }
    // A nested folder: up to its parent, then up to the Library.
    await page.goto("/#/folder/projects");
    await expect(back).toBeVisible();
    await expect(places).toBeHidden();
    await expect(back).toHaveAccessibleName("Back to Note");
    await back.click();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(back).toHaveAccessibleName("Back to Library");
    await back.click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(places).toBeVisible();
    // A To-Do list: up to Lists.
    await page.goto("/#/todo");
    await page.getByRole("link", { name: /Français/ }).first().click();
    await expect(back).toHaveAccessibleName("Back to Lists");
    await back.click();
    await expect(page).toHaveURL(/#\/todo$/);
    // Search: back to where it started.
    await page.goto("/#/folder/note");
    await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Search" }).click();
    await page.getByRole("searchbox").fill("weekly");
    await expect(page).toHaveURL(/#\/search/);
    await expect(back).toHaveAccessibleName("Back to Note");
    await back.click();
    await expect(page).toHaveURL(/#\/folder\/note$/);
  });

  test("a note reads with one row of reading controls; its tools are under View in ⋯; Pages starts closed", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const bar = page.locator(".reader__bar");
    await expect(bar.getByRole("button", { name: "Next page" })).toBeVisible();
    for (const tool of ["Find in this note", "Recognized text", "Pages"]) await expect(bar.getByRole("button", { name: tool }), tool).toBeHidden();
    await expect(page.getByRole("region", { name: "Pages" })).toBeHidden();
    // The controls left on the bar fit one row.
    const rows = await bar.locator(".toolbar__group:not(.toolbar__group--file) button:visible").evaluateAll((bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size);
    expect(rows).toBe(1);
    await bar.getByRole("button", { name: "More" }).click();
    const menu = page.locator(".menu__pop--float.is-open");
    await expect(menu.locator(".menu__section").first()).toHaveText("View");
    // A panel switch is ticked while on.
    const pages = menu.getByRole("menuitemcheckbox", { name: "Pages" });
    await expect(pages).toHaveAttribute("aria-checked", "false");
    await pages.click();
    await expect(page.getByRole("region", { name: "Pages" })).toBeVisible();
    await bar.getByRole("button", { name: "More" }).click();
    await expect(menu.getByRole("menuitemcheckbox", { name: "Pages" })).toHaveAttribute("aria-checked", "true");
  });

  // Regression: every step was clamped back to the stage's width, so where Fit
  // already filled it (a phone, a tablet upright) zoom did nothing.
  test("zoom enlarges a note past the screen's width, and its start stays reachable", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const sheet = page.locator(".stage .page");
    await expect(sheet).toBeVisible();
    const fit = (await sheet.boundingBox())!.width;
    await page.locator(".reader__bar").getByRole("button", { name: /zoom in/i }).click();
    await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(fit * 1.3);
    await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(390);
    // Scrolled to its start, the page's start is on screen (`safe center`).
    await page.locator(".stage").evaluate((s) => (s.scrollLeft = 0));
    expect((await sheet.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  });

  test("every viewer has its own ‹ back", async ({ page }) => {
    await signedIn(page);
    // A note, a PDF, an image, a sketch, a text file.
    for (const id of ["101", "142", "151", "174", "177"]) {
      await page.goto(`/#/folder/note`);
      await page.goto(`/#/note/${id}`);
      const back = page.locator(".backbtn:visible, .viewer__back:visible");
      await expect(back, id).toHaveCount(1);
      await back.click();
      await expect(page, id).not.toHaveURL(/#\/note\//);
    }
  });

  test("a card's ⋯ menu is a sheet along the bottom", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/files");
    await railSettled(page);
    await page.locator(".card .card__more").first().click();
    const sheet = page.locator(".menu__pop--float.is-open");
    await expect(sheet).toHaveAttribute("data-sheet", "");
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844);
  });

  test("a note's reading controls sit at the bottom, its title keeps the top", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const next = page.getByRole("button", { name: "Next page" });
    await expect(next).toBeVisible();
    expect((await next.boundingBox())!.y).toBeGreaterThan(700);
    await expect(page.locator(".reader__title b")).toBeVisible();
    // The tab bar gives way to the reader's own.
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeHidden();
  });
});

test.describe("at desktop width", () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
  test("none of it shows", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await expect(page.getByRole("button", { name: "Places" })).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Library" })).toBeVisible();
  });
});
