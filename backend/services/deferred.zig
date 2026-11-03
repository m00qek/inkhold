//! Post-upload processing, off the connection, one file at a time. The job
//! store is a query, not a queue: each tenant names in SQL the blobs it still
//! owes work on. One worker thread is the serialization (and the memory bound).

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const derivedstore = @import("../store/derived.zig");
const derivesearch = @import("derive_search.zig");
const txtindex = @import("txt_index.zig");
const noteindex = @import("note_index.zig");
const inkscan = @import("ink_scan.zig");
const pdfindex = @import("pdf_index.zig");
const pdftext = @import("pdf_text.zig");
const pdfprobe = @import("../pdf/probe.zig");
const pdftextpass = @import("../pdf/text.zig");

const log = std.log.scoped(.deferred);

/// Idle sleep, and the backstop: work left by a restart or an unsignalled path
/// is found by the next tick.
pub const idle_tick_ns: u64 = 30 * std.time.ns_per_s;

/// One kind of post-upload work. The worker owns thread, ordering and locking.
pub const Tenant = struct {
    name: []const u8,

    /// Lower runs first; ties break on blob size ascending.
    priority: u8,

    /// The blobs this tenant still owes work on: bare FROM/WHERE with `files f`,
    /// `blobs b`, `note_index ni`; `?1` is the note index version. Must exclude
    /// finished work or the worker spins. Shared with `pending.zig`'s count; a
    /// reader may only add a bound, never restate it.
    from_where: []const u8,

    /// Built from `from_where` by `discovery`.
    pending_sql: []const u8,

    /// Called without the DB lock: parse off it, take it for the write. Errors
    /// leave the blob outstanding; a blob that can never succeed must be recorded
    /// by the tenant itself or it is retried for ever.
    run: *const fn (Job) anyerror!void,
};

pub const Job = struct {
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    /// Held for the tenant's write transaction only.
    lock: *std.Io.Mutex,
    io: std.Io,
    md5: []const u8,
    /// Any holder's name: only the extension is read.
    name: []const u8,
    /// Null means "write no derived files", never an error.
    terms: ?derivedstore.DerivedStore = null,
    text: ?derivedstore.DerivedStore = null,

    /// Is the `.txt` work still outstanding? Asked under the lock, since an upload
    /// may have healed the blob since discovery.
    fn check(self: Job) !bool {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        if (!try noteindex.isCurrent(self.db, self.md5)) return false;
        return txtindex.needsDerive(self.db, self.md5);
    }

    fn pdfNeedsProbe(self: Job) !bool {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return pdfindex.needsProbe(self.db, self.md5);
    }

    fn pdfNeedsText(self: Job) !bool {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return pdftext.needsText(self.db, self.md5);
    }
};

/// The next outstanding blob, smallest first (shortest-job-first is the
/// worker's choice, not the tenant's).
fn discovery(comptime from_where: []const u8) []const u8 {
    return "SELECT f.md5, f.name, b.size\n" ++ from_where ++
        \\
        \\ ORDER BY b.size ASC
        \\ LIMIT 1;
    ;
}

const txt_tenant: Tenant = .{
    .name = "txt",
    .priority = 1,
    .from_where = txtindex.pending_from_where,
    .pending_sql = discovery(txtindex.pending_from_where),
    .run = runTxt,
};

fn runTxt(job: Job) anyerror!void {
    // Every tenant: re-check under the lock, derive off it, verdict under it.

    if (!try job.check()) return;

    var d = (try txtindex.deriveStored(job.gpa, job.blobs, job.md5)) orelse return;
    defer d.deinit();

    // Derived files before the verdict: the file is the fact that a document is
    // derived, so a crash in between must leave it outstanding. Failure is not
    // fatal; `reconcileDerived` heals from disk. Off the lock because the fold
    // runs on a private in-memory connection.
    writeTxtFiles(job, d) catch |e| {
        log.warn("derived files failed for {s}: {t}", .{ job.md5, e });
    };

    // Re-ask first: an ingest or another pass may have answered meanwhile.
    job.lock.lockUncancelable(job.io);
    defer job.lock.unlock(job.io);
    if (!try txtindex.needsDerive(job.db, job.md5)) return;
    try job.db.exec("BEGIN IMMEDIATE;");
    errdefer job.db.exec("ROLLBACK;") catch {};
    try txtindex.storeVerdict(job.db, job.md5, txtindex.verdictFor(d));
    try job.db.exec("COMMIT;");
}

fn writeTxtFiles(job: Job, d: txtindex.Derived) !void {
    const terms_store = job.terms orelse return;
    const text_store = job.text orelse return;
    var src = txtindex.Pages.init(d);
    try derivesearch.writeDerived(
        job.gpa,
        terms_store,
        text_store,
        job.md5,
        @intCast(txtindex.rowCount(d)),
        &src,
    );
}

/// A `.pdf`'s shape, then its text. After `.txt`: least urgent, most costly.
/// One tenant with two questions (see `pdf_index.pending_from_where`).
const pdf_tenant: Tenant = .{
    .name = "pdf",
    .priority = 2,
    .from_where = pdfindex.pending_from_where,
    .pending_sql = discovery(pdfindex.pending_from_where),
    .run = runPdf,
};

fn runPdf(job: Job) anyerror!void {
    try runPdfProbe(job);
    try runPdfText(job);
}

fn runPdfProbe(job: Job) anyerror!void {
    if (!try job.pdfNeedsProbe()) return;

    const file = job.blobs.open(job.md5) catch return; // blob gone: nothing to record
    defer file.close(job.io);
    const shape: ?pdfprobe.Shape = pdfprobe.probeFile(file) catch |e| blk: {
        const v = pdfindex.Verdict.of(e) orelse return; // transient — try again later
        // A broken PDF is a verdict, recorded so it is never offered again.
        job.lock.lockUncancelable(job.io);
        defer job.lock.unlock(job.io);
        try job.db.exec("BEGIN IMMEDIATE;");
        errdefer job.db.exec("ROLLBACK;") catch {};
        try pdfindex.storeVerdict(job.db, job.md5, v);
        try job.db.exec("COMMIT;");
        break :blk null;
    };

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

/// The text pass. Every early return leaves `pdf_text` NULL, so it is redone.
fn runPdfText(job: Job) anyerror!void {
    if (!try job.pdfNeedsText()) return;

    const file = job.blobs.open(job.md5) catch return; // blob gone: nothing to record
    defer file.close(job.io);
    var ex = pdftextpass.Extractor.open(file) catch |e| {
        const v = pdftext.Verdict.of(e) orelse return; // transient — try again later
        // A text-pass failure is likewise recorded as a verdict.
        job.lock.lockUncancelable(job.io);
        defer job.lock.unlock(job.io);
        try job.db.exec("BEGIN IMMEDIATE;");
        errdefer job.db.exec("ROLLBACK;") catch {};
        try pdftext.storeVerdict(job.db, job.md5, v);
        try job.db.exec("COMMIT;");
        return;
    };
    defer ex.close();

    const doc_pages = ex.pages;
    // Same arithmetic as `nextChunk`'s stop (`min(pages, max_pages)`).
    const to_index = @min(doc_pages, pdftext.max_pages);

    // Derived files before the verdict, as in `runTxt`.
    var src = pdftext.Pages.init(job.gpa, &ex);
    defer src.deinit();
    writePdfFiles(job, &src, doc_pages) catch |e| {
        log.warn("derived files failed for {s}: {t}", .{ job.md5, e });
    };
    // Finish the walk (no stores, or a mid-walk failure): the verdict needs to
    // know whether any page had text.
    while (try src.next()) |_| {}

    // Re-ask first, as in `runTxt`.
    job.lock.lockUncancelable(job.io);
    defer job.lock.unlock(job.io);
    if (!try pdftext.needsText(job.db, job.md5)) return;
    try job.db.exec("BEGIN IMMEDIATE;");
    errdefer job.db.exec("ROLLBACK;") catch {};
    try pdftext.finish(job.db, job.md5, to_index, pdftext.verdictFor(doc_pages, to_index, src.any_text));
    try job.db.exec("COMMIT;");
}

/// Walks the caller's page source once (a second walk is ~0.1 s/page on the
/// Pi). A scan writes a header-only pair, which is correct: it is derived.
fn writePdfFiles(job: Job, src: *pdftext.Pages, doc_pages: u32) !void {
    const terms_store = job.terms orelse return;
    const text_store = job.text orelse return;
    try derivesearch.writeDerived(job.gpa, terms_store, text_store, job.md5, doc_pages, src);
}

/// `has_ink` back-fill for `.note` pages predating the column. Last: nothing
/// waits on it (NULL reads as an omitted mark). Writes no verdict column;
/// `has_ink IS NULL` is both the outstanding set and the missing answer.
const ink_tenant: Tenant = .{
    .name = "ink",
    .priority = 3,
    .from_where = inkscan.ink_pending_from_where,
    .pending_sql = discovery(inkscan.ink_pending_from_where),
    .run = runInk,
};

fn runInk(job: Job) anyerror!void {
    // Copy the packed layer records (tens of bytes per page) out under the lock.
    var scan = blk: {
        job.lock.lockUncancelable(job.io);
        defer job.lock.unlock(job.io);
        if (!try inkscan.inkNeedsScan(job.db, job.md5)) return;
        break :blk try inkscan.pendingInk(job.gpa, job.db, job.md5);
    };
    defer scan.deinit();
    if (scan.pages.len == 0) return;

    inkscan.scanInk(job.blobs, job.md5, &scan);

    // Scoped to `has_ink IS NULL`, so a fresher ingest answer is kept.
    job.lock.lockUncancelable(job.io);
    defer job.lock.unlock(job.io);
    try job.db.exec("BEGIN IMMEDIATE;");
    errdefer job.db.exec("ROLLBACK;") catch {};
    try inkscan.storeInk(job.db, job.md5, scan);
    try job.db.exec("COMMIT;");
}

/// Every tenant, in one place so the set can be tested.
pub const tenants = [_]Tenant{ txt_tenant, pdf_tenant, ink_tenant };

// ---- reconcile: the backfill the tenant predicates cannot do ----

/// Derived files for one `.note`; the `.note` format has no tenant (it derives
/// at upload), so this is the only path for notes predating the stores.
/// Unparseable blobs write nothing, agreeing with the ingest side.
fn writeNoteFiles(job: Job, p: *const noteindex.Parsed) !void {
    if (!p.indexable) return;
    const terms_store = job.terms orelse return;
    const text_store = job.text orelse return;
    var src = noteindex.Pages.init(p);
    try derivesearch.writeDerived(
        job.gpa,
        terms_store,
        text_store,
        job.md5,
        // The address space: every page, not only recognised ones.
        p.note.page_count,
        &src,
    );
}

/// Live documents of a derivable format, with no index-state predicate: a
/// blob indexed before the derived stores existed owes no tenant work, so
/// whether its files exist is asked of the disk. `ni.indexable` picks the
/// parser from content, not name. `?1` index version, `?2` the md5 cursor.
const reconcile_sql =
    \\SELECT f.md5, f.name, ni.indexable
    \\  FROM files f
    \\  JOIN blobs b ON b.md5 = f.md5
    \\  JOIN note_index ni ON ni.blob_md5 = f.md5
    \\ WHERE f.is_folder = 0
    \\   AND f.deleted = 0
    \\   AND f.md5 IS NOT NULL
    \\   AND ni.index_version = ?1
    \\   AND (ni.indexable = 1
    \\        OR LOWER(f.name) LIKE '%_.txt'
    \\        OR LOWER(f.name) LIKE '%_.pdf')
    \\   AND f.md5 > ?2
    \\ ORDER BY f.md5 ASC
    \\ LIMIT 1;
;

const Candidate = struct {
    md5: [32]u8,
    /// Owned by the caller's allocator; only its extension is read.
    name: []u8,
    indexable: bool,
};

/// Called without the DB lock; writes no rows, only the two files.
fn deriveOne(job: Job, indexable: bool) !void {
    if (indexable) return deriveNote(job);
    if (txtindex.wants(job.name)) return deriveTxt(job);
    if (pdfindex.wants(job.name)) return derivePdf(job);
    // Unreachable: `reconcile_sql`'s LIKEs are `wants`'s rule (pinned by a test).
}

fn deriveNote(job: Job) !void {
    var p = (try noteindex.parseStoredBlob(job.gpa, job.io, job.blobs, job.md5)) orelse return;
    defer p.deinit();
    try writeNoteFiles(job, &p);
}

fn deriveTxt(job: Job) !void {
    var d = (try txtindex.deriveStored(job.gpa, job.blobs, job.md5)) orelse return;
    defer d.deinit();
    try writeTxtFiles(job, d);
}

fn derivePdf(job: Job) !void {
    const file = job.blobs.open(job.md5) catch return; // blob gone: nothing to derive
    defer file.close(job.io);
    var ex = pdftextpass.Extractor.open(file) catch return;
    defer ex.close();
    var src = pdftext.Pages.init(job.gpa, &ex);
    defer src.deinit();
    try writePdfFiles(job, &src, ex.pages);
}

pub const Found = struct {
    tenant: *const Tenant,
    md5: [32]u8,
    /// Owned by the caller's allocator.
    name: []u8,
};

/// The next outstanding job; tenants are asked in priority order on every pass.
pub fn nextJob(gpa: std.mem.Allocator, db: sqlite.Db) !?Found {
    // `tenants` is comptime and asserted sorted by a test.
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

pub const Worker = struct {
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    lock: *std.Io.Mutex,
    io: std.Io,
    /// Set by `app.run`; null everywhere else.
    terms: ?derivedstore.DerivedStore = null,
    text: ?derivedstore.DerivedStore = null,

    thread: ?std.Thread = null,

    /// Bumped by `signal`. A bare futex word because the worker needs a timed wait
    /// and `Io.Condition` has none.
    epoch: std.atomic.Value(u32) = .init(0),

    /// Checked between jobs, so shutdown lands between files.
    stopping: std.atomic.Value(bool) = .init(false),

    /// Jobs completed. `usize`, not `u64`: 32-bit targets (the Pi's
    /// `arm-linux-musleabihf`) have no lock-free 64-bit atomic.
    done: std.atomic.Value(usize) = .init(0),

    pub fn start(self: *Worker) !void {
        self.thread = try std.Thread.spawn(.{}, loop, .{self});
    }

    /// Non-blocking; safe under the DB lock.
    pub fn signal(self: *Worker) void {
        _ = self.epoch.fetchAdd(1, .release);
        self.io.futexWake(u32, &self.epoch.raw, 1);
    }

    /// Stop and join, never detach: the worker writes to the DB, so the connection
    /// must not close under it.
    pub fn stop(self: *Worker) void {
        const t = self.thread orelse return;
        self.stopping.store(true, .release);
        self.signal();
        t.join();
        self.thread = null;
    }

    fn loop(self: *Worker) void {
        nice19();

        // Once at start, on this thread: boot must not wait for minutes of derives.
        self.reconcileDerived();

        while (!self.stopping.load(.acquire)) {
            // Read the epoch before draining, so a signal during work is not slept through.
            const seen = self.epoch.load(.acquire);
            self.drain();
            if (self.stopping.load(.acquire)) return;
            self.io.futexWaitTimeout(
                u32,
                &self.epoch.raw,
                seen,
                .{ .duration = .{ .raw = .{ .nanoseconds = idle_tick_ns }, .clock = .awake } },
            ) catch {};

            // An unchanged epoch means the idle tick (the wait reports timeout by
            // returning). Reconciling on every wake would scan the library per upload.
            if (self.epoch.load(.acquire) == seen) self.reconcileDerived();
        }
    }

    /// Gives every live document its two derived files. A `LIMIT 1` cursor on md5
    /// under the lock: no list held, fresh rows between documents. The common case
    /// is two `stat`s and no blob read. Both stores are checked because a crash
    /// between terms and text commits leaves a lone terms file. Per-document
    /// failures are not fatal.
    pub fn reconcileDerived(self: *Worker) void {
        // Null stores: this deployment keeps none.
        const terms = self.terms orelse return;
        const text = self.text orelse return;

        var cursor_buf: [32]u8 = undefined;
        var cursor: []const u8 = ""; // every hex md5 sorts after the empty string
        var missing: usize = 0;

        while (!self.stopping.load(.acquire)) {
            const c = self.nextCandidate(cursor) catch |e| {
                log.warn("reconcile discovery failed: {t}", .{e});
                return;
            } orelse break;
            defer self.gpa.free(c.name);

            // Advance first, or a failing document is re-offered in a hot loop.
            cursor_buf = c.md5;
            cursor = &cursor_buf;

            if (terms.has(&c.md5, derivesearch.index_version) and
                text.has(&c.md5, derivesearch.index_version)) continue;

            deriveOne(.{
                .gpa = self.gpa,
                .db = self.db,
                .blobs = self.blobs,
                .lock = self.lock,
                .io = self.io,
                .md5 = &c.md5,
                .name = c.name,
                .terms = terms,
                .text = text,
            }, c.indexable) catch |e| {
                log.warn("reconcile failed for {s}: {t}", .{ &c.md5, e });
                continue;
            };
            missing += 1;
        }

        if (missing != 0) log.info("reconcile derived {d} document(s)", .{missing});
    }

    /// The name is duped: row memory dies with the statement, which dies with the lock.
    fn nextCandidate(self: *Worker, after: []const u8) !?Candidate {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);

        var r = (try self.db.row(reconcile_sql, &.{
            .{ .int = noteindex.index_version },
            .{ .text = after },
        })) orelse return null;
        defer r.finalize();

        const md5_text = r.text(0);
        if (md5_text.len != 32) return null; // a corrupt row; `nextJob` is as wary
        var c: Candidate = .{ .md5 = undefined, .name = undefined, .indexable = r.int(2) != 0 };
        @memcpy(&c.md5, md5_text);
        c.name = try self.gpa.dupe(u8, r.text(1));
        return c;
    }

    /// Runs jobs until none remain or asked to stop, re-querying between jobs.
    pub fn drain(self: *Worker) void {
        // Forward-progress guard: a tenant may decline a blob without recording
        // anything, and discovery would hand it back at once (a hot loop on one core).
        // Each blob is offered at most once per drain; the idle tick paces retries.
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
                .terms = self.terms,
                .text = self.text,
            }) catch |e| {
                // Left outstanding; returning lets the idle tick pace the retry.
                log.warn("{s} job failed for {s}: {t}", .{ found.tenant.name, &found.md5, e });
                return;
            };

            _ = self.done.fetchAdd(1, .release);
        }
    }

    fn next(self: *Worker) !?Found {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return nextJob(self.gpa, self.db);
    }
};

/// Drops the calling thread to nice 19. On the Pi, a CPU-bound pass at nice 0
/// doubles foreground latency (19.8 → 40 ms p50); at 19 it costs 1.4 ms, which
/// is why the PDF parse need not be resumable. Linux nice is per-task, so only
/// the worker moves. Raw syscall: Zig 0.16 std has no `setpriority` wrapper.
fn nice19() void {
    if (@import("builtin").os.tag != .linux) return;
    const PRIO_PROCESS = 0; // …which, for `who = 0`, means this THREAD
    _ = std.os.linux.syscall3(.setpriority, PRIO_PROCESS, 0, 19);
}

/// Runs every outstanding job on this thread, through the real discovery and
/// tenants. For tests and startup sweeps.
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

// ---- tests ----

const schema = @import("../db/schema.zig");
const testing = std.testing;
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");

/// Real database, blob store and ingest path, minus the thread.
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

    /// Uploads without draining.
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

    fn stores(f: *Fixture) !struct { terms: derivedstore.DerivedStore, text: derivedstore.DerivedStore } {
        const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
        const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
        return .{
            .terms = try derivedstore.DerivedStore.init(testing.io, terms_dir),
            .text = try derivedstore.DerivedStore.init(testing.io, text_dir),
        };
    }

    /// Has the `.txt` tenant written its verdict for this blob?
    fn txtDone(f: *Fixture, md5: []const u8) !bool {
        return !(try txtindex.needsDerive(f.db, md5));
    }
};

const two_paragraphs = "First paragraph, with words in it.\n\nSecond paragraph, also with words.\n";

test "the .txt tenant writes BOTH derived files, and they inflate to the §2.2 record" {
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("notes.txt", two_paragraphs);
    try testing.expect(!terms.has(&md5, derivesearch.index_version));

    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    try testing.expect(try f.txtDone(&md5));
    try testing.expect(terms.has(&md5, derivesearch.index_version));
    try testing.expect(text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    const head = lines.next().?;
    try testing.expect(std.mem.indexOf(u8, head, "\"n\":2") != null);
    try testing.expectEqualStrings(
        "{\"p\":0,\"t\":\"first in it paragraph with words\"}",
        lines.next().?,
    );
    try testing.expectEqualStrings(
        "{\"p\":1,\"t\":\"also paragraph second with words\"}",
        lines.next().?,
    );
    try testing.expect(lines.next() == null);

    const x = try derivedstore.readPlain(testing.allocator, text, &md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    var xlines = std.mem.tokenizeScalar(u8, x, '\n');
    _ = xlines.next();
    const p0 = try std.json.parseFromSlice(std.json.Value, testing.allocator, xlines.next().?, .{});
    defer p0.deinit();
    try testing.expectEqualStrings("First paragraph, with words in it.", p0.value.object.get("t").?.string);
    try testing.expectEqual(@as(i64, 0), p0.value.object.get("o").?.integer);
    try testing.expectEqual(@as(i64, 34), p0.value.object.get("l").?.integer);
}

test "no stores wired means no files and no failure" {
    var f = try Fixture.init();
    defer f.deinit();
    const md5 = try f.put("notes.txt", two_paragraphs);
    f.drain();
    try testing.expect(try f.txtDone(&md5));
}

test "an upload does NOT derive the .txt, and a drain does" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    try std.testing.expect(!try f.txtDone(&md5));

    f.drain();
    try std.testing.expect(try f.txtDone(&md5));
}

test "a second drain finds nothing — the query excludes finished work, so the worker cannot spin" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("notes.txt", two_paragraphs);
    f.drain();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql` and `needsDerive` agree — the two expressions of one predicate" {
    // Checked both before and after the work.
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

/// Three chunks at `txt_index.chunk_segments`.
fn manyParagraphs(a: std.mem.Allocator, n: usize) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (0..n) |i| {
        if (i != 0) try out.appendSlice(a, "\n\n");
        try out.print(a, "paragraph {d} rutabaga leaf{d:0>3}", .{ i, i });
    }
    return out.items;
}

test "THE .txt DERIVE WRITES IN READING ORDER, and the verdict comes AFTER the files" {
    // Records ascend from ordinal 0, and the verdict lands after both files.
    var f = try Fixture.init();
    defer f.deinit();
    const s = try f.stores();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const md5 = try f.put("book.txt", try manyParagraphs(arena.allocator(), 120));

    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.drain();

    try testing.expect(try f.txtDone(&md5));
    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const raw = try derivedstore.readPlain(arena.allocator(), s.text, &md5, derivesearch.index_version);
    var lines = std.mem.tokenizeScalar(u8, raw, '\n');
    const head = try std.json.parseFromSlice(std.json.Value, arena.allocator(), lines.next().?, .{});
    try testing.expectEqual(@as(i64, 120), head.value.object.get("n").?.integer);

    var expect_ordinal: i64 = 0;
    while (lines.next()) |line| : (expect_ordinal += 1) {
        const v = try std.json.parseFromSlice(std.json.Value, arena.allocator(), line, .{});
        try testing.expectEqual(expect_ordinal, v.value.object.get("p").?.integer);
    }
    try testing.expectEqual(@as(i64, 120), expect_ordinal);
}

test "a trashed .txt is not offered — the bin is not a work queue" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    const found = (try nextJob(testing.allocator, f.db)).?;
    defer testing.allocator.free(found.name);
    try std.testing.expectEqualStrings(&md5, &found.md5);
}

test "a leading-dot name is not a text file, here as in `wants`" {
    // `_` demands a character before the dot, as `txtindex.wants` does.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(".txt", two_paragraphs);
    try std.testing.expect(!txtindex.wants(".txt"));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "the worker thread starts, does the work, and JOINS on stop" {
    var f = try Fixture.init();
    defer f.deinit();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    try w.start();
    f.files.deferred = &w;

    const md5 = try f.put("notes.txt", two_paragraphs);

    var spins: usize = 0;
    while (spins < 2000) : (spins += 1) {
        f.lock.lockUncancelable(testing.io);
        const done = f.txtDone(&md5) catch false;
        f.lock.unlock(testing.io);
        if (done) break;
        std.Io.sleep(testing.io, .{ .nanoseconds = std.time.ns_per_ms }, .awake) catch {};
    }
    w.stop();
    try std.testing.expect(w.thread == null);
    try std.testing.expect(try f.txtDone(&md5));
}

/// A 200x100 page with `/Rotate 90`, so the right answer is 100x200.
const rotate90_pdf = @embedFile("../pdf/testdata/rotate90.pdf");

test "a PDF gets its shape from the worker, and ROTATION survives into the row" {
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
    // A `files` row whose blob is missing on disk.
    const saved = testing.log_level;
    testing.log_level = .err; // the warning below is the POINT of this test
    defer testing.log_level = saved;

    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    f.files.blobs.remove(&md5); // the row survives, the bytes do not

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain(); // must RETURN. Without the guard this never does.

    try std.testing.expect(w.done.load(.acquire) <= 1);
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));
}

/// Three chunks at `pdf_text.chunk_pages`.
const book_pdf = @embedFile("../pdf/testdata/text-120-page.pdf");
/// Three bare `/MediaBox` pages: a scan, minus the image.
const scan_pdf = @embedFile("../pdf/testdata/three-page.pdf");

test "ONE JOB answers both of the .pdf tenant's questions — the shape, then the text" {
    // One drain must leave the document fully indexed despite the guard.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.pdf", book_pdf);
    f.drain();

    var r = (try f.db.row(
        "SELECT page_count, pdf_probe, pdf_text FROM note_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 120), r.int(0));
    try std.testing.expectEqual(@as(?i64, 0), r.intOpt(1)); // pdfindex.Verdict.ok
    try std.testing.expectEqual(@as(?i64, 0), r.intOpt(2)); // pdftext.Verdict.ok

    var pages = (try f.db.row(
        "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer pages.finalize();
    try std.testing.expectEqual(@as(i64, 0), pages.int(0));
}

test "a second drain finds nothing for a finished PDF either — text is done work, not outstanding" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("book.pdf", book_pdf);
    f.drain();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql`, `needsProbe` and `needsText` agree on both sides of the text pass" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.pdf", book_pdf);
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));
    try std.testing.expect(!try pdftext.needsText(f.db, &md5)); // never before the probe

    f.drain();

    try std.testing.expect(!try pdfindex.needsProbe(f.db, &md5));
    try std.testing.expect(!try pdftext.needsText(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a SCANNED PDF records its verdict and is never offered again" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("scan.pdf", scan_pdf);
    f.drain();

    {
        var r = (try f.db.row("SELECT pdf_text FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(?i64, 1), r.intOpt(0)); // pdftext.Verdict.no_text
    }

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "the .pdf tenant writes BOTH derived files, ACROSS CHUNK BOUNDARIES" {
    // Three chunks: catches a source that hands out only its first chunk or frees
    // one while `writeDerived` still reads it.
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("book.pdf", book_pdf);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    try testing.expect(terms.has(&md5, derivesearch.index_version));
    try testing.expect(text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":120") != null);
    var seen: usize = 0;
    while (lines.next()) |line| : (seen += 1) {
        var buf: [64]u8 = undefined;
        try testing.expectEqualStrings(
            try std.fmt.bufPrint(
                &buf,
                "{{\"p\":{d},\"t\":\"{d} leaf{d:0>3} recipe rutabaga\"}}",
                .{ seen, seen, seen },
            ),
            line,
        );
    }
    try testing.expectEqual(@as(usize, 120), seen); // the last two chunks, too

    // A PDF page has no byte range in the blob, so `o`/`l` are absent.
    const x = try derivedstore.readPlain(testing.allocator, text, &md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    var xlines = std.mem.tokenizeScalar(u8, x, '\n');
    _ = xlines.next();
    const p0 = try std.json.parseFromSlice(std.json.Value, testing.allocator, xlines.next().?, .{});
    defer p0.deinit();
    try testing.expectEqual(@as(i64, 0), p0.value.object.get("p").?.integer);
    try testing.expect(p0.value.object.get("o") == null);
    try testing.expect(p0.value.object.get("l") == null);
    try testing.expect(std.mem.indexOf(u8, p0.value.object.get("t").?.string, "Recipe 0 rutabaga leaf000") != null);
}

test "a SCANNED PDF still gets its two files, and they are the header alone" {
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("scan.pdf", scan_pdf);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    try testing.expect(terms.has(&md5, derivesearch.index_version));
    try testing.expect(text.has(&md5, derivesearch.index_version));

    for ([_]derivedstore.DerivedStore{ terms, text }) |store| {
        const got = try derivedstore.readPlain(testing.allocator, store, &md5, derivesearch.index_version);
        defer testing.allocator.free(got);
        var lines = std.mem.tokenizeScalar(u8, got, '\n');
        try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":3") != null);
        try testing.expect(lines.next() == null);
    }
}

test "NICE 19 IS PER-THREAD — the worker yields the core, the request threads do not" {
    if (@import("builtin").os.tag != .linux) return error.SkipZigTest;
    // The kernel returns `20 - nice`.
    const nice = struct {
        fn read() usize {
            return std.os.linux.syscall2(.getpriority, 0, 0);
        }
        fn lowerAndRead(out: *usize) void {
            nice19();
            out.* = read();
        }
    };
    const before = nice.read();

    var worker_nice: usize = 0;
    const t = try std.Thread.spawn(.{}, nice.lowerAndRead, .{&worker_nice});
    t.join();

    try std.testing.expectEqual(@as(usize, 1), worker_nice); // nice 19
    try std.testing.expectEqual(before, nice.read()); // this thread is untouched
}

test "the tenant table is ordered by priority, so `nextJob` can take the first match" {
    var prev: u8 = 0;
    for (&tenants) |*t| {
        try std.testing.expect(t.priority >= prev);
        prev = t.priority;
        try std.testing.expect(t.name.len > 0);
        try std.testing.expect(t.pending_sql.len > 0);
        try std.testing.expect(t.from_where.len > 0);
    }
}

test "every tenant's pending_sql is valid SQL against the real schema" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    for (&tenants) |*t| {
        const s = try db.prepare(t.pending_sql);
        s.finalize();
    }
}

test "a tenant's discovery statement CONTAINS its predicate, so a second reader cannot drift from it" {
    for (&tenants) |*t| {
        try std.testing.expect(std.mem.indexOf(u8, t.pending_sql, t.from_where) != null);
    }
}

test "the predicate answers PER BLOB as well as per install — one bound parameter, not a fourth copy" {
    var f = try Fixture.init();
    defer f.deinit();

    const txt = try f.put("notes.txt", two_paragraphs);
    const pdf = try f.put("doc.pdf", rotate90_pdf);

    const per_blob = struct {
        fn ask(db: sqlite.Db, from_where: []const u8, md5: []const u8) !bool {
            const sql = try std.fmt.allocPrint(
                testing.allocator,
                "SELECT 1\n{s}\n   AND f.md5 = ?2\n LIMIT 1;",
                .{from_where},
            );
            defer testing.allocator.free(sql);
            var r = (try db.row(sql, &.{
                .{ .int = noteindex.index_version },
                .{ .text = md5 },
            })) orelse return false;
            r.finalize();
            return true;
        }
    }.ask;

    try std.testing.expect(try per_blob(f.db, txt_tenant.from_where, &txt));
    try std.testing.expect(!try per_blob(f.db, txt_tenant.from_where, &pdf));
    try std.testing.expect(try per_blob(f.db, pdf_tenant.from_where, &pdf));
    try std.testing.expect(!try per_blob(f.db, pdf_tenant.from_where, &txt));

    f.drain();

    try std.testing.expect(!try per_blob(f.db, txt_tenant.from_where, &txt));
    try std.testing.expect(!try per_blob(f.db, pdf_tenant.from_where, &pdf));
}

// ---- the `ink` tenant ----

fn unlookedPages(f: *Fixture, md5: []const u8) !i64 {
    var r = (try f.db.row(
        "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1 AND has_ink IS NULL;",
        &.{.{ .text = md5 }},
    )).?;
    defer r.finalize();
    return r.int(0);
}

test "INK: a NULL page is offered once, back-filled, and never offered again" {
    // A fresh upload owes nothing; the state is forced as after a v15 migration.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.note", sample2_note);

    try testing.expectEqual(@as(i64, 0), try unlookedPages(&f, &md5));
    try std.testing.expect(!try inkscan.inkNeedsScan(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try testing.expectEqual(@as(i64, 2), try unlookedPages(&f, &md5));
    try std.testing.expect(try inkscan.inkNeedsScan(f.db, &md5));

    {
        const found = (try nextJob(testing.allocator, f.db)).?;
        defer testing.allocator.free(found.name);
        try std.testing.expectEqualStrings(&md5, &found.md5);
        try std.testing.expectEqualStrings("ink", found.tenant.name);
    }

    f.drain();

    try testing.expectEqual(@as(i64, 0), try unlookedPages(&f, &md5));
    {
        var r = (try f.db.row(
            "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1 AND has_ink = 1;",
            &.{.{ .text = &md5 }},
        )).?;
        defer r.finalize();
        try testing.expectEqual(@as(i64, 2), r.int(0));
    }

    try std.testing.expect(!try inkscan.inkNeedsScan(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "INK: what the tenant owes is EXACTLY the NULL rows, and it answers only those" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.note", sample2_note);
    // Page 1's answer is deliberately wrong, so re-scanning it would show.
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL WHERE page_index = 0;");
    try f.db.exec("UPDATE note_page_index SET has_ink = 0 WHERE page_index = 1;");

    try testing.expectEqual(@as(i64, 1), try unlookedPages(&f, &md5));
    try std.testing.expect(try inkscan.inkNeedsScan(f.db, &md5));

    f.drain();

    try testing.expectEqual(@as(i64, 0), try unlookedPages(&f, &md5));
    var s = try f.db.prepare(
        "SELECT has_ink FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    try std.testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 1), s.columnInt(0)); // scanned: really inked
    try std.testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 0), s.columnInt(0)); // untouched, wrong and left alone
}

test "INK: a trashed note is not offered, and neither is a `.txt` or a `.pdf`" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.note", sample2_note);
    _ = try f.put("notes.txt", two_paragraphs);
    _ = try f.put("doc.pdf", rotate90_pdf);
    f.drain(); // clear the other two tenants' work

    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try f.db.exec("UPDATE files SET deleted = 1 WHERE name = 'notes.note';");
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE name = 'notes.note';");
    const found = (try nextJob(testing.allocator, f.db)).?;
    defer testing.allocator.free(found.name);
    try std.testing.expectEqualStrings(&md5, &found.md5);
    try std.testing.expectEqualStrings("ink", found.tenant.name);
}

test "INK: `pending_sql` and `inkNeedsScan` agree, on both sides of the work" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.note", sample2_note);
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try std.testing.expect(try inkscan.inkNeedsScan(f.db, &md5));

    f.drain();

    try std.testing.expect(!try inkscan.inkNeedsScan(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

// ---- reconcile ----

/// Two pages, page 0 recognised.
const sample2_note = @embedFile("sample-2.note");

test "RECONCILE: an ALREADY-INDEXED .txt gets its files, and a drain cannot give them" {
    // A library indexed before the derived stores existed owes no tenant work.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    f.drain(); // a worker with no stores wired
    try testing.expect(try f.txtDone(&md5));
    try testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };

    w.drain();
    try testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
    try testing.expect(!s.terms.has(&md5, derivesearch.index_version));

    w.reconcileDerived();

    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, s.terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":2") != null);
    try testing.expectEqualStrings(
        "{\"p\":0,\"t\":\"first in it paragraph with words\"}",
        lines.next().?,
    );
    try testing.expectEqualStrings(
        "{\"p\":1,\"t\":\"also paragraph second with words\"}",
        lines.next().?,
    );
    try testing.expect(lines.next() == null);
}

test "RECONCILE: a .note gets its files, which NOTHING else in the worker can do" {
    // A `.note` has no tenant: pre-store or dedup re-linked notes are reached only here.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("n.note", sample2_note);
    f.drain();
    try testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();

    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, s.terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":2") != null);
    try testing.expect(std.mem.startsWith(u8, lines.next().?, "{\"p\":0,\"t\":\""));
    try testing.expect(lines.next() == null);
}

test "RECONCILE: a .pdf gets its files through the chunked source" {
    // Drives the PDF page source without `runPdfText`'s `any_text` shortcut.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.pdf", book_pdf);
    f.drain();
    try testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();

    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, s.terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":120") != null);
    var seen: usize = 0;
    while (lines.next()) |line| : (seen += 1) {
        var buf: [64]u8 = undefined;
        try testing.expectEqualStrings(
            try std.fmt.bufPrint(&buf, "{{\"p\":{d},\"t\":\"{d} leaf{d:0>3} recipe rutabaga\"}}", .{ seen, seen, seen }),
            line,
        );
    }
    try testing.expectEqual(@as(usize, 120), seen); // past both chunk boundaries
}

test "RECONCILE: a document that HAS its files is not derived again" {
    // Files overwritten with a sentinel a re-derive would destroy.
    var f = try Fixture.init();
    defer f.deinit();

    const s = try f.stores();
    const md5 = try f.put("notes.txt", two_paragraphs);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.drain(); // the tenant writes them on the way past
    try testing.expect(s.terms.has(&md5, derivesearch.index_version));

    const sentinel = "not a fragment";
    try s.terms.put(&md5, derivesearch.index_version, sentinel);
    try s.text.put(&md5, derivesearch.index_version, sentinel);

    w.reconcileDerived();

    for ([_]derivedstore.DerivedStore{ s.terms, s.text }) |store| {
        const got = try rawStored(store, &md5);
        defer testing.allocator.free(got);
        try testing.expectEqualStrings(sentinel, got);
    }
}

test "RECONCILE: a HALF-WRITTEN pair is completed — terms alone is not derived" {
    var f = try Fixture.init();
    defer f.deinit();

    const s = try f.stores();
    const md5 = try f.put("notes.txt", two_paragraphs);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.drain();
    s.text.remove(&md5, derivesearch.index_version); // the torn commit

    w.reconcileDerived();

    try testing.expect(s.text.has(&md5, derivesearch.index_version));
    const x = try derivedstore.readPlain(testing.allocator, s.text, &md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    try testing.expect(std.mem.indexOf(u8, x, "First paragraph") != null);
}

test "RECONCILE: null stores are a no-op, not an error" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("notes.txt", two_paragraphs);
    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.reconcileDerived();
    try testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "RECONCILE: the bin is not a backfill queue either" {
    var f = try Fixture.init();
    defer f.deinit();

    const s = try f.stores();
    const md5 = try f.put("notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");

    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();
    try testing.expect(!s.terms.has(&md5, derivesearch.index_version));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    w.reconcileDerived();
    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
}

test "RECONCILE: the cursor visits EVERY document, and a second pass reads no blob" {
    var f = try Fixture.init();
    defer f.deinit();

    const txt = try f.put("notes.txt", two_paragraphs);
    const note = try f.put("n.note", sample2_note);
    const pdf = try f.put("doc.pdf", rotate90_pdf);
    f.drain();

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();

    for ([_][32]u8{ txt, note, pdf }) |md5| {
        try testing.expect(s.terms.has(&md5, derivesearch.index_version));
        try testing.expect(s.text.has(&md5, derivesearch.index_version));
    }

    const sentinel = "still here";
    try s.terms.put(&txt, derivesearch.index_version, sentinel);
    w.reconcileDerived();
    const got = try rawStored(s.terms, &txt);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(sentinel, got);
}

test "RECONCILE: the SQL compiles, and carries NO index state" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    const s = try db.prepare(reconcile_sql);
    s.finalize();

    try testing.expect(std.mem.indexOf(u8, reconcile_sql, "LIKE '%_.txt'") != null);
    try testing.expect(std.mem.indexOf(u8, reconcile_sql, "LIKE '%_.pdf'") != null);
    try testing.expect(txtindex.wants("a.txt") and pdfindex.wants("a.pdf"));
    try testing.expect(!txtindex.wants(".txt") and !pdfindex.wants(".pdf"));
    for ([_][]const u8{ "txt_index", "pdf_probe", "pdf_text" }) |column| {
        try testing.expect(std.mem.indexOf(u8, reconcile_sql, column) == null);
    }
}

/// Raw on-disk bytes, no header skip or inflate.
fn rawStored(store: derivedstore.DerivedStore, md5: []const u8) ![]u8 {
    var file = try store.open(md5, derivesearch.index_version);
    defer file.close(store.io);
    var buf: [1 << 12]u8 = undefined;
    const n = try file.readPositionalAll(store.io, &buf, 0);
    return testing.allocator.dupe(u8, buf[0..n]);
}
