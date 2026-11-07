import { test, expect } from "@playwright/test";
import { railSettled, signedIn } from "./helpers/app";
import { servePdf } from "./pdfViewer.shared";

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

  test("a viewer's file actions fold into ⋯: one menu, its long Download behind one row", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    const bar = page.locator(".reader__bar");
    await expect(bar.getByRole("button", { name: "Move to bin" })).toBeHidden();
    await expect(bar.getByRole("button", { name: "Next page" })).toBeEnabled();
    await bar.getByRole("button", { name: "More" }).click();
    const menu = page.locator(".menu__pop--float.is-open");
    await expect(menu).toHaveAttribute("data-sheet", "");
    await expect(menu.getByRole("menuitem", { name: "Version history" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Download" })).toHaveAttribute("aria-haspopup", "menu");
    await expect(menu.getByRole("menuitem", { name: /^Supernote/ })).toHaveCount(0);
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

  test("a note's bar holds paging and its panel switches; Find sits by ⋯; zoom is under View in ⋯; Pages starts closed", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const bar = page.locator(".reader__bar");
    await expect(bar.getByRole("button", { name: "Next page" })).toBeVisible();
    for (const tool of ["Recognized text", "Pages"]) await expect(bar.getByRole("button", { name: tool }), tool).toBeVisible();
    for (const tool of ["Zoom in", "Zoom out"]) await expect(bar.getByRole("button", { name: tool }), tool).toBeHidden();
    // Find in the top row, beside ⋯, level with the title.
    const find = bar.getByRole("button", { name: "Find in this note" });
    await expect(find).toBeVisible();
    const more = (await bar.getByRole("button", { name: "More" }).boundingBox())!;
    const findBox = (await find.boundingBox())!;
    expect(Math.round(findBox.y)).toBe(Math.round(more.y));
    expect(findBox.x).toBeLessThan(more.x);
    await expect(page.getByRole("region", { name: "Pages" })).toBeHidden();
    // The controls left on the bar fit one row.
    const rows = await bar.locator(".toolbar__group:not(.toolbar__group--file) button:visible").evaluateAll((bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size);
    expect(rows).toBe(1);
    await bar.getByRole("button", { name: "More" }).click();
    const menu = page.locator(".menu__pop--float.is-open");
    await expect(menu.locator(".menu__section").first()).toHaveText("View");
    await expect(menu.getByRole("menuitemcheckbox", { name: "Find in this note" })).toHaveCount(0);
    for (const tool of ["Zoom out", "Zoom in"]) await expect(menu.getByRole("menuitem", { name: tool }), tool).toBeVisible();
    await expect(menu.getByRole("menuitemcheckbox", { name: "Pages" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // A panel switch shows whether it is on.
    const pages = bar.getByRole("button", { name: "Pages" });
    await expect(pages).toHaveAttribute("aria-pressed", "false");
    await pages.click();
    await expect(page.getByRole("region", { name: "Pages" })).toBeVisible();
    await expect(pages).toHaveAttribute("aria-pressed", "true");
  });

  test("a long menu of the bar's (Download) is one row that opens in place, with a way back", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const bar = page.locator(".reader__bar");
    // The note's own rows (its downloads) arrive with it.
    await expect(bar.getByRole("button", { name: "Next page" })).toBeEnabled();
    await expect(page.locator(".stage .page canvas").first()).toBeVisible();
    await bar.getByRole("button", { name: "More" }).click();
    const menu = page.locator(".menu__pop--float.is-open");
    await expect(menu.getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
    await expect(menu.getByText(".ora")).toHaveCount(0);
    const download = menu.getByRole("menuitem", { name: "Download" });
    await expect(download).toHaveAttribute("aria-haspopup", "menu");
    await download.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByText(".ora")).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Move to bin" })).toHaveCount(0);
    const back = menu.getByRole("menuitem", { name: "Download" });
    await expect(back).toBeFocused();
    await back.click();
    await expect(menu.getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Download" })).toHaveAttribute("aria-haspopup", "menu");
  });

  test("Version history from ⋯ is a sheet the screen's width", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const bar = page.locator(".reader__bar");
    await expect(bar.getByRole("button", { name: "Next page" })).toBeEnabled();
    await bar.getByRole("button", { name: "More" }).click();
    await page.locator(".menu__pop--float.is-open").getByRole("menuitem", { name: "Version history" }).click();
    const sheet = page.locator(".vh.is-open");
    await expect(sheet).toHaveAttribute("data-sheet", "");
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844);
  });

  // On an iPhone the reader slid off the list it covers (Find's field scrolled
  // into view scrolled the library under it) and the field jumped (iOS zooms
  // in on a field under 16px).
  test("an open file never scrolls off the library under it, and Find's field holds still", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/files");
    await railSettled(page);
    await page.goto("/#/note/101");
    const reader = page.locator(".reader.is-open");
    await expect(reader).toBeVisible();
    await page.locator(".content").evaluate((c) => {
      c.scrollTop = 400;
      c.scrollBy(0, 400);
    });
    expect(Math.round((await reader.boundingBox())!.y)).toBe(0);
    const bar = page.locator(".reader__bar");
    await bar.getByRole("button", { name: "Find in this note" }).click();
    const field = page.getByRole("textbox", { name: "Find in this note" });
    await expect(field).toBeFocused();
    expect(parseFloat(await field.evaluate((f) => getComputedStyle(f).fontSize))).toBeGreaterThanOrEqual(16);
    // A long status line sits under the field, not beside it squeezing it.
    await page.locator(".reader .findbar__count").evaluate((c) => (c.textContent = "Couldn't search this note. Keep typing to retry."));
    expect((await field.boundingBox())!.width).toBeGreaterThan(150);
    expect((await reader.boundingBox())!.y).toBe(0);
  });

  // Zoom on a phone is a pinch, and a double tap back to Fit. Dispatched as
  // touch events, which is what the viewer listens to.
  test("a pinch zooms the page sharp, a double tap puts it back to Fit", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const sheet = page.locator(".stage .page");
    await expect(sheet).toBeVisible();
    const fit = (await sheet.boundingBox())!.width;
    const can = await page.locator(".stage").evaluate((stage) => {
      // Desktop WebKit has `Touch` but won't let a script make one.
      try {
        new Touch({ identifier: 0, target: stage, clientX: 0, clientY: 0 });
      } catch {
        return false;
      }
      const r = stage.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const pair = (d: number) => [1, 2].map((id) => new Touch({ identifier: id, target: stage, clientX: cx + (id === 1 ? -d : d) / 2, clientY: cy }));
      const fire = (type: string, touches: Touch[]) => stage.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }));
      fire("touchstart", pair(100));
      for (let i = 1; i <= 5; i++) fire("touchmove", pair(100 + 30 * i));
      fire("touchend", []);
      return true;
    });
    test.skip(!can, "this browser won't let a script make touches");
    // 250 / 100: the page re-renders at 2.5 × Fit, its own box, not a stretched picture.
    await expect.poll(async () => (await sheet.evaluate((el) => el.offsetWidth)) / fit).toBeGreaterThan(2.3);
    await expect(sheet).toHaveCSS("transform", "none");
    const canvas = page.locator(".stage .page canvas").first();
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(fit * 2);
    // Double tap: back to Fit.
    await page.locator(".stage").evaluate((stage) => {
      const r = stage.getBoundingClientRect();
      const t = new Touch({ identifier: 3, target: stage, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
      for (let i = 0; i < 2; i++) {
        stage.dispatchEvent(new TouchEvent("touchstart", { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
        stage.dispatchEvent(new TouchEvent("touchend", { touches: [], targetTouches: [], changedTouches: [t], bubbles: true, cancelable: true }));
      }
    });
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.width)).toBe(Math.round(fit));
  });

  // A sideways swipe turns the page, in the note reader and in the PDF viewer.
  const swipeOn = (stage: import("@playwright/test").Locator, dx: number) =>
    stage.evaluate((el, dx) => {
      try {
        new Touch({ identifier: 0, target: el, clientX: 0, clientY: 0 });
      } catch {
        return false; // desktop WebKit won't let a script make one
      }
      const r = el.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const x0 = r.left + r.width / 2 - dx / 2;
      const at = (x: number) => [new Touch({ identifier: 4, target: el, clientX: x, clientY: y })];
      const fire = (type: string, touches: Touch[], changed = touches) =>
        el.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: changed, bubbles: true, cancelable: true }));
      fire("touchstart", at(x0));
      for (let i = 1; i <= 4; i++) fire("touchmove", at(x0 + (dx * i) / 4));
      fire("touchend", [], at(x0 + dx));
      return true;
    }, dx);

  test("a swipe to the left turns to the next page, to the right back", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    const stage = page.locator(".stage");
    await expect(stage.locator(".page")).toBeVisible();
    test.skip(!(await swipeOn(stage, -200)), "this browser won't let a script make touches");
    await expect(page).toHaveURL(/\/note\/141\/page\/2$/);
    await swipeOn(stage, 200);
    await expect(page).toHaveURL(/\/note\/141$/);
    // A scroll down is not a turn.
    await stage.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const t = (y: number) => [new Touch({ identifier: 5, target: el, clientX: r.left + 150, clientY: y })];
      const fire = (type: string, touches: Touch[], changed = touches) =>
        el.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: changed, bubbles: true, cancelable: true }));
      fire("touchstart", t(r.top + 400));
      fire("touchmove", t(r.top + 150));
      fire("touchend", [], t(r.top + 150));
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/note\/141$/);
  });

  test("a swipe turns a PDF's page", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    const main = page.locator(".viewer--pdf .pdf-wrap");
    await expect(page.locator(".viewer--pdf .pdf-page")).toBeVisible({ timeout: 20_000 });
    test.skip(!(await swipeOn(main, -200)), "this browser won't let a script make touches");
    await expect(page).toHaveURL(/\/note\/178\/page\/2/);
    await swipeOn(main, 200);
    await expect(page).toHaveURL(/\/note\/178$/);
  });

  // Regression: on a phone the text sat in a small 3:4 card scrolling inside a
  // wide margin, a third of the screen.
  test("a .txt fills the screen's width and scrolls to its last line above the bar", async ({ page }) => {
    await signedIn(page);
    const body = Array.from({ length: 80 }, (_, i) => `line ${i + 1}: the quick brown fox`).join("\n") + "\nTHE LAST LINE";
    await page.route(
      (url) => url.pathname.startsWith("/file/"),
      (route) => route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body }),
    );
    await page.goto("/#/note/177");
    const sheet = page.locator(".viewer--txt .txt__sheet");
    await expect(sheet).toContainText("THE LAST LINE");
    const box = (await sheet.boundingBox())!;
    expect(box.x).toBe(0);
    expect(Math.round(box.width)).toBe(390);
    await sheet.evaluate((el) => (el.scrollTop = el.scrollHeight));
    // The bottom row, where the text-size stepper sits.
    const bar = (await page.getByRole("button", { name: "Larger text" }).boundingBox())!;
    const last = await sheet.evaluate((el) => {
      const r = document.createRange();
      const t = el.lastChild ?? el;
      r.selectNodeContents(t);
      return r.getBoundingClientRect().bottom;
    });
    expect(last).toBeLessThanOrEqual(bar.y);
    // The column-width zoom has nothing to widen: not offered under ⋯.
    await page.locator(".viewer--txt .viewer__bar").getByRole("button", { name: "More" }).click();
    const menu = page.locator(".menu__pop--float.is-open");
    await expect(menu.getByRole("menuitem", { name: "Download" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Zoom/ })).toHaveCount(0);
  });

  // An iPhone's status bar and home indicator: with `viewport-fit=cover` the
  // insets are real, and the bars keep their controls out of both.
  test("the bars keep clear of the status bar and the home indicator", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "only Chromium can fake the safe-area insets");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 47, bottom: 34, left: 0, right: 0 } } as never);
    await signedIn(page);
    await page.goto("/#/note/101");
    await expect(page.locator(".stage .page")).toBeVisible();
    // Without the opt-in iOS reports no insets at all (Chromium's override applies regardless).
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
    const back = (await page.locator(".reader__bar").getByRole("button", { name: "Library" }).boundingBox())!;
    expect(back.y).toBeGreaterThanOrEqual(47);
    const next = (await page.locator(".reader__bar").getByRole("button", { name: "Next page" }).boundingBox())!;
    expect(next.y + next.height).toBeLessThanOrEqual(844 - 34);
    // The library's tab bar too.
    await page.goto("/#/");
    const tab = (await page.getByRole("link", { name: "Library" }).last().boundingBox())!;
    expect(tab.y + tab.height).toBeLessThanOrEqual(844 - 34);
  });

  // Regression: ON was a faint grey wash, hard to tell from OFF.
  // And ON is not the focus ring's colour, so focus never looks like ON.
  test("a toggle that is on is filled in ink, one that is off is not", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const bar = page.locator(".reader__bar");
    const pages = bar.getByRole("button", { name: "Pages" });
    const ocr = bar.getByRole("button", { name: /Recognized text/ });
    await pages.click();
    await expect(pages).toHaveAttribute("aria-pressed", "true");
    await expect(ocr).toHaveAttribute("aria-pressed", "false");
    // The token values, resolved the same way the buttons' are.
    const token = (name: string) =>
      page.evaluate((n) => {
        const probe = document.createElement("i");
        probe.style.color = `var(${n})`;
        document.querySelector(".sn-root")!.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      }, name);
    const look = (b: typeof pages) => b.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]);
    const on = [await token("--ink"), await token("--sheet")];
    expect(on[0]).not.toBe(await token("--accent"));
    // Polled: the fill fades in.
    await expect.poll(() => look(pages)).toEqual(on);
    await expect.poll(async () => (await look(ocr))[0]).toBe("rgba(0, 0, 0, 0)");
  });

  // Regression: with a file open the library under it is clipped, not scrolled,
  // so its widest unbreakable word set the screen's width: from a search, the
  // .txt arrived wider than the phone, its bar and lines cut at the edge.
  test("nothing left under an open file widens it past the screen", async ({ page }) => {
    await signedIn(page);
    await page.route((url) => url.pathname.startsWith("/file/"), (r) => r.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "a line" }));
    await page.goto("/#/search?q=budget");
    await page.goto("/#/note/177?q=line");
    await expect(page.locator(".viewer--txt .txt__sheet")).toContainText("a line");
    await page.locator(".content").evaluate((c) => {
      const s = document.createElement("span");
      s.style.whiteSpace = "nowrap";
      s.textContent = "www.gutenberg.org/ebooks/2000/".repeat(8);
      c.append(s);
    });
    await expect.poll(async () => Math.round((await page.locator(".viewer--txt").boundingBox())!.width)).toBe(390);
    await expect(page.locator(".viewer--txt .viewer__bar").getByRole("button", { name: "More" })).toBeInViewport({ ratio: 1 });
  });

  // Regression: rem follows the iPhone's text size (`-apple-system-body`), so with
  // a smaller one a 1rem field fell under 16px, and iOS zoomed the page on focus,
  // staying zoomed after (a library search, then the .txt it opened).
  test("every text field stays at 16px or more, whatever the phone's text size", async ({ page }) => {
    const small = "html { font-size: 13px !important; }";
    const size = (l: import("@playwright/test").Locator) => l.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    await page.goto("/#/login");
    await page.addStyleTag({ content: small });
    const login = page.locator("input").first();
    await expect(login).toBeVisible();
    expect(await size(login)).toBeGreaterThanOrEqual(16);

    await signedIn(page);
    await page.goto("/");
    await page.addStyleTag({ content: small });
    await page.locator(".tabbar").getByRole("button", { name: "Search" }).click();
    expect(await size(page.getByRole("searchbox", { name: "Search notes" }))).toBeGreaterThanOrEqual(16);

    await page.route((url) => url.pathname.startsWith("/file/"), (r) => r.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "a line" }));
    await page.goto("/#/note/177");
    await page.addStyleTag({ content: small });
    await page.locator(".viewer--txt .viewer__bar").getByRole("button", { name: "Find in this file" }).click();
    expect(await size(page.getByRole("textbox", { name: "Find in this file" }))).toBeGreaterThanOrEqual(16);
  });

  // Regression: every step was clamped back to the stage's width, so where Fit
  // already filled it (a phone, a tablet upright) zoom did nothing.
  test("zoom enlarges a note past the screen's width, and its start stays reachable", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const sheet = page.locator(".stage .page");
    await expect(sheet).toBeVisible();
    const fit = (await sheet.boundingBox())!.width;
    // The one-finger way: Zoom in, under ⋯.
    await page.locator(".reader__bar").getByRole("button", { name: "More" }).click();
    await page.locator(".menu__pop--float.is-open").getByRole("menuitem", { name: "Zoom in" }).click();
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

  // A panel used to float over the page while the page still shrank to make
  // room beside it: a sliver of a page, hidden behind the panel.
  test("a reader's panels are one sheet on its bar, the page fits above it, × closes it", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    const bar = page.locator(".reader__bar");
    const sheetPage = page.locator(".stage .page");
    await expect(sheetPage).toBeVisible();
    const alone = (await sheetPage.boundingBox())!;
    const open = (name: string) => bar.getByRole("button", { name }).click();

    await open("Recognized text");
    const text = page.getByRole("region", { name: "Recognized text" });
    await expect(text).toBeVisible();
    const controls = (await bar.locator(".toolbar__group:not(.toolbar__group--file)").boundingBox())!;
    let panel = (await text.boundingBox())!;
    expect(Math.abs(panel.y + panel.height - controls.y)).toBeLessThanOrEqual(1);
    expect(Math.round(panel.width)).toBe(390);
    await expect.poll(async () => { const b = (await sheetPage.boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(panel.y);
    expect((await sheetPage.boundingBox())!.width).toBeGreaterThan(alone.width * 0.6);

    // One at a time: Pages takes the sheet's place, its pages in a row.
    await open("Pages");
    const pages = page.getByRole("region", { name: "Pages" });
    await expect(pages).toBeVisible();
    await expect(text).toBeHidden();
    const tops = await pages.locator(".filmstrip__page").evaluateAll((rows) => new Set(rows.map((r) => Math.round(r.getBoundingClientRect().top))).size);
    expect(tops).toBe(1);
    panel = (await pages.boundingBox())!;
    await expect.poll(async () => { const b = (await sheetPage.boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(panel.y);

    await pages.getByRole("button", { name: "Close pages" }).click();
    await expect(pages).toBeHidden();
    await expect(bar.getByRole("button", { name: "Pages" })).toBeFocused();
    await expect.poll(async () => (await sheetPage.boundingBox())!.height).toBeGreaterThan(panel.height);
  });

  test("a PDF's panel is a sheet too, the page above it", async ({ page }) => {
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    const bar = page.locator(".viewer--pdf .viewer__bar");
    const pdfPage = page.locator(".viewer--pdf .pdf-page");
    await expect(pdfPage).toBeVisible({ timeout: 20_000 });
    await bar.getByRole("button", { name: "Pages" }).click();
    const pages = page.getByRole("region", { name: "Pages" });
    await expect(pages).toBeVisible();
    const panel = (await pages.boundingBox())!;
    await expect.poll(async () => { const b = (await pdfPage.boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(panel.y);
    await expect.poll(async () => (await pdfPage.boundingBox())!.width).toBeGreaterThan(200);
    await pages.getByRole("button", { name: "Close pages" }).click();
    await expect(pages).toBeHidden();
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

  test("a docked panel has no ×: its toggle on the bar closes it", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/101");
    await expect(page.getByRole("region", { name: "Pages" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close pages" })).toBeHidden();
  });
});
