import { test, expect, type Page } from "@playwright/test";
import { mockApi, type Scenario } from "./helpers/mockApi";
import { signedIn, mockRawFiles } from "./helpers/app";

// WHAT IS ON SCREEN WHILE A REQUEST IS STILL IN FLIGHT.
//
// Every case here is a state that is invisible on localhost and obvious on a
// throttled link (docs/scratch/ui-on-slow-connection.md, found under 20× CPU +
// Slow 3G). They share one rule: LOADING and KNOWN-EMPTY are different states,
// and the empty or negative one must not be claimed until the data that could
// disprove it has arrived.
//
// They are driven through REAL mode (`?real`) with a mocked control plane,
// because that is the only way to HOLD a response: the library and reader
// otherwise run against the in-memory fake `Api`, whose latency is fixed. A held
// response is what turns "the loading state exists" into "the loading state is
// what the user actually sees, for the whole round trip".

const ME = { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false };

const folder = (id: string, name: string, itemCount: number) => ({ kind: "folder", id, name, itemCount });

/** A note entry as the control plane serves it in a listing. */
function note(id: string, name: string) {
  return {
    kind: "note",
    id,
    name,
    pageCount: 1,
    fileType: "note",
    fileHash: "0".repeat(32),
    updatedAt: 1_700_000_000_000,
    hasRecognizedText: false,
    firstPage: { index: 0, hash: "1".repeat(32), width: 1404, height: 1872, textHash: null },
  };
}

const galleryEmpty = (page: Page) => page.locator("#gallery .empty");

/** A 2×2 PNG — real bytes, so the browser genuinely decodes what it is served. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAwMTAwMAAAA8EAQFa0S3fAAAAAElFTkSuQmCC";

test.describe("what is painted while a listing is in flight", () => {
  // 1.4/1.5 — the cache-miss branch of `navigate` used to paint NOTHING: on a
  // cold boot the shell mounted with an empty gallery for a whole round trip,
  // and folder A stayed fully on screen through folder B's fetch. The state to
  // paint already existed (`renderGallery`'s `!listing` branch); it was simply
  // unreachable on the primary path.
  test("a cold boot says Loading… while the root listing is held", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: ME },
      "controlplane/tree": {
        delayMs: 3000,
        json: { folderId: null, path: [], entries: [folder("arch", "Archive", 1)], syncVersion: 1 },
      },
    });
    await page.goto("/?real");

    // Not a blank shell, and not a failure: the app says what it is doing.
    await expect(galleryEmpty(page).locator("h3")).toHaveText("Loading…");
    await expect(galleryEmpty(page)).toContainText("Fetching your notebooks");
  });

  // The other half of 1.5: the folder you came FROM must not still be on screen
  // under the new folder's chrome. `listing` is dropped on the cache miss, so
  // the delayed paint has nothing stale to fall back to.
  test("folder A does not stay on screen through folder B's fetch", async ({ page }) => {
    await mockApi(page, {
      "controlplane/tree?parent=arch": {
        // Held: everything asserted below happens inside this window.
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

    // The loading state, and — the actual regression — NOT the previous folder's
    // contents sitting under a breadcrumb that has already moved on.
    await expect(galleryEmpty(page).locator("h3")).toHaveText("Loading…");
    await expect(page.locator("#gallery")).not.toContainText("Root readme");
  });

  // THE MITIGATION, and it is half of the fix: a loading state that paints
  // instantly turns every warm navigation into a flicker between two good
  // paints. `LOADING_PAINT_DELAY_MS` (150 ms) is what buys the fast case out of
  // it — the response wins the race and no loading state is ever painted.
  //
  // Asserted with a MutationObserver rather than by polling, because the thing
  // under test is a state that must never EXIST, not one that must not be there
  // at the end: a `toHaveCount(0)` after the fact passes happily against a flash
  // that came and went.
  test("a fast listing paints no loading state at all", async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __loadingPaints?: number }).__loadingPaints = 0;
      new MutationObserver(() => {
        const g = document.querySelector("#gallery");
        if (g?.textContent?.includes("Loading…")) {
          const w = window as Window & { __loadingPaints?: number };
          w.__loadingPaints = (w.__loadingPaints ?? 0) + 1;
        }
      }).observe(document, { childList: true, subtree: true });
    });
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

    // Neither the cold boot nor the navigation flashed it.
    expect(await page.evaluate(() => (window as Window & { __loadingPaints?: number }).__loadingPaints)).toBe(0);
  });

  // 1.3 — the failure path used to `replaceChildren` the gallery element
  // DIRECTLY, around the destination guard the success path respects. Click a
  // slow folder, give up, open the recycle bin, and the folder's failure landing
  // minutes later replaced the bin with "Couldn't load" — while the URL, the
  // rail highlight and the `Empty bin` button all still said Recycle bin.
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

    // Give up on it and go to the bin, well before the failure lands.
    await page.getByRole("navigation", { name: "Folders" }).getByText("Recycle bin").click();
    await expect(page.locator(".crumbs__here")).toHaveText("Recycle bin");

    // Outlast the held failure, then check the bin is still the thing on screen.
    await page.waitForTimeout(2000);
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".crumbs__here")).toHaveText("Recycle bin");
    await expect(page.locator("#gallery")).not.toContainText("Couldn't load");
    await expect(page).toHaveURL(/#\/bin$/);
  });
});

test.describe("a search inside a subfolder, while the tree walk is outstanding", () => {
  /**
   * A tree whose `Archive` listing is HELD. `Projects` resolves instantly, so
   * the user can stand in it and type while the walk is still running — which is
   * the exact window 1.1 lived in.
   */
  async function heldBranch(page: Page, opts: { archiveDelayMs: number }): Promise<void> {
    const scenario: Scenario = {
      "controlplane/tree?parent=arch": {
        delayMs: opts.archiveDelayMs,
        json: {
          folderId: "arch",
          path: [folder("arch", "Archive", 1)],
          // The name match the query is looking for, in the folder that has not
          // been walked yet. It CANNOT be found until this response lands.
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
      // The transcript half answers at once, and answers NOTHING. That is what
      // used to settle the question prematurely.
      "controlplane/search": { json: { query: "Zebra", hits: [], usedFuzzy: false, coverage: null } },
      "user/me": { json: ME },
    };
    await mockApi(page, scenario);
  }

  // 1.1 — the permanent lie. The name half of a library-wide query is matched
  // against the cached tree that `prefetchTree` fills one folder at a time, so a
  // transcript response with no hits routinely arrives BEFORE the name half can
  // have been computed against a complete library. "No matches" painted then is
  // a claim about notes the app has not looked at yet — and inside a subfolder
  // it never self-corrected, because the repaint was gated on `folderId === null`.
  test("says Searching…, never No matches, while the walk is still running", async ({ page }) => {
    await heldBranch(page, { archiveDelayMs: 4000 });
    await page.goto("/?real#/folder/proj");
    await expect(page.locator("#gallery")).toContainText("Sprint plan");

    await page.getByRole("searchbox", { name: "Search notes" }).fill("Zebra");
    // Wait for the transcript half to have ANSWERED — otherwise "Searching…"
    // would be true for the trivial reason that nothing had come back yet.
    await page.waitForResponse((r) => r.url().includes("controlplane/search"));

    // The walk has not landed…
    await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "true");
    // …so the negative is not claimed.
    await expect(galleryEmpty(page).locator("h3")).toHaveText("Searching…");
    await expect(page.locator("#gallery")).not.toContainText("No matches");
  });

  // The other half: the claim has to RESOLVE. `rail.settle()` only repainted at
  // the root, and search deliberately does not move `folderId` — so a query
  // typed in a subfolder sat on its stale answer until the next keystroke, with
  // a real name match hidden behind it.
  test("the held folder's name match appears when the walk lands", async ({ page }) => {
    await heldBranch(page, { archiveDelayMs: 1500 });
    await page.goto("/?real#/folder/proj");
    await expect(page.locator("#gallery")).toContainText("Sprint plan");

    await page.getByRole("searchbox", { name: "Search notes" }).fill("Zebra");

    // No further keystroke, no navigation — the walk finishing is the only event.
    await expect(page.locator("#gallery")).toContainText("Zebra migration notes");
  });
});

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

  /** The row's ⋯ TRIGGER (not its items) — its accessible name changes with the
   *  busy state, so it is located structurally. */
  const rowMenu = (page: Page) => page.locator(".bin__row .bin__actions .card__more");

  // 1.2 — no optimistic paint, no disabled state, no in-flight sentinel. On a
  // slow link nothing at all happened when Restore was chosen, so the click read
  // as missed and was made again; the second call reached a server that had
  // already restored the entry, found nothing, and the bin reported "Couldn't
  // restore X. Try again." for an operation that had SUCCEEDED.
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
    // The open popover is PORTALED to `.menu-portal` at the body root.
    await page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" }).click();

    // The click that was made is now visible, and there is nothing to re-click:
    // the row recedes, says so to a screen reader, and its ⋯ is inert.
    await expect(row).toHaveAttribute("aria-busy", "true");
    await expect(row).toHaveClass(/is-busy/);
    await expect(rowMenu(page)).toBeDisabled();

    // ONE call, and it reports the truth. The second click a slow link used to
    // invite reached a server that had already restored the entry, found nothing
    // to restore, and made the bin apologise for an operation that succeeded.
    await expect(page.locator(".bin-toast")).toContainText("Restored", { timeout: 10_000 });
    await expect(page.locator(".bin-toast")).not.toContainText("Couldn’t restore");
    expect(restoreCalls).toBe(1);
  });

  // The topbar's `Empty bin` had the same hole, with its `disabled` set only from
  // the row count. `DELETE controlplane/bin` and `GET controlplane/bin` are the
  // same URL, hence the verb-prefixed scenario key.
  test("Empty bin disables itself while its own call travels", async ({ page }) => {
    await binWith(page, {
      "DELETE controlplane/bin": { delayMs: 2500, json: { entries: 1 } },
    });
    await page.goto("/?real#/bin");

    const emptyBin = page.locator("#empty-bin");
    await expect(emptyBin).toBeEnabled();
    await emptyBin.click();
    // The confirm travels with the control — accept it.
    await page.locator("dialog.confirm .is-danger").click();

    await expect(emptyBin).toBeDisabled();
  });
});

test.describe("the reader's image stage", () => {
  // 1.7 — `fileImg.src = url` without clearing first leaves the browser painting
  // the PREVIOUS file's decoded image for the whole download, so opening image B
  // from image A showed A's picture under B's title and B's download link.
  test("opening a second image never shows the first one's picture", async ({ page }) => {
    await signedIn(page);
    await mockRawFiles(page);
    // Registered AFTER `mockRawFiles`, so this narrower route wins (Playwright
    // matches newest-first) and holds ONLY the second image. Held long enough
    // that the whole assertion below runs inside the window, and answered with
    // REAL bytes when it finally lands — a broken response would end the window
    // early via the `onerror` fallback, and the state under test would never be
    // the one measured.
    await page.route(
      (url) => url.pathname === "/file/n-shot-map",
      async (route) => {
        await new Promise((r) => setTimeout(r, 10_000));
        await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(TINY_PNG_BASE64, "base64") });
      },
    );

    await page.goto("/#/note/n-shot-pricing");
    const img = page.locator(".filestage__img");
    await expect.poll(async () => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
    const first = await img.getAttribute("src");
    expect(first).toContain("n-shot-pricing");

    // Straight to the second image, whose bytes are held.
    await page.evaluate(() => {
      window.location.hash = "#/note/n-shot-map";
    });
    // The title moves in the SAME synchronous block that swaps the stage, so
    // once it reads the second file the stage is already in its in-flight state.
    await expect(page.locator(".reader__title")).toContainText("trailhead map");

    // Read ONCE, deliberately — a retrying assertion here would keep polling
    // until the hold expired and record the settled state instead of the one
    // the user spends the whole download looking at.
    const stage = await page.evaluate(() => {
      const i = document.querySelector(".filestage__img") as HTMLImageElement;
      const body = document.querySelector(".filestage__empty");
      return { src: i.getAttribute("src"), painted: i.getBoundingClientRect().width > 0, body: body?.textContent ?? "" };
    });

    // NOT the previous file's picture — the element paints nothing at all,
    // where it used to keep image A on screen for the whole of B's download.
    expect(stage.painted).toBe(false);
    expect(stage.src).not.toBe(first);
    // And in its place, a real loading state rather than a blank rectangle.
    expect(stage.body).toContain("Loading this picture…");
    expect(stage.body).toContain("trailhead map");
  });
});
