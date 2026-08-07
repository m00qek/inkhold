import { test, expect, type Locator, type Page } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";
import { signedIn, cardButton, railSettled } from "./helpers/app";

// THE RULE, END TO END: every place has a URL; every navigation pushes and every
// adjustment replaces.
//
// These tests are deliberately about the RULE rather than about the route table.
// A spec that only checked `#/folder/:id` appears in the address bar would pass
// on a build where the URL is written but never read, which is exactly the half-
// fix this work replaced — folder navigation was internal state with a routed
// reader beside it, so reloading inside a subfolder put you back at the root and
// Back's meaning depended on which of the two systems you had last used.
//
// So each place is proved the same three ways, because those are the three
// things a URL is FOR:
//
//   - RELOAD lands on the same place (it is written and it is read);
//   - BACK and FORWARD step through places, not through knob turns;
//   - a link that has gone stale degrades to somewhere real, with something
//     honest on screen.
//
// The push/replace half is asserted as an ABSENCE (`history.length` did not
// grow), because a build that pushed where it should replace passes every
// visible assertion here.

/** A rail anchor/subfolder/destination located by its exact visible name. */
function navItem(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Folders" })
    .locator(".nav__item", { has: page.locator(".nav__name", { hasText: new RegExp(`^${name}$`) }) });
}

function reader(page: Page): Locator {
  return page.getByRole("region", { name: "Reader" });
}

/** The row the rail is currently marking as where you are. */
function currentNavItem(page: Page): Locator {
  return page.getByRole("navigation", { name: "Folders" }).locator('.nav__item[aria-current="true"]');
}

const searchBox = (page: Page) => page.getByRole("searchbox", { name: "Search notes" });

// --- 1. WHICH FOLDER YOU ARE IN ---------------------------------------------
//
// The biggest gap and the most common action: open a subfolder, reload, and you
// used to be back at the root.

test.describe("a folder is a place", () => {
  test("opening one from the rail puts it in the URL, and a reload lands back in it", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    await navItem(page, "Note").click();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();

    await page.reload();

    // THE ASSERTION THE WHOLE REFACTOR IS FOR. On the old build this landed on
    // the library root and showed the six category cards instead.
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
    await railSettled(page);
    await expect(currentNavItem(page)).toHaveText(/^Note/);
  });

  test("a subfolder is reachable by link alone, with the breadcrumb it would have had", async ({ page }) => {
    await signedIn(page);
    // Straight in, having never visited the parent — a shared link, a bookmark.
    await page.goto("/#/folder/projects");

    await expect(cardButton(page, /Project Aurora — kickoff/)).toBeVisible();
    // The breadcrumb comes off the server's own `listing.path`, so it is right
    // immediately — it does not wait for the tree walk the RAIL needs.
    await expect(page.locator(".crumbs")).toContainText("Projects");
    // The rail's highlight IS provisional until the walk lands: which category a
    // folder sits under is `resolveCategory`'s answer. It arrives, rather than
    // being waited on by a second mechanism.
    await railSettled(page);
    await expect(currentNavItem(page)).toHaveText(/^Projects/);
  });

  test("Back and Forward step through folders", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    await navItem(page, "Note").click();
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
    // Down one more, this time through a gallery card rather than the rail: both
    // entry points are the same `go()`, and a test that only used the rail would
    // not notice one of them going back to calling `navigate()` directly.
    await cardButton(page, /^Projects/).click();
    await expect(page).toHaveURL(/#\/folder\/projects$/);
    await expect(cardButton(page, /Project Aurora — kickoff/)).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();

    await page.goBack();
    // `page.goto("/")` left no hash at all, so the root is spelled bare here —
    // one place, two spellings the browser gave us, both meaning the library.
    await expect(page).toHaveURL(/\/(#\/)?$/);
    await expect(page.locator(".card--folder").first()).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
  });

  test("a link to a folder that is gone lands somewhere real and says so", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/deleted-last-tuesday");

    // Something HONEST on screen — not a blank shell, and not an empty folder,
    // which would be a confident lie about a folder that does not exist.
    await expect(page.locator(".toast")).toContainText("isn't there any more");
    // …and somewhere real to be.
    await expect(page).toHaveURL(/#\/$/);
    await railSettled(page);
    await expect(page.locator(".card--folder").first()).toBeVisible();

    // A REDIRECT, NOT A NAVIGATION. The missing folder was never a place, so it
    // must not be a rung Back can climb onto only to be bounced off it again.
    await page.goBack();
    await expect(page).not.toHaveURL(/deleted-last-tuesday/);
  });
});

// --- 2 & 3. THE DESTINATIONS -------------------------------------------------

test.describe("a destination is a place", () => {
  test("the recycle bin has a URL, survives a reload, and keeps the rail honest", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    await navItem(page, "Recycle bin").click();
    // Spelled by the rail's own `DESTINATIONS` key — the router reads that list
    // rather than restating the name.
    await expect(page).toHaveURL(/#\/bin$/);
    await expect(page.locator(".bin")).toBeVisible();

    await page.reload();
    await expect(page.locator(".bin")).toBeVisible();
    await railSettled(page);
    // The rail highlight derives from the ROUTE now, so it cannot disagree with
    // the address bar even though the bin's own DOM is what `bin.isOpen()` reads.
    await expect(currentNavItem(page)).toHaveText(/^Recycle bin/);

    // Back leaves the bin for wherever you were.
    await page.goBack();
    await expect(page).toHaveURL(/\/(#\/)?$/);
    await expect(page.locator(".bin")).toHaveCount(0);
  });

  test("backing out of a note opened from the bin lands in the bin, not in a folder", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/bin");
    await expect(page.locator(".bin")).toBeVisible();

    await page.getByRole("button", { name: /20260720_152956/ }).first().click();
    await expect(reader(page)).toBeVisible();
    // The reader NAMES where it will go — history could return you there but it
    // could never tell you what to call it, which is why the origin survives.
    await expect(page.locator(".backbtn__label")).toHaveText("Recycle bin");

    await page.locator(".backbtn").click();
    await expect(page).toHaveURL(/#\/bin$/);
    await expect(page.locator(".bin")).toBeVisible();
  });

  test("the admin console has a URL — and it opens the GATE, never the console", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: true, mustChangePassword: false } },
    });
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Admin").click();
    await expect(page).toHaveURL(/#\/admin$/);

    await page.getByLabel("Password", { exact: true }).fill("inkhold");
    await page.getByRole("button", { name: "Unlock console" }).click();
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();

    // ADDRESSABLE IS NOT ACCESSIBLE. The URL survives the reload; the elevation
    // does not, because the server is its authority and this document has not
    // asked it anything yet. A bookmark that reopened the console would be a way
    // around `require_admin`, which is enforced server-side — and the client must
    // not imply otherwise.
    await page.reload();
    await expect(page).toHaveURL(/#\/admin$/);
    await expect(page.getByRole("button", { name: "Unlock console" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "People" })).toHaveCount(0);
  });

  test("a household member who types the admin URL meets the same gate", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "rui@household.lan", isAdmin: false, mustChangePassword: false } },
    });
    // The rail hides the row from them (a door that always refuses is worse than
    // no door), but a URL can still be typed. What it reaches is the gate, and
    // the gate is what the server enforces.
    await page.goto("/#/admin");
    await expect(page.getByRole("button", { name: "Unlock console" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "People" })).toHaveCount(0);
  });
});

// --- 4. LIBRARY-WIDE SEARCH --------------------------------------------------

test.describe("a library-wide search is a place", () => {
  test("typing pushes ONCE, refining replaces, and the URL is shareable", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Note").click();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    // Waited for on purpose: the click only sets the hash, and the route handler
    // that lands the listing — and CLEARS the search box — runs a task later.
    // Typing into the box before it has run gets the box wiped underneath you.
    await expect(cardButton(page, /Weekly review/)).toBeVisible();

    await searchBox(page).fill("a");
    await expect(page).toHaveURL(/#\/search\?q=a$/);
    // The depth after ARRIVING. Everything that follows is a knob turn.
    const depth = await page.evaluate(() => history.length);

    await searchBox(page).fill("au");
    await searchBox(page).fill("aur");
    await searchBox(page).fill("aurora");
    await expect(page).toHaveURL(/#\/search\?q=aurora$/);
    // Four more keystrokes, no more history. A build that pushed per keystroke
    // makes Back spell the query backwards one letter at a time.
    expect(await page.evaluate(() => history.length)).toBe(depth);

    // ONE Back leaves the whole search episode and returns to the folder — which
    // search never moved you out of.
    await page.goBack();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
  });

  test("a shared search URL lands on the results, with the box saying what produced them", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/search?q=aurora");

    // The box has to agree with the URL: results above an empty search field are
    // the control lying about what produced them.
    await expect(searchBox(page)).toHaveValue("aurora");
    await expect(cardButton(page, /Project Aurora — kickoff/)).toBeVisible();
    // Results span the library, so the crumb says just "Search" — naming the
    // folder would claim a scope the search does not have, which is also why the
    // route is `#/search` and not `#/folder/:id?q=`.
    await expect(page.locator(".crumbs")).toHaveText("Search");
  });

  test("clearing the box returns to the folder without leaving a second entry behind", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Note").click();
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
    const depth = await page.evaluate(() => history.length);

    await searchBox(page).fill("aurora");
    await expect(page).toHaveURL(/#\/search\?q=aurora$/);
    await searchBox(page).fill("");

    // Back where it started, and one search episode cost exactly one entry —
    // the one Back now steps off.
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(depth + 1);
  });
});

// --- THE TWO EXCEPTIONS ------------------------------------------------------

test.describe("what is deliberately NOT in the URL", () => {
  test("sort and view mode are preferences, not places", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Note").click();
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
    const depth = await page.evaluate(() => history.length);

    await page.getByRole("combobox", { name: "Sort notes" }).selectOption("title");
    await page.getByRole("button", { name: "List view" }).click();

    // A URL carrying them means sharing a link imposes your view on whoever
    // opens it. Sort is pinned in localStorage precisely so it follows the
    // PERSON rather than the link.
    await expect(page).toHaveURL(/#\/folder\/note$/);
    expect(await page.evaluate(() => history.length)).toBe(depth);
  });
});

// --- THE PAGE NUMBER IN THE URL IS THE ONE ON SCREEN -------------------------
//
// A URL is user-facing text and humans number pages from one, so `/page/5` is the
// fifth page — while the reader, the filmstrip and the lazy engine all index from
// zero and stay that way. Asserted from OUTSIDE the router on both sides (a
// literal URL against a rendered pager) because a test that round-tripped through
// the app's own helpers would pass whether or not the offset was ever applied.

test.describe("page numbers in the URL count from one", () => {
  test("the address bar agrees with the pager, in both directions", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-doc-attn");

    // Internal index 4 → `/page/5`, and the pager independently says "5 / 20".
    await page.getByRole("button", { name: "Page 5" }).click();
    await expect(page.locator(".pager__count")).toHaveText("5 / 20");
    await expect(page).toHaveURL(/#\/note\/n-doc-attn\/page\/5$/);

    // And back the other way, on a cold load.
    await page.goto("/#/note/n-doc-attn/page/5");
    await expect(page.locator(".pager__count")).toHaveText("5 / 20");
  });

  test("the first page has one URL, and `page/1` is accepted as the same place", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-doc-attn/page/5");
    await expect(page.locator(".pager__count")).toHaveText("5 / 20");

    // Returning to the start collapses to the bare path rather than emitting a
    // second spelling of it.
    await page.getByRole("button", { name: "Page 1", exact: true }).click();
    await expect(page).toHaveURL(/#\/note\/n-doc-attn$/);

    // …but a hand-typed or shared `page/1` still lands there.
    await page.goto("/#/note/n-doc-attn/page/1");
    await expect(page.locator(".pager__count")).toHaveText("1 / 20");
  });

  test("a hand-edited page number lands somewhere sensible instead of erroring", async ({ page }) => {
    await signedIn(page);
    // `page/0` means nothing once the URL counts from one. It is clamped to the
    // start of THIS note — not 404'd, and not bounced to the library, which
    // would make a mistyped page number look like a broken link.
    await page.goto("/#/note/n-doc-attn/page/0");
    await expect(reader(page)).toBeVisible();
    await expect(page.locator(".pager__count")).toHaveText("1 / 20");

    // Past the end is clamped by the READER, which is the only thing that knows
    // how long the note is.
    await page.goto("/#/note/n-doc-attn/page/900");
    await expect(page.locator(".pager__count")).toHaveText("20 / 20");
  });

  test("a search hit deep-links to the page its excerpt is on, numbered the same way", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    // "Endor" is on the ODD pages only, so the best-ranked page is not the first
    // — "the link carries a page" is a real claim here.
    await railSettled(page); // the name half of a search reads the cached tree
    await searchBox(page).fill("Endor");
    const row = page.locator(".card--result").filter({ hasText: "Project Aurora — kickoff" });
    await row.locator(".card__open").click();

    await expect(page.locator(".pager__count")).toHaveText("2 / 6");
    // The href builder the result rows use is the SAME one the reader writes
    // with, so the conversion cannot be applied in one and missed in the other.
    await expect(page).toHaveURL(/#\/note\/n-proj-alpha\/page\/2\?q=Endor$/);
  });
});

// --- PAGING IS AN ADJUSTMENT, NOT A PLACE ------------------------------------

test.describe("Back out of a note goes where you came from", () => {
  test("however far you paged, and to the folder you entered from", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Document").click();
    await expect(page).toHaveURL(/#\/folder\/document$/);

    await cardButton(page, /Attention Is All You Need/).click();
    await expect(reader(page)).toBeVisible();

    await page.getByRole("button", { name: "Page 9" }).click();
    await expect(page.locator(".pager__count")).toHaveText("9 / 20");
    await expect(page).toHaveURL(/#\/note\/n-doc-attn\/page\/9$/);

    // ONE Back, and it lands in the FOLDER — not on page 8, and not at the
    // library root the reader used to be sent to unconditionally.
    await page.goBack();
    await expect(reader(page)).toBeHidden();
    await expect(page).toHaveURL(/#\/folder\/document$/);
    await expect(cardButton(page, /Attention Is All You Need/)).toBeVisible();
  });
});
