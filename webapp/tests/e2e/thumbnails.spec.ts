import { test, expect, type Page } from "@playwright/test";
import { signedIn, mockThumbnailBackend, imgInkFraction, freezeMotion } from "./helpers/app";
import { fakeFileHash } from "../../src/api/fake";

// The thumbnail facade (§C): every file type resolves to a displayable tile, so
// the gallery never shows a blank where a preview could be. The fixture's `Files`
// folder holds one of each kind — a `.note`, a png, an `.spd`, a `.txt` and a
// `.pdf` — and each takes its own strategy:
//
//   note  → its server-extracted COVER when one exists (200 from /thumbnail/),
//           else the SNPG page rendered to a WebP blob, shown in an <img>
//   png   → a native <img> off the raw-file endpoint
//   spd   → its extracted embedded thumbnail, transcoded to WebP, in an <img>
//   txt   → a rasterised snippet of its first lines, in an <img>
//   pdf   → its page 0, rendered client-side through the MuPDF wasm, in an <img>
//           — falling back to the facade's glyph when the bytes will not open
//
// The gallery displays every real preview as an <img src="blob:…"> now, not a
// canvas — the browser owns decode/eviction. "Ink" here is the pixel-probe from
// helpers/app.ts, run against the <img> (drawn to an offscreen canvas): a blank
// placeholder reads ~0, real content clearly higher — the same probe that proves
// lazy rendering.

const card = (page: Page, name: string) => page.locator(".card", { hasText: name });
const INK = 0.004; // comfortably above a blank placeholder, below real content
// The mock cover's black band fills ~36% of the tile — a level the fake
// renderer's thin pseudo-handwriting never approaches. Reading above this is
// what PROVES a note tile's pixels came from /thumbnail/, not the fallback.
const COVER_INK = 0.15;

// The fixture `.note` in `Files`, addressed by the whole-file hash its tile
// puts in `/thumbnail/{hash}` — the knob that decides whether the mock serves
// it a cover (200) or answers like the real server for a coverless note (404).
const NOTE_HASH = fakeFileHash("n-files-note");

async function openFiles(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".card--folder", { hasText: "Files" }).click();
  await expect(card(page, "Meeting notes — Q3")).toBeVisible();
  await freezeMotion(page);
}

test.describe("thumbnails across file types", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test("a gallery of mixed types every one shows a real tile, not a blank", async ({ page }) => {
    // The `.note` is COVERLESS here (404, like most real notes), so this test
    // keeps proving the client-render fallback end to end; the cover-preferred
    // path has its own test below.
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"], coverless: [NOTE_HASH] });
    await openFiles(page);

    // note → the rendered page, painted into an <img> from a WebP blob.
    await expect
      .poll(() => imgInkFraction(card(page, "Meeting notes — Q3").locator("img.thumb__img")), { timeout: 6000 })
      .toBeGreaterThan(INK);

    // image → a native <img> that really decoded.
    const img = card(page, "Screenshot — dashboard").locator("img.thumb__img");
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth))
      .toBeGreaterThan(0);

    // .spd → its extracted embedded thumbnail, in an <img> — NOT the glyph tile,
    // and NOT an on-screen canvas (the gallery has none any more).
    const spd = card(page, "Kitchen sketch");
    await expect(spd.locator("img.thumb__img")).toBeVisible();
    await expect(spd.locator("canvas")).toHaveCount(0);
    await expect(spd.locator(".thumb--file")).toHaveCount(0);
    await expect.poll(() => imgInkFraction(spd.locator("img.thumb__img")), { timeout: 6000 }).toBeGreaterThan(INK);

    // .pdf → the facade's <img> as well. `mockThumbnailBackend` serves PNG bytes
    // for every raw file, so MuPDF refuses them and this tile lands on the
    // facade's GLYPH — which is exactly the floor worth pinning here: a document
    // that will not render still paints something, inside the same <img>, rather
    // than leaving an empty tile. The real page-0 render is
    // `pdfThumbnail.spec.ts`, which serves genuine PDF bytes over byte ranges.
    const pdf = card(page, "Appliance manual");
    await expect(pdf.locator("img.thumb__img")).toBeVisible();
    await expect(pdf.locator(".thumb--file")).toHaveCount(0);
    await expect
      .poll(() => pdf.locator("img.thumb__img").evaluate((e: HTMLImageElement) => e.src.startsWith("blob:")))
      .toBe(true);
  });

  test("a .txt tile renders a snippet of its first lines, not a blank", async ({ page }) => {
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"], coverless: [NOTE_HASH] });
    await openFiles(page);

    const txt = card(page, "readme");
    // A real <img> preview, not the static glyph a `.txt` used to collapse to.
    await expect(txt.locator("img.thumb__img")).toBeVisible();
    await expect(txt.locator("canvas")).toHaveCount(0);
    await expect(txt.locator(".thumb--file")).toHaveCount(0);
    // And it is genuinely painted with the snippet's ink, not the blank placeholder.
    await expect.poll(() => imgInkFraction(txt.locator("img.thumb__img")), { timeout: 6000 }).toBeGreaterThan(INK);
  });

  test("a .note with a cover prefers it over the client render", async ({ page }) => {
    // No `coverless` entry: /thumbnail/{NOTE_HASH} answers 200 with the mock
    // cover, the way the real server serves a note whose user set one.
    await mockThumbnailBackend(page, { textIds: ["n-files-readme"] });
    await openFiles(page);

    const note = card(page, "Meeting notes — Q3");
    await expect(note.locator("img.thumb__img")).toBeVisible();
    await expect(note.locator("canvas")).toHaveCount(0);
    await expect(note.locator(".thumb--file")).toHaveCount(0);
    // The ink level is the discriminator: the cover's solid band reads ~0.36,
    // far above anything the fake page renderer ever paints — so pixels this
    // dark can only have come through the cover fetch, not the fallback.
    await expect
      .poll(() => imgInkFraction(note.locator("img.thumb__img")), { timeout: 6000 })
      .toBeGreaterThan(COVER_INK);
  });
});
