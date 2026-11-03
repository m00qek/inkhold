//! HTTP-level integration tests: real requests through `std.http.Server`,
//! `transport.handle`, the handlers and services, over an in-memory SQLite and
//! an in-memory reader/writer pair (no sockets, no threads).

const std = @import("std");
const repeat = @import("../repeat.zig").repeat;
const app = @import("../routes.zig");
const transport = @import("../http/transport.zig");
const context = @import("../http/context.zig");
const router = @import("../http/router.zig");
const sqlite = @import("../db/sqlite.zig");
const schema = @import("../db/schema.zig");
const authsvc = @import("../services/auth/service.zig");
const password = @import("../services/auth/password.zig");
const ratelimit = @import("../http/ratelimit.zig");
const dltokensmod = @import("../http/download_tokens.zig");
const filesmod = @import("../services/files.zig");
const noteindex = @import("../services/note_index.zig");
const deferredmod = @import("../services/deferred.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const uploadcap = @import("../handlers/upload_cap.zig");
const eventstreams = @import("../http/event_streams.zig");
const pendingsvc = @import("../services/pending.zig");
const deferredsvc = @import("../services/deferred.zig");
const readerpool = @import("../db/reader_pool.zig");
const lockstats = @import("../http/lock_stats.zig");
const sn = @import("supernote");

const Context = context.Context;
const gpa = std.testing.allocator;

// ---- tiny HTTP client over the in-memory transport ----

const Header = struct { name: []const u8, value: []const u8 };

const Response = struct {
    status: u16,
    body: []const u8, // slice into the caller's response buffer
    set_cookie: ?[]const u8,
    head: []const u8, // the raw header block (status line + headers), for header assertions
};

fn buildRequest(buf: []u8, method: []const u8, path: []const u8, headers: []const Header, body: []const u8) ![]const u8 {
    var w = std.Io.Writer.fixed(buf);
    try w.print("{s} {s} HTTP/1.1\r\n", .{ method, path });
    try w.writeAll("host: test\r\n");
    for (headers) |h| try w.print("{s}: {s}\r\n", .{ h.name, h.value });
    try w.print("content-length: {d}\r\n\r\n", .{body.len});
    try w.writeAll(body);
    return buf[0..w.end];
}

fn roundtrip(ctx: *Context, req_bytes: []const u8, out_buf: []u8) !Response {
    var in = std.Io.Reader.fixed(req_bytes);
    var out = std.Io.Writer.fixed(out_buf);
    var server = std.http.Server.init(&in, &out);
    var req = try server.receiveHead();
    try transport.handle(ctx, &app.routes, &req);
    return parseResponse(out_buf[0..out.end]);
}

/// `roundtrip` plus how many request bytes the server read: the ingest cap is
/// about where a body stops, so tests assert on this, not just the aftermath.
const Sent = struct { resp: Response, consumed: usize };

fn roundtripCounting(ctx: *Context, req_bytes: []const u8, out_buf: []u8) !Sent {
    var in = std.Io.Reader.fixed(req_bytes);
    var out = std.Io.Writer.fixed(out_buf);
    var server = std.http.Server.init(&in, &out);
    var req = try server.receiveHead();
    try transport.handle(ctx, &app.routes, &req);
    return .{ .resp = try parseResponse(out_buf[0..out.end]), .consumed = in.seek };
}

fn parseResponse(raw: []const u8) !Response {
    const sep = std.mem.indexOf(u8, raw, "\r\n\r\n") orelse return error.BadResponse;
    const head = raw[0..sep];
    var lines = std.mem.splitSequence(u8, head, "\r\n");

    const status_line = lines.next() orelse return error.BadResponse; // "HTTP/1.1 200 OK"
    var fields = std.mem.splitScalar(u8, status_line, ' ');
    _ = fields.next(); // version
    const code = fields.next() orelse return error.BadResponse;

    var set_cookie: ?[]const u8 = null;
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "set-cookie:")) {
            set_cookie = std.mem.trim(u8, line["set-cookie:".len..], " ");
        }
    }
    return .{
        .status = try std.fmt.parseInt(u16, code, 10),
        .body = raw[sep + 4 ..],
        .set_cookie = set_cookie,
        .head = head,
    };
}

/// The session token inside a `sn_session=...; …` Set-Cookie value.
fn cookieToken(set_cookie: []const u8) ?[]const u8 {
    const prefix = context.session_cookie_name ++ "=";
    if (!std.mem.startsWith(u8, set_cookie, prefix)) return null;
    const rest = set_cookie[prefix.len..];
    const end = std.mem.indexOfScalar(u8, rest, ';') orelse rest.len;
    return rest[0..end];
}

/// The login password field: `sha256_hex(md5_hex(pw) + randomCode)` over the
/// full nonce.
fn challenge(pw: []const u8, code: []const u8) [password.sha256_len]u8 {
    return password.challengeHash(&password.md5Hex(pw), code);
}

/// A random code for `account`, copied out (the response buffer is reused).
fn getCode(ctx: *Context, account: []const u8) ![authsvc.code_len]u8 {
    var bodybuf: [256]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var obuf: [2048]u8 = undefined;
    const body = try std.fmt.bufPrint(&bodybuf, "{{\"account\":\"{s}\"}}", .{account});
    const req = try buildRequest(&reqbuf, "POST", "/api/official/user/query/random/code", &.{
        .{ .name = "content-type", .value = "application/json" },
    }, body);
    const resp = try roundtrip(ctx, req, &obuf);
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    var parsed = try std.json.parseFromSlice(struct { randomCode: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    var code: [authsvc.code_len]u8 = undefined;
    @memcpy(&code, parsed.value.randomCode[0..authsvc.code_len]);
    return code;
}

/// Logs in with the temp password, changes to `final_pw`, returns the web
/// session token.
fn onboardWeb(ctx: *Context, account: []const u8, temp: []const u8, final_pw: []const u8) ![32]u8 {
    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const code = try getCode(ctx, account);
    const hash = challenge(temp, &code);
    const login_body = try std.fmt.allocPrint(gpa, "{{\"account\":\"{s}\",\"password\":\"{s}\"}}", .{ account, hash[0..] });
    defer gpa.free(login_body);

    var pending: [32]u8 = undefined;
    {
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, login_body);
        const resp = try roundtrip(ctx, req, &obuf);
        @memcpy(&pending, cookieToken(resp.set_cookie.?).?);
    }

    const new_md5 = password.md5Hex(final_pw);
    const cur_md5 = password.md5Hex(temp);
    const change_body = try std.fmt.allocPrint(gpa, "{{\"currentPassword\":\"{s}\",\"newPassword\":\"{s}\"}}", .{ cur_md5[0..], new_md5[0..] });
    defer gpa.free(change_body);
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/user/password", &pending, change_body);
    var web: [32]u8 = undefined;
    @memcpy(&web, cookieToken(resp.set_cookie.?).?);
    return web;
}

/// POST /api/admin/elevate through the login challenge flow; returns the raw
/// response.
fn tryElevate(ctx: *Context, obuf: []u8, reqbuf: []u8, account: []const u8, pw: []const u8, tok: []const u8) !Response {
    const code = try getCode(ctx, account);
    const hash = challenge(pw, &code);
    const body = try std.fmt.allocPrint(gpa, "{{\"password\":\"{s}\"}}", .{hash[0..]});
    defer gpa.free(body);
    return requestWithCookie(ctx, obuf, reqbuf, "POST", "/api/admin/elevate", tok, body);
}

fn elevate(ctx: *Context, obuf: []u8, reqbuf: []u8, account: []const u8, pw: []const u8, tok: []const u8) !void {
    const resp = try tryElevate(ctx, obuf, reqbuf, account, pw, tok);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
}

const Fixture = struct {
    db: sqlite.Db,
    svc: authsvc.Service,
    limiter: ratelimit.Limiter,
    dltokens: dltokensmod.DownloadTokens,
    files: filesmod.Files,
    tmp: std.testing.TmpDir,
    ctx: Context,
    /// Set only by `initPooled`: a second connection to `:memory:` opens a
    /// different, empty database, so the pooled fixture is on disk.
    path_buf: [128]u8 = undefined,
    pool: ?readerpool.Pool = null,
    db_lock: std.Io.Mutex = .init,
    stats: lockstats.LockStats = .{},

    fn init() !*Fixture {
        return initWith(false, readerpool.default_size);
    }

    /// On-disk DB, real `db_lock`, per-route histogram and `readers` readers
    /// (`0` = pool always empty).
    fn initPooled(readers: usize) !*Fixture {
        return initWith(true, readers);
    }

    fn initWith(on_disk: bool, readers: usize) !*Fixture {
        const f = try gpa.create(Fixture);
        f.pool = null;
        f.db_lock = .init;
        f.stats = .{};
        f.tmp = std.testing.tmpDir(.{});
        if (on_disk) {
            const path = try std.fmt.bufPrintSentinel(&f.path_buf, ".zig-cache/tmp/{s}/inkhold.db", .{f.tmp.sub_path}, 0);
            f.db = try sqlite.Db.open(path);
            try schema.migrate(f.db);
            f.pool = try readerpool.Pool.open(gpa, path, readers);
        } else {
            f.db = try sqlite.Db.openMemory();
            try schema.migrate(f.db);
        }
        f.svc = authsvc.Service.init(gpa, std.testing.io, f.db, @splat(0xA5));
        f.limiter = ratelimit.Limiter.init(gpa);
        f.dltokens = dltokensmod.DownloadTokens.init(gpa);
        const store = try blobstore.BlobStore.init(std.testing.io, f.tmp.dir);
        const thumbs_dir = try f.tmp.dir.createDirPathOpen(std.testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(std.testing.io, thumbs_dir);
        f.files = filesmod.Files.init(gpa, std.testing.io, f.db, store, thumbs);
        f.ctx = .{
            .gpa = gpa,
            .io = std.testing.io,
            .config = .{},
            .service = &f.svc,
            .files = &f.files,
            .limiter = &f.limiter,
            .download_tokens = &f.dltokens,
            .client_ip = "203.0.113.7", // a stable test client IP
        };
        if (f.pool) |*p| {
            // Only the pooled fixture gets a real lock and stats table; giving the
            // in-memory one a lock would change the path most tests exercise.
            f.ctx.readers = p;
            f.ctx.db_lock = &f.db_lock;
            f.ctx.lock_stats = &f.stats;
        }
        return f;
    }

    fn deinit(f: *Fixture) void {
        f.svc.deinit();
        f.limiter.deinit();
        f.dltokens.deinit();
        // Readers close before the writer, which keeps the `-shm` file alive.
        if (f.pool) |*p| p.close(gpa);
        f.db.close();
        f.tmp.cleanup();
        gpa.destroy(f);
    }

    fn slotFor(f: *Fixture, table: []const router.Route, path: []const u8) *const lockstats.Slot {
        for (table, 0..) |r, i| {
            if (std.mem.eql(u8, r.path, path)) return &f.stats.slots[i];
        }
        unreachable;
    }
};

/// A slot's (seconds, remainder) pair as nanoseconds (the pair exists because
/// ARMv6 has no 64-bit atomic).
fn nsOfSlot(s: *const lockstats.Slot) u64 {
    return @as(u64, s.total_s) * std.time.ns_per_s + s.total_ns_rem;
}

// ---- tests ----

test "control-plane first login is limited, change-password revokes it and unlocks web, logout kills the session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "temp0000"); // must_change_password = 1

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const code = try getCode(ctx, "admin");
    const hash = challenge("temp0000", &code);
    const login_body = try std.fmt.allocPrint(gpa, "{{\"account\":\"admin\",\"password\":\"{s}\"}}", .{hash[0..]});
    defer gpa.free(login_body);
    var pending_tok: [32]u8 = undefined;
    {
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, login_body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const tok = cookieToken(resp.set_cookie.?).?;
        try std.testing.expectEqual(@as(usize, 32), tok.len);
        @memcpy(&pending_tok, tok);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &pending_tok, "{\"equipmentNo\":\"X\"}", 403);

    var web_tok: [32]u8 = undefined;
    {
        const new_md5 = password.md5Hex("newpass1");
        const body = try std.fmt.allocPrint(gpa, "{{\"newPassword\":\"{s}\"}}", .{new_md5[0..]});
        defer gpa.free(body);
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/user/password", &pending_tok, body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const tok = cookieToken(resp.set_cookie.?).?;
        @memcpy(&web_tok, tok);
        try std.testing.expect(!std.mem.eql(u8, &pending_tok, &web_tok)); // rotated
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &pending_tok, "{\"equipmentNo\":\"X\"}", 401);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &web_tok, "{\"equipmentNo\":\"X\"}", 200);

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/user/logout", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.set_cookie.?, "Max-Age=0") != null);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &web_tok, "{\"equipmentNo\":\"X\"}", 401);
}

// ---- self-service password change ----
// A `controlplane` caller must send `currentPassword` (handler policy); one that
// is sent is verified for any audience (service mechanism).

/// Logs in with an owned password and returns the control-plane token; spends
/// no `PUT /api/user/password` budget, unlike `onboardWeb`.
fn webLogin(ctx: *Context, account: []const u8, pw: []const u8) ![32]u8 {
    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const code = try getCode(ctx, account);
    const hash = challenge(pw, &code);
    const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"{s}\",\"password\":\"{s}\"}}", .{ account, hash[0..] });
    defer gpa.free(body);
    const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
        .{ .name = "content-type", .value = "application/json" },
    }, body);
    const resp = try roundtrip(ctx, req, &obuf);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var tok: [32]u8 = undefined;
    @memcpy(&tok, cookieToken(resp.set_cookie.?).?);
    return tok;
}

/// A `PUT /api/user/password` body; `current` null omits the field.
fn changePasswordBody(current: ?[]const u8, new_pw: []const u8) ![]u8 {
    const new_md5 = password.md5Hex(new_pw);
    if (current) |c| {
        const cur_md5 = password.md5Hex(c);
        return std.fmt.allocPrint(gpa, "{{\"currentPassword\":\"{s}\",\"newPassword\":\"{s}\"}}", .{ cur_md5[0..], new_md5[0..] });
    }
    return std.fmt.allocPrint(gpa, "{{\"newPassword\":\"{s}\"}}", .{new_md5[0..]});
}

fn tryChangePassword(ctx: *Context, obuf: []u8, reqbuf: []u8, tok: []const u8, current: ?[]const u8, new_pw: []const u8) !Response {
    const body = try changePasswordBody(current, new_pw);
    defer gpa.free(body);
    return requestWithCookie(ctx, obuf, reqbuf, "PUT", "/api/user/password", tok, body);
}

fn passwordChangedAt(f: *Fixture, user_id: u64) !?i64 {
    var r = (try f.db.row("SELECT password_changed_at FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return error.NoSuchUser;
    defer r.finalize();
    return r.intOpt(0);
}

test "CHANGE PASSWORD: a WRONG current password is refused and leaves every session standing" {
    // Verification must precede the UPDATE, `revokeAllSessions` and
    // `issueSession`, so a typo does not sign out every session.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const desk = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const phone = try webLogin(ctx, "admin", "adminpw1"); // a second browser, elsewhere
    const stamp_before = try passwordChangedAt(f, admin);

    const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &desk, "not-my-password", "adminpw2");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try expectFailure(resp.body, "INVALID_CREDENTIALS");
    try std.testing.expect(resp.set_cookie == null);

    // A refusal issued after revocation would pass the status check; this is
    // the durable half.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &desk, "", 200);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &phone, "", 200);

    try std.testing.expectEqual(stamp_before, try passwordChangedAt(f, admin));
    _ = try webLogin(ctx, "admin", "adminpw1");
    {
        const code = try getCode(ctx, "admin");
        const hash = challenge("adminpw2", &code);
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"admin\",\"password\":\"{s}\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const bad = try roundtrip(ctx, req, &obuf);
        try expectFailure(bad.body, "INVALID_CREDENTIALS");
    }
}

test "CHANGE PASSWORD: the RIGHT current password rotates it, revokes every other session, and stamps the change" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const desk = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const phone = try webLogin(ctx, "admin", "adminpw1");

    // Backdate so "it moved" holds even when the suite finishes within a second.
    {
        var s = try f.db.prepare("UPDATE users SET password_changed_at = 0 WHERE id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(admin));
        _ = try s.step();
    }

    var fresh: [32]u8 = undefined;
    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &desk, "adminpw1", "adminpw2");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
        const tok = cookieToken(resp.set_cookie.?).?;
        @memcpy(&fresh, tok);
        try std.testing.expect(!std.mem.eql(u8, &desk, &fresh)); // rotated
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &fresh, "", 200);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &desk, "", 401);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &phone, "", 401);
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM sessions;"));

    const stamp = (try passwordChangedAt(f, admin)) orelse return error.StampMissing;
    try std.testing.expect(stamp > 0);
    _ = try webLogin(ctx, "admin", "adminpw2");
}

test "CHANGE PASSWORD: a control-plane caller that OMITS the current password is refused" {
    // A live session is not proof enough; answered with the same code as a
    // wrong password.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const desk = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const stamp_before = try passwordChangedAt(f, admin);

    const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &desk, null, "adminpw2");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try expectFailure(resp.body, "INVALID_CREDENTIALS");
    try std.testing.expect(resp.set_cookie == null);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &desk, "", 200);
    try std.testing.expectEqual(stamp_before, try passwordChangedAt(f, admin));
    _ = try webLogin(ctx, "admin", "adminpw1");
}

test "CHANGE PASSWORD: a first-login PENDING caller needs no current password — but a wrong one still refuses it" {
    // Onboarding works with no current password, yet a `pending` caller that
    // sends one is still verified.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = try f.svc.createUser(admin, "bob", false);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const pending = try webLogin(ctx, "bob", bob.temp_password.slice());

    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &pending, "guessing", "bobpass1");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
        try std.testing.expect(resp.set_cookie == null);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &pending, "", 200);
    try std.testing.expectEqual(@as(?i64, null), try passwordChangedAt(f, bob.id));

    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &pending, null, "bobpass1");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
        try std.testing.expect(cookieToken(resp.set_cookie.?) != null);
    }
    try std.testing.expect((try passwordChangedAt(f, bob.id)) != null);
    _ = try webLogin(ctx, "bob", "bobpass1");
}

test "CHANGE PASSWORD is rate-limited per USER, so an unattended browser is not a password oracle" {
    // 5 per 5 minutes per account, not per IP: a household shares an address and
    // must not block a housemate's forced first-login change.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    // Provisioned at the service layer so both start with a full bucket.
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("alicepw1"));
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bobpw111"));

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const a_tok = try webLogin(ctx, "alice", "alicepw1");
    const b_tok = try webLogin(ctx, "bob", "bobpw111");

    var i: usize = 0;
    while (i < 5) : (i += 1) {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &a_tok, "guess", "newpw123");
        try std.testing.expectEqual(@as(u16, 200), resp.status); // allowed through, refused on merit
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
    }
    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &a_tok, "guess", "newpw123");
        try std.testing.expectEqual(@as(u16, 429), resp.status);
    }
    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &a_tok, "alicepw1", "newpw123");
        try std.testing.expectEqual(@as(u16, 429), resp.status);
    }

    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &b_tok, "bobpw111", "bobpw222");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &a_tok, "", 200);
}

test "device login returns a body token, binds, and cannot cross into the control-plane face" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111")); // clears must_change

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const code = try getCode(ctx, "alice");
    const hash = challenge("apass111", &code);
    var dev_tok: [32]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"alice\",\"password\":\"{s}\",\"equipmentNo\":\"SN1\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(resp.set_cookie == null); // device face: no cookie

        var parsed = try std.json.parseFromSlice(
            struct { token: []const u8, isBindEquipment: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqualStrings("N", parsed.value.isBindEquipment);
        try std.testing.expectEqual(@as(usize, 32), parsed.value.token.len);
        @memcpy(&dev_tok, parsed.value.token);
    }

    {
        const req = try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &.{
            .{ .name = "content-type", .value = "application/json" },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\"}");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expect(try f.svc.isDeviceBound(alice, "SN1"));

    {
        const req = try buildRequest(&reqbuf, "POST", "/api/controlplane/equipment/unlink", &.{
            .{ .name = "content-type", .value = "application/json" },
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "{\"equipmentNo\":\"SN1\"}");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
}

test "app login (equipment:2, no serial) yields a body token, reaches device routes, lazily binds; web still gets a cookie" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111")); // clears must_change

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // `equipment:2` (a JSON int) with no `equipmentNo`: the self-declared face,
    // not the serial, picks a device session.
    const code = try getCode(ctx, "alice");
    const hash = challenge("apass111", &code);
    var app_tok: [32]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"alice\",\"password\":\"{s}\",\"equipment\":2,\"equipmentNo\":null,\"devices\":\"ANDROID\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(resp.set_cookie == null); // device face: no cookie
        var p = try std.json.parseFromSlice(
            struct { token: []const u8, isBind: []const u8, isBindEquipment: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqualStrings("Y", p.value.isBind);
        try std.testing.expectEqualStrings("N", p.value.isBindEquipment);
        try std.testing.expectEqual(@as(usize, 32), p.value.token.len);
        @memcpy(&app_tok, p.value.token);
    }

    // The app sends its ANDROID-… serial per request and is auto-bound lazily;
    // it never calls bindEquipment.
    const app_eno = "ANDROID-c0c59ca7-dead-beef";
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"equipmentNo\":\"{s}\"}}", .{app_eno});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/synchronous/start", &app_tok, app_eno, body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expect(try f.svc.isDeviceBound(alice, app_eno)); // auto-bound

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/equipment/bind/status", &app_tok, app_eno, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { success: bool, bindStatus: bool }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expect(p.value.bindStatus);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/capacity/query", &app_tok, app_eno, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { success: bool, usedCapacity: i64, totalCapacity: i64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(authsvc.default_capacity, p.value.totalCapacity);
    }

    {
        const code2 = try getCode(ctx, "alice");
        const hash2 = challenge("apass111", &code2);
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"alice\",\"password\":\"{s}\"}}", .{hash2[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(resp.set_cookie != null); // cookie path
        var p = try std.json.parseFromSlice(struct { token: ?[]const u8 = null }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.token == null); // no body token for the SPA
    }
}

test "login rejects a missing challenge and a wrong password" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    _ = try f.svc.changePassword(admin, null, &password.md5Hex("adminpw1"));

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    {
        const body = "{\"account\":\"admin\",\"password\":\"" ++ (repeat(u8, "0", 64)) ++ "\"}";
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "NO_CHALLENGE");
    }

    {
        const code = try getCode(ctx, "admin");
        const hash = challenge("WRONGpw!", &code);
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"admin\",\"password\":\"{s}\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
    }
}

test "login is rate-limited by IP after too many attempts (429)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const body = "{\"account\":\"x\",\"password\":\"y\"}"; // no challenge -> 200 NO_CHALLENGE (not limited)

    // Login allows 10/min per IP; the 11th is 429.
    var i: usize = 0;
    while (i < 10) : (i += 1) {
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
        .{ .name = "content-type", .value = "application/json" },
    }, body);
    const resp = try roundtrip(ctx, req, &obuf);
    try std.testing.expectEqual(@as(u16, 429), resp.status);
}

test "admin manages household users over HTTP; non-admins are forbidden (require_admin)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00"); // is_admin, must_change

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    var bob_id: u64 = undefined;
    var bob_temp_buf: [password.max_temp_len]u8 = undefined;
    var bob_temp_len: usize = 0;
    {
        const body = "{\"email\":\"bob\"}";
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { userId: u64, temporaryPassword: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        bob_id = parsed.value.userId;
        try std.testing.expect(parsed.value.temporaryPassword.len > 0 and parsed.value.temporaryPassword.len <= password.max_temp_len);
        bob_temp_len = parsed.value.temporaryPassword.len;
        @memcpy(bob_temp_buf[0..bob_temp_len], parsed.value.temporaryPassword);

        const dup = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, body);
        try expectFailure(dup.body, "EMAIL_EXISTS");
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { users: []struct { email: []const u8 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 2), parsed.value.users.len);
    }

    // A non-admin gets a plain 403 on admin routes, never the elevation gate.
    const bob_temp = bob_temp_buf[0..bob_temp_len];
    const bob_tok = try onboardWeb(ctx, "bob", bob_temp, "bobpw123");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 403);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/reset", .{bob_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { temporaryPassword: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expect(parsed.value.temporaryPassword.len > 0 and parsed.value.temporaryPassword.len <= password.max_temp_len);
        try std.testing.expect(!std.mem.eql(u8, bob_temp, parsed.value.temporaryPassword)); // a fresh one
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 401);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}", .{bob_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "");
        var parsed = try std.json.parseFromSlice(
            struct { users: []struct { email: []const u8 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 1), parsed.value.users.len); // only admin remains
    }
}

test "admin devices + quota over HTTP: the gate, the 403, and the cross-user unlink that must not land" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp0");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    try f.svc.bindDevice(alice, "SN-ALICE-1", "Alice's Nomad");
    try f.svc.bindDevice(bob, "SN-BOB-1", "Bob's Manta");

    var obuf: [8192]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    // One buffer per path: these are held across later requests.
    var devbuf: [96]u8 = undefined;
    var quotabuf: [96]u8 = undefined;
    var pbuf: [96]u8 = undefined;

    const devices_path = try std.fmt.bufPrint(&devbuf, "/api/admin/users/{d}/devices", .{alice});
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");

    // Unelevated admin gets 428, never 401 (which would sign them out).
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &admin_tok, "", 428);
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { devices: []struct { equipment_no: []const u8, name: []const u8, active: bool, created_at: i64 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 1), parsed.value.devices.len);
        try std.testing.expectEqualStrings("SN-ALICE-1", parsed.value.devices[0].equipment_no);
        try std.testing.expect(parsed.value.devices[0].active);
    }

    // Alice's id with Bob's serial must 404 and leave Bob's binding active.
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-BOB-1\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "DEVICE_NOT_FOUND") != null);
    }
    try std.testing.expectEqual(@as(i64, 1), try f.svc.deviceCount(bob));

    // An unheld serial answers identically, so ownership cannot be probed.
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-NOBODY\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "DEVICE_NOT_FOUND") != null);
    }

    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{bob});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-BOB-1\"}", 200);
    }
    try std.testing.expectEqual(@as(i64, 0), try f.svc.deviceCount(bob));

    // Quota below usage is accepted and reports used > total.
    const quota_path = try std.fmt.bufPrint(&quotabuf, "/api/admin/users/{d}/quota", .{alice});
    {
        var s = try f.db.prepare("UPDATE capacity SET used_bytes = 5000 WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", quota_path, &admin_tok, "{\"totalBytes\":100}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { used_bytes: i64, total_bytes: i64 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(i64, 100), parsed.value.total_bytes);
        try std.testing.expectEqual(@as(i64, 5000), parsed.value.used_bytes);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", quota_path, &admin_tok, "{\"totalBytes\":-1}");
        try std.testing.expectEqual(@as(u16, 400), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "INVALID_QUOTA") != null);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users/9999/quota", &admin_tok, "", 404);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users/9999/devices", &admin_tok, "", 404);

    const bob_temp = (try f.svc.resetPassword(admin, bob));
    const bob_tok = try onboardWeb(ctx, "bob", bob_temp.slice(), "bobpw123");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &bob_tok, "", 403);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", quota_path, &bob_tok, "", 403);
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{bob});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &bob_tok, "{\"equipmentNo\":\"SN-BOB-1\"}", 403);
    }
}

test "admin retention and health over HTTP: the window round-trips and health names no one" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    _ = try f.svc.bootstrapAdmin("admin", "admtemp0");

    var obuf: [8192]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/settings/retention", &admin_tok, "", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/health", &admin_tok, "", 428);
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    const Retention = struct { retentionDays: i64, defaultDays: i64, minDays: i64, maxDays: i64, changedAt: i64 };

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/settings/retention", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Retention, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 30), p.value.retentionDays);
        try std.testing.expectEqual(@as(i64, 30), p.value.defaultDays);
        try std.testing.expectEqual(@as(i64, 1), p.value.minDays);
        try std.testing.expectEqual(@as(i64, 365), p.value.maxDays);
        try std.testing.expectEqual(@as(i64, 0), p.value.changedAt);
    }

    // `changedAt` starts the grace that stops a shortened window purging the
    // bin retroactively.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/settings/retention", &admin_tok, "{\"retentionDays\":7}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Retention, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 7), p.value.retentionDays);
        try std.testing.expect(p.value.changedAt > 0);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/settings/retention", &admin_tok, "{\"retentionDays\":0}", 400);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/settings/retention", &admin_tok, "{\"retentionDays\":9999}", 400);

    // The bin quotes the configured window, not the constant.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/bin", &admin_tok, "");
        var p = try std.json.parseFromSlice(struct { retentionDays: i64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 7), p.value.retentionDays);
    }

    // Household-wide totals only; the absence assertions guard against
    // per-person fields.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/health", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { health: struct { version: []const u8, memory_budget_bytes: i64, blob_bytes: i64, blob_count: i64 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqualStrings(app.api_version, p.value.health.version);
        try std.testing.expectEqual(@as(i64, 50 * 1024 * 1024), p.value.health.memory_budget_bytes);
        try std.testing.expectEqual(@as(i64, 0), p.value.health.blob_count);
        for ([_][]const u8{ "lastSync", "last_sync", "noteCount", "note_count", "user", "email" }) |leak| {
            if (std.mem.indexOf(u8, resp.body, leak) != null) {
                std.debug.print("health response leaked per-person field: {s}\n", .{leak});
                return error.HealthLeaksActivity;
            }
        }
    }
}

test "DELETE /api/admin/users releases the account's blobs, but only decrements one shared with another user" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp0");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    // Identical bytes dedup to one blob at refcount 2; deleting Alice must not
    // destroy Bob's copy.
    _ = try putSeed(f, alice, null, "solo.note", "alice private bytes");
    _ = try putSeed(f, alice, null, "shared.note", "bytes both of them have");
    const bob_shared = try putSeed(f, bob, null, "shared.note", "bytes both of them have");

    try std.testing.expectEqual(@as(i64, 2), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
    const shared_md5 = try soleMd5(f, bob_shared);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT refcount FROM blobs;"));
    try std.testing.expect(f.files.blobs.has(&shared_md5));

    try std.testing.expectEqual(@as(usize, 0), (try f.files.list(alice, null)).len);
    const listing = try f.files.list(bob, null);
    defer filesmod.Files.freeEntries(gpa, listing);
    try std.testing.expectEqual(@as(usize, 1), listing.len);
    try std.testing.expectEqualStrings("shared.note", listing[0].name);
    try std.testing.expectEqualSlices(u8, &shared_md5, listing[0].md5.?);
}

test "sync supersede RETAINS the prior version: history row, old blob kept, and BOTH are charged" {
    const f = try Fixture.init();
    defer f.deinit();

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp0");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;

    // Default fixture keeps history (keep = 5); an edit under the same path.
    const dir = try f.files.ensureFolderPath(alice, "NOTE/Note");
    const v1 = "first-version-of-the-note";
    const v2 = "second-version-of-the-note-that-is-a-bit-longer";
    const old_md5 = blobstore.md5HexOf(v1);

    const v1_id = try putSeed(f, alice, dir, "up.note", v1);
    try std.testing.expect(f.files.blobs.has(&old_md5));
    try std.testing.expectEqual(@as(i64, @intCast(v1.len)), try usedBytes(f, alice));

    const v2_id = try putSeed(f, alice, dir, "up.note", v2);
    try std.testing.expectEqual(v1_id, v2_id); // superseded the same file row, not a new one

    // v1 is retained: one history row, blob not GC'd.
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
    try std.testing.expectEqual(@as(i64, @intCast(v1.len)), try countRows(f, "SELECT size FROM file_history;"));
    try std.testing.expect(f.files.blobs.has(&old_md5));
    // The retained version is charged to the owner, like a trashed file.
    try std.testing.expectEqual(@as(i64, @intCast(v1.len + v2.len)), try usedBytes(f, alice));
    // Two blobs coexist; search stays current-only because the manifest only
    // reaches blobs a live row points at.
    try std.testing.expectEqual(@as(i64, 2), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
}

// ---- versioning: "history of this file" endpoints ----

/// Seeds a one-page recognized `.note`; a second call with the same name
/// supersedes the first, retaining v1 in `file_history`.
fn seedRecognizedVersion(f: *Fixture, user_id: u64, name: []const u8, bitmap: []const u8, labels: []const []const u8) !u64 {
    const nb = @import("note_builder");
    const els = try gpa.alloc(nb.ElementSpec, labels.len);
    defer gpa.free(els);
    for (labels, els) |label, *e| e.* = .{ .label = label };

    const bytes = try nb.serialize(gpa, .{ .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }}, .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = bitmap }},
        .recogn_status = 1,
        .recogn_elements = els,
    }} });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
    return e.id;
}

/// N-page variant of `seedRecognizedVersion`, so a retained version can differ
/// in page count from the current one.
fn seedRecognizedVersionPages(f: *Fixture, user_id: u64, name: []const u8, page_count: usize, bitmap: []const u8, label: []const u8) !u64 {
    const nb = @import("note_builder");
    const els = try gpa.alloc(nb.ElementSpec, 1);
    defer gpa.free(els);
    els[0] = .{ .label = label };

    const pgs = try gpa.alloc(nb.PageSpec, page_count);
    defer gpa.free(pgs);
    for (pgs) |*p| p.* = .{
        .layers = &.{.{ .slot = .main, .bitmap = bitmap }},
        .recogn_status = 1,
        .recogn_elements = els,
    };

    const bytes = try nb.serialize(gpa, .{ .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }}, .pages = pgs });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
    return e.id;
}

/// The single retained-version md5 of `file_id`.
fn soleHistoryMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM file_history WHERE file_id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoHistory;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0)[0..32]);
    return out;
}

fn currentFileMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM files WHERE id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoFile;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0)[0..32]);
    return out;
}

test "history list: current + retained versions newest-first; foreign id is 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const id = try seedRecognizedVersion(f, admin, "hist.note", "AAAA", &.{ "alpha", "common" });
    _ = try seedRecognizedVersion(f, admin, "hist.note", "BBBB", &.{ "beta", "common" }); // v2 supersedes v1
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    const HistVersion = struct { md5: []const u8, size: i64, createdAt: i64, current: bool = false };
    var pbuf: [96]u8 = undefined;
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        var parsed = try std.json.parseFromSlice(
            struct { id: []const u8, versions: []HistVersion },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        const vs = parsed.value.versions;
        try std.testing.expectEqual(@as(usize, 2), vs.len);
        try std.testing.expect(vs[0].current);
        try std.testing.expectEqualStrings(&v2md5, vs[0].md5);
        try std.testing.expect(!vs[1].current);
        try std.testing.expectEqualStrings(&v1md5, vs[1].md5);
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/note/99999/history", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "history list: each version carries its OWN page count (current and retained differ)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const id = try seedRecognizedVersionPages(f, admin, "hist.note", 3, "AAAA", "alpha");
    _ = try seedRecognizedVersionPages(f, admin, "hist.note", 1, "BBBB", "beta");
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    var qbuf: [128]u8 = undefined;
    const v1_rows = try countRows(f, try std.fmt.bufPrint(&qbuf, "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = '{s}';", .{&v1md5}));
    var qbuf2: [128]u8 = undefined;
    const v2_rows = try countRows(f, try std.fmt.bufPrint(&qbuf2, "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = '{s}';", .{&v2md5}));
    try std.testing.expectEqual(@as(i64, 3), v1_rows);
    try std.testing.expectEqual(@as(i64, 1), v2_rows);

    const HistVersion = struct { md5: []const u8, size: i64, createdAt: i64, pageCount: i64 = 0, current: bool = false };
    var pbuf: [96]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history", .{id});
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    var parsed = try std.json.parseFromSlice(
        struct { id: []const u8, versions: []HistVersion },
        gpa,
        resp.body,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    const vs = parsed.value.versions;
    try std.testing.expectEqual(@as(usize, 2), vs.len);
    try std.testing.expect(vs[0].current);
    try std.testing.expectEqual(v2_rows, vs[0].pageCount);
    try std.testing.expectEqual(@as(i64, 1), vs[0].pageCount);
    try std.testing.expect(!vs[1].current);
    try std.testing.expectEqual(v1_rows, vs[1].pageCount);
    try std.testing.expectEqual(@as(i64, 3), vs[1].pageCount);
}

test "history list: a non-note file's versions report pageCount == 0" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    // A `.pdf` has no `note_page_index` rows, so both versions report 0 pages.
    const id = try putSeed(f, admin, null, "scan.pdf", "%PDF-1.4 first revision");
    _ = try putSeed(f, admin, null, "scan.pdf", "%PDF-1.4 second revision");
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM note_page_index;"));

    const HistVersion = struct { md5: []const u8, size: i64, createdAt: i64, pageCount: i64 = 0, current: bool = false };
    var pbuf: [96]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history", .{id});
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    var parsed = try std.json.parseFromSlice(
        struct { id: []const u8, versions: []HistVersion },
        gpa,
        resp.body,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    const vs = parsed.value.versions;
    try std.testing.expectEqual(@as(usize, 2), vs.len);
    for (vs) |v| try std.testing.expectEqual(@as(i64, 0), v.pageCount);
}

test "an unframed body-method request (POST, no Content-Length) responds instead of panicking the server" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var obuf: [4096]u8 = undefined;

    // A body-bearing method with neither Content-Length nor Transfer-Encoding:
    // std's `discardBody` asserts on it and panics the connection thread, so the
    // transport drops keep-alive. Without the guard this crashes the run.

    const unmatched = "POST /api/controlplane/nope HTTP/1.1\r\nhost: test\r\n\r\n";
    try std.testing.expectEqual(@as(u16, 404), (try roundtrip(ctx, unmatched, &obuf)).status);

    // Scope gate rejects before reading the body.
    const restore = "POST /api/controlplane/note/1/history/abc/restore HTTP/1.1\r\nhost: test\r\n\r\n";
    try std.testing.expectEqual(@as(u16, 401), (try roundtrip(ctx, restore, &obuf)).status);
}

test "history preview: serves v1's page bytes (distinct from v2); 404 for an md5 not in this file's history" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const id = try seedRecognizedVersion(f, admin, "hist.note", "AAAA", &.{"alpha"});
    _ = try seedRecognizedVersion(f, admin, "hist.note", "ZZZZZZ", &.{"beta"});
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    var v1_page: [4096]u8 = undefined;
    var v1_len: usize = 0;
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        @memcpy(v1_page[0..resp.body.len], resp.body);
        v1_len = resp.body.len;
        try std.testing.expect(v1_len > 0);
    }

    {
        const meta_path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{id});
        const meta = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", meta_path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), meta.status);
        var parsed = try std.json.parseFromSlice(
            struct { pages: []struct { hash: []const u8 } },
            gpa,
            meta.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        var hbuf: [40]u8 = undefined;
        const hash = try std.fmt.bufPrint(&hbuf, "{s}", .{parsed.value.pages[0].hash});

        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ id, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(!std.mem.eql(u8, v1_page[0..v1_len], resp.body)); // distinct versions
    }

    // The current blob is never reachable as "history".
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0", .{ id, v2md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        const bogus = "ffffffffffffffffffffffffffffffff";
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0", .{ id, bogus });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "history page text: serves v1's OWN retained transcript + word boxes, distinct from the current page's" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const nb = @import("note_builder");
    // A version's text and boxes come from its own retained `note_page_index`.
    const v1_els = [_]nb.ElementSpec{.{ .label = "alpha", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10.5, .y = 20.25, .width = 30.5, .height = 8.125 } },
    } }};
    const v2_els = [_]nb.ElementSpec{.{ .label = "beta", .words = &.{
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};
    const id = try seedRecognizedElements(f, admin, "vtext.note", "N6", &v1_els, false);
    _ = try seedRecognizedElements(f, admin, "vtext.note", "N6", &v2_els, false);
    const v1md5 = try soleHistoryMd5(f, id);

    const Body = struct {
        text: ?[]const u8 = null,
        words: ?[]const struct {
            text: []const u8,
            xMm: f32,
            yMm: f32,
            wMm: f32,
            hMm: f32,
        } = null,
    };

    // Same `PageTextVO` as the live route; `no-cache`, never `immutable`.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null); // raw VO
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{});
        defer p.deinit();
        try std.testing.expectEqualStrings("alpha", p.value.text.?);
        try std.testing.expectEqual(@as(usize, 1), p.value.words.?.len);
        try std.testing.expectEqualStrings("alpha", p.value.words.?[0].text);
        try std.testing.expectApproxEqAbs(@as(f32, 10.5), p.value.words.?[0].xMm, 0.001);
        try std.testing.expectApproxEqAbs(@as(f32, 20.25), p.value.words.?[0].yMm, 0.001);
        try std.testing.expectApproxEqAbs(@as(f32, 30.5), p.value.words.?[0].wMm, 0.001);
        try std.testing.expectApproxEqAbs(@as(f32, 8.125), p.value.words.?[0].hMm, 0.001);
    }

    {
        const meta_path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{id});
        const meta = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", meta_path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), meta.status);
        var parsed = try std.json.parseFromSlice(
            struct { pages: []struct { textHash: ?[]const u8 = null } },
            gpa,
            meta.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        var hbuf: [40]u8 = undefined;
        const hash = try std.fmt.bufPrint(&hbuf, "{s}", .{parsed.value.pages[0].textHash.?});

        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ id, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{});
        defer p.deinit();
        try std.testing.expectEqualStrings("beta", p.value.text.?); // distinct from v1
        try std.testing.expectApproxEqAbs(@as(f32, 40), p.value.words.?[0].xMm, 0.001); // distinct box
    }
}

test "history page text: 404 (indistinguishable) for a non-history md5, a bogus md5, a foreign owner's id, and a trashed id" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const mallory = (try f.svc.createUser(admin, "mallory", false)).id;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;

    const id = try seedRecognizedVersion(f, admin, "vt404.note", "AAAA", &.{"alpha"});
    _ = try seedRecognizedVersion(f, admin, "vt404.note", "BBBB", &.{"beta"});
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v2md5 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, repeat(u8, "f", 32) });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // Another user's real retained md5: the `user_id` scope 404s it.
    {
        const mid = try seedRecognizedVersion(f, mallory, "hers.note", "AAAA", &.{"one"});
        _ = try seedRecognizedVersion(f, mallory, "hers.note", "BBBB", &.{"two"});
        const mv1 = try soleHistoryMd5(f, mid);
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ mid, mv1 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // `historyVersion` requires `f.deleted = 0`, even for the owner.
    {
        try f.files.trash(admin, id);
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v1md5 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
}

test "history raw: serves v1's exact bytes (distinct from v2 and the live file), headers match /file/{id}; ?download forces attachment" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;

    const v1 = "spd-version-one-raw-bytes";
    const v2 = "spd-version-two-raw-bytes-and-a-little-longer";
    const id = try putSeed(f, admin, null, "draw.spd", v1);
    _ = try putSeed(f, admin, null, "draw.spd", v2); // v2 supersedes v1
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    // Headers match live `/file/{id}` for a `.spd`: attachment, nosniff,
    // immutable, etag = md5, declared content-length.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(v1, resp.body); // v1's EXACT bytes

        var hbuf: [64]u8 = undefined;
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&hbuf, "content-length: {d}", .{v1.len}));
        try expectHeaderAbsent(resp.head, "transfer-encoding");
        try expectHeaderContains(resp.head, "content-type: application/octet-stream");
        try expectHeaderContains(resp.head, "content-disposition: attachment;");
        try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&hbuf, "etag: \"{s}\"", .{v1md5}));
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ id, v2md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(v2, resp.body);
        try std.testing.expect(!std.mem.eql(u8, v1, resp.body)); // distinct from the retained version
        try expectHeaderContains(resp.head, "content-type: application/octet-stream");
        try expectHeaderContains(resp.head, "content-disposition: attachment;");
    }

    {
        const img1 = "img-version-one";
        const img2 = "img-version-two-differs";
        const pid = try putSeed(f, admin, null, "pic.png", img1);
        _ = try putSeed(f, admin, null, "pic.png", img2);
        const pv1 = try soleHistoryMd5(f, pid);

        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ pid, pv1 });
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
            try std.testing.expectEqual(@as(u16, 200), resp.status);
            try std.testing.expectEqualStrings(img1, resp.body);
            try expectHeaderContains(resp.head, "content-type: image/png");
            try expectHeaderContains(resp.head, "content-disposition: inline;");
        }
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw?download=1", .{ pid, pv1 });
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
            try std.testing.expectEqual(@as(u16, 200), resp.status);
            try std.testing.expectEqualStrings(img1, resp.body);
            try expectHeaderContains(resp.head, "content-disposition: attachment;");
        }
    }
}

test "history raw: 404 (indistinguishable) for a non-history md5, a bogus md5, a foreign owner's id, and a trashed id" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const mallory = (try f.svc.createUser(admin, "mallory", false)).id;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;

    const id = try putSeed(f, admin, null, "hraw.spd", "one");
    _ = try putSeed(f, admin, null, "hraw.spd", "two");
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ id, v2md5 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ id, repeat(u8, "f", 32) });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // Another user's real retained md5 404s: no cross-account existence oracle.
    {
        const mid = try putSeed(f, mallory, null, "hers.spd", "m1");
        _ = try putSeed(f, mallory, null, "hers.spd", "m2");
        const mv1 = try soleHistoryMd5(f, mid);
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ mid, mv1 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    {
        try f.files.trash(admin, id);
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ id, v1md5 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
}

test "history meta: serves the VERSION's own page count, not the current note's; 404 for a foreign id / non-history md5" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    // A version's meta must use its own page geometry, not the current note's.
    const id = try seedRecognizedVersionPages(f, admin, "histmeta.note", 3, "AAAA", "alpha");
    _ = try seedRecognizedVersionPages(f, admin, "histmeta.note", 1, "BBBB", "beta");
    const v1md5 = try soleHistoryMd5(f, id);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { pages: []struct { index: i64 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 1), parsed.value.pages.len);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/meta", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { fileHash: []const u8, pages: []struct { index: i64, width: i64, height: i64 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 3), parsed.value.pages.len);
        try std.testing.expectEqualStrings(&v1md5, parsed.value.fileHash);
        for (parsed.value.pages, 0..) |p, i| {
            try std.testing.expectEqual(@as(i64, @intCast(i)), p.index);
            try std.testing.expect(p.width > 0 and p.height > 0);
        }
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/99999/history/{s}/meta", .{v1md5});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        const v2md5 = try currentFileMd5(f, id);
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/meta", .{ id, v2md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        const bogus = "ffffffffffffffffffffffffffffffff";
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/meta", .{ id, bogus });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

// Find in a retained version is done in the browser over `text/<md5>`; the
// server has no history search route.

test "history restore: re-points via supersede, flips what is searchable, and is undoable" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const id = try seedRecognizedVersion(f, admin, "hist.note", "AAAA", &.{ "alpha", "common" });
    _ = try seedRecognizedVersion(f, admin, "hist.note", "BBBB", &.{ "beta", "common" });
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, admin, "beta"));
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, admin, "alpha"));

    const RestoreVO = struct { success: bool, md5: []const u8, size: i64, createdAt: i64, current: bool };

        // Restore goes through the supersede path, not a raw md5 UPDATE: the
        // search manifest ships live rows by md5.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/restore", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web_tok, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(RestoreVO, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        try std.testing.expect(parsed.value.success);
        try std.testing.expectEqualStrings(&v1md5, parsed.value.md5);
        try std.testing.expect(parsed.value.current);
    }

    try std.testing.expectEqualSlices(u8, &v1md5, &(try currentFileMd5(f, id))); // current is v1 now
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, admin, "alpha")); // v1 re-indexed
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, admin, "beta")); // v2 displaced
    try std.testing.expectEqualSlices(u8, &v2md5, &(try soleHistoryMd5(f, id)));

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/restore", .{ id, v2md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web_tok, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqualSlices(u8, &v2md5, &(try currentFileMd5(f, id)));
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, admin, "beta"));
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, admin, "alpha"));
    try std.testing.expectEqualSlices(u8, &v1md5, &(try soleHistoryMd5(f, id)));
}

fn countRows(f: *Fixture, sql: []const u8) !i64 {
    var s = try f.db.prepare(sql);
    defer s.finalize();
    _ = try s.step();
    return s.columnInt(0);
}

fn soleMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM files WHERE id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoSuchFile;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0));
    return out;
}

test "control-plane login signals must-change; /api/user/me restores identity across states" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "temp0000"); // is_admin, must_change

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    var pending: [32]u8 = undefined;
    {
        const code = try getCode(ctx, "admin");
        const hash = challenge("temp0000", &code);
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"admin\",\"password\":\"{s}\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        var p = try std.json.parseFromSlice(struct { mustChangePassword: bool }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.mustChangePassword);
        @memcpy(&pending, cookieToken(resp.set_cookie.?).?);
    }

    // Still-must-change on /me is what routes a reload to change-password.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &pending, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { email: []const u8, isAdmin: bool, mustChangePassword: bool },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqualStrings("admin", p.value.email);
        try std.testing.expect(p.value.isAdmin);
        try std.testing.expect(p.value.mustChangePassword);
    }

    var web: [32]u8 = undefined;
    {
        const new_md5 = password.md5Hex("adminpw1");
        const body = try std.fmt.allocPrint(gpa, "{{\"newPassword\":\"{s}\"}}", .{new_md5[0..]});
        defer gpa.free(body);
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/user/password", &pending, body);
        @memcpy(&web, cookieToken(resp.set_cookie.?).?);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &web, "");
        var p = try std.json.parseFromSlice(struct { mustChangePassword: bool }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(!p.value.mustChangePassword);
    }
}

// ---- device-sync read path ----

fn deviceRequest(ctx: *Context, obuf: []u8, reqbuf: []u8, method: []const u8, path: []const u8, token: []const u8, eno: []const u8, body: []const u8) !Response {
    const req = try buildRequest(reqbuf, method, path, &.{
        .{ .name = "content-type", .value = "application/json" },
        .{ .name = "x-access-token", .value = token },
        .{ .name = "equipmentNo", .value = eno },
    }, body);
    return roundtrip(ctx, req, obuf);
}

fn deviceLogin(ctx: *Context, obuf: []u8, reqbuf: []u8, account: []const u8, pw: []const u8, eno: []const u8) ![32]u8 {
    const code = try getCode(ctx, account);
    const hash = challenge(pw, &code);
    const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"{s}\",\"password\":\"{s}\",\"equipmentNo\":\"{s}\",\"version\":\"202407\"}}", .{ account, hash[0..], eno });
    defer gpa.free(body);
    const req = try buildRequest(reqbuf, "POST", "/api/official/user/account/login/equipment", &.{
        .{ .name = "content-type", .value = "application/json" },
    }, body);
    const resp = try roundtrip(ctx, req, obuf);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(struct { token: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    var tok: [32]u8 = undefined;
    @memcpy(&tok, p.value.token);
    return tok;
}

fn putSeed(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, data: []const u8) !u64 {
    var r = std.Io.Reader.fixed(data);
    const e = try f.files.putFile(user_id, parent, name, &r, null);
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
    return e.id;
}

test "device sync M1: login/equipment, bind (folders + capacity), and the hash-diff read path" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111")); // clears must_change

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"alice\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
        const miss = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"ghost\"}"), &obuf);
        try expectFailure(miss.body, "USER_NOT_FOUND");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/api/file/query/server", &.{}, ""), &obuf);
        try expectSuccess(resp.body);
    }

    // Real order: a file call arrives before `bindEquipment` and binds the
    // serial with a placeholder name; the bind must then adopt the reported name.
    try f.svc.bindDevice(alice, "SN1", "Supernote app");

    // The device-reported `totalCapacity` is ignored: the server owns the quota.
    {
        const body =
            "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\",\"totalCapacity\":\"25485312\"," ++
            "\"label\":[\"NOTE/Note\",\"NOTE/MyStyle\",\"EXPORT\",\"INBOX\"],\"version\":\"202407\"}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/terminal/user/bindEquipment", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expect(try f.svc.isDeviceBound(alice, "SN1"));
    // Asserted through the route: the handler, not `nameDevice`, was the bug.
    {
        const devs = try f.svc.listUserDevices(gpa, alice, alice);
        defer authsvc.Service.freeDevices(gpa, devs);
        try std.testing.expectEqual(@as(usize, 1), devs.len);
        try std.testing.expectEqualStrings("Nomad", devs[0].name);
    }
    try std.testing.expectEqual(authsvc.default_capacity, try f.svc.userCapacity(alice));

    {
        const root = try f.files.list(alice, null);
        defer filesmod.Files.freeEntries(gpa, root);
        try std.testing.expectEqual(@as(usize, 3), root.len);
        for (root) |e| try std.testing.expect(e.is_folder);
    }
    const note_id = try f.files.ensureFolderPath(alice, "NOTE/Note"); // idempotent → existing id

    const a_id = try putSeed(f, alice, note_id, "a.note", "aaaa");
    _ = try putSeed(f, alice, note_id, "b.note", "bbbbbb");
    const a_md5 = blobstore.md5HexOf("aaaa");

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/query/summary/hash", &dev_tok, "SN1", "{\"page\":0,\"size\":100}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            totalRecords: i64,
            summaryInfoVOList: []const struct {
                id: i64,
                md5Hash: []const u8,
                handwriteMd5: []const u8,
                metadataMap: struct { path: []const u8 },
            },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(@as(i64, 2), p.value.totalRecords);
        try std.testing.expectEqual(@as(usize, 2), p.value.summaryInfoVOList.len);
        const first = p.value.summaryInfoVOList[0];
        try std.testing.expectEqual(a_id, @as(u64, @intCast(first.id)));
        try std.testing.expectEqualStrings(&a_md5, first.md5Hash);
        try std.testing.expectEqualStrings(&a_md5, first.handwriteMd5); // mirrored (§7.1)
        try std.testing.expectEqualStrings("/NOTE/Note/a.note", first.metadataMap.path);
    }

    {
        const body = try std.fmt.allocPrint(gpa, "{{\"ids\":[{d}]}}", .{a_id});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/query/summary/id", &dev_tok, "SN1", body);
        var p = try std.json.parseFromSlice(struct {
            summaryDOList: []const struct { id: i64, name: []const u8, sourcePath: []const u8, md5Hash: []const u8, isSummaryGroup: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.summaryDOList.len);
        const d = p.value.summaryDOList[0];
        try std.testing.expectEqualStrings("a.note", d.name);
        try std.testing.expectEqualStrings("/NOTE/Note/a.note", d.sourcePath);
        try std.testing.expectEqualStrings("N", d.isSummaryGroup);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/query/summary/group", &dev_tok, "SN1", "{\"page\":0,\"size\":100}");
        var p = try std.json.parseFromSlice(struct { totalRecords: i64, summaryDOList: []const struct { isSummaryGroup: []const u8 } }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 5), p.value.totalRecords);
        for (p.value.summaryDOList) |g| try std.testing.expectEqualStrings("Y", g.isSummaryGroup);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/user/query", &dev_tok, "SN1", "{}");
        var p = try std.json.parseFromSlice(struct { success: bool, email: []const u8, totalCapacity: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("alice", p.value.email);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/synchronous/start", &dev_tok, "SN1", "{\"equipmentNo\":\"SN1\"}");
        var p = try std.json.parseFromSlice(struct { success: bool, equipmentNo: []const u8, synType: bool }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success and p.value.synType);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
    }
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/synchronous/end", &dev_tok, "SN1", "{\"equipmentNo\":\"SN1\",\"flag\":\"Y\"}");
        try expectSuccess(resp.body);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &dev_tok, "{\"equipmentNo\":\"SN1\"}", 403);
}

test "pre-login device unlink is public, returns success, but is NON-DESTRUCTIVE (no token)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");
    try f.svc.bindDevice(alice, "SN1", "Nomad");
    try std.testing.expectEqual(@as(i64, 1), try f.svc.deviceCount(alice));
    try std.testing.expect((try f.svc.caller(&dev_tok)) != null);

    // An unauthenticated serial POST must not unbind or drop sessions (any LAN
    // client could log the device out); it returns the lenient success.
    const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/equipment/unlink", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"equipmentNo\":\"SN1\"}"), &obuf);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try expectSuccess(resp.body);
    try std.testing.expectEqual(@as(i64, 1), try f.svc.deviceCount(alice)); // binding SURVIVES
    try std.testing.expect((try f.svc.caller(&dev_tok)) != null); // session SURVIVES
}

test "capacity onboarding: wouldFit defaults for a user with no row; bindEquipment creates it at the server default" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // No capacity row: the state that used to make upload/apply 500.
    {
        var s = try f.db.prepare("DELETE FROM capacity WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }

    try std.testing.expect(try f.files.wouldFit(alice, 1024));

    {
        const body = "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\",\"totalCapacity\":\"25485312\",\"label\":[\"NOTE/Note\"]}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/terminal/user/bindEquipment", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    var s = try f.db.prepare("SELECT total_bytes FROM capacity WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(alice));
    try std.testing.expect(try s.step()); // the row was created
    try std.testing.expectEqual(authsvc.default_capacity, s.columnInt(0));
}

test "device sync M1: file enumeration (list_folder, query_v3, download_v3) + raw /oss/get, auth enforced" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const note_id = try f.files.ensureFolderPath(alice, "NOTE/Note");
    const blob_bytes = "hello supernote download blob";
    const a_id = try putSeed(f, alice, note_id, "a.note", blob_bytes);
    const top_id = try putSeed(f, alice, null, "top.note", "x"); // a second file, for cross-file scoping
    const a_md5 = blobstore.md5HexOf(blob_bytes);
    const a_entry = (try f.files.get(alice, a_id)).?;
    defer gpa.free(a_entry.name);
    defer if (a_entry.md5) |m| gpa.free(m);

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/NOTE/Note\",\"recursive\":false}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            entries: []const struct {
                tag: []const u8,
                id: []const u8,
                name: []const u8,
                path_display: []const u8,
                content_hash: []const u8,
                is_downloadable: bool,
                size: i64,
                lastUpdateTime: i64,
                parent_path: []const u8,
            },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqual(@as(usize, 1), p.value.entries.len);
        const e = p.value.entries[0];
        try std.testing.expectEqualStrings("file", e.tag);
        try std.testing.expectEqualStrings("a.note", e.name);
        try std.testing.expectEqualStrings("/NOTE/Note/a.note", e.path_display);
        try std.testing.expectEqualStrings("/NOTE/Note", e.parent_path);
        try std.testing.expectEqualStrings(&a_md5, e.content_hash);
        try std.testing.expect(e.is_downloadable); // !is_folder (FLAGGED)
        try std.testing.expectEqual(@as(i64, @intCast(blob_bytes.len)), e.size);
        try std.testing.expectEqual(a_entry.updated_at * 1000, e.lastUpdateTime); // ms (FLAGGED)
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const struct { tag: []const u8, path_display: []const u8, is_downloadable: bool },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 4), p.value.entries.len);
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.tag, "folder")) try std.testing.expect(!e.is_downloadable);
        }
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/query/by/path_v3", &dev_tok, "SN1", "{\"path\":\"/NOTE/Note/a.note\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            entriesVO: ?struct { id: []const u8, name: []const u8, content_hash: []const u8, path_display: []const u8 } = null,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.entriesVO != null);
        try std.testing.expectEqualStrings("a.note", p.value.entriesVO.?.name);
        try std.testing.expectEqualStrings(&a_md5, p.value.entriesVO.?.content_hash);
    }
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/query/by/path_v3", &dev_tok, "SN1", "{\"path\":\"/NOTE/ghost.note\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "entriesVO") == null);
        try expectSuccess(resp.body);
    }

    {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":\"{d}\"}}", .{a_id});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/query_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            equipmentNo: []const u8,
            entriesVO: ?struct { name: []const u8 } = null,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        // Echoed after the body read: guards a use-after-free on the head buffer.
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("a.note", p.value.entriesVO.?.name);
    }

    // The device sends no x-access-token on the download GET, so the URL
    // carries a `?t=` capability token.
    var oss_url_buf: [128]u8 = undefined;
    var oss_url_len: usize = 0;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":\"{d}\"}}", .{a_id});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/download_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            id: []const u8,
            url: []const u8,
            content_hash: []const u8,
            is_downloadable: bool,
            size: i64,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        var prefix_buf: [64]u8 = undefined;
        const prefix = try std.fmt.bufPrint(&prefix_buf, "http://test/oss/get/{d}?t=", .{a_id});
        try std.testing.expect(std.mem.startsWith(u8, p.value.url, prefix));
        try std.testing.expect(p.value.url.len > prefix.len); // a non-empty token follows
        try std.testing.expectEqualStrings(&a_md5, p.value.content_hash);
        try std.testing.expect(p.value.is_downloadable);
        try std.testing.expectEqual(@as(i64, @intCast(blob_bytes.len)), p.value.size);
        @memcpy(oss_url_buf[0..p.value.url.len], p.value.url);
        oss_url_len = p.value.url.len;
    }
    const oss_url = oss_url_buf[0..oss_url_len]; // "/oss/get/<a_id>?t=<token>" after the host
    const oss_path = oss_url["http://test".len..]; // path+query the device GETs (no token header)

    // No x-access-token header: the `?t=` token is the only credential.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", oss_path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(blob_bytes, resp.body); // exact bytes, raw
        try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "application/octet-stream") != null);
        try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "content-disposition:") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "a.note") != null);
    }

    // Multi-use within the TTL: the device may Range-request or retry.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", oss_path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(blob_bytes, resp.body);
    }

    // Token failures are 403, never 401 (a 401 logs the device out).
    {
        var pbuf: [32]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}", .{a_id});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}?t=deadbeefdeadbeefdeadbeefdeadbeef", .{a_id});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
    {
        const q = std.mem.indexOfScalar(u8, oss_path, '?').?;
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}{s}", .{ top_id, oss_path[q..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/2/files/list_folder", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"path\":\"/\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &web_tok, "{\"path\":\"/\"}", 403);
    }
}

// Reference oracle: walk the whole tree, then filter in Zig, to prove the
// scoped `list_folder` query returns the same set.
fn underPathT(path: []const u8, folder: []const u8) bool {
    return path.len > folder.len and std.mem.startsWith(u8, path, folder) and path[folder.len] == '/';
}

fn walkAndFilterPaths(a: std.mem.Allocator, files: *filesmod.Files, user_id: u64, target: []const u8, recursive: bool) ![][]const u8 {
    const nodes = try files.walkTree(a, user_id);
    var out: std.ArrayList([]const u8) = .empty;
    for (nodes) |n| {
        const include = if (recursive)
            (std.mem.eql(u8, target, "/") or underPathT(n.path_display, target))
        else
            std.mem.eql(u8, n.parent_path, target);
        if (include) try out.append(a, n.path_display);
    }
    const s = try out.toOwnedSlice(a);
    std.mem.sort([]const u8, s, {}, lessPath);
    return s;
}

fn lessPath(_: void, x: []const u8, y: []const u8) bool {
    return std.mem.order(u8, x, y) == .lt;
}

// `list_folder` over the wire as a sorted set of `path_display` (owned by `a`).
fn endpointPaths(a: std.mem.Allocator, ctx: *Context, obuf: []u8, reqbuf: []u8, token: []const u8, target: []const u8, recursive: bool) ![][]const u8 {
    const body = try std.fmt.allocPrint(a, "{{\"path\":\"{s}\",\"recursive\":{}}}", .{ target, recursive });
    const resp = try deviceRequest(ctx, obuf, reqbuf, "POST", "/api/file/2/files/list_folder", token, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(struct {
        entries: []const struct { path_display: []const u8 },
    }, a, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    var out: std.ArrayList([]const u8) = .empty;
    for (p.value.entries) |e| try out.append(a, try a.dupe(u8, e.path_display));
    const s = try out.toOwnedSlice(a);
    std.mem.sort([]const u8, s, {}, lessPath);
    return s;
}

test "list_folder scoped query returns the SAME SET as the old whole-tree walk-and-filter (nested, recursive, empty, root)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // /A/one.note  /A/B/deep.note  /A/empty  /root.note
    const a_id = try f.files.ensureFolderPath(alice, "A");
    _ = try putSeed(f, alice, a_id, "one.note", "1");
    const b_id = try f.files.ensureFolderPath(alice, "A/B");
    _ = try putSeed(f, alice, b_id, "deep.note", "22");
    _ = try f.files.ensureFolderPath(alice, "A/empty");
    _ = try putSeed(f, alice, null, "root.note", "333");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const Case = struct { target: []const u8, recursive: bool, expect_len: usize };
    const cases = [_]Case{
        .{ .target = "/A", .recursive = false, .expect_len = 3 }, // one.note, B, empty
        .{ .target = "/A", .recursive = true, .expect_len = 4 }, // one.note, B, empty, deep.note (- the folder itself)
        .{ .target = "/A/empty", .recursive = false, .expect_len = 0 }, // empty folder
        .{ .target = "/A/empty", .recursive = true, .expect_len = 0 }, // empty subtree
        .{ .target = "/", .recursive = false, .expect_len = 2 }, // A, root.note
        .{ .target = "/", .recursive = true, .expect_len = 6 }, // the whole tree
    };
    for (cases) |c| {
        const want = try walkAndFilterPaths(a, &f.files, alice, c.target, c.recursive);
        const got = try endpointPaths(a, ctx, &obuf, &reqbuf, &dev, c.target, c.recursive);
        try std.testing.expectEqual(c.expect_len, want.len); // the oracle itself is right
        try std.testing.expectEqual(want.len, got.len);
        for (want, got) |w, g| try std.testing.expectEqualStrings(w, g);
    }
}

test "get_space_usage reports the caller's real capacity row, in the exact shape the device accepted" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    try f.svc.setCapacityTotal(alice, 10 * 1024 * 1024 * 1024); // 10 GiB, server-owned

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const dev = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    _ = try putSeed(f, alice, null, "a.note", "abcdefg"); // 7 bytes
    try std.testing.expectEqual(@as(i64, 7), try usedBytes(f, alice));

    // The serialized body is pinned: the device matches these literal names.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/users/get_space_usage", &dev, "SN1", "{\"equipmentNo\":\"SN1\",\"version\":\"202407\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(
            "{\"success\":true,\"used\":7,\"allocationVO\":{\"tag\":\"Individual\",\"allocated\":10737418240}}",
            resp.body,
        );
    }

    _ = try putSeed(f, alice, null, "b.note", "xyz"); // +3 → 10
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/users/get_space_usage", &dev, "SN1", "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { success: bool, used: i64, allocationVO: struct { tag: []const u8, allocated: i64 } },
            gpa,
            resp.body,
            .{},
        );
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(@as(i64, 10), p.value.used);
        try std.testing.expectEqual(@as(i64, 10 * 1024 * 1024 * 1024), p.value.allocationVO.allocated);
        try std.testing.expectEqualStrings("Individual", p.value.allocationVO.tag);
    }

    {
        var s = try f.db.prepare("DELETE FROM capacity WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/users/get_space_usage", &dev, "SN1", "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var buf: [160]u8 = undefined;
        const want = try std.fmt.bufPrint(
            &buf,
            "{{\"success\":true,\"used\":0,\"allocationVO\":{{\"tag\":\"Individual\",\"allocated\":{d}}}}}",
            .{filesmod.Files.default_total_bytes},
        );
        try std.testing.expectEqualStrings(want, resp.body);
    }

    {
        const req = try buildRequest(&reqbuf, "POST", "/api/file/2/users/get_space_usage", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, "{}");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/2/users/get_space_usage", &web_tok, "{}", 403);
    }
}

// ---- device-sync upload byte path ----

fn usedBytes(f: *Fixture, user_id: u64) !i64 {
    var s = try f.db.prepare("SELECT used_bytes FROM capacity WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    _ = try s.step();
    return s.columnInt(0);
}

/// A single-part `multipart/form-data` body, framed as the device frames
/// `/oss/put`. Caller frees.
fn buildMultipart(boundary: []const u8, payload: []const u8) ![]u8 {
    const head = try std.fmt.allocPrint(gpa, "--{s}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"up.note\"\r\nContent-Type: application/octet-stream\r\n\r\n", .{boundary});
    defer gpa.free(head);
    const tail = try std.fmt.allocPrint(gpa, "\r\n--{s}--\r\n", .{boundary});
    defer gpa.free(tail);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, head);
    try out.appendSlice(gpa, payload);
    try out.appendSlice(gpa, tail);
    return out.toOwnedSlice(gpa);
}

/// Files staged under the blob store's `tmp/`, where a refused upload could
/// strand bytes.
fn blobTempCount(f: *Fixture) !usize {
    var d = try f.tmp.dir.openDir(std.testing.io, "tmp", .{ .iterate = true });
    defer d.close(std.testing.io);
    var it = d.iterate();
    var n: usize = 0;
    while (try it.next(std.testing.io)) |_| n += 1;
    return n;
}

/// Total bytes staged under `tmp/`: the per-session cap bounds this, which a
/// file count cannot see.
fn blobTempBytes(f: *Fixture) !u64 {
    var d = try f.tmp.dir.openDir(std.testing.io, "tmp", .{ .iterate = true });
    defer d.close(std.testing.io);
    var it = d.iterate();
    var total: u64 = 0;
    while (try it.next(std.testing.io)) |e| {
        var file = d.openFile(std.testing.io, e.name, .{}) catch continue;
        defer file.close(std.testing.io);
        const st = file.stat(std.testing.io) catch continue;
        total += st.size;
    }
    return total;
}

/// `len` bytes of a non-repeating pattern with no multipart delimiter look-alike.
fn filler(len: usize) ![]u8 {
    const buf = try gpa.alloc(u8, len);
    for (buf, 0..) |*b, i| b.* = @intCast((i * 31 + 7) & 0xFF);
    return buf;
}

/// `upload/apply` announcing `size` bytes; returns the minted `innerName`.
fn applyUpload(ctx: *Context, obuf: []u8, reqbuf: []u8, tok: []const u8, name: []const u8, size: usize) ![16]u8 {
    const body = try std.fmt.allocPrint(
        gpa,
        "{{\"path\":\"/NOTE/Note/{s}\",\"fileName\":\"{s}\",\"equipmentNo\":\"SN1\",\"size\":{d}}}",
        .{ name, name, size },
    );
    defer gpa.free(body);
    const resp = try deviceRequest(ctx, obuf, reqbuf, "POST", "/api/file/3/files/upload/apply", tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(struct { success: bool, innerName: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expect(p.value.success);
    var inner: [16]u8 = undefined;
    @memcpy(&inner, p.value.innerName);
    return inner;
}

/// POSTs `payload` multipart-framed to `/oss/put/<inner>`; `query` is appended
/// raw. Heap request buffer: payloads exceed any stack buffer here.
fn ossPut(ctx: *Context, obuf: []u8, tok: []const u8, inner: []const u8, payload: []const u8, query: []const u8) !Sent {
    const boundary = "----NomadUploadBoundaryZZ";
    const wire = try buildMultipart(boundary, payload);
    defer gpa.free(wire);
    const reqbuf = try gpa.alloc(u8, wire.len + 1024);
    defer gpa.free(reqbuf);
    var pbuf: [160]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}{s}", .{ inner, query });
    const req = try buildRequest(reqbuf, "POST", path, &.{
        .{ .name = "content-type", .value = "multipart/form-data; boundary=" ++ boundary },
        .{ .name = "x-access-token", .value = tok },
        .{ .name = "equipmentNo", .value = "SN1" },
    }, wire);
    return roundtripCounting(ctx, req, obuf);
}

/// The most a capped ingest may read before refusing: the cap plus three
/// `chunk_len` reads of framing and lookahead headroom.
fn cappedReadCeiling(limit: usize) usize {
    return limit + 3 * blobstore.chunk_len;
}

test "device upload M2: apply → /oss/put → finish stores the blob and links it into the tree" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const file_bytes = "SUPERNOTE upload payload — the real .note bytes\x00\x01\x02\r\n--not-a-boundary";
    const md5 = blobstore.md5HexOf(file_bytes);
    const before_version = try f.files.syncVersion(alice);

    var inner: [16]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"path\":\"/NOTE/Note/up.note\",\"fileName\":\"up.note\",\"equipmentNo\":\"SN1\",\"size\":{d}}}", .{file_bytes.len});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            innerName: []const u8,
            bucketName: []const u8,
            fullUploadUrl: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(@as(usize, 16), p.value.innerName.len);
        try std.testing.expectEqualStrings("ufile", p.value.bucketName);
        @memcpy(&inner, p.value.innerName);
        var want: [64]u8 = undefined;
        try std.testing.expectEqualStrings(try std.fmt.bufPrint(&want, "http://test/oss/put/{s}", .{&inner}), p.value.fullUploadUrl);
    }

    {
        const boundary = "----NomadUploadBoundaryZZ";
        const wire = try buildMultipart(boundary, file_bytes);
        defer gpa.free(wire);
        try std.testing.expect(wire.len > file_bytes.len);

        var ctbuf: [96]u8 = undefined;
        const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});
        var pbuf: [48]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}", .{&inner});
        const req = try buildRequest(&reqbuf, "POST", path, &.{
            .{ .name = "content-type", .value = ct },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, wire);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len); // empty success body
    }

    // Keyed by the file's md5, not the wire body's.
    try std.testing.expect(f.files.blobs.has(&md5));

    var file_id: u64 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"up.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}", .{ &md5, &inner, file_bytes.len });
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            id: []const u8,
            name: []const u8,
            path_display: []const u8,
            content_hash: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("up.note", p.value.name);
        try std.testing.expectEqualStrings(&md5, p.value.content_hash);
        try std.testing.expectEqualStrings("/NOTE/Note/", p.value.path_display);
        file_id = try std.fmt.parseInt(u64, p.value.id, 10);
    }

    {
        const entry = (try f.files.get(alice, file_id)).?;
        defer gpa.free(entry.name);
        defer if (entry.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("up.note", entry.name);
        try std.testing.expect(!entry.is_folder);
        try std.testing.expectEqualStrings(&md5, entry.md5.?);
        try std.testing.expectEqual(@as(u64, file_bytes.len), entry.size);

        const note_id = (try f.files.resolvePath(alice, "/NOTE/Note")).?;
        try std.testing.expectEqual(note_id, entry.parent_id.?); // linked under the bound folder

        try std.testing.expectEqual(@as(i64, @intCast(file_bytes.len)), try usedBytes(f, alice));
        try std.testing.expect(try f.files.syncVersion(alice) > before_version);
    }

    {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        try std.testing.expect((try f.files.uploadSession(arena.allocator(), alice, &inner)) == null);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/NOTE/Note\",\"recursive\":false}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const struct { name: []const u8, content_hash: []const u8, size: i64 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.entries.len);
        try std.testing.expectEqualStrings("up.note", p.value.entries[0].name);
        try std.testing.expectEqualStrings(&md5, p.value.entries[0].content_hash);
    }
}

test "device upload M2: content_hash mismatch rejects the commit; auth is enforced" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const file_bytes = "these bytes are stored fine";
    const real_md5 = blobstore.md5HexOf(file_bytes);

    var inner: [16]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"path\":\"/NOTE/Note/bad.note\",\"fileName\":\"bad.note\",\"equipmentNo\":\"SN1\",\"size\":{d}}}", .{file_bytes.len});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        var p = try std.json.parseFromSlice(struct { innerName: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&inner, p.value.innerName);
    }
    {
        const boundary = "BND";
        const wire = try buildMultipart(boundary, file_bytes);
        defer gpa.free(wire);
        var ctbuf: [64]u8 = undefined;
        const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});
        var pbuf: [48]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}", .{&inner});
        const req = try buildRequest(&reqbuf, "POST", path, &.{
            .{ .name = "content-type", .value = ct },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, wire);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    {
        const wrong = "ffffffffffffffffffffffffffffffff";
        const body = try std.fmt.allocPrint(gpa, "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"bad.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}", .{ wrong, &inner, file_bytes.len });
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "HASH_MISMATCH");
    }
    try std.testing.expect((try f.files.resolvePath(alice, "/NOTE/Note/bad.note")) == null);
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, alice));
    try std.testing.expect(f.files.blobs.has(&real_md5)); // stored but unreferenced

    {
        const swept = try f.files.sweepUploadSessions(-1); // cutoff in the future → sweep everything
        try std.testing.expectEqual(@as(usize, 1), swept);
        try std.testing.expect(!f.files.blobs.has(&real_md5)); // orphan reclaimed
    }

    {
        const req = try buildRequest(&reqbuf, "POST", "/oss/put/deadbeefdeadbeef", &.{
            .{ .name = "content-type", .value = "multipart/form-data; boundary=BND" },
        }, "--BND\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nx\r\n--BND--\r\n");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/oss/put/deadbeefdeadbeef", &web_tok, "", 403);
    }
}

test "device upload M2: commits the INGESTED size, not the device-declared size" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // A declared size larger than the payload must not reach files.size or quota.
    const file_bytes = "tiny"; // 4 real bytes
    const md5 = blobstore.md5HexOf(file_bytes);
    const declared: usize = 5_000_000; // fits the default quota, so apply passes

    var inner: [16]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"path\":\"/NOTE/Note/up.note\",\"fileName\":\"up.note\",\"equipmentNo\":\"SN1\",\"size\":{d}}}", .{declared});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { innerName: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&inner, p.value.innerName);
    }
    {
        const boundary = "----NomadBoundaryQ";
        const wire = try buildMultipart(boundary, file_bytes);
        defer gpa.free(wire);
        var ctbuf: [96]u8 = undefined;
        const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});
        var pbuf: [48]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}", .{&inner});
        const req = try buildRequest(&reqbuf, "POST", path, &.{
            .{ .name = "content-type", .value = ct },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, wire);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    var file_id: u64 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"up.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}", .{ &md5, &inner, declared });
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { id: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        file_id = try std.fmt.parseInt(u64, p.value.id, 10);
    }

    const entry = (try f.files.get(alice, file_id)).?;
    defer gpa.free(entry.name);
    defer if (entry.md5) |m| gpa.free(m);
    try std.testing.expectEqual(@as(u64, file_bytes.len), entry.size);
    try std.testing.expectEqual(@as(i64, @intCast(file_bytes.len)), try usedBytes(f, alice));
}

test "device upload chunked: parts are merged on the final part" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const p1 = "SUPERNOTE upload payload ";
    const p2 = "— the real .note ";
    const p3 = "bytes\x00\x01\x02\r\n--not-a-boundary";

    const file_bytes = try std.mem.concat(gpa, u8, &.{ p1, p2, p3 });
    defer gpa.free(file_bytes);
    const md5 = blobstore.md5HexOf(file_bytes);

    var inner: [16]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"path\":\"/NOTE/Note/up.note\",\"fileName\":\"up.note\",\"equipmentNo\":\"SN1\",\"size\":{d}}}", .{file_bytes.len});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            innerName: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        @memcpy(&inner, p.value.innerName);
    }

    const boundary = "----NomadUploadBoundaryZZ";
    const upload_id = "1785154238763_ad76ebd7";
    for ([_][]const u8{ p1, p2, p3 }, 1..) |part_bytes, part_num| {
        const wire = try buildMultipart(boundary, part_bytes);
        defer gpa.free(wire);

        var ctbuf: [96]u8 = undefined;
        const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}?uploadId={s}&totalChunks=3&partNumber={d}", .{ &inner, upload_id, part_num });
        const req = try buildRequest(&reqbuf, "POST", path, &.{
            .{ .name = "content-type", .value = ct },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, wire);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len); // empty success body
    }

    try std.testing.expect(f.files.blobs.has(&md5));

    {
        const body = try std.fmt.allocPrint(gpa, "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"up.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}", .{ &md5, &inner, file_bytes.len });
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            content_hash: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings(&md5, p.value.content_hash);
    }
}

test "device upload chunked: a path-traversal uploadId is rejected before it names a file" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // Get past the ownership check so the uploadId check is what rejects.
    var inner: [16]u8 = undefined;
    {
        const body = "{\"path\":\"/NOTE/Note/evil.note\",\"fileName\":\"evil.note\",\"equipmentNo\":\"SN1\",\"size\":10}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            innerName: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&inner, p.value.innerName);
    }

    const boundary = "----NomadUploadBoundaryZZ";
    const wire = try buildMultipart(boundary, "pwn");
    defer gpa.free(wire);
    var ctbuf: [96]u8 = undefined;
    const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});

    // Must 400 before `beginChunkIngest` splices it into a `tmp/<id>_1` path.
    var pbuf: [160]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}?uploadId=../../pwned&totalChunks=3&partNumber=1", .{&inner});
    const req = try buildRequest(&reqbuf, "POST", path, &.{
        .{ .name = "content-type", .value = ct },
        .{ .name = "x-access-token", .value = &dev_tok },
        .{ .name = "equipmentNo", .value = "SN1" },
    }, wire);
    const resp = try roundtrip(ctx, req, &obuf);
    try std.testing.expectEqual(@as(u16, 400), resp.status);
}

// ---- the ingest cap: a body may not outrun what was declared ----

test "device /oss/put: a body past the declared size is refused MID-STREAM, leaving no session row and nothing on disk" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const declared: usize = 4096;
    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "flood.note", declared);
    const payload = try filler(declared + 4 * uploadcap.slack_bytes);
    defer gpa.free(payload);

    const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, payload, "");
    const resp = sent.resp;

    // Device protocol failures are HTTP 200 with the coded envelope; a 4xx/5xx
    // reads to the tablet as a network failure.
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try expectFailure(resp.body, "QUOTA_EXCEEDED");

    // Refused mid-stream, near the cap (see `Sent`).
    try std.testing.expect(sent.consumed < cappedReadCeiling(uploadcap.limitFor(declared)));

    // Reservation gone, no blob published, nothing staged in `tmp/`.
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(payload)));
    try std.testing.expectEqual(@as(usize, 0), try blobTempCount(f));
    try std.testing.expectEqual(@as(i64, 0), (try f.files.capacity(alice)).used);

    {
        const md5 = blobstore.md5HexOf(payload);
        const body = try std.fmt.allocPrint(
            gpa,
            "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"flood.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}",
            .{ &md5, &inner, payload.len },
        );
        defer gpa.free(body);
        const fin = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), fin.status);
        try expectFailure(fin.body, "NOT_FOUND");
    }
}

test "device /oss/put: the declared size, and the cap itself, both still upload — the cap removes an attack, not the feature" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const declared: usize = 4096;

    {
        const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "normal.note", declared);
        const payload = try filler(declared);
        defer gpa.free(payload);
        const md5 = blobstore.md5HexOf(payload);

        const resp = (try ossPut(ctx, &obuf, &dev_tok, &inner, payload, "")).resp;
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len); // the empty-200 success shape
        try std.testing.expect(f.files.blobs.has(&md5));

        const body = try std.fmt.allocPrint(
            gpa,
            "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"normal.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}",
            .{ &md5, &inner, payload.len },
        );
        defer gpa.free(body);
        const fin = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), fin.status);
        var p = try std.json.parseFromSlice(struct { success: bool, id: []const u8 }, gpa, fin.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(@as(i64, @intCast(payload.len)), try usedBytes(f, alice));
    }

    // Declared + the whole slack is accepted; one byte more is refused above.
    {
        const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "edge.note", declared);
        const payload = try filler(declared + uploadcap.slack_bytes);
        defer gpa.free(payload);
        const resp = (try ossPut(ctx, &obuf, &dev_tok, &inner, payload, "")).resp;
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len);
        try std.testing.expect(f.files.blobs.has(&blobstore.md5HexOf(payload)));
    }
}

test "device /oss/put chunked: an over-cap PART is refused with the same envelope, and takes the session with it" {
    // Each chunked part is held to the same figure.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const declared: usize = 4096;
    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "flood.note", declared);
    const payload = try filler(declared + 4 * uploadcap.slack_bytes);
    defer gpa.free(payload);

    const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, payload, "?uploadId=abc123&totalChunks=3&partNumber=1");
    try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
    try expectFailure(sent.resp.body, "QUOTA_EXCEEDED");
    try std.testing.expect(sent.consumed < cappedReadCeiling(uploadcap.limitFor(declared)));

    // `ChunkIngest.abort` closes without unlinking; the startup `sweepTmp`
    // reclaims what the refused part staged.
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(payload)));

    const again = try ossPut(ctx, &obuf, &dev_tok, &inner, "small", "?uploadId=abc123&totalChunks=3&partNumber=2");
    try std.testing.expectEqual(@as(u16, 404), again.resp.status);
}

test "device /oss/put chunked: the byte cap is per SESSION — N parts cannot each stage the whole budget" {
    // `totalChunks` is caller-supplied, so a per-part cap alone is unbounded in
    // aggregate. Each part here is exactly the declared size.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // Much larger than `slack_bytes`, so "stopped near the remainder" and "read
    // the whole part" are far apart.
    const declared: usize = 400_000;
    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "flood.note", declared);
    const part = try filler(declared);
    defer gpa.free(part);

    {
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, "?uploadId=floodid&totalChunks=9&partNumber=1");
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try std.testing.expectEqual(@as(usize, 0), sent.resp.body.len); // empty-200 success
    }

    // Part 2 exceeds the session's remaining budget and is refused mid-stream.
    const remaining = uploadcap.limitFor(declared) - declared;
    {
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, "?uploadId=floodid&totalChunks=9&partNumber=2");
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try expectFailure(sent.resp.body, "QUOTA_EXCEEDED"); // the protocol's refusal, not a 413
        try std.testing.expect(sent.consumed < cappedReadCeiling(remaining));
    }

    // Staged bytes are bounded by one budget: the refused part's sink was capped
    // at the remainder. A check only after a part lands would bound accounting
    // but not the disk.
    try std.testing.expect(try blobTempBytes(f) <= uploadcap.limitFor(declared));

    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    const again = try ossPut(ctx, &obuf, &dev_tok, &inner, "small", "?uploadId=floodid&totalChunks=9&partNumber=3");
    try std.testing.expectEqual(@as(u16, 404), again.resp.status);
}

test "device /oss/put chunked: re-sending a part is not charged twice" {
    // Part temp files are `tmp/<uploadId>_<n>`, so re-POSTing a part replaces
    // it; `stagedPartSize` must refund the earlier copy or a retry is refused.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const declared: usize = 50_000; // budget = 50_000 + 65_536 = 115_536
    const part = try filler(50_000); //  2 parts = 100_000 (fits), 3 = 150_000 (does not)
    defer gpa.free(part);
    try std.testing.expect(2 * part.len <= uploadcap.limitFor(declared));
    try std.testing.expect(3 * part.len > uploadcap.limitFor(declared));

    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "retry.note", declared);
    for ([_]u8{ 1, 2 }) |n| {
        var q: [64]u8 = undefined;
        const query = try std.fmt.bufPrint(&q, "?uploadId=retryid&totalChunks=3&partNumber={d}", .{n});
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, query);
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try std.testing.expectEqual(@as(usize, 0), sent.resp.body.len);
    }

    {
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, "?uploadId=retryid&totalChunks=3&partNumber=2");
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try std.testing.expectEqual(@as(usize, 0), sent.resp.body.len);
    }

    // The running total still reads two parts, not three.
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    try std.testing.expectEqual(
        @as(i64, @intCast(2 * part.len)),
        try countRows(f, "SELECT received_bytes FROM upload_sessions;"),
    );
}

test "oversized device numbers are rejected, not panicked (overflow guard)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // size == i64max must not overflow the quota math and panic.
    {
        const body = "{\"path\":\"/NOTE/Note/x.note\",\"fileName\":\"x.note\",\"equipmentNo\":\"SN1\",\"size\":9223372036854775807}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "QUOTA_EXCEEDED");
    }

    {
        const body = "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\",\"totalCapacity\":\"9223372036854775000\"}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/terminal/user/bindEquipment", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqual(authsvc.default_capacity, try f.svc.userCapacity(alice));
}

test "public pre-auth unlink is IP rate-limited (429 after the burst)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    var obuf: [2048]u8 = undefined;
    var reqbuf: [512]u8 = undefined;
    const body = "{\"equipmentNo\":\"SN1\"}";

    var i: usize = 0;
    while (i < 20) : (i += 1) {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/equipment/unlink", &.{.{ .name = "content-type", .value = "application/json" }}, body), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/equipment/unlink", &.{.{ .name = "content-type", .value = "application/json" }}, body), &obuf);
    try std.testing.expectEqual(@as(u16, 429), resp.status);
}

/// Live rows a user has under `name`: a retried create must converge on one.
fn countNamed(f: *Fixture, user_id: u64, name: []const u8) !i64 {
    var s = try f.db.prepare("SELECT COUNT(*) FROM files WHERE user_id = ?1 AND name = ?2 AND deleted = 0;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindText(2, name);
    _ = try s.step();
    return s.columnInt(0);
}

test "create_folder_v2: a device folder reaches the server without a file in it" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // The Nomad's wire shape.
    const body = "{\"equipmentNo\":\"SN1\",\"autorename\":false,\"path\":\"/NOTE/Note/Trip\"}";
    const id = blk: {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            metadata: struct { tag: []const u8, id: []const u8, name: []const u8, path_display: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("folder", p.value.metadata.tag);
        try std.testing.expectEqualStrings("Trip", p.value.metadata.name);
        try std.testing.expectEqualStrings("/NOTE/Note/Trip", p.value.metadata.path_display);
        break :blk try std.fmt.parseInt(u64, p.value.metadata.id, 10);
    };

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "/NOTE/Note/Trip") != null);
    }
    const entry = (try f.files.get(alice, id)).?;
    defer gpa.free(entry.name);
    try std.testing.expect(entry.is_folder);

    // A retry with `autorename: false` converges on the same row.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var want: [64]u8 = undefined;
        try std.testing.expect(std.mem.indexOf(
            u8,
            resp.body,
            try std.fmt.bufPrint(&want, "\"id\":\"{d}\"", .{id}),
        ) != null);
    }
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "Trip")); // not forked

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &dev_tok, "SN1", "{\"equipmentNo\":\"SN1\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", resp.body);
    }
}

test "create_folder_v2 is device-scoped and cannot reach another user's tree" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const body = "{\"autorename\":false,\"path\":\"/NOTE/Shared\"}";

    const a_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");
    const a_resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &a_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), a_resp.status);

    // Same path for Bob is his own folder, not a conflict or an oracle.
    const b_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN2");
    const b_resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &b_tok, "SN2", body);
    try std.testing.expectEqual(@as(u16, 200), b_resp.status);
    try std.testing.expect(std.mem.indexOf(u8, b_resp.body, "\"name\":\"Shared\"") != null);

    const a_id = (try f.files.resolvePath(alice, "/NOTE/Shared")).?;
    const b_id = (try f.files.resolvePath(bob, "/NOTE/Shared")).?;
    try std.testing.expect(a_id != b_id);
    try std.testing.expect((try f.files.get(bob, a_id)) == null);
}

/// The tombstone as the row records it, not as any read path reports it.
const Tombstone = struct { deleted: bool, deleted_at: i64 };
fn tombstoneOf(f: *Fixture, id: u64) !Tombstone {
    var s = try f.db.prepare("SELECT deleted, COALESCE(deleted_at, 0) FROM files WHERE id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(id));
    try std.testing.expect(try s.step());
    return .{ .deleted = s.columnInt(0) != 0, .deleted_at = s.columnInt(1) };
}

fn countTrashed(f: *Fixture, user_id: u64) !i64 {
    var s = try f.db.prepare("SELECT COUNT(*) FROM files WHERE user_id = ?1 AND deleted = 1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    _ = try s.step();
    return s.columnInt(0);
}

/// How many of `user_id`'s own live files contain `q`, read straight from
/// `note_page_index.text` (the server runs no queries). A case-folded substring,
/// not a tokenizer; only `.note` rows (`kind = 0`) remain. The `files` join
/// carries ownership, `deleted = 0`, and current-only via `files.md5`.
fn searchHits(f: *Fixture, user_id: u64, q: []const u8) !usize {
    var s = try f.db.prepare(
        "SELECT COUNT(DISTINCT f.id) FROM files f " ++
            "JOIN note_page_index p ON p.blob_md5 = f.md5 " ++
            "WHERE f.user_id = ?1 AND f.deleted = 0 AND f.is_folder = 0 " ++
            "  AND p.text IS NOT NULL AND instr(lower(p.text), lower(?2)) > 0;",
    );
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindText(2, q);
    _ = try s.step();
    return @intCast(s.columnInt(0));
}

test "device delete_folder_v3 soft-deletes: leaves listings and search, but the blob survives and the row restores to readable bytes" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const rec_id = try seedRecognizedNote(f, alice, "rec.note", &.{ "Zebra", "Quokka" });
    const md5 = blk: {
        const e = (try f.files.get(alice, rec_id)).?;
        defer gpa.free(e.name);
        defer if (e.md5) |m| gpa.free(m);
        var out: [blobstore.md5_hex_len]u8 = undefined;
        @memcpy(&out, e.md5.?);
        break :blk out;
    };
    const size_before = try usedBytes(f, alice);
    try std.testing.expect(size_before > 0);
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));

    var body_buf: [128]u8 = undefined;
    const del_body = try std.fmt.bufPrint(&body_buf, "{{\"equipmentNo\":\"SN1\",\"id\":\"{d}\"}}", .{rec_id});
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &dev_tok, "SN1", del_body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        // Pinned serialized: the firmware matches these literal names.
        var want_buf: [256]u8 = undefined;
        const want = try std.fmt.bufPrint(
            &want_buf,
            "{{\"success\":true,\"equipmentNo\":\"SN1\",\"metadata\":{{\"tag\":\"file\",\"id\":\"{d}\",\"name\":\"rec.note\"}}}}",
            .{rec_id},
        );
        try std.testing.expectEqualStrings(want, resp.body);
    }

    const t = try tombstoneOf(f, rec_id);
    try std.testing.expect(t.deleted);
    try std.testing.expect(t.deleted_at > 0);

    // Gone from the device's enumeration (stops the zombie re-download).
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "rec.note") == null);
    }
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, alice, "Zebra"));
    try std.testing.expect((try f.files.get(alice, rec_id)) == null);

    // Quota is not refunded on trash: the bytes stay on disk until purge.
    try std.testing.expectEqual(size_before, try usedBytes(f, alice));

    try std.testing.expect(f.files.blobs.has(&md5));
    (try f.files.restore(alice, rec_id)).deinit(gpa);

    const back = (try f.files.get(alice, rec_id)).?;
    defer gpa.free(back.name);
    defer if (back.md5) |m| gpa.free(m);
    const want_bytes = try f.files.blobs.sizeOf(back.md5.?);
    const got = try gpa.alloc(u8, @intCast(want_bytes));
    defer gpa.free(got);
    const read = try f.files.blobs.readRange(back.md5.?, 0, want_bytes, got);
    try std.testing.expectEqual(@as(usize, @intCast(want_bytes)), read.len);
    try std.testing.expectEqualStrings(&md5, &blobstore.md5HexOf(read)); // the ORIGINAL bytes

    // Restore is a flag flip; the md5-keyed rows survived.
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));
}

test "device delete_folder_v3: an idempotent retry succeeds without restarting the retention clock, and children-then-parent trashes the whole subtree" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const dir = try f.files.createFolder(alice, null, "Dir");
    defer gpa.free(dir.name);
    const a_id = try putSeed(f, alice, dir.id, "a.note", "aaa");
    const b_id = try putSeed(f, alice, dir.id, "b.note", "bbb");

    var body_buf: [128]u8 = undefined;
    const del = struct {
        fn go(c: *Context, o: []u8, rq: []u8, bb: []u8, tok: []const u8, id: u64) !Response {
            const body = try std.fmt.bufPrint(bb, "{{\"equipmentNo\":\"SN1\",\"id\":\"{d}\"}}", .{id});
            return deviceRequest(c, o, rq, "POST", "/api/file/3/files/delete_folder_v3", tok, "SN1", body);
        }
    };

    // The device sends one request per entity, children first, parent last.
    {
        const r1 = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, a_id);
        try std.testing.expectEqual(@as(u16, 200), r1.status);
        try expectSuccess(r1.body);
        const r2 = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, b_id);
        try std.testing.expectEqual(@as(u16, 200), r2.status);
        try expectSuccess(r2.body);
        const r3 = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, dir.id);
        try std.testing.expectEqual(@as(u16, 200), r3.status);
        var want_buf: [256]u8 = undefined;
        try std.testing.expectEqualStrings(try std.fmt.bufPrint(
            &want_buf,
            "{{\"success\":true,\"equipmentNo\":\"SN1\",\"metadata\":{{\"tag\":\"folder\",\"id\":\"{d}\",\"name\":\"Dir\"}}}}",
            .{dir.id},
        ), r3.body);
    }
    try std.testing.expectEqual(@as(i64, 3), try countTrashed(f, alice)); // the whole subtree
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\",\"entries\":[]}", resp.body);
    }

    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = 1000 WHERE user_id = ?1 AND deleted = 1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }
    const ver_before = try f.files.syncVersion(alice);

    // A retry: `Files.get` hardcodes deleted = 0, so the handler looks up
    // state-blind.
    for ([_]u64{ a_id, dir.id }) |id| {
        const r = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, id);
        try std.testing.expectEqual(@as(u16, 200), r.status);
        try expectSuccess(r.body);
    }
    try std.testing.expectEqual(@as(i64, 3), try countTrashed(f, alice));
    // The retention clock does not restart on retry.
    try std.testing.expectEqual(@as(i64, 1000), (try tombstoneOf(f, a_id)).deleted_at);
    try std.testing.expectEqual(@as(i64, 1000), (try tombstoneOf(f, dir.id)).deleted_at);
    try std.testing.expectEqual(@as(i64, 1000), (try tombstoneOf(f, b_id)).deleted_at);
    try std.testing.expectEqual(ver_before, try f.files.syncVersion(alice));
}

test "device delete_folder_v3: scope enforced, and a foreign id is indistinguishable from a missing one" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    // Bob's id and a never-existing id must answer byte-identically.
    var body_buf: [128]u8 = undefined;
    var foreign_body_buf: [128]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&body_buf, "{{\"equipmentNo\":\"SN1\",\"id\":\"{d}\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    var missing_body: [256]u8 = undefined;
    @memcpy(missing_body[0..missing.body.len], missing.body);
    const missing_len = missing.body.len;

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&foreign_body_buf, "{{\"equipmentNo\":\"SN1\",\"id\":\"{d}\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing_body[0..missing_len], foreign.body);

    // Unknown id: success with `metadata` omitted, or the device retries forever.
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", foreign.body);
    {
        const still = (try f.files.get(bob, bob_id)).?;
        defer gpa.free(still.name);
        defer if (still.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("bob.note", still.name);
    }
    try std.testing.expectEqual(@as(i64, 0), try countTrashed(f, bob));

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"id\":\"1\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &web_tok, "{\"id\":\"1\"}", 403);
    }
}

test "device move_v3: renames + relocates a note, provisioning the destination parent, and it stays searchable" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const id = try seedRecognizedNote(f, alice, "note.note", &.{ "Zebra", "Quokka" });
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));

    // Captured shape: full destination path including the new filename, into a
    // parent that does not exist yet, autorename false.
    var body_buf: [256]u8 = undefined;
    const body = try std.fmt.bufPrint(
        &body_buf,
        "{{\"id\":\"{d}\",\"to_path\":\"/NOTE/Note/corpus/note/custom_template.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}",
        .{id},
    );
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            entriesVO: struct { tag: []const u8, id: []const u8, name: []const u8, path_display: []const u8, parent_path: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("file", p.value.entriesVO.tag);
        try std.testing.expectEqualStrings("custom_template.note", p.value.entriesVO.name);
        try std.testing.expectEqualStrings("/NOTE/Note/corpus/note/custom_template.note", p.value.entriesVO.path_display);
        try std.testing.expectEqualStrings("/NOTE/Note/corpus/note", p.value.entriesVO.parent_path);
        try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.entriesVO.id, 10));
    }

    try std.testing.expect((try f.files.resolvePath(alice, "/NOTE/Note/corpus/note")) != null);
    try std.testing.expectEqual(@as(?u64, id), try f.files.resolvePath(alice, "/NOTE/Note/corpus/note/custom_template.note"));
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(alice, "/note.note"));
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "/NOTE/Note/corpus/note/custom_template.note") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"name\":\"note.note\"") == null);
    }

    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));
}

test "device move_v3 NEVER 404s: unknown and foreign ids settle as idempotent success, byte-for-byte" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    // Same settled body for unknown and foreign ids: a 404 aborts the device's
    // sync, and a difference is an oracle.
    var mbuf: [200]u8 = undefined;
    var fbuf: [200]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&mbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", missing.body);

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&fbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing.body, foreign.body);

    {
        const still = (try f.files.get(bob, bob_id)).?;
        defer gpa.free(still.name);
        defer if (still.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("bob.note", still.name);
        try std.testing.expectEqual(@as(?u64, null), still.parent_id);
    }
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(bob, "/x"));

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/3/files/move_v3", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"id\":\"1\",\"to_path\":\"/a.note\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &web_tok, "{\"id\":\"1\",\"to_path\":\"/a.note\"}", 403);
    }
}

test "device move_v3: autorename settles a destination-name conflict and reports the chosen name" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const keep = try putSeed(f, alice, null, "keep.note", "kkkk");
    const mover = try putSeed(f, alice, null, "mover.note", "mmmm");
    _ = keep;

    var body_buf: [200]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"id\":\"{d}\",\"to_path\":\"/keep.note\",\"autorename\":true,\"equipmentNo\":\"SN1\"}}", .{mover});
    const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    const p = try std.json.parseFromSlice(struct {
        success: bool,
        entriesVO: struct { name: []const u8, path_display: []const u8 },
    }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("keep (2).note", p.value.entriesVO.name);
    try std.testing.expectEqualStrings("/keep (2).note", p.value.entriesVO.path_display);
    try std.testing.expectEqual(@as(?u64, mover), try f.files.resolvePath(alice, "/keep (2).note"));
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note")); // the occupant intact
}

test "device copy_v3: duplicates a note sharing its blob (no extra quota), both stay searchable" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const id = try seedRecognizedNote(f, alice, "note.note", &.{ "Zebra", "Quokka" });
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));
    const used_before = (try f.files.capacity(alice)).used;

    var body_buf: [256]u8 = undefined;
    const body = try std.fmt.bufPrint(
        &body_buf,
        "{{\"to_path\":\"/NOTE/Note/note_CONFLICT_20260726151728080.note\",\"equipmentNo\":\"SN1\",\"id\":\"{d}\",\"autorename\":false}}",
        .{id},
    );
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            entriesVO: struct { tag: []const u8, id: []const u8, name: []const u8, path_display: []const u8, parent_path: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("file", p.value.entriesVO.tag);
        try std.testing.expectEqualStrings("note_CONFLICT_20260726151728080.note", p.value.entriesVO.name);
        try std.testing.expectEqualStrings("/NOTE/Note/note_CONFLICT_20260726151728080.note", p.value.entriesVO.path_display);
        try std.testing.expect(id != try std.fmt.parseInt(u64, p.value.entriesVO.id, 10));
    }

    try std.testing.expectEqual(@as(?u64, id), try f.files.resolvePath(alice, "/note.note"));
    const copy_id = (try f.files.resolvePath(alice, "/NOTE/Note/note_CONFLICT_20260726151728080.note")).?;
    try std.testing.expect(copy_id != id);

    try std.testing.expectEqual(used_before, (try f.files.capacity(alice)).used);

    try std.testing.expectEqual(@as(usize, 2), try searchHits(f, alice, "Zebra"));
}

test "device copy_v3 NEVER 404s: unknown and foreign ids settle as idempotent success, byte-for-byte" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    var mbuf: [200]u8 = undefined;
    var fbuf: [200]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&mbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", missing.body);

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&fbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing.body, foreign.body);

    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, bob, "bob.note"));
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(bob, "/x"));

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/3/files/copy_v3", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"id\":\"1\",\"to_path\":\"/a.note\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &web_tok, "{\"id\":\"1\",\"to_path\":\"/a.note\"}", 403);
    }
}

test "device copy_v3: autorename settles a destination-name conflict and reports the chosen name" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const keep = try putSeed(f, alice, null, "keep.note", "kkkk");
    const src = try putSeed(f, alice, null, "src.note", "ssss");
    _ = keep;

    var body_buf: [200]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"id\":\"{d}\",\"to_path\":\"/keep.note\",\"autorename\":true,\"equipmentNo\":\"SN1\"}}", .{src});
    const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    const p = try std.json.parseFromSlice(struct {
        success: bool,
        entriesVO: struct { name: []const u8, path_display: []const u8 },
    }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("keep (2).note", p.value.entriesVO.name);
    try std.testing.expectEqualStrings("/keep (2).note", p.value.entriesVO.path_display);
    try std.testing.expect((try f.files.resolvePath(alice, "/keep (2).note")) != null);
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note"));
    try std.testing.expectEqual(@as(?u64, src), try f.files.resolvePath(alice, "/src.note"));
}

test "device copy_v3: a name conflict under autorename:false never clobbers the occupant" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const keep = try putSeed(f, alice, null, "keep.note", "original");
    const src = try putSeed(f, alice, null, "src.note", "different");

    var body_buf: [200]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"id\":\"{d}\",\"to_path\":\"/keep.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{src});
    const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", resp.body);
    _ = keep;
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note"));
    try std.testing.expectEqual(@as(?u64, src), try f.files.resolvePath(alice, "/src.note"));
}

// ---- web-face browse/read endpoints ----

/// Stores a synthetic `.note` (one main layer per page); returns the file id.
fn seedNoteHttp(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, page_bitmaps: []const []const u8) !u64 {
    const nb = @import("note_builder");
    var layers = try gpa.alloc([1]nb.LayerSpec, page_bitmaps.len);
    defer gpa.free(layers);
    var pagespecs = try gpa.alloc(nb.PageSpec, page_bitmaps.len);
    defer gpa.free(pagespecs);
    for (page_bitmaps, 0..) |bmp, i| {
        layers[i] = .{.{ .slot = .main, .bitmap = bmp }};
        pagespecs[i] = .{ .layers = layers[i][0..1] };
    }
    const bytes = try nb.serialize(gpa, .{ .pages = pagespecs });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, parent, name, &r, null);
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
    return e.id;
}

test "control-plane browse/read: tree, note meta, page bytes (immutable), and SSE — auth enforced" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const work = try f.files.createFolder(admin, null, "Work");
    defer gpa.free(work.name);
    const top_id = try seedNoteHttp(f, admin, null, "top.note", &.{"AAAA"});
    _ = try seedNoteHttp(f, admin, work.id, "deep.note", &.{ "AAAA", "BBBBBB" });

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/tree", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const alice = (try f.svc.createUser(admin, "alice", false)).id;
        _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/tree", &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    var work_id_str: [20]u8 = undefined;
    var work_id_len: usize = 0;
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            folderId: ?[]const u8 = null,
            path: []const struct { kind: []const u8, id: []const u8, name: []const u8 },
            entries: []const struct {
                kind: []const u8,
                id: []const u8,
                name: []const u8,
                pageCount: ?i64 = null,
                firstPage: ?struct { index: i64, hash: []const u8, width: i64, height: i64 } = null,
                updatedAt: ?i64 = null,
                thumbAspect: ?struct { w: i64, h: i64 } = null,
            },
            syncVersion: i64,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.folderId == null);
        try std.testing.expectEqual(@as(usize, 0), p.value.path.len);
        try std.testing.expectEqual(@as(usize, 2), p.value.entries.len);
        try std.testing.expectEqualStrings("folder", p.value.entries[0].kind);
        try std.testing.expectEqualStrings("Work", p.value.entries[0].name);
        // Absent is omitted, never `"thumbAspect":null`.
        try std.testing.expect(p.value.entries[0].thumbAspect == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"thumbAspect\":null") == null);
        const n = p.value.entries[1];
        try std.testing.expectEqualStrings("note", n.kind);
        try std.testing.expectEqualStrings("top.note", n.name);
        try std.testing.expectEqual(@as(i64, 1), n.pageCount.?);
        try std.testing.expectEqual(@as(usize, 32), n.firstPage.?.hash.len);
        try std.testing.expectEqual(@as(i64, 1404), n.firstPage.?.width);
        try std.testing.expectEqual(@as(i64, 1404), n.thumbAspect.?.w);
        try std.testing.expectEqual(@as(i64, 1872), n.thumbAspect.?.h);
        try std.testing.expect(p.value.syncVersion > 0);
        @memcpy(work_id_str[0..p.value.entries[0].id.len], p.value.entries[0].id);
        work_id_len = p.value.entries[0].id.len;
    }

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/tree?parent={s}", .{work_id_str[0..work_id_len]});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            folderId: ?[]const u8 = null,
            path: []const struct { name: []const u8 },
            entries: []const struct { name: []const u8, pageCount: ?i64 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings(work_id_str[0..work_id_len], p.value.folderId.?);
        try std.testing.expectEqual(@as(usize, 1), p.value.path.len);
        try std.testing.expectEqualStrings("Work", p.value.path[0].name);
        try std.testing.expectEqual(@as(usize, 1), p.value.entries.len);
        try std.testing.expectEqual(@as(i64, 2), p.value.entries[0].pageCount.?);
    }

    var page0_hash: [32]u8 = undefined;
    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{top_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            id: []const u8,
            name: []const u8,
            pages: []const struct { index: i64, hash: []const u8, width: i64, height: i64 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("top.note", p.value.name);
        try std.testing.expectEqual(@as(usize, 1), p.value.pages.len);
        try std.testing.expectEqual(@as(i64, 0), p.value.pages[0].index);
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].hash.len);
        @memcpy(&page0_hash, p.value.pages[0].hash);
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/file/metadata/99999", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ top_id, page0_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(resp.body.len >= 4);
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") != null);
        try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "etag:") != null);
    }

    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ top_id, repeat(u8, "0", 32) });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/9?v={s}", .{ top_id, page0_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "text/event-stream") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "data: ") != null);
    }
}

/// A one-page `.note` with finished recognition holding `labels`.
fn seedRecognizedNote(f: *Fixture, user_id: u64, name: []const u8, labels: []const []const u8) !u64 {
    return seedRecognizedElements(f, user_id, name, "N6", blk: {
        const nb = @import("note_builder");
        const els = try gpa.alloc(nb.ElementSpec, labels.len);
        for (labels, els) |label, *e| e.* = .{ .label = label };
        break :blk els;
    }, true);
}

/// A recognized note with explicit `APPLY_EQUIPMENT` (null = unmeasured
/// hardware) and per-word boxes. `owns_elements` frees the slice.
fn seedRecognizedElements(
    f: *Fixture,
    user_id: u64,
    name: []const u8,
    equipment: ?[]const u8,
    elements: []const @import("note_builder").ElementSpec,
    owns_elements: bool,
) !u64 {
    const nb = @import("note_builder");
    defer if (owns_elements) gpa.free(elements);

    const header: []const nb.Kv = if (equipment) |eq|
        &.{.{ .key = "APPLY_EQUIPMENT", .value = eq }}
    else
        &.{};

    const bytes = try nb.serialize(gpa, .{ .header = header, .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
        .recogn_status = 1,
        .recogn_elements = elements,
    }} });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
    return e.id;
}

/// Page 0 rasterised from a PDF template with its links (`note-format.md`
/// §14); page 1 has none.
fn seedLinkedNote(f: *Fixture, user_id: u64, name: []const u8) !u64 {
    const nb = @import("note_builder");
    const bytes = try nb.serialize(gpa, .{ .pages = &.{
        .{
            .style = "user_pdf_planner_1",
            .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
            .links = &.{
                .{ .target_page = 2, .x = 901, .y = 192, .w = 407, .h = 50 },
                .{ .uri = "https://onplanners.com/g?a=1,2", .x = 53, .y = 464, .w = 297, .h = 121 },
                .{ .uri = "javascript:alert(1)", .x = 10, .y = 10, .w = 50, .h = 50 },
            },
        },
        .{ .layers = &.{.{ .slot = .main, .bitmap = "BBBB" }} },
    } });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
    return e.id;
}

test "control-plane page links: raw VO, versioned by linksHash, revalidated, 404 where there are none" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const id = try seedLinkedNote(f, admin, "planner.note");
    const plain_id = try seedNoteHttp(f, admin, null, "plain.note", &.{"AAAA"});

    // `linksHash` is omitted on pages without links, so the reader never asks.
    var links_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8, linksHash: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].linksHash.?.len);
        try std.testing.expect(p.value.pages[1].linksHash == null);
        @memcpy(&links_hash, p.value.pages[0].linksHash.?);
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "linksHash") == null);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links?v={s}", .{ id, links_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // Struct-serialised: `?v=` versions content, not shape, so no-cache.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null);

        var p = try std.json.parseFromSlice(struct {
            links: []const struct { x: f64, y: f64, w: f64, h: f64, page: i64, uri: []const u8 },
        }, gpa, resp.body, .{});
        defer p.deinit();
        // The `javascript:` record is filtered server-side too (the exporter
        // reads this endpoint).
        try std.testing.expectEqual(@as(usize, 2), p.value.links.len);
        // 1-based page 2 is index 1; `none` is external, spelled -1.
        try std.testing.expectEqual(@as(i64, 1), p.value.links[0].page);
        try std.testing.expectEqual(@as(f64, 901), p.value.links[0].x);
        try std.testing.expectEqual(@as(i64, -1), p.value.links[1].page);
        try std.testing.expectEqualStrings("https://onplanners.com/g?a=1,2", p.value.links[1].uri);
    }

    const stale = repeat(u8, "0", 32);
    const cases = [_]struct { id: u64, page: []const u8, v: []const u8 }{
        .{ .id = id, .page = "0", .v = stale },
        .{ .id = id, .page = "1", .v = &links_hash }, // the ordinary page
        .{ .id = plain_id, .page = "0", .v = &links_hash },
        .{ .id = id, .page = "9", .v = &links_hash },
        .{ .id = 99999, .page = "0", .v = &links_hash },
    };
    for (cases) |c| {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/{s}/links?v={s}", .{ c.id, c.page, c.v });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links?v={s}", .{ id, links_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN9");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links?v={s}", .{ id, links_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    // The row is keyed by blob md5 and shared by dedup; another account with
    // identical bytes must not reach it.
    {
        const bob = try f.svc.createUser(admin, "bob", false);
        const bob_tok = try onboardWeb(ctx, "bob", bob.temp_password.slice(), "bpass111");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links?v={s}", .{ id, links_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &bob_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "control-plane page text: raw VO, versioned by textHash, revalidated, 404 on stale or unrecognized" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const rec_id = try seedRecognizedNote(f, admin, "rec.note", &.{ "Test", "Middle" });
    const plain_id = try seedNoteHttp(f, admin, null, "plain.note", &.{"AAAA"}); // no recognition

    var text_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8, textHash: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].textHash.?.len);
        @memcpy(&text_hash, p.value.pages[0].textHash.?);
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "textHash") == null);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // `PageTextVO` shape can change under the same `?v=`, so no-cache.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null); // raw VO
        var p = try std.json.parseFromSlice(struct { text: ?[]const u8 = null }, gpa, resp.body, .{});
        defer p.deinit();
        try std.testing.expectEqualStrings("Test\nMiddle", p.value.text.?); // v7: regions newline-joined
    }

    const stale = repeat(u8, "0", 32);
    const cases = [_]struct { id: u64, page: []const u8, v: []const u8 }{
        .{ .id = rec_id, .page = "0", .v = stale }, // stale `?v=`
        .{ .id = plain_id, .page = "0", .v = &text_hash }, // never recognized
        .{ .id = plain_id, .page = "0", .v = stale }, // ...with any version at all
        .{ .id = rec_id, .page = "9", .v = &text_hash }, // out of range
        .{ .id = 99999, .page = "0", .v = &text_hash }, // no such note
    };
    for (cases) |c| {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/{s}/text?v={s}", .{ c.id, c.page, c.v });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN9");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    // Keyed by blob md5 and shared by dedup: another account must not reach it.
    {
        const bob = try f.svc.createUser(admin, "bob", false);
        const bob_tok = try onboardWeb(ctx, "bob", bob.temp_password.slice(), "bpass111");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &bob_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "control-plane listing: hasRecognizedText tracks finished on-device recognition; textHash rides the page list" {
    // Pins `hasRecognizedText` on the tree and `textHash` on note detail over
    // the real transport (the fake API emits them in dev).
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const rec_id = try seedRecognizedNote(f, admin, "rec.note", &.{ "Test", "Middle" });
    const plain_id = try seedNoteHttp(f, admin, null, "plain.note", &.{"AAAA"}); // no recognition

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const struct {
                id: []const u8,
                name: []const u8,
                hasRecognizedText: ?bool = null,
            },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.entries.len);

        var saw_rec = false;
        var saw_plain = false;
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.name, "rec.note")) {
                saw_rec = true;
                try std.testing.expectEqual(true, e.hasRecognizedText.?);
            } else if (std.mem.eql(u8, e.name, "plain.note")) {
                saw_plain = true;
                try std.testing.expectEqual(false, e.hasRecognizedText.?);
            }
        }
        try std.testing.expect(saw_rec and saw_plain);
    }

    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8, textHash: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].textHash.?.len);
        try std.testing.expect(!std.mem.eql(u8, p.value.pages[0].hash, p.value.pages[0].textHash.?));
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "textHash") == null);
    }
}

test "control-plane page text: word boxes in millimetres, separators skipped, scale only for known hardware" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const nb = @import("note_builder");
    // Two of the four words are the device's null-box layout separators. Boxes
    // are mm on the 118.64 x 158.19 mm canvas.
    const elements = [_]nb.ElementSpec{.{ .label = "alpha beta", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10.5, .y = 20.25, .width = 30.5, .height = 8.125 } },
        .{ .label = "\n", .box = null },
        .{ .label = " ", .box = null },
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};

    const known_id = try seedRecognizedElements(f, admin, "known.note", "N6", &elements, false);
    // Unmeasured hardware: `Dimensions.forEquipment`'s 1404x1872 fallback must
    // not become a mm scale.
    const unknown_id = try seedRecognizedElements(f, admin, "unknown.note", "N5", &elements, false);

    const Meta = struct {
        pages: []const struct { textHash: ?[]const u8 = null },
        pxPerMm: ?f32 = null,
    };
    const Body = struct {
        text: ?[]const u8 = null,
        words: ?[]const struct {
            text: []const u8,
            xMm: f32,
            yMm: f32,
            wMm: f32,
            hMm: f32,
        } = null,
    };

    var known_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{known_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Meta, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectApproxEqAbs(@as(f32, 11.834), p.value.pxPerMm.?, 0.001);
        @memcpy(&known_hash, p.value.pages[0].textHash.?);
    }

    // Unknown hardware: omitted, not zero or the pixel table's default.
    var unknown_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{unknown_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "pxPerMm") == null);
        var p = try std.json.parseFromSlice(Meta, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.pxPerMm == null);
        @memcpy(&unknown_hash, p.value.pages[0].textHash.?);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ known_id, known_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // `?v={textHash}` versions the transcript, not the struct; an
        // immutable response once pinned wordless copies.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);

        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();

        try std.testing.expectEqualStrings("alpha beta", p.value.text.?);

        // Null-box separators are dropped, not defaulted to {0,0,0,0}.
        const words = p.value.words.?;
        try std.testing.expectEqual(@as(usize, 2), words.len);
        try std.testing.expectEqualStrings("alpha", words[0].text);
        try std.testing.expectApproxEqAbs(@as(f32, 10.5), words[0].xMm, 1e-4);
        try std.testing.expectApproxEqAbs(@as(f32, 20.25), words[0].yMm, 1e-4);
        try std.testing.expectApproxEqAbs(@as(f32, 30.5), words[0].wMm, 1e-4);
        try std.testing.expectApproxEqAbs(@as(f32, 8.125), words[0].hMm, 1e-4);
        try std.testing.expectEqualStrings("beta", words[1].text);
        try std.testing.expectApproxEqAbs(@as(f32, 100), words[1].yMm, 1e-4);
        for (words) |w| try std.testing.expect(w.xMm >= 0 and w.yMm >= 0);
    }

    // Boxes are the device's mm verbatim; hardware only changes `pxPerMm`.
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ unknown_id, unknown_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        const words = p.value.words.?;
        try std.testing.expectEqual(@as(usize, 2), words.len);
        try std.testing.expectApproxEqAbs(@as(f32, 10.5), words[0].xMm, 1e-4);
    }

    // No positioned words: `words` is omitted, not `[]`.
    {
        const bare = try seedRecognizedNote(f, admin, "bare.note", &.{"solo"});
        var pbuf: [96]u8 = undefined;
        const mpath = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{bare});
        const mresp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", mpath, &web_tok, "");
        var mp = try std.json.parseFromSlice(Meta, gpa, mresp.body, .{ .ignore_unknown_fields = true });
        defer mp.deinit();

        var tbuf: [128]u8 = undefined;
        const tpath = try std.fmt.bufPrint(&tbuf, "/note/{d}/page/0/text?v={s}", .{ bare, mp.value.pages[0].textHash.? });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", tpath, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "words") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "solo") != null);
    }
}

/// One header's value copied out of the head, so a test can echo back the
/// exact `ETag` minted.
fn headerValue(head: []const u8, name: []const u8, buf: []u8) ![]const u8 {
    var lower_buf: [4096]u8 = undefined;
    const lower = lowerHead(&lower_buf, head);
    var needle_buf: [64]u8 = undefined;
    const needle = try std.fmt.bufPrint(&needle_buf, "\r\n{s}: ", .{name});
    const at = std.mem.indexOf(u8, lower, needle) orelse return error.HeaderMissing;
    const start = at + needle.len;
    const end = std.mem.indexOfPos(u8, head, start, "\r\n") orelse return error.HeaderMissing;
    const value = head[start..end];
    if (value.len > buf.len) return error.HeaderTooLong;
    @memcpy(buf[0..value.len], value);
    return buf[0..value.len];
}

/// A `files` row's blob md5 as lowercase hex.
fn fileMd5(f: *Fixture, id: u64) ![32]u8 {
    var s = try f.db.prepare("SELECT md5 FROM files WHERE id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(id));
    _ = try s.step();
    var out: [32]u8 = undefined;
    @memcpy(&out, s.columnText(0)[0..32]);
    return out;
}

test "the search-index manifest is served as bytes, and an unchanged one answers 304" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const keep = try seedRecognizedNote(f, admin, "keep.note", &.{"trimestral"});
    _ = keep;
    const gone = try seedRecognizedNote(f, admin, "gone.note", &.{"trimestral"});

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/manifest", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const bob = (try f.svc.createUser(admin, "bob", false)).id;
        _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN9");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/manifest", &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    var etag_buf: [64]u8 = undefined;
    var etag: []const u8 = "";
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // Binary (`SMAN`), not the 5.2x-larger JSON.
        try std.testing.expect(std.mem.startsWith(u8, resp.body, "SMAN"));
        try std.testing.expectEqual(@as(u8, 1), resp.body[4]);
        try std.testing.expectEqual(@as(u32, 2), std.mem.readInt(u32, resp.body[5..9], .little));
        // Names are deliberately not on the wire; the client has the listing.
        try std.testing.expect(std.mem.indexOf(u8, resp.body, ".note") == null);

        try expectHeaderContains(resp.head, "content-type: application/octet-stream");
        // Not `immutable`: absence from the manifest is the only removal channel.
        try expectHeaderContains(resp.head, "cache-control: private, no-cache");
        try expectHeaderAbsentSubstring(resp.head, "immutable");
        etag = try headerValue(resp.head, "etag", &etag_buf);
        try std.testing.expect(etag.len > 2);
    }

    var cookie_buf: [64]u8 = undefined;
    const cookie = try std.fmt.bufPrint(&cookie_buf, "sn_session={s}", .{web_tok});

    // An unchanged manifest costs a bodiless 304.
    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/manifest", &.{
            .{ .name = "cookie", .value = cookie },
            .{ .name = "if-none-match", .value = etag },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 304), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len);
        // The validator rides on the 304 too, or a client may drop it.
        try expectHeaderContains(resp.head, "etag:");
    }

    // A manifest that lost a row must not 304 (a version-counter validator
    // would): absence is how deletions reach the client.
    {
        try f.files.trash(admin, gone);
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/manifest", &.{
            .{ .name = "cookie", .value = cookie },
            .{ .name = "if-none-match", .value = etag },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(u32, 1), std.mem.readInt(u32, resp.body[5..9], .little));
    }
}

// ---- the stitched search-index stream ----
// Chromium and `curl --compressed` decode concatenated gzip members down to the
// first one and report success, as does Zig's `Decompress`; Node's zlib decodes
// all. So these tests assert decoded bytes and documents, never just success.

/// Decodes a chunked body; the stream route sends no `Content-Length`, since
/// skipped fragments make the length unknowable up front.
fn dechunk(a: std.mem.Allocator, raw: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    var rest = raw;
    while (true) {
        const eol = std.mem.indexOf(u8, rest, "\r\n") orelse return error.BadChunking;
        const semi = std.mem.indexOfScalar(u8, rest[0..eol], ';') orelse eol;
        const n = try std.fmt.parseInt(usize, rest[0..semi], 16);
        rest = rest[eol + 2 ..];
        if (n == 0) break;
        if (rest.len < n + 2) return error.BadChunking;
        try out.appendSlice(a, rest[0..n]);
        rest = rest[n + 2 ..];
    }
    return out.items;
}

/// Inflates a stitched body as a browser would and checks: exactly one gzip
/// member (by the full 10-byte header; 3-byte magic collides in deflate
/// output), the whole payload decodes, and the trailer matches.
/// `std.compress.flate.Decompress` never verifies the gzip CRC, so it is
/// checked here.
fn inflateStitched(a: std.mem.Allocator, body: []const u8) ![]u8 {
    const gzip_stitch = @import("../http/gzip_stitch.zig");
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, body, gzip_stitch.header));

    var input: std.Io.Reader = .fixed(body);
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .gzip, &window);
    var got: std.Io.Writer.Allocating = .init(a);
    _ = try d.reader.streamRemaining(&got.writer);

    try std.testing.expectEqual(std.hash.Crc32.hash(got.written()), d.container_metadata.gzip.crc);
    try std.testing.expectEqual(@as(u32, @intCast(got.written().len)), d.container_metadata.gzip.count);
    return got.written();
}

/// The uncompressed size from a stored fragment's 12-byte header, the number
/// the serve path feeds into the gzip trailer.
fn storedPlainLen(store: @import("../store/derived.zig").DerivedStore, md5: []const u8) !u32 {
    const derivedstore = @import("../store/derived.zig");
    const derivesearch = @import("../services/derive_search.zig");
    var file = try store.open(md5, derivesearch.index_version);
    defer file.close(std.testing.io);
    const h = try derivedstore.readHeader(std.testing.io, file);
    return h.len;
}

/// Wires both derived stores into a fixture; without them every manifest row
/// would be skipped and the test would assert nothing.
fn withDerivedStores(f: *Fixture) !void {
    const derivedstore = @import("../store/derived.zig");
    const io = std.testing.io;
    const terms_dir = try f.tmp.dir.createDirPathOpen(io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(io, "text", .{});
    f.files.terms = try derivedstore.DerivedStore.init(io, terms_dir);
    f.files.text = try derivedstore.DerivedStore.init(io, text_dir);
}

test "the search-index stream is ONE gzip member carrying every document, not a concatenation" {
    const derivesearch = @import("../services/derive_search.zig");
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [512]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    // Eight documents, each with a unique term: the bug is a ratio.
    const words = [_][]const u8{
        "trimestral", "orcamento",  "reuniao",  "acta",
        "relatorio",  "manutencao", "projecto", "arquivo",
    };
    var md5s: [words.len][32]u8 = undefined;
    for (words, 0..) |w, i| {
        const name = try std.fmt.allocPrint(a, "doc{d}.note", .{i});
        const id = try seedRecognizedNote(f, admin, name, &.{w});
        md5s[i] = try fileMd5(f, id);
    }

    // Unlink one fragment: a missing file mid-walk (GC race) is skipped, since
    // an error mid-stream poisons the whole stitched gzip.
    const gone = 5;
    f.files.terms.?.remove(&md5s[gone], derivesearch.index_version);

    var etag_buf: [64]u8 = undefined;
    var etag: []const u8 = "";
    var rows: u32 = 0;
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        rows = std.mem.readInt(u32, resp.body[5..9], .little);
        try std.testing.expectEqual(@as(u32, words.len), rows);
        etag = try headerValue(resp.head, "etag", &etag_buf);
    }
    try std.testing.expectEqual(@as(usize, 34), etag.len);
    const etag_hex = etag[1 .. etag.len - 1];

    var want_buf: [64]u8 = undefined;
    const want_all = wantEveryPosition(&want_buf, rows);

    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{ etag_hex, want_all });
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    // `content-encoding: gzip` regardless of `Accept-Encoding`: fragments only
    // exist compressed.
    try expectHeaderContains(resp.head, "content-encoding: gzip");
    try expectHeaderContains(resp.head, "content-type: application/x-ndjson");
    try expectHeaderContains(resp.head, "cache-control: private, no-store");
    try expectHeaderAbsentSubstring(resp.head, "content-length:");

    const body = try dechunk(a, resp.body);
    const plain = try inflateStitched(a, body);

    // Every record opens with `{"md5":"…`; seven, the unlinked one skipped.
    try std.testing.expectEqual(@as(usize, words.len - 1), std.mem.count(u8, plain, "{\"md5\":\""));

    // Decoded byte count from the stored headers catches a dropped fragment.
    var expected_bytes: u64 = 0;
    for (md5s, 0..) |md5, i| {
        if (i == gone) continue;
        expected_bytes += try storedPlainLen(f.files.terms.?, &md5);
    }
    try std.testing.expectEqual(expected_bytes, plain.len);

    // Each md5 and term exactly once; the unlinked one nowhere.
    for (md5s, words, 0..) |md5, word, i| {
        if (i == gone) {
            try std.testing.expectEqual(@as(usize, 0), std.mem.count(u8, plain, &md5));
            try std.testing.expect(std.mem.indexOf(u8, plain, word) == null);
            continue;
        }
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, plain, &md5));
        try std.testing.expect(std.mem.indexOf(u8, plain, word) != null);
    }

    // Each position singly: the manifest orders by `updated_at DESC, id`, so
    // seeding across a second boundary reorders it.
    {
        var served: usize = 0;
        var skipped: usize = 0;
        var pos: u32 = 0;
        while (pos < rows) : (pos += 1) {
            var bits = @as([8]u8, @splat(0));
            bits[pos >> 3] = @as(u8, 1) << @intCast(pos & 7);
            var b64: [16]u8 = undefined;
            const enc = std.base64.url_safe_no_pad.Encoder;
            const want_one = enc.encode(&b64, bits[0 .. (rows + 7) / 8]);

            const one = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{ etag_hex, want_one });
            const r = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", one, &web_tok, "");
            try std.testing.expectEqual(@as(u16, 200), r.status);
            const p = try inflateStitched(a, try dechunk(a, r.body));
            switch (std.mem.count(u8, p, "{\"md5\":\"")) {
                0 => skipped += 1,
                1 => served += 1,
                else => return error.TestUnexpectedResult, // one bit, one document
            }
        }
        try std.testing.expectEqual(words.len - 1, served);
        try std.testing.expectEqual(@as(usize, 1), skipped);
    }

    {
        const none = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want=", .{etag_hex});
        const r = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", none, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), r.status);
        try std.testing.expectEqualStrings("", try inflateStitched(a, try dechunk(a, r.body)));
    }
}

/// All `n` positions set, base64url like `webapp/src/search/wantBitmap.ts`.
/// Bits past `n` must stay clear (a set one is a 412).
fn wantEveryPosition(buf: []u8, n: u32) []const u8 {
    var bits: [64]u8 = @splat(0);
    for (0..n) |i| bits[i >> 3] |= @as(u8, 1) << @intCast(i & 7);
    return std.base64.url_safe_no_pad.Encoder.encode(buf, bits[0 .. (n + 7) / 8]);
}

test "the search-index stream refuses a bitmap it cannot trust: 412 on the manifest, 400 on the encoding" {
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [512]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    _ = try seedRecognizedNote(f, admin, "a.note", &.{"trimestral"});
    const doomed = try seedRecognizedNote(f, admin, "b.note", &.{"orcamento"});

    var etag_buf: [64]u8 = undefined;
    var etag: []const u8 = "";
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        etag = try headerValue(resp.head, "etag", &etag_buf);
    }
    var hex_buf: [32]u8 = undefined;
    @memcpy(&hex_buf, etag[1 .. etag.len - 1]);
    const etag_hex: []const u8 = &hex_buf;

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/stream?m=x&want=AQ", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const bob = (try f.svc.createUser(admin, "bob", false)).id;
        _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN9");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/stream?m=x&want=AQ", &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/stream?want=AQ", &web_tok, "", 400);

    // A wrong `m=` is 412 before the bitmap is parsed (this `want` would be a 400).
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/stream?m=" ++ repeat(u8, "0", 32) ++ "&want=+A", &web_tok, "", 412);

    // Trashing a document moves the manifest, so the old ETag stops answering.
    {
        const stale = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want=Aw", .{etag_hex});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", stale, &web_tok, "", 200);
        try f.files.trash(admin, doomed);
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", stale, &web_tok, "", 412);
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        etag = try headerValue(resp.head, "etag", &etag_buf);
        @memcpy(&hex_buf, etag[1 .. etag.len - 1]);
    }
    // Malformed encodings are 400: refetching the manifest would not help.
    for ([_][]const u8{ "+A", "/A", "A", "AB" }) |bad| {
        const p = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{ etag_hex, bad });
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", p, &web_tok, "", 400);
    }
    // Too long, or a bit past the end: 412, the two sides disagree on ordering.
    for ([_][]const u8{ "AAAA", "_g" }) |bad| {
        const p = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{ etag_hex, bad });
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", p, &web_tok, "", 412);
    }
}

test "the search-index stream is scoped to the caller: a housemate's documents are not in it" {
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [512]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));
    const mine = try seedRecognizedNote(f, admin, "mine.note", &.{"trimestral"});
    const theirs = try seedRecognizedNote(f, bob, "theirs.note", &.{"confidencial"});
    const mine_md5 = try fileMd5(f, mine);
    const theirs_md5 = try fileMd5(f, theirs);

    var etag_buf: [64]u8 = undefined;
    var rows: u32 = 0;
    var etag: []const u8 = "";
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        rows = std.mem.readInt(u32, resp.body[5..9], .little);
        etag = try headerValue(resp.head, "etag", &etag_buf);
    }
    // The scope is the manifest's (`d.user_id = ?1`): a position can only name
    // a row the caller's manifest listed.
    try std.testing.expectEqual(@as(u32, 1), rows);

    var want_buf: [64]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{
        etag[1 .. etag.len - 1],
        wantEveryPosition(&want_buf, rows),
    });
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    const plain = try inflateStitched(a, try dechunk(a, resp.body));

    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, plain, "{\"md5\":\""));
    try std.testing.expect(std.mem.indexOf(u8, plain, &mine_md5) != null);
    try std.testing.expect(std.mem.indexOf(u8, plain, &theirs_md5) == null);
    try std.testing.expect(std.mem.indexOf(u8, plain, "confidencial") == null);
}

// ---- the per-document text route ----
// One route serves live, retained and trashed text alike; a caller who cannot
// reach a blob is told the same as for an underived one.

/// GETs one md5's text record, asserts the transport contract, returns the
/// decoded bytes.
fn fetchDocText(
    a: std.mem.Allocator,
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    tok: []const u8,
    md5: []const u8,
) ![]u8 {
    var pbuf: [128]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/text/{s}", .{md5});
    const resp = try requestWithCookie(ctx, obuf, reqbuf, "GET", path, tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    try expectHeaderContains(resp.head, "content-type: application/x-ndjson");
    try expectHeaderContains(resp.head, "content-encoding: gzip");
    // A bare URL is not cached for a year: its key omits the `index_version`
    // the file is keyed by, so a parser bump could not invalidate it.
    try expectHeaderContains(resp.head, "cache-control: private, immutable");
    try expectHeaderAbsentSubstring(resp.head, "max-age");

    const derivesearch = @import("../services/derive_search.zig");
    // With `?v=` it can be immutable.
    {
        var vbuf: [256]u8 = undefined;
        const versioned = try std.fmt.bufPrint(&vbuf, "/api/controlplane/text/{s}?v={d}", .{ md5, derivesearch.index_version });
        const r = try requestWithCookie(ctx, obuf, reqbuf, "GET", versioned, tok, "");
        try std.testing.expectEqual(@as(u16, 200), r.status);
        try expectHeaderContains(r.head, "cache-control: private, max-age=31536000, immutable");
    }
    {
        var vbuf: [256]u8 = undefined;
        const stale = try std.fmt.bufPrint(&vbuf, "/api/controlplane/text/{s}?v={d}", .{ md5, derivesearch.index_version - 1 });
        const r = try requestWithCookie(ctx, obuf, reqbuf, "GET", stale, tok, "");
        try std.testing.expectEqual(@as(u16, 200), r.status);
        try expectHeaderAbsentSubstring(r.head, "max-age");
    }
    // A real length: no mid-walk skip is possible here.
    try expectHeaderContains(resp.head, "content-length:");
    try expectHeaderAbsentSubstring(resp.head, "transfer-encoding:");

    return inflateStitched(a, resp.body);
}

test "the per-document text route serves ONE document's real text, by each of the three ways a caller reaches it" {
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    // Accents on purpose: `terms/` is diacritic-folded, `text/` holds the real
    // text find-in-document highlights.
    const live = try seedRecognizedNote(f, admin, "vivo.note", &.{"reunião de orçamento"});
    // Supersede to create gate 2: a version no `files` row points at.
    _ = try seedRecognizedNote(f, admin, "vivo.note", &.{"versão revista"});
    const current_md5 = try fileMd5(f, live);
    const retained_md5 = try soleHistoryMd5(f, live);

    const binned = try seedRecognizedNote(f, admin, "lixo.note", &.{"documentação antiga"});
    const binned_md5 = try fileMd5(f, binned);
    try f.files.trash(admin, binned);

    {
        const plain = try fetchDocText(a, ctx, &obuf, &reqbuf, &web_tok, &current_md5);

        // One header line naming md5 and version, then one line per segment.
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, plain, "{\"md5\":\""));
        try std.testing.expect(std.mem.startsWith(u8, plain, "{\"md5\":\""));
        try std.testing.expect(std.mem.indexOf(u8, plain, &current_md5) != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "\"p\":0") != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "versão revista") != null);

        try std.testing.expectEqual(
            @as(usize, try storedPlainLen(f.files.text.?, &current_md5)),
            plain.len,
        );
    }

    // Gate 2: `reachesBlob` finding the `file_history` row.
    {
        const plain = try fetchDocText(a, ctx, &obuf, &reqbuf, &web_tok, &retained_md5);
        try std.testing.expect(std.mem.indexOf(u8, plain, &retained_md5) != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "reunião de orçamento") != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "versão revista") == null);
    }

    // Gate 3: trashing hides the row but the bin reads the same file.
    {
        const plain = try fetchDocText(a, ctx, &obuf, &reqbuf, &web_tok, &binned_md5);
        try std.testing.expect(std.mem.indexOf(u8, plain, &binned_md5) != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "documentação antiga") != null);
    }
}

test "the per-document text route: unreachable and underived are ONE 404, byte for byte" {
    const derivesearch = @import("../services/derive_search.zig");
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));

    // Bob has a live and a retained version: both gates must hold the boundary.
    const theirs = try seedRecognizedNote(f, bob, "deles.note", &.{"confidencial"});
    _ = try seedRecognizedNote(f, bob, "deles.note", &.{"confidencial revisto"});
    const theirs_md5 = try fileMd5(f, theirs);
    const theirs_old_md5 = try soleHistoryMd5(f, theirs);

    const mine = try seedRecognizedNote(f, admin, "meu.note", &.{"inventário"});
    const mine_md5 = try fileMd5(f, mine);

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/text/" ++ repeat(u8, "a", 32), &.{}, "");
        try std.testing.expectEqual(@as(u16, 401), (try roundtrip(ctx, req, &obuf)).status);
    }
    {
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN9");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/text/" ++ repeat(u8, "a", 32), &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        try std.testing.expectEqual(@as(u16, 403), (try roundtrip(ctx, req, &obuf)).status);
    }

    // Works for the owner first, so the 404s below are the gate.
    _ = try fetchDocText(a, ctx, &obuf, &reqbuf, &web_tok, &mine_md5);

    // Underived: the blob is reachable, the derived file absent (GC'd or pending).
    f.files.text.?.remove(&mine_md5, derivesearch.index_version);

    // All refusals must be byte-identical, or the route is an existence oracle
    // over the shared blob space.
    const refusals = [_][]const u8{
        &mine_md5, // reachable, NOT derived
        &theirs_md5, // derived, NOT reachable — a housemate's live document
        &theirs_old_md5, // derived, NOT reachable — a housemate's retained version
        repeat(u8, "f", 32), // names no blob at all
        "nao-e-um-md5", // not even the right shape: still 404, never a 400
    };
    var first: []const u8 = "";
    for (refusals, 0..) |md5, i| {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/text/{s}", .{md5});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        // A miss carries no cache policy: the URL becomes valid once derived.
        try expectHeaderAbsentSubstring(resp.head, "immutable");
        try expectHeaderAbsentSubstring(resp.head, "cache-control");

        const whole = try std.fmt.allocPrint(a, "{s}\r\n\r\n{s}", .{ resp.head, resp.body });
        if (i == 0) first = whole else try std.testing.expectEqualStrings(first, whole);
    }
}

// Find-in-note is done in the browser over `text/:md5`. Content-addressing
// means a housemate holding identical bytes gets that text; `reachesBlob` is
// the boundary.

test "static SPA serving: index, assets, wasm, path-traversal refused, API precedence, disabled=404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    var web = std.testing.tmpDir(.{});
    defer web.cleanup();
    const index_html = "<!doctype html><title>SPA</title>";
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "index.html", .data = index_html });
    var assets = try web.dir.createDirPathOpen(std.testing.io, "assets", .{});
    assets.close(std.testing.io);
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/x.js", .data = "console.log(1)" });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "x.wasm", .data = "\x00asm\x01\x00\x00\x00" });

    // The tmp dir is `.zig-cache/tmp/<sub_path>` relative to the repo root.
    var wd_buf: [256]u8 = undefined;
    ctx.config.web_dir = try std.fmt.bufPrint(&wd_buf, ".zig-cache/tmp/{s}", .{web.sub_path});

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // The shell must state `no-cache`: its URL never changes and it points at
    // the current hashed bundle, so heuristic freshness pins an old build.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(index_html, resp.body);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/html") != null);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "max-age") == null);
    }

    // Both URLs reach the shell, so both carry the policy.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/index.html", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(index_html, resp.body);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("console.log(1)", resp.body);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/javascript") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") != null);
    }

    // Un-fingerprinted, so it revalidates: the decoder must never lag the
    // year-cached SNPG payloads it decodes.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/x.wasm", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: application/wasm") != null);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/../../etc/passwd", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    // No SPA fallback (hash routing).
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/does-not-exist.js", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/api/version", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(app.api_version, resp.body); // the handler ran, not static
    }

    {
        ctx.config.web_dir = "";
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "static serving negotiates precompressed variants: br > gzip > raw, honoring q=0" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // Sibling files hold distinct sentinels (not real gzip/brotli), so the body
    // shows which variant was chosen.
    var web = std.testing.tmpDir(.{});
    defer web.cleanup();
    var assets = try web.dir.createDirPathOpen(std.testing.io, "assets", .{});
    assets.close(std.testing.io);
    const raw = "RAW-console.log(1)";
    const gz = "GZIP-BYTES-x";
    const br = "BROTLI-BYTES";
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/x.js", .data = raw });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/x.js.gz", .data = gz });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/x.js.br", .data = br });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/y.css", .data = "body{color:red}" });

    var wd_buf: [256]u8 = undefined;
    ctx.config.web_dir = try std.fmt.bufPrint(&wd_buf, ".zig-cache/tmp/{s}", .{web.sub_path});

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // .br bytes with the base Content-Type, Vary, and the base path's cache policy.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "gzip, deflate, br" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(br, resp.body);
        try expectHeaderContains(resp.head, "content-encoding: br");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/javascript") != null);
        try expectHeaderContains(resp.head, "vary: accept-encoding");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") != null);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "gzip, deflate" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(gz, resp.body);
        try expectHeaderContains(resp.head, "content-encoding: gzip");
        try expectHeaderContains(resp.head, "vary: accept-encoding");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(raw, resp.body);
        try expectHeaderAbsentSubstring(resp.head, "content-encoding:");
        try expectHeaderAbsentSubstring(resp.head, "vary:");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "identity" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(raw, resp.body);
        try expectHeaderAbsentSubstring(resp.head, "content-encoding:");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "br;q=0, gzip" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(gz, resp.body);
        try expectHeaderContains(resp.head, "content-encoding: gzip");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/y.css", &.{
            .{ .name = "accept-encoding", .value = "br, gzip" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("body{color:red}", resp.body);
        try expectHeaderAbsentSubstring(resp.head, "content-encoding:");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/css") != null);
    }
}

// ---- assertion helpers ----

/// `requestWithCookie` plus a `Range` header.
fn requestRanged(
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    path: []const u8,
    token: []const u8,
    range: []const u8,
) !Response {
    var cbuf: [64]u8 = undefined;
    const cookie = try std.fmt.bufPrint(&cbuf, "sn_session={s}", .{token});
    const req = try buildRequest(reqbuf, "GET", path, &.{
        .{ .name = "cookie", .value = cookie },
        .{ .name = "range", .value = range },
    }, "");
    return roundtrip(ctx, req, obuf);
}

fn requestWithCookie(
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    method: []const u8,
    path: []const u8,
    token: []const u8,
    body: []const u8,
) !Response {
    var cbuf: [64]u8 = undefined;
    const cookie = try std.fmt.bufPrint(&cbuf, "sn_session={s}", .{token});
    const req = try buildRequest(reqbuf, method, path, &.{
        .{ .name = "content-type", .value = "application/json" },
        .{ .name = "cookie", .value = cookie },
    }, body);
    return roundtrip(ctx, req, obuf);
}

fn expectStatusWithCookie(
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    method: []const u8,
    path: []const u8,
    token: []const u8,
    body: []const u8,
    want: u16,
) !void {
    const resp = try requestWithCookie(ctx, obuf, reqbuf, method, path, token, body);
    try std.testing.expectEqual(want, resp.status);
}

fn expectSuccess(body: []const u8) !void {
    var parsed = try std.json.parseFromSlice(struct { success: bool }, gpa, body, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    try std.testing.expect(parsed.value.success);
}

fn expectFailure(body: []const u8, code: []const u8) !void {
    var parsed = try std.json.parseFromSlice(
        struct { success: bool, errorCode: []const u8 = "" },
        gpa,
        body,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    try std.testing.expect(!parsed.value.success);
    try std.testing.expectEqualStrings(code, parsed.value.errorCode);
}

test "handle() drives requests through the db_lock path without deadlocking" {
    const f = try Fixture.init();
    defer f.deinit();

    // Exercise transport.handle's lock path: a dropped unlock would deadlock the
    // second request.
    var lock: std.Io.Mutex = .init;
    f.ctx.db_lock = &lock;
    const ctx = &f.ctx;

    _ = try f.svc.bootstrapAdmin("admin", "temp0000");

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    for (0..2) |_| {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"admin\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
    }
}

test "manual_db_lock is set on EXACTLY the two /oss routes, the page route, the raw-file routes, the thumbnail route, the SSE route, the device list_folder route and the web upload route" {
    // `manual_db_lock` opts a route out of the whole-handler DB lock; a handler
    // that then touches the DB without `ctx.db_lock` is a silent data race.
    // Adding a route here means auditing its DB touches: each must lock only
    // its brief lookups and stream with the lock released.
    const expected = [_][]const u8{
        "/oss/get/:id",
        "/oss/put/:innerName",
        "/note/:id/page/:n",
        "/note/:id/template/:hash",
        "/file/:id",
        "/thumbnail/:hash",
        "/api/controlplane/events",
        "/api/controlplane/bin/note/:id/page/:n",
        "/api/controlplane/bin/file/:id",
        "/api/file/2/files/list_folder",
        "/api/controlplane/note/:id/history/:md5/page/:n",
        "/api/controlplane/note/:id/history/:md5/raw",
        "/api/controlplane/bin/note/:id/history/:md5/page/:n",
        "/api/controlplane/bin/note/:id/history/:md5/raw",
        "/api/controlplane/folder/:id/upload",
        // Manual to get a reader: `read_only` would hold the lease for the
        // whole download.
        "/api/controlplane/search-index/stream",
        "/api/controlplane/text/:md5",
    };
    var found: usize = 0;
    for (app.routes) |r| {
        if (!r.manual_db_lock) continue;
        found += 1;
        var matched_expected = false;
        for (expected) |e| {
            if (std.mem.eql(u8, e, r.path)) matched_expected = true;
        }
        if (!matched_expected) {
            std.debug.print("unexpected manual_db_lock route: {s}\n", .{r.path});
            return error.UnexpectedManualDbLockRoute;
        }
    }
    try std.testing.expectEqual(expected.len, found);
}

// ---- the cache-policy pin ----
// A response may be `immutable` only when its cache key covers everything that
// can change about it; a content hash does not cover a serialised struct. The
// classification below is exhaustive so no new route skips the decision.

/// The only routes allowed to answer `immutable`: opaque bytes, no serialised
/// struct, under a content-addressed key (`?v=` md5 with 404-on-mismatch, or a
/// `:hash`/`:md5` in the path). SNPG's envelope is outside `?v=` but versioned
/// in band. `text/:md5` gets no `max-age`: its file is keyed by
/// `(md5, index_version)`, so it changes once per parser release.
const immutable_routes = [_][]const u8{
    "/note/:id/page/:n",
    "/note/:id/template/:hash",
    "/file/:id",
    "/thumbnail/:hash",
    "/api/controlplane/bin/note/:id/page/:n",
    "/api/controlplane/bin/file/:id",
    "/api/controlplane/note/:id/history/:md5/page/:n",
    "/api/controlplane/note/:id/history/:md5/raw",
    "/api/controlplane/bin/note/:id/history/:md5/page/:n",
    "/api/controlplane/bin/note/:id/history/:md5/raw",
    "/api/controlplane/text/:md5",
};

/// Every other route; an unlisted route fails the test. JSON belongs here: its
/// shape is not in its cache key.
const non_immutable_routes = [_][]const u8{
    "/api/admin/elevate",
    "/api/admin/lock",
    "/api/admin/users",
    "/api/admin/users/:id",
    "/api/admin/users/:id/reset",
    "/api/admin/users/:id/devices",
    "/api/admin/users/:id/devices/unlink",
    "/api/admin/users/:id/quota",
    "/api/admin/settings/retention",
    "/api/admin/health",
    "/api/controlplane/account",
    "/api/controlplane/account/storage",
    "/api/controlplane/account/devices/unlink",
    "/api/controlplane/account/sign-out-others",
    "/api/controlplane/account/versions",
    "/api/controlplane/bin",
    "/api/controlplane/bin/:id",
    "/api/controlplane/bin/:id/restore",
    "/api/controlplane/bin/file/metadata/:id",
    "/api/controlplane/bin/note/:id/page/:n/text",
    "/api/controlplane/bin/note/:id/history",
    "/api/controlplane/bin/note/:id/history/:md5/page/:n/text",
    "/api/controlplane/entry/:id",
    "/api/controlplane/entry/:id/rename",
    "/api/controlplane/equipment/unlink",
    "/api/controlplane/events",
    "/api/controlplane/file/metadata/:id",
    "/api/controlplane/folder/:id/upload",
    "/api/controlplane/note/:id/history",
    "/api/controlplane/note/:id/history/:md5/meta",
    "/api/controlplane/note/:id/history/:md5/page/:n/text",
    "/api/controlplane/note/:id/history/:md5/restore",
    "/api/controlplane/search-index/manifest",
    // no-store: a document still deriving is skipped, so identical requests
    // may differ.
    "/api/controlplane/search-index/stream",
    "/api/controlplane/server-info",
    "/api/controlplane/tree",
    "/api/controlplane/usage",
    "/api/equipment/bind/status",
    "/api/file/2/files/create_folder_v2",
    "/api/file/2/files/list_folder",
    "/api/file/2/files/synchronous/end",
    "/api/file/2/files/synchronous/start",
    "/api/file/2/files/upload/finish",
    "/api/file/2/users/get_space_usage",
    "/api/file/3/files/copy_v3",
    "/api/file/3/files/delete_folder_v3",
    "/api/file/3/files/download_v3",
    "/api/file/3/files/move_v3",
    "/api/file/3/files/query/by/path_v3",
    "/api/file/3/files/query_v3",
    "/api/file/3/files/upload/apply",
    "/api/file/capacity/query",
    "/api/file/query/server",
    "/api/file/query/summary/group",
    "/api/file/query/summary/hash",
    "/api/file/query/summary/id",
    "/api/file/schedule/group/all",
    "/api/file/schedule/task/all",
    "/api/official/user/account/login/equipment",
    "/api/official/user/account/login/new",
    "/api/official/user/check/exists/server",
    "/api/official/user/query/random/code",
    "/api/terminal/equipment/unlink",
    "/api/terminal/user/bindEquipment",
    "/api/user/logout",
    "/api/user/me",
    "/api/user/password",
    "/api/user/query",
    "/api/version",
    "/note/:id/page/:n/links",
    "/note/:id/page/:n/text",
    "/oss/get/:id",
    "/oss/put/:innerName",
};

fn listed(list: []const []const u8, path: []const u8) bool {
    for (list) |p| {
        if (std.mem.eql(u8, p, path)) return true;
    }
    return false;
}

test "cache policy: every route is classified, and only the byte routes may be immutable" {
    // Exhaustive over the live route table, both new and deleted routes.
    for (app.routes) |r| {
        const a = listed(&immutable_routes, r.path);
        const b = listed(&non_immutable_routes, r.path);
        if (a == b) { // in neither list, or (impossibly) in both
            std.debug.print("route not classified for cache policy: {s}\n", .{r.path});
            return error.UnclassifiedCachePolicyRoute;
        }
    }
    for (immutable_routes ++ non_immutable_routes) |p| {
        var exists = false;
        for (app.routes) |r| {
            if (std.mem.eql(u8, r.path, p)) exists = true;
        }
        if (!exists) {
            std.debug.print("cache-policy list names a route that no longer exists: {s}\n", .{p});
            return error.StaleCachePolicyEntry;
        }
    }
    try std.testing.expectEqual(@as(usize, 11), immutable_routes.len);
}

test "cache policy: the served responses match the classification, route by route" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const note_id = try seedRecognizedNote(f, admin, "cached.note", &.{ "Test", "Middle" });
    const pic = try putSeedHashed(f, admin, null, "shot.png", "raw bytes");

    var page_hash: [32]u8 = undefined;
    var text_hash: [32]u8 = undefined;
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{note_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8, textHash: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&page_hash, p.value.pages[0].hash);
        @memcpy(&text_hash, p.value.pages[0].textHash.?);
    }

    const allowed = [_][]const u8{
        try std.fmt.bufPrint(pbuf[0..96], "/note/{d}/page/0?v={s}", .{ note_id, page_hash[0..] }),
        try std.fmt.bufPrint(pbuf[96..], "/file/{d}?v={s}", .{ pic.id, pic.md5[0..] }),
    };
    for (allowed) |path| {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
    }

    // Not on the 404 path: that would cache the miss.
    {
        const stale = [_][]const u8{
            try std.fmt.bufPrint(pbuf[0..96], "/note/{d}/page/0?v={s}", .{ note_id, repeat(u8, "0", 32) }),
            try std.fmt.bufPrint(pbuf[96..], "/file/{d}?v={s}", .{ pic.id, repeat(u8, "0", 32) }),
        };
        for (stale) |path| {
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
            try std.testing.expectEqual(@as(u16, 404), resp.status);
            try expectHeaderAbsentSubstring(resp.head, "immutable");
        }
    }

    const others = [_][]const u8{
        "/api/version",
        "/api/user/me",
        "/api/file/query/server",
        "/api/controlplane/tree",
        "/api/controlplane/bin",
        "/api/controlplane/account",
        "/api/controlplane/account/storage",
        "/api/controlplane/events",
        "/api/admin/users",
        "/oss/get/1?t=deadbeefdeadbeefdeadbeefdeadbeef",
        // The text route's miss path (no derived stores here).
        "/api/controlplane/text/" ++ repeat(u8, "f", 32),
        try std.fmt.bufPrint(pbuf[0..96], "/api/controlplane/file/metadata/{d}", .{note_id}),
        try std.fmt.bufPrint(pbuf[96..], "/note/{d}/page/0/text?v={s}", .{ note_id, text_hash[0..] }),
    };
    for (others) |path| {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try expectHeaderAbsentSubstring(resp.head, "immutable");
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ note_id, text_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
    }
}

/// Fails if `needle` appears anywhere in the response head, under any header.
fn expectHeaderAbsentSubstring(head: []const u8, needle: []const u8) !void {
    if (std.mem.indexOf(u8, head, needle) != null) {
        std.debug.print("unexpected `{s}` in response head:\n{s}\n", .{ needle, head });
        return error.UnexpectedHeaderToken;
    }
}

test "db_lock is released after handle() for both a normal and a manual_db_lock route" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    // `tryLock` succeeds only when unlocked, so it detects a leaked acquire.
    const expectUnlocked = struct {
        fn check(m: *std.Io.Mutex) !void {
            try std.testing.expect(m.tryLock()); // would fail if handle() leaked the lock
            m.unlock(std.testing.io);
        }
    }.check;

    try expectUnlocked(&lock); // sanity: the guard can tell "unlocked"

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"admin\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try expectUnlocked(&lock);

    const blob_bytes = "hello narrow-lock download blob";
    const file_id = try putSeed(f, admin, null, "a.note", blob_bytes);
    const now_ms = std.Io.Clock.real.now(std.testing.io).toMilliseconds();
    const tok = try f.dltokens.mint(std.testing.io, file_id, admin, now_ms);
    var pbuf: [128]u8 = undefined;
    const oss_path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}?t={s}", .{ file_id, &tok });
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", oss_path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(blob_bytes, resp.body);
    }
    try expectUnlocked(&lock);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}?t=deadbeefdeadbeefdeadbeefdeadbeef", .{file_id});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
    try expectUnlocked(&lock);

    const note_id = try seedNoteHttp(f, admin, null, "locked.note", &.{"AAAA"});
    const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
    try expectUnlocked(&lock); // the onboarding roundtrips balanced too

    var page0_hash: [32]u8 = undefined;
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{note_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&page0_hash, p.value.pages[0].hash);
    }
    try expectUnlocked(&lock);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ note_id, page0_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]); // the real payload, not a truncated read
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") != null);
    }
    try expectUnlocked(&lock);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ note_id, repeat(u8, "0", 32) });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    try expectUnlocked(&lock);

    const raw_bytes = "raw png-ish bytes for the browser face";
    const pic = try putSeedHashed(f, admin, null, "shot.png", raw_bytes);
    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ pic.id, pic.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(raw_bytes, resp.body);
    }
    try expectUnlocked(&lock);
    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ pic.id, repeat(u8, "0", 32) });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    try expectUnlocked(&lock);
}

/// `putSeed` plus the blob md5 (the raw-file route's `?v=`).
const Seeded = struct { id: u64, md5: [32]u8 };

fn putSeedHashed(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, data: []const u8) !Seeded {
    var r = std.Io.Reader.fixed(data);
    const e = try f.files.putFile(user_id, parent, name, &r, null);
    defer gpa.free(e.name);
    defer if (e.md5) |m| gpa.free(m);
    var out: Seeded = .{ .id = e.id, .md5 = undefined };
    @memcpy(&out.md5, e.md5.?);
    return out;
}

/// The response head lowercased into `buf`, for case-insensitive assertions.
fn lowerHead(buf: []u8, head: []const u8) []const u8 {
    const n = @min(buf.len, head.len);
    for (head[0..n], 0..) |c, i| buf[i] = std.ascii.toLower(c);
    return buf[0..n];
}

fn expectHeaderContains(head: []const u8, needle: []const u8) !void {
    var buf: [4096]u8 = undefined;
    const lower = lowerHead(&buf, head);
    if (std.mem.indexOf(u8, lower, needle) == null) {
        std.debug.print("missing header fragment `{s}` in:\n{s}\n", .{ needle, head });
        return error.HeaderMissing;
    }
}

fn expectHeaderAbsent(head: []const u8, needle: []const u8) !void {
    var buf: [4096]u8 = undefined;
    const lower = lowerHead(&buf, head);
    if (std.mem.indexOf(u8, lower, needle) != null) {
        std.debug.print("unexpected header fragment `{s}` in:\n{s}\n", .{ needle, head });
        return error.UnexpectedHeader;
    }
}

test "raw file route: ownership, versioning, and the inline/attachment allowlist" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const mallory = (try f.svc.createUser(admin, "mallory", false)).id;
    _ = try f.svc.changePassword(mallory, null, &password.md5Hex("mpass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;

    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    // Before the device login: a password change revokes device tokens too.
    const mtok = try onboardWeb(ctx, "mallory", "mpass111", "mallorypw1");
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "mallory", "mallorypw1", "SN9");

    const png_bytes = "\x89PNG\r\n\x1a\n not really a png, but exactly these bytes";
    const png = try putSeedHashed(f, admin, null, "20260719_165902_Page_1.png", png_bytes);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ png.id, png.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(png_bytes, resp.body);

        // Content-Length is declared from `files.size`, never chunked.
        var lbuf: [64]u8 = undefined;
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-length: {d}", .{png_bytes.len}));
        try expectHeaderAbsent(resp.head, "transfer-encoding");

        try expectHeaderContains(resp.head, "content-type: image/png");
        try expectHeaderContains(resp.head, "content-disposition: inline;");
        try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "etag: \"{s}\"", .{png.md5[0..]}));
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ png.id, png.md5[0..] });
        var lbuf: [80]u8 = undefined;

        // Advertised on a plain reply too.
        {
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
            try expectHeaderContains(resp.head, "accept-ranges: bytes");
        }

        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, "bytes=4-11");
            try std.testing.expectEqual(@as(u16, 206), resp.status);
            try std.testing.expectEqualStrings(png_bytes[4..12], resp.body);
            try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-range: bytes 4-11/{d}", .{png_bytes.len}));
            try expectHeaderContains(resp.head, "content-length: 8");
        }

        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, "bytes=10-");
            try std.testing.expectEqual(@as(u16, 206), resp.status);
            try std.testing.expectEqualStrings(png_bytes[10..], resp.body);
        }

        // Suffix: the last 5 bytes (a PDF's trailer lives there).
        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, "bytes=-5");
            try std.testing.expectEqual(@as(u16, 206), resp.status);
            try std.testing.expectEqualStrings(png_bytes[png_bytes.len - 5 ..], resp.body);
        }

        // 416 with the unsatisfied-range form: the client needs the size.
        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, "bytes=99999-");
            try std.testing.expectEqual(@as(u16, 416), resp.status);
            try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-range: bytes */{d}", .{png_bytes.len}));
        }

        // Malformed and multi-range are ignored (200, per RFC 9110).
        for ([_][]const u8{ "bytes=abc", "bytes=9-2", "bytes=0-3,8-11", "items=0-3" }) |bad| {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, bad);
            try std.testing.expectEqual(@as(u16, 200), resp.status);
            try std.testing.expectEqualStrings(png_bytes, resp.body);
        }

        // Ownership is checked first: a foreign caller gets 404, not a 206.
        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &mtok, "bytes=0-3");
            try std.testing.expectEqual(@as(u16, 404), resp.status);
        }
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}&download=1", .{ png.id, png.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(png_bytes, resp.body);
        try expectHeaderContains(resp.head, "content-disposition: attachment;");
    }

    const Case = struct { name: []const u8, mime: []const u8, disposition: []const u8 };
    const cases = [_]Case{
        .{ .name = "a.jpg", .mime = "image/jpeg", .disposition = "inline" },
        .{ .name = "a.JPEG", .mime = "image/jpeg", .disposition = "inline" }, // case-insensitive
        .{ .name = "a.webp", .mime = "image/webp", .disposition = "inline" },
        .{ .name = "a.gif", .mime = "image/gif", .disposition = "inline" },
        .{ .name = "a.pdf", .mime = "application/pdf", .disposition = "inline" },
        // SVG executes script: inline from our origin would be stored XSS.
        .{ .name = "a.svg", .mime = "application/octet-stream", .disposition = "attachment" },
        .{ .name = "a.html", .mime = "application/octet-stream", .disposition = "attachment" },
        .{ .name = "a.note", .mime = "application/octet-stream", .disposition = "attachment" },
        .{ .name = "a.spd", .mime = "application/octet-stream", .disposition = "attachment" },
        .{ .name = "noextension", .mime = "application/octet-stream", .disposition = "attachment" },
    };
    for (cases, 0..) |c, i| {
        // Distinct bytes per case so dedup can't collapse them.
        var body_buf: [64]u8 = undefined;
        const bytes = try std.fmt.bufPrint(&body_buf, "payload-{d}-{s}", .{ i, c.name });
        const seed = try putSeedHashed(f, admin, null, c.name, bytes);

        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ seed.id, seed.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(bytes, resp.body);

        var hbuf: [128]u8 = undefined;
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&hbuf, "content-type: {s}", .{c.mime}));
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&hbuf, "content-disposition: {s};", .{c.disposition}));
        // nosniff stops a wrong label being sniffed into text/html.
        try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
    }

    {
        const nasty = "ev\"il\r\nX-Injected: yes.png";
        const bytes = "nasty-name-bytes";
        const seed = try putSeedHashed(f, admin, null, nasty, bytes);
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ seed.id, seed.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");

        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(bytes, resp.body);
        // The forged name survives only as text inside one header's value.
        try expectHeaderAbsent(resp.head, "\r\nx-injected:");
        try expectHeaderContains(resp.head, "content-disposition: inline; filename=\"ev_il__x-injected_ yes.png\"");
        try expectHeaderContains(resp.head, "content-type: image/png");
        // Status + exactly 7 headers: a forged filename cannot add a line.
        try std.testing.expect(std.mem.count(u8, resp.head, "\r\n") == 7);
    }

    {
        const bare = try std.fmt.bufPrint(&pbuf, "/file/{d}", .{png.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", bare, &web_tok, "", 404);
        const stale = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ png.id, repeat(u8, "0", 32) });
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", stale, &web_tok, "", 404);
    }

    // Another user's file is 404, not 403 (no existence oracle).
    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ png.id, png.md5[0..] });
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &mtok, "", 404);
        const ghost = try std.fmt.bufPrint(&pbuf, "/file/999999?v={s}", .{png.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", ghost, &web_tok, "", 404);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ png.id, png.md5[0..] });
        const anon = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 401), anon.status);

        const dev = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), dev.status);
    }
}

test "raw file: /file serves a .note's exact bytes as attachment (no .note-specific download path)" {
    // `/file/:id?v=` is the one raw-bytes primitive, `.note` included; there is
    // no `.note`-specific download route.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var note_bytes: [2048]u8 = undefined;
    const magic = "noteSN_FILE_VER_20230015";
    @memcpy(note_bytes[0..magic.len], magic);
    for (note_bytes[magic.len..], magic.len..) |*b, i| b.* = @truncate(i * 31 + 7);

    const note = try putSeedHashed(f, admin, null, "diary.note", &note_bytes);

    const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ note.id, note.md5[0..] });
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    try std.testing.expectEqualStrings(&note_bytes, resp.body);

    try expectHeaderContains(resp.head, "content-type: application/octet-stream");
    try expectHeaderContains(resp.head, "content-disposition: attachment;");
    try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
    try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
    var lbuf: [64]u8 = undefined;
    try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "etag: \"{s}\"", .{note.md5[0..]}));
    try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-length: {d}", .{note_bytes.len}));
}

test "raw file route: the listing carries fileHash, and a multi-chunk blob streams whole" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;

    // More than one 64 KiB chunk and not a multiple of it, so the pump loops
    // and ends on a short chunk.
    const big_len = 150 * 1024 + 7;
    const big = try gpa.alloc(u8, big_len);
    defer gpa.free(big);
    for (big, 0..) |*b, i| b.* = @truncate(i *% 31 +% 7);

    const seed = try putSeedHashed(f, admin, null, "scan.pdf", big);

    const obuf = try gpa.alloc(u8, 1 << 19);
    defer gpa.free(obuf);

    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var listed_hash: [32]u8 = undefined;
    {
        const resp = try requestWithCookie(ctx, obuf, &reqbuf, "GET", "/api/controlplane/tree", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const struct {
                kind: []const u8,
                name: []const u8,
                fileType: ?[]const u8 = null,
                fileHash: ?[]const u8 = null,
            },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();

        var seen = false;
        for (p.value.entries) |e| {
            if (!std.mem.eql(u8, e.name, "scan.pdf")) continue;
            seen = true;
            try std.testing.expectEqualStrings("pdf", e.fileType.?);
            try std.testing.expectEqual(@as(usize, 32), e.fileHash.?.len);
            @memcpy(&listed_hash, e.fileHash.?);
        }
        try std.testing.expect(seen);
    }
    try std.testing.expectEqualStrings(seed.md5[0..], listed_hash[0..]);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ seed.id, listed_hash[0..] });
        const resp = try requestWithCookie(ctx, obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(usize, big_len), resp.body.len);
        try std.testing.expectEqualSlices(u8, big, resp.body);

        var lbuf: [64]u8 = undefined;
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-length: {d}", .{big_len}));
        try expectHeaderAbsent(resp.head, "transfer-encoding");
    }
}

/// A minimal `.spd` (SQLite with a `config` table) as bytes; `thumbnail` null
/// omits the `thumbnail` row.
fn buildSpdFixture(thumb: ?[]const u8) ![]u8 {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE config(name TEXT PRIMARY KEY NOT NULL, value BLOB);");
    try db.exec("INSERT INTO config(name, value) VALUES('fmt_ver', '2');");
    if (thumb) |t| {
        var s = try db.prepare("INSERT INTO config(name, value) VALUES('thumbnail', ?1);");
        defer s.finalize();
        s.bindBlob(1, t);
        _ = try s.step();
    }
    return db.serializeAlloc(gpa);
}

test "GET /thumbnail/{hash}: extracted .spd preview served immutable; 404 for no-thumbnail, corrupt, foreign, and unowned" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const jpeg = "\xff\xd8\xff\xe0" ++ (repeat(u8, "supernote-thumbnail-pixels", 8));

    const spd = try buildSpdFixture(jpeg);
    defer gpa.free(spd);
    const drawing = try putSeedHashed(f, admin, null, "drawing.spd", spd);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{drawing.md5[0..]});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, jpeg, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/jpeg");
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
        try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
        var lbuf: [64]u8 = undefined;
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-length: {d}", .{jpeg.len}));
        try expectHeaderAbsent(resp.head, "transfer-encoding");
    }

    // A `.txt` has no thumbnail, but `/file/{id}` serves its bytes for the snippet.
    const txt_body = "The quick brown fox.\nA second line the client would raster.\n";
    const note = try putSeedHashed(f, admin, null, "readme.txt", txt_body);
    {
        const tpath = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{note.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", tpath, &admin_tok, "", 404);
    }
    {
        const fpath = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ note.id, note.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", fpath, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(txt_body, resp.body);
    }

    // A corrupt `.spd` still uploads; it just has no thumbnail.
    const corrupt = try putSeedHashed(f, admin, null, "broken.spd", "SQLite format 3\x00 then total garbage \xff\x00\xab");
    {
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{corrupt.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/thumbnail/not-a-hash", &admin_tok, "", 404);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/thumbnail/ffffffffffffffffffffffffffffffff", &admin_tok, "", 404);

    // Bob's thumbnail row exists, but admin does not hold that blob: 404.
    const bob_spd = try buildSpdFixture("\x89PNG\r\n\x1a\n" ++ (repeat(u8, "bobs-private-drawing", 4)));
    defer gpa.free(bob_spd);
    const bob_drawing = try putSeedHashed(f, bob, null, "secret.spd", bob_spd);
    {
        try std.testing.expect(try f.files.holdsBlob(bob, &bob_drawing.md5));
        try std.testing.expect(!try f.files.holdsBlob(admin, &bob_drawing.md5));
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{bob_drawing.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{drawing.md5[0..]});
        const req = try buildRequest(&reqbuf, "GET", path, &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
}

test "GET /thumbnail/{hash}: a lost thumbs/ file heals on demand — the next GET regenerates and serves 200" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const jpeg = "\xff\xd8\xff\xe0" ++ (repeat(u8, "regenerate-me", 8));
    const spd = try buildSpdFixture(jpeg);
    defer gpa.free(spd);
    const drawing = try putSeedHashed(f, admin, null, "drawing.spd", spd);
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{drawing.md5[0..]});

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    // A restore skipped `thumbs/`: the serve path must re-derive and serve.
    f.files.thumbs.remove(&drawing.md5);
    try std.testing.expect(!f.files.thumbs.has(&drawing.md5));
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, jpeg, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/jpeg");
    }
    try std.testing.expect(f.files.thumbs.has(&drawing.md5)); // healed on disk too
}

test "GET /thumbnail/{hash}: a corrupt .spd is derived ONCE — two GETs, two 404s, one derive" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    // SQLite magic + garbage fails the real open (`indexable = 0`); wiping the
    // row makes the first GET pay the derive.
    const corrupt = try putSeedHashed(f, admin, null, "broken.spd", "SQLite format 3\x00 then total garbage \xff\x00\xab");
    try f.db.exec("DELETE FROM spd_index;");
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{corrupt.md5[0..]});

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("SELECT indexable FROM spd_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &corrupt.md5);
        try std.testing.expect(try s.step()); // the memo row exists
        try std.testing.expectEqual(@as(i64, 0), s.columnInt(0)); // recorded as unparseable
    }

    // A sentinel `indexed_at` survives only if no second derive upserts it.
    try f.db.exec("UPDATE spd_index SET indexed_at = 12345;");

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("SELECT indexed_at FROM spd_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &corrupt.md5);
        try std.testing.expect(try s.step());
        try std.testing.expectEqual(@as(i64, 12345), s.columnInt(0));
    }
}

/// A real minimal PNG head (320×240 IHDR) that sniffs and yields dims.
const cover_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

/// A one-page `.note`, optionally with `cover` as its `COVER_2` block.
fn buildNoteFixture(cover: ?[]const u8) ![]u8 {
    const nb = @import("note_builder");
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
        .covers = if (cover) |c| &.{.{ .bytes = c }} else &.{},
    });
}

test "GET /thumbnail/{hash}: a .note cover serves 200 immutable; a coverless note is a memoized 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    // Streamed from the blob at the location the ingest parse recorded, same
    // serve contract as the `.spd` thumbnail.
    const covered = try buildNoteFixture(cover_png);
    defer gpa.free(covered);
    const note = try putSeedHashed(f, admin, null, "covered.note", covered);
    {
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{note.md5[0..]});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/png");
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
        try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
        var lbuf: [64]u8 = undefined;
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-length: {d}", .{cover_png.len}));
        try expectHeaderAbsent(resp.head, "transfer-encoding");
    }

    // Coverless (the common case) is memoized; the sentinel proves no re-parse.
    const plain = try buildNoteFixture(null);
    defer gpa.free(plain);
    const coverless = try putSeedHashed(f, admin, null, "plain.note", plain);
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{coverless.md5[0..]});
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("UPDATE note_index SET indexed_at = 54321 WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &coverless.md5);
        _ = try s.step();
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("SELECT indexed_at FROM note_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &coverless.md5);
        try std.testing.expect(try s.step());
        try std.testing.expectEqual(@as(i64, 54321), s.columnInt(0));
    }
}

test "GET /thumbnail/{hash}: a wiped .note cover row heals on demand — the repair e2e, second format" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const covered = try buildNoteFixture(cover_png);
    defer gpa.free(covered);
    const note = try putSeedHashed(f, admin, null, "covered.note", covered);
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{note.md5[0..]});

    // A `.note` cover streams from the blob; ingest writes no thumbs file.
    try std.testing.expect(!f.files.thumbs.has(&note.md5));
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
    }

    // No index row: the magic dispatch must route the re-derive to the cover parse.
    try f.db.exec("DELETE FROM note_index;");
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/png");
    }
    {
        var sqlbuf: [160]u8 = undefined;
        const sql = try std.fmt.bufPrintSentinel(&sqlbuf, "SELECT cover_offset IS NOT NULL FROM note_index WHERE blob_md5 = ?1 AND index_version = {d};", .{noteindex.index_version}, 0);
        var s = try f.db.prepare(sql);
        defer s.finalize();
        s.bindText(1, &note.md5);
        try std.testing.expect(try s.step());
        try std.testing.expectEqual(@as(i64, 1), s.columnInt(0));
    }
}

test "GET /note/{id}/template/{hash}: serves the custom image template; 404 for a wrong hash or note" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const nb = @import("note_builder");

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    const bytes = try nb.serialize(gpa, .{ .pages = &.{.{
        .style = "customImage",
        .style_md5 = hash,
        .layers = &.{
            .{ .slot = .background, .name = "BGLAYER", .protocol = "RATTA_RLE", .bitmap = cover_png },
            .{ .slot = .main, .name = "MAINLAYER", .protocol = "RATTA_RLE", .bitmap = &.{ 0x61, 0x00 } },
        },
    }} });
    defer gpa.free(bytes);
    const note = try putSeedHashed(f, admin, null, "template.note", bytes);

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/template/{s}", .{ note.id, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/png");
        try expectHeaderContains(resp.head, "immutable");
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/template/{s}", .{ note.id, "00000000000000000000000000000000" });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/template/{s}", .{ note.id + 999, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

// ---- /api/controlplane/events: the held SSE stream ----
// A stream holding `db_lock` for its lifetime looks fine to the browser while
// freezing device sync; only a held stream plus a concurrent request catches it.

/// Runs one events request on its own thread with its own `Context` copy, as
/// `connThread` does, keeping the raw response.
const StreamRunner = struct {
    ctx: *Context,
    token: [32]u8,
    /// Cleared when the handler returns — "is the stream still held?".
    running: std.atomic.Value(bool) = .init(true),
    status: u16 = 0,
    failed: bool = false,
    raw: [8192]u8 = undefined,
    raw_len: usize = 0,

    fn run(self: *StreamRunner) void {
        defer self.running.store(false, .release);
        var reqbuf: [1024]u8 = undefined;
        var local = self.ctx.*; // exactly what connThread does with ctx
        const resp = requestWithCookie(&local, &self.raw, &reqbuf, "GET", "/api/controlplane/events", &self.token, "") catch {
            self.failed = true;
            return;
        };
        self.status = resp.status;
        self.raw_len = resp.head.len + 4 + resp.body.len;
    }

    fn output(self: *const StreamRunner) []const u8 {
        return self.raw[0..self.raw_len];
    }

    /// Blocks until the stream holds its slot, so tests never race the spawn.
    fn waitUntilHeld(self: *StreamRunner, streams: *eventstreams.EventStreams) !void {
        for (0..2000) |_| {
            if (streams.count(std.testing.io) == 1) return;
            if (!self.running.load(.acquire)) return error.StreamEndedBeforeItStarted;
            try std.testing.io.sleep(.fromMilliseconds(1), .awake);
        }
        return error.StreamNeverStarted;
    }
};

fn onboardedAdmin(f: *Fixture) !struct { id: u64, token: [32]u8 } {
    const id = try f.svc.bootstrapAdmin("admin", "temp0000");
    const token = try onboardWeb(&f.ctx, "admin", "temp0000", "s3cret-pw");
    return .{ .id = id, .token = token };
}

test "a HELD SSE stream never parks the global DB lock: concurrent requests are served throughout" {
    // Ordinary DB routes must be served while the stream stays held.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // Without serve mode's lock, lockDb is a no-op and the test is vacuous.
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 10,
        .heartbeat_ms = 1_000_000, // no heartbeat: this test is about the lock only
        .max_lifetime_ms = 2_000, // ample headroom over the ~ms of work below
    };
    ctx.event_streams = &streams;

    var runner: StreamRunner = .{ .ctx = ctx, .token = who.token };
    const t = try std.Thread.spawn(.{}, StreamRunner.run, .{&runner});
    defer t.join();
    try runner.waitUntilHeld(&streams);

    var obuf: [8192]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    for (0..20) |_| {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &who.token, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    try std.testing.expectEqual(@as(u32, 1), streams.count(std.testing.io));
}

test "a held stream pushes a NEW syncVersion when the tree changes, then releases its slot" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 5,
        .heartbeat_ms = 1_000_000,
        .max_lifetime_ms = 400,
    };
    ctx.event_streams = &streams;

    var runner: StreamRunner = .{ .ctx = ctx, .token = who.token };
    const t = try std.Thread.spawn(.{}, StreamRunner.run, .{&runner});
    try runner.waitUntilHeld(&streams);

    {
        lock.lockUncancelable(std.testing.io);
        defer lock.unlock(std.testing.io);
        const dir = try f.files.createFolder(who.id, null, "Dir");
        gpa.free(dir.name);
    }

    t.join();
    try std.testing.expectEqual(@as(u16, 200), runner.status);

    const out = runner.output();
    try std.testing.expect(std.ascii.findIgnoreCase(out, "transfer-encoding: chunked") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "text/event-stream") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "retry: ") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "data: 0") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "data: 1") != null);

    // A leaked slot would silently downgrade the endpoint to one-shot forever.
    try std.testing.expectEqual(@as(u32, 0), streams.count(std.testing.io));
    try std.testing.expectEqual(@as(u32, 0), streams.countFor(std.testing.io, who.id));
}

test "`event: index` is emitted when a derive completes, and NOT when an unrelated file is renamed" {
    // Frames only on change (the link is treated as 3G): a tree change emits
    // `event: sync` and leaves `event: index` silent.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    {
        lock.lockUncancelable(std.testing.io);
        defer lock.unlock(std.testing.io);
        var r = std.Io.Reader.fixed("A paragraph.\n\nAnd a second one.\n");
        const e = try f.files.putFile(who.id, null, "notes.txt", &r, null);
        gpa.free(e.name);
        if (e.md5) |m| gpa.free(m);
    }

    var worker: deferredsvc.Worker = .{
        .gpa = gpa,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &lock,
        .io = std.testing.io,
    };
    var pulse: pendingsvc.Pulse = .{
        .db = f.db,
        .db_lock = &lock,
        .io = std.testing.io,
        .worker = &worker,
        .max_age_ms = 1_000_000,
    };
    ctx.pending = &pulse;

    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 5,
        .heartbeat_ms = 1_000_000,
        .max_lifetime_ms = 600,
    };
    ctx.event_streams = &streams;

    var runner: StreamRunner = .{ .ctx = ctx, .token = who.token };
    const t = try std.Thread.spawn(.{}, StreamRunner.run, .{&runner});
    try runner.waitUntilHeld(&streams);

    {
        lock.lockUncancelable(std.testing.io);
        defer lock.unlock(std.testing.io);
        const dir = try f.files.createFolder(who.id, null, "Dir");
        gpa.free(dir.name);
    }
    // Let the stream see the rename before the derive, so the two can't share a frame.
    try std.testing.io.sleep(.fromMilliseconds(60), .awake);

    worker.drain();

    t.join();
    try std.testing.expectEqual(@as(u16, 200), runner.status);
    const out = runner.output();

    try std.testing.expect(std.mem.indexOf(u8, out, "event: index\ndata: {\"pending\":1,") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "event: index\ndata: {\"pending\":0,") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "event: sync") != null);

    var frames: usize = 0;
    var at: usize = 0;
    while (std.mem.indexOfPos(u8, out, at, "event: index")) |i| : (at = i + 1) frames += 1;
    try std.testing.expectEqual(@as(usize, 2), frames);
}

test "with no pending pulse the endpoint says NOTHING about indexing rather than claiming zero" {
    // `ctx.pending == null` must send no `event: index`; `pending: 0` would be
    // an unchecked claim.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const who = try onboardedAdmin(f);
    try std.testing.expect(ctx.pending == null);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &who.token, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: index") == null);
}

test "the DEGRADED one-shot shape carries the index frame too — it is the client furthest from the next one" {
    // An over-cap caller gets a full one-shot answer and reconnects on `retry:`.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;
    const who = try onboardedAdmin(f);

    {
        lock.lockUncancelable(std.testing.io);
        defer lock.unlock(std.testing.io);
        var r = std.Io.Reader.fixed("A paragraph.\n\nAnd a second one.\n");
        const e = try f.files.putFile(who.id, null, "notes.txt", &r, null);
        gpa.free(e.name);
        if (e.md5) |m| gpa.free(m);
    }
    var pulse: pendingsvc.Pulse = .{ .db = f.db, .db_lock = &lock, .io = std.testing.io };
    ctx.pending = &pulse;

    var streams: eventstreams.EventStreams = .{ .max_total = 8, .max_per_user = 1 };
    ctx.event_streams = &streams;
    try std.testing.expect(streams.tryAcquire(std.testing.io, who.id)); // occupy it
    defer streams.release(std.testing.io, who.id);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &who.token, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "chunked") == null); // really one-shot
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: index\ndata: {\"pending\":1,") != null);
}

test "an idle held stream emits heartbeat comment frames" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    // No tree changes: without a heartbeat a dead peer looks like a quiet one.
    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 5,
        .heartbeat_ms = 10,
        .max_lifetime_ms = 200,
    };
    ctx.event_streams = &streams;

    var runner: StreamRunner = .{ .ctx = ctx, .token = who.token };
    const t = try std.Thread.spawn(.{}, StreamRunner.run, .{&runner});
    t.join();

    try std.testing.expectEqual(@as(u16, 200), runner.status);
    // `:` is an SSE comment: ignored by EventSource but real bytes on the wire.
    try std.testing.expect(std.mem.indexOf(u8, runner.output(), ": ping") != null);
    try std.testing.expectEqual(@as(u32, 0), streams.count(std.testing.io));
}

test "at the per-user cap the events endpoint DEGRADES to one-shot rather than refusing" {
    // Over cap degrades to one-shot, not 503.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    var streams: eventstreams.EventStreams = .{ .max_total = 8, .max_per_user = 1 };
    ctx.event_streams = &streams;

    try std.testing.expect(streams.tryAcquire(std.testing.io, who.id));
    defer streams.release(std.testing.io, who.id);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &who.token, "");

    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.head, "text/event-stream") != null);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "retry: ") != null);
    try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "content-length:") != null);
    try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "chunked") == null);
    try std.testing.expectEqual(@as(u32, 1), streams.count(std.testing.io));
}

test "with no stream registry (the single-threaded harness) the endpoint is one-shot" {
    // With no `ctx.event_streams` there is no thread to park; holding would hang.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const who = try onboardedAdmin(f);
    try std.testing.expect(ctx.event_streams == null);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &who.token, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
    try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "chunked") == null);
}

test "a dead client tears the stream down and returns its slot, long before the lifetime cap" {
    // A dead peer surfaces only as a failing write (the heartbeat's job),
    // modelled by a response buffer that fills up.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    // Long lifetime: teardown must come from the write failure.
    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 1,
        .heartbeat_ms = 1,
        .max_lifetime_ms = 30_000,
    };
    ctx.event_streams = &streams;

    var reqbuf: [1024]u8 = undefined;
    var small: [640]u8 = undefined; // head + the first frame, then no room
    const started = std.Io.Timestamp.now(std.testing.io, .awake);
    _ = requestWithCookie(ctx, &small, &reqbuf, "GET", "/api/controlplane/events", &who.token, "") catch {};
    const elapsed_ms = started.durationTo(std.Io.Timestamp.now(std.testing.io, .awake)).toMilliseconds();

    try std.testing.expect(elapsed_ms < 10_000);
    try std.testing.expectEqual(@as(u32, 0), streams.count(std.testing.io));
    try std.testing.expectEqual(@as(u32, 0), streams.countFor(std.testing.io, who.id));
}

// ---- the recycle bin, over HTTP ----

/// The parsed `GET /api/controlplane/bin` body, only the fields the UI needs.
const BinBody = struct {
    entries: []const struct {
        kind: []const u8,
        id: []const u8,
        name: []const u8,
        path: []const u8,
        deletedAt: i64,
        size: i64,
        parentId: ?[]const u8 = null,
        isRoot: bool,
        fileType: ?[]const u8 = null,
        fileHash: ?[]const u8 = null,
        thumbAspect: ?struct { w: i64, h: i64 } = null,
    },
    totalBytes: i64,
    retentionDays: i64,
};

fn getBin(ctx: *Context, obuf: []u8, reqbuf: []u8, tok: []const u8) !std.json.Parsed(BinBody) {
    const resp = try requestWithCookie(ctx, obuf, reqbuf, "GET", "/api/controlplane/bin", tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    return std.json.parseFromSlice(BinBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
}

test "web DELETE of a folder walks the subtree itself, and the bin lists every row with the path it had" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const dir = try f.files.createFolder(admin, null, "NOTE");
    defer gpa.free(dir.name);
    const sub = try f.files.createFolder(admin, dir.id, "Work");
    defer gpa.free(sub.name);
    const deep = try putSeed(f, admin, sub.id, "deep.note", "deep body");
    const loose = try putSeed(f, admin, null, "loose.note", "loose");

    // The device walks the subtree itself; the browser sends one request, so
    // the server walks.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{dir.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            name: []const u8,
            isFolder: bool,
            entries: i64,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("NOTE", p.value.name);
        try std.testing.expect(p.value.isFolder);
        try std.testing.expectEqual(@as(i64, 3), p.value.entries);
    }
    try std.testing.expectEqual(@as(i64, 3), try countTrashed(f, admin));

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{loose});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }

    var parsed = try getBin(ctx, &obuf, &reqbuf, &web);
    defer parsed.deinit();
    const bin = parsed.value;
    try std.testing.expectEqual(@as(usize, 4), bin.entries.len);
    try std.testing.expectEqual(@as(i64, 30), bin.retentionDays);
    // Folder rows contribute no bytes, so "frees N bytes" does not double-count.
    try std.testing.expectEqual(@as(i64, 14), bin.totalBytes);

    var deep_id_buf: [24]u8 = undefined;
    const deep_id = try std.fmt.bufPrint(&deep_id_buf, "{d}", .{deep});
    var seen_deep = false;
    for (bin.entries) |e| {
        try std.testing.expect(e.deletedAt > 0);
        if (std.mem.eql(u8, e.id, deep_id)) {
            seen_deep = true;
            // Both ancestors are trashed; a live-only parent walk would say `/deep.note`.
            try std.testing.expectEqualStrings("/NOTE/Work/deep.note", e.path);
            try std.testing.expectEqualStrings("note", e.kind);
            try std.testing.expectEqualStrings("note", e.fileType.?); // not a real .note container
            try std.testing.expect(e.fileHash != null); // the preview URL's `?v=`
            try std.testing.expect(e.thumbAspect == null); // unparseable: no shape to freeze
            try std.testing.expect(!e.isRoot); // it came down with `NOTE`
        }
        if (std.mem.eql(u8, e.name, "loose.note")) {
            try std.testing.expectEqualStrings("/loose.note", e.path);
            try std.testing.expect(e.isRoot);
        }
        if (std.mem.eql(u8, e.name, "NOTE")) {
            try std.testing.expect(e.isRoot);
            try std.testing.expectEqual(@as(i64, 0), e.size);
        }
    }
    try std.testing.expect(seen_deep);

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "loose.note") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"NOTE\"") == null);
    }
}

const RenamedBody = struct { kind: []const u8, name: []const u8 };

fn renameEntry(ctx: *Context, obuf: []u8, reqbuf: []u8, tok: []const u8, id: u64, new_name: []const u8) !Response {
    var pbuf: [96]u8 = undefined;
    var bbuf: [256]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}/rename", .{id});
    const body = try std.fmt.bufPrint(&bbuf, "{{\"name\":\"{s}\"}}", .{new_name});
    return requestWithCookie(ctx, obuf, reqbuf, "POST", path, tok, body);
}

fn liveName(f: *Fixture, user_id: u64, id: u64) ![]u8 {
    const e = (try f.files.get(user_id, id)).?;
    if (e.md5) |m| gpa.free(m);
    return @constCast(e.name);
}

test "web rename: renames a file and a folder in place, returns the updated entry, and bumps syncVersion" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const dir = try f.files.createFolder(admin, null, "Poems");
    defer gpa.free(dir.name);
    const note = try putSeed(f, admin, dir.id, "Ozymandias.note", "I met a traveller");

    const v0 = try f.files.syncVersion(admin);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, note, "Sonnet.note");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(RenamedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("note", p.value.kind);
        try std.testing.expectEqualStrings("Sonnet.note", p.value.name);
    }
    try std.testing.expect(try f.files.syncVersion(admin) > v0);
    {
        const nm = try liveName(f, admin, note);
        defer gpa.free(nm);
        try std.testing.expectEqualStrings("Sonnet.note", nm);
    }

    {
        var pbuf: [64]u8 = undefined;
        var idbuf: [24]u8 = undefined;
        const id_str = try std.fmt.bufPrint(&idbuf, "{d}", .{dir.id});
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/tree?parent={s}", .{id_str});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Sonnet.note") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Ozymandias.note") == null);
    }

    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, dir.id, "Verse");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(RenamedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("folder", p.value.kind);
        try std.testing.expectEqualStrings("Verse", p.value.name);
    }
    {
        const nm = try liveName(f, admin, dir.id);
        defer gpa.free(nm);
        try std.testing.expectEqualStrings("Verse", nm);
    }
}

test "web rename: a sibling name-clash is a 409 and changes nothing" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    _ = try putSeed(f, admin, null, "taken.note", "occupant");
    const mover = try putSeed(f, admin, null, "mover.note", "the one being renamed");

    const v0 = try f.files.syncVersion(admin);
    const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, mover, "taken.note");
    try std.testing.expectEqual(@as(u16, 409), resp.status);

    {
        const nm = try liveName(f, admin, mover);
        defer gpa.free(nm);
        try std.testing.expectEqualStrings("mover.note", nm);
    }
    try std.testing.expectEqual(v0, try f.files.syncVersion(admin));
}

test "web rename: refuses the fixed category roots and anchor subfolders (403), but renames user folders that merely share a name" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    // Device tree: roots NOTE / DOCUMENT, anchors NOTE/Note, NOTE/MyStyle,
    // DOCUMENT/Document.
    const root_note = try f.files.createFolder(admin, null, "NOTE");
    defer gpa.free(root_note.name);
    const root_doc = try f.files.createFolder(admin, null, "DOCUMENT");
    defer gpa.free(root_doc.name);
    const anchor_note = try f.files.createFolder(admin, root_note.id, "Note");
    defer gpa.free(anchor_note.name);
    const anchor_mystyle = try f.files.createFolder(admin, root_note.id, "MyStyle");
    defer gpa.free(anchor_mystyle.name);
    const anchor_document = try f.files.createFolder(admin, root_doc.id, "Document");
    defer gpa.free(anchor_document.name);

    const Guarded = struct { id: u64, name: []const u8 };
    const guarded = [_]Guarded{
        .{ .id = root_note.id, .name = "NOTE" },
        .{ .id = root_doc.id, .name = "DOCUMENT" },
        .{ .id = anchor_note.id, .name = "Note" },
        .{ .id = anchor_mystyle.id, .name = "MyStyle" },
        .{ .id = anchor_document.id, .name = "Document" },
    };
    for (guarded) |g| {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, g.id, "Renamed");
        try std.testing.expectEqual(@as(u16, 403), resp.status);
        const nm = try liveName(f, admin, g.id);
        defer gpa.free(nm);
        try std.testing.expectEqualStrings(g.name, nm); // untouched
    }

    // The guard keys on shape, not name: a root-level "Note"...
    const loose_note = try f.files.createFolder(admin, null, "Note");
    defer gpa.free(loose_note.name);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, loose_note.id, "Journal");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // ...a "Note" under the anchor "Note"...
    const deep_note = try f.files.createFolder(admin, anchor_note.id, "Note");
    defer gpa.free(deep_note.name);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, deep_note.id, "Sub");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // ...and a "Note" under a non-root "NOTE" all rename fine.
    const user_container = try f.files.createFolder(admin, loose_note.id, "NOTE");
    defer gpa.free(user_container.name);
    const note_under_nonroot = try f.files.createFolder(admin, user_container.id, "Note");
    defer gpa.free(note_under_nonroot.name);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, note_under_nonroot.id, "Free");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
}

test "web rename: a foreign or missing id is one indistinguishable 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    // Foreign and missing ids both 404.
    const foreign = try renameEntry(ctx, &obuf, &reqbuf, &web, bob_id, "stolen.note");
    try std.testing.expectEqual(@as(u16, 404), foreign.status);
    const missing = try renameEntry(ctx, &obuf, &reqbuf, &web, 999999, "ghost.note");
    try std.testing.expectEqual(@as(u16, 404), missing.status);

    const nm = try liveName(f, bob, bob_id);
    defer gpa.free(nm);
    try std.testing.expectEqualStrings("bob.note", nm);
}

test "web rename: rejects an empty name and a name containing a path separator (400)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const note = try putSeed(f, admin, null, "keep.note", "unchanged");

    const empty = try renameEntry(ctx, &obuf, &reqbuf, &web, note, "   ");
    try std.testing.expectEqual(@as(u16, 400), empty.status);
    const slashed = try renameEntry(ctx, &obuf, &reqbuf, &web, note, "a/b.note");
    try std.testing.expectEqual(@as(u16, 400), slashed.status);

    const nm = try liveName(f, admin, note);
    defer gpa.free(nm);
    try std.testing.expectEqualStrings("keep.note", nm);
}

// ---- web upload (POST /api/controlplane/folder/:id/upload) ----

const upload_boundary = "----InkholdWebUploadBoundary";

/// `payload` as the one file part of a browser upload. Caller frees.
fn buildUploadBody(filename: []const u8, payload: []const u8) ![]u8 {
    const head = try std.fmt.allocPrint(
        gpa,
        "--{s}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{s}\"\r\nContent-Type: application/octet-stream\r\n\r\n",
        .{ upload_boundary, filename },
    );
    defer gpa.free(head);
    const tail = try std.fmt.allocPrint(gpa, "\r\n--{s}--\r\n", .{upload_boundary});
    defer gpa.free(tail);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, head);
    try out.appendSlice(gpa, payload);
    try out.appendSlice(gpa, tail);
    return out.toOwnedSlice(gpa);
}

fn uploadFile(
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    tok: []const u8,
    dest: []const u8,
    filename: []const u8,
    payload: []const u8,
) !Response {
    return uploadFileQuery(ctx, obuf, reqbuf, tok, dest, filename, payload, "");
}

/// `uploadFile`, reporting how much of the request the server read (see `Sent`).
fn uploadFileCounting(
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    tok: []const u8,
    dest: []const u8,
    filename: []const u8,
    payload: []const u8,
) !Sent {
    const req = try buildUploadRequest(reqbuf, tok, dest, filename, payload, "");
    return roundtripCounting(ctx, req, obuf);
}

fn uploadFileQuery(
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    tok: []const u8,
    dest: []const u8,
    filename: []const u8,
    payload: []const u8,
    query: []const u8,
) !Response {
    const req = try buildUploadRequest(reqbuf, tok, dest, filename, payload, query);
    return roundtrip(ctx, req, obuf);
}

fn buildUploadRequest(
    reqbuf: []u8,
    tok: []const u8,
    dest: []const u8,
    filename: []const u8,
    payload: []const u8,
    query: []const u8,
) ![]const u8 {
    const wire = try buildUploadBody(filename, payload);
    defer gpa.free(wire);
    var pbuf: [128]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/folder/{s}/upload{s}", .{ dest, query });
    var cbuf: [64]u8 = undefined;
    const cookie = try std.fmt.bufPrint(&cbuf, "sn_session={s}", .{tok});
    return buildRequest(reqbuf, "POST", path, &.{
        .{ .name = "content-type", .value = "multipart/form-data; boundary=" ++ upload_boundary },
        .{ .name = "cookie", .value = cookie },
    }, wire);
}

fn destOf(buf: []u8, id: u64) ![]const u8 {
    return std.fmt.bufPrint(buf, "{d}", .{id});
}

/// The listing-shaped `EntryVO` fields an upload returns (same as `rename`).
const UploadedBody = struct {
    kind: []const u8,
    id: []const u8,
    name: []const u8,
    fileType: ?[]const u8 = null,
    fileHash: ?[]const u8 = null,
};

test "web upload: stores the blob, links the row, charges quota, bumps syncVersion, and answers a listing-shaped entry" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const dir = try f.files.createFolder(admin, null, "Papers");
    defer gpa.free(dir.name);

    const bytes = "%PDF-1.7\n… pretend pdf bytes …\r\n--not-a-boundary\x00\xff";
    const md5 = blobstore.md5HexOf(bytes);
    const v0 = try f.files.syncVersion(admin);

    var dbuf: [24]u8 = undefined;
    var file_id: u64 = undefined;
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, try destOf(&dbuf, dir.id), "Ozymandias.pdf", bytes);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("note", p.value.kind); // the listing's file kind
        try std.testing.expectEqualStrings("Ozymandias.pdf", p.value.name);
        try std.testing.expectEqualStrings("pdf", p.value.fileType.?);
        try std.testing.expectEqualStrings(&md5, p.value.fileHash.?);
        file_id = try std.fmt.parseInt(u64, p.value.id, 10);
    }

    try std.testing.expect(f.files.blobs.has(&md5));

    {
        const entry = (try f.files.get(admin, file_id)).?;
        defer gpa.free(entry.name);
        defer if (entry.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("Ozymandias.pdf", entry.name);
        try std.testing.expect(!entry.is_folder);
        try std.testing.expectEqual(dir.id, entry.parent_id.?);
        try std.testing.expectEqual(@as(u64, bytes.len), entry.size);
        try std.testing.expectEqualStrings(&md5, entry.md5.?);
    }
    try std.testing.expectEqual(@as(i64, @intCast(bytes.len)), try usedBytes(f, admin));
    try std.testing.expect(try f.files.syncVersion(admin) > v0);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/tree?parent={d}", .{dir.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Ozymandias.pdf") != null);
    }

    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "loose.epub", "EPUB at the root");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        const at_root = (try f.files.get(admin, try std.fmt.parseInt(u64, p.value.id, 10))).?;
        defer gpa.free(at_root.name);
        defer if (at_root.md5) |m| gpa.free(m);
        try std.testing.expect(at_root.parent_id == null);
    }
}

test "web upload: identical bytes dedup onto one blob and charge zero extra quota" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "the very same bytes, twice";
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "first.pdf", bytes);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    const after_first = try usedBytes(f, admin);
    try std.testing.expectEqual(@as(i64, @intCast(bytes.len)), after_first);

    // Quota is per distinct blob per user: same content, new name, no charge.
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "second.pdf", bytes);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqual(after_first, try usedBytes(f, admin));
}

test "web upload: a name collision auto-renames instead of replacing the file already there" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const first = try putSeed(f, admin, null, "notes.pdf", "the occupant's bytes");

    // A device re-upload replaces (new version); a browser drop takes " (n)".
    const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "notes.pdf", "a completely different document");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("notes (2).pdf", p.value.name);
    try std.testing.expect(try std.fmt.parseInt(u64, p.value.id, 10) != first);

    {
        const kept = (try f.files.get(admin, first)).?;
        defer gpa.free(kept.name);
        defer if (kept.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("notes.pdf", kept.name);
        try std.testing.expectEqualStrings(&blobstore.md5HexOf("the occupant's bytes"), kept.md5.?);
    }
    {
        const third = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "notes.pdf", "yet another document");
        try std.testing.expectEqual(@as(u16, 200), third.status);
        var q = try std.json.parseFromSlice(UploadedBody, gpa, third.body, .{ .ignore_unknown_fields = true });
        defer q.deinit();
        try std.testing.expectEqualStrings("notes (3).pdf", q.value.name);
    }
}

test "web upload: an over-quota file is 413 and leaves the tree and the charge alone" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    {
        var s = try f.db.prepare("INSERT OR REPLACE INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 8);");
        defer s.finalize();
        s.bindInt(1, @intCast(admin));
        _ = try s.step();
    }

    const v0 = try f.files.syncVersion(admin);
    const bytes = "far more than eight bytes of PDF";
    const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "big.pdf", bytes);
    try std.testing.expectEqual(@as(u16, 413), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "QUOTA_EXCEEDED") != null);

    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expectEqual(v0, try f.files.syncVersion(admin));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(bytes)));
    {
        const resp2 = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expect(std.mem.indexOf(u8, resp2.body, "big.pdf") == null);
    }
}

test "web upload: a body past the caller's remaining quota is refused MID-STREAM and stores nothing" {
    // No `upload/apply` on the browser face, so the cap is the remaining quota.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;

    {
        var s = try f.db.prepare("INSERT OR REPLACE INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 8);");
        defer s.finalize();
        s.bindInt(1, @intCast(admin));
        _ = try s.step();
    }

    const v0 = try f.files.syncVersion(admin);
    const payload = try filler(8 + 4 * uploadcap.slack_bytes);
    defer gpa.free(payload);
    const reqbuf = try gpa.alloc(u8, payload.len + 1024);
    defer gpa.free(reqbuf);

    const sent = try uploadFileCounting(ctx, &obuf, reqbuf, &web, "root", "flood.pdf", payload);
    const resp = sent.resp;
    // The browser face answers 413, not the device protocol's 200 envelope.
    try std.testing.expectEqual(@as(u16, 413), resp.status);
    try expectFailure(resp.body, "QUOTA_EXCEEDED");

    // The read count is what distinguishes a capped refusal from a late one.
    try std.testing.expect(sent.consumed < cappedReadCeiling(uploadcap.limitFor(8)));

    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(payload)));
    try std.testing.expectEqual(@as(usize, 0), try blobTempCount(f));
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expectEqual(v0, try f.files.syncVersion(admin));
    {
        const tree = try requestWithCookie(ctx, &obuf, reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expect(std.mem.indexOf(u8, tree.body, "flood.pdf") == null);
    }

    {
        var s = try f.db.prepare("UPDATE capacity SET total_bytes = ?1 WHERE user_id = ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(payload.len * 2));
        s.bindInt(2, @intCast(admin));
        _ = try s.step();
    }
    const ok = try uploadFile(ctx, &obuf, reqbuf, &web, "root", "flood.pdf", payload);
    try std.testing.expectEqual(@as(u16, 200), ok.status);
    try std.testing.expect(f.files.blobs.has(&blobstore.md5HexOf(payload)));
    try std.testing.expectEqual(@as(i64, @intCast(payload.len)), try usedBytes(f, admin));
}

test "web upload: an off-list extension is 415 and an unsafe filename is 400, both before a byte is stored" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "payload the server must never store";
    const md5 = blobstore.md5HexOf(bytes);

    for ([_][]const u8{ "trojan.exe", "vector.svg", "README" }) |name| {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", name, bytes);
        try std.testing.expectEqual(@as(u16, 415), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "UNSUPPORTED_TYPE") != null);
    }
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", ".pdf", bytes);
        try std.testing.expectEqual(@as(u16, 415), resp.status);
    }

    // The multipart parser already strips directory prefixes; these survive it.
    for ([_][]const u8{ "", "..", "..pdf", "a\x00b.pdf", "line\nbreak.pdf", "\xff\xfe.pdf" }) |name| {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", name, bytes);
        try std.testing.expectEqual(@as(u16, 400), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "INVALID_NAME") != null);
    }

    try std.testing.expect(!f.files.blobs.has(&md5));
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));

    // Traversal is neutralised: the file lands under its basename.
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "../../../etc/passwd.txt", "innocent");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("passwd.txt", p.value.name);
        const e = (try f.files.get(admin, try std.fmt.parseInt(u64, p.value.id, 10))).?;
        defer gpa.free(e.name);
        defer if (e.md5) |m| gpa.free(m);
        try std.testing.expect(e.parent_id == null);
    }

    const accepted = [_][]const u8{
        "a.note", "b.SPD", "c.pdf",  "d.EPUB", "e.doc",  "f.docx",
        "g.txt",  "h.PNG", "i.jpg",  "j.jpeg", "k.webp", "l.cbz",
        "m.fb2",  "n.xps", "o.mobi", "p.azw",  "q.AZW3",
    };
    for (accepted, 0..) |name, i| {
        var pbuf: [64]u8 = undefined;
        const payload = try std.fmt.bufPrint(&pbuf, "accepted payload number {d}", .{i});
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", name, payload);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
}

test "web upload: a missing, foreign, non-folder or trashed destination is one indistinguishable 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    var dbuf: [24]u8 = undefined;

    const bobs_dir = try f.files.createFolder(bob, null, "BobsPapers");
    defer gpa.free(bobs_dir.name);
    const a_file = try putSeed(f, admin, null, "not-a-folder.pdf", "just a file");
    const trashed = try f.files.createFolder(admin, null, "Doomed");
    defer gpa.free(trashed.name);
    try f.files.trash(admin, trashed.id);

    const cases = [_]u64{ 999999, bobs_dir.id, a_file, trashed.id };
    for (cases) |dest| {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, try destOf(&dbuf, dest), "drop.pdf", "bytes");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "NOT_FOUND") != null);
    }

    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, bob));
}

test "web upload: requires a control-plane session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const resp = try uploadFile(ctx, &obuf, &reqbuf, repeat(u8, "0", 32), "root", "sneaky.pdf", "bytes");
    try std.testing.expectEqual(@as(u16, 401), resp.status);
}

// ---- web upload: ?onConflict= ----

const UploadHistVersion = struct { md5: []const u8, size: i64, current: bool = false };

test "web upload onConflict=replace: supersedes the same-named file, keeps the row id, and the old bytes stay a restorable version" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const v1 = "the first draft of the paper";
    const v2 = "the SECOND draft, materially different";
    const v1md5 = blobstore.md5HexOf(v1);
    const v2md5 = blobstore.md5HexOf(v2);

    const id = try putSeed(f, admin, null, "paper.pdf", v1);

    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "paper.pdf", v2, "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("paper.pdf", p.value.name); // no " (2)"
        try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.id, 10)); // the SAME row
        try std.testing.expectEqualStrings(&v2md5, p.value.fileHash.?);
    }
    try std.testing.expectEqualSlices(u8, &v2md5, &(try currentFileMd5(f, id)));

    try std.testing.expectEqual(
        @as(i64, 1),
        try countRows(f, "SELECT COUNT(*) FROM files WHERE name = 'paper.pdf' AND deleted = 0;"),
    );

    // The superseded bytes are retained, which is why `replace` is offered.
    try std.testing.expectEqualSlices(u8, &v1md5, &(try soleHistoryMd5(f, id)));
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { id: []const u8, versions: []UploadHistVersion },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.versions.len);
        try std.testing.expect(p.value.versions[0].current);
        try std.testing.expectEqualStrings(&v2md5, p.value.versions[0].md5);
        try std.testing.expect(!p.value.versions[1].current);
        try std.testing.expectEqualStrings(&v1md5, p.value.versions[1].md5);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/restore", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqualSlices(u8, &v1md5, &(try currentFileMd5(f, id)));
}

test "web upload onConflict=replace: with nothing of that name it is just a create" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "nothing to supersede";
    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "fresh.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("fresh.pdf", p.value.name);

    const id = try std.fmt.parseInt(u64, p.value.id, 10);
    try std.testing.expectEqualSlices(u8, &blobstore.md5HexOf(bytes), &(try currentFileMd5(f, id)));
    try std.testing.expectEqual(@as(i64, @intCast(bytes.len)), try usedBytes(f, admin));
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
}

test "web upload: the DEFAULT and an unrecognised onConflict both auto-rename — an old or confused client can never overwrite" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const occupant = "the file already there";
    const id = try putSeed(f, admin, null, "notes.pdf", occupant);

    const queries = [_][]const u8{
        "",
        "?onConflict=",
        "?onConflict=Rename",
        "?onConflict=overwrite",
        "?onConflict=replace%20", // not a literal match, so not a replace
        "?other=replace",
    };
    var expected_suffix: usize = 2;
    for (queries) |q| {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "notes.pdf", "a different document", q);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        var want: [32]u8 = undefined;
        try std.testing.expectEqualStrings(
            try std.fmt.bufPrint(&want, "notes ({d}).pdf", .{expected_suffix}),
            p.value.name,
        );
        expected_suffix += 1;
    }

    {
        const kept = (try f.files.get(admin, id)).?;
        defer gpa.free(kept.name);
        defer if (kept.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("notes.pdf", kept.name);
        try std.testing.expectEqualStrings(&blobstore.md5HexOf(occupant), kept.md5.?);
    }
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
}

test "web upload onConflict=replace: a FOLDER holding the name is still 409, and the folder survives" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    // A file may never supersede a folder, under either mode.
    const dir = try f.files.createFolder(admin, null, "archive.pdf");
    defer gpa.free(dir.name);

    const bytes = "trying to become a folder";
    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "archive.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 409), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "NAME_TAKEN") != null);

    {
        const kept = (try f.files.get(admin, dir.id)).?;
        defer gpa.free(kept.name);
        defer if (kept.md5) |m| gpa.free(m);
        try std.testing.expect(kept.is_folder);
        try std.testing.expectEqualStrings("archive.pdf", kept.name);
    }
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(bytes)));

    {
        const ok = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "archive.pdf", bytes);
        try std.testing.expectEqual(@as(u16, 200), ok.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, ok.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("archive (2).pdf", p.value.name);
    }
}

test "web upload onConflict=replace: quota releases the old charge only when nothing live still holds the blob" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    // Different lengths so the arithmetic can't balance by coincidence.
    const old_bytes = "old bytes";
    const new_bytes = "the replacement bytes, rather longer than the old";
    const old_len: i64 = @intCast(old_bytes.len);
    const new_len: i64 = @intCast(new_bytes.len);

    const solo = try putSeed(f, admin, null, "solo.pdf", old_bytes);
    try std.testing.expectEqual(old_len, try usedBytes(f, admin));
    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "solo.pdf", new_bytes, "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // The old charge stays: the retained version keeps the bytes on disk.
    try std.testing.expectEqual(old_len + new_len, try usedBytes(f, admin));
    try std.testing.expect(f.files.blobs.has(&blobstore.md5HexOf(old_bytes)));
    try std.testing.expectEqualSlices(u8, &blobstore.md5HexOf(old_bytes), &(try soleHistoryMd5(f, solo)));

    // Two rows on one blob cost one charge; replacing one releases nothing.
    const shared_a = try putSeed(f, admin, null, "shared-a.pdf", old_bytes);
    _ = try putSeed(f, admin, null, "shared-b.pdf", old_bytes);
    _ = shared_a;
    const before = try usedBytes(f, admin);
    // Dedup against your own history is still dedup.
    try std.testing.expectEqual(new_len + old_len, before);
    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "shared-a.pdf", "third distinct payload", "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqual(before + @as(i64, "third distinct payload".len), try usedBytes(f, admin));
}

test "ACCOUNT SCREEN: the wire shape the panel is built against, over a real session" {
    // Pins the wire, which the frontend reads field by field.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    _ = try putSeed(f, admin, null, "bujo.note", "notebook bytes v1");
    _ = try putSeed(f, admin, null, "bujo.note", "notebook bytes v2 (edited)");
    _ = try putSeed(f, admin, null, "sketch.spd", "sketch bytes");
    _ = try putSeed(f, admin, null, "lease.pdf", "document bytes");
    const doomed = try putSeed(f, admin, null, "old.pdf", "trashed document bytes");
    try f.files.trash(admin, doomed);

    const AccountBody = struct {
        success: bool,
        email: []const u8,
        name: []const u8,
        isAdmin: bool,
        createdAt: i64,
        passwordChangedAt: ?i64 = null,
        thisSessionSince: ?i64 = null,
        otherBrowsers: i64,
        devices: []const struct {
            equipment_no: []const u8,
            name: []const u8,
            model: ?[]const u8 = null,
            firmware: ?[]const u8 = null,
            active: bool,
            created_at: i64,
            last_seen: ?i64 = null,
        },
        // No `bytes` (the storage route owns it); unknown fields are rejected.
        versions: struct { keep: u32, maxKeep: u32, retainedPerFile: []const u32 },
    };

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(AccountBody, gpa, resp.body, .{ .ignore_unknown_fields = false });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("admin", p.value.email);
        try std.testing.expect(p.value.isAdmin);
        // Only a self-service change stamps this.
        try std.testing.expect(p.value.passwordChangedAt != null);
        try std.testing.expect(p.value.thisSessionSince != null);
        try std.testing.expectEqual(@as(i64, 0), p.value.otherBrowsers);
        try std.testing.expectEqual(@as(usize, 0), p.value.devices.len); // no tablet bound here
        // Default (`history.keep`) and ceiling (`history.max_keep`) differ.
        try std.testing.expectEqual(@as(u32, 5), p.value.versions.keep); // the config default
        try std.testing.expectEqual(@as(u32, 15), p.value.versions.maxKeep); // the config ceiling
        try std.testing.expect(p.value.versions.maxKeep > p.value.versions.keep);
    }

    const StorageBody = struct {
        success: bool,
        used_bytes: i64,
        total_bytes: i64,
        notebooks: i64,
        sketches: i64,
        documents: i64,
        recycle_bin: i64,
        versions: i64,
    };

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account/storage", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(StorageBody, gpa, resp.body, .{ .ignore_unknown_fields = false });
        defer p.deinit();
        const b = p.value;
        try std.testing.expect(b.notebooks > 0);
        try std.testing.expect(b.sketches > 0);
        try std.testing.expect(b.documents > 0);
        try std.testing.expect(b.recycle_bin > 0);
        try std.testing.expect(b.versions > 0);
        // The parts add up to the whole.
        try std.testing.expectEqual(
            b.used_bytes,
            b.notebooks + b.sketches + b.documents + b.recycle_bin + b.versions,
        );
        try std.testing.expectEqual(b.used_bytes, try usedBytes(f, admin));
        try std.testing.expect(b.total_bytes > b.used_bytes);
    }

    // A foreign serial answers like an unknown one.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/account/devices/unlink", &web, "{\"equipmentNo\":\"SN-NOT-MINE\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    // Unlink must actually deactivate the binding, not just answer 200.
    {
        try f.svc.bindDevice(admin, "SN-MINE-1", "My Nomad");
        {
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
            try std.testing.expectEqual(@as(u16, 200), resp.status);
            var p = try std.json.parseFromSlice(AccountBody, gpa, resp.body, .{ .ignore_unknown_fields = false });
            defer p.deinit();
            var found = false;
            for (p.value.devices) |d| {
                if (std.mem.eql(u8, d.equipment_no, "SN-MINE-1")) {
                    found = true;
                    try std.testing.expect(d.active); // bound and live before we touch it
                }
            }
            try std.testing.expect(found);
        }

        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/account/devices/unlink", &web, "{\"equipmentNo\":\"SN-MINE-1\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        // Revoked bindings stay listed, so assert status, not absence.
        const after = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
        var p = try std.json.parseFromSlice(AccountBody, gpa, after.body, .{ .ignore_unknown_fields = false });
        defer p.deinit();
        for (p.value.devices) |d| {
            if (std.mem.eql(u8, d.equipment_no, "SN-MINE-1")) try std.testing.expect(!d.active);
        }
    }

    // Sign out elsewhere keeps this browser signed in.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/account/sign-out-others", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const after = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
        try std.testing.expectEqual(@as(u16, 200), after.status);
    }
}

test "abandoned upload sessions are reclaimed at startup, not left for ever" {
    // Upload failures strand staged blobs for the sweep; assert the sweep
    // actually reclaims them, not merely that it runs.
    const f = try Fixture.init();
    defer f.deinit();
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    _ = admin;

    try f.db.exec(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, blob_md5, created_at) " ++
            "VALUES('stale-inner-name', 1, '/Note', 'abandoned.note', 12, '0123456789abcdef0123456789abcdef', 0);",
    );
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));

    // A day's window, as `transport.run` uses.
    const swept = try f.files.sweepUploadSessions(24 * 60 * 60);
    try std.testing.expectEqual(@as(usize, 1), swept);
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
}

test "bindEquipment WITHOUT a token: accepted only on the strength of a live session for that serial" {
    // The Nomad sends bindEquipment unauthenticated: it fires the call ~9ms
    // after login and stores the token ~6ms later, so name, model and firmware
    // arrive with no x-access-token.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    _ = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const created = try f.svc.createUser(admin, "alice@home", false);
    const alice = created.id;
    // Real first-login flow: a `pending` account could not log a device in.
    _ = try onboardWeb(ctx, "alice@home", created.temp_password.slice(), "alicepw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bind_body =
        "{\"account\":\"alice@home\",\"equipmentNo\":\"SN-NOMAD-9\",\"name\":\"Supernote Nomad 2\"," ++
        "\"totalCapacity\":\"25485312\",\"label\":[\"NOTE/Note\"],\"version\":\"202407\"}";
    const tokenless = [_]Header{.{ .name = "content-type", .value = "application/json" }};

    // No session for that serial: 401, so the body cannot bind a serial to an
    // account you cannot log into.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &tokenless, bind_body), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }

    {
        _ = try deviceLogin(ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN-NOMAD-9");
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &tokenless, bind_body), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
        try std.testing.expect(!(try f.svc.isDeviceBound(alice, "SN-NOMAD-9")));
    }

    {
        _ = try deviceLogin(ctx, &obuf, &reqbuf, "alice@home", "alicepw1", "SN-NOMAD-9");
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &tokenless, bind_body), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(try f.svc.isDeviceBound(alice, "SN-NOMAD-9"));

        const devs = try f.svc.listUserDevices(gpa, alice, alice);
        defer authsvc.Service.freeDevices(gpa, devs);
        try std.testing.expectEqualStrings("Supernote Nomad 2", devs[0].name);
    }
}

test "web upload onConflict=replace: re-uploading identical bytes is a no-op, not a spurious version" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "unchanged content";
    const id = try putSeed(f, admin, null, "same.pdf", bytes);
    const charged = try usedBytes(f, admin);

    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "same.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.id, 10));

    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
    try std.testing.expectEqual(charged, try usedBytes(f, admin));
    try std.testing.expectEqual(
        @as(i64, 1),
        try countRows(f, "SELECT COUNT(*) FROM files WHERE name = 'same.pdf' AND deleted = 0;"),
    );
}

/// A minimal PNG with a 320×240 IHDR, so a `.spd` embedding it gets `thumb_w/h`.
const aspect_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

test "a PDF's tree entry carries its REAL page count and shape, not the 1-page fallback" {
    // A `.pdf` card must report its `page_count`, not the fallback's 1. Three
    // pages, since one would pass either way.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    _ = try putSeed(f, admin, null, "doc.pdf", @embedFile("../pdf/testdata/three-page.pdf"));
    // A `.txt` (`page_count` 0) keeps the fallback.
    _ = try putSeed(f, admin, null, "readme.txt", "plain text");

    var lock: std.Io.Mutex = .init;
    deferredmod.drainNow(gpa, f.db, f.files.blobs, &lock, std.testing.io);

    const Aspect = struct { w: i64, h: i64 };
    const Row = struct { name: []const u8, pageCount: i64 = 0, thumbAspect: ?Aspect = null };

    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(struct { entries: []const Row }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();

    for (p.value.entries) |e| {
        if (std.mem.eql(u8, e.name, "doc.pdf")) {
            try std.testing.expectEqual(@as(i64, 3), e.pageCount);
            try std.testing.expectEqual(@as(i64, 200), e.thumbAspect.?.w);
            try std.testing.expectEqual(@as(i64, 100), e.thumbAspect.?.h);
        } else {
            try std.testing.expectEqualStrings("readme.txt", e.name);
            try std.testing.expectEqual(@as(i64, 1), e.pageCount); // no pages: the fallback stands
        }
    }
}

test "thumbAspect over HTTP: tree and bin serve the aspect fact, and omit it where unknown" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    // A coverless landscape note, a `.spd` with a 320×240 thumbnail, and a text
    // file (shaped client-side, no server aspect).
    const nb = @import("note_builder");
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const wide = try nb.serialize(gpa, .{ .pages = &.{
        .{ .style = "style_white", .orientation = "1090", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
    } });
    defer gpa.free(wide);
    const note_id = try putSeed(f, admin, null, "wide.note", wide);

    const spd = try buildSpdFixture(aspect_png);
    defer gpa.free(spd);
    const spd_id = try putSeed(f, admin, null, "drawing.spd", spd);

    const txt_id = try putSeed(f, admin, null, "readme.txt", "plain text");

    const Aspect = struct { w: i64, h: i64 };
    const Row = struct { name: []const u8, thumbAspect: ?Aspect = null };

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const Row,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 3), p.value.entries.len);
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.name, "wide.note")) {
                try std.testing.expectEqual(@as(i64, 1872), e.thumbAspect.?.w);
                try std.testing.expectEqual(@as(i64, 1404), e.thumbAspect.?.h);
            } else if (std.mem.eql(u8, e.name, "drawing.spd")) {
                try std.testing.expectEqual(@as(i64, 320), e.thumbAspect.?.w);
                try std.testing.expectEqual(@as(i64, 240), e.thumbAspect.?.h);
            } else {
                try std.testing.expectEqualStrings("readme.txt", e.name);
                try std.testing.expect(e.thumbAspect == null);
            }
        }
        // Absent is omitted, never `null`.
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"thumbAspect\":null") == null);
    }

    // Trashed entries still render previews, so the aspect rides bin rows too.
    for ([_]u64{ note_id, spd_id, txt_id }) |id| try f.files.trash(admin, id);
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/bin", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const Row,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 3), p.value.entries.len);
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.name, "wide.note")) {
                try std.testing.expectEqual(@as(i64, 1872), e.thumbAspect.?.w);
                try std.testing.expectEqual(@as(i64, 1404), e.thumbAspect.?.h);
            } else if (std.mem.eql(u8, e.name, "drawing.spd")) {
                try std.testing.expectEqual(@as(i64, 320), e.thumbAspect.?.w);
                try std.testing.expectEqual(@as(i64, 240), e.thumbAspect.?.h);
            } else {
                try std.testing.expect(e.thumbAspect == null);
            }
        }
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"thumbAspect\":null") == null);
    }
}

/// One layer descriptor; the listing's `firstPage.layers` and the metadata's
/// `pages[].layers` must match exactly (one client code path).
const LayerRow = struct {
    slot: []const u8,
    name: []const u8,
    visible: bool,
    isCurrent: bool,
};

fn expectSameLayerRows(want: []const LayerRow, got: []const LayerRow) !void {
    try std.testing.expectEqual(want.len, got.len);
    for (want, got) |w, g| {
        try std.testing.expectEqualStrings(w.slot, g.slot); // record order is the contract
        try std.testing.expectEqualStrings(w.name, g.name);
        try std.testing.expectEqual(w.visible, g.visible);
        try std.testing.expectEqual(w.isCurrent, g.isCurrent);
    }
}

test "layer descriptors over HTTP: tree and bin firstPage carry what /file/metadata reports for page 0" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [32768]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    // A real capture whose page 0 carries a `#`-JSON LAYERINFO panel.
    const layered_id = try putSeed(f, admin, null, "layers.note", @embedFile("layers_edited.note"));

    // A page with no layer records must omit the field.
    const nb = @import("note_builder");
    const bare = try nb.serialize(gpa, .{ .pages = &.{.{ .style = "style_white", .layers = &.{} }} });
    defer gpa.free(bare);
    const bare_id = try putSeed(f, admin, null, "bare.note", bare);

    const Page = struct { index: i64 = 0, layers: ?[]const LayerRow = null };
    const Row = struct { name: []const u8, firstPage: ?Page = null };

    var want_buf: [8]LayerRow = undefined;
    var want_len: usize = 0;
    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{layered_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { pages: []const Page },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        const l0 = p.value.pages[0].layers.?;
        try std.testing.expect(l0.len > 0);
        // Copied out: the parse arena dies with `p`.
        for (l0, 0..) |l, i| {
            want_buf[i] = .{
                .slot = try gpa.dupe(u8, l.slot),
                .name = try gpa.dupe(u8, l.name),
                .visible = l.visible,
                .isCurrent = l.isCurrent,
            };
        }
        want_len = l0.len;
    }
    const want = want_buf[0..want_len];
    defer for (want) |l| {
        gpa.free(l.slot);
        gpa.free(l.name);
    };

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { entries: []const Row },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.entries.len);
        var seen_layered = false;
        var seen_bare = false;
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.name, "layers.note")) {
                seen_layered = true;
                try expectSameLayerRows(want, e.firstPage.?.layers.?);
            } else {
                seen_bare = true;
                try std.testing.expectEqualStrings("bare.note", e.name);
                try std.testing.expect(e.firstPage.?.layers == null);
            }
        }
        try std.testing.expect(seen_layered and seen_bare);
        // Omitted, never `"layers":null` or `[]`.
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"layers\":null") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"layers\":[]") == null);
    }

    // The bin builds `firstPage` through the same `pageRefAt`.
    for ([_]u64{ layered_id, bare_id }) |id| try f.files.trash(admin, id);
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/bin", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { entries: []const Row },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.entries.len);
        var seen_layered = false;
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.name, "layers.note")) {
                seen_layered = true;
                try expectSameLayerRows(want, e.firstPage.?.layers.?);
            } else {
                try std.testing.expect(e.firstPage.?.layers == null);
            }
        }
        try std.testing.expect(seen_layered);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"layers\":null") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"layers\":[]") == null);
    }
}

test "the bin's own read path previews a trashed file that every LIVE route 404s" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;

    const note_id = try seedRecognizedNote(f, admin, "doomed.note", &.{"Zebra"});
    const pic = try putSeedHashed(f, admin, null, "shot.png", "raw bytes");

    var page_hash: [32]u8 = undefined;
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{note_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&page_hash, p.value.pages[0].hash);
    }

    for ([_]u64{ note_id, pic.id }) |id| {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }

    // Live reads 404 (`Files.get` hardcodes `deleted = 0`, deliberately).
    {
        const live = [_][]const u8{
            try std.fmt.bufPrint(pbuf[0..80], "/api/controlplane/file/metadata/{d}", .{note_id}),
            try std.fmt.bufPrint(pbuf[80..160], "/note/{d}/page/0?v={s}", .{ note_id, page_hash[0..] }),
            try std.fmt.bufPrint(pbuf[160..], "/file/{d}?v={s}", .{ pic.id, pic.md5[0..] }),
        };
        for (live) |path| {
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
            try std.testing.expectEqual(@as(u16, 404), resp.status);
        }
    }

    // The bin-scoped twins serve them, so purging is decided while looking.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/metadata/{d}", .{note_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "doomed.note") != null);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/page/0?v={s}", .{ note_id, page_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // Real bytes: trash holds the blob reference.
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/{d}?v={s}", .{ pic.id, pic.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("raw bytes", resp.body);
    }

    // A live id 404s through the bin routes: no second general read path.
    {
        const kept = try putSeedHashed(f, admin, null, "kept.png", "kept bytes");
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/{d}?v={s}", .{ kept.id, kept.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, admin, "Zebra"));
}

test "bin parity phase 1: page-text ovals serve a TRASHED note's current version; live routes 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    // Two versions with words and boxes, then trash: blob, `note_index` and
    // `file_history` are all retained.
    const nb = @import("note_builder");
    const v1_els = [_]nb.ElementSpec{.{ .label = "alpha", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10, .y = 20, .width = 30, .height = 8 } },
    } }};
    const v2_els = [_]nb.ElementSpec{.{ .label = "beta", .words = &.{
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};
    const id = try seedRecognizedElements(f, admin, "trash.note", "N6", &v1_els, false);
    _ = try seedRecognizedElements(f, admin, "trash.note", "N6", &v2_els, false);
    try f.files.trash(admin, id);

    const PageTextBody = struct {
        text: ?[]const u8 = null,
        words: ?[]const struct { text: []const u8 } = null,
    };

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/page/0/text", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null); // raw VO
        var p = try std.json.parseFromSlice(PageTextBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("beta", p.value.text.?); // the CURRENT version's text
        try std.testing.expectEqual(@as(usize, 1), p.value.words.?.len);
        try std.testing.expectEqualStrings("beta", p.value.words.?[0].text);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ id, repeat(u8, "f", 32) });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }

    {
        const live_id = try seedRecognizedNote(f, admin, "live.note", &.{"gamma"});
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/page/0/text", .{live_id});
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }
}

test "bin parity phase 2: view-only version history for a TRASHED note serves each retained version; live-history scope unchanged" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [200]u8 = undefined;

    // A `.note` and a `.spd`, two versions each, both trashed: `file_history`
    // follows a file to the bin.
    const nb = @import("note_builder");
    const v1_els = [_]nb.ElementSpec{.{ .label = "alpha", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10, .y = 20, .width = 30, .height = 8 } },
    } }};
    const v2_els = [_]nb.ElementSpec{.{ .label = "beta", .words = &.{
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};
    const id = try seedRecognizedElements(f, admin, "vh.note", "N6", &v1_els, false);
    _ = try seedRecognizedElements(f, admin, "vh.note", "N6", &v2_els, false);
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    const spd_v1 = "spd-version-one-bytes";
    const spd_v2 = "spd-version-two-bytes-longer";
    const spd_id = try putSeed(f, admin, null, "vh.spd", spd_v1);
    _ = try putSeed(f, admin, null, "vh.spd", spd_v2);
    const spd_v1md5 = try soleHistoryMd5(f, spd_id);

    try f.files.trash(admin, id);
    try f.files.trash(admin, spd_id);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        var p = try std.json.parseFromSlice(struct {
            versions: []const struct { md5: []const u8, pageCount: i64 = 0, current: bool = false },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.versions.len);
        try std.testing.expect(p.value.versions[0].current); // current leads
        try std.testing.expectEqualStrings(&v2md5, p.value.versions[0].md5);
        try std.testing.expect(!p.value.versions[1].current);
        try std.testing.expectEqualStrings(&v1md5, p.value.versions[1].md5);
        try std.testing.expectEqual(@as(i64, 1), p.value.versions[1].pageCount);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/page/0", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]);
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
    }

    const PageTextBody = struct { text: ?[]const u8 = null, words: ?[]const struct { text: []const u8 } = null };
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/page/0/text", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        var p = try std.json.parseFromSlice(PageTextBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("alpha", p.value.text.?); // the RETAINED text
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/page/0/text", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(PageTextBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("beta", p.value.text.?); // the CURRENT text — distinct
    }

    // An md5 not in this file's history is a 404 (`historyVersionIn(.trashed)`).
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/page/0/text", .{ id, repeat(u8, "f", 32) });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/raw", .{ spd_id, spd_v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(spd_v1, resp.body); // v1's EXACT bytes
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
    }

    // The bin history is view-only: no restore twin.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/restore", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status); // no such route
    }

    // A trashed id on live history routes 404s, and a live id on bin history
    // routes 404s.
    {
        const live = [_][]const u8{
            try std.fmt.bufPrint(pbuf[0..90], "/api/controlplane/note/{d}/history", .{id}),
            try std.fmt.bufPrint(pbuf[90..], "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v1md5 }),
        };
        for (live) |path|
            try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }
    {
        const live_id = try seedRecognizedElements(f, admin, "kept.note", "N6", &v1_els, false);
        _ = try seedRecognizedElements(f, admin, "kept.note", "N6", &v2_els, false);
        const live_v1 = try soleHistoryMd5(f, live_id);

        var b1: [100]u8 = undefined;
        const live_hist = try std.fmt.bufPrint(&b1, "/api/controlplane/note/{d}/history", .{live_id});
        try std.testing.expectEqual(@as(u16, 200), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", live_hist, &web, "")).status);

        const bin = [_][]const u8{
            try std.fmt.bufPrint(pbuf[0..90], "/api/controlplane/bin/note/{d}/history", .{live_id}),
            try std.fmt.bufPrint(pbuf[90..], "/api/controlplane/bin/note/{d}/history/{s}/page/0", .{ live_id, live_v1 }),
        };
        for (bin) |path|
            try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }
}

test "bin routes: restore reports the rename and the fanout, purge is the only thing that decrefs and refunds" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const dir = try f.files.createFolder(admin, null, "Dir");
    defer gpa.free(dir.name);
    const sub = try f.files.createFolder(admin, dir.id, "Sub");
    defer gpa.free(sub.name);
    const a = try putSeedHashed(f, admin, sub.id, "a.note", "aaaa");
    const charged = try usedBytes(f, admin);
    try std.testing.expect(charged > 0);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{dir.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }
    // Trash refunds and releases nothing.
    try std.testing.expectEqual(charged, try usedBytes(f, admin));
    try std.testing.expect(f.files.blobs.has(&a.md5));

    // The device recreates the folder, so the restore lands on an occupied name.
    const squatter = try f.files.createFolder(admin, null, "Dir");
    defer gpa.free(squatter.name);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}/restore", .{sub.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            name: []const u8,
            renamed: bool,
            ancestors: i64,
            descendants: i64,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        // `Sub` didn't collide; its ancestor did and was renamed.
        try std.testing.expectEqualStrings("Sub", p.value.name);
        try std.testing.expectEqual(@as(i64, 1), p.value.ancestors);
        try std.testing.expectEqual(@as(i64, 1), p.value.descendants);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Dir (2)") != null);
    }

    // Purge is the only route that reaches `decref`.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{a.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }
    try std.testing.expectEqual(charged, try usedBytes(f, admin)); // still charged
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}", .{a.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
    }
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin)); // refunded HERE
    try std.testing.expect(!f.files.blobs.has(&a.md5)); // and GC'd HERE

    const live = try putSeedHashed(f, admin, null, "live.note", "live");
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}", .{live.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(f.files.blobs.has(&live.md5));
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{live.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", "/api/controlplane/bin", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { success: bool, entries: i64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 1), p.value.entries);
    }
    var parsed = try getBin(ctx, &obuf, &reqbuf, &web);
    defer parsed.deinit();
    try std.testing.expectEqual(@as(usize, 0), parsed.value.entries.len);
    try std.testing.expectEqual(@as(i64, 0), parsed.value.totalBytes);
}

test "bin routes: a foreign id is indistinguishable from a missing one, over a DEDUPLICATED blob" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const alice_new = try f.svc.createUser(admin, "alice", false);
    const alice = alice_new.id;
    const admin_web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const alice_web = try onboardWeb(ctx, "alice", alice_new.temp_password.slice(), "apass111");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [160]u8 = undefined;

    // Both hold the same bytes: one blob at refcount 2 and one shared
    // `note_index` row; only the `files` row records ownership.
    const mine = try putSeedHashed(f, alice, null, "secret.note", "identical bytes");
    const theirs = try putSeedHashed(f, admin, null, "mine.note", "identical bytes");
    try std.testing.expectEqualStrings(&mine.md5, &theirs.md5);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{mine.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &alice_web, "", 200);
    }

    // Alice's id and a missing id must answer identically.
    for ([_]u64{ mine.id, 99999 }) |id| {
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}/restore", .{id});
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", path, &admin_web, "", 404);
        }
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}", .{id});
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_web, "", 404);
        }
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{id});
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_web, "", 404);
        }
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/metadata/{d}", .{id});
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_web, "", 404);
        }
        {
            // Even with the right `?v=` (same md5), the row is not admin's.
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/{d}?v={s}", .{ id, theirs.md5[0..] });
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_web, "", 404);
        }
    }

    var parsed = try getBin(ctx, &obuf, &reqbuf, &alice_web);
    defer parsed.deinit();
    try std.testing.expectEqual(@as(usize, 1), parsed.value.entries.len);
    try std.testing.expectEqualStrings("secret.note", parsed.value.entries[0].name);
    var admin_bin = try getBin(ctx, &obuf, &reqbuf, &admin_web);
    defer admin_bin.deinit();
    try std.testing.expectEqual(@as(usize, 0), admin_bin.value.entries.len);
    try std.testing.expect(f.files.blobs.has(&theirs.md5));
    const still_theirs = (try f.files.get(admin, theirs.id)).?;
    defer gpa.free(still_theirs.name);
    defer if (still_theirs.md5) |m| gpa.free(m);
}

test "the admin console is gated behind re-authentication, with a status the SPA cannot mistake for a dead session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    // `is_admin` alone is not permission. 428, not 401/403, which the SPA maps
    // to "session ended" and a login redirect.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 428), resp.status);
        try std.testing.expect(resp.status != 401);
        try std.testing.expect(resp.status != 403);
        try expectFailure(resp.body, "ELEVATION_REQUIRED");
    }

    // The gate covers every admin route, read-only ones included.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, "{\"email\":\"x\"}", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", "/api/admin/users/1", &admin_tok, "", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users/1/reset", &admin_tok, "", 428);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &admin_tok, "", 200);

    {
        const resp = try tryElevate(ctx, &obuf, &reqbuf, "admin", "not-the-password", &admin_tok);
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 428);

    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 200);

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/lock", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 428);

    // Lock is idempotent and never hits the gate.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/lock", &admin_tok, "", 200);
}

test "elevation: a non-admin's failure is indistinguishable from a wrong password, and a pending session cannot elevate at all" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = try f.svc.createUser(admin, "bob", false);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // A pending session cannot elevate around `must_change_password`.
    var pending_tok: [32]u8 = undefined;
    {
        const code = try getCode(ctx, "bob");
        const hash = challenge(bob.temp_password.slice(), &code);
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"bob\",\"password\":\"{s}\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        @memcpy(&pending_tok, cookieToken(resp.set_cookie.?).?);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/elevate", &pending_tok, "{\"password\":\"x\"}", 403);

    // A non-admin with a correct password gets the wrong-password code: no
    // oracle for who is an admin.
    const bob_tok = try onboardWeb(ctx, "bob", bob.temp_password.slice(), "bobpw123");
    {
        const right = try tryElevate(ctx, &obuf, &reqbuf, "bob", "bobpw123", &bob_tok);
        try expectFailure(right.body, "INVALID_CREDENTIALS");
        const wrong = try tryElevate(ctx, &obuf, &reqbuf, "bob", "definitely-wrong", &bob_tok);
        try expectFailure(wrong.body, "INVALID_CREDENTIALS");
        try std.testing.expectEqual(right.status, wrong.status);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 403);
}

test "elevate is rate-limited per USER, so one housemate's fumbling cannot lock out another on the same IP" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // Two admins, one shared IP (the fixture's `client_ip`).
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const second = try f.svc.createUser(admin, "second", true);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const a_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const b_tok = try onboardWeb(ctx, "second", second.temp_password.slice(), "secondpw1");

    // 5 per 5 minutes: `elevate` is a password oracle.
    var i: usize = 0;
    while (i < 5) : (i += 1) {
        const resp = try tryElevate(ctx, &obuf, &reqbuf, "admin", "wrong-guess", &a_tok);
        try std.testing.expectEqual(@as(u16, 200), resp.status); // allowed through, auth fails
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
    }
    {
        const resp = try tryElevate(ctx, &obuf, &reqbuf, "admin", "wrong-guess", &a_tok);
        try std.testing.expectEqual(@as(u16, 429), resp.status);
    }

    // Keyed by user, not IP: one person's fumbling must not lock out housemates.
    try elevate(ctx, &obuf, &reqbuf, "second", "secondpw1", &b_tok);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &b_tok, "", 200);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &a_tok, "", 200);
}

test "a password reset drops the target's elevation along with their session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const second = try f.svc.createUser(admin, "second", true);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const a_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const b_tok = try onboardWeb(ctx, "second", second.temp_password.slice(), "secondpw1");

    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &a_tok);
    try elevate(ctx, &obuf, &reqbuf, "second", "secondpw1", &b_tok);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &b_tok, "", 200);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/reset", .{second.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &a_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    // Elevation lived on the revoked session row; 401, not 428.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &b_tok, "", 401);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &b_tok, "", 401);
}

test "admin activity slides the elevation window; ordinary browsing does not" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    // Idle deadline nearly expired, ceiling far away, so a renewal is visible.
    const nearly = std.Io.Clock.real.now(std.testing.io).toSeconds() + 5;
    {
        var s = try f.db.prepare("UPDATE sessions SET elevated_until = ?1 WHERE token_hash = ?2;");
        defer s.finalize();
        s.bindInt(1, nearly);
        s.bindText(2, &password.hashToken(&admin_tok)); // rows are keyed by sha256(token)
        _ = try s.step();
    }

    // Ordinary control-plane traffic does not renew elevation.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &admin_tok, "", 200);
    try std.testing.expectEqual(nearly, elevatedUntil(&f.db, &admin_tok).?);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 200);
    try std.testing.expect(elevatedUntil(&f.db, &admin_tok).? > nearly);

    // Renewal only extends a live elevation, so it is safe before authorization.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/lock", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 428);
    try std.testing.expect(elevatedUntil(&f.db, &admin_tok) == null); // the failed request did not revive it
}

fn elevatedUntil(db: *sqlite.Db, token: []const u8) ?i64 {
    var r = (db.row("SELECT elevated_until FROM sessions WHERE token_hash = ?1;", &.{.{ .text = &password.hashToken(token) }}) catch return null) orelse return null;
    defer r.finalize();
    return r.intOpt(0);
}

test "server-info: public, reports the LAN address, and firstRun flips once onboarding completes" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "temp0000"); // the sole account, must_change_password = 1

    var obuf: [2048]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const Info = struct { address: []const u8, firstRun: bool };

    // Unauthenticated: the login page reads this pre-auth.
    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/server-info", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        var p = try std.json.parseFromSlice(Info, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.firstRun);
        // `address` is "host:port"; the host depends on the box, so assert shape.
        try std.testing.expect(p.value.address.len != 0);
        try std.testing.expect(std.mem.indexOfScalar(u8, p.value.address, ':') != null);
        try std.testing.expect(std.mem.endsWith(u8, p.value.address, ":8089"));
    }

    _ = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/server-info", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        var p = try std.json.parseFromSlice(Info, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(!p.value.firstRun);
        try std.testing.expect(p.value.address.len != 0);
    }
}

// ---- the reader pool ----
// Synthetic route tables: the dispatch policy of `read_only` is under test,
// not the real table's classification.

/// A read-only handler through `ctx.files`, so pooled dispatch runs end to end.
fn poolReadHandler(ctx: *Context, req: *router.Request, _: router.Params) anyerror!void {
    const files = ctx.files.?;
    _ = files.syncVersion(1) catch return serverErrorish(req);
    try req.respond("{\"success\":true}", .{ .status = .ok });
}

fn serverErrorish(req: *router.Request) anyerror!void {
    try req.respond("{\"success\":false}", .{ .status = .internal_server_error });
}

test "a read_only route runs on a pooled reader and a plain route does not, and the histogram says which" {
    // A pooled read takes no `db_lock`, so without the reader window it would
    // vanish from the per-route histogram.
    const f = try Fixture.initPooled(2);
    defer f.deinit();

    const table = [_]router.Route{
        .{ .method = .GET, .path = "/pooled", .scopes = &.{.public}, .handler = poolReadHandler, .read_only = true },
        .{ .method = .GET, .path = "/locked", .scopes = &.{.public}, .handler = poolReadHandler },
    };

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    for ([_][]const u8{ "/pooled", "/locked" }) |path| {
        var in = std.Io.Reader.fixed(try buildRequest(&reqbuf, "GET", path, &.{}, ""));
        var out = std.Io.Writer.fixed(&obuf);
        var server = std.http.Server.init(&in, &out);
        var req = try server.receiveHead();
        try transport.handle(&f.ctx, &table, &req);
        try std.testing.expectEqual(@as(u16, 200), (try parseResponse(obuf[0..out.end])).status);
    }

    const pooled = f.slotFor(&table, "/pooled");
    const locked = f.slotFor(&table, "/locked");

    try std.testing.expect(pooled.count > 0);
    try std.testing.expectEqual(@as(u64, 1), pooled.read_count);
    try std.testing.expectEqual(@as(u64, 0), pooled.fallback_count);
    try std.testing.expect(pooled.read_total_s > 0 or pooled.read_total_ns_rem > 0);

    try std.testing.expect(locked.count > 0);
    try std.testing.expectEqual(@as(u64, 0), locked.read_count);

    // `totals` counts only real lock hold time; reader windows are subtracted.
    const t = f.stats.totals();
    try std.testing.expect(t.count > 0);
    try std.testing.expect(t.total_ns < nsOfSlot(pooled) + nsOfSlot(locked) + std.time.ns_per_s);

    // A leaked lease starves the pool into permanent fallback.
    try std.testing.expectEqual(@as(usize, 2), f.pool.?.available());
}

test "a read_only route falls back to the write lock when every reader is busy, and says so" {
    // Exhaustion degrades to the writer under `db_lock`: never a wait or a 503.
    const f = try Fixture.initPooled(1);
    defer f.deinit();

    const table = [_]router.Route{
        .{ .method = .GET, .path = "/pooled", .scopes = &.{.public}, .handler = poolReadHandler, .read_only = true },
    };

    const held = f.pool.?.acquire().?;
    try std.testing.expect(f.pool.?.acquire() == null);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var in = std.Io.Reader.fixed(try buildRequest(&reqbuf, "GET", "/pooled", &.{}, ""));
    var out = std.Io.Writer.fixed(&obuf);
    var server = std.http.Server.init(&in, &out);
    var req = try server.receiveHead();
    try transport.handle(&f.ctx, &table, &req);

    try std.testing.expectEqual(@as(u16, 200), (try parseResponse(obuf[0..out.end])).status);
    const s = f.slotFor(&table, "/pooled");
    try std.testing.expectEqual(@as(u64, 1), s.fallback_count);
    try std.testing.expectEqual(@as(u64, 0), s.read_count);
    try std.testing.expect(s.count > 0); // recorded as an ordinary lock window

    f.pool.?.release(held);
    try std.testing.expect(f.db_lock.tryLock());
    f.db_lock.unlock(std.testing.io);
}

test "a pool of zero is the server without a pool: every read falls back and nothing breaks" {
    const f = try Fixture.initPooled(0);
    defer f.deinit();
    const table = [_]router.Route{
        .{ .method = .GET, .path = "/pooled", .scopes = &.{.public}, .handler = poolReadHandler, .read_only = true },
    };
    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var in = std.Io.Reader.fixed(try buildRequest(&reqbuf, "GET", "/pooled", &.{}, ""));
    var out = std.Io.Writer.fixed(&obuf);
    var server = std.http.Server.init(&in, &out);
    var req = try server.receiveHead();
    try transport.handle(&f.ctx, &table, &req);
    try std.testing.expectEqual(@as(u16, 200), (try parseResponse(obuf[0..out.end])).status);
    try std.testing.expectEqual(@as(u64, 1), f.slotFor(&table, "/pooled").fallback_count);
}

/// The handler announces it is inside, then parks until released.
const SlowRead = struct {
    var inside: std.atomic.Value(bool) = .init(false);
    var let_go: std.atomic.Value(bool) = .init(false);

    fn reset() void {
        inside.store(false, .seq_cst);
        let_go.store(false, .seq_cst);
    }

    fn handler(ctx: *Context, req: *router.Request, _: router.Params) anyerror!void {
        _ = ctx.files.?.syncVersion(1) catch {};
        inside.store(true, .seq_cst);
        while (!let_go.load(.seq_cst)) std.Thread.yield() catch {};
        try req.respond("{\"success\":true}", .{ .status = .ok });
    }

    fn drive(ctx: *Context, table: []const router.Route) void {
        var obuf: [4096]u8 = undefined;
        var reqbuf: [1024]u8 = undefined;
        const bytes = buildRequest(&reqbuf, "GET", table[0].path, &.{}, "") catch return;
        var in = std.Io.Reader.fixed(bytes);
        var out = std.Io.Writer.fixed(&obuf);
        var server = std.http.Server.init(&in, &out);
        var req = server.receiveHead() catch return;
        transport.handle(ctx, table, &req) catch {};
    }
};

test "a long-running READ does not block a concurrent WRITE, which is the entire point of the pool" {
    // Mid-read on a `read_only` route, `db_lock` is free and a write completes.
    // The reader parks inside the handler, so this is deterministic.
    const f = try Fixture.initPooled(2);
    defer f.deinit();

    const pooled = [_]router.Route{
        .{ .method = .GET, .path = "/slow-read", .scopes = &.{.public}, .handler = SlowRead.handler, .read_only = true },
    };
    SlowRead.reset();
    var ctx_copy = f.ctx; // a connection thread gets its own Context, as in serve mode
    const t = try std.Thread.spawn(.{}, SlowRead.drive, .{ &ctx_copy, @as([]const router.Route, &pooled) });
    while (!SlowRead.inside.load(.seq_cst)) std.Thread.yield() catch {};

    try std.testing.expect(f.db_lock.tryLock());
    try f.db.exec("INSERT INTO users(id, email, password_md5, cred_enc, is_admin, created_at) VALUES(42,'w@h','','',0,0);");
    f.db_lock.unlock(std.testing.io);

    SlowRead.let_go.store(true, .seq_cst);
    t.join();

    var r = (try f.db.row("SELECT COUNT(*) FROM users WHERE id = 42;", &.{})).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 1), r.int(0));
}

test "the SAME handler without read_only DOES block the write, which is what the flag changes" {
    // The control: same handler and moment, without the flag.
    const f = try Fixture.initPooled(2);
    defer f.deinit();

    const locked = [_]router.Route{
        .{ .method = .GET, .path = "/slow-read", .scopes = &.{.public}, .handler = SlowRead.handler },
    };
    SlowRead.reset();
    var ctx_copy = f.ctx;
    const t = try std.Thread.spawn(.{}, SlowRead.drive, .{ &ctx_copy, @as([]const router.Route, &locked) });
    while (!SlowRead.inside.load(.seq_cst)) std.Thread.yield() catch {};

    try std.testing.expect(!f.db_lock.tryLock());

    SlowRead.let_go.store(true, .seq_cst);
    t.join();
    try std.testing.expect(f.db_lock.tryLock()); // and released afterwards
    f.db_lock.unlock(std.testing.io);
}

test "an SSE stream borrows no reader, so eight open tabs cannot exhaust the pool" {
    // A stream borrowing for its lifetime would starve reads. The route is
    // `manual_db_lock` (`router.readOnlyConflict` forbids combining it with
    // `read_only`), and dispatch borrows per operation.
    const f = try Fixture.initPooled(2);
    defer f.deinit();
    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    _ = admin;
    const tok = try onboardWeb(&f.ctx, "admin", "temp0000", "adminpw1");

    for (app.routes) |r| {
        if (std.mem.eql(u8, r.path, "/api/controlplane/events")) {
            try std.testing.expect(!r.read_only);
            try std.testing.expect(r.manual_db_lock);
        }
    }

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const resp = try requestWithCookie(&f.ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    try std.testing.expectEqual(@as(usize, 2), f.pool.?.available());
}

// ---- the read_only audit ----
// A wrongly flagged route runs writes on a connection that refuses them. Two
// checks: on a real reader (`SQLITE_READONLY` surfaces as 5xx), and on the
// writer with a row-mutation hook, which catches writes hidden by `catch {}`
// (like `ControlPlaneService`'s lazy index backfill). Every flagged route
// needs a probe.

/// A request reaching a `read_only` handler; `route` is the declared path.
const ReadOnlyProbe = struct {
    route: []const u8,
    path: []const u8,
    method: []const u8,
    body: []const u8 = "",
    face: enum { none, device, web } = .none,
};

/// Drives every probe; none may 5xx (a 404 is fine).
fn driveReadOnlyProbes(f: *Fixture, probes: []const ReadOnlyProbe, web_tok: []const u8, dev_tok: []const u8) !void {
    var obuf: [1 << 16]u8 = undefined;
    var reqbuf: [4096]u8 = undefined;
    for (probes) |p| {
        var cookie_buf: [128]u8 = undefined;
        const headers: []const Header = switch (p.face) {
            .none => &.{.{ .name = "content-type", .value = "application/json" }},
            .web => &.{
                .{ .name = "content-type", .value = "application/json" },
                .{ .name = "cookie", .value = try std.fmt.bufPrint(&cookie_buf, "{s}={s}", .{ context.session_cookie_name, web_tok }) },
            },
            .device => &.{
                .{ .name = "content-type", .value = "application/json" },
                .{ .name = "x-access-token", .value = dev_tok },
                .{ .name = "equipmentno", .value = "SN-AUDIT" },
            },
        };
        const req = try buildRequest(&reqbuf, p.method, p.path, headers, p.body);
        const resp = try roundtrip(&f.ctx, req, &obuf);
        if (resp.status >= 500) {
            std.debug.print("read_only route {s} {s} answered {d}: {s}\n", .{ p.method, p.path, resp.status, resp.body });
            return error.ReadOnlyRouteFailed;
        }
    }
}

fn readOnlyProbes(a: std.mem.Allocator, note_id: u64) ![]const ReadOnlyProbe {
    var out: std.ArrayList(ReadOnlyProbe) = .empty;
    const fixed = [_]ReadOnlyProbe{
        .{ .route = "/api/version", .path = "/api/version", .method = "GET" },
        .{ .route = "/api/file/query/server", .path = "/api/file/query/server", .method = "GET" },
        .{ .route = "/api/controlplane/usage", .path = "/api/controlplane/usage", .method = "GET", .face = .web },
        .{ .route = "/api/controlplane/account/storage", .path = "/api/controlplane/account/storage", .method = "GET", .face = .web },
        .{ .route = "/api/user/query", .path = "/api/user/query", .method = "POST", .body = "{}", .face = .device },
        .{ .route = "/api/equipment/bind/status", .path = "/api/equipment/bind/status", .method = "POST", .body = "{}", .face = .device },
        .{ .route = "/api/file/capacity/query", .path = "/api/file/capacity/query", .method = "POST", .body = "{}", .face = .device },
        .{ .route = "/api/file/2/users/get_space_usage", .path = "/api/file/2/users/get_space_usage", .method = "POST", .body = "{}", .face = .device },
        .{ .route = "/api/file/query/summary/hash", .path = "/api/file/query/summary/hash", .method = "POST", .body = "{\"page\":0,\"size\":50}", .face = .device },
        .{ .route = "/api/file/query/summary/group", .path = "/api/file/query/summary/group", .method = "POST", .body = "{\"page\":0,\"size\":50}", .face = .device },
        .{ .route = "/api/file/3/files/query/by/path_v3", .path = "/api/file/3/files/query/by/path_v3", .method = "POST", .body = "{\"path\":\"/audit.note\"}", .face = .device },
        // The manifest never calls `indexRowEnsuring`, so it heals nothing.
        .{ .route = "/api/controlplane/search-index/manifest", .path = "/api/controlplane/search-index/manifest", .method = "GET", .face = .web },
    };
    try out.appendSlice(a, &fixed);

    // Against rows that exist: a probe that 404s early audits nothing.
    try out.append(a, .{
        .route = "/api/file/query/summary/id",
        .path = "/api/file/query/summary/id",
        .method = "POST",
        .body = try std.fmt.allocPrint(a, "{{\"ids\":[{d}]}}", .{note_id}),
        .face = .device,
    });
    try out.append(a, .{
        .route = "/api/file/3/files/query_v3",
        .path = "/api/file/3/files/query_v3",
        .method = "POST",
        .body = try std.fmt.allocPrint(a, "{{\"id\":\"{d}\"}}", .{note_id}),
        .face = .device,
    });
    return out.items;
}

const AuditData = struct {
    web_tok: [32]u8,
    dev_tok: [32]u8,
    note_id: u64,
};

fn seedAuditData(f: *Fixture) !AuditData {
    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const web_tok = try onboardWeb(&f.ctx, "admin", "temp0000", "adminpw1");
    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(&f.ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN-AUDIT");

    const note_id = try seedRecognizedNote(f, admin, "audit.note", &.{"hello"});

    return .{ .web_tok = web_tok, .dev_tok = dev_tok, .note_id = note_id };
}

test "every read_only route has a probe, so the audit grows with the table instead of decaying" {
    // Coverage: every `read_only` route has a probe.
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const probes = try readOnlyProbes(arena.allocator(), 1);

    for (app.routes) |r| {
        if (!r.read_only) continue;
        var covered = false;
        for (probes) |p| {
            if (std.mem.eql(u8, p.route, r.path)) covered = true;
        }
        if (!covered) {
            std.debug.print("read_only route '{s}' has no probe in readOnlyProbes\n", .{r.path});
            return error.UnauditedReadOnlyRoute;
        }
    }

    // And no stale probe names an unflagged route.
    for (probes) |p| {
        var found = false;
        for (app.routes) |r| {
            if (std.mem.eql(u8, p.route, r.path) and r.read_only) found = true;
        }
        if (!found) {
            std.debug.print("probe names '{s}', which is not a read_only route\n", .{p.route});
            return error.StaleReadOnlyProbe;
        }
    }
}

test "every read_only route answers correctly through a genuinely read-only connection" {
    // On a real reader pool: a misclassified write fails here, not in a household.
    const f = try Fixture.initPooled(2);
    defer f.deinit();
    const d = try seedAuditData(f);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const probes = try readOnlyProbes(arena.allocator(), d.note_id);
    try driveReadOnlyProbes(f, probes, &d.web_tok, &d.dev_tok);

    // At least one pooled window was recorded, and every lease came back.
    var pooled: u64 = 0;
    for (&f.stats.slots) |*s| pooled += s.read_count;
    try std.testing.expect(pooled >= probes.len);
    try std.testing.expectEqual(@as(usize, 2), f.pool.?.available());
}

test "no read_only route mutates a row, including through a write whose failure would be swallowed" {
    // On the writer with `sqlite3_update_hook` armed, so a swallowed write is
    // visible. Pool size 0: the hook watches only its own connection.
    const f = try Fixture.initPooled(0);
    defer f.deinit();
    const d = try seedAuditData(f);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const probes = try readOnlyProbes(arena.allocator(), d.note_id);

    var watch: sqlite.WriteWatch = .{ .db = f.db };
    watch.arm();
    defer watch.disarm();
    // One probe at a time, so a failure names the route.
    for (probes) |p| {
        const before = watch.mutations;
        const one = [_]ReadOnlyProbe{p};
        try driveReadOnlyProbes(f, &one, &d.web_tok, &d.dev_tok);
        if (watch.mutations != before) {
            std.debug.print("read_only route '{s}' mutated {d} row(s) (last table: {s})\n", .{ p.route, watch.mutations - before, watch.lastTable() });
            return error.ReadOnlyRouteWrote;
        }
    }
}

test "the read-modify-write routes are NOT read_only, and the default is what protects them" {
    // Read-decide-write routes must hold the write lock across every statement;
    // pinned by name so flagging one is a red test.
    const must_write = [_][]const u8{
        "/api/file/2/files/upload/finish",
        "/api/controlplane/bin/:id", // purge — the only route reaching decref
        "/api/controlplane/bin", // empty bin
        "/api/controlplane/bin/:id/restore",
        "/api/admin/elevate",
        "/api/official/user/account/login/new",
        "/api/official/user/account/login/equipment",
        "/api/official/user/query/random/code",
        "/api/user/password",
        "/api/controlplane/entry/:id",
        "/api/controlplane/entry/:id/rename",
    };
    for (must_write) |path| {
        var seen = false;
        for (app.routes) |r| {
            if (!std.mem.eql(u8, r.path, path)) continue;
            seen = true;
            if (r.read_only) {
                std.debug.print("read-modify-write route '{s} {s}' is flagged read_only\n", .{ @tagName(r.method), r.path });
                return error.WriteRouteMarkedReadOnly;
            }
        }
        try std.testing.expect(seen); // the pin must not silently name a route that no longer exists
    }

    // The default: an undeclared route is slow, never wrong.
    const undeclared: router.Route = .{
        .method = .GET,
        .path = "/x",
        .scopes = &.{.public},
        .handler = poolReadHandler,
    };
    try std.testing.expect(!undeclared.read_only);
}
