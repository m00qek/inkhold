import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signedIn, mockThumbnailBackend, imgInkFraction, freezeMotion, railSettled } from "./helpers/app";
import { FIXTURE, serveRanges } from "./helpers/pdfRange";

// A `.pdf`'s LIBRARY TILE, rendered end to end: page 0 through the real MuPDF
// wasm, in the gallery, over real byte ranges.
//
// Every other PDF spec drives the VIEWER. This one drives the listing, which is
// the last place a PDF was a static glyph — and it is the case with no
// server-side help at all: a PDF carries no embedded thumbnail, its `.mark`
// sibling carries none either, and the backend has no PDF parser. So the client
// opens the document itself, off the same range-served route the viewer uses.
//
// THE FIXTURE IS LOAD-BEARING TWICE. `two-page.pdf`'s page 0 is 200x100 —
// LANDSCAPE, aspect 2.0, nothing like the 3:4 the grid falls back to — so a tile
// that ends up 2:1 can only have learnt its shape from the page itself. And it
// draws a filled 60x40 rectangle, 12% of the page, so the ink probe has
// something unambiguous to see.

const PDF = readFileSync(FIXTURE);
/** The fixture's page 0: `/MediaBox [0 0 200 100]`. */
const PAGE0_ASPECT = 200 / 100;
/** Comfortably above a blank tile, well below the fixture's ~12% of black. */
const INK = 0.02;

const card = (page: Page, name: string) => page.locator(".card", { hasText: name });
const manual = (page: Page) => card(page, "Appliance manual");

/**
 * The `Files` folder with real PDF bytes behind `178` ("Appliance manual") ALONE.
 *
 * Registered AFTER `mockThumbnailBackend` so Playwright's newest-first matching
 * gives the PDF its own bytes while every sibling tile — the images, the `.spd`,
 * the `.txt` — keeps the ordinary mock. Returns the range tally, because "how
 * many requests did this tile cost?" is the question this whole path is designed
 * around.
 */
async function openFilesWithPdf(page: Page): Promise<{ count: () => number; bytes: () => number }> {
  await mockThumbnailBackend(page, { textIds: ["177"] });
  const served = await serveRanges(page, PDF, undefined, (url) =>
    url.pathname === "/file/178",
  );
  await page.goto("/");
  await railSettled(page);
  await page.locator(".card--folder", { hasText: "Files" }).click();
  await expect(card(page, "Meeting notes — Q3")).toBeVisible();
  await freezeMotion(page);
  return served;
}

test.describe("a .pdf's gallery tile is its page 0", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test("renders page 0 into the card's <img> — real ink, not a glyph", async ({ page }) => {
    await openFilesWithPdf(page);

    const img = manual(page).locator("img.thumb__img");
    await expect(img).toBeVisible();
    // The facade's WebP, as an object URL — the same currency every other real
    // tile in this grid is painted in.
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.src.startsWith("blob:"))).toBe(true);
    // …and it carries the page's ink. A glyph tile reads far below this: its
    // sheet outline is a thin stroke on paper, where the fixture's page is an
    // eighth solid black.
    await expect.poll(() => imgInkFraction(img), { timeout: 20_000 }).toBeGreaterThan(INK);
    // The static glyph tile is gone from this card entirely.
    await expect(manual(page).locator(".thumb--file")).toHaveCount(0);
  });

  test("the tile takes PAGE 0's own aspect, so masonry stops guessing A4", async ({ page }) => {
    await openFilesWithPdf(page);
    const tile = manual(page).locator(".thumb");

    // Nothing on the wire states a PDF's shape, so the tile opens on the CSS
    // 3:4 fallback and corrects once — the single reflow a first-ever view is
    // allowed, exactly as an image's does. What it corrects TO is the claim:
    // 2:1 landscape, which only page 0 could have told it.
    await expect
      .poll(
        async () => {
          const box = await tile.boundingBox();
          return box && box.height > 0 ? box.width / box.height : null;
        },
        { timeout: 20_000, message: "the pdf tile's aspect" },
      )
      .toBeCloseTo(PAGE0_ASPECT, 1);
  });

  // THE DEFECT THIS FILE SPENT A WHILE MISREADING AS ITS OWN FLAKE.
  //
  // `render/lazy.ts` races the produce against `PLACEHOLDER_AFTER_MS` (200 ms)
  // and paints the type's generic glyph into the tile's `<img>` if the produce
  // loses — then repaints THE SAME ELEMENT with the real pixels. `applyTileAspect`
  // listened with `{ once: true }`, so the glyph's `load` won: it pinned the
  // glyph's 3:4 and removed the listener, and the real pixels arrived to nothing.
  //
  // The test above only reproduces that when the machine happens to be busy
  // enough to lose the race, which is why it read as load flake for a whole
  // session. This one MAKES it lose, by charging the bytes a latency well past
  // the placeholder timer — so the glyph is guaranteed, and the assertion is
  // about what the tile settles on afterwards.
  test("a tile that showed the interim glyph STILL ends at page 0's aspect", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["177"] });
    // 300 ms per request, effectively unlimited throughput: the delay is the
    // point, not the bandwidth.
    await serveRanges(page, PDF, { latencyMs: 300, bytesPerSecond: 1e9 }, (url) =>
      url.pathname === "/file/178",
    );
    await page.goto("/");
    await railSettled(page);
    await page.locator(".card--folder", { hasText: "Files" }).click();
    await expect(card(page, "Meeting notes — Q3")).toBeVisible();
    await freezeMotion(page);

    const tile = manual(page).locator(".thumb");

    // The glyph really did get painted — otherwise this asserts nothing about
    // the second `load`, and the test would pass for the wrong reason.
    await expect
      .poll(
        async () => {
          const box = await tile.boundingBox();
          return box && box.height > 0 ? box.width / box.height : null;
        },
        { timeout: 5_000, message: "the interim glyph's aspect" },
      )
      .toBeLessThan(1.5);

    // ...and the real pixels still correct it.
    await expect
      .poll(
        async () => {
          const box = await tile.boundingBox();
          return box && box.height > 0 ? box.width / box.height : null;
        },
        { timeout: 20_000, message: "the pdf tile's settled aspect" },
      )
      .toBeCloseTo(PAGE0_ASPECT, 1);
  });

  test("costs ONE document open, and none at all on the way back", async ({ page }) => {
    // The serial queue opens, renders and CLOSES per file; the facade's memo then
    // answers every later paint. So leaving the folder and coming back must not
    // re-open the document — which is the whole reason the 5.3 MB module is
    // fetched once per device rather than once per visit.
    const served = await openFilesWithPdf(page);
    const img = manual(page).locator("img.thumb__img");
    await expect.poll(() => imgInkFraction(img), { timeout: 20_000 }).toBeGreaterThan(INK);
    const first = served.count();
    // A 688-byte document collapses its head and tail windows into one span, so
    // this is block 0 plus that one — small, and above all BOUNDED.
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(4);

    await page.goBack();
    await expect(page.locator(".card--folder", { hasText: "Files" })).toBeVisible();
    await page.locator(".card--folder", { hasText: "Files" }).click();
    await expect(card(page, "Meeting notes — Q3")).toBeVisible();
    await expect.poll(() => imgInkFraction(manual(page).locator("img.thumb__img")), { timeout: 20_000 })
      .toBeGreaterThan(INK);
    // Not one more byte range: the tile came out of the facade's cache.
    expect(served.count()).toBe(first);
  });

  test("a PDF whose bytes will not open falls back to the glyph, never an empty tile", async ({ page }) => {
    // The honest floor, on a real browser: an encrypted or corrupt document (here
    // simply not a PDF) must still paint something. `mockThumbnailBackend` alone
    // serves PNG bytes for the raw route, which MuPDF refuses.
    await mockThumbnailBackend(page, { textIds: ["177"] });
    await page.goto("/");
    await railSettled(page);
    await page.locator(".card--folder", { hasText: "Files" }).click();
    await expect(card(page, "Meeting notes — Q3")).toBeVisible();
    await freezeMotion(page);

    const img = manual(page).locator("img.thumb__img");
    // Painted — with the facade's glyph, inside the same <img>. An unpainted
    // tile would have no `src` at all (see `imgPainted`), and that is the state
    // this is here to rule out.
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.src.startsWith("blob:")), {
      timeout: 20_000,
    }).toBe(true);
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
    // …and the rest of the grid is unharmed: one refused document is one tile.
    await expect
      .poll(() => imgInkFraction(card(page, "readme").locator("img.thumb__img")), { timeout: 20_000 })
      .toBeGreaterThan(0.004);
  });
});
