//! Row-level helpers for the bin: pair closure, releasing ids, restoring a row under a free name.

const std = @import("std");
const filesmod = @import("../files.zig");
const internal = @import("internal.zig");
const markpair = @import("../mark_pairing.zig");
const history = @import("history.zig");
const Files = filesmod.Files;
const md5_len = filesmod.md5_len;
const bin = @import("bin.zig");
const restore = bin.restore;

/// Closes `ids` under the pairing rule, adding each member's partner once.
/// The set is already cascade-closed, so only file siblings are added.
pub fn addPairs(self: Files, user_id: u64, ids: *std.ArrayList(u64)) !void {
    const n = ids.items.len; // snapshot: added rows are pairs already
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const p = (try internal.pairOf(self, user_id, ids.items[i])) orelse continue;
        if (std.mem.indexOfScalar(u64, ids.items, p.id) != null) continue;
        try ids.append(self.gpa, p.id);
    }
}

pub fn releaseIds(self: Files, user_id: u64, ids: []const u64, gc: *std.ArrayList([md5_len]u8)) !void {
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
    var hist_doomed: std.ArrayList(history.Evicted) = .empty;
    defer hist_doomed.deinit(self.gpa);
    for (ids) |fid| {
        var s = try self.db.prepare("SELECT md5, size FROM file_history WHERE file_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(fid));
        while (try s.step()) {
            const m = s.columnText(0);
            if (m.len != md5_len) continue;
            var e: history.Evicted = .{ .md5 = undefined, .size = s.columnInt(1) };
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
    for (doomed.items) |*d| try internal.settleRefund(self, user_id, &d.md5, d.size, &settled, &delta);
    for (hist_doomed.items) |*h| try internal.settleRefund(self, user_id, &h.md5, h.size, &settled, &delta);
    if (delta != 0) try internal.addUsed(self, user_id, delta);

    for (doomed.items) |*d| {
        if (try internal.decref(self, &d.md5)) try gc.append(self.gpa, d.md5);
    }

    // Reap blobs whose last keeper was a cascaded history row, after the decrefs.
    {
        var hist_md5s: std.ArrayList([md5_len]u8) = .empty;
        defer hist_md5s.deinit(self.gpa);
        for (hist_doomed.items) |*h| try hist_md5s.append(self.gpa, h.md5);
        try history.reapDistinct(self, hist_md5s.items, gc);
    }
}

/// `was_trashed` is false for an already-live row, so counts include only
/// rows actually changed.
pub const RestoredRow = struct { name: []u8, was_trashed: bool, renamed: bool };

/// Name choice for `restoreRow`; both fields serve `.mark` pairing only.
pub const RestoreName = struct {
    /// Restore under this name: a mark follows its document's possibly new name.
    name: ?[]const u8 = null,
    /// Accept a candidate only if `candidate ++ pair` is also free, so the pair
    /// shares one ` (n)` and never adopts an orphan mark.
    pair: ?[]const u8 = null,
};

/// Makes one row live, renaming on collision; leaves a live row alone. The
/// returned `name` is owned by `gpa`.
pub fn restoreRow(self: Files, user_id: u64, id: u64, opts: RestoreName) !RestoredRow {
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

    const final = try freeName(self, user_id, parent_id, opts.name orelse name, opts.pair);
    errdefer self.gpa.free(final);

    // `deleted_path` is NULL for live rows.
    var s = try self.db.prepare(
        "UPDATE files SET deleted = 0, deleted_at = NULL, deleted_path = NULL, name = ?1, updated_at = ?2 WHERE id = ?3;",
    );
    defer s.finalize();
    s.bindText(1, final);
    s.bindInt(2, internal.now(self));
    s.bindInt(3, @intCast(id));
    _ = try s.step();
    return .{ .name = final, .was_trashed = true, .renamed = !std.mem.eql(u8, final, name) };
}

/// A name free in `parent_id`: `wanted`, or ` (n)` inserted before the
/// extension with the lowest free n ≥ 2. Deterministic, so a replayed restore
/// lands on the same name. An existing suffix is replaced, not stacked. With
/// `pair`, `cand ++ pair` must be free too. Always a fresh allocation.
pub fn freeName(self: Files, user_id: u64, parent_id: ?u64, wanted: []const u8, pair: ?[]const u8) ![]u8 {
    if (try nameFree(self, user_id, parent_id, wanted, pair)) return self.gpa.dupe(u8, wanted);

    const dot = std.mem.lastIndexOfScalar(u8, wanted, '.');
    const full_stem = if (dot) |d| (if (d == 0) wanted else wanted[0..d]) else wanted;
    const ext = wanted[full_stem.len..];
    const stem = stripSuffix(full_stem);

    var n: u32 = 2;
    while (n < 10_000) : (n += 1) {
        const cand = try std.fmt.allocPrint(self.gpa, "{s} ({d}){s}", .{ stem, n, ext });
        errdefer self.gpa.free(cand);
        if (try nameFree(self, user_id, parent_id, cand, pair)) return cand;
        self.gpa.free(cand);
    }
    return error.NameConflict;
}

/// Whether `cand` is free and, with `pair`, not half of somebody else's pair:
/// for a document name `cand ++ pair` must be free; for a mark name its stem
/// must be.
pub fn nameFree(self: Files, user_id: u64, parent_id: ?u64, cand: []const u8, pair: ?[]const u8) !bool {
    if (try internal.liveChild(self, user_id, parent_id, cand) != null) return false;
    const suffix = pair orelse return true;
    if (markpair.markStemOf(cand)) |stem| return (try internal.liveChild(self, user_id, parent_id, stem)) == null;
    const twin = try std.fmt.allocPrint(self.gpa, "{s}{s}", .{ cand, suffix });
    defer self.gpa.free(twin);
    return (try internal.liveChild(self, user_id, parent_id, twin)) == null;
}

/// Strips one trailing ` (n)` (all digits), so `Budget (draft)` survives.
pub fn stripSuffix(stem: []const u8) []const u8 {
    if (stem.len == 0 or stem[stem.len - 1] != ')') return stem;
    const open = std.mem.lastIndexOfScalar(u8, stem, '(') orelse return stem;
    if (open < 2 or stem[open - 1] != ' ') return stem; // needs " (" and a non-empty base
    const digits = stem[open + 1 .. stem.len - 1];
    if (digits.len == 0) return stem;
    for (digits) |ch| if (!std.ascii.isDigit(ch)) return stem;
    return stem[0 .. open - 1];
}
