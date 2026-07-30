import { test, expect, type Page } from "@playwright/test";
import { mockApi, type Scenario } from "./helpers/mockApi";
import { signedIn, mockRawFiles } from "./helpers/app";
// The committed layered fixture, imported so the SNPG payload served below is the
// real thing the wasm decoder is written against, and its layer descriptors pair
// with that payload's records by slot — see src/api/layeredFixture.ts.
import { layeredPageLayers, layeredPagePayload } from "../../src/api/layeredFixture";

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
    await page.addInitScript(() => {
      const w = window as Window & { __findCounts?: string[] };
      w.__findCounts = [];
      const isCounter = (n: Node | null): boolean =>
        n instanceof Element ? n.classList.contains("findbar__count") : isCounter(n?.parentElement ?? null);
      new MutationObserver((records) => {
        for (const r of records) {
          if (!isCounter(r.target)) continue;
          // Every value the counter ever HELD, including one replaced later in the
          // same task: a replaced text node still carries the text it showed.
          for (const n of Array.from(r.addedNodes)) w.__findCounts!.push(n.textContent ?? "");
          if (r.type === "characterData") w.__findCounts!.push(r.target.textContent ?? "");
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await mockApi(page, {
      "controlplane/file/metadata": { delayMs: 6000, json: layeredMeta(3, []) },
      // Held too, so the counter cannot be settled by the note-wide count landing.
      "controlplane/note/n-lay/search": { delayMs: 6000, json: { pages: [], usedFuzzy: false } },
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

    const seen = await page.evaluate(() => (window as Window & { __findCounts?: string[] }).__findCounts ?? []);
    expect(seen.join(" | ")).not.toContain("Not recognised");
    expect(seen.join(" | ")).not.toContain("No matches");
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
