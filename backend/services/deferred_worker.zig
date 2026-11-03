//! The deferred worker thread: its loop, wakeups, and the synchronous drain.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const derivedstore = @import("../store/derived.zig");
const derivesearch = @import("derive_search.zig");
const noteindex = @import("note_index.zig");
const log = std.log.scoped(.deferred);
const deferred = @import("deferred.zig");
const Candidate = deferred.Candidate;
const Found = deferred.Found;
const deriveOne = deferred.deriveOne;
const discovery = deferred.discovery;
const idle_tick_ns = deferred.idle_tick_ns;
const nextJob = deferred.nextJob;
const reconcile_sql = deferred.reconcile_sql;
const tenants = deferred.tenants;

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
pub fn nice19() void {
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
