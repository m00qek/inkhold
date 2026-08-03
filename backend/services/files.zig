//! The file-tree service: the logical layer over the `files`/`blobs`/`capacity`
//! tables and the content-addressed `BlobStore`. It owns the storage invariants
//! so the HTTP faces (device sync, control plane) stay thin:
//!
//!   - every operation is scoped by `user_id` (the core security guarantee);
//!   - a blob's `refcount` tracks how many live files reference it, and the
//!     on-disk blob is GC'd when it reaches 0;
//!   - `capacity.used_bytes` tracks a user's usage, enforced against quota, and
//!     is charged **per distinct blob per user** — see below;
//!   - deletes are soft (tombstones) so sync can report removals; folder deletes
//!     recurse over the whole subtree.
//!
//! Multi-table mutations run in a transaction. The blob is written to disk
//! *before* the DB commit and GC'd *after* it, so a crash can only ever orphan a
//! blob (harmless, content-addressed, reclaimable) — never leave a file row
//! pointing at missing bytes.
//!
//! ## The recycle bin
//!
//! Deleting happens in two stages, and the split is the whole design:
//!
//!   - `trash` tombstones (`deleted = 1`, `deleted_at = now`) and **holds every
//!     blob reference**. Nothing is released, nothing is refunded — the row is
//!     merely hidden from listings, from search (which joins `deleted = 0`) and
//!     from the unique live-name index.
//!   - `purge` / `emptyBin` / `sweepBin` hard-delete the rows and are the **only**
//!     callers of `decref` outside account deletion. That is where the blob's
//!     refcount drops, where `note_index`/`note_page_fts` go, where the on-disk
//!     blob is GC'd, and where `addUsed(-bytes)` finally happens.
//!
//! Before the bin, a tombstone decref'd in the same transaction: the blob could
//! be GC'd from disk while the tombstone survived, pointing at bytes that no
//! longer existed. `deleted = 1` was a sync tombstone, not a bin, and restore was
//! impossible. Because the blob now stays alive, and the md5-keyed `note_index`
//! rows with it, `restore` is a flag flip rather than a re-index.
//!
//! Quota keeps charging while an entry is trashed. The bytes still occupy disk,
//! and refunding at trash time would let a user exceed real usage by cycling the
//! bin.
//!
//! ## What quota counts
//!
//! `used_bytes` is the sum of the sizes of the **distinct blobs** a user's rows
//! keep alive — not the sum of their `files.size` columns. The store is
//! content-addressed, so a user's two identical files are one file on disk;
//! billing both charges for storage that was never allocated, and the error
//! compounds with every duplicate a device syncs. `userChargedRefs` is the
//! per-user counterpart to the global `blobs.refcount` that makes this decidable:
//! a link charges only on a user's first reference to a blob, a purge refunds only
//! on their last. Dedup ACROSS users is not a discount — two users holding the
//! same content are each charged for it.
//!
//! **A reference is anything that keeps the bytes on disk**, which since
//! docs/scratch/user-options.md §6 means `files` rows (live OR trashed) AND
//! `file_history` rows. That is the same rule the trashed-file paragraph above
//! states, applied consistently: a retained version survives the GC gate on the
//! strength of its history row alone, so it occupies disk the account is
//! responsible for. Charging it also makes the per-user `K` a safe thing to hand
//! to a person — raising it spends their own allotment.
//!
//! `userBlobRefs` (files only) survives alongside it and is NOT interchangeable:
//! SEARCH rows follow live file references, because text from content no file
//! holds must stop being findable whatever history says.
//!
//! Under quota pressure the write paths **evict the user's oldest versions rather
//! than refuse**, and refuse only when the live files alone do not fit — see
//! `linkBlobIndexed`. History is discardable; the ability to edit a note is not.
//!
//! The invariant is asserted directly by the quota-audit test at the bottom of
//! this file, which rebuilds the total from `files`/`file_history`/`blobs` and
//! demands the running counter agree — and by the partition audit beside it,
//! which demands the account screen's five figures sum to exactly that total.

const std = @import("std");
const config = @import("../config.zig");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const authsvc = @import("auth/service.zig");
const noteindex = @import("note_index.zig");
const notesearch = @import("search/maintain.zig");
const thumbnail = @import("thumbnail.zig");
const spdindex = @import("spd_index.zig");
const txtindex = @import("txt_index.zig");

const md5_len = blobstore.md5_hex_len;

pub const Entry = struct {
    id: u64,
    parent_id: ?u64,
    name: []const u8, // owned
    is_folder: bool,
    md5: ?[]const u8, // owned; null for folders
    size: u64,
    updated_at: i64,
};

/// One RETAINED version of a file (a `file_history` row), for the hot-cache
/// history UI. Being in `file_history` is itself the guarantee the blob is on
/// disk AND its md5-keyed `note_index` is present (retention keeps both, H1/H2),
/// so nothing here ever needs a re-parse. `md5` is an inline 32-hex copy, so it
/// outlives any statement/arena it was read from.
pub const HistoryVersion = struct {
    md5: [md5_len]u8,
    size: u64,
    created_at: i64,
};

/// Which state a file-history read is gated to. The live history routes use
/// `.live` (`deleted = 0`); the bin's view-only history twins use `.trashed`
/// (`deleted = 1`), which a trashed file's RETAINED `file_history` (H10) makes
/// reachable. The two are otherwise the same read, so this is the ONE parameter
/// that separates them — exactly the split `ControlPlaneService.ReadScope` makes
/// for the note/blob lookups (it aliases this enum, so there is one scope type).
pub const HistoryScope = enum {
    live,
    trashed,

    /// The `files.deleted` value this scope gates on.
    fn deletedFlag(self: HistoryScope) i64 {
        return switch (self) {
            .live => 0,
            .trashed => 1,
        };
    }
};

/// One entry of the device file-enumeration walk: an `Entry` plus its computed
/// Dropbox-format `path_display` (leading slash, NO trailing) and `parent_path`
/// (its folder's `path_display`; root-level entries → "/"). Feeds the device
/// file API (`list_folder`, `query/by/path_v3`, `query_v3`, `download_v3`). All
/// slices are owned by the allocator passed to the producing function.
pub const TreeNode = struct {
    id: u64,
    name: []const u8,
    is_folder: bool,
    md5: []const u8, // "" for folders
    size: u64,
    updated_at: i64,
    path_display: []const u8,
    parent_path: []const u8,
};

/// One row of the recycle-bin listing (`Files.listBin`). All slices are owned by
/// the allocator passed to `listBin` — pass an arena and free it wholesale.
///
/// `path` is the path the entry had **when it was deleted**, frozen into
/// `files.deleted_path` by `trash` and read back verbatim (see `listBin`), with a
/// leading slash and no trailing one — the same Dropbox form `pathOf`/`walkTree`
/// produce. The VO field stays `path`: the change is where it is sourced, not the
/// wire shape, so `bin.ts` and the frontend are unaffected.
pub const BinEntry = struct {
    id: u64,
    parent_id: ?u64,
    name: []const u8,
    is_folder: bool,
    md5: ?[]const u8, // null for folders and for a row with no blob
    size: u64, // 0 for folders — a folder's bytes are its children's
    deleted_at: i64,
    path: []const u8,
    /// True when this row is the TOP of a trashed subtree: its parent is the
    /// root, or a folder that is still live. False means some ancestor of this
    /// row is in the bin too, so the UI can nest it under that ancestor instead
    /// of listing it as a thing the user deleted on its own.
    ///
    /// Computed here rather than left to the client because it is a fact about
    /// rows the client may not have (a live parent never appears in the bin
    /// listing at all), so it is not derivable from the response alone.
    is_root: bool,
};

/// A row of `upload_sessions`: an in-flight device upload keyed by `inner_name`.
/// Slices are owned by the allocator passed to `uploadSession`.
pub const UploadSession = struct {
    path: []const u8, // destination folder (Dropbox form, no trailing slash; "/" = root)
    file_name: []const u8,
    declared_size: u64,
    blob_md5: ?[]const u8, // null until /oss/put has stored the bytes
    /// Bytes this session has staged so far, summed over its DISTINCT parts (v5).
    /// What makes the `/oss/put` byte cap per-session rather than per-part: each
    /// arriving part is held to what is left of `declared_size` + slack, not to
    /// the whole figure again. See `addUploadReceived`.
    received_bytes: u64,
};

pub const Files = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    /// The derived-thumbnail store (`thumbs/<source_md5>` beside the blob
    /// root). Written at ingest and by the on-demand repair; cleaned up by
    /// `removeBlobFiles` whenever a blob leaves disk.
    thumbs: thumbstore.ThumbStore,
    /// Single-flight gate for `repairDerivedThumb`. A gallery load after a
    /// restore fires N missing-thumbnail GETs at once; N concurrent derives
    /// (up to a 16 MiB `.spd` buffer, or a full `.note` index parse) would
    /// blow the RSS budget, so the holder derives and waiters re-check the
    /// repair gate after acquiring (double-checked locking).
    ///
    /// **LOCK ORDER: repair mutex FIRST, `db_lock` second — never the
    /// reverse.** `repairDerivedThumb` takes the db lock itself inside its
    /// critical section, so a caller already holding the db lock would
    /// deadlock against a second repairing thread. The `/thumbnail` handler
    /// releases the db lock before calling in. (`std.Io.Mutex`, like the
    /// db lock itself — NOT reentrant.)
    thumb_repair: std.Io.Mutex = .init,

    /// Hot-cache versioning bounds (docs/scratch/hot-cache-versioning.md). Left
    /// at the compiled default by `init` (keep = 5); production overwrites it
    /// from `Config.history` in http/transport.zig. `keep = 0` disables
    /// versioning: no `file_history` rows are written and supersede prunes the
    /// old blob exactly as it did before this feature.
    history: config.History = .{},

    pub fn init(gpa: std.mem.Allocator, io: std.Io, db: sqlite.Db, blobs: blobstore.BlobStore, thumbs: thumbstore.ThumbStore) Files {
        return .{ .gpa = gpa, .io = io, .db = db, .blobs = blobs, .thumbs = thumbs };
    }

    fn now(self: Files) i64 {
        return std.Io.Clock.real.now(self.io).toSeconds();
    }

    // ---- reads ----

    /// Lists the live entries directly under `parent_id` (null = root) for a user.
    /// Caller owns the result — free via `freeEntries`.
    pub fn list(self: Files, user_id: u64, parent_id: ?u64) ![]Entry {
        var out: std.ArrayList(Entry) = .empty;
        errdefer freeList(self.gpa, &out);

        var s = try self.db.prepare(
            "SELECT id, parent_id, name, is_folder, md5, size, updated_at FROM files " ++
                "WHERE user_id = ?1 AND COALESCE(parent_id, 0) = COALESCE(?2, 0) AND deleted = 0 " ++
                "ORDER BY is_folder DESC, name;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        bindOpt(s, 2, parent_id);
        while (try s.step()) try out.append(self.gpa, try self.rowToEntry(&s));
        return out.toOwnedSlice(self.gpa);
    }

    /// How many live children a folder holds, DIRECTLY, of any kind.
    ///
    /// ONE NUMBER, COUNTING EVERYTHING. Not "notes": the tree is not all `.note`
    /// — the device syncs PDFs into `DOCUMENT/`, PNGs into `SCREENSHOT/` and
    /// `.spd` files besides — so a count labelled "notes" would be wrong for most
    /// folders whether or not they also hold subfolders. "Items" is the honest
    /// noun, and it folds subfolders in without a second number.
    ///
    /// Two rules, both load-bearing:
    ///
    ///  - **Direct children only.** A recursive count would be a different fact
    ///    (and a tree walk per row); the listing shows one level, so it counts one
    ///    level.
    ///  - **`deleted = 0` only.** Trashed rows must never inflate a folder's
    ///    count. The bin is invisible to every listing read (`list`, `get`,
    ///    path resolution) and a count that disagreed with the listing beside it
    ///    would be the one place the bin leaked back into view.
    ///
    /// One indexed lookup: `files_user_parent (user_id, parent_id, deleted)` covers
    /// the whole predicate, so this is a COUNT over an index range. A listing holds
    /// few subfolders, so `listing()` calling this once per folder row is a handful
    /// of index probes — deliberately NOT a scan or a join.
    pub fn childCount(self: Files, user_id: u64, folder_id: u64) !i64 {
        // An aggregate always yields exactly one row, even over zero matches.
        var r = (try self.db.row(
            "SELECT COUNT(*) FROM files WHERE user_id = ?1 AND parent_id = ?2 AND deleted = 0;",
            &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(folder_id) } },
        )) orelse return 0;
        defer r.finalize();
        return r.int(0);
    }

    /// The user's current sync-version: a monotonic counter bumped on every
    /// change to their file tree (see `bumpSync`). The control-plane face returns it so the
    /// browser can tell whether a cached listing is stale. A user who has never
    /// had a change (no row) reads as 0.
    pub fn syncVersion(self: Files, user_id: u64) !i64 {
        var r = (try self.db.row("SELECT version FROM sync_state WHERE user_id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return 0;
        defer r.finalize();
        return r.int(0);
    }

    /// Bumps the user's sync-version (creating the row at 1 on the first change).
    /// Called from every tree mutation so a device upload that changes files, or
    /// a folder create/delete, moves the counter the control-plane face watches. Callers
    /// that hold a transaction bump inside it, so the counter commits atomically
    /// with the change it describes.
    fn bumpSync(self: Files, user_id: u64) !void {
        var s = try self.db.prepare(
            "INSERT INTO sync_state(user_id, version) VALUES(?1, 1) " ++
                "ON CONFLICT(user_id) DO UPDATE SET version = version + 1;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        _ = try s.step();
    }

    /// Fetches one live entry by id (scoped to `user_id`), or null.
    pub fn get(self: Files, user_id: u64, id: u64) !?Entry {
        var r = (try self.db.row(
            "SELECT id, parent_id, name, is_folder, md5, size, updated_at FROM files " ++
                "WHERE id = ?1 AND user_id = ?2 AND deleted = 0;",
            &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
        )) orelse return null;
        defer r.finalize();
        return try self.rowToEntry(&r.stmt);
    }

    /// Fetches one **trashed** entry by id (scoped to `user_id`), or null. The
    /// bin's preview endpoints read through this and nothing else.
    ///
    /// It exists rather than reusing `getAnyState` because the two answer
    /// different questions. `getAnyState` is deliberately state-BLIND, because the
    /// device's delete retry must name a row that was live on the first call and
    /// trashed on the second. Preview is the opposite: it is only ever looking at
    /// something in the bin, so the narrower lookup is the one that matches, and a
    /// bin-preview route wired to it can never quietly grow into a second general
    /// read path for live files. `get` stays the shared ownership boundary for
    /// every listing/metadata/page/search read and is NOT relaxed — loosening it
    /// would leak trashed rows back into all of them.
    ///
    /// A foreign id, a missing id and a LIVE id all read as null, so none of them
    /// is distinguishable from the others through this endpoint.
    pub fn getTrashed(self: Files, user_id: u64, id: u64) !?Entry {
        var r = (try self.db.row(
            "SELECT id, parent_id, name, is_folder, md5, size, updated_at FROM files " ++
                "WHERE id = ?1 AND user_id = ?2 AND deleted = 1;",
            &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
        )) orelse return null;
        defer r.finalize();
        return try self.rowToEntry(&r.stmt);
    }

    /// Fetches one entry by id (scoped to `user_id`) in **any state — live or
    /// trashed**, or null. The bin's own paths need this: `get` hardcodes
    /// `deleted = 0`, so the moment a row is tombstoned it reports as missing,
    /// and the device's delete retry could not even name the thing it deleted.
    ///
    /// NOT a general read path. `get` is the shared ownership boundary for every
    /// listing, note-metadata, page-byte and search read; relaxing *it* would leak
    /// trashed rows back into all of them. Use this only where operating on the
    /// bin is the explicit point. A foreign id reads as null exactly as it does
    /// through `get`, so ownership is enforced identically.
    pub fn getAnyState(self: Files, user_id: u64, id: u64) !?Entry {
        var r = (try self.db.row(
            "SELECT id, parent_id, name, is_folder, md5, size, updated_at FROM files " ++
                "WHERE id = ?1 AND user_id = ?2;",
            &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
        )) orelse return null;
        defer r.finalize();
        return try self.rowToEntry(&r.stmt);
    }

    const tree_walk_sql =
        \\WITH RECURSIVE tree(id,name,is_folder,md5,size,updated_at,path,parent_path) AS (
        \\  SELECT id,name,is_folder,md5,size,updated_at, '/'||name, '/'
        \\  FROM files WHERE user_id=?1 AND parent_id IS NULL AND deleted=0
        \\  UNION ALL
        \\  SELECT f.id,f.name,f.is_folder,f.md5,f.size,f.updated_at, t.path||'/'||f.name, t.path
        \\  FROM files f JOIN tree t ON f.parent_id=t.id
        \\  WHERE f.user_id=?1 AND f.deleted=0
        \\)
        \\SELECT id,name,is_folder,md5,size,updated_at,path,parent_path FROM tree ORDER BY path;
    ;

    /// `tree_walk_sql` re-rooted at a folder: the base arm seeds on the target's
    /// direct children (`parent_id = ?3`) with the path accumulator primed to the
    /// target's own path (?2), so it emits the target's STRICT descendants only.
    /// Identical columns/ordering to `tree_walk_sql`, so `walkSubtree` shares
    /// `treeNodeFromWalkRow`. ?1 = user_id, ?2 = root_path (non-root), ?3 = root_id.
    const subtree_walk_sql =
        \\WITH RECURSIVE tree(id,name,is_folder,md5,size,updated_at,path,parent_path) AS (
        \\  SELECT id,name,is_folder,md5,size,updated_at, ?2||'/'||name, ?2
        \\  FROM files WHERE user_id=?1 AND parent_id=?3 AND deleted=0
        \\  UNION ALL
        \\  SELECT f.id,f.name,f.is_folder,f.md5,f.size,f.updated_at, t.path||'/'||f.name, t.path
        \\  FROM files f JOIN tree t ON f.parent_id=t.id
        \\  WHERE f.user_id=?1 AND f.deleted=0
        \\)
        \\SELECT id,name,is_folder,md5,size,updated_at,path,parent_path FROM tree ORDER BY path;
    ;

    /// Materializes the user's whole live tree, each entry carrying its
    /// Dropbox-format `path_display` + `parent_path`, computed **top-down in a
    /// single recursive CTE** — the path is accumulated as we descend, so we
    /// never re-walk `parent_id` per entry. Everything is allocated in `alloc`
    /// (pass an arena; the caller frees it wholesale). This is the source for the
    /// device's file-enumeration endpoints (`list_folder` etc.); the SQL `md5`
    /// column is NULL for folders and surfaces as "".
    pub fn walkTree(self: Files, alloc: std.mem.Allocator, user_id: u64) ![]TreeNode {
        var out: std.ArrayList(TreeNode) = .empty;
        var s = try self.db.prepare(tree_walk_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        while (try s.step()) try out.append(alloc, try treeNodeFromWalkRow(alloc, &s));
        return out.toOwnedSlice(alloc);
    }

    /// Builds a `TreeNode` from a row of `tree_walk_sql`/`subtree_walk_sql` (both
    /// select the identical 8 columns: id,name,is_folder,md5,size,updated_at,
    /// path,parent_path). The `md5` column is NULL for folders → surfaces as "".
    fn treeNodeFromWalkRow(alloc: std.mem.Allocator, s: *sqlite.Stmt) !TreeNode {
        return .{
            .id = @intCast(s.columnInt(0)),
            .name = try alloc.dupe(u8, s.columnText(1)),
            .is_folder = s.columnInt(2) != 0,
            .md5 = try alloc.dupe(u8, s.columnText(3)), // "" for folders (NULL → "")
            .size = @intCast(s.columnInt(4)),
            .updated_at = s.columnInt(5),
            .path_display = try alloc.dupe(u8, s.columnText(6)),
            .parent_path = try alloc.dupe(u8, s.columnText(7)),
        };
    }

    /// The DIRECT children of `parent_id` (null = root), each as a `TreeNode` in
    /// the SAME shape `walkTree` emits — the scoped, O(folder) primitive behind the
    /// device's non-recursive `list_folder` (was: `walkTree` + an in-memory filter,
    /// O(whole tree)). `parent_path` is the caller-supplied normalized folder path
    /// ("/" for the root, else leading slash + no trailing); `path_display` is that
    /// path joined to each `name`, computed ONCE per row with no per-child walk.
    /// Ordered by `name`, which for a single parent's children is byte-identical to
    /// `walkTree`'s `ORDER BY path` (all share the same prefix). Slices owned by
    /// `alloc` (pass an arena).
    pub fn walkChildren(self: Files, alloc: std.mem.Allocator, user_id: u64, parent_id: ?u64, parent_path: []const u8) ![]TreeNode {
        const is_root = std.mem.eql(u8, parent_path, "/");
        var out: std.ArrayList(TreeNode) = .empty;
        var s = try self.db.prepare(
            "SELECT id,name,is_folder,md5,size,updated_at FROM files " ++
                "WHERE user_id = ?1 AND COALESCE(parent_id, 0) = COALESCE(?2, 0) AND deleted = 0 " ++
                "ORDER BY name;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        bindOpt(s, 2, parent_id);
        while (try s.step()) {
            const name = try alloc.dupe(u8, s.columnText(1));
            // Root → "/name" (no double slash); nested → "parent/name". Matches the
            // literal-'/' root arm vs the `t.path||'/'||name` descent in walkTree.
            const path_display = if (is_root)
                try std.fmt.allocPrint(alloc, "/{s}", .{name})
            else
                try std.fmt.allocPrint(alloc, "{s}/{s}", .{ parent_path, name });
            try out.append(alloc, .{
                .id = @intCast(s.columnInt(0)),
                .name = name,
                .is_folder = s.columnInt(2) != 0,
                .md5 = try alloc.dupe(u8, s.columnText(3)), // "" for folders (NULL → "")
                .size = @intCast(s.columnInt(4)),
                .updated_at = s.columnInt(5),
                .path_display = path_display,
                .parent_path = try alloc.dupe(u8, parent_path),
            });
        }
        return out.toOwnedSlice(alloc);
    }

    /// `tree_walk_sql`, RE-ROOTED at `root_id` instead of the user's roots: the same
    /// top-down path-accumulating recursive CTE, but its base arm seeds on
    /// `parent_id = ?3` (the target folder's direct children) with the accumulator
    /// primed to `root_path` (?2). Emits every STRICT descendant of `root_id` — the
    /// folder itself is excluded, exactly as the old recursive `underPath` filter
    /// excluded the target. Backs the device's recursive `list_folder` for a NAMED
    /// folder (O(subtree), not O(whole tree)); recursive-from-root stays `walkTree`
    /// because that genuinely IS the whole tree. `root_path` must be non-root
    /// (leading slash, no trailing). Same `TreeNode` shape as `walkTree`; slices
    /// owned by `alloc`.
    pub fn walkSubtree(self: Files, alloc: std.mem.Allocator, user_id: u64, root_id: u64, root_path: []const u8) ![]TreeNode {
        var out: std.ArrayList(TreeNode) = .empty;
        var s = try self.db.prepare(subtree_walk_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, root_path);
        s.bindInt(3, @intCast(root_id));
        while (try s.step()) try out.append(alloc, try treeNodeFromWalkRow(alloc, &s));
        return out.toOwnedSlice(alloc);
    }

    /// Builds a single `TreeNode` for `id` (scoped to `user_id`), or null if the
    /// id is absent/foreign. Used by the by-id / by-path device endpoints.
    /// `path_display` is derived via `pathOf`; `parent_path` is the parent
    /// folder's path (root → "/"). Slices are owned by `alloc`.
    pub fn nodeById(self: Files, alloc: std.mem.Allocator, user_id: u64, id: u64) !?TreeNode {
        const e = (try self.get(user_id, id)) orelse return null;
        defer self.gpa.free(e.name);
        defer if (e.md5) |m| self.gpa.free(m);
        return .{
            .id = e.id,
            .name = try alloc.dupe(u8, e.name),
            .is_folder = e.is_folder,
            .md5 = try alloc.dupe(u8, e.md5 orelse ""),
            .size = e.size,
            .updated_at = e.updated_at,
            .path_display = try self.pathOf(alloc, user_id, id),
            .parent_path = if (e.parent_id) |pid| try self.pathOf(alloc, user_id, pid) else try alloc.dupe(u8, "/"),
        };
    }

    /// Resolves a Dropbox-format path (e.g. `/NOTE/Note/a.note`) to a live entry
    /// id by descending segments from the root, matching `name` at each level
    /// (read-only — never creates). Root / empty path → null (the root is not an
    /// entry). A missing segment → null.
    pub fn resolvePath(self: Files, user_id: u64, path: []const u8) !?u64 {
        var parent: ?u64 = null;
        var found: ?u64 = null;
        var it = std.mem.tokenizeScalar(u8, path, '/');
        while (it.next()) |seg| {
            const c = (try self.liveChild(user_id, parent, seg)) orelse return null;
            parent = c.id;
            found = c.id;
        }
        return found;
    }

    /// True if `size` more bytes would fit within the user's quota (for the
    /// device upload/apply pre-check, before any bytes are streamed).
    ///
    /// Overflow-proof by construction: a hostile device-supplied `size` (up to
    /// u64max) must never panic the single-threaded server. We compute the
    /// remaining headroom and compare in u64 — no `used + size` add, no `@intCast`
    /// of an oversized `size` into i64.
    pub fn wouldFit(self: Files, user_id: u64, size: u64) !bool {
        const cap = try self.capacity(user_id);
        if (cap.total <= cap.used) return size == 0; // already at/over quota
        const remaining: u64 = @intCast(cap.total - cap.used);
        return size <= remaining;
    }

    /// Derives an entry's full path by walking `parent_id` up to the root, e.g.
    /// `/NOTE/Note/foo.note`. Scoped to `user_id`. The result is owned by `gpa`.
    /// Sync VOs (`SummaryInfoVO.metadataMap`, `SummaryDO.sourcePath`) need this —
    /// the tree is stored as an adjacency list, so paths aren't materialized.
    pub fn pathOf(self: Files, gpa: std.mem.Allocator, user_id: u64, id: u64) ![]u8 {
        var names: std.ArrayList([]u8) = .empty; // leaf-first, owned segments
        defer {
            for (names.items) |n| gpa.free(n);
            names.deinit(gpa);
        }
        var cur: ?u64 = id;
        var guard: usize = 0;
        while (cur) |cid| {
            guard += 1;
            if (guard > 256) break; // cycle guard (should never trigger)
            var r = (try self.db.row("SELECT name, parent_id FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0;", &.{ .{ .int = @intCast(cid) }, .{ .int = @intCast(user_id) } })) orelse break; // missing/foreign node → stop here
            defer r.finalize();
            const nm = try gpa.dupe(u8, r.text(0));
            names.append(gpa, nm) catch |e| {
                gpa.free(nm);
                return e;
            };
            const pid = r.int(1);
            cur = if (pid == 0) null else @intCast(pid); // 0 == NULL (root)
        }

        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        if (names.items.len == 0) {
            try out.append(gpa, '/');
        } else {
            var i = names.items.len; // reverse: root-first
            while (i > 0) {
                i -= 1;
                try out.append(gpa, '/');
                try out.appendSlice(gpa, names.items[i]);
            }
        }
        return out.toOwnedSlice(gpa);
    }

    // ---- writes ----

    /// Creates a folder under `parent_id` (null = root). Errors: NotFound /
    /// NotAFolder (bad parent), NameConflict (name already taken in the folder).
    pub fn createFolder(self: Files, user_id: u64, parent_id: ?u64, name: []const u8) !Entry {
        try self.assertFolder(user_id, parent_id);
        if (try self.liveChild(user_id, parent_id, name) != null) return error.NameConflict;

        const ts = self.now();
        var s = try self.db.prepare(
            "INSERT INTO files(user_id, parent_id, name, is_folder, created_at, updated_at) VALUES(?1,?2,?3,1,?4,?4);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        bindOpt(s, 2, parent_id);
        s.bindText(3, name);
        s.bindInt(4, ts);
        _ = try s.step();
        const new_id = self.db.lastInsertRowId();
        try self.bumpSync(user_id); // the tree changed — move the control-plane-face counter
        return .{
            .id = @intCast(new_id),
            .parent_id = parent_id,
            .name = try self.gpa.dupe(u8, name),
            .is_folder = true,
            .md5 = null,
            .size = 0,
            .updated_at = ts,
        };
    }

    /// Idempotently creates a `/`-separated folder path (e.g. `NOTE/MyStyle`),
    /// creating each missing segment as a folder and descending into existing
    /// ones. Returns the leaf folder's id. Used to auto-provision a device's
    /// default `label` root folders on bind. A path segment that already exists
    /// as a *file* is a NameConflict.
    pub fn ensureFolderPath(self: Files, user_id: u64, path: []const u8) !u64 {
        var parent: ?u64 = null;
        var leaf: ?u64 = null;
        var it = std.mem.tokenizeScalar(u8, path, '/');
        while (it.next()) |seg| {
            if (try self.liveChild(user_id, parent, seg)) |c| {
                if (!c.is_folder) return error.NameConflict;
                parent = c.id;
            } else {
                const e = try self.createFolder(user_id, parent, seg);
                self.gpa.free(e.name); // only the id is needed here
                parent = e.id;
            }
            leaf = parent;
        }
        return leaf orelse error.NotFound; // empty path
    }

    /// Creates the folder named by the LAST segment of `path`, creating any
    /// missing ancestors along the way, and returns it. Backs the device's
    /// `create_folder_v2`.
    ///
    /// Ancestors are always idempotent (`ensureFolderPath`'s rule: descend into
    /// an existing folder, create a missing one, refuse a segment that is a
    /// file). `autorename` governs the LEAF only, mirroring the flag the device
    /// sends and the Dropbox-shaped API it is modelled on:
    ///
    ///   - `false` — the caller wants THAT name. An existing folder of that name
    ///     is returned unchanged, so a device retry converges instead of
    ///     failing; an existing FILE of that name is `error.NameConflict`,
    ///     because there is no folder to hand back and silently renaming would
    ///     not be what was asked for.
    ///   - `true` — the caller wants A folder, name negotiable. Any live
    ///     occupant, file or folder, sends the new folder to `freeName`'s
    ///     `Name (2)` form — the same suffix rule `restore` uses, so the two
    ///     paths cannot disagree about what a renamed sibling looks like.
    ///
    /// Returns the leaf `Entry`; caller frees `.name`. `error.NotFound` on an
    /// empty path.
    pub fn createFolderPath(self: Files, user_id: u64, path: []const u8, autorename: bool) !Entry {
        var parent: ?u64 = null;
        var it = std.mem.tokenizeScalar(u8, path, '/');
        var name = it.next() orelse return error.NotFound; // "" / "/" name nothing

        // Every segment but the last is an ancestor: ensure it and descend. The
        // leaf falls out of the loop still unconsumed, which is what lets
        // `autorename` apply to it alone.
        while (it.next()) |next_seg| {
            if (try self.liveChild(user_id, parent, name)) |c| {
                if (!c.is_folder) return error.NameConflict;
                parent = c.id;
            } else {
                const e = try self.createFolder(user_id, parent, name);
                self.gpa.free(e.name); // only the id is needed while descending
                parent = e.id;
            }
            name = next_seg;
        }

        if (try self.liveChild(user_id, parent, name)) |c| {
            if (!autorename) {
                if (!c.is_folder) return error.NameConflict;
                return (try self.get(user_id, c.id)) orelse error.NotFound;
            }
            const final = try self.freeName(user_id, parent, name);
            defer self.gpa.free(final);
            return self.createFolder(user_id, parent, final);
        }
        return self.createFolder(user_id, parent, name);
    }

    /// Streams `reader` into the blob store and links it as a file named `name`
    /// under `parent_id`. If a live file with that name exists it is replaced
    /// (its old blob is decref'd/GC'd); a folder of that name is a NameConflict.
    /// `expected_md5` (if given) is verified by the blob store. Enforces quota.
    pub fn putFile(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, reader: *std.Io.Reader, expected_md5: ?[]const u8) !Entry {
        // Fail a bad parent before we spend a blob write on it.
        try self.assertFolder(user_id, parent_id);

        const res = try self.blobs.put(reader, expected_md5);
        // If linking bails, drop the blob we just wrote (unless it was a dedup of
        // content we already hold, which another file still references).
        errdefer if (!res.deduped) self.blobs.remove(&res.md5);

        return self.linkBlob(user_id, parent_id, name, &res.md5, res.size);
    }

    /// Links an ALREADY-STORED blob (`md5`, `size`) into the tree as a file named
    /// `name` under `parent_id` — the transactional "back half" of `putFile`,
    /// split out so the device upload path (which streams the bytes in via
    /// `/oss/put` before `finish` links them) can reuse it. Replaces a live file of
    /// the same name (its old blob is decref'd/GC'd); a folder of that name is a
    /// NameConflict. Creates/refcounts the `blobs` row, charges quota, and bumps
    /// the sync-version — all in one transaction. On any failure the transaction
    /// rolls back and the on-disk blob is left UNTOUCHED (unreferenced blobs are
    /// collectable by the sweep); this method never removes blobs.
    pub fn linkBlob(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, md5: []const u8, size: u64) !Entry {
        return self.linkBlobIndexed(user_id, parent_id, name, md5, size, null);
    }

    /// `linkBlob`, with the blob's `.note` index handed in pre-parsed.
    ///
    /// Indexing a note means parsing a multi-MB container, and `upload/finish`
    /// runs under the whole-handler global DB lock — so the parse must NOT
    /// happen inside the transaction (see `note_index.zig`). This overload is
    /// the seam that lets a caller hoist the parse above the lock entirely;
    /// `linkBlob` itself does the next best thing and parses before `BEGIN`.
    /// Either way the rows are written inside the transaction, so an index can
    /// never outlive a rolled-back link.
    pub fn linkBlobIndexed(
        self: Files,
        user_id: u64,
        parent_id: ?u64,
        name: []const u8,
        md5: []const u8,
        size: u64,
        pre_parsed: ?*const noteindex.Parsed,
    ) !Entry {
        try self.assertFolder(user_id, parent_id);

        // ---- parse OUTSIDE the transaction ----
        var owned: ?noteindex.Parsed = null;
        defer if (owned) |*p| p.deinit();
        var parsed: ?*const noteindex.Parsed = pre_parsed;
        if (parsed == null and !try noteindex.isCurrent(self.db, md5)) {
            owned = noteindex.parseStoredBlob(self.gpa, self.io, self.blobs, md5) catch null;
            if (owned) |*p| parsed = p;
        }

        // ---- derive the `.spd` index + thumbnail, also OUTSIDE the transaction ----
        // Best-effort and attacker-hardened (see `spd_index.zig`): a `.spd` is
        // an SQLite DB an untrusted device wrote, opened READONLY into :memory:
        // ONCE for both the metadata scalars and the embedded thumbnail. Gated
        // on the name (`wantsSpd`) so we never hand a `.note`/PDF/PNG to the
        // deserializer — nor buffer one whole just to fail its magic check —
        // and on `isCurrent` so dedup'd content is not re-opened. The SQLite
        // open + reads happen here, off the global DB lock — like the note
        // parse above — and any failure is "no row / no thumbnail", never a
        // failed upload.
        var spd_derived: ?spdindex.Derived = null;
        defer if (spd_derived) |*d| d.deinit();
        if (thumbnail.wantsSpd(name) and !(spdindex.isCurrent(self.db, md5) catch false)) {
            spd_derived = spdindex.deriveStored(self.gpa, self.blobs, md5) catch null;
        }

        // ---- derive the `.txt` paragraph segments, also OUTSIDE the transaction ----
        // Gated by the file NAME (the `wantsSpd` convention) and by the
        // derived-state memo, so dedup'd content is not re-chunked. A blob
        // the note parser VERIFIED as a `.note` is never chunked, whatever
        // it is called: with a fresh parse in hand its own verdict decides;
        // with a current row, `needsDerive` reads the stored verdict (and
        // the `kind = 1` memo) instead. See `txt_index.zig`.
        var txt_derived: ?txtindex.Derived = null;
        defer if (txt_derived) |*d| d.deinit();
        if (txtindex.wants(name)) {
            const chunkable = if (parsed) |p|
                !p.indexable
            else
                txtindex.needsDerive(self.db, md5) catch false;
            if (chunkable) txt_derived = txtindex.deriveStored(self.gpa, self.blobs, md5) catch null;
        }

        // Thumbnail bytes reach disk BEFORE the commit that references them (the
        // blob pattern: a crash can only orphan a derived file, which is
        // content-keyed, regenerable, and swept with the blob's GC). Best-effort.
        // Only the `.spd` thumbnail is stored this way — a `.note` COVER is NOT
        // copied into `thumbs/` at all: its bytes stay in the immutable blob and
        // the serve path streams them on demand from the location the note parse
        // recorded (`note_index.cover_offset/cover_length/cover_mime`).
        if (spd_derived) |d| {
            if (d.thumb) |t| self.thumbs.put(md5, t.bytes) catch {};
        }

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        try self.ensureBlobRow(md5, size);

        const existing = try self.liveChild(user_id, parent_id, name);
        if (existing) |e| if (e.is_folder) return error.NameConflict;

        const old_md5: ?[md5_len]u8 = if (existing) |e| e.md5 else null;
        // Reference the new blob unless it's the same content we already had.
        const same_content = if (old_md5) |om| std.mem.eql(u8, &om, md5) else false;

        // ---- the two reference counts, read BEFORE any row write changes them ----
        //
        // They used to be one pair of booleans doing two jobs. They are now
        // deliberately SEPARATE, because quota and search stopped agreeing about
        // what a reference is:
        //
        //   - SEARCH follows LIVE FILE rows (`userBlobRefs`). A blob held only by
        //     a retained version must NOT stay searchable — find-in-library would
        //     surface text from content no live file holds.
        //   - QUOTA follows anything that keeps the bytes on disk
        //     (`userChargedRefs`), which since §6 includes `file_history`. A
        //     retained version occupies disk, so the user is charged for it,
        //     exactly as a trashed file is charged.
        //
        // Fusing them again would silently re-break one of the two.
        var new_first = false; // the user's FIRST live-file reference to the new content
        var old_last = false; // the replaced row held their LAST live-file reference to the old
        var new_charge = false; // the user held NO reference of any kind to the new content
        if (!same_content) {
            new_first = try self.userBlobRefs(user_id, md5) == 0;
            new_charge = try self.userChargedRefs(user_id, md5) == 0;
            if (old_md5) |om| old_last = try self.userBlobRefs(user_id, &om) == 1;
        }

        var file_id: u64 = undefined;
        const ts = self.now();

        // Eager index, written inside the transaction (the parse already happened
        // above). Rolls back with the link if anything below fails.
        if (parsed) |p| try noteindex.store(self.db, md5, p.*, ts);

        // Eager `.spd` index row, same shape: derived above, written here (the
        // `blobs` row from `ensureBlobRow` satisfies its FK). Best-effort — a
        // store failure must NOT roll back the link, so it is swallowed: nothing
        // downstream depends on the row existing (the on-demand repair re-derives
        // a missing one), and a failed upload is worse than a missing preview.
        // The upsert is one atomic statement.
        if (spd_derived) |d| spdindex.store(self.db, md5, d, ts) catch {};

        // `.txt` segment rows (`kind = 1`), inside the transaction like the
        // note index — and `try`, NOT best-effort like the `.spd` row above:
        // `txt_index.store` interleaves FTS 'delete'/insert with the row
        // writes, and committing a half-applied diff would corrupt the
        // postings, which is worse than a failed upload. Runs after
        // `noteindex.store` (the `note_index` row is the segments' FK) and
        // before the `files` row write, so `mintPageForHolders` inside it
        // reaches every EXISTING holder while this owner's own segment rows
        // are minted by the search block below once their row exists.
        if (txt_derived) |d| try txtindex.store(self.db, md5, d, ts);

        if (existing) |e| {
            file_id = e.id;
            var s = try self.db.prepare("UPDATE files SET md5 = ?1, size = ?2, updated_at = ?3 WHERE id = ?4;");
            defer s.finalize();
            s.bindText(1, md5);
            s.bindInt(2, @intCast(size));
            s.bindInt(3, ts);
            s.bindInt(4, @intCast(file_id));
            _ = try s.step();
        } else {
            var s = try self.db.prepare(
                "INSERT INTO files(user_id, parent_id, name, is_folder, md5, size, created_at, updated_at) VALUES(?1,?2,?3,0,?4,?5,?6,?6);",
            );
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            bindOpt(s, 2, parent_id);
            s.bindText(3, name);
            s.bindText(4, md5);
            s.bindInt(5, @intCast(size));
            s.bindInt(6, ts);
            _ = try s.step();
            file_id = @intCast(self.db.lastInsertRowId());
        }

        if (!same_content) try self.incref(md5);

        try self.bumpSync(user_id); // an upload/replace changed the tree

        // ---- search segment maintenance (docs/scratch/search-architecture.md) ----
        // The owner's segment rows follow the content they hold, in THIS
        // transaction — search atomically sees exactly one version. A new
        // VERSION of a note is a new blob, and when this row was both the
        // user's last reference to the old content and their first to the new,
        // that is the flip: diffed by text_hash, unchanged pages REPOINTED
        // (zero FTS writes, recency kept), edited pages vanish + mint fresh.
        // When the reference counts say otherwise the flip degenerates: the
        // old rows stay (another of the user's files still needs them) and/or
        // the new rows already exist. All of it MUST run before the decref
        // below — the FTS 'delete' side reads the old blob's text rows, which
        // a refcount-0 GC would take away.
        if (!same_content) {
            if (old_last and new_first) {
                try notesearch.flipOwnerBlob(self.db, user_id, &old_md5.?, md5, ts);
            } else {
                if (old_last) try notesearch.dropOwnerBlobSearch(self.db, user_id, &old_md5.?);
                if (new_first) try notesearch.mintOwnerBlobSearch(self.db, user_id, md5, ts);
            }
        }

        // Release the replaced blob. RETAIN-ON-SUPERSEDE (H1): when versioning is
        // on, record the superseded version FIRST, so the `file_history` row is in
        // place before the decref runs its GC gate — `reapIfUnreferenced` then
        // sees the history keep-alive and does NOT delete the blob (or its
        // md5-keyed render index). `refcount` still drops (the live-file reference
        // is genuinely gone), but the CHARGE does not: the retained version still
        // occupies disk, and since §6 the user keeps paying for it. With
        // `keep == 0` no row is written and this is exactly the old
        // prune-on-supersede path, refund and all.
        //
        // `gc_hist` collects blobs freed by eviction below; `gc_old` is the
        // legacy single-blob GC (non-null only when the old blob was neither
        // retained nor otherwise referenced). `evicted` is every version dropped
        // here, so the quota settlement below can give back exactly what left.
        const keep = (try self.versionPolicy(user_id)).keep;
        var gc_old = false;
        var gc_hist: std.ArrayList([md5_len]u8) = .empty;
        defer gc_hist.deinit(self.gpa);
        var evicted: std.ArrayList(Evicted) = .empty;
        defer evicted.deinit(self.gpa);
        if (old_md5) |om| {
            if (!same_content) {
                if (keep > 0) try self.recordHistory(file_id, &om, existing.?.size, ts);
                gc_old = try self.decref(&om);
                // Bound the store: K per file, then the global max_bytes ceiling.
                if (keep > 0) try self.evictHistory(user_id, file_id, keep, &gc_hist, &evicted);
            }
        }

        // ---- quota settlement (§6: retained versions are charged) ----
        //
        // Computed from what the rows say NOW, after every write above, rather
        // than predicted before them. That ordering is the point: eviction can
        // drop the very version we just recorded, and a delta guessed in advance
        // would have to model that.
        var settled: std.ArrayList([md5_len]u8) = .empty;
        defer settled.deinit(self.gpa);
        var delta: i64 = if (new_charge) @as(i64, @intCast(size)) else 0;
        if (old_md5) |om| {
            if (!same_content) try self.settleRefund(user_id, &om, @intCast(existing.?.size), &settled, &delta);
        }
        for (evicted.items) |*e| try self.settleRefund(user_id, &e.md5, e.size, &settled, &delta);

        // **THE FAILURE THIS MUST NOT CREATE** (§6). A person near their allotment
        // must not be refused when EDITING AN EXISTING NOTE just because the
        // version the edit displaced pushed them over — an error they added
        // nothing to earn, arriving from the device mid-sync where it is least
        // explicable. So under quota pressure we spend HISTORY DEPTH instead:
        // evict this user's oldest versions until the edit fits, and refuse only
        // when the live files alone do not. A full quota costs you history before
        // it costs you the ability to work.
        //
        // The loop is bounded by the user's history row count, and each pass
        // deletes exactly one row; `evictOldestVersion` only ever offers rows
        // whose blob no live file of theirs also holds, so a pass that frees
        // nothing cannot repeat on the same row.
        const cap = try self.capacity(user_id);
        while (cap.used + delta > cap.total) {
            const dropped = (try self.evictOldestVersion(user_id, &gc_hist)) orelse break;
            try self.settleRefund(user_id, &dropped.md5, dropped.size, &settled, &delta);
        }
        if (cap.used + delta > cap.total) return error.QuotaExceeded; // errdefer rolls back
        try self.addUsed(user_id, delta);

        try self.db.exec("COMMIT;");
        if (gc_old) self.removeBlobFiles(&old_md5.?);
        for (gc_hist.items) |*m| self.removeBlobFiles(m);

        return .{
            .id = file_id,
            .parent_id = parent_id,
            .name = try self.gpa.dupe(u8, name),
            .is_folder = false,
            .md5 = try self.gpa.dupe(u8, md5),
            .size = size,
            .updated_at = ts,
        };
    }

    /// Links an ALREADY-STORED blob into `parent_id` as a NEW file, never over an
    /// existing one — the web upload's tree-link. It is `linkBlob` (the ONE
    /// tree-link path, shared with the device's `upload/finish`) with a single
    /// thing added in front: name resolution.
    ///
    /// That one difference is the whole reason this exists. `linkBlob` REPLACES a
    /// live file of the same name, which is right for the device — a Nomad
    /// re-uploading `BuJo.note` means "here is the new version of that note", and
    /// replacing is what keeps version history on one row. It is wrong for a
    /// browser drop: the file arriving is a DIFFERENT file that merely shares a
    /// name, and overwriting the user's existing one would be silently lossy. So a
    /// collision takes the next free ` (n)` suffix (`freeName`, the same scheme
    /// `move`/`copy`/`restore` use) and both files survive.
    ///
    /// Errors are `linkBlob`'s: `QuotaExceeded`, `NotAFolder` (bad destination),
    /// and `NameConflict` only when a FOLDER holds the resolved name (`freeName`
    /// resolves against live children of either kind, so this is unreachable in
    /// practice — it stays as the honest error rather than a silent overwrite).
    /// Returns the created entry; the caller frees `.name` / `.md5`.
    pub fn placeUpload(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, md5: []const u8, size: u64) !Entry {
        // Fail a bad destination before spending a name on it (`linkBlob` checks
        // this too — this only moves the error ahead of the `freeName` scan).
        try self.assertFolder(user_id, parent_id);

        const final = try self.freeName(user_id, parent_id, name);
        defer self.gpa.free(final);
        return self.linkBlob(user_id, parent_id, final, md5, size);
    }

    /// Moves and/or renames a live entry (scoped to `user_id`): reparents it to
    /// `new_parent_id` (null = root) under `new_name`, in ONE transaction.
    ///
    /// The tree is an adjacency list — paths are NOT materialized (they are derived
    /// by walking `parent_id`; see `pathOf` / `walkTree`) — so a MOVE is a single
    /// UPDATE of `parent_id` + `name` on the one row, and a folder's whole subtree
    /// follows for free: every descendant's path is recomputed from the new parent
    /// chain on the next read, with nothing per-descendant rewritten. The
    /// "half-applied tree that reads as a deletion" hazard the sync-safety doc warns
    /// about therefore cannot arise here — the change is atomic by construction.
    ///
    /// A RENAME is a move whose `new_parent_id` equals the current one; a MOVE is
    /// the same operation to a different parent. One unified primitive.
    ///
    ///   - **No-op.** Same parent + same name (the row already sits where it is
    ///     asked to go) is a clean success that changes nothing and does not bump
    ///     the sync-version — it is not a mutation.
    ///   - **Name conflict.** A DIFFERENT live sibling already holds `new_name` in
    ///     the destination: with `autorename` we take the next free ` (n)` name
    ///     (`freeName` — the exact suffix rule `restore` / `createFolder` use, so
    ///     the paths cannot disagree about what a renamed sibling looks like);
    ///     without it, `error.NameConflict` and nothing moves — we never clobber the
    ///     occupant, because a silent overwrite would be lossy.
    ///   - **Cycle guard.** A folder cannot move into itself or one of its own
    ///     descendants (`error.InvalidMove`): that would sever the subtree from the
    ///     root and orphan it.
    ///
    /// `error.NotFound` if `id` is absent, foreign, or already trashed (a bin row is
    /// not live and is not moved). Other errors: NameConflict / InvalidMove /
    /// NotAFolder (bad destination parent). Returns the entry AFTER the move; the
    /// caller frees `.name` / `.md5`.
    pub fn move(self: Files, user_id: u64, id: u64, new_parent_id: ?u64, new_name: []const u8, autorename: bool) !Entry {
        if (new_name.len == 0) return error.NameConflict;
        // The destination parent must be the root or a live folder the user owns.
        try self.assertFolder(user_id, new_parent_id);

        // The live row (user-scoped). A trashed / absent / foreign id is NotFound —
        // the handler translates that to an idempotent success.
        var is_folder = false;
        var md5buf: [md5_len]u8 = undefined;
        var has_md5 = false;
        var size: u64 = 0;
        {
            var r = (try self.db.row(
                "SELECT is_folder, md5, size FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0;",
                &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
            )) orelse return error.NotFound;
            defer r.finalize();
            is_folder = r.int(0) != 0;
            const m = r.text(1);
            if (m.len == md5_len) {
                @memcpy(&md5buf, m);
                has_md5 = true;
            }
            size = @intCast(r.int(2));
        }

        // A folder may not move into its own subtree: walking UP from the target
        // parent must never reach the folder itself. (A file has no subtree.)
        if (is_folder and try self.wouldCycle(user_id, new_parent_id, id)) return error.InvalidMove;

        // Resolve the destination name against the live siblings there.
        var owned_name: ?[]u8 = null;
        defer if (owned_name) |n| self.gpa.free(n);
        var final_name: []const u8 = new_name;
        if (try self.liveChild(user_id, new_parent_id, new_name)) |occ| {
            // The occupant IS this row — it already sits at the destination under
            // this exact name. A true no-op: touch nothing, bump nothing.
            if (occ.id == id) return (try self.get(user_id, id)) orelse error.NotFound;
            if (!autorename) return error.NameConflict; // never clobber the occupant
            owned_name = try self.freeName(user_id, new_parent_id, new_name);
            final_name = owned_name.?;
        }

        const ts = self.now();
        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};
        {
            var s = try self.db.prepare(
                "UPDATE files SET parent_id = ?1, name = ?2, updated_at = ?3 WHERE id = ?4 AND user_id = ?5;",
            );
            defer s.finalize();
            bindOpt(s, 1, new_parent_id);
            s.bindText(2, final_name);
            s.bindInt(3, ts);
            s.bindInt(4, @intCast(id));
            s.bindInt(5, @intCast(user_id));
            _ = try s.step();
        }
        try self.bumpSync(user_id); // the tree changed — move the control-plane counter
        try self.db.exec("COMMIT;");

        return .{
            .id = id,
            .parent_id = new_parent_id,
            .name = try self.gpa.dupe(u8, final_name),
            .is_folder = is_folder,
            .md5 = if (has_md5) try self.gpa.dupe(u8, &md5buf) else null,
            .size = size,
            .updated_at = ts,
        };
    }

    /// Copies a live FILE (scoped to `user_id`) to `new_parent_id` under
    /// `new_name`, sharing the source's blob — a content-addressed copy.
    ///
    /// The store is content-addressed and refcounted, so a copy is NOT a byte
    /// duplication: it is a second `files` row pointing at the same `md5`, with an
    /// `incref`. The blob and ALL its md5-keyed derived state — `note_index`,
    /// `spd_index`, `.txt` segments, search postings, the cover/thumbnail — already
    /// exist (the source references them), so none is re-derived. And because quota
    /// is charged per DISTINCT blob per user (see `linkBlobIndexed`) and the user
    /// already holds this content via the source, a copy of one's own file costs
    /// ZERO additional quota — which is exactly the bytes it occupies on disk.
    ///
    /// Name resolution mirrors `move`: an occupied destination name is taken with
    /// the next free ` (n)` suffix when `autorename`, else `error.NameConflict` and
    /// nothing is written — we never clobber the occupant (a copy is never lossy).
    ///
    ///   - `error.NotFound`  — `id` is absent, foreign, or already trashed.
    ///   - `error.IsFolder`  — folder copy is a deep recursive duplication we do
    ///     not perform (the device's conflict-resolution copy is always a single
    ///     file); the handler settles it as an idempotent success.
    ///   - `error.NameConflict` / `error.NotAFolder` — as in `move`.
    ///
    /// Returns the NEW entry; the caller frees `.name` / `.md5`.
    pub fn copy(self: Files, user_id: u64, id: u64, new_parent_id: ?u64, new_name: []const u8, autorename: bool) !Entry {
        if (new_name.len == 0) return error.NameConflict;
        // The destination parent must be the root or a live folder the user owns.
        try self.assertFolder(user_id, new_parent_id);

        // The live SOURCE row (user-scoped). A trashed / absent / foreign id is
        // NotFound — the handler translates that to an idempotent success.
        var md5buf: [md5_len]u8 = undefined;
        var size: u64 = 0;
        {
            var r = (try self.db.row(
                "SELECT is_folder, md5, size FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0;",
                &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
            )) orelse return error.NotFound;
            defer r.finalize();
            if (r.int(0) != 0) return error.IsFolder; // no recursive folder copy
            const m = r.text(1);
            if (m.len != md5_len) return error.NotFound; // a file with no blob is nothing to copy
            @memcpy(&md5buf, m);
            size = @intCast(r.int(2));
        }
        const md5: []const u8 = &md5buf;

        // Resolve the destination name against the live siblings there. Unlike
        // `move` there is no "occupant IS this row" no-op case — a copy always
        // produces a NEW row, so any occupant (the source itself included) is a
        // genuine conflict: autorename around it, or refuse without clobbering.
        var owned_name: ?[]u8 = null;
        defer if (owned_name) |n| self.gpa.free(n);
        var final_name: []const u8 = new_name;
        if (try self.liveChild(user_id, new_parent_id, new_name)) |_| {
            if (!autorename) return error.NameConflict;
            owned_name = try self.freeName(user_id, new_parent_id, new_name);
            final_name = owned_name.?;
        }

        const ts = self.now();
        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        try self.ensureBlobRow(md5, size); // idempotent — the source already made it

        // Quota is charged per distinct blob per user. The source is a live
        // reference to this content, so `userChargedRefs` is already ≥ 1 and this
        // copy adds no new charge (delta 0) — but compute it the same way the
        // upload path does, so the one rule lives in one place.
        const delta: i64 = if (try self.userChargedRefs(user_id, md5) == 0) @intCast(size) else 0;

        var file_id: u64 = undefined;
        {
            var s = try self.db.prepare(
                "INSERT INTO files(user_id, parent_id, name, is_folder, md5, size, created_at, updated_at) VALUES(?1,?2,?3,0,?4,?5,?6,?6);",
            );
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            bindOpt(s, 2, new_parent_id);
            s.bindText(3, final_name);
            s.bindText(4, md5);
            s.bindInt(5, @intCast(size));
            s.bindInt(6, ts);
            _ = try s.step();
            file_id = @intCast(self.db.lastInsertRowId());
        }

        try self.incref(md5);

        const cap = try self.capacity(user_id);
        if (cap.used + delta > cap.total) return error.QuotaExceeded; // errdefer rolls back
        try self.addUsed(user_id, delta);

        // Search postings are per-owner-per-blob and already exist for this owner
        // (via the source) whenever `delta == 0`; only a first reference mints them.
        if (delta != 0) try notesearch.mintOwnerBlobSearch(self.db, user_id, md5, ts);

        try self.bumpSync(user_id); // the tree gained a row
        try self.db.exec("COMMIT;");

        return .{
            .id = file_id,
            .parent_id = new_parent_id,
            .name = try self.gpa.dupe(u8, final_name),
            .is_folder = false,
            .md5 = try self.gpa.dupe(u8, md5),
            .size = size,
            .updated_at = ts,
        };
    }

    // ---- the recycle bin ----

    /// The DEFAULT retention window for a trashed entry: 30 days.
    ///
    /// It was the whole story until the admin console put a **Change** button
    /// beside it; the effective window now lives in the `settings` table and is
    /// read through `services/settings.zig`, which falls back to this constant on
    /// an install that has never configured one. This stays the compiled default
    /// (and the number the empty-state copy quotes on a fresh install) — it is no
    /// longer the number to read when you want to know what retention IS.
    ///
    /// `sweepBin` still takes the window as a parameter, which is what let the
    /// knob land without touching the sweep at all.
    pub const bin_retention_s: i64 = 30 * 24 * 60 * 60;

    /// Every entry in one user's bin, newest deletion first, each carrying the
    /// path it had **when it was deleted**. Everything is allocated in `alloc`
    /// (pass an arena; the caller frees it wholesale).
    ///
    /// ## The path is frozen, not reconstructed
    ///
    /// Paths are not materialized — the tree is an adjacency list — but a bin row
    /// does not walk for its path: `trash` recorded it into `deleted_path` at the
    /// moment of deletion (schema v12 backfilled the rows that predate that). So
    /// this is a direct read of `deleted = 1` rows off the partial index, O(bin)
    /// rather than the O(tree) whole-tree walk it replaced — and the path shown is
    /// the one the entry ACTUALLY had when trashed, immune to a later rename of an
    /// ancestor that the recompute-from-current-tree query got silently wrong.
    ///
    /// `is_root` is the one field still computed here — a correlated existence
    /// check on the parent's `deleted` flag — because the client cannot derive it:
    /// a live parent is not in this response at all, and unlike the path it is a
    /// fact about the tree NOW, not a property to freeze at trash time.
    ///
    /// The empty bin is the overwhelmingly common state, so an indexed EXISTS
    /// probe short-circuits before any row work.
    ///
    /// **No grouping is imposed on the result.** It is a flat, complete list, in
    /// deletion order, with `parent_id`, `deleted_at` and `is_root` on every row.
    /// The approved UI groups rows by deletion time and nests children under a
    /// trashed parent — both of which are re-derivable from those three fields
    /// with no further request, since the list is closed under "trashed descendant
    /// of a trashed row". Emitting a pre-grouped tree instead would freeze one
    /// rendering decision into the wire format, cost a second shape for the same
    /// facts, and buy nothing the client cannot do in a single pass.
    pub fn listBin(self: Files, alloc: std.mem.Allocator, user_id: u64) ![]BinEntry {
        var out: std.ArrayList(BinEntry) = .empty;

        // Empty-bin early exit: one indexed probe on `files_deleted_at`, skipping
        // even the cheap frozen-path read below. The bin is empty almost always.
        {
            var probe = try self.db.prepare(
                "SELECT EXISTS(SELECT 1 FROM files WHERE user_id = ?1 AND deleted = 1);",
            );
            defer probe.finalize();
            probe.bindInt(1, @intCast(user_id));
            if (!try probe.step() or probe.columnInt(0) == 0) return out.toOwnedSlice(alloc);
        }

        var s = try self.db.prepare(bin_listing_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        while (try s.step()) {
            const pid = s.columnInt(1);
            const is_folder = s.columnInt(3) != 0;
            const m = s.columnText(4);
            try out.append(alloc, .{
                .id = @intCast(s.columnInt(0)),
                .parent_id = if (pid == 0) null else @intCast(pid),
                .name = try alloc.dupe(u8, s.columnText(2)),
                .is_folder = is_folder,
                .md5 = if (is_folder or m.len == 0) null else try alloc.dupe(u8, m),
                .size = @intCast(s.columnInt(5)),
                .deleted_at = s.columnInt(6),
                .path = try alloc.dupe(u8, s.columnText(7)),
                .is_root = s.columnInt(8) != 0,
            });
        }
        return out.toOwnedSlice(alloc);
    }

    /// How many LIVE rows a web delete of `id` would tombstone: the entry plus
    /// every live descendant. Scoped to `user_id`; 0 for a missing/foreign/already
    /// trashed id.
    ///
    /// Exists so the browser can be told the fanout of what it is about to do
    /// ("deletes the folder and the 2 notes inside it") — the same obligation
    /// restore carries in the other direction. Counted BEFORE `trash` runs, since
    /// afterwards there is nothing live left to count.
    pub fn liveSubtreeCount(self: Files, user_id: u64, id: u64) !usize {
        var r = (try self.db.row(live_subtree_count_sql, &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } })) orelse return 0;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// Moves an entry to the recycle bin (scoped to `user_id`): tombstones it and
    /// its whole subtree, stamps `deleted_at`, and bumps the sync-version. It
    /// **holds every blob reference** and refunds no quota — `purge` does both.
    /// NotFound if the id is absent or foreign.
    ///
    /// Idempotent, and deliberately indifferent to what is already tombstoned.
    /// The device deletes a folder as one request per entity, children first and
    /// the parent last, and it retries; so `trash` may arrive for an id that is
    /// already trashed, or for a folder whose children all are. A **web** delete
    /// of a folder, by contrast, has done no walk of its own. One subtree UPDATE
    /// gated on `deleted = 0` serves all three: it tombstones whatever is still
    /// live below the id, leaves already-trashed rows (and their original,
    /// earlier `deleted_at`) untouched, and lands both callers in the same state.
    pub fn trash(self: Files, user_id: u64, id: u64) !void {
        if (!try self.exists(user_id, id)) return error.NotFound;

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        var changed: i64 = 0;
        {
            var s = try self.db.prepare(subtree_trash_sql);
            defer s.finalize();
            s.bindInt(1, @intCast(id));
            s.bindInt(2, @intCast(user_id));
            s.bindInt(3, self.now());
            _ = try s.step();
            changed = self.db.changes();
        }
        // Only a real state change moves the counter: a retry that tombstoned
        // nothing must not invalidate every cached listing in the browser.
        if (changed > 0) try self.bumpSync(user_id);
        try self.db.exec("COMMIT;");
    }

    /// What a `restore` actually did — which is routinely MORE than the caller
    /// asked for, and the browser cannot tell the truth about it otherwise.
    /// `name` is owned by `gpa`; free it (or call `deinit`).
    pub const Restored = struct {
        /// The entry's resulting name, which is not necessarily the one it had:
        /// see `freeName`. Owned by `gpa`.
        name: []u8,
        /// True when `name` differs from the name the row was trashed under, so
        /// the UI can say "restored as `BuJo (2).note`" rather than silently
        /// producing a file the user did not name.
        renamed: bool,
        /// Trashed ANCESTOR folders brought back to make this entry reachable.
        /// Zero whenever the parent chain was already live.
        ancestors: usize,
        /// Trashed DESCENDANTS brought back with a folder. Zero for a file.
        descendants: usize,

        pub fn deinit(self: Restored, gpa: std.mem.Allocator) void {
            gpa.free(self.name);
        }
    };

    /// Brings a trashed entry back (scoped to `user_id`) and reports what it did —
    /// see `Restored`. NotFound if the id is absent or foreign; restoring a live
    /// entry is a no-op that reports its current name and zero counts.
    ///
    /// Three things happen beyond flipping the flag:
    ///
    ///   - **The ancestor chain is restored.** A live row under a trashed parent
    ///     is an orphan: every listing walks live parents, so it would be visible
    ///     nowhere at all.
    ///   - **Names that a live entry has since taken are auto-renamed**, because
    ///     `files_live_name` is UNIQUE on `(user_id, COALESCE(parent_id,0), name)
    ///     WHERE deleted = 0` and restoring onto an occupied name would violate
    ///     it. See `freeName`. The requested entry's final name is returned so the
    ///     caller can report "restored as `BuJo (2).note`".
    ///   - **Restoring a folder restores every trashed descendant.** Occasionally
    ///     surprising — a file trashed separately weeks earlier comes back too —
    ///     but easy to explain and easy to undo. The precise alternative is a
    ///     `deleted_batch` id so restore undoes exactly one delete *operation*;
    ///     more correct, one more column, and awkward given that the device sends
    ///     per-entity delete requests that share no batch. Start simple.
    ///
    /// The blob was never released, so there is nothing to re-fetch and nothing to
    /// re-index: the md5-keyed `note_index` rows are still there, and the file is
    /// searchable again the moment `deleted` goes back to 0.
    pub fn restore(self: Files, user_id: u64, id: u64) !Restored {
        if (!try self.exists(user_id, id)) return error.NotFound;

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        var ancestors: usize = 0;
        var descendants: usize = 0;

        // 1. Ancestors, root-first, so each row is made live under a parent that
        //    is already live (and so name collisions resolve top-down).
        {
            var chain: std.ArrayList(u64) = .empty; // leaf-first
            defer chain.deinit(self.gpa);
            var cur = try self.parentOf(user_id, id);
            var guard: usize = 0;
            while (cur) |pid| {
                guard += 1;
                if (guard > 256) break; // cycle guard (should never trigger)
                try chain.append(self.gpa, pid);
                cur = try self.parentOf(user_id, pid);
            }
            var i = chain.items.len;
            while (i > 0) {
                i -= 1;
                const r = try self.restoreRow(user_id, chain.items[i]);
                self.gpa.free(r.name);
                if (r.was_trashed) ancestors += 1;
            }
        }

        // 2. The entry itself. Its (possibly renamed) name is what we report.
        const self_row = try self.restoreRow(user_id, id);
        errdefer self.gpa.free(self_row.name);

        // 3. Every trashed descendant, shallowest first — same reason as the
        //    ancestors: a child must never be made live before its parent is.
        //    Ids are collected in full before anything is written; restoring
        //    while stepping the recursive CTE would mutate the table underneath it.
        {
            var kids: std.ArrayList(u64) = .empty;
            defer kids.deinit(self.gpa);
            {
                var s = try self.db.prepare(subtree_depth_sql);
                defer s.finalize();
                s.bindInt(1, @intCast(id));
                s.bindInt(2, @intCast(user_id));
                while (try s.step()) try kids.append(self.gpa, @intCast(s.columnInt(0)));
            }
            for (kids.items) |kid| {
                const r = try self.restoreRow(user_id, kid);
                self.gpa.free(r.name);
                if (r.was_trashed) descendants += 1;
            }
        }

        try self.bumpSync(user_id); // the tree changed; the device re-downloads
        try self.db.exec("COMMIT;");
        return .{
            .name = self_row.name,
            .renamed = self_row.renamed,
            .ancestors = ancestors,
            .descendants = descendants,
        };
    }

    /// Permanently destroys a trashed entry and its subtree (scoped to `user_id`).
    /// NotFound if the id is absent, foreign, or still live — purge operates on
    /// the bin, and hard-deleting a live file must never be one mistyped id away.
    ///
    /// This is where the reference `trash` held is finally given back: blob
    /// refcounts drop, blobs that reach 0 lose their `note_index` /
    /// `note_page_index` / `note_page_fts` rows and are removed from disk, and the
    /// bytes come off the user's quota. Irreversible.
    pub fn purge(self: Files, user_id: u64, id: u64) !void {
        if (!try self.existsTrashed(user_id, id)) return error.NotFound;

        var gc: std.ArrayList([md5_len]u8) = .empty;
        defer gc.deinit(self.gpa);

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        var ids: std.ArrayList(u64) = .empty;
        defer ids.deinit(self.gpa);
        {
            var s = try self.db.prepare(subtree_ids_sql);
            defer s.finalize();
            s.bindInt(1, @intCast(id));
            s.bindInt(2, @intCast(user_id));
            while (try s.step()) try ids.append(self.gpa, @intCast(s.columnInt(0)));
        }

        try self.releaseIds(user_id, ids.items, &gc);
        try self.bumpSync(user_id);
        try self.db.exec("COMMIT;");

        for (gc.items) |*m| self.removeBlobFiles(m); // GC on disk after the commit
    }

    /// Permanently destroys everything in a user's bin. Returns the number of
    /// entries removed. Irreversible; same release path as `purge`.
    pub fn emptyBin(self: Files, user_id: u64) !usize {
        var gc: std.ArrayList([md5_len]u8) = .empty;
        defer gc.deinit(self.gpa);

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        var ids: std.ArrayList(u64) = .empty;
        defer ids.deinit(self.gpa);
        {
            var s = try self.db.prepare(bin_ids_sql);
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            while (try s.step()) try ids.append(self.gpa, @intCast(s.columnInt(0)));
        }

        try self.releaseIds(user_id, ids.items, &gc);
        if (ids.items.len > 0) try self.bumpSync(user_id);
        try self.db.exec("COMMIT;");

        for (gc.items) |*m| self.removeBlobFiles(m);
        return ids.items.len;
    }

    /// Retention: purges every entry trashed more than `max_age_s` ago, for every
    /// user. Runs at startup, mirroring `sweepExpiredSessions`. Returns the number
    /// of entries removed.
    ///
    /// Users are swept one at a time because quota accounting is per-user, and
    /// each user's expired ids are expanded to their subtree closure so a folder's
    /// contents are released with it. A child trashed *before* its parent (the
    /// device's children-first order gives it a slightly earlier `deleted_at`)
    /// simply expires first and is purged as a subtree of one; the parent follows
    /// on the next sweep or in the same pass.
    pub fn sweepBin(self: Files, max_age_s: i64) !usize {
        return self.sweepBinBefore(self.now() - max_age_s);
    }

    /// `sweepBin` against an explicit cutoff instead of an age.
    ///
    /// Retention is configurable, and the policy that turns "the window" into "the
    /// cutoff" is not `now - window`: a shortened window must not retroactively
    /// purge, so the cutoff is also bounded by when the window last changed. That
    /// decision belongs to `services/settings.zig` (`sweepCutoff`), which is pure
    /// and tested as such — so the sweep takes the answer rather than recomputing
    /// a policy it would then own a second copy of.
    pub fn sweepBinBefore(self: Files, cutoff: i64) !usize {
        var users: std.ArrayList(u64) = .empty;
        defer users.deinit(self.gpa);
        {
            var s = try self.db.prepare(
                "SELECT DISTINCT user_id FROM files WHERE deleted = 1 AND COALESCE(deleted_at, 0) < ?1;",
            );
            defer s.finalize();
            s.bindInt(1, cutoff);
            while (try s.step()) try users.append(self.gpa, @intCast(s.columnInt(0)));
        }

        var total: usize = 0;
        for (users.items) |uid| total += try self.sweepBinForUser(uid, cutoff);
        return total;
    }

    fn sweepBinForUser(self: Files, user_id: u64, cutoff: i64) !usize {
        var gc: std.ArrayList([md5_len]u8) = .empty;
        defer gc.deinit(self.gpa);

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        var ids: std.ArrayList(u64) = .empty;
        defer ids.deinit(self.gpa);
        {
            var s = try self.db.prepare(expired_bin_ids_sql);
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            s.bindInt(2, cutoff);
            while (try s.step()) try ids.append(self.gpa, @intCast(s.columnInt(0)));
        }

        try self.releaseIds(user_id, ids.items, &gc);
        if (ids.items.len > 0) try self.bumpSync(user_id);
        try self.db.exec("COMMIT;");

        for (gc.items) |*m| self.removeBlobFiles(m);
        return ids.items.len;
    }

    /// Releases every blob reference a user's files hold and hard-deletes those
    /// rows — the storage half of account deletion. The `users` FK cascade cannot
    /// do this: it drops `files` rows, but dropping a row does not decrement the
    /// `blobs.refcount` it was counted in, so the blob (and its `note_index` /
    /// `note_page_index` / `note_page_fts` rows) would survive the account forever.
    ///
    /// Deduplication makes the shared case the one that matters: two users who own
    /// the same note share ONE blob at `refcount = 2`. This decrements — the blob
    /// is only reaped, unindexed and unlinked from disk when the count actually
    /// reaches 0 — so the surviving owner's note still opens and stays searchable.
    ///
    /// Call it BEFORE deleting the `users` row: once the cascade has removed the
    /// `files` rows, nothing records which blobs the account was holding.
    pub fn purgeUser(self: Files, user_id: u64) !void {
        // md5s of every blob reference the account holds (fixed-size, no ownership).
        var doomed: std.ArrayList([md5_len]u8) = .empty;
        defer doomed.deinit(self.gpa);

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        // The account's search world goes FIRST, while the md5-keyed text the
        // FTS deletes read still exists: every posting in the user's
        // partitions, the segment rows (one exact range delete per partition),
        // and the partition mapping rows. Restore never needed anything;
        // deletion needs exactly this.
        try notesearch.dropUserSearch(self.db, user_id);

        // EVERY file row, tombstoned ones included.
        //
        // This used to read `AND deleted = 0`, because `deleteEntry` decref'd at
        // tombstone time and counting a tombstone here would have decremented the
        // blob twice. With the recycle bin that reasoning inverts: `trash` HOLDS
        // the reference and only `purge` releases it, so a tombstoned row is
        // still a live reference in `blobs.refcount`. Skipping it now would be
        // the bug — the account's rows all vanish below, and any blob whose last
        // reference happened to be sitting in the bin would keep a refcount that
        // nothing can ever decrement: a leaked blob, its index, and its
        // searchable OCR text, surviving the account forever.
        {
            var s = try self.db.prepare(
                "SELECT md5 FROM files WHERE user_id = ?1 AND is_folder = 0;",
            );
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            while (try s.step()) {
                const m = s.columnText(0);
                if (m.len != md5_len) continue; // defensive: a folder-shaped row
                var buf: [md5_len]u8 = undefined;
                @memcpy(&buf, m);
                try doomed.append(self.gpa, buf);
            }
        }

        // The account's retained-version blobs (H10): every `file_history` row
        // cascades away with the `files` rows below, so collect their md5s first
        // and reap them after — otherwise a superseded version's blob (refcount
        // already 0, kept alive only by its history row) would survive the account
        // forever, exactly the leak the tombstone-inclusion note above guards.
        var hist_doomed: std.ArrayList([md5_len]u8) = .empty;
        defer hist_doomed.deinit(self.gpa);
        {
            var s = try self.db.prepare(
                "SELECT fh.md5 FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = ?1;",
            );
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            while (try s.step()) {
                const m = s.columnText(0);
                if (m.len != md5_len) continue;
                var buf: [md5_len]u8 = undefined;
                @memcpy(&buf, m);
                try hist_doomed.append(self.gpa, buf);
            }
        }

        // Drop the rows for real, in the same transaction as the decrefs, so
        // `refcount` never disagrees with the number of live referencing files.
        {
            var s = try self.db.prepare("DELETE FROM files WHERE user_id = ?1;");
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            _ = try s.step();
        }

        var gc: std.ArrayList([md5_len]u8) = .empty;
        defer gc.deinit(self.gpa);
        for (doomed.items) |*m| {
            if (try self.decref(m)) try gc.append(self.gpa, m.*);
        }
        try self.reapDistinct(hist_doomed.items, &gc);

        try self.db.exec("COMMIT;");

        for (gc.items) |*m| self.removeBlobFiles(m); // GC on disk after the commit
    }

    // ---- device upload sessions (upload/apply → /oss/put → upload/finish) ----

    /// Records an intended upload at `upload/apply` time: binds `inner_name` (our
    /// opaque upload key) to the destination `path` folder + `file_name` and the
    /// device-declared size. `blob_md5` stays null until the bytes arrive at
    /// `/oss/put`. These bound values — not finish's echoed path — are authoritative.
    pub fn createUploadSession(self: Files, user_id: u64, inner_name: []const u8, path: []const u8, file_name: []const u8, declared_size: u64) !void {
        var s = try self.db.prepare(
            "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, blob_md5, created_at) VALUES(?1,?2,?3,?4,?5,NULL,?6);",
        );
        defer s.finalize();
        s.bindText(1, inner_name);
        s.bindInt(2, @intCast(user_id));
        s.bindText(3, path);
        s.bindText(4, file_name);
        s.bindInt(5, @intCast(declared_size));
        s.bindInt(6, self.now());
        _ = try s.step();
    }

    /// Records the md5 the blob store computed for the bytes streamed to
    /// `/oss/put`, scoped to `(inner_name, user_id)`. Returns NotFound if no such
    /// live session exists for this caller.
    pub fn setUploadBlob(self: Files, user_id: u64, inner_name: []const u8, md5: []const u8) !void {
        var s = try self.db.prepare("UPDATE upload_sessions SET blob_md5 = ?1 WHERE inner_name = ?2 AND user_id = ?3;");
        defer s.finalize();
        s.bindText(1, md5);
        s.bindText(2, inner_name);
        s.bindInt(3, @intCast(user_id));
        _ = try s.step();
        if (self.db.changes() == 0) return error.NotFound;
    }

    /// Adds `delta` to a session's staged-byte total and returns the new value.
    ///
    /// **The per-session half of the upload cap.** `upload_cap` bounds one
    /// arriving body; nothing bounded their SUM, so a chunked `/oss/put` with a
    /// caller-chosen `totalChunks` could stage N × the cap before the merge. This
    /// is the running total each part's budget is computed against.
    ///
    /// `delta` is SIGNED because a re-POSTed part replaces its temp file rather
    /// than appending to it (`BlobStore.stagedPartSize` is the "before" figure the
    /// caller subtracts). A device retrying one part of a large upload must not be
    /// charged for it twice. The stored value is clamped at 0 so an over-large
    /// subtraction — a part file vanishing under us — cannot make the total
    /// negative and hand out an unbounded budget.
    ///
    /// `error.NotFound` when the session does not exist for this caller, which is
    /// the same ownership scoping `setUploadBlob` applies.
    pub fn addUploadReceived(self: Files, user_id: u64, inner_name: []const u8, delta: i64) !u64 {
        {
            var s = try self.db.prepare(
                "UPDATE upload_sessions SET received_bytes = MAX(0, received_bytes + ?1) " ++
                    "WHERE inner_name = ?2 AND user_id = ?3;",
            );
            defer s.finalize();
            s.bindInt(1, delta);
            s.bindText(2, inner_name);
            s.bindInt(3, @intCast(user_id));
            _ = try s.step();
            if (self.db.changes() == 0) return error.NotFound;
        }
        var r = (try self.db.row(
            "SELECT received_bytes FROM upload_sessions WHERE inner_name = ?1 AND user_id = ?2;",
            &.{ .{ .text = inner_name }, .{ .int = @intCast(user_id) } },
        )) orelse return error.NotFound;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// Looks up a session by `(inner_name, user_id)`. Slices are owned by `alloc`.
    pub fn uploadSession(self: Files, alloc: std.mem.Allocator, user_id: u64, inner_name: []const u8) !?UploadSession {
        var r = (try self.db.row("SELECT path, file_name, declared_size, blob_md5, received_bytes FROM upload_sessions WHERE inner_name = ?1 AND user_id = ?2;", &.{ .{ .text = inner_name }, .{ .int = @intCast(user_id) } })) orelse return null;
        defer r.finalize();
        const path = try alloc.dupe(u8, r.text(0));
        const file_name = try alloc.dupe(u8, r.text(1));
        const declared_size: u64 = @intCast(r.int(2));
        const raw_md5 = r.text(3);
        const blob_md5 = if (raw_md5.len == 0) null else try alloc.dupe(u8, raw_md5);
        return .{
            .path = path,
            .file_name = file_name,
            .declared_size = declared_size,
            .blob_md5 = blob_md5,
            .received_bytes = @intCast(r.int(4)),
        };
    }

    /// Deletes a consumed (or rejected) session row by key.
    pub fn deleteUploadSession(self: Files, inner_name: []const u8) !void {
        var s = try self.db.prepare("DELETE FROM upload_sessions WHERE inner_name = ?1;");
        defer s.finalize();
        s.bindText(1, inner_name);
        _ = try s.step();
    }

    /// Orphan cleanup: drops sessions older than `max_age_s` whose `finish` never
    /// arrived, removing each one's on-disk blob when it is untracked — i.e. has no
    /// `blobs` row (a `blobs` row is only created at finish, so a stale session's
    /// blob is on-disk-only and safe to reclaim; a md5 that some committed file
    /// shares would have a `blobs` row and is left alone). Returns the count swept.
    pub fn sweepUploadSessions(self: Files, max_age_s: i64) !usize {
        const cutoff = self.now() - max_age_s;

        // Collect the stale sessions + the md5s to reclaim (those without a blobs row).
        var doomed: std.ArrayList([]u8) = .empty; // inner_names, owned
        defer {
            for (doomed.items) |n| self.gpa.free(n);
            doomed.deinit(self.gpa);
        }
        var orphans: std.ArrayList([md5_len]u8) = .empty;
        defer orphans.deinit(self.gpa);
        {
            var s = try self.db.prepare(
                "SELECT s.inner_name, s.blob_md5 FROM upload_sessions s WHERE s.created_at < ?1;",
            );
            defer s.finalize();
            s.bindInt(1, cutoff);
            while (try s.step()) {
                try doomed.append(self.gpa, try self.gpa.dupe(u8, s.columnText(0)));
                const m = s.columnText(1);
                if (m.len == md5_len and !try self.blobRowExists(m)) {
                    var arr: [md5_len]u8 = undefined;
                    @memcpy(&arr, m[0..md5_len]);
                    try orphans.append(self.gpa, arr);
                }
            }
        }

        for (doomed.items) |n| try self.deleteUploadSession(n);
        for (orphans.items) |*m| self.removeBlobFiles(m); // reclaim on-disk-only bytes
        return doomed.items.len;
    }

    fn blobRowExists(self: Files, md5: []const u8) !bool {
        var s = try self.db.prepare("SELECT 1 FROM blobs WHERE md5 = ?1;");
        defer s.finalize();
        s.bindText(1, md5);
        return try s.step();
    }

    // ---- internal helpers ----

    // ---- bin SQL ----
    //
    // Every closure below walks children WITHOUT filtering on `deleted`. That is
    // deliberate: `parent_id` is `ON DELETE CASCADE`, so a row we hard-delete
    // takes its children with it whether or not we looked at them. Anything the
    // cascade would reach must therefore be in the set we decref, or its blob
    // reference leaks. Descending unconditionally makes that structural.

    /// Tombstone the subtree rooted at ?1, freezing each row's path AS IT IS NOW.
    /// Gated on `deleted = 0` in the UPDATE rather than in the walk, so already-
    /// trashed rows keep their original `deleted_at` (their retention clock does
    /// not restart) AND their earlier frozen `deleted_path`, while any live row
    /// below them — including one under an already-trashed folder — is caught.
    ///
    /// `deleted_path` is the path the entry has at THIS instant — the bin displays
    /// it verbatim rather than recomputing it, which is both the O(tree)→O(bin)
    /// win and the fix for the rename bug (a later rename of an ancestor cannot
    /// rewrite a tombstone's recorded path). The `tree` CTE is the whole-user
    /// top-down walk with NO `deleted` filter in either arm, matching what the old
    /// listing computed: a trashed row's ancestors are normally trashed too, so
    /// the walk must pass through them to reach the real root. Children first, the
    /// folder last (the device's delete order) each freeze their own correct path,
    /// because at each step every ancestor above the row being trashed is still
    /// present in the tree — trashed or not.
    const subtree_trash_sql =
        \\WITH RECURSIVE
        \\  sub(id) AS (
        \\    SELECT id FROM files WHERE id = ?1 AND user_id = ?2
        \\    UNION
        \\    SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
        \\  ),
        \\  tree(id, path) AS (
        \\    SELECT id, '/'||name FROM files WHERE user_id = ?2 AND parent_id IS NULL
        \\    UNION ALL
        \\    SELECT f.id, t.path||'/'||f.name FROM files f JOIN tree t ON f.parent_id = t.id
        \\    WHERE f.user_id = ?2
        \\  )
        \\UPDATE files SET deleted = 1, deleted_at = ?3, updated_at = ?3,
        \\  deleted_path = (SELECT path FROM tree WHERE tree.id = files.id)
        \\WHERE id IN (SELECT id FROM sub) AND deleted = 0;
    ;

    /// The subtree rooted at ?1, ordered so a parent always precedes its
    /// children. `id` breaks ties within a depth so that when two trashed
    /// siblings want the same name (delete → the device recreates it → delete
    /// again) the OLDER row wins it and the newer one takes the suffix — and the
    /// outcome is the same on every replay.
    const subtree_depth_sql =
        \\WITH RECURSIVE sub(id, depth) AS (
        \\  SELECT id, 0 FROM files WHERE id = ?1 AND user_id = ?2
        \\  UNION ALL
        \\  SELECT f.id, sub.depth + 1 FROM files f JOIN sub ON f.parent_id = sub.id
        \\)
        \\SELECT id FROM sub WHERE depth > 0 ORDER BY depth, id;
    ;

    /// Every id in the subtree rooted at ?1 (the entry included).
    const subtree_ids_sql =
        \\WITH RECURSIVE sub(id) AS (
        \\  SELECT id FROM files WHERE id = ?1 AND user_id = ?2
        \\  UNION
        \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
        \\)
        \\SELECT id FROM sub;
    ;

    /// Everything in user ?1's bin, plus anything reachable below it.
    const bin_ids_sql =
        \\WITH RECURSIVE sub(id) AS (
        \\  SELECT id FROM files WHERE user_id = ?1 AND deleted = 1
        \\  UNION
        \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
        \\)
        \\SELECT id FROM sub;
    ;

    /// The same, restricted to entries trashed before ?2 (the retention cutoff).
    const expired_bin_ids_sql =
        \\WITH RECURSIVE sub(id) AS (
        \\  SELECT id FROM files
        \\  WHERE user_id = ?1 AND deleted = 1 AND COALESCE(deleted_at, 0) < ?2
        \\  UNION
        \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
        \\)
        \\SELECT id FROM sub;
    ;

    /// The bin listing (see `listBin`). A DIRECT read of the tombstones — no tree
    /// walk — because the path each row shows was frozen into `deleted_path` by
    /// `trash` (backfilled for older rows by schema v12). Where the old query
    /// materialized the user's entire live tree to reconstruct a handful of paths,
    /// this probes only `deleted = 1` rows: O(bin), not O(tree). The partial index
    /// `files_deleted_at (deleted_at) WHERE deleted = 1` both selects the rows and
    /// supplies the `deleted_at` ordering.
    ///
    /// `deleted_path` COALESCEs to "" only defensively — every trashed row has one
    /// after v12. `is_root` (column 8) is the one thing still computed at read
    /// time, and must be: it turns on whether the parent is CURRENTLY the root or
    /// still live, a fact about rows not in this response, not a property frozen at
    /// trash time. Column order matches the old query so `listBin` is untouched.
    const bin_listing_sql =
        \\SELECT id, parent_id, name, is_folder, md5, size,
        \\       COALESCE(deleted_at, 0), COALESCE(deleted_path, ''),
        \\       (parent_id IS NULL OR NOT EXISTS (
        \\          SELECT 1 FROM files p WHERE p.id = files.parent_id AND p.deleted = 1))
        \\FROM files WHERE user_id = ?1 AND deleted = 1
        \\ORDER BY COALESCE(deleted_at, 0) DESC, id DESC;
    ;

    /// The live subtree rooted at ?1 (the entry included), counted. Both arms are
    /// gated on `deleted = 0`, so it counts exactly what `trash` will tombstone
    /// and never a row that is already in the bin.
    const live_subtree_count_sql =
        \\WITH RECURSIVE sub(id) AS (
        \\  SELECT id FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0
        \\  UNION
        \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id WHERE f.deleted = 0
        \\)
        \\SELECT COUNT(*) FROM sub;
    ;

    /// Hard-deletes `ids` (a cascade-closed set) and gives back everything they
    /// hold: blob references, quota bytes, and — through `decref` →
    /// `unindexBlob` / `deleteForBlob` — the note index and FTS entries of any
    /// blob whose last reference this removes. The single release path behind
    /// `purge`, `emptyBin` and `sweepBin`.
    ///
    /// Must be called inside an open transaction. md5s and sizes are read for the
    /// WHOLE set before a single row is deleted: the FK cascade can remove a row
    /// we have not yet looked at, and a row that is gone can no longer tell us
    /// which blob it was holding. Blobs that reached refcount 0 are appended to
    /// `gc` for the caller to remove from disk AFTER the commit.
    fn releaseIds(self: Files, user_id: u64, ids: []const u64, gc: *std.ArrayList([md5_len]u8)) !void {
        // One entry per doomed ROW, duplicates included: `blobs.refcount` counts
        // referencing rows, so every row must decref exactly once. The quota
        // refund below deliberately works off the DISTINCT md5s instead.
        const Doomed = struct { md5: [md5_len]u8, size: i64 };
        var doomed: std.ArrayList(Doomed) = .empty;
        defer doomed.deinit(self.gpa);

        for (ids) |fid| {
            var r = (try self.db.row(
                "SELECT md5, size FROM files WHERE id = ?1 AND user_id = ?2 AND is_folder = 0;",
                &.{ .{ .int = @intCast(fid) }, .{ .int = @intCast(user_id) } },
            )) orelse continue; // a folder, or already gone
            defer r.finalize();
            const m = r.text(0);
            if (m.len != md5_len) continue; // defensive: a file row with no blob
            var d: Doomed = .{ .md5 = undefined, .size = r.int(1) };
            @memcpy(&d.md5, m);
            try doomed.append(self.gpa, d);
        }

        // Retained-version blobs of the doomed files (H10): their `file_history`
        // rows CASCADE away with the `files` rows below, dropping their sole
        // keep-alive. Collect the md5s FIRST (the cascade removes rows we could no
        // longer read) and reap them after the deletes, so a purged file's
        // history leaves disk like any other unreferenced blob. NOT a quota refund
        // — a retained version already left the user's live quota when it was
        // superseded.
        var hist_doomed: std.ArrayList(Evicted) = .empty;
        defer hist_doomed.deinit(self.gpa);
        for (ids) |fid| {
            var s = try self.db.prepare("SELECT md5, size FROM file_history WHERE file_id = ?1;");
            defer s.finalize();
            s.bindInt(1, @intCast(fid));
            while (try s.step()) {
                const m = s.columnText(0);
                if (m.len != md5_len) continue;
                var e: Evicted = .{ .md5 = undefined, .size = s.columnInt(1) };
                @memcpy(&e.md5, m);
                try hist_doomed.append(self.gpa, e);
            }
        }

        for (ids) |fid| {
            var s = try self.db.prepare("DELETE FROM files WHERE id = ?1 AND user_id = ?2;");
            defer s.finalize();
            s.bindInt(1, @intCast(fid));
            s.bindInt(2, @intCast(user_id));
            _ = try s.step();
        }

        // The owner's SEARCH rows follow LIVE FILE references, so this pass still
        // asks `userBlobRefs`: a blob no file of theirs holds any more must stop
        // being findable, whatever `file_history` says about it.
        //
        // Read AFTER the deletes above, so it sees the final state — and BEFORE
        // the decrefs below, because the FTS 'delete' reads the md5-keyed text a
        // refcount-0 GC would take away.
        var seen: std.ArrayList([md5_len]u8) = .empty;
        defer seen.deinit(self.gpa);
        outer: for (doomed.items) |*d| {
            for (seen.items) |*s| if (std.mem.eql(u8, s, &d.md5)) continue :outer;
            try seen.append(self.gpa, d.md5);
            if (try self.userBlobRefs(user_id, &d.md5) == 0) {
                try notesearch.dropOwnerBlobSearch(self.db, user_id, &d.md5);
            }
        }

        // Refund the mirror image of what `linkBlobIndexed` charged: one refund
        // per DISTINCT blob, and only for a blob this user no longer references
        // in ANY charged sense. Two of the user's files sharing content were
        // billed once, so deleting one of them must give back nothing — and
        // deleting both must give back the size once, not twice.
        //
        // **Purged files' RETAINED VERSIONS are refunded here too** (§6). Their
        // `file_history` rows cascaded away with the `files` rows above, so the
        // bytes are genuinely gone; charging for them afterwards would leave a
        // permanent phantom on the meter that no action could ever clear. This is
        // also what makes the recycle-bin line on the account screen truthful:
        // that figure promises what emptying the bin returns, and it returns the
        // trashed files' versions along with the files.
        var settled: std.ArrayList([md5_len]u8) = .empty;
        defer settled.deinit(self.gpa);
        var delta: i64 = 0;
        for (doomed.items) |*d| try self.settleRefund(user_id, &d.md5, d.size, &settled, &delta);
        for (hist_doomed.items) |*h| try self.settleRefund(user_id, &h.md5, h.size, &settled, &delta);
        if (delta != 0) try self.addUsed(user_id, delta);

        for (doomed.items) |*d| {
            if (try self.decref(&d.md5)) try gc.append(self.gpa, d.md5);
        }

        // The cascade-deleted history rows are gone now; reap any blob they were
        // the last keeper of (a distinct-blob pass, so an oscillation's shared
        // blob is reaped once). Runs after the decrefs so the live/history state
        // both reflect the final rows.
        {
            var hist_md5s: std.ArrayList([md5_len]u8) = .empty;
            defer hist_md5s.deinit(self.gpa);
            for (hist_doomed.items) |*h| try hist_md5s.append(self.gpa, h.md5);
            try self.reapDistinct(hist_md5s.items, gc);
        }
    }

    /// How many of `user_id`'s file rows reference `md5` — trashed rows included,
    /// because the bin holds a real reference to real bytes.
    ///
    /// This is the per-user counterpart to `blobs.refcount` (which is global, so
    /// it cannot answer "does THIS user still hold this blob?"), and it is what
    /// decides whether a link charges quota or an unlink refunds it. Quota is
    /// billed per distinct blob per user; dedup across two users is not a
    /// discount on either account.
    fn userBlobRefs(self: Files, user_id: u64, md5: []const u8) !u64 {
        var r = (try self.db.row(
            "SELECT COUNT(*) FROM files WHERE user_id = ?1 AND is_folder = 0 AND md5 = ?2;",
            &.{ .{ .int = @intCast(user_id) }, .{ .text = md5 } },
        )) orelse return 0;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// How many references of ANY charged kind `user_id` holds to `md5`: their
    /// `files` rows (live or trashed) PLUS the `file_history` rows of those files.
    ///
    /// **This is the quota predicate since §6**, and the wider one. `userBlobRefs`
    /// answers "does a FILE of theirs hold this blob", which is the right question
    /// for search rows and the wrong one for billing: a retained version keeps the
    /// blob on disk through `reapIfUnreferenced`'s keep-alive gate, so it occupies
    /// storage the account is responsible for. The rule the service header states —
    /// *if the bytes occupy disk, the user is charged* — already applies to a
    /// trashed file for precisely this reason; history was the inconsistency, not
    /// the proposal.
    ///
    /// Two indexed COUNTs (`files_md5`, `file_history_md5`), summed in one row.
    fn userChargedRefs(self: Files, user_id: u64, md5: []const u8) !u64 {
        var r = (try self.db.row(
            "SELECT (SELECT COUNT(*) FROM files WHERE user_id = ?1 AND is_folder = 0 AND md5 = ?2) + " ++
                "(SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id " ++
                "  WHERE f.user_id = ?1 AND fh.md5 = ?2);",
            &.{ .{ .int = @intCast(user_id) }, .{ .text = md5 } },
        )) orelse return 0;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// Gives `size` back to `delta` if `md5` is now unreferenced by `user_id` in
    /// every charged sense — and records that it did, so the same blob cannot be
    /// refunded twice down two paths in one transaction (the superseded blob and
    /// an evicted version can be the same bytes).
    ///
    /// It reads the CURRENT row state, so callers must have finished their writes.
    /// A blob that is still held is left alone and stays refundable later in the
    /// same transaction — which is exactly what the quota-pressure loop needs when
    /// it drops the second of two history rows pointing at one blob.
    fn settleRefund(
        self: Files,
        user_id: u64,
        md5: []const u8,
        size: i64,
        settled: *std.ArrayList([md5_len]u8),
        delta: *i64,
    ) !void {
        for (settled.items) |*s| if (std.mem.eql(u8, s, md5)) return;
        if (try self.userChargedRefs(user_id, md5) != 0) return;
        var buf: [md5_len]u8 = undefined;
        @memcpy(&buf, md5[0..md5_len]);
        try settled.append(self.gpa, buf);
        delta.* -= size;
    }

    /// True when `user_id` holds ANY file — live or trashed — referencing blob
    /// `md5`. The ownership boundary for md5-keyed control-plane reads that have no
    /// file id to scope through: `/thumbnail/{hash}` is keyed by content, not by a
    /// row, so `Files.get(user_id, id)` cannot gate it. A holder of the bytes may
    /// read anything derived from them (they can already download the whole file);
    /// a non-holder is answered exactly as "no such thumbnail", so a foreign hash
    /// is indistinguishable from a missing one and the endpoint is no existence
    /// oracle over the deduplicated blob space. The quota predicate `userBlobRefs`
    /// is the same "does this user hold this blob" question.
    pub fn holdsBlob(self: Files, user_id: u64, md5: []const u8) !bool {
        return (try self.userBlobRefs(user_id, md5)) > 0;
    }

    /// What `restoreRow` did to one row. `was_trashed` is what the counts in
    /// `Restored` are built from: it is false for a row that was already live, so
    /// the ancestor and descendant passes report only rows they actually changed.
    const RestoredRow = struct { name: []u8, was_trashed: bool, renamed: bool };

    /// Makes one row live again, renaming it if a live sibling has taken its name
    /// in the meantime. The returned `name` is owned by `gpa`.
    ///
    /// A row that is ALREADY live is left completely alone (its name is simply
    /// reported back), which is what makes the ancestor and descendant passes of
    /// `restore` safe to run over rows that were never trashed.
    fn restoreRow(self: Files, user_id: u64, id: u64) !RestoredRow {
        var parent_id: ?u64 = null;
        var deleted = false;
        var name: []u8 = undefined;
        {
            var r = (try self.db.row(
                "SELECT parent_id, name, deleted FROM files WHERE id = ?1 AND user_id = ?2;",
                &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
            )) orelse return error.NotFound;
            defer r.finalize();
            const pid = r.int(0);
            parent_id = if (pid == 0) null else @intCast(pid);
            name = try self.gpa.dupe(u8, r.text(1));
            deleted = r.int(2) != 0;
        }
        defer self.gpa.free(name);
        if (!deleted) return .{ .name = try self.gpa.dupe(u8, name), .was_trashed = false, .renamed = false };

        const final = try self.freeName(user_id, parent_id, name);
        errdefer self.gpa.free(final);

        // `deleted_path` is cleared with the tombstone: it is the NULL-for-live
        // invariant, and if this row is trashed again `trash` freezes a fresh one.
        var s = try self.db.prepare(
            "UPDATE files SET deleted = 0, deleted_at = NULL, deleted_path = NULL, name = ?1, updated_at = ?2 WHERE id = ?3;",
        );
        defer s.finalize();
        s.bindText(1, final);
        s.bindInt(2, self.now());
        s.bindInt(3, @intCast(id));
        _ = try s.step();
        return .{ .name = final, .was_trashed = true, .renamed = !std.mem.eql(u8, final, name) };
    }

    /// A name free in `parent_id`, derived from `wanted`. Returns a copy of
    /// `wanted` when nothing live holds it; otherwise inserts ` (n)` before the
    /// extension — `BuJo.note` → `BuJo (2).note`, a folder `Dir` → `Dir (2)` —
    /// taking the lowest free `n` from 2 upwards. Always a fresh allocation.
    ///
    /// Deterministic by construction, so a restore replayed after a crash lands
    /// on the same name rather than accumulating variants. The scheme is the
    /// protocol's own idiom rather than an invention: the device's
    /// `create_folder_v2` already carries an `autorename` flag. Suffixing the
    /// STEM (not the whole name) keeps `.note` at the end, which is what both the
    /// device and our own type detection key off.
    ///
    /// A suffix already present is REPLACED, not stacked: a name we previously
    /// renamed to `BuJo (2).note` and that is trashed and restored again becomes
    /// `BuJo (3).note`, never `BuJo (2) (2).note`. Round-tripping through the bin
    /// is a normal thing to do repeatedly, and without this the name grows a
    /// parenthesis every time.
    fn freeName(self: Files, user_id: u64, parent_id: ?u64, wanted: []const u8) ![]u8 {
        if (try self.liveChild(user_id, parent_id, wanted) == null) return self.gpa.dupe(u8, wanted);

        // A leading dot is part of the name, not an extension separator.
        const dot = std.mem.lastIndexOfScalar(u8, wanted, '.');
        const full_stem = if (dot) |d| (if (d == 0) wanted else wanted[0..d]) else wanted;
        const ext = wanted[full_stem.len..];
        const stem = stripSuffix(full_stem);

        var n: u32 = 2;
        while (n < 10_000) : (n += 1) {
            const cand = try std.fmt.allocPrint(self.gpa, "{s} ({d}){s}", .{ stem, n, ext });
            errdefer self.gpa.free(cand);
            if (try self.liveChild(user_id, parent_id, cand) == null) return cand;
            self.gpa.free(cand);
        }
        return error.NameConflict;
    }

    /// The `parent_id` of a row in ANY state (live or trashed), or null at the
    /// root. `restore` walks with this rather than a live-only lookup — the whole
    /// point is that the ancestors it is chasing are themselves trashed.
    fn parentOf(self: Files, user_id: u64, id: u64) !?u64 {
        var r = (try self.db.row("SELECT parent_id FROM files WHERE id = ?1 AND user_id = ?2;", &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } })) orelse return null;
        defer r.finalize();
        const pid = r.int(0);
        return if (pid == 0) null else @intCast(pid);
    }

    /// True when moving folder `id` under `new_parent` would create a cycle — i.e.
    /// `new_parent` IS `id`, or sits somewhere inside `id`'s own subtree. Walks the
    /// parent chain UP from `new_parent`; reaching `id` means the target is at or
    /// below it. The root (`null`) is never inside any subtree, so it never cycles.
    /// The 256-hop guard mirrors `pathOf` / `restore` — a well-formed tree never
    /// reaches it.
    fn wouldCycle(self: Files, user_id: u64, new_parent: ?u64, id: u64) !bool {
        var cur = new_parent;
        var guard: usize = 0;
        while (cur) |c| {
            if (c == id) return true;
            guard += 1;
            if (guard > 256) break;
            cur = try self.parentOf(user_id, c);
        }
        return false;
    }

    /// A user's storage accounting: bytes charged against their quota, and the
    /// quota itself. Public because the device's `get_space_usage` endpoint
    /// reports both straight from here.
    pub const Cap = struct { used: i64, total: i64 };

    /// Fallback quota when a user has no `capacity` row yet, and the total used
    /// when `ensureCapacity` creates one. An alias of the single definition in
    /// the db layer (via the auth service), so the read default, the created row
    /// and the v10 repair migration can never drift apart.
    pub const default_total_bytes: i64 = authsvc.default_capacity;

    /// The user's `capacity` row. A user with NO row reads as the server default
    /// (0 used against `default_total_bytes`) rather than erroring — the write
    /// paths call `ensureCapacity`, so a missing row only ever means "nothing
    /// stored yet", and the device's storage display must not 500 on it.
    pub fn capacity(self: Files, user_id: u64) !Cap {
        var r = (try self.db.row("SELECT used_bytes, total_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse
            return .{ .used = 0, .total = default_total_bytes };
        defer r.finalize();
        return .{ .used = r.int(0), .total = r.int(1) };
    }

    /// The five-way storage split behind the account screen's Storage section
    /// (docs/scratch/user-options.md §7). Every figure is a sum over DISTINCT
    /// blobs — `used_bytes` counts distinct blobs, so a naive sum of `files.size`
    /// would double-count the user's deduplicated copies and the lines would not
    /// add up to the meter they sit under.
    ///
    /// **These five are a PARTITION of the user's charged bytes**, and the
    /// partition only holds because of a stated PRECEDENCE — one blob is reachable
    /// several ways, and it must be counted exactly once:
    ///
    ///   1. **Live kinds** — any blob a LIVE file references, filed under that
    ///      file's kind (`.note` → notebooks, `.spd` → sketches, everything else →
    ///      documents, which is the catch-all so a file with an unknown extension
    ///      still lands somewhere).
    ///   2. **Recycle bin** — blobs reachable from a TRASHED file, or from the
    ///      history OF a trashed file (H10: history follows a file into the bin and
    ///      is purged with it), and not already counted live.
    ///   3. **Versions** — blobs reachable only from the history of LIVE files.
    ///
    /// Precedence is not arbitrary. A blob shared by a live file and a trashed one
    /// frees NOTHING when the bin is emptied, so filing it under Recycle bin would
    /// make that line a lie — and this line has to mean *what emptying the bin
    /// actually returns*. The same argument puts a blob shared by a live file and a
    /// retained version under live: Versions is the MARGINAL cost of versioning,
    /// not a second count of bytes a live file already pays for.
    ///
    /// A blob two live files of DIFFERENT kinds share is filed under the
    /// lowest-ranked kind (notebook < sketch < document) so the assignment is
    /// deterministic and the buckets stay disjoint. Measured against the live beta
    /// database that case does not occur, but "the day someone uploads a notebook
    /// under a second name" is the day it would silently double-count.
    ///
    /// One statement, three index-assisted scans of the caller's own rows; §8
    /// costed the split at 0.65 ms on the live database. No caching and no
    /// maintained column: a page opened occasionally does not need either.
    pub const StorageBreakdown = struct {
        notebooks: i64 = 0,
        sketches: i64 = 0,
        documents: i64 = 0,
        recycle_bin: i64 = 0,
        versions: i64 = 0,

        /// The sum of the five. Equals `capacity.used_bytes` — that identity is the
        /// property the partition test asserts after every mutation.
        pub fn total(self: StorageBreakdown) i64 {
            return self.notebooks + self.sketches + self.documents + self.recycle_bin + self.versions;
        }
    };

    const storage_breakdown_sql =
        \\WITH live(md5, rank) AS (
        \\  SELECT f.md5,
        \\         MIN(CASE WHEN lower(f.name) LIKE '%.note' THEN 0
        \\                  WHEN lower(f.name) LIKE '%.spd'  THEN 1
        \\                  ELSE 2 END)
        \\    FROM files f
        \\   WHERE f.user_id = ?1 AND f.deleted = 0 AND f.is_folder = 0
        \\     AND f.md5 IS NOT NULL AND f.md5 <> ''
        \\   GROUP BY f.md5
        \\),
        \\binned(md5) AS (
        \\  SELECT DISTINCT m.md5 FROM (
        \\    SELECT f.md5 AS md5 FROM files f
        \\     WHERE f.user_id = ?1 AND f.deleted = 1 AND f.is_folder = 0
        \\       AND f.md5 IS NOT NULL AND f.md5 <> ''
        \\    UNION ALL
        \\    SELECT fh.md5 FROM file_history fh JOIN files f ON f.id = fh.file_id
        \\     WHERE f.user_id = ?1 AND f.deleted = 1
        \\  ) m
        \\  WHERE m.md5 NOT IN (SELECT md5 FROM live)
        \\),
        \\versions(md5) AS (
        \\  SELECT DISTINCT fh.md5 FROM file_history fh JOIN files f ON f.id = fh.file_id
        \\   WHERE f.user_id = ?1 AND f.deleted = 0
        \\     AND fh.md5 NOT IN (SELECT md5 FROM live)
        \\     AND fh.md5 NOT IN (SELECT md5 FROM binned)
        \\)
        \\SELECT
        \\  (SELECT COALESCE(SUM(b.size), 0) FROM live l JOIN blobs b ON b.md5 = l.md5 WHERE l.rank = 0),
        \\  (SELECT COALESCE(SUM(b.size), 0) FROM live l JOIN blobs b ON b.md5 = l.md5 WHERE l.rank = 1),
        \\  (SELECT COALESCE(SUM(b.size), 0) FROM live l JOIN blobs b ON b.md5 = l.md5 WHERE l.rank = 2),
        \\  (SELECT COALESCE(SUM(b.size), 0) FROM binned x JOIN blobs b ON b.md5 = x.md5),
        \\  (SELECT COALESCE(SUM(b.size), 0) FROM versions v JOIN blobs b ON b.md5 = v.md5);
    ;

    pub fn storageBreakdown(self: Files, user_id: u64) !StorageBreakdown {
        var r = (try self.db.row(storage_breakdown_sql, &.{.{ .int = @intCast(user_id) }})) orelse return .{};
        defer r.finalize();
        return .{
            .notebooks = r.int(0),
            .sketches = r.int(1),
            .documents = r.int(2),
            .recycle_bin = r.int(3),
            .versions = r.int(4),
        };
    }

    /// The highest `keep` anyone may choose — `config.History.max_keep`, but never
    /// below the configured DEFAULT.
    ///
    /// `@max` rather than the field alone, because a default outside the ceiling
    /// is incoherent: an install that had raised `history.keep` to 20 before
    /// `max_keep` existed would otherwise find every user silently clamped down
    /// to 15 and their versions evicted on the next edit. The invariant lives
    /// here, in the one place the ceiling is read, rather than in config
    /// validation that a hand-edited file can sidestep.
    fn historyCeiling(self: Files) u32 {
        return @max(self.history.keep, self.history.max_keep);
    }

    /// How many versions of each file this user keeps, and the ceiling they may
    /// choose within (docs/scratch/user-options.md §7).
    ///
    /// `keep` is the EFFECTIVE value the eviction path uses; `max_keep` is the
    /// admin's configured value, which is both the default (a user who has never
    /// chosen reads `users.history_keep IS NULL` and gets it) and the ceiling — a
    /// stored value above it is clamped rather than honoured, so one household
    /// member cannot set the whole install's disk policy by writing a large number
    /// and the admin lowering the config takes effect immediately for everyone.
    pub const VersionPolicy = struct { keep: u32, max_keep: u32 };

    pub fn versionPolicy(self: Files, user_id: u64) !VersionPolicy {
        // TWO DIFFERENT NUMBERS, since `max_keep` split from `keep`. A user who
        // has never chosen gets the DEFAULT (`history.keep`); the ceiling only
        // bounds what they may choose. These were one value, and returning the
        // ceiling as the default was harmless while they were equal — the moment
        // they parted it silently gave every untouched account the maximum depth,
        // which the retention tests caught by retaining more than K.
        const ceiling = self.historyCeiling();
        const fallback: VersionPolicy = .{ .keep = self.history.keep, .max_keep = ceiling };
        var r = (try self.db.row("SELECT history_keep FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse
            return fallback;
        defer r.finalize();
        const stored = r.intOpt(0) orelse return fallback;
        const clamped: u32 = if (stored <= 0) 0 else @intCast(@min(stored, @as(i64, ceiling)));
        return .{ .keep = clamped, .max_keep = ceiling };
    }

    /// How many versions are retained behind each LIVE file that has any — one
    /// entry per such file, caller-owned.
    ///
    /// This exists so the settings control can state its cost BEFORE it is paid:
    /// "Keeping 3 will remove 8 versions now" is `Σ max(0, count − 3)` over this
    /// list. Discarded versions do not go to the recycle bin, they are gone, so
    /// the number has to be a fact offered while there is still time to not press
    /// the button rather than an apology afterwards.
    ///
    /// Shipping the counts rather than answering one hypothetical at a time is
    /// deliberate: the control recomputes on every keystroke, and a household has
    /// tens of files with history, not millions. A round trip per digit would be
    /// slower AND would make the notice lag the number it describes.
    ///
    /// LIVE files only — a trashed file's retained versions are counted in the
    /// storage panel's Recycle bin line (`storageBreakdown`), and lowering `keep`
    /// does not touch them, so including them here would predict a discard that
    /// will not happen.
    pub fn retainedPerFile(self: Files, gpa: std.mem.Allocator, user_id: u64) ![]u32 {
        var out: std.ArrayList(u32) = .empty;
        errdefer out.deinit(gpa);
        var s = try self.db.prepare(
            "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id " ++
                "WHERE f.user_id = ?1 AND f.deleted = 0 GROUP BY fh.file_id;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        while (try s.step()) try out.append(gpa, @intCast(s.columnInt(0)));
        return out.toOwnedSlice(gpa);
    }

    /// What changing `keep` cost: the policy now in force, and what the change
    /// actually discarded. Reported so the interface can CONFIRM the number it
    /// predicted rather than assert it a second time — if these ever disagree with
    /// `retainedPerFile`'s arithmetic, the interface was lying and should be able
    /// to notice.
    pub const VersionPolicyChange = struct {
        policy: VersionPolicy,
        removed_versions: u32 = 0,
        freed_bytes: i64 = 0,
    };

    /// Sets this user's version depth, evicting immediately down to the new value.
    ///
    /// Clamped to the admin's ceiling rather than refused, matching `versionPolicy`
    /// — the stored value is never authoritative on its own, so a request above the
    /// ceiling stores the ceiling and the returned policy says what actually took
    /// effect. **`keep = 0` is a real setting, not a disabled state**: someone who
    /// would rather spend every byte on live files must be able to say so, and it
    /// turns versioning off end to end (`recordHistory` never runs).
    ///
    /// RAISING discards nothing and frees nothing; it only changes what future
    /// edits retain. Lowering evicts through the same `evictHistory` the supersede
    /// path uses, so eviction has one implementation and this cannot drift from it.
    ///
    /// The quota settlement mirrors `linkBlob`'s: refunds are computed from what
    /// the rows say AFTER every delete, through `settleRefund`, so a blob two
    /// evicted versions shared is refunded once and a blob a live file still holds
    /// is not refunded at all. Blob files are removed only after COMMIT.
    pub fn setVersionPolicy(self: Files, user_id: u64, want: u32) !VersionPolicyChange {
        const ceiling = self.historyCeiling();
        const keep: u32 = @min(want, ceiling);

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        {
            var s = try self.db.prepare("UPDATE users SET history_keep = ?2 WHERE id = ?1;");
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            s.bindInt(2, @intCast(keep));
            _ = try s.step();
        }

        var gc: std.ArrayList([md5_len]u8) = .empty;
        defer gc.deinit(self.gpa);
        var evicted: std.ArrayList(Evicted) = .empty;
        defer evicted.deinit(self.gpa);

        // Every live file of theirs that holds more than `keep`. Selected BEFORE
        // deleting anything, so the set cannot shift under the loop.
        var doomed: std.ArrayList(u64) = .empty;
        defer doomed.deinit(self.gpa);
        {
            var s = try self.db.prepare(
                "SELECT fh.file_id FROM file_history fh JOIN files f ON f.id = fh.file_id " ++
                    "WHERE f.user_id = ?1 AND f.deleted = 0 " ++
                    "GROUP BY fh.file_id HAVING COUNT(*) > ?2;",
            );
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            s.bindInt(2, @intCast(keep));
            while (try s.step()) try doomed.append(self.gpa, @intCast(s.columnInt(0)));
        }
        for (doomed.items) |file_id| try self.evictHistory(user_id, file_id, keep, &gc, &evicted);

        var settled: std.ArrayList([md5_len]u8) = .empty;
        defer settled.deinit(self.gpa);
        var delta: i64 = 0;
        for (evicted.items) |*e| try self.settleRefund(user_id, &e.md5, e.size, &settled, &delta);
        if (delta != 0) try self.addUsed(user_id, delta);

        try self.db.exec("COMMIT;");
        for (gc.items) |*m| self.removeBlobFiles(m);

        return .{
            .policy = .{ .keep = keep, .max_keep = ceiling },
            .removed_versions = @intCast(evicted.items.len),
            // `delta` is negative (bytes given back); the interface says "freed".
            .freed_bytes = -delta,
        };
    }

    /// Guarantees a `capacity` row exists for the user before we touch usage.
    /// Without this the `addUsed` UPDATE matches ZERO rows for a user who has no
    /// row (admin `createUser`, manual insert, any onboarding path that skips
    /// `bindEquipment`), so `used_bytes` would never accrue and quota would be
    /// silently disabled. `INSERT OR IGNORE` mirrors the auth service and shares
    /// the same default total, so a missing row can never disable accounting.
    fn ensureCapacity(self: Files, user_id: u64) !void {
        var s = try self.db.prepare("INSERT OR IGNORE INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, ?2);");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, default_total_bytes);
        _ = try s.step();
    }

    fn addUsed(self: Files, user_id: u64, delta: i64) !void {
        try self.ensureCapacity(user_id); // the row must exist or the UPDATE no-ops (quota bypass)
        var s = try self.db.prepare("UPDATE capacity SET used_bytes = used_bytes + ?1 WHERE user_id = ?2;");
        defer s.finalize();
        s.bindInt(1, delta);
        s.bindInt(2, @intCast(user_id));
        _ = try s.step();
    }

    fn ensureBlobRow(self: Files, md5: []const u8, size: u64) !void {
        var s = try self.db.prepare("INSERT INTO blobs(md5, size, refcount, created_at) VALUES(?1,?2,0,?3) ON CONFLICT(md5) DO NOTHING;");
        defer s.finalize();
        s.bindText(1, md5);
        s.bindInt(2, @intCast(size));
        s.bindInt(3, self.now());
        _ = try s.step();
    }

    fn incref(self: Files, md5: []const u8) !void {
        var s = try self.db.prepare("UPDATE blobs SET refcount = refcount + 1 WHERE md5 = ?1;");
        defer s.finalize();
        s.bindText(1, md5);
        _ = try s.step();
    }

    /// Removes a blob's on-disk files — the content-addressed blob AND its
    /// derived thumbnail — after the transaction that released the last
    /// reference has committed. EVERY post-commit GC site calls this rather
    /// than `blobs.remove` directly, so no site can forget the pair and leak a
    /// `thumbs/` file for content that no longer exists.
    fn removeBlobFiles(self: Files, md5: []const u8) void {
        self.blobs.remove(md5);
        self.thumbs.remove(md5);
    }

    /// Decrements a blob's LIVE reference (`blobs.refcount`, the count of `files`
    /// rows pointing at it) and then runs the GC gate. Returns true when the blob
    /// was reaped and its on-disk bytes should be removed by the caller after
    /// commit. `refcount` keeps meaning "live-file references" exactly as before;
    /// the history keep-alive is a SEPARATE gate applied by `reapIfUnreferenced`.
    fn decref(self: Files, md5: []const u8) !bool {
        {
            var s = try self.db.prepare("UPDATE blobs SET refcount = refcount - 1 WHERE md5 = ?1;");
            defer s.finalize();
            s.bindText(1, md5);
            _ = try s.step();
        }
        return self.reapIfUnreferenced(md5);
    }

    /// The single GC gate. Reaps a blob — drops its FTS backstop, its note/`.spd`
    /// index and its `blobs` row, and reports that the on-disk bytes should be
    /// removed post-commit (true) — ONLY when nothing references it any more:
    ///
    ///   - no LIVE file holds it (`blobs.refcount == 0`), AND
    ///   - no `file_history` row holds it (a retained version is the second
    ///     keep-alive — the reference the GC must never outlive).
    ///
    /// When either still holds it, returns false and leaves the blob, its bytes
    /// and its md5-keyed render index untouched — which is exactly what makes a
    /// retained version's render index survive "for free."
    ///
    /// Split out from `decref` because history eviction reaps a version whose
    /// LIVE reference was already released back at supersede time: it must reap
    /// WITHOUT decrementing `refcount` a second time.
    fn reapIfUnreferenced(self: Files, md5: []const u8) !bool {
        var rc: i64 = 0;
        {
            if (try self.db.row("SELECT refcount FROM blobs WHERE md5 = ?1;", &.{.{ .text = md5 }})) |r| {
                defer r.finalize();
                rc = r.int(0);
            }
        }
        if (rc > 0) return false; // a live file still references it

        // A retained version keeps the blob alive with no live file behind it.
        // This gate is checked ALWAYS (even with `history.keep == 0`), so that
        // disabling versioning can never strand an existing history row into a
        // dangling reference.
        {
            var s = try self.db.prepare("SELECT 1 FROM file_history WHERE md5 = ?1 LIMIT 1;");
            defer s.finalize();
            s.bindText(1, md5);
            if (try s.step()) return false;
        }

        // Truly unreferenced. The blob's index dies with it, in this same
        // transaction — otherwise we leak rows AND keep searchable text for
        // deleted content. (The schema's ON DELETE CASCADE is the backstop; this
        // is the intent.)
        //
        // The FTS pass goes FIRST and cannot be folded into the cascade: an
        // external-content FTS5 delete reads the text back out of
        // `note_page_index` to know which postings to subtract, so it only works
        // while those rows are still there. At this point every owner already
        // dropped their segment rows (the paths that release a last reference
        // do), so this is normally a no-op — the structural backstop for anything
        // a bug left behind, paired with the segment-row sweep inside
        // `deleteForBlob`.
        try notesearch.unindexBlob(self.db, md5);
        try noteindex.deleteForBlob(self.db, md5);
        try spdindex.deleteForBlob(self.db, md5); // intent; the FK cascade is the backstop
        var s = try self.db.prepare("DELETE FROM blobs WHERE md5 = ?1;");
        defer s.finalize();
        s.bindText(1, md5);
        _ = try s.step();
        return true;
    }

    /// Records a superseded version in the append-only `file_history` log (H3).
    /// Written in the SAME transaction as the `files` repoint + the decref, so a
    /// version can never be recorded without its blob being retained, or vice
    /// versa. The row is itself the blob keep-alive `reapIfUnreferenced` honors.
    fn recordHistory(self: Files, file_id: u64, md5: []const u8, size: u64, ts: i64) !void {
        var s = try self.db.prepare(
            "INSERT INTO file_history(file_id, md5, size, created_at) VALUES(?1,?2,?3,?4);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(file_id));
        s.bindText(2, md5);
        s.bindInt(3, @intCast(size));
        s.bindInt(4, ts);
        _ = try s.step();
    }

    /// The total on-disk footprint the retained history is responsible for: the
    /// summed size of the DISTINCT blobs a `file_history` row references and that
    /// NO live file also holds (`blobs.refcount = 0`). A blob a live file still
    /// references is paid for by that file's quota, not by history, so it is not
    /// counted against `max_bytes` (and evicting its history row would free no
    /// disk). Each distinct history-only blob is counted once.
    fn historyBytes(self: Files) !u64 {
        var r = (try self.db.row(
            "SELECT COALESCE(SUM(size), 0) FROM blobs " ++
                "WHERE refcount = 0 AND md5 IN (SELECT md5 FROM file_history);",
            &.{},
        )) orelse return 0;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// One dropped version: which blob it held and what it was charged. The size
    /// travels with it because the `blobs` row it came from may already be gone by
    /// the time quota is settled (the GC gate deletes it in this same transaction).
    const Evicted = struct { md5: [md5_len]u8, size: i64 };

    /// Enforces the two history bounds after a version was retained, collecting
    /// into `gc` the md5s whose bytes must be removed from disk post-commit, and
    /// into `evicted` every version dropped (so the caller can settle its quota):
    ///
    ///   (a) per-file `keep = K` — drop THIS file's versions beyond the newest K,
    ///       where K is now the OWNER's (`Files.versionPolicy`), not a global;
    ///   (b) global `max_bytes` — drop THIS USER's oldest history-only versions
    ///       until the install-wide retained footprint is under the ceiling.
    ///
    /// **(b) is now a per-user eviction against a global ceiling, and that is the
    /// §6 fix.** It used to pick the globally-oldest history row, so one person's
    /// churn evicted another person's versions — an invisible cross-account
    /// effect with no way for either to see it. Now that every user's retained
    /// bytes are charged to their own allotment, their quota is the primary
    /// control and `max_bytes` demotes to what it should always have been: a
    /// backstop on the whole install's disk, honoured by having the user doing the
    /// writing give ground first. If their history is exhausted and the ceiling is
    /// still exceeded, the loop stops rather than reaching into someone else's.
    ///
    /// Each dropped row's blob is reaped through `reapIfUnreferenced` (the same
    /// gate), so a blob still held by a live file or another history row survives.
    /// Backup-INDEPENDENT: bounded purely by K + `max_bytes`, computed locally.
    /// Runs inside the supersede transaction; call only when the owner's K > 0.
    fn evictHistory(
        self: Files,
        user_id: u64,
        file_id: u64,
        keep: u32,
        gc: *std.ArrayList([md5_len]u8),
        evicted: *std.ArrayList(Evicted),
    ) !void {
        // (a) per-file K: drop everything past the newest `keep` for this file.
        {
            const before = evicted.items.len;

            // COLLECT, THEN DELETE — the file's own discipline (see `deleteUser`'s
            // "collect their md5s first", and `restore`'s id list). This loop used
            // to step a `DELETE FROM file_history` while its own SELECT over
            // `file_history` was mid-cursor. It happened to be safe, because the
            // `ORDER BY … OFFSET` forces SQLite to materialise the result through a
            // sorter before emitting a row — but that is a property of the query
            // plan, which the next person to touch this ORDER BY is under no
            // obligation to preserve. Collecting first does not depend on it.
            var doomed_ids: std.ArrayList(i64) = .empty;
            defer doomed_ids.deinit(self.gpa);
            {
                var s = try self.db.prepare(
                    "SELECT rowid, md5, size FROM file_history WHERE file_id = ?1 " ++
                        "ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?2;",
                );
                defer s.finalize();
                s.bindInt(1, @intCast(file_id));
                s.bindInt(2, @intCast(keep));
                while (try s.step()) {
                    const m = s.columnText(1);
                    if (m.len != md5_len) continue;
                    var e: Evicted = .{ .md5 = undefined, .size = s.columnInt(2) };
                    @memcpy(&e.md5, m);
                    try evicted.append(self.gpa, e);
                    try doomed_ids.append(self.gpa, s.columnInt(0));
                }
            }
            {
                // Prepared once and rebound per row, the house pattern (sync.zig),
                // rather than re-prepared inside the loop as before.
                var d = try self.db.prepare("DELETE FROM file_history WHERE rowid = ?1;");
                defer d.finalize();
                for (doomed_ids.items) |rowid| {
                    d.reset();
                    d.bindInt(1, rowid);
                    _ = try d.step();
                }
            }
            // Reap AFTER every doomed row is deleted, so a blob two of the file's
            // versions shared (an A→B→A oscillation) is only reaped once the last
            // of its rows is gone.
            var doomed: std.ArrayList([md5_len]u8) = .empty;
            defer doomed.deinit(self.gpa);
            for (evicted.items[before..]) |*e| try doomed.append(self.gpa, e.md5);
            try self.reapDistinct(doomed.items, gc);
        }

        // (b) the `max_bytes` backstop: evict THIS user's oldest history-only
        // version, one at a time, recomputing the install-wide footprint each pass,
        // until under the ceiling or this user has nothing history-only left. Each
        // pass deletes exactly one row, so the loop is bounded by the row count.
        while (try self.historyBytes() > self.history.max_bytes) {
            const dropped = (try self.evictOldestVersion(user_id, gc)) orelse break;
            try evicted.append(self.gpa, dropped);
        }
    }

    /// Drops `user_id`'s single OLDEST retained version whose blob no live or
    /// trashed file of theirs also holds, reaping the blob through the shared GC
    /// gate. Returns what it dropped, or null when they have no such row.
    ///
    /// The `NOT EXISTS` is what makes the callers' loops terminate usefully: a
    /// version whose blob a file of theirs still references frees no disk and no
    /// quota, so evicting it would cost a version for nothing and the loop would
    /// have to spin past it. Excluding it up front means every candidate offered is
    /// one that either frees bytes now or is the second-to-last row pointing at
    /// bytes the next pass frees.
    fn evictOldestVersion(self: Files, user_id: u64, gc: *std.ArrayList([md5_len]u8)) !?Evicted {
        var out: Evicted = .{ .md5 = undefined, .size = 0 };
        // Same collect-then-delete discipline as (a) above: read the row out, let
        // the cursor go, THEN delete. The read is a single row, so the old shape
        // deleted with the cursor still positioned on the very row it was removing.
        const doomed_rowid = blk: {
            const r = (try self.db.row(
                "SELECT fh.rowid, fh.md5, fh.size FROM file_history fh " ++
                    "JOIN files f ON f.id = fh.file_id WHERE f.user_id = ?1 " ++
                    "  AND NOT EXISTS (SELECT 1 FROM files ff WHERE ff.user_id = ?1 " ++
                    "                    AND ff.is_folder = 0 AND ff.md5 = fh.md5) " ++
                    "ORDER BY fh.created_at ASC, fh.rowid ASC LIMIT 1;",
                &.{.{ .int = @intCast(user_id) }},
            )) orelse return null;
            defer r.finalize();
            const m = r.text(1);
            if (m.len != md5_len) return null;
            @memcpy(&out.md5, m);
            out.size = r.int(2);
            break :blk r.int(0);
        };
        {
            var d = try self.db.prepare("DELETE FROM file_history WHERE rowid = ?1;");
            defer d.finalize();
            d.bindInt(1, doomed_rowid);
            _ = try d.step();
        }
        if (try self.reapIfUnreferenced(&out.md5)) try gc.append(self.gpa, out.md5);
        return out;
    }

    // ---- history reads + restore (hot-cache versioning, phases 3-6) ----

    /// Every RETAINED version of `file_id`, newest first — the list the "history
    /// of this file" UI renders. Ownership is enforced by the `files` join on
    /// `user_id` (+ `deleted = 0`), so a foreign or trashed file's id yields an
    /// EMPTY list, indistinguishable from a file that simply has no history. The
    /// caller has typically already resolved the live entry (for the CURRENT
    /// version it prepends); the join is the belt-and-braces boundary regardless.
    /// Allocated in `alloc` (pass an arena and free it wholesale).
    pub fn fileHistory(self: Files, alloc: std.mem.Allocator, user_id: u64, file_id: u64) ![]HistoryVersion {
        return self.fileHistoryIn(.live, alloc, user_id, file_id);
    }

    /// `fileHistory` under an explicit `scope` — `.live` (`deleted = 0`) is the
    /// live history routes, `.trashed` (`deleted = 1`) the bin's view-only history
    /// twins. A trashed file's `file_history` is RETAINED (H10), so `.trashed` finds
    /// its versions; `.live` behaves EXACTLY as before (the wrapper above), so every
    /// live history route is unchanged. The only difference between the two is the
    /// `deleted` flag bound below.
    pub fn fileHistoryIn(self: Files, scope: HistoryScope, alloc: std.mem.Allocator, user_id: u64, file_id: u64) ![]HistoryVersion {
        var out: std.ArrayList(HistoryVersion) = .empty;
        var s = try self.db.prepare(
            "SELECT fh.md5, fh.size, fh.created_at FROM file_history fh " ++
                "JOIN files f ON f.id = fh.file_id " ++
                "WHERE fh.file_id = ?1 AND f.user_id = ?2 AND f.deleted = ?3 " ++
                "ORDER BY fh.created_at DESC, fh.rowid DESC;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(file_id));
        s.bindInt(2, @intCast(user_id));
        s.bindInt(3, scope.deletedFlag());
        while (try s.step()) {
            const m = s.columnText(0);
            if (m.len != md5_len) continue; // a malformed row is not a servable version
            var v: HistoryVersion = .{ .md5 = undefined, .size = @intCast(s.columnInt(1)), .created_at = s.columnInt(2) };
            @memcpy(&v.md5, m);
            try out.append(alloc, v);
        }
        return out.items;
    }

    /// The gate every per-version endpoint (preview/search/restore) shares: is
    /// `md5` a retained version of `file_id`, and is `file_id` a live file owned
    /// by `user_id`? Returns the version when so, null otherwise — so a stranger's
    /// md5, an md5 not in THIS file's history, and a foreign/trashed/missing id are
    /// all one indistinguishable 404. One indexed lookup; no allocation.
    pub fn historyVersion(self: Files, user_id: u64, file_id: u64, md5: []const u8) !?HistoryVersion {
        return self.historyVersionIn(.live, user_id, file_id, md5);
    }

    /// `historyVersion` under an explicit `scope`. `.live` (`deleted = 0`) is the
    /// per-version gate the live history routes share and behaves EXACTLY as before
    /// (the wrapper above); `.trashed` (`deleted = 1`) is the same gate for the bin's
    /// view-only history twins, reachable because a trashed file keeps its
    /// `file_history` (H10). A stranger's md5, an md5 not in THIS file's history, and
    /// an id outside `scope`'s deleted-state are all one indistinguishable null.
    pub fn historyVersionIn(self: Files, scope: HistoryScope, user_id: u64, file_id: u64, md5: []const u8) !?HistoryVersion {
        if (md5.len != md5_len) return null;
        var r = (try self.db.row(
            "SELECT fh.size, fh.created_at FROM file_history fh " ++
                "JOIN files f ON f.id = fh.file_id " ++
                "WHERE fh.file_id = ?1 AND f.user_id = ?2 AND f.deleted = ?4 AND fh.md5 = ?3 LIMIT 1;",
            &.{ .{ .int = @intCast(file_id) }, .{ .int = @intCast(user_id) }, .{ .text = md5 }, .{ .int = scope.deletedFlag() } },
        )) orelse return null;
        defer r.finalize();
        var v: HistoryVersion = .{ .md5 = undefined, .size = @intCast(r.int(0)), .created_at = r.int(1) };
        @memcpy(&v.md5, md5[0..md5_len]);
        return v;
    }

    /// Restore a retained version (H9): re-point the file at `md5`'s already-stored
    /// blob by going through the SAME supersede path an upload takes
    /// (`linkBlobIndexed`), NOT a raw `UPDATE files SET md5`. That re-derives the
    /// version as the CURRENT one — re-indexes it into the FTS, regenerates
    /// thumbnails — and retains the DISPLACED current as a new `file_history` row,
    /// which is what makes restore inherently undoable ("undo" is "restore the
    /// displaced version"). `md5` MUST already be validated by `historyVersion`
    /// (the caller's ownership + retained gate); a bad/foreign md5 is `NotFound`.
    ///
    /// Returns the file's new current `Entry` (name/md5 owned by `gpa`). Errors:
    /// `NotFound` (no such version/file), `QuotaExceeded` (restoring would exceed
    /// the owner's allotment — nothing is changed).
    pub fn restoreVersion(self: Files, user_id: u64, file_id: u64, md5: []const u8) !Entry {
        const v = (try self.historyVersion(user_id, file_id, md5)) orelse return error.NotFound;
        const entry = (try self.get(user_id, file_id)) orelse return error.NotFound;
        defer self.gpa.free(entry.name);
        defer if (entry.md5) |m| self.gpa.free(m);
        if (entry.is_folder) return error.NotFound;

        // The re-point + re-derive + retain-the-displaced-current, all in
        // `linkBlobIndexed`'s one transaction. Linking the SAME name under the SAME
        // parent supersedes this very file row (see `liveChild`), so `file_id` is
        // unchanged and the previously-current blob lands in `file_history`.
        const linked = try self.linkBlobIndexed(user_id, entry.parent_id, entry.name, &v.md5, v.size, null);

        // The restored version is now the CURRENT one, so it must not ALSO linger
        // as a "past version". Drop its history row(s) for this file — a safe
        // post-commit tidy: the blob stays alive (a live file references it now),
        // and without it a later supersede + restore would accumulate duplicate
        // rows. Other files' history (a shared blob) is untouched.
        self.dropFileHistoryVersion(file_id, &v.md5) catch {};
        return linked;
    }

    /// Deletes any `file_history` rows for `file_id` whose blob is `md5`. Used by
    /// restore to retire the row of a version that has just become current. Never
    /// decrefs or GCs — the blob is referenced by the live file now.
    fn dropFileHistoryVersion(self: Files, file_id: u64, md5: []const u8) !void {
        var s = try self.db.prepare("DELETE FROM file_history WHERE file_id = ?1 AND md5 = ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(file_id));
        s.bindText(2, md5);
        _ = try s.step();
    }

    /// Reaps each DISTINCT md5 in `list` through the GC gate, appending the ones
    /// whose bytes must be removed from disk post-commit to `gc`. Used wherever a
    /// batch of `file_history` rows was deleted (K-eviction, purge cascade).
    fn reapDistinct(self: Files, md5s: []const [md5_len]u8, gc: *std.ArrayList([md5_len]u8)) !void {
        var seen: std.ArrayList([md5_len]u8) = .empty;
        defer seen.deinit(self.gpa);
        outer: for (md5s) |*m| {
            for (seen.items) |*s| if (std.mem.eql(u8, s, m)) continue :outer;
            try seen.append(self.gpa, m.*);
            if (try self.reapIfUnreferenced(m)) try gc.append(self.gpa, m.*);
        }
    }

    const Child = struct { id: u64, is_folder: bool, md5: [md5_len]u8, size: u64 };

    /// The live entry named `name` in `parent_id` for this user, or null.
    fn liveChild(self: Files, user_id: u64, parent_id: ?u64, name: []const u8) !?Child {
        var r = (try self.db.row(
            "SELECT id, is_folder, md5, size FROM files " ++
                "WHERE user_id = ?1 AND COALESCE(parent_id, 0) = COALESCE(?2, 0) AND name = ?3 AND deleted = 0;",
            &.{
                .{ .int = @intCast(user_id) },
                .{ .int_opt = if (parent_id) |p| @intCast(p) else null },
                .{ .text = name },
            },
        )) orelse return null;
        defer r.finalize();
        var c: Child = .{ .id = @intCast(r.int(0)), .is_folder = r.int(1) != 0, .md5 = undefined, .size = @intCast(r.int(3)) };
        const m = r.text(2);
        if (m.len == md5_len) @memcpy(&c.md5, m) else @memset(&c.md5, 0);
        return c;
    }

    /// Cheap existence check (no allocation), scoped to the user, in ANY state.
    /// `trash` and `restore` both use it: an id the caller is allowed to act on
    /// may legitimately be tombstoned already.
    fn exists(self: Files, user_id: u64, id: u64) !bool {
        var s = try self.db.prepare("SELECT 1 FROM files WHERE id = ?1 AND user_id = ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(id));
        s.bindInt(2, @intCast(user_id));
        return try s.step();
    }

    /// The same, restricted to the bin. `purge` refuses anything else, so a live
    /// file can never be destroyed by one mistyped id.
    fn existsTrashed(self: Files, user_id: u64, id: u64) !bool {
        var s = try self.db.prepare("SELECT 1 FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 1;");
        defer s.finalize();
        s.bindInt(1, @intCast(id));
        s.bindInt(2, @intCast(user_id));
        return try s.step();
    }

    /// Verifies `parent_id` is null (root) or a live folder owned by the user.
    fn assertFolder(self: Files, user_id: u64, parent_id: ?u64) !void {
        const pid = parent_id orelse return;
        var r = (try self.db.row("SELECT is_folder FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0;", &.{ .{ .int = @intCast(pid) }, .{ .int = @intCast(user_id) } })) orelse return error.NotFound;
        defer r.finalize();
        if (r.int(0) == 0) return error.NotAFolder;
    }

    fn rowToEntry(self: Files, s: *sqlite.Stmt) !Entry {
        const pid = s.columnInt(1);
        const is_folder = s.columnInt(3) != 0;
        const m = s.columnText(4);
        return .{
            .id = @intCast(s.columnInt(0)),
            .parent_id = if (pid == 0) null else @intCast(pid),
            .name = try self.gpa.dupe(u8, s.columnText(2)),
            .is_folder = is_folder,
            .md5 = if (is_folder or m.len == 0) null else try self.gpa.dupe(u8, m),
            .size = @intCast(s.columnInt(5)),
            .updated_at = s.columnInt(6),
        };
    }

    pub fn freeEntries(gpa: std.mem.Allocator, entries: []Entry) void {
        for (entries) |e| {
            gpa.free(e.name);
            if (e.md5) |m| gpa.free(m);
        }
        gpa.free(entries);
    }

    // ---- on-demand derived-thumbnail repair (both formats) ----

    /// Which extractor a blob's OWN magic selects — the `/thumbnail/{hash}`
    /// URL carries only an md5, so the name-based ingest gates cannot apply
    /// here (plan decision 3 in docs/scratch/archive/notes-with-covers.md). Reads the
    /// blob's first `thumbnail.source_probe_len` bytes; a missing or empty
    /// blob is `.none` (nothing to derive).
    fn thumbSourceKind(self: Files, md5: []const u8) thumbnail.SourceKind {
        var head: [thumbnail.source_probe_len]u8 = undefined;
        const size = self.blobs.sizeOf(md5) catch return .none;
        const n: usize = @intCast(@min(size, head.len));
        const bytes = self.blobs.readRange(md5, 0, n, head[0..n]) catch return .none;
        return thumbnail.sourceKind(bytes);
    }

    /// The serve path's repair gate: does `/thumbnail/{hash}` need to
    /// re-derive before it can answer honestly? Dispatches on the blob's magic
    /// and asks THAT format's memo (`spd_index.needsRepair` /
    /// `note_index.needsRepair` — each a pure "row missing/stale, or a claimed
    /// file lost" check). A blob neither format claims is `false`: it can
    /// never yield a thumbnail, so it 404s WITHOUT any derive — no memo row is
    /// even needed. Runs under the caller's db-lock window; the file probes
    /// (`sizeOf` + a `source_probe_len` read + `thumbs.has`) are all O(1).
    pub fn thumbNeedsRepair(self: Files, md5: []const u8) bool {
        return switch (self.thumbSourceKind(md5)) {
            .spd => spdindex.needsRepair(self.db, self.thumbs, md5) catch false,
            .note => noteindex.needsRepair(self.db, self.thumbs, md5) catch false,
            .none => false,
        };
    }

    /// Which embedded-thumbnail extractor a stored blob's own magic selects —
    /// the `/thumbnail/{hash}` serve path uses it to choose between STREAMING a
    /// `.note` cover straight from the blob and serving a `.spd` thumbnail from
    /// the `thumbs/` derived store. The public face of `thumbSourceKind`.
    pub fn thumbnailSourceKind(self: Files, md5: []const u8) thumbnail.SourceKind {
        return self.thumbSourceKind(md5);
    }

    /// The recorded on-demand cover location for a `.note` blob, or null when it
    /// ships no cover. The serve path streams `length` bytes straight from the
    /// blob at `offset` (never resident; nothing is copied to `thumbs/`), under
    /// the recorded `mime`. Reads one current-`index_version` row.
    pub fn noteCover(self: Files, md5: []const u8) !?noteindex.CoverLocation {
        return noteindex.coverLocation(self.db, md5);
    }

    /// Re-derives a blob's index row + `thumbs/` file when the serve path
    /// found them missing or stale (`thumbNeedsRepair`) — the lazy heal that
    /// replaced the startup thumbnail backfill, now covering BOTH formats: a
    /// pre-v13 database (`.spd`), a v3 `note_index` row from before the cover
    /// columns, an `index_version` bump on either side, and a restore that
    /// skipped the (backup-skippable) `thumbs/` dir all heal here, per blob,
    /// on first request. The extractor is picked by the blob's own magic:
    /// SQLite → the `.spd` derive; a `.note` signature → the index parse whose
    /// footer carries the cover; neither → nothing to do.
    ///
    /// Best-effort to the last: any failure simply leaves the miss in place (the
    /// caller serves 404), never an error. A corrupt blob writes its
    /// `indexable = 0` row as the memo, so it is derived ONCE, not per request.
    ///
    /// `lk` is anything exposing `lockDb()`/`unlockDb()` — the handler's
    /// `*Context` in production (which is how the brief row write below stays
    /// attributed in the lock-hold histogram), a no-op stub in tests. **The
    /// caller MUST NOT hold the db lock**: the `.spd` derive buffers up to
    /// 16 MiB and opens attacker-supplied SQLite, and the `.note` derive is a
    /// full container parse — neither may run under the one global lock (the
    /// same parse-outside-lock rule as `note_index.ensureIndexed`), and the
    /// lock order is fixed as repair mutex → db lock (see `thumb_repair`).
    pub fn repairDerivedThumb(self: *Files, lk: anytype, md5: []const u8) void {
        self.thumb_repair.lockUncancelable(self.io);
        defer self.thumb_repair.unlock(self.io);

        const kind = self.thumbSourceKind(md5);
        if (kind == .none) return;

        // Double-check under the mutex: a waiter arrives here AFTER the holder
        // finished, finds the work done, and serves the file the holder wrote.
        {
            lk.lockDb();
            defer lk.unlockDb();
            const needed = switch (kind) {
                .spd => spdindex.needsRepair(self.db, self.thumbs, md5) catch return,
                .note => noteindex.needsRepair(self.db, self.thumbs, md5) catch return,
                .none => unreachable,
            };
            if (!needed) return;
        }

        // Derive with NO db lock held — the parse/deserialize must not
        // serialize the server (only the repair mutex is held, which bounds
        // concurrent derives to one). Then: disk before commit, as at ingest;
        // then a brief locked transaction for the row (the memo that makes a
        // corrupt blob a one-time cost).
        switch (kind) {
            .spd => {
                var derived = (spdindex.deriveStored(self.gpa, self.blobs, md5) catch return) orelse return;
                defer derived.deinit();
                if (derived.thumb) |t| self.thumbs.put(md5, t.bytes) catch {};

                lk.lockDb();
                defer lk.unlockDb();
                self.db.exec("BEGIN IMMEDIATE;") catch return;
                spdindex.store(self.db, md5, derived, self.now()) catch {
                    self.db.exec("ROLLBACK;") catch {};
                    return;
                };
                self.db.exec("COMMIT;") catch {
                    self.db.exec("ROLLBACK;") catch {};
                };
            },
            .note => {
                // A `.note` cover is streamed from the blob on serve, so the
                // repair writes NO thumbs file — it only refreshes the index row
                // whose `cover_offset/length/mime` the serve path reads.
                var parsed = (noteindex.parseStoredBlob(self.gpa, self.io, self.blobs, md5) catch return) orelse return;
                defer parsed.deinit();

                lk.lockDb();
                defer lk.unlockDb();
                self.db.exec("BEGIN IMMEDIATE;") catch return;
                noteindex.store(self.db, md5, parsed, self.now()) catch {
                    self.db.exec("ROLLBACK;") catch {};
                    return;
                };
                self.db.exec("COMMIT;") catch {
                    self.db.exec("ROLLBACK;") catch {};
                };
            },
            .none => unreachable,
        }
    }
};

/// Strips one trailing ` (n)` collision suffix, if `stem` ends in exactly that
/// shape — `BuJo (2)` → `BuJo`. Anything else is returned untouched, so a name
/// the user genuinely chose (`Budget (draft)`, `Notes (2024)`) survives: only an
/// all-digit group counts, and only one is removed.
fn stripSuffix(stem: []const u8) []const u8 {
    if (stem.len == 0 or stem[stem.len - 1] != ')') return stem;
    const open = std.mem.lastIndexOfScalar(u8, stem, '(') orelse return stem;
    if (open < 2 or stem[open - 1] != ' ') return stem; // needs " (" and a non-empty base
    const digits = stem[open + 1 .. stem.len - 1];
    if (digits.len == 0) return stem;
    for (digits) |ch| if (!std.ascii.isDigit(ch)) return stem;
    return stem[0 .. open - 1];
}

fn bindOpt(s: sqlite.Stmt, idx: c_int, v: ?u64) void {
    if (v) |x| s.bindInt(idx, @intCast(x)) else s.bindNull(idx);
}

fn freeList(gpa: std.mem.Allocator, list: *std.ArrayList(Entry)) void {
    for (list.items) |e| {
        gpa.free(e.name);
        if (e.md5) |m| gpa.free(m);
    }
    list.deinit(gpa);
}

// ---- tests ----

const schema = @import("../db/schema.zig");
const testing = std.testing;

const Fixture = struct {
    db: sqlite.Db,
    files: Files,
    tmp: testing.TmpDir,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        // A user with a 1 KiB quota.
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1024);");
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 1024);");

        const tmp = testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{ .db = db, .files = Files.init(testing.allocator, testing.io, db, store, thumbs), .tmp = tmp };
    }

    fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    fn used(f: *Fixture, user_id: u64) !i64 {
        return (try f.files.capacity(user_id)).used;
    }

    /// What `capacity.used_bytes` SHOULD be, rebuilt from the `files`/`blobs`
    /// tables rather than from the running total.
    ///
    /// The store is content-addressed and refcounted, so the quantity a user
    /// actually occupies is the sum over the DISTINCT blobs their rows
    /// reference — two files holding identical content are one blob on disk and
    /// must be charged once. Rows in the bin count: the bin holds a real
    /// reference and keeps real bytes alive. Folders reference no blob and
    /// weigh nothing.
    ///
    /// **And retained versions count** (user-options.md §6). A `file_history` row
    /// keeps its blob alive through the GC gate exactly as a trashed file does, so
    /// the same rule applies: if the bytes occupy disk, the user is charged. This
    /// is the audit's whole claim, and adding history to it is what made the
    /// accounting change land — the running counter now has to agree with a
    /// reconstruction that includes them.
    fn trueUsed(f: *Fixture, user_id: u64) !i64 {
        var r = (try f.db.row(
            \\SELECT COALESCE(SUM(b.size), 0) FROM blobs b WHERE b.md5 IN (
            \\  SELECT md5 FROM files
            \\   WHERE user_id = ?1 AND is_folder = 0 AND md5 IS NOT NULL AND md5 <> ''
            \\  UNION
            \\  SELECT fh.md5 FROM file_history fh JOIN files f ON f.id = fh.file_id
            \\   WHERE f.user_id = ?1
            \\);
        , &.{.{ .int = @intCast(user_id) }})) orelse return 0;
        defer r.finalize();
        return r.int(0);
    }

    /// THE PARTITION ASSERTION. The five category figures sum EXACTLY to
    /// `used_bytes` — so a blob that charges without landing in a bucket makes the
    /// sum short, and one that lands in two makes it long. Neither number is typed
    /// out anywhere: the reconstruction is rebuilt from `files`, `file_history`
    /// and `blobs` on the spot, and the running counter is asserted against it
    /// too, so the identity is pinned at BOTH ends. Call it after any mutation.
    fn expectPartition(f: *Fixture, user_id: u64) !void {
        const b = try f.files.storageBreakdown(user_id);
        try testing.expectEqual(try f.trueUsed(user_id), b.total());
        try testing.expectEqual(try f.used(user_id), b.total());
    }

    /// Asserts the invariant the whole quota system rests on: the running total
    /// equals the reconstructed one. Call it after any mutation.
    fn expectQuotaBalanced(f: *Fixture, user_id: u64) !void {
        try testing.expectEqual(try f.trueUsed(user_id), try f.used(user_id));
    }
};

fn putBytes(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, data: []const u8) !Entry {
    var r = std.Io.Reader.fixed(data);
    return f.files.putFile(user_id, parent, name, &r, null);
}

test "create folders and files, then list them" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer testing.allocator.free(notes.name);
    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);
    const b = try putBytes(&f, 1, notes.id, "b.note", "bbbbbb");
    defer freeEntry(b);

    const entries = try f.files.list(1, notes.id);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 2), entries.len);
    try testing.expectEqualStrings("a.note", entries[0].name);
    try testing.expectEqual(@as(u64, 4), entries[0].size);
    try testing.expectEqual(@as(i64, 10), try f.used(1)); // 4 + 6
}

test "childCount counts direct live children of every kind, and never a trashed one" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer testing.allocator.free(notes.name);
    const sub = try f.files.createFolder(1, notes.id, "Projects");
    defer testing.allocator.free(sub.name);

    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);
    // NOT a .note — the count is "items", so a PDF has to be in it.
    const b = try putBytes(&f, 1, notes.id, "lease.pdf", "bbbb");
    defer freeEntry(b);
    // A GRANDCHILD: direct-children-only means this must not be counted.
    const deep = try putBytes(&f, 1, sub.id, "deep.note", "cccc");
    defer freeEntry(deep);

    // Projects + a.note + lease.pdf = 3 items, subfolder folded in.
    try testing.expectEqual(@as(i64, 3), try f.files.childCount(1, notes.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, sub.id));

    // THE POINT OF THE TEST: trashing a child drops it from the count, exactly as
    // it drops out of `list` — the bin stays invisible to listings.
    try f.files.trash(1, b.id);
    const entries = try f.files.list(1, notes.id);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 2), entries.len); // Projects + a.note
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, notes.id));

    // Trashing the subfolder takes its own row out too — folders are items.
    try f.files.trash(1, sub.id);
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, notes.id));

    // An empty folder is 0, not an error — the caller renders that as "Empty".
    const empty = try f.files.createFolder(1, null, "Empty");
    defer testing.allocator.free(empty.name);
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, empty.id));

    // Scoped to the user: another user's tree cannot be counted through this id.
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(2, notes.id));
}

test "replacing a file swaps its blob and adjusts capacity; the old blob is GC'd" {
    var f = try Fixture.init();
    defer f.deinit();
    f.files.history.keep = 0; // the keep = 0 path: prune-on-supersede, no history

    const v1 = try putBytes(&f, 1, null, "note", "hello");
    const md5_v1 = dupeMd5(v1.md5.?);
    freeEntry(v1);
    try testing.expect(f.files.blobs.has(&md5_v1));
    try testing.expectEqual(@as(i64, 5), try f.used(1));

    const v2 = try putBytes(&f, 1, null, "note", "a much longer body");
    defer freeEntry(v2);
    try testing.expectEqual(@as(i64, 18), try f.used(1)); // replaced 5 with 18
    try testing.expect(!f.files.blobs.has(&md5_v1)); // old blob gone
    try testing.expect(f.files.blobs.has(v2.md5.?)); // new blob present
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM file_history;")); // keep=0: nothing retained

    // Still a single entry named "note".
    const entries = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 1), entries.len);
}

test "HISTORY: supersede RETAINS the old version — history row, blob on disk, render index kept" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    // default history.keep = 5

    const b1 = try buildNote(testing.allocator, cover_png);
    defer testing.allocator.free(b1);
    const v1 = try putBytes(&f, 1, null, "bujo.note", b1);
    const old_md5 = dupeMd5(v1.md5.?);
    const old_size = v1.size;
    freeEntry(v1);
    try testing.expect((try noteIndexedAt(&f, &old_md5)) != null); // render index minted
    try testing.expectEqual(@as(i64, 1), try blobRefcount(&f, &old_md5)); // one live ref

    const b2 = try buildNote(testing.allocator, null); // coverless -> different content -> new blob
    defer testing.allocator.free(b2);
    const v2 = try putBytes(&f, 1, null, "bujo.note", b2);
    defer freeEntry(v2);
    const new_md5 = dupeMd5(v2.md5.?);
    try testing.expect(!std.mem.eql(u8, &old_md5, &new_md5));

    // The old version is RETAINED, not pruned.
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expect(f.files.blobs.has(&old_md5)); // the OLD blob is still on disk (not GC'd)
    try testing.expect((try noteIndexedAt(&f, &old_md5)) != null); // its render index rode along for free
    // refcount dropped to LIVE-only 0 (the retained version left the user's live
    // quota); the history row is the separate keep-alive.
    try testing.expectEqual(@as(i64, 0), try blobRefcount(&f, &old_md5));
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &old_md5));

    // The history row carries the superseded version's md5 and size.
    {
        var s = try f.db.prepare("SELECT md5, size, file_id FROM file_history;");
        defer s.finalize();
        try testing.expect(try s.step());
        try testing.expectEqualStrings(&old_md5, s.columnText(0));
        try testing.expectEqual(@as(i64, @intCast(old_size)), s.columnInt(1));
        try testing.expectEqual(@as(i64, @intCast(v2.id)), s.columnInt(2)); // same file row
    }
    try testing.expect(f.files.blobs.has(&new_md5)); // the current version present too
}

test "HISTORY: keep = K retains only the newest K superseded versions; evicted blobs GC'd" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 2;

    var mds: [5][md5_len]u8 = undefined;
    for (0..5) |i| {
        const body = try std.fmt.allocPrint(testing.allocator, "version-{d}-unique-body", .{i});
        defer testing.allocator.free(body);
        const e = try putBytes(&f, 1, null, "doc.txt", body);
        mds[i] = dupeMd5(e.md5.?);
        freeEntry(e);
    }

    // Five uploads: v5 (mds[4]) is current; history keeps the newest K = 2 of the
    // SUPERSEDED versions — v3 and v4 (mds[2], mds[3]).
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expect(!f.files.blobs.has(&mds[0])); // v1 evicted -> blob GC'd
    try testing.expect(!f.files.blobs.has(&mds[1])); // v2 evicted -> blob GC'd
    try testing.expect(f.files.blobs.has(&mds[2])); // v3 retained
    try testing.expect(f.files.blobs.has(&mds[3])); // v4 retained
    try testing.expect(f.files.blobs.has(&mds[4])); // v5 is the live current
    // Evicted versions leave nothing behind — their render index dropped with the blob.
    try testing.expect((try noteIndexedAt(&f, &mds[0])) == null);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM blobs WHERE refcount < 0;")); // never over-decremented
}

test "HISTORY: eviction never DELETEs with a cursor open on file_history" {
    // THE DISCIPLINE, NOT THE OUTCOME. Both eviction arms used to step a
    // `DELETE FROM file_history` while their own SELECT over `file_history` was
    // mid-cursor. It was de-facto safe — the `ORDER BY … OFFSET` forces SQLite to
    // materialise the result through a sorter first — so every row-count and
    // blob-presence assertion in the tests around this one passes identically
    // against the old shape. There is nothing to assert but the discipline itself,
    // which is what `sqlite.CursorWatch` exists to see (see its own test).
    //
    // BOTH arms are driven, in separate phases, because they are bounded by
    // different things and one configuration cannot reach both: (a) needs K to
    // bite while `max_bytes` does not, (b) needs the reverse.
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    // (a) per-file K. K = 2 over six versions, ceiling out of the way.
    {
        f.files.history.keep = 2;
        f.files.history.max_bytes = 1_000_000;
        var w: sqlite.CursorWatch = .{ .db = f.db, .table = "file_history" };
        w.arm();
        defer w.disarm();
        for (0..6) |i| {
            const body = try std.fmt.allocPrint(testing.allocator, "bodybytes{d}", .{i}); // exactly 10 bytes
            defer testing.allocator.free(body);
            freeEntry(try putBytes(&f, 1, null, "doc.txt", body));
        }
        // K really evicted (six versions in, two retained), and not one row
        // mutation happened with a reader still on the table.
        try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
        try testing.expect(w.mutations > 0);
        try testing.expectEqual(@as(usize, 0), w.overlaps);
    }

    // (b) the `max_bytes` backstop, through `evictOldestVersion`. K out of the way,
    // a 20-byte ceiling: two 10-byte history blobs fit and no more.
    {
        f.files.history.keep = 100;
        f.files.history.max_bytes = 20;
        var w: sqlite.CursorWatch = .{ .db = f.db, .table = "file_history" };
        w.arm();
        defer w.disarm();
        for (0..6) |i| {
            const body = try std.fmt.allocPrint(testing.allocator, "otherbyt{d}x", .{i}); // exactly 10 bytes
            defer testing.allocator.free(body);
            freeEntry(try putBytes(&f, 1, null, "doc2.txt", body));
        }
        // The ceiling really bit (K = 100 would have kept five for doc2.txt alone),
        // and again nothing mutated under an open cursor.
        try testing.expect(try f.files.historyBytes() <= 20);
        try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
        try testing.expect(w.mutations > 0);
        try testing.expectEqual(@as(usize, 0), w.overlaps);
    }
}

test "HISTORY: the max_bytes ceiling evicts oldest history-only versions until under" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 100; // K is not the bound here — max_bytes is
    f.files.history.max_bytes = 20; // room for at most two 10-byte history blobs

    var mds: [6][md5_len]u8 = undefined;
    for (0..6) |i| {
        const body = try std.fmt.allocPrint(testing.allocator, "bodybytes{d}", .{i}); // exactly 10 bytes
        defer testing.allocator.free(body);
        try testing.expectEqual(@as(usize, 10), body.len);
        const e = try putBytes(&f, 1, null, "doc.txt", body);
        mds[i] = dupeMd5(e.md5.?);
        freeEntry(e);
    }

    // v5 (mds[5]) current; the retained history footprint is held at <= 20 bytes,
    // so only the two newest superseded versions (v3, v4) survive; v0..v2 evicted.
    try testing.expect(try f.files.historyBytes() <= 20);
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expect(!f.files.blobs.has(&mds[0]));
    try testing.expect(!f.files.blobs.has(&mds[1]));
    try testing.expect(!f.files.blobs.has(&mds[2]));
    try testing.expect(f.files.blobs.has(&mds[3]));
    try testing.expect(f.files.blobs.has(&mds[4]));
    try testing.expect(f.files.blobs.has(&mds[5]));
}

test "§6: a user AT their allotment can still EDIT — history gives way, the edit does not" {
    // **The failure §6 must not create.** Once retained versions are charged, a
    // person near their allotment could be refused when editing an existing note:
    // they added nothing, but the version the edit displaced pushed them over. That
    // error would arrive from the DEVICE, mid-sync, where it is least explicable.
    //
    // The answer falls out of what history IS — discardable, where live files are
    // not. So the edit goes through and the OLDEST version gives way. A full quota
    // costs you history depth before it costs you the ability to work.
    var f = try Fixture.init();
    defer f.deinit();
    f.files.history.keep = 5;
    try f.db.exec("UPDATE capacity SET total_bytes = 30 WHERE user_id = 1;"); // exactly three 10-byte blobs

    freeEntry(try putBytes(&f, 1, null, "n.note", "aaaaaaaaaa"));
    freeEntry(try putBytes(&f, 1, null, "n.note", "bbbbbbbbbb"));
    freeEntry(try putBytes(&f, 1, null, "n.note", "cccccccccc"));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1)); // current + two retained: FULL
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    // THE CASE: the fourth edit needs 40 bytes if everything is retained. It must
    // NOT be refused — the oldest version is evicted to make room and the edit
    // lands.
    freeEntry(try putBytes(&f, 1, null, "n.note", "dddddddddd"));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1));
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    // The current version is the one just written, and the OLDEST retained one went.
    {
        const e = (try f.files.get(1, (try f.files.resolvePath(1, "/n.note")).?)).?;
        defer freeEntry(e);
        try testing.expectEqualStrings(&blobstore.md5HexOf("dddddddddd"), e.md5.?);
    }
    try testing.expectEqual(@as(i64, 0), try historyRows(&f, &blobstore.md5HexOf("aaaaaaaaaa")));
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &blobstore.md5HexOf("cccccccccc")));

    // ...but the LIVE files are not discardable, so something that does not fit
    // even with the whole history thrown away is still refused. And the refusal
    // rolls back completely: the versions the attempt evicted on its way to
    // failing are all still there.
    {
        var r = std.Io.Reader.fixed("x" ** 40);
        try testing.expectError(error.QuotaExceeded, f.files.putFile(1, null, "big.note", &r, null));
    }
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1));
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    // Editing all the way down: with K worth of versions gone, the note itself
    // still edits, because a live file only ever displaces its own predecessor.
    freeEntry(try putBytes(&f, 1, null, "n.note", "eeeeeeeeee"));
    freeEntry(try putBytes(&f, 1, null, "n.note", "ffffffffff"));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1));
}

test "§6: eviction is PER-USER — one person's churn can no longer evict another's versions" {
    // Before §6 the `max_bytes` loop picked the globally-oldest history row, so a
    // housemate syncing hard silently ate someone else's version history — an
    // effect neither of them could see. Now every user's retained bytes are
    // charged to their own allotment, `max_bytes` is only a backstop on the whole
    // install's disk, and the user doing the writing is the one who gives ground.
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000;");
    f.files.history.keep = 100; // K is not the bound here
    f.files.history.max_bytes = 20; // a global ceiling this test blows through

    // User 2 banks a version FIRST, so it is the globally oldest — precisely what
    // the old loop would have reached for.
    freeEntry(try putBytes(&f, 2, null, "u2.note", "user-two-original"));
    freeEntry(try putBytes(&f, 2, null, "u2.note", "user-two-edited!!"));
    const u2_rows = "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = 2;";
    try testing.expectEqual(@as(i64, 1), try countOf(&f, u2_rows));

    // User 1 churns hard against the same global ceiling.
    for (0..6) |i| {
        const body = try std.fmt.allocPrint(testing.allocator, "user-one-version-{d}", .{i});
        defer testing.allocator.free(body);
        freeEntry(try putBytes(&f, 1, null, "u1.note", body));
    }

    // User 2's version is untouched, and both accounts still balance.
    try testing.expectEqual(@as(i64, 1), try countOf(&f, u2_rows));
    try f.expectQuotaBalanced(1);
    try f.expectQuotaBalanced(2);
    try f.expectPartition(1);
    try f.expectPartition(2);
}

test "HISTORY: a dedup'd blob is never GC'd while a live file OR a history row still holds it" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 5;

    // Two live files share ONE content-addressed blob X.
    const a1 = try putBytes(&f, 1, null, "a.txt", "shared-content");
    const x = dupeMd5(a1.md5.?);
    freeEntry(a1);
    const b1 = try putBytes(&f, 1, null, "b.txt", "shared-content");
    defer freeEntry(b1);
    try testing.expect(std.mem.eql(u8, &x, b1.md5.?)); // deduped onto the same blob
    try testing.expectEqual(@as(i64, 2), try blobRefcount(&f, &x)); // two live refs

    // Supersede a.txt: X keeps one live ref (b) AND becomes a history entry of a.
    const a2 = try putBytes(&f, 1, null, "a.txt", "a-new-content");
    defer freeEntry(a2);
    try testing.expectEqual(@as(i64, 1), try blobRefcount(&f, &x)); // b still live
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &x));
    try testing.expect(f.files.blobs.has(&x));

    // Supersede b.txt: X now has ZERO live refs — but TWO history rows hold it.
    const b2 = try putBytes(&f, 1, null, "b.txt", "b-new-content");
    defer freeEntry(b2);
    try testing.expectEqual(@as(i64, 0), try blobRefcount(&f, &x));
    try testing.expectEqual(@as(i64, 2), try historyRows(&f, &x));
    try testing.expect(f.files.blobs.has(&x)); // retained purely by history

    // Purge a: its history row for X cascades away, but b's history row still
    // holds X — so X survives (exercises the purge-cascade reap path, H10).
    try f.files.trash(1, a2.id);
    try f.files.purge(1, a2.id);
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &x));
    try testing.expect(f.files.blobs.has(&x));

    // Purge b: the LAST history reference to X is gone -> X finally GC's.
    try f.files.trash(1, b2.id);
    try f.files.purge(1, b2.id);
    try testing.expectEqual(@as(i64, 0), try historyRows(&f, &x));
    try testing.expect(!f.files.blobs.has(&x));
}

test "identical content dedups: shared blob survives until the last reference is deleted" {
    var f = try Fixture.init();
    defer f.deinit();

    const a = try putBytes(&f, 1, null, "a", "same bytes");
    const b = try putBytes(&f, 1, null, "b", "same bytes");
    const md5 = dupeMd5(a.md5.?);
    freeEntry(a);
    freeEntry(b);
    try testing.expect(f.files.blobs.has(&md5)); // one physical blob, two refs

    try f.files.trash(1, 1);
    try f.files.purge(1, 1); // destroy "a" for real
    try testing.expect(f.files.blobs.has(&md5)); // still referenced by "b"

    try f.files.trash(1, 2);
    try f.files.purge(1, 2); // destroy "b"
    try testing.expect(!f.files.blobs.has(&md5)); // now GC'd
    try testing.expectEqual(@as(i64, 0), try f.used(1));
}

test "purging a folder recurses, frees capacity, and GCs its blobs" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(sub.name);
    const a = try putBytes(&f, 1, dir.id, "a", "1234");
    const md5a = dupeMd5(a.md5.?);
    freeEntry(a);
    const b = try putBytes(&f, 1, sub.id, "b", "567");
    const md5b = dupeMd5(b.md5.?);
    freeEntry(b);
    try testing.expectEqual(@as(i64, 7), try f.used(1));

    try f.files.trash(1, dir.id); // the whole tree into the bin…
    try testing.expectEqual(@as(i64, 7), try f.used(1)); // …still charged, still on disk
    try testing.expect(f.files.blobs.has(&md5a));
    try f.files.purge(1, dir.id); // …and now destroyed

    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try testing.expect(!f.files.blobs.has(&md5a));
    try testing.expect(!f.files.blobs.has(&md5b));
    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 0), root.len); // subtree gone
}

test "createFolderPath: creates ancestors, and autorename governs only the leaf" {
    var f = try Fixture.init();
    defer f.deinit();

    // Nested creation from nothing.
    const a = try f.files.createFolderPath(1, "/NOTE/Note/Trip", false);
    defer testing.allocator.free(a.name);
    try testing.expectEqualStrings("Trip", a.name);
    try testing.expect(a.is_folder);
    const p = try f.files.pathOf(testing.allocator, 1, a.id);
    defer testing.allocator.free(p);
    try testing.expectEqualStrings("/NOTE/Note/Trip", p);

    // autorename = false is IDEMPOTENT on an existing folder: the device retries,
    // and a second create must converge on the same row rather than fail or fork.
    const again = try f.files.createFolderPath(1, "/NOTE/Note/Trip", false);
    defer testing.allocator.free(again.name);
    try testing.expectEqual(a.id, again.id);

    // autorename = true wants A folder, not THAT name.
    const renamed = try f.files.createFolderPath(1, "/NOTE/Note/Trip", true);
    defer testing.allocator.free(renamed.name);
    try testing.expectEqualStrings("Trip (2)", renamed.name);
    try testing.expect(renamed.id != a.id);

    // Ancestors are idempotent regardless of the flag — only the leaf renames.
    const sibling = try f.files.createFolderPath(1, "/NOTE/Note/Other", true);
    defer testing.allocator.free(sibling.name);
    try testing.expectEqualStrings("Other", sibling.name);
    const note_id = (try f.files.resolvePath(1, "/NOTE/Note")).?;
    try testing.expectEqual(note_id, sibling.parent_id.?);

    // A single segment lands at the root; an empty path names nothing.
    const root_level = try f.files.createFolderPath(1, "Inbox", false);
    defer testing.allocator.free(root_level.name);
    try testing.expect(root_level.parent_id == null);
    try testing.expectError(error.NotFound, f.files.createFolderPath(1, "/", false));
}

test "createFolderPath: a FILE in the way is a conflict, or a rename if asked" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "D");
    defer testing.allocator.free(dir.name);
    const note = try putBytes(&f, 1, dir.id, "x", "bytes");
    freeEntry(note);

    // Leaf blocked by a file: there is no folder to hand back, and quietly
    // renaming is not what `autorename: false` asked for.
    try testing.expectError(error.NameConflict, f.files.createFolderPath(1, "/D/x", false));

    // …but with autorename the occupant's kind stops mattering.
    const renamed = try f.files.createFolderPath(1, "/D/x", true);
    defer testing.allocator.free(renamed.name);
    try testing.expectEqualStrings("x (2)", renamed.name);
    try testing.expect(renamed.is_folder);

    // A file part-way ALONG the path is always a conflict — it cannot be
    // descended into, and renaming an ancestor would silently create the folder
    // somewhere other than where the caller asked for it.
    try testing.expectError(error.NameConflict, f.files.createFolderPath(1, "/D/x/deeper", false));
    try testing.expectError(error.NameConflict, f.files.createFolderPath(1, "/D/x/deeper", true));
}

test "createFolderPath is scoped per user: same path, two independent trees" {
    var f = try Fixture.init();
    defer f.deinit();

    const one = try f.files.createFolderPath(1, "/NOTE/Shared", false);
    defer testing.allocator.free(one.name);
    const two = try f.files.createFolderPath(2, "/NOTE/Shared", false);
    defer testing.allocator.free(two.name);

    // Same path, different rows — user 2 must not land in user 1's tree, and
    // must not be told the name is taken either.
    try testing.expect(one.id != two.id);
    try testing.expectEqualStrings("Shared", two.name);
    try testing.expect((try f.files.get(1, two.id)) == null); // foreign id: invisible
}

test "quota is enforced and leaves no state or orphan blob behind" {
    var f = try Fixture.init();
    defer f.deinit();

    var big: [1025]u8 = undefined; // 1 byte over the 1024 quota
    @memset(&big, 'x');
    var r = std.Io.Reader.fixed(&big);
    try testing.expectError(error.QuotaExceeded, f.files.putFile(1, null, "big", &r, null));

    try testing.expectEqual(@as(i64, 0), try f.used(1)); // no capacity charged
    const entries = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 0), entries.len); // no file row
    // and the freshly-written blob was rolled back off disk
    try testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(&big)));
}

test "name conflicts and bad parents are rejected; users are isolated" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try testing.expectError(error.NameConflict, f.files.createFolder(1, null, "Dir"));

    const file = try putBytes(&f, 1, null, "thing", "x");
    defer freeEntry(file);
    // A folder can't overwrite a file of the same name, nor vice versa.
    try testing.expectError(error.NameConflict, f.files.createFolder(1, null, "thing"));
    var r = std.Io.Reader.fixed("y");
    try testing.expectError(error.NameConflict, f.files.putFile(1, null, "Dir", &r, null));

    // Bad parent: not a folder / not owned.
    var r2 = std.Io.Reader.fixed("z");
    try testing.expectError(error.NotAFolder, f.files.putFile(1, file.id, "child", &r2, null));
    try testing.expectError(error.NotFound, f.files.createFolder(1, 9999, "x"));

    // User 2 cannot see or reach user 1's tree.
    const u2list = try f.files.list(2, null);
    defer Files.freeEntries(testing.allocator, u2list);
    try testing.expectEqual(@as(usize, 0), u2list.len);
    try testing.expectError(error.NotFound, f.files.createFolder(2, dir.id, "x")); // dir belongs to user 1
    try testing.expect((try f.files.get(2, file.id)) == null);
}

test "pathOf derives full paths; ensureFolderPath is idempotent and nests" {
    var f = try Fixture.init();
    defer f.deinit();

    // Idempotent nested creation; shared prefix ("NOTE") is created once.
    const note_id = try f.files.ensureFolderPath(1, "NOTE/Note");
    _ = try f.files.ensureFolderPath(1, "NOTE/MyStyle");
    const note_id2 = try f.files.ensureFolderPath(1, "NOTE/Note"); // no duplicate
    try testing.expectEqual(note_id, note_id2);

    // "NOTE" has exactly two children (Note, MyStyle); root has exactly one (NOTE).
    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 1), root.len);
    try testing.expectEqualStrings("NOTE", root[0].name);
    const under_note = try f.files.list(1, root[0].id);
    defer Files.freeEntries(testing.allocator, under_note);
    try testing.expectEqual(@as(usize, 2), under_note.len);

    // A file inside a nested folder derives the expected path.
    const file = try putBytes(&f, 1, note_id, "foo.note", "data");
    defer freeEntry(file);
    const p = try f.files.pathOf(testing.allocator, 1, file.id);
    defer testing.allocator.free(p);
    try testing.expectEqualStrings("/NOTE/Note/foo.note", p);

    // A root-level file derives "/name".
    const rootfile = try putBytes(&f, 1, null, "top.note", "x");
    defer freeEntry(rootfile);
    const rp = try f.files.pathOf(testing.allocator, 1, rootfile.id);
    defer testing.allocator.free(rp);
    try testing.expectEqualStrings("/top.note", rp);

    // A segment that collides with a file is rejected.
    try testing.expectError(error.NameConflict, f.files.ensureFolderPath(1, "top.note/sub"));
}

test "walkTree materializes the tree with Dropbox path_display + parent_path in one pass" {
    var f = try Fixture.init();
    defer f.deinit();

    const note = try f.files.ensureFolderPath(1, "NOTE/Note"); // /NOTE, /NOTE/Note
    const a = try putBytes(&f, 1, note, "a.note", "aaaa");
    const a_id = a.id;
    freeEntry(a);
    const top = try putBytes(&f, 1, null, "top.note", "x"); // root-level file
    const top_id = top.id;
    freeEntry(top);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const nodes = try f.files.walkTree(arena.allocator(), 1);

    // ORDER BY path is deterministic: /NOTE, /NOTE/Note, /NOTE/Note/a.note, /top.note
    try testing.expectEqual(@as(usize, 4), nodes.len);

    // A root folder: path "/NOTE", parent "/", md5 "" (folders carry no hash), size 0.
    try testing.expectEqualStrings("NOTE", nodes[0].name);
    try testing.expect(nodes[0].is_folder);
    try testing.expectEqualStrings("/NOTE", nodes[0].path_display);
    try testing.expectEqualStrings("/", nodes[0].parent_path);
    try testing.expectEqualStrings("", nodes[0].md5);
    try testing.expectEqual(@as(u64, 0), nodes[0].size);

    // A nested file: full path + its folder as parent_path, real md5 + size.
    const file = nodes[2];
    try testing.expectEqual(a_id, file.id);
    try testing.expectEqualStrings("a.note", file.name);
    try testing.expect(!file.is_folder);
    try testing.expectEqualStrings("/NOTE/Note/a.note", file.path_display);
    try testing.expectEqualStrings("/NOTE/Note", file.parent_path);
    try testing.expectEqualStrings(&blobstore.md5HexOf("aaaa"), file.md5);
    try testing.expectEqual(@as(u64, 4), file.size);

    // A root-level file: parent_path is "/".
    try testing.expectEqualStrings("/top.note", nodes[3].path_display);
    try testing.expectEqualStrings("/", nodes[3].parent_path);

    // nodeById reproduces the same computed paths for a single id.
    const byid = (try f.files.nodeById(arena.allocator(), 1, a_id)).?;
    try testing.expectEqualStrings("/NOTE/Note/a.note", byid.path_display);
    try testing.expectEqualStrings("/NOTE/Note", byid.parent_path);
    try testing.expect((try f.files.nodeById(arena.allocator(), 1, 99999)) == null);
    try testing.expect((try f.files.nodeById(arena.allocator(), 2, a_id)) == null); // foreign user

    // resolvePath descends segments; root/unknown → null.
    try testing.expectEqual(a_id, (try f.files.resolvePath(1, "/NOTE/Note/a.note")).?);
    try testing.expectEqual(note, (try f.files.resolvePath(1, "/NOTE/Note")).?);
    try testing.expectEqual(top_id, (try f.files.resolvePath(1, "/top.note")).?);
    try testing.expect((try f.files.resolvePath(1, "/")) == null);
    try testing.expect((try f.files.resolvePath(1, "/NOTE/nope")) == null);
    try testing.expect((try f.files.resolvePath(2, "/NOTE/Note/a.note")) == null); // user isolation
}

test "syncVersion starts at 0 and bumps on every tree mutation" {
    var f = try Fixture.init();
    defer f.deinit();

    try testing.expectEqual(@as(i64, 0), try f.files.syncVersion(1));

    const dir = try f.files.createFolder(1, null, "Dir"); // bump 1
    defer testing.allocator.free(dir.name);
    try testing.expectEqual(@as(i64, 1), try f.files.syncVersion(1));

    const a = try putBytes(&f, 1, dir.id, "a.note", "aaaa"); // bump 2
    freeEntry(a);
    try testing.expectEqual(@as(i64, 2), try f.files.syncVersion(1));

    const a2 = try putBytes(&f, 1, dir.id, "a.note", "bbbb"); // replace → bump 3
    freeEntry(a2);
    try testing.expectEqual(@as(i64, 3), try f.files.syncVersion(1));

    try f.files.trash(1, dir.id); // bump 4
    try testing.expectEqual(@as(i64, 4), try f.files.syncVersion(1));

    try f.files.trash(1, dir.id); // idempotent retry: nothing changed, no bump
    try testing.expectEqual(@as(i64, 4), try f.files.syncVersion(1));

    const restored = try f.files.restore(1, dir.id); // bump 5
    restored.deinit(testing.allocator);
    try testing.expectEqual(@as(i64, 5), try f.files.syncVersion(1));

    try f.files.trash(1, dir.id); // bump 6
    try f.files.purge(1, dir.id); // bump 7
    try testing.expectEqual(@as(i64, 7), try f.files.syncVersion(1));

    // Counters are per-user: user 2 was never touched.
    try testing.expectEqual(@as(i64, 0), try f.files.syncVersion(2));
}

test "linkBlob links a pre-stored blob, replaces, and enforces quota" {
    var f = try Fixture.init();
    defer f.deinit();

    // Pre-store a blob the way /oss/put would (bytes already on disk).
    var r = std.Io.Reader.fixed("note bytes");
    const res = try f.files.blobs.put(&r, null);
    try testing.expect(f.files.blobs.has(&res.md5));

    // Link it into the tree; quota is charged, syncVersion bumped.
    const e = try f.files.linkBlob(1, null, "a.note", &res.md5, res.size);
    defer freeEntry(e);
    try testing.expectEqualStrings(&res.md5, e.md5.?);
    try testing.expectEqual(res.size, e.size);
    try testing.expectEqual(@as(i64, @intCast(res.size)), try f.used(1));
    try testing.expectEqual(@as(i64, 1), try f.files.syncVersion(1));

    // Quota is enforced on the resulting usage (1 KiB quota).
    var big: [1025]u8 = undefined;
    @memset(&big, 'x');
    var rb = std.Io.Reader.fixed(&big);
    const rbig = try f.files.blobs.put(&rb, null);
    try testing.expectError(error.QuotaExceeded, f.files.linkBlob(1, null, "big", &rbig.md5, rbig.size));
    // The transaction rolled back; linkBlob left the on-disk blob alone (sweepable).
    try testing.expect(f.files.blobs.has(&rbig.md5));
    try testing.expectEqual(@as(i64, @intCast(res.size)), try f.used(1)); // unchanged
}

test "upload session sweep drops stale sessions and reclaims only untracked blobs" {
    var f = try Fixture.init();
    defer f.deinit();
    const alloc = testing.allocator;

    // Session A: an orphan — bytes stored at /oss/put but finish never came.
    var ra = std.Io.Reader.fixed("orphaned upload");
    const oa = try f.files.blobs.put(&ra, null);
    try f.files.createUploadSession(1, "aaaaaaaaaaaaaaaa", "/NOTE", "a.note", oa.size);
    try f.files.setUploadBlob(1, "aaaaaaaaaaaaaaaa", &oa.md5);

    // Session B: its md5 is ALSO held by a committed file (dedup). The sweep must
    // NOT reclaim those bytes even though the session is stale.
    const shared = try putBytes(&f, 1, null, "kept.note", "shared bytes");
    defer freeEntry(shared);
    try f.files.createUploadSession(1, "bbbbbbbbbbbbbbbb", "/NOTE", "b.note", shared.size);
    try f.files.setUploadBlob(1, "bbbbbbbbbbbbbbbb", shared.md5.?);

    try testing.expect(f.files.blobs.has(&oa.md5));
    try testing.expect(f.files.blobs.has(shared.md5.?));

    // Sweep everything (cutoff in the future).
    const swept = try f.files.sweepUploadSessions(-1);
    try testing.expectEqual(@as(usize, 2), swept);

    // Both sessions are gone.
    try testing.expect((try f.files.uploadSession(alloc, 1, "aaaaaaaaaaaaaaaa")) == null);
    try testing.expect((try f.files.uploadSession(alloc, 1, "bbbbbbbbbbbbbbbb")) == null);
    // A's untracked blob was reclaimed; B's blob (a live file references it) survives.
    try testing.expect(!f.files.blobs.has(&oa.md5));
    try testing.expect(f.files.blobs.has(shared.md5.?));

    // A young session is NOT swept (age gate).
    try f.files.createUploadSession(1, "cccccccccccccccc", "/NOTE", "c.note", 10);
    try testing.expectEqual(@as(usize, 0), try f.files.sweepUploadSessions(3600));
    const young = (try f.files.uploadSession(alloc, 1, "cccccccccccccccc")).?;
    alloc.free(young.path);
    alloc.free(young.file_name);
    if (young.blob_md5) |m| alloc.free(m);
}

test "addUploadReceived accumulates per session, credits a replaced part, and clamps at zero" {
    // The running total that makes the `/oss/put` byte cap per-SESSION. A cap that
    // only ever added would refuse a device retrying one part of a large upload,
    // because a part's temp file is REPLACED rather than appended to — hence the
    // signed delta.
    var f = try Fixture.init();
    defer f.deinit();
    const alloc = testing.allocator;

    try f.files.createUploadSession(1, "aaaaaaaaaaaaaaaa", "/NOTE", "a.note", 1000);
    try f.files.createUploadSession(2, "bbbbbbbbbbbbbbbb", "/NOTE", "b.note", 1000);

    // A fresh session starts at zero (the v5 column's DEFAULT), and parts accrue.
    {
        const s = (try f.files.uploadSession(alloc, 1, "aaaaaaaaaaaaaaaa")).?;
        defer {
            alloc.free(s.path);
            alloc.free(s.file_name);
            if (s.blob_md5) |m| alloc.free(m);
        }
        try testing.expectEqual(@as(u64, 0), s.received_bytes);
    }
    try testing.expectEqual(@as(u64, 400), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", 400));
    try testing.expectEqual(@as(u64, 700), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", 300));

    // A retried part: the earlier copy is credited back, so re-sending a 300-byte
    // part as 300 bytes leaves the total where it was.
    try testing.expectEqual(@as(u64, 700), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", -300 + 300));

    // Sessions do not bleed into each other, and the write is user-scoped exactly
    // as `setUploadBlob` is: another account's `inner_name` is NotFound, not a
    // silent no-op that would leave the budget untouched.
    {
        const b = (try f.files.uploadSession(alloc, 2, "bbbbbbbbbbbbbbbb")).?;
        defer {
            alloc.free(b.path);
            alloc.free(b.file_name);
            if (b.blob_md5) |m| alloc.free(m);
        }
        try testing.expectEqual(@as(u64, 0), b.received_bytes);
    }
    try testing.expectError(error.NotFound, f.files.addUploadReceived(2, "aaaaaaaaaaaaaaaa", 100));
    try testing.expectError(error.NotFound, f.files.addUploadReceived(1, "nosuchsession___", 100));

    // Clamped at zero: an over-large credit (a part file that vanished under us)
    // must not make the total negative — a negative total read back as a u64 is an
    // enormous budget, i.e. the cap switched off for that session.
    try testing.expectEqual(@as(u64, 0), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", -100_000));

    // And the value really is on the row, not just in the return.
    const again = (try f.files.uploadSession(alloc, 1, "aaaaaaaaaaaaaaaa")).?;
    defer {
        alloc.free(again.path);
        alloc.free(again.file_name);
        if (again.blob_md5) |m| alloc.free(m);
    }
    try testing.expectEqual(@as(u64, 0), again.received_bytes);
}

test "a missing capacity row is created on the write path and used_bytes accrues (no quota bypass)" {
    var f = try Fixture.init();
    defer f.deinit();

    // A user with NO capacity row (admin createUser path, or any onboarding that
    // skipped bindEquipment). Before the fix, addUsed's UPDATE matched zero rows,
    // so used_bytes never accrued and quota was silently disabled.
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(3, 'q@z.c', '0123456789abcdef0123456789abcdef', 0);");
    try testing.expect(!try hasCapacityRow(&f, 3));

    // A write guarantees the row and charges it.
    const a = try putBytes(&f, 3, null, "a.note", "aaaa"); // 4 bytes
    defer freeEntry(a);
    try testing.expect(try hasCapacityRow(&f, 3)); // ensureCapacity created it
    try testing.expectEqual(@as(i64, 4), try f.used(3)); // accounting is live

    // Tighten the quota to just under what a second write needs; it is enforced —
    // proving accounting is real, not bypassed.
    {
        var s = try f.db.prepare("UPDATE capacity SET total_bytes = 5 WHERE user_id = 3;");
        defer s.finalize();
        _ = try s.step();
    }
    var r = std.Io.Reader.fixed("bb"); // 4 + 2 = 6 > 5
    try testing.expectError(error.QuotaExceeded, f.files.putFile(3, null, "b.note", &r, null));
    try testing.expectEqual(@as(i64, 4), try f.used(3)); // rolled back, unchanged
}

// ---- recycle bin ----

test "THE BIN TEST: a restored file gives back READABLE BYTES, not just a cleared flag" {
    var f = try Fixture.init();
    defer f.deinit();

    // This is the test the whole design exists for. Before the bin, `deleteEntry`
    // decref'd in the same transaction as the tombstone, so the blob was GC'd off
    // disk while the row survived pointing at bytes that no longer existed. A
    // test that only asserted `deleted = 0` after a restore would have PASSED
    // against that — and the user's note would still have been gone. So: put real
    // bytes in, trash, restore, then read the blob back and compare.
    const body = "PAGE1 handwriting strokes \x00\x01\x02 and a trailing NUL\x00";
    const e = try putBytes(&f, 1, null, "BuJo.note", body);
    defer freeEntry(e);
    const md5 = dupeMd5(e.md5.?);

    try f.files.trash(1, e.id);
    try testing.expect(f.files.blobs.has(&md5)); // the bin HOLDS the reference

    const r = try f.files.restore(1, e.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("BuJo.note", r.name);
    try testing.expect(!r.renamed);

    // The row is live again…
    const back = (try f.files.get(1, e.id)).?;
    defer freeEntry(back);
    try testing.expectEqualStrings("BuJo.note", back.name);
    try testing.expectEqual(@as(u64, body.len), back.size);

    // …and, the part that actually matters, the CONTENT is byte-identical.
    var buf: [256]u8 = undefined;
    const read = try f.files.blobs.readRange(back.md5.?, 0, body.len, &buf);
    try testing.expectEqualSlices(u8, body, read);
    try testing.expectEqualStrings(&blobstore.md5HexOf(body), back.md5.?);
}

test "THE DEDUP TEST: a blob shared by two files survives one being trashed, and one being purged" {
    var f = try Fixture.init();
    defer f.deinit();

    // Content-addressed dedup makes this reachable in ordinary use: the same note
    // in two folders is ONE blob at refcount 2. Reaping it when only one
    // reference goes destroys a file the user never touched.
    const body = "identical note payload";
    const a = try putBytes(&f, 1, null, "a.note", body);
    defer freeEntry(a);
    const b = try putBytes(&f, 1, null, "b.note", body);
    defer freeEntry(b);

    // Prove the sharing is real rather than assumed.
    const md5 = dupeMd5(a.md5.?);
    try testing.expectEqualStrings(&md5, b.md5.?);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT refcount FROM blobs;"));

    // 1. Trashing one touches nothing at all — not the refcount, not the disk.
    try f.files.trash(1, a.id);
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT refcount FROM blobs;"));
    try testing.expect(f.files.blobs.has(&md5));

    // 2. PURGING one, while the other is still live, drops the count to 1 and
    //    must leave the bytes exactly where they are.
    try f.files.purge(1, a.id);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT refcount FROM blobs;"));
    try testing.expect(f.files.blobs.has(&md5));

    // The survivor still reads back correctly — the point of the whole test.
    const kept = (try f.files.get(1, b.id)).?;
    defer freeEntry(kept);
    var buf: [64]u8 = undefined;
    try testing.expectEqualSlices(u8, body, try f.files.blobs.readRange(kept.md5.?, 0, body.len, &buf));

    // Only when the LAST reference is purged does the blob actually go.
    try f.files.trash(1, b.id);
    try f.files.purge(1, b.id);
    try testing.expect(!f.files.blobs.has(&md5));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
}

test "THE QUOTA AUDIT: used_bytes equals the reconstructed sum after every mutation" {
    // This test is worth more than any single accounting fix. It does not assert
    // a number anyone typed out; it rebuilds what the user's live blobs actually
    // charge, straight from `files` and `blobs`, and demands the running
    // `used_bytes` agree — after every operation that can move the total. Any
    // future path that charges without refunding, refunds twice, or forgets
    // dedup fails here rather than drifting silently for months.
    var f = try Fixture.init();
    defer f.deinit();

    try f.expectQuotaBalanced(1);

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try f.expectQuotaBalanced(1); // a folder charges nothing

    // Two DIFFERENT files: two blobs, both charged.
    const a = try putBytes(&f, 1, dir.id, "a", "aaaa");
    freeEntry(a);
    const b = try putBytes(&f, 1, dir.id, "b", "bbbbbb");
    freeEntry(b);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    // THE DEDUP CASE. "c" is byte-identical to "a", so it links the SAME blob:
    // one file on disk, one `blobs` row, refcount 2. Charging it a second time
    // bills the user for storage that was never allocated — this is the drift.
    const c = try putBytes(&f, 1, null, "c", "aaaa");
    const shared = dupeMd5(c.md5.?);
    freeEntry(c);
    try testing.expect(f.files.blobs.has(&shared));
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 10), try f.used(1)); // NOT 14

    // A third reference to the same content changes nothing either.
    const d = try putBytes(&f, 1, dir.id, "d", "aaaa");
    freeEntry(d);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    // Replacing "b" with new content ADDS a charge rather than swapping one:
    // the displaced version is RETAINED (`history.keep` defaults to 5), it still
    // occupies disk, and since §6 the user is charged for it — the same rule that
    // has always kept a trashed file on the meter.
    const b2 = try putBytes(&f, 1, dir.id, "b", "bb");
    freeEntry(b2);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 12), try f.used(1)); // 4 shared + 2 current + 6 retained

    // Replacing a file with content the user ALREADY holds elsewhere: the new
    // reference is free, and the displaced "bb" joins the retained history, so
    // nothing is given back here either.
    const b3 = try putBytes(&f, 1, dir.id, "b", "aaaa");
    freeEntry(b3);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 12), try f.used(1)); // 4 shared + 6 + 2, both retained

    // Trash holds a real reference, so nothing is refunded yet — and history
    // follows its file into the bin (H10), so the retained versions keep charging
    // there too.
    try f.files.trash(1, dir.id);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 12), try f.used(1));

    // Purging the folder drops three of the four live references AND cascades
    // away "b"'s two retained versions, refunding both — the bytes are genuinely
    // gone, and charging for them afterwards would be a phantom nothing could
    // clear. "c" still holds the shared blob at the root, so those 4 bytes stay.
    try f.files.purge(1, dir.id);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 4), try f.used(1));
    try testing.expect(f.files.blobs.has(&shared));

    // The last reference goes: charge and blob both released.
    const c_id = (try f.files.resolvePath(1, "/c")).?;
    try f.files.trash(1, c_id);
    try f.files.purge(1, c_id);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try testing.expect(!f.files.blobs.has(&shared));
}

test "the quota audit holds across users sharing one blob" {
    // Deduplication is global (the blob store is content-addressed across the
    // whole install) but quota is per-user. Two users holding the same content
    // must EACH be charged for it — a shared blob is not a discount on someone
    // else's account, and one user deleting their copy must not refund the
    // other's.
    var f = try Fixture.init();
    defer f.deinit();

    const a = try putBytes(&f, 1, null, "a", "shared bytes");
    const md5 = dupeMd5(a.md5.?);
    freeEntry(a);
    const b = try putBytes(&f, 2, null, "b", "shared bytes");
    freeEntry(b);

    try f.expectQuotaBalanced(1);
    try f.expectQuotaBalanced(2);
    try testing.expectEqual(@as(i64, 12), try f.used(1));
    try testing.expectEqual(@as(i64, 12), try f.used(2));

    try f.files.trash(1, 1);
    try f.files.purge(1, 1);
    try f.expectQuotaBalanced(1);
    try f.expectQuotaBalanced(2);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try testing.expectEqual(@as(i64, 12), try f.used(2)); // user 2 unaffected
    try testing.expect(f.files.blobs.has(&md5)); // still theirs
}

test "THE PARTITION AUDIT: the five storage figures sum to the reconstructed total after every mutation" {
    // The storage panel's sibling of THE QUOTA AUDIT above, and it earns its keep
    // the same way: it asserts NO number anyone typed. `expectPartition` rebuilds
    // what the user's blobs actually keep alive — straight from `files`,
    // `file_history` and `blobs` — and demands the five category figures add up to
    // it, after every operation that can move any of them.
    //
    // Anything that charges without landing in a bucket makes the sum short;
    // anything that lands in two makes it long. A user shown a meter whose parts
    // do not add up has no reason to trust any line on the page, so this fails
    // here instead.
    //
    // **The era this test is in.** §6 has landed: retained versions are charged,
    // so the five figures sum to `used_bytes` ITSELF, not merely to a reconstructed
    // total running ahead of it. `expectPartition` asserts BOTH — against the
    // rebuilt figure and against the running meter — because those are two
    // different claims. The first says the split is a partition; the second says
    // the meter agrees with reality. A bug that broke the accounting identically
    // in both places would slip past either check alone.
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 3;

    try f.expectPartition(1);

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try f.expectPartition(1); // a folder references no blob

    // --- upload: one of each live kind, so all three live buckets are populated.
    const note = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v1");
    freeEntry(note);
    const spd = try putBytes(&f, 1, dir.id, "sketch.spd", "sketch-bytes");
    freeEntry(spd);
    const pdf = try putBytes(&f, 1, dir.id, "lease.pdf", "document-bytes");
    freeEntry(pdf);
    try f.expectPartition(1);
    {
        // The kinds actually split (not everything swept into one bucket).
        const b = try f.files.storageBreakdown(1);
        try testing.expect(b.notebooks > 0 and b.sketches > 0 and b.documents > 0);
        try testing.expectEqual(@as(i64, 0), b.recycle_bin);
        try testing.expectEqual(@as(i64, 0), b.versions);
        try testing.expectEqual(try f.used(1), b.total()); // no history yet: meter == sum
    }

    // A file with NO recognisable extension still charges, so it must still land
    // somewhere — Documents is the catch-all, not a list of known types.
    const odd = try putBytes(&f, 1, dir.id, "README", "no-extension-bytes");
    freeEntry(odd);
    try f.expectPartition(1);

    // --- dedup hit: identical content under a second name is ONE blob. Counting
    //     it twice would make the documents line exceed what it occupies.
    {
        const before = (try f.files.storageBreakdown(1)).documents;
        const dup = try putBytes(&f, 1, null, "copy.pdf", "document-bytes");
        freeEntry(dup);
        try f.expectPartition(1);
        try testing.expectEqual(before, (try f.files.storageBreakdown(1)).documents);
    }

    // --- edit / a replace that supersedes: the displaced version leaves the
    //     notebook line and appears under Versions, counted once.
    const note2 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v2");
    freeEntry(note2);
    try f.expectPartition(1);
    try testing.expect((try f.files.storageBreakdown(1)).versions > 0);

    const note3 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v3");
    freeEntry(note3);
    const note4 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v4");
    freeEntry(note4);
    try f.expectPartition(1);

    // §6 HAS LANDED, and this is the line that says so: the Versions figure is
    // NON-ZERO and is INSIDE `used_bytes`, not beside it. Before the accounting
    // change the five summed to the meter plus the version bytes; the meter now
    // includes them, which is what makes the panel's parts add up to its whole.
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expect(b.versions > 0);
        try testing.expectEqual(try f.used(1), b.total());
    }

    // --- version eviction: K bounds the retained set, and the evicted blobs must
    //     leave every bucket rather than lingering in one.
    f.files.history.keep = 1; // K lowered; the next supersede re-applies it
    const note5 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v5");
    freeEntry(note5);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    // --- trash: the note AND its retained versions move to the bin line, because
    //     emptying the bin is what would actually free them (H10).
    const note_id = (try f.files.resolvePath(1, "/Dir/bujo.note")).?;
    try f.files.trash(1, note_id);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(@as(i64, 0), b.versions); // the live-file history is gone with it
        try testing.expect(b.recycle_bin > 0);
    }

    // --- restore: everything comes back out of the bin line.
    (try f.files.restore(1, note_id)).deinit(testing.allocator);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(@as(i64, 0), b.recycle_bin);
        try testing.expect(b.versions > 0);
        try testing.expect(b.notebooks > 0);
    }

    // --- a blob shared by a LIVE file and a trashed one belongs to LIVE: emptying
    //     the bin would free nothing of it, so counting it under Recycle bin would
    //     make that line a lie. Trash the dedup twin and watch documents hold.
    {
        const before = (try f.files.storageBreakdown(1)).documents;
        const dup_id = (try f.files.resolvePath(1, "/copy.pdf")).?;
        try f.files.trash(1, dup_id);
        try f.expectPartition(1);
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(before, b.documents); // still live's
        try testing.expectEqual(@as(i64, 0), b.recycle_bin); // and NOT also the bin's
        try f.files.purge(1, dup_id);
        try f.expectPartition(1);
        try testing.expectEqual(before, (try f.files.storageBreakdown(1)).documents);
    }

    // --- purge: the bytes leave every bucket at once.
    try f.files.trash(1, note_id);
    try f.expectPartition(1);
    try f.files.purge(1, note_id);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(@as(i64, 0), b.notebooks);
        try testing.expectEqual(@as(i64, 0), b.versions);
        try testing.expectEqual(@as(i64, 0), b.recycle_bin);
    }

    // --- and the whole tree away: everything reads zero, from both directions.
    try f.files.trash(1, dir.id);
    try f.expectPartition(1);
    _ = try f.files.emptyBin(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 0), (try f.files.storageBreakdown(1)).total());
    try testing.expectEqual(@as(i64, 0), try f.used(1));
}

test "the storage partition is per-user: one household member's bytes never appear on another's panel" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000;");
    f.files.history.keep = 2;

    // The SAME content in both accounts — deduplicated to one blob on disk, but
    // charged to each, so each panel must show it in full.
    const a = try putBytes(&f, 1, null, "shared.note", "shared-notebook");
    freeEntry(a);
    const b = try putBytes(&f, 2, null, "shared.note", "shared-notebook");
    freeEntry(b);
    // Plus a version apiece, so `file_history` is in play on both sides.
    freeEntry(try putBytes(&f, 1, null, "shared.note", "user-1-edit"));
    freeEntry(try putBytes(&f, 2, null, "shared.note", "user-2-edit"));

    try f.expectPartition(1);
    try f.expectPartition(2);

    // User 2 purging their copy leaves user 1's panel untouched.
    const id2 = (try f.files.resolvePath(2, "/shared.note")).?;
    try f.files.trash(2, id2);
    try f.files.purge(2, id2);
    try f.expectPartition(1);
    try f.expectPartition(2);
    try testing.expectEqual(@as(i64, 0), (try f.files.storageBreakdown(2)).total());
    try testing.expect((try f.files.storageBreakdown(1)).total() > 0);
}

test "setVersionPolicy: lowering evicts NOW, refunds the bytes, and keeps the partition exact" {
    // The partition audit's `K lowered` step changes the GLOBAL ceiling and lets
    // the next supersede re-apply it — the passive path. This is the ACTIVE one:
    // a person moves the dial on the settings page and expects the versions to be
    // gone and the meter to drop without editing a file first. Nothing re-applies
    // it for them, so the setter has to do the eviction, the refund and the GC
    // itself, and this is what says it does.
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 5;
    f.files.history.max_keep = 5; // default AND ceiling here, so the clamp below has a bound to hit

    // Five distinct contents of one file: four retained versions behind it.
    inline for (.{ "v1", "v2", "v3", "v4", "v5" }) |body| {
        const e = try putBytes(&f, 1, null, "bujo.note", "notebook-" ++ body);
        freeEntry(e);
    }
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 4), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    {
        const counts = try f.files.retainedPerFile(testing.allocator, 1);
        defer testing.allocator.free(counts);
        // One file with history, holding four — the array the control sums over.
        try testing.expectEqualSlices(u32, &.{4}, counts);
    }

    const before = try f.used(1);
    const change = try f.files.setVersionPolicy(1, 1);

    try testing.expectEqual(@as(u32, 1), change.policy.keep);
    try testing.expectEqual(@as(u32, 3), change.removed_versions);
    try testing.expect(change.freed_bytes > 0);
    // The refund is the bytes it says it freed — not a number computed twice.
    try testing.expectEqual(before - change.freed_bytes, try f.used(1));
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try f.expectPartition(1);

    // RAISING discards nothing: it only changes what future edits retain, so a
    // person who overshoots the dial and corrects it loses nothing by the trip.
    const raised = try f.files.setVersionPolicy(1, 4);
    try testing.expectEqual(@as(u32, 0), raised.removed_versions);
    try testing.expectEqual(@as(i64, 0), raised.freed_bytes);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try f.expectPartition(1);

    // CLAMPED to the admin's ceiling, not refused — and the returned policy says
    // what actually took effect, so the control can correct itself rather than
    // display a number the server did not accept.
    const over = try f.files.setVersionPolicy(1, 9999);
    try testing.expectEqual(@as(u32, 5), over.policy.keep);
    try testing.expectEqual(@as(u32, 5), over.policy.max_keep);

    // ZERO IS A REAL SETTING: versioning off, every retained version gone, and
    // the Versions line reads 0 rather than the control becoming unavailable.
    const off = try f.files.setVersionPolicy(1, 0);
    try testing.expectEqual(@as(u32, 0), off.policy.keep);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expectEqual(@as(i64, 0), (try f.files.storageBreakdown(1)).versions);
    try f.expectPartition(1);
    {
        const counts = try f.files.retainedPerFile(testing.allocator, 1);
        defer testing.allocator.free(counts);
        try testing.expectEqual(@as(usize, 0), counts.len); // no file has history now
    }
}

test "the default and the ceiling are two knobs, and the default is always reachable" {
    var f = try Fixture.init();
    defer f.deinit();

    // The shipped shape: start everyone at 5, let anyone go as far as 15.
    f.files.history.keep = 5;
    f.files.history.max_keep = 15;
    {
        // An account that has never chosen gets the DEFAULT, not the ceiling.
        // These were one number, and returning the ceiling here would silently
        // give every untouched account maximum depth on the day they split.
        const p = try f.files.versionPolicy(1);
        try testing.expectEqual(@as(u32, 5), p.keep);
        try testing.expectEqual(@as(u32, 15), p.max_keep);
    }
    {
        // ...and raising past the default is now actually available, which is the
        // whole point of the split: a ceiling welded to the default meant the
        // control could offer no choice at all.
        const c = try f.files.setVersionPolicy(1, 12);
        try testing.expectEqual(@as(u32, 12), c.policy.keep);
        try testing.expectEqual(@as(u32, 12), (try f.files.versionPolicy(1)).keep);
    }
    {
        const c = try f.files.setVersionPolicy(1, 99);
        try testing.expectEqual(@as(u32, 15), c.policy.keep); // clamped to the ceiling
    }

    // THE UPGRADE HAZARD. An install that had raised `keep` to 20 before
    // `max_keep` existed inherits the new field's default of 15 — and a bare
    // clamp would drop every user to 15 and evict their versions on the next
    // edit, from a config change the admin never made. The ceiling is read as
    // `@max(keep, max_keep)`, so the configured default stays reachable.
    f.files.history.keep = 20;
    f.files.history.max_keep = 15;
    {
        const p = try f.files.versionPolicy(2);
        try testing.expectEqual(@as(u32, 20), p.keep); // untouched
        try testing.expectEqual(@as(u32, 20), p.max_keep); // and choosable
    }
}

test "setVersionPolicy is per-user: lowering your dial never touches a housemate's history" {
    // The §6 fairness rule, at the one place a person can now trigger eviction
    // deliberately. Before §6 the eviction path picked the globally-oldest row,
    // so this control would have let anyone in the household discard somebody
    // else's version history by turning their own dial down.
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("INSERT OR IGNORE INTO users(id, email, name) VALUES(2, 'b@h.lan', 'b');");
    try f.db.exec("INSERT OR IGNORE INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 5;

    inline for (.{ "1", "2", "3" }) |v| {
        const a = try putBytes(&f, 1, null, "a.note", "ana-" ++ v);
        freeEntry(a);
        const b = try putBytes(&f, 2, null, "b.note", "ben-" ++ v);
        freeEntry(b);
    }
    const ben_before = try countOf(&f, "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = 2;");
    try testing.expect(ben_before > 0);
    const ben_used_before = try f.used(2);

    _ = try f.files.setVersionPolicy(1, 0);

    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = 1;"));
    try testing.expectEqual(ben_before, try countOf(&f, "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = 2;"));
    try testing.expectEqual(ben_used_before, try f.used(2));
    try f.expectPartition(1);
    try f.expectPartition(2);
}

test "quota keeps charging while trashed and is refunded only at purge" {
    var f = try Fixture.init();
    defer f.deinit();

    const e = try putBytes(&f, 1, null, "a.note", "0123456789"); // 10 bytes
    defer freeEntry(e);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    // The bytes still occupy disk, so the quota still charges for them. Refunding
    // at trash time would let a user exceed real usage by cycling the bin.
    try f.files.trash(1, e.id);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    // Restoring changes nothing either way — it was never refunded.
    (try f.files.restore(1, e.id)).deinit(testing.allocator);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    try f.files.trash(1, e.id);
    try f.files.purge(1, e.id);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
}

test "a trashed entry is absent from listings, get and path resolution" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const e = try putBytes(&f, 1, dir.id, "a.note", "body");
    defer freeEntry(e);

    try f.files.trash(1, e.id);

    const kids = try f.files.list(1, dir.id);
    defer Files.freeEntries(testing.allocator, kids);
    try testing.expectEqual(@as(usize, 0), kids.len);
    try testing.expect((try f.files.get(1, e.id)) == null);
    try testing.expect((try f.files.resolvePath(1, "/Dir/a.note")) == null);

    // And it comes back to all three on restore.
    (try f.files.restore(1, e.id)).deinit(testing.allocator);
    const kids2 = try f.files.list(1, dir.id);
    defer Files.freeEntries(testing.allocator, kids2);
    try testing.expectEqual(@as(usize, 1), kids2.len);
    try testing.expect((try f.files.resolvePath(1, "/Dir/a.note")) != null);
}

test "trash is idempotent, tolerates already-trashed children, and walks a folder itself" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const a = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(a);
    const b = try putBytes(&f, 1, dir.id, "b.note", "bbb");
    defer freeEntry(b);

    // The DEVICE's order: one request per entity, children first, parent last —
    // so the folder arrives already empty of live children.
    try f.files.trash(1, a.id);
    try f.files.trash(1, b.id);
    try f.files.trash(1, dir.id);
    try testing.expectEqual(@as(i64, 3), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));

    // Retries must succeed, not error — the device resends.
    try f.files.trash(1, a.id);
    try f.files.trash(1, dir.id);
    try testing.expectEqual(@as(i64, 3), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));

    // Unknown / foreign ids are still NotFound.
    try testing.expectError(error.NotFound, f.files.trash(1, 9999));
    try testing.expectError(error.NotFound, f.files.trash(2, dir.id));

    // The WEB's order: one call on the folder, no walk done for us. Same end state.
    const dir2 = try f.files.createFolder(1, null, "Dir2");
    defer testing.allocator.free(dir2.name);
    const sub = try f.files.createFolder(1, dir2.id, "Sub");
    defer testing.allocator.free(sub.name);
    const c = try putBytes(&f, 1, sub.id, "c.note", "ccc");
    defer freeEntry(c);

    try f.files.trash(1, dir2.id);
    try testing.expectEqual(@as(i64, 6), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 0;"));

    // Every tombstone carries a retention timestamp; none is left NULL.
    try testing.expectEqual(@as(i64, 0), try countOf(
        &f,
        "SELECT COUNT(*) FROM files WHERE deleted = 1 AND deleted_at IS NULL;",
    ));
}

test "restore brings back the whole ancestor chain, so nothing lands orphaned" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(sub.name);
    const e = try putBytes(&f, 1, sub.id, "deep.note", "deep body");
    defer freeEntry(e);

    try f.files.trash(1, dir.id); // the whole chain goes

    // Restore only the LEAF. Without the ancestor pass this would be a live row
    // under two dead parents: reachable by id, visible in no listing at all.
    (try f.files.restore(1, e.id)).deinit(testing.allocator);

    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 1), root.len);
    try testing.expectEqualStrings("Dir", root[0].name);

    const p = try f.files.pathOf(testing.allocator, 1, e.id);
    defer testing.allocator.free(p);
    try testing.expectEqualStrings("/Dir/Sub/deep.note", p);
    try testing.expectEqual(e.id, (try f.files.resolvePath(1, "/Dir/Sub/deep.note")).?);
}

test "restoring a folder restores every trashed descendant" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(sub.name);
    const a = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(a);
    const c = try putBytes(&f, 1, sub.id, "c.note", "ccc");
    defer freeEntry(c);

    try f.files.trash(1, dir.id);
    (try f.files.restore(1, dir.id)).deinit(testing.allocator);

    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted_at IS NOT NULL;"));
    try testing.expectEqual(c.id, (try f.files.resolvePath(1, "/Dir/Sub/c.note")).?);
    try testing.expectEqual(a.id, (try f.files.resolvePath(1, "/Dir/a.note")).?);
}

test "restore auto-renames onto a taken name and reports the name it chose" {
    var f = try Fixture.init();
    defer f.deinit();

    const v1 = try putBytes(&f, 1, null, "BuJo.note", "first body");
    defer freeEntry(v1);
    try f.files.trash(1, v1.id);

    // The device recreates the note while the old one sits in the bin — the
    // UNIQUE-on-live-names index means the restore cannot land on `BuJo.note`.
    const v2 = try putBytes(&f, 1, null, "BuJo.note", "second body");
    defer freeEntry(v2);

    const r = try f.files.restore(1, v1.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("BuJo (2).note", r.name); // suffix on the STEM, extension kept
    try testing.expect(r.renamed); // …and the caller is TOLD, or the UI lies about the name

    // Both exist, both live, and each still holds its OWN bytes.
    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 2), root.len);
    var buf: [64]u8 = undefined;
    const restored = (try f.files.get(1, v1.id)).?;
    defer freeEntry(restored);
    try testing.expectEqualSlices(u8, "first body", try f.files.blobs.readRange(restored.md5.?, 0, 10, &buf));

    // A third round takes the next free suffix WITHOUT stacking parentheses:
    // the row is now literally named "BuJo (2).note", and a naive scheme would
    // hand back "BuJo (2) (2).note" and grow one more every trip through the bin.
    try f.files.trash(1, v1.id);
    const occupier = try putBytes(&f, 1, null, "BuJo (2).note", "occupier");
    defer freeEntry(occupier);
    const again = try f.files.restore(1, v1.id);
    defer again.deinit(testing.allocator);
    try testing.expectEqualStrings("BuJo (3).note", again.name);

    // A suffix the USER chose is not a collision suffix and is never stripped.
    try testing.expectEqualStrings("Budget (draft)", stripSuffix("Budget (draft)"));
    try testing.expectEqualStrings("Notes", stripSuffix("Notes (2024)"));
    try testing.expectEqualStrings("(2)", stripSuffix("(2)")); // no base to keep

    // A name with no extension keeps the suffix at the end.
    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try f.files.trash(1, dir.id);
    const dir2 = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir2.name);
    const dname = try f.files.restore(1, dir.id);
    defer dname.deinit(testing.allocator);
    try testing.expectEqualStrings("Dir (2)", dname.name);
}

test "two trashed siblings that share a name both come back, one suffixed" {
    var f = try Fixture.init();
    defer f.deinit();

    // The "deleted twice" case: delete, the device recreates the note, delete
    // again. Nothing stops that — `files_live_name` is UNIQUE only over LIVE
    // rows, so the bin legitimately holds two `a.note` in the same folder.
    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const first = try putBytes(&f, 1, dir.id, "a.note", "first body");
    defer freeEntry(first);
    try f.files.trash(1, first.id);
    const second = try putBytes(&f, 1, dir.id, "a.note", "second body");
    defer freeEntry(second);
    try f.files.trash(1, second.id);
    try f.files.trash(1, dir.id);

    (try f.files.restore(1, dir.id)).deinit(testing.allocator);

    // Both are live, under distinct names; the older row keeps the plain one.
    const kids = try f.files.list(1, dir.id);
    defer Files.freeEntries(testing.allocator, kids);
    try testing.expectEqual(@as(usize, 2), kids.len);
    try testing.expectEqualStrings("a (2).note", kids[0].name);
    try testing.expectEqualStrings("a.note", kids[1].name);

    // And each still points at its OWN bytes — the rename moved a name, not content.
    var buf: [64]u8 = undefined;
    for (kids) |k| {
        const want: []const u8 = if (k.id == first.id) "first body" else "second body";
        try testing.expectEqualSlices(u8, want, try f.files.blobs.readRange(k.md5.?, 0, want.len, &buf));
    }
}

test "purge refuses a live entry; emptyBin clears the bin and leaves the live tree alone" {
    var f = try Fixture.init();
    defer f.deinit();

    const keep = try putBytes(&f, 1, null, "keep.note", "kept bytes");
    defer freeEntry(keep);
    const drop = try putBytes(&f, 1, null, "drop.note", "dropped bytes");
    defer freeEntry(drop);
    const drop_md5 = dupeMd5(drop.md5.?);

    // Purge is a bin operation: a live file must never be one mistyped id away
    // from destruction.
    try testing.expectError(error.NotFound, f.files.purge(1, keep.id));
    try testing.expectError(error.NotFound, f.files.purge(1, 9999));

    try f.files.trash(1, drop.id);
    try testing.expectError(error.NotFound, f.files.purge(2, drop.id)); // foreign

    try testing.expectEqual(@as(usize, 1), try f.files.emptyBin(1));

    try testing.expect(!f.files.blobs.has(&drop_md5));
    try testing.expect(f.files.blobs.has(keep.md5.?));
    try testing.expectEqual(@as(i64, 10), try f.used(1)); // only "kept bytes" remains
    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 1), root.len);
    try testing.expectEqual(@as(usize, 0), try f.files.emptyBin(1)); // already empty
}

test "the retention sweep purges only entries past the window" {
    var f = try Fixture.init();
    defer f.deinit();

    const old = try putBytes(&f, 1, null, "old.note", "old body");
    defer freeEntry(old);
    const recent = try putBytes(&f, 1, null, "recent.note", "recent body");
    defer freeEntry(recent);
    const live = try putBytes(&f, 1, null, "live.note", "live body");
    defer freeEntry(live);
    const old_md5 = dupeMd5(old.md5.?);

    try f.files.trash(1, old.id);
    try f.files.trash(1, recent.id);

    // Age one tombstone past the window by hand (the clock is real).
    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = deleted_at - ?1 WHERE id = ?2;");
        defer s.finalize();
        s.bindInt(1, Files.bin_retention_s + 60);
        s.bindInt(2, @intCast(old.id));
        _ = try s.step();
    }

    try testing.expectEqual(@as(usize, 1), try f.files.sweepBin(Files.bin_retention_s));

    // The expired one is destroyed — row, blob and quota.
    try testing.expect(!f.files.blobs.has(&old_md5));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE id = 1;"));
    try testing.expectEqual(@as(i64, 20), try f.used(1)); // 11 + 9, "old body" refunded

    // The recent tombstone is untouched and still restorable.
    try testing.expect(f.files.blobs.has(recent.md5.?));
    (try f.files.restore(1, recent.id)).deinit(testing.allocator);
    freeEntry((try f.files.get(1, recent.id)).?);

    // A second sweep finds nothing; the live file was never a candidate.
    try testing.expectEqual(@as(usize, 0), try f.files.sweepBin(Files.bin_retention_s));
    freeEntry((try f.files.get(1, live.id)).?);
}

test "shortening the retention window purges nothing, and the sweep applies it going forward" {
    var f = try Fixture.init();
    defer f.deinit();
    const settings = @import("settings.zig");
    const set = settings.Settings.init(testing.io, f.db);

    // An entry trashed 20 days ago: comfortably inside the 30-day default.
    const entry = try putBytes(&f, 1, null, "old.note", "old body");
    defer freeEntry(entry);
    const md5 = dupeMd5(entry.md5.?);
    try f.files.trash(1, entry.id);
    const day = settings.seconds_per_day;
    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = deleted_at - ?1 WHERE id = ?2;");
        defer s.finalize();
        s.bindInt(1, 20 * day);
        s.bindInt(2, @intCast(entry.id));
        _ = try s.step();
    }

    const now = std.Io.Clock.real.now(testing.io).toSeconds();

    // Under the default window it survives, as it always did.
    {
        const cutoff = settings.sweepCutoff(now, try set.binRetention()).?;
        try testing.expectEqual(@as(usize, 0), try f.files.sweepBinBefore(cutoff));
    }

    // THE ITEM: the admin cuts retention to 7 days. The entry is 20 days old and
    // therefore already past the NEW window — and it must NOT be destroyed. The
    // sweep is gated entirely: the shortened window has not been in force for its
    // own length, so nothing at all is due yet.
    const shortened = try set.setBinRetentionDays(7);
    try testing.expectEqual(@as(?i64, null), settings.sweepCutoff(now, shortened));
    try testing.expect(f.files.blobs.has(&md5));
    (try f.files.restore(1, entry.id)).deinit(testing.allocator); // still restorable
    freeEntry((try f.files.get(1, entry.id)).?);
    try f.files.trash(1, entry.id);

    // Seven days on, the new window HAS been served in full and the sweep applies
    // it — going forward, which is the whole distinction. Nothing was lost at the
    // moment of the change; the grace simply expired.
    const later = now + 7 * day + 1;
    const cutoff = settings.sweepCutoff(later, shortened).?;
    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = ?1 WHERE id = ?2;");
        defer s.finalize();
        s.bindInt(1, later - 8 * day); // 8 days in the bin at that later "now"
        s.bindInt(2, @intCast(entry.id));
        _ = try s.step();
    }
    try testing.expectEqual(@as(usize, 1), try f.files.sweepBinBefore(cutoff));
    try testing.expect(!f.files.blobs.has(&md5));
}

test "the retention sweep is per-user and takes a trashed folder's whole subtree" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const inner = try putBytes(&f, 1, dir.id, "inner.note", "inner body");
    defer freeEntry(inner);
    const inner_md5 = dupeMd5(inner.md5.?);
    const other = try putBytes(&f, 2, null, "other.note", "other body");
    defer freeEntry(other);

    try f.files.trash(1, dir.id);
    try f.files.trash(2, other.id);

    // Sweep everything (a negative window puts the cutoff in the future).
    try testing.expectEqual(@as(usize, 3), try f.files.sweepBin(-1)); // Dir + inner + other

    try testing.expect(!f.files.blobs.has(&inner_md5));
    try testing.expect(!f.files.blobs.has(other.md5.?));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try testing.expectEqual(@as(i64, 0), try f.used(2)); // each user refunded separately
}

fn countOf(f: *Fixture, sql: []const u8) !i64 {
    var s = try f.db.prepare(sql);
    defer s.finalize();
    _ = try s.step();
    return s.columnInt(0);
}

fn hasCapacityRow(f: *Fixture, user_id: u64) !bool {
    var s = try f.db.prepare("SELECT 1 FROM capacity WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    return try s.step();
}

fn freeEntry(e: Entry) void {
    testing.allocator.free(e.name);
    if (e.md5) |m| testing.allocator.free(m);
}

fn dupeMd5(m: []const u8) [md5_len]u8 {
    var out: [md5_len]u8 = undefined;
    @memcpy(&out, m[0..md5_len]);
    return out;
}

/// The global `blobs.refcount` (live-file references) for `md5`, or -1 if the
/// row is gone. Used by the versioning tests to prove `refcount` keeps meaning
/// "live-file references" while a history row is the separate keep-alive.
fn blobRefcount(f: *Fixture, md5: []const u8) !i64 {
    var r = (try f.db.row("SELECT refcount FROM blobs WHERE md5 = ?1;", &.{.{ .text = md5 }})) orelse return -1;
    defer r.finalize();
    return r.int(0);
}

/// How many `file_history` rows reference `md5`.
fn historyRows(f: *Fixture, md5: []const u8) !i64 {
    var s = try f.db.prepare("SELECT COUNT(*) FROM file_history WHERE md5 = ?1;");
    defer s.finalize();
    s.bindText(1, md5);
    _ = try s.step();
    return s.columnInt(0);
}

// ---- the bin listing ----

/// The bin row for `id`, or null. Tests read through the real `listBin` rather
/// than a SELECT so the assertions are on the shape the browser actually gets.
fn binRow(arena: std.mem.Allocator, f: *Fixture, user_id: u64, id: u64) !?BinEntry {
    const rows = try f.files.listBin(arena, user_id);
    for (rows) |r| {
        if (r.id == id) return r;
    }
    return null;
}

test "listBin reconstructs the original path THROUGH trashed ancestors" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const dir = try f.files.createFolder(1, null, "NOTE");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Work");
    defer testing.allocator.free(sub.name);
    const e = try putBytes(&f, 1, sub.id, "deep.note", "deep body");
    defer freeEntry(e);

    // THE CASE THAT ACTUALLY OCCURS. The device deletes a folder as one request
    // per entity, CHILDREN FIRST and the folder last (the capture: ids 19, 20,
    // then 18), so by the time the parent is trashed its children already are.
    // Every ancestor of `deep.note` is therefore a tombstone.
    try f.files.trash(1, e.id);
    try f.files.trash(1, sub.id);
    try f.files.trash(1, dir.id);

    // `pathOf` — the live-only walk — cannot answer this at all: it stops at the
    // first tombstone and reports the note as having lived at the root. That is
    // precisely why `listBin` has its own walk.
    const live_path = try f.files.pathOf(testing.allocator, 1, e.id);
    defer testing.allocator.free(live_path);
    try testing.expectEqualStrings("/", live_path);

    const row = (try binRow(a, &f, 1, e.id)).?;
    try testing.expectEqualStrings("/NOTE/Work/deep.note", row.path);
    try testing.expectEqualStrings("deep.note", row.name);
    try testing.expect(!row.is_folder);
    try testing.expectEqual(@as(u64, 9), row.size);
    try testing.expect(row.deleted_at > 0);
    try testing.expect(row.md5 != null);

    // The ancestors are in the bin too, with their own (shorter) paths.
    try testing.expectEqualStrings("/NOTE/Work", (try binRow(a, &f, 1, sub.id)).?.path);
    try testing.expectEqualStrings("/NOTE", (try binRow(a, &f, 1, dir.id)).?.path);
}

test "listBin: newest first, is_root marks what the user deleted, folders weigh 0" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const inside = try putBytes(&f, 1, dir.id, "inside.note", "inside!");
    defer freeEntry(inside);
    const loose = try putBytes(&f, 1, null, "loose.note", "loose");
    defer freeEntry(loose);

    try f.files.trash(1, loose.id);
    try f.files.trash(1, dir.id); // takes `inside.note` with it
    // A coarse test clock can stamp both in the same second, so order the two
    // deletions explicitly — the assertion is about the ORDER BY, not the clock.
    try f.db.exec("UPDATE files SET deleted_at = 100 WHERE name = 'loose.note';");
    try f.db.exec("UPDATE files SET deleted_at = 200 WHERE name IN ('Dir','inside.note');");

    const rows = try f.files.listBin(a, 1);
    try testing.expectEqual(@as(usize, 3), rows.len);
    // Newest deletion first; `Dir` before its child at the same instant (id DESC
    // is only a tie-break — the client nests by `parent_id`, not by position).
    try testing.expectEqual(@as(i64, 200), rows[0].deleted_at);
    try testing.expectEqual(@as(i64, 200), rows[1].deleted_at);
    try testing.expectEqualStrings("loose.note", rows[2].name);

    // `is_root` = "the thing the user clicked". `inside.note` came along for the
    // ride, so it is NOT a root and the UI nests it under `Dir` instead of
    // claiming it was deleted on its own.
    try testing.expect((try binRow(a, &f, 1, dir.id)).?.is_root);
    try testing.expect((try binRow(a, &f, 1, loose.id)).?.is_root);
    try testing.expect(!(try binRow(a, &f, 1, inside.id)).?.is_root);

    // A folder weighs 0 and carries no blob: its bytes are its children's, so
    // summing `size` over any subset of these rows can never double-count.
    const folder_row = (try binRow(a, &f, 1, dir.id)).?;
    try testing.expectEqual(@as(u64, 0), folder_row.size);
    try testing.expect(folder_row.md5 == null);

    // A LIVE entry is never in the bin, and a trashed entry never in a listing.
    const kept = try putBytes(&f, 1, null, "kept.note", "kept");
    defer freeEntry(kept);
    try testing.expect((try binRow(a, &f, 1, kept.id)) == null);

    // Scoped: user 2's bin is empty however many rows user 1 has trashed.
    try testing.expectEqual(@as(usize, 0), (try f.files.listBin(a, 2)).len);
    try testing.expect((try binRow(a, &f, 2, loose.id)) == null);
}

test "listBin: a trashed child under a LIVE parent is a root, and keeps its live path" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const e = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(e);

    try f.files.trash(1, e.id); // just the file; `Dir` stays live

    const row = (try binRow(arena.allocator(), &f, 1, e.id)).?;
    try testing.expectEqualStrings("/Dir/a.note", row.path);
    try testing.expect(row.is_root); // its parent is live, so it stands alone
    try testing.expectEqual(dir.id, row.parent_id.?);
}

test "listBin: the path is FROZEN at trash time — a later ancestor rename cannot move it" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const dir = try f.files.createFolder(1, null, "NOTE");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Work");
    defer testing.allocator.free(sub.name);
    const e = try putBytes(&f, 1, sub.id, "deep.note", "deep body");
    defer freeEntry(e);

    // Trash JUST the file; its ancestors stay live. It was deleted at /NOTE/Work.
    try f.files.trash(1, e.id);
    try testing.expectEqualStrings("/NOTE/Work/deep.note", (try binRow(a, &f, 1, e.id)).?.path);

    // Rename a LIVE ancestor — the case the device can drive even though the web
    // UI cannot. The old recompute-from-current-tree listing would now report
    // "/ARCHIVE/Work/deep.note"; the frozen path must not budge. This assertion
    // fails on the pre-v12 behaviour, which is the whole point of the column.
    try f.db.exec("UPDATE files SET name = 'ARCHIVE' WHERE name = 'NOTE' AND user_id = 1;");
    // The live tree really did move: the folder now resolves under its new name.
    const sub_path = try f.files.pathOf(testing.allocator, 1, sub.id);
    defer testing.allocator.free(sub_path);
    try testing.expectEqualStrings("/ARCHIVE/Work", sub_path);
    // ...but the tombstone still shows where it ACTUALLY was when deleted.
    try testing.expectEqualStrings("/NOTE/Work/deep.note", (try binRow(a, &f, 1, e.id)).?.path);
}

test "trash writes deleted_path, restore clears it, and the empty bin exits early" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The empty bin returns an empty listing (via the EXISTS early exit), and no
    // live row ever carries a frozen path.
    try testing.expectEqual(@as(usize, 0), (try f.files.listBin(a, 1)).len);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted_path IS NOT NULL;"));

    const dir = try f.files.createFolder(1, null, "NOTE");
    defer testing.allocator.free(dir.name);
    const e = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(e);
    // A live row has no frozen path.
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM files WHERE name = 'a.note' AND deleted_path IS NULL;"));

    // trash freezes the column, and the listing reads exactly that value.
    try f.files.trash(1, e.id);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM files WHERE name = 'a.note' AND deleted_path = '/NOTE/a.note';"));
    try testing.expectEqualStrings("/NOTE/a.note", (try binRow(a, &f, 1, e.id)).?.path);

    // restore clears it back to NULL — the live invariant — and empties the bin,
    // so the early exit fires again.
    {
        const r = try f.files.restore(1, e.id);
        r.deinit(testing.allocator);
    }
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted_path IS NOT NULL;"));
    try testing.expectEqual(@as(usize, 0), (try f.files.listBin(a, 1)).len);
}

test "listBin disambiguates: same name two places, and the same place deleted twice" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // Same NAME, two different PLACES: path is what tells them apart.
    const d1 = try f.files.createFolder(1, null, "A");
    defer testing.allocator.free(d1.name);
    const d2 = try f.files.createFolder(1, null, "B");
    defer testing.allocator.free(d2.name);
    const in_a = try putBytes(&f, 1, d1.id, "note.note", "aaa");
    defer freeEntry(in_a);
    const in_b = try putBytes(&f, 1, d2.id, "note.note", "bbb");
    defer freeEntry(in_b);
    try f.files.trash(1, in_a.id);
    try f.files.trash(1, in_b.id);
    try testing.expectEqualStrings("/A/note.note", (try binRow(a, &f, 1, in_a.id)).?.path);
    try testing.expectEqualStrings("/B/note.note", (try binRow(a, &f, 1, in_b.id)).?.path);

    // Same PLACE, deleted TWICE: identical frozen path, told apart by deleted_at.
    // (The device recreates a name after a delete, then deletes it again — U2.)
    const first = try putBytes(&f, 1, null, "again.note", "1");
    defer freeEntry(first);
    try f.files.trash(1, first.id); // frees the live name again
    const second = try putBytes(&f, 1, null, "again.note", "2");
    defer freeEntry(second);
    try f.files.trash(1, second.id);

    // Both froze the SAME root path, so path alone cannot separate them — they are
    // two distinct rows (deleted_at is what the UI leans on together with path).
    const r1 = (try binRow(a, &f, 1, first.id)).?;
    const r2 = (try binRow(a, &f, 1, second.id)).?;
    try testing.expectEqualStrings("/again.note", r1.path);
    try testing.expectEqualStrings("/again.note", r2.path);
    try testing.expect(r1.id != r2.id);
}

test "restore REPORTS what it did: the ancestors, the descendants and the rename" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(sub.name);
    const a = try putBytes(&f, 1, sub.id, "a.note", "aaa");
    defer freeEntry(a);
    const b = try putBytes(&f, 1, sub.id, "b.note", "bbb");
    defer freeEntry(b);

    try f.files.trash(1, dir.id); // Dir + Sub + a.note + b.note

    // Restoring `Sub` restores ONE ancestor (Dir) and TWO descendants — three
    // rows the user did not select. Without these numbers the UI cannot say so.
    {
        const r = try f.files.restore(1, sub.id);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("Sub", r.name);
        try testing.expect(!r.renamed);
        try testing.expectEqual(@as(usize, 1), r.ancestors);
        try testing.expectEqual(@as(usize, 2), r.descendants);
    }

    // Already-live rows are not counted as work done: a second restore of the
    // same id reports zeroes rather than re-reporting the whole subtree.
    {
        const again = try f.files.restore(1, sub.id);
        defer again.deinit(testing.allocator);
        try testing.expectEqual(@as(usize, 0), again.ancestors);
        try testing.expectEqual(@as(usize, 0), again.descendants);
        try testing.expect(!again.renamed);
    }

    // And a rename is reported alongside the counts, not instead of them.
    try f.files.trash(1, sub.id);
    const squatter = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(squatter.name);
    const r = try f.files.restore(1, sub.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("Sub (2)", r.name);
    try testing.expect(r.renamed);
    try testing.expectEqual(@as(usize, 2), r.descendants);
}

test "liveSubtreeCount is the fanout a web delete is about to have" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(sub.name);
    const a = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(a);
    const c = try putBytes(&f, 1, sub.id, "c.note", "ccc");
    defer freeEntry(c);

    try testing.expectEqual(@as(usize, 4), try f.files.liveSubtreeCount(1, dir.id)); // Dir+Sub+a+c
    try testing.expectEqual(@as(usize, 1), try f.files.liveSubtreeCount(1, a.id));

    // Rows already in the bin are not counted — they are not what this delete
    // will tombstone, and counting them would overstate the fanout.
    try f.files.trash(1, c.id);
    try testing.expectEqual(@as(usize, 3), try f.files.liveSubtreeCount(1, dir.id));

    // Missing, foreign and already-trashed all read 0.
    try testing.expectEqual(@as(usize, 0), try f.files.liveSubtreeCount(1, 99999));
    try testing.expectEqual(@as(usize, 0), try f.files.liveSubtreeCount(2, dir.id));
    try testing.expectEqual(@as(usize, 0), try f.files.liveSubtreeCount(1, c.id));
}

test "getTrashed sees the bin and ONLY the bin; get still sees only live rows" {
    var f = try Fixture.init();
    defer f.deinit();

    const e = try putBytes(&f, 1, null, "a.note", "aaa");
    defer freeEntry(e);

    // Live: `get` finds it, the bin lookup does not.
    {
        const live = (try f.files.get(1, e.id)).?;
        defer freeEntry(live);
        try testing.expectEqualStrings("a.note", live.name);
    }
    try testing.expect((try f.files.getTrashed(1, e.id)) == null);

    try f.files.trash(1, e.id);

    // Trashed: exactly the other way round. `get` is NOT relaxed — that is what
    // keeps the bin out of every listing, noteMeta and search read.
    try testing.expect((try f.files.get(1, e.id)) == null);
    {
        const binned = (try f.files.getTrashed(1, e.id)).?;
        defer freeEntry(binned);
        try testing.expectEqualStrings("a.note", binned.name);
        try testing.expect(binned.md5 != null); // the blob reference is still held
    }

    // A foreign id is null through both, indistinguishable from a missing one.
    try testing.expect((try f.files.getTrashed(2, e.id)) == null);
    try testing.expect((try f.files.getTrashed(1, 99999)) == null);
}

// ---- embedded-thumbnail ingest derivation + on-demand repair ----

/// The JPEG magic the sniffer keys on plus filler — a stand-in for a real image,
/// so derivation can be exercised end to end without a committed binary. Mirrors
/// the fixture `spd_index.zig`'s own tests build.
const spd_fake_jpeg = "\xff\xd8\xff\xe0" ++ ("thumbnail-pixels" ** 4);

/// Builds a minimal, hermetic `.spd`: an in-memory SQLite db with a `config`
/// table, serialized to bytes. Same shape as `spd_index.zig`'s test fixture — no
/// committed binary, no file on disk. `thumb` is the raw image blob to embed
/// (null omits the row, i.e. a `.spd` with no preview).
fn buildSpd(gpa: std.mem.Allocator, thumb: ?[]const u8) ![]u8 {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE config(name TEXT PRIMARY KEY NOT NULL, value BLOB);");
    try db.exec("INSERT INTO config(name, value) VALUES('fmt_ver', '2');");
    if (thumb) |t| {
        var s = try db.prepare("INSERT INTO config(name, value) VALUES('thumbnail', ?1);");
        defer s.finalize();
        s.bindBlob(1, t);
        _ = try s.step();
    }
    return db.serializeAlloc(gpa);
}

/// The repair path's lock shim: `repairDerivedThumb` brackets its DB touches
/// through the handler's `ctx.lockDb()`/`unlockDb()` in production; these tests
/// are single-threaded with no lock to take, exactly like a null `ctx.db_lock`.
const NoLock = struct {
    fn lockDb(_: NoLock) void {}
    fn unlockDb(_: NoLock) void {}
};

fn spdIndexedAt(f: *Fixture, md5: []const u8) !?i64 {
    var r = (try f.db.row("SELECT indexed_at FROM spd_index WHERE blob_md5 = ?1;", &.{.{ .text = md5 }})) orelse return null;
    defer r.finalize();
    return r.int(0);
}

test "linking a .spd derives the spd_index row + thumbs file; dedup re-link does not re-derive" {
    var f = try Fixture.init();
    defer f.deinit();
    // A synthetic `.spd` is a few KiB — well past the fixture's 1 KiB default quota.
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const spd_bytes = try buildSpd(testing.allocator, spd_fake_jpeg);
    defer testing.allocator.free(spd_bytes);

    const e = try putBytes(&f, 1, null, "drawing.spd", spd_bytes);
    defer freeEntry(e);
    const md5 = e.md5.?;

    // Ingest derived eagerly: the row and the on-disk thumbnail both exist.
    try testing.expect(try spdindex.isCurrent(f.db, md5));
    try testing.expect(f.files.thumbs.has(md5));

    // Re-linking dedup'd content under another name hits the `isCurrent` gate:
    // the row is untouched, so the `.spd` was NOT re-opened. The sentinel is
    // what proves it — a re-derive would upsert `indexed_at = now()` over it
    // (equality of two same-second `now()` values would prove nothing).
    try f.db.exec("UPDATE spd_index SET indexed_at = 999;");
    const e2 = try putBytes(&f, 1, null, "copy.spd", spd_bytes);
    defer freeEntry(e2);
    try testing.expectEqual(@as(?i64, 999), try spdIndexedAt(&f, md5));

    // A `.note` never reaches the deserializer, even with `.spd` bytes inside —
    // the filename gate (`thumbnail.wants`) is what decides.
    const disguised = try buildSpd(testing.allocator, "\x89PNG\r\n\x1a\n" ++ ("z" ** 40));
    defer testing.allocator.free(disguised);
    const n = try putBytes(&f, 1, null, "secret.note", disguised);
    defer freeEntry(n);
    try testing.expect(!try spdindex.isCurrent(f.db, n.md5.?));
    try testing.expect(!f.files.thumbs.has(n.md5.?));

    // A corrupt `.spd` still links fine and memoizes the fact.
    const bad = try putBytes(&f, 1, null, "bad.spd", "this is not a sqlite database at all");
    defer freeEntry(bad);
    try testing.expect(try spdindex.isCurrent(f.db, bad.md5.?)); // indexable = 0, current
    try testing.expect(!f.files.thumbs.has(bad.md5.?));
}

test "purging the last reference removes the spd_index row AND the thumbs file" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const spd_bytes = try buildSpd(testing.allocator, spd_fake_jpeg);
    defer testing.allocator.free(spd_bytes);
    const e = try putBytes(&f, 1, null, "drawing.spd", spd_bytes);
    defer freeEntry(e);
    const md5 = dupeMd5(e.md5.?);

    try f.files.trash(1, e.id);
    try f.files.purge(1, e.id);

    try testing.expect(!try spdindex.isCurrent(f.db, &md5)); // row released in the txn
    try testing.expect(!f.files.blobs.has(&md5)); // blob GC'd post-commit
    try testing.expect(!f.files.thumbs.has(&md5)); // and its derived thumbnail with it
}

test "replacing a .spd GCs the OLD blob's thumbs file along with the blob" {
    var f = try Fixture.init();
    defer f.deinit();
    f.files.history.keep = 0; // prune path: a superseded blob (and its thumb) is GC'd at once
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const v1 = try buildSpd(testing.allocator, spd_fake_jpeg);
    defer testing.allocator.free(v1);
    const v2 = try buildSpd(testing.allocator, "\x89PNG\r\n\x1a\n" ++ ("q" ** 40));
    defer testing.allocator.free(v2);

    const e1 = try putBytes(&f, 1, null, "drawing.spd", v1);
    defer freeEntry(e1);
    const old_md5 = dupeMd5(e1.md5.?);
    try testing.expect(f.files.thumbs.has(&old_md5));

    // Same name, new content: the replace path decrefs the old blob to 0 and
    // must take its derived thumbnail with it.
    const e2 = try putBytes(&f, 1, null, "drawing.spd", v2);
    defer freeEntry(e2);
    try testing.expect(!std.mem.eql(u8, &old_md5, e2.md5.?));
    try testing.expect(!f.files.blobs.has(&old_md5));
    try testing.expect(!f.files.thumbs.has(&old_md5));
    try testing.expect(f.files.thumbs.has(e2.md5.?)); // the new one derived
}

test "repairDerivedThumb (.spd) heals a missing row, a lost file, and a stale version — and memoizes a corrupt .spd" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const spd_bytes = try buildSpd(testing.allocator, spd_fake_jpeg);
    defer testing.allocator.free(spd_bytes);
    const e = try putBytes(&f, 1, null, "drawing.spd", spd_bytes);
    defer freeEntry(e);
    const md5 = e.md5.?;

    // 1. Row + file deleted (a pre-v13 database): repair restores BOTH.
    try f.db.exec("DELETE FROM spd_index;");
    f.files.thumbs.remove(md5);
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try spdindex.isCurrent(f.db, md5));
    try testing.expect(f.files.thumbs.has(md5));
    try testing.expect(!try spdindex.needsRepair(f.db, f.files.thumbs, md5));

    // 2. File-only loss (row current, thumbs/ gone): regenerated.
    f.files.thumbs.remove(md5);
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(f.files.thumbs.has(md5));

    // 3. Stale index_version: re-derived to the current one.
    try f.db.exec("UPDATE spd_index SET index_version = 0;");
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try spdindex.isCurrent(f.db, md5));

    // 4. The no-retry gate: a corrupt `.spd` is derived ONCE. The repair writes
    //    its `indexable = 0` row (no file), and a second look does no work.
    const bad = try putBytes(&f, 1, null, "bad.spd", "SQLite format 3\x00 then total garbage \xff\x00\xab");
    defer freeEntry(bad);
    const bad_md5 = bad.md5.?;
    try f.db.exec("DELETE FROM spd_index WHERE indexable = 0;"); // pre-v13 state for it
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, bad_md5));
    f.files.repairDerivedThumb(NoLock{}, bad_md5);
    try testing.expect(try spdindex.isCurrent(f.db, bad_md5)); // the memo row
    try testing.expect(!f.files.thumbs.has(bad_md5)); // no file was produced
    try testing.expect(!try spdindex.needsRepair(f.db, f.files.thumbs, bad_md5));
    const at = (try spdIndexedAt(&f, bad_md5)).?;
    f.files.repairDerivedThumb(NoLock{}, bad_md5); // double-check gate: a no-op
    try testing.expectEqual(at, (try spdIndexedAt(&f, bad_md5)).?);
}

// ---- `.note` cover: ingest + repair (the second format through the same seam) ----

/// The synthetic `.note` builder (parsers/note/tests), reachable in the test
/// build via the root build.zig's `note_builder` module — same as note_index's.
const nb = @import("note_builder");

/// A real minimal PNG head (320×240 IHDR) — sniffs AND yields dims.
const cover_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++
    "\x08\x02\x00\x00\x00" ++ ("p" ** 16);

/// A one-page `.note` carrying `cover` as its `COVER_2` block (null = coverless).
fn buildNote(gpa: std.mem.Allocator, cover: ?[]const u8) ![]u8 {
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
        .covers = if (cover) |c| &.{.{ .bytes = c }} else &.{},
    });
}

fn noteIndexedAt(f: *Fixture, md5: []const u8) !?i64 {
    var r = (try f.db.row("SELECT indexed_at FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = md5 }})) orelse return null;
    defer r.finalize();
    return r.int(0);
}

test "linking a .note with a cover records its location (NOT a thumbs file); a coverless one memoizes NULL and never repairs" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    // With a cover: NO thumbs file is written — the cover streams from the blob.
    // The ingest parse records its location (offset/length/mime) and dims in
    // `note_index`, and `noteCover` resolves that row into a serve plan.
    const covered = try buildNote(testing.allocator, cover_png);
    defer testing.allocator.free(covered);
    const e = try putBytes(&f, 1, null, "covered.note", covered);
    defer freeEntry(e);
    try testing.expect(!f.files.thumbs.has(e.md5.?));
    {
        var s = try f.db.prepare("SELECT cover_w, cover_h, cover_offset, cover_length, cover_mime FROM note_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, e.md5.?);
        try testing.expect(try s.step());
        try testing.expectEqual(@as(i64, 320), s.columnInt(0));
        try testing.expectEqual(@as(i64, 240), s.columnInt(1));
        try testing.expect(s.columnInt(2) > 0); // offset inside the blob
        try testing.expectEqual(@as(i64, cover_png.len), s.columnInt(3));
        try testing.expectEqualStrings("image/png", s.columnText(4));
    }
    const loc = (try f.files.noteCover(e.md5.?)).?;
    try testing.expectEqual(@as(u64, cover_png.len), loc.length);
    try testing.expectEqualStrings("image/png", loc.mime());
    // The recorded window addresses the cover verbatim in the blob.
    var rbuf: [64]u8 = undefined;
    const got = try f.files.blobs.readRange(e.md5.?, loc.offset, loc.length, rbuf[0..@intCast(loc.length)]);
    try testing.expectEqualSlices(u8, cover_png, got);
    try testing.expect(!f.files.thumbNeedsRepair(e.md5.?));

    // Coverless: no cover location, NULL dims — and, critical, NO repair
    // attempts on later serve-path gates (the memo works; the sentinel would be
    // clobbered by any re-parse's `indexed_at = now()`).
    const plain = try buildNote(testing.allocator, null);
    defer testing.allocator.free(plain);
    const p = try putBytes(&f, 1, null, "plain.note", plain);
    defer freeEntry(p);
    try testing.expect((try f.files.noteCover(p.md5.?)) == null);
    try f.db.exec("UPDATE note_index SET indexed_at = 999;");
    try testing.expect(!f.files.thumbNeedsRepair(p.md5.?));
    f.files.repairDerivedThumb(NoLock{}, p.md5.?); // gate inside: a no-op
    try testing.expectEqual(@as(?i64, 999), try noteIndexedAt(&f, p.md5.?));

    // A blob NEITHER format claims (.txt bytes) gates false without any derive.
    const txt = try putBytes(&f, 1, null, "readme.txt", "plain text, no magic");
    defer freeEntry(txt);
    try testing.expect(!f.files.thumbNeedsRepair(txt.md5.?));
}

test "repairDerivedThumb (.note) heals a stale row and a wiped row — restoring the recorded cover location, no thumbs file" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const covered = try buildNote(testing.allocator, cover_png);
    defer testing.allocator.free(covered);
    const e = try putBytes(&f, 1, null, "covered.note", covered);
    defer freeEntry(e);
    const md5 = e.md5.?;

    // A current row needs no repair, and never a thumbs file for a `.note`.
    try testing.expect(!f.files.thumbs.has(md5));
    try testing.expect(!f.files.thumbNeedsRepair(md5));

    // 1. A stale, pre-cover-location row: re-derived to the current version,
    // regaining its recorded cover location (no thumbs file is ever written).
    try f.db.exec("UPDATE note_index SET index_version = 3, cover_w = NULL, cover_h = NULL, " ++
        "cover_offset = NULL, cover_length = NULL, cover_mime = NULL;");
    try testing.expect(f.files.thumbNeedsRepair(md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try noteindex.isCurrent(f.db, md5));
    try testing.expect(!f.files.thumbs.has(md5)); // still no derived file
    try testing.expect((try f.files.noteCover(md5)) != null); // location restored

    // 2. Row wiped entirely (a pre-index blob): repair restores the row + its
    // cover location. Segment rows are derived too; their FK deliberately blocks
    // deleting pages from under them, so wipe them first (see note_index tests).
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('delete-all');");
    try f.db.exec("DELETE FROM segment_search;");
    try f.db.exec("DELETE FROM note_index;");
    try testing.expect(f.files.thumbNeedsRepair(md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try noteindex.isCurrent(f.db, md5));
    try testing.expect((try f.files.noteCover(md5)) != null);
}

test "purging the last reference removes the .note cover file along with the blob" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const covered = try buildNote(testing.allocator, cover_png);
    defer testing.allocator.free(covered);
    const e = try putBytes(&f, 1, null, "covered.note", covered);
    defer freeEntry(e);
    const md5 = dupeMd5(e.md5.?);

    try f.files.trash(1, e.id);
    try f.files.purge(1, e.id);
    try testing.expect(!try noteindex.isCurrent(f.db, &md5)); // row released in the txn
    try testing.expect(!f.files.blobs.has(&md5)); // blob GC'd post-commit
    try testing.expect(!f.files.thumbs.has(&md5)); // and its derived cover with it
}

// ---- move / rename (the device's move_v3 primitive) ----

/// A one-page `.note` whose page carries `labels` as FINISHED recognition — a
/// blob the note indexer parses AND makes searchable. Mirrors note_search's own
/// `putNote`, so the search-still-finds test exercises the real ingest path.
fn putSearchNote(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, labels: []const []const u8) !Entry {
    const bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
        .recogn_status = 1,
        .recogn_labels = labels,
    }} });
    defer testing.allocator.free(bytes);
    var r = std.Io.Reader.fixed(bytes);
    return f.files.putFile(user_id, parent, name, &r, null);
}

test "move renames in place and relocates between folders, bumping sync each time" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer freeEntry(notes);
    const docs = try f.files.createFolder(1, null, "Docs");
    defer freeEntry(docs);
    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);

    // RENAME in place: same parent, new final component. Same row, new name.
    const v0 = try f.files.syncVersion(1);
    {
        const moved = try f.files.move(1, a.id, notes.id, "b.note", false);
        defer freeEntry(moved);
        try testing.expectEqual(a.id, moved.id);
        try testing.expectEqual(notes.id, moved.parent_id.?);
        try testing.expectEqualStrings("b.note", moved.name);
    }
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Notes/b.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Notes/a.note"));
    try testing.expect(try f.files.syncVersion(1) > v0);

    // MOVE to another existing folder: different parent, same operation.
    const v1 = try f.files.syncVersion(1);
    {
        const moved = try f.files.move(1, a.id, docs.id, "b.note", false);
        defer freeEntry(moved);
        try testing.expectEqual(docs.id, moved.parent_id.?);
    }
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Docs/b.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Notes/b.note"));
    try testing.expect(try f.files.syncVersion(1) > v1);

    // MOVE to the root (null parent).
    {
        const moved = try f.files.move(1, a.id, null, "b.note", false);
        defer freeEntry(moved);
        try testing.expectEqual(@as(?u64, null), moved.parent_id);
    }
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/b.note"));
}

test "move of a FOLDER carries its whole subtree — every descendant's path follows in one txn" {
    var f = try Fixture.init();
    defer f.deinit();

    // /Src/inner/deep.note, /Src/top.note, and a separate /Dst.
    const src = try f.files.createFolder(1, null, "Src");
    defer freeEntry(src);
    const inner = try f.files.createFolder(1, src.id, "inner");
    defer freeEntry(inner);
    const deep = try putBytes(&f, 1, inner.id, "deep.note", "dddd");
    defer freeEntry(deep);
    const top = try putBytes(&f, 1, src.id, "top.note", "tttt");
    defer freeEntry(top);
    const dst = try f.files.createFolder(1, null, "Dst");
    defer freeEntry(dst);

    // Reparent the folder Src under Dst. The tree is an adjacency list, so the one
    // UPDATE on Src's row moves the entire subtree — nothing per-descendant is
    // rewritten, and it commits atomically.
    {
        const moved = try f.files.move(1, src.id, dst.id, "Src", false);
        defer freeEntry(moved);
        try testing.expectEqual(dst.id, moved.parent_id.?);
    }

    // Every descendant resolves under the NEW prefix, and NONE under the old one.
    try testing.expectEqual(@as(?u64, src.id), try f.files.resolvePath(1, "/Dst/Src"));
    try testing.expectEqual(@as(?u64, inner.id), try f.files.resolvePath(1, "/Dst/Src/inner"));
    try testing.expectEqual(@as(?u64, deep.id), try f.files.resolvePath(1, "/Dst/Src/inner/deep.note"));
    try testing.expectEqual(@as(?u64, top.id), try f.files.resolvePath(1, "/Dst/Src/top.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Src"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Src/inner/deep.note"));

    // The path derived bottom-up (pathOf) agrees — proof the descendant "moved"
    // purely by its ancestor chain changing.
    const deep_path = try f.files.pathOf(testing.allocator, 1, deep.id);
    defer testing.allocator.free(deep_path);
    try testing.expectEqualStrings("/Dst/Src/inner/deep.note", deep_path);
}

test "move name conflict: autorename=false refuses without clobbering; autorename=true suffixes" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer freeEntry(notes);
    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);
    const b = try putBytes(&f, 1, notes.id, "b.note", "bbbb");
    defer freeEntry(b);

    // autorename=false onto a name a DIFFERENT live sibling holds → NameConflict,
    // and nothing moves: neither the mover nor the occupant is touched (no clobber).
    try testing.expectError(error.NameConflict, f.files.move(1, a.id, notes.id, "b.note", false));
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Notes/a.note"));
    try testing.expectEqual(@as(?u64, b.id), try f.files.resolvePath(1, "/Notes/b.note"));

    // autorename=true → the mover takes the next free " (n)" name, occupant intact.
    {
        const moved = try f.files.move(1, a.id, notes.id, "b.note", true);
        defer freeEntry(moved);
        try testing.expectEqualStrings("b (2).note", moved.name);
    }
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Notes/b (2).note"));
    try testing.expectEqual(@as(?u64, b.id), try f.files.resolvePath(1, "/Notes/b.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Notes/a.note"));
}

test "move is a clean no-op when the target is the row's own current parent+name" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer freeEntry(notes);
    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);

    const v0 = try f.files.syncVersion(1);
    const moved = try f.files.move(1, a.id, notes.id, "a.note", false);
    defer freeEntry(moved);
    try testing.expectEqual(a.id, moved.id);
    try testing.expectEqualStrings("a.note", moved.name);
    // A no-op is not a mutation: the sync-version must not move (else every cached
    // browser listing would be needlessly invalidated).
    try testing.expectEqual(v0, try f.files.syncVersion(1));
}

test "move is user-scoped: an unknown id and a foreign id are both NotFound, and nothing crosses accounts" {
    var f = try Fixture.init();
    defer f.deinit();

    const a = try putBytes(&f, 1, null, "mine.note", "aaaa");
    defer freeEntry(a);
    const bob = try putBytes(&f, 2, null, "bob.note", "bbbb");
    defer freeEntry(bob);

    // Absent id → NotFound (the handler turns this into an idempotent success).
    try testing.expectError(error.NotFound, f.files.move(1, 999_999, null, "x.note", false));

    // Bob's id, moved as user 1 → NotFound (user-scoped), and Bob's file is
    // untouched: same id, same name, still his. No cross-user move, no oracle.
    try testing.expectError(error.NotFound, f.files.move(1, bob.id, null, "stolen.note", false));
    const still = (try f.files.get(2, bob.id)).?;
    defer freeEntry(still);
    try testing.expectEqualStrings("bob.note", still.name);
    try testing.expect((try f.files.get(1, bob.id)) == null); // invisible to user 1
}

test "move refuses to send a folder into its own subtree (or into itself)" {
    var f = try Fixture.init();
    defer f.deinit();

    const parent = try f.files.createFolder(1, null, "Parent");
    defer freeEntry(parent);
    const child = try f.files.createFolder(1, parent.id, "Child");
    defer freeEntry(child);

    // Into a descendant, and into itself — both would orphan the subtree.
    try testing.expectError(error.InvalidMove, f.files.move(1, parent.id, child.id, "Parent", false));
    try testing.expectError(error.InvalidMove, f.files.move(1, parent.id, parent.id, "Parent", false));

    // The tree is intact.
    try testing.expectEqual(@as(?u64, parent.id), try f.files.resolvePath(1, "/Parent"));
    try testing.expectEqual(@as(?u64, child.id), try f.files.resolvePath(1, "/Parent/Child"));
}

test "SEARCH-NEUTRALITY: a renamed + relocated note leaves the blob-keyed index untouched" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const note = try putSearchNote(&f, 1, null, "orig.note", &.{"quarterly roadmap review"});
    defer freeEntry(note);

    // Record the index size so we can prove the move never touched it. That the
    // renamed note is still FOUND end-to-end is proven in http_integration's
    // "device move_v3 … stays searchable" test — `files.zig` cannot import the
    // search READ module (`search/query.zig`) without a cycle (query already
    // imports files), and index-neutrality is the property that belongs here.
    const seg_before = blk: {
        var s = try f.db.prepare("SELECT COUNT(*) FROM segment_search;");
        defer s.finalize();
        _ = try s.step();
        break :blk s.columnInt(0);
    };

    // RENAME it AND relocate it into a freshly-created folder — the exact device
    // move that once 404'd. The blob (and its md5-keyed index) is untouched.
    const archive = try f.files.createFolder(1, null, "Archive");
    defer freeEntry(archive);
    {
        const moved = try f.files.move(1, note.id, archive.id, "renamed.note", false);
        defer freeEntry(moved);
        try testing.expectEqualStrings("renamed.note", moved.name);
    }
    try testing.expectEqual(@as(?u64, note.id), try f.files.resolvePath(1, "/Archive/renamed.note"));

    // The proof it was neutral: the segment index has exactly the rows it had
    // before the move — nothing reindexed, nothing dropped (the index is keyed by
    // the blob's md5 + partition, not by path).
    const seg_after = blk: {
        var s = try f.db.prepare("SELECT COUNT(*) FROM segment_search;");
        defer s.finalize();
        _ = try s.step();
        break :blk s.columnInt(0);
    };
    try testing.expectEqual(seg_before, seg_after);
}
