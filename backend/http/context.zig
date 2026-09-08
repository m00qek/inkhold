//! Per-request context passed to every route handler, plus the auth types that
//! define which callers may reach which routes.

const std = @import("std");
const config = @import("../config.zig");
const service = @import("../services/auth/service.zig");
const router = @import("router.zig");
const ratelimit = @import("ratelimit.zig");
const download_tokens = @import("download_tokens.zig");
const event_streams = @import("event_streams.zig");
const files = @import("../services/files.zig");
const lock_stats = @import("lock_stats.zig");
const reader_pool = @import("../db/reader_pool.zig");
const pending = @import("../services/pending.zig");

/// Name of the HttpOnly session cookie carrying a control-plane session token.
pub const session_cookie_name = "sn_session";

/// Audience of a route / caller. The device and control-plane faces share one
/// login flow but get separate, non-interchangeable authority:
///   - `device`       — the sync/file/oss API, reached via `x-access-token`.
///   - `controlplane` — the browser API, reached via the session cookie.
///   - `public`       — no authentication required (login, version, etc.); a
///     route scope only, never a caller audience.
///   - `pending`      — a limited token issued at first login: reachable only by
///     routes that list `.pending` in their scope set (the change-password route).
///
/// A `Route` lists the *set* of scopes it accepts (e.g. `&.{.controlplane, .pending}`);
/// a caller's `audience` is always `controlplane`, `device`, or `pending`.
pub const Scope = enum { public, device, controlplane, pending };

/// An authenticated caller, resolved from a valid session.
pub const Caller = struct {
    user_id: u64,
    audience: Scope,
    /// Whether the account is an administrator (for `require_admin` routes).
    is_admin: bool = false,
    /// Whether this SESSION currently holds admin elevation — i.e. the password
    /// was re-entered recently enough (see `services/auth/service.zig`'s
    /// `elevation_idle_s` / `elevation_absolute_s`). Resolved per request from the
    /// session row, so it lapses on its own with no sweep.
    ///
    /// `is_admin` says who you ARE; this says whether you have proved it JUST NOW.
    /// Every `require_admin` route needs both — that is the whole point of the
    /// re-auth gate, since a tablet left unlocked on a table carries `is_admin`
    /// perfectly well.
    elevated: bool = false,
    /// Device serial for `device` callers, stored INLINE (a copy, not a slice into
    /// the request head buffer — `json.readBody` invalidates head strings, and a
    /// Caller outlives its resolve). `equipment_len == 0` means none. Read it via
    /// `equipmentNo()`, which recomputes the slice from the struct's own storage so
    /// it survives the copies a Caller makes on its way to `ctx.caller`.
    equipment_buf: [max_equipment_len]u8 = undefined,
    equipment_len: usize = 0,

    pub const max_equipment_len = 64;

    /// The device serial, or null for a non-device caller.
    pub fn equipmentNo(self: *const Caller) ?[]const u8 {
        return if (self.equipment_len == 0) null else self.equipment_buf[0..self.equipment_len];
    }
};

pub const Context = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    config: config.Config,
    /// The auth/data service, shared across requests. Set at startup.
    service: ?*service.Service = null,
    /// The file-tree service (tree/blob storage), shared across requests. Set at
    /// startup; used by the device sync + control-plane file faces.
    files: ?*files.Files = null,
    /// The rate limiter, shared across requests. Set at startup.
    limiter: ?*ratelimit.Limiter = null,
    /// Short-TTL, file-scoped download capability tokens for the URL-authed
    /// `/oss/get` path (the device sends no bearer token there). Set at startup.
    download_tokens: ?*download_tokens.DownloadTokens = null,
    /// Admission control + timing knobs for the held SSE streams on
    /// `/api/controlplane/events`. Set at startup by `transport.run`.
    ///
    /// **Null means "do not hold a connection"** — the events handler then emits
    /// its historical one-shot frame and returns. That is what keeps every
    /// single-threaded caller (the integration harness, which drives `handle()`
    /// over in-memory buffers with no thread to park) working unchanged, and it
    /// makes "hold a connection open" an explicitly opted-into capability of
    /// serve mode rather than something a handler can decide alone.
    event_streams: ?*event_streams.EventStreams = null,
    /// The shared "how much is still being indexed" answer, behind the live
    /// channel's `event: index` frame. Set at startup by `app.run`.
    ///
    /// **Null means "say nothing about indexing"** — the frame is simply not
    /// emitted, exactly as a null `event_streams` means "do not hold a
    /// connection". That is what keeps the integration harness (no worker, no
    /// threads) working unchanged, and it makes an absent frame a legible "this
    /// server does not report it" rather than a claim that nothing is pending.
    ///
    /// Takes `db_lock` ITSELF rather than through `lockDb`, like the deferred
    /// worker does, so its windows do not appear in the per-route histogram.
    /// Acceptable because they are rare (see `pending.Pulse`) and because
    /// attributing them to whichever stream happened to trigger the count would
    /// be worse than not attributing them at all.
    pending: ?*pending.Pulse = null,
    /// The caller's IP (formatted), set per connection; null if unavailable.
    client_ip: ?[]const u8 = null,
    /// Serializes access to the single shared SQLite connection across the
    /// per-connection threads serve mode spawns. Shared across threads via this
    /// pointer; null in the single-threaded integration tests, which drive
    /// `handle()` directly and need no lock. See transport.dispatchLocked.
    db_lock: ?*std.Io.Mutex = null,
    /// Bounded pool of `SQLITE_OPEN_READONLY` connections that `read_only` routes
    /// run on instead of holding `db_lock` (see db/reader_pool.zig). Shared across
    /// threads via this pointer.
    ///
    /// **Null means "no pool", not "broken"**: `borrowReader` then answers null
    /// exactly as an exhausted pool does, and dispatch falls back to the writer
    /// under `db_lock` — which is the whole server before this existed. That is
    /// what keeps the single-threaded integration harness and the CLI working
    /// with no pool at all.
    readers: ?*reader_pool.Pool = null,
    /// Per-route hold-time histogram for `db_lock`, reported by
    /// `GET /api/admin/health`. Shared across threads via this pointer, and safe
    /// without synchronization of its own for one reason only: it is written
    /// exclusively from `unlockDb` below, with the lock still held. See
    /// http/lock_stats.zig. Null = not measuring (the integration tests).
    lock_stats: ?*lock_stats.LockStats = null,
    /// The route table being served. Carried on the context so the health
    /// handler can name the routes its lock histogram is indexed by WITHOUT
    /// importing `routes.zig` — which imports every handler, this one included,
    /// and would close an import cycle through the module that defines the table.
    routes: []const router.Route = &.{},
    /// Index into the route table of the route being served, set by
    /// `transport.dispatchLocked` before it locks. Attributes each lock window to
    /// a route; null when nothing matched.
    route_idx: ?usize = null,
    /// When the currently-held `db_lock` window was acquired. Thread-local
    /// (`Context` is copied per connection), so the two ways the lock is taken —
    /// `dispatchLocked`'s whole-handler window and a `manual_db_lock` handler's
    /// own narrow ones — can share one field: they are mutually exclusive, since
    /// the mutex is not reentrant.
    lock_started: ?std.Io.Timestamp = null,
    /// When the currently-held reader lease was taken. The `lock_started` twin
    /// for the pooled path, and a SEPARATE field on purpose: a `read_only`
    /// request takes a short `db_lock` window for `resolveCaller` and then holds
    /// a reader across the handler, so the two really can be live at once — which
    /// is precisely the thing that is not true of the lock.
    read_started: ?std.Io.Timestamp = null,
    /// How long the current lease took to borrow, carried from `borrowReader` to
    /// `returnReader` so the whole borrow is one sample. Thread-local like
    /// `lock_started`.
    read_wait_ns: u64 = 0,
    /// Set per request by the router before the handler runs.
    caller: ?Caller = null,

    /// Acquire the shared DB lock, if one is set. A null `db_lock` (the
    /// single-threaded integration tests) makes both calls no-ops, so callers can
    /// bracket a DB touch unconditionally.
    ///
    /// NOT REENTRANT — `std.Io.Mutex` is a bare futex with no owner tracking, so a
    /// second acquire on the same thread deadlocks. Only a `manual_db_lock` route's
    /// handler may call these; every other handler already runs with the lock held
    /// by `transport.handle`.
    ///
    /// Takes `*Context` rather than `*const Context` because the window's start is
    /// stamped here: measuring the lock at the ONE pair of functions that take it
    /// is what makes the `manual_db_lock` handlers' own windows measurable without
    /// touching a single handler.
    pub fn lockDb(self: *Context) void {
        if (self.db_lock) |l| l.lockUncancelable(self.io);
        // AFTER the acquire, never before: what this measures is how long the lock
        // is HELD (the thing that sets the server's ceiling), not how long this
        // thread waited for it (a consequence of the first, and already visible in
        // the request latency).
        if (self.lock_stats != null) self.lock_started = std.Io.Clock.awake.now(self.io);
    }

    /// Release the shared DB lock taken by `lockDb`. Pair them with `defer` in a
    /// block so the window is exactly the DB touch and nothing else.
    pub fn unlockDb(self: *Context) void {
        // Record BEFORE unlocking. The counters carry no lock of their own, and
        // this is the entire reason that is safe: the write happens inside the
        // critical section, so `db_lock` is already excluding every other writer.
        // Moving this below the unlock would be a data race, and adding a mutex to
        // fix it would serialize on the very resource being measured.
        if (self.lock_stats) |st| {
            if (self.lock_started) |t0| {
                const held = t0.untilNow(self.io, .awake).toNanoseconds();
                st.record(self.route_idx, @intCast(@max(held, 0)));
                self.lock_started = null;
            }
        }
        if (self.db_lock) |l| l.unlock(self.io);
    }

    /// Borrow a pooled reader for ONE operation, or null when there is no pool or
    /// every reader is busy. Null means "use the writer under `db_lock`" — see
    /// `db/reader_pool.zig`; it is never an error.
    ///
    /// Paired with `returnReader` for the same reason `lockDb`/`unlockDb` are
    /// paired: measuring at the one pair of functions that take the resource is
    /// what makes every borrow visible without touching a handler. Without it a
    /// pooled route would simply VANISH from the per-route histogram, which reads
    /// as a fix and is a blind spot (see http/lock_stats.zig).
    pub fn borrowReader(self: *Context) ?reader_pool.Lease {
        const pool = self.readers orelse {
            // No pool configured is not a fallback anybody can tune, so it is not
            // counted as one: `fallback_count` must mean "the pool was too small".
            return null;
        };
        const t0 = if (self.lock_stats != null) std.Io.Clock.awake.now(self.io) else null;
        const lease = pool.acquire() orelse {
            if (self.lock_stats) |st| st.recordFallback(self.route_idx);
            return null;
        };
        if (t0) |start| {
            // Wait is carried to `returnReader` rather than recorded here: one
            // borrow must be ONE sample in the route's distribution, and a second
            // record with a zero hold would put a phantom 0 ns window in the
            // histogram every time a reader was taken.
            const waited = start.untilNow(self.io, .awake).toNanoseconds();
            self.read_wait_ns = @intCast(@max(waited, 0));
            self.read_started = std.Io.Clock.awake.now(self.io);
        }
        return lease;
    }

    /// Return a reader borrowed by `borrowReader`, recording the whole borrow —
    /// wait plus hold — as one window. Exactly one call per non-null borrow.
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
