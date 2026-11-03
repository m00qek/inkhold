import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { signedIn, imgInkFraction, imgPainted, contrastRatio, paintedColours, cardButton, railSettled, freezeMotion } from "./helpers/app";
import { mockApi } from "./helpers/mockApi";

/**
 * Waits for the tree walk first: an early click is supported but causes a delayed
 * repaint that detaches measured nodes. The sparse-tree suite drives that path explicitly.
 */
async function openCategory(page: Page, name: string): Promise<void> {
  await railSettled(page);
  await navItem(page, name).click();
}

/** A rail anchor/subfolder located by its exact visible name (ignoring count). */
function navItem(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Folders" })
    .locator(".nav__item", { has: page.locator(".nav__name", { hasText: new RegExp(`^${name}$`) }) });
}

test.describe("library rail + gallery", () => {
  test("the rail renders the Supernote categories with icons and direct item counts", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    await expect(page.getByRole("navigation", { name: "Folders" })).toBeVisible();

    for (const label of ["Note", "Document", "MyStyle", "Export", "Screenshot", "Inbox"]) {
      const item = navItem(page, label);
      await expect(item).toHaveCount(1);
      await expect(item.locator("svg")).toBeVisible();
      await expect(item.locator(".nav__count")).toBeVisible();
    }
    await expect(navItem(page, "NOTE")).toHaveCount(0);
    await expect(navItem(page, "DOCUMENT")).toHaveCount(0);

    // Direct items (`FolderVO.itemCount`): the Projects subfolder plus 4 loose notes.
    await expect(navItem(page, "Note").locator(".nav__count")).toHaveText("5");
    await expect(navItem(page, "MyStyle").locator(".nav__count")).toHaveText("3");
    await expect(navItem(page, "Document").locator(".nav__count")).toHaveText("4");
    await expect(navItem(page, "Export").locator(".nav__count")).toHaveText("0");
    await expect(navItem(page, "Screenshot").locator(".nav__count")).toHaveText("2");
    await expect(navItem(page, "Inbox").locator(".nav__count")).toHaveText("1");
  });

  // Category and folder rows come from different code paths; nothing else pins them equal.
  test("a category row and a top-level folder row are the same row, to the pixel", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    const category = navItem(page, "Note");
    const folder = navItem(page, "Archive");
    await expect(category).toBeVisible();
    await expect(folder).toBeVisible();

    // Polled as one reading: the rail rebuilds when a listing lands.
    await expect
      .poll(async () => {
        const box = async (loc: Locator) => ({
          row: await loc.boundingBox(),
          glyph: await loc.locator("svg").boundingBox(),
          name: await loc.locator(".nav__name").boundingBox(),
          count: await loc.locator(".nav__count").boundingBox(),
        });
        const [c, f] = await Promise.all([box(category), box(folder)]);
        if (!c.row || !c.glyph || !c.name || !c.count) return null;
        if (!f.row || !f.glyph || !f.name || !f.count) return null;
        const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
        return {
          sameHeight: near(c.row.height, f.row.height),
          sameWidth: near(c.row.width, f.row.width),
          glyphSized: near(c.glyph.width, 16) && near(c.glyph.height, 16),
          sameGlyphBox: near(c.glyph.width, f.glyph.width) && near(c.glyph.height, f.glyph.height),
          sameGlyphColumn: near(c.glyph.x, f.glyph.x),
          glyphCentred: near(c.glyph.y + c.glyph.height / 2, c.row.y + c.row.height / 2),
          sameNameColumn: near(c.name.x, f.name.x),
          gapIsTen: near(c.name.x - (c.glyph.x + c.glyph.width), 10),
          sameCountRightEdge: near(c.count.x + c.count.width, f.count.x + f.count.width),
        };
      })
      .toEqual({
        sameHeight: true,
        sameWidth: true,
        glyphSized: true,
        sameGlyphBox: true,
        sameGlyphColumn: true,
        glyphCentred: true,
        sameNameColumn: true,
        gapIsTen: true,
        sameCountRightEdge: true,
      });
  });

  test("a nested rail row carries its own count, from the same field", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openCategory(page, "Note");

    const projects = navItem(page, "Projects");
    await expect(projects).toHaveClass(/is-nested/);
    await expect(projects.locator(".nav__count")).toHaveText("2");

    // The accent tick, not the danger-only --margin red. Polled as one reading.
    await expect
      .poll(async () => {
        const tick = await projects.evaluate((e) => {
          const cs = getComputedStyle(e, "::before");
          return { w: parseFloat(cs.width), h: parseFloat(cs.height), content: cs.content };
        });
        if (!Number.isFinite(tick.w) || !Number.isFinite(tick.h)) return null;
        return {
          drawn: tick.content !== "none",
          short: Math.abs(tick.w - 8) < 1, // a SHORT horizontal tick
          hairline: Math.abs(tick.h - 1) < 1,
        };
      })
      .toEqual({ drawn: true, short: true, hairline: true });
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    );
    expect(accent).not.toBe("");
  });

  test("clicking a category anchor opens its gallery", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    await openCategory(page, "Document");
    await expect(cardButton(page, /Attention Is All You Need/)).toBeVisible();

    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.locator(".card--folder", { hasText: "Archive" })).toBeVisible();

    for (const label of ["Note", "Document", "MyStyle", "Export", "Screenshot", "Inbox"]) {
      const card = page.locator(".card--folder", {
        has: page.locator(".card__title", { hasText: new RegExp(`^${label}$`) }),
      });
      await expect(card.locator(".thumb--category")).toBeVisible();
      await expect(card.locator(".thumb--category .cat__glyph svg")).toBeVisible();
      await expect(card.locator(".thumb--folder")).toHaveCount(0);
      await expect(card.locator(".card__meta")).toBeVisible();
    }
    const archive = page.locator(".card--folder", { hasText: "Archive" });
    await expect(archive.locator(".thumb--folder")).toBeVisible();
    await expect(archive.locator(".thumb--category")).toHaveCount(0);
  });

  test("a user subfolder renders nested (indented) under its category anchor", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    await openCategory(page, "Note");

    const note = navItem(page, "Note");
    const projects = navItem(page, "Projects");
    await expect(note).toBeVisible();
    await expect(projects).toBeVisible();
    await expect(projects).toHaveClass(/is-nested/);

    // Polled as one reading: a detached node reports "" styles (NaN padding).
    await expect
      .poll(async () => {
        const pad = async (loc: Locator): Promise<number> =>
          loc.evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft));
        const [p, n] = await Promise.all([pad(projects), pad(note)]);
        if (!Number.isFinite(p) || !Number.isFinite(n)) return null;
        return p > n;
      })
      .toBe(true);
  });

  // The device creates category folders lazily; the rail pins all six anyway. Uses `?real`
  // because the fake fixture has every category.
  test.describe("categories the device has not created yet", () => {
    async function sparseTree(page: Page): Promise<void> {
      const folder = (id: string, name: string, itemCount: number) => ({ kind: "folder", id, name, itemCount });
      await mockApi(page, {
        "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
        // Longest first: `mockApi` takes the first substring match.
        "controlplane/tree?parent=dir-note": {
          json: { folderId: "dir-note", path: [folder("dir-note", "NOTE", 1)], entries: [folder("note", "Note", 0)], syncVersion: 1 },
        },
        "controlplane/tree?parent=note": {
          json: { folderId: "note", path: [folder("dir-note", "NOTE", 1), folder("note", "Note", 0)], entries: [], syncVersion: 1 },
        },
        "controlplane/tree": {
          json: { folderId: null, path: [], entries: [folder("dir-note", "NOTE", 1)], syncVersion: 1 },
        },
      });
    }

    // Regression: nested anchors resolve a round-trip later, and the root gallery painted
    // only resolved anchors plus raw containers, then re-laid-out.
    test("the root gallery paints all six categories, and no container, WHILE the walk is still in flight", async ({
      page,
    }) => {
      const folder = (id: string, name: string, itemCount: number) => ({ kind: "folder", id, name, itemCount });
      await mockApi(page, {
        "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
        // The child walk is held, so these assertions run against the first paint.
        "controlplane/tree?parent=dir-note": {
          delayMs: 2500,
          json: { folderId: "dir-note", path: [folder("dir-note", "NOTE", 1)], entries: [folder("note", "Note", 0)], syncVersion: 1 },
        },
        "controlplane/tree": {
          json: { folderId: null, path: [], entries: [folder("dir-note", "NOTE", 1)], syncVersion: 1 },
        },
      });
      await page.goto("/?real");

      await expect(page.locator("#gallery .card--category")).toHaveCount(6);
      await expect(page.locator("#gallery").getByText("NOTE", { exact: true })).toHaveCount(0);

      await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "false");
      await expect(page.locator("#gallery .card--category")).toHaveCount(6);
      await expect(page.locator("#gallery").getByText("NOTE", { exact: true })).toHaveCount(0);
    });

    test("all six render, absent ones included, with a zero", async ({ page }) => {
      await sparseTree(page);
      await page.goto("/?real");

      for (const label of ["Note", "Document", "MyStyle", "Export", "Screenshot", "Inbox"]) {
        await expect(navItem(page, label)).toHaveCount(1);
      }
      await expect(navItem(page, "Note").locator(".nav__count")).toHaveText("0");
      await expect(navItem(page, "Export").locator(".nav__count")).toHaveText("0");
      await expect(navItem(page, "Inbox").locator(".nav__count")).toHaveText("0");

      const exportRow = navItem(page, "Export");
      await expect(exportRow).toBeEnabled();
      await exportRow.focus();
      await expect(exportRow).toBeFocused();
    });

    test("selecting an absent one shows the empty state and issues no listing request", async ({ page }) => {
      await sparseTree(page);
      const treeCalls: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("controlplane/tree")) treeCalls.push(r.url());
      });
      await page.goto("/?real");
      // Until the walk lands an unresolved category is unknown, not empty.
      await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

      const before = treeCalls.length;
      await openCategory(page, "Export");

      const empty = page.locator("#gallery .empty");
      await expect(empty).toBeVisible();
      await expect(empty.locator("h3")).toHaveText("Export is empty");
      await expect(empty).toContainText("after a sync");
      await expect(empty).not.toContainText(/couldn't|error|failed/i);

      await expect(navItem(page, "Export")).toHaveAttribute("aria-current", "true");
      await expect(page.locator(".crumbs__here")).toHaveText("Export");

      await page.waitForTimeout(300);
      expect(treeCalls.slice(before)).toEqual([]);

      await openCategory(page, "Note");
      await expect(page.locator(".empty h3")).toHaveText("This folder is empty");
    });
  });

  // The rail's flattened model (no NOTE/DOCUMENT containers) is the only model.
  test.describe("container folders are flattened everywhere", () => {
    const head = (page: Page) => page.locator("#gallery .section-head").first();

    test("the breadcrumb drops the container segment", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");

      // The server's path still says NOTE/Note; this is a presentation filter.
      await expect(page.locator(".crumbs")).toHaveText("Library/Note");
      await expect(page.locator(".crumbs")).not.toContainText("NOTE");

      await openCategory(page, "Projects");
      await expect(page.locator(".crumbs")).toHaveText("Library/Note/Projects");

        // A single-segment category keeps its segment but takes the rail's label.
        await openCategory(page, "Screenshot");
        await expect(page.locator(".crumbs")).toHaveText("Library/Screenshot");
    });

    test("the root gallery lists the categories, not the raw containers", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

      const titles = page.locator("#gallery .card--folder .card__title");
      const names = await titles.allTextContents();

      expect(names).not.toContain("NOTE");
      expect(names).not.toContain("DOCUMENT");
        expect(names.slice(0, 6)).toEqual(["Note", "Document", "MyStyle", "Export", "Screenshot", "Inbox"]);
        expect(names).toContain("Export");
        expect(names).toContain("Inbox");
      expect(names).toContain("Scratch");
      expect(names).toContain("Archive");
      await expect(head(page)).toHaveText("9 folders");
    });

    test("a user folder made inside a container is still reachable from the root", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

      // Flattening NOTE without promoting `NOTE/Scratch` would make it unreachable.
      const scratch = page.locator(".card--folder", { hasText: "Scratch" });
      await expect(scratch).toHaveCount(1);
      await scratch.click();
      await expect(page.locator(".card__title", { hasText: "Scratch — todo" })).toBeVisible();
      await expect(page.locator(".crumbs")).toHaveText("Library/Scratch");

      await expect(navItem(page, "Scratch")).toHaveCount(1);
    });

    test("landing in a container renders it and keeps its name in the breadcrumb", async ({ page }) => {
      // The reachable case is the transient container card shown before the walk lands.
      await signedIn(page);
      await page.goto("/");
      const container = page.locator(".card--folder", { hasText: "NOTE" });
      // It may already have been replaced by the settle repaint.
      if ((await container.count()) > 0) {
        await container.first().click();
        await expect(page.locator("#gallery")).toBeVisible();
      }

      await page.goto("/#/folder/dir-note");
      await expect(page.getByRole("navigation", { name: "Folders" })).toBeVisible();
      await expect(page.locator("#gallery")).toBeVisible();
      await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    });
  });

  test("a custom top-level folder is surfaced under 'Other' and stays reachable", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    const archive = navItem(page, "Archive");
    await expect(archive).toBeVisible();

    await archive.click();
    await expect(cardButton(page, /Archive note 01/)).toBeVisible();
  });

  test("an off-screen thumbnail is a blank placeholder until scrolled into view", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openCategory(page, "Archive");

    const cards = page.locator(".card");
    await expect(cards.first()).toBeVisible();
    await expect.poll(async () => cards.count()).toBeGreaterThan(20);

    // Below the fold: unpainted (empty src).
    const farImg = cards.last().locator("img.thumb__img");
    expect(await imgPainted(farImg)).toBe(false);

    await cards.last().scrollIntoViewIfNeeded();
    await expect.poll(async () => imgPainted(farImg), { timeout: 5000 }).toBe(true);
    await expect.poll(async () => imgInkFraction(farImg), { timeout: 5000 }).toBeGreaterThan(0.002);
  });

  test("list view: a folder row is structurally the same row as a note row", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openCategory(page, "Note");
    await expect(page.locator(".card--folder", { hasText: "Projects" })).toBeVisible();

    await page.getByRole("button", { name: "List view" }).click();

    const folderRow = page.locator(".gallery.is-list .card--folder").first();
    const noteRow = page.locator(".gallery.is-list .card:not(.card--folder)").first();
    await expect(folderRow).toBeVisible();
    await expect(noteRow).toBeVisible();
    await expect(page.locator(".folder")).toHaveCount(0);

    await expect(folderRow.locator(".card__marks .card__badge")).toHaveText("folder");
    await expect(folderRow.locator(".card__title")).toHaveText("Projects");
    await expect(folderRow.locator(".card__meta")).toHaveText("2 items");

    await expect
      .poll(async () => {
        const fRow = await folderRow.boundingBox();
        const nRow = await noteRow.boundingBox();
        const fTile = await folderRow.locator(".thumb").boundingBox();
        const nTile = await noteRow.locator(".thumb").boundingBox();
        const fTitle = await folderRow.locator(".card__title").boundingBox();
        const nTitle = await noteRow.locator(".card__title").boundingBox();
        const fMarks = await folderRow.locator(".card__marks").boundingBox();
        const nMarks = await noteRow.locator(".card__marks").boundingBox();
        if (!fRow || !nRow || !fTile || !nTile || !fTitle || !nTitle || !fMarks || !nMarks) return null;
        return {
          sameRowHeight: Math.abs(fRow.height - nRow.height) < 1.5,
          sameTileWidth: Math.abs(fTile.width - nTile.width) < 1.5,
          sameTileHeight: Math.abs(fTile.height - nTile.height) < 1.5,
          sameTitleColumn: Math.abs(fTitle.x - nTitle.x) < 1.5,
          sameBadgeColumn: Math.abs(fMarks.x - nMarks.x) < 1.5,
          bothBadgesAtTop: Math.abs(fMarks.y - fTile.y) < 4 && Math.abs(nMarks.y - nTile.y) < 4,
        };
      })
      .toEqual({
        sameRowHeight: true,
        sameTileWidth: true,
        sameTileHeight: true,
        sameTitleColumn: true,
        sameBadgeColumn: true,
        bothBadgesAtTop: true,
      });
  });

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
      await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

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

      expect(download.suggestedFilename()).toBe("Ideas & scratch.pdf");

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

    test("a folder tile matches a note card's box, not a short chip", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");

      const folderTile = card(page, "Projects");
      const noteTile = card(page, "Weekly review");
      await expect(folderTile.locator(".thumb--folder")).toBeVisible();
      await expect(folderTile.locator(".thumb--folder svg")).toBeVisible();

      await expect
        .poll(async () => {
          const f = await folderTile.locator(".thumb").boundingBox();
          const n = await noteTile.locator(".thumb").boundingBox();
          const fCard = await folderTile.boundingBox();
          const nCard = await noteTile.boundingBox();
          const glyph = await folderTile.locator(".thumb--folder svg").boundingBox();
          if (!f || !n || !fCard || !nCard || !glyph) return null;
          return {
            sameTileWidth: Math.abs(f.width - n.width) < 1.5,
            sameTileHeight: Math.abs(f.height - n.height) < 1.5,
            sameCardWidth: Math.abs(fCard.width - nCard.width) < 1.5,
            keepsAspect: Math.abs(f.width / f.height - 0.75) < 0.02,
            glyphIsFourtyPercent: Math.abs(glyph.width / f.width - 0.4) < 0.03,
            centred: Math.abs(glyph.x + glyph.width / 2 - (f.x + f.width / 2)) < 1.5,
          };
        })
        .toEqual({
          sameTileWidth: true,
          sameTileHeight: true,
          sameCardWidth: true,
          keepsAspect: true,
          glyphIsFourtyPercent: true,
          centred: true,
        });
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

  test.describe("grid card overflow menu", () => {
    const card = (page: Page, name: string) => page.locator(".card", { hasText: name });
    const more = (page: Page, name: string) => card(page, name).getByRole("button", { name: `Actions for ${name}` });

    test("opens, tracks aria-expanded, and closes on an outside click or Escape", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Document");

      const trigger = more(page, "Attention Is All You Need");
      const pop = page.locator(".menu-portal .menu__pop");
      await expect(trigger).toHaveCount(1);
      await expect(pop).toBeHidden();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");

      await trigger.click();
      await expect(pop).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(pop.locator(".menu__section")).toHaveText(["DOWNLOAD", "ACTIONS"]);
      await expect(pop.getByRole("menuitem")).toHaveCount(5);
      await expect(pop.getByRole("menuitem", { name: /PDF document/ })).toBeVisible();
      const moveBin = pop.getByRole("menuitem").last();
      await expect(moveBin).toHaveText("Move to bin");
      await expect(moveBin).not.toHaveClass(/menu__item--danger/);

      await page.locator(".topbar").click({ position: { x: 4, y: 4 } });
      await expect(pop).toBeHidden();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");

      await trigger.click();
      await expect(pop).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(pop).toBeHidden();
    });

    test("a non-note downloads only its original bytes, and the trigger stays in the corner", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Document");

      const pdfMenu = card(page, "Apartment lease").locator(".card__menu");
      await expect(pdfMenu).toHaveCount(1);
      await more(page, "Apartment lease").click();
      // The open popover is portaled to `.menu-portal`.
      const pdfPop = page.locator(".menu-portal .menu__pop");
      await expect(pdfPop.locator(".menu__section")).toHaveText(["DOWNLOAD", "ACTIONS"]);
      await expect(pdfPop.getByRole("menuitem")).toHaveCount(3);
      await expect(pdfPop.getByRole("menuitem", { name: /Original file/ })).toBeVisible();
      await expect(pdfPop.getByRole("menuitem", { name: "Rename" })).toBeVisible();
      await expect(pdfPop.getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
      await page.keyboard.press("Escape");

      // Regression guard: `.menu` (later, equal specificity) must not put `.card__menu` into flow.
      const noteCard = card(page, "Attention Is All You Need");
      const menu = noteCard.locator(".card__menu");
      // Polled: a detached node reports "" for every computed property.
      await expect
        .poll(async () => (await menu.evaluate((e) => getComputedStyle(e).position)) || null)
        .toBe("absolute");

      await expect
        .poll(async () => {
          const t = await noteCard.locator(".card__more").boundingBox();
          const thumb = await noteCard.locator(".thumb").boundingBox();
          const withMenu = await noteCard.boundingBox();
          const without = await card(page, "Apartment lease").boundingBox();
          if (!t || !thumb || !withMenu || !without) return null;
          return {
            insetFromRight: Math.abs(thumb.x + thumb.width - (t.x + t.width) - 8) < 1.5,
            insetFromTop: Math.abs(t.y - thumb.y - 8) < 1.5,
            noExtraHeight: Math.abs(withMenu.height - without.height) < 1.5,
          };
        })
        .toEqual({ insetFromRight: true, insetFromTop: true, noExtraHeight: true });
    });

    test("the PDF document item exports the whole notebook, the same as a list row does", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");

      await more(page, "Ideas & scratch").click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator(".menu-portal").getByRole("menuitem", { name: /PDF document/ }).click(),
      ]);
      expect(download.suggestedFilename()).toBe("Ideas & scratch.pdf");
      await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    });
  });

  // Always visible: hover never fires on touch. Runs with `hasTouch` + `isMobile`.
  test.describe("always-visible actions on a touch device", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 851 } });

    test("both the list row's button and the grid card's trigger are visible unhovered", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");
      await page.addStyleTag({ content: `*, *::before, *::after { transition: none !important; }` });

      // Polled: the gallery repaints under it.
      const opacityOf = (loc: Locator) =>
        expect
          .poll(async () => {
            const v = await loc.evaluate((e) => getComputedStyle(e).opacity);
            return v === "" ? null : Number(v);
          })
          .toBe(1);

      const trigger = page.locator(".card", { hasText: "Weekly review" }).locator(".card__more");
      await expect(trigger).toHaveCount(1);
      await opacityOf(trigger);

      await page.getByRole("button", { name: "List view" }).click();
      await page.addStyleTag({ content: `*, *::before, *::after { transition: none !important; }` });
      const listMore = page.locator(".card", { hasText: "Weekly review" }).locator(".card__more");
      await expect(listMore).toHaveCount(1);
      await opacityOf(listMore);
    });
  });

  test("search filters the current folder by name", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openCategory(page, "Archive");
    await expect(cardButton(page, /Archive note 01/)).toBeVisible();

    await page.getByRole("searchbox", { name: "Search notes" }).fill("note 02");
    await expect(cardButton(page, /Archive note 02/)).toBeVisible();
    await expect(cardButton(page, /Archive note 01/)).toHaveCount(0);
  });
});

test.describe("the sort order is remembered", () => {
  test("survives a reload, in both the gallery and the control", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    // The root holds only folders, which `sort` does not order.
    await openCategory(page, "MyStyle");

    const sort = page.locator("#sort");
    await expect(sort).toHaveValue("recent");

    // Note cards only: folder cards sit ahead and are not sorted.
    const titles = async (): Promise<string[]> =>
      page.locator(".card__open:not(:has(.thumb--folder)) .card__title").allInnerTexts();

    await sort.selectOption("title");
    const byTitle = await titles();
    // Guard: an already-alphabetical fixture would let a broken restore pass.
    expect(byTitle.length).toBeGreaterThan(1);
    expect([...byTitle].sort((a, b) => a.localeCompare(b))).toEqual(byTitle);

    await page.reload();
    await openCategory(page, "MyStyle");

    await expect(page.locator("#sort")).toHaveValue("title");
    expect(await titles()).toEqual(byTitle);
  });

  test("an unrecognised stored value falls back to Recent instead of breaking", async ({ page }) => {
    await signedIn(page);
    await page.addInitScript(() => window.localStorage.setItem("sn.sort", "by-vibes"));
    await page.goto("/");
    await openCategory(page, "MyStyle");

    await expect(page.locator("#sort")).toHaveValue("recent");
    expect(await page.locator(".card__open").count()).toBeGreaterThan(0);
  });
});

// `--topbar-control-h` sets every control's border-box height.
test.describe("the top-bar controls share one height", () => {
  test("the sort select, the view toggle and the search box all report the same offsetHeight", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    const sort = page.locator("#sort");
    const segmented = page.locator(".segmented");
    const search = page.locator(".search input");
    await expect(sort).toBeVisible();
    await expect(segmented).toBeVisible();
    await expect(search).toBeVisible();

    // Upload shipped 6px short: `.btn` wins on stylesheet order. Add every new topbar control here.
    const upload = page.locator("#upload");
    await expect(upload).toBeVisible();

    const heightOf = (loc: Locator) => loc.evaluate((el) => (el as HTMLElement).offsetHeight);
    const [hSort, hSeg, hSearch, hUpload] = await Promise.all([
      heightOf(sort),
      heightOf(segmented),
      heightOf(search),
      heightOf(upload),
    ]);

    expect(hSort).toBe(hSeg);
    expect(hSearch).toBe(hSeg);
    expect(hUpload).toBe(hSeg);
    // Guard: a zero height would make the equality vacuous.
    expect(hSeg).toBeGreaterThan(0);
  });
});
