import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, mockThumbnailBackend, imgPainted, freezeMotion, railSettled } from "./helpers/app";

// The masonry icon gallery + the reflow-free row rider.
//
// The `Files` fixture folder is the whole test bed: one entry per aspect source
// (a cover note, a landscape note whose page-1 dims serve 1872×1404, a `.spd`
// with its thumb dims, a `.txt` on the client constant, an image with NO served
// aspect) plus both clamp extremes (a 7.5:1 panorama and a 0.13:1 scroll).
//
// What must hold:
//  - ICON mode is uniform `--tile-w-icon` columns; each tile's HEIGHT is its
//    own aspect — pre-set from `thumbAspect` before any image bytes arrive;
//  - the sort order READS LEFT-TO-RIGHT (the §D rule — `column-count`-style
//    down-a-column scan orders are the rejected design);
//  - the free axis clamps at 2.5× the fixed one, letterboxed inside;
//  - tiles with a served aspect NEVER move when their image lands (the reflow
//    e2e), and a list row's lead reserves its final — pre-clamped — width from
//    first paint, so the row's text never moves either.

const card = (page: Page, name: string) => page.locator(".card", { hasText: name });

/** The masonry column width, from the live token — the tests must not restate it. */
async function tileWidth(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tile-w-icon")));
}

async function openFiles(page: Page): Promise<void> {
  await page.goto("/");
  await railSettled(page);
  await page.locator(".card--folder", { hasText: "Files" }).click();
  await expect(card(page, "Meeting notes — Q3")).toBeVisible();
  await freezeMotion(page);
}

/** A tile's box ratio (w/h), or null while the node is being repainted under us. */
async function tileRatio(tile: Locator): Promise<number | null> {
  const box = await tile.boundingBox();
  if (!box || box.height === 0) return null;
  return box.width / box.height;
}

test.describe("masonry icon gallery", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  // Every tile's rendered aspect matches its SOURCE's truth — thumbAspect for
  // notes/spd, the client constant for .txt, the decoded image for an image,
  // the 3:4 fallback for a glyph — at one uniform column width.
  test("mixed gallery: every tile's aspect matches its source, at uniform width", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"] });
    await openFiles(page);
    const w = await tileWidth(page);

    const cases: [string, number][] = [
      ["Meeting notes — Q3", 120 / 160], // cover dims (cover-else-page-1 rule)
      ["Whiteboard — sprint plan", 1872 / 1404], // landscape page-1 EFFECTIVE dims
      ["Kitchen sketch", 600 / 800], // .spd thumb dims
      ["readme", 3 / 4], // the .txt client constant
      // The `.pdf` states no shape. It RESERVES A4 portrait (0.707) and then
      // learns from its tile — and here the mock serves PNG bytes, MuPDF refuses
      // them, and what it learns from is the facade's GLYPH, drawn at the note
      // sheet's 3:4. Both land inside this tolerance, which is the honest thing
      // to assert about a tile with no served shape; `pdfThumbnail.spec.ts`
      // covers the case where page 0 really renders and the tile takes the
      // page's own (2:1) aspect, well outside it.
      ["Appliance manual", 3 / 4],
      ["Panorama — coastline", 2.5], // 7.5 floored at the 2.5× wide clamp
      ["Receipt — long scroll", 1 / 2.5], // 0.13 capped at the 2.5× tall clamp
    ];
    for (const [name, want] of cases) {
      const tile = card(page, name).locator(".thumb");
      await expect
        .poll(async () => tileRatio(tile), { message: `${name} tile aspect` })
        .toBeCloseTo(want, 1);
      // The fixed axis: every tile is exactly one column wide.
      await expect.poll(async () => (await tile.boundingBox())?.width ?? null).toBeCloseTo(w, 0);
    }

    // The image (2×2 png, aspect 1.0) has NO served aspect — its one allowed
    // reflow corrects the 3:4 placeholder to square once the browser decodes it.
    const img = card(page, "Screenshot — dashboard").locator(".thumb");
    await expect.poll(async () => tileRatio(img), { timeout: 6000 }).toBeCloseTo(1.0, 1);
  });

  // THE §D RULE: the sort order reads left-to-right, then wraps — never down a
  // column. `grid-auto-flow: row` is what carries it; this pins the behaviour,
  // not the property.
  test("the sort order reads left-to-right across the masonry", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"] });
    await openFiles(page);

    // DOM order is the sort order (default "recent"; the fixture's updatedAt
    // descend in declaration order) — pinned first so the geometry claim below
    // is about the right sequence.
    await expect(page.locator("#gallery .card .card__title")).toHaveText([
      "Meeting notes — Q3",
      "Whiteboard — sprint plan",
      "Screenshot — dashboard",
      "Kitchen sketch",
      "Panorama — coastline",
      "Receipt — long scroll",
      "readme",
      "Appliance manual",
    ]);

    await expect
      .poll(async () => {
        const boxes: { x: number; y: number }[] = [];
        for (const c of await page.locator("#gallery .card").all()) {
          const b = await c.boundingBox();
          if (!b) return null;
          boxes.push({ x: b.x, y: b.y });
        }
        if (boxes.length < 2) return null;
        const columns = new Set(boxes.map((b) => Math.round(b.x))).size;
        // Row-major placement, stated as geometry: a LATER card never starts
        // ABOVE an earlier one, and cards that start on the same line run left
        // to right. A column-major scan (`column-count`, the rejected design)
        // fails this at every column break — the next column's first card jumps
        // back UP above its DOM predecessor.
        const leftToRight = boxes.every((b, i) => {
          if (i === 0) return true;
          const prev = boxes[i - 1]!;
          return b.y > prev.y + 0.5 || (Math.abs(b.y - prev.y) <= 0.5 && b.x > prev.x);
        });
        return { columns: columns > 1, leftToRight };
      })
      .toEqual({ columns: true, leftToRight: true });
  });

  // The reflow pin: a tile whose entry SERVES an aspect has its final box
  // before its image bytes arrive, and that box does not move when they land.
  // The held `/thumbnail/` response is what makes "before" a real observation.
  test("tiles with a served aspect are stable across their image load", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"], delayMs: 600 });
    await openFiles(page);

    // Both tiles are gated on the held `/thumbnail/` response; the `.txt` tile
    // is deliberately NOT here — its snippet paints off an unheld `/file/`
    // fetch, so "provably unpainted" cannot be guaranteed for it (its shape
    // stability is already covered by the aspect-truth test above).
    const names = ["Whiteboard — sprint plan", "Kitchen sketch"];
    const before = new Map<string, { w: number; h: number; x: number; y: number }>();
    for (const name of names) {
      const tile = card(page, name).locator(".thumb");
      const img = card(page, name).locator("img.thumb__img");
      // Provably BEFORE: the engine has not painted this tile yet.
      expect(await imgPainted(img)).toBe(false);
      const b = (await tile.boundingBox())!;
      expect(b.width).toBeGreaterThan(0);
      before.set(name, { w: b.width, h: b.height, x: b.x, y: b.y });
    }

    for (const name of names) {
      const img = card(page, name).locator("img.thumb__img");
      await expect.poll(() => imgPainted(img), { timeout: 8000 }).toBe(true);
      const b = (await card(page, name).locator(".thumb").boundingBox())!;
      const was = before.get(name)!;
      expect(Math.abs(b.width - was.w)).toBeLessThan(1);
      expect(Math.abs(b.height - was.h)).toBeLessThan(1);
      expect(Math.abs(b.x - was.x)).toBeLessThan(1);
      expect(Math.abs(b.y - was.y)).toBeLessThan(1);
    }
  });

  // The vertical clamp, measured against the token: a pathological scroll caps
  // at 2.5× the column width, a pathological panorama floors at width / 2.5,
  // and both letterbox (`object-fit: contain`) rather than distort.
  test("extreme aspects clamp at 2.5× the column width, letterboxed", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"] });
    await openFiles(page);
    const w = await tileWidth(page);

    const tall = card(page, "Receipt — long scroll").locator(".thumb");
    await expect.poll(async () => (await tall.boundingBox())?.height ?? null).toBeCloseTo(w * 2.5, 0);

    const wide = card(page, "Panorama — coastline").locator(".thumb");
    await expect.poll(async () => (await wide.boundingBox())?.height ?? null).toBeCloseTo(w / 2.5, 0);

    for (const tile of [tall, wide]) {
      await expect
        .poll(() => tile.locator(".thumb__img").evaluate((e) => getComputedStyle(e).objectFit))
        .toBe("contain");
    }
  });
});

// The LIST/SEARCH row rider: rows already preserved aspect at fixed height, but
// learned it from the LOADED image — the lead sat at the 3:4 floor and widened
// on arrival, nudging the row's text. With the aspect pre-set (pre-clamped to
// the class's 2.5× width cap) the lead is final-width from first paint.
test.describe("reflow-free list rows", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  async function openFilesList(page: Page): Promise<void> {
    await openFiles(page);
    await page.getByRole("button", { name: "List view" }).click();
    await freezeMotion(page);
  }

  test("a landscape row's lead and text are final before its thumb loads", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"], delayMs: 600 });
    await openFilesList(page);

    const row = card(page, "Whiteboard — sprint plan");
    const img = row.locator("img.thumb__img");
    expect(await imgPainted(img)).toBe(false); // provably before the bytes

    const listH = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--preview-h-list")),
    );
    const leadBefore = (await row.locator(".thumb").boundingBox())!;
    const titleBefore = (await row.locator(".card__title").boundingBox())!;
    // Reserved WIDE up front: height × (1872/1404), not the 3:4 floor.
    expect(leadBefore.width).toBeCloseTo(listH * (1872 / 1404), 0);

    await expect.poll(() => imgPainted(img), { timeout: 8000 }).toBe(true);
    const leadAfter = (await row.locator(".thumb").boundingBox())!;
    const titleAfter = (await row.locator(".card__title").boundingBox())!;
    expect(Math.abs(leadAfter.width - leadBefore.width)).toBeLessThan(1);
    // THE POINT: the row's text never moved.
    expect(Math.abs(titleAfter.x - titleBefore.x)).toBeLessThan(1);
    expect(Math.abs(titleAfter.y - titleBefore.y)).toBeLessThan(1);
  });

  test("an extreme panorama reserves its CLAMPED width from first paint", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"], delayMs: 600 });
    await openFilesList(page);

    const row = card(page, "Panorama — coastline");
    const img = row.locator("img.thumb__img");
    expect(await imgPainted(img)).toBe(false);

    const listH = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--preview-h-list")),
    );
    // min(7.5, 2.5) × height — the final LETTERBOXED width, reserved before any
    // bytes, so nothing snaps narrower when the CSS cap would otherwise bite.
    const lead = (await row.locator(".thumb").boundingBox())!;
    expect(lead.width).toBeCloseTo(listH * 2.5, 0);

    await expect.poll(() => imgPainted(img), { timeout: 8000 }).toBe(true);
    const after = (await row.locator(".thumb").boundingBox())!;
    expect(Math.abs(after.width - lead.width)).toBeLessThan(1);
  });

  test("the 3:4 floor still stands for a row with nothing to state yet", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"] });
    await openFilesList(page);

    const listH = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--preview-h-list")),
    );
    // A pdf states no shape on the wire — nothing indexes a `/MediaBox` — so its
    // lead is RESERVED at A4 portrait (0.707) until page 0 renders, and the list
    // class's 3:4 min-width then floors that to the same ~64px lead every
    // aspect-less row has always had. Same number as before this type grew a
    // preview, for a different reason, and the reason is the point: the tile is
    // now an `<img>`, and an `<img>` with no `src` measures SQUARE (the 1×1 GIF
    // the styles substitute for the broken-image icon). Left unpinned it
    // reserved an 85px square for a document.
    const lead = card(page, "Appliance manual").locator(".thumb");
    await expect.poll(async () => (await lead.boundingBox())?.width ?? null).toBeCloseTo(listH * 0.75, 0);
  });
});
