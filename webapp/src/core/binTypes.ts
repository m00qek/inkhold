// The recycle bin's domain vocabulary — the client half of `BinVO`/`RestoredVO`/
// `TrashedVO`/`EmptiedVO` in backend/services/controlplane.zig.
//
// A SEPARATE FILE from core/types.ts on purpose: the bin and the admin console
// are being built in parallel against the same shared modules, so each keeps its
// own vocabulary in its own file and the two sets of edits stay textually
// disjoint. Same rule as the `--- BIN WRITES ---` markers on the `Api` seam.
//
// Nothing here has behaviour. It is data, exactly like core/types.ts.

import type { Hash, Id, PageRef } from "./types";

/**
 * One trashed row. FLAT — the server deliberately does not group or nest, which
 * is why {@link parentId} and {@link isRoot} are here: the nesting the bin view
 * renders is derived on the client (see `binRows` in pages/bin.ts).
 */
export interface BinEntry {
  /** The same two values `Entry.kind` uses, so the client's kind branch works. */
  kind: "folder" | "note";
  id: Id;
  name: string;
  /**
   * The path the entry had WHEN IT WAS DELETED, walked through trashed
   * ancestors. Half of the disambiguation the bin needs — the other half is
   * {@link deletedAt}, because the same name can be deleted from the same place
   * twice (delete → the device recreates it → delete).
   */
  path: string;
  /** Epoch ms, matching `NoteSummary.updatedAt`. */
  deletedAt: number;
  /**
   * Bytes this row itself charges against quota, and **0 for a folder**.
   *
   * A folder's bytes are its children's, and the children are rows in the same
   * list — so summing `size` over any set of rows is correct by construction and
   * can never count a folder together with its contents. That is exactly what
   * the purge and empty-bin confirmations have to state, and the double-count is
   * the mistake the field's shape rules out rather than asks callers to avoid.
   */
  size: number;
  /** The trashed parent this row came down with, or null when it has none here. */
  parentId: Id | null;
  /** True when this is the top of a trashed subtree — what the user deleted. */
  isRoot: boolean;
  /**
   * Server-verified, same vocabulary as `NoteSummary.fileType`. Empty string for
   * a folder, which has no type of its own.
   */
  fileType: string;
  /** The `?v=` of the bin-scoped raw-bytes URL, or null when there is none. */
  fileHash: Hash | null;
  /**
   * Page 0, for the row's thumbnail — the same field, the same shape and the
   * same content hash `NoteSummary.firstPage` carries, so the row paints through
   * the shared lazy engine and hits the same render cache the library filled.
   * The bin-scoped fetch is automatic: `createBinScope` routes `getPageBytes`
   * for a trashed id to the bin's own route.
   *
   * NULL when there is nothing to draw — a folder, or a file the indexer could
   * not parse a page out of. That is not a hole to paper over: the row's honest
   * fallback is the doc glyph, and a placeholder ref would trade it for an empty
   * canvas plus a page fetch that can only 404.
   */
  firstPage: PageRef | null;
  /**
   * The preview's pixel dimensions, exactly as `NoteSummary.thumbAspect` carries
   * them (same sources, same absent-means-unknown rule — the index is keyed by
   * blob md5, so trashing changes nothing about a file's shape). The bin row
   * pre-sets its lead tile's aspect from this so the row lays out at its final
   * width before any bytes arrive.
   */
  thumbAspect?: { w: number; h: number };
}

/** `GET /api/controlplane/bin`. */
export interface Bin {
  /** Newest deletion first. */
  entries: BinEntry[];
  /**
   * What emptying the whole bin would free. The server sums only non-folder
   * rows, so this is the honest figure rather than one that counts a folder and
   * its contents both.
   */
  totalBytes: number;
  /**
   * The retention window, from the server's own `Files.bin_retention_s`, so the
   * empty state and the per-row countdown quote the real number instead of a
   * hardcoded copy that can drift from it.
   */
  retentionDays: number;
  syncVersion: number;
}

/**
 * What a web delete actually did (U5), so the undo toast can state the fanout
 * when the operation exceeds the one row that was clicked.
 */
export interface Trashed {
  id: Id;
  name: string;
  isFolder: boolean;
  /** Rows tombstoned, the clicked one included. `> 1` only for a folder. */
  entries: number;
}

/**
 * What `restore` actually did — **not what was asked** (U3).
 *
 * Restore routinely does more than the user selected and the UI cannot tell the
 * truth otherwise: it brings back the trashed ancestor chain (a live row under a
 * trashed parent would be an orphan, in no listing at all), it brings back every
 * trashed descendant of a folder, and it auto-renames when a live entry has
 * taken the name in the meantime. So every field here is load-bearing copy.
 */
export interface Restored {
  /** The name it came back under — NOT necessarily the one it had. */
  name: string;
  renamed: boolean;
  /** Trashed ancestor folders that had to come back for this to be reachable. */
  ancestors: number;
  /** Trashed descendants that came back with a restored folder. */
  descendants: number;
}
