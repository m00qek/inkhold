import { describe, it, expect } from "vitest";
import { binRows, emptyConfirm, emptyStateBody, folderLabel, groupLabel, purgeConfirm, restoreMessage, trashMessage } from "../../src/pages/bin/bin";
import type { Bin, BinEntry } from "../../src/core/binTypes";

// --- fixtures ----------------------------------------------------------------
import { NOW, entry, bin, FOLDER_DELETE } from "./bin.shared";

const DAY = 24 * 60 * 60 * 1000;

describe("bin rows", () => {
  it("keeps a trashed subtree together, children nested under their parent", () => {
    const rows = binRows(FOLDER_DELETE, NOW);
    expect(rows.map((r) => r.entry.id)).toEqual(["f", "a", "b"]);
    expect(rows.map((r) => r.child)).toEqual([false, true, true]);
  });

  it("gives a whole subtree its ROOT's date heading, never one per child", () => {
    const split = bin([
      entry({ id: "f", name: "folder", kind: "folder", fileType: "", fileHash: null, deletedAt: NOW }),
      entry({ id: "a", name: "one.note", parentId: "f", isRoot: false, deletedAt: NOW - 2 * DAY }),
    ]);
    const rows = binRows(split, NOW);
    expect(rows.map((r) => r.group)).toEqual(["Deleted today", "Deleted today"]);
  });

  it("promotes an orphan rather than dropping it", () => {
    const orphan = bin([entry({ id: "a", name: "one.note", parentId: "gone", isRoot: false })]);
    const rows = binRows(orphan, NOW);
    expect(rows.map((r) => r.entry.id)).toEqual(["a"]);
    expect(rows[0]!.child).toBe(false);
  });

  it("makes a folder unopenable and a file openable", () => {
    const rows = binRows(FOLDER_DELETE, NOW);
    expect(rows.map((r) => r.openable)).toEqual([false, true, true]);
  });

  it("counts the fanout and the bytes over the SUBTREE, not the row", () => {
    const [folder, a] = binRows(FOLDER_DELETE, NOW);
    expect(folder!.fanout).toBe(3);
    expect(folder!.bytes).toBe(3000);
    expect(a!.fanout).toBe(1);
    expect(a!.bytes).toBe(1000);
  });

  it("counts down from the server's retention window and reddens near the end", () => {
    const rows = binRows(
      bin(
        [
          entry({ id: "fresh", name: "fresh.note", deletedAt: NOW }),
          entry({ id: "old", name: "old.note", deletedAt: NOW - 26 * DAY }),
        ],
        { retentionDays: 30 },
      ),
      NOW,
    );
    expect(rows.map((r) => r.daysLeft)).toEqual([30, 4]);
    expect(rows.map((r) => r.soon)).toEqual([false, true]);
  });

  it("names the size and type of a file, and the contents of a folder", () => {
    const rows = binRows(FOLDER_DELETE, NOW);
    expect(rows[0]!.detail).toBe("folder · 2 items");
    expect(rows[1]!.detail).toBe(".note · 1000 B");
  });
});

describe("group headings", () => {
  it("counts CALENDAR days, so 23:50 is yesterday at 00:10 and not today", () => {
    const late = new Date("2026-07-19T23:50:00").getTime();
    const early = new Date("2026-07-20T00:10:00").getTime();
    expect(groupLabel(late, early)).toBe("Deleted yesterday");
  });

  it("says today, yesterday, then a count", () => {
    const now = new Date("2026-07-20T12:00:00").getTime();
    expect(groupLabel(new Date("2026-07-20T09:00:00").getTime(), now)).toBe("Deleted today");
    expect(groupLabel(new Date("2026-07-19T09:00:00").getTime(), now)).toBe("Deleted yesterday");
    expect(groupLabel(new Date("2026-07-14T09:00:00").getTime(), now)).toBe("Deleted 6 days ago");
  });
});

// --- the sentences ------------------------------------------------------------

describe("confirmation copy", () => {
  it("names the object and the act, and the button repeats it", () => {
    const row = binRows(bin([entry({ id: "a", name: "download_test.note", size: 2_202_009 })]), NOW)[0]!;
    const spec = purgeConfirm(row);
    expect(spec.title).toBe("Delete download_test.note permanently?");
    expect(spec.action).toBe("Delete permanently");
    expect(spec.body).not.toMatch(/sure/i);
  });

  it("declares the fanout only when the operation exceeds the selection", () => {
    const [folder, child] = binRows(FOLDER_DELETE, NOW);
    expect(purgeConfirm(folder!).body).toContain("Deletes the folder and the 2 items inside it");
    expect(purgeConfirm(child!).body).toBe("This can’t be undone.");
  });

  it("states the space freed, because purge is the only moment it comes back", () => {
    const row = binRows(bin([entry({ id: "a", name: "a.note", size: 2_202_009 })]), NOW)[0]!;
    expect(purgeConfirm(row).frees).toBe("2.1 MB");
  });

  it("never double-counts a folder with its contents in the empty-bin total", () => {
    // Folder rows weigh 0, so summing every row equals summing the files.
    const spec = emptyConfirm(FOLDER_DELETE);
    expect(spec.frees).toBe("2.9 KB");
    expect(spec.title).toBe("Delete all 3 items permanently?");
    expect(spec.action).toBe("Empty bin");
  });
});

describe("result copy", () => {
  it("reports what restore ACTUALLY did, not what was asked", () => {
    expect(restoreMessage({ name: "BuJo (2).note", renamed: true, ancestors: 2, descendants: 0 })).toBe(
      "Restored as BuJo (2).note · also restored 2 folders — back on your Supernote at the next sync",
    );
    expect(restoreMessage({ name: "folder", renamed: false, ancestors: 0, descendants: 3 })).toBe(
      "Restored folder · with the 3 items inside it — back on your Supernote at the next sync",
    );
  });

  it("states the trash fanout, and nothing extra when there is none", () => {
    expect(trashMessage({ id: "1", name: "a.note", isFolder: false, entries: 1 })).toBe("Moved a.note to Recycle bin");
    expect(trashMessage({ id: "1", name: "folder", isFolder: true, entries: 3 })).toBe(
      "Moved folder and the 2 items inside it to Recycle bin",
    );
  });

  it("quotes the server's retention window in the empty state, never a copy of it", () => {
    expect(emptyStateBody(14)).toContain("14 days");
  });
});

// --- where the row says the entry used to live --------------------------------

describe("the folder a trashed entry came from", () => {
  it("strips the entry's own name and names the folder the way the rail does", () => {
    expect(folderLabel("/NOTE/Note/deep.note", "deep.note")).toBe("Note");
    expect(folderLabel("/NOTE/Note/nested_to_remove/one.note", "one.note")).toBe("Note / nested_to_remove");
  });

  it("keeps a parent that happens to share the entry's name", () => {
    // Strip only the trailing segment: a same-named parent must survive.
    expect(folderLabel("/NOTE/Note/Work/Work", "Work")).toBe("Note / Work");
  });

  it("says Library rather than nothing when the entry sat at the root", () => {
    expect(folderLabel("/loose.note", "loose.note")).toBe("Library");
    expect(folderLabel("/NOTE", "NOTE")).toBe("Library");
  });

  it("survives a path the strip does not apply to", () => {
    expect(folderLabel("/NOTE/Note", "deep.note")).toBe("Note");
    expect(folderLabel("", "deep.note")).toBe("Library");
  });
});

// --- what asks and what does not --------------------------------------------
