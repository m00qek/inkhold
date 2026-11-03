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

test {
    _ = @import("deferred/tenant_test.zig");
    _ = @import("deferred/ink_test.zig");
    _ = @import("deferred/reconcile_test.zig");
}

// ---- tests of private helpers ----

const schema = @import("../db/schema.zig");
const testing = std.testing;
const fixture = @import("deferred/fixture.zig");
const Fixture = fixture.Fixture;
const two_paragraphs = fixture.two_paragraphs;
const rotate90_pdf = fixture.rotate90_pdf;

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
