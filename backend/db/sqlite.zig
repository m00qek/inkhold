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

/// Whether `exec` logs SQLite's own message for a statement that failed. Always
/// true in the server; a TEST that deliberately drives a statement into failure
/// clears it for the duration of that call, because Zig's test runner counts
/// every `std.log.err` as a test failure — the diagnostic would fail the very
/// test asserting the error. Single-threaded test affordance, not a knob.
pub var log_exec_errors: bool = true;

/// Page cache a POOLED READER gets, in KiB (the pragma takes it negative).
///
/// Half the writer's 2 MB, and the number to turn if the trade ever looks wrong:
/// a reader re-reads pages the writer would have kept, which costs I/O, and the
/// pool multiplies whatever this is by its size. 1 MB × 3 readers ≈ 3 MB of page
/// cache — file-backed and reclaimable, which is the half of the RSS figure the
/// kernel does not charge us for. It is a lazily-filled
/// CEILING, not an upfront allocation.
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

    /// Opens an EXISTING database read-only — the connection kind the reader pool
    /// hands out (`db/reader_pool.zig`).
    ///
    /// Three differences from `open`, each of them load-bearing:
    ///
    ///   - `sqlite3_open_v2` with `SQLITE_OPEN_READONLY`, so SQLite itself refuses
    ///     any write with `SQLITE_READONLY`. That is what turns a misclassified
    ///     `read_only` route from silent corruption into a loud failure, and it is
    ///     the property the route audit test in `backend/test/reader_pool.zig`
    ///     rests on. It also means this NEVER creates the file: a missing database
    ///     is `error.Open` rather than a fresh empty one that would answer every
    ///     query with nothing.
    ///   - `SQLITE_OPEN_NOMUTEX`. The build is `SQLITE_THREADSAFE=1` (serialized),
    ///     which puts a mutex inside every connection; a pooled reader is borrowed
    ///     exclusively for one operation, so that mutex is pure overhead. **This
    ///     is only safe while the pool's borrow really is exclusive** — see
    ///     `reader_pool.Pool.acquire`.
    ///   - **No `journal_mode`.** WAL is a property of the DATABASE, set once by
    ///     the writer; a read-only connection cannot set it and would fail here on
    ///     the pragma rather than on the first query.
    ///
    /// `cache_size` is deliberately smaller than the writer's (see
    /// `reader_cache_size_kib`). `busy_timeout` is kept: a WAL reader does not
    /// contend for the write lock, but a checkpoint can briefly block it.
    ///
    /// **Operational note:** a read-only connection to a WAL database still needs
    /// the `-shm` file to exist and be writable — SQLite coordinates readers
    /// through shared memory. The writer holds the database open, so that is
    /// always true here; it would NOT be true of a genuinely read-only mount.
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
        // Same 32 MB window as the writer, and cheaper here than it looks: the
        // kernel page cache holds ONE physical copy of the mapped file across
        // every connection that maps it, so N readers do not cost N times the
        // pages.
        try db.exec("PRAGMA mmap_size = 33554432;");
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

    /// Prepares `sql`, binds `binds[i]` to parameter `?(i+1)`, and steps once —
    /// the single-row read shape (`prepare → bind* → step → column*`) in one call.
    /// Returns `null` (finalizing the statement) when there is no row; otherwise a
    /// `Row` wrapping the positioned statement. The caller reads columns THEN calls
    /// `Row.finalize` — `text`/`blob` columns alias SQLite memory that `finalize`
    /// invalidates, so this deliberately hands back a positioned-stmt wrapper rather
    /// than mapping columns into a struct (whose `[]const u8` fields would dangle).
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

/// Watches for a row mutation issued while a SELECT over the SAME table is still
/// mid-cursor — the "DELETE inside an open cursor" hazard the services layer's
/// collect-then-delete discipline exists to avoid.
///
/// **This is the only way that discipline can be TESTED.** SQLite tolerates the
/// overlap, so the rows deleted are identical either way and every outcome
/// assertion passes against both shapes; the difference is internal cursor state,
/// and it stops being harmless the day a query plan stops materialising the
/// result through a sorter. `sqlite3_update_hook` fires per mutated row, and
/// `sqlite3_stmt_busy` says which statements on the connection have been stepped
/// and not yet reset — together they observe exactly the overlap.
///
/// Only READERS count: the mutating statement is itself busy inside its own hook,
/// so a statement is an offender only if its SQL starts with SELECT and names the
/// table being mutated.
pub const CursorWatch = struct {
    db: Db,
    /// Watch only this table when set (a whole-service call path mutates many;
    /// naming one keeps a test about `file_history` from answering for `blobs`).
    table: ?[]const u8 = null,
    /// Row mutations seen while a SELECT over the same table was mid-cursor.
    overlaps: usize = 0,
    /// Row mutations seen at all — so a test can tell "no overlap" from
    /// "the code under test never ran".
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

    // The hazardous shape: delete each row as the cursor emits it.
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

    // The disciplined shape: collect inside the cursor, delete after it is closed.
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

/// Counts row mutations in ONE attached database, for the `read_only` route
/// audit (`test/http_integration.zig`).
///
/// **Why it exists alongside a read-only connection rather than instead of it.**
/// `SQLITE_OPEN_READONLY` catches a write that is ATTEMPTED and propagated. It
/// cannot catch one whose failure is swallowed — the lazy index backfill on the
/// control-plane read paths discards its own error by design, so on a reader it
/// would answer 200 with quietly degraded data. Armed on the WRITER while the
/// same routes run, this sees the mutation whichever way it goes.
///
/// **`database` is not decoration.** `temp` is per-connection scratch and is
/// writable even on a read-only connection — `search/fuzzy.zig` tokenizes through
/// a `temp.token_fold` table, which is a legitimate write that must not read as a
/// misclassification. Watching `main` alone is the difference between an audit
/// that means something and one that has to be switched off.
pub const WriteWatch = struct {
    db: Db,
    /// Which attached database to count mutations in. `temp` and any other
    /// attachment are ignored.
    database: []const u8 = "main",
    mutations: usize = 0,
    /// The last table mutated, so a failure names something. Truncated, and only
    /// ever read after `mutations` is non-zero.
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

    // A pure read moves nothing.
    {
        var s = try db.prepare("SELECT COUNT(*) FROM t;");
        defer s.finalize();
        _ = try s.step();
    }
    try std.testing.expectEqual(@as(usize, 0), w.mutations);

    // `temp` is per-connection scratch — the in-document search tokenizes through
    // one on every query — so it must NOT read as a write to the database.
    try db.exec("INSERT INTO temp.scratch(k) VALUES(1),(2);");
    try std.testing.expectEqual(@as(usize, 0), w.mutations);

    // A real row in `main` does.
    try db.exec("INSERT INTO t(k) VALUES(1);");
    try std.testing.expectEqual(@as(usize, 1), w.mutations);
    try std.testing.expectEqualStrings("t", w.lastTable());
}

/// Every `Stmt.bind*` routes its SQLite return code through here.
///
/// It ASSERTS rather than returning an error, deliberately. A bind fails for two
/// reasons: `SQLITE_RANGE` — the index does not exist in the statement, i.e. the
/// bind list and the SQL have drifted apart — or `SQLITE_NOMEM`. The first is a
/// programming error, and the second is not a condition 390 call sites across 14
/// files can each do something useful about. Propagating would mean touching
/// nearly every service and handler in the repo to thread an error that, at every
/// one of those sites, means "this code is wrong".
///
/// Silence was the thing worth fixing: a discarded code left the parameter NULL,
/// so a keyed `UPDATE … WHERE id = ?1` quietly matched nothing and reported
/// success. An assert turns that into a loud stop in every debug and test build —
/// which is exactly where a wrong index is introduced — and, since the server
/// ships ReleaseSafe (see the Makefile), in production too.
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
    /// Binds arbitrary bytes as a BLOB (no encoding, no NUL semantics) — for
    /// packed fixed-stride records that are always read back as a unit.
    pub fn bindBlob(self: Stmt, index: c_int, bytes: []const u8) void {
        checkBind(c.sqlite3_bind_blob64(self.stmt, index, bytes.ptr, @intCast(bytes.len), sqliteTransient()));
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
        checkBind(c.sqlite3_bind_double(self.stmt, index, value));
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

    /// Virtual-machine steps this statement has run since it was prepared or last
    /// reset — the work SQLite ACTUALLY did, counted rather than timed.
    ///
    /// For plan pins. A wall-clock assertion on a query is a flake generator on a
    /// loaded machine; this counter is deterministic for a given plan and a given
    /// row set, so a test can say "this must not grow with the library" and mean
    /// exactly that.
    ///
    /// **CUMULATIVE for the statement's lifetime, NOT per-execution.** `reset()`
    /// does not zero it — `sqlite3VdbeRewind` never touches `aCounter`; only
    /// `sqlite3_stmt_status`'s own reset flag clears it, which this call does not
    /// pass. A test that resets and re-steps expecting a fresh count reads the
    /// running total and passes for the wrong reason. Prepare a new statement per
    /// measurement, as `sync.zig`'s pin does.
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

/// One bound parameter for `Db.row`. Each variant mirrors a `Stmt.bind*` method;
/// a `binds` slice position `i` binds to SQL parameter `?(i+1)`.
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

/// A statement positioned on its single result row (see `Db.row`). Read the
/// columns you need, then `finalize`. Column readers delegate straight to the
/// underlying `Stmt`; `text`/`blob` slices are valid only until `finalize`.
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
    // The premise `checkBind` rests on. SQLite does NOT ignore a parameter index
    // the statement has no slot for — it reports SQLITE_RANGE and leaves the
    // statement's other parameters alone. Discarding that code was what turned a
    // keyed `UPDATE … WHERE id = ?1` into a no-op that reported success.
    var db = try Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY);");

    var s = try db.prepare("SELECT id FROM t WHERE id = ?1;");
    defer s.finalize();
    // `?2` does not exist in that SQL. Called through `s.bindInt(2, 1)` this would
    // trip the assert, i.e. panic — and Zig 0.16 has no `std.testing.expectPanic`
    // (checked: `std.testing` exports no panic-catching helper), and a panic cannot
    // otherwise be caught in-process. So the contract is pinned one level down: the
    // code SQLite returns here is non-OK, and the test below proves every bind
    // checks it.
    try std.testing.expectEqual(c.SQLITE_RANGE, c.sqlite3_bind_int64(s.stmt, 2, 1));
    try std.testing.expect(c.SQLITE_RANGE != c.SQLITE_OK);

    // The in-range bind on the same statement still works, so this is about the
    // index and not about the statement having been poisoned.
    s.bindInt(1, 1);
    try std.testing.expect(!try s.step());
}

test "no bind discards its SQLite return code" {
    // Mechanized inspection, standing in for the panic test Zig 0.16 cannot write.
    // The property is "every `sqlite3_bind_*` call in this file goes through
    // `checkBind`", and a new `bind*` helper that drops the code is exactly the
    // regression that would restore the silent-NULL bug — so it fails here instead
    // of six months later in a no-op UPDATE.
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
    // text / int64 / null / blob64 / double — the five raw bind calls that exist.
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

    // No-row case: null (and the statement is finalized inside `row`).
    try std.testing.expect(
        (try db.row(
            "SELECT id FROM t WHERE email = ?1 AND note IS ?2;",
            &.{ .{ .text = "missing@example.com" }, .null },
        )) == null,
    );

    // One-row case: bind an int, a text, and a NULL; read an int and a text column.
    var r = (try db.row(
        "SELECT id, email FROM t WHERE id = ?1 AND email = ?2 AND note IS ?3;",
        &.{ .{ .int = 7 }, .{ .text = "a@example.com" }, .null },
    )) orelse return error.TestUnexpectedResult;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 7), r.int(0));
    try std.testing.expectEqualStrings("a@example.com", r.text(1));
}
