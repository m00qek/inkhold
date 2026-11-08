// The library rail and gallery: folder meta, cards and listings.

import { test, expect, type Page } from "@playwright/test";
import { asSaved } from "./helpers/download";
import { readFile } from "node:fs/promises";
import { signedIn, contrastRatio, paintedColours, railSettled, freezeMotion } from "./helpers/app";
import { openCategory } from "./library.shared";

test.describe("library rail + gallery", () => {
  // A folder row counts items; inside, the head splits them into folders and docs.
  test.describe("the gallery section head", () => {
    const head = (page: Page) => page.locator("#gallery .section-head").first();

    test("counts folders and docs separately, with singulars", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");

      await openCategory(page, "Note");
      await expect(head(page)).toHaveText("1 folder · 4 docs");

      await page.getByRole("button", { name: "List view" }).click();
      await expect(page.locator(".card--folder", { hasText: "Projects" }).locator(".card__meta")).toHaveText("2 items");
      await openCategory(page, "Projects");
      await expect(head(page)).toHaveText("2 docs");
    });

    test("says docs for PDFs and screenshots, never notes", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");

      await openCategory(page, "Document");
      await expect(head(page)).toHaveText("4 docs");

      await openCategory(page, "Screenshot");
      await expect(head(page)).toHaveText("2 docs");
      await expect(head(page)).not.toContainText("note");
    });

    test("singular halves, and the root's folder-only case", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await expect(page.getByRole("group", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

      // Six categories plus promoted NOTE/Scratch, Archive and Files.
      await expect(head(page)).toHaveText("9 folders");
      await expect(head(page)).not.toContainText("doc");

      await openCategory(page, "Inbox");
      await expect(head(page)).toHaveText("1 doc");
    });
  });

  test("a folder's meta says items, and an empty one says Empty", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await page.getByRole("button", { name: "List view" }).click();

    const exportRow = page.locator(".card--folder", { hasText: "EXPORT" });
    await expect(exportRow.locator(".card__meta")).toHaveText("Empty");

    await expect(page.locator(".card--folder", { hasText: "INBOX" }).locator(".card__meta")).toHaveText("1 item");
    await expect(page.locator(".card--folder", { hasText: "SCREENSHOT" }).locator(".card__meta")).toHaveText("2 items");
  });

  test.describe("card badge + recognized-text marker", () => {
    const card = (page: Page, name: string) => page.locator(".card", { hasText: name });

    test("the badge shows each file's own type, not a blanket 'note'", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");

      await openCategory(page, "Document");
      await expect(card(page, "Attention Is All You Need").locator(".card__badge")).toHaveText("note");
      await expect(card(page, "Apartment lease").locator(".card__badge")).toHaveText("pdf");

      // These names carry no ".png", so the badge comes from the server's `fileType`.
      await openCategory(page, "Screenshot");
      await expect(card(page, "pricing page").locator(".card__badge")).toHaveText("png");
    });

    test("the recognized-text marker appears only on notes that have it, with an accessible name", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");

      const withText = card(page, "Weekly review");
      const withoutText = card(page, "Ideas & scratch");
      await expect(withText).toBeVisible();
      await expect(withoutText).toBeVisible();

      await expect(withText.locator(".card__ocr")).toBeVisible();
      await expect(withoutText.locator(".card__ocr")).toHaveCount(0);

      const marker = withText.getByRole("img", { name: "Has recognised text" });
      await expect(marker).toBeVisible();
      await expect(marker.locator("svg")).toBeVisible();

      // Sized in CSS and grouped with the badge at top-left. Polled: the SWR refetch repaints.
      await expect
        .poll(async () => {
          const m = await withText.locator(".card__ocr").boundingBox();
          const b = await withText.locator(".card__badge").boundingBox();
          const t = await withText.locator(".thumb").boundingBox();
          if (!m || !b || !t) return null;
          return {
            sized: m.width > 0 && m.height > 0,
            rightOfBadge: m.x > b.x + b.width,
            adjacent: m.x - (b.x + b.width) < 6,
            groupedLeft: Math.abs(b.x - t.x - 8) < 1.5,
            notMirrored: t.x + t.width - (m.x + m.width) > 20,
          };
        })
        .toEqual({ sized: true, rightOfBadge: true, adjacent: true, groupedLeft: true, notMirrored: true });
    });

    // Styled only by tokens and a component class, so check contrast in both themes.
    for (const scheme of ["light", "dark"] as const) {
      test(`the marker stays legible in ${scheme} mode`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await signedIn(page);
        await page.goto("/");
        await railSettled(page);
        await openCategory(page, "Note");

        const marker = card(page, "Weekly review").locator(".card__ocr");
        await expect(marker).toBeVisible();

        const { stroke, background } = await paintedColours(marker);
        expect(stroke).not.toBeNull();
        expect(contrastRatio(stroke!, background)).toBeGreaterThan(3);
      });
    }

    // List view used to `display: none` both overlays.
    test("list view keeps both badges, as the row's first line", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");

      const withText = card(page, "Weekly review");
      await expect(withText.locator(".card__ocr")).toBeVisible();

      await page.getByRole("button", { name: "List view" }).click();
      await expect(withText.locator(".card__badge")).toBeVisible();
      await expect(withText.locator(".card__ocr")).toBeVisible();
      await expect(withText.locator(".card__badge")).toHaveText("note");

      const marks = withText.locator(".card__marks");
      await expect(marks).toHaveCount(1);
      await expect(withText.locator(".card__body .card__marks")).toHaveCount(1);
      await expect(withText.locator(".thumb .card__marks")).toHaveCount(0);
    });

    // The meta sits 5px short of flush on purpose (see the CSS).
    test("list view: the row is three lines aligned to the thumb's edges", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");
      await page.getByRole("button", { name: "List view" }).click();

      const row = card(page, "Weekly review");
      await expect(row.locator(".card__marks")).toBeVisible();

      // Polled as one reading: the SWR refetch repaints the gallery.
      await expect
        .poll(async () => {
          const marks = await row.locator(".card__marks").boundingBox();
          const title = await row.locator(".card__title").boundingBox();
          const meta = await row.locator(".card__meta").boundingBox();
          const thumb = await row.locator(".thumb").boundingBox();
          if (!marks || !title || !meta || !thumb) return null;
          const bottomGap = thumb.y + thumb.height - (meta.y + meta.height);
          return {
            thumbWide: Math.abs(thumb.width - 64) < 1.5,
            aspectKept: Math.abs(thumb.height - 64 / 0.75) < 2,
            badgesFirst: marks.y + marks.height <= title.y + 1,
            metaLast: title.y + title.height <= meta.y + 1,
            topAligned: Math.abs(marks.y - thumb.y) < 4,
            nearBottom: bottomGap > 0 && bottomGap < 14,
          };
        })
        .toEqual({
          thumbWide: true,
          aspectKept: true,
          badgesFirst: true,
          metaLast: true,
          topAligned: true,
          nearBottom: true,
        });
    });
  });

  test.describe("list row overflow menu", () => {
    const card = (page: Page, name: string) => page.locator(".card", { hasText: name });
    const more = (page: Page, name: string) => card(page, name).getByRole("button", { name: `Actions for ${name}` });

    test("the list row uses the SAME sectioned menu the grid does", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Document");

      await expect(page.locator(".card__actions")).toHaveCount(0);
      await expect(card(page, "Attention Is All You Need").locator(".card__menu")).toHaveCount(1);

      await page.getByRole("button", { name: "List view" }).click();

      await more(page, "Attention Is All You Need").click();
      const pop = page.locator(".menu-portal .menu__pop");
      await expect(pop.locator(".menu__section")).toHaveText(["DOWNLOAD", "ACTIONS"]);
      await expect(pop.getByRole("menuitem")).toHaveCount(5);
      await expect(pop.getByRole("menuitem", { name: /PDF document/ })).toBeVisible();
      await expect(pop.getByRole("menuitem", { name: /Supernote/ })).toBeVisible();
      await expect(pop.getByRole("menuitem", { name: "Version history" })).toBeVisible();
      await expect(pop.getByRole("menuitem", { name: "Rename" })).toBeVisible();
      const moveBin = pop.getByRole("menuitem", { name: "Move to bin" });
      await expect(moveBin).toBeVisible();
      await expect(moveBin).not.toHaveClass(/menu__item--danger/);
      await expect(pop.getByRole("menuitem", { name: /Delete permanently|Restore/ })).toHaveCount(0);
      await page.keyboard.press("Escape");

      await more(page, "Apartment lease").click();
      const pdfPop = page.locator(".menu-portal .menu__pop");
      await expect(pdfPop.locator(".menu__section")).toHaveText(["DOWNLOAD", "ACTIONS"]);
      await expect(pdfPop.getByRole("menuitem")).toHaveCount(3);
      await expect(pdfPop.getByRole("menuitem", { name: /Original file/ })).toBeVisible();
      await expect(pdfPop.getByRole("menuitem", { name: "Rename" })).toBeVisible();
      await expect(pdfPop.getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
    });

    test("Move to bin soft-deletes the row with no dialog, and offers the undo", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");
      await page.getByRole("button", { name: "List view" }).click();

      await more(page, "Ideas & scratch").click();
      await page.locator(".menu-portal").getByRole("menuitem", { name: "Move to bin" }).click();

      await expect(page.locator("dialog.confirm")).toBeHidden();
      await expect(page.locator(".bin-toast")).toContainText("Moved Ideas & scratch to Recycle bin");
    });

    test("the PDF document item downloads the WHOLE notebook as one PDF named after the note", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");
      await page.getByRole("button", { name: "List view" }).click();

      await more(page, "Ideas & scratch").click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator(".menu-portal").getByRole("menuitem", { name: /PDF document/ }).click(),
      ]);

      expect(download.suggestedFilename()).toBe(asSaved(download, "Ideas & scratch.pdf"));

      const path = await download.path();
      expect(path).not.toBeNull();
      const bytes = await readFile(path!);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

      await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    });
  });

  // Row boundaries and actions used to show on `:hover` only; measured, since
  // `opacity: 0` still looks plausible.
  test.describe("the list reads at rest", () => {
    async function openList(page: Page, category: string): Promise<void> {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, category);
      await page.getByRole("button", { name: "List view" }).click();
      // Automated tabs freeze transitions mid-flight; freeze before reading opacity.
      await freezeMotion(page);
    }

    test("the row's overflow trigger is visible before the pointer arrives", async ({ page }) => {
      await openList(page, "Note");

      const more = page.locator(".gallery.is-list .card__more").first();
      await expect(more).toBeVisible();

      // `toBeVisible` passes for a transparent element, so read opacity.
      const resting = await more.evaluate((e) => Number(getComputedStyle(e).opacity));
      expect(resting).toBe(1);
    });

    // Icon-only, so WCAG 1.4.11's 3:1 non-text floor applies.
    test("the resting trigger's glyph clears the 3:1 non-text floor", async ({ page }) => {
      await openList(page, "Note");

      const more = page.locator(".gallery.is-list .card__more").first();
      const alpha = await more.evaluate((e) => Number(getComputedStyle(e).opacity));
      expect(alpha).toBe(1);
      const { color, background } = await paintedColours(more);
      expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(3);
    });

    test("a row is separated from the next one by a rule, and the last row is not", async ({ page }) => {
      await openList(page, "Note");

      const rows = page.locator(".gallery.is-list .card");
      const count = await rows.count();
      expect(count).toBeGreaterThan(1);

      const rule = await rows.first().evaluate((e) => {
        const cs = getComputedStyle(e);
        return { width: cs.borderBottomWidth, colour: cs.borderBottomColor, style: cs.borderBottomStyle };
      });
      expect(parseFloat(rule.width)).toBeGreaterThan(0);
      expect(rule.style).not.toBe("none");
      // A 1px border of `rgba(…, 0)` measures as present and paints as nothing.
      expect(rule.colour).not.toMatch(/,\s*0\s*\)$/);

      const last = await rows.nth(count - 1).evaluate((e) => getComputedStyle(e).borderBottomWidth);
      expect(parseFloat(last)).toBe(0);
    });

    // Measured against the scroll container, not the viewport: the rail owns the left.
    test("the list is centred in the space it is given", async ({ page }) => {
      await openList(page, "Note");

      const gaps = await page.locator(".gallery.is-list").evaluate((el) => {
        const parent = el.parentElement!.getBoundingClientRect();
        const self = el.getBoundingClientRect();
        // Otherwise "centred" is vacuously true.
        return { left: self.left - parent.left, right: parent.right - self.right, room: parent.width - self.width };
      });
      expect(gaps.room).toBeGreaterThan(4);
      expect(Math.abs(gaps.left - gaps.right)).toBeLessThan(2);
    });
  });

  test.describe("grid tiles without a preview", () => {
    const card = (page: Page, name: string) => page.locator(".card", { hasText: name });

    // Regression: a folder rendered as a short chip. A folder is the device's
    // folder silhouette, as wide as a note's card at its own 100:82 proportion.
    test("a folder tile is a full-width folder, not a short chip", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");

      const folderTile = card(page, "Projects");
      const noteTile = card(page, "Weekly review");
      await expect(folderTile.locator(".thumb--folder-shape .cat__shape")).toBeVisible();

      await expect
        .poll(async () => {
          const f = await folderTile.locator(".thumb").boundingBox();
          const fCard = await folderTile.boundingBox();
          const nCard = await noteTile.boundingBox();
          if (!f || !fCard || !nCard) return null;
          return {
            sameCardWidth: Math.abs(fCard.width - nCard.width) < 1.5,
            fillsTheCard: Math.abs(f.width - fCard.width) < 1.5,
            folderShape: Math.abs(f.width / f.height - 100 / 82) < 0.03,
          };
        })
        .toEqual({ sameCardWidth: true, fillsTheCard: true, folderShape: true });
    });

    test("a preview-less type gets a glyph tile; an image keeps its real preview", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Document");

      // An `.epub` gets the glyph treatment and no <img>.
      const other = card(page, "Sourdough");
      await expect(other.locator(".thumb--file")).toBeVisible();
      await expect(other.locator(".thumb--file svg")).toBeVisible();
      await expect(other.locator("img.thumb__img")).toHaveCount(0);

      const pdf = card(page, "Apartment lease");
      await expect(pdf.locator("img.thumb__img")).toHaveCount(1);
      await expect(pdf.locator(".thumb--file")).toHaveCount(0);

      const note = card(page, "Attention Is All You Need");
      await expect(note.locator("img.thumb__img")).toHaveCount(1);
      await expect(note.locator("canvas")).toHaveCount(0);

      await openCategory(page, "Screenshot");
      const png = card(page, "pricing page");
      await expect(png.locator(".thumb__img")).toBeVisible();
      await expect(png.locator(".thumb--file")).toHaveCount(0);
    });
  });
});
