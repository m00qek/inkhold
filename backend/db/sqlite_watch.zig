//! Statement-level watches over a connection: cursor deletes and write counts.

const std = @import("std");
const c = @import("c");

// SQLITE_TRANSIENT, (void*)-1: SQLite copies bound text/blobs. @cImport can't
// translate the macro, and a comptime `@ptrFromInt` of this unaligned address
// to a fn-pointer type is a compile error on 32-bit ARM. SQLite only compares
// it, so build it at runtime behind `noinline` with safety off.
noinline fn transientAddr() usize {
    return @bitCast(@as(isize, -1));
}
const sqlite = @import("sqlite.zig");
const Db = sqlite.Db;
const Row = sqlite.Row;

/// Counts row mutations made while a SELECT over the same table is mid-cursor,
/// to test the collect-then-delete discipline. SQLite tolerates the overlap, so
/// outcome assertions cannot see it. The mutator is busy in its own hook, so only
/// statements starting with SELECT count.
pub const CursorWatch = struct {
    db: Db,
    /// Watch only this table when set.
    table: ?[]const u8 = null,
    overlaps: usize = 0,
    /// Row mutations seen at all, to tell "no overlap" from "never ran".
    mutations: usize = 0,

    pub fn arm(self: *CursorWatch) void {
        _ = c.sqlite3_update_hook(self.db.handle, onRow, self);
    }

    pub fn disarm(self: *CursorWatch) void {
        _ = c.sqlite3_update_hook(self.db.handle, null, null);
    }

    fn onRow(user: ?*anyopaque, _: c_int, _: [*c]const u8, table: [*c]const u8, _: c.sqlite3_int64) callconv(.c) void {
        const self: *CursorWatch = @ptrCast(@alignCast(user.?));
        const t = std.mem.span(table);
        if (self.table) |want| {
            if (!std.mem.eql(u8, want, t)) return;
        }
        self.mutations += 1;
        var it: ?*c.sqlite3_stmt = c.sqlite3_next_stmt(self.db.handle, null);
        while (it) |stmt| : (it = c.sqlite3_next_stmt(self.db.handle, stmt)) {
            if (c.sqlite3_stmt_busy(stmt) == 0) continue;
            const sql_ptr = c.sqlite3_sql(stmt);
            if (sql_ptr == null) continue;
            const sql = std.mem.span(sql_ptr);
            if (!std.mem.startsWith(u8, sql, "SELECT")) continue; // the mutator itself
            if (std.mem.indexOf(u8, sql, t) == null) continue; // a cursor on some other table
            self.overlaps += 1;
            return;
        }
    }
};

test "CursorWatch sees a DELETE issued inside an open cursor, and not one issued after it" {
    var db = try Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE t(k INTEGER);");
    try db.exec("INSERT INTO t(k) VALUES(1),(2),(3);");

    {
        var w: CursorWatch = .{ .db = db };
        w.arm();
        defer w.disarm();
        var s = try db.prepare("SELECT k FROM t ORDER BY k;");
        defer s.finalize();
        while (try s.step()) {
            try db.run("DELETE FROM t WHERE k = ?1;", &.{.{ .int = s.columnInt(0) }});
        }
        try std.testing.expectEqual(@as(usize, 3), w.mutations);
        try std.testing.expectEqual(@as(usize, 3), w.overlaps);
    }

    try db.exec("INSERT INTO t(k) VALUES(1),(2),(3);");
    {
        var w: CursorWatch = .{ .db = db };
        w.arm();
        defer w.disarm();
        var ids: [8]i64 = undefined;
        var n: usize = 0;
        {
            var s = try db.prepare("SELECT k FROM t ORDER BY k;");
            defer s.finalize();
            while (try s.step()) {
                ids[n] = s.columnInt(0);
                n += 1;
            }
        }
        var d = try db.prepare("DELETE FROM t WHERE k = ?1;");
        defer d.finalize();
        for (ids[0..n]) |k| {
            d.reset();
            d.bindInt(1, k);
            _ = try d.step();
        }
        try std.testing.expectEqual(@as(usize, 3), w.mutations);
        try std.testing.expectEqual(@as(usize, 0), w.overlaps);
    }
}

/// Counts row mutations in one attached database, for the `read_only` route
/// audit. Armed on the writer, it also catches writes a reader would have failed
/// silently (e.g. a swallowed lazy-backfill error). Only `main` is watched:
/// `temp` scratch is a legitimate write even on a read-only connection.
pub const WriteWatch = struct {
    db: Db,
    database: []const u8 = "main",
    mutations: usize = 0,
    /// The last table mutated, truncated, so a failure names something.
    last_table: [64]u8 = @splat(0),
    last_len: usize = 0,

    pub fn arm(self: *WriteWatch) void {
        _ = c.sqlite3_update_hook(self.db.handle, onRow, self);
    }

    pub fn disarm(self: *WriteWatch) void {
        _ = c.sqlite3_update_hook(self.db.handle, null, null);
    }

    pub fn lastTable(self: *const WriteWatch) []const u8 {
        return self.last_table[0..self.last_len];
    }

    fn onRow(user: ?*anyopaque, _: c_int, database: [*c]const u8, table: [*c]const u8, _: c.sqlite3_int64) callconv(.c) void {
        const self: *WriteWatch = @ptrCast(@alignCast(user.?));
        if (!std.mem.eql(u8, self.database, std.mem.span(database))) return;
        self.mutations += 1;
        const t = std.mem.span(table);
        self.last_len = @min(t.len, self.last_table.len);
        @memcpy(self.last_table[0..self.last_len], t[0..self.last_len]);
    }
};

test "WriteWatch counts mutations in main and ignores the temp scratch a reader may still write" {
    var db = try Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE t(k INTEGER);");
    try db.exec("CREATE TEMP TABLE scratch(k INTEGER);");

    var w: WriteWatch = .{ .db = db };
    w.arm();
    defer w.disarm();

    {
        try db.run("SELECT COUNT(*) FROM t;", &.{});
    }
    try std.testing.expectEqual(@as(usize, 0), w.mutations);

    try db.exec("INSERT INTO temp.scratch(k) VALUES(1),(2);");
    try std.testing.expectEqual(@as(usize, 0), w.mutations);

    try db.exec("INSERT INTO t(k) VALUES(1);");
    try std.testing.expectEqual(@as(usize, 1), w.mutations);
    try std.testing.expectEqualStrings("t", w.lastTable());
}
