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

// ---- tests ----

const testing = std.testing;
const schema = @import("../db/schema.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const txtindex = @import("txt_index.zig");

/// Two users: one person's outstanding work must not be another's.
const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    lock: std.Io.Mutex = .init,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        for ([_]u8{ 1, 2 }) |id| {
            var s = try db.prepare(
                "INSERT INTO users(id, email, password_md5, created_at) VALUES(?1, 'a' || ?1 || '@b.c', '0123456789abcdef0123456789abcdef', 0);",
            );
            defer s.finalize();
            s.bindInt(1, id);
            _ = try s.step();
            var c = try db.prepare("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 1000000000);");
            defer c.finalize();
            c.bindInt(1, id);
            _ = try c.step();
        }

        const tmp = testing.tmpDir(.{});
        const blobs = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{
            .db = db,
            .files = filesvc.Files.init(testing.allocator, testing.io, db, blobs, thumbs),
            .tmp = tmp,
        };
    }

    fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    fn put(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) ![32]u8 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return md5;
    }

    fn drain(f: *Fixture) void {
        deferred.drainNow(testing.allocator, f.db, f.files.blobs, &f.lock, testing.io);
    }

    fn pending(f: *Fixture, user_id: u64) !i64 {
        return countFor(f.db, user_id);
    }
};

const owes_derive_d = owesDerive("d");

const spelt_clauses = blk: {
    var out: [deferred.tenants.len][]const u8 = undefined;
    for (&deferred.tenants, 0..) |*t, i| out[i] = spellVersion(t.from_where);
    break :blk out;
};

const two_paragraphs = "First paragraph, with words in it.\n\nSecond paragraph, also with words.\n";
const rotate90_pdf = @embedFile("../pdf/testdata/rotate90.pdf");
/// A real two-page capture: the only fixture the `ink` tenant will look at.
const sample2_note = @embedFile("sample-2.note");

test "a just-uploaded .txt is reported pending, and stops being pending when the worker finishes" {
    var f = try Fixture.init();
    defer f.deinit();

    try testing.expectEqual(@as(i64, 0), try f.pending(1));
    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), try f.pending(1));

    f.drain();
    try testing.expectEqual(@as(i64, 0), try f.pending(1));
}

test "an UPLOADED .note is not pending; one whose pages predate `has_ink` is, until it heals" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "notes.note", sample2_note);
    try testing.expectEqual(@as(i64, 0), try f.pending(1));

    // The state of a database migrated from schema v15.
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
    {
        var s = try f.db.prepare("SELECT " ++ owes_derive_d ++ " FROM files d WHERE d.md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &md5);
        _ = try s.step();
        try testing.expect(s.columnInt(0) != 0);
    }

    f.drain();
    try testing.expectEqual(@as(i64, 0), try f.pending(1));
}

test "the count and `pending_sql` agree about what is outstanding" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    _ = try f.put(1, "doc.pdf", rotate90_pdf);

    try testing.expectEqual(@as(i64, 2), try f.pending(1));

    var guard: usize = 0;
    while (guard < 20) : (guard += 1) {
        const next = try deferred.nextJob(testing.allocator, f.db);
        const count = try f.pending(1);
        if (next) |found| {
            testing.allocator.free(found.name);
            try testing.expect(count > 0); // work to do, and the user is told
        } else {
            try testing.expectEqual(@as(i64, 0), count); // nothing to do, nothing claimed
            break;
        }
        f.drain();
    }
    try testing.expect(guard < 20);
}

test "one user's outstanding work is not another user's pending count" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
    try testing.expectEqual(@as(i64, 0), try f.pending(2));

    try testing.expectEqual(@as(i64, 0), try f.pending(99));
}

test "a trashed .txt is not pending — the bin is not a work queue, here as in the worker" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");
    try testing.expectEqual(@as(i64, 0), try f.pending(1));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
}

test "ONE PDF owing two questions is ONE pending document, and two holders of one blob are too" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "doc.pdf", rotate90_pdf);
    var r = std.Io.Reader.fixed(rotate90_pdf);
    const dup = try f.files.putFile(1, null, "copy.pdf", &r, null);
    defer testing.allocator.free(dup.name);
    defer if (dup.md5) |m| testing.allocator.free(m);
    try testing.expectEqualStrings(&md5, dup.md5.?[0..32]); // really the same blob

    try testing.expectEqual(@as(i64, 1), try f.pending(1));
}

test "pending and unsearchable are different numbers, and a note with no recognised text is never pending" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "ink.note", &.{ 0x6e, 0x6f, 0x74, 0x65, 0x00 });
    f.drain();
    try testing.expectEqual(@as(i64, 0), try f.pending(1));

    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
}

test "the pending count is computed once per poll, not once per connected client" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put(1, "notes.txt", two_paragraphs);

    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io };
    for (0..12) |_| {
        try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
        try testing.expectEqual(@as(i64, 0), pulse.forUser(2).pending);
    }
    try testing.expectEqual(@as(usize, 2), pulse.counts);
}

test "an upload and a finished derive each make the count ask again — the signals are WHEN, never WHAT" {
    var f = try Fixture.init();
    defer f.deinit();

    var w: deferred.Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
    };
    f.files.deferred = &w; // so the ingest path signals
    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io, .worker = &w };

    try testing.expectEqual(@as(i64, 0), pulse.forUser(1).pending);
    const after_first = pulse.counts;

    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
    try testing.expect(pulse.counts > after_first);
    const after_upload = pulse.counts;

    for (0..8) |_| try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
    try testing.expectEqual(after_upload, pulse.counts);

    w.drain();
    try testing.expectEqual(@as(i64, 0), pulse.forUser(1).pending);
    try testing.expect(pulse.counts > after_upload);
}

test "the backstop makes a count expire even when nothing signalled" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put(1, "notes.txt", two_paragraphs);

    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io, .max_age_ms = 60_000 };
    try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
    f.drain();
    try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending); // still inside the window

    pulse.max_age_ms = 0; // the window closes
    try testing.expectEqual(@as(i64, 0), pulse.forUser(1).pending);
}

test "the version moves when the worker finishes a job and not when a file is renamed" {
    var f = try Fixture.init();
    defer f.deinit();

    var w: deferred.Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
    };
    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io, .worker = &w, .max_age_ms = 0 };

    const before = pulse.forUser(1).version;
    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(before, pulse.forUser(1).version); // an upload is not a derive

    w.drain();
    const after = pulse.forUser(1).version;
    try testing.expect(after > before);

    try f.db.exec("UPDATE files SET name = 'renamed.txt' WHERE md5 IS NOT NULL;");
    try testing.expectEqual(after, pulse.forUser(1).version);
}

test "PLAN PIN: the count is bounded by the CALLER's library, and nothing is scanned" {
    // The count must reach `files` by `files_user_parent (user_id=?)`. Not forced
    // with `INDEXED BY`: the planner picks it unaided.
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put(1, "notes.txt", two_paragraphs);

    var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ count_sql);
    defer s.finalize();
    var by_owner: usize = 0;
    var ni_by_pk: usize = 0;
    var blobs_by_pk: usize = 0;
    while (try s.step()) {
        const detail = s.columnText(3);
        if (std.mem.indexOf(u8, detail, "SEARCH f ") != null and
            std.mem.indexOf(u8, detail, "files_user_parent") != null) by_owner += 1;
        if (std.mem.indexOf(u8, detail, "SEARCH ni ") != null) ni_by_pk += 1;
        if (std.mem.indexOf(u8, detail, "SEARCH b ") != null) blobs_by_pk += 1;
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN f") == null);
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN ni") == null);
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN b") == null);
    }
    try testing.expectEqual(deferred.tenants.len, by_owner);
    try testing.expectEqual(deferred.tenants.len, ni_by_pk);
    try testing.expectEqual(deferred.tenants.len, blobs_by_pk);
}

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

test "`owesDerive` is valid SQL against the real schema, and answers per blob" {
    // An outer row aliased other than `f`, as in the manifest.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    _ = try f.put(1, "ink.note", &.{ 0x6e, 0x6f, 0x74, 0x65, 0x00 });

    const sql = "SELECT d.name, " ++ owes_derive_d ++ " FROM files d WHERE d.user_id = ?1 ORDER BY d.name;";
    const ask = struct {
        fn run(db: sqlite.Db, name: []const u8) !bool {
            var s = try db.prepare("SELECT " ++ owes_derive_d ++ " FROM files d WHERE d.name = ?1;");
            defer s.finalize();
            s.bindText(1, name);
            _ = try s.step();
            return s.columnInt(0) != 0;
        }
    }.run;

    {
        // The manifest reads NULL as `Derivation.unknown`, so rows must be 0 or 1.
        var s = try f.db.prepare(sql);
        defer s.finalize();
        s.bindInt(1, 1);
        var rows: usize = 0;
        while (try s.step()) : (rows += 1) try testing.expect(!s.columnIsNull(1));
        try testing.expectEqual(@as(usize, 2), rows);
    }

    try testing.expect(try ask(f.db, "notes.txt"));
    try testing.expect(!try ask(f.db, "ink.note"));

    f.drain();
    try testing.expect(!try ask(f.db, "notes.txt"));
}

test "the count and `owesDerive` are the same question asked two ways" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    _ = try f.put(1, "doc.pdf", rotate90_pdf);
    _ = try f.put(1, "ink.note", &.{ 0x6e, 0x6f, 0x74, 0x65, 0x00 });
    _ = try f.put(2, "theirs.txt", two_paragraphs);

    const sum_sql = "SELECT COUNT(DISTINCT d.md5) FROM files d WHERE d.user_id = ?1 " ++
        "AND d.deleted = 0 AND d.is_folder = 0 AND d.md5 IS NOT NULL AND " ++ owes_derive_d;

    var guard: usize = 0;
    while (guard < 20) : (guard += 1) {
        var r = (try f.db.row(sum_sql, &.{.{ .int = 1 }})).?;
        const summed = r.int(0);
        r.finalize();
        try testing.expectEqual(try f.pending(1), summed);
        if (summed == 0) break;
        f.drain();
    }
    try testing.expect(guard < 20);
}

test "the count statement is valid SQL against the real schema, and names EVERY tenant" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    const s = try db.prepare(count_sql);
    s.finalize();
    for (&deferred.tenants) |*t| {
        try testing.expect(std.mem.indexOf(u8, count_sql, t.from_where) != null);
    }
}
