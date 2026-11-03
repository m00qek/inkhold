//! The file-tree service over `files`/`blobs`/`capacity` and the blob store.
//! Owns the storage invariants: every operation scoped by `user_id`, blob
//! refcounts, per-user quota, two-stage delete via the recycle bin. This file
//! holds the tree reads and writes and the blob refcounts; the bin, uploads,
//! quota, history and thumbnail repair live in `files/`.

const std = @import("std");
const config = @import("../config.zig");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const derivedstore = @import("../store/derived.zig");
const derivesearch = @import("derive_search.zig");
const noteindex = @import("note_index.zig");
const thumbnail = @import("thumbnail.zig");
const spdindex = @import("spd_index.zig");
const deferredmod = @import("deferred.zig");
const markpair = @import("mark_pairing.zig");
const internal = @import("files/internal.zig");
const bin = @import("files/bin.zig");
const uploads = @import("files/uploads.zig");
const quota = @import("files/quota.zig");
const history = @import("files/history.zig");
const thumb_repair = @import("files/thumb_repair.zig");
const walk = @import("files/walk.zig");
const link = @import("files/link.zig");
const relocate = @import("files/relocate.zig");

pub const md5_len = blobstore.md5_hex_len;
const log = std.log.scoped(.files);

pub const Entry = struct {
    id: u64,
    parent_id: ?u64,
    name: []const u8, // owned
    is_folder: bool,
    md5: ?[]const u8, // owned; null for folders
    size: u64,
    updated_at: i64,
    /// The live `.mark` paired with this row, resolved inside the reading query.
    /// Always NULL on trashed reads (live ink must not composite onto a deleted
    /// document). Not defaulted, so every producer must say.
    mark_id: ?u64,
};

/// One retained version (`file_history` row). Retention keeps its blob and
/// `note_index`, so nothing needs a re-parse. `md5` is an inline copy.
pub const HistoryVersion = struct {
    md5: [md5_len]u8,
    size: u64,
    created_at: i64,
};

/// Which `files.deleted` state a history read is gated to: live routes, or the
/// bin's view-only twins.
pub const HistoryScope = enum {
    live,
    trashed,

    pub fn deletedFlag(self: HistoryScope) i64 {
        return switch (self) {
            .live => 0,
            .trashed => 1,
        };
    }
};

/// A device-walk entry: `path_display` (leading slash, no trailing) and
/// `parent_path` ("/" at root). Slices owned by the producer's allocator.
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

/// A bin listing row; slices owned by `listBin`'s allocator. `path` is the path
/// at deletion time, frozen into `files.deleted_path` by `trash`.
pub const BinEntry = struct {
    id: u64,
    parent_id: ?u64,
    name: []const u8,
    is_folder: bool,
    md5: ?[]const u8, // null for folders and for a row with no blob
    size: u64, // 0 for folders
    deleted_at: i64,
    path: []const u8,
    /// Top of a trashed subtree (parent is root or live). Computed here because
    /// the client never sees live parents in the bin listing.
    is_root: bool,
};

/// An in-flight device upload keyed by `inner_name`; slices owned by the caller.
pub const UploadSession = struct {
    path: []const u8, // destination folder (no trailing slash; "/" = root)
    file_name: []const u8,
    declared_size: u64,
    blob_md5: ?[]const u8, // null until /oss/put has stored the bytes
    /// Bytes staged over distinct parts, so the `/oss/put` cap is per session.
    received_bytes: u64,
};

pub const Files = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    /// `thumbs/<source_md5>`; cleaned up by `removeBlobFiles`.
    thumbs: thumbstore.ThumbStore,
    /// `terms/<md5>.<v>` and `text/<md5>.<v>`. Null means "keep none", not an
    /// error. Cleaned up by `removeBlobFiles`.
    terms: ?derivedstore.DerivedStore = null,
    text: ?derivedstore.DerivedStore = null,
    /// Single-flight gate for `repairDerivedThumb`, so a burst of missing-thumbnail
    /// GETs runs one derive at a time (RSS). Lock order: this first, `db_lock`
    /// second; neither is reentrant.
    thumb_repair: std.Io.Mutex = .init,
    /// Worker to wake after a commit; advisory, the idle tick catches a miss.
    deferred: ?*deferredmod.Worker = null,

    /// Versioning bounds; overwritten from `Config.history`. `keep = 0` disables
    /// versioning.
    history: config.History = .{},

    /// Set on a `readerView`. The connection refuses DB writes; this guards the
    /// one mutation outside the database.
    read_only: bool = false,

    const assertFolder = internal.assertFolder;
    const ensureBlobRow = internal.ensureBlobRow;
    const incref = internal.incref;

    pub fn init(gpa: std.mem.Allocator, io: std.Io, db: sqlite.Db, blobs: blobstore.BlobStore, thumbs: thumbstore.ThumbStore) Files {
        return .{ .gpa = gpa, .io = io, .db = db, .blobs = blobs, .thumbs = thumbs };
    }

    /// A copy bound to one request's pooled read-only connection. Drops the
    /// worker wake (a write), and re-inits `thumb_repair` because copying a
    /// held mutex would copy it locked.
    pub fn readerView(self: *const Files, db: sqlite.Db) Files {
        var v = self.*;
        v.db = db;
        v.read_only = true;
        v.deferred = null;
        v.thumb_repair = .init;
        return v;
    }

    // ---- reads ----

    /// `id` is the partner's row. Names are anchored on the document: the mark's
    /// name is the document's plus `.mark`.
    pub const Paired = struct { id: u64, entry_is_mark: bool };

    /// The live `.mark` beside `name` in `parent_id`, or null. Exposed for
    /// `annotationsId`, which needs it for a content-verified PDF without the extension.
    pub fn liveMarkIdFor(self: Files, user_id: u64, parent_id: ?u64, name: []const u8) !?u64 {
        var s = try self.db.prepare(
            "SELECT id FROM files WHERE user_id = ?1 AND COALESCE(parent_id, 0) = COALESCE(?2, 0) " ++
                "AND name = ?3 || '" ++ markpair.mark_ext ++ "' AND is_folder = 0 AND deleted = 0;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        internal.bindOpt(s, 2, parent_id);
        s.bindText(3, name);
        if (!try s.step()) return null;
        return @intCast(s.columnInt(0));
    }

    /// Live entries directly under `parent_id` (null = root). Free via `freeEntries`.
    pub fn list(self: Files, user_id: u64, parent_id: ?u64) ![]Entry {
        var out: std.ArrayList(Entry) = .empty;
        errdefer freeList(self.gpa, &out);

        var s = try self.db.prepare(
            "SELECT f.id, f.parent_id, f.name, f.is_folder, f.md5, f.size, f.updated_at, " ++
                internal.paired_mark_id ++
                " FROM files f " ++
                "WHERE f.user_id = ?1 AND COALESCE(f.parent_id, 0) = COALESCE(?2, 0) AND f.deleted = 0 " ++
                internal.hide_paired_mark ++
                " ORDER BY f.is_folder DESC, f.name;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        internal.bindOpt(s, 2, parent_id);
        while (try s.step()) try out.append(self.gpa, try self.rowToEntry(&s));
        return out.toOwnedSlice(self.gpa);
    }

    /// Live direct children of any kind ("items", not notes). Trashed rows never
    /// count. One index range over `files_user_parent`.
    pub fn childCount(self: Files, user_id: u64, folder_id: u64) !i64 {
        var r = (try self.db.row(
            "SELECT COUNT(*) FROM files f WHERE f.user_id = ?1 AND f.parent_id = ?2 AND f.deleted = 0" ++
                internal.hide_paired_mark ++ ";",
            &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(folder_id) } },
        )) orelse return 0;
        defer r.finalize();
        return r.int(0);
    }

    /// Monotonic per-user counter bumped on every tree change; 0 with no row.
    pub fn syncVersion(self: Files, user_id: u64) !i64 {
        var r = (try self.db.row("SELECT version FROM sync_state WHERE user_id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return 0;
        defer r.finalize();
        return r.int(0);
    }

    /// One live entry by id (scoped to `user_id`), or null.
    pub fn get(self: Files, user_id: u64, id: u64) !?Entry {
        var r = (try self.db.row(
            "SELECT f.id, f.parent_id, f.name, f.is_folder, f.md5, f.size, f.updated_at, " ++
                // Live, so it carries its ink: rename/move/upload responses are built from it.
                internal.paired_mark_id ++
                " FROM files f WHERE f.id = ?1 AND f.user_id = ?2 AND f.deleted = 0;",
            &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
        )) orelse return null;
        defer r.finalize();
        return try self.rowToEntry(&r.stmt);
    }

    /// One trashed entry, for bin previews only. Kept separate from the
    /// state-blind `getAnyState`, and `get` is never relaxed. Foreign, missing and
    /// live ids all read as null.
    pub fn getTrashed(self: Files, user_id: u64, id: u64) !?Entry {
        var r = (try self.db.row(
            // NULL, not `pairedMarkId`: the mark it would find is live.
            "SELECT f.id, f.parent_id, f.name, f.is_folder, f.md5, f.size, f.updated_at, NULL " ++
                "FROM files f WHERE f.id = ?1 AND f.user_id = ?2 AND f.deleted = 1;",
            &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
        )) orelse return null;
        defer r.finalize();
        return try self.rowToEntry(&r.stmt);
    }

    /// One entry in either state, for the bin's own paths and the device delete
    /// retry. Not a general read path: `get` is the ownership boundary for reads.
    pub fn getAnyState(self: Files, user_id: u64, id: u64) !?Entry {
        var r = (try self.db.row(
            // NULL: a state-blind read cannot scope a mark id.
            "SELECT f.id, f.parent_id, f.name, f.is_folder, f.md5, f.size, f.updated_at, NULL " ++
                "FROM files f WHERE f.id = ?1 AND f.user_id = ?2;",
            &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
        )) orelse return null;
        defer r.finalize();
        return try self.rowToEntry(&r.stmt);
    }

    // ---- writes ----

    /// Errors: NotFound / NotAFolder (bad parent), NameConflict.
    pub fn createFolder(self: Files, user_id: u64, parent_id: ?u64, name: []const u8) !Entry {
        try self.assertFolder(user_id, parent_id);
        if (try internal.liveChild(self, user_id, parent_id, name) != null) return error.NameConflict;

        const ts = internal.now(
            self,
        );
        var s = try self.db.prepare(
            "INSERT INTO files(user_id, parent_id, name, is_folder, created_at, updated_at) VALUES(?1,?2,?3,1,?4,?4);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        internal.bindOpt(s, 2, parent_id);
        s.bindText(3, name);
        s.bindInt(4, ts);
        _ = try s.step();
        const new_id = self.db.lastInsertRowId();
        try internal.bumpSync(self, user_id);
        return .{
            .id = @intCast(new_id),
            .parent_id = parent_id,
            .name = try self.gpa.dupe(u8, name),
            .is_folder = true,
            .md5 = null,
            .size = 0,
            .updated_at = ts,
            .mark_id = null, // a folder is never half of a pair
        };
    }

    /// Idempotently creates a `/`-separated folder path; returns the leaf id. A
    /// segment that is a file is NameConflict.
    pub fn ensureFolderPath(self: Files, user_id: u64, path: []const u8) !u64 {
        var parent: ?u64 = null;
        var leaf: ?u64 = null;
        var it = std.mem.tokenizeScalar(u8, path, '/');
        while (it.next()) |seg| {
            if (try internal.liveChild(self, user_id, parent, seg)) |c| {
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

    /// Creates the last segment of `path` as a folder, ancestors idempotently
    /// (device `create_folder_v2`). `autorename` governs the leaf only: false
    /// returns an existing folder unchanged (retries converge) and refuses a file;
    /// true takes `bin.freeName`'s ` (n)` form. Caller frees `.name`.
    pub fn createFolderPath(self: Files, user_id: u64, path: []const u8, autorename: bool) !Entry {
        var parent: ?u64 = null;
        var it = std.mem.tokenizeScalar(u8, path, '/');
        var name = it.next() orelse return error.NotFound; // "" / "/" name nothing

        while (it.next()) |next_seg| {
            if (try internal.liveChild(self, user_id, parent, name)) |c| {
                if (!c.is_folder) return error.NameConflict;
                parent = c.id;
            } else {
                const e = try self.createFolder(user_id, parent, name);
                self.gpa.free(e.name); // only the id is needed while descending
                parent = e.id;
            }
            name = next_seg;
        }

        if (try internal.liveChild(self, user_id, parent, name)) |c| {
            if (!autorename) {
                if (!c.is_folder) return error.NameConflict;
                return (try self.get(user_id, c.id)) orelse error.NotFound;
            }
            const final = try bin.freeName(self, user_id, parent, name, null);
            defer self.gpa.free(final);
            return self.createFolder(user_id, parent, final);
        }
        return self.createFolder(user_id, parent, name);
    }

    /// The user's file rows (trashed included) referencing `md5`. Backs `holdsBlob`
    /// only; quota uses `userChargedRefs`.
    fn userBlobRefs(self: Files, user_id: u64, md5: []const u8) !u64 {
        var r = (try self.db.row(
            "SELECT COUNT(*) FROM files WHERE user_id = ?1 AND is_folder = 0 AND md5 = ?2;",
            &.{ .{ .int = @intCast(user_id) }, .{ .text = md5 } },
        )) orelse return 0;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// Whether the user holds any file (live or trashed) on blob `md5`: the
    /// ownership gate for content-keyed reads like `/thumbnail/{hash}`. A
    /// non-holder gets the same answer as a missing hash (no existence oracle).
    pub fn holdsBlob(self: Files, user_id: u64, md5: []const u8) !bool {
        return (try self.userBlobRefs(user_id, md5)) > 0;
    }

    /// Whether the user can reach blob `md5` as a live, trashed or retained
    /// version of their file: the gate for `/api/controlplane/text/{md5}`. That set
    /// is exactly `userChargedRefs` (what is charged is what is reachable). False
    /// is a 404 indistinguishable from "not derived".
    pub fn reachesBlob(self: Files, user_id: u64, md5: []const u8) !bool {
        if (md5.len != md5_len) return false;
        return (try internal.userChargedRefs(self, user_id, md5)) > 0;
    }

    pub const Child = struct { id: u64, is_folder: bool, md5: [md5_len]u8, size: u64 };

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
            // Column 7: `pairedMarkId` on live reads, literal NULL on trashed/state-blind ones.
            .mark_id = if (s.columnIntOpt(7)) |mid| @intCast(mid) else null,
        };
    }

    pub fn freeEntries(gpa: std.mem.Allocator, entries: []Entry) void {
        for (entries) |e| {
            gpa.free(e.name);
            if (e.md5) |m| gpa.free(m);
        }
        gpa.free(entries);
    }

    pub const bin_retention_s = bin.bin_retention_s;
    // The rest of the API, one concern per file under `files/`.
    pub const listBin = bin.listBin;
    pub const liveSubtreeCount = bin.liveSubtreeCount;
    pub const trash = bin.trash;
    pub const Restored = bin.Restored;
    pub const restore = bin.restore;
    pub const purge = bin.purge;
    pub const emptyBin = bin.emptyBin;
    pub const sweepBin = bin.sweepBin;
    pub const sweepBinBefore = bin.sweepBinBefore;
    pub const purgeUser = bin.purgeUser;

    pub const createUploadSession = uploads.createUploadSession;
    pub const setUploadBlob = uploads.setUploadBlob;
    pub const addUploadReceived = uploads.addUploadReceived;
    pub const uploadSession = uploads.uploadSession;
    pub const deleteUploadSession = uploads.deleteUploadSession;
    pub const sweepUploadSessions = uploads.sweepUploadSessions;

    pub const Cap = quota.Cap;
    pub const default_total_bytes = quota.default_total_bytes;
    pub const capacity = quota.capacity;
    pub const StorageBreakdown = quota.StorageBreakdown;
    pub const storageBreakdown = quota.storageBreakdown;

    pub const VersionPolicy = history.VersionPolicy;
    pub const versionPolicy = history.versionPolicy;
    pub const retainedPerFile = history.retainedPerFile;
    pub const VersionPolicyChange = history.VersionPolicyChange;
    pub const setVersionPolicy = history.setVersionPolicy;
    pub const fileHistory = history.fileHistory;
    pub const fileHistoryIn = history.fileHistoryIn;
    pub const historyVersion = history.historyVersion;
    pub const historyVersionIn = history.historyVersionIn;
    pub const restoreVersion = history.restoreVersion;

    pub const thumbNeedsRepair = thumb_repair.thumbNeedsRepair;
    pub const thumbnailSourceKind = thumb_repair.thumbnailSourceKind;
    pub const noteCover = thumb_repair.noteCover;
    pub const repairDerivedThumb = thumb_repair.repairDerivedThumb;

    const tree_walk_sql = walk.tree_walk_sql;
    const subtree_walk_sql = walk.subtree_walk_sql;
    pub const walkTree = walk.walkTree;
    const treeNodeFromWalkRow = walk.treeNodeFromWalkRow;
    pub const walkChildren = walk.walkChildren;
    pub const walkSubtree = walk.walkSubtree;
    pub const nodeById = walk.nodeById;
    pub const resolvePath = walk.resolvePath;
    pub const wouldFit = walk.wouldFit;
    pub const pathOf = walk.pathOf;

    pub const putFile = link.putFile;
    pub const linkBlob = link.linkBlob;
    pub const linkBlobIndexed = link.linkBlobIndexed;
    const writeNoteDerived = link.writeNoteDerived;
    pub const placeUpload = link.placeUpload;

    pub const move = relocate.move;
    pub const copy = relocate.copy;
    const wouldCycle = relocate.wouldCycle;
};

fn freeList(gpa: std.mem.Allocator, list: *std.ArrayList(Entry)) void {
    for (list.items) |e| {
        gpa.free(e.name);
        if (e.md5) |m| gpa.free(m);
    }
    list.deinit(gpa);
}

test {
    _ = @import("files/tree_test.zig");
    _ = @import("files/history_test.zig");
    _ = @import("files/quota_test.zig");
    _ = @import("files/uploads_test.zig");
    _ = @import("files/bin_test.zig");
    _ = @import("files/bin_list_test.zig");
    _ = @import("files/derive_test.zig");
    _ = @import("files/move_test.zig");
    _ = @import("files/marks_test.zig");
    _ = @import("files/marks_move_test.zig");
    _ = @import("files/marks_rule_test.zig");
}
