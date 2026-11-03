import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createRail, CATEGORIES, DESTINATIONS, type FolderTree, type RailRow } from "../../src/pages/rail";
import { SHIPPED, Spec, folder, treeOf, FULL, SPARSE, build, names, item } from "./rail.shared";

beforeEach(() => void DESTINATIONS.splice(0, DESTINATIONS.length));

afterAll(() => void DESTINATIONS.splice(0, DESTINATIONS.length, ...SHIPPED));

// --- fixtures ----------------------------------------------------------------

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
