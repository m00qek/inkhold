//! The file-tree service over `files`/`blobs`/`capacity` and the blob store.
//! Owns the storage invariants: every operation scoped by `user_id`, blob
//! refcounts, per-user quota, two-stage delete via the recycle bin.

const std = @import("std");
const config = @import("../config.zig");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const derivedstore = @import("../store/derived.zig");
const derivesearch = @import("derive_search.zig");
const authsvc = @import("auth/service.zig");
const noteindex = @import("note_index.zig");
const thumbnail = @import("thumbnail.zig");
const spdindex = @import("spd_index.zig");
const txtindex = @import("txt_index.zig");
const deferredmod = @import("deferred.zig");
const markpair = @import("mark_pairing.zig");

const md5_len = blobstore.md5_hex_len;
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

    fn deletedFlag(self: HistoryScope) i64 {
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

    fn now(self: Files) i64 {
        return std.Io.Clock.real.now(self.io).toSeconds();
    }

    // ---- reads ----

    /// Shared by the listing and `get`, so both read one expression.
    const paired_mark_id = markpair.pairedMarkId("f");

    const hide_paired_mark = markpair.hidePairedMark("f", "0");

    /// The bin's view: a trashed pair is one row there too.
    const hide_paired_bin_mark = markpair.hidePairedMark("f", "1");

    /// `id` is the partner's row. Names are anchored on the document: the mark's
    /// name is the document's plus `.mark`.
    const Paired = struct { id: u64, entry_is_mark: bool };

    /// The other half of a pair, or null. The only entry point for the two-way
    /// rule: `trash`, `restore`, `purge` and `move` call it once and then work a
    /// flat id set (applying it per row would bounce back). Same state only, the
    /// set `hidePairedMark` folds. Folders never pair.
    fn pairOf(self: Files, user_id: u64, id: u64) !?Paired {
        var parent_id: ?u64 = null;
        var deleted: i64 = 0;
        var name: []u8 = undefined;
        {
            var r = (try self.db.row(
                "SELECT parent_id, name, is_folder, deleted FROM files WHERE id = ?1 AND user_id = ?2;",
                &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
            )) orelse return null;
            defer r.finalize();
            if (r.int(2) != 0) return null; // a folder is never half of a pair
            const pid = r.int(0);
            parent_id = if (pid == 0) null else @intCast(pid);
            // No length cap: the SQL predicate has none, so a capped name would be hidden
            // yet left behind by mutations.
            name = try self.gpa.dupe(u8, r.text(1));
            deleted = r.int(3);
        }
        defer self.gpa.free(name);

        const entry_is_mark = std.mem.endsWith(u8, name, markpair.mark_ext);
        var owned_want: ?[]u8 = null;
        defer if (owned_want) |w| self.gpa.free(w);
        var want: []const u8 = undefined;
        if (entry_is_mark) {
            // A `.mark` name can only pair with the document it is named after.
            want = markpair.markStemOf(name) orelse return null;
        } else {
            owned_want = try std.fmt.allocPrint(self.gpa, "{s}" ++ markpair.mark_ext, .{name});
            want = owned_want.?;
        }

        var s = try self.db.prepare(
            "SELECT id FROM files WHERE user_id = ?1 AND COALESCE(parent_id, 0) = COALESCE(?2, 0) " ++
                "AND name = ?3 AND is_folder = 0 AND deleted = ?4;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        bindOpt(s, 2, parent_id);
        s.bindText(3, want);
        s.bindInt(4, deleted);
        if (!try s.step()) return null;
        return .{ .id = @intCast(s.columnInt(0)), .entry_is_mark = entry_is_mark };
    }

    /// The live `.mark` beside `name` in `parent_id`, or null. Exposed for
    /// `annotationsId`, which needs it for a content-verified PDF without the extension.
    pub fn liveMarkIdFor(self: Files, user_id: u64, parent_id: ?u64, name: []const u8) !?u64 {
        var s = try self.db.prepare(
            "SELECT id FROM files WHERE user_id = ?1 AND COALESCE(parent_id, 0) = COALESCE(?2, 0) " ++
                "AND name = ?3 || '" ++ markpair.mark_ext ++ "' AND is_folder = 0 AND deleted = 0;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        bindOpt(s, 2, parent_id);
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
                paired_mark_id ++
                " FROM files f " ++
                "WHERE f.user_id = ?1 AND COALESCE(f.parent_id, 0) = COALESCE(?2, 0) AND f.deleted = 0 " ++
                hide_paired_mark ++
                " ORDER BY f.is_folder DESC, f.name;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        bindOpt(s, 2, parent_id);
        while (try s.step()) try out.append(self.gpa, try self.rowToEntry(&s));
        return out.toOwnedSlice(self.gpa);
    }

    /// Live direct children of any kind ("items", not notes). Trashed rows never
    /// count. One index range over `files_user_parent`.
    pub fn childCount(self: Files, user_id: u64, folder_id: u64) !i64 {
        var r = (try self.db.row(
            "SELECT COUNT(*) FROM files f WHERE f.user_id = ?1 AND f.parent_id = ?2 AND f.deleted = 0" ++
                hide_paired_mark ++ ";",
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

    /// Callers holding a transaction bump inside it, so it commits atomically.
    fn bumpSync(self: Files, user_id: u64) !void {
        var s = try self.db.prepare(
            "INSERT INTO sync_state(user_id, version) VALUES(?1, 1) " ++
                "ON CONFLICT(user_id) DO UPDATE SET version = version + 1;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        _ = try s.step();
    }

    /// One live entry by id (scoped to `user_id`), or null.
    pub fn get(self: Files, user_id: u64, id: u64) !?Entry {
        var r = (try self.db.row(
            "SELECT f.id, f.parent_id, f.name, f.is_folder, f.md5, f.size, f.updated_at, " ++
                // Live, so it carries its ink: rename/move/upload responses are built from it.
                paired_mark_id ++
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
        bindOpt(s, 2, parent_id);
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
            const c = (try self.liveChild(user_id, parent, seg)) orelse return null;
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
        try self.bumpSync(user_id);
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

    /// Creates the last segment of `path` as a folder, ancestors idempotently
    /// (device `create_folder_v2`). `autorename` governs the leaf only: false
    /// returns an existing folder unchanged (retries converge) and refuses a file;
    /// true takes `freeName`'s ` (n)` form. Caller frees `.name`.
    pub fn createFolderPath(self: Files, user_id: u64, path: []const u8, autorename: bool) !Entry {
        var parent: ?u64 = null;
        var it = std.mem.tokenizeScalar(u8, path, '/');
        var name = it.next() orelse return error.NotFound; // "" / "/" name nothing

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
            const final = try self.freeName(user_id, parent, name, null);
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
        errdefer if (!res.deduped) self.removeBlobFiles(&res.md5);

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

        const existing = try self.liveChild(user_id, parent_id, name);
        if (existing) |e| if (e.is_folder) return error.NameConflict;

        const old_md5: ?[md5_len]u8 = if (existing) |e| e.md5 else null;
        const same_content = if (old_md5) |om| std.mem.eql(u8, &om, md5) else false;

        // ---- reference counts, read before any row write ----
        // Quota follows anything keeping bytes on disk, incl. `file_history`.
        var new_charge = false;
        if (!same_content) new_charge = try self.userChargedRefs(user_id, md5) == 0;

        var file_id: u64 = undefined;
        const ts = self.now();

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

        // Retain on supersede: write the history row before the decref, so the GC gate
        // keeps the blob. Refcount drops but the charge stays. `keep == 0` prunes and
        // refunds. `evicted` lets settlement give back exactly what left.
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
                // K per file, then the global max_bytes ceiling.
                if (keep > 0) try self.evictHistory(user_id, file_id, keep, &gc_hist, &evicted);
            }
        }

        // ---- quota settlement, from the rows as they are now ----
        // Eviction may drop the version just recorded, so nothing is predicted.
        var settled: std.ArrayList([md5_len]u8) = .empty;
        defer settled.deinit(self.gpa);
        var delta: i64 = if (new_charge) @as(i64, @intCast(size)) else 0;
        if (old_md5) |om| {
            if (!same_content) try self.settleRefund(user_id, &om, @intCast(existing.?.size), &settled, &delta);
        }
        for (evicted.items) |*e| try self.settleRefund(user_id, &e.md5, e.size, &settled, &delta);

        // Never refuse an edit for the version it displaced: evict the user's oldest
        // versions until it fits, and refuse only when live files alone do not.
        // Bounded: each pass deletes one row whose blob no live file holds.
        const cap = try self.capacity(user_id);
        while (cap.used + delta > cap.total) {
            const dropped = (try self.evictOldestVersion(user_id, &gc_hist)) orelse break;
            try self.settleRefund(user_id, &dropped.md5, dropped.size, &settled, &delta);
        }
        if (cap.used + delta > cap.total) return error.QuotaExceeded; // errdefer rolls back
        try self.addUsed(user_id, delta);

        try self.db.exec("COMMIT;");
        // After commit, or the worker may find nothing and sleep.
        if (self.deferred) |w| w.signal();
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
    /// different file, so a collision takes `freeName`'s ` (n)`. Caller frees
    /// `.name` / `.md5`.
    pub fn placeUpload(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, md5: []const u8, size: u64) !Entry {
        // Fail a bad destination before the `freeName` scan.
        try self.assertFolder(user_id, parent_id);

        const final = try self.freeName(user_id, parent_id, name, null);
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
        const partner = try self.pairOf(user_id, id);

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
            if (try self.liveChild(user_id, new_parent_id, pdf_want)) |occ| {
                if (occ.id == pdf_id) return (try self.get(user_id, id)) orelse error.NotFound;
            }

            // Both targets must be free at the same ` (n)`.
            if (!try self.nameFree(user_id, new_parent_id, pdf_want, markpair.mark_ext)) {
                if (!autorename) return error.NameConflict; // never clobber, never unpair
                owned_pdf = try self.freeName(user_id, new_parent_id, pdf_want, markpair.mark_ext);
                pdf_final = owned_pdf.?;
            }
            owned_mark = try std.fmt.allocPrint(self.gpa, "{s}" ++ markpair.mark_ext, .{pdf_final});
            final_name = if (p.entry_is_mark) owned_mark.? else pdf_final;
        } else {
            // Checked first: `nameFree` would count the row's own name as taken.
            if (try self.liveChild(user_id, new_parent_id, new_name)) |occ| {
                if (occ.id == id) return (try self.get(user_id, id)) orelse error.NotFound;
            }

            // This unpaired row must not walk into an existing pairing (an orphan
            // `.mark` at the new name, or as a mark becoming someone's ink). Same
            // posture as `restore`'s paired arm; `restore`'s unpaired arm deliberately
            // re-pairs because it returns a row to its own name. Folders never pair.
            const pair_guard: ?[]const u8 = if (is_folder) null else markpair.mark_ext;
            if (!try self.nameFree(user_id, new_parent_id, new_name, pair_guard)) {
                if (!autorename) return error.NameConflict; // never clobber, never adopt
                owned_pdf = try self.freeName(user_id, new_parent_id, new_name, pair_guard);
                final_name = owned_pdf.?;
            }
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
        if (partner) |p| {
            // Names fall out of the anchor, not out of what each row had.
            var s = try self.db.prepare(
                "UPDATE files SET parent_id = ?1, name = ?2, updated_at = ?3 WHERE id = ?4 AND user_id = ?5;",
            );
            defer s.finalize();
            bindOpt(s, 1, new_parent_id);
            s.bindText(2, if (p.entry_is_mark) pdf_final else owned_mark.?);
            s.bindInt(3, ts);
            s.bindInt(4, @intCast(p.id));
            s.bindInt(5, @intCast(user_id));
            _ = try s.step();
        }
        try self.bumpSync(user_id);
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
        if (try self.liveChild(user_id, new_parent_id, new_name)) |_| {
            if (!autorename) return error.NameConflict;
            owned_name = try self.freeName(user_id, new_parent_id, new_name, null);
            final_name = owned_name.?;
        }

        const ts = self.now();
        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        try self.ensureBlobRow(md5, size); // idempotent — the source already made it

        // Zero for a copy of one's own file; computed as uploads do.
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
            // Asked of the destination name, after any suffix.
            .mark_id = try self.liveMarkIdFor(user_id, new_parent_id, final_name),
        };
    }

    // ---- the recycle bin ----

    /// The default bin retention (30 days); the effective window is in
    /// `services/settings.zig`.
    pub const bin_retention_s: i64 = 30 * 24 * 60 * 60;

    /// One user's bin, newest deletion first, allocated in `alloc`. Paths are the
    /// ones frozen at trash time (`deleted_path`), O(bin) and immune to later
    /// ancestor renames. `is_root` is computed live. A flat list; the client
    /// groups and nests from `parent_id`/`deleted_at`/`is_root`.
    pub fn listBin(self: Files, alloc: std.mem.Allocator, user_id: u64) ![]BinEntry {
        var out: std.ArrayList(BinEntry) = .empty;

        // Empty-bin early exit on `files_deleted_at`.
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

    /// Live rows a web delete of `id` would tombstone, counted before `trash`.
    /// Paired `.mark`s are not counted: the user never saw them.
    pub fn liveSubtreeCount(self: Files, user_id: u64, id: u64) !usize {
        var r = (try self.db.row(live_subtree_count_sql, &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } })) orelse return 0;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// Tombstones an entry and its subtree, holding every blob reference (no
    /// refund; `purge` does that). Idempotent: one UPDATE gated on `deleted = 0`
    /// serves the device's children-first, retried deletes and the web's single
    /// request, keeping earlier `deleted_at`s. A pair goes together in one
    /// transaction, or the mark would surface as a conjured file.
    pub fn trash(self: Files, user_id: u64, id: u64) !void {
        if (!try self.exists(user_id, id)) return error.NotFound;

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        // The rule, spent once, before any write.
        const partner = try self.pairOf(user_id, id);

        const ts = self.now();
        var changed = try self.trashSubtree(user_id, id, ts);
        if (partner) |p| changed += try self.trashSubtree(user_id, p.id, ts);

        // A no-op retry must not invalidate every cached listing.
        if (changed > 0) try self.bumpSync(user_id);
        try self.db.exec("COMMIT;");
    }

    /// Inside an open transaction. A pair's roots share `ts`, so their retention
    /// clocks match and the bin groups them.
    fn trashSubtree(self: Files, user_id: u64, id: u64, ts: i64) !i64 {
        var s = try self.db.prepare(subtree_trash_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(id));
        s.bindInt(2, @intCast(user_id));
        s.bindInt(3, ts);
        _ = try s.step();
        return self.db.changes();
    }

    /// What `restore` did, often more than asked. `name` is owned by `gpa`.
    pub const Restored = struct {
        /// The resulting name, possibly suffixed (see `freeName`).
        name: []u8,
        renamed: bool,
        /// Trashed ancestor folders brought back to make it reachable.
        ancestors: usize,
        descendants: usize,

        pub fn deinit(self: Restored, gpa: std.mem.Allocator) void {
            gpa.free(self.name);
        }
    };

    /// Restores a trashed entry, its trashed ancestor chain (else orphaned), and
    /// for a folder every trashed descendant. Names a live entry has taken are
    /// auto-renamed (`files_live_name` is unique). The blob was never released,
    /// so there is nothing to re-index. A pair returns together: the document is
    /// restored first and its free-name search skips suffixes whose `.mark` is
    /// taken, so the mark follows it. Restoring a live entry is a no-op.
    pub fn restore(self: Files, user_id: u64, id: u64) !Restored {
        if (!try self.exists(user_id, id)) return error.NotFound;

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        // Spent once, while both members are still trashed.
        const partner = try self.pairOf(user_id, id);

        var ancestors: usize = 0;
        var descendants: usize = 0;

        // 1. Ancestors, root-first, so collisions resolve top-down.
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
                const r = try self.restoreRow(user_id, chain.items[i], .{});
                self.gpa.free(r.name);
                if (r.was_trashed) ancestors += 1;
            }
        }

        // 2. The entry and its pair, document first; report the requested row's name.
        const self_row = blk: {
            const p = partner orelse break :blk try self.restoreRow(user_id, id, .{});

            const pdf_id = if (p.entry_is_mark) p.id else id;
            const mark_id = if (p.entry_is_mark) id else p.id;

            const pdf_row = try self.restoreRow(user_id, pdf_id, .{ .pair = markpair.mark_ext });
            errdefer self.gpa.free(pdf_row.name);

            const want = try std.fmt.allocPrint(self.gpa, "{s}" ++ markpair.mark_ext, .{pdf_row.name});
            defer self.gpa.free(want);
            const mark_row = try self.restoreRow(user_id, mark_id, .{ .name = want });

            if (p.entry_is_mark) {
                self.gpa.free(pdf_row.name);
                break :blk mark_row;
            }
            self.gpa.free(mark_row.name);
            break :blk pdf_row;
        };
        errdefer self.gpa.free(self_row.name);

        // 3. Descendants, shallowest first. Ids are collected before writing, so the
        //    recursive CTE is not mutated underneath.
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
                const r = try self.restoreRow(user_id, kid, .{});
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

    /// Hard-deletes a trashed entry and its subtree: blob refcounts drop, blobs at
    /// 0 lose their index rows and leave disk, quota is refunded. NotFound if live,
    /// so a live file is never one mistyped id away. A pair is destroyed together,
    /// or the mark's bytes would stay charged with no row to purge.
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
        try self.addPairs(user_id, &ids);

        try self.releaseIds(user_id, ids.items, &gc);
        try self.bumpSync(user_id);
        try self.db.exec("COMMIT;");

        for (gc.items) |*m| self.removeBlobFiles(m); // GC on disk after the commit
    }

    /// Purges the whole bin. Returns the count the bin listing showed (hidden
    /// `.mark`s excluded), taken before the release.
    pub fn emptyBin(self: Files, user_id: u64) !usize {
        var gc: std.ArrayList([md5_len]u8) = .empty;
        defer gc.deinit(self.gpa);

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        const shown: usize = blk: {
            var r = (try self.db.row(
                "SELECT COUNT(*) FROM files f WHERE f.user_id = ?1 AND f.deleted = 1" ++
                    hide_paired_bin_mark ++ ";",
                &.{.{ .int = @intCast(user_id) }},
            )) orelse break :blk 0;
            defer r.finalize();
            break :blk @intCast(r.int(0));
        };

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
        return shown;
    }

    /// Purges entries trashed more than `max_age_s` ago, for every user, one user
    /// at a time (quota is per user), each expanded to its subtree closure.
    pub fn sweepBin(self: Files, max_age_s: i64) !usize {
        return self.sweepBinBefore(self.now() - max_age_s);
    }

    /// `sweepBin` against a cutoff computed by `settings.sweepCutoff` (which
    /// keeps a shortened window non-retroactive).
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
        // A pair expires together even if its stamps differ, or the mark would appear.
        try self.addPairs(user_id, &ids);

        try self.releaseIds(user_id, ids.items, &gc);
        if (ids.items.len > 0) try self.bumpSync(user_id);
        try self.db.exec("COMMIT;");

        for (gc.items) |*m| self.removeBlobFiles(m);
        return ids.items.len;
    }

    /// Releases every blob reference a user's rows hold, then hard-deletes them:
    /// the storage half of account deletion (the FK cascade does not decref).
    /// Shared blobs are only decremented. Call before deleting the `users` row.
    pub fn purgeUser(self: Files, user_id: u64) !void {
        var doomed: std.ArrayList([md5_len]u8) = .empty;
        defer doomed.deinit(self.gpa);

        try self.db.exec("BEGIN IMMEDIATE;");
        errdefer self.db.exec("ROLLBACK;") catch {};

        // Every row, trashed included: a tombstone still holds its blob reference.
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

        // Retained versions' md5s, collected before their rows cascade away.
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

        // In the same transaction as the decrefs, so refcount never disagrees.
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

    /// Binds `inner_name` (our opaque upload key) to the destination folder, file
    /// name and declared size at `upload/apply`. These values, not finish's echoed
    /// path, are authoritative.
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

    /// The md5 the blob store computed at `/oss/put`. NotFound if no such session.
    pub fn setUploadBlob(self: Files, user_id: u64, inner_name: []const u8, md5: []const u8) !void {
        var s = try self.db.prepare("UPDATE upload_sessions SET blob_md5 = ?1 WHERE inner_name = ?2 AND user_id = ?3;");
        defer s.finalize();
        s.bindText(1, md5);
        s.bindText(2, inner_name);
        s.bindInt(3, @intCast(user_id));
        _ = try s.step();
        if (self.db.changes() == 0) return error.NotFound;
    }

    /// Adds `delta` to a session's staged-byte total, bounding the sum of parts
    /// (not just each body). Signed, since a re-POSTed part replaces its file;
    /// clamped at 0. NotFound if not this caller's session.
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

    /// Slices are owned by `alloc`.
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

    pub fn deleteUploadSession(self: Files, inner_name: []const u8) !void {
        var s = try self.db.prepare("DELETE FROM upload_sessions WHERE inner_name = ?1;");
        defer s.finalize();
        s.bindText(1, inner_name);
        _ = try s.step();
    }

    /// Drops sessions older than `max_age_s` and their on-disk blob when it has no
    /// `blobs` row (created only at finish, so a shared md5 is left alone).
    pub fn sweepUploadSessions(self: Files, max_age_s: i64) !usize {
        const cutoff = self.now() - max_age_s;

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
    // Closures walk children without filtering on `deleted`: `parent_id` is
    // ON DELETE CASCADE, so anything the cascade reaches must be decref'd.

    /// Tombstones the subtree at ?1, freezing each row's current path into
    /// `deleted_path`. Gated on `deleted = 0` in the UPDATE, so trashed rows keep
    /// their `deleted_at` and path while live rows below them are caught. The walk
    /// ignores `deleted` so it can pass through trashed ancestors.
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

    /// Parents before children; `id` breaks ties so the older of two same-named
    /// siblings keeps the name, identically on every replay.
    const subtree_depth_sql =
        \\WITH RECURSIVE sub(id, depth) AS (
        \\  SELECT id, 0 FROM files WHERE id = ?1 AND user_id = ?2
        \\  UNION ALL
        \\  SELECT f.id, sub.depth + 1 FROM files f JOIN sub ON f.parent_id = sub.id
        \\)
        \\SELECT id FROM sub WHERE depth > 0 ORDER BY depth, id;
    ;

    const subtree_ids_sql =
        \\WITH RECURSIVE sub(id) AS (
        \\  SELECT id FROM files WHERE id = ?1 AND user_id = ?2
        \\  UNION
        \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
        \\)
        \\SELECT id FROM sub;
    ;

    /// User ?1's bin plus everything reachable below it.
    const bin_ids_sql =
        \\WITH RECURSIVE sub(id) AS (
        \\  SELECT id FROM files WHERE user_id = ?1 AND deleted = 1
        \\  UNION
        \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
        \\)
        \\SELECT id FROM sub;
    ;

    /// The same, trashed before ?2.
    const expired_bin_ids_sql =
        \\WITH RECURSIVE sub(id) AS (
        \\  SELECT id FROM files
        \\  WHERE user_id = ?1 AND deleted = 1 AND COALESCE(deleted_at, 0) < ?2
        \\  UNION
        \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
        \\)
        \\SELECT id FROM sub;
    ;

    /// The bin listing: a direct read of tombstones via `files_deleted_at`, O(bin).
    /// `is_root` is computed live. A trashed pair is one row (the document's), and
    /// its size is the pair's, because purging frees both.
    const bin_listing_sql =
        \\SELECT f.id, f.parent_id, f.name, f.is_folder, f.md5,
        \\       f.size + COALESCE((SELECT m.size FROM files m
        \\                           WHERE m.user_id = f.user_id
        \\                             AND COALESCE(m.parent_id, 0) = COALESCE(f.parent_id, 0)
        \\                             AND m.name = f.name || '.mark'
        \\                             AND m.is_folder = 0 AND m.deleted = 1
        \\                             AND f.is_folder = 0
        \\                             AND substr(f.name, -5) <> '.mark'), 0),
        \\       COALESCE(f.deleted_at, 0), COALESCE(f.deleted_path, ''),
        \\       (f.parent_id IS NULL OR NOT EXISTS (
        \\          SELECT 1 FROM files p WHERE p.id = f.parent_id AND p.deleted = 1))
        \\FROM files f WHERE f.user_id = ?1 AND f.deleted = 1
    ++ hide_paired_bin_mark ++
        \\
        \\ORDER BY COALESCE(f.deleted_at, 0) DESC, f.id DESC;
    ;

    /// The live subtree at ?1, counted as `trash` would tombstone it, minus paired
    /// `.mark`s below the anchor (the user never saw them).
    const live_subtree_count_sql =
        \\WITH RECURSIVE sub(id) AS (
        \\  SELECT id FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0
        \\  UNION
        \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id WHERE f.deleted = 0
    ++ hide_paired_mark ++
        \\
        \\)
        \\SELECT COUNT(*) FROM sub;
    ;

    /// Closes `ids` under the pairing rule, adding each member's partner once.
    /// The set is already cascade-closed, so only file siblings are added.
    fn addPairs(self: Files, user_id: u64, ids: *std.ArrayList(u64)) !void {
        const n = ids.items.len; // snapshot: added rows are pairs already
        var i: usize = 0;
        while (i < n) : (i += 1) {
            const p = (try self.pairOf(user_id, ids.items[i])) orelse continue;
            if (std.mem.indexOfScalar(u64, ids.items, p.id) != null) continue;
            try ids.append(self.gpa, p.id);
        }
    }

    fn releaseIds(self: Files, user_id: u64, ids: []const u64, gc: *std.ArrayList([md5_len]u8)) !void {
        // Must run inside a transaction. Everything is read before any delete (the
        // cascade removes rows we have not looked at); zero-ref blobs go to `gc` for
        // removal after commit. One entry per row: refcount counts rows, the refund
        // counts distinct md5s.
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

        // Retained-version md5s, collected before their rows cascade away, reaped after.
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

        // Refund per distinct blob the user no longer holds in any charged sense,
        // including purged files' retained versions (their rows are gone).
        var settled: std.ArrayList([md5_len]u8) = .empty;
        defer settled.deinit(self.gpa);
        var delta: i64 = 0;
        for (doomed.items) |*d| try self.settleRefund(user_id, &d.md5, d.size, &settled, &delta);
        for (hist_doomed.items) |*h| try self.settleRefund(user_id, &h.md5, h.size, &settled, &delta);
        if (delta != 0) try self.addUsed(user_id, delta);

        for (doomed.items) |*d| {
            if (try self.decref(&d.md5)) try gc.append(self.gpa, d.md5);
        }

        // Reap blobs whose last keeper was a cascaded history row, after the decrefs.
        {
            var hist_md5s: std.ArrayList([md5_len]u8) = .empty;
            defer hist_md5s.deinit(self.gpa);
            for (hist_doomed.items) |*h| try hist_md5s.append(self.gpa, h.md5);
            try self.reapDistinct(hist_md5s.items, gc);
        }
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

    /// The user's charged references to `md5`: `files` rows (live or trashed) plus
    /// their `file_history` rows. The quota predicate.
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

    /// Refunds `size` if `md5` is now unreferenced by the user, once per
    /// transaction (superseded and evicted blobs can coincide). Reads current
    /// state, so call after the writes.
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
        return (try self.userChargedRefs(user_id, md5)) > 0;
    }

    /// `was_trashed` is false for an already-live row, so counts include only
    /// rows actually changed.
    const RestoredRow = struct { name: []u8, was_trashed: bool, renamed: bool };

    /// Name choice for `restoreRow`; both fields serve `.mark` pairing only.
    const RestoreName = struct {
        /// Restore under this name: a mark follows its document's possibly new name.
        name: ?[]const u8 = null,
        /// Accept a candidate only if `candidate ++ pair` is also free, so the pair
        /// shares one ` (n)` and never adopts an orphan mark.
        pair: ?[]const u8 = null,
    };

    /// Makes one row live, renaming on collision; leaves a live row alone. The
    /// returned `name` is owned by `gpa`.
    fn restoreRow(self: Files, user_id: u64, id: u64, opts: RestoreName) !RestoredRow {
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

        const final = try self.freeName(user_id, parent_id, opts.name orelse name, opts.pair);
        errdefer self.gpa.free(final);

        // `deleted_path` is NULL for live rows.
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

    /// A name free in `parent_id`: `wanted`, or ` (n)` inserted before the
    /// extension with the lowest free n ≥ 2. Deterministic, so a replayed restore
    /// lands on the same name. An existing suffix is replaced, not stacked. With
    /// `pair`, `cand ++ pair` must be free too. Always a fresh allocation.
    fn freeName(self: Files, user_id: u64, parent_id: ?u64, wanted: []const u8, pair: ?[]const u8) ![]u8 {
        if (try self.nameFree(user_id, parent_id, wanted, pair)) return self.gpa.dupe(u8, wanted);

        const dot = std.mem.lastIndexOfScalar(u8, wanted, '.');
        const full_stem = if (dot) |d| (if (d == 0) wanted else wanted[0..d]) else wanted;
        const ext = wanted[full_stem.len..];
        const stem = stripSuffix(full_stem);

        var n: u32 = 2;
        while (n < 10_000) : (n += 1) {
            const cand = try std.fmt.allocPrint(self.gpa, "{s} ({d}){s}", .{ stem, n, ext });
            errdefer self.gpa.free(cand);
            if (try self.nameFree(user_id, parent_id, cand, pair)) return cand;
            self.gpa.free(cand);
        }
        return error.NameConflict;
    }

    /// Whether `cand` is free and, with `pair`, not half of somebody else's pair:
    /// for a document name `cand ++ pair` must be free; for a mark name its stem
    /// must be.
    fn nameFree(self: Files, user_id: u64, parent_id: ?u64, cand: []const u8, pair: ?[]const u8) !bool {
        if (try self.liveChild(user_id, parent_id, cand) != null) return false;
        const suffix = pair orelse return true;
        if (markpair.markStemOf(cand)) |stem| return (try self.liveChild(user_id, parent_id, stem)) == null;
        const twin = try std.fmt.allocPrint(self.gpa, "{s}{s}", .{ cand, suffix });
        defer self.gpa.free(twin);
        return (try self.liveChild(user_id, parent_id, twin)) == null;
    }

    /// `parent_id` in any state; `restore` chases trashed ancestors with it.
    fn parentOf(self: Files, user_id: u64, id: u64) !?u64 {
        var r = (try self.db.row("SELECT parent_id FROM files WHERE id = ?1 AND user_id = ?2;", &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } })) orelse return null;
        defer r.finalize();
        const pid = r.int(0);
        return if (pid == 0) null else @intCast(pid);
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
            cur = try self.parentOf(user_id, c);
        }
        return false;
    }

    /// Charged bytes and quota, as `get_space_usage` reports them.
    pub const Cap = struct { used: i64, total: i64 };

    /// Quota for a user with no `capacity` row; one definition shared with the
    /// db layer and the v10 repair migration.
    pub const default_total_bytes: i64 = authsvc.default_capacity;

    /// A missing row reads as 0 used of the default (nothing stored yet).
    pub fn capacity(self: Files, user_id: u64) !Cap {
        var r = (try self.db.row("SELECT used_bytes, total_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse
            return .{ .used = 0, .total = default_total_bytes };
        defer r.finalize();
        return .{ .used = r.int(0), .total = r.int(1) };
    }

    /// The account screen's five-way split of charged bytes, over distinct blobs.
    /// A partition by precedence, so each blob counts once: live kinds (notebook <
    /// sketch < document on ties), then recycle bin (trashed files and their
    /// history), then versions (history of live files only). So the bin line is
    /// what emptying it returns, and versions is versioning's marginal cost.
    pub const StorageBreakdown = struct {
        notebooks: i64 = 0,
        sketches: i64 = 0,
        documents: i64 = 0,
        recycle_bin: i64 = 0,
        versions: i64 = 0,

        /// Equals `capacity.used_bytes`; the partition test asserts it.
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

    /// `config.History.max_keep`, but never below the configured default (an
    /// older install's larger `keep` must not be silently clamped).
    fn historyCeiling(self: Files) u32 {
        return @max(self.history.keep, self.history.max_keep);
    }

    /// `keep` is effective (default for users who never chose); `max_keep` is the
    /// ceiling, and stored values above it are clamped.
    pub const VersionPolicy = struct { keep: u32, max_keep: u32 };

    pub fn versionPolicy(self: Files, user_id: u64) !VersionPolicy {
        // Untouched accounts get the default, not the ceiling.
        const ceiling = self.historyCeiling();
        const fallback: VersionPolicy = .{ .keep = self.history.keep, .max_keep = ceiling };
        var r = (try self.db.row("SELECT history_keep FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse
            return fallback;
        defer r.finalize();
        const stored = r.intOpt(0) orelse return fallback;
        const clamped: u32 = if (stored <= 0) 0 else @intCast(@min(stored, @as(i64, ceiling)));
        return .{ .keep = clamped, .max_keep = ceiling };
    }

    /// Retained-version counts per live file, so the settings control can state
    /// what lowering `keep` will discard before it happens (discards skip the bin).
    /// Live files only: lowering `keep` does not touch trashed files' history.
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

    /// The policy now in force and what the change discarded, so the UI can
    /// confirm its prediction.
    pub const VersionPolicyChange = struct {
        policy: VersionPolicy,
        removed_versions: u32 = 0,
        freed_bytes: i64 = 0,
    };

    /// Sets the user's version depth (clamped to the ceiling), evicting at once
    /// via `evictHistory`. `keep = 0` turns versioning off. Refunds are settled
    /// from post-delete rows; blob files are removed after COMMIT.
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

        // Selected before deleting, so the set cannot shift.
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
            .freed_bytes = -delta,
        };
    }

    /// Ensures a `capacity` row exists; otherwise `addUsed` matches zero rows for
    /// users created without one and quota is silently off.
    fn ensureCapacity(self: Files, user_id: u64) !void {
        var s = try self.db.prepare("INSERT OR IGNORE INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, ?2);");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, default_total_bytes);
        _ = try s.step();
    }

    fn addUsed(self: Files, user_id: u64, delta: i64) !void {
        try self.ensureCapacity(user_id); // or the UPDATE no-ops
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

    /// Removes a blob and every derived file after the releasing transaction
    /// commits. Every post-commit GC site calls this, never `blobs.remove`.
    fn removeBlobFiles(self: Files, md5: []const u8) void {
        self.blobs.remove(md5);
        self.thumbs.remove(md5);
        // Every version: this side does not know which exist.
        if (self.terms) |t| t.removeAll(md5);
        if (self.text) |t| t.removeAll(md5);
    }

    /// Decrements `blobs.refcount` (live-file references) and runs the GC gate.
    /// True means: remove the bytes after commit.
    fn decref(self: Files, md5: []const u8) !bool {
        {
            var s = try self.db.prepare("UPDATE blobs SET refcount = refcount - 1 WHERE md5 = ?1;");
            defer s.finalize();
            s.bindText(1, md5);
            _ = try s.step();
        }
        return self.reapIfUnreferenced(md5);
    }

    /// The single GC gate: reaps a blob (FTS, note/`.spd` index, `blobs` row) only
    /// when no live file and no `file_history` row holds it. Separate from
    /// `decref` because history eviction reaps without decrementing again.
    fn reapIfUnreferenced(self: Files, md5: []const u8) !bool {
        var rc: i64 = 0;
        {
            if (try self.db.row("SELECT refcount FROM blobs WHERE md5 = ?1;", &.{.{ .text = md5 }})) |r| {
                defer r.finalize();
                rc = r.int(0);
            }
        }
        if (rc > 0) return false; // a live file still references it

        // Checked even with `keep == 0`, so disabling versioning cannot strand a row.
        {
            var s = try self.db.prepare("SELECT 1 FROM file_history WHERE md5 = ?1 LIMIT 1;");
            defer s.finalize();
            s.bindText(1, md5);
            if (try s.step()) return false;
        }

        // The index dies with the blob, in this transaction (CASCADE is the backstop).
        try noteindex.deleteForBlob(self.db, md5);
        try spdindex.deleteForBlob(self.db, md5); // intent; the FK cascade is the backstop
        var s = try self.db.prepare("DELETE FROM blobs WHERE md5 = ?1;");
        defer s.finalize();
        s.bindText(1, md5);
        _ = try s.step();
        return true;
    }

    /// Appends a superseded version, in the same transaction as the repoint and
    /// decref. The row is itself the blob's keep-alive.
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

    /// Install-wide retained footprint: distinct history blobs no live file holds.
    fn historyBytes(self: Files) !u64 {
        var r = (try self.db.row(
            "SELECT COALESCE(SUM(size), 0) FROM blobs " ++
                "WHERE refcount = 0 AND md5 IN (SELECT md5 FROM file_history);",
            &.{},
        )) orelse return 0;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// The size travels with it: the `blobs` row may already be gone at settlement.
    const Evicted = struct { md5: [md5_len]u8, size: i64 };

    /// Enforces both history bounds after a retain: (a) per-file K (the owner's),
    /// (b) the global `max_bytes`, by evicting this user's oldest history-only
    /// versions and never another user's. Collects GC md5s and evicted versions.
    /// Inside the supersede transaction; only when K > 0.
    fn evictHistory(
        self: Files,
        user_id: u64,
        file_id: u64,
        keep: u32,
        gc: *std.ArrayList([md5_len]u8),
        evicted: *std.ArrayList(Evicted),
    ) !void {
        // (a) per-file K.
        {
            const before = evicted.items.len;

            // Collect, then delete: deleting under a live cursor is safe here only by
            // accident of the query plan.
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
                var d = try self.db.prepare("DELETE FROM file_history WHERE rowid = ?1;");
                defer d.finalize();
                for (doomed_ids.items) |rowid| {
                    d.reset();
                    d.bindInt(1, rowid);
                    _ = try d.step();
                }
            }
            // Reap after all deletes, so a blob shared by two versions is reaped once.
            var doomed: std.ArrayList([md5_len]u8) = .empty;
            defer doomed.deinit(self.gpa);
            for (evicted.items[before..]) |*e| try doomed.append(self.gpa, e.md5);
            try self.reapDistinct(doomed.items, gc);
        }

        // (b) the `max_bytes` backstop, one row per pass.
        while (try self.historyBytes() > self.history.max_bytes) {
            const dropped = (try self.evictOldestVersion(user_id, gc)) orelse break;
            try evicted.append(self.gpa, dropped);
        }
    }

    /// Drops the user's oldest retained version whose blob no file of theirs holds
    /// (so each eviction frees something), or null.
    fn evictOldestVersion(self: Files, user_id: u64, gc: *std.ArrayList([md5_len]u8)) !?Evicted {
        var out: Evicted = .{ .md5 = undefined, .size = 0 };
        // Read the row, release the cursor, then delete.
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

    // ---- history reads + restore ----

    /// Retained versions of a live file, newest first. A foreign or trashed id
    /// yields an empty list. Allocated in `alloc`.
    pub fn fileHistory(self: Files, alloc: std.mem.Allocator, user_id: u64, file_id: u64) ![]HistoryVersion {
        return self.fileHistoryIn(.live, alloc, user_id, file_id);
    }

    /// `fileHistory` gated to `scope`.
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

    /// The per-version gate: is `md5` a retained version of live file `file_id`
    /// owned by `user_id`? Every failure is the same null (one 404).
    pub fn historyVersion(self: Files, user_id: u64, file_id: u64, md5: []const u8) !?HistoryVersion {
        return self.historyVersionIn(.live, user_id, file_id, md5);
    }

    /// `historyVersion` gated to `scope`.
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

    /// Restores a retained version through the upload supersede path, so it is
    /// re-derived and the displaced current is retained (restore is undoable).
    /// `md5` must be validated by `historyVersion`. QuotaExceeded changes nothing.
    pub fn restoreVersion(self: Files, user_id: u64, file_id: u64, md5: []const u8) !Entry {
        const v = (try self.historyVersion(user_id, file_id, md5)) orelse return error.NotFound;
        const entry = (try self.get(user_id, file_id)) orelse return error.NotFound;
        defer self.gpa.free(entry.name);
        defer if (entry.md5) |m| self.gpa.free(m);
        if (entry.is_folder) return error.NotFound;

        // Same name and parent supersedes this very row; `file_id` is unchanged.
        const linked = try self.linkBlobIndexed(user_id, entry.parent_id, entry.name, &v.md5, v.size, null);

        // The restored version is current now; drop its history row for this file.
        self.dropFileHistoryVersion(file_id, &v.md5) catch {};
        return linked;
    }

    /// Never decrefs or GCs: the live file references the blob.
    fn dropFileHistoryVersion(self: Files, file_id: u64, md5: []const u8) !void {
        var s = try self.db.prepare("DELETE FROM file_history WHERE file_id = ?1 AND md5 = ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(file_id));
        s.bindText(2, md5);
        _ = try s.step();
    }

    /// Reaps each distinct md5 through the GC gate.
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

    /// Existence in any state, scoped to the user.
    fn exists(self: Files, user_id: u64, id: u64) !bool {
        var s = try self.db.prepare("SELECT 1 FROM files WHERE id = ?1 AND user_id = ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(id));
        s.bindInt(2, @intCast(user_id));
        return try s.step();
    }

    /// In the bin only; `purge` relies on it.
    fn existsTrashed(self: Files, user_id: u64, id: u64) !bool {
        var s = try self.db.prepare("SELECT 1 FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 1;");
        defer s.finalize();
        s.bindInt(1, @intCast(id));
        s.bindInt(2, @intCast(user_id));
        return try s.step();
    }

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

    // ---- on-demand derived-thumbnail repair ----

    /// Extractor by the blob's own magic (the URL has no name); missing is `.none`.
    fn thumbSourceKind(self: Files, md5: []const u8) thumbnail.SourceKind {
        var head: [thumbnail.source_probe_len]u8 = undefined;
        const size = self.blobs.sizeOf(md5) catch return .none;
        const n: usize = @intCast(@min(size, head.len));
        const bytes = self.blobs.readRange(md5, 0, n, head[0..n]) catch return .none;
        return thumbnail.sourceKind(bytes);
    }

    /// Does `/thumbnail/{hash}` need a re-derive first? Asks the format's memo; a
    /// blob neither format claims is false and 404s without deriving. O(1) probes.
    pub fn thumbNeedsRepair(self: Files, md5: []const u8) bool {
        return switch (self.thumbSourceKind(md5)) {
            .spd => spdindex.needsRepair(self.db, self.thumbs, md5) catch false,
            .note => noteindex.needsRepair(self.db, self.thumbs, md5) catch false,
            .none => false,
        };
    }

    /// Chooses streaming a `.note` cover from the blob vs a `.spd` thumbnail.
    pub fn thumbnailSourceKind(self: Files, md5: []const u8) thumbnail.SourceKind {
        return self.thumbSourceKind(md5);
    }

    /// A `.note` cover's recorded location, or null; streamed from the blob.
    pub fn noteCover(self: Files, md5: []const u8) !?noteindex.CoverLocation {
        return noteindex.coverLocation(self.db, md5);
    }

    /// Lazily re-derives a missing/stale index row and `thumbs/` file on first
    /// request (old schemas, version bumps, restores without `thumbs/`).
    /// Best-effort; a corrupt blob's `indexable = 0` row makes it a one-time cost.
    /// `lk` exposes `lockDb()`/`unlockDb()`. The caller must not hold the db lock:
    /// the derive runs off it, and the order is repair mutex → db lock.
    pub fn repairDerivedThumb(self: *Files, lk: anytype, md5: []const u8) void {
        // A reader view's gate is unshared, so repairing here would lose the
        // single-flight bound. Unreachable: `/thumbnail` is `manual_db_lock`.
        if (self.read_only) return;
        self.thumb_repair.lockUncancelable(self.io);
        defer self.thumb_repair.unlock(self.io);

        const kind = self.thumbSourceKind(md5);
        if (kind == .none) return;

        // Double-check under the mutex: a waiter may find the work done.
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

        // Derive off the db lock, disk before commit, then a brief locked write.
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
                // A cover writes no thumbs file, only the index row the serve path reads.
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

/// Strips one trailing ` (n)` (all digits), so `Budget (draft)` survives.
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

    /// `used_bytes` rebuilt from the tables: distinct blobs held by the user's
    /// files (trashed included) and their history rows.
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

    /// The five categories sum exactly to `used_bytes`, and that to the rebuild.
    fn expectPartition(f: *Fixture, user_id: u64) !void {
        const b = try f.files.storageBreakdown(user_id);
        try testing.expectEqual(try f.trueUsed(user_id), b.total());
        try testing.expectEqual(try f.used(user_id), b.total());
    }

    /// Running total equals the reconstruction.
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
    const b = try putBytes(&f, 1, notes.id, "lease.pdf", "bbbb");
    defer freeEntry(b);
    const deep = try putBytes(&f, 1, sub.id, "deep.note", "cccc");
    defer freeEntry(deep);

    try testing.expectEqual(@as(i64, 3), try f.files.childCount(1, notes.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, sub.id));

    try f.files.trash(1, b.id);
    const entries = try f.files.list(1, notes.id);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 2), entries.len); // Projects + a.note
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, notes.id));

    try f.files.trash(1, sub.id);
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, notes.id));

    const empty = try f.files.createFolder(1, null, "Empty");
    defer testing.allocator.free(empty.name);
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, empty.id));

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

    const entries = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 1), entries.len);
}

test "HISTORY: supersede RETAINS the old version — history row, blob on disk, render index kept" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

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

    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expect(f.files.blobs.has(&old_md5)); // the OLD blob is still on disk (not GC'd)
    try testing.expect((try noteIndexedAt(&f, &old_md5)) != null); // its render index rode along for free
    try testing.expectEqual(@as(i64, 0), try blobRefcount(&f, &old_md5));
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &old_md5));

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

    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expect(!f.files.blobs.has(&mds[0])); // v1 evicted -> blob GC'd
    try testing.expect(!f.files.blobs.has(&mds[1])); // v2 evicted -> blob GC'd
    try testing.expect(f.files.blobs.has(&mds[2])); // v3 retained
    try testing.expect(f.files.blobs.has(&mds[3])); // v4 retained
    try testing.expect(f.files.blobs.has(&mds[4])); // v5 is the live current
    try testing.expect((try noteIndexedAt(&f, &mds[0])) == null);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM blobs WHERE refcount < 0;")); // never over-decremented
}

test "HISTORY: eviction never DELETEs with a cursor open on file_history" {
    // Pins the collect-then-delete discipline via `sqlite.CursorWatch`; the
    // outcome is the same either way. Each arm needs its own configuration.
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

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
        try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
        try testing.expect(w.mutations > 0);
        try testing.expectEqual(@as(usize, 0), w.overlaps);
    }

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

    freeEntry(try putBytes(&f, 1, null, "n.note", "dddddddddd"));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1));
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    {
        const e = (try f.files.get(1, (try f.files.resolvePath(1, "/n.note")).?)).?;
        defer freeEntry(e);
        try testing.expectEqualStrings(&blobstore.md5HexOf("dddddddddd"), e.md5.?);
    }
    try testing.expectEqual(@as(i64, 0), try historyRows(&f, &blobstore.md5HexOf("aaaaaaaaaa")));
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &blobstore.md5HexOf("cccccccccc")));

    {
        var r = std.Io.Reader.fixed("x" ** 40);
        try testing.expectError(error.QuotaExceeded, f.files.putFile(1, null, "big.note", &r, null));
    }
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1));
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    freeEntry(try putBytes(&f, 1, null, "n.note", "eeeeeeeeee"));
    freeEntry(try putBytes(&f, 1, null, "n.note", "ffffffffff"));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1));
}

test "§6: eviction is PER-USER — one person's churn can no longer evict another's versions" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000;");
    f.files.history.keep = 100; // K is not the bound here
    f.files.history.max_bytes = 20; // a global ceiling this test blows through

    freeEntry(try putBytes(&f, 2, null, "u2.note", "user-two-original"));
    freeEntry(try putBytes(&f, 2, null, "u2.note", "user-two-edited!!"));
    const u2_rows = "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = 2;";
    try testing.expectEqual(@as(i64, 1), try countOf(&f, u2_rows));

    for (0..6) |i| {
        const body = try std.fmt.allocPrint(testing.allocator, "user-one-version-{d}", .{i});
        defer testing.allocator.free(body);
        freeEntry(try putBytes(&f, 1, null, "u1.note", body));
    }

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

    const a1 = try putBytes(&f, 1, null, "a.txt", "shared-content");
    const x = dupeMd5(a1.md5.?);
    freeEntry(a1);
    const b1 = try putBytes(&f, 1, null, "b.txt", "shared-content");
    defer freeEntry(b1);
    try testing.expect(std.mem.eql(u8, &x, b1.md5.?)); // deduped onto the same blob
    try testing.expectEqual(@as(i64, 2), try blobRefcount(&f, &x)); // two live refs

    const a2 = try putBytes(&f, 1, null, "a.txt", "a-new-content");
    defer freeEntry(a2);
    try testing.expectEqual(@as(i64, 1), try blobRefcount(&f, &x)); // b still live
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &x));
    try testing.expect(f.files.blobs.has(&x));

    const b2 = try putBytes(&f, 1, null, "b.txt", "b-new-content");
    defer freeEntry(b2);
    try testing.expectEqual(@as(i64, 0), try blobRefcount(&f, &x));
    try testing.expectEqual(@as(i64, 2), try historyRows(&f, &x));
    try testing.expect(f.files.blobs.has(&x)); // retained purely by history

    try f.files.trash(1, a2.id);
    try f.files.purge(1, a2.id);
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &x));
    try testing.expect(f.files.blobs.has(&x));

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

    const a = try f.files.createFolderPath(1, "/NOTE/Note/Trip", false);
    defer testing.allocator.free(a.name);
    try testing.expectEqualStrings("Trip", a.name);
    try testing.expect(a.is_folder);
    const p = try f.files.pathOf(testing.allocator, 1, a.id);
    defer testing.allocator.free(p);
    try testing.expectEqualStrings("/NOTE/Note/Trip", p);

    const again = try f.files.createFolderPath(1, "/NOTE/Note/Trip", false);
    defer testing.allocator.free(again.name);
    try testing.expectEqual(a.id, again.id);

    const renamed = try f.files.createFolderPath(1, "/NOTE/Note/Trip", true);
    defer testing.allocator.free(renamed.name);
    try testing.expectEqualStrings("Trip (2)", renamed.name);
    try testing.expect(renamed.id != a.id);

    const sibling = try f.files.createFolderPath(1, "/NOTE/Note/Other", true);
    defer testing.allocator.free(sibling.name);
    try testing.expectEqualStrings("Other", sibling.name);
    const note_id = (try f.files.resolvePath(1, "/NOTE/Note")).?;
    try testing.expectEqual(note_id, sibling.parent_id.?);

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

    try testing.expectError(error.NameConflict, f.files.createFolderPath(1, "/D/x", false));

    const renamed = try f.files.createFolderPath(1, "/D/x", true);
    defer testing.allocator.free(renamed.name);
    try testing.expectEqualStrings("x (2)", renamed.name);
    try testing.expect(renamed.is_folder);

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
    try testing.expectError(error.NameConflict, f.files.createFolder(1, null, "thing"));
    var r = std.Io.Reader.fixed("y");
    try testing.expectError(error.NameConflict, f.files.putFile(1, null, "Dir", &r, null));

    var r2 = std.Io.Reader.fixed("z");
    try testing.expectError(error.NotAFolder, f.files.putFile(1, file.id, "child", &r2, null));
    try testing.expectError(error.NotFound, f.files.createFolder(1, 9999, "x"));

    const u2list = try f.files.list(2, null);
    defer Files.freeEntries(testing.allocator, u2list);
    try testing.expectEqual(@as(usize, 0), u2list.len);
    try testing.expectError(error.NotFound, f.files.createFolder(2, dir.id, "x")); // dir belongs to user 1
    try testing.expect((try f.files.get(2, file.id)) == null);
}

test "pathOf derives full paths; ensureFolderPath is idempotent and nests" {
    var f = try Fixture.init();
    defer f.deinit();

    const note_id = try f.files.ensureFolderPath(1, "NOTE/Note");
    _ = try f.files.ensureFolderPath(1, "NOTE/MyStyle");
    const note_id2 = try f.files.ensureFolderPath(1, "NOTE/Note"); // no duplicate
    try testing.expectEqual(note_id, note_id2);

    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 1), root.len);
    try testing.expectEqualStrings("NOTE", root[0].name);
    const under_note = try f.files.list(1, root[0].id);
    defer Files.freeEntries(testing.allocator, under_note);
    try testing.expectEqual(@as(usize, 2), under_note.len);

    const file = try putBytes(&f, 1, note_id, "foo.note", "data");
    defer freeEntry(file);
    const p = try f.files.pathOf(testing.allocator, 1, file.id);
    defer testing.allocator.free(p);
    try testing.expectEqualStrings("/NOTE/Note/foo.note", p);

    const rootfile = try putBytes(&f, 1, null, "top.note", "x");
    defer freeEntry(rootfile);
    const rp = try f.files.pathOf(testing.allocator, 1, rootfile.id);
    defer testing.allocator.free(rp);
    try testing.expectEqualStrings("/top.note", rp);

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

    try testing.expectEqual(@as(usize, 4), nodes.len);

    try testing.expectEqualStrings("NOTE", nodes[0].name);
    try testing.expect(nodes[0].is_folder);
    try testing.expectEqualStrings("/NOTE", nodes[0].path_display);
    try testing.expectEqualStrings("/", nodes[0].parent_path);
    try testing.expectEqualStrings("", nodes[0].md5);
    try testing.expectEqual(@as(u64, 0), nodes[0].size);

    const file = nodes[2];
    try testing.expectEqual(a_id, file.id);
    try testing.expectEqualStrings("a.note", file.name);
    try testing.expect(!file.is_folder);
    try testing.expectEqualStrings("/NOTE/Note/a.note", file.path_display);
    try testing.expectEqualStrings("/NOTE/Note", file.parent_path);
    try testing.expectEqualStrings(&blobstore.md5HexOf("aaaa"), file.md5);
    try testing.expectEqual(@as(u64, 4), file.size);

    try testing.expectEqualStrings("/top.note", nodes[3].path_display);
    try testing.expectEqualStrings("/", nodes[3].parent_path);

    const byid = (try f.files.nodeById(arena.allocator(), 1, a_id)).?;
    try testing.expectEqualStrings("/NOTE/Note/a.note", byid.path_display);
    try testing.expectEqualStrings("/NOTE/Note", byid.parent_path);
    try testing.expect((try f.files.nodeById(arena.allocator(), 1, 99999)) == null);
    try testing.expect((try f.files.nodeById(arena.allocator(), 2, a_id)) == null); // foreign user

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

    try testing.expectEqual(@as(i64, 0), try f.files.syncVersion(2));
}

test "linkBlob links a pre-stored blob, replaces, and enforces quota" {
    var f = try Fixture.init();
    defer f.deinit();

    var r = std.Io.Reader.fixed("note bytes");
    const res = try f.files.blobs.put(&r, null);
    try testing.expect(f.files.blobs.has(&res.md5));

    const e = try f.files.linkBlob(1, null, "a.note", &res.md5, res.size);
    defer freeEntry(e);
    try testing.expectEqualStrings(&res.md5, e.md5.?);
    try testing.expectEqual(res.size, e.size);
    try testing.expectEqual(@as(i64, @intCast(res.size)), try f.used(1));
    try testing.expectEqual(@as(i64, 1), try f.files.syncVersion(1));

    var big: [1025]u8 = undefined;
    @memset(&big, 'x');
    var rb = std.Io.Reader.fixed(&big);
    const rbig = try f.files.blobs.put(&rb, null);
    try testing.expectError(error.QuotaExceeded, f.files.linkBlob(1, null, "big", &rbig.md5, rbig.size));
    try testing.expect(f.files.blobs.has(&rbig.md5));
    try testing.expectEqual(@as(i64, @intCast(res.size)), try f.used(1)); // unchanged
}

test "upload session sweep drops stale sessions and reclaims only untracked blobs" {
    var f = try Fixture.init();
    defer f.deinit();
    const alloc = testing.allocator;

    var ra = std.Io.Reader.fixed("orphaned upload");
    const oa = try f.files.blobs.put(&ra, null);
    try f.files.createUploadSession(1, "aaaaaaaaaaaaaaaa", "/NOTE", "a.note", oa.size);
    try f.files.setUploadBlob(1, "aaaaaaaaaaaaaaaa", &oa.md5);

    const shared = try putBytes(&f, 1, null, "kept.note", "shared bytes");
    defer freeEntry(shared);
    try f.files.createUploadSession(1, "bbbbbbbbbbbbbbbb", "/NOTE", "b.note", shared.size);
    try f.files.setUploadBlob(1, "bbbbbbbbbbbbbbbb", shared.md5.?);

    try testing.expect(f.files.blobs.has(&oa.md5));
    try testing.expect(f.files.blobs.has(shared.md5.?));

    const swept = try f.files.sweepUploadSessions(-1);
    try testing.expectEqual(@as(usize, 2), swept);

    try testing.expect((try f.files.uploadSession(alloc, 1, "aaaaaaaaaaaaaaaa")) == null);
    try testing.expect((try f.files.uploadSession(alloc, 1, "bbbbbbbbbbbbbbbb")) == null);
    try testing.expect(!f.files.blobs.has(&oa.md5));
    try testing.expect(f.files.blobs.has(shared.md5.?));

    try f.files.createUploadSession(1, "cccccccccccccccc", "/NOTE", "c.note", 10);
    try testing.expectEqual(@as(usize, 0), try f.files.sweepUploadSessions(3600));
    const young = (try f.files.uploadSession(alloc, 1, "cccccccccccccccc")).?;
    alloc.free(young.path);
    alloc.free(young.file_name);
    if (young.blob_md5) |m| alloc.free(m);
}

test "addUploadReceived accumulates per session, credits a replaced part, and clamps at zero" {
    var f = try Fixture.init();
    defer f.deinit();
    const alloc = testing.allocator;

    try f.files.createUploadSession(1, "aaaaaaaaaaaaaaaa", "/NOTE", "a.note", 1000);
    try f.files.createUploadSession(2, "bbbbbbbbbbbbbbbb", "/NOTE", "b.note", 1000);

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

    try testing.expectEqual(@as(u64, 700), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", -300 + 300));

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

    // A negative total read back as u64 would switch the cap off.
    try testing.expectEqual(@as(u64, 0), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", -100_000));

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

    // A user with no capacity row (e.g. admin createUser).
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(3, 'q@z.c', '0123456789abcdef0123456789abcdef', 0);");
    try testing.expect(!try hasCapacityRow(&f, 3));

    const a = try putBytes(&f, 3, null, "a.note", "aaaa"); // 4 bytes
    defer freeEntry(a);
    try testing.expect(try hasCapacityRow(&f, 3)); // ensureCapacity created it
    try testing.expectEqual(@as(i64, 4), try f.used(3)); // accounting is live

    {
        var s = try f.db.prepare("UPDATE capacity SET total_bytes = 5 WHERE user_id = 3;");
        defer s.finalize();
        _ = try s.step();
    }
    var r = std.Io.Reader.fixed("bb"); // 4 + 2 = 6 > 5
    try testing.expectError(error.QuotaExceeded, f.files.putFile(3, null, "b.note", &r, null));
    try testing.expectEqual(@as(i64, 4), try f.used(3)); // rolled back, unchanged
}

test "THE BIN TEST: a restored file gives back READABLE BYTES, not just a cleared flag" {
    var f = try Fixture.init();
    defer f.deinit();

    // Reads the bytes back: a flag-only check passed while the blob was GC'd.
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

    const back = (try f.files.get(1, e.id)).?;
    defer freeEntry(back);
    try testing.expectEqualStrings("BuJo.note", back.name);
    try testing.expectEqual(@as(u64, body.len), back.size);

    var buf: [256]u8 = undefined;
    const read = try f.files.blobs.readRange(back.md5.?, 0, body.len, &buf);
    try testing.expectEqualSlices(u8, body, read);
    try testing.expectEqualStrings(&blobstore.md5HexOf(body), back.md5.?);
}

test "THE DEDUP TEST: a blob shared by two files survives one being trashed, and one being purged" {
    var f = try Fixture.init();
    defer f.deinit();

    const body = "identical note payload";
    const a = try putBytes(&f, 1, null, "a.note", body);
    defer freeEntry(a);
    const b = try putBytes(&f, 1, null, "b.note", body);
    defer freeEntry(b);

    const md5 = dupeMd5(a.md5.?);
    try testing.expectEqualStrings(&md5, b.md5.?);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT refcount FROM blobs;"));

    try f.files.trash(1, a.id);
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT refcount FROM blobs;"));
    try testing.expect(f.files.blobs.has(&md5));

    try f.files.purge(1, a.id);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT refcount FROM blobs;"));
    try testing.expect(f.files.blobs.has(&md5));

    const kept = (try f.files.get(1, b.id)).?;
    defer freeEntry(kept);
    var buf: [64]u8 = undefined;
    try testing.expectEqualSlices(u8, body, try f.files.blobs.readRange(kept.md5.?, 0, body.len, &buf));

    try f.files.trash(1, b.id);
    try f.files.purge(1, b.id);
    try testing.expect(!f.files.blobs.has(&md5));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
}

test "THE QUOTA AUDIT: used_bytes equals the reconstructed sum after every mutation" {
    var f = try Fixture.init();
    defer f.deinit();

    try f.expectQuotaBalanced(1);

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try f.expectQuotaBalanced(1); // a folder charges nothing

    const a = try putBytes(&f, 1, dir.id, "a", "aaaa");
    freeEntry(a);
    const b = try putBytes(&f, 1, dir.id, "b", "bbbbbb");
    freeEntry(b);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    // Byte-identical to "a": the same blob, charged once.
    const c = try putBytes(&f, 1, null, "c", "aaaa");
    const shared = dupeMd5(c.md5.?);
    freeEntry(c);
    try testing.expect(f.files.blobs.has(&shared));
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 10), try f.used(1)); // NOT 14

    const d = try putBytes(&f, 1, dir.id, "d", "aaaa");
    freeEntry(d);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    const b2 = try putBytes(&f, 1, dir.id, "b", "bb");
    freeEntry(b2);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 12), try f.used(1)); // 4 shared + 2 current + 6 retained

    const b3 = try putBytes(&f, 1, dir.id, "b", "aaaa");
    freeEntry(b3);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 12), try f.used(1)); // 4 shared + 6 + 2, both retained

    try f.files.trash(1, dir.id);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 12), try f.used(1));

    try f.files.purge(1, dir.id);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 4), try f.used(1));
    try testing.expect(f.files.blobs.has(&shared));

    const c_id = (try f.files.resolvePath(1, "/c")).?;
    try f.files.trash(1, c_id);
    try f.files.purge(1, c_id);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try testing.expect(!f.files.blobs.has(&shared));
}

test "the quota audit holds across users sharing one blob" {
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
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 3;

    try f.expectPartition(1);

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try f.expectPartition(1); // a folder references no blob

    const note = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v1");
    freeEntry(note);
    const spd = try putBytes(&f, 1, dir.id, "sketch.spd", "sketch-bytes");
    freeEntry(spd);
    const pdf = try putBytes(&f, 1, dir.id, "lease.pdf", "document-bytes");
    freeEntry(pdf);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expect(b.notebooks > 0 and b.sketches > 0 and b.documents > 0);
        try testing.expectEqual(@as(i64, 0), b.recycle_bin);
        try testing.expectEqual(@as(i64, 0), b.versions);
        try testing.expectEqual(try f.used(1), b.total()); // no history yet: meter == sum
    }

    const odd = try putBytes(&f, 1, dir.id, "README", "no-extension-bytes");
    freeEntry(odd);
    try f.expectPartition(1);

    {
        const before = (try f.files.storageBreakdown(1)).documents;
        const dup = try putBytes(&f, 1, null, "copy.pdf", "document-bytes");
        freeEntry(dup);
        try f.expectPartition(1);
        try testing.expectEqual(before, (try f.files.storageBreakdown(1)).documents);
    }

    const note2 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v2");
    freeEntry(note2);
    try f.expectPartition(1);
    try testing.expect((try f.files.storageBreakdown(1)).versions > 0);

    const note3 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v3");
    freeEntry(note3);
    const note4 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v4");
    freeEntry(note4);
    try f.expectPartition(1);

    {
        const b = try f.files.storageBreakdown(1);
        try testing.expect(b.versions > 0);
        try testing.expectEqual(try f.used(1), b.total());
    }

    f.files.history.keep = 1; // K lowered; the next supersede re-applies it
    const note5 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v5");
    freeEntry(note5);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    const note_id = (try f.files.resolvePath(1, "/Dir/bujo.note")).?;
    try f.files.trash(1, note_id);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(@as(i64, 0), b.versions); // the live-file history is gone with it
        try testing.expect(b.recycle_bin > 0);
    }

    (try f.files.restore(1, note_id)).deinit(testing.allocator);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(@as(i64, 0), b.recycle_bin);
        try testing.expect(b.versions > 0);
        try testing.expect(b.notebooks > 0);
    }

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

    const a = try putBytes(&f, 1, null, "shared.note", "shared-notebook");
    freeEntry(a);
    const b = try putBytes(&f, 2, null, "shared.note", "shared-notebook");
    freeEntry(b);
    freeEntry(try putBytes(&f, 1, null, "shared.note", "user-1-edit"));
    freeEntry(try putBytes(&f, 2, null, "shared.note", "user-2-edit"));

    try f.expectPartition(1);
    try f.expectPartition(2);

    const id2 = (try f.files.resolvePath(2, "/shared.note")).?;
    try f.files.trash(2, id2);
    try f.files.purge(2, id2);
    try f.expectPartition(1);
    try f.expectPartition(2);
    try testing.expectEqual(@as(i64, 0), (try f.files.storageBreakdown(2)).total());
    try testing.expect((try f.files.storageBreakdown(1)).total() > 0);
}

test "setVersionPolicy: lowering evicts NOW, refunds the bytes, and keeps the partition exact" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 5;
    f.files.history.max_keep = 5; // default AND ceiling here, so the clamp below has a bound to hit

    inline for (.{ "v1", "v2", "v3", "v4", "v5" }) |body| {
        const e = try putBytes(&f, 1, null, "bujo.note", "notebook-" ++ body);
        freeEntry(e);
    }
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 4), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    {
        const counts = try f.files.retainedPerFile(testing.allocator, 1);
        defer testing.allocator.free(counts);
        try testing.expectEqualSlices(u32, &.{4}, counts);
    }

    const before = try f.used(1);
    const change = try f.files.setVersionPolicy(1, 1);

    try testing.expectEqual(@as(u32, 1), change.policy.keep);
    try testing.expectEqual(@as(u32, 3), change.removed_versions);
    try testing.expect(change.freed_bytes > 0);
    try testing.expectEqual(before - change.freed_bytes, try f.used(1));
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try f.expectPartition(1);

    const raised = try f.files.setVersionPolicy(1, 4);
    try testing.expectEqual(@as(u32, 0), raised.removed_versions);
    try testing.expectEqual(@as(i64, 0), raised.freed_bytes);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try f.expectPartition(1);

    const over = try f.files.setVersionPolicy(1, 9999);
    try testing.expectEqual(@as(u32, 5), over.policy.keep);
    try testing.expectEqual(@as(u32, 5), over.policy.max_keep);

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

    f.files.history.keep = 5;
    f.files.history.max_keep = 15;
    {
        const p = try f.files.versionPolicy(1);
        try testing.expectEqual(@as(u32, 5), p.keep);
        try testing.expectEqual(@as(u32, 15), p.max_keep);
    }
    {
        const c = try f.files.setVersionPolicy(1, 12);
        try testing.expectEqual(@as(u32, 12), c.policy.keep);
        try testing.expectEqual(@as(u32, 12), (try f.files.versionPolicy(1)).keep);
    }
    {
        const c = try f.files.setVersionPolicy(1, 99);
        try testing.expectEqual(@as(u32, 15), c.policy.keep); // clamped to the ceiling
    }

    // A pre-`max_keep` install with `keep = 20` must not be clamped to 15.
    f.files.history.keep = 20;
    f.files.history.max_keep = 15;
    {
        const p = try f.files.versionPolicy(2);
        try testing.expectEqual(@as(u32, 20), p.keep); // untouched
        try testing.expectEqual(@as(u32, 20), p.max_keep); // and choosable
    }
}

test "setVersionPolicy is per-user: lowering your dial never touches a housemate's history" {
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

test "a link that fails takes the thumbnail with the blob, not just the blob" {
    // Thumbnail seeded directly: the cleanup is under test, not a parse.
    var f = try Fixture.init();
    defer f.deinit();

    const bytes = "content that will not fit";
    const md5 = blobstore.md5HexOf(bytes);
    try f.files.thumbs.put(&md5, "fake-thumb-bytes");
    try testing.expect(f.files.thumbs.has(&md5));

    try f.db.exec("UPDATE capacity SET total_bytes = 1 WHERE user_id = 1;");
    try testing.expectError(error.QuotaExceeded, putBytes(&f, 1, null, "too-big.note", bytes));

    try testing.expect(!f.files.thumbs.has(&md5));
    try testing.expect(!f.files.blobs.has(&md5));
}

test "quota keeps charging while trashed and is refunded only at purge" {
    var f = try Fixture.init();
    defer f.deinit();

    const e = try putBytes(&f, 1, null, "a.note", "0123456789"); // 10 bytes
    defer freeEntry(e);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    try f.files.trash(1, e.id);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

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

    try f.files.trash(1, a.id);
    try f.files.trash(1, b.id);
    try f.files.trash(1, dir.id);
    try testing.expectEqual(@as(i64, 3), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));

    try f.files.trash(1, a.id);
    try f.files.trash(1, dir.id);
    try testing.expectEqual(@as(i64, 3), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));

    try testing.expectError(error.NotFound, f.files.trash(1, 9999));
    try testing.expectError(error.NotFound, f.files.trash(2, dir.id));

    const dir2 = try f.files.createFolder(1, null, "Dir2");
    defer testing.allocator.free(dir2.name);
    const sub = try f.files.createFolder(1, dir2.id, "Sub");
    defer testing.allocator.free(sub.name);
    const c = try putBytes(&f, 1, sub.id, "c.note", "ccc");
    defer freeEntry(c);

    try f.files.trash(1, dir2.id);
    try testing.expectEqual(@as(i64, 6), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 0;"));

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

    const v2 = try putBytes(&f, 1, null, "BuJo.note", "second body");
    defer freeEntry(v2);

    const r = try f.files.restore(1, v1.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("BuJo (2).note", r.name); // suffix on the STEM, extension kept
    try testing.expect(r.renamed); // …and the caller is TOLD, or the UI lies about the name

    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 2), root.len);
    var buf: [64]u8 = undefined;
    const restored = (try f.files.get(1, v1.id)).?;
    defer freeEntry(restored);
    try testing.expectEqualSlices(u8, "first body", try f.files.blobs.readRange(restored.md5.?, 0, 10, &buf));

    try f.files.trash(1, v1.id);
    const occupier = try putBytes(&f, 1, null, "BuJo (2).note", "occupier");
    defer freeEntry(occupier);
    const again = try f.files.restore(1, v1.id);
    defer again.deinit(testing.allocator);
    try testing.expectEqualStrings("BuJo (3).note", again.name);

    try testing.expectEqualStrings("Budget (draft)", stripSuffix("Budget (draft)"));
    try testing.expectEqualStrings("Notes", stripSuffix("Notes (2024)"));
    try testing.expectEqualStrings("(2)", stripSuffix("(2)")); // no base to keep

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

    const kids = try f.files.list(1, dir.id);
    defer Files.freeEntries(testing.allocator, kids);
    try testing.expectEqual(@as(usize, 2), kids.len);
    try testing.expectEqualStrings("a (2).note", kids[0].name);
    try testing.expectEqualStrings("a.note", kids[1].name);

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

    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = deleted_at - ?1 WHERE id = ?2;");
        defer s.finalize();
        s.bindInt(1, Files.bin_retention_s + 60);
        s.bindInt(2, @intCast(old.id));
        _ = try s.step();
    }

    try testing.expectEqual(@as(usize, 1), try f.files.sweepBin(Files.bin_retention_s));

    try testing.expect(!f.files.blobs.has(&old_md5));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE id = 1;"));
    try testing.expectEqual(@as(i64, 20), try f.used(1)); // 11 + 9, "old body" refunded

    try testing.expect(f.files.blobs.has(recent.md5.?));
    (try f.files.restore(1, recent.id)).deinit(testing.allocator);
    freeEntry((try f.files.get(1, recent.id)).?);

    try testing.expectEqual(@as(usize, 0), try f.files.sweepBin(Files.bin_retention_s));
    freeEntry((try f.files.get(1, live.id)).?);
}

test "shortening the retention window purges nothing, and the sweep applies it going forward" {
    var f = try Fixture.init();
    defer f.deinit();
    const settings = @import("settings.zig");
    const set = settings.Settings.init(testing.io, f.db);

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

    {
        const cutoff = settings.sweepCutoff(now, try set.binRetention()).?;
        try testing.expectEqual(@as(usize, 0), try f.files.sweepBinBefore(cutoff));
    }

    const shortened = try set.setBinRetentionDays(7);
    try testing.expectEqual(@as(?i64, null), settings.sweepCutoff(now, shortened));
    try testing.expect(f.files.blobs.has(&md5));
    (try f.files.restore(1, entry.id)).deinit(testing.allocator); // still restorable
    freeEntry((try f.files.get(1, entry.id)).?);
    try f.files.trash(1, entry.id);

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

fn blobRefcount(f: *Fixture, md5: []const u8) !i64 {
    var r = (try f.db.row("SELECT refcount FROM blobs WHERE md5 = ?1;", &.{.{ .text = md5 }})) orelse return -1;
    defer r.finalize();
    return r.int(0);
}

fn historyRows(f: *Fixture, md5: []const u8) !i64 {
    var s = try f.db.prepare("SELECT COUNT(*) FROM file_history WHERE md5 = ?1;");
    defer s.finalize();
    s.bindText(1, md5);
    _ = try s.step();
    return s.columnInt(0);
}

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

    // The device deletes children first, so every ancestor is already a tombstone.
    try f.files.trash(1, e.id);
    try f.files.trash(1, sub.id);
    try f.files.trash(1, dir.id);

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
    // Explicit stamps: a coarse clock can put both in the same second.
    try f.db.exec("UPDATE files SET deleted_at = 100 WHERE name = 'loose.note';");
    try f.db.exec("UPDATE files SET deleted_at = 200 WHERE name IN ('Dir','inside.note');");

    const rows = try f.files.listBin(a, 1);
    try testing.expectEqual(@as(usize, 3), rows.len);
    try testing.expectEqual(@as(i64, 200), rows[0].deleted_at);
    try testing.expectEqual(@as(i64, 200), rows[1].deleted_at);
    try testing.expectEqualStrings("loose.note", rows[2].name);

    try testing.expect((try binRow(a, &f, 1, dir.id)).?.is_root);
    try testing.expect((try binRow(a, &f, 1, loose.id)).?.is_root);
    try testing.expect(!(try binRow(a, &f, 1, inside.id)).?.is_root);

    const folder_row = (try binRow(a, &f, 1, dir.id)).?;
    try testing.expectEqual(@as(u64, 0), folder_row.size);
    try testing.expect(folder_row.md5 == null);

    const kept = try putBytes(&f, 1, null, "kept.note", "kept");
    defer freeEntry(kept);
    try testing.expect((try binRow(a, &f, 1, kept.id)) == null);

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

    try f.files.trash(1, e.id);
    try testing.expectEqualStrings("/NOTE/Work/deep.note", (try binRow(a, &f, 1, e.id)).?.path);

    // Rename a live ancestor (device-reachable); the frozen path must not move.
    try f.db.exec("UPDATE files SET name = 'ARCHIVE' WHERE name = 'NOTE' AND user_id = 1;");
    const sub_path = try f.files.pathOf(testing.allocator, 1, sub.id);
    defer testing.allocator.free(sub_path);
    try testing.expectEqualStrings("/ARCHIVE/Work", sub_path);
    try testing.expectEqualStrings("/NOTE/Work/deep.note", (try binRow(a, &f, 1, e.id)).?.path);
}

test "trash writes deleted_path, restore clears it, and the empty bin exits early" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try testing.expectEqual(@as(usize, 0), (try f.files.listBin(a, 1)).len);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted_path IS NOT NULL;"));

    const dir = try f.files.createFolder(1, null, "NOTE");
    defer testing.allocator.free(dir.name);
    const e = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(e);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM files WHERE name = 'a.note' AND deleted_path IS NULL;"));

    try f.files.trash(1, e.id);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM files WHERE name = 'a.note' AND deleted_path = '/NOTE/a.note';"));
    try testing.expectEqualStrings("/NOTE/a.note", (try binRow(a, &f, 1, e.id)).?.path);

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

    const first = try putBytes(&f, 1, null, "again.note", "1");
    defer freeEntry(first);
    try f.files.trash(1, first.id); // frees the live name again
    const second = try putBytes(&f, 1, null, "again.note", "2");
    defer freeEntry(second);
    try f.files.trash(1, second.id);

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

    {
        const r = try f.files.restore(1, sub.id);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("Sub", r.name);
        try testing.expect(!r.renamed);
        try testing.expectEqual(@as(usize, 1), r.ancestors);
        try testing.expectEqual(@as(usize, 2), r.descendants);
    }

    {
        const again = try f.files.restore(1, sub.id);
        defer again.deinit(testing.allocator);
        try testing.expectEqual(@as(usize, 0), again.ancestors);
        try testing.expectEqual(@as(usize, 0), again.descendants);
        try testing.expect(!again.renamed);
    }

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

    try f.files.trash(1, c.id);
    try testing.expectEqual(@as(usize, 3), try f.files.liveSubtreeCount(1, dir.id));

    try testing.expectEqual(@as(usize, 0), try f.files.liveSubtreeCount(1, 99999));
    try testing.expectEqual(@as(usize, 0), try f.files.liveSubtreeCount(2, dir.id));
    try testing.expectEqual(@as(usize, 0), try f.files.liveSubtreeCount(1, c.id));
}

test "getTrashed sees the bin and ONLY the bin; get still sees only live rows" {
    var f = try Fixture.init();
    defer f.deinit();

    const e = try putBytes(&f, 1, null, "a.note", "aaa");
    defer freeEntry(e);

    {
        const live = (try f.files.get(1, e.id)).?;
        defer freeEntry(live);
        try testing.expectEqualStrings("a.note", live.name);
    }
    try testing.expect((try f.files.getTrashed(1, e.id)) == null);

    try f.files.trash(1, e.id);

    try testing.expect((try f.files.get(1, e.id)) == null);
    {
        const binned = (try f.files.getTrashed(1, e.id)).?;
        defer freeEntry(binned);
        try testing.expectEqualStrings("a.note", binned.name);
        try testing.expect(binned.md5 != null); // the blob reference is still held
    }

    try testing.expect((try f.files.getTrashed(2, e.id)) == null);
    try testing.expect((try f.files.getTrashed(1, 99999)) == null);
}

// ---- embedded-thumbnail ingest derivation + on-demand repair ----

/// JPEG magic plus filler, so derivation runs without a committed binary.
const spd_fake_jpeg = "\xff\xd8\xff\xe0" ++ ("thumbnail-pixels" ** 4);

/// A minimal in-memory `.spd` with an optional `config.thumbnail` row.
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

/// Stands in for the handler's `lockDb()`/`unlockDb()`.
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
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const spd_bytes = try buildSpd(testing.allocator, spd_fake_jpeg);
    defer testing.allocator.free(spd_bytes);

    const e = try putBytes(&f, 1, null, "drawing.spd", spd_bytes);
    defer freeEntry(e);
    const md5 = e.md5.?;

    try testing.expect(try spdindex.isCurrent(f.db, md5));
    try testing.expect(f.files.thumbs.has(md5));

    // A re-derive would overwrite this `indexed_at` sentinel.
    try f.db.exec("UPDATE spd_index SET indexed_at = 999;");
    const e2 = try putBytes(&f, 1, null, "copy.spd", spd_bytes);
    defer freeEntry(e2);
    try testing.expectEqual(@as(?i64, 999), try spdIndexedAt(&f, md5));

    const disguised = try buildSpd(testing.allocator, "\x89PNG\r\n\x1a\n" ++ ("z" ** 40));
    defer testing.allocator.free(disguised);
    const n = try putBytes(&f, 1, null, "secret.note", disguised);
    defer freeEntry(n);
    try testing.expect(!try spdindex.isCurrent(f.db, n.md5.?));
    try testing.expect(!f.files.thumbs.has(n.md5.?));

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

    try f.db.exec("DELETE FROM spd_index;");
    f.files.thumbs.remove(md5);
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try spdindex.isCurrent(f.db, md5));
    try testing.expect(f.files.thumbs.has(md5));
    try testing.expect(!try spdindex.needsRepair(f.db, f.files.thumbs, md5));

    f.files.thumbs.remove(md5);
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(f.files.thumbs.has(md5));

    try f.db.exec("UPDATE spd_index SET index_version = 0;");
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try spdindex.isCurrent(f.db, md5));

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

// ---- `.note` cover: ingest + repair ----

/// The synthetic `.note` builder, via the root build.zig's `note_builder` module.
const nb = @import("note_builder");

/// A minimal PNG head (320×240 IHDR).
const cover_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++
    "\x08\x02\x00\x00\x00" ++ ("p" ** 16);

/// A one-page `.note` with `cover` as its `COVER_2` block (null = coverless).
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
    var rbuf: [64]u8 = undefined;
    const got = try f.files.blobs.readRange(e.md5.?, loc.offset, loc.length, rbuf[0..@intCast(loc.length)]);
    try testing.expectEqualSlices(u8, cover_png, got);
    try testing.expect(!f.files.thumbNeedsRepair(e.md5.?));

    // The sentinel would be clobbered by any re-parse.
    const plain = try buildNote(testing.allocator, null);
    defer testing.allocator.free(plain);
    const p = try putBytes(&f, 1, null, "plain.note", plain);
    defer freeEntry(p);
    try testing.expect((try f.files.noteCover(p.md5.?)) == null);
    try f.db.exec("UPDATE note_index SET indexed_at = 999;");
    try testing.expect(!f.files.thumbNeedsRepair(p.md5.?));
    f.files.repairDerivedThumb(NoLock{}, p.md5.?); // gate inside: a no-op
    try testing.expectEqual(@as(?i64, 999), try noteIndexedAt(&f, p.md5.?));

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

    try testing.expect(!f.files.thumbs.has(md5));
    try testing.expect(!f.files.thumbNeedsRepair(md5));

    try f.db.exec("UPDATE note_index SET index_version = 3, cover_w = NULL, cover_h = NULL, " ++
        "cover_offset = NULL, cover_length = NULL, cover_mime = NULL;");
    try testing.expect(f.files.thumbNeedsRepair(md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try noteindex.isCurrent(f.db, md5));
    try testing.expect(!f.files.thumbs.has(md5)); // still no derived file
    try testing.expect((try f.files.noteCover(md5)) != null); // location restored

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

// ---- `.note` search derivation at ingest ----

/// A device capture: page 0 finished, page 1 still recognising.
const sample2_note = @embedFile("sample-2.note");

fn wireDerivedStores(f: *Fixture) !void {
    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    f.files.terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    f.files.text = try derivedstore.DerivedStore.init(testing.io, text_dir);
}

test "linking a .note writes BOTH derived files AT INGEST, skipping the page with no transcript" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    try wireDerivedStores(&f);

    const e = try putBytes(&f, 1, null, "notes.note", sample2_note);
    defer freeEntry(e);
    const md5 = e.md5.?;

    try testing.expect(f.files.terms.?.has(md5, derivesearch.index_version));
    try testing.expect(f.files.text.?.has(md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, f.files.terms.?, md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":2") != null);
    try testing.expectEqualStrings("{\"p\":0,\"t\":\"middle test\"}", lines.next().?);
    try testing.expect(lines.next() == null); // page 1 is still recognising

    const x = try derivedstore.readPlain(testing.allocator, f.files.text.?, md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    var xlines = std.mem.tokenizeScalar(u8, x, '\n');
    _ = xlines.next();
    const p0 = try std.json.parseFromSlice(std.json.Value, testing.allocator, xlines.next().?, .{});
    defer p0.deinit();
    try testing.expectEqual(@as(i64, 0), p0.value.object.get("p").?.integer);
    try testing.expect(p0.value.object.get("o") == null);
    try testing.expect(p0.value.object.get("l") == null);
    try testing.expectEqualStrings("Test\nMiddle\nTest", p0.value.object.get("t").?.string);
    try testing.expect(xlines.next() == null);
}

test "a .txt through the same path derives NOTHING — `indexable` is the gate" {
    var f = try Fixture.init();
    defer f.deinit();
    try wireDerivedStores(&f);

    const e = try putBytes(&f, 1, null, "readme.txt", "plain text, no magic");
    defer freeEntry(e);
    try testing.expect(!f.files.terms.?.has(e.md5.?, derivesearch.index_version));
    try testing.expect(!f.files.text.?.has(e.md5.?, derivesearch.index_version));
}

// ---- move / rename ----

/// A one-page `.note` with `labels` as finished recognition.
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

    const v1 = try f.files.syncVersion(1);
    {
        const moved = try f.files.move(1, a.id, docs.id, "b.note", false);
        defer freeEntry(moved);
        try testing.expectEqual(docs.id, moved.parent_id.?);
    }
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Docs/b.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Notes/b.note"));
    try testing.expect(try f.files.syncVersion(1) > v1);

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

    {
        const moved = try f.files.move(1, src.id, dst.id, "Src", false);
        defer freeEntry(moved);
        try testing.expectEqual(dst.id, moved.parent_id.?);
    }

    try testing.expectEqual(@as(?u64, src.id), try f.files.resolvePath(1, "/Dst/Src"));
    try testing.expectEqual(@as(?u64, inner.id), try f.files.resolvePath(1, "/Dst/Src/inner"));
    try testing.expectEqual(@as(?u64, deep.id), try f.files.resolvePath(1, "/Dst/Src/inner/deep.note"));
    try testing.expectEqual(@as(?u64, top.id), try f.files.resolvePath(1, "/Dst/Src/top.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Src"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Src/inner/deep.note"));

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

    try testing.expectError(error.NameConflict, f.files.move(1, a.id, notes.id, "b.note", false));
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Notes/a.note"));
    try testing.expectEqual(@as(?u64, b.id), try f.files.resolvePath(1, "/Notes/b.note"));

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
    try testing.expectEqual(v0, try f.files.syncVersion(1));
}

test "move is user-scoped: an unknown id and a foreign id are both NotFound, and nothing crosses accounts" {
    var f = try Fixture.init();
    defer f.deinit();

    const a = try putBytes(&f, 1, null, "mine.note", "aaaa");
    defer freeEntry(a);
    const bob = try putBytes(&f, 2, null, "bob.note", "bbbb");
    defer freeEntry(bob);

    try testing.expectError(error.NotFound, f.files.move(1, 999_999, null, "x.note", false));

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

    try testing.expectError(error.InvalidMove, f.files.move(1, parent.id, child.id, "Parent", false));
    try testing.expectError(error.InvalidMove, f.files.move(1, parent.id, parent.id, "Parent", false));

    try testing.expectEqual(@as(?u64, parent.id), try f.files.resolvePath(1, "/Parent"));
    try testing.expectEqual(@as(?u64, child.id), try f.files.resolvePath(1, "/Parent/Child"));
}

test "SEARCH-NEUTRALITY: a renamed + relocated note leaves the blob-keyed index untouched" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const note = try putSearchNote(&f, 1, null, "orig.note", &.{"quarterly roadmap review"});
    defer freeEntry(note);

    // A re-derive moves `indexed_at` even when the row count is unchanged.
    const IndexState = struct { rows: i64, indexed_at: i64 };
    const read = struct {
        fn get(db: sqlite.Db, md5: []const u8) !IndexState {
            var r = (try db.row(
                "SELECT (SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1), " ++
                    "indexed_at FROM note_index WHERE blob_md5 = ?1;",
                &.{.{ .text = md5 }},
            )) orelse return error.NoIndexRow;
            defer r.finalize();
            return .{ .rows = r.int(0), .indexed_at = r.int(1) };
        }
    }.get;
    const before = try read(f.db, note.md5.?);
    try testing.expect(before.rows > 0); // or the assertion below is vacuous

    const archive = try f.files.createFolder(1, null, "Archive");
    defer freeEntry(archive);
    {
        const moved = try f.files.move(1, note.id, archive.id, "renamed.note", false);
        defer freeEntry(moved);
        try testing.expectEqualStrings("renamed.note", moved.name);
    }
    try testing.expectEqual(@as(?u64, note.id), try f.files.resolvePath(1, "/Archive/renamed.note"));

    const after = try read(f.db, note.md5.?);
    try testing.expectEqual(before.rows, after.rows);
    try testing.expectEqual(before.indexed_at, after.indexed_at);
}

test "listing hides a .mark that has its PDF beside it, and counts the same way" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const pdf = try putBytes(&f, 1, docs.id, "manual.pdf", "aaaa");
    defer freeEntry(pdf);
    const mk = try putBytes(&f, 1, docs.id, "manual.pdf.mark", "bbbb"); // the layer
    defer freeEntry(mk);
    const nb2 = try putBytes(&f, 1, docs.id, "notes.note", "cccc"); // a neighbour
    defer freeEntry(nb2);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    for (rows) |r| try testing.expect(!std.mem.endsWith(u8, r.name, ".mark"));

    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, docs.id));

    const still = (try f.files.get(1, mk.id)) orelse return error.Missing;
    defer freeEntry(still);
    try testing.expectEqualStrings("manual.pdf.mark", still.name);
}

test "an ORPHANED .mark still lists — it is the only trace of that ink left" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const orphan = try putBytes(&f, 1, docs.id, "lease.pdf.mark", "aaaa");
    defer freeEntry(orphan);
    const away = try putBytes(&f, 1, null, "away.pdf", "bbbb");
    defer freeEntry(away);
    const away_mk = try putBytes(&f, 1, docs.id, "away.pdf.mark", "cccc");
    defer freeEntry(away_mk);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, docs.id));
}

test "trashing a pdf takes its mark with it — a delete must not CONJURE a file" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const pdf = try putBytes(&f, 1, docs.id, "manual.pdf", "aaaa");
    defer freeEntry(pdf);
    const mk = try putBytes(&f, 1, docs.id, "manual.pdf.mark", "bbbb");
    defer freeEntry(mk);
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));

    try f.files.trash(1, pdf.id);
    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 0), rows.len);
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));

    var r = (try f.db.row(
        "SELECT COUNT(*), COUNT(DISTINCT deleted_at) FROM files WHERE deleted = 1 AND id IN (?1, ?2);",
        &.{ .{ .int = @intCast(pdf.id) }, .{ .int = @intCast(mk.id) } },
    )).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 2), r.int(0));
    try testing.expectEqual(@as(i64, 1), r.int(1));
}

test "a folder named like a PDF never pairs, so the mark beside it keeps its row" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const sub = try f.files.createFolder(1, docs.id, "plan.pdf");
    testing.allocator.free(sub.name);
    const plan_mk = try putBytes(&f, 1, docs.id, "plan.pdf.mark", "dddd");
    defer freeEntry(plan_mk);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    var saw_mark = false;
    for (rows) |r| if (std.mem.eql(u8, r.name, "plan.pdf.mark")) {
        saw_mark = true;
    };
    try testing.expect(saw_mark);

    try f.files.trash(1, sub.id);
    const still = (try f.files.get(1, plan_mk.id)) orelse return error.Missing;
    freeEntry(still);
}

// ---- the .mark pairing through the file lifecycle ----

/// Distinct bytes so the quota arithmetic can tell them apart. Caller frees both.
const MarkPair = struct { pdf: Entry, mark: Entry };
fn putPair(f: *Fixture, parent: ?u64, stem: []const u8, pdf_bytes: []const u8, mark_bytes: []const u8) !MarkPair {
    var buf: [128]u8 = undefined;
    const pdf_name = try std.fmt.bufPrint(&buf, "{s}.pdf", .{stem});
    const pdf = try putBytes(f, 1, parent, pdf_name, pdf_bytes);
    errdefer freeEntry(pdf);
    var buf2: [128]u8 = undefined;
    const mark_name = try std.fmt.bufPrint(&buf2, "{s}.pdf.mark", .{stem});
    const mark = try putBytes(f, 1, parent, mark_name, mark_bytes);
    return .{ .pdf = pdf, .mark = mark };
}

/// Straight from the table, never through the folding API.
fn deletedFlagOf(f: *Fixture, id: u64) !i64 {
    var r = (try f.db.row("SELECT deleted FROM files WHERE id = ?1;", &.{.{ .int = @intCast(id) }})) orelse return -1;
    defer r.finalize();
    return r.int(0);
}

/// Straight from the table; "" when the row is gone.
fn nameOf(f: *Fixture, arena: std.mem.Allocator, id: u64) ![]const u8 {
    var r = (try f.db.row("SELECT name FROM files WHERE id = ?1;", &.{.{ .int = @intCast(id) }})) orelse return "";
    defer r.finalize();
    return arena.dupe(u8, r.text(0));
}

/// A borrow into `rows`.
fn rowNamed(rows: []Entry, name: []const u8) !Entry {
    for (rows) |e| {
        if (std.mem.eql(u8, e.name, name)) return e;
    }
    return error.TestUnexpectedResult;
}

test "a listing row carries the id of the .mark hidden behind it" {
    var f = try Fixture.init();
    defer f.deinit();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("manual.pdf", rows[0].name);
    try testing.expectEqual(@as(?u64, p.mark.id), rows[0].mark_id);
}

test "mark id on a listing row: absent for a lonely file, a folder, and a mark's own row" {
    var f = try Fixture.init();
    defer f.deinit();

    const lonely = try putBytes(&f, 1, null, "lease.pdf", "aaaa");
    defer freeEntry(lonely);

    const folder = try f.files.createFolder(1, null, "Notes");
    defer testing.allocator.free(folder.name);
    const orphan = try putBytes(&f, 1, null, "Notes.mark", "bbbb");
    defer freeEntry(orphan);

    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(?u64, null), (try rowNamed(rows, "lease.pdf")).mark_id);
    try testing.expectEqual(@as(?u64, null), (try rowNamed(rows, "Notes")).mark_id);

    try testing.expectEqual(@as(?u64, null), (try rowNamed(rows, "Notes.mark")).mark_id);
}

test "a mark id is a LIVE fact on both sides — the bin never carries one" {
    var f = try Fixture.init();
    defer f.deinit();

    // Reachable when the mark arrives after the document went to the bin.
    const doc = try putBytes(&f, 1, null, "old.pdf", "aaaa");
    defer freeEntry(doc);
    try f.files.trash(1, doc.id);
    const late_mark = try putBytes(&f, 1, null, "old.pdf.mark", "bbbb");
    defer freeEntry(late_mark);
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, doc.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, late_mark.id));

    const trashed = (try f.files.getTrashed(1, doc.id)).?;
    defer freeEntry(trashed);
    try testing.expectEqual(@as(?u64, null), trashed.mark_id);

    const blind = (try f.files.getAnyState(1, doc.id)).?;
    defer freeEntry(blind);
    try testing.expectEqual(@as(?u64, null), blind.mark_id);

    const live = try putBytes(&f, 1, null, "new.pdf", "cccc");
    defer freeEntry(live);
    const ink = try putBytes(&f, 1, null, "new.pdf.mark", "dddd");
    defer freeEntry(ink);
    {
        const before = try f.files.list(1, null);
        defer Files.freeEntries(testing.allocator, before);
        try testing.expectEqual(@as(?u64, ink.id), (try rowNamed(before, "new.pdf")).mark_id);
    }

    var s = try f.db.prepare("UPDATE files SET deleted = 1, deleted_at = 1 WHERE id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(ink.id));
    _ = try s.step();

    const after = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, after);
    try testing.expectEqual(@as(?u64, null), (try rowNamed(after, "new.pdf")).mark_id);
}

test "trashing the MARK takes its PDF too — the rule runs both ways" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.mark.id);
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, p.pdf.id));
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, p.mark.id));
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));
}

test "a pair is ONE user-visible change: one sync bump for two rows" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const before = try f.files.syncVersion(1);
    try f.files.trash(1, p.pdf.id);
    try testing.expectEqual(before + 1, try f.files.syncVersion(1));

    const after_trash = try f.files.syncVersion(1);
    (try f.files.restore(1, p.pdf.id)).deinit(testing.allocator);
    try testing.expectEqual(after_trash + 1, try f.files.syncVersion(1));

    const after_restore = try f.files.syncVersion(1);
    try f.files.trash(1, p.mark.id);
    try testing.expectEqual(after_restore + 1, try f.files.syncVersion(1));
}

test "restore brings the pair back together, from either member" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    var r = try f.files.restore(1, p.pdf.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("manual.pdf", r.name);
    try testing.expect(!r.renamed);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, p.mark.id));
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, p.mark.id));

    try f.files.trash(1, p.mark.id);
    var r2 = try f.files.restore(1, p.mark.id);
    defer r2.deinit(testing.allocator);
    try testing.expectEqualStrings("manual.pdf.mark", r2.name);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, p.pdf.id));
}

test "restore under a name COLLISION renames both, so the pair survives it" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    const fresh = try putBytes(&f, 1, docs.id, "manual.pdf", "cccc");
    defer freeEntry(fresh);

    var r = try f.files.restore(1, p.pdf.id);
    defer r.deinit(testing.allocator);
    try testing.expect(r.renamed);
    try testing.expectEqualStrings("manual (2).pdf", r.name);

    try testing.expectEqualStrings("manual (2).pdf.mark", try nameOf(&f, a, p.mark.id));

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("manual (2).pdf", rows[0].name);
    try testing.expectEqualStrings("manual.pdf", rows[1].name);
}

test "restore skips a suffix whose .mark twin is taken, rather than adopting it" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    const fresh = try putBytes(&f, 1, docs.id, "manual.pdf", "cccc");
    defer freeEntry(fresh);
    const squatter = try putBytes(&f, 1, docs.id, "manual (2).pdf.mark", "dddd");
    defer freeEntry(squatter);

    var r = try f.files.restore(1, p.pdf.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("manual (3).pdf", r.name);
    try testing.expectEqualStrings("manual (3).pdf.mark", try nameOf(&f, a, p.mark.id));
    try testing.expectEqualStrings("manual (2).pdf.mark", try nameOf(&f, a, squatter.id));
}

test "purge destroys the pair, refunding and decref'ing BOTH blobs" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);
    const pdf_md5 = dupeMd5(p.pdf.md5.?);
    const mark_md5 = dupeMd5(p.mark.md5.?);

    try f.files.trash(1, p.pdf.id);
    try testing.expectEqual(@as(i64, 10), try f.used(1));
    try f.expectQuotaBalanced(1);

    try f.files.purge(1, p.pdf.id);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, -1), try blobRefcount(&f, &pdf_md5));
    try testing.expectEqual(@as(i64, -1), try blobRefcount(&f, &mark_md5));
    try testing.expect(!f.files.blobs.has(&pdf_md5));
    try testing.expect(!f.files.blobs.has(&mark_md5));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE is_folder = 0;"));
}

test "purging from the MARK destroys the PDF too" {
    var f = try Fixture.init();
    defer f.deinit();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.mark.id);
    try f.files.purge(1, p.mark.id);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

test "an ORPHANED mark has no pair, so it travels entirely alone" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const orphan = try putBytes(&f, 1, docs.id, "lease.pdf.mark", "aaaa");
    defer freeEntry(orphan);
    const away = try putBytes(&f, 1, null, "away.pdf", "bbbb");
    defer freeEntry(away);
    const away_mk = try putBytes(&f, 1, docs.id, "away.pdf.mark", "cccc");
    defer freeEntry(away_mk);
    const bystander = try putBytes(&f, 1, docs.id, "notes.note", "dddd");
    defer freeEntry(bystander);

    try f.files.trash(1, orphan.id);
    try f.files.trash(1, away_mk.id);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, away.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, bystander.id));

    (try f.files.restore(1, orphan.id)).deinit(testing.allocator);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, orphan.id));
    try f.files.purge(1, away_mk.id);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, away.id));
    const survivor = (try f.files.get(1, away.id)) orelse return error.Missing;
    freeEntry(survivor);
    try f.expectQuotaBalanced(1);

    const moved = try f.files.move(1, orphan.id, null, "elsewhere.mark", false);
    defer freeEntry(moved);
    try testing.expectEqual(@as(i64, 3), try countOf(&f, "SELECT COUNT(*) FROM files WHERE is_folder = 0;"));
}

test "a PDF with NO mark behaves exactly as it did before any of this" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const lone = try putBytes(&f, 1, docs.id, "solo.pdf", "aaaa");
    defer freeEntry(lone);

    try f.files.trash(1, lone.id);
    try testing.expectEqual(@as(i64, 4), try f.used(1)); // trash refunds nothing
    var r = try f.files.restore(1, lone.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("solo.pdf", r.name);
    try testing.expect(!r.renamed);

    const renamed = try f.files.move(1, lone.id, null, "solo.txt", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("solo.txt", renamed.name);

    try f.files.trash(1, lone.id);
    try f.files.purge(1, lone.id);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

test "renaming a pdf renames its mark, and moving it moves its mark" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const other = try f.files.createFolder(1, null, "Other");
    defer testing.allocator.free(other.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const renamed = try f.files.move(1, p.pdf.id, docs.id, "handbook.pdf", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("handbook.pdf.mark", try nameOf(&f, a, p.mark.id));

    const moved = try f.files.move(1, p.pdf.id, other.id, "handbook.pdf", false);
    defer freeEntry(moved);
    var pr = (try f.db.row("SELECT parent_id FROM files WHERE id = ?1;", &.{.{ .int = @intCast(p.mark.id) }})).?;
    defer pr.finalize();
    try testing.expectEqual(@as(i64, @intCast(other.id)), pr.int(0));

    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, other.id));
}

test "renaming the MARK renames its pdf, and a name that cannot pair is refused" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const renamed = try f.files.move(1, p.mark.id, null, "handbook.pdf.mark", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("handbook.pdf.mark", renamed.name);
    try testing.expectEqualStrings("handbook.pdf", try nameOf(&f, a, p.pdf.id));

    const retyped = try f.files.move(1, p.pdf.id, null, "handbook.txt", false);
    defer freeEntry(retyped);
    try testing.expectEqualStrings("handbook.txt", retyped.name);
    try testing.expectEqualStrings("handbook.txt.mark", try nameOf(&f, a, p.mark.id));

    try testing.expectError(error.InvalidMove, f.files.move(1, p.mark.id, null, "notes.txt", false));
    try testing.expectError(error.InvalidMove, f.files.move(1, p.pdf.id, null, "notes.mark", false));
    try testing.expectEqualStrings("handbook.txt", try nameOf(&f, a, p.pdf.id));
    try testing.expectEqualStrings("handbook.txt.mark", try nameOf(&f, a, p.mark.id));

    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("handbook.txt", rows[0].name);
}

test "a paired move takes a suffix that is free for BOTH, or refuses to clobber" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const other = try f.files.createFolder(1, null, "Other");
    defer testing.allocator.free(other.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const squatter = try putBytes(&f, 1, other.id, "manual.pdf.mark", "cccc");
    defer freeEntry(squatter);

    try testing.expectError(error.NameConflict, f.files.move(1, p.pdf.id, other.id, "manual.pdf", false));
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, squatter.id));

    const moved = try f.files.move(1, p.pdf.id, other.id, "manual.pdf", true);
    defer freeEntry(moved);
    try testing.expectEqualStrings("manual (2).pdf", moved.name);
    try testing.expectEqualStrings("manual (2).pdf.mark", try nameOf(&f, a, p.mark.id));
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, squatter.id));

    const noop = try f.files.move(1, p.pdf.id, other.id, "manual (2).pdf", false);
    defer freeEntry(noop);
    try testing.expectEqualStrings("manual (2).pdf.mark", try nameOf(&f, a, p.mark.id));
}

test "the BIN shows one row for a trashed pair, sized as the pair" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    const rows = try f.files.listBin(a, 1);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("manual.pdf", rows[0].name);
    try testing.expectEqual(@as(u64, 10), rows[0].size);
    try testing.expectEqualStrings("/Docs/manual.pdf", rows[0].path);

    const orphan = try putBytes(&f, 1, docs.id, "lease.pdf.mark", "cc");
    defer freeEntry(orphan);
    try f.files.trash(1, orphan.id);
    const rows2 = try f.files.listBin(a, 1);
    try testing.expectEqual(@as(usize, 2), rows2.len);
    try testing.expect((try binRow(a, &f, 1, orphan.id)) != null);
    try testing.expectEqual(@as(u64, 2), (try binRow(a, &f, 1, orphan.id)).?.size);
}

test "emptyBin reports what the bin SHOWED and strands no half of a pair" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);
    const solo = try putBytes(&f, 1, null, "notes.note", "cc");
    defer freeEntry(solo);

    try f.files.trash(1, p.pdf.id);
    try f.files.trash(1, solo.id);
    try testing.expectEqual(@as(usize, 2), (try f.files.listBin(arena.allocator(), 1)).len);

    try testing.expectEqual(@as(usize, 2), try f.files.emptyBin(1));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

test "the retention sweep expires a pair as one, never half of it" {
    var f = try Fixture.init();
    defer f.deinit();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    // Backdate only the PDF, as a pre-fix bin left it.
    try f.db.exec("UPDATE files SET deleted_at = 0 WHERE name = 'manual.pdf';");

    _ = try f.files.sweepBin(1);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

test "a trash fanout counts what the folder SHOWED, mark included in the deed" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);
    const note = try putBytes(&f, 1, docs.id, "notes.note", "cccc");
    defer freeEntry(note);

    try testing.expectEqual(@as(usize, 3), try f.files.liveSubtreeCount(1, docs.id));
    try f.files.trash(1, docs.id);
    try testing.expectEqual(@as(i64, 4), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));
}

test "a folder move carries a pair inside it without touching their names" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const dest = try f.files.createFolder(1, null, "Dest");
    defer testing.allocator.free(dest.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const moved = try f.files.move(1, docs.id, dest.id, "Docs", false);
    defer freeEntry(moved);
    try testing.expectEqualStrings("manual.pdf", try nameOf(&f, a, p.pdf.id));
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, p.mark.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));
}

test "a LIVE mark beside a TRASHED pdf is not a pair — the shape a pre-fix bin left" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    // The state pre-fix databases hold: PDF trashed alone, mark live.
    try f.db.exec("UPDATE files SET deleted = 1, deleted_at = 1, deleted_path = '/Docs/manual.pdf' WHERE name = 'manual.pdf';");

    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));
    try f.files.purge(1, p.pdf.id);
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, p.mark.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, p.mark.id));
    try testing.expectEqual(@as(i64, 6), try f.used(1)); // only the PDF's 4 refunded
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);

    try f.files.trash(1, p.mark.id);
    try testing.expectEqual(@as(usize, 1), (try f.files.listBin(a, 1)).len);
    try f.files.purge(1, p.mark.id);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

test "restoring a trashed pdf leaves a LIVE mark of the same name alone" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);
    try f.db.exec("UPDATE files SET deleted = 1, deleted_at = 1, deleted_path = '/manual.pdf' WHERE name = 'manual.pdf';");

    var r = try f.files.restore(1, p.pdf.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("manual.pdf", r.name);
    try testing.expect(!r.renamed);
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, p.mark.id));
    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("manual.pdf", rows[0].name);
}

// ---- the pairing rule is format-agnostic ----

test "a mark of a format we do not render is folded away exactly like a PDF's" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const book = try putBytes(&f, 1, docs.id, "novel.epub", "aaaa");
    defer freeEntry(book);
    const ink = try putBytes(&f, 1, docs.id, "novel.epub.mark", "bbbbbb");
    defer freeEntry(ink);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("novel.epub", rows[0].name);
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));

    try f.files.trash(1, book.id);
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, ink.id));
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));

    const bin = try f.files.listBin(a, 1);
    try testing.expectEqual(@as(usize, 1), bin.len);
    try testing.expectEqualStrings("novel.epub", bin[0].name);
    try testing.expectEqual(@as(u64, 10), bin[0].size);

    (try f.files.restore(1, ink.id)).deinit(testing.allocator);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, book.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));

    const other = try f.files.createFolder(1, null, "Other");
    defer testing.allocator.free(other.name);
    const moved = try f.files.move(1, book.id, other.id, "saga.epub", false);
    defer freeEntry(moved);
    try testing.expectEqualStrings("saga.epub.mark", try nameOf(&f, a, ink.id));
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, other.id));
}

test "an orphan mark of a format we do not render still lists, and travels alone" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const orphan = try putBytes(&f, 1, docs.id, "novel.epub.mark", "aaaa");
    defer freeEntry(orphan);
    const elsewhere = try putBytes(&f, 1, null, "novel.epub", "bbbb");
    defer freeEntry(elsewhere);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("novel.epub.mark", rows[0].name);

    try f.files.trash(1, orphan.id);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, elsewhere.id));
}

test "a mark of a mark is nobody's pair — the rule refuses to CHAIN" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const doc = try putBytes(&f, 1, docs.id, "a.note", "aaaa");
    defer freeEntry(doc);
    const mk = try putBytes(&f, 1, docs.id, "a.note.mark", "bbbb");
    defer freeEntry(mk);
    const chain = try putBytes(&f, 1, docs.id, "a.note.mark.mark", "cccc");
    defer freeEntry(chain);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("a.note", rows[0].name);
    try testing.expectEqualStrings("a.note.mark.mark", rows[1].name);

    try f.files.trash(1, doc.id);
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, mk.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, chain.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));

    try testing.expect(markpair.markStemOf(".mark") == null);
    try testing.expect(markpair.markStemOf("a.note.mark.mark") == null);
    try testing.expectEqualStrings("a.note", markpair.markStemOf("a.note.mark").?);
}

test "PLAN PIN: the pairing rule is an indexed sibling seek in the library AND the bin" {
    var f = try Fixture.init();
    defer f.deinit();

    // Pinned by index name (`files_live_name`, `files_bin_name`): without the
    // bin index a 40-row bin listing went from ~4k to ~222k VM steps. Needles
    // include the trailing " (" so a renamed index cannot match.
    const pins = .{
        .{ "SELECT f.id FROM files f WHERE f.user_id = ?1 AND f.deleted = 0" ++ Files.hide_paired_mark ++ ";", "files_live_name (" },
        .{ "SELECT f.id FROM files f WHERE f.user_id = ?1 AND f.deleted = 1" ++ Files.hide_paired_bin_mark ++ ";", "files_bin_name (" },
    };
    inline for (pins) |pin| {
        var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ pin[0]);
        defer s.finalize();
        var indexed = false;
        while (try s.step()) {
            const detail = s.columnText(3);
            if (std.mem.indexOf(u8, detail, "SEARCH p ") != null and
                std.mem.indexOf(u8, detail, pin[1]) != null) indexed = true;
        }
        try testing.expect(indexed);
    }

    var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ Files.bin_listing_sql);
    defer s.finalize();
    var sized = false;
    var hidden = false;
    while (try s.step()) {
        const detail = s.columnText(3);
        if (std.mem.indexOf(u8, detail, "files_bin_name (") == null) continue;
        if (std.mem.indexOf(u8, detail, "SEARCH m ") != null) sized = true;
        if (std.mem.indexOf(u8, detail, "SEARCH p ") != null) hidden = true;
    }
    try testing.expect(sized);
    try testing.expect(hidden);

    var ids = try f.db.prepare("EXPLAIN QUERY PLAN SELECT f.id, " ++ Files.paired_mark_id ++
        " FROM files f WHERE f.user_id = ?1 AND f.deleted = 0;");
    defer ids.finalize();
    var seeks = false;
    while (try ids.step()) {
        const detail = ids.columnText(3);
        if (std.mem.indexOf(u8, detail, "SEARCH m ") != null and
            std.mem.indexOf(u8, detail, "files_live_name (") != null) seeks = true;
    }
    try testing.expect(seeks);
}

// ---- a move must not adopt ink it did not arrive with ----

test "a rename must not let an unpaired file adopt an orphan mark" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const stray = try putBytes(&f, 1, docs.id, "handbook.pdf.mark", "aaaa");
    defer freeEntry(stray);
    const plain = try putBytes(&f, 1, docs.id, "notes.txt", "bbbb");
    defer freeEntry(plain);

    try testing.expectError(error.NameConflict, f.files.move(1, plain.id, docs.id, "handbook.pdf", false));
    try testing.expectEqualStrings("notes.txt", try nameOf(&f, a, plain.id));

    const renamed = try f.files.move(1, plain.id, docs.id, "handbook.pdf", true);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("handbook (2).pdf", renamed.name);

    try testing.expectEqualStrings("handbook.pdf.mark", try nameOf(&f, a, stray.id));
    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("handbook (2).pdf", rows[0].name);
    try testing.expectEqualStrings("handbook.pdf.mark", rows[1].name);

    const noop = try f.files.move(1, plain.id, docs.id, "handbook (2).pdf", false);
    defer freeEntry(noop);
    try testing.expectEqualStrings("handbook (2).pdf", noop.name);
}

test "a MOVE into another folder adopts nothing either — the pairing is name plus folder" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const other = try f.files.createFolder(1, null, "Other");
    defer testing.allocator.free(other.name);

    const plain = try putBytes(&f, 1, docs.id, "lease.pdf", "aaaa");
    defer freeEntry(plain);
    const stray = try putBytes(&f, 1, other.id, "lease.pdf.mark", "bbbb");
    defer freeEntry(stray);

    try testing.expectError(error.NameConflict, f.files.move(1, plain.id, other.id, "lease.pdf", false));
    const moved = try f.files.move(1, plain.id, other.id, "lease.pdf", true);
    defer freeEntry(moved);
    try testing.expectEqualStrings("lease (2).pdf", moved.name);
    try testing.expectEqualStrings("lease.pdf.mark", try nameOf(&f, a, stray.id));
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, other.id));
}

test "an orphan MARK cannot be renamed into somebody's ink — the direction that is not symmetric" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const doc = try putBytes(&f, 1, docs.id, "report.pdf", "aaaa");
    defer freeEntry(doc);
    const stray = try putBytes(&f, 1, docs.id, "stray.epub.mark", "bbbb");
    defer freeEntry(stray);

    // An orphan never reaches the chain refusal; `nameFree` answers from the
    // mark's side.
    try testing.expectError(error.NameConflict, f.files.move(1, stray.id, docs.id, "report.pdf.mark", false));
    try testing.expectEqualStrings("stray.epub.mark", try nameOf(&f, a, stray.id));

    const renamed = try f.files.move(1, stray.id, docs.id, "report.pdf.mark", true);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("report.pdf (2).mark", renamed.name);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, docs.id));
}

test "a FOLDER is exempt from the adoption guard, because a folder never pairs" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const mk = try putBytes(&f, 1, docs.id, "plan.pdf.mark", "aaaa");
    defer freeEntry(mk);
    const dir = try f.files.createFolder(1, docs.id, "Archive");
    testing.allocator.free(dir.name);

    const renamed = try f.files.move(1, dir.id, docs.id, "plan.pdf", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("plan.pdf", renamed.name);

    try testing.expectEqualStrings("plan.pdf.mark", try nameOf(&f, a, mk.id));
    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
}

test "a PAIRED move is unchanged by the adoption guard — it still carries its own ink" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const renamed = try f.files.move(1, p.pdf.id, null, "guide.epub", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("guide.epub", renamed.name);
    try testing.expectEqualStrings("guide.epub.mark", try nameOf(&f, a, p.mark.id));

    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
}

test "a FOLDER named like a mark is not ink — it lists, and nothing carries it" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const doc = try putBytes(&f, 1, docs.id, "plan.pdf", "aaaa");
    defer freeEntry(doc);
    const dir = try f.files.createFolder(1, docs.id, "plan.pdf.mark");
    testing.allocator.free(dir.name);
    const buried = try putBytes(&f, 1, dir.id, "buried.note", "bbbb");
    defer freeEntry(buried);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("plan.pdf.mark", rows[0].name); // folders first
    try testing.expectEqualStrings("plan.pdf", rows[1].name);
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, docs.id));

    try f.files.trash(1, doc.id);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, dir.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, buried.id));
    const rows2 = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows2);
    try testing.expectEqual(@as(usize, 1), rows2.len);
    try testing.expectEqualStrings("plan.pdf.mark", rows2[0].name);
}
