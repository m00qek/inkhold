//! Version history: retention, eviction, reads and restore.

const std = @import("std");
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const internal = @import("internal.zig");
const Entry = filesmod.Entry;
const HistoryVersion = filesmod.HistoryVersion;
const HistoryScope = filesmod.HistoryScope;
const md5_len = filesmod.md5_len;
const config = @import("../../config.zig");

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
    const ceiling = historyCeiling(
        self,
    );
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
    const ceiling = historyCeiling(
        self,
    );
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
    for (doomed.items) |file_id| try evictHistory(self, user_id, file_id, keep, &gc, &evicted);

    var settled: std.ArrayList([md5_len]u8) = .empty;
    defer settled.deinit(self.gpa);
    var delta: i64 = 0;
    for (evicted.items) |*e| try internal.settleRefund(self, user_id, &e.md5, e.size, &settled, &delta);
    if (delta != 0) try internal.addUsed(self, user_id, delta);

    try self.db.exec("COMMIT;");
    for (gc.items) |*m| internal.removeBlobFiles(self, m);

    return .{
        .policy = .{ .keep = keep, .max_keep = ceiling },
        .removed_versions = @intCast(evicted.items.len),
        .freed_bytes = -delta,
    };
}

/// Appends a superseded version, in the same transaction as the repoint and
/// decref. The row is itself the blob's keep-alive.
pub fn recordHistory(self: Files, file_id: u64, md5: []const u8, size: u64, ts: i64) !void {
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
pub fn historyBytes(self: Files) !u64 {
    var r = (try self.db.row(
        "SELECT COALESCE(SUM(size), 0) FROM blobs " ++
            "WHERE refcount = 0 AND md5 IN (SELECT md5 FROM file_history);",
        &.{},
    )) orelse return 0;
    defer r.finalize();
    return @intCast(r.int(0));
}

/// The size travels with it: the `blobs` row may already be gone at settlement.
pub const Evicted = struct { md5: [md5_len]u8, size: i64 };

/// Enforces both history bounds after a retain: (a) per-file K (the owner's),
/// (b) the global `max_bytes`, by evicting this user's oldest history-only
/// versions and never another user's. Collects GC md5s and evicted versions.
/// Inside the supersede transaction; only when K > 0.
pub fn evictHistory(
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
        try reapDistinct(self, doomed.items, gc);
    }

    // (b) the `max_bytes` backstop, one row per pass.
    while (try historyBytes(
        self,
    ) > self.history.max_bytes) {
        const dropped = (try evictOldestVersion(self, user_id, gc)) orelse break;
        try evicted.append(self.gpa, dropped);
    }
}

/// Drops the user's oldest retained version whose blob no file of theirs holds
/// (so each eviction frees something), or null.
pub fn evictOldestVersion(self: Files, user_id: u64, gc: *std.ArrayList([md5_len]u8)) !?Evicted {
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
    if (try internal.reapIfUnreferenced(self, &out.md5)) try gc.append(self.gpa, out.md5);
    return out;
}

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
    dropFileHistoryVersion(self, file_id, &v.md5) catch {};
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
pub fn reapDistinct(self: Files, md5s: []const [md5_len]u8, gc: *std.ArrayList([md5_len]u8)) !void {
    var seen: std.ArrayList([md5_len]u8) = .empty;
    defer seen.deinit(self.gpa);
    outer: for (md5s) |*m| {
        for (seen.items) |*s| if (std.mem.eql(u8, s, m)) continue :outer;
        try seen.append(self.gpa, m.*);
        if (try internal.reapIfUnreferenced(self, m)) try gc.append(self.gpa, m.*);
    }
}
