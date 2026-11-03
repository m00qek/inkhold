// Helpers shared by the bin tests.

import type { Bin, BinEntry } from "../../src/core/binTypes";

// --- fixtures ----------------------------------------------------------------

export const NOW = new Date("2026-07-20T14:00:00Z").getTime();

export function entry(over: Partial<BinEntry> & Pick<BinEntry, "id" | "name">): BinEntry {
  return {
    kind: "note",
    path: "Note",
    deletedAt: NOW,
    size: 0,
    parentId: null,
    isRoot: true,
    fileType: "note",
    fileHash: `${over.id}-md5`,
    firstPage: null,
    ...over,
  };
}

export function bin(entries: BinEntry[], over: Partial<Bin> = {}): Bin {
  return {
    entries,
    // The server's figure, which sums files only.
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
    retentionDays: 30,
    syncVersion: 1,
    ...over,
  };
}

export const FOLDER_DELETE = bin([
  entry({ id: "f", name: "nested_to_remove", kind: "folder", fileType: "", fileHash: null, size: 0 }),
  entry({ id: "a", name: "one.note", parentId: "f", isRoot: false, size: 1000, path: "Note / nested_to_remove" }),
  entry({ id: "b", name: "two.note", parentId: "f", isRoot: false, size: 2000, path: "Note / nested_to_remove" }),
]);

// --- ordering and nesting ----------------------------------------------------
