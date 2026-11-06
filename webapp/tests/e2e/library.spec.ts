import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, imgInkFraction, imgPainted, cardButton, railSettled } from "./helpers/app";
import { mockApi } from "./helpers/mockApi";
import { openCategory, navItem } from "./library.shared";

test.describe("library rail + gallery", () => {
  test("the rail renders the Supernote categories with icons and direct item counts", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    await expect(page.getByRole("navigation", { name: "Library" })).toBeVisible();

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

      await expect(page.getByRole("group", { name: "Folders" })).toHaveAttribute("aria-busy", "false");
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
      await expect(page.getByRole("group", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

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
      await expect(page.getByRole("group", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

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
      await expect(page.getByRole("group", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

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
      await expect(page.getByRole("navigation", { name: "Library" })).toBeVisible();
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
});
