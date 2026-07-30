import { describe, it, expect, vi, afterEach, beforeEach, afterAll } from "vitest";
import {
  createRail,
  crumbPath,
  CATEGORIES,
  CONTAINER_NAMES,
  labelPathSegments,
  DESTINATIONS,
  type FolderTree,
  type RailPlace,
  type RailRow,
  type RailView,
  type Destination,
} from "../../src/pages/rail";
import type { IconName } from "../../src/ui/icons";
import type { Entry, Folder, Id } from "../../src/core/types";

// `DESTINATIONS` is a SHIPPED list now (the recycle bin registers a line in it),
// but every test below is about the producer rather than about which entries
// happen to exist — so each one starts from an empty list and installs exactly
// the destinations it is making a claim about. The shipped set is put back
// afterwards so nothing leaks out of this file. That the bin is really
// registered is `bin.test.ts`'s claim, where it belongs.
const SHIPPED: Destination[] = [...DESTINATIONS];
beforeEach(() => void DESTINATIONS.splice(0, DESTINATIONS.length));
afterAll(() => void DESTINATIONS.splice(0, DESTINATIONS.length, ...SHIPPED));

// The rail's logic with the DOM injected, the same way the recognized-text panel
// is tested. The load-bearing invariants here are the ones a silent regression
// would cost a user something real:
//
//   - ALL SIX categories render whether or not the device has created their
//     folders, because it creates them lazily;
//   - selecting one the device has NOT created issues no request and is not an
//     error — and, before the tree walk lands, is not yet even known to be
//     absent (the `pendingCategory` / `treeLoaded` machine);
//   - the device's container folders are flattened away in the rail, the
//     breadcrumb and the root listing ALIKE, without ever losing a folder the
//     user made inside one;
//   - one counting path, and `undefined` is not `0`.

// --- fixtures ----------------------------------------------------------------

interface Spec {
  id: Id;
  name: string;
  /** Omitted = the server did not count this folder. */
  count?: number;
  children?: Spec[];
}

const folder = (s: Spec): Folder => ({ kind: "folder", id: s.id, name: s.name, ...(s.count === undefined ? {} : { itemCount: s.count }) });

/**
 * A {@link FolderTree} over a literal spec, plus the one thing the shell's real
 * cache knows and a plain tree does not: which folders have been LISTED.
 * `unwalked` marks folders whose listing has not arrived — they report no
 * children AND report themselves as unwalked, which is the distinction
 * `rootEntries` turns on.
 */
function treeOf(roots: Spec[], unwalked: Id[] = []): FolderTree {
  const byId = new Map<Id, Spec>();
  const index = (s: Spec): void => {
    byId.set(s.id, s);
    for (const c of s.children ?? []) index(c);
  };
  for (const r of roots) index(r);
  const missing = new Set(unwalked);
  return {
    roots: () => roots.map(folder),
    children: (id) => (missing.has(id) ? [] : (byId.get(id)?.children ?? []).map(folder)),
    walked: (id) => !missing.has(id),
  };
}

/** The device's default tree, as it looks once a household has used it. */
const FULL: Spec[] = [
  {
    id: "dir-note",
    name: "NOTE",
    count: 3,
    children: [
      { id: "note", name: "Note", count: 4, children: [{ id: "projects", name: "Projects", count: 2 }] },
      { id: "mystyle", name: "MyStyle", count: 3 },
      { id: "scratch", name: "Scratch", count: 1 },
    ],
  },
  { id: "dir-doc", name: "DOCUMENT", count: 1, children: [{ id: "doc", name: "Document", count: 3 }] },
  { id: "export", name: "EXPORT", count: 0 },
  { id: "screenshot", name: "SCREENSHOT", count: 2 },
  { id: "inbox", name: "INBOX", count: 1 },
  { id: "archive", name: "Archive", count: 24 },
];

/** Only `NOTE/Note` exists — Export, Screenshot and Inbox were never created. */
const SPARSE: Spec[] = [{ id: "dir-note", name: "NOTE", count: 1, children: [{ id: "note", name: "Note", count: 0 }] }];

function build(
  spec: Spec[],
  place: RailPlace = { folderId: null, openPath: null },
  unwalked: Id[] = [],
  over: Partial<{
    destinationCount: (k: string) => number;
    destinationState: (k: string) => { icon: IconName; label: string } | null;
    isAdmin: () => boolean;
  }> = {},
) {
  const painted: RailRow[][] = [];
  const view = {
    render: vi.fn((rows: readonly RailRow[]) => void painted.push([...rows])),
    setBusy: vi.fn(),
  } satisfies RailView;
  const deps = {
    view,
    tree: treeOf(spec, unwalked),
    place: () => place,
    onOpenFolder: vi.fn(),
    onSelectCategory: vi.fn(),
    onOpenDestination: vi.fn(),
    destinationCount: vi.fn(over.destinationCount ?? (() => 0)),
    destinationState: vi.fn(over.destinationState ?? (() => null)),
    isAdmin: vi.fn(over.isAdmin ?? (() => false)),
    onSettled: vi.fn(),
    onLabelsSettled: vi.fn(),
  };
  const rail = createRail(deps);
  return { rail, view, painted, ...deps, last: () => painted[painted.length - 1]!, setPlace: (p: RailPlace) => void (place = p) };
}

/** Every item row's visible name, in paint order. Labels excluded. */
const names = (rows: RailRow[]): string[] => rows.filter((r) => r.kind === "item").map((r) => (r.kind === "item" ? r.name : ""));
const item = (rows: RailRow[], name: string) => rows.find((r): r is Extract<RailRow, { kind: "item" }> => r.kind === "item" && r.name === name);
/**
 * A row's COUNT, or undefined where it carries no count — either no badge at all
 * or a state glyph instead. The badge is a discriminated union now (see
 * {@link RailBadge}), because the admin row shows a padlock rather than a number
 * and a padlock is not a count of anything.
 */
const countOf = (rows: RailRow[], name: string): number | undefined => {
  const badge = item(rows, name)?.badge;
  return badge?.kind === "count" ? badge.value : undefined;
};

// --- the pinned six ----------------------------------------------------------

describe("the rail's category anchors", () => {
  it("renders all six even when the device has created only one of them", () => {
    const t = build(SPARSE);
    t.rail.build();

    // The rail's shape is the SAME every session — it does not grow a row each
    // time the device happens to write a folder.
    expect(names(t.last()).slice(0, 6)).toEqual(["Note", "Document", "MyStyle", "Export", "Screenshot", "Inbox"]);
    expect(names(t.last()).slice(0, 6)).toEqual(CATEGORIES.map((c) => c.label));
  });

  it("counts from the server's field, and an absent category reads 0", () => {
    const t = build(FULL);
    t.rail.build();
    const rows = t.last();

    // DIRECT counts: Note holds Projects + 3 loose notes = 4. Projects' own 2
    // belong to its own row, a level down.
    expect(countOf(rows, "Note")).toBe(4);
    expect(countOf(rows, "MyStyle")).toBe(3);
    expect(countOf(rows, "Document")).toBe(3);
    expect(countOf(rows, "Export")).toBe(0);
    expect(countOf(rows, "Screenshot")).toBe(2);
    expect(countOf(rows, "Inbox")).toBe(1);

    // An anchor with no folder behind it still shows a number.
    const sparse = build(SPARSE);
    sparse.rail.build();
    expect(countOf(sparse.last(), "Export")).toBe(0);
  });

  it("shows a rail row's count as 0 when the server did not count the folder", () => {
    // A rail row must show a number, so `undefined` reads as 0 HERE. This is the
    // one place that conversion is allowed — the gallery's folder rows take the
    // opposite decision and render no meta line at all, so an uncounted folder
    // never *claims* to be empty where there is room to say nothing.
    const t = build([{ id: "dir-note", name: "NOTE", children: [{ id: "note", name: "Note" }] }]);
    t.rail.build();
    expect(countOf(t.last(), "Note")).toBe(0);
    // …and the underlying field really is absent, not 0.
    expect(t.tree.children("dir-note")[0]!.itemCount).toBeUndefined();
  });

  it("marks the current folder, and nothing else", () => {
    const t = build(FULL, { folderId: "doc", openPath: [] });
    t.rail.build();
    const current = t.last().filter((r) => r.kind === "item" && r.current);
    expect(current).toHaveLength(1);
    expect((current[0] as { name: string }).name).toBe("Document");
  });
});

// --- categoryIconFor ---------------------------------------------------------
//
// The glyph that scopes the gallery's folder-silhouette treatment to the six
// pinned categories. Resolved by IDENTITY, exactly like `labelFor`: only the
// folder a category path resolves to is the category, so a user's own folder
// that merely happens to be named like one gets nothing.

describe("categoryIconFor", () => {
  it("returns each pinned category's own glyph, by identity", () => {
    const t = build(FULL);
    // Note carries its OWN notebook glyph now, not the generic `folder`.
    expect(t.rail.categoryIconFor({ id: "note" })).toBe("note");
    expect(CATEGORIES.find((c) => c.label === "Note")!.icon).toBe("note");
    // The other five keep their existing glyphs.
    expect(t.rail.categoryIconFor({ id: "doc" })).toBe("doc");
    expect(t.rail.categoryIconFor({ id: "mystyle" })).toBe("layers");
    expect(t.rail.categoryIconFor({ id: "export" })).toBe("export");
    expect(t.rail.categoryIconFor({ id: "screenshot" })).toBe("image");
    expect(t.rail.categoryIconFor({ id: "inbox" })).toBe("inbox");
  });

  it("returns null for a user folder, even the device CONTAINER it flattens away", () => {
    const t = build(FULL);
    // A folder the user made at the root is not a category.
    expect(t.rail.categoryIconFor({ id: "archive" })).toBeNull();
    // A user folder INSIDE a container (`NOTE/Scratch`) is not a category.
    expect(t.rail.categoryIconFor({ id: "scratch" })).toBeNull();
    // The raw container `NOTE` itself is noise the rail flattens — not an anchor.
    expect(t.rail.categoryIconFor({ id: "dir-note" })).toBeNull();
    // A nested category CHILD (`Note/Projects`) is a plain folder, not an anchor.
    expect(t.rail.categoryIconFor({ id: "projects" })).toBeNull();
  });

  it("returns null for every category before the tree resolves them", () => {
    // SPARSE has only NOTE/Note; the other five resolve to nothing, so they are
    // not anchors yet and get no glyph — the same absence `labelFor` reports.
    const t = build(SPARSE);
    expect(t.rail.categoryIconFor({ id: "note" })).toBe("note");
    expect(t.rail.categoryIconFor({ id: "export" })).toBeNull();
  });
});

// --- the pendingCategory / treeLoaded machine --------------------------------

describe("selecting a category the device has not created yet", () => {
  it("issues no folder navigation, and holds the category as pending", () => {
    const t = build(SPARSE);
    t.rail.build();
    expect(t.rail.pending()).toBeNull();

    item(t.last(), "Export")!.select();

    // THE POINT: there is no id, so nothing is asked for. Inventing one would 404.
    expect(t.onOpenFolder).not.toHaveBeenCalled();
    expect(t.rail.pending()?.label).toBe("Export");
    // The shell still gets told, so it can close the reader and clear the query.
    expect(t.onSelectCategory).toHaveBeenCalledTimes(1);
  });

  it("is a real, selectable row — identical to a resolved one apart from what it does", () => {
    const t = build(SPARSE);
    t.rail.build();
    const absent = item(t.last(), "Export")!;
    const present = item(t.last(), "Note")!;
    // Same shape: no disabled flag, no dimming, no "not available" — from the
    // user's side nothing is wrong, the category is simply empty.
    expect(Object.keys(absent).sort()).toEqual(Object.keys(present).sort());
    expect(absent.depth).toBe(present.depth);
  });

  it("shows the pending row as current, and clears when ordinary navigation happens", () => {
    const t = build(SPARSE);
    t.rail.build();
    item(t.last(), "Export")!.select();
    t.rail.build();
    expect(item(t.last(), "Export")!.current).toBe(true);

    t.rail.clearPending();
    t.rail.build();
    expect(item(t.last(), "Export")!.current).toBe(false);
    expect(t.rail.pending()).toBeNull();
  });

  // The bug this machine exists for: before the walk lands, an unresolved
  // category is indistinguishable from an absent one, and clicking Export during
  // load once claimed "nothing has been exported" about a folder that was merely
  // still loading — a confident lie.
  it("is not yet KNOWN to be absent until the tree walk lands", () => {
    const t = build(SPARSE);
    t.rail.build();
    expect(t.rail.loaded()).toBe(false);

    item(t.last(), "Export")!.select();

    // The shell reads `loaded()` to choose "Loading…" over the empty state, so
    // it cannot yet say "Export is empty" about a folder that may still arrive.
    expect(t.rail.loaded()).toBe(false);
    expect(t.rail.pending()?.label).toBe("Export");
  });

  it("settles to the real empty state once the walk lands and it is still absent", () => {
    const t = build(SPARSE);
    t.rail.build();
    item(t.last(), "Export")!.select();

    t.rail.treeWalked();

    expect(t.rail.loaded()).toBe(true);
    expect(t.view.setBusy).toHaveBeenLastCalledWith(false);
    // Still pending, still no request — but now the shell can say so honestly.
    expect(t.rail.pending()?.label).toBe("Export");
    expect(t.onOpenFolder).not.toHaveBeenCalled();
    expect(t.onSettled).toHaveBeenCalledTimes(1);
  });

  it("goes to the folder when the walk resolves the category after all", () => {
    // Export is selected while the walk has only reached the root, and `EXPORT`
    // turns up later in the same walk. This is the race the flag exists for, so
    // the tree has to GROW under one rail rather than be swapped for another.
    let spec: Spec[] = [...SPARSE];
    const growing: FolderTree = {
      roots: () => treeOf(spec).roots(),
      children: (id) => treeOf(spec).children(id),
      walked: (id) => treeOf(spec).walked(id),
    };
    const painted: RailRow[][] = [];
    const onOpenFolder = vi.fn();
    const onSettled = vi.fn();
    const rail = createRail({
      view: { render: (rows) => void painted.push([...rows]), setBusy: vi.fn() },
      tree: growing,
      place: () => ({ folderId: null, openPath: null }),
      onOpenFolder,
      onSelectCategory: vi.fn(),
    onOpenDestination: vi.fn(),
    destinationCount: vi.fn(() => 0),
    destinationState: vi.fn(() => null),
    isAdmin: vi.fn(() => false),
      onSettled,
      onLabelsSettled: vi.fn(),
    });

    rail.build();
    item(painted[painted.length - 1]!, "Export")!.select();
    expect(onOpenFolder).not.toHaveBeenCalled();

    spec = [...SPARSE, { id: "export", name: "EXPORT", count: 0 }];
    rail.treeWalked();

    // Where the user asked to be, so that is where they go.
    expect(onOpenFolder).toHaveBeenCalledWith("export");
    // …and NOT also a bare repaint, which would paint the empty state over it.
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("repaints the root when the walk lands with nothing pending", () => {
    // The root gallery is a function of the tree too (it flattens the containers
    // away), so the first paint's raw NOTE/DOCUMENT rows must be replaced.
    const t = build(FULL, { folderId: null, openPath: null });
    t.rail.treeWalked();
    expect(t.onSettled).toHaveBeenCalledTimes(1);

    // Standing in a real folder, the ROWS are not provisional — they came from
    // one listing that never depended on the walk — so the full repaint stays
    // off. What IS provisional is what they are CALLED, and that gets the narrow
    // callback instead of nothing at all (2.3: a deep link to `#/folder/<export>`
    // used to read "Library / EXPORT" for good).
    const inside = build(FULL, { folderId: "note", openPath: [] });
    inside.rail.treeWalked();
    expect(inside.onSettled).not.toHaveBeenCalled();
    expect(inside.onLabelsSettled).toHaveBeenCalledTimes(1);
  });

  it("owes the gallery nothing when the walk found the tree unchanged", () => {
    // A syncing tablet bumps the sync version per file, and every bump used to
    // end in a full `replaceChildren` + `galleryEngine.reset()` of a gallery that
    // was already correct. `changed` is the shell's answer to "did anything the
    // rail, the crumbs or name-search reads actually move".
    const root = build(FULL, { folderId: null, openPath: null });
    root.rail.treeWalked(false);
    expect(root.onSettled).not.toHaveBeenCalled();

    const inside = build(FULL, { folderId: "note", openPath: [] });
    inside.rail.treeWalked(false);
    expect(inside.onLabelsSettled).not.toHaveBeenCalled();

    // A PENDING CATEGORY is exempt: the walk having FINISHED is the transition,
    // whatever it found, and it is what turns "Loading…" into "Export is empty".
    const pending = build(SPARSE);
    pending.rail.build();
    item(pending.last(), "Export")!.select();
    pending.rail.treeWalked(false);
    expect(pending.onSettled).toHaveBeenCalledTimes(1);
  });
});

// --- container flattening ----------------------------------------------------

describe("container folders", () => {
  it("derives the container set from the multi-segment category paths only", () => {
    expect([...CONTAINER_NAMES].sort()).toEqual(["DOCUMENT", "NOTE"]);
    // Single-segment categories ARE the category, not a wrapper around one —
    // flattening them would promote their notes to the root and delete the
    // folders from the UI.
    for (const name of ["EXPORT", "SCREENSHOT", "INBOX"]) expect(CONTAINER_NAMES.has(name)).toBe(false);
  });

  it("never shows a container in the rail, and never shows a folder twice", () => {
    const t = build(FULL);
    t.rail.build();
    const shown = names(t.last());

    expect(shown).not.toContain("NOTE");
    expect(shown).not.toContain("DOCUMENT");
    // A single-segment category appears exactly once — as its anchor, never also
    // under "Other". That is what KNOWN_ROOT_NAMES is for.
    for (const name of shown) expect(shown.filter((n) => n === name)).toHaveLength(1);
  });

  it("promotes a user folder made inside a container rather than losing it", () => {
    const t = build(FULL);
    t.rail.build();
    const rows = t.last();

    // `NOTE/Scratch` is not a category. Flattening NOTE without promoting it
    // would make it unreachable from anywhere in the UI.
    expect(names(rows)).toContain("Scratch");
    expect(names(rows)).toContain("Archive");
    // Both live under the "Other" heading, after the six anchors.
    const other = rows.findIndex((r) => r.kind === "label" && r.text === "Other");
    expect(other).toBeGreaterThan(0);
    expect(names(rows.slice(other))).toEqual(["Scratch", "Archive"]);

    // And it is a working destination, not just a row.
    item(rows, "Scratch")!.select();
    expect(t.onOpenFolder).toHaveBeenCalledWith("scratch");
  });

  it("contributes nothing from a container it has not walked yet", () => {
    const t = build(FULL, { folderId: null, openPath: null }, ["dir-note"]);
    t.rail.build();
    // Scratch is inside the unwalked NOTE, so it cannot be promoted yet — but
    // the rail must not invent it, and Archive is still there.
    expect(names(t.last())).not.toContain("Scratch");
    expect(names(t.last())).toContain("Archive");
  });
});

// --- nesting -----------------------------------------------------------------

describe("nested rows", () => {
  it("reveals a category's subfolders only for the branch you are inside", () => {
    const closed = build(FULL, { folderId: null, openPath: null });
    closed.rail.build();
    expect(names(closed.last())).not.toContain("Projects");

    const open = build(FULL, { folderId: "note", openPath: [folder({ id: "dir-note", name: "NOTE" })] });
    open.rail.build();
    const projects = item(open.last(), "Projects")!;
    expect(projects).toBeDefined();
    // Indented one step under its anchor, and counted from the same field.
    expect(projects.depth).toBe(1);
    expect(projects.badge).toEqual({ kind: "count", value: 2 });
  });

  it("expands nothing at all when there is no listing yet", () => {
    // `openPath: null` is not the same as an empty path: with no listing nothing
    // is expanded, not even the folder we believe we are in.
    const t = build(FULL, { folderId: "note", openPath: null });
    t.rail.build();
    expect(names(t.last())).not.toContain("Projects");
  });
});

// --- the root listing --------------------------------------------------------

describe("rootEntries", () => {
  const raw: Entry[] = [
    folder({ id: "dir-note", name: "NOTE", count: 3 }),
    folder({ id: "dir-doc", name: "DOCUMENT", count: 1 }),
    folder({ id: "export", name: "EXPORT", count: 0 }),
    folder({ id: "archive", name: "Archive", count: 24 }),
  ];

  it("lists what the rail lists, in the rail's order, with the containers gone", () => {
    const t = build(FULL);
    const out = t.rail.rootEntries(raw).map((e) => e.name);
    expect(out.slice(0, 6)).toEqual(["Note", "Document", "MyStyle", "EXPORT", "SCREENSHOT", "INBOX"]);
    expect(out).not.toContain("NOTE");
    expect(out).not.toContain("DOCUMENT");
    // The promoted and the custom folder, both reachable.
    expect(out).toContain("Scratch");
    expect(out).toContain("Archive");
  });

  it("drops the containers even before the walk, and still shows ALL SIX anchors", () => {
    // THE SHAPE IS SETTLED AT FIRST PAINT. This used to emit a not-yet-walked
    // container as itself so nothing was unreachable, and push only the anchors
    // that already resolved — so the root painted 3 tiles + `NOTE`/`DOCUMENT`,
    // then re-laid-out to 6 when the walk landed (plainly visible on a slow link).
    //
    // Reachability is preserved WITHOUT the containers: the anchors are all
    // present from the start, and selecting an unresolved one shows "Loading…"
    // until the walk settles it onto the real folder (see the `loaded()` gate in
    // library.ts and `settle()` here). `CONTAINER_NAMES` is static data derived
    // from `CATEGORIES`, so nothing has to be fetched to know these are noise.
    const t = build(FULL, { folderId: null, openPath: null }, ["dir-note"]);
    const out = t.rail.rootEntries(raw).map((e) => e.name);
    expect(out).not.toContain("NOTE");
    expect(out).not.toContain("DOCUMENT");
    expect(out.slice(0, 6)).toEqual(["Note", "Document", "MyStyle", "EXPORT", "SCREENSHOT", "INBOX"]);
  });

  it("stands in for an anchor the device has no folder for, and never as a real folder", () => {
    // An unresolved anchor is a card, not a gap — but it has no folder behind it,
    // so every consumer that would navigate to its id or offer folder actions has
    // to be able to tell (galleryCards asks exactly this).
    const t = build([]); // a device that has synced nothing: no anchor resolves
    const out = t.rail.rootEntries([]);
    expect(out.map((e) => e.name).slice(0, 6)).toEqual([
      "Note",
      "Document",
      "MyStyle",
      "Export",
      "Screenshot",
      "Inbox",
    ]);
    for (const e of out) {
      const cat = t.rail.pendingCategoryOf(e as Folder);
      expect(cat).not.toBeNull();
      // It still paints as its category, so resolving it never restyles the card.
      expect(t.rail.categoryIconFor(e as Folder)).toBe(cat!.icon);
    }
  });

  it("keeps every non-folder the device left at the root", () => {
    const t = build(FULL);
    const loose = { kind: "note", id: "n1", name: "stray" } as unknown as Entry;
    expect(t.rail.rootEntries([...raw, loose]).map((e) => e.name)).toContain("stray");
  });
});

// --- the shared path filter ---------------------------------------------------

describe("crumbPath", () => {
  const p = (...names: string[]): Folder[] => names.map((name, i) => folder({ id: `f${i}`, name }));

  it("drops a container at index 0", () => {
    expect(crumbPath(p("NOTE", "Note")).map((f) => f.name)).toEqual(["Note"]);
    expect(crumbPath(p("NOTE", "Note", "Projects")).map((f) => f.name)).toEqual(["Note", "Projects"]);
  });

  it("keeps a container that is where you are STANDING", () => {
    // Dropping the last segment would leave the breadcrumb saying "Library"
    // while the gallery showed the container's contents.
    expect(crumbPath(p("NOTE")).map((f) => f.name)).toEqual(["NOTE"]);
  });

  it("keeps a deeply-nested folder that merely happens to be called NOTE", () => {
    // A container name is a ROOT-folder fact; a user's own folder is not noise.
    expect(crumbPath(p("Archive", "NOTE", "x")).map((f) => f.name)).toEqual(["Archive", "NOTE", "x"]);
  });

  it("leaves a single-segment category alone", () => {
    expect(crumbPath(p("SCREENSHOT", "2024")).map((f) => f.name)).toEqual(["SCREENSHOT", "2024"]);
  });
});

// --- labelPathSegments -------------------------------------------------------
//
// `crumbPath`'s twin, for a path that arrives as PLAIN SEGMENTS rather than as
// resolved folders — which is the shape the recycle bin gets, because a trashed
// entry's path is reconstructed on the server from a tree that no longer has
// live `Folder` objects to run `labelFor` against. The two must agree: a path
// that reads `Note` in the breadcrumb cannot read `NOTE / Note` in the bin.

describe("labelPathSegments", () => {
  it("labels a category and flattens the container it sits in", () => {
    expect(labelPathSegments(["NOTE", "Note"])).toEqual(["Note"]);
  });

  it("picks the LONGEST matching category, not the first", () => {
    // The load-bearing case: `NOTE/Note` and `NOTE/MyStyle` share a first
    // segment, so a shortest-prefix match would label every one of them "Note".
    expect(labelPathSegments(["NOTE", "MyStyle"])).toEqual(["MyStyle"]);
  });

  it("keeps what is BELOW the category", () => {
    expect(labelPathSegments(["NOTE", "Note", "Sub"])).toEqual(["Note", "Sub"]);
    expect(labelPathSegments(["NOTE", "MyStyle", "Grids"])).toEqual(["MyStyle", "Grids"]);
  });

  it("never flattens a single-segment category — it IS the category", () => {
    // `EXPORT`, `SCREENSHOT` and `INBOX` are not wrappers around anything.
    // Flattening one would promote its notes to the root and delete the folder
    // from the UI entirely.
    expect(labelPathSegments(["EXPORT"])).toEqual(["Export"]);
    expect(labelPathSegments(["SCREENSHOT", "2024"])).toEqual(["Screenshot", "2024"]);
  });

  it("passes a folder the user made themselves through untouched", () => {
    expect(labelPathSegments(["Archive", "2024"])).toEqual(["Archive", "2024"]);
    // A container name is a ROOT-folder fact; the same word deeper down is a
    // folder somebody meant.
    expect(labelPathSegments(["Archive", "NOTE", "x"])).toEqual(["Archive", "NOTE", "x"]);
  });

  it("drops a bare container no category owns, exactly as the rail shows it", () => {
    expect(labelPathSegments(["NOTE", "Whatever"])).toEqual(["Whatever"]);
  });

  it("returns nothing for the root, rather than inventing a name for it", () => {
    expect(labelPathSegments([])).toEqual([]);
  });

  it("does not alias the caller's array", () => {
    const input = ["Archive"];
    expect(labelPathSegments(input)).not.toBe(input);
  });
});

// --- destinations ------------------------------------------------------------
//
// A rail entry with no folder behind it. `DESTINATIONS` ships EMPTY — the bin and
// the admin console each add their line when they land — so these tests install
// their own and remove them again. That is deliberate: the producer is the shared
// foundation two features build on in parallel, and it must be known-good before
// either depends on it, rather than discovered broken twice.

describe("rail destinations", () => {
  const BIN: Destination = { key: "bin", label: "Recycle bin", icon: "trash" };
  const ADMIN: Destination = { key: "admin", label: "Admin", icon: "users", adminOnly: true };

  const install = (...d: Destination[]) => void DESTINATIONS.push(...d);
  afterEach(() => void DESTINATIONS.splice(0, DESTINATIONS.length));

  it("renders under Other, after the folders, never among the categories", () => {
    install(BIN);
    const t = build(SPARSE);
    t.rail.build();
    const rows = t.last();
    expect(rows.filter((r) => r.kind === "label").map((r) => (r.kind === "label" ? r.text : ""))).toEqual([
      "Folders",
      "Other",
    ]);
    const binAt = rows.findIndex((r) => r.kind === "item" && r.name === "Recycle bin");
    const otherAt = rows.findIndex((r) => r.kind === "label" && r.text === "Other");
    expect(binAt).toBeGreaterThan(otherAt);
    expect(names(rows).at(-1)).toBe("Recycle bin");
  });

  it("emits the Other heading for a destination even with no custom root folders", () => {
    // SPARSE holds only NOTE/Note — a known category — so `otherRootFolders()` is
    // empty. Before destinations there was no "Other" heading in this case at
    // all, and a destination rendering under no heading is what this pins.
    install(BIN);
    const t = build(SPARSE);
    t.rail.build();
    expect(t.last().some((r) => r.kind === "label" && r.text === "Other")).toBe(true);
  });

  it("hides an adminOnly destination from a non-admin, shows it to an admin", () => {
    install(BIN, ADMIN);

    const guest = build(SPARSE, { folderId: null, openPath: null }, [], { isAdmin: () => false });
    guest.rail.build();
    expect(names(guest.last())).toContain("Recycle bin");
    expect(names(guest.last())).not.toContain("Admin");

    const admin = build(SPARSE, { folderId: null, openPath: null }, [], { isAdmin: () => true });
    admin.rail.build();
    expect(names(admin.last())).toContain("Admin");
  });

  it("badges from destinationCount, keyed by key and not by label", () => {
    install(BIN, ADMIN);
    const t = build(SPARSE, { folderId: null, openPath: null }, [], {
      isAdmin: () => true,
      destinationCount: (k) => (k === "bin" ? 3 : 0),
    });
    t.rail.build();
    expect(item(t.last(), "Recycle bin")?.badge).toEqual({ kind: "count", value: 3 });
    // A DESTINATION'S 0 IS NO BADGE AT ALL — the regression this pins. The
    // painter used to render the count unconditionally, so the console (which
    // has nothing countable, by design) carried a permanent `0` beside its name
    // and read as an empty inbox. A folder's 0 is a different claim and keeps
    // its badge; see the category tests above.
    expect(item(t.last(), "Admin")?.badge).toBeNull();
  });

  it("shows a destination's state glyph instead of a count, with its own label", () => {
    install(BIN, ADMIN);
    const t = build(SPARSE, { folderId: null, openPath: null }, [], {
      isAdmin: () => true,
      destinationState: (k) => (k === "admin" ? { icon: "lock", label: "Admin console locked" } : null),
    });
    t.rail.build();
    expect(item(t.last(), "Admin")?.badge).toEqual({
      kind: "state",
      icon: "lock",
      label: "Admin console locked",
    });
    // The bin is untouched by the new channel.
    expect(item(t.last(), "Recycle bin")?.badge).toBeNull();
  });

  it("prefers a state glyph over a count — a row has room for one badge", () => {
    install(ADMIN);
    const t = build(SPARSE, { folderId: null, openPath: null }, [], {
      isAdmin: () => true,
      destinationCount: () => 7,
      destinationState: () => ({ icon: "unlock", label: "Admin console unlocked" }),
    });
    t.rail.build();
    expect(item(t.last(), "Admin")?.badge).toEqual({
      kind: "state",
      icon: "unlock",
      label: "Admin console unlocked",
    });
  });

  it("never asks about a destination it is not painting — elevation cannot leak", () => {
    // `adminOnly` filters the row out BEFORE the badge is produced, so a
    // household member's rail never even puts the question. That is what keeps
    // "hidden from non-admins" true of the state as well as of the row: a
    // padlock is a fact about the admin's session, and this is the only place
    // the shell could have leaked it.
    install(BIN, ADMIN);
    const t = build(SPARSE, { folderId: null, openPath: null }, [], { isAdmin: () => false });
    t.rail.build();
    expect(t.destinationState).not.toHaveBeenCalledWith("admin");
    expect(t.destinationCount).not.toHaveBeenCalledWith("admin");
  });

  it("marks the open destination current, and nothing else alongside it", () => {
    install(BIN);
    const t = build(SPARSE, { folderId: null, openPath: null, destination: "bin" });
    t.rail.build();
    expect(item(t.last(), "Recycle bin")?.current).toBe(true);
    // A destination is not a folder: no folder row is current at the same time.
    expect(t.last().filter((r) => r.kind === "item" && r.current)).toHaveLength(1);
  });

  it("routes selection by key, never through the folder or category paths", () => {
    install(BIN);
    const t = build(SPARSE);
    t.rail.build();
    item(t.last(), "Recycle bin")!.select();
    expect(t.onOpenDestination).toHaveBeenCalledWith("bin");
    expect(t.onOpenFolder).not.toHaveBeenCalled();
    expect(t.onSelectCategory).not.toHaveBeenCalled();
  });

  it("renders at depth 0 — a destination is never nested under a folder", () => {
    install(BIN);
    const t = build(SPARSE);
    t.rail.build();
    expect(item(t.last(), "Recycle bin")?.depth).toBe(0);
  });
});
