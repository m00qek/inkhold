// The recycle bin: trashed files in their viewers, and the bin viewer URL.

import { test, expect, type Page } from "@playwright/test";
import { signedIn, railSettled, mockThumbnailBackend, imgInkFraction, imgPainted } from "./helpers/app";
import { serveRanges } from "./helpers/pdfRange";
import { fakeFileHash } from "../../src/api/fake";

// Fixture `src/api/binFake.ts`: a folder trashed with two notes, plus an older note four
// days from expiry. Trash never confirms and purge always does; `renderGallery()`
// overwriting the gallery is what closes the bin and leaves bin mode.
import { openBin, chooseMenuItem, PDF_BYTES, serveRawBytes, reader, trashFromFiles, IMG_PNG_BASE64 } from "./bin.shared";

test.describe("recycle bin", () => {
  test("a trashed .pdf renders its page 0 off the BIN route, and learns the page's shape", async ({ page }) => {
    // `two-page.pdf`'s page 0 is landscape, so the final lead shape proves the page was read.
    await signedIn(page);
    await mockThumbnailBackend(page, { textIds: ["177"] });
    const served = await serveRanges(page, PDF_BYTES, undefined, (url) =>
      url.pathname === "/api/controlplane/bin/file/178",
    );
    await page.goto("/");
    await railSettled(page);

    await trashFromFiles(page, "Appliance manual");
    await openBin(page);

    const row = page.locator(".bin__row", { hasText: "Appliance manual" });
    const img = row.locator(".bin__thumb img");
    await expect(img).toHaveCount(1);
    await expect.poll(() => imgInkFraction(img), { timeout: 20_000 }).toBeGreaterThan(0.02);
    expect(served.count()).toBeGreaterThan(0);

    await expect(row.locator(".bin__thumb")).toHaveClass(/has-aspect/);
    await expect
      .poll(
        async () => {
          const box = await row.locator(".bin__thumb").boundingBox();
          return box && box.height > 0 ? box.width / box.height : null;
        },
        { timeout: 20_000 },
      )
      .toBeCloseTo(2, 1);
  });

  test("a trashed image is tier-served off the bin route, aspect-corrected, and memoised", async ({ page }) => {
    await signedIn(page);
    // Both scopes are served; only the bin route is tallied.
    const png = Buffer.from(IMG_PNG_BASE64, "base64");
    const raw = await serveRawBytes(page, "image/png", png);
    await page.goto("/");
    await railSettled(page);

    await trashFromFiles(page, "Screenshot — dashboard");
    await openBin(page);

    const row = page.locator(".bin__row", { hasText: "Screenshot — dashboard" });
    const img = row.locator(".bin__thumb img");
    // The tile shows the facade's downscaled WebP, never the raw file.
    await expect.poll(() => imgPainted(img), { timeout: 6000 }).toBe(true);
    await expect.poll(() => imgInkFraction(img), { timeout: 6000 }).toBeGreaterThan(0.02);
    expect(raw.binHits()).toBeGreaterThan(0);

    // Images state no `thumbAspect`, so the decoded 120×160 is the truth.
    await expect(row.locator(".bin__thumb")).toHaveClass(/has-aspect/);
    await expect
      .poll(() =>
        row.locator(".bin__thumb").evaluate((t) => {
          const [w, h] = getComputedStyle(t).aspectRatio.split("/").map((n) => parseFloat(n));
          return Math.round((w / (h || 1)) * 1000) / 1000;
        }),
      )
      .toBe(0.75);

    // The facade memoised the source dims under the content hash.
    await expect
      .poll(
        () =>
          page.evaluate(
            (hash: string) =>
              new Promise((resolve) => {
                const open = indexedDB.open("sn-dims", 1);
                open.onerror = () => resolve(null);
                open.onsuccess = () => {
                  const db = open.result;
                  try {
                    const req = db.transaction("dims", "readonly").objectStore("dims").get(hash);
                    req.onsuccess = () => {
                      const r = req.result as { w: number; h: number } | undefined;
                      db.close();
                      resolve(r ? { w: r.w, h: r.h } : null);
                    };
                    req.onerror = () => {
                      db.close();
                      resolve(null);
                    };
                  } catch {
                    db.close();
                    resolve(null);
                  }
                };
              }),
            fakeFileHash("173"),
          ),
        { timeout: 6000 },
      )
      .toEqual({ w: 120, h: 160 });

    // A repaint is served from the tier cache, with no second raw fetch.
    const before = raw.binHits();
    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Note$/ }) })
      .click();
    await openBin(page);
    const again = page.locator(".bin__row", { hasText: "Screenshot — dashboard" }).locator(".bin__thumb img");
    await expect.poll(() => imgPainted(again), { timeout: 6000 }).toBe(true);
    expect(raw.binHits()).toBe(before);
  });
});

// --- recycle-bin viewer URL ---
// `#/bin/note/:id/page/:n`: the live route would 404 a trashed blob. Gone files age out
// to the listing with a notice.
test.describe("recycle-bin viewer URL", () => {
  test("addresses the open trashed file under #/bin, tracks the page, and a reload reopens it there", async ({
    page,
  }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    const reader = page.locator(".reader");
    await expect(reader).toBeVisible();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");
    // The first page collapses to the bare form.
    await expect(page).toHaveURL(/#\/bin\/note\/304$/);

    await reader.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/#\/bin\/note\/304\/page\/2$/);
    const at = page.url();

    await page.reload();
    await expect(page.locator(".reader")).toBeVisible();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");
    expect(page.url()).toBe(at);
  });

  test("a bin deep link opened COLD reopens the trashed file, and Back leaves for the listing", async ({ page }) => {
    await signedIn(page);
    // Cold boot: `openBinNote` must load the bin listing before it can find the entry.
    await page.goto("/#/bin/note/304");
    await expect(page.locator(".reader")).toBeVisible();
    await expect(page.locator("#back-label, .backbtn")).toContainText("Recycle bin");
    await expect(page).toHaveURL(/#\/bin\/note\/304$/);

    await expect(reader(page).getByRole("button", { name: "Move to bin" })).toBeHidden();

    await page.locator(".backbtn").first().click();
    await expect(page).toHaveURL(/#\/bin$/);
    await expect(page.locator(".bin__row").first()).toBeVisible();
  });

  test("a bin deep link to a file no longer in the bin falls back to the listing with a notice", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/bin/note/t-does-not-exist");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page).toHaveURL(/#\/bin$/);
    await expect(page.locator(".toast")).toContainText("no longer in the recycle bin");
  });
});
