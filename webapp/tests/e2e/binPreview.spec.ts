// The recycle bin: previews of trashed notes and their versions.

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, railSettled, contrastRatio, paintedColours, freezeMotion, mockThumbnailBackend, imgInkFraction } from "./helpers/app";
import { mockDocText, noteTextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// Fixture `src/api/binFake.ts`: a folder trashed with two notes, plus an older note four
// days from expiry. Trash never confirms and purge always does; `renderGallery()`
// overwriting the gallery is what closes the bin and leaves bin mode.
import { binRow, openBin, openRowMenu, openFileActions, chooseMenuItem, PDF_BYTES, serveRawBytes } from "./bin.shared";

/** `download_test.note` — the older trashed seed, by id (`src/api/binFake.ts`). */
const BIN_OLD_NOTE_ID = "304";

const SPD_PATH = fileURLToPath(new URL("../../../parsers/spd/tests/fixtures/layers_hidden.spd", import.meta.url));

const SPD_BYTES = readFileSync(SPD_PATH);

const TXT_BODY = "Reading list\n\n- Piranesi\n- A Canticle for Leibowitz\n\nReturn the library books on Friday.";

async function trashAndReopenFromBin(page: Page, viewerRegion: string, rowName: string): Promise<void> {
  const region = page.getByRole("region", { name: viewerRegion });
  await expect(region).toBeVisible();
  await region.getByRole("button", { name: "Move to bin" }).click();
  await expect(page.locator(".bin-toast")).toContainText("Moved");

  // In-app navigation: a reload would rebuild the fake Api and lose the trash.
  await openBin(page);
  await page.locator(".bin__row", { hasText: rowName }).locator("button.bin__open").click();
  await expect(region).toBeVisible();
  await expect(region.locator(".viewer__back-label")).toHaveText("Recycle bin");
}

test.describe("recycle bin", () => {
  /** Trash one of the Files-folder fixtures from its list row — no viewer. The
   *  row's delete is the "…" menu's Move to bin item. */
  async function trashFromFiles(page: Page, name: string): Promise<void> {
    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Files$/ }) })
      .click();
    await page.getByRole("button", { name: "List view" }).click();
    const row = page.locator(".card", { hasText: name });
    await chooseMenuItem(page, row.getByRole("button", { name: `Actions for ${name}` }), "Move to bin");
    await expect(page.locator(".bin-toast")).toContainText(`Moved ${name}`);
  }

  // 120×160 PNG: the image-doc strategy decodes via `createImageBitmap`, so it must be real.
  const IMG_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAAAAADiYvdMAAAAZElEQVR42u3aAQ0AMAgEsfdvmqkAktEzUAOXWipgMBgMBoPBR+E0" +
    "BwaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAyegS03YDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAZ/Cz+nJdLCphXs6QAAAABJ" +
    "RU5ErkJggg==";

  test("a trashed .note preview draws recognized-text ovals and find-in-note works", async ({ page }) => {
    await signedIn(page);
    // Served under the trashed blob's own md5 (`binFake.ts`'s `BlobHash`), not via `fallback`.
    // `download_test.note`: 2 pages, "budget" twice on each.
    await mockDocText(page, {
      [fakeFileHash(BIN_OLD_NOTE_ID)]: noteTextRecord("download_test.note", 2),
    });
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    const findBtn = page.getByRole("button", { name: "Find in this note" });
    await expect(findBtn).toBeEnabled();
    await findBtn.click();
    await page.getByRole("textbox", { name: "Find in this note" }).fill("budget");

    // Generous: the session's first find pays wasm instantiation and the index build.
    await expect(page.locator(".findbar__count")).toContainText("of", { timeout: 20_000 });
    // Ovals come from the bin page-text route; only search stopped being bin-scoped.
    await expect(page.locator(".reader .findbox").first()).toBeVisible();
    await expect(page.locator(".findbar__note")).toBeHidden();
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
  });

  test("a trashed .note browses its version history VIEW-ONLY: previews any version, no per-version Restore", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await freezeMotion(page);

    const cluster = page.locator(".reader").locator(".viewer__bin-actions");
    await openFileActions(page, cluster);
    await expect(page.locator(".menu-portal").getByRole("menuitem", { name: "Version history" })).toBeVisible();
    await expect(page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.locator(".reader__bar").getByRole("button", { name: "Version history" }).click();
    const panel = page.locator(".vh");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".vh__eyebrow")).toHaveText("Version history");
    const versionRows = page.locator(".vh-row");
    await expect(versionRows).toHaveCount(3);
    await expect(versionRows.nth(0).locator("button")).toHaveCount(0);

    await versionRows.nth(1).click();
    await expect(panel).toBeHidden();
    const banner = page.locator(".reader .version-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not the current note");
    // View-only: restore the file first, then a version.
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeHidden();
  });

  test("restoring the whole trashed .note from the bin viewer still works", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
    await expect(page.locator(".reader.is-open")).toBeVisible();

    const cluster = page.locator(".reader").locator(".viewer__bin-actions");
    await chooseMenuItem(page, cluster.getByRole("button", { name: "File actions" }), "Restore");
    await expect(page.locator(".bin-toast")).toContainText("Restored download_test.note");
    await expect(page.locator(".bin__row", { hasText: "download_test.note" })).toHaveCount(0);
  });

  test("leaving by the rail closes the bin and restores the folder controls", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Note$/ }) })
      .click();

    await expect(page.locator(".bin")).toHaveCount(0);
    await expect(page.locator(".segmented")).toBeVisible();
    await expect(page.locator(".select")).toBeVisible();
    await expect(page.locator("#empty-bin")).toBeHidden();
    await expect(binRow(page)).toHaveAttribute("aria-current", "false");
  });

  test("Delete permanently is legible and red in the menu, and clears the 24px target", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);

    const row = await openRowMenu(page, "download_test.note", "download_test.note");
    const del = page.locator(".menu-portal").getByRole("menuitem", { name: "Delete permanently" });
    await expect(del).toBeVisible();
    await expect(del).toHaveClass(/menu__item--danger/);
    const { color, background } = await paintedColours(del);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);

    const box = await del.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.width).toBeGreaterThanOrEqual(24);
  });

  // Dropping the rule and tightening padding are one decision; either alone leaves the
  // group reading further apart than unrelated rows.
  test("a trashed folder clusters with its children, and the group ends where the next entry begins", async ({
    page,
  }) => {
    await signedIn(page);
    await page.goto("/");
    await openBin(page);
    // Freeze first: a running transition reports intermediate padding.
    await freezeMotion(page);

    const rows = page.locator(".bin__row");
    await expect(rows.nth(0)).toContainText("nested_to_remove");
    await expect(rows.nth(1)).toHaveClass(/is-child/);
    await expect(rows.nth(2)).toHaveClass(/is-child/);

    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        full: parseFloat(cs.getPropertyValue("--row-pad-y")),
        tight: parseFloat(cs.getPropertyValue("--row-pad-y-tight")),
      };
    });
    expect(tokens.tight).toBeLessThan(tokens.full);

    // Retried: the bin re-renders when its refresh lands, and orphans report "" styles.
    const readGroup = () =>
      page.locator(".bin__rows").first().evaluate((g) => {
        const out = [];
        for (const r of g.querySelectorAll(".bin__row")) {
          const cs = getComputedStyle(r);
          if (!cs.paddingTop) return null; // orphaned mid-repaint
          out.push({
            rule: parseFloat(cs.borderBottomWidth),
            top: parseFloat(cs.paddingTop),
            bottom: parseFloat(cs.paddingBottom),
          });
        }
        // Fewer than three rows is a half-rendered list.
        return out.length >= 3 ? out : null;
      });

    const group = async () => {
      for (let attempt = 0; ; attempt++) {
        const read = await readGroup().catch(() => null);
        if (read !== null) return read;
        if (attempt >= 20) throw new Error("bin rows kept detaching (20 attempts)");
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    const [folder, middle, last] = await group();
    expect(folder).toEqual({ rule: 0, top: tokens.full, bottom: tokens.tight });
    expect(middle).toEqual({ rule: 0, top: tokens.tight, bottom: tokens.tight });
    expect(last!.top).toBe(tokens.tight);
    expect(last!.bottom).toBe(tokens.full);

    // The last child is also last in its date group, where `:last-child` hides the border
    // anyway, so a stranger row is appended. Appended and read in one evaluate, since a
    // re-render discards it.
    const groupWithStranger = async () => {
      for (let attempt = 0; ; attempt++) {
        const read = await page
          .locator(".bin__rows")
          .first()
          .evaluate((g) => {
            g.querySelector(".bin__row[data-stranger]")?.remove();
            const stranger = document.createElement("div");
            stranger.className = "bin__row";
            stranger.setAttribute("data-stranger", "");
            g.append(stranger);
            const out = [];
            for (const r of g.querySelectorAll(".bin__row:not([data-stranger])")) {
              const cs = getComputedStyle(r);
              if (!cs.paddingTop) return null;
              out.push({
                rule: parseFloat(cs.borderBottomWidth),
                top: parseFloat(cs.paddingTop),
                bottom: parseFloat(cs.paddingBottom),
              });
            }
            return out.length === 3 && g.contains(stranger) ? out : null;
          })
          .catch(() => null);
        if (read !== null) return read;
        if (attempt >= 20) throw new Error("bin rows kept detaching (20 attempts)");
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    const [folderAfter, middleAfter, lastAfter] = await groupWithStranger();
    expect(folderAfter).toEqual(folder);
    expect(middleAfter).toEqual(middle);
    expect(lastAfter!.rule).toBeGreaterThan(0);
    expect(lastAfter!.bottom).toBe(tokens.full);
    const colour = await page
      .locator(".bin__rows .bin__row.is-child")
      .last()
      .evaluate((e) => getComputedStyle(e).borderBottomColor);
    // A 1px border of `rgba(…, 0)` measures as present and paints as nothing.
    expect(colour).not.toMatch(/,\s*0\s*\)$/);
  });

  // --- non-note viewers from the bin ---

  test("a trashed .spd opens its real viewer off the bin route, and Restore returns it", async ({ page }) => {
    await signedIn(page);
    const raw = await serveRawBytes(page, "application/octet-stream", SPD_BYTES);
    await page.goto("/#/note/174");
    await freezeMotion(page);

    await trashAndReopenFromBin(page, "Sketch viewer", "Kitchen sketch");

    // The live route 404s for trashed files.
    const region = page.getByRole("region", { name: "Sketch viewer" });
    await expect(region.locator(".spd-canvas-wrap .spd-layer-canvas")).toHaveCount(4);
    expect(raw.binHits()).toBeGreaterThan(0);

    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();
    const cluster = region.locator(".viewer__bin-actions");
    await expect(cluster.locator(".life__label")).toContainText("days left");
    await openFileActions(page, cluster);
    const restore = page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" });
    const purge = page.locator(".menu-portal").getByRole("menuitem", { name: "Delete permanently" });
    await expect(restore).toBeVisible();
    await expect(purge).toBeVisible();
    await expect(purge).toHaveClass(/menu__item--danger/);

    await restore.click();
    await expect(page.locator("dialog.confirm")).toBeHidden();
    await expect(page.locator(".bin-toast")).toContainText("Restored Kitchen sketch");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "Kitchen sketch" })).toHaveCount(0);
    await expect(binRow(page).locator(".nav__count")).toHaveText("4");
  });

  test("a trashed .txt opens its real viewer, and Delete permanently confirms first", async ({ page }) => {
    await signedIn(page);
    const raw = await serveRawBytes(page, "text/plain; charset=utf-8", TXT_BODY);
    await page.goto("/#/note/177");
    await freezeMotion(page);

    await trashAndReopenFromBin(page, "Text viewer", "readme");

    const region = page.getByRole("region", { name: "Text viewer" });
    await expect(region.locator(".txt__sheet")).toContainText("Return the library books on Friday.");
    expect(raw.binHits()).toBeGreaterThan(0);
    await expect(region.locator('[aria-label="Download"]')).toHaveAttribute(
      "href",
      /^\/api\/controlplane\/bin\/file\/177\?/,
    );

    const cluster = region.locator(".viewer__bin-actions");
    const openPurge = async (): Promise<void> => {
      await chooseMenuItem(page, cluster.getByRole("button", { name: "File actions" }), "Delete permanently");
    };
    await openPurge();
    const dialog = page.locator("dialog.confirm");
    await expect(dialog.locator("h2")).toHaveText("Delete readme permanently?");
    await dialog.locator("button", { hasText: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(region).toBeVisible();

    await openPurge();
    await dialog.locator(".is-danger").click();
    await expect(page.locator(".bin-toast")).toContainText("Deleted readme");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "readme" })).toHaveCount(0);
    await expect(binRow(page).locator(".nav__count")).toHaveText("4");
  });

  test("a trashed .pdf offers Restore and Delete permanently, like every other viewer", async ({
    page,
  }) => {
    // Regression: the PDF viewer offered no bin controls for a trashed PDF.
    await signedIn(page);
    const raw = await serveRawBytes(page, "application/pdf", PDF_BYTES);
    await page.goto("/#/note/178");
    await freezeMotion(page);

    await trashAndReopenFromBin(page, "PDF viewer", "Appliance manual");

    const region = page.getByRole("region", { name: "PDF viewer" });
    // A viewer minting the live URL would sit on its placeholder.
    await expect.poll(
      () =>
        page.evaluate(() => {
          const c = document.querySelector(".pdf-page") as HTMLCanvasElement | null;
          return c && c.width ? c.width : 0;
        }),
      { timeout: 20_000 },
    ).toBeGreaterThan(0);
    expect(raw.binHits()).toBeGreaterThan(0);

    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();
    const cluster = region.locator(".viewer__bin-actions");
    await expect(cluster.locator(".life__label")).toContainText("days left");
    await openFileActions(page, cluster);
    const restore = page.locator(".menu-portal").getByRole("menuitem", { name: "Restore" });
    const purge = page.locator(".menu-portal").getByRole("menuitem", { name: "Delete permanently" });
    await expect(restore).toBeVisible();
    await expect(purge).toHaveClass(/menu__item--danger/);

    await restore.click();
    await expect(page.locator(".bin-toast")).toContainText("Restored Appliance manual");
    await expect(page.locator(".bin")).toBeVisible();
    await expect(page.locator(".bin__row", { hasText: "Appliance manual" })).toHaveCount(0);
  });

  // --- bin tiles use the library's thumbnail facade ---
  // `bin: true` routes raw fetches to the bin endpoint.

  test("a trashed .spd and .txt paint their REAL previews through the facade, not doc glyphs", async ({ page }) => {
    await signedIn(page);
    const hits = await mockThumbnailBackend(page, { textIds: ["177"] });
    await page.goto("/");
    await railSettled(page);

    await trashFromFiles(page, "Kitchen sketch");
    await trashFromFiles(page, "readme");
    await openBin(page);

    const spdRow = page.locator(".bin__row", { hasText: "Kitchen sketch" });
    const spd = spdRow.locator(".bin__thumb img");
    await expect(spd).toHaveCount(1);
    await expect.poll(() => imgInkFraction(spd), { timeout: 6000 }).toBeGreaterThan(0.02);
    // Trashing does not rewrite a blob, so the md5 is the live one.
    expect(hits.thumbnailHits(fakeFileHash("174"))).toBeGreaterThan(0);
    await expect(spdRow.locator(".bin__thumb")).toHaveClass(/has-aspect/);

    const txt = page.locator(".bin__row", { hasText: "readme" }).locator(".bin__thumb img");
    await expect(txt).toHaveCount(1);
    await expect.poll(() => imgInkFraction(txt), { timeout: 6000 }).toBeGreaterThan(0.004);

    // The facade keys by hash alone, so the raw blob is read once across both scopes.
    expect(hits.fileHits("177") + hits.binFileHits("177")).toBe(1);
  });

  test("a trashed .txt tile reads its bytes off the BIN route when the cache is cold", async ({ page }) => {
    // The bin must be the first place the facade meets this blob: live `/file/{id}` uses
    // `deleted = 0`. Trashed from a deep-linked viewer, whose fetch does not warm the facade.
    await signedIn(page);
    const hits = await mockThumbnailBackend(page, { textIds: ["177"] });
    await page.goto("/#/note/177");
    await freezeMotion(page);

    const region = page.getByRole("region", { name: "Text viewer" });
    await expect(region).toBeVisible();
    await region.getByRole("button", { name: "Move to bin" }).click();
    await expect(page.locator(".bin-toast")).toContainText("Moved");

    const liveBefore = hits.fileHits("177");

    // In-app, never a goto: a reload rebuilds the fake `Api` and loses the trash.
    await openBin(page);

    const txt = page.locator(".bin__row", { hasText: "readme" }).locator(".bin__thumb img");
    await expect(txt).toHaveCount(1);
    await expect.poll(() => imgInkFraction(txt), { timeout: 6000 }).toBeGreaterThan(0.004);
    expect(hits.binFileHits("177")).toBeGreaterThan(0);
    expect(hits.fileHits("177")).toBe(liveBefore);
  });
});
