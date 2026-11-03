//! A bounded pool of `SQLITE_OPEN_READONLY` connections, borrowed per operation
//! (never per request) and falling back to the writer when empty.

const std = @import("std");
const sqlite = @import("sqlite.zig");

/// Hard ceiling on the pool: the free set is one `u32` bitmask.
pub const max_readers = 32;

/// Readers opened by default. Sized for a 1–2 core Pi; keep
/// `reader_cache_size_kib` in `sqlite.zig` in step.
pub const default_size = 3;

/// One borrowed reader. Hold it for exactly one operation, then `release`.
pub const Lease = struct {
    db: sqlite.Db,
    slot: u5,
};

pub const Pool = struct {
    conns: []sqlite.Db,
    /// Bit `i` set = `conns[i]` is free. The CAS claim guarantees one borrower
    /// per connection, which is what makes `SQLITE_OPEN_NOMUTEX` safe.
    free: std.atomic.Value(u32),

    /// Opens `n` read-only connections to `path`. Call after the writer has
    /// created and migrated the database. `n = 0` is an always-empty pool.
    pub fn open(gpa: std.mem.Allocator, path: [:0]const u8, n: usize) !Pool {
        std.debug.assert(n <= max_readers);
        const conns = try gpa.alloc(sqlite.Db, n);
        errdefer gpa.free(conns);
        var opened: usize = 0;
        errdefer for (conns[0..opened]) |db| db.close();
        while (opened < n) : (opened += 1) conns[opened] = try sqlite.Db.openReadOnly(path);
        // `n = 32` would overflow `1 << n`, hence the widening.
        const mask: u32 = if (n == 0) 0 else @truncate((@as(u64, 1) << @intCast(n)) - 1);
        return .{ .conns = conns, .free = .init(mask) };
    }

    /// Closes every connection; every lease must be released first.
    pub fn close(self: *Pool, gpa: std.mem.Allocator) void {
        std.debug.assert(self.available() == self.conns.len);
        for (self.conns) |db| db.close();
        gpa.free(self.conns);
        self.conns = &.{};
        self.free = .init(0);
    }

    /// Borrow a reader, or null when every one is busy. Null is not an error:
    /// the caller uses the writer under `db_lock`.
    pub fn acquire(self: *Pool) ?Lease {
        var cur = self.free.load(.monotonic);
        while (cur != 0) {
            const bit: u5 = @intCast(@ctz(cur));
            const claimed = cur & ~(@as(u32, 1) << bit);
            // `.acquire`: the previous holder's work must be visible before we use it.
            cur = self.free.cmpxchgWeak(cur, claimed, .acquire, .monotonic) orelse
                return .{ .db = self.conns[bit], .slot = bit };
        }
        return null;
    }

    /// Give a reader back, exactly once per successful `acquire`.
    pub fn release(self: *Pool, lease: Lease) void {
        const bit = @as(u32, 1) << lease.slot;
        const prev = self.free.fetchOr(bit, .release);
        std.debug.assert(prev & bit == 0); // released a slot that was already free
    }

    /// Readers not currently borrowed; stale by the time it is read.
    pub fn available(self: *const Pool) usize {
        return @popCount(self.free.load(.monotonic));
    }
};

// ---- tests ----

const testing = std.testing;
const schema = @import("schema.zig");

/// A migrated database file, not `:memory:`: a second connection to an
/// in-memory database opens a different, empty one.
const Fixture = struct {
    tmp: testing.TmpDir,
    path_buf: [128]u8 = undefined,
    path: [:0]const u8 = undefined,
    writer: sqlite.Db = undefined,

    fn init() !*Fixture {
        const f = try testing.allocator.create(Fixture);
        errdefer testing.allocator.destroy(f);
        f.tmp = testing.tmpDir(.{});
        f.path = try std.fmt.bufPrintZ(&f.path_buf, ".zig-cache/tmp/{s}/reader.db", .{f.tmp.sub_path});
        f.writer = try sqlite.Db.open(f.path);
        try schema.migrate(f.writer);
        return f;
    }

    fn deinit(f: *Fixture) void {
        f.writer.close();
        f.tmp.cleanup();
        testing.allocator.destroy(f);
    }
};

test "a pooled reader can read the writer's committed rows and cannot write a single one" {
    const f = try Fixture.init();
    defer f.deinit();
    try f.writer.exec("INSERT INTO users(id, email, password_md5, cred_enc, is_admin, created_at) VALUES(1,'a@h','','',1,0);");

    var pool = try Pool.open(testing.allocator, f.path, 2);
    defer pool.close(testing.allocator);

    const lease = pool.acquire().?;
    defer pool.release(lease);

    var r = (try lease.db.row("SELECT email FROM users WHERE id = 1;", &.{})).?;
    defer r.finalize();
    try testing.expectEqualStrings("a@h", r.text(0));

    const saved = sqlite.log_exec_errors;
    sqlite.log_exec_errors = false; // the diagnostic would fail this very test
    defer sqlite.log_exec_errors = saved;
    try testing.expectError(error.Exec, lease.db.exec("UPDATE users SET email = 'b@h' WHERE id = 1;"));
    try testing.expectError(error.Exec, lease.db.exec("INSERT INTO users(id, email, password_md5, cred_enc, is_admin, created_at) VALUES(2,'c@h','','',0,0);"));
    try testing.expectError(error.Exec, lease.db.exec("DELETE FROM users WHERE id = 1;"));

    var after = (try f.writer.row("SELECT COUNT(*), email FROM users;", &.{})).?;
    defer after.finalize();
    try testing.expectEqual(@as(i64, 1), after.int(0));
    try testing.expectEqualStrings("a@h", after.text(1));
}

test "the pool hands out each connection to at most one borrower, and empties rather than blocking" {
    const f = try Fixture.init();
    defer f.deinit();

    var pool = try Pool.open(testing.allocator, f.path, 3);
    defer pool.close(testing.allocator);
    try testing.expectEqual(@as(usize, 3), pool.available());

    var held: [3]Lease = undefined;
    for (&held) |*h| h.* = pool.acquire() orelse return error.TestUnexpectedResult;
    try testing.expectEqual(@as(usize, 0), pool.available());

    for (held, 0..) |a, i| for (held[i + 1 ..]) |b| {
        try testing.expect(a.slot != b.slot);
        try testing.expect(a.db.handle != b.db.handle);
    };

    for (0..10) |_| try testing.expect(pool.acquire() == null);
    try testing.expectEqual(@as(usize, 0), pool.available());

    pool.release(held[1]);
    try testing.expectEqual(@as(usize, 1), pool.available());
    const again = pool.acquire() orelse return error.TestUnexpectedResult;
    try testing.expect(pool.acquire() == null);

    pool.release(again);
    pool.release(held[0]);
    pool.release(held[2]);
    try testing.expectEqual(@as(usize, 3), pool.available());
}

test "a reader may still write its own TEMP scratch, which is what makes a folding read poolable" {
    // `temp` stays writable on a read-only connection; `WriteWatch` relies on it.
    const f = try Fixture.init();
    defer f.deinit();
    var pool = try Pool.open(testing.allocator, f.path, 1);
    defer pool.close(testing.allocator);
    const lease = pool.acquire().?;
    defer pool.release(lease);

    try lease.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold USING fts5(t);");
    try lease.db.exec("DELETE FROM temp.token_fold;");
    try lease.db.exec("INSERT INTO temp.token_fold(rowid, t) VALUES(1, 'caligrafia');");
    var r = (try lease.db.row("SELECT t FROM temp.token_fold WHERE rowid = 1;", &.{})).?;
    defer r.finalize();
    try testing.expectEqualStrings("caligrafia", r.text(0));

    const saved = sqlite.log_exec_errors;
    sqlite.log_exec_errors = false;
    defer sqlite.log_exec_errors = saved;
    try testing.expectError(error.Exec, lease.db.exec("CREATE TABLE main.nope(x INTEGER);"));
}

test "a zero-sized pool is the server without a pool: always empty, never wrong" {
    const f = try Fixture.init();
    defer f.deinit();
    var pool = try Pool.open(testing.allocator, f.path, 0);
    defer pool.close(testing.allocator);
    try testing.expectEqual(@as(usize, 0), pool.available());
    try testing.expect(pool.acquire() == null);
}

test "borrows balance under concurrent threads, and no connection is ever double-lent" {
    const f = try Fixture.init();
    defer f.deinit();
    try f.writer.exec("INSERT INTO users(id, email, password_md5, cred_enc, is_admin, created_at) VALUES(1,'a@h','','',1,0);");

    var pool = try Pool.open(testing.allocator, f.path, 3);
    defer pool.close(testing.allocator);

    const Worker = struct {
        pool: *Pool,
        held: *[max_readers]std.atomic.Value(bool),
        double_lends: *std.atomic.Value(u32),
        fallbacks: *std.atomic.Value(u32),

        fn run(self: @This()) void {
            for (0..2000) |_| {
                const lease = self.pool.acquire() orelse {
                    _ = self.fallbacks.fetchAdd(1, .monotonic);
                    continue;
                };
                if (self.held[lease.slot].swap(true, .acq_rel)) {
                    _ = self.double_lends.fetchAdd(1, .monotonic);
                }
                if (lease.db.row("SELECT COUNT(*) FROM users;", &.{}) catch null) |r| r.finalize();
                _ = self.held[lease.slot].swap(false, .acq_rel);
                self.pool.release(lease);
            }
        }
    };

    var held: [max_readers]std.atomic.Value(bool) = @splat(.init(false));
    var double_lends: std.atomic.Value(u32) = .init(0);
    var fallbacks: std.atomic.Value(u32) = .init(0);
    var threads: [6]std.Thread = undefined;
    for (&threads) |*t| t.* = try std.Thread.spawn(.{}, Worker.run, .{Worker{
        .pool = &pool,
        .held = &held,
        .double_lends = &double_lends,
        .fallbacks = &fallbacks,
    }});
    for (threads) |t| t.join();

    try testing.expectEqual(@as(u32, 0), double_lends.load(.monotonic));
    try testing.expectEqual(@as(usize, 3), pool.available());
    // Six threads on three readers must have hit the fallback at least once.
    try testing.expect(fallbacks.load(.monotonic) > 0);
}
