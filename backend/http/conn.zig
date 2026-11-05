//! One client socket across its requests: the buffers `std.http` reads into,
//! the optional TLS session, and the clock the poller judges idleness by.
//! Heap-allocated and never moved, because the reader, the writer and the
//! HTTP server all point into it. A parked plaintext connection is this struct
//! and nothing else: ~34 KB, no thread.

const std = @import("std");
const Io = std.Io;
const tls = @import("tls");
const router = @import("router.zig");
const transport = @import("transport.zig");
const Context = @import("context.zig").Context;

const log = std.log.scoped(.http);

// Socket-side buffers must hold whole TLS ciphertext records.
pub const sock_read_len = tls.input_buffer_len;
pub const sock_write_len = tls.output_buffer_len;
const plain_len = 16 * 1024;

/// What the listener was configured with; the handshake runs per connection.
pub const TlsOptions = struct {
    auth: ?*tls.config.CertKeyPair,
    ciphers: []const tls.config.CipherSuite,
    rng: std.Random,
};

/// What a worker does with the connection after serving it.
pub const Next = union(enum) {
    /// Keep-alive with nothing buffered: back to the poller.
    park,
    /// The peer closed, the response said `connection: close`, or an error.
    close,
    /// The request matched a `held` route (a stream that runs for minutes); the
    /// caller gives it a thread of its own. The request is already parsed.
    held: router.Request,
};

/// The TLS state of one connection, allocated only for TLS listeners so a
/// parked plaintext socket does not carry two idle 16 KB buffers.
const Session = struct {
    conn: tls.Connection,
    plain_rbuf: [plain_len]u8,
    plain_wbuf: [plain_len]u8,
    reader: tls.Connection.Reader,
    writer: tls.Connection.Writer,
};

pub const Conn = struct {
    io: Io,
    stream: Io.net.Stream,
    ip_buf: [46]u8 = undefined, // max textual IPv6
    ip_len: u8 = 0,
    sock_rbuf: [sock_read_len]u8 = undefined,
    sock_wbuf: [sock_write_len]u8 = undefined,
    sr: Io.net.Stream.Reader,
    sw: Io.net.Stream.Writer,
    /// Present on a TLS listener. Built on the first request, since the
    /// handshake reads from the peer.
    session: ?*Session = null,
    handshaken: bool = false,
    /// Valid once the stream is plaintext, or once `handshaken`.
    http: std.http.Server,
    /// `Io.Clock.awake` milliseconds when parked; the poller's idle clock.
    parked_at_ms: i64 = 0,

    /// Takes ownership of `stream`. `with_tls` reserves the session; the
    /// handshake itself waits for the first request.
    pub fn create(gpa: std.mem.Allocator, io: Io, stream: Io.net.Stream, with_tls: bool) !*Conn {
        const self = try gpa.create(Conn);
        errdefer gpa.destroy(self);
        self.* = .{ .io = io, .stream = stream, .sr = undefined, .sw = undefined, .http = undefined };
        self.sr = stream.reader(io, &self.sock_rbuf);
        self.sw = stream.writer(io, &self.sock_wbuf);
        if (with_tls) {
            self.session = try gpa.create(Session);
        } else {
            self.http = std.http.Server.init(&self.sr.interface, &self.sw.interface);
        }
        if (peerIp(stream, &self.ip_buf)) |addr| self.ip_len = @intCast(addr.len);
        noDelay(stream);
        return self;
    }

    /// Closes the socket (with TLS `close_notify` when a session is up) and frees.
    pub fn destroy(self: *Conn, gpa: std.mem.Allocator) void {
        if (self.session) |s| {
            if (self.handshaken) s.conn.close() catch {};
            gpa.destroy(s);
        }
        self.stream.close(self.io);
        gpa.destroy(self);
    }

    pub fn fd(self: *const Conn) Io.net.Socket.Handle {
        return self.stream.socket.handle;
    }

    /// The socket peer's address.
    pub fn ip(self: *const Conn) ?[]const u8 {
        return if (self.ip_len == 0) null else self.ip_buf[0..self.ip_len];
    }

    /// The address rate limits key `req` by: the peer, unless the peer is the
    /// configured `trusted_proxy`, in which case the client it says it fronts.
    /// Points into the request head, so it lives as long as the request.
    pub fn clientIp(self: *const Conn, trusted_proxy: []const u8, req: *router.Request) ?[]const u8 {
        const peer = self.ip() orelse return null;
        if (trusted_proxy.len == 0 or !std.mem.eql(u8, peer, trusted_proxy)) return peer;
        var real_ip: ?[]const u8 = null;
        var forwarded: ?[]const u8 = null;
        var it = req.iterateHeaders();
        while (it.next()) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, "x-real-ip")) real_ip = h.value;
            if (std.ascii.eqlIgnoreCase(h.name, "x-forwarded-for")) forwarded = h.value;
        }
        return forwardedClient(real_ip, forwarded) orelse peer;
    }

    fn handshake(self: *Conn, opts: TlsOptions) !void {
        const s = self.session.?;
        s.conn = try tls.server(&self.sr.interface, &self.sw.interface, .{
            .auth = opts.auth,
            .rng = opts.rng,
            .now = Io.Clock.real.now(self.io),
            .cipher_suites = opts.ciphers,
        });
        s.reader = s.conn.reader(&s.plain_rbuf);
        s.writer = s.conn.writer(&s.plain_wbuf);
        self.http = std.http.Server.init(&s.reader.interface, &s.writer.interface);
        self.handshaken = true;
    }

    /// Serves requests until the connection should be parked, closed or handed
    /// to a thread of its own. `ctx` is the calling worker's own copy; the
    /// client IP is stamped here.
    pub fn serve(self: *Conn, ctx: *Context, routes: []const router.Route, opts: TlsOptions) Next {
        if (self.session != null and !self.handshaken) {
            self.handshake(opts) catch |err| {
                log.debug("tls handshake failed: {t}", .{err});
                return .close;
            };
        }
        while (true) {
            // A closed peer, a malformed head or a read error all end here.
            var req = self.http.receiveHead() catch return .close;
            if (router.isHeld(routes, &req)) return .{ .held = req };
            ctx.client_ip = self.clientIp(ctx.config.trusted_proxy, &req);
            transport.handle(ctx, routes, &req) catch |err| {
                log.warn("connection error: {t}", .{err});
                return .close;
            };
            if (!req.head.keep_alive) return .close;
            // A pipelined request is already here: serve it before parking.
            if (self.http.reader.in.buffered().len == 0) return .park;
        }
    }
};

/// What a trusted proxy says about its client. `X-Real-IP` is what a single
/// proxy sets outright; failing that, the LAST `X-Forwarded-For` hop, the one
/// that proxy appended. Earlier hops are whatever the client claimed, and an
/// implausible value is ignored rather than keyed on.
fn forwardedClient(real_ip: ?[]const u8, forwarded: ?[]const u8) ?[]const u8 {
    if (real_ip) |v| if (plausibleIp(std.mem.trim(u8, v, " "))) |ip| return ip;
    const list = forwarded orelse return null;
    var hops = std.mem.splitBackwardsScalar(u8, list, ',');
    return plausibleIp(std.mem.trim(u8, hops.first(), " "));
}

/// An address-shaped string: short enough for a rate-limit key, hex digits,
/// dots and colons only. Not a parse; just a refusal to key on junk.
fn plausibleIp(s: []const u8) ?[]const u8 {
    if (s.len == 0 or s.len > 45) return null;
    for (s) |c| if (!std.ascii.isHex(c) and c != '.' and c != ':') return null;
    return s;
}

/// Sends each write at once. A TLS response leaves as several records (the
/// head, then the body), each its own small write, and with Nagle's algorithm
/// the second waits for the client's delayed ACK: a flat ~40 ms on every page,
/// file and thumbnail over HTTPS, measured against 0.4 ms in plain HTTP (whose
/// head and body share one write). Best effort: a refusal changes nothing else.
fn noDelay(stream: Io.net.Stream) void {
    const on: c_int = 1;
    std.posix.setsockopt(stream.socket.handle, std.posix.IPPROTO.TCP, std.posix.TCP.NODELAY, std.mem.asBytes(&on)) catch {};
}

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

test "forwardedClient prefers X-Real-IP, else the hop the proxy appended, and refuses junk" {
    const expectEq = std.testing.expectEqualStrings;
    try expectEq("203.0.113.7", forwardedClient("203.0.113.7", "1.2.3.4").?);
    try expectEq("203.0.113.7", forwardedClient(" 203.0.113.7 ", null).?);
    // Client-supplied hops come first; the trusted proxy appends the real one last.
    try expectEq("203.0.113.7", forwardedClient(null, "spoofed, 10.0.0.9, 203.0.113.7").?);
    try expectEq("2001:db8::1", forwardedClient(null, "2001:db8::1").?);
    // Junk in X-Real-IP falls through to X-Forwarded-For; junk everywhere yields nothing.
    try expectEq("203.0.113.7", forwardedClient("not an ip", "203.0.113.7").?);
    try std.testing.expect(forwardedClient("evil;drop", "a b") == null);
    try std.testing.expect(forwardedClient(null, "") == null);
    try std.testing.expect(forwardedClient(null, null) == null);
}

test "a parked plaintext connection is one struct of about 34 KB; TLS state is separate" {
    // The budget a parked socket costs: the two record-sized buffers plus bookkeeping.
    try std.testing.expect(@sizeOf(Conn) < 40 * 1024);
    try std.testing.expect(@sizeOf(Conn) > sock_read_len + sock_write_len);
    try std.testing.expect(@sizeOf(Session) > 2 * plain_len);
}

test "an accepted socket sends at once: TCP_NODELAY, or every TLS response waits ~40 ms" {
    const io = std.testing.io;
    const addr = try Io.net.IpAddress.parse("127.0.0.1", 0);
    var server = try addr.listen(io, .{ .mode = .stream });
    defer server.deinit(io);
    const client = try server.socket.address.connect(io, .{ .mode = .stream });
    defer client.close(io);
    const accepted = try server.accept(io);
    const conn = try Conn.create(std.testing.allocator, io, accepted, false);
    defer conn.destroy(std.testing.allocator);

    const linux = std.os.linux;
    var on: c_int = 0;
    var len: std.posix.socklen_t = @sizeOf(c_int);
    const rc = linux.getsockopt(conn.fd(), std.posix.IPPROTO.TCP, std.posix.TCP.NODELAY, @ptrCast(&on), &len);
    try std.testing.expectEqual(linux.E.SUCCESS, linux.errno(rc));
    try std.testing.expect(on != 0);
}
