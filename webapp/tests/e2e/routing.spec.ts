import { test, expect, type Locator, type Page } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";
import { signedIn, cardButton, railSettled } from "./helpers/app";
import { mockDocText, noteTextRecord } from "./helpers/docText";
import { mockSearchIndex, noteTermsDocument } from "./helpers/searchIndex";
import { fakeFileHash } from "../../src/api/fake";

// Each place is proved three ways: reload lands there, Back/Forward step through
// places, and a stale link degrades honestly. Navigations push and adjustments
// replace, asserted as `history.length` not growing.

/** A rail anchor/subfolder/destination located by its exact visible name. */
function navItem(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Library" })
    .locator(".nav__item", { has: page.locator(".nav__name", { hasText: new RegExp(`^${name}$`) }) });
}

function reader(page: Page): Locator {
  return page.getByRole("region", { name: "Reader" });
}

/** The row the rail is currently marking as where you are. */
function currentNavItem(page: Page): Locator {
  return page.getByRole("navigation", { name: "Library" }).locator('.nav__item[aria-current="page"]');
}

const searchBox = (page: Page) => page.getByRole("searchbox", { name: "Search notes" });

// --- 1. which folder you are in ---

test.describe("a folder is a place", () => {
  test("opening one from the rail puts it in the URL, and a reload lands back in it", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    await navItem(page, "Note").click();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
    await railSettled(page);
    await expect(currentNavItem(page)).toHaveText(/^Note/);
  });

  test("a subfolder is reachable by link alone, with the breadcrumb it would have had", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/projects");

    await expect(cardButton(page, /Project Aurora — kickoff/)).toBeVisible();
    await expect(page.locator(".crumbs")).toContainText("Projects");
    // The rail highlight is provisional until the tree walk lands.
    await railSettled(page);
    await expect(currentNavItem(page)).toHaveText(/^Projects/);
  });

  // Regression: the listing's repaint skips an open bin (so a restore can't close
  // it), and nothing else closed it, so a folder not yet loaded never showed.
  test("leaving the bin for a folder not yet loaded shows the folder", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/bin");
    await expect(page.locator("main h1")).toHaveText("Recycle bin");
    await page.goto("/#/folder/projects");
    await expect(page.locator("main h1")).toHaveText("Projects");
    await expect(page.locator("#crumbs")).toHaveText("Library/Note/Projects");
    await expect(page.locator("#gallery .card")).toHaveCount(2);
  });

  test("Back and Forward step through folders", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    await navItem(page, "Note").click();
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
    // Through a gallery card, since rail and card must share the same `go()`.
    await cardButton(page, /^Projects/).click();
    await expect(page).toHaveURL(/#\/folder\/projects$/);
    await expect(cardButton(page, /Project Aurora — kickoff/)).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();

    await page.goBack();
    // `page.goto("/")` left no hash, so the root may be spelled bare.
    await expect(page).toHaveURL(/\/(#\/)?$/);
    await expect(page.locator(".card--folder").first()).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
  });

  test("a link to a folder that is gone lands somewhere real and says so", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/deleted-last-tuesday");

    await expect(page.locator(".toast")).toContainText("isn't there any more");
    await expect(page).toHaveURL(/#\/$/);
    await railSettled(page);
    await expect(page.locator(".card--folder").first()).toBeVisible();

    // A redirect: the missing folder must not become a history entry.
    await page.goBack();
    await expect(page).not.toHaveURL(/deleted-last-tuesday/);
  });
});

// --- 2 & 3. destinations ---

test.describe("a destination is a place", () => {
  test("the recycle bin has a URL, survives a reload, and keeps the rail honest", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    await navItem(page, "Recycle bin").click();
    await expect(page).toHaveURL(/#\/bin$/);
    await expect(page.locator(".bin")).toBeVisible();

    await page.reload();
    await expect(page.locator(".bin")).toBeVisible();
    await railSettled(page);
    await expect(currentNavItem(page)).toHaveText(/^Recycle bin/);

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

    // The elevation does not survive a reload; `require_admin` is enforced server-side.
    await page.reload();
    await expect(page).toHaveURL(/#\/admin$/);
    await expect(page.getByRole("button", { name: "Unlock console" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "People" })).toHaveCount(0);
  });

  test("a household member who types the admin URL meets the same gate", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "rui@household.lan", isAdmin: false, mustChangePassword: false } },
    });
    await page.goto("/#/admin");
    await expect(page.getByRole("button", { name: "Unlock console" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "People" })).toHaveCount(0);
  });
});

// --- 4. library-wide search ---

test.describe("a library-wide search is a place", () => {
  test("typing pushes ONCE, refining replaces, and the URL is shareable", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await navItem(page, "Note").click();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    // The route handler clears the search box a task after the click; wait for it first.
    await expect(cardButton(page, /Weekly review/)).toBeVisible();

    await searchBox(page).fill("a");
    await expect(page).toHaveURL(/#\/search\?q=a$/);
    const depth = await page.evaluate(() => history.length);

    await searchBox(page).fill("au");
    await searchBox(page).fill("aur");
    await searchBox(page).fill("aurora");
    await expect(page).toHaveURL(/#\/search\?q=aurora$/);
    expect(await page.evaluate(() => history.length)).toBe(depth);

    await page.goBack();
    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
  });

  test("a shared search URL lands on the results, with the box saying what produced them", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/search?q=aurora");

    await expect(searchBox(page)).toHaveValue("aurora");
    await expect(cardButton(page, /Project Aurora — kickoff/)).toBeVisible();
    // Results span the library, hence `#/search` rather than `#/folder/:id?q=`.
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

    await expect(page).toHaveURL(/#\/folder\/note$/);
    await expect(cardButton(page, /Weekly review/)).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(depth + 1);
  });
});

// --- what is deliberately not in the URL ---

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

    // Sort lives in localStorage so it follows the person, not the link.
    await expect(page).toHaveURL(/#\/folder\/note$/);
    expect(await page.evaluate(() => history.length)).toBe(depth);
  });
});

// --- page numbers in the URL count from one ---
// Asserted from outside the router, so a round-trip through app helpers cannot hide the offset.

test.describe("page numbers in the URL count from one", () => {
  test("the address bar agrees with the pager, in both directions", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");

    await page.getByRole("button", { name: "Page 5" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("5 / 20");
    await expect(page).toHaveURL(/#\/note\/141\/page\/5$/);

    await page.goto("/#/note/141/page/5");
    await expect(page.locator(".pager__count")).toHaveValue("5 / 20");
  });

  test("the first page has one URL, and `page/1` is accepted as the same place", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141/page/5");
    await expect(page.locator(".pager__count")).toHaveValue("5 / 20");

    // By name prefix: an inked row is named "Page 1, written".
    await page.getByRole("button", { name: /^Page 1\b/ }).click();
    await expect(page).toHaveURL(/#\/note\/141$/);

    await page.goto("/#/note/141/page/1");
    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");
  });

  test("a hand-edited page number lands somewhere sensible instead of erroring", async ({ page }) => {
    await signedIn(page);
    // `page/0` clamps to the start of this note rather than 404ing.
    await page.goto("/#/note/141/page/0");
    await expect(reader(page)).toBeVisible();
    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

    // Past the end is clamped by the reader, the only thing that knows the length.
    await page.goto("/#/note/141/page/900");
    await expect(page.locator(".pager__count")).toHaveValue("20 / 20");
  });

  // "Endor" exists only in transcripts, on odd pages; recognised indices skip 2 and 5,
  // so the first hit is index 1, i.e. `/page/2?q=Endor`.
  test("a search hit deep-links to the first page it matched, numbered the same way", async ({ page }) => {
    await signedIn(page);
    await mockSearchIndex(page, {
      rows: [
        {
          md5: fakeFileHash("121"),
          fileId: 121,
          tier: "note",
          updatedAt: 1_700_000_000,
          indexVersion: 1,
          derivation: "derived",
        },
      ],
      documents: {
        [fakeFileHash("121")]: noteTermsDocument(fakeFileHash("121"), "Project Aurora — kickoff", 6),
      },
    });
    // Without it the reader would open onto a red find bar without failing anything.
    await mockDocText(page, { [fakeFileHash("121")]: noteTextRecord("Project Aurora — kickoff", 6) });
    await page.goto("/");
    // "Endor" is on odd pages only, so the link really carries a page.
    await railSettled(page); // the name half of a search reads the cached tree
    await searchBox(page).fill("Endor");
    const row = page.locator(".card--result").filter({ hasText: "Project Aurora — kickoff" });
    await expect(row.locator(".card__matches")).toHaveText("Matches on 2 pages", { timeout: 20_000 });
    await row.locator(".card__open").click();

    await expect(page.locator(".pager__count")).toHaveValue("2 / 6");
    // Result rows and the reader share one href builder.
    await expect(page).toHaveURL(/#\/note\/121\/page\/2\?q=Endor$/);
  });
});

// --- paging is an adjustment, not a place ---

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
    await expect(page.locator(".pager__count")).toHaveValue("9 / 20");
    await expect(page).toHaveURL(/#\/note\/141\/page\/9$/);

    await page.goBack();
    await expect(reader(page)).toBeHidden();
    await expect(page).toHaveURL(/#\/folder\/document$/);
    await expect(cardButton(page, /Attention Is All You Need/)).toBeVisible();
  });
});
