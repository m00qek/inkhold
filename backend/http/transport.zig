//! HTTP(S) transport: the accept loop, the poller/worker machinery around a
//! connection (`conn.zig`, `poller.zig`, `pool.zig`), caller resolution, and
//! dispatch under the route table's `db_lock` policy.
const std = @import("std");
const tls = @import("tls");
const config = @import("../config.zig");
const router = @import("router.zig");
const context = @import("context.zig");
const Context = context.Context;
const sqlite = @import("../db/sqlite.zig");
const schema = @import("../db/schema.zig");
const authsvc = @import("../services/auth/service.zig");
const ratelimit = @import("ratelimit.zig");
const dltokens = @import("download_tokens.zig");
const eventstreams = @import("event_streams.zig");
const lockstats = @import("lock_stats.zig");
const filesmod = @import("../services/files.zig");
const settingsmod = @import("../services/settings.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");

const Io = std.Io;
const log = std.log.scoped(.http);
const conn_mod = @import("conn.zig");
const Conn = conn_mod.Conn;
const Poller = @import("poller.zig").Poller;
const Pool = @import("pool.zig").Pool;

pub const Error = error{UnknownCipherSuite} || std.mem.Allocator.Error;

/// Stack per worker and per held-stream thread, set empirically: static frame
/// sums (~281 KB, mostly `ossPut` and `multipart.extract` buffers) badly
/// under-predict, and a live 32 MB upload put the real floor between 512 KiB
/// (SIGSEGV) and 576 KiB. Re-bisect against a real transfer if those frames
/// change. Only `workers + max_held` threads reserve it.
pub const conn_stack_size = 1024 * 1024;

/// A counted cap: open sockets, or held-stream threads. One missed `release`
/// drifts the count until everything is refused.
pub const ConnLimiter = struct {
    active: std.atomic.Value(u32) = .init(0),
    max: u32,

    pub fn init(max: u32) ConnLimiter {
        return .{ .max = max };
    }

    /// Reserves a slot, or false at capacity. On true the caller must `release`
    /// exactly once.
    pub fn tryAcquire(self: *ConnLimiter) bool {
        var cur = self.active.load(.monotonic);
        while (true) {
            if (cur >= self.max) return false;
            // CAS rather than fetchAdd-then-check: no overshoot, no compensating
            // decrement to leak.
            cur = self.active.cmpxchgWeak(cur, cur + 1, .acquire, .monotonic) orelse return true;
        }
    }

    pub fn release(self: *ConnLimiter) void {
        const prev = self.active.fetchSub(1, .release);
        std.debug.assert(prev != 0);
    }

    pub fn count(self: *const ConnLimiter) u32 {
        return self.active.load(.monotonic);
    }
};

test "ConnLimiter: admits up to the cap, refuses beyond it, and balances back to zero" {
    var l: ConnLimiter = .init(3);
    try std.testing.expectEqual(@as(u32, 0), l.count());

    for (0..3) |_| try std.testing.expect(l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 3), l.count());

    for (0..10) |_| try std.testing.expect(!l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 3), l.count());

    l.release();
    try std.testing.expectEqual(@as(u32, 2), l.count());
    try std.testing.expect(l.tryAcquire());
    try std.testing.expect(!l.tryAcquire());

    l.release();
    l.release();
    l.release();
    try std.testing.expectEqual(@as(u32, 0), l.count());
    for (0..3) |_| try std.testing.expect(l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 3), l.count());
    for (0..3) |_| l.release();
    try std.testing.expectEqual(@as(u32, 0), l.count());
}

test "ConnLimiter: a slot is returned even when the connection handler fails" {
    var l: ConnLimiter = .init(2);
    const serveOne = struct {
        fn run(lim: *ConnLimiter, fail: bool) !void {
            try std.testing.expect(lim.tryAcquire());
            defer lim.release();
            if (fail) return error.ConnectionReset;
        }
    }.run;

    for (0..50) |i| {
        serveOne(&l, i % 2 == 0) catch {};
        try std.testing.expectEqual(@as(u32, 0), l.count());
    }

    try std.testing.expect(l.tryAcquire());
    try std.testing.expect(l.tryAcquire());
    try std.testing.expect(!l.tryAcquire());
    l.release();
    l.release();
    try std.testing.expectEqual(@as(u32, 0), l.count());
}

test "ConnLimiter: a zero cap refuses everything without underflowing" {
    var l: ConnLimiter = .init(0);
    try std.testing.expect(!l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 0), l.count());
}

/// The serving machinery, alive for the process: the acceptor (this thread)
/// hands sockets to the poller, the poller hands readable ones to the pool, a
/// worker serves and hands the socket back or closes it. A request on a
/// `held` route gets a thread of its own, as every connection once did.
/// Memory therefore follows requests in flight, not open sockets.
pub const Serve = struct {
    gpa: std.mem.Allocator,
    io: Io,
    /// The template every worker copies per request: `client_ip`, `caller` and
    /// the lock bookkeeping are per request.
    ctx: *Context,
    routes: []const router.Route,
    tls_opts: conn_mod.TlsOptions,
    /// Open sockets: parked, in a worker, or held.
    sockets: ConnLimiter,
    /// Threads given to held streams, beyond the workers.
    held: ConnLimiter,
    poller: Poller,
    pool: Pool,

    /// A worker's turn with `conn`.
    pub fn work(self: *Serve, conn: *Conn) void {
        var local = self.ctx.*;
        switch (conn.serve(&local, self.routes, self.tls_opts)) {
            .park => self.poller.park(conn),
            .close => self.finish(conn),
            .held => |req| self.hold(conn, req),
        }
    }

    /// Closes and frees `conn` and returns its socket slot.
    pub fn finish(self: *Serve, conn: *Conn) void {
        conn.destroy(self.gpa);
        self.sockets.release();
    }

    /// Gives a held stream its own thread. Over the cap, or with no thread to
    /// be had, the connection is dropped rather than parked on a worker for
    /// minutes; an `EventSource` reconnects after `retry:`.
    fn hold(self: *Serve, conn: *Conn, req: router.Request) void {
        if (!self.held.tryAcquire()) {
            log.warn("at max_held ({d}); dropping a stream", .{self.held.max});
            self.finish(conn);
            return;
        }
        const t = std.Thread.spawn(.{ .stack_size = conn_stack_size }, heldThread, .{ self, conn, req }) catch |err| {
            self.held.release();
            log.warn("thread spawn failed ({t}); dropping a stream", .{err});
            self.finish(conn);
            return;
        };
        t.detach();
    }

    /// Runs the held request to its end, then closes: a stream never keeps alive.
    fn heldThread(self: *Serve, conn: *Conn, req_in: router.Request) void {
        defer self.held.release();
        var req = req_in;
        var local = self.ctx.*;
        local.client_ip = conn.clientIp(local.config.trusted_proxy, &req);
        handle(&local, self.routes, &req) catch |err| log.warn("connection error: {t}", .{err});
        self.finish(conn);
    }
};

/// The accept loop. Never returns on success.
pub fn listenAndServe(
    io: Io,
    cfg: config.Config,
    routes: []const router.Route,
    ctx: *Context,
    auth_ptr: ?*tls.config.CertKeyPair,
    ciphers: []const tls.config.CipherSuite,
    rng: std.Random,
) !void {
    const address = try Io.net.IpAddress.parse(cfg.host, cfg.port);
    var listener = try address.listen(io, .{ .mode = .stream, .reuse_address = true });
    defer listener.deinit(io);

    // Self-referential through the poller and the pool, so it never moves:
    // this frame lives as long as the process.
    var serve: Serve = .{
        .gpa = ctx.gpa,
        .io = io,
        .ctx = ctx,
        .routes = routes,
        .tls_opts = .{ .auth = auth_ptr, .ciphers = ciphers, .rng = rng },
        .sockets = .init(cfg.max_connections),
        .held = .init(cfg.max_held),
        .poller = undefined,
        .pool = undefined,
    };
    serve.poller = try Poller.init(io, ctx.gpa, &serve, cfg.idle_timeout_s);
    serve.pool = .{ .io = io, .gpa = ctx.gpa, .serve = &serve };
    try serve.pool.start(cfg.workers);
    try serve.poller.start();

    log.info("listening on {s}://{s}:{d} ({d} workers)", .{
        if (cfg.tls.enabled) "https" else "http", cfg.host, cfg.port, cfg.workers,
    });

    var refusing = false; // log once per over-capacity episode
    while (true) {
        const stream = listener.accept(io) catch |err| {
            log.warn("accept failed: {t}", .{err});
            continue;
        };
        // Over the cap, close immediately and keep accepting.
        if (!serve.sockets.tryAcquire()) {
            stream.close(io);
            if (!refusing) {
                refusing = true;
                log.warn("at max_connections ({d}); refusing new connections until one closes", .{cfg.max_connections});
            }
            continue;
        }
        refusing = false;
        const conn = Conn.create(ctx.gpa, io, stream, cfg.tls.enabled) catch |err| {
            serve.sockets.release();
            stream.close(io);
            log.warn("connection refused ({t})", .{err});
            continue;
        };
        // Straight to the poller: the first request is read once bytes arrive,
        // so a silent connect holds no worker.
        serve.poller.park(conn);
    }
}

/// Resolves the caller and dispatches one request. Public so integration tests
/// can drive it without a socket.
pub fn handle(ctx: *Context, routes: []const router.Route, req: *router.Request) !void {
    // std.http's `discardBody` asserts a body-bearing method has framing, so a
    // POST with neither Content-Length nor Transfer-Encoding (`curl -X POST`)
    // would panic the thread on any early response. The assert is behind
    // keep-alive, so drop keep-alive for such a request.
    if (req.head.method.requestHasBody() and
        req.head.content_length == null and
        req.head.transfer_encoding == .none)
    {
        req.head.keep_alive = false;
    }
    return dispatchLocked(ctx, routes, req);
}

/// Dispatches under the route's `db_lock` policy. Default: hold the lock
/// across `resolveCaller` and the whole handler. `manual_db_lock`, `read_only`
/// and no-match (404/static) hold it only for `resolveCaller`; `read_only` then
/// runs on a pooled reader (WAL serves concurrent readers), falling back to the
/// writer when the pool is empty.
fn dispatchLocked(ctx: *Context, routes: []const router.Route, req: *router.Request) !void {
    const idx = router.matchedIndex(routes, req);
    // Set before any lock so every window, including a manual handler's own,
    // is attributed.
    ctx.route_idx = idx;
    ctx.routes = routes;
    const route = if (idx) |i| &routes[i] else null;
    const manual = if (route) |r| r.manual_db_lock else false;
    const admin_route = if (route) |r| r.require_admin else false;
    // Banned at comptime in `routes.zig`; asserted here for test tables.
    std.debug.assert(!(manual and admin_route));
    const read_only = if (route) |r| r.read_only else false;
    std.debug.assert(!(read_only and (manual or admin_route)));
    if (manual) {
        const caller = blk: {
            ctx.lockDb();
            defer ctx.unlockDb();
            break :blk resolveCaller(ctx.service, req);
        };
        return router.dispatch(routes, ctx, req, caller);
    }
    if (read_only or route == null) {
        // The session read runs on the writer, before any reader is borrowed.
        const caller = blk: {
            ctx.lockDb();
            defer ctx.unlockDb();
            break :blk resolveCaller(ctx.service, req);
        };
        if (route == null) return router.dispatch(routes, ctx, req, caller);
        return dispatchReadOnly(ctx, routes, req, caller);
    }
    ctx.lockDb();
    defer ctx.unlockDb();
    const caller = resolveCaller(ctx.service, req);
    if (admin_route) renewElevation(ctx, req);
    try router.dispatch(routes, ctx, req, caller);
}

/// Runs a `read_only` handler on a borrowed reader by swapping `ctx.files` and
/// `ctx.service` for reader-bound copies, restored afterwards because keep-alive
/// reuses the `Context`. Without a reader, runs under `db_lock` on the writer.
fn dispatchReadOnly(
    ctx: *Context,
    routes: []const router.Route,
    req: *router.Request,
    caller: ?router.Caller,
) !void {
    const lease = ctx.borrowReader() orelse {
        ctx.lockDb();
        defer ctx.unlockDb();
        return router.dispatch(routes, ctx, req, caller);
    };
    defer ctx.returnReader(lease);

    const saved_files = ctx.files;
    const saved_service = ctx.service;
    defer {
        ctx.files = saved_files;
        ctx.service = saved_service;
    }
    var ro_files = saved_files.readerView(lease.db);
    var ro_service = saved_service.readerView(lease.db);
    ctx.files = &ro_files;
    ctx.service = &ro_service;
    return router.dispatch(routes, ctx, req, caller);
}

/// Slides the caller's admin elevation forward on `require_admin` routes.
/// Runs before `authorize`, which is safe because it only extends a live
/// elevation and clamps to the hard ceiling. Best-effort.
fn renewElevation(ctx: *Context, req: *router.Request) void {
    const svc = ctx.service;
    const token = presentedToken(req) orelse return;
    _ = svc.renewElevation(token) catch return;
}

/// The device `x-access-token` header, else the session cookie.
pub fn presentedToken(req: *router.Request) ?[]const u8 {
    var cookie_header: ?[]const u8 = null;
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, "x-access-token")) return h.value;
        if (std.ascii.eqlIgnoreCase(h.name, "cookie")) cookie_header = h.value;
    }
    if (cookie_header) |ch| return cookieValue(ch, context.session_cookie_name);
    return null;
}

/// Resolves the caller from the session store; the stored audience, not the
/// channel, governs authority. Fails closed on lookup errors.
fn resolveCaller(svc: *authsvc.Service, req: *router.Request) ?router.Caller {
    const t = presentedToken(req) orelse return null;
    var who = (svc.caller(t) catch |err| {
        log.warn("resolveCaller: session lookup failed: {t}", .{err});
        return null;
    }) orelse return null;
    if (who.audience == .device) {
        // Copy the serial now: `json.readBody` overwrites the head buffer.
        who.equipment_len = router.headerCopy(req, "equipmentno", &who.equipment_buf).len;
    }
    return who;
}

/// Cookie `name` from a `Cookie` header value, or null.
fn cookieValue(header: []const u8, name: []const u8) ?[]const u8 {
    var it = std.mem.splitScalar(u8, header, ';');
    while (it.next()) |pair| {
        const kv = std.mem.trim(u8, pair, " \t");
        const eq = std.mem.indexOfScalar(u8, kv, '=') orelse continue;
        if (std.mem.eql(u8, kv[0..eq], name)) return kv[eq + 1 ..];
    }
    return null;
}

pub fn resolveCiphers(gpa: std.mem.Allocator, names: []const []const u8) Error![]const tls.config.CipherSuite {
    if (names.len == 0) return tls.config.cipher_suites.tls13;
    const out = try gpa.alloc(tls.config.CipherSuite, names.len);
    errdefer gpa.free(out);
    for (names, out) |name, *slot| {
        slot.* = std.meta.stringToEnum(tls.config.CipherSuite, name) orelse return error.UnknownCipherSuite;
    }
    return out;
}

test "cookieValue extracts a named cookie, tolerating spaces" {
    const eq = std.testing.expectEqualStrings;
    try eq("abc123", cookieValue("sn_session=abc123", "sn_session").?);
    try eq("abc123", cookieValue("theme=dark; sn_session=abc123; lang=en", "sn_session").?);
    try eq("abc123", cookieValue("theme=dark;  sn_session=abc123", "sn_session").?);
    try std.testing.expect(cookieValue("theme=dark; lang=en", "sn_session") == null);
    try std.testing.expect(cookieValue("", "sn_session") == null);
    try std.testing.expect(cookieValue("x_sn_session=nope", "sn_session") == null);
}
