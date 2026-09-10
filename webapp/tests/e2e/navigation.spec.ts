import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, cardButton, railSettled } from "./helpers/app";

// The reader is a full-bleed *overlay* over the library, and there is now ONE
// navigation system: every place has a URL, so a rail click is `#/folder/:id`
// exactly as opening a note is `#/note/:id/page/:n?q=`, and the shell reacts to
// whichever arrives. There used to be two — folder navigation as internal state
// beside a routed reader — which is why navigating the library while the reader
// was open listed the new folder *underneath* the still-open overlay. Reader
// visibility is a function of the route, so the folder route's own handler does
// the closing. (Routing the folder is covered in `routing.spec.ts`; what is
// tested here is the reader/library seam.)
//
// The load-bearing test here is "a reload does not reopen the note": that is what
// distinguishes the real fix from the naive one (calling `reader.close()` inside
// `navigate()`, which hides the overlay but leaves the URL lying about it).
//
// THE OTHER HALF OF THAT SINGLE SOURCE OF TRUTH is that the URL keeps describing
// the reader as it moves — the page, and the search running over it — WITHOUT
// pushing a history entry per page turn. `replaceState` is what separates the two:
// addressability without Back turning into "previous page" for a note you read
// through and "the library" for one you did not. Both halves are asserted below,
// and the second one has to be asserted as an ABSENCE (history did not grow),
// because a build that pushed instead of replaced passes every other assertion
// here.

/** A rail anchor/subfolder located by its exact visible name (ignoring count). */
function navItem(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Folders" })
    .locator(".nav__item", { has: page.locator(".nav__name", { hasText: new RegExp(`^${name}$`) }) });
}

/** The reader overlay. */
function reader(page: Page): Locator {
  return page.getByRole("region", { name: "Reader" });
}

test.describe("navigating while the reader is open", () => {
  test("a rail folder closes the reader, lists that folder, and leaves the note route", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(reader(page)).toBeVisible();

    // The rail stays visible beside the overlay — this is the click that used to
    // navigate the library underneath the reader.
    await railSettled(page);
    await navItem(page, "Archive").click();

    await expect(reader(page)).toBeHidden();
    await expect(cardButton(page, /Archive note 01/)).toBeVisible();
    await expect(page).not.toHaveURL(/#\/note\//);
  });

  test("the header's breadcrumb is not reachable over a note — the reader's own Back is", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Document").click();

    await cardButton(page, /Attention Is All You Need/).click();
    await expect(reader(page)).toBeVisible();
    await expect(page).toHaveURL(/#\/note\/141$/);

    // The breadcrumb used to live in a topbar that stayed on screen over the
    // reader, repeating the note's title and its folder. The topbar leaves now,
    // so the breadcrumb goes with it and Back is the way out.
    await expect(page.locator(".crumbs")).toBeHidden();
    await page.locator(".backbtn").click();

    await expect(reader(page)).toBeHidden();
    await expect(page).not.toHaveURL(/#\/note\//);
    // Back named its destination, and that is where it went.
    await expect(cardButton(page, /Attention Is All You Need/)).toBeVisible();
    await expect(page.locator(".crumbs")).toBeVisible();
  });

  test("the URL is truthful afterwards: a reload does not reopen the note", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(reader(page)).toBeVisible();

    await railSettled(page);
    await navItem(page, "Archive").click();
    await expect(reader(page)).toBeHidden();

    // The naive fix (reader.close() inside navigate()) leaves the hash at
    // `#/note/:id`, so this reload would boot straight back into the reader.
    await page.reload();

    await expect(page).not.toHaveURL(/#\/note\//);
    // Wait for the shell to finish booting before asserting the overlay is
    // absent, so a build that *would* reopen the note has every chance to.
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    // AND IT LANDS BACK IN ARCHIVE, not at the root. The rail click left the
    // note route for `#/folder/archive`, so the reload has a folder to restore —
    // where it used to have only `#/` and a folder card to click again.
    await expect(cardButton(page, /Archive note 01/)).toBeVisible();
    await expect(reader(page)).toBeHidden();
  });

  test("the library's listing chrome is gone over a note, and reader controls leave the route alone", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(reader(page)).toBeVisible();

    // Sort, the view toggle and the search box all describe a LISTING, and the
    // search box was worse than dead weight — typing in it closed the reader. All
    // three leave with the topbar rather than sitting above a note doing nothing
    // (or the wrong thing).
    await expect(page.getByRole("combobox", { name: "Sort notes" })).toBeHidden();
    await expect(page.getByRole("group", { name: "View" })).toBeHidden();
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();

    // The reader's own controls are not NAVIGATION — but the URL still has to say
    // where they left you, so the route gains a page and stays a note route.
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
    await expect(reader(page)).toBeVisible();
    // `/page/2` for the SECOND page: the URL counts from one, as the pager on
    // screen does, while the reader indexes from zero. The conversion lives in
    // the router and nowhere else.
    await expect(page).toHaveURL(/#\/note\/141\/page\/2$/);
  });

  test("Back and forward still route the reader", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Document").click();
    const card = cardButton(page, /Attention Is All You Need/);
    await card.click();
    await expect(reader(page)).toBeVisible();

    await page.goBack();
    await expect(reader(page)).toBeHidden();
    // Back lands on the library still showing the folder we opened the note from.
    await expect(card).toBeVisible();

    await page.goForward();
    await expect(reader(page)).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Attention");
  });
});

// PAGING IS ADDRESSABLE, AND IT IS NOT NAVIGATION.
//
// These two facts are in tension and `replaceState` is what holds them apart, so
// they are asserted together: the URL must follow the reader, and history must
// not grow while it does.
test.describe("the URL follows the reader without becoming history", () => {
  test("turning pages rewrites the URL and adds no history entry", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Document").click();
    const card = cardButton(page, /Attention Is All You Need/);
    await card.click();
    await expect(reader(page)).toBeVisible();
    await expect(page).toHaveURL(/#\/note\/141$/);

    // The depth history has reached by the time the note is open. Everything
    // after this must leave it exactly here.
    const depth = await page.evaluate(() => history.length);

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("3 / 20");
    await page.getByRole("button", { name: "Page 7" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("7 / 20");

    // The URL describes what is on screen…
    await expect(page).toHaveURL(/#\/note\/141\/page\/7$/);
    // …and three page turns cost nothing in history. A build that pushed instead
    // of replaced reads `depth + 3` here and passes every other assertion in this
    // file.
    expect(await page.evaluate(() => history.length)).toBe(depth);

    // Which is the point: ONE Back leaves the note, however far you read. It does
    // not step back to page 3.
    await page.goBack();
    await expect(reader(page)).toBeHidden();
    await expect(card).toBeVisible();
  });

  test("the rewritten URL is truthful: a reload lands on the page you were on", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await page.getByRole("button", { name: "Page 5" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("5 / 20");

    await page.reload();

    // The whole reason the position is in the URL rather than in reader state.
    await expect(page.locator(".pager__count")).toHaveValue("5 / 20");
  });
});

// The route must be dispatched EXACTLY ONCE on load.
//
// `onRoute` used to register a `DOMContentLoaded` listener AND call the callback
// immediately when `readyState !== "loading"`. `readyState` flips to
// "interactive" just before `DOMContentLoaded` fires, so a module evaluating in
// that window did both and dispatched twice.
//
// WHY THIS TEST'S PREMISE MOVED. It used to prove the latch by paging away from
// the route's page and showing that a second dispatch did not drag the reader
// back to it — which worked *because* the URL could not describe the position, so
// the route's page was always the ENTRY page. Making paging addressable removes
// that lever: page 3 now IS the route, and re-dispatching it re-opens the reader
// exactly where it already is. The old assertion would pass on a build with no
// latch at all.
//
// The guarantee it protects is unchanged and still worth a test — a stray
// dispatch must not cost the reader its position — so it is asserted against
// state the route genuinely does NOT carry, and the reader would lose if it were
// rebuilt from the route alone: the zoom step, and the scroll the OCR panel adds
// to the stage. Both are reader state by design, exactly as the page used to be.
test.describe("the initial route is dispatched once", () => {
  test("a late DOMContentLoaded does not throw away state the route cannot describe", async ({ page }) => {
    await signedIn(page);
    // Page 4 (index 3), because it is one the device RECOGNISED — the fixture
    // leaves every third page without a transcript, and the Text toggle is
    // correctly disabled on those.
    await page.goto("/#/note/141/page/4");
    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");

    // Two things the URL says nothing about, so only a genuine re-open can lose
    // them: the zoom step, and the recognized-text panel.
    await page.getByRole("button", { name: "Zoom in" }).click();
    // Scoped to the reader: `.zoom` is the shared zoom-slot class, and the `.txt`
    // viewer (mounted at once, hidden) carries its own `.zoom` font-size label.
    await expect(page.locator(".reader .zoom")).toHaveText("100%");
    await page.getByRole("button", { name: "Recognized text" }).click();
    await expect(page.locator(".ocr")).toBeVisible();

    // `bubbles: true` matters: the real event bubbles document → window, and the
    // listener was registered on `window`. A non-bubbling synthetic event would
    // never reach it and the test would pass against the bug.
    await page.evaluate(() => document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true })));
    await page.waitForTimeout(300);

    // A second dispatch calls `reader.open()`, which resets zoom to "Fit" and
    // `ocr.reset()`s the panel shut. Both still as the user left them.
    await expect(page.locator(".reader .zoom")).toHaveText("100%");
    await expect(page.locator(".ocr")).toBeVisible();
    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
  });

  // The OTHER half, and the reason the bug was destructive in the first place:
  // with the position in the URL a re-dispatch is IDEMPOTENT. Even without the
  // latch the reader would come back to the same page — which is what makes the
  // old failure mode (page 3, export writes page 1) unreachable by construction
  // rather than only by the latch.
  test("re-dispatching the route re-opens the reader where it already is", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await page.getByRole("button", { name: "Page 4" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
    await expect(page).toHaveURL(/#\/note\/141\/page\/4$/);

    // Forcing a real dispatch of the CURRENT route — what a duplicate boot did.
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
    await page.waitForTimeout(300);

    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
    await expect(page).toHaveURL(/#\/note\/141\/page\/4$/);
  });
});
