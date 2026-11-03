// Rail containers, nested rows, root entries, crumbs, labels and destinations.

import { describe, it, expect, afterEach, beforeEach, afterAll } from "vitest";
import { crumbPath, CONTAINER_NAMES, labelPathSegments, DESTINATIONS, type Destination } from "../../src/pages/rail";
import type { Entry, Folder } from "../../src/core/types";
import { SHIPPED, folder, FULL, SPARSE, build, names, item } from "./rail.shared";

beforeEach(() => void DESTINATIONS.splice(0, DESTINATIONS.length));

afterAll(() => void DESTINATIONS.splice(0, DESTINATIONS.length, ...SHIPPED));

// --- fixtures ----------------------------------------------------------------

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
