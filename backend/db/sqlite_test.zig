//! Tests for the SQLite wrapper: binds, columns and rows.

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

test "float bind/column round-trips a REAL, including the NULL and 0.0 cases" {
    var db = try Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE r(id INTEGER PRIMARY KEY, v REAL);");

    {
        var s = try db.prepare("INSERT INTO r(id, v) VALUES(?1, ?2);");
        defer s.finalize();
        s.bindInt(1, 1);
        s.bindFloat(2, 1404.5);
        try std.testing.expect(!try s.step());
        s.reset();
        s.bindInt(1, 2);
        s.bindFloatOpt(2, null);
        try std.testing.expect(!try s.step());
        s.reset();
        s.bindInt(1, 3);
        s.bindFloatOpt(2, 0.0); // 0.0 must survive as a VALUE, not read as absent
        try std.testing.expect(!try s.step());
    }

    var s = try db.prepare("SELECT v FROM r ORDER BY id;");
    defer s.finalize();
    try std.testing.expect(try s.step());
    try std.testing.expectEqual(@as(f64, 1404.5), s.columnFloat(0));
    try std.testing.expect(try s.step());
    try std.testing.expect(s.columnFloatOpt(0) == null);
    try std.testing.expect(try s.step());
    try std.testing.expectEqual(@as(?f64, 0.0), s.columnFloatOpt(0));
}

test "open in-memory db, DDL, insert with bind, query back" {
    var db = try Db.openMemory();
    defer db.close();

    try db.exec("CREATE TABLE u(id INTEGER PRIMARY KEY, email TEXT NOT NULL);");

    {
        var s = try db.prepare("INSERT INTO u(email) VALUES(?1);");
        defer s.finalize();
        s.bindText(1, "a@example.com");
        try std.testing.expect((try s.step()) == false); // no rows for INSERT
        try std.testing.expectEqual(@as(i64, 1), db.lastInsertRowId());
    }

    {
        var s = try db.prepare("SELECT id, email FROM u WHERE email = ?1;");
        defer s.finalize();
        s.bindText(1, "a@example.com");
        try std.testing.expect((try s.step()) == true);
        try std.testing.expectEqual(@as(i64, 1), s.columnInt(0));
        try std.testing.expectEqualStrings("a@example.com", s.columnText(1));
        try std.testing.expect((try s.step()) == false);
    }
}

test "an out-of-range bind index is a real error, not a silent no-op" {
    var db = try Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY);");

    var s = try db.prepare("SELECT id FROM t WHERE id = ?1;");
    defer s.finalize();
    // Binding `?2` via `bindInt` would panic, which Zig 0.16 tests cannot catch,
    // so pin the raw return code instead.
    try std.testing.expectEqual(c.SQLITE_RANGE, c.sqlite3_bind_int64(s.stmt, 2, 1));
    try std.testing.expect(c.SQLITE_RANGE != c.SQLITE_OK);

    s.bindInt(1, 1);
    try std.testing.expect(!try s.step());
}

test "no bind discards its SQLite return code" {
    // Stands in for the panic test Zig 0.16 cannot write: no bind may drop its code.
    const src = @embedFile("sqlite.zig");
    const discarded = "_ = c.sqlite3_bind"; // the pre-fix shape: code thrown away
    const checked = "checkBind(c.sqlite3_bind";

    var checked_count: usize = 0;
    var it = std.mem.splitScalar(u8, src, '\n');
    while (it.next()) |line| {
        const code = std.mem.trim(u8, line, " \t");
        if (std.mem.startsWith(u8, code, discarded)) return error.BindDiscardsReturnCode;
        if (std.mem.startsWith(u8, code, checked)) checked_count += 1;
    }
    try std.testing.expect(checked_count >= 5);
}

test "Db.row: no-row returns null, one-row reads int + text with int/text/null binds" {
    var db = try Db.openMemory();
    defer db.close();

    try db.exec(
        \\CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT NOT NULL, note TEXT);
    );
    {
        var s = try db.prepare("INSERT INTO t(id, email, note) VALUES(?1, ?2, ?3);");
        defer s.finalize();
        s.bindInt(1, 7);
        s.bindText(2, "a@example.com");
        s.bindNull(3);
        try std.testing.expect(!try s.step());
    }

    try std.testing.expect(
        (try db.row(
            "SELECT id FROM t WHERE email = ?1 AND note IS ?2;",
            &.{ .{ .text = "missing@example.com" }, .null },
        )) == null,
    );

    var r = (try db.row(
        "SELECT id, email FROM t WHERE id = ?1 AND email = ?2 AND note IS ?3;",
        &.{ .{ .int = 7 }, .{ .text = "a@example.com" }, .null },
    )) orelse return error.TestUnexpectedResult;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 7), r.int(0));
    try std.testing.expectEqualStrings("a@example.com", r.text(1));
}

test "openNoCreate opens an existing database and never creates a missing one" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const gpa = std.testing.allocator;
    const dir = try std.fmt.allocPrint(gpa, ".zig-cache/tmp/{s}", .{&tmp.sub_path});
    defer gpa.free(dir);
    const path = try std.fmt.allocPrintSentinel(gpa, "{s}/x.db", .{dir}, 0);
    defer gpa.free(path);

    try std.testing.expectError(error.Open, Db.openNoCreate(path, 1000));
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(std.testing.io, "x.db", .{}));

    {
        const made = try Db.open(path);
        defer made.close();
        try made.exec("CREATE TABLE t(v INTEGER); INSERT INTO t VALUES(7);");
    }
    const db = try Db.openNoCreate(path, 1000);
    defer db.close();
    var r = (try db.row("SELECT v FROM t;", &.{})).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 7), r.int(0));
}
