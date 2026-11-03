// The recycle bin's domain vocabulary: the client half of `BinVO`/`RestoredVO`/
// `TrashedVO`/`EmptiedVO` in backend/services/controlplane.zig.

import type { Hash, Id, PageRef } from "./types";

/**
 * One trashed row. Flat; the nesting the bin view renders is derived on the
 * client from {@link parentId} and {@link isRoot}.
 */
export interface BinEntry {
  kind: "folder" | "note";
  id: Id;
  name: string;
  /**
   * The path at deletion time, through trashed ancestors. With
   * {@link deletedAt} it disambiguates the same name deleted twice.
   */
  path: string;
  /** Epoch ms, matching `NoteSummary.updatedAt`. */
  deletedAt: number;
  /**
   * Bytes this row charges against quota, 0 for a folder, so summing `size`
   * over any set of rows never double-counts a folder and its contents.
   */
  size: number;
  /** The trashed parent this row came down with, or null when it has none here. */
  parentId: Id | null;
  /** True when this is the top of a trashed subtree — what the user deleted. */
  isRoot: boolean;
  /** Same vocabulary as `NoteSummary.fileType`; `""` for a folder. */
  fileType: string;
  /** The `?v=` of the bin-scoped raw-bytes URL, or null when there is none. */
  fileHash: Hash | null;
  /**
   * Page 0 for the thumbnail, same shape and hash as `NoteSummary.firstPage`,
   * so it hits the library's render cache. Null when there is nothing to draw
   * (folder or unparseable file); the row then shows the doc glyph.
   */
  firstPage: PageRef | null;
  /** As `NoteSummary.thumbAspect`; trashing doesn't change a blob's shape. */
  thumbAspect?: { w: number; h: number };
}

/** `GET /api/controlplane/bin`. */
export interface Bin {
  /** Newest deletion first. */
  entries: BinEntry[];
  /** What emptying the bin would free; folders excluded. */
  totalBytes: number;
  /** From the server's `Files.bin_retention_s`. */
  retentionDays: number;
  syncVersion: number;
}

/** What a web delete did, so the undo toast can state the fanout. */
export interface Trashed {
  id: Id;
  name: string;
  isFolder: boolean;
  /** Rows tombstoned, the clicked one included. `> 1` only for a folder. */
  entries: number;
}

/**
 * What `restore` actually did, not what was asked: it also restores the
 * trashed ancestor chain (else the row would be orphaned), a folder's trashed
 * descendants, and auto-renames on a name collision.
 */
export interface Restored {
  /** The name it came back under, not necessarily the one it had. */
  name: string;
  renamed: boolean;
  /** Trashed ancestor folders that had to come back for this to be reachable. */
  ancestors: number;
  /** Trashed descendants that came back with a restored folder. */
  descendants: number;
}
