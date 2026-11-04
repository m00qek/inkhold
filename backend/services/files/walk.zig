//! Tree walks and path resolution over the files table.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const internal = @import("internal.zig");
const quota = @import("quota.zig");
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const TreeNode = filesmod.TreeNode;

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
    defer e.deinit(self.gpa);
    return .{
        .id = e.id,
        .name = try alloc.dupe(u8, e.name),
        .is_folder = e.is_folder,
        .md5 = try alloc.dupe(u8, e.md5 orelse ""),
        .size = e.size,
        .updated_at = e.updated_at,
        .path_display = try pathOf(self, alloc, user_id, id),
        .parent_path = if (e.parent_id) |pid| try pathOf(self, alloc, user_id, pid) else try alloc.dupe(u8, "/"),
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
