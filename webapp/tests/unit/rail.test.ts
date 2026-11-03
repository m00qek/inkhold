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

// `DESTINATIONS` ships entries; each test starts empty and the shipped set is restored.
const SHIPPED: Destination[] = [...DESTINATIONS];
beforeEach(() => void DESTINATIONS.splice(0, DESTINATIONS.length));
afterAll(() => void DESTINATIONS.splice(0, DESTINATIONS.length, ...SHIPPED));

// --- fixtures ----------------------------------------------------------------

interface Spec {
  id: Id;
  name: string;
  /** Omitted = the server did not count this folder. */
  count?: number;
  children?: Spec[];
}

const folder = (s: Spec): Folder => ({ kind: "folder", id: s.id, name: s.name, ...(s.count === undefined ? {} : { itemCount: s.count }) });

/** A tree over a literal spec; `unwalked` folders report no children and say so. */
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
/** A row's count, or undefined for no badge or a state glyph. */
const countOf = (rows: RailRow[], name: string): number | undefined => {
  const badge = item(rows, name)?.badge;
  return badge?.kind === "count" ? badge.value : undefined;
};

// --- the pinned six ----------------------------------------------------------

describe("the rail's category anchors", () => {
  it("renders all six even when the device has created only one of them", () => {
    const t = build(SPARSE);
    t.rail.build();

    expect(names(t.last()).slice(0, 6)).toEqual(["Note", "Document", "MyStyle", "Export", "Screenshot", "Inbox"]);
    expect(names(t.last()).slice(0, 6)).toEqual(CATEGORIES.map((c) => c.label));
  });

  it("counts from the server's field, and an absent category reads 0", () => {
    const t = build(FULL);
    t.rail.build();
    const rows = t.last();

    // Direct counts: Note holds Projects + 3 loose notes = 4.
    expect(countOf(rows, "Note")).toBe(4);
    expect(countOf(rows, "MyStyle")).toBe(3);
    expect(countOf(rows, "Document")).toBe(3);
    expect(countOf(rows, "Export")).toBe(0);
    expect(countOf(rows, "Screenshot")).toBe(2);
    expect(countOf(rows, "Inbox")).toBe(1);

    const sparse = build(SPARSE);
    sparse.rail.build();
    expect(countOf(sparse.last(), "Export")).toBe(0);
  });

  it("shows a rail row's count as 0 when the server did not count the folder", () => {
    // The one place `undefined` reads as 0; gallery folder rows show nothing instead.
    const t = build([{ id: "dir-note", name: "NOTE", children: [{ id: "note", name: "Note" }] }]);
    t.rail.build();
    expect(countOf(t.last(), "Note")).toBe(0);
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

// --- categoryIconFor: by identity, like `labelFor` ---------------------------

describe("categoryIconFor", () => {
  it("returns each pinned category's own glyph, by identity", () => {
    const t = build(FULL);
    expect(t.rail.categoryIconFor({ id: "note" })).toBe("note");
    expect(CATEGORIES.find((c) => c.label === "Note")!.icon).toBe("note");
    expect(t.rail.categoryIconFor({ id: "doc" })).toBe("doc");
    expect(t.rail.categoryIconFor({ id: "mystyle" })).toBe("layers");
    expect(t.rail.categoryIconFor({ id: "export" })).toBe("export");
    expect(t.rail.categoryIconFor({ id: "screenshot" })).toBe("image");
    expect(t.rail.categoryIconFor({ id: "inbox" })).toBe("inbox");
  });

  it("returns null for a user folder, even the device CONTAINER it flattens away", () => {
    const t = build(FULL);
    expect(t.rail.categoryIconFor({ id: "archive" })).toBeNull();
    expect(t.rail.categoryIconFor({ id: "scratch" })).toBeNull();
    expect(t.rail.categoryIconFor({ id: "dir-note" })).toBeNull();
    expect(t.rail.categoryIconFor({ id: "projects" })).toBeNull();
  });

  it("returns null for every category before the tree resolves them", () => {
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

    // No id, so nothing is asked for; inventing one would 404.
    expect(t.onOpenFolder).not.toHaveBeenCalled();
    expect(t.rail.pending()?.label).toBe("Export");
    expect(t.onSelectCategory).toHaveBeenCalledTimes(1);
  });

  it("is a real, selectable row — identical to a resolved one apart from what it does", () => {
    const t = build(SPARSE);
    t.rail.build();
    const absent = item(t.last(), "Export")!;
    const present = item(t.last(), "Note")!;
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

  // Regression: clicking Export during load claimed it was empty.
  it("is not yet KNOWN to be absent until the tree walk lands", () => {
    const t = build(SPARSE);
    t.rail.build();
    expect(t.rail.loaded()).toBe(false);

    item(t.last(), "Export")!.select();

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
    expect(t.rail.pending()?.label).toBe("Export");
    expect(t.onOpenFolder).not.toHaveBeenCalled();
    expect(t.onSettled).toHaveBeenCalledTimes(1);
  });

  it("goes to the folder when the walk resolves the category after all", () => {
    // Export is selected while the walk is at the root and `EXPORT` turns up later.
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

    expect(onOpenFolder).toHaveBeenCalledWith("export");
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("repaints the root when the walk lands with nothing pending", () => {
    const t = build(FULL, { folderId: null, openPath: null });
    t.rail.treeWalked();
    expect(t.onSettled).toHaveBeenCalledTimes(1);

    // In a real folder only the names are provisional, so only the narrow callback fires.
    const inside = build(FULL, { folderId: "note", openPath: [] });
    inside.rail.treeWalked();
    expect(inside.onSettled).not.toHaveBeenCalled();
    expect(inside.onLabelsSettled).toHaveBeenCalledTimes(1);
  });

  it("owes the gallery nothing when the walk found the tree unchanged", () => {
    // A syncing tablet bumps per file; `changed` gates the full repaint.
    const root = build(FULL, { folderId: null, openPath: null });
    root.rail.treeWalked(false);
    expect(root.onSettled).not.toHaveBeenCalled();

    const inside = build(FULL, { folderId: "note", openPath: [] });
    inside.rail.treeWalked(false);
    expect(inside.onLabelsSettled).not.toHaveBeenCalled();

    // A pending category repaints when the walk finishes, whatever it found.
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
    // Single-segment categories are the category; flattening would hide their folders.
    for (const name of ["EXPORT", "SCREENSHOT", "INBOX"]) expect(CONTAINER_NAMES.has(name)).toBe(false);
  });

  it("never shows a container in the rail, and never shows a folder twice", () => {
    const t = build(FULL);
    t.rail.build();
    const shown = names(t.last());

    expect(shown).not.toContain("NOTE");
    expect(shown).not.toContain("DOCUMENT");
    for (const name of shown) expect(shown.filter((n) => n === name)).toHaveLength(1);
  });

  it("promotes a user folder made inside a container rather than losing it", () => {
    const t = build(FULL);
    t.rail.build();
    const rows = t.last();

    // `NOTE/Scratch` is not a category; flattening NOTE must still promote it.
    expect(names(rows)).toContain("Scratch");
    expect(names(rows)).toContain("Archive");
    const other = rows.findIndex((r) => r.kind === "label" && r.text === "Other");
    expect(other).toBeGreaterThan(0);
    expect(names(rows.slice(other))).toEqual(["Scratch", "Archive"]);

    item(rows, "Scratch")!.select();
    expect(t.onOpenFolder).toHaveBeenCalledWith("scratch");
  });

  it("contributes nothing from a container it has not walked yet", () => {
    const t = build(FULL, { folderId: null, openPath: null }, ["dir-note"]);
    t.rail.build();
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
    expect(projects.depth).toBe(1);
    expect(projects.badge).toEqual({ kind: "count", value: 2 });
  });

  it("expands nothing at all when there is no listing yet", () => {
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
    expect(out).toContain("Scratch");
    expect(out).toContain("Archive");
  });

  it("drops the containers even before the walk, and still shows ALL SIX anchors", () => {
    // The six anchors are present from first paint; unresolved ones show "Loading…".
    const t = build(FULL, { folderId: null, openPath: null }, ["dir-note"]);
    const out = t.rail.rootEntries(raw).map((e) => e.name);
    expect(out).not.toContain("NOTE");
    expect(out).not.toContain("DOCUMENT");
    expect(out.slice(0, 6)).toEqual(["Note", "Document", "MyStyle", "EXPORT", "SCREENSHOT", "INBOX"]);
  });

  it("stands in for an anchor the device has no folder for, and never as a real folder", () => {
    // An unresolved anchor is a card with no folder behind it.
    const t = build([]);
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
    expect(crumbPath(p("NOTE")).map((f) => f.name)).toEqual(["NOTE"]);
  });

  it("keeps a deeply-nested folder that merely happens to be called NOTE", () => {
    // A container name is a root-folder fact only.
    expect(crumbPath(p("Archive", "NOTE", "x")).map((f) => f.name)).toEqual(["Archive", "NOTE", "x"]);
  });

  it("leaves a single-segment category alone", () => {
    expect(crumbPath(p("SCREENSHOT", "2024")).map((f) => f.name)).toEqual(["SCREENSHOT", "2024"]);
  });
});

// --- labelPathSegments: `crumbPath` for plain segments (the bin) -------------

describe("labelPathSegments", () => {
  it("labels a category and flattens the container it sits in", () => {
    expect(labelPathSegments(["NOTE", "Note"])).toEqual(["Note"]);
  });

  it("picks the LONGEST matching category, not the first", () => {
    // `NOTE/Note` and `NOTE/MyStyle` share a first segment.
    expect(labelPathSegments(["NOTE", "MyStyle"])).toEqual(["MyStyle"]);
  });

  it("keeps what is BELOW the category", () => {
    expect(labelPathSegments(["NOTE", "Note", "Sub"])).toEqual(["Note", "Sub"]);
    expect(labelPathSegments(["NOTE", "MyStyle", "Grids"])).toEqual(["MyStyle", "Grids"]);
  });

  it("never flattens a single-segment category — it IS the category", () => {
    // `EXPORT`, `SCREENSHOT` and `INBOX` are not wrappers.
    expect(labelPathSegments(["EXPORT"])).toEqual(["Export"]);
    expect(labelPathSegments(["SCREENSHOT", "2024"])).toEqual(["Screenshot", "2024"]);
  });

  it("passes a folder the user made themselves through untouched", () => {
    expect(labelPathSegments(["Archive", "2024"])).toEqual(["Archive", "2024"]);
    // A container name is a root-folder fact only.
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
    // Regression: a destination's 0 rendered as a badge, so the console read as an empty inbox.
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
    // `adminOnly` filters the row before its badge is produced.
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
