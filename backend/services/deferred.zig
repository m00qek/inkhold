//! Post-upload processing, off the connection and one file at a time.
//!
//! ## Why this exists
//!
//! Indexing ran ON THE UPLOAD PATH (`files.zig`, reached identically by web
//! upload and device sync). It is outside the transaction, but the client holds
//! the connection through all of it, and it scales with the file:
//!
//! | case | Ryzen (release) | Pi 1 B+ (x40-50) |
//! |---|---:|---:|
//! | 5 MB `.txt` | 372 ms | **15-19 s** |
//! | 16 MB `.txt` (`max_file_bytes`) | ~1.2 s | **48-60 s** |
//!
//! A minute of held connection for a file the user is allowed to upload today.
//! This is a repair for shipped behaviour, not groundwork — see
//! `docs/scratch/search-index.md`, which measured it.
//!
//! ## The job store is a QUERY, not a queue
//!
//! Nothing is enqueued. Outstanding work is DERIVABLE — a tenant names the
//! blobs it still owes work on, in SQL. That removes a second source of truth
//! that could disagree with the first, and it buys, for free:
//!
//!   - **restart safety** — nothing to persist, nothing to replay
//!   - **idempotence** — every tenant's write is an upsert
//!   - **live priority** — the ordering is re-evaluated every iteration, so a
//!     note arriving during a long job is taken next; a queue frozen at enqueue
//!     time could not do that
//!
//! It also matches the self-healing posture the index paths already have
//! (`ensureIndexed`): no backfill migration is ever required.
//!
//! ## One worker IS the serialization
//!
//! "If there is no queue, what serializes?" — a queue never serialized
//! anything. A queue with ten consumers is not serialized; one consumer with no
//! queue is. The serializer is the single worker, so there is no claiming, no
//! lease, no `status` column: those exist to stop two workers taking the same
//! row, and there is one worker, in one process, against one SQLite file.
//!
//! **This is also the memory story.** Before this, N concurrent uploads meant N
//! concurrent derives; peak RSS scaled with how many people hit save at once.
//! Now it is one file's cost, whatever the traffic — which is what has to be
//! true for the 50 MB budget on a Pi to hold once bigger formats arrive.
//!
//! ## Adding a tenant
//!
//! Write a `Tenant` and add it to `tenants`. The contract is the whole
//! interface: `pending_sql` says what is outstanding, `run` does one blob's
//! work. Nothing else in here knows what a `.txt` is.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const txtindex = @import("txt_index.zig");
const noteindex = @import("note_index.zig");
const pdfindex = @import("pdf_index.zig");
const pdfprobe = @import("../pdf/probe.zig");

const log = std.log.scoped(.deferred);

/// How long the worker sleeps when it finds nothing to do.
///
/// THE BACKSTOP, and it is why startup needs no special case: work left behind
/// by a restart, or created by a path that forgot to signal, is found by the
/// next tick rather than waiting for the next upload. Same belt-and-braces
/// reasoning as `startupSweeps`.
pub const idle_tick_ns: u64 = 30 * std.time.ns_per_s;

/// One kind of post-upload work.
///
/// A tenant is two things: a QUESTION (`pending_sql` — what do I still owe?)
/// and an ANSWER (`run` — do one blob's worth). The worker owns the thread, the
/// ordering and the lock discipline; a tenant owns its own format entirely.
pub const Tenant = struct {
    /// For logs. Not an identifier — the SQL and the function are.
    name: []const u8,

    /// Lower runs first. Ties break on blob size ascending (shortest-job-first),
    /// so fifty small files produce fifty quick wins rather than queueing behind
    /// one enormous one.
    priority: u8,

    /// Selects the blobs this tenant still owes work on, as
    /// `(md5, name, size)`, ordered however it likes — the worker only takes
    /// the first row. It MUST exclude work already done, or the worker spins on
    /// the same blob for ever.
    ///
    /// Bound parameter 1 is the note index version, because every current
    /// tenant's "is it current" question is asked against it.
    pending_sql: []const u8,

    /// Do one blob's work. Called WITHOUT the DB lock held: the tenant takes it
    /// itself, around its own transaction, after the expensive part is done.
    /// That is the rule this whole file exists to enforce — parse off the lock,
    /// write under it.
    ///
    /// Errors are logged and the blob is left outstanding; the discovery query
    /// will offer it again. A tenant that can never succeed on a given blob
    /// must record that fact itself (the way `txt_index` writes a marker row
    /// for an over-cap file), or it will be retried for ever.
    run: *const fn (Job) anyerror!void,
};

/// One unit of work, plus everything the tenant needs to do it.
pub const Job = struct {
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    /// Held for the tenant's write transaction, released immediately after.
    lock: *std.Io.Mutex,
    io: std.Io,
    /// 32 lowercase hex.
    md5: []const u8,
    /// A name the blob is known by. Any holder's name will do — the extension
    /// is the whole gate, and a blob's holders cannot disagree about it.
    name: []const u8,
    now: i64,

    /// Is this blob's `.txt` work still outstanding, asked under the lock?
    ///
    /// The discovery query already said yes, but it said so before the derive,
    /// and an upload can heal the same blob in between. Cheap — two indexed
    /// single-row selects — and it is what keeps a duplicate derive from
    /// becoming a duplicate write.
    fn check(self: Job) !bool {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        if (!try noteindex.isCurrent(self.db, self.md5)) return false;
        return txtindex.needsDerive(self.db, self.md5);
    }

    /// The same question for the `.pdf` tenant.
    fn pdfNeedsProbe(self: Job) !bool {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return pdfindex.needsProbe(self.db, self.md5);
    }
};

/// `.txt` paragraph segments (`txt_index.zig`) — the first tenant.
///
/// The SQL mirrors `txtindex.needsDerive` exactly, and the two are asserted to
/// agree in this file's tests. It is a second expression of the same predicate,
/// which is a cost; the alternative is a worker that cannot tell finished work
/// from outstanding work without calling into every tenant, which is worse.
///
/// `LIKE '%_.txt'` IS `txtindex.wants`, not an approximation: `_` is LIKE's
/// single-character wildcard, so the pattern demands at least one character
/// before the dot — which is exactly the rule that makes a bare `.txt` a
/// leading-dot name with no extension rather than a text file.
///
/// The `note_index` join is the ORDER CONTRACT (`txt_index.ensureIndexed`): the
/// note half heals first, so a blob whose row is missing or stale is not
/// offered here at all. It becomes visible on a later pass, once that row is
/// current — which the idle tick guarantees will happen.
const txt_tenant: Tenant = .{
    .name = "txt",
    .priority = 1,
    .pending_sql =
    \\SELECT f.md5, f.name, b.size
    \\  FROM files f
    \\  JOIN blobs b ON b.md5 = f.md5
    \\  JOIN note_index ni ON ni.blob_md5 = f.md5
    \\ WHERE f.is_folder = 0
    \\   AND f.deleted = 0
    \\   AND f.md5 IS NOT NULL
    \\   AND LOWER(f.name) LIKE '%_.txt'
    \\   AND ni.index_version = ?1
    \\   AND ni.indexable = 0
    \\   AND NOT EXISTS (
    \\         SELECT 1 FROM note_page_index np
    \\          WHERE np.blob_md5 = f.md5 AND np.kind = 1)
    \\ ORDER BY b.size ASC
    \\ LIMIT 1;
    ,
    .run = runTxt,
};

fn runTxt(job: Job) anyerror!void {
    // THE THREE-STEP SHAPE EVERY TENANT FOLLOWS, and the reason the lock is
    // passed in rather than taken around the whole call: the middle step is the
    // expensive one and it must not hold the connection.
    //
    // `txt_index` itself stays lock-agnostic — it knows about paragraphs, not
    // about threading — so the discipline lives here, where the threading does.

    // 1. Re-check under the lock. The discovery query said so a moment ago, but
    //    an upload may have healed it since; `needsDerive` is the authority.
    if (!try job.check()) return;

    // 2. Derive OFF the lock. Ranged reads and chunking, the part that scales
    //    with the file and the whole reason this is not on the upload path.
    var d = (try txtindex.deriveStored(job.gpa, job.blobs, job.md5)) orelse return;
    defer d.deinit();

    // 3. Write under the lock, in ONE transaction. A crash here commits nothing
    //    and the discovery query simply finds the blob again.
    job.lock.lockUncancelable(job.io);
    defer job.lock.unlock(job.io);
    if (!try txtindex.needsDerive(job.db, job.md5)) return; // raced while deriving
    try job.db.exec("BEGIN IMMEDIATE;");
    errdefer job.db.exec("ROLLBACK;") catch {};
    try txtindex.store(job.db, job.md5, d, job.now);
    try job.db.exec("COMMIT;");
}

/// A `.pdf`'s shape (`pdf_index.zig`) — page count, the page-1 box, and whether
/// the file opens at all.
///
/// AFTER `.txt` on purpose. A note or a text file is what somebody just synced
/// and is about to look for; a PDF's tile shape can wait a beat. The cost is
/// also the other way round: probing a 1,703-page document is 13.2 MB and walks
/// its page tree (`pdf-index.md` §3.1), where a text file is a scan.
const pdf_tenant: Tenant = .{
    .name = "pdf",
    .priority = 2,
    .pending_sql = pdfindex.pending_sql,
    .run = runPdf,
};

fn runPdf(job: Job) anyerror!void {
    // 1. Ask under the lock. The discovery query said so, but an upload or a
    //    heal may have answered it since.
    if (!try job.pdfNeedsProbe()) return;

    // 2. Probe OFF the lock — MuPDF walking the page tree, which is the part
    //    that scales with the document and must not hold the connection.
    const file = job.blobs.open(job.md5) catch return; // blob gone: nothing to record
    defer file.close(job.io);
    const shape: ?pdfprobe.Shape = pdfprobe.probeFile(file) catch |e| blk: {
        const v = pdfindex.Verdict.of(e) orelse return; // transient — try again later
        // A VERDICT IS A RESULT, not an error: recorded so this file is never
        // probed again. Left unrecorded, the discovery query would hand back the
        // same broken PDF for ever.
        job.lock.lockUncancelable(job.io);
        defer job.lock.unlock(job.io);
        try job.db.exec("BEGIN IMMEDIATE;");
        errdefer job.db.exec("ROLLBACK;") catch {};
        try pdfindex.storeVerdict(job.db, job.md5, v);
        try job.db.exec("COMMIT;");
        break :blk null;
    };

    // 3. Write under the lock, in one transaction.
    if (shape) |sh| {
        job.lock.lockUncancelable(job.io);
        defer job.lock.unlock(job.io);
        if (!try pdfindex.needsProbe(job.db, job.md5)) return; // raced while probing
        try job.db.exec("BEGIN IMMEDIATE;");
        errdefer job.db.exec("ROLLBACK;") catch {};
        try pdfindex.store(job.db, job.md5, sh);
        try job.db.exec("COMMIT;");
    }
}

/// Every tenant, in one named place so the SET of them can be tested rather
/// than only the individual tenants — the same reason `startupSweeps` exists.
/// A sweep that nothing calls is a sweep that silently never runs.
pub const tenants = [_]Tenant{ txt_tenant, pdf_tenant };

/// What the worker found on one pass.
pub const Found = struct {
    tenant: *const Tenant,
    md5: [32]u8,
    /// Owned by the caller's allocator.
    name: []u8,
};

/// The next outstanding job, or null when everything is current.
///
/// PRIORITY IS AN `ORDER BY`, re-evaluated here on every pass rather than fixed
/// when work was created. Tenants are asked in priority order and the first with
/// anything outstanding wins.
pub fn nextJob(gpa: std.mem.Allocator, db: sqlite.Db) !?Found {
    // Ask in priority order. `tenants` is comptime-known and tiny, so a sort
    // would be ceremony; assert the order instead (see the test below).
    for (&tenants) |*t| {
        var r = (try db.row(t.pending_sql, &.{.{ .int = noteindex.index_version }})) orelse continue;
        defer r.finalize();
        const md5_text = r.text(0);
        if (md5_text.len != 32) continue;
        var found: Found = .{ .tenant = t, .md5 = undefined, .name = undefined };
        @memcpy(&found.md5, md5_text);
        found.name = try gpa.dupe(u8, r.text(1));
        return found;
    }
    return null;
}

/// The background worker: one thread, one job at a time.
pub const Worker = struct {
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    lock: *std.Io.Mutex,
    io: std.Io,

    thread: ?std.Thread = null,

    /// Bumped by `signal`. The worker waits on THIS, with a timeout — which is
    /// why it is a bare futex word rather than an `Io.Condition`: a condition
    /// variable here has `wait` but no `timedWait`, and the timeout is not
    /// optional. It is the backstop that makes a missed signal cost latency
    /// instead of correctness.
    epoch: std.atomic.Value(u32) = .init(0),

    /// Set once, by `stop`. Checked between jobs so a shutdown lands BETWEEN
    /// two files rather than after all of them.
    stopping: std.atomic.Value(bool) = .init(false),

    /// Jobs completed. Test observability today; the natural source for a
    /// pending count in the admin console later.
    ///
    /// `usize`, NOT `u64`, and the difference is not cosmetic: a 32-bit target
    /// has no lock-free 64-bit atomic, so `Value(u64)` is a hard compile error
    /// there ("expected 32-bit integer type or smaller"). That took out all four
    /// release artifacts — including `arm-linux-musleabihf`, which IS the Pi 1
    /// this server is designed for — while every test on the 64-bit builder
    /// stayed green. A counter of completed jobs has no use for the extra range.
    done: std.atomic.Value(usize) = .init(0),

    pub fn start(self: *Worker) !void {
        self.thread = try std.Thread.spawn(.{}, loop, .{self});
    }

    /// New work may exist. Cheap, non-blocking, and safe to call while holding
    /// the DB lock — it touches nothing but an atomic and a futex.
    pub fn signal(self: *Worker) void {
        _ = self.epoch.fetchAdd(1, .release);
        self.io.futexWake(u32, &self.epoch.raw, 1);
    }

    /// Stop and JOIN — never detach.
    ///
    /// The worker writes to the database, so the process must not close the
    /// connection out from under it. That is exactly the opposite of the
    /// per-connection threads (`transport.zig`), which are detached precisely
    /// because they own nothing that outlives the request.
    pub fn stop(self: *Worker) void {
        const t = self.thread orelse return;
        self.stopping.store(true, .release);
        self.signal();
        t.join();
        self.thread = null;
    }

    fn loop(self: *Worker) void {
        while (!self.stopping.load(.acquire)) {
            // Read the epoch BEFORE draining. A signal that arrives while we are
            // working then leaves the word changed, so the wait below returns
            // immediately instead of sleeping on work that already exists.
            const seen = self.epoch.load(.acquire);
            self.drain();
            if (self.stopping.load(.acquire)) return;
            self.io.futexWaitTimeout(
                u32,
                &self.epoch.raw,
                seen,
                .{ .duration = .{ .raw = .{ .nanoseconds = idle_tick_ns }, .clock = .awake } },
            ) catch {};
        }
    }

    /// Run outstanding jobs until there are none, or until asked to stop.
    ///
    /// Re-queries between jobs rather than taking a batch: that is what makes
    /// priority live, and what lets a shutdown land between two files.
    pub fn drain(self: *Worker) void {
        // THE FORWARD-PROGRESS GUARD, and it belongs here rather than in any
        // tenant. A tenant is allowed to decline a blob — the file has vanished
        // under its `files` row, the probe hit a transient failure — and when it
        // does, it records nothing, so the discovery query hands back the SAME
        // blob on the next turn of this loop. That is not a slow loop, it is a
        // hot one: on a single-core Pi it is the whole machine.
        //
        // So a blob is offered at most once per drain. If it comes back
        // unchanged we stop and let the idle tick pace the retry, which is the
        // same posture as a failed job.
        var last: ?[32]u8 = null;
        while (!self.stopping.load(.acquire)) {
            const found = self.next() catch |e| {
                log.warn("discovery failed: {t}", .{e});
                return;
            } orelse return;
            defer self.gpa.free(found.name);

            if (last) |prev| {
                if (std.mem.eql(u8, &prev, &found.md5)) {
                    log.warn("{s} made no progress on {s}; leaving it for the next tick", .{
                        found.tenant.name, &found.md5,
                    });
                    return;
                }
            }
            last = found.md5;

            found.tenant.run(.{
                .gpa = self.gpa,
                .db = self.db,
                .blobs = self.blobs,
                .lock = self.lock,
                .io = self.io,
                .md5 = &found.md5,
                .name = found.name,
                .now = std.Io.Clock.real.now(self.io).toSeconds(),
            }) catch |e| {
                // LEFT OUTSTANDING ON PURPOSE: the discovery query will offer it
                // again. Returning rather than continuing is what stops a blob
                // that always fails from becoming a hot loop — the idle tick
                // paces the retry instead.
                log.warn("{s} job failed for {s}: {t}", .{ found.tenant.name, &found.md5, e });
                return;
            };

            _ = self.done.fetchAdd(1, .release);
        }
    }

    /// Discovery reads the shared connection, so it takes the lock like any
    /// other reader.
    fn next(self: *Worker) !?Found {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return nextJob(self.gpa, self.db);
    }
};

/// Run every outstanding job to completion, ON THIS THREAD.
///
/// The synchronous face of the worker, for callers that need the queue empty
/// before they can assert anything — every test that uploads a file and then
/// looks for what the upload used to produce inline. It runs the same discovery
/// query and the same tenants, so a test that passes here is a test of the real
/// path and not of a stub.
pub fn drainNow(
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    lock: *std.Io.Mutex,
    io: std.Io,
) void {
    var w: Worker = .{ .gpa = gpa, .db = db, .blobs = blobs, .lock = lock, .io = io };
    w.drain();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const schema = @import("../db/schema.zig");
const testing = std.testing;
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");

/// A server's worth of moving parts, minus the thread: a real database, a real
/// blob store and the real ingest path, so a test that passes here is a test of
/// the shipped code and not of a stand-in.
const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    lock: std.Io.Mutex = .init,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        var s = try db.prepare(
            "INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);",
        );
        defer s.finalize();
        _ = try s.step();
        var c = try db.prepare("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1000000000);");
        defer c.finalize();
        _ = try c.step();

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

    /// Upload, exactly as a client does. Deliberately does NOT drain — what is
    /// under test here is which side of the upload the work happens on.
    fn put(f: *Fixture, name: []const u8, bytes: []const u8) ![32]u8 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(1, null, name, &r, null);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return md5;
    }

    fn drain(f: *Fixture) void {
        drainNow(testing.allocator, f.db, f.files.blobs, &f.lock, testing.io);
    }

    fn segmentCount(f: *Fixture, md5: []const u8) !i64 {
        var r = (try f.db.row(
            "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1 AND kind = 1;",
            &.{.{ .text = md5 }},
        )).?;
        defer r.finalize();
        return r.int(0);
    }
};

const two_paragraphs = "First paragraph, with words in it.\n\nSecond paragraph, also with words.\n";

test "an upload does NOT index the .txt, and a drain does" {
    // The whole point. `putFile` used to chunk the file while the client held
    // the connection — 15-19 s for 5 MB on the deployment target.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    try std.testing.expectEqual(@as(i64, 0), try f.segmentCount(&md5));

    f.drain();
    try std.testing.expectEqual(@as(i64, 2), try f.segmentCount(&md5));
}

test "a second drain finds nothing — the query excludes finished work, so the worker cannot spin" {
    // A discovery query that still matched a completed blob would make `drain`
    // an infinite loop pinning the core, which on one CPU is the whole machine.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("notes.txt", two_paragraphs);
    f.drain();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql` and `needsDerive` agree — the two expressions of one predicate" {
    // The SQL is a second statement of `txtindex.needsDerive`, which is a real
    // cost; this is what stops the two drifting into disagreeing about whether a
    // file is done. Checked on BOTH sides of the work.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);

    try std.testing.expect(try txtindex.needsDerive(f.db, &md5));
    {
        const found = (try nextJob(testing.allocator, f.db)).?;
        defer testing.allocator.free(found.name);
        try std.testing.expectEqualStrings(&md5, &found.md5);
    }

    f.drain();

    try std.testing.expect(!try txtindex.needsDerive(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a trashed .txt is not offered — the bin is not a work queue" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    // And it comes back the moment it is restored, without anything re-signalling.
    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    const found = (try nextJob(testing.allocator, f.db)).?;
    defer testing.allocator.free(found.name);
    try std.testing.expectEqualStrings(&md5, &found.md5);
}

test "a leading-dot name is not a text file, here as in `wants`" {
    // `LIKE '%_.txt'` has to mean what `txtindex.wants` means: `_` demands a
    // character before the dot, so a bare `.txt` has no extension at all.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(".txt", two_paragraphs);
    try std.testing.expect(!txtindex.wants(".txt"));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "the worker thread starts, does the work, and JOINS on stop" {
    // Shutdown ordering is the one thing a background writer can get fatally
    // wrong: the connection must not close under it. `stop` joins.
    var f = try Fixture.init();
    defer f.deinit();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    try w.start();
    f.files.deferred = &w;

    const md5 = try f.put("notes.txt", two_paragraphs);

    // The upload signalled it; wait for the segments rather than for a duration.
    var spins: usize = 0;
    while (spins < 2000) : (spins += 1) {
        f.lock.lockUncancelable(testing.io);
        const n = f.segmentCount(&md5) catch 0;
        f.lock.unlock(testing.io);
        if (n == 2) break;
        std.Io.sleep(testing.io, .{ .nanoseconds = std.time.ns_per_ms }, .awake) catch {};
    }
    w.stop();
    try std.testing.expect(w.thread == null);
    try std.testing.expectEqual(@as(i64, 2), try f.segmentCount(&md5));
}

/// A 200x100 page with `/Rotate 90` — so the honest answer is 100x200.
const rotate90_pdf = @embedFile("../pdf/testdata/rotate90.pdf");

test "a PDF gets its shape from the worker, and ROTATION survives into the row" {
    // End to end: upload, drain, read the row the gallery reads. The rotated
    // fixture is the point — a `/MediaBox` reader would store 200x100 here, and
    // every tile of that document would be laid out on its side.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    {
        var r = (try f.db.row("SELECT pdf_probe FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(?i64, null), r.intOpt(0)); // the upload does not probe
    }

    f.drain();

    var r = (try f.db.row(
        "SELECT page_count, width, height, pdf_probe FROM note_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 1), r.int(0));
    try std.testing.expectEqual(@as(i64, 100), r.int(1));
    try std.testing.expectEqual(@as(i64, 200), r.int(2));
    try std.testing.expectEqual(@as(i64, 0), r.int(3)); // Verdict.ok
}

test "a file that is not a PDF records a verdict, so it is never probed twice" {
    // `Tenant.run`'s contract: a tenant that cannot record its own dead ends is
    // handed the same blob for ever, and one core is the whole machine here.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("broken.pdf", "this is definitely not a pdf");
    f.drain();

    {
        var r = (try f.db.row("SELECT pdf_probe FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(?i64, 1), r.intOpt(0)); // Verdict.unopenable
    }

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql` and `needsProbe` agree, on both sides of the work" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));

    f.drain();

    try std.testing.expect(!try pdfindex.needsProbe(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a .pdf.mark is not a PDF — the extension rule, not a substring" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put("doc.pdf.mark", rotate90_pdf);
    try std.testing.expect(!pdfindex.wants("doc.pdf.mark"));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a blob whose FILE is gone cannot spin the worker" {
    // A `files` row whose blob is missing on disk — a failed GC, a hand-edited
    // data dir. The tenant declines (nothing to probe) and records nothing, so
    // the discovery query offers the same blob again. Without the forward
    // progress guard in `drain` that is a hot loop on the one core this server
    // is allowed to have; with it, the blob is offered once and left for the
    // idle tick.
    const saved = testing.log_level;
    testing.log_level = .err; // the warning below is the POINT of this test
    defer testing.log_level = saved;

    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    f.files.blobs.remove(&md5); // the row survives, the bytes do not

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain(); // must RETURN. Without the guard this never does.

    // Offered once, then abandoned — not once per turn of the loop.
    try std.testing.expect(w.done.load(.acquire) <= 1);
    // And still outstanding, so a later tick can retry once the blob is back.
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));
}

test "the tenant table is ordered by priority, so `nextJob` can take the first match" {
    // `nextJob` asks in array order and returns the first tenant with work.
    // That is only "priority order" if the array IS sorted — asserted here
    // rather than by sorting at runtime, because the table is comptime-known.
    var prev: u8 = 0;
    for (&tenants) |*t| {
        try std.testing.expect(t.priority >= prev);
        prev = t.priority;
        try std.testing.expect(t.name.len > 0);
        try std.testing.expect(t.pending_sql.len > 0);
    }
}

test "every tenant's pending_sql is valid SQL against the real schema" {
    // A tenant whose query does not compile would only fail at runtime, in a
    // background thread, as a log line nobody reads.
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    for (&tenants) |*t| {
        const s = try db.prepare(t.pending_sql);
        s.finalize();
    }
}
