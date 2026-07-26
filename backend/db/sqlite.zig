//! Thin idiomatic wrapper over SQLite (C API via @cImport).
//!
//! Currently links the system libsqlite3; switching to a vendored/fetched
//! amalgamation for a self-contained static binary is a build.zig change only —
//! this file is unaffected. Opens with WAL + foreign keys + a small, explicit
//! page cache (per the 50 MB budget).

const std = @import("std");

const c = @cImport({
    @cInclude("sqlite3.h");
});

// sqliteTransient() = (void*)-1: tell SQLite to copy bound blobs/text, so callers
// needn't keep the source alive past bind. (@cImport can't translate the macro.)
//
// The sentinel address `0xFFFF…F` is deliberately UNaligned, and on 32-bit ARM a
// function pointer has alignment > 1 — so a *comptime* `@ptrFromInt` to the
// destructor type is a hard "requires aligned address" error there (x86-64
// happened to accept it, its fn-ptr alignment being 1). It is a value SQLite
// only ever COMPARES, never calls, so we build it at RUNTIME: the `noinline`
// barrier hides the address from comptime evaluation, and safety-off skips the
// runtime alignment assert. Portable to armv6; a couple of instructions on any
// target, dwarfed by the C bind call that consumes it.
noinline fn transientAddr() usize {
    return @bitCast(@as(isize, -1));
}
inline fn sqliteTransient() c.sqlite3_destructor_type {
    @setRuntimeSafety(false);
    return @ptrFromInt(transientAddr());
}

pub const Error = error{
    Open,
    Exec,
    Prepare,
    Step,
};

pub const Db = struct {
    handle: *c.sqlite3,

    /// Opens (creating if needed) the database at `path` (":memory:" for an
    /// in-memory db) and applies the standard pragmas.
    pub fn open(path: [:0]const u8) Error!Db {
        var handle: ?*c.sqlite3 = null;
        if (c.sqlite3_open(path.ptr, &handle) != c.SQLITE_OK) {
            if (handle) |h| _ = c.sqlite3_close(h);
            return error.Open;
        }
        const db: Db = .{ .handle = handle.? };
        try db.exec("PRAGMA journal_mode = WAL;");
        try db.exec("PRAGMA foreign_keys = ON;");
        try db.exec("PRAGMA busy_timeout = 5000;");
        try db.exec("PRAGMA cache_size = -2000;"); // ~2 MB page cache (negative = KiB)
        // Memory-mapped reads: skip the read() syscall + copy into the private page
        // cache. The gain is I/O latency, not caching, so it is invisible on a warm
        // NVMe dev box and largest on the SD-card/Pi target. 32 MB (not more) is
        // deliberate: VmRSS counts mapped file pages, and `health.zig` measures the
        // ~50 MB budget against VmRSS — a larger map over a growing DB would inflate
        // that number with nothing actually wrong. RssAnon is reported alongside so
        // the "memory this process owns" figure stays honest once this is on.
        try db.exec("PRAGMA mmap_size = 33554432;"); // 32 MB
        return db;
    }

    pub fn openMemory() Error!Db {
        return open(":memory:");
    }

    /// Serializes the "main" database into a fresh `gpa`-owned buffer — the inverse
    /// of a deserialize-into-`:memory:` open (the untrusted-`.spd` read path, which
    /// now lives entirely in the shared `parsers/spd` parser). Only used by tests,
    /// to build a `.spd` fixture hermetically (an in-memory SQLite db → bytes)
    /// rather than committing a large binary. `error.Serialize` if SQLite cannot
    /// produce the image.
    pub fn serializeAlloc(self: Db, gpa: std.mem.Allocator) ![]u8 {
        var size: c.sqlite3_int64 = 0;
        const p = c.sqlite3_serialize(self.handle, "main", &size, 0);
        if (p == null) return error.Serialize;
        defer c.sqlite3_free(p);
        return gpa.dupe(u8, @as([*]const u8, @ptrCast(p))[0..@intCast(size)]);
    }

    pub fn close(self: Db) void {
        _ = c.sqlite3_close(self.handle);
    }

    /// Runs one or more statements with no result rows (DDL, INSERT, etc.).
    pub fn exec(self: Db, sql: [:0]const u8) Error!void {
        var msg: [*c]u8 = null;
        if (c.sqlite3_exec(self.handle, sql.ptr, null, null, &msg) != c.SQLITE_OK) {
            if (msg != null) {
                std.log.err("sqlite exec: {s}", .{msg});
                c.sqlite3_free(msg);
            }
            return error.Exec;
        }
    }

    pub fn prepare(self: Db, sql: []const u8) Error!Stmt {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, sql.ptr, @intCast(sql.len), &stmt, null) != c.SQLITE_OK) {
            std.log.err("sqlite prepare: {s}", .{self.errmsg()});
            return error.Prepare;
        }
        return .{ .stmt = stmt.? };
    }

    /// rowid of the most recent successful INSERT.
    pub fn lastInsertRowId(self: Db) i64 {
        return c.sqlite3_last_insert_rowid(self.handle);
    }

    /// Rows changed by the most recent INSERT/UPDATE/DELETE (for "did anything
    /// match?" checks after a keyed UPDATE/DELETE).
    pub fn changes(self: Db) i64 {
        return c.sqlite3_changes(self.handle);
    }

    pub fn errmsg(self: Db) []const u8 {
        return std.mem.span(c.sqlite3_errmsg(self.handle));
    }
};

pub const Stmt = struct {
    stmt: *c.sqlite3_stmt,

    /// Parameters are 1-indexed (`?1`, `?2`, …).
    pub fn bindText(self: Stmt, index: c_int, text: []const u8) void {
        _ = c.sqlite3_bind_text(self.stmt, index, text.ptr, @intCast(text.len), sqliteTransient());
    }
    pub fn bindInt(self: Stmt, index: c_int, value: i64) void {
        _ = c.sqlite3_bind_int64(self.stmt, index, value);
    }
    pub fn bindNull(self: Stmt, index: c_int) void {
        _ = c.sqlite3_bind_null(self.stmt, index);
    }
    /// Binds arbitrary bytes as a BLOB (no encoding, no NUL semantics) — for
    /// packed fixed-stride records that are always read back as a unit.
    pub fn bindBlob(self: Stmt, index: c_int, bytes: []const u8) void {
        _ = c.sqlite3_bind_blob64(self.stmt, index, bytes.ptr, @intCast(bytes.len), sqliteTransient());
    }
    /// Binds `text`, or SQL NULL when it is absent.
    pub fn bindTextOpt(self: Stmt, index: c_int, text: ?[]const u8) void {
        if (text) |t| self.bindText(index, t) else self.bindNull(index);
    }
    /// Binds `value`, or SQL NULL when it is absent.
    pub fn bindIntOpt(self: Stmt, index: c_int, value: ?i64) void {
        if (value) |v| self.bindInt(index, v) else self.bindNull(index);
    }
    /// Binds a REAL. SQLite stores all floats as 8-byte IEEE doubles, so `f64`
    /// is the native width; narrower values widen losslessly at the call site.
    pub fn bindFloat(self: Stmt, index: c_int, value: f64) void {
        _ = c.sqlite3_bind_double(self.stmt, index, value);
    }
    /// Binds `value`, or SQL NULL when it is absent.
    pub fn bindFloatOpt(self: Stmt, index: c_int, value: ?f64) void {
        if (value) |v| self.bindFloat(index, v) else self.bindNull(index);
    }

    /// Advances the statement. Returns true if a row is available, false when done.
    pub fn step(self: Stmt) Error!bool {
        return switch (c.sqlite3_step(self.stmt)) {
            c.SQLITE_ROW => true,
            c.SQLITE_DONE => false,
            else => error.Step,
        };
    }

    /// Columns are 0-indexed.
    pub fn columnInt(self: Stmt, col: c_int) i64 {
        return c.sqlite3_column_int64(self.stmt, col);
    }
    /// The returned slice is owned by SQLite and valid until the next `step`/`reset`.
    pub fn columnText(self: Stmt, col: c_int) []const u8 {
        const ptr = c.sqlite3_column_text(self.stmt, col);
        const len = c.sqlite3_column_bytes(self.stmt, col);
        if (ptr == null or len <= 0) return "";
        return ptr[0..@intCast(len)];
    }

    /// The returned slice is owned by SQLite and valid until the next `step`/`reset`.
    pub fn columnBlob(self: Stmt, col: c_int) []const u8 {
        const ptr = c.sqlite3_column_blob(self.stmt, col);
        const len = c.sqlite3_column_bytes(self.stmt, col);
        if (ptr == null or len <= 0) return "";
        return @as([*]const u8, @ptrCast(ptr))[0..@intCast(len)];
    }

    /// True when the column holds SQL NULL (distinguishable from "" / 0, which
    /// `columnText` / `columnInt` would report identically).
    pub fn columnIsNull(self: Stmt, col: c_int) bool {
        return c.sqlite3_column_type(self.stmt, col) == c.SQLITE_NULL;
    }

    /// The column as an optional integer — null for SQL NULL. The mirror of
    /// `bindIntOpt`, for nullable timestamp columns where 0 is a legitimate value
    /// and `columnInt` alone could not tell it from "absent".
    pub fn columnIntOpt(self: Stmt, col: c_int) ?i64 {
        return if (self.columnIsNull(col)) null else self.columnInt(col);
    }

    /// A REAL column as `f64` (SQLite's native float width).
    pub fn columnFloat(self: Stmt, col: c_int) f64 {
        return c.sqlite3_column_double(self.stmt, col);
    }
    /// The column as an optional float — null for SQL NULL, the mirror of
    /// `bindFloatOpt` (0.0 is a legitimate stored value, so `columnFloat` alone
    /// could not tell it from "absent").
    pub fn columnFloatOpt(self: Stmt, col: c_int) ?f64 {
        return if (self.columnIsNull(col)) null else self.columnFloat(col);
    }

    pub fn reset(self: Stmt) void {
        _ = c.sqlite3_reset(self.stmt);
    }
    pub fn finalize(self: Stmt) void {
        _ = c.sqlite3_finalize(self.stmt);
    }
};

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
