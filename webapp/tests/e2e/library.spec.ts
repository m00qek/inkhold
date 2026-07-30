import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { signedIn, imgInkFraction, imgPainted, contrastRatio, paintedColours, cardButton, railSettled, freezeMotion } from "./helpers/app";
import { mockApi } from "./helpers/mockApi";

// The rail is anchored in the Supernote's own categories (Note, Document,
// MyStyle, Export, Screenshot, Inbox) — all six pinned whether or not the device
// has created their folders yet — each with the mockup's icon and its DIRECT
// item count, with user-created subfolders nested beneath their category anchor
// (counted the same way) and any custom top-level folder surfaced under an
// "Other" group. The gallery's
// load-bearing invariant — off-screen thumbnails stay blank until scrolled in —
// is still proven at the pixel level over the deep "Archive" folder.

/**
 * Click a rail row, once the rail has stopped changing under it.
 *
 * All six categories are pinned from the first paint, but which of them resolve
 * to a real folder is only known after the tree walk. Clicking before that is a
 * supported user action — the shell re-navigates once the walk lands — but it
 * produces a second, delayed repaint, and a test that then measures a card would
 * read a node the repaint had already detached (`getComputedStyle` on an orphan
 * returns "" for every property). Tests that deliberately exercise the
 * not-yet-resolved path drive it explicitly instead; see the sparse-tree suite.
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

    // Each category anchor exists exactly once, with an icon and a count.
    for (const label of ["Note", "Document", "MyStyle", "Export", "Screenshot", "Inbox"]) {
      const item = navItem(page, label);
      await expect(item).toHaveCount(1);
      await expect(item.locator("svg")).toBeVisible();
      await expect(item.locator(".nav__count")).toBeVisible();
    }
    // The redundant device container folders are flattened away, not shown.
    await expect(navItem(page, "NOTE")).toHaveCount(0);
    await expect(navItem(page, "DOCUMENT")).toHaveCount(0);

    // ITEMS, DIRECT: the server's `FolderVO.itemCount`. Note holds the Projects
    // subfolder plus 4 loose notes = 5 items — the subfolder is an item, and
    // Projects' own 2 notes are a level down and belong to its own row.
    await expect(navItem(page, "Note").locator(".nav__count")).toHaveText("5");
    await expect(navItem(page, "MyStyle").locator(".nav__count")).toHaveText("3");
    await expect(navItem(page, "Document").locator(".nav__count")).toHaveText("3");
    await expect(navItem(page, "Export").locator(".nav__count")).toHaveText("0");
    await expect(navItem(page, "Screenshot").locator(".nav__count")).toHaveText("2");
    await expect(navItem(page, "Inbox").locator(".nav__count")).toHaveText("1");
  });

  // A category anchor and a plain folder row are ONE row type, measured.
  //
  // They are built by different code paths (a category's label is a constant, a
  // folder's name is device-authored and must be set as text), and nothing else
  // in the suite says the two paths have to agree about the row's internals — so
  // a change to either one could quietly move the glyph, the name column or the
  // row's height for half the rail and every existing assertion would still pass.
  // Both rows are at depth 0 here, so every number below must match exactly.
  test("a category row and a top-level folder row are the same row, to the pixel", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    // "Note" is a category anchor (constant label); "Archive" is a custom root
    // folder in the Other group (device-authored name). Both depth 0.
    const category = navItem(page, "Note");
    const folder = navItem(page, "Archive");
    await expect(category).toBeVisible();
    await expect(folder).toBeVisible();

    // Polled as ONE reading: the rail is rebuilt wholesale when a listing lands,
    // and a box sampled across that rebuild comes back null from a detached node.
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
          // The row box itself: a wrapper around the glyph that took flex space
          // or line height would show up here first.
          sameHeight: near(c.row.height, f.row.height),
          sameWidth: near(c.row.width, f.row.width),
          // 16px glyphs, same size, in the same column.
          glyphSized: near(c.glyph.width, 16) && near(c.glyph.height, 16),
          sameGlyphBox: near(c.glyph.width, f.glyph.width) && near(c.glyph.height, f.glyph.height),
          sameGlyphColumn: near(c.glyph.x, f.glyph.x),
          glyphCentred: near(c.glyph.y + c.glyph.height / 2, c.row.y + c.row.height / 2),
          // The 10px gap the rail's flex `gap` puts between glyph and name.
          sameNameColumn: near(c.name.x, f.name.x),
          gapIsTen: near(c.name.x - (c.glyph.x + c.glyph.width), 10),
          // The count sits at the row's right edge in both.
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
    // Projects holds 2 notes — the mockup's rail counts every row, not just the
    // anchors, and both numbers come from `itemCount`.
    await expect(projects.locator(".nav__count")).toHaveText("2");

    // The accent tick, not the red danger token: --margin is danger-only.
    // Polled as one reading — the rail rebuilds under it (see the padding test).
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
    // --accent resolved, and distinctly not the --margin red.
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

    // Back to the root library via the breadcrumb.
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.locator(".card--folder", { hasText: "Archive" })).toBeVisible();

    // THE PINNED CATEGORIES render as the folder-silhouette treatment — the
    // `.thumb--category` shape with the category's own glyph inside — while an
    // ordinary user folder keeps the plain `.thumb--folder` tile.
    for (const label of ["Note", "Document", "MyStyle", "Export", "Screenshot", "Inbox"]) {
      const card = page.locator(".card--folder", {
        has: page.locator(".card__title", { hasText: new RegExp(`^${label}$`) }),
      });
      await expect(card.locator(".thumb--category")).toBeVisible();
      await expect(card.locator(".thumb--category .cat__glyph svg")).toBeVisible();
      await expect(card.locator(".thumb--folder")).toHaveCount(0);
      // The item count is kept alongside the silhouette.
      await expect(card.locator(".card__meta")).toBeVisible();
    }
    // Archive is a user folder — the plain tile, no silhouette.
    const archive = page.locator(".card--folder", { hasText: "Archive" });
    await expect(archive.locator(".thumb--folder")).toBeVisible();
    await expect(archive.locator(".thumb--category")).toHaveCount(0);
  });

  test("a user subfolder renders nested (indented) under its category anchor", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    // Enter the Note category, which holds the user-created "Projects" subfolder.
    await openCategory(page, "Note");

    const note = navItem(page, "Note");
    const projects = navItem(page, "Projects");
    await expect(note).toBeVisible();
    await expect(projects).toBeVisible();
    await expect(projects).toHaveClass(/is-nested/);

    // Polled as ONE reading, for the same reason the gallery assertions are: the
    // rail is rebuilt wholesale (a listing lands, the tree walk finishes), and a
    // padding sampled across that rebuild comes back from a node that has just
    // been detached — where `getComputedStyle` reports "" and parseFloat is NaN.
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

  // The device creates its category folders LAZILY, so before a first sync
  // several genuinely do not exist. The rail is pinned regardless: six rows,
  // always, in the same order — a rail that grew an entry each time the device
  // happened to write a folder would be a different shape every week.
  //
  // Driven through REAL mode (`?real`) with a mocked control plane, because the
  // point is a tree that is MISSING categories and the fake fixture has them all.
  test.describe("categories the device has not created yet", () => {
    /** A tree holding only NOTE/Note — Export, Screenshot and Inbox are absent. */
    async function sparseTree(page: Page): Promise<void> {
      const folder = (id: string, name: string, itemCount: number) => ({ kind: "folder", id, name, itemCount });
      await mockApi(page, {
        "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
        // Longest/most specific first: `mockApi` takes the first substring match.
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

    // THE ROOT GALLERY'S SHAPE IS SETTLED AT FIRST PAINT — the regression this
    // pins: three anchors are NESTED (`NOTE/Note`, `NOTE/MyStyle`,
    // `DOCUMENT/Document`) and cannot resolve until the walk fetches the
    // containers' children, a whole round-trip later. The gallery used to paint
    // only the anchors that had resolved, plus the raw `NOTE`/`DOCUMENT`
    // containers as ordinary folder cards — so it showed the wrong things and
    // then re-laid-out. Invisible on localhost; plainly visible on a throttled
    // link, which is where it was found.
    test("the root gallery paints all six categories, and no container, WHILE the walk is still in flight", async ({
      page,
    }) => {
      const folder = (id: string, name: string, itemCount: number) => ({ kind: "folder", id, name, itemCount });
      await mockApi(page, {
        "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
        // The child walk is HELD, so every assertion below runs against the
        // first paint — the exact window the bug lived in.
        "controlplane/tree?parent=dir-note": {
          delayMs: 2500,
          json: { folderId: "dir-note", path: [folder("dir-note", "NOTE", 1)], entries: [folder("note", "Note", 0)], syncVersion: 1 },
        },
        "controlplane/tree": {
          json: { folderId: null, path: [], entries: [folder("dir-note", "NOTE", 1)], syncVersion: 1 },
        },
      });
      await page.goto("/?real");

      // All six category tiles, before the walk can have landed.
      await expect(page.locator("#gallery .card--category")).toHaveCount(6);
      // And never the container itself, under either casing.
      await expect(page.locator("#gallery").getByText("NOTE", { exact: true })).toHaveCount(0);

      // The shape does not change when the walk lands: same six, still no
      // container — the tile settles into the real folder in place.
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
      // The one that resolves, and three that do not — all counted, all present.
      await expect(navItem(page, "Note").locator(".nav__count")).toHaveText("0");
      await expect(navItem(page, "Export").locator(".nav__count")).toHaveText("0");
      await expect(navItem(page, "Inbox").locator(".nav__count")).toHaveText("0");

      // NOT disabled and NOT dimmed into a broken-looking row: nothing has gone
      // wrong, so it must be reachable exactly like any other category.
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
      // Wait for the tree walk to land. Until it does, an unresolved category is
      // merely UNKNOWN, not absent, and the gallery says "Loading…" — asserting
      // "Export is empty" before this point would be asserting the bug.
      await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

      const before = treeCalls.length;
      await openCategory(page, "Export");

      // The gallery says so in the app's voice — a fact about the device, not a
      // failure. No "couldn't load", no error.
      const empty = page.locator("#gallery .empty");
      await expect(empty).toBeVisible();
      await expect(empty.locator("h3")).toHaveText("Export is empty");
      await expect(empty).toContainText("after a sync");
      await expect(empty).not.toContainText(/couldn't|error|failed/i);

      // The rail row is the current one, and the breadcrumb agrees with it.
      await expect(navItem(page, "Export")).toHaveAttribute("aria-current", "true");
      await expect(page.locator(".crumbs__here")).toHaveText("Export");

      // THE POINT: no request was made for an id that does not exist.
      await page.waitForTimeout(300);
      expect(treeCalls.slice(before)).toEqual([]);

      // And it is not a dead end — a real category still works afterwards.
      await openCategory(page, "Note");
      await expect(page.locator(".empty h3")).toHaveText("This folder is empty");
    });
  });

  // The app used to run two models of the same tree: the rail flattened the
  // device's container folders (NOTE, DOCUMENT) away and promoted their
  // meaningful children, while the breadcrumb and the root gallery showed them
  // raw. So a note inside NOTE/Note read `Library / NOTE / Note`, naming a folder
  // that appears nowhere in the rail, and "Library" listed NOTE and EXPORT side
  // by side. The rail's model is now the only model.
  test.describe("container folders are flattened everywhere", () => {
    const head = (page: Page) => page.locator("#gallery .section-head").first();

    test("the breadcrumb drops the container segment", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");

      // `Library / Note` — the server's path still says NOTE/Note; this is a
      // presentation filter.
      await expect(page.locator(".crumbs")).toHaveText("Library/Note");
      // The container name is gone entirely (case-sensitive: "Note" is not "NOTE").
      await expect(page.locator(".crumbs")).not.toContainText("NOTE");

      // And one level deeper: only the container goes, never a real segment.
      await openCategory(page, "Projects");
      await expect(page.locator(".crumbs")).toHaveText("Library/Note/Projects");

        // A single-segment category is NOT a container, so its SEGMENT survives —
        // that is what this test is about, and it still holds. What changed is the
        // NAME: a category anchor is called by its category label everywhere, so
        // the crumb reads "Screenshot" like the rail rather than the device's own
        // `SCREENSHOT`. The same folder must not read as two different places two
        // inches apart.
        await openCategory(page, "Screenshot");
        await expect(page.locator(".crumbs")).toHaveText("Library/Screenshot");
    });

    test("the root gallery lists the categories, not the raw containers", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

      const titles = page.locator("#gallery .card--folder .card__title");
      const names = await titles.allTextContents();

      // The containers are gone…
      expect(names).not.toContain("NOTE");
      expect(names).not.toContain("DOCUMENT");
        // …replaced by the children the rail promotes, in the rail's order, and
        // under the rail's LABELS. A category anchor is called the same thing
        // everywhere — card, rail row, breadcrumb, the reader's Back button — so
        // the device's `EXPORT` shows as `Export`. Same folder; only the name is
        // ours. Labelling is not flattening: the segment still survives.
        expect(names.slice(0, 6)).toEqual(["Note", "Document", "MyStyle", "Export", "Screenshot", "Inbox"]);
        expect(names).toContain("Export");
        expect(names).toContain("Inbox");
      // Plus the promoted user folder and the custom root one.
      expect(names).toContain("Scratch");
      expect(names).toContain("Archive");
      await expect(head(page)).toHaveText("9 folders");
    });

    test("a user folder made inside a container is still reachable from the root", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

      // `NOTE/Scratch` is not a category. Flattening NOTE without promoting it
      // would make it unreachable from anywhere in the UI.
      const scratch = page.locator(".card--folder", { hasText: "Scratch" });
      await expect(scratch).toHaveCount(1);
      await scratch.click();
      await expect(page.locator(".card__title", { hasText: "Scratch — todo" })).toBeVisible();
      // Its breadcrumb loses the container too.
      await expect(page.locator(".crumbs")).toHaveText("Library/Scratch");

      // And it is in the rail's "Other" group, so the two agree.
      await expect(navItem(page, "Scratch")).toHaveCount(1);
    });

    test("landing in a container renders it and keeps its name in the breadcrumb", async ({ page }) => {
      // There is no folder route (`#/folder/x` parses as `library`), so a
      // container id cannot arrive from a URL. The reachable case is the
      // transient container card the root shows before the tree walk lands — it
      // is rendered, never redirected or errored.
      await signedIn(page);
      await page.goto("/");
      const container = page.locator(".card--folder", { hasText: "NOTE" });
      // It may already have been replaced by the settle repaint; either way it
      // must never error, and if it is there it must work.
      if ((await container.count()) > 0) {
        await container.first().click();
        await expect(page.locator("#gallery")).toBeVisible();
      }

      // An unroutable folder hash falls back to the library rather than 404ing.
      await page.goto("/#/folder/dir-note");
      await expect(page.getByRole("navigation", { name: "Folders" })).toBeVisible();
      await expect(page.locator("#gallery")).toBeVisible();
      await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    });
  });

  test("a custom top-level folder is surfaced under 'Other' and stays reachable", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    // "Archive" isn't a known category, so it appears in the rail's Other group.
    const archive = navItem(page, "Archive");
    await expect(archive).toBeVisible();

    await archive.click();
    await expect(cardButton(page, /Archive note 01/)).toBeVisible();
  });

  test("an off-screen thumbnail is a blank placeholder until scrolled into view", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await openCategory(page, "Archive");

    // Wait for the grid to populate.
    const cards = page.locator(".card");
    await expect(cards.first()).toBeVisible();
    await expect.poll(async () => cards.count()).toBeGreaterThan(20);

    // The last card is well below the fold: its <img> is unpainted (empty src),
    // showing the tile's sheet background — no object URL swapped in yet.
    const farImg = cards.last().locator("img.thumb__img");
    expect(await imgPainted(farImg)).toBe(false);

    // Scroll it into view; the lazy engine paints it from the facade blob — the
    // <img> gets an object URL and the handwriting's ink appears.
    await cards.last().scrollIntoViewIfNeeded();
    await expect.poll(async () => imgPainted(farImg), { timeout: 5000 }).toBe(true);
    await expect.poll(async () => imgInkFraction(farImg), { timeout: 5000 }).toBeGreaterThan(0.002);
  });

  // A folder is a `.card` in BOTH views — the compact `.folder` chip is gone
  // everywhere. In a list that means the same row as a note: 64px lead tile,
  // badge line, name, meta. Sharing the note's markup is what makes the
  // alignment exact rather than approximated.
  test("list view: a folder row is structurally the same row as a note row", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    // The Note category holds a mix of the Projects subfolder and loose notes.
    await openCategory(page, "Note");
    await expect(page.locator(".card--folder", { hasText: "Projects" })).toBeVisible();

    await page.getByRole("button", { name: "List view" }).click();

    const folderRow = page.locator(".gallery.is-list .card--folder").first();
    const noteRow = page.locator(".gallery.is-list .card:not(.card--folder)").first();
    await expect(folderRow).toBeVisible();
    await expect(noteRow).toBeVisible();
    // The chip class is gone from the app entirely, in either view.
    await expect(page.locator(".folder")).toHaveCount(0);

    // The folder row states what it is on the SAME badge line a note uses.
    await expect(folderRow.locator(".card__marks .card__badge")).toHaveText("folder");
    await expect(folderRow.locator(".card__title")).toHaveText("Projects");
    // …and its meta is the item count: folders + docs, totalled.
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
          // The column every row's text starts at.
          sameTitleColumn: Math.abs(fTitle.x - nTitle.x) < 1.5,
          sameBadgeColumn: Math.abs(fMarks.x - nMarks.x) < 1.5,
          // Same rhythm: the badge line sits on the tile's top edge in both.
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

  // Two nouns, and they dovetail: a folder row says how many ITEMS are inside
  // it; opening it shows a head splitting those items into FOLDERS and DOCS.
  // "docs" is type-neutral, so nothing here can call a screenshot a note — the
  // defect the old blanket "8 notes" count had.
  test.describe("the gallery section head", () => {
    const head = (page: Page) => page.locator("#gallery .section-head").first();

    test("counts folders and docs separately, with singulars", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");

      // Note/: the Projects subfolder + 4 loose notes.
      await openCategory(page, "Note");
      await expect(head(page)).toHaveText("1 folder · 4 docs");

      // The row that opens this folder says the same eight things as one number.
      await page.getByRole("button", { name: "List view" }).click();
      await expect(page.locator(".card--folder", { hasText: "Projects" }).locator(".card__meta")).toHaveText("2 items");
      await openCategory(page, "Projects");
      // …and inside, those 2 items resolve to 2 docs and no folders. The folder
      // half is OMITTED, never "0 folders · 2 docs".
      await expect(head(page)).toHaveText("2 docs");
    });

    test("says docs for PDFs and screenshots, never notes", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");

      // DOCUMENT/ holds a real .note, a PDF and an unscaled note — mixed types,
      // one type-neutral noun.
      await openCategory(page, "Document");
      await expect(head(page)).toHaveText("3 docs");

      // SCREENSHOT/ is nothing but PNGs. "2 notes" here was the old lie.
      await openCategory(page, "Screenshot");
      await expect(head(page)).toHaveText("2 docs");
      await expect(head(page)).not.toContainText("note");
    });

    test("singular halves, and the root's folder-only case", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "Folders" })).toHaveAttribute("aria-busy", "false");

      // The root is all folders — the doc half is omitted, not "0 docs". Six
      // categories (the containers are flattened away), plus the promoted
      // NOTE/Scratch and the custom Archive and Files.
      await expect(head(page)).toHaveText("9 folders");
      await expect(head(page)).not.toContainText("doc");

      // "1 folder" singular is covered by Note/ above ("1 folder · 3 docs").
      // INBOX/ holds exactly one file: "1 doc", not "1 docs".
      await openCategory(page, "Inbox");
      await expect(head(page)).toHaveText("1 doc");
    });
  });

  test("a folder's meta says items, and an empty one says Empty", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await page.getByRole("button", { name: "List view" }).click();

    // EXPORT is empty in the fixture — "Empty", never "0 items".
    const exportRow = page.locator(".card--folder", { hasText: "EXPORT" });
    await expect(exportRow.locator(".card__meta")).toHaveText("Empty");

    // Singular is "1 item", not "1 items". Measured on INBOX (one note in the
    // fixture) — this used to read the raw `DOCUMENT` CONTAINER, which the root
    // gallery no longer paints at all: the containers are noise the rail
    // flattens away, and showing them until the walk landed was what made two
    // folder cards appear and then vanish.
    await expect(page.locator(".card--folder", { hasText: "INBOX" }).locator(".card__meta")).toHaveText("1 item");
    // Plural, folders and files folded into one honest noun.
    await expect(page.locator(".card--folder", { hasText: "SCREENSHOT" }).locator(".card__meta")).toHaveText("2 items");
  });

  // The card badge used to be the hardcoded string "note" for every entry, which
  // mislabelled the PDFs and screenshots the device syncs into the tree. It is
  // now the file's real type, with a SEPARATE marker for on-device recognized
  // text (shown ⟺ the note can turn up in a text search).
  test.describe("card badge + recognized-text marker", () => {
    const card = (page: Page, name: string) => page.locator(".card", { hasText: name });

    test("the badge shows each file's own type, not a blanket 'note'", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");

      await openCategory(page, "Document");
      await expect(card(page, "Attention Is All You Need").locator(".card__badge")).toHaveText("note");
      // Same folder, different type — the case the hardcoded badge got wrong.
      await expect(card(page, "Apartment lease").locator(".card__badge")).toHaveText("pdf");

      // And the badge follows fileType, not the filename: these names carry no
      // ".png" at all, so "png" can only have come from the server's field.
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

      // Shown for the recognized note, absent for the un-recognized one.
      await expect(withText.locator(".card__ocr")).toBeVisible();
      await expect(withoutText.locator(".card__ocr")).toHaveCount(0);

      // It carries meaning, so it must have an accessible name — not a bare glyph.
      const marker = withText.getByRole("img", { name: "Has recognised text" });
      await expect(marker).toBeVisible();
      await expect(marker.locator("svg")).toBeVisible();

      // Sized in CSS (svg() emits no width/height), and GROUPED with the badge at
      // the thumb's top-left rather than mirrored into the opposite corner: two
      // marks in opposite corners read as two unrelated marks, together they read
      // as one set. Polled as one reading: the gallery repaints on the SWR
      // refetch, and boxes sampled across that repaint come back null from a node
      // that has just been replaced.
      await expect
        .poll(async () => {
          const m = await withText.locator(".card__ocr").boundingBox();
          const b = await withText.locator(".card__badge").boundingBox();
          const t = await withText.locator(".thumb").boundingBox();
          if (!m || !b || !t) return null;
          return {
            sized: m.width > 0 && m.height > 0,
            rightOfBadge: m.x > b.x + b.width,
            // Adjacent, not a corner apart: one 4px gap between the two chips.
            adjacent: m.x - (b.x + b.width) < 6,
            // Both in the same group, inset 8px from the thumb's LEFT edge.
            groupedLeft: Math.abs(b.x - t.x - 8) < 1.5,
            // Nowhere near the right edge — that is the layout this replaced.
            notMirrored: t.x + t.width - (m.x + m.width) > 20,
          };
        })
        .toEqual({ sized: true, rightOfBadge: true, adjacent: true, groupedLeft: true, notMirrored: true });
    });

    // Same class of bug the reader toolbar guards against: the marker is styled
    // only by tokens and a component class, so a bad token or a reset that
    // outranks `.card__ocr` would make it silently invisible in one theme. The
    // icon is stroked with currentColor, so contrast is the durable assertion.
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
        // WCAG 1.4.11's 3:1 floor for a meaningful non-text graphic.
        expect(contrastRatio(stroke!, background)).toBeGreaterThan(3);
      });
    }

    // List view used to `display: none` BOTH overlays — an 8px-inset chip would
    // have covered the shrunken thumbnail — and the two facts were simply lost.
    // They are not overlaid now: they are the row's first line.
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

      // Same order as the grid overlay: type first, then the marker.
      const marks = withText.locator(".card__marks");
      await expect(marks).toHaveCount(1);
      // Inside the body, not over the thumb.
      await expect(withText.locator(".card__body .card__marks")).toHaveCount(1);
      await expect(withText.locator(".thumb .card__marks")).toHaveCount(0);
    });

    // The three-line row, measured. Order top-to-bottom is badges → title →
    // meta, the badge line lands on the thumb's top edge, and the meta lands
    // near its bottom (deliberately 5px short of flush — see the CSS comment;
    // flush measures as aligned but reads as sitting too low).
    test("list view: the row is three lines aligned to the thumb's edges", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");
      await page.getByRole("button", { name: "List view" }).click();

      const row = card(page, "Weekly review");
      await expect(row.locator(".card__marks")).toBeVisible();

      // Polled as one reading: the SWR refetch repaints the gallery, and a box
      // sampled across that repaint comes back null from a replaced node.
      await expect
        .poll(async () => {
          const marks = await row.locator(".card__marks").boundingBox();
          const title = await row.locator(".card__title").boundingBox();
          const meta = await row.locator(".card__meta").boundingBox();
          const thumb = await row.locator(".thumb").boundingBox();
          if (!marks || !title || !meta || !thumb) return null;
          const bottomGap = thumb.y + thumb.height - (meta.y + meta.height);
          return {
            // 46px → 64px, aspect-ratio intact (not stretched by align-items).
            thumbWide: Math.abs(thumb.width - 64) < 1.5,
            aspectKept: Math.abs(thumb.height - 64 / 0.75) < 2,
            // Line order.
            badgesFirst: marks.y + marks.height <= title.y + 1,
            metaLast: title.y + title.height <= meta.y + 1,
            // Badge line on the thumb's top edge.
            topAligned: Math.abs(marks.y - thumb.y) < 4,
            // Meta near the bottom edge, above it, by the optical margin.
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

  // GRID AND LIST OFFER ONE IDENTICAL ACTION SET, through the same "…" overflow
  // menu: a per-type DOWNLOAD section (for a `.note`, whole-doc PDF + the original
  // `.note`) and a titled ACTIONS section (Move to bin on a live item).
  test.describe("list row overflow menu", () => {
    const card = (page: Page, name: string) => page.locator(".card", { hasText: name });
    const more = (page: Page, name: string) => card(page, name).getByRole("button", { name: `Actions for ${name}` });

    test("the list row uses the SAME sectioned menu the grid does", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Document");

      // The grid card carries no labelled row buttons — only the "…" menu, the
      // same control the list now uses.
      await expect(page.locator(".card__actions")).toHaveCount(0);
      await expect(card(page, "Attention Is All You Need").locator(".card__menu")).toHaveCount(1);

      await page.getByRole("button", { name: "List view" }).click();

      // A `.note`: DOWNLOAD (PDF document + Supernote) then ACTIONS (Version
      // history + Rename + Move to bin), each group under its own titled header,
      // the soft-delete last.
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
      // NEUTRAL: a recoverable soft-delete is NOT the red danger variant.
      await expect(moveBin).not.toHaveClass(/menu__item--danger/);
      // BIN-ONLY verbs never appear on a live library item.
      await expect(pop.getByRole("menuitem", { name: /Delete permanently|Restore/ })).toHaveCount(0);
      await page.keyboard.press("Escape");

      // A PDF hands back only its own bytes: DOWNLOAD (Original file .pdf) + ACTIONS.
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

      // Reversible → no confirm dialog; the bin's toast offers the undo instead.
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

      // No `-p{n}` suffix: this is the document, not a page.
      expect(download.suggestedFilename()).toBe("Ideas & scratch.pdf");

      const path = await download.path();
      expect(path).not.toBeNull();
      const bytes = await readFile(path!);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

      // Exporting is not navigating into the reader — the grid stayed put.
      await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    });
  });

  // WHAT THE EYE GETS AT REST. The list used to carry two things on `:hover`
  // alone — the row's boundary and its actions — which made them information the
  // pointer had and the eye did not. Both regress silently: an `opacity: 0` or a
  // dropped `border-bottom` still renders a perfectly plausible-looking list, and
  // every existing structural assertion keeps passing. Hence measurement.
  test.describe("the list reads at rest", () => {
    async function openList(page: Page, category: string): Promise<void> {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, category);
      await page.getByRole("button", { name: "List view" }).click();
      // Before ANY measurement: an automated tab is `visibilityState: hidden`,
      // which freezes transitions mid-flight, so an opacity read would return an
      // intermediate value forever.
      await freezeMotion(page);
    }

    test("the row's overflow trigger is visible before the pointer arrives", async ({ page }) => {
      await openList(page, "Note");

      // The list row's action is the "…" trigger, visible at rest — like the
      // labelled buttons it replaced (the grid trigger is now always-visible too,
      // for the touch surface; see the touch-device suite).
      const more = page.locator(".gallery.is-list .card__more").first();
      await expect(more).toBeVisible();

      // NOT HOVERED, and not focused. `toBeVisible` alone would pass on a fully
      // transparent element — it is in the layout either way — so opacity is read
      // directly.
      const resting = await more.evaluate((e) => Number(getComputedStyle(e).opacity));
      expect(resting).toBe(1);
    });

    // THE LEGIBILITY OF THAT RESTING TRIGGER. It is an icon-only control, so the
    // durable floor is WCAG 1.4.11's 3:1 for a meaningful non-text graphic rather
    // than 4.5 for text — the glyph is stroked in currentColor, measured against
    // what is painted behind it, and (unlike the old faded buttons) at full
    // opacity so the computed colour is the one that reaches the eye.
    test("the resting trigger's glyph clears the 3:1 non-text floor", async ({ page }) => {
      await openList(page, "Note");

      const more = page.locator(".gallery.is-list .card__more").first();
      const alpha = await more.evaluate((e) => Number(getComputedStyle(e).opacity));
      expect(alpha).toBe(1);
      // The "…" glyph is filled with currentColor, so `color` IS the mark's
      // colour, measured against what is painted behind it.
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

      // The list ends with an item, not with a line waiting for one.
      const last = await rows.nth(count - 1).evaluate((e) => getComputedStyle(e).borderBottomWidth);
      expect(parseFloat(last)).toBe(0);
    });

    // The 760px measure was always there; what was missing was the `auto` that
    // makes the leftover space symmetric instead of pooling it all on the right.
    // Measured against the SCROLL CONTAINER the gallery centres inside, not the
    // viewport — the rail owns the left of the window, so a viewport-relative
    // assertion would be measuring the rail's width, not the centring.
    test("the list is centred in the space it is given", async ({ page }) => {
      await openList(page, "Note");

      const gaps = await page.locator(".gallery.is-list").evaluate((el) => {
        const parent = el.parentElement!.getBoundingClientRect();
        const self = el.getBoundingClientRect();
        // The gallery is narrower than its container — otherwise "centred" is
        // vacuously true and this test would prove nothing.
        return { left: self.left - parent.left, right: parent.right - self.right, room: parent.width - self.width };
      });
      expect(gaps.room).toBeGreaterThan(4);
      expect(Math.abs(gaps.left - gaps.right)).toBeLessThan(2);
    });
  });

  // Grid view is ONE UNIFORM SET OF TILES: a folder and a preview-less file get
  // the same box as a note card, carrying a centred glyph on the same stock,
  // instead of a short chip and an empty sheet respectively.
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
            // THE CHIP REGRESSION: a chip was ~50px tall next to a ~245px card.
            sameTileHeight: Math.abs(f.height - n.height) < 1.5,
            sameCardWidth: Math.abs(fCard.width - nCard.width) < 1.5,
            // Grid keeps the note's 0.75 sheet ratio.
            keepsAspect: Math.abs(f.width / f.height - 0.75) < 0.02,
            // The mockup's 40% glyph, centred in the tile.
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

    test("a PDF gets a glyph tile; an image keeps its real preview", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Document");

      // A PDF has no page data to render, so it gets the glyph treatment rather
      // than a tile the renderer leaves blank. No <img> preview either.
      const pdf = card(page, "Apartment lease");
      await expect(pdf.locator(".thumb--file")).toBeVisible();
      await expect(pdf.locator(".thumb--file svg")).toBeVisible();
      await expect(pdf.locator("img.thumb__img")).toHaveCount(0);

      // A real note gets a real preview: an engine-managed <img> (painted from the
      // facade's WebP blob), not a canvas — the gallery has none any more.
      const note = card(page, "Attention Is All You Need");
      await expect(note.locator("img.thumb__img")).toHaveCount(1);
      await expect(note.locator("canvas")).toHaveCount(0);

      // An image has a genuine preview and must keep it — NOT a glyph.
      await openCategory(page, "Screenshot");
      const png = card(page, "pricing page");
      await expect(png.locator(".thumb__img")).toBeVisible();
      await expect(png.locator(".thumb--file")).toHaveCount(0);
    });
  });

  // The grid has no room for a labelled button beside a card, so the actions live
  // behind the mockup's "…" — now a sectioned DOWNLOAD + ACTIONS menu, the same
  // the list row carries.
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
      // DOWNLOAD (PDF document + Supernote) then ACTIONS (Version history +
      // Rename + Move to bin) — the soft-delete LAST, never the one under the
      // pointer when the menu opens, and NEUTRAL (a recoverable move is not the
      // red danger variant).
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

      // A pdf cannot be re-rendered, so its DOWNLOAD is just the original file;
      // ACTIONS is Move to bin, offered for every file.
      const pdfMenu = card(page, "Apartment lease").locator(".card__menu");
      await expect(pdfMenu).toHaveCount(1);
      await more(page, "Apartment lease").click();
      // The trigger stays in `.card__menu`, but the open popover is portaled to
      // `.menu-portal` at the body root — so its sections/items are read there.
      const pdfPop = page.locator(".menu-portal .menu__pop");
      await expect(pdfPop.locator(".menu__section")).toHaveText(["DOWNLOAD", "ACTIONS"]);
      await expect(pdfPop.getByRole("menuitem")).toHaveCount(3);
      await expect(pdfPop.getByRole("menuitem", { name: /Original file/ })).toBeVisible();
      await expect(pdfPop.getByRole("menuitem", { name: "Rename" })).toBeVisible();
      await expect(pdfPop.getByRole("menuitem", { name: "Move to bin" })).toBeVisible();
      await page.keyboard.press("Escape");

      // THE SPECIFICITY REGRESSION: the element carries both `menu` and
      // `card__menu`, and the generic `.menu { position: relative }` is declared
      // later at equal specificity. If the scoped rule ever loses, the menu falls
      // into flow and silently adds its height to every card in the grid.
      const noteCard = card(page, "Attention Is All You Need");
      const menu = noteCard.locator(".card__menu");
      // Polled: the gallery repaints under this read (SWR refetch), and a
      // detached node reports "" for every computed property.
      await expect
        .poll(async () => (await menu.evaluate((e) => getComputedStyle(e).position)) || null)
        .toBe("absolute");

      // Measured, not just declared: the trigger sits over the thumb's top-right,
      // and the card is no taller than a card that has no menu at all.
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
      // Exporting is not opening: the grid stayed put.
      await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    });
  });

  // A hover-revealed control is unreachable on a touch screen, and this library is
  // browsed from a phone — so the grid card's "…" trigger is ALWAYS visible now,
  // not hover-revealed. `hasTouch` + `isMobile` runs the check on the real touch
  // surface it was made for; it holds on the desktop too.
  test.describe("always-visible actions on a touch device", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 851 } });

    test("both the list row's button and the grid card's trigger are visible unhovered", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await openCategory(page, "Note");
      await page.addStyleTag({ content: `*, *::before, *::after { transition: none !important; }` });

      // Polled, like every other computed-style read here: the gallery repaints
      // under it and a detached node reports "" for every property.
      const opacityOf = (loc: Locator) =>
        expect
          .poll(async () => {
            const v = await loc.evaluate((e) => getComputedStyle(e).opacity);
            return v === "" ? null : Number(v);
          })
          .toBe(1);

      // Grid first: the "…" trigger.
      const trigger = page.locator(".card", { hasText: "Weekly review" }).locator(".card__more");
      await expect(trigger).toHaveCount(1);
      await opacityOf(trigger);

      await page.getByRole("button", { name: "List view" }).click();
      await page.addStyleTag({ content: `*, *::before, *::after { transition: none !important; }` });
      // The list row's "…" trigger, the same control the grid card carries.
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

// The sort order is a PREFERENCE, not a per-visit choice: someone who works by
// title should not have to re-pick it on every reload. Two things have to hold
// together, and only asserting the first is how a control ends up lying — the
// gallery must come back in the chosen order AND the select must say so.
test.describe("the sort order is remembered", () => {
  test("survives a reload, in both the gallery and the control", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    // MyStyle, because the ROOT holds only folders — `sort` orders notes, so a
    // root-level assertion would compare an empty list against itself and pass
    // no matter what the restore did.
    await openCategory(page, "MyStyle");

    const sort = page.locator("#sort");
    await expect(sort).toHaveValue("recent");

    // NOTE cards only. Folder cards carry `card__title` too but are laid out
    // ahead of the notes and are not what `sort` orders, so including them would
    // assert alphabetical over a list that is not sorted alphabetically.
    const titles = async (): Promise<string[]> =>
      page.locator(".card__open:not(:has(.thumb--folder)) .card__title").allInnerTexts();

    await sort.selectOption("title");
    const byTitle = await titles();
    // Guard the guard: a fixture that is ALREADY alphabetical would let a broken
    // restore pass, because both orders would look identical.
    expect(byTitle.length).toBeGreaterThan(1);
    expect([...byTitle].sort((a, b) => a.localeCompare(b))).toEqual(byTitle);

    await page.reload();
    await openCategory(page, "MyStyle");

    // The control agrees with the state it restored from...
    await expect(page.locator("#sort")).toHaveValue("title");
    // ...and the gallery is actually in that order, not merely labelled with it.
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

// The top bar's controls used to render a pixel or two apart — the "Recent ▾"
// sort select sat SHORTER than the icon/list view toggle beside it. One shared
// token (`--topbar-control-h`) now sets every interactive control's VISUAL height
// (border-box, so padding and border are inside it), so they line up.
test.describe("the top-bar controls share one height", () => {
  test("the sort select, the view toggle and the search box all report the same offsetHeight", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    // All three live in the library top bar at once (grid view, no query).
    const sort = page.locator("#sort");
    const segmented = page.locator(".segmented");
    const search = page.locator(".search input");
    await expect(sort).toBeVisible();
    await expect(segmented).toBeVisible();
    await expect(search).toBeVisible();

    // The UPLOAD control is in this list because it was NOT, and that is how it
    // shipped six pixels short of everything beside it: `.btn` carries the
    // compact height and wins on stylesheet order, so `.topbar__action` needed
    // to match its specificity. A test that enumerates controls only catches the
    // ones it enumerates — every new topbar control belongs here.
    const upload = page.locator("#upload");
    await expect(upload).toBeVisible();

    const heightOf = (loc: Locator) => loc.evaluate((el) => (el as HTMLElement).offsetHeight);
    const [hSort, hSeg, hSearch, hUpload] = await Promise.all([
      heightOf(sort),
      heightOf(segmented),
      heightOf(search),
      heightOf(upload),
    ]);

    // THE PIN: the sort select and the view toggle are the same height…
    expect(hSort).toBe(hSeg);
    // …and the search box aligns to that same height too.
    expect(hSearch).toBe(hSeg);
    // …as does the upload control, which is a button rather than a field or a
    // frame and so takes its height from a different rule.
    expect(hUpload).toBe(hSeg);
    // Guard the guard: a zero height would make the equality vacuously true.
    expect(hSeg).toBeGreaterThan(0);
  });
});
