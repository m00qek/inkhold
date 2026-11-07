import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, mockThumbnailBackend, imgPainted, freezeMotion, railSettled } from "./helpers/app";

// The `Files` fixture has one entry per aspect source plus both clamp extremes
// (7.5:1 panorama, 0.13:1 scroll).

const card = (page: Page, name: string) => page.locator(".card", { hasText: name });

/** Read from the live token so the tests do not restate it. */
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

/** Null while the node is being repainted. */
async function tileRatio(tile: Locator): Promise<number | null> {
  const box = await tile.boundingBox();
  if (!box || box.height === 0) return null;
  return box.width / box.height;
}

test.describe("masonry icon gallery", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test("mixed gallery: every tile's aspect matches its source, at uniform width", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["177"] });
    await openFiles(page);
    const w = await tileWidth(page);

    const cases: [string, number][] = [
      ["Meeting notes — Q3", 120 / 160], // cover dims (cover-else-page-1 rule)
      ["Whiteboard — sprint plan", 1872 / 1404], // landscape page-1 EFFECTIVE dims
      ["Kitchen sketch", 600 / 800], // .spd thumb dims
      ["readme", 3 / 4], // the .txt client constant
      // No served shape: reserves A4 then learns from the glyph (mock serves PNG bytes), so ~3:4.
      ["Appliance manual", 3 / 4],
      ["Panorama — coastline", 2.5], // 7.5 floored at the 2.5× wide clamp
      ["Receipt — long scroll", 1 / 2.5], // 0.13 capped at the 2.5× tall clamp
    ];
    for (const [name, want] of cases) {
      const tile = card(page, name).locator(".thumb");
      await expect
        .poll(async () => tileRatio(tile), { message: `${name} tile aspect` })
        .toBeCloseTo(want, 1);
      await expect.poll(async () => (await tile.boundingBox())?.width ?? null).toBeCloseTo(w, 0);
    }

    const img = card(page, "Screenshot — dashboard").locator(".thumb");
    await expect.poll(async () => tileRatio(img), { timeout: 6000 }).toBeCloseTo(1.0, 1);
  });

  // Pins the behaviour, not `grid-auto-flow: row`.
  test("the sort order reads left-to-right across the masonry", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["177"] });
    await openFiles(page);

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
        // A column-major layout fails this at every column break.
        const leftToRight = boxes.every((b, i) => {
          if (i === 0) return true;
          const prev = boxes[i - 1]!;
          return b.y > prev.y + 0.5 || (Math.abs(b.y - prev.y) <= 0.5 && b.x > prev.x);
        });
        return { columns: columns > 1, leftToRight };
      })
      .toEqual({ columns: true, leftToRight: true });
  });

  test("tiles with a served aspect are stable across their image load", async ({ page }) => {
    // Held, not delayed: a fixed delay lapses under a busy machine before the
    // "unpainted" measurements are taken.
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await mockThumbnailBackend(page, { textIds: ["177"], hold });
    await openFiles(page);

    // The `.txt` tile is excluded: it paints off an unheld `/file/` fetch.
    const names = ["Whiteboard — sprint plan", "Kitchen sketch"];
    const before = new Map<string, { w: number; h: number; x: number; y: number }>();
    for (const name of names) {
      const tile = card(page, name).locator(".thumb");
      const img = card(page, name).locator("img.thumb__img");
      expect(await imgPainted(img), `${name} painted before its thumbnail was served`).toBe(false);
      const b = (await tile.boundingBox())!;
      expect(b.width).toBeGreaterThan(0);
      before.set(name, { w: b.width, h: b.height, x: b.x, y: b.y });
    }
    release();

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

  test("extreme aspects clamp at 2.5× the column width, letterboxed", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["177"] });
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
    // Held, not delayed: a fixed delay lapses on a busy machine before the
    // "before the bytes" measurements are taken.
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await mockThumbnailBackend(page, { textIds: ["177"], hold });
    await openFilesList(page);

    const row = card(page, "Whiteboard — sprint plan");
    const img = row.locator("img.thumb__img");
    expect(await imgPainted(img)).toBe(false); // provably before the bytes

    const listH = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--preview-h-list")),
    );
    const leadBefore = (await row.locator(".thumb").boundingBox())!;
    const titleBefore = (await row.locator(".card__title").boundingBox())!;
    expect(leadBefore.width).toBeCloseTo(listH * (1872 / 1404), 0);
    release();

    await expect.poll(() => imgPainted(img), { timeout: 8000 }).toBe(true);
    const leadAfter = (await row.locator(".thumb").boundingBox())!;
    const titleAfter = (await row.locator(".card__title").boundingBox())!;
    expect(Math.abs(leadAfter.width - leadBefore.width)).toBeLessThan(1);
    expect(Math.abs(titleAfter.x - titleBefore.x)).toBeLessThan(1);
    expect(Math.abs(titleAfter.y - titleBefore.y)).toBeLessThan(1);
  });

  test("an extreme panorama reserves its CLAMPED width from first paint", async ({ page }) => {
    // Held, not delayed: a fixed delay lapses on a busy machine before the
    // "first paint" measurement is taken.
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await mockThumbnailBackend(page, { textIds: ["177"], hold });
    await openFilesList(page);

    const row = card(page, "Panorama — coastline");
    const img = row.locator("img.thumb__img");
    expect(await imgPainted(img)).toBe(false);

    const listH = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--preview-h-list")),
    );
    const lead = (await row.locator(".thumb").boundingBox())!;
    expect(lead.width).toBeCloseTo(listH * 2.5, 0);
    release();

    await expect.poll(() => imgPainted(img), { timeout: 8000 }).toBe(true);
    const after = (await row.locator(".thumb").boundingBox())!;
    expect(Math.abs(after.width - lead.width)).toBeLessThan(1);
  });

  test("the 3:4 floor still stands for a row with nothing to state yet", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["177"] });
    await openFilesList(page);

    const listH = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--preview-h-list")),
    );
    // A pdf states no shape on the wire; an `<img>` with no `src` measured square (85px) until pinned.
    const lead = card(page, "Appliance manual").locator(".thumb");
    await expect.poll(async () => (await lead.boundingBox())?.width ?? null).toBeCloseTo(listH * 0.75, 0);
  });
});
