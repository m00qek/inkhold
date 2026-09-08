import { test, expect, type Page } from "@playwright/test";
import { mockApi, type Scenario } from "./helpers/mockApi";
import { signedIn, mockRawFiles } from "./helpers/app";
import { recordText } from "./helpers/recordText";
// The committed layered fixture, imported so the SNPG payload served below is the
// real thing the wasm decoder is written against, and its layer descriptors pair
// with that payload's records by slot — see src/api/layeredFixture.ts.
import { layeredPageLayers, layeredPagePayload } from "../../src/api/layeredFixture";

// WHAT IS ON SCREEN WHILE A REQUEST IS STILL IN FLIGHT.
//
// Every case here is a state that is invisible on localhost and obvious on a
// throttled link (found under 20× CPU +
// Slow 3G). They share one rule: LOADING and KNOWN-EMPTY are different states,
// and the empty or negative one must not be claimed until the data that could
// disprove it has arrived.
//
// They are driven through REAL mode (`?real`) with a mocked control plane,
// because that is the only way to HOLD a response: the library and reader
// otherwise run against the in-memory fake `Api`, whose latency is fixed. A held
// response is what turns "the loading state exists" into "the loading state is
// what the user actually sees, for the whole round trip".
//
// ── DOES THIS TEST HAVE TEETH? ───────────────────────────────────────────────
//
// Every test below was verified by REVERTING ITS FIX and confirming it fails.
// That step is not diligence here, it is the only real validation: three tests
// in this file passed against genuinely broken code before they were fixed, in
// three different ways (an assertion a flash outran; a retrying matcher that
// polled until a held response settled; a claim overwritten a moment later, so
// any after-the-fact snapshot recorded the good state). A green run proves
// nothing about a test in this class until you have seen it go red.
//
// So the line each test pins is recorded, for whoever changes one of them next.
// If you edit the source below and the matching test does NOT fail, either the
// test has stopped biting or you have not changed what you thought:
//
//   cold boot says Loading…              ← the cache-miss branch in `navigate`
//   folder A does not stay on screen     ← the cache-miss branch in `navigate`
//   a fast listing paints no loading     ← `LOADING_PAINT_DELAY_MS` → 0
//   folder error dropped over the bin    ← the `galleryIsOnScreen()` guard
//   says Searching…, never No matches    ← the `!ctx.treeLoaded()` clause
//   held folder's name match appears     ← `place.searching` in `settle()`
//   a row goes inert while restore runs  ← the bin's `inFlight` guard
//   Empty bin disables itself            ← `|| busy` in `setBinMode`
//   second image never shows the first   ← clear-before-assign in `showImage`
//   previous stack not sharp on a turn   ← the stack-hide block in `showPage`
//   Layers toggle right on the turn      ← `layersAvail` back to the decode result
//   invented page claims no layers       ← collapsing the neutral third state
//   jump past the filmstrip window       ← the ruled sheet back to `clearRect`
//   find never claims Not recognised     ← `recognitionKnown` in `findInNote`
//   listing-open paints the stack        ← `normalizeEntry` dropping the layers
//   export names the page on screen      ← `stackIsCurrent()` in the export menu
//   the console's import window          ← `showAdminBooting()` in `openAdmin`
//   a bin retry reads as a retry         ← the `state === "error"` flip in `open`
//   a deep-linked crumb corrects itself  ← `onLabelsSettled` in `settle()`
//   a deep link's category tiles settle  ← `relabelFolders`'s card replacement
//   a superseded find is aborted         ← `runAbort?.abort()` in `findInNote`
//
// And prefer `recordText` (helpers/recordText.ts) over any `expect(locator)` for
// "it must never have said X": Playwright's matchers retry until they pass, so
// they are structurally incapable of catching a claim that has already gone.

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

    // Neither the cold boot nor the navigation flashed it.
    expect(await gallery.everShowed("Loading…")).toBe(false);
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

// ============================================================================
// THE TREE WALK, AND WHAT IS WAITING ON IT
// ============================================================================
//
// `prefetchTree` is a sequential BFS: N round-trips before the rail's category
// resolution, the breadcrumb's labels, the root gallery's flattening and
// name-search are correct. A deep link arrives in the middle of it — which is
// the whole of 2.2/2.3.
test.describe("a folder deep link that beats the tree walk", () => {
  /** The container tree: `NOTE` holding the two nested anchors, plus `EXPORT`. */
  const NOTE_KIDS = [folder("f-note", "Note", 1), folder("f-style", "MyStyle", 0)];

  /** The ROOT listing is what resolves every category anchor, so holding it is
   *  what puts the deep link ahead of the walk. Every other listing answers at
   *  once, so the folder itself paints immediately — which is the point: the
   *  CONTENTS never depended on the walk, only the NAMES do. */
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

  // 2.3 — `settle()` called `onSettled()` only at the root (or for a pending
  // category), and `buildCrumbs` runs only inside `renderGallery`. So a bookmarked
  // `#/folder/<export-id>` that resolved before the walk showed the breadcrumb
  // "Library / EXPORT" — the device's raw name, two inches from a rail row
  // reading `Export` — and never repainted, because nothing was going to.
  test("the breadcrumb stops saying EXPORT once the walk resolves the category", async ({ page }) => {
    await heldRoot(page, 2500);
    await page.goto("/?real#/folder/export");
    await expect(page.locator("#gallery")).toContainText("Trail export");

    // Read ONCE, inside the window: the folder itself is fully painted and the
    // crumb is still the raw device name, because nothing yet knows this folder
    // IS the Export category.
    expect(await page.locator(".crumbs__here").textContent()).toBe("EXPORT");

    // The walk landing is the ONLY event — no navigation, no keystroke, no bump.
    await expect(page.locator(".crumbs__here")).toHaveText("Export");
  });

  // The other half of the same repaint, and the reason it is a card replacement
  // rather than a `textContent` write: a category anchor's tile is a different
  // tile. Deep-link into the `NOTE` container and its two children are `Note` and
  // `MyStyle` — both anchors — which arrive as plain folder chips and have to
  // settle into category tiles in place.
  test("a deep-linked container's children settle into category tiles", async ({ page }) => {
    await heldRoot(page, 2500);
    await page.goto("/?real#/folder/dir-note");
    await expect(page.locator("#gallery")).toContainText("MyStyle");

    // Inside the window: two folder cards, neither of them a category.
    const mid = await page.evaluate(() => ({
      folders: document.querySelectorAll("#gallery .card--folder").length,
      categories: document.querySelectorAll("#gallery .card--category").length,
    }));
    expect(mid.folders).toBe(2);
    expect(mid.categories).toBe(0);

    // …and the walk landing settles them where they stand.
    await expect(page.locator("#gallery .card--category")).toHaveCount(2);
    // Narrow, not a rebuild: the listing's own note count is untouched and the
    // section head still describes the same two things.
    await expect(page.locator("#gallery .card--folder")).toHaveCount(2);
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
      // THE TRANSCRIPT HALF NEEDS NO ENTRY, and that absence is the whole of what
      // §6 step 6 changed here. It used to be `controlplane/search`, answering at
      // once and answering NOTHING — which is what settled the question
      // prematurely. It is now the browser's own index (`golden-search.md` §6),
      // which in this scenario has no manifest and no stored rows and therefore
      // also answers nothing, instantly and without a round trip.
      //
      // So the bug's window did not close with the route; it got WIDER, because
      // the empty answer now arrives in the same task as the keystroke instead of
      // after a request. What stops "No matches" being painted is `gallerySearch`'s
      // `!ctx.treeLoaded()` clause and nothing else.
      "user/me": { json: ME },
    };
    await mockApi(page, scenario);
  }

  // 1.1 — the permanent lie. The name half of a library-wide query is matched
  // against the cached tree that `prefetchTree` fills one folder at a time, so a
  // transcript answer with no hits routinely arrives BEFORE the name half can
  // have been computed against a complete library. "No matches" painted then is
  // a claim about notes the app has not looked at yet — and inside a subfolder
  // it never self-corrected, because the repaint was gated on `folderId === null`.
  test("says Searching…, never No matches, while the walk is still running", async ({ page }) => {
    // RECORDED, not sampled, and that is a change forced by the mechanism rather
    // than a preference. The old test's sync point was "wait for the transcript
    // response", which pinned the moment the empty answer arrived; there is no
    // response now, so there is no moment to wait for — and the empty answer lands
    // in the same task as the keystroke, which is exactly the flash this file's
    // header says a retrying matcher cannot see. The whole window is therefore
    // recorded and asserted over afterwards.
    const gallery = await recordText(page, "#gallery");
    await heldBranch(page, { archiveDelayMs: 4000 });
    await page.goto("/?real#/folder/proj");
    await expect(page.locator("#gallery")).toContainText("Sprint plan");

    await page.getByRole("searchbox", { name: "Search notes" }).fill("Zebra");

    // The walk has not landed…
    await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "true");
    // …so the negative is not claimed, now…
    await expect(galleryEmpty(page).locator("h3")).toHaveText("Searching…");
    // …nor at any point since the keystroke. This is the assertion with teeth:
    // remove the `!ctx.treeLoaded()` clause and "No matches" is painted for one
    // repaint before "Searching…" replaces it, which the line above would miss.
    expect(await gallery.everShowed("No matches")).toBe(false);
    expect(await gallery.everShowed("Searching…")).toBe(true);
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

// 2.7 — "a superseded search gives its connection back" — MOVED, not dropped.
//
// It lived here as a LIBRARY search: `controlplane/search` was held, a second
// keystroke superseded the first, and the observable was the browser reporting
// the first request as `net::ERR_ABORTED`. A library-wide query makes no request
// at all now (`golden-search.md` §6 step 6), so there is no connection out here
// to give back and no way to write that assertion in this scope.
//
// The behaviour it pinned is still real, on the one search that still touches the
// network: the FIRST find on a document fetches `text/<md5>`, a giant one can be
// megabytes, and `findInNote`'s `cancelPending` aborts it when the query moves
// on. So the test moved to where that fetch happens — see "a superseded find gives
// its connection back" in the reader's note-stage block below, next to the
// layered fixture it needs.

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

test.describe("the recycle bin's own listing, retried", () => {
  // 2.7 — `state` was only ever moved by a RESPONSE, so a listing that failed
  // left "Couldn't load the bin" standing and the next listing then ran its whole
  // round trip underneath that sentence. The screen reported a failure about a
  // request that had already been replaced by one in progress, and nothing said
  // anything was happening — so the natural reading was that the retry had not
  // been taken.
  test("opening the bin after a failed listing says Loading…, not Couldn’t load", async ({ page }) => {
    const gallery = await recordText(page, "#gallery");
    await mockApi(page, {
      "controlplane/tree": { json: { folderId: null, path: [], entries: [], syncVersion: 1 } },
      "user/me": { json: ME },
    });
    // Registered AFTER `mockApi` so this narrower route wins (Playwright matches
    // newest-first). The boot listing FAILS — with nothing mounted, so nothing is
    // painted — and the retry is HELD, which is the window under test.
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
    // The boot listing has answered (with a failure) before the bin is opened.
    await page.waitForResponse((r) => r.url().includes("/api/controlplane/bin"));

    await page.getByRole("navigation", { name: "Folders" }).getByText("Recycle bin").click();

    // Opening the bin IS the retry, and it reads as one.
    await expect(galleryEmpty(page).locator("h3")).toHaveText("Loading…");
    // RECORDED, not sampled: the stale failure was painted and then replaced when
    // the held listing landed, so any assertion taken afterwards records the good
    // state and proves nothing.
    expect(await gallery.everShowed("Couldn’t load the bin")).toBe(false);

    // …and the retry it was reporting really does arrive.
    await expect(galleryEmpty(page).locator("h3")).toHaveText("Nothing deleted", { timeout: 10_000 });
  });
});

test.describe("the admin console's chunk-import window", () => {
  // 2.6 — `void import("./admin")` painted NOTHING before or during a round trip
  // of its own, so the previous folder's gallery stayed on screen under a rail
  // highlight that had already moved to Admin. From the BIN it was worse: the
  // console's route closes the bin by repainting the gallery over it, so the
  // sequence was bin → a folder listing nobody asked for → a long gap → console.
  test("paints the console's loading state, never a folder listing nobody asked for", async ({ page }) => {
    await mockApi(page, {
      "controlplane/bin": { json: { entries: [], totalBytes: 0, retentionDays: 30, syncVersion: 1 } },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [note("n-root", "Root readme")], syncVersion: 1 },
      },
      // 428 is what a cold console really meets: the session is alive and simply
      // not elevated, so the panel lands on its gate. Without it `mockApi`'s bland
      // fallback 200 would read as proof of elevation.
      "admin/users": { status: 428, json: { success: false } },
      "user/me": { json: { ...ME, isAdmin: true } },
    });
    // HOLD THE CHUNK. Under the dev server the console's module is a request like
    // any other, which is the only way to make this window deterministic rather
    // than a race against the module graph.
    const isChunk = (u: string) => new URL(u).pathname.endsWith("/src/pages/admin.ts");
    await page.route(
      (url) => url.pathname.endsWith("/src/pages/admin.ts"),
      async (route) => {
        await new Promise((r) => setTimeout(r, 4000));
        await route.continue();
      },
    );

    await page.goto("/?real#/bin");
    await expect(page.locator(".bin")).toBeVisible();

    // The REQUEST is the sync point, and it has to be awaited rather than
    // inferred: a flag set inside the route handler lives in node and the handler
    // runs a round trip behind the browser, so reading it straight after the click
    // is a race the assertion loses about half the time — while the window it is
    // about is genuinely open. Awaiting the request proves the hold happened AND
    // puts the read inside it.
    const chunk = page.waitForRequest((r) => isChunk(r.url()));
    await page.locator(".nav__item", { hasText: "Admin" }).click();
    await chunk;

    // Read ONCE, inside the window — a retrying matcher would poll until the
    // chunk landed and then record the console, which is not what is under test.
    const s = await page.evaluate(() => ({
      galleryHidden: (document.querySelector("#gallery") as HTMLElement).hidden,
      crumb: document.querySelector(".crumbs__here")?.textContent ?? "",
      standIn: document.querySelector(".admin-booting")?.textContent ?? "",
      destinationMode: document.querySelector(".sn-root")?.classList.contains("is-destination") ?? false,
      console_: document.querySelector(".admin") !== null,
    }));

    // Not the gallery, not the bin, and not a blank: the surface says what it is.
    expect(s.galleryHidden).toBe(true);
    expect(s.console_).toBe(false);
    expect(s.standIn).toContain("Opening the admin console");
    // …with the chrome already the console's, so the crumb and the rail highlight
    // agree with the address bar for the whole window.
    expect(s.crumb).toBe("Admin");
    expect(s.destinationMode).toBe(true);

    // And the console takes the surface over when it lands, with the stand-in gone.
    await expect(page.locator(".admin-gate")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".admin-booting")).toBeHidden();
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

    // Straight to the second image, whose bytes are held.
    await page.evaluate(() => {
      window.location.hash = "#/note/152";
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

// ============================================================================
// THE READER'S NOTE STAGE, WITH THE LINK HELD
// ============================================================================
//
// These run through REAL mode against a mocked control plane for the same reason
// the listing cases above do — it is the only way to HOLD a page's bytes or its
// metadata — but with one addition: the SNPG payload served for a page is the
// committed layered fixture (src/api/layeredFixture.ts), so the real
// `note-decode.wasm` genuinely decodes it and the stack that appears is a real
// stack, not a stand-in. Its layer descriptors come from the same module, which
// is what makes them pair by slot with the payload's records.

const LAY = "n-lay";
const PAGE_HASHES = ["a1".repeat(16), "b2".repeat(16), "c3".repeat(16)];

/** A page ref as the control plane serves it, layered or not. Layers are OMITTED
 *  where a page has none — never `null`, never `[]` — exactly as the wire does. */
function wirePage(index: number, layered: boolean) {
  return {
    index,
    hash: PAGE_HASHES[index] ?? `${index}`.repeat(32).slice(0, 32),
    width: 1404,
    height: 1872,
    textHash: null,
    ...(layered ? { layers: layeredPageLayers(0) } : {}),
  };
}

/** The layered note as a LISTING entry — the shape the reader opens from. */
function layeredEntry(opts: { firstPageLayered: boolean; pageCount: number }) {
  return {
    kind: "note",
    id: LAY,
    name: "Layered field sketch",
    pageCount: opts.pageCount,
    fileType: "note",
    fileHash: "0".repeat(32),
    updatedAt: 1_700_000_000_000,
    hasRecognizedText: false,
    firstPage: wirePage(0, opts.firstPageLayered),
  };
}

/** …and as `getNoteMeta` answers it. `layered` lists which page indices carry layers. */
function layeredMeta(pageCount: number, layered: number[]) {
  return {
    id: LAY,
    name: "Layered field sketch",
    fileType: "note",
    fileHash: "0".repeat(32),
    size: 1_048_576,
    pxPerMm: null,
    pages: Array.from({ length: pageCount }, (_, i) => wirePage(i, layered.includes(i))),
  };
}

/**
 * Serve `GET /note/{id}/page/{n}` with the fixture's real SNPG v2 payload,
 * optionally HOLDING one page index. Not an `/api/` route, so it is a page.route
 * of its own rather than a `mockApi` scenario key.
 */
async function serveLayeredPages(page: Page, hold?: { index: number; ms: number }): Promise<void> {
  const payload = Buffer.from(layeredPagePayload(0)!);
  await page.route(
    (url) => url.pathname.startsWith(`/note/${LAY}/page/`),
    async (route) => {
      const n = Number(new URL(route.request().url()).pathname.split("/page/")[1]);
      if (hold && n === hold.index) await new Promise((r) => setTimeout(r, hold.ms));
      await route.fulfill({ status: 200, contentType: "application/octet-stream", body: payload });
    },
  );
}

/** The one-shot snapshot of the note stage, read in a SINGLE evaluate — never a
 *  retrying assertion, which would poll until the held response expired and then
 *  record the settled state instead of the one under test. */
async function stageSnapshot(page: Page) {
  return page.evaluate(() => {
    const stack = document.querySelector(".note-stack") as HTMLElement | null;
    const canvas = document.querySelector(".page > canvas") as HTMLCanvasElement | null;
    const toggle = document.querySelector('[aria-controls="note-layers-panel"]') as HTMLButtonElement | null;
    const panel = document.querySelector(".note-layers") as HTMLElement | null;
    // Alpha at the page's centre. A CLEARED canvas is transparent (0) — the bare
    // white rectangle 1.8 is about; the ruled-sheet placeholder fills it (255).
    let centreAlpha = -1;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const ctx = canvas.getContext("2d");
      if (ctx) centreAlpha = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3]!;
    }
    return {
      pager: document.querySelector(".pager__count")?.textContent ?? "",
      stackHidden: stack === null || stack.hidden,
      stackCanvases: stack ? stack.querySelectorAll("canvas").length : 0,
      canvasHidden: canvas === null || canvas.hidden,
      canvasWidth: canvas?.width ?? 0,
      centreAlpha,
      layersDisabled: toggle?.disabled ?? null,
      layersTitle: toggle?.getAttribute("title") ?? "",
      panelHidden: panel === null || panel.hidden,
      panelText: panel?.textContent ?? "",
      findCount: document.querySelector(".findbar__count")?.textContent ?? "",
    };
  });
}

test.describe("the reader's note stage, mid-fetch", () => {
  // 1.6 — `.note-stack` is `position:absolute; inset:0`, so it COVERS the page
  // canvas; nothing released or hid it until the new page's `present()` committed.
  // On a layered→layered turn the title, the pager and the filmstrip moved to
  // page N+1 while page N's ink stayed fully rendered and sharp underneath them,
  // for the whole fetch + decode. Blurring the stack was rejected as the fix: the
  // blur-up works because it is the SAME page at low resolution, and a blurred
  // stack is just a blurry WRONG page.
  test("the previous page's layer stack does not stay sharp through a page turn", async ({ page }) => {
    await mockApi(page, {
      "controlplane/file/metadata": { json: layeredMeta(2, [0, 1]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: true, pageCount: 2 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    // Page 2's bytes are held — everything asserted below happens inside that window.
    await serveLayeredPages(page, { index: 1, ms: 6000 });
    await page.goto("/?real");
    await page.locator(".card__open", { hasText: "Layered field sketch" }).click();

    // Page 1's stack is genuinely up (four records, decoded by the real wasm).
    await expect(page.locator(".note-stack canvas")).toHaveCount(4);
    await page.getByRole("button", { name: "Layers" }).click();
    await expect(page.locator(".note-layers")).toContainText("Layer Renamed");

    await page.getByRole("button", { name: "Next page" }).click();
    // Read ONCE. Everything `showPage` does before its first await — the pager,
    // the layers affordance, the stack swap, the placeholder — has already run
    // by the time the click resolves.
    const s = await stageSnapshot(page);

    expect(s.pager).toBe("2 / 2");
    // THE REGRESSION: page 1's ink is no longer on screen…
    expect(s.stackHidden).toBe(true);
    // …but it was HIDDEN, not released — the canvases are still mounted, which is
    // what keeps `isPresented`'s short-circuit (and the controller's `gen` token)
    // intact for a zoom step or a relayout of the same page.
    expect(s.stackCanvases).toBe(4);
    // …and what IS on screen is the composite canvas, painted with the ruled
    // sheet (page 2 has no filmstrip thumbnail to blur up — its bytes are held).
    expect(s.canvasHidden).toBe(false);
    expect(s.centreAlpha).toBe(255);

    // 1.9's panel half: an open panel across a page turn showed the PREVIOUS
    // page's rows and thumbnails. It says what it is doing instead.
    expect(s.panelHidden).toBe(false);
    expect(s.panelText).toContain("Loading this page's layers…");
    expect(s.panelText).not.toContain("Layer Renamed");
  });

  // FOUND WHILE FIXING THE ABOVE, not looked for: the export menu read the
  // MOUNTED stack rather than the one on screen. Across a page turn the previous
  // page's stack survives (hidden) until the new one commits, so "save the
  // current view as a layered image" would have written page N's layers into a
  // file named for page N+1 — a wrong file with a convincing name, which is the
  // worst kind. Giving "is the stack on screen the right one" a single
  // definition (`stackIsCurrent`) fixed the export at the same time as the paint.
  test("the export menu never offers the current view while it belongs to the page you left", async ({
    page,
  }) => {
    await mockApi(page, {
      "controlplane/file/metadata": { json: layeredMeta(2, [0, 1]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: true, pageCount: 2 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    // Page 2's bytes are held, so the turn below lands mid-flight and page 1's
    // stack is still the only one mounted.
    await serveLayeredPages(page, { index: 1, ms: 6000 });
    await page.goto("/?real");
    await page.locator(".card__open", { hasText: "Layered field sketch" }).click();
    await expect(page.locator(".note-stack canvas")).toHaveCount(4);

    // The EXPORT pop specifically — the bar also carries the bin-mode "…" pop,
    // which shares `.menu__pop`; only the export menu has group headings.
    const reader = page.getByRole("region", { name: "Reader" });
    const exportMenu = page.locator(".reader__bar .menu__pop", { has: page.locator(".menu__head") });
    const oraRow = exportMenu.getByRole("menuitem", { name: "Layered image" });

    // On page 1 the row is genuinely on offer — the stack IS this page's.
    await reader.getByRole("button", { name: "Download" }).click();
    await expect(oraRow).toHaveCount(1);
    await page.keyboard.press("Escape");

    await reader.getByRole("button", { name: "Next page" }).click();
    await reader.getByRole("button", { name: "Download" }).click();
    // Mid-turn: the mounted stack is page 1's, so there is no current view to
    // save. Offering one would export the wrong page under this page's name.
    await expect(oraRow).toHaveCount(0);
  });

  // 1.9 — `refreshLayersUi` ran only AFTER the decode resolved, so a turn onto a
  // layered page left the toggle describing the page you had just left: disabled,
  // "This page has no layers", about a page whose layers were on the wire. The
  // reader already knows the answer from `page.layers` before it fetches anything.
  test("the Layers toggle is right the instant the page turns, not when it decodes", async ({ page }) => {
    await mockApi(page, {
      // Page 1 is plain, page 2 is layered — the direction with teeth. (The other
      // way round the old code was accidentally correct: a layerless page released
      // the stack synchronously.)
      "controlplane/file/metadata": { json: layeredMeta(2, [1]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: false, pageCount: 2 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page, { index: 1, ms: 6000 });
    await page.goto("/?real");
    await page.locator(".card__open", { hasText: "Layered field sketch" }).click();
    await expect(page.locator(".pager__count")).toHaveText("1 / 2");
    // Page 1 carries none, and that is a fact off real metadata.
    expect((await stageSnapshot(page)).layersTitle).toBe("This page has no layers");

    await page.getByRole("button", { name: "Next page" }).click();
    const s = await stageSnapshot(page);

    expect(s.pager).toBe("2 / 2");
    // Correct BEFORE a single byte of page 2 has arrived.
    expect(s.layersDisabled).toBe(false);
    expect(s.layersTitle).toBe("Layers");
  });

  // The other half of 1.9, and the one the owner picked option (a) for: a page the
  // SKELETON invented answers nothing about layers, so the toggle is disabled with
  // NEUTRAL wording. "This page has no layers" there is a definite claim about a
  // page whose metadata has not arrived.
  test("a page the skeleton invented never claims to have no layers", async ({ page }) => {
    await mockApi(page, {
      "controlplane/file/metadata": { delayMs: 6000, json: layeredMeta(3, [0, 1, 2]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: true, pageCount: 3 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page);
    await page.goto("/?real");
    await expect(page.locator("#gallery")).toContainText("Layered field sketch");
    // Straight to page 2 — a page the summary says nothing about, so the reader
    // stands it in with a placeholder until the real metadata lands.
    await page.evaluate(() => {
      window.location.hash = "#/note/n-lay/page/2";
    });
    await expect(page.locator(".pager__count")).toHaveText("2 / 3");

    const s = await stageSnapshot(page);
    expect(s.layersDisabled).toBe(true);
    expect(s.layersTitle).not.toBe("This page has no layers");
    expect(s.layersTitle).toContain("Layers");
  });

  // 1.8 — the blur-up source is the filmstrip, which is VIRTUALIZED, and
  // `scrollIntoView` only runs at the END of `showPage`. Jump outside the rendered
  // window and there is no button to blur, so the canvas was CLEARED: a bare white
  // rectangle, indistinguishable from frozen, for the whole fetch + decode.
  test("a jump past the filmstrip's window paints the ruled sheet, not a blank", async ({ page }) => {
    const PAGES = 60;
    const meta = {
      id: LAY,
      name: "Long notebook",
      fileType: "note",
      fileHash: "0".repeat(32),
      size: 1_048_576,
      pxPerMm: null,
      pages: Array.from({ length: PAGES }, (_, i) => ({
        index: i,
        hash: `${i}`.padStart(32, "d"),
        width: 1404,
        height: 1872,
        textHash: null,
      })),
    };
    await mockApi(page, {
      "controlplane/file/metadata": { json: meta },
      "controlplane/tree": {
        json: {
          folderId: null,
          path: [],
          entries: [{ ...layeredEntry({ firstPageLayered: false, pageCount: PAGES }), name: "Long notebook" }],
          syncVersion: 1,
        },
      },
      "user/me": { json: ME },
    });
    // Page 41's bytes never arrive inside the test — the window under test is the
    // whole of that fetch. Every other page answers at once (with bytes the
    // renderer will reject, which is fine: nothing here is about pixels).
    await page.route(
      (url) => url.pathname.startsWith(`/note/${LAY}/page/`),
      async (route) => {
        if (new URL(route.request().url()).pathname.endsWith("/page/40")) {
          await new Promise((r) => setTimeout(r, 15_000));
        }
        await route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from([]) });
      },
    );
    // STRAIGHT to the deep link, with no listing loaded — which is the only way to
    // observe the FIRST `showPage` for a distant page. Every later one is safe by
    // accident: `showPage` ends with `scrollIntoView`, so by its second run the
    // filmstrip has scrolled the target into its rendered window and there IS a
    // thumbnail to blur up. The bug lives in that first paint.
    await page.goto(`/?real#/note/${LAY}/page/41`);

    // The request for page 41 IS the sync point: the placeholder is painted in the
    // same synchronous block that issues it.
    await page.waitForRequest((r) => r.url().includes(`/note/${LAY}/page/40`));
    const s = await stageSnapshot(page);

    expect(s.pager).toBe("41 / 60");
    // A sized, PAINTED canvas — the warm ruled sheet. Cleared, it was transparent
    // on a zero-sized backing store, which is the blank rectangle 1.8 describes.
    expect(s.canvasWidth).toBeGreaterThan(0);
    expect(s.centreAlpha).toBe(255);
  });

  // 1.10 — a `?q=` deep link primes find against the SKELETON, where every page
  // but the first carries an invented `textHash: null`. `runQuery` saw zero
  // recognised pages and painted "Not recognised on the device" — a definite claim
  // about a note whose page list was still in flight, and the exact class of
  // speculative statement this reader's own copy rules forbid.
  //
  // Observed rather than polled, and deliberately: the claim is OVERWRITTEN a
  // moment later by phase 1's counter (`paintPage` repaints once the page's word
  // boxes resolve), so a snapshot taken afterwards records the good state and
  // proves nothing. What must be true is that the claim never appeared AT ALL.
  test("find never claims Not recognised while the note's metadata is in flight", async ({ page }) => {
    const counter = await recordText(page, ".findbar__count");
    await mockApi(page, {
      "controlplane/file/metadata": { delayMs: 6000, json: layeredMeta(3, []) },
      // Held too, so the counter cannot be settled by the note-wide count
      // landing. This is `text/<md5>` now (§6 step 7): the note-scoped search
      // route is gone and the count comes from an index the browser builds out
      // of this response, so holding it holds the whole of phase 2 — which is
      // what makes the intermediate state observable at all.
      "controlplane/text/": { delayMs: 6000, json: {} },
      "controlplane/tree": {
        json: {
          folderId: null,
          path: [],
          entries: [
            // The LISTING's whole-note answer: this note DOES carry recognition
            // somewhere. Page 1 happens not to — which is exactly the case the
            // skeleton reads as "none anywhere".
            { ...layeredEntry({ firstPageLayered: false, pageCount: 3 }), hasRecognizedText: true },
          ],
          syncVersion: 1,
        },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page);
    await page.goto("/?real");
    await expect(page.locator("#gallery")).toContainText("Layered field sketch");
    await page.evaluate(() => {
      window.location.hash = "#/note/n-lay?q=zebra";
    });
    await expect(page.locator(".findbar")).toBeVisible();
    // What it says instead: a search is under way, with no number it does not have
    // ("searching 0 pages…" would be a count off the skeleton's invented nulls).
    await expect(page.locator(".findbar__count")).toHaveText("searching…");

    expect(await counter.everShowed("Not recognised")).toBe(false);
    expect(await counter.everShowed("No matches")).toBe(false);
  });

  // 2.7, REHOUSED — see the note where this used to live, above the recycle bin's
  // block. The token machine is correct and always was: a superseded answer is
  // dropped on both arms. But DROPPING IS NOT STOPPING. The request went on to
  // completion holding one of the browser's ~6 connections per origin, and after
  // §6 step 7 the request it is holding is the one that can actually be big:
  // `text/<md5>` is a whole document's text, 3.15 MB for the worst real one
  // (§8.1), against a find bar that issues a new one every 220 ms of typing.
  //
  // `findInNote`'s `cancelPending` aborts it, and the browser reporting the
  // request as FAILED is the observable: an abort is `net::ERR_ABORTED`, and a
  // request merely ignored never fails at all.
  test("a superseded find gives its connection back rather than running to completion", async ({ page }) => {
    await mockApi(page, {
      // The metadata lands, so find has the real page list and the query really
      // runs — this test is about the fetch, not about the skeleton.
      "controlplane/file/metadata": { json: layeredMeta(3, [0, 1, 2]) },
      // Held, so the first query's text fetch is still on the wire when the next
      // keystroke supersedes it. That IS the window.
      "controlplane/text/": { delayMs: 6000, json: {} },
      "controlplane/tree": {
        json: {
          folderId: null,
          path: [],
          entries: [
            { ...layeredEntry({ firstPageLayered: false, pageCount: 3 }), hasRecognizedText: true },
          ],
          syncVersion: 1,
        },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page);
    await page.goto(`/?real#/note/${LAY}`);
    await expect(page.locator(".reader.is-open")).toBeVisible();

    await page.getByRole("button", { name: "Find in this note" }).click();
    const field = page.getByRole("textbox", { name: "Find in this note" });

    await field.fill("zebra");
    await page.waitForRequest((r) => r.url().includes("controlplane/text/"));

    const dropped = page.waitForEvent("requestfailed", (r) => r.url().includes("controlplane/text/"));
    await field.fill("zebras");
    expect((await dropped).failure()?.errorText ?? "").toContain("ABORTED");
  });

  // THE PAYOFF of a listing's `firstPage` carrying its layers: a note opened from
  // a listing used to paint the composite, disable Layers, then — when the meta
  // landed — re-fetch the very same page bytes and swap the stack in. Held
  // metadata makes the difference unmissable: the stack is up while `getNoteMeta`
  // is still outstanding.
  test("a listing-originated open paints the stack before the metadata lands", async ({ page }) => {
    await mockApi(page, {
      "controlplane/file/metadata": { delayMs: 6000, json: layeredMeta(2, [0]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: true, pageCount: 2 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page);
    await page.goto("/?real");
    await page.locator(".card__open", { hasText: "Layered field sketch" }).click();

    // Four record canvases, decoded by the real wasm, with `getNoteMeta` still held.
    await expect(page.locator(".note-stack canvas")).toHaveCount(4);
    const s = await stageSnapshot(page);
    expect(s.stackHidden).toBe(false);
    // The composite is out of the way, and the toggle is right on the FIRST paint.
    expect(s.canvasHidden).toBe(true);
    expect(s.layersDisabled).toBe(false);
    expect(s.layersTitle).toBe("Layers");
  });
});
