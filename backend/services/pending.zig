//! How many of a user's documents are still being indexed: the deferred
//! worker's own tenant clauses (`deferred.tenants`), counted over distinct
//! blobs. Never a maintained counter, so it cannot drift from the worker.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const deferred = @import("deferred.zig");
const noteindex = @import("note_index.zig");

/// One `UNION` so blobs dedupe across tenants, scoped to one owner so SQLite
/// seeks `files_user_parent` rather than walking `files_md5` (27 vs 95 ms on
/// the Pi). A plan pin keeps it that way.
fn countSql() []const u8 {
    comptime {
        var sql: []const u8 = "SELECT COUNT(*) FROM (\n";
        for (&deferred.tenants, 0..) |*t, i| {
            if (i != 0) sql = sql ++ "\n UNION\n";
            // The only thing a reader may add to a tenant's clause.
            sql = sql ++ "SELECT f.md5\n" ++ t.from_where ++ "\n   AND f.user_id = ?2";
        }
        return sql ++ "\n);";
    }
}

/// `?1` the note index version, `?2` the owner.
pub const count_sql = countSql();

/// A tenant's clause with `?1` (the note index version) spelt as a constant,
/// for embedding in a larger statement without renumbering its parameters.
fn spellVersion(comptime clause: []const u8) []const u8 {
    comptime {
        const version = std.fmt.comptimePrint("{d}", .{noteindex.index_version});
        var out: []const u8 = "";
        var rest = clause;
        while (std.mem.indexOf(u8, rest, "?1")) |at| {
            out = out ++ rest[0..at] ++ version;
            rest = rest[at + 2 ..];
        }
        return out ++ rest;
    }
}

/// SQL boolean: does any tenant still owe derive work for row `alias`? Lets the
/// search manifest tell "derived and empty" from "not yet derived". Has no bound
/// parameter of its own. `alias` must not be `f` (the tenants' own alias): that
/// silently yields `f.md5 = f.md5`, so it is refused at comptime.
pub fn owesDerive(comptime alias: []const u8) []const u8 {
    comptime {
        if (std.mem.eql(u8, alias, "f")) @compileError(
            "pending.owesDerive: the alias must not be `f` — every tenant's clause " ++
                "binds `f` to its own `files` row, so `AND f.md5 = f.md5` would be a " ++
                "tautology and every document would report pending. Alias the outer row " ++
                "something else.",
        );
        var sql: []const u8 = "(";
        for (&deferred.tenants, 0..) |*t, i| {
            if (i != 0) sql = sql ++ " OR ";
            // `OR` short-circuits on the first tenant that owes work.
            sql = sql ++ "EXISTS (SELECT 1\n" ++ spellVersion(t.from_where) ++
                "\n   AND f.md5 = " ++ alias ++ ".md5)";
        }
        return sql ++ ")";
    }
}

/// ~27 ms on the Pi: too much for a timer. See `Pulse`.
pub fn countFor(db: sqlite.Db, user_id: u64) !i64 {
    var r = (try db.row(count_sql, &.{
        .{ .int = noteindex.index_version },
        .{ .int = @intCast(user_id) },
    })) orelse return 0;
    defer r.finalize();
    return r.int(0);
}

/// Owners remembered at once; matches `event_streams.max_slots`. Past it the
/// oldest is dropped and recounted on its next tick.
pub const max_owners: usize = 32;

/// Backstop age for a count with no change signal. Only `Files.putFile` calls
/// `Worker.signal`, so trash, restore and purge are noticed here (≤ 30 s).
pub const default_max_age_ms: i64 = deferred.idle_tick_ns / std.time.ns_per_ms;

pub const Snapshot = struct {
    pending: i64,
    /// Moves when the worker finishes a job: "the index changed, re-sync".
    version: i64,
};

/// The shared count, recomputed on change rather than per poll: when
/// `Worker.epoch` (work created) or `Worker.done` (work finished) moves, or the
/// backstop expires. Signals decide when to ask, never the answer. `mutex` is
/// held across the recount (and its `db_lock`); nothing takes them the other way.
pub const Pulse = struct {
    db: sqlite.Db,
    /// Taken around the count only. Null in single-threaded tests.
    db_lock: ?*std.Io.Mutex = null,
    io: std.Io,
    /// Change signals and `Snapshot.version`. Null leaves only the backstop.
    worker: ?*deferred.Worker = null,

    /// A field so a test can force a recount.
    max_age_ms: i64 = default_max_age_ms,

    mutex: std.Io.Mutex = .init,

    taken_at: ?std.Io.Timestamp = null,
    seen_epoch: u32 = 0,
    seen_done: usize = 0,
    owners: [max_owners]Owner = @splat(.{}),
    len: usize = 0,

    /// Counts actually run; for tests.
    counts: usize = 0,

    pub const Owner = struct { user_id: u64 = 0, pending: i64 = 0 };

    /// A failed count answers 0 for the tick; it is only a UI hint.
    pub fn forUser(self: *Pulse, user_id: u64) Snapshot {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        if (self.changed()) self.forget();

        for (self.owners[0..self.len]) |o| {
            if (o.user_id == user_id) return .{ .pending = o.pending, .version = self.version() };
        }

        const pending = self.count(user_id);
        if (self.len == max_owners) {
            std.mem.copyForwards(Owner, self.owners[0 .. max_owners - 1], self.owners[1..]);
            self.len -= 1;
        }
        self.owners[self.len] = .{ .user_id = user_id, .pending = pending };
        self.len += 1;
        return .{ .pending = pending, .version = self.version() };
    }

    /// Jobs completed in this process; restart-relative. A trash or purge leaving
    /// `pending` moves the count, not this.
    fn version(self: *Pulse) i64 {
        const w = self.worker orelse return 0;
        return @intCast(w.done.load(.acquire));
    }

    /// Caller holds `mutex`.
    fn changed(self: *Pulse) bool {
        const t0 = self.taken_at orelse return true;
        const age_ns = t0.untilNow(self.io, .awake).toNanoseconds();
        if (age_ns < 0 or age_ns >= self.max_age_ms * std.time.ns_per_ms) return true;
        const w = self.worker orelse return false;
        return w.epoch.load(.acquire) != self.seen_epoch or w.done.load(.acquire) != self.seen_done;
    }

    /// Caller holds `mutex`.
    fn forget(self: *Pulse) void {
        self.len = 0;
        self.taken_at = std.Io.Clock.awake.now(self.io);
        if (self.worker) |w| {
            self.seen_epoch = w.epoch.load(.acquire);
            self.seen_done = w.done.load(.acquire);
        }
    }

    /// Under `db_lock` only. Caller holds `mutex`.
    fn count(self: *Pulse, user_id: u64) i64 {
        if (self.db_lock) |l| l.lockUncancelable(self.io);
        defer if (self.db_lock) |l| l.unlock(self.io);
        self.counts += 1;
        return countFor(self.db, user_id) catch |e| {
            std.log.warn("pending: count failed for user {d}: {t}", .{ user_id, e });
            return 0;
        };
    }
};

test {
    _ = @import("pending_test.zig");
}

// ---- tests of private helpers ----

const testing = std.testing;
const fixture = @import("pending_test_fixture.zig");
const owes_derive_d = fixture.owes_derive_d;

const spelt_clauses = blk: {
    var out: [deferred.tenants.len][]const u8 = undefined;
    for (&deferred.tenants, 0..) |*t, i| out[i] = spellVersion(t.from_where);
    break :blk out;
};

test "`owesDerive` is the tenants' own clause and names EVERY tenant, with no second copy" {
    const expr = owes_derive_d;
    try testing.expectEqual(deferred.tenants.len, spelt_clauses.len);
    for (spelt_clauses) |clause| {
        try testing.expect(std.mem.indexOf(u8, expr, clause) != null);
    }
    try testing.expect(std.mem.indexOf(u8, expr, "?") == null);
    const versioned = std.fmt.comptimePrint("ni.index_version = {d}", .{noteindex.index_version});
    try testing.expect(std.mem.indexOf(u8, expr, versioned) != null);
}
