import { test, expect, type Page } from "@playwright/test";
import { mockApi, type Scenario } from "./helpers/mockApi";
import { signedIn, mockRawFiles } from "./helpers/app";
import { recordText } from "./helpers/recordText";
// The real layered SNPG payload; its layer descriptors pair with the records by slot.
import { layeredPageLayers, layeredPagePayload } from "../../src/api/layeredFixture";

// What is on screen while a request is in flight: loading and known-empty are different
// states. Uses `?real` with a mocked control plane, the only way to hold a response.
// Use `recordText` for "must never have said X"; retrying matchers cannot catch it.
import { ME, note } from "./slowLink.shared";

const folder = (id: string, name: string, itemCount: number) => ({ kind: "folder", id, name, itemCount });

const galleryEmpty = (page: Page) => page.locator("#gallery .empty");

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAwMTAwMAAAA8EAQFa0S3fAAAAAElFTkSuQmCC";

test.describe("what is painted while a listing is in flight", () => {
  // Regression: the cache-miss branch of `navigate` painted nothing on a cold boot.
  test("a cold boot says Loading… while the root listing is held", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: ME },
      "controlplane/tree": {
        delayMs: 3000,
        json: { folderId: null, path: [], entries: [folder("arch", "Archive", 1)], syncVersion: 1 },
      },
    });
    await page.goto("/?real");

    await expect(galleryEmpty(page).locator("h3")).toHaveText("Loading…");
    await expect(galleryEmpty(page)).toContainText("Fetching your notebooks");
  });

  // Regression: folder A stayed on screen through folder B's fetch.
  test("folder A does not stay on screen through folder B's fetch", async ({ page }) => {
    await mockApi(page, {
      "controlplane/tree?parent=arch": {
        delayMs: 3000,
        json: { folderId: "arch", path: [folder("arch", "Archive", 1)], entries: [note("n-arch", "Coastline")], syncVersion: 1 },
      },
      "controlplane/tree": {
        json: {
          folderId: null,
          path: [],
          entries: [folder("arch", "Archive", 1), note("n-root", "Root readme")],
          syncVersion: 1,
        },
      },
      "user/me": { json: ME },
    });
    await page.goto("/?real");
    await expect(page.locator("#gallery")).toContainText("Root readme");

    await page.locator(".card__open", { hasText: "Archive" }).click();

    await expect(galleryEmpty(page).locator("h3")).toHaveText("Loading…");
    await expect(page.locator("#gallery")).not.toContainText("Root readme");
  });

  // `LOADING_PAINT_DELAY_MS` (150 ms) keeps fast navigations from flickering.
  test("a fast listing paints no loading state at all", async ({ page }) => {
    const gallery = await recordText(page, "#gallery");
    await mockApi(page, {
      "controlplane/tree?parent=arch": {
        json: { folderId: "arch", path: [folder("arch", "Archive", 1)], entries: [note("n-arch", "Coastline")], syncVersion: 1 },
      },
      "controlplane/tree": {
        json: {
          folderId: null,
          path: [],
          entries: [folder("arch", "Archive", 1), note("n-root", "Root readme")],
          syncVersion: 1,
        },
      },
      "user/me": { json: ME },
    });
    await page.goto("/?real");
    await expect(page.locator("#gallery")).toContainText("Root readme");

    await page.locator(".card__open", { hasText: "Archive" }).click();
    await expect(page.locator("#gallery")).toContainText("Coastline");

    expect(await gallery.everShowed("Loading…")).toBe(false);
  });

  // Regression: the failure path replaced the gallery around the destination guard.
  test("a folder error that lands after the user opened the bin is dropped", async ({ page }) => {
    await mockApi(page, {
      "controlplane/tree?parent=arch": { delayMs: 1200, status: 500, json: { success: false } },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [folder("arch", "Archive", 1)], syncVersion: 1 },
      },
      "controlplane/bin": { json: { entries: [], totalBytes: 0, retentionDays: 30, syncVersion: 1 } },
      "user/me": { json: ME },
    });
    await page.goto("/?real");
    await page.locator(".card__open", { hasText: "Archive" }).click();

    await page.getByRole("navigation", { name: "Library" }).getByText("Recycle bin").click();
    await expect(page.locator(".crumbs__here")).toHaveText("Recycle bin");

    await page.waitForTimeout(2000);
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".crumbs__here")).toHaveText("Recycle bin");
    await expect(page.locator("#gallery")).not.toContainText("Couldn't load");
    await expect(page).toHaveURL(/#\/bin$/);
  });
});

// ---- the tree walk, and what waits on it ----
// `prefetchTree` is a sequential BFS, so a deep link can land mid-walk.
test.describe("a folder deep link that beats the tree walk", () => {
  const NOTE_KIDS = [folder("f-note", "Note", 1), folder("f-style", "MyStyle", 0)];

  /**
   * The root listing resolves every category anchor, so holding it puts the deep link
   * ahead of the walk. Contents never depend on the walk, only names do.
   */
  async function heldRoot(page: Page, ms: number): Promise<void> {
    await mockApi(page, {
      "controlplane/tree?parent=export": {
        json: {
          folderId: "export",
          path: [folder("export", "EXPORT", 1)],
          entries: [note("n-e", "Trail export")],
          syncVersion: 1,
        },
      },
      "controlplane/tree?parent=dir-note": {
        json: { folderId: "dir-note", path: [folder("dir-note", "NOTE", 2)], entries: NOTE_KIDS, syncVersion: 1 },
      },
      "controlplane/tree?parent=f-note": {
        json: { folderId: "f-note", path: [], entries: [], syncVersion: 1 },
      },
      "controlplane/tree?parent=f-style": {
        json: { folderId: "f-style", path: [], entries: [], syncVersion: 1 },
      },
      "controlplane/tree": {
        delayMs: ms,
        json: {
          folderId: null,
          path: [],
          entries: [folder("dir-note", "NOTE", 2), folder("export", "EXPORT", 1)],
          syncVersion: 1,
        },
      },
      "user/me": { json: ME },
    });
  }

  // Regression: `settle()` did not rebuild crumbs for a deep link resolved before the walk.
  test("the breadcrumb stops saying EXPORT once the walk resolves the category", async ({ page }) => {
    await heldRoot(page, 2500);
    await page.goto("/?real#/folder/export");
    await expect(page.locator("#gallery")).toContainText("Trail export");

    // Read once, inside the window.
    expect(await page.locator(".crumbs__here").textContent()).toBe("EXPORT");

    await expect(page.locator(".crumbs__here")).toHaveText("Export");
  });

  // A category anchor is a different tile, so the settle replaces cards rather than text.
  test("a deep-linked container's children settle into category tiles", async ({ page }) => {
    await heldRoot(page, 2500);
    await page.goto("/?real#/folder/dir-note");
    await expect(page.locator("#gallery")).toContainText("MyStyle");

    const mid = await page.evaluate(() => ({
      folders: document.querySelectorAll("#gallery .card--folder").length,
      categories: document.querySelectorAll("#gallery .card--category").length,
    }));
    expect(mid.folders).toBe(2);
    expect(mid.categories).toBe(0);

    await expect(page.locator("#gallery .card--category")).toHaveCount(2);
    await expect(page.locator("#gallery .card--folder")).toHaveCount(2);
  });

});

test.describe("a search inside a subfolder, while the tree walk is outstanding", () => {
  /** `Archive` is held while `Projects` resolves, so the user can type mid-walk. */
  async function heldBranch(page: Page, opts: { archiveDelayMs: number }): Promise<void> {
    const scenario: Scenario = {
      "controlplane/tree?parent=arch": {
        delayMs: opts.archiveDelayMs,
        json: {
          folderId: "arch",
          path: [folder("arch", "Archive", 1)],
          entries: [note("n-zebra", "Zebra migration notes")],
          syncVersion: 1,
        },
      },
      "controlplane/tree?parent=proj": {
        json: {
          folderId: "proj",
          path: [folder("proj", "Projects", 1)],
          entries: [note("n-proj", "Sprint plan")],
          syncVersion: 1,
        },
      },
      "controlplane/tree": {
        json: {
          folderId: null,
          path: [],
          entries: [folder("arch", "Archive", 1), folder("proj", "Projects", 1)],
          syncVersion: 1,
        },
      },
      // No search route: the empty in-browser index answers in the keystroke's task, so only
      // `gallerySearch`'s `!ctx.treeLoaded()` clause stops "No matches".
      "user/me": { json: ME },
    };
    await mockApi(page, scenario);
  }

  // Regression: "No matches" was painted before the name half had a complete tree, and
  // never corrected inside a subfolder.
  test("says Searching…, never No matches, while the walk is still running", async ({ page }) => {
    // Recorded: the empty answer lands in the same task as the keystroke.
    const gallery = await recordText(page, "#gallery");
    await heldBranch(page, { archiveDelayMs: 4000 });
    await page.goto("/?real#/folder/proj");
    await expect(page.locator("#gallery")).toContainText("Sprint plan");

    await page.getByRole("searchbox", { name: "Search notes" }).fill("Zebra");

    await expect(page.getByRole("group", { name: "Folders" })).toHaveAttribute("aria-busy", "true");
    await expect(galleryEmpty(page).locator("h3")).toHaveText("Searching…");
    expect(await gallery.everShowed("No matches")).toBe(false);
    expect(await gallery.everShowed("Searching…")).toBe(true);
  });

  // Regression: `rail.settle()` repainted only at the root, so a subfolder query stayed stale.
  test("the held folder's name match appears when the walk lands", async ({ page }) => {
    await heldBranch(page, { archiveDelayMs: 1500 });
    await page.goto("/?real#/folder/proj");
    await expect(page.locator("#gallery")).toContainText("Sprint plan");

    await page.getByRole("searchbox", { name: "Search notes" }).fill("Zebra");

    await expect(page.locator("#gallery")).toContainText("Zebra migration notes");
  });
});

// The superseded-request abort test lives with the reader's find, the only search that fetches.

test.describe("the recycle bin's actions while one is in flight", () => {
  const trashed = {
    kind: "note",
    id: "b-1",
    name: "Coastline sketch",
    path: "/Note",
    deletedAt: 1_700_000_000_000,
    size: 2048,
    parentId: null,
    isRoot: true,
    fileType: "note",
    fileHash: null,
    firstPage: null,
  };

  async function binWith(page: Page, extra: Scenario): Promise<void> {
    await mockApi(page, {
      ...extra,
      "controlplane/tree": { json: { folderId: null, path: [], entries: [], syncVersion: 1 } },
      "controlplane/bin": { json: { entries: [trashed], totalBytes: 2048, retentionDays: 30, syncVersion: 1 } },
      "user/me": { json: ME },
    });
  }

  /** Located structurally: the trigger's name changes with the busy state. */
  const rowMenu = (page: Page) => page.locator(".bin__row .bin__actions .card__more");

  // Regression: with no busy state a slow restore invited a second click, which then
  // reported failure for an operation that had succeeded.
  test("a row's actions go inert and visibly busy while its restore travels", async ({ page }) => {
    await binWith(page, {
      "bin/b-1/restore": { delayMs: 2000, json: { name: "Coastline sketch", renamed: false } },
    });
    let restoreCalls = 0;
    page.on("request", (r) => {
      if (r.url().includes("bin/b-1/restore")) restoreCalls++;
    });
    await page.goto("/?real#/bin");

    const row = page.locator(".bin__row", { hasText: "Coastline sketch" });
    await expect(row).toBeVisible();
    await rowMenu(page).click();
    // The open popover is portaled to `.menu-portal`.
    await page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" }).click();

    await expect(row).toHaveAttribute("aria-busy", "true");
    await expect(row).toHaveClass(/is-busy/);
    await expect(rowMenu(page)).toBeDisabled();

    await expect(page.locator(".bin-toast")).toContainText("Restored", { timeout: 10_000 });
    await expect(page.locator(".bin-toast")).not.toContainText("Couldn’t restore");
    expect(restoreCalls).toBe(1);
  });

  // `DELETE` and `GET controlplane/bin` share a URL, hence the verb-prefixed key.
  test("Empty bin disables itself while its own call travels", async ({ page }) => {
    await binWith(page, {
      "DELETE controlplane/bin": { delayMs: 2500, json: { entries: 1 } },
    });
    await page.goto("/?real#/bin");

    const emptyBin = page.locator("#empty-bin");
    await expect(emptyBin).toBeEnabled();
    await emptyBin.click();
    await page.locator("dialog.confirm .is-danger").click();

    await expect(emptyBin).toBeDisabled();
  });
});

test.describe("the recycle bin's own listing, retried", () => {
  // Regression: a failed listing's "Couldn't load" stayed up through the retry.
  test("opening the bin after a failed listing says Loading…, not Couldn’t load", async ({ page }) => {
    const gallery = await recordText(page, "#gallery");
    await mockApi(page, {
      "controlplane/tree": { json: { folderId: null, path: [], entries: [], syncVersion: 1 } },
      "user/me": { json: ME },
    });
    // Registered after `mockApi` so it wins. The boot listing fails and the retry is held.
    let calls = 0;
    await page.route(
      (url) => url.pathname === "/api/controlplane/bin",
      async (route) => {
        calls++;
        if (calls === 1) {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false }) });
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entries: [], totalBytes: 0, retentionDays: 30, syncVersion: 1 }),
        });
      },
    );

    await page.goto("/?real");
    await page.waitForResponse((r) => r.url().includes("/api/controlplane/bin"));

    await page.getByRole("navigation", { name: "Library" }).getByText("Recycle bin").click();

    await expect(galleryEmpty(page).locator("h3")).toHaveText("Loading…");
    // Recorded: the stale failure was replaced when the held listing landed.
    expect(await gallery.everShowed("Couldn’t load the bin")).toBe(false);

    await expect(galleryEmpty(page).locator("h3")).toHaveText("Nothing deleted", { timeout: 10_000 });
  });
});

test.describe("the admin console's chunk-import window", () => {
  // Regression: `import("./admin")` painted nothing for a round trip, leaving a folder listing up.
  test("paints the console's loading state, never a folder listing nobody asked for", async ({ page }) => {
    await mockApi(page, {
      "controlplane/bin": { json: { entries: [], totalBytes: 0, retentionDays: 30, syncVersion: 1 } },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [note("n-root", "Root readme")], syncVersion: 1 },
      },
      // 428 is what a cold console meets; the bland fallback 200 would read as elevation.
      "admin/users": { status: 428, json: { success: false } },
      "user/me": { json: { ...ME, isAdmin: true } },
    });
    // Hold the chunk: under the dev server the console module is an ordinary request.
    const isChunk = (u: string) => new URL(u).pathname.endsWith("/src/pages/admin/admin.ts");
    await page.route(
      (url) => url.pathname.endsWith("/src/pages/admin/admin.ts"),
      async (route) => {
        await new Promise((r) => setTimeout(r, 4000));
        await route.continue();
      },
    );

    await page.goto("/?real#/bin");
    await expect(page.locator(".bin")).toBeVisible();

    // Await the request: a flag set in the route handler lags the browser by a round trip.
    const chunk = page.waitForRequest((r) => isChunk(r.url()));
    await page.locator(".nav__item", { hasText: "Admin" }).click();
    await chunk;

    // Read once, inside the window.
    const s = await page.evaluate(() => ({
      galleryHidden: (document.querySelector("#gallery") as HTMLElement).hidden,
      crumb: document.querySelector(".crumbs__here")?.textContent ?? "",
      standIn: document.querySelector(".admin-booting")?.textContent ?? "",
      destinationMode: document.querySelector(".sn-root")?.classList.contains("is-destination") ?? false,
      console_: document.querySelector(".admin") !== null,
    }));

    expect(s.galleryHidden).toBe(true);
    expect(s.console_).toBe(false);
    expect(s.standIn).toContain("Opening the admin console");
    expect(s.crumb).toBe("Admin");
    expect(s.destinationMode).toBe(true);

    await expect(page.locator(".admin-gate")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".admin-booting")).toBeHidden();
  });
});

test.describe("the reader's image stage", () => {
  // Regression: `fileImg.src = url` without clearing kept image A painted during B's download.
  test("opening a second image never shows the first one's picture", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    // Registered after `mockRawFiles` so it wins; real bytes, so `onerror` cannot end the window early.
    await page.route(
      (url) => url.pathname === "/file/152",
      async (route) => {
        await new Promise((r) => setTimeout(r, 10_000));
        await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(TINY_PNG_BASE64, "base64") });
      },
    );

    await page.goto("/#/note/151");
    const img = page.locator(".filestage__img");
    await expect.poll(async () => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
    const first = await img.getAttribute("src");
    expect(first).toContain("151");

    await page.evaluate(() => {
      window.location.hash = "#/note/152";
    });
    // The title moves in the same synchronous block that swaps the stage.
    await expect(page.locator(".reader__title")).toContainText("trailhead map");

    // Read once: a retrying assertion would record the settled state.
    const stage = await page.evaluate(() => {
      const i = document.querySelector(".filestage__img") as HTMLImageElement;
      const body = document.querySelector(".filestage__empty");
      return { src: i.getAttribute("src"), painted: i.getBoundingClientRect().width > 0, body: body?.textContent ?? "" };
    });

    expect(stage.painted).toBe(false);
    expect(stage.src).not.toBe(first);
    expect(stage.body).toContain("Loading this picture…");
    expect(stage.body).toContain("trailhead map");
  });
});

// ---- the reader's note stage, with the link held ----
// Serves the committed layered fixture, so the real `note-decode.wasm` decodes it.
