//! A bounded pool of `SQLITE_OPEN_READONLY` connections, borrowed per OPERATION.
//!
//! ## Why this exists
//!
//! The server's one `db_lock` protects the connection HANDLE, not the database.
//! WAL supports concurrent readers plus one writer natively, and a single shared
//! connection discards that: a 3.41 s global search (measured on the Pi)
//! holds the one lock, so every write and every other read
//! queues behind it. A read that runs on its own connection is not a barrier —
//! even on one core, where the win is PREEMPTION rather than parallelism: the OS
//! timeslices the short read against the long search instead of serializing them.
//!
//! ## The two rules
//!
//! **Borrow per OPERATION, never per request.** An SSE stream lives for minutes
//! and uses 74 µs of connection; eight such streams holding a reader for their
//! lifetime would exhaust this pool and deadlock the server against itself. The
//! API makes the right thing easy — `acquire`/`release` around one dispatch — and
//! `http/transport.zig` is the only caller.
//!
//! **Exhaustion falls back to the writer, it never blocks and never fails.**
//! `acquire` returns null the moment nothing is free, and the caller takes
//! `db_lock` and uses the writer connection exactly as it did before this module
//! existed. That makes the pool a pure optimisation with NO new failure mode, and
//! it makes `default_size` a tuning decision rather than a correctness one.
//!
//! ## Why a bitmask and not a mutex + free list
//!
//! `acquire` must be cheap enough to sit in front of a 100 µs read and must not
//! itself be a contended lock — a pool guarded by a mutex reintroduces, in
//! miniature, the serialization it exists to remove. One atomic word with a CAS
//! claim is wait-free in the uncontended case and needs no `Io` to operate, which
//! also keeps it usable from anywhere a `Context` is.

const std = @import("std");
const sqlite = @import("sqlite.zig");

/// Hard ceiling on the pool: the free set is one `u32` bitmask.
///
/// Not a limitation in practice — the target is a 1–2 core Pi, where more
/// readers than cores only timeslice against each other. It is here so the
/// bitmask's width is stated rather than implied.
pub const max_readers = 32;

/// Readers opened by default.
///
/// **3, from the revised one-or-two-core table**, not from the 4–6 first
/// estimated against a multi-core box: on one core extra
/// readers buy nothing but context switches, and each one costs a page cache.
/// The exhaustion fallback above is what makes this safe to be wrong about — too
/// few readers degrades to today's behaviour for the overflow, never to an error
/// — so it is deliberately the small end of the range. Turn it up here, and
/// `reader_cache_size_kib` in `sqlite.zig` with it.
pub const default_size = 3;

/// One borrowed reader. Hold it for exactly one operation, then `release`.
///
/// `slot` is how release finds the bit again; a caller has no business reading
/// it, and must not fabricate a Lease to release a connection it did not borrow.
pub const Lease = struct {
    db: sqlite.Db,
    slot: u5,
};

pub const Pool = struct {
    conns: []sqlite.Db,
    /// Bit `i` set = `conns[i]` is free. Claiming is a CAS that clears the bit,
    /// so a connection can be held by at most one borrower — which is the whole
    /// safety argument for opening them `SQLITE_OPEN_NOMUTEX`.
    free: std.atomic.Value(u32),

    /// Opens `n` read-only connections to `path`.
    ///
    /// **Call this AFTER the writer has opened and migrated the database.** A
    /// reader cannot create the file and cannot set `journal_mode`, so opening
    /// first would either fail or (worse, before `SQLITE_OPEN_READONLY`) race the
    /// migration. `app.zig` orders it that way.
    ///
    /// `n = 0` yields a pool that always answers "empty", i.e. the pre-pool
    /// server. Useful as an off switch and as the boundary case the tests pin.
    pub fn open(gpa: std.mem.Allocator, path: [:0]const u8, n: usize) !Pool {
        std.debug.assert(n <= max_readers);
        const conns = try gpa.alloc(sqlite.Db, n);
        errdefer gpa.free(conns);
        var opened: usize = 0;
        errdefer for (conns[0..opened]) |db| db.close();
        while (opened < n) : (opened += 1) conns[opened] = try sqlite.Db.openReadOnly(path);
        // Every slot free. `n = 32` would overflow `1 << n`, hence the widening.
        const mask: u32 = if (n == 0) 0 else @truncate((@as(u64, 1) << @intCast(n)) - 1);
        return .{ .conns = conns, .free = .init(mask) };
    }

    /// Closes every connection. **Every lease must be released first** — a
    /// borrower still stepping a statement through a closed handle is a
    /// use-after-free, so this asserts the pool is whole rather than trusting it.
    pub fn close(self: *Pool, gpa: std.mem.Allocator) void {
        std.debug.assert(self.available() == self.conns.len);
        for (self.conns) |db| db.close();
        gpa.free(self.conns);
        self.conns = &.{};
        self.free = .init(0);
    }

    /// Borrow a reader, or null when every one is busy.
    ///
    /// **Null is not an error and must never be treated as one.** It means "use
    /// the writer under `db_lock`", which is what the server did before this
    /// module existed. Blocking here would reintroduce the queueing the pool
    /// exists to remove, and refusing would 503 reads on a busy server.
    pub fn acquire(self: *Pool) ?Lease {
        var cur = self.free.load(.monotonic);
        while (cur != 0) {
            const bit: u5 = @intCast(@ctz(cur));
            const claimed = cur & ~(@as(u32, 1) << bit);
            // `.acquire` on success: everything the previous holder did through
            // this connection must be visible to us before we touch it.
            cur = self.free.cmpxchgWeak(cur, claimed, .acquire, .monotonic) orelse
                return .{ .db = self.conns[bit], .slot = bit };
        }
        return null;
    }

    /// Give a reader back. Exactly one per successful `acquire`, and never twice
    /// — a double release would hand the same connection to two threads at once,
    /// which `SQLITE_OPEN_NOMUTEX` makes a data race rather than merely a
    /// surprise.
    pub fn release(self: *Pool, lease: Lease) void {
        const bit = @as(u32, 1) << lease.slot;
        const prev = self.free.fetchOr(bit, .release);
        std.debug.assert(prev & bit == 0); // released a slot that was already free
    }

    /// Readers not currently borrowed. Diagnostics and tests only: by the time a
    /// caller reads it the answer may already be stale, which is why `acquire`
    /// claims rather than checks.
    pub fn available(self: *const Pool) usize {
        return @popCount(self.free.load(.monotonic));
    }
};

// ---- tests ----

const testing = std.testing;
const schema = @import("schema.zig");

/// A migrated database FILE (not `:memory:` — a second connection to an in-memory
/// database opens a different, empty one) plus a pool over it. Returns the path
/// so a test can open more connections against the same file.
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

    // The read half: a reader sees what the writer committed.
    var r = (try lease.db.row("SELECT email FROM users WHERE id = 1;", &.{})).?;
    defer r.finalize();
    try testing.expectEqualStrings("a@h", r.text(0));

    // The write half, which is the whole safety argument: SQLite refuses, loudly.
    // A route wrongly marked `read_only` therefore fails its first write instead
    // of corrupting anything, and the route audit in `test/reader_pool.zig` is
    // what turns that into a red test rather than a 500 in production.
    const saved = sqlite.log_exec_errors;
    sqlite.log_exec_errors = false; // the diagnostic would fail this very test
    defer sqlite.log_exec_errors = saved;
    try testing.expectError(error.Exec, lease.db.exec("UPDATE users SET email = 'b@h' WHERE id = 1;"));
    try testing.expectError(error.Exec, lease.db.exec("INSERT INTO users(id, email, password_md5, cred_enc, is_admin, created_at) VALUES(2,'c@h','','',0,0);"));
    try testing.expectError(error.Exec, lease.db.exec("DELETE FROM users WHERE id = 1;"));

    // And the writer is untouched by any of that.
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

    // No two leases name the same slot or the same handle. This is the property
    // `SQLITE_OPEN_NOMUTEX` depends on: a connection shared by two threads at
    // once would be a data race, not a slow request.
    for (held, 0..) |a, i| for (held[i + 1 ..]) |b| {
        try testing.expect(a.slot != b.slot);
        try testing.expect(a.db.handle != b.db.handle);
    };

    // Exhaustion is NULL, immediately — not a wait and not an error. The caller
    // falls back to the writer under `db_lock`, i.e. to exactly the behaviour
    // this pool replaced.
    for (0..10) |_| try testing.expect(pool.acquire() == null);
    try testing.expectEqual(@as(usize, 0), pool.available());

    // Returning one admits exactly one.
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
    // VERIFIED, not assumed. `SQLITE_OPEN_READONLY` refuses writes to the
    // DATABASE; the per-connection `temp` schema is a different store and stays
    // writable — which is why `sqlite.WriteWatch` scopes its audit to `main` and
    // not to every attachment, and why a read that needs to see a string exactly
    // as the index saw its own text (`temp.token_fold`, `search/fuzzy.zig`) can
    // run on a pooled reader at all.
    //
    // No route folds on a reader today: the reads that did went into the browser
    // with §6 step 7. The property is pinned anyway, because
    // the audit above is written in terms of it.
    const f = try Fixture.init();
    defer f.deinit();
    var pool = try Pool.open(testing.allocator, f.path, 1);
    defer pool.close(testing.allocator);
    const lease = pool.acquire().?;
    defer pool.release(lease);

    // Deliberately a plain fts5 table rather than `fuzzy.fold_ddl`'s: what is
    // under test is that `temp` is WRITABLE on a read-only connection, and
    // `db/` cannot import `services/` to borrow the real declaration anyway.
    try lease.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold USING fts5(t);");
    try lease.db.exec("DELETE FROM temp.token_fold;");
    try lease.db.exec("INSERT INTO temp.token_fold(rowid, t) VALUES(1, 'caligrafia');");
    var r = (try lease.db.row("SELECT t FROM temp.token_fold WHERE rowid = 1;", &.{})).?;
    defer r.finalize();
    try testing.expectEqualStrings("caligrafia", r.text(0));

    // And the main database is still refused, so this is a property of `temp` and
    // not of the connection having been opened writable by accident.
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
    // The bitmask claim is a CAS, and a CAS is exactly the thing that looks right
    // single-threaded and is wrong under contention. Real threads, because the
    // server borrows from one per connection.
    const f = try Fixture.init();
    defer f.deinit();
    try f.writer.exec("INSERT INTO users(id, email, password_md5, cred_enc, is_admin, created_at) VALUES(1,'a@h','','',1,0);");

    var pool = try Pool.open(testing.allocator, f.path, 3);
    defer pool.close(testing.allocator);

    const Worker = struct {
        pool: *Pool,
        /// Per-slot "somebody is holding this" flags. A second holder of the same
        /// slot would see it already set — the failure this test exists for.
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
                // Touch the connection, so a double lend is a real concurrent use
                // of one handle rather than only a bookkeeping error.
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
    // Balance: every borrow was returned, so the pool is whole again. A leaked
    // slot is the failure that eventually starves the pool into permanent
    // fallback while the server looks healthy.
    try testing.expectEqual(@as(usize, 3), pool.available());
    // Six threads against three readers must have found it empty sometimes —
    // otherwise this ran the fallback path zero times and proved less than it
    // looks. (Not an equality: how often is a scheduling detail.)
    try testing.expect(fallbacks.load(.monotonic) > 0);
}
