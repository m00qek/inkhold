//! How many of a user's documents are still being indexed — the COUNT half of
//! `services/deferred.zig`'s question.
//!
//! ## Why this is a count and not a queue length
//!
//! The deferred worker's job store is *"a query, not a queue"*. Pending-ness is
//! that same clause counted instead of `LIMIT 1`-ed, and deliberately NOT a
//! counter the worker maintains: a counter is a SECOND OPINION about what the
//! worker owes, free to drift from what it actually does.
//!
//! So every statement here is built at comptime from `deferred.tenants`'
//! `from_where` clauses. Adding a tenant adds it to this count with no edit
//! here.
//!
//! ## What it counts: DISTINCT BLOBS, scoped to one owner
//!
//! The only thing added to a tenant's clause is `f.user_id = ?` — the `files`
//! VISIBILITY predicates (`deleted = 0`, `is_folder = 0`, `md5 IS NOT NULL`) are
//! already inside it and are deliberately not restated. A reader may only ADD a
//! bound, never narrow or restate what is already there.
//!
//! `UNION` rather than `UNION ALL`, and the select list is the BLOB: one PDF
//! owing both a probe and its text is ONE document still being indexed, and a
//! user holding one blob under two names is one derive rather than two.
//!
//! ## Two things it does NOT count, both named because they look like bugs
//!
//!   - **A `.note` a CURRENT index has looked at.** The note half is indexed
//!     inside the upload transaction, so an upload owes nothing. The one
//!     exception: a note whose page rows predate `has_ink` DOES owe the `ink`
//!     tenant a scan, and is counted until it heals — a strictly transient set.
//!   - **A blob whose `note_index` row is stale.** Every tenant's clause
//!     requires a CURRENT row, because the note half heals first and its heal
//!     rewrites what the tenant writes into. Such a blob is not offered to the
//!     worker either, so the count AGREES WITH THE WORKER — which is the whole
//!     property this module exists to keep.
//!
//! ## The cost constraint, and what it MEASURED (§5)
//!
//! The live channel polls every 500 ms and its loop is PER CONNECTED CLIENT, so
//! a naive recount inside it is *(clients × tenants)* aggregate queries per
//! second, for ever, on one core.
//!
//! **MEASURED on the Pi 1 B+**, a 1,275-file corpus, 336 files for the owner
//! under test, warm cache:
//!
//! | statement | p50 | p95 |
//! |---|---:|---:|
//! | this count, one owner | **27.25 ms** | 29.55 ms |
//! | search's `coverage_sql`, which it rode beside (since deleted) | 72.4 ms | 86.2 ms |
//! | `files.syncVersion`, the SSE tick's existing cost | 0.42 ms | 1.10 ms |
//!
//! So the count is 65x what one poll tick costs — far too much to pay 2/s per
//! owner for ever (5.5 % of the single core, and a 27 ms `db_lock` window twice
//! a second competing with device sync). `Pulse` below is therefore gated on
//! CHANGE rather than on the clock.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const deferred = @import("deferred.zig");
const noteindex = @import("note_index.zig");

/// ONE STATEMENT, not one per tenant, because the answer is over DISTINCT BLOBS
/// and a blob can only be deduplicated inside a single `UNION`.
///
/// **SCOPED TO ONE OWNER, and that is the load-bearing choice.** One grouped
/// statement answering every owner at once was written and MEASURED on the Pi
/// first: **95.0 ms p50** against **27.3 ms** for this one. It has to reach
/// `files` by `files_md5` (there is no owner to seek on), which turns every row
/// into a random page fetch across the whole install. Scoped, SQLite seeks
/// `files_user_parent (user_id=?)` and the work is bounded by the CALLER's
/// library. The plan pin in this file's tests keeps it that way.
fn countSql() []const u8 {
    comptime {
        var sql: []const u8 = "SELECT COUNT(*) FROM (\n";
        for (&deferred.tenants, 0..) |*t, i| {
            if (i != 0) sql = sql ++ "\n UNION\n";
            // The ONLY thing added to a tenant's clause — see the header.
            sql = sql ++ "SELECT f.md5\n" ++ t.from_where ++ "\n   AND f.user_id = ?2";
        }
        return sql ++ "\n);";
    }
}

/// `?1` the note index version, `?2` the owner.
pub const count_sql = countSql();

/// A tenant's clause with its ONE bound parameter — `?1`, the note index
/// version — spelt out as the constant it always is.
///
/// `?1` is only a parameter because the worker and the count are prepared
/// statements with a natural place to bind it. A caller embedding this clause
/// inside a LARGER statement has no such place: it would have to renumber every
/// other parameter around it. The predicate's MEANING is untouched.
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

/// **Pending-ness PER BLOB, as a SQL boolean** — true when any tenant still owes
/// derive work for the `files` row aliased `alias`. The COUNT says how many
/// documents are outstanding; this says whether THIS one is. Same generator, so
/// two granularities of one source of truth.
///
/// The consumer is `search/index_export.zig`'s manifest, whose `Derivation`
/// column decides whether a browser may cache an empty term set for ever: a
/// derived-and-empty blob and a not-yet-derived blob look identical on the wire,
/// and a client that caches the second one's emptiness loses that document
/// permanently. This is the fact that separates them.
///
/// **NO BOUND PARAMETER OF ITS OWN** (`spellVersion`). An expression that grew a
/// `?` would change the CALL SHAPE of every statement embedding it — the
/// manifest binds `?1 = user_id` and nothing else — and a consumer that got the
/// numbering wrong would silently compare the version against a user id.
///
/// **`alias` MUST NOT be `f`.** Every tenant's clause is `FROM files f JOIN ...`,
/// so inside the `EXISTS` the name `f` is the tenant's OWN row. A caller whose
/// outer row is also `f` would generate `AND f.md5 = f.md5` — a tautology
/// reading as "every document is pending", forever, with every test that only
/// checks *some* row is pending still green. It is the one way to misuse this
/// that produces no error and no symptom, so it is refused at comptime.
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
            // ONE ADDED BOUND, which is all `Tenant.from_where` permits. `OR`
            // rather than `UNION` because the answer is a boolean and `OR`
            // short-circuits — the first tenant that owes work ends the row.
            sql = sql ++ "EXISTS (SELECT 1\n" ++ spellVersion(t.from_where) ++
                "\n   AND f.md5 = " ++ alias ++ ".md5)";
        }
        return sql ++ ")";
    }
}

/// MEASURED at 27.25 ms p50 on the deployment target against a 336-file
/// library — far too much to run on a timer. See `Pulse` for when it is run.
pub fn countFor(db: sqlite.Db, user_id: u64) !i64 {
    var r = (try db.row(count_sql, &.{
        .{ .int = noteindex.index_version },
        .{ .int = @intCast(user_id) },
    })) orelse return 0;
    defer r.finalize();
    return r.int(0);
}

/// How many owners' counts are remembered at once. A household is one or two;
/// the cap matches `event_streams.max_slots`, which is the most distinct users
/// who can hold a live channel at the same time, so the table can never be the
/// binding constraint. Past it the oldest entry is dropped and recounted on that
/// owner's next tick — a cost, never a wrong number.
pub const max_owners: usize = 32;

/// How long a count may stand with no signal saying it changed.
///
/// THE BACKSTOP, and deliberately the deferred worker's own idle tick: it exists
/// for exactly the same class of event — work that finished or appeared by a
/// path that did not signal. `Files.putFile` is the ONLY caller of
/// `Worker.signal`, so every other way the count moves lands here: a trash, a
/// restore and a purge are three writes the worker never hears about. Slow to
/// react (up to 30 s) and never wrong for longer than that.
pub const default_max_age_ms: i64 = deferred.idle_tick_ns / std.time.ns_per_ms;

/// What one poll of the live channel needs to know about the index.
pub const Snapshot = struct {
    /// Documents of the caller's with derive work outstanding.
    pending: i64,
    /// Moves when the deferred worker finishes a job — the "the index changed,
    /// re-sync" signal for a client that keeps its own copy.
    version: i64,
};

/// The shared answer to "what is still outstanding", recomputed on CHANGE rather
/// than on the clock.
///
/// **WHY NOT SIMPLY A 500 ms CACHE.** A shared window removes the per-client
/// multiplier, and MEASURED that is still not enough: 27.25 ms twice a second is
/// 5.5 % of the single core and a 27 ms `db_lock` window 2/s competing with
/// device sync, permanently, on a server where nothing changes for hours.
///
/// So the count is recomputed when something says it may have changed. Two
/// signals, both already there and free to read: **`Worker.epoch`** (bumped by
/// the ingest path — work may have been CREATED) and **`Worker.done`** (bumped
/// per completed job — work FINISHED). Plus `max_age_ms` as the backstop. Idle,
/// that is one 27 ms query per 30 s (0.09 % of the core).
///
/// **THE SIGNALS DECIDE WHEN TO ASK, NEVER WHAT THE ANSWER IS** — that is what
/// separates this from the dirty counter the header forbids. Every answer is a
/// fresh count over the tenants' own predicate, so a missed signal costs latency
/// (bounded by the backstop) and a spurious one costs a query. Neither can make
/// the number wrong.
///
/// `mutex` is held ACROSS the recount, including the `db_lock` window inside it.
/// Not a lock-order hazard — nothing takes `db_lock` and then this — and it buys
/// ONE query rather than N when a burst of streams ticks together.
pub const Pulse = struct {
    db: sqlite.Db,
    /// The global DB lock. Taken around the count and released immediately — the
    /// same narrow-bracket discipline the events handler follows for its own
    /// `syncVersion` read. Null in the single-threaded tests.
    db_lock: ?*std.Io.Mutex = null,
    io: std.Io,
    /// Both change signals AND the source of `Snapshot.version`. Null (tests, a
    /// server with no worker) leaves only the backstop driving recounts.
    worker: ?*deferred.Worker = null,

    /// See `default_max_age_ms`. A field so a test can force a recount.
    max_age_ms: i64 = default_max_age_ms,

    mutex: std.Io.Mutex = .init,

    /// When the remembered counts were taken. Null = nothing remembered.
    taken_at: ?std.Io.Timestamp = null,
    seen_epoch: u32 = 0,
    seen_done: usize = 0,
    owners: [max_owners]Owner = @splat(.{}),
    len: usize = 0,

    /// Counts actually run. The observable that makes "not once per connected
    /// client" a driven claim; nothing in the server reads it.
    counts: usize = 0,

    pub const Owner = struct { user_id: u64 = 0, pending: i64 = 0 };

    /// Counts only when a signal moved or the remembered answer is older than
    /// `max_age_ms`. A failed count answers 0 for that tick rather than holding
    /// the connection — it is a UI hint, and the next tick asks again.
    pub fn forUser(self: *Pulse, user_id: u64) Snapshot {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        if (self.changed()) self.forget();

        for (self.owners[0..self.len]) |o| {
            if (o.user_id == user_id) return .{ .pending = o.pending, .version = self.version() };
        }

        const pending = self.count(user_id);
        // Oldest out when full: remembering the wrong owner costs a count on the
        // next tick, remembering nothing would cost one on EVERY tick.
        if (self.len == max_owners) {
            std.mem.copyForwards(Owner, self.owners[0 .. max_owners - 1], self.owners[1..]);
            self.len -= 1;
        }
        self.owners[self.len] = .{ .user_id = user_id, .pending = pending };
        self.len += 1;
        return .{ .pending = pending, .version = self.version() };
    }

    /// Jobs the deferred worker has completed in this process.
    ///
    /// WHAT IT DOES NOT OBSERVE is a document that leaves `pending` by ceasing
    /// to be one — a trash, or a purge. That disappearance IS observed by the
    /// count beside it, which is a fresh query rather than a counter, so a
    /// client watching for "something changed" is told; only the version number
    /// stays put. Restart-relative and not persisted, which is right for a live
    /// channel that reconnects and re-reads, and wrong for anything that tries
    /// to store it across a reboot.
    fn version(self: *Pulse) i64 {
        const w = self.worker orelse return 0;
        return @intCast(w.done.load(.acquire));
    }

    /// Has anything happened that could move a count? Caller holds `mutex`.
    fn changed(self: *Pulse) bool {
        const t0 = self.taken_at orelse return true;
        const age_ns = t0.untilNow(self.io, .awake).toNanoseconds();
        if (age_ns < 0 or age_ns >= self.max_age_ms * std.time.ns_per_ms) return true;
        const w = self.worker orelse return false;
        return w.epoch.load(.acquire) != self.seen_epoch or w.done.load(.acquire) != self.seen_done;
    }

    /// Drop every remembered count and re-arm the signals. Caller holds `mutex`.
    fn forget(self: *Pulse) void {
        self.len = 0;
        self.taken_at = std.Io.Clock.awake.now(self.io);
        if (self.worker) |w| {
            self.seen_epoch = w.epoch.load(.acquire);
            self.seen_done = w.done.load(.acquire);
        }
    }

    /// One owner's count, under `db_lock` and nothing else. Caller holds `mutex`.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const txtindex = @import("txt_index.zig");

/// The same shape `deferred.zig`'s fixture has, with TWO users: half of what
/// this module has to get right is that one person's outstanding work is not
/// another's.
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

/// `owesDerive` for a document row aliased `d` — the shape `index_export.zig`'s
/// manifest embeds, and the only shape the tests below ever ask it in.
const owes_derive_d = owesDerive("d");

/// Every tenant's clause with `?1` spelt out — what `owesDerive` must be found
/// to contain, verbatim.
const spelt_clauses = blk: {
    var out: [deferred.tenants.len][]const u8 = undefined;
    for (&deferred.tenants, 0..) |*t, i| out[i] = spellVersion(t.from_where);
    break :blk out;
};

const two_paragraphs = "First paragraph, with words in it.\n\nSecond paragraph, also with words.\n";
const rotate90_pdf = @embedFile("../pdf/testdata/rotate90.pdf");
/// A real two-page capture — the only fixture here the note parser accepts, and
/// therefore the only one the `ink` tenant will look at.
const sample2_note = @embedFile("sample-2.note");

test "a just-uploaded .txt is reported pending, and stops being pending when the worker finishes" {
    // Until this is true, an upload whose derive has been moved off the
    // connection returns "No matches" for itself and says nothing about why.
    var f = try Fixture.init();
    defer f.deinit();

    try testing.expectEqual(@as(i64, 0), try f.pending(1));
    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), try f.pending(1));

    f.drain();
    try testing.expectEqual(@as(i64, 0), try f.pending(1));
}

test "an UPLOADED .note is not pending; one whose pages predate `has_ink` is, until it heals" {
    // A fresh upload owes nothing (the note half derives inside the upload
    // transaction), but a note indexed before `has_ink` existed owes the `ink`
    // tenant a scan. Both halves are here because the first is what stops the
    // count reporting every note in the library for ever.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "notes.note", sample2_note);
    try testing.expectEqual(@as(i64, 0), try f.pending(1));

    // The state a database migrated from schema v15 is in.
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
    // And it is the same document the per-blob question names.
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
    // The drift the module header exists to prevent, DRIVEN: whenever the
    // worker has something to offer the count is non-zero, and when it has
    // nothing the count is zero.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    _ = try f.put(1, "doc.pdf", rotate90_pdf);

    // Both outstanding, both tenants represented.
    try testing.expectEqual(@as(i64, 2), try f.pending(1));

    // And every intermediate state agrees too: drain one job at a time and the
    // count must never disagree with whether a job exists.
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

    // A user who does not exist is not everybody.
    try testing.expectEqual(@as(i64, 0), try f.pending(99));
}

test "a trashed .txt is not pending — the bin is not a work queue, here as in the worker" {
    // Proves the count did not restate the `files` visibility predicates
    // differently from the tenant's clause: same file, deleted and restored.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");
    try testing.expectEqual(@as(i64, 0), try f.pending(1));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
}

test "ONE PDF owing two questions is ONE pending document, and two holders of one blob are too" {
    // The unit is a blob's outstanding WORK, not the number of questions asked
    // about it and not the number of `files` rows pointing at it.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "doc.pdf", rotate90_pdf);
    var r = std.Io.Reader.fixed(rotate90_pdf);
    const dup = try f.files.putFile(1, null, "copy.pdf", &r, null);
    defer testing.allocator.free(dup.name);
    defer if (dup.md5) |m| testing.allocator.free(m);
    try testing.expectEqualStrings(&md5, dup.md5.?[0..32]); // really the same blob

    // Two files, one blob, two outstanding questions (probe then text): one
    // document being indexed.
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
}

test "pending and unsearchable are different numbers, and a note with no recognised text is never pending" {
    // `Coverage.unsearchable` is PERMANENT — a note whose OCR is absent — and
    // pending is TRANSIENT. Merging them would tell somebody their new upload
    // is permanently unsearchable.
    var f = try Fixture.init();
    defer f.deinit();

    // A file the note indexer parses but that carries no recognised text.
    _ = try f.put(1, "ink.note", &.{ 0x6e, 0x6f, 0x74, 0x65, 0x00 });
    f.drain();
    try testing.expectEqual(@as(i64, 0), try f.pending(1));

    // …while a `.txt` beside it IS pending until the worker runs.
    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
}

test "the pending count is computed once per poll, not once per connected client" {
    // Two owners × twelve ticks is twenty-four calls and must cost TWO queries
    // — one per owner, not one per call — as long as nothing says it moved.
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
    // A remembered count that no signal could dislodge would leave "1 document
    // still being indexed" on screen for ever; a count the worker MAINTAINED
    // would be the second source of truth the header forbids.
    var f = try Fixture.init();
    defer f.deinit();

    var w: deferred.Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
    };
    f.files.deferred = &w; // so the ingest path signals, as it does in the server
    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io, .worker = &w };

    try testing.expectEqual(@as(i64, 0), pulse.forUser(1).pending);
    const after_first = pulse.counts;

    // WORK CREATED: the ingest path signalled, so the next tick asks again.
    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
    try testing.expect(pulse.counts > after_first);
    const after_upload = pulse.counts;

    // …and settles: with nothing new signalled, further ticks are free.
    for (0..8) |_| try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
    try testing.expectEqual(after_upload, pulse.counts);

    // WORK FINISHED: `done` moved, so the stale 1 must not survive it.
    w.drain();
    try testing.expectEqual(@as(i64, 0), pulse.forUser(1).pending);
    try testing.expect(pulse.counts > after_upload);
}

test "the backstop makes a count expire even when nothing signalled" {
    // A `Pulse` with no worker wired sees NEITHER signal — the shape of every
    // change `Files.putFile` does not make: a trash, a restore, a purge.
    // Without the backstop the failure mode is the worst one this feature has:
    // "still indexing" on screen permanently, over a fully indexed library.
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put(1, "notes.txt", two_paragraphs);

    // No worker at all, so ONLY the backstop can dislodge the answer.
    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io, .max_age_ms = 60_000 };
    try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
    f.drain();
    try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending); // still inside the window

    pulse.max_age_ms = 0; // the window closes
    try testing.expectEqual(@as(i64, 0), pulse.forUser(1).pending);
}

test "the version moves when the worker finishes a job and not when a file is renamed" {
    // What the `event: index` frame's `version` promises a client keeping its
    // own index: "a derive landed, re-sync". A rename is not a derive.
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
    // MEASURED: the same count written to answer every owner at once cannot
    // seek on an owner, falls back to walking `files_md5`, and costs **95.0 ms
    // p50 on the Pi against 27.25 ms** for this shape. So the load-bearing fact
    // is that `files` is reached by `files_user_parent (user_id=?)`: the scan is
    // over the CALLER's library, not the install's.
    //
    // NOT stated as `INDEXED BY`. `f.user_id = ?2` IS an equality on that
    // index's first column and the planner picks it unaided on an empty test
    // database and on the 1,275-file corpus alike. A pin catches a rewrite that
    // loses it; a directive would also forbid a better index nobody needs yet.
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
        // NOTHING is scanned but the compound's own result. A `SCAN f` here is
        // the whole install per tick instead of one library.
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN f") == null);
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN ni") == null);
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN b") == null);
    }
    // Once per tenant, each: the compound has one arm per tenant and no arm may
    // reach a table by any other path.
    try testing.expectEqual(deferred.tenants.len, by_owner);
    try testing.expectEqual(deferred.tenants.len, ni_by_pk);
    try testing.expectEqual(deferred.tenants.len, blobs_by_pk);
}

test "`owesDerive` is the tenants' own clause and names EVERY tenant, with no second copy" {
    // The structural half of the no-drift argument: the generated expression
    // must literally CONTAIN each tenant's predicate. A hand-written "is this
    // blob derived yet" fails here before any fixture is built, and so does a
    // tenant added to `deferred.tenants` that this never learns about.
    const expr = owes_derive_d;
    try testing.expectEqual(deferred.tenants.len, spelt_clauses.len);
    for (spelt_clauses) |clause| {
        try testing.expect(std.mem.indexOf(u8, expr, clause) != null);
    }
    // And no parameter of its own. A `?` here would silently renumber the binds
    // of whatever statement embeds it — the manifest binds `?1 = user_id`, so a
    // stray `?1` would compare the note index version against a user id.
    try testing.expect(std.mem.indexOf(u8, expr, "?") == null);
    // The version really is spelt, not dropped: an expression that lost the
    // `index_version` test would report a blob pending across a version bump for
    // ever, because the note half has not healed yet. Built from the CONSTANT,
    // so a bump does not turn a shape test red.
    const versioned = std.fmt.comptimePrint("ni.index_version = {d}", .{noteindex.index_version});
    try testing.expect(std.mem.indexOf(u8, expr, versioned) != null);
}

test "`owesDerive` is valid SQL against the real schema, and answers per blob" {
    // Asserted through a statement shaped like the manifest's — an outer `files`
    // row aliased something other than `f` — because that is the only shape it
    // is ever used in, and the alias collision is the one way to misuse it that
    // produces no error (see its doc comment).
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
        // Prepares, and every row answers 0 or 1 rather than NULL — the manifest
        // reads a NULL as `Derivation.unknown`, so a NULL here would quietly
        // reinstate the seam this expression exists to close.
        var s = try f.db.prepare(sql);
        defer s.finalize();
        s.bindInt(1, 1);
        var rows: usize = 0;
        while (try s.step()) : (rows += 1) try testing.expect(!s.columnIsNull(1));
        try testing.expectEqual(@as(usize, 2), rows);
    }

    try testing.expect(try ask(f.db, "notes.txt"));
    // A `.note` is indexed inside the upload transaction: nothing is OWED.
    try testing.expect(!try ask(f.db, "ink.note"));

    f.drain();
    try testing.expect(!try ask(f.db, "notes.txt"));
}

test "the count and `owesDerive` are the same question asked two ways" {
    // Summing the per-blob answer over the caller's DISTINCT blobs must be the
    // count. If they disagreed, a user would be told "1 document still being
    // indexed" while the manifest reported every one derived — and the client
    // would cache a false empty for the one that was not.
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
    // The thing that can break is the GENERATOR: a tenant added to
    // `deferred.tenants` that this never learns about would silently stop being
    // counted while the worker kept doing it.
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    const s = try db.prepare(count_sql);
    s.finalize();
    for (&deferred.tenants) |*t| {
        try testing.expect(std.mem.indexOf(u8, count_sql, t.from_where) != null);
    }
}
