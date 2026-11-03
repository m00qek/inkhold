//! Thin idiomatic wrapper over SQLite (C API via @cImport).

const std = @import("std");

const c = @cImport({
    @cInclude("sqlite3.h");
});

// SQLITE_TRANSIENT, (void*)-1: SQLite copies bound text/blobs. @cImport can't
// translate the macro, and a comptime `@ptrFromInt` of this unaligned address
// to a fn-pointer type is a compile error on 32-bit ARM. SQLite only compares
// it, so build it at runtime behind `noinline` with safety off.
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

/// Whether `exec` logs SQLite's message on failure. Tests that drive a statement
/// into failure clear it, since the test runner fails on any `std.log.err`.
pub var log_exec_errors: bool = true;

/// Page cache a pooled reader gets, in KiB (the pragma takes it negative).
/// Multiplied by the pool size; it is a lazily-filled ceiling.
pub const reader_cache_size_kib = 1000;

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
        // 32 MB and no more: VmRSS counts mapped file pages, and the memory
        // budget in `health.zig` is measured against VmRSS.
        try db.exec("PRAGMA mmap_size = 33554432;"); // 32 MB
        return db;
    }

    /// Opens an existing database read-only, for the reader pool. SQLite then
    /// refuses every write, and a missing file is `error.Open`, not a new empty db.
    /// `NOMUTEX` is safe only because a pool lease is exclusive. No
    /// `journal_mode`: WAL is set by the writer and a reader cannot set it.
    /// The `-shm` file must exist and be writable, which the open writer ensures.
    pub fn openReadOnly(path: [:0]const u8) Error!Db {
        var handle: ?*c.sqlite3 = null;
        const flags = c.SQLITE_OPEN_READONLY | c.SQLITE_OPEN_NOMUTEX;
        if (c.sqlite3_open_v2(path.ptr, &handle, flags, null) != c.SQLITE_OK) {
            if (handle) |h| _ = c.sqlite3_close(h);
            return error.Open;
        }
        const db: Db = .{ .handle = handle.? };
        errdefer db.close();
        try db.exec("PRAGMA busy_timeout = 5000;");
        try db.exec(std.fmt.comptimePrint("PRAGMA cache_size = -{d};", .{reader_cache_size_kib}));
        // Mapped pages are shared in the kernel page cache across connections.
        try db.exec("PRAGMA mmap_size = 33554432;");
        return db;
    }

    pub fn openMemory() Error!Db {
        return open(":memory:");
    }

    /// Serializes the "main" database into a `gpa`-owned buffer. Tests use it
    /// to build `.spd` fixtures without committing binaries.
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
                if (log_exec_errors) std.log.err("sqlite exec: {s}", .{msg});
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

    /// Prepares `sql`, binds `binds[i]` to `?(i+1)` and steps once; null when
    /// there is no row. Read columns before `Row.finalize`: `text`/`blob` alias
    /// SQLite memory that finalize frees.
    pub fn row(self: Db, sql: []const u8, binds: []const Bind) Error!?Row {
        var stmt = try self.prepare(sql);
        errdefer stmt.finalize();
        for (binds, 0..) |b, i| {
            const idx: c_int = @intCast(i + 1);
            switch (b) {
                .int => |v| stmt.bindInt(idx, v),
                .text => |v| stmt.bindText(idx, v),
                .blob => |v| stmt.bindBlob(idx, v),
                .null => stmt.bindNull(idx),
                .float => |v| stmt.bindFloat(idx, v),
                .int_opt => |v| stmt.bindIntOpt(idx, v),
                .text_opt => |v| stmt.bindTextOpt(idx, v),
                .float_opt => |v| stmt.bindFloatOpt(idx, v),
            }
        }
        if (!try stmt.step()) {
            stmt.finalize();
            return null;
        }
        return .{ .stmt = stmt };
    }

    pub fn lastInsertRowId(self: Db) i64 {
        return c.sqlite3_last_insert_rowid(self.handle);
    }

    /// Rows changed by the most recent INSERT/UPDATE/DELETE.
    pub fn changes(self: Db) i64 {
        return c.sqlite3_changes(self.handle);
    }

    pub fn errmsg(self: Db) []const u8 {
        return std.mem.span(c.sqlite3_errmsg(self.handle));
    }
};

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
            var d = try db.prepare("DELETE FROM t WHERE k = ?1;");
            defer d.finalize();
            d.bindInt(1, s.columnInt(0));
            _ = try d.step();
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
        var s = try db.prepare("SELECT COUNT(*) FROM t;");
        defer s.finalize();
        _ = try s.step();
    }
    try std.testing.expectEqual(@as(usize, 0), w.mutations);

    try db.exec("INSERT INTO temp.scratch(k) VALUES(1),(2);");
    try std.testing.expectEqual(@as(usize, 0), w.mutations);

    try db.exec("INSERT INTO t(k) VALUES(1);");
    try std.testing.expectEqual(@as(usize, 1), w.mutations);
    try std.testing.expectEqualStrings("t", w.lastTable());
}

/// Asserts every bind's return code. A failed bind (`SQLITE_RANGE`: bind list and
/// SQL drifted apart) otherwise leaves the parameter NULL, so a keyed UPDATE
/// silently matches nothing. The server ships ReleaseSafe, so this holds in
/// production too.
fn checkBind(rc: c_int) void {
    std.debug.assert(rc == c.SQLITE_OK);
}

pub const Stmt = struct {
    stmt: *c.sqlite3_stmt,

    /// Parameters are 1-indexed (`?1`, `?2`, …).
    pub fn bindText(self: Stmt, index: c_int, text: []const u8) void {
        checkBind(c.sqlite3_bind_text(self.stmt, index, text.ptr, @intCast(text.len), sqliteTransient()));
    }
    pub fn bindInt(self: Stmt, index: c_int, value: i64) void {
        checkBind(c.sqlite3_bind_int64(self.stmt, index, value));
    }
    pub fn bindNull(self: Stmt, index: c_int) void {
        checkBind(c.sqlite3_bind_null(self.stmt, index));
    }
    /// Binds arbitrary bytes as a BLOB.
    pub fn bindBlob(self: Stmt, index: c_int, bytes: []const u8) void {
        checkBind(c.sqlite3_bind_blob64(self.stmt, index, bytes.ptr, @intCast(bytes.len), sqliteTransient()));
    }
    pub fn bindTextOpt(self: Stmt, index: c_int, text: ?[]const u8) void {
        if (text) |t| self.bindText(index, t) else self.bindNull(index);
    }
    pub fn bindIntOpt(self: Stmt, index: c_int, value: ?i64) void {
        if (value) |v| self.bindInt(index, v) else self.bindNull(index);
    }
    /// Binds a REAL (SQLite floats are 8-byte doubles).
    pub fn bindFloat(self: Stmt, index: c_int, value: f64) void {
        checkBind(c.sqlite3_bind_double(self.stmt, index, value));
    }
    pub fn bindFloatOpt(self: Stmt, index: c_int, value: ?f64) void {
        if (value) |v| self.bindFloat(index, v) else self.bindNull(index);
    }

    /// Returns true if a row is available, false when done.
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

    /// True for SQL NULL, which `columnText` / `columnInt` report as "" / 0.
    pub fn columnIsNull(self: Stmt, col: c_int) bool {
        return c.sqlite3_column_type(self.stmt, col) == c.SQLITE_NULL;
    }

    /// The column as an optional integer, null for SQL NULL.
    pub fn columnIntOpt(self: Stmt, col: c_int) ?i64 {
        return if (self.columnIsNull(col)) null else self.columnInt(col);
    }

    pub fn columnFloat(self: Stmt, col: c_int) f64 {
        return c.sqlite3_column_double(self.stmt, col);
    }
    /// The column as an optional float, null for SQL NULL.
    pub fn columnFloatOpt(self: Stmt, col: c_int) ?f64 {
        return if (self.columnIsNull(col)) null else self.columnFloat(col);
    }

    /// VM steps since prepare: a deterministic work count for plan pins, where
    /// wall-clock asserts would flake. Cumulative for the statement's lifetime;
    /// `reset()` does not zero it, so prepare a fresh statement per measurement.
    pub fn vmSteps(self: Stmt) i64 {
        return c.sqlite3_stmt_status(self.stmt, c.SQLITE_STMTSTATUS_VM_STEP, 0);
    }

    pub fn reset(self: Stmt) void {
        _ = c.sqlite3_reset(self.stmt);
    }
    pub fn finalize(self: Stmt) void {
        _ = c.sqlite3_finalize(self.stmt);
    }
};

/// One bound parameter for `Db.row`; slice position `i` binds `?(i+1)`.
pub const Bind = union(enum) {
    int: i64,
    text: []const u8,
    blob: []const u8,
    null,
    float: f64,
    int_opt: ?i64,
    text_opt: ?[]const u8,
    float_opt: ?f64,
};

/// A statement positioned on its single result row (see `Db.row`); `text`/`blob`
/// slices are valid only until `finalize`.
pub const Row = struct {
    stmt: Stmt,

    pub fn int(self: Row, col: c_int) i64 {
        return self.stmt.columnInt(col);
    }
    pub fn text(self: Row, col: c_int) []const u8 {
        return self.stmt.columnText(col);
    }
    pub fn blob(self: Row, col: c_int) []const u8 {
        return self.stmt.columnBlob(col);
    }
    pub fn float(self: Row, col: c_int) f64 {
        return self.stmt.columnFloat(col);
    }
    pub fn isNull(self: Row, col: c_int) bool {
        return self.stmt.columnIsNull(col);
    }
    pub fn intOpt(self: Row, col: c_int) ?i64 {
        return self.stmt.columnIntOpt(col);
    }
    pub fn floatOpt(self: Row, col: c_int) ?f64 {
        return self.stmt.columnFloatOpt(col);
    }

    pub fn finalize(self: Row) void {
        self.stmt.finalize();
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
