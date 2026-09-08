//! HTTP(S) transport: an accept loop that optionally terminates TLS in-process
//! (via ianic/tls.zig) and dispatches each request through a route table and a
//! `Context`, both handed in by the caller.
//!
//! **It used to claim to be "app-agnostic — pure plumbing" while opening the
//! database, building four services and two stores, and running the startup
//! sweeps.** It was the composition root wearing a plumbing label. That work now
//! lives in `backend/app.zig`, which is allowed to know what an Inkhold is.
//!
//! What is left is honestly ALMOST app-agnostic, and the exception is worth
//! naming rather than papering over: `resolveCaller` takes the auth service,
//! because dispatch has to know who is calling before it can enforce a route's
//! scopes. That is a dispatch concern, not a composition one, so it stays — and
//! it means this file is "transport plus authentication", not pure plumbing.
//! Injecting a resolver function to reach purity would buy a claim and cost a
//! reader.

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

// Socket-side buffers must hold whole TLS ciphertext records; plaintext-side
// buffers hold decrypted data / HTTP heads.
const sock_read_len = tls.input_buffer_len;
const sock_write_len = tls.output_buffer_len;
const plain_len = 16 * 1024;

pub const Error = error{UnknownCipherSuite} || std.mem.Allocator.Error;

/// Stack reserved for each per-connection thread.
///
/// ESTABLISHED EMPIRICALLY, because static frame analysis badly under-predicts.
/// Summing the `sub $N,%rsp` prologues along the deepest chain in the compiled
/// Debug binary gives only ~281 KB:
///
///   handleConn                67,952 B  socket buffers (tls.input_buffer_len
///                                       16,645 + output 16,469) + the TLS
///                                       plaintext buffers (2 x 16,384)
///   serve + handle +
///     dispatchLocked + dispatch  2,976 B
///   ossPut                   134,728 B  a [64 KiB] read + a [64 KiB] write
///                                       buffer, both on the stack
///   multipart.extract         75,144 B  the [read_chunk + max_term] work buffer
///
/// The real requirement is roughly DOUBLE that — the sum misses the reader/writer,
/// Io-vtable and syscall-wrapper frames beneath the sink, and glibc's thread
/// descriptor + static TLS come out of the same mapping. A live 32 MB upload
/// bisects the true floor to between 512 KiB (reproducible SIGSEGV on entry to
/// `multipart.extract`) and 576 KiB (clean). Do not trust the static sum alone;
/// re-bisect against a real transfer if these frames change.
///
/// 1 MiB is ~1.8x that measured floor. The download path (`ossGet`, 134,768 B),
/// static SPA serving (`static.serve`, 133,904 B) and the TLS handshake
/// (`DhKeyPair.init`, 124,336 B) are all shallower than the upload path this is
/// sized against. Undersizing here is far worse than the thread flood the cap
/// bounds — it is a stack-overflow crash mid-transfer, as the 512 KiB run showed.
///
/// Also a floor from below: glibc rejects small stacks with EINVAL, and Zig's
/// `Thread.spawn` treats that as `unreachable` (a panic, not an error the accept
/// loop's inline fallback could absorb). 1 MiB is far clear of that.
pub const conn_stack_size = 1024 * 1024;

/// Bounds how many connections may be in flight at once.
///
/// Serve mode spawns a detached thread per connection, so without a cap a
/// connection flood is a thread flood — each with `conn_stack_size` of stack plus
/// its buffers — which blows the project's hard ~50 MB RSS target. Over the cap
/// the accept loop closes the connection immediately and keeps accepting.
///
/// Split out of the accept loop (which tests never invoke) so the accounting is
/// directly unit-testable, following `authorize`/`formatPeerIp`. The real risk
/// here is not the arithmetic but BALANCE: one missed `release` on an error or
/// fallback path leaks a slot, and the count drifts up until the server refuses
/// everything. A pure `admit(active, max)` predicate could not catch that.
pub const ConnLimiter = struct {
    active: std.atomic.Value(u32) = .init(0),
    max: u32,

    pub fn init(max: u32) ConnLimiter {
        return .{ .max = max };
    }

    /// Reserve a slot, or false if at capacity. On false the caller MUST close the
    /// connection; on true it MUST eventually `release` exactly once.
    pub fn tryAcquire(self: *ConnLimiter) bool {
        var cur = self.active.load(.monotonic);
        while (true) {
            if (cur >= self.max) return false;
            // Compare-and-swap rather than fetchAdd-then-check: an overshooting
            // add would be briefly visible to another accepting thread and, worse,
            // needs a compensating decrement on the failure path — one more place
            // to leak a slot.
            cur = self.active.cmpxchgWeak(cur, cur + 1, .acquire, .monotonic) orelse return true;
        }
    }

    /// Give a slot back. Exactly one per successful `tryAcquire`.
    pub fn release(self: *ConnLimiter) void {
        const prev = self.active.fetchSub(1, .release);
        std.debug.assert(prev != 0); // released more than acquired — a slot-accounting bug
    }

    /// Slots currently held. For tests and diagnostics.
    pub fn count(self: *const ConnLimiter) u32 {
        return self.active.load(.monotonic);
    }
};

test "ConnLimiter: admits up to the cap, refuses beyond it, and balances back to zero" {
    var l: ConnLimiter = .init(3);
    try std.testing.expectEqual(@as(u32, 0), l.count());

    // Up to the cap.
    for (0..3) |_| try std.testing.expect(l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 3), l.count());

    // Over the cap: refused, and refusal must not itself consume or leak a slot
    // (a flood hits this path repeatedly — drift here is the whole failure mode).
    for (0..10) |_| try std.testing.expect(!l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 3), l.count());

    // Freeing one slot re-admits exactly one.
    l.release();
    try std.testing.expectEqual(@as(u32, 2), l.count());
    try std.testing.expect(l.tryAcquire());
    try std.testing.expect(!l.tryAcquire());

    // Everything released → back to zero, and full capacity is available again.
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
    // Mirrors the accept loop's contract: `connThread` releases via `defer`, and
    // the inline spawn-failure fallback releases too. A handler that errors out
    // must not strand its slot — that is the drift that eventually refuses every
    // connection while the server looks healthy.
    var l: ConnLimiter = .init(2);
    const serveOne = struct {
        fn run(lim: *ConnLimiter, fail: bool) !void {
            try std.testing.expect(lim.tryAcquire());
            defer lim.release(); // exactly what connThread does
            if (fail) return error.ConnectionReset;
        }
    }.run;

    for (0..50) |i| {
        serveOne(&l, i % 2 == 0) catch {};
        try std.testing.expectEqual(@as(u32, 0), l.count()); // never drifts
    }

    // After a burst of failures the full cap is still available.
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

/// The accept loop: bind, then one detached thread per connection, dispatching
/// through `routes` with the caller's `ctx`.
///
/// **Everything application-shaped is handed in.** This file used to build the
/// database, four services and two stores itself, while its own header claimed to
/// be "app-agnostic — pure plumbing". It was the composition root wearing a
/// plumbing label. That work moved to `backend/app.zig`, which is allowed to know
/// what an Inkhold is; what remains here genuinely does not.
///
/// Never returns on success.
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
    var refusing = false; // true while over capacity, so we log once per episode

    while (true) {
        const stream = listener.accept(io) catch |err| {
            std.debug.print("accept failed: {}\n", .{err});
            continue;
        };
        // Bound the in-flight connections BEFORE spawning: one detached thread per
        // connection means an unbounded flood is a thread flood (see ConnLimiter).
        // Over the cap we close immediately and keep accepting — refusing fast is
        // what keeps the accept loop responsive for the connections we do serve.
        if (!conns.tryAcquire()) {
            stream.close(io);
            if (!refusing) {
                refusing = true; // one line per episode, not one per refused connection
                std.debug.print(
                    "at max_connections ({d}); refusing new connections until one closes\n",
                    .{cfg.max_connections},
                );
            }
            continue;
        }
        refusing = false;
        // One detached thread per connection. A connection can be held open for a
        // long time — a browser keep-alive, the device's persistent Socket.IO
        // WebSocket, an SSE stream — and serving connections one-at-a-time wedges
        // the accept loop (nothing else can be served while one is parked). The
        // shared state each thread touches is synchronized: the SQLite connection
        // via `ctx.db_lock` (whole handler = whole transaction, no interleaving),
        // the rate limiter and download-token store via their own mutexes.
        // `connThread` takes `ctx` by value so
        // per-request mutations (`client_ip`, `caller`) stay thread-local. On spawn
        // failure we fall back to handling inline so the server keeps serving.
        // `stack_size` is explicit, not the (large) default: the cap only bounds
        // memory if the per-thread reservation is a known number. See conn_stack_size.
        const t = std.Thread.spawn(.{ .stack_size = conn_stack_size }, connThread, .{ ctx.*, routes, stream, auth_ptr, ciphers, rng, &conns }) catch |err| {
            // Inline fallback: this thread never took a slot of its own, so release
            // the one we reserved above — missing this leaks a slot per spawn failure.
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

/// Handle one accepted connection on its own thread. Takes `ctx` by value so
/// per-connection/per-request mutations (`client_ip`, `caller`) touch a
/// thread-local copy — the shared pointers inside it (`service`/`files` DB via
/// `db_lock`, `limiter`, `download_tokens`) carry their own synchronization.
fn connThread(
    ctx: Context,
    routes: []const router.Route,
    stream: Io.net.Stream,
    auth: ?*tls.config.CertKeyPair,
    ciphers: []const tls.config.CipherSuite,
    rng: std.Random,
    conns: *ConnLimiter,
) void {
    // Give the slot back however this thread ends — a normal close, a connection
    // error, anything. This `defer` is the whole balance guarantee for the common
    // path; the accept loop's inline fallback has its own.
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
    var ip_buf: [46]u8 = undefined; // max textual IPv6 length
    ctx.client_ip = peerIp(stream, &ip_buf); // per-connection; null if unavailable

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

/// Serve HTTP requests on one (already-decrypted) reader/writer pair,
/// dispatching each through the supplied route table.
fn serve(ctx: *Context, routes: []const router.Route, in: *Io.Reader, out: *Io.Writer) !void {
    var http = std.http.Server.init(in, out);
    while (true) {
        var req = http.receiveHead() catch return; // client closed / no more requests
        try handle(ctx, routes, &req);
    }
}

/// Resolve the caller for one request and dispatch it. Exposed so integration
/// tests can drive a request through the real auth + routing path over an
/// in-memory reader/writer, without a socket.
pub fn handle(ctx: *Context, routes: []const router.Route, req: *router.Request) !void {
    // Guard against a std.http assert that otherwise takes down the whole
    // connection thread: `discardBody` (run on the response path to ready the
    // socket for keep-alive) asserts that a body-bearing method carries framing
    //   assert(transfer_encoding != .none or content_length != null)
    // So a POST/PUT/PATCH with NEITHER a Content-Length NOR a Transfer-Encoding
    // — a valid empty-body request — panics the server the moment we respond
    // before reading its (absent) body: every early reject (401/403/404/429)
    // and every body-less POST handler (e.g. `restore`). The assert sits behind
    //   if (keep_alive and request.head.keep_alive)
    // so dropping THIS request's keep-alive skips it entirely; the handler still
    // sends its real response and the connection simply closes afterward.
    // Browsers send `Content-Length: 0` and never hit this; lean clients
    // (`curl -X POST` with no body, some scripts) and malformed/hostile ones do.
    if (req.head.method.requestHasBody() and
        req.head.content_length == null and
        req.head.transfer_encoding == .none)
    {
        req.head.keep_alive = false;
    }
    return dispatchLocked(ctx, routes, req);
}

/// Resolve the caller and dispatch, applying the route table's `db_lock` policy.
///
/// Default policy: hold `db_lock` across resolveCaller + the whole handler, so the
/// shared SQLite connection is never touched concurrently and a multi-statement
/// transaction can't interleave with another thread's. Coarse but correct.
///
/// `manual_db_lock` policy (the streaming transfer routes): hold the lock only
/// across `resolveCaller` — it reads the session table, so it MUST be locked —
/// then release and run the handler unlocked. Those handlers take the lock again
/// themselves around each of their own (short) DB touches, so a multi-MB transfer
/// no longer serializes every other request behind it.
///
/// `read_only` policy (the pooled reads): the same short `resolveCaller` window,
/// then the handler runs against a BORROWED `SQLITE_OPEN_READONLY` connection
/// with no lock held at all. WAL serves concurrent readers natively, so a 3.41 s
/// search stops being a barrier the whole household queues behind and becomes one
/// slow request for the person who asked for it. When the pool is empty the
/// request falls back to the writer under the lock, i.e. to exactly the behaviour
/// of every other route — which is what makes the pool a pure optimisation.
///
/// No-match policy (a 404, or a static SPA asset): the same shape, minus the
/// reader. Neither `static.serve` nor the 404 touches the database, and serving a
/// multi-hundred-KB bundle under the one global DB lock was pure loss.
///
/// Skipped entirely when `db_lock` is unset (the integration tests drive handle()
/// directly and are single-threaded).
fn dispatchLocked(ctx: *Context, routes: []const router.Route, req: *router.Request) !void {
    const idx = router.matchedIndex(routes, req);
    // Set before any lock is taken, so EVERY window this request opens is
    // attributed to the route — including the ones a `manual_db_lock` handler
    // opens for itself, which is the only way their "the windows are short" claim
    // can be checked rather than trusted.
    ctx.route_idx = idx;
    ctx.routes = routes; // so the health handler can name what the histogram indexes
    const route = if (idx) |i| &routes[i] else null;
    const manual = if (route) |r| r.manual_db_lock else false;
    const admin_route = if (route) |r| r.require_admin else false;
    // The two are mutually exclusive BY CONSTRUCTION: the manual branch below
    // returns before `renewElevation`, so a manual admin route would silently stop
    // sliding the elevation window and hand admins a surprise 428 with nothing
    // pointing at the flag that did it. `routes.zig` refuses to compile such a
    // route (`router.manualAdminRoute`); this assert is the same rule for the
    // synthetic tables tests build.
    //
    // Chosen over renewing in BOTH branches on purpose. That fix works, and it is
    // the worse one: it puts a silent behaviour in a second place, under a
    // different lock discipline (a manual handler holds no lock here, so its
    // renewal would need a window of its own), where the next reader has to
    // remember it exists. This one cannot be got wrong.
    std.debug.assert(!(manual and admin_route));
    // Likewise by construction: `read_only` pairs with neither flag, because a
    // manual handler would lock the writer while reading the reader it was
    // leased, and an admin route's elevation renewal is an UPDATE. `routes.zig`
    // refuses to compile either pairing (`router.readOnlyConflict`); this assert
    // is the same rule for the synthetic tables tests build.
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
        // The session read is a DB touch like any other and still belongs under
        // the lock — it runs on the WRITER, before any reader is borrowed, so the
        // auth service's own in-memory state is never reached through a copy.
        const caller = blk: {
            ctx.lockDb();
            defer ctx.unlockDb();
            break :blk if (ctx.service) |svc| resolveCaller(svc, req) else null;
        };
        if (route == null) return router.dispatch(routes, ctx, req, caller); // 404 / static: no DB at all
        return dispatchReadOnly(ctx, routes, req, caller);
    }
    ctx.lockDb();
    defer ctx.unlockDb();
    const caller = if (ctx.service) |svc| resolveCaller(svc, req) else null;
    if (admin_route) renewElevation(ctx, req);
    try router.dispatch(routes, ctx, req, caller);
}

/// Run a `read_only` route's handler against a borrowed reader, or — when the
/// pool is empty or absent — under `db_lock` on the writer, exactly as every
/// other route runs.
///
/// **The services are swapped, not just the connection.** Handlers reach the
/// database only through `ctx.files` / `ctx.service`, each of which carries its
/// own `sqlite.Db`; pointing them at reader-bound copies for the duration of the
/// dispatch is what actually routes the reads. The copies are stack locals here
/// so their lifetime is exactly the lease's, and the originals are restored
/// before returning because a `Context` outlives the request (keep-alive reuses
/// it for the next one on the same connection).
fn dispatchReadOnly(
    ctx: *Context,
    routes: []const router.Route,
    req: *router.Request,
    caller: ?router.Caller,
) !void {
    const lease = ctx.borrowReader() orelse {
        // Pool empty (or no pool at all): degrade to today's behaviour for this
        // one request. Never worse, never an error — the property that lets the
        // pool's size be a tuning decision.
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

/// Slide the caller's admin elevation forward, because they are using the admin
/// console right now. The window is idle-based with a hard ceiling, and this is
/// the "activity" half of it: `Service.renewElevation` clamps the new deadline to
/// the ceiling, so a console left open in a tab cannot renew itself forever.
///
/// Called on `require_admin` routes ONLY — elevation should track admin activity,
/// not any browsing the same session happens to do — and BEFORE `authorize`, which
/// is safe because renewal can only ever extend an already-live elevation: a NULL,
/// an idle-lapsed or a ceiling-exceeded one is left untouched. So it can never
/// grant what the gate is about to refuse.
///
/// Best-effort: a failure here costs the admin an early re-prompt, which is the
/// safe direction to fail.
fn renewElevation(ctx: *Context, req: *router.Request) void {
    const svc = ctx.service orelse return;
    const token = presentedToken(req) orelse return;
    _ = svc.renewElevation(token) catch return;
}

/// The session token presented on a request: the device `x-access-token` header,
/// else the control-plane session cookie. Null if neither is present.
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

/// Resolve the authenticated caller from the request's credentials. The device
/// face presents its token in the `x-access-token` header (plus an `equipmentNo`
/// header identifying the device); the control-plane face uses the session cookie. Either
/// way the token is validated against the session store, and the *stored*
/// audience — not the channel — governs authority. Fails closed (null caller →
/// only public routes) on any lookup error.
fn resolveCaller(svc: *authsvc.Service, req: *router.Request) ?router.Caller {
    const t = presentedToken(req) orelse return null;
    var who = (svc.caller(t) catch |err| {
        std.debug.print("resolveCaller: session lookup failed: {}\n", .{err});
        return null;
    }) orelse return null;
    if (who.audience == .device) {
        // Copy the serial INLINE now: header values borrow the request head
        // buffer, which `json.readBody` overwrites before the device handlers
        // read `caller.equipmentNo()` (a use-after-free on the head buffer).
        // `headerCopy` is the shared helper that makes copying the only option.
        who.equipment_len = router.headerCopy(req, "equipmentno", &who.equipment_buf).len;
    }
    return who;
}

/// The peer's IP address (no port) as text, for rate-limit keying. Uses
/// `getpeername` on the socket fd; null if unavailable or an unknown family.
/// (We terminate TLS in-process with no proxy, so this is the real client.)
fn peerIp(stream: Io.net.Stream, buf: []u8) ?[]const u8 {
    var storage: std.posix.sockaddr.storage = undefined;
    var len: std.posix.socklen_t = @sizeOf(@TypeOf(storage));
    std.posix.getpeername(stream.socket.handle, @ptrCast(&storage), &len) catch return null;
    return formatPeerIp(&storage, buf);
}

/// Formats a peer address into just its IP (IPv4 dotted-quad or IPv6 hextets).
/// Pure — split out so it can be unit-tested with a fabricated sockaddr.
fn formatPeerIp(storage: *const std.posix.sockaddr.storage, buf: []u8) ?[]const u8 {
    const sa: *const std.posix.sockaddr = @ptrCast(storage);
    switch (sa.family) {
        std.posix.AF.INET => {
            const in: *const std.posix.sockaddr.in = @ptrCast(@alignCast(storage));
            const b = std.mem.asBytes(&in.addr); // network byte order = dotted order
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
    in.addr = std.mem.bytesToValue(u32, &[4]u8{ 192, 168, 1, 42 }); // network order bytes
    var buf: [46]u8 = undefined;
    try std.testing.expectEqualStrings("192.168.1.42", formatPeerIp(&storage, &buf).?);
}

/// Extracts cookie `name` from a `Cookie` header value (`a=1; b=2`), or null.
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
    try eq("abc123", cookieValue("theme=dark;  sn_session=abc123", "sn_session").?); // padded
    try std.testing.expect(cookieValue("theme=dark; lang=en", "sn_session") == null);
    try std.testing.expect(cookieValue("", "sn_session") == null);
    // Must not match on a suffix/substring of another cookie name.
    try std.testing.expect(cookieValue("x_sn_session=nope", "sn_session") == null);
}
