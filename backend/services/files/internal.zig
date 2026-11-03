//! Helpers the `files/` siblings share and nothing else calls: refcounts,
//! quota deltas, pairing and existence checks. Outside callers go through
//! `Files`, whose methods hold the transactions these assume.

const std = @import("std");
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const sqlite = @import("../../db/sqlite.zig");
const noteindex = @import("../note_index.zig");
const spdindex = @import("../spd_index.zig");
const md5_len = filesmod.md5_len;
const markpair = @import("../mark_pairing.zig");
const Paired = Files.Paired;
const Child = Files.Child;

pub fn now(self: Files) i64 {
    return std.Io.Clock.real.now(self.io).toSeconds();
}

/// Shared by the listing and `get`, so both read one expression.
pub const paired_mark_id = markpair.pairedMarkId("f");

pub const hide_paired_mark = markpair.hidePairedMark("f", "0");

/// The bin's view: a trashed pair is one row there too.
pub const hide_paired_bin_mark = markpair.hidePairedMark("f", "1");

/// The other half of a pair, or null. The only entry point for the two-way
/// rule: `trash`, `restore`, `purge` and `move` call it once and then work a
/// flat id set (applying it per row would bounce back). Same state only, the
/// set `hidePairedMark` folds. Folders never pair.
pub fn pairOf(self: Files, user_id: u64, id: u64) !?Paired {
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

/// Callers holding a transaction bump inside it, so it commits atomically.
pub fn bumpSync(self: Files, user_id: u64) !void {
    var s = try self.db.prepare(
        "INSERT INTO sync_state(user_id, version) VALUES(?1, 1) " ++
            "ON CONFLICT(user_id) DO UPDATE SET version = version + 1;",
    );
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    _ = try s.step();
}

/// Refunds `size` if `md5` is now unreferenced by the user, once per
/// transaction (superseded and evicted blobs can coincide). Reads current
/// state, so call after the writes.
pub fn settleRefund(
    self: Files,
    user_id: u64,
    md5: []const u8,
    size: i64,
    settled: *std.ArrayList([md5_len]u8),
    delta: *i64,
) !void {
    for (settled.items) |*s| if (std.mem.eql(u8, s, md5)) return;
    if (try userChargedRefs(self, user_id, md5) != 0) return;
    var buf: [md5_len]u8 = undefined;
    @memcpy(&buf, md5[0..md5_len]);
    try settled.append(self.gpa, buf);
    delta.* -= size;
}

/// `parent_id` in any state; `restore` chases trashed ancestors with it.
pub fn parentOf(self: Files, user_id: u64, id: u64) !?u64 {
    var r = (try self.db.row("SELECT parent_id FROM files WHERE id = ?1 AND user_id = ?2;", &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } })) orelse return null;
    defer r.finalize();
    const pid = r.int(0);
    return if (pid == 0) null else @intCast(pid);
}

pub fn addUsed(self: Files, user_id: u64, delta: i64) !void {
    try ensureCapacity(self, user_id); // or the UPDATE no-ops
    var s = try self.db.prepare("UPDATE capacity SET used_bytes = used_bytes + ?1 WHERE user_id = ?2;");
    defer s.finalize();
    s.bindInt(1, delta);
    s.bindInt(2, @intCast(user_id));
    _ = try s.step();
}

/// Removes a blob and every derived file after the releasing transaction
/// commits. Every post-commit GC site calls this, never `blobs.remove`.
pub fn removeBlobFiles(self: Files, md5: []const u8) void {
    self.blobs.remove(md5);
    self.thumbs.remove(md5);
    // Every version: this side does not know which exist.
    if (self.terms) |t| t.removeAll(md5);
    if (self.text) |t| t.removeAll(md5);
}

/// Decrements `blobs.refcount` (live-file references) and runs the GC gate.
/// True means: remove the bytes after commit.
pub fn decref(self: Files, md5: []const u8) !bool {
    {
        var s = try self.db.prepare("UPDATE blobs SET refcount = refcount - 1 WHERE md5 = ?1;");
        defer s.finalize();
        s.bindText(1, md5);
        _ = try s.step();
    }
    return reapIfUnreferenced(self, md5);
}

/// The single GC gate: reaps a blob (FTS, note/`.spd` index, `blobs` row) only
/// when no live file and no `file_history` row holds it. Separate from
/// `decref` because history eviction reaps without decrementing again.
pub fn reapIfUnreferenced(self: Files, md5: []const u8) !bool {
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

pub fn liveChild(self: Files, user_id: u64, parent_id: ?u64, name: []const u8) !?Child {
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
pub fn exists(self: Files, user_id: u64, id: u64) !bool {
    var s = try self.db.prepare("SELECT 1 FROM files WHERE id = ?1 AND user_id = ?2;");
    defer s.finalize();
    s.bindInt(1, @intCast(id));
    s.bindInt(2, @intCast(user_id));
    return try s.step();
}

/// In the bin only; `purge` relies on it.
pub fn existsTrashed(self: Files, user_id: u64, id: u64) !bool {
    var s = try self.db.prepare("SELECT 1 FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 1;");
    defer s.finalize();
    s.bindInt(1, @intCast(id));
    s.bindInt(2, @intCast(user_id));
    return try s.step();
}

pub fn bindOpt(s: sqlite.Stmt, idx: c_int, v: ?u64) void {
    if (v) |x| s.bindInt(idx, @intCast(x)) else s.bindNull(idx);
}

/// Ensures a `capacity` row exists; otherwise `addUsed` matches zero rows for
/// users created without one and quota is silently off.
pub fn ensureCapacity(self: Files, user_id: u64) !void {
    var s = try self.db.prepare("INSERT OR IGNORE INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, ?2);");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindInt(2, Files.default_total_bytes);
    _ = try s.step();
}

/// The user's charged references to `md5`: `files` rows (live or trashed) plus
/// their `file_history` rows. The quota predicate.
pub fn userChargedRefs(self: Files, user_id: u64, md5: []const u8) !u64 {
    var r = (try self.db.row(
        "SELECT (SELECT COUNT(*) FROM files WHERE user_id = ?1 AND is_folder = 0 AND md5 = ?2) + " ++
            "(SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id " ++
            "  WHERE f.user_id = ?1 AND fh.md5 = ?2);",
        &.{ .{ .int = @intCast(user_id) }, .{ .text = md5 } },
    )) orelse return 0;
    defer r.finalize();
    return @intCast(r.int(0));
}

/// `parent_id` is null (root) or a live folder owned by the user.
pub fn assertFolder(self: Files, user_id: u64, parent_id: ?u64) !void {
    const pid = parent_id orelse return;
    var r = (try self.db.row("SELECT is_folder FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0;", &.{ .{ .int = @intCast(pid) }, .{ .int = @intCast(user_id) } })) orelse return error.NotFound;
    defer r.finalize();
    if (r.int(0) == 0) return error.NotAFolder;
}

pub fn ensureBlobRow(self: Files, md5: []const u8, size: u64) !void {
    var s = try self.db.prepare("INSERT INTO blobs(md5, size, refcount, created_at) VALUES(?1,?2,0,?3) ON CONFLICT(md5) DO NOTHING;");
    defer s.finalize();
    s.bindText(1, md5);
    s.bindInt(2, @intCast(size));
    s.bindInt(3, now(self));
    _ = try s.step();
}

pub fn incref(self: Files, md5: []const u8) !void {
    var s = try self.db.prepare("UPDATE blobs SET refcount = refcount + 1 WHERE md5 = ?1;");
    defer s.finalize();
    s.bindText(1, md5);
    _ = try s.step();
}
