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

    /// `tree_walk_sql` re-rooted at a folder: strict descendants only.
    /// ?1 = user_id, ?2 = root_path (non-root), ?3 = root_id.
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

    /// The user's whole live tree with paths, accumulated top-down in one recursive
    /// CTE. Allocated in `alloc` (an arena). Folder md5 surfaces as "".
    pub fn walkTree(self: Files, alloc: std.mem.Allocator, user_id: u64) ![]TreeNode {
        var out: std.ArrayList(TreeNode) = .empty;
        var s = try self.db.prepare(tree_walk_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        while (try s.step()) try out.append(alloc, try treeNodeFromWalkRow(alloc, &s));
        return out.toOwnedSlice(alloc);
    }

    /// Both walk statements select the same 8 columns.
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

    /// Direct children of `parent_id` in `walkTree`'s shape: O(folder), for the
    /// non-recursive `list_folder`. `parent_path` is "/" or leading-slash, no
    /// trailing. Ordered by name. Slices owned by `alloc`.
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
        internal.bindOpt(s, 2, parent_id);
        while (try s.step()) {
            const name = try alloc.dupe(u8, s.columnText(1));
            // Root → "/name", nested → "parent/name".
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

    /// Strict descendants of `root_id` (O(subtree)), for recursive `list_folder` on
    /// a named folder. `root_path` must be non-root. Slices owned by `alloc`.
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

    /// A single `TreeNode` for `id`, or null if absent/foreign. Slices owned by `alloc`.
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

    /// Live entry id for a Dropbox-format path, read-only. Root or a missing
    /// segment → null.
    pub fn resolvePath(self: Files, user_id: u64, path: []const u8) !?u64 {
        var parent: ?u64 = null;
        var found: ?u64 = null;
        var it = std.mem.tokenizeScalar(u8, path, '/');
        while (it.next()) |seg| {
            const c = (try internal.liveChild(self, user_id, parent, seg)) orelse return null;
            parent = c.id;
            found = c.id;
        }
        return found;
    }

    /// Whether `size` more bytes fit the quota (upload/apply pre-check). Compares
    /// remaining headroom in u64, so a hostile u64-max `size` cannot overflow.
    pub fn wouldFit(self: Files, user_id: u64, size: u64) !bool {
        const cap = try self.capacity(user_id);
        if (cap.total <= cap.used) return size == 0; // already at/over quota
        const remaining: u64 = @intCast(cap.total - cap.used);
        return size <= remaining;
    }

    /// Full path by walking `parent_id` to the root, e.g. `/NOTE/Note/foo.note`.
    /// Owned by `gpa`. One query per ancestor; for a single path only.
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

    /// Streams `reader` into the blob store and links it, replacing a live file of
    /// that name. Enforces quota.
    pub fn putFile(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, reader: *std.Io.Reader, expected_md5: ?[]const u8) !Entry {
        try self.assertFolder(user_id, parent_id);

        const res = try self.blobs.put(reader, expected_md5);
        // Not a dedup: drop the blob and the thumbnail its indexing wrote.
        errdefer if (!res.deduped) internal.removeBlobFiles(self, &res.md5);

        return self.linkBlob(user_id, parent_id, name, &res.md5, res.size);
    }

    /// Links an already-stored blob (device `upload/finish`), replacing a live
    /// file of that name, in one transaction. On failure the on-disk blob is left
    /// untouched for the sweep; this never removes blobs.
    pub fn linkBlob(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, md5: []const u8, size: u64) !Entry {
        return self.linkBlobIndexed(user_id, parent_id, name, md5, size, null);
    }

    /// `linkBlob` with the `.note` index pre-parsed, so the multi-MB parse can run
    /// outside the transaction (and the global lock). Rows are still written
    /// inside it, so an index never outlives a rolled-back link.
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

        // ---- parse outside the transaction ----
        var owned: ?noteindex.Parsed = null;
        defer if (owned) |*p| p.deinit();
        var parsed: ?*const noteindex.Parsed = pre_parsed;
        if (parsed == null and !try noteindex.isCurrent(self.db, md5)) {
            owned = noteindex.parseStoredBlob(self.gpa, self.io, self.blobs, md5) catch null;
            if (owned) |*p| parsed = p;
        }

        // ---- `.spd` index + thumbnail, outside the transaction ----
        // An untrusted SQLite DB, opened read-only in memory once. Gated on the name
        // and `isCurrent`; any failure means no row, never a failed upload.
        var spd_derived: ?spdindex.Derived = null;
        defer if (spd_derived) |*d| d.deinit();
        if (thumbnail.wantsSpd(name) and !(spdindex.isCurrent(self.db, md5) catch false)) {
            spd_derived = spdindex.deriveStored(self.gpa, self.blobs, md5) catch null;
        }

        // `.txt` (and other) derives belong to `services/deferred.zig`; the worker is
        // signalled after COMMIT below.

        // Thumbnail before the commit (a crash can only orphan a regenerable file).
        // A `.note` cover is not copied: the serve path streams it from the blob.
        if (spd_derived) |d| {
            if (d.thumb) |t| self.thumbs.put(md5, t.bytes) catch {};
        }

        // `.note` derived files, eagerly and outside the transaction: the text is
        // already in the container and the parse was needed anyway. Best-effort.
        if (parsed) |p| self.writeNoteDerived(md5, p) catch |e| {
            log.warn("terms/text write failed for {s}: {t}", .{ md5, e });
        };

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        try self.ensureBlobRow(md5, size);

        const existing = try internal.liveChild(self, user_id, parent_id, name);
        if (existing) |e| if (e.is_folder) return error.NameConflict;

        const old_md5: ?[md5_len]u8 = if (existing) |e| e.md5 else null;
        const same_content = if (old_md5) |om| std.mem.eql(u8, &om, md5) else false;

        // ---- reference counts, read before any row write ----
        // Quota follows anything keeping bytes on disk, incl. `file_history`.
        var new_charge = false;
        if (!same_content) new_charge = try internal.userChargedRefs(self, user_id, md5) == 0;

        var file_id: u64 = undefined;
        const ts = internal.now(
            self,
        );

        // Rolls back with the link.
        if (parsed) |p| try noteindex.store(self.db, md5, p.*, ts);

        // Best-effort: a missing row is re-derived on demand.
        if (spd_derived) |d| spdindex.store(self.db, md5, d, ts) catch {};

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
            internal.bindOpt(s, 2, parent_id);
            s.bindText(3, name);
            s.bindText(4, md5);
            s.bindInt(5, @intCast(size));
            s.bindInt(6, ts);
            _ = try s.step();
            file_id = @intCast(self.db.lastInsertRowId());
        }

        if (!same_content) try self.incref(md5);

        try internal.bumpSync(self, user_id); // an upload/replace changed the tree

        // Retain on supersede: write the history row before the decref, so the GC gate
        // keeps the blob. Refcount drops but the charge stays. `keep == 0` prunes and
        // refunds. `evicted` lets settlement give back exactly what left.
        const keep = (try self.versionPolicy(user_id)).keep;
        var gc_old = false;
        var gc_hist: std.ArrayList([md5_len]u8) = .empty;
        defer gc_hist.deinit(self.gpa);
        var evicted: std.ArrayList(history.Evicted) = .empty;
        defer evicted.deinit(self.gpa);
        if (old_md5) |om| {
            if (!same_content) {
                if (keep > 0) try history.recordHistory(self, file_id, &om, existing.?.size, ts);
                gc_old = try internal.decref(self, &om);
                // K per file, then the global max_bytes ceiling.
                if (keep > 0) try history.evictHistory(self, user_id, file_id, keep, &gc_hist, &evicted);
            }
        }

        // ---- quota settlement, from the rows as they are now ----
        // Eviction may drop the version just recorded, so nothing is predicted.
        var settled: std.ArrayList([md5_len]u8) = .empty;
        defer settled.deinit(self.gpa);
        var delta: i64 = if (new_charge) @as(i64, @intCast(size)) else 0;
        if (old_md5) |om| {
            if (!same_content) try internal.settleRefund(self, user_id, &om, @intCast(existing.?.size), &settled, &delta);
        }
        for (evicted.items) |*e| try internal.settleRefund(self, user_id, &e.md5, e.size, &settled, &delta);

        // Never refuse an edit for the version it displaced: evict the user's oldest
        // versions until it fits, and refuse only when live files alone do not.
        // Bounded: each pass deletes one row whose blob no live file holds.
        const cap = try self.capacity(user_id);
        while (cap.used + delta > cap.total) {
            const dropped = (try history.evictOldestVersion(self, user_id, &gc_hist)) orelse break;
            try internal.settleRefund(self, user_id, &dropped.md5, dropped.size, &settled, &delta);
        }
        if (cap.used + delta > cap.total) return error.QuotaExceeded; // errdefer rolls back
        try internal.addUsed(self, user_id, delta);

        try self.db.exec("COMMIT;");
        // After commit, or the worker may find nothing and sleep.
        if (self.deferred) |w| w.signal();
        if (gc_old) internal.removeBlobFiles(self, &old_md5.?);
        for (gc_hist.items) |*m| internal.removeBlobFiles(self, m);

        return .{
            .id = file_id,
            .parent_id = parent_id,
            .name = try self.gpa.dupe(u8, name),
            .is_folder = false,
            .md5 = try self.gpa.dupe(u8, md5),
            .size = size,
            .updated_at = ts,
            // The upload response is a listing row; the `.mark` often arrives first.
            .mark_id = try self.liveMarkIdFor(user_id, parent_id, name),
        };
    }

    /// Derived files for one `.note`. Gated on `indexable`: non-notes parse to an
    /// empty `Parsed`, and an empty file would mark them derived for ever.
    fn writeNoteDerived(self: Files, md5: []const u8, p: *const noteindex.Parsed) !void {
        if (!p.indexable) return;
        // Null store: nothing to write.
        const terms_store = self.terms orelse return;
        const text_store = self.text orelse return;
        var src = noteindex.Pages.init(p);
        try derivesearch.writeDerived(
            self.gpa,
            terms_store,
            text_store,
            md5,
            // The address space: every page, not only recognised ones.
            p.note.page_count,
            &src,
        );
    }

    /// Links an already-stored blob as a new file, never over an existing one (web
    /// upload). Unlike the device, a browser drop of a same-named file is a
    /// different file, so a collision takes `bin.freeName`'s ` (n)`. Caller frees
    /// `.name` / `.md5`.
    pub fn placeUpload(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, md5: []const u8, size: u64) !Entry {
        // Fail a bad destination before the `bin.freeName` scan.
        try self.assertFolder(user_id, parent_id);

        const final = try bin.freeName(self, user_id, parent_id, name, null);
        defer self.gpa.free(final);
        return self.linkBlob(user_id, parent_id, final, md5, size);
    }

    /// Moves and/or renames a live entry in one transaction. Paths are not
    /// materialized, so a folder's subtree follows for free.
    ///   - Same parent and name is a no-op without a sync bump.
    ///   - A taken name: ` (n)` with `autorename`, else NameConflict; never clobber.
    ///   - Adopting a stranger's `.mark` (or becoming one) counts as a conflict.
    ///   - A folder may not move into its own subtree (InvalidMove).
    ///   - A pair moves and renames as one; the mark's name follows the document's
    ///     final name. A rename that would unpair them is InvalidMove: a document
    ///     may not take a `.mark` name; a mark may only take names `markStemOf`
    ///     accepts.
    /// NotFound if absent, foreign or trashed. Caller frees `.name` / `.md5`.
    pub fn move(self: Files, user_id: u64, id: u64, new_parent_id: ?u64, new_name: []const u8, autorename: bool) !Entry {
        if (new_name.len == 0) return error.NameConflict;
        try self.assertFolder(user_id, new_parent_id);

        // Trashed / absent / foreign is NotFound (the handler treats it as success).
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

        if (is_folder and try self.wouldCycle(user_id, new_parent_id, id)) return error.InvalidMove;

        // The rule, spent once (see `pairOf`).
        const partner = try internal.pairOf(self, user_id, id);

        // The document's requested name anchors both rows.
        var pdf_want: []const u8 = new_name;
        if (partner) |p| {
            if (p.entry_is_mark) {
                pdf_want = markpair.markStemOf(new_name) orelse return error.InvalidMove;
            } else if (std.mem.endsWith(u8, new_name, markpair.mark_ext)) {
                // A document ending in `.mark` would make a chain, unpairing them.
                return error.InvalidMove;
            }
        }

        var owned_pdf: ?[]u8 = null; // the PDF's name, when autorename produced one
        defer if (owned_pdf) |n| self.gpa.free(n);
        var owned_mark: ?[]u8 = null; // the mark's, always derived from the PDF's
        defer if (owned_mark) |n| self.gpa.free(n);
        var final_name: []const u8 = new_name; // the ENTRY's, whichever member it is
        var pdf_final: []const u8 = pdf_want; // the anchor the mark's is built from
        if (partner) |p| {
            const pdf_id = if (p.entry_is_mark) p.id else id;

            // Already in place: a true no-op.
            if (try internal.liveChild(self, user_id, new_parent_id, pdf_want)) |occ| {
                if (occ.id == pdf_id) return (try self.get(user_id, id)) orelse error.NotFound;
            }

            // Both targets must be free at the same ` (n)`.
            if (!try bin.nameFree(self, user_id, new_parent_id, pdf_want, markpair.mark_ext)) {
                if (!autorename) return error.NameConflict; // never clobber, never unpair
                owned_pdf = try bin.freeName(self, user_id, new_parent_id, pdf_want, markpair.mark_ext);
                pdf_final = owned_pdf.?;
            }
            owned_mark = try std.fmt.allocPrint(self.gpa, "{s}" ++ markpair.mark_ext, .{pdf_final});
            final_name = if (p.entry_is_mark) owned_mark.? else pdf_final;
        } else {
            // Checked first: `bin.nameFree` would count the row's own name as taken.
            if (try internal.liveChild(self, user_id, new_parent_id, new_name)) |occ| {
                if (occ.id == id) return (try self.get(user_id, id)) orelse error.NotFound;
            }

            // This unpaired row must not walk into an existing pairing (an orphan
            // `.mark` at the new name, or as a mark becoming someone's ink). Same
            // posture as `restore`'s paired arm; `restore`'s unpaired arm deliberately
            // re-pairs because it returns a row to its own name. Folders never pair.
            const pair_guard: ?[]const u8 = if (is_folder) null else markpair.mark_ext;
            if (!try bin.nameFree(self, user_id, new_parent_id, new_name, pair_guard)) {
                if (!autorename) return error.NameConflict; // never clobber, never adopt
                owned_pdf = try bin.freeName(self, user_id, new_parent_id, new_name, pair_guard);
                final_name = owned_pdf.?;
            }
        }

        const ts = internal.now(
            self,
        );
        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};
        {
            var s = try self.db.prepare(
                "UPDATE files SET parent_id = ?1, name = ?2, updated_at = ?3 WHERE id = ?4 AND user_id = ?5;",
            );
            defer s.finalize();
            internal.bindOpt(s, 1, new_parent_id);
            s.bindText(2, final_name);
            s.bindInt(3, ts);
            s.bindInt(4, @intCast(id));
            s.bindInt(5, @intCast(user_id));
            _ = try s.step();
        }
        if (partner) |p| {
            // Names fall out of the anchor, not out of what each row had.
            var s = try self.db.prepare(
                "UPDATE files SET parent_id = ?1, name = ?2, updated_at = ?3 WHERE id = ?4 AND user_id = ?5;",
            );
            defer s.finalize();
            internal.bindOpt(s, 1, new_parent_id);
            s.bindText(2, if (p.entry_is_mark) pdf_final else owned_mark.?);
            s.bindInt(3, ts);
            s.bindInt(4, @intCast(p.id));
            s.bindInt(5, @intCast(user_id));
            _ = try s.step();
        }
        try internal.bumpSync(self, user_id);
        try self.db.exec("COMMIT;");

        return .{
            .id = id,
            .parent_id = new_parent_id,
            .name = try self.gpa.dupe(u8, final_name),
            .is_folder = is_folder,
            .md5 = if (has_md5) try self.gpa.dupe(u8, &md5buf) else null,
            .size = size,
            .updated_at = ts,
            // After the move: the pair travelled together.
            .mark_id = if (is_folder) null else try self.liveMarkIdFor(user_id, new_parent_id, final_name),
        };
    }

    /// Copies a live file: a second row on the same blob, an `incref`. No
    /// derived state is redone and, since quota is per distinct blob per user,
    /// copying your own file costs nothing. Name rules as in `move`. IsFolder:
    /// folders are not deep-copied. Caller frees `.name` / `.md5`.
    pub fn copy(self: Files, user_id: u64, id: u64, new_parent_id: ?u64, new_name: []const u8, autorename: bool) !Entry {
        if (new_name.len == 0) return error.NameConflict;
        try self.assertFolder(user_id, new_parent_id);

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

        // Any occupant, the source included, is a conflict: a copy is always new.
        var owned_name: ?[]u8 = null;
        defer if (owned_name) |n| self.gpa.free(n);
        var final_name: []const u8 = new_name;
        if (try internal.liveChild(self, user_id, new_parent_id, new_name)) |_| {
            if (!autorename) return error.NameConflict;
            owned_name = try bin.freeName(self, user_id, new_parent_id, new_name, null);
            final_name = owned_name.?;
        }

        const ts = internal.now(
            self,
        );
        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        try self.ensureBlobRow(md5, size); // idempotent — the source already made it

        // Zero for a copy of one's own file; computed as uploads do.
        const delta: i64 = if (try internal.userChargedRefs(self, user_id, md5) == 0) @intCast(size) else 0;

        var file_id: u64 = undefined;
        {
            var s = try self.db.prepare(
                "INSERT INTO files(user_id, parent_id, name, is_folder, md5, size, created_at, updated_at) VALUES(?1,?2,?3,0,?4,?5,?6,?6);",
            );
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            internal.bindOpt(s, 2, new_parent_id);
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
        try internal.addUsed(self, user_id, delta);

        try internal.bumpSync(self, user_id); // the tree gained a row
        try self.db.exec("COMMIT;");

        return .{
            .id = file_id,
            .parent_id = new_parent_id,
            .name = try self.gpa.dupe(u8, final_name),
            .is_folder = false,
            .md5 = try self.gpa.dupe(u8, md5),
            .size = size,
            .updated_at = ts,
            // Asked of the destination name, after any suffix.
            .mark_id = try self.liveMarkIdFor(user_id, new_parent_id, final_name),
        };
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

    /// Whether moving folder `id` under `new_parent` would create a cycle (walks
    /// up from `new_parent`, 256-hop guard).
    fn wouldCycle(self: Files, user_id: u64, new_parent: ?u64, id: u64) !bool {
        var cur = new_parent;
        var guard: usize = 0;
        while (cur) |c| {
            if (c == id) return true;
            guard += 1;
            if (guard > 256) break;
            cur = try internal.parentOf(self, user_id, c);
        }
        return false;
    }

    fn ensureBlobRow(self: Files, md5: []const u8, size: u64) !void {
        var s = try self.db.prepare("INSERT INTO blobs(md5, size, refcount, created_at) VALUES(?1,?2,0,?3) ON CONFLICT(md5) DO NOTHING;");
        defer s.finalize();
        s.bindText(1, md5);
        s.bindInt(2, @intCast(size));
        s.bindInt(3, internal.now(
            self,
        ));
        _ = try s.step();
    }

    fn incref(self: Files, md5: []const u8) !void {
        var s = try self.db.prepare("UPDATE blobs SET refcount = refcount + 1 WHERE md5 = ?1;");
        defer s.finalize();
        s.bindText(1, md5);
        _ = try s.step();
    }

    pub const Child = struct { id: u64, is_folder: bool, md5: [md5_len]u8, size: u64 };

    /// `parent_id` is null (root) or a live folder owned by the user.
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
