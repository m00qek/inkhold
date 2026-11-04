//! Per-request context passed to every handler.

const std = @import("std");
const config = @import("../config.zig");
const authsvc = @import("../services/auth/service.zig");
const router = @import("router.zig");
const ratelimit = @import("ratelimit.zig");
const download_tokens = @import("download_tokens.zig");
const event_streams = @import("event_streams.zig");
const filesmod = @import("../services/files.zig");
const lock_stats = @import("lock_stats.zig");
const reader_pool = @import("../db/reader_pool.zig");
const pending = @import("../services/pending.zig");
const authscope = @import("../services/auth/scope.zig");

pub const session_cookie_name = "sn_session";

/// Defined by the auth service (`services/auth/scope.zig`); re-exported so
/// handlers and the router read them from the request context.
pub const Scope = authscope.Scope;
pub const Caller = authscope.Caller;

pub const Context = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    config: config.Config,
    service: ?*authsvc.Service = null,
    files: ?*filesmod.Files = null,
    limiter: ?*ratelimit.Limiter = null,
    download_tokens: ?*download_tokens.DownloadTokens = null,
    /// SSE admission control. Null means never hold a connection: the events
    /// handler sends one frame and returns (the single-threaded test harness).
    event_streams: ?*event_streams.EventStreams = null,
    /// Backs the `event: index` frame; null means the frame is omitted. Takes
    /// `db_lock` itself rather than via `lockDb`, so it stays out of the
    /// per-route histogram.
    pending: ?*pending.Pulse = null,
    /// The caller's formatted IP, per connection.
    client_ip: ?[]const u8 = null,
    /// Serializes the single shared writer connection across connection
    /// threads; null in single-threaded tests.
    db_lock: ?*std.Io.Mutex = null,
    /// Read-only connections for `read_only` routes. Null means no pool, not
    /// broken: `borrowReader` returns null and dispatch uses the writer.
    readers: ?*reader_pool.Pool = null,
    /// Per-route `db_lock` hold histogram. Needs no lock of its own because it
    /// is written only from `unlockDb` while `db_lock` is held.
    lock_stats: ?*lock_stats.LockStats = null,
    /// Carried here so the health handler needn't import `routes.zig`, which
    /// would close an import cycle.
    routes: []const router.Route = &.{},
    /// The route being served, for lock attribution; null when nothing matched.
    route_idx: ?usize = null,
    /// When the held `db_lock` window began. One field serves both
    /// `dispatchLocked` and `manual_db_lock` handlers, which can't overlap.
    lock_started: ?std.Io.Timestamp = null,
    /// When the held reader lease began. Separate from `lock_started` because a
    /// `read_only` request holds a reader while briefly taking `db_lock`.
    read_started: ?std.Io.Timestamp = null,
    /// Borrow wait, carried to `returnReader` so a borrow is one sample.
    read_wait_ns: u64 = 0,
    caller: ?Caller = null,

    /// Acquires `db_lock` (no-op when null). Not reentrant: only
    /// `manual_db_lock` handlers may call it; others already run under the lock.
    pub fn lockDb(self: *Context) void {
        if (self.db_lock) |l| l.lockUncancelable(self.io);
        // Stamp after the acquire: this measures hold time, not wait.
        if (self.lock_stats != null) self.lock_started = std.Io.Clock.awake.now(self.io);
    }

    /// Releases the lock taken by `lockDb`.
    pub fn unlockDb(self: *Context) void {
        // Record before unlocking: the counters rely on `db_lock` for exclusion.
        if (self.lock_stats) |st| {
            if (self.lock_started) |t0| {
                const held = t0.untilNow(self.io, .awake).toNanoseconds();
                st.record(self.route_idx, @intCast(@max(held, 0)));
                self.lock_started = null;
            }
        }
        if (self.db_lock) |l| l.unlock(self.io);
    }

    /// Borrows a pooled reader, or null when there is no pool or all are busy,
    /// meaning use the writer. Paired with `returnReader` for measurement.
    pub fn borrowReader(self: *Context) ?reader_pool.Lease {
        const pool = self.readers orelse {
            // Not a fallback: `fallback_count` means the pool was too small.
            return null;
        };
        const t0 = if (self.lock_stats != null) std.Io.Clock.awake.now(self.io) else null;
        const lease = pool.acquire() orelse {
            if (self.lock_stats) |st| st.recordFallback(self.route_idx);
            return null;
        };
        if (t0) |start| {
            // Recorded on return, so one borrow is one histogram sample.
            const waited = start.untilNow(self.io, .awake).toNanoseconds();
            self.read_wait_ns = @intCast(@max(waited, 0));
            self.read_started = std.Io.Clock.awake.now(self.io);
        }
        return lease;
    }

    /// Returns a lease, recording wait plus hold as one window. Exactly once
    /// per non-null borrow.
    pub fn returnReader(self: *Context, lease: reader_pool.Lease) void {
        if (self.lock_stats) |st| {
            if (self.read_started) |t0| {
                const held = t0.untilNow(self.io, .awake).toNanoseconds();
                st.recordRead(self.route_idx, self.read_wait_ns, @intCast(@max(held, 0)));
                self.read_started = null;
                self.read_wait_ns = 0;
            }
        }
        (self.readers orelse return).release(lease);
    }
};
