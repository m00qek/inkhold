//! HTTP(S) transport: the accept loop, optional in-process TLS (ianic/tls.zig),
//! caller resolution, and dispatch under the route table's `db_lock` policy.
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

// Socket-side buffers must hold whole TLS ciphertext records.
const sock_read_len = tls.input_buffer_len;
const sock_write_len = tls.output_buffer_len;
const plain_len = 16 * 1024;

pub const Error = error{UnknownCipherSuite} || std.mem.Allocator.Error;

/// Stack per connection thread, set empirically: static frame sums (~281 KB,
/// mostly `ossPut` and `multipart.extract` buffers) badly under-predict, and a
/// live 32 MB upload put the real floor between 512 KiB (SIGSEGV) and
/// 576 KiB. Re-bisect against a real transfer if those frames change.
pub const conn_stack_size = 1024 * 1024;

/// Bounds in-flight connections: each is a detached thread with
/// `conn_stack_size` of stack, so an uncapped flood blows the ~50 MB RSS
/// target. One missed `release` drifts the count until everything is refused.
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

/// The accept loop: one detached thread per connection, dispatching `routes`
/// with `ctx`. Never returns on success.
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
    defer listener.close(io);

    std.debug.print("Inkhold listening on {s}://{s}:{d}\n", .{
        if (cfg.tls.enabled) "https" else "http", cfg.host, cfg.port,
    });

    var conns: ConnLimiter = .init(cfg.max_connections);
    var refusing = false; // log once per over-capacity episode

    while (true) {
        const stream = listener.accept(io) catch |err| {
            std.debug.print("accept failed: {}\n", .{err});
            continue;
        };
        // Over the cap, close immediately and keep accepting.
        if (!conns.tryAcquire()) {
            stream.close(io);
            if (!refusing) {
                refusing = true;
                std.debug.print(
                    "at max_connections ({d}); refusing new connections until one closes\n",
                    .{cfg.max_connections},
                );
            }
            continue;
        }
        refusing = false;
        // A thread per connection, since keep-alive, the device's Socket.IO
        // WebSocket and SSE streams park connections for a long time. `ctx` is
        // copied so `client_ip`/`caller` stay thread-local. On spawn failure,
        // serve inline.
        const t = std.Thread.spawn(.{ .stack_size = conn_stack_size }, connThread, .{ ctx.*, routes, stream, auth_ptr, ciphers, rng, &conns }) catch |err| {
            // Inline fallback: release the slot reserved above.
            defer conns.release();
            std.debug.print("thread spawn failed ({}); handling inline\n", .{err});
            handleConn(ctx, routes, stream, auth_ptr, ciphers, rng) catch |e| {
                std.debug.print("connection error: {}\n", .{e});
            };
            stream.close(io);
            continue;
        };
        t.detach();
    }
}

/// One connection on its own thread, with a by-value `ctx`.
fn connThread(
    ctx: Context,
    routes: []const router.Route,
    stream: Io.net.Stream,
    auth: ?*tls.config.CertKeyPair,
    ciphers: []const tls.config.CipherSuite,
    rng: std.Random,
    conns: *ConnLimiter,
) void {
    defer conns.release();
    var local = ctx;
    handleConn(&local, routes, stream, auth, ciphers, rng) catch |err| {
        std.debug.print("connection error: {}\n", .{err});
    };
    stream.close(local.io);
}

fn handleConn(
    ctx: *Context,
    routes: []const router.Route,
    stream: Io.net.Stream,
    auth: ?*tls.config.CertKeyPair,
    ciphers: []const tls.config.CipherSuite,
    rng: std.Random,
) !void {
    const io = ctx.io;
    var ip_buf: [46]u8 = undefined; // max textual IPv6
    ctx.client_ip = peerIp(stream, &ip_buf);

    var sock_rbuf: [sock_read_len]u8 = undefined;
    var sock_wbuf: [sock_write_len]u8 = undefined;
    var sr = stream.reader(io, &sock_rbuf);
    var sw = stream.writer(io, &sock_wbuf);

    if (ctx.config.tls.enabled) {
        var conn = try tls.server(&sr.interface, &sw.interface, .{
            .auth = auth,
            .rng = rng,
            .now = Io.Clock.real.now(io),
            .cipher_suites = ciphers,
        });
        var plain_rbuf: [plain_len]u8 = undefined;
        var plain_wbuf: [plain_len]u8 = undefined;
        var cr = conn.reader(&plain_rbuf);
        var cw = conn.writer(&plain_wbuf);
        try serve(ctx, routes, &cr.interface, &cw.interface);
        conn.close() catch {};
    } else {
        try serve(ctx, routes, &sr.interface, &sw.interface);
    }
}

fn serve(ctx: *Context, routes: []const router.Route, in: *Io.Reader, out: *Io.Writer) !void {
    var http = std.http.Server.init(in, out);
    while (true) {
        var req = http.receiveHead() catch return;
        try handle(ctx, routes, &req);
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
            break :blk if (ctx.service) |svc| resolveCaller(svc, req) else null;
        };
        return router.dispatch(routes, ctx, req, caller);
    }
    if (read_only or route == null) {
        // The session read runs on the writer, before any reader is borrowed.
        const caller = blk: {
            ctx.lockDb();
            defer ctx.unlockDb();
            break :blk if (ctx.service) |svc| resolveCaller(svc, req) else null;
        };
        if (route == null) return router.dispatch(routes, ctx, req, caller);
        return dispatchReadOnly(ctx, routes, req, caller);
    }
    ctx.lockDb();
    defer ctx.unlockDb();
    const caller = if (ctx.service) |svc| resolveCaller(svc, req) else null;
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
    var ro_files: filesmod.Files = undefined;
    var ro_service: authsvc.Service = undefined;
    if (saved_files) |f| {
        ro_files = f.readerView(lease.db);
        ctx.files = &ro_files;
    }
    if (saved_service) |s| {
        ro_service = s.readerView(lease.db);
        ctx.service = &ro_service;
    }
    return router.dispatch(routes, ctx, req, caller);
}

/// Slides the caller's admin elevation forward on `require_admin` routes.
/// Runs before `authorize`, which is safe because it only extends a live
/// elevation and clamps to the hard ceiling. Best-effort.
fn renewElevation(ctx: *Context, req: *router.Request) void {
    const svc = ctx.service orelse return;
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
        std.debug.print("resolveCaller: session lookup failed: {}\n", .{err});
        return null;
    }) orelse return null;
    if (who.audience == .device) {
        // Copy the serial now: `json.readBody` overwrites the head buffer.
        who.equipment_len = router.headerCopy(req, "equipmentno", &who.equipment_buf).len;
    }
    return who;
}

/// The peer IP for rate-limit keying (no proxy: TLS terminates here).
fn peerIp(stream: Io.net.Stream, buf: []u8) ?[]const u8 {
    var storage: std.posix.sockaddr.storage = undefined;
    var len: std.posix.socklen_t = @sizeOf(@TypeOf(storage));
    std.posix.getpeername(stream.socket.handle, @ptrCast(&storage), &len) catch return null;
    return formatPeerIp(&storage, buf);
}

fn formatPeerIp(storage: *const std.posix.sockaddr.storage, buf: []u8) ?[]const u8 {
    const sa: *const std.posix.sockaddr = @ptrCast(storage);
    switch (sa.family) {
        std.posix.AF.INET => {
            const in: *const std.posix.sockaddr.in = @ptrCast(@alignCast(storage));
            const b = std.mem.asBytes(&in.addr); // network order = dotted order
            return std.fmt.bufPrint(buf, "{d}.{d}.{d}.{d}", .{ b[0], b[1], b[2], b[3] }) catch null;
        },
        std.posix.AF.INET6 => {
            const in6: *const std.posix.sockaddr.in6 = @ptrCast(@alignCast(storage));
            var w = std.Io.Writer.fixed(buf);
            for (in6.addr, 0..) |octet, i| {
                if (i != 0 and i % 2 == 0) w.writeByte(':') catch return null;
                w.print("{x:0>2}", .{octet}) catch return null;
            }
            return buf[0..w.end];
        },
        else => return null,
    }
}

test "formatPeerIp renders an IPv4 dotted quad" {
    var storage: std.posix.sockaddr.storage = std.mem.zeroes(std.posix.sockaddr.storage);
    const in: *std.posix.sockaddr.in = @ptrCast(@alignCast(&storage));
    in.family = std.posix.AF.INET;
    in.addr = std.mem.bytesToValue(u32, &[4]u8{ 192, 168, 1, 42 });
    var buf: [46]u8 = undefined;
    try std.testing.expectEqualStrings("192.168.1.42", formatPeerIp(&storage, &buf).?);
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
