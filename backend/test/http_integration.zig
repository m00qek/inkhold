//! HTTP-level integration tests for the auth flow.
//!
//! These drive real requests through the full stack — `std.http.Server` head
//! parsing, `transport.handle` (caller resolution + routing), the handlers in
//! the handlers in `handlers/`, the auth `Service`, and an in-memory SQLite — over an in-memory
//! reader/writer pair (no sockets, no threads). They assert on the response
//! status, JSON body, and Set-Cookie, and chain sessions across requests exactly
//! as a real client would. Only TLS/socket transport is out of scope (that is
//! covered by the manual curl smoke).

const std = @import("std");
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
const notesearch = @import("../services/search/query.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const uploadcap = @import("../handlers/upload_cap.zig");
const eventstreams = @import("../http/event_streams.zig");
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

/// Serialize an HTTP/1.1 request into `buf` and return the written slice.
fn buildRequest(buf: []u8, method: []const u8, path: []const u8, headers: []const Header, body: []const u8) ![]const u8 {
    var w = std.Io.Writer.fixed(buf);
    try w.print("{s} {s} HTTP/1.1\r\n", .{ method, path });
    try w.writeAll("host: test\r\n");
    for (headers) |h| try w.print("{s}: {s}\r\n", .{ h.name, h.value });
    try w.print("content-length: {d}\r\n\r\n", .{body.len});
    try w.writeAll(body);
    return buf[0..w.end];
}

/// Run one request end-to-end through the real transport + router + handlers.
fn roundtrip(ctx: *Context, req_bytes: []const u8, out_buf: []u8) !Response {
    var in = std.Io.Reader.fixed(req_bytes);
    var out = std.Io.Writer.fixed(out_buf);
    var server = std.http.Server.init(&in, &out);
    var req = try server.receiveHead();
    try transport.handle(ctx, &app.routes, &req);
    return parseResponse(out_buf[0..out.end]);
}

/// `roundtrip` plus HOW MUCH OF THE REQUEST THE SERVER READ.
///
/// The ingest cap is a claim about *where a body stops*, and the end state of a
/// refusal-during-ingest is indistinguishable from the end state of the old
/// refusal-after-ingest: both answer QUOTA_EXCEEDED, publish no blob, charge
/// nothing and leave no row. The only observable difference is that the capped
/// one never read the rest of the body — which is the entire point, because the
/// bytes it did not read are the bytes it did not write to disk. So the tests
/// assert on this number, not merely on the aftermath.
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

/// What a client computes for the login password field: `sha256_hex(md5_hex(pw) +
/// randomCode)` over the FULL challenge nonce.
fn challenge(pw: []const u8, code: []const u8) [password.sha256_len]u8 {
    return password.challengeHash(&password.md5Hex(pw), code);
}

/// Fetch a random code for `account` and return it copied into an owned array
/// (the response buffer is reused by the next request). Sized to the server's
/// `code_len`, so a nonce-length bump needs no edit here.
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

/// Logs `account` in with its temp password, changes to `final_pw`, and returns
/// the resulting full **web** session token (32 hex chars) — as a browser would.
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

    // `currentPassword` is sent even though a first-login `pending` caller is not
    // required to: `temp` genuinely IS the current credential here, and some
    // callers of this helper are already past their forced change (so they log in
    // control-plane, where it IS required). One truthful body serves both.
    const new_md5 = password.md5Hex(final_pw);
    const cur_md5 = password.md5Hex(temp);
    const change_body = try std.fmt.allocPrint(gpa, "{{\"currentPassword\":\"{s}\",\"newPassword\":\"{s}\"}}", .{ cur_md5[0..], new_md5[0..] });
    defer gpa.free(change_body);
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/user/password", &pending, change_body);
    var web: [32]u8 = undefined;
    @memcpy(&web, cookieToken(resp.set_cookie.?).?);
    return web;
}

/// POST /api/admin/elevate for `tok`, re-authenticating through the SAME
/// challenge flow login uses: fetch a random code, send
/// `sha256(md5(pw) + code)`. Returns the raw response so failure cases can
/// assert on it.
fn tryElevate(ctx: *Context, obuf: []u8, reqbuf: []u8, account: []const u8, pw: []const u8, tok: []const u8) !Response {
    const code = try getCode(ctx, account);
    const hash = challenge(pw, &code);
    const body = try std.fmt.allocPrint(gpa, "{{\"password\":\"{s}\"}}", .{hash[0..]});
    defer gpa.free(body);
    return requestWithCookie(ctx, obuf, reqbuf, "POST", "/api/admin/elevate", tok, body);
}

/// `tryElevate`, asserting it succeeded — for the many tests that only need an
/// admin session that can actually reach the console.
fn elevate(ctx: *Context, obuf: []u8, reqbuf: []u8, account: []const u8, pw: []const u8, tok: []const u8) !void {
    const resp = try tryElevate(ctx, obuf, reqbuf, account, pw, tok);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
}

/// A ready-to-use test context (in-memory DB, migrated, service wired in).
const Fixture = struct {
    db: sqlite.Db,
    svc: authsvc.Service,
    limiter: ratelimit.Limiter,
    dltokens: dltokensmod.DownloadTokens,
    files: filesmod.Files,
    tmp: std.testing.TmpDir,
    ctx: Context,
    /// Set only by `initPooled`. A reader pool needs a database FILE — a second
    /// connection to `:memory:` opens a different, empty database — so the pooled
    /// fixture is on disk while the default one stays in memory.
    path_buf: [128]u8 = undefined,
    pool: ?readerpool.Pool = null,
    db_lock: std.Io.Mutex = .init,
    stats: lockstats.LockStats = .{},

    fn init() !*Fixture {
        return initWith(false, readerpool.default_size);
    }

    /// The fixture the reader pool needs: an on-disk database, a real `db_lock`,
    /// the per-route histogram, and `readers` of the requested size. `readers = 0`
    /// is the "pool always empty" case, i.e. the server this change replaced.
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
            const path = try std.fmt.bufPrintZ(&f.path_buf, ".zig-cache/tmp/{s}/inkhold.db", .{f.tmp.sub_path});
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
            // Only the pooled fixture runs with a real lock and a stats table:
            // the in-memory one is what almost every test here uses, and giving
            // it a lock would change the path they exercise.
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
        // Readers before the writer: they coordinate through the `-shm` file the
        // writer keeps alive, which is the same order `app.run` gets from its
        // defers.
        if (f.pool) |*p| p.close(gpa);
        f.db.close();
        f.tmp.cleanup();
        gpa.destroy(f);
    }

    /// The histogram slot for `path` in `table`. Tests assert on windows, so they
    /// need the same route index dispatch attributes them to.
    fn slotFor(f: *Fixture, table: []const router.Route, path: []const u8) *const lockstats.Slot {
        for (table, 0..) |r, i| {
            if (std.mem.eql(u8, r.path, path)) return &f.stats.slots[i];
        }
        unreachable;
    }
};

/// A slot's carried (seconds, remainder) total as plain nanoseconds — the pair
/// exists because ARMv6 has no 64-bit atomic, not because callers care.
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

    // random code + control-plane login (no equipmentNo) -> a pending session in a cookie.
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

    // The pending cookie cannot reach a normal web route.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &pending_tok, "{\"equipmentNo\":\"X\"}", 403);

    // Change the password: revokes all sessions, returns a fresh control-plane session cookie.
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

    // Old pending token is dead now -> 401 on a protected route.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &pending_tok, "{\"equipmentNo\":\"X\"}", 401);

    // The fresh web token works on a web route (idempotent unlink -> 200).
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &web_tok, "{\"equipmentNo\":\"X\"}", 200);

    // Logout deletes it; afterwards it is rejected.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/user/logout", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.set_cookie.?, "Max-Age=0") != null);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &web_tok, "{\"equipmentNo\":\"X\"}", 401);
}

// ---- self-service password change ----
//
// The endpoint was built for the FORCED first-login change, where a `pending`
// token is the proof of identity, and it took the new password and nothing else.
// From a live session that is wrong: a session outlives a password prompt (a
// borrowed laptop, an unlocked screen), so it must demand and CHECK the current
// password. The split these tests pin:
//
//   POLICY (handler)   — a `controlplane` caller MUST send `currentPassword`.
//   MECHANISM (service)— whenever one IS sent it is verified, for ANY audience.
//
// Together those mean the check cannot be dodged by choosing a caller.

/// Log `account` in over HTTP with a password it already owns (no forced change
/// pending) and return the control-plane session token. Unlike `onboardWeb` this
/// spends no `PUT /api/user/password` budget, so the rate-limit test can start
/// from a full bucket.
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

/// A `PUT /api/user/password` body. `current` null omits the field entirely —
/// which is what a first-login client sends, and what a control-plane one must
/// not get away with.
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

/// `users.password_changed_at`, the "last changed" stamp the account screen reads.
fn passwordChangedAt(f: *Fixture, user_id: u64) !?i64 {
    var r = (try f.db.row("SELECT password_changed_at FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return error.NoSuchUser;
    defer r.finalize();
    return r.intOpt(0);
}

test "CHANGE PASSWORD: a WRONG current password is refused and leaves every session standing" {
    // THE ORDERING TEST, and the reason this feature exists at all (§1: a beta
    // tester locked themselves out). Verification happens BEFORE the UPDATE,
    // before `revokeAllSessions` and before `issueSession` — so a typo costs a
    // typo, not every session the person holds. Move the check below
    // `revokeAllSessions` and this test goes red on the line after the refusal.
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
    // No session was minted, so no cookie was handed back either.
    try std.testing.expect(resp.set_cookie == null);

    // THE DURABLE FACT: the session that made the mistake still resolves, and so
    // does the other browser. Not "the response said no" — that is the momentary
    // half, and a refusal issued AFTER the revocation would satisfy it perfectly.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &desk, "", 200);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &phone, "", 200);

    // And nothing about the credential moved: the old password still logs in, the
    // one that was never accepted does not, and the stamp did not advance.
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

    // Backdate the stamp so "it moved" is a fact and not a coincidence of a suite
    // that finishes inside one second.
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

    // The browser that asked gets a NEW session; the one that asked with the old
    // token, and every other browser, is signed out. The screen has to say this.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &fresh, "", 200);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &desk, "", 401);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &phone, "", 401);
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM sessions;"));

    // The credential really changed, and the account screen's "last changed" line
    // moved off the backdate.
    const stamp = (try passwordChangedAt(f, admin)) orelse return error.StampMissing;
    try std.testing.expect(stamp > 0);
    _ = try webLogin(ctx, "admin", "adminpw2");
}

test "CHANGE PASSWORD: a control-plane caller that OMITS the current password is refused" {
    // POLICY, not mechanism: there is nothing wrong with the body except that it
    // does not prove anything, and a live session is not proof enough. Answered
    // with the same code a wrong one gets — "you did not prove the current
    // password" is one outcome, not two.
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

    // Refused, not "refused after the damage": the session lives and the
    // credential is untouched.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &desk, "", 200);
    try std.testing.expectEqual(stamp_before, try passwordChangedAt(f, admin));
    _ = try webLogin(ctx, "admin", "adminpw1");
}

test "CHANGE PASSWORD: a first-login PENDING caller needs no current password — but a wrong one still refuses it" {
    // Both halves of the split, on the one caller that shows the difference.
    // Onboarding must keep working with no current password at all; and the
    // mechanism still applies to a `pending` caller that supplies one, so the
    // check cannot be dodged by picking the audience that is not required to send
    // it.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = try f.svc.createUser(admin, "bob", false);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // Bob's first login: a `pending` token, which can reach this route and
    // nothing else.
    const pending = try webLogin(ctx, "bob", bob.temp_password.slice());

    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &pending, "guessing", "bobpass1");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
        try std.testing.expect(resp.set_cookie == null);
    }
    // The half-onboarded person is not stranded by their own typo: the pending
    // token still resolves and can try again.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &pending, "", 200);
    try std.testing.expectEqual(@as(?i64, null), try passwordChangedAt(f, bob.id));

    // And with no current password at all — the body a first-login client sends —
    // it goes through.
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
    // The moment the route verifies, it answers "was that the password?" — and it
    // is reachable from any signed-in window. 5 per 5 minutes per ACCOUNT.
    // Deliberately by USER and not by IP: a household shares one address, and
    // IP-keying would let one person's fumbling block a housemate mid-way through
    // their own FORCED first-login change, the one screen they cannot go around.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    // Provisioned at the service layer so both start with a FULL bucket — an
    // onboarding round trip would have spent a token on this very route.
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
    // Even the RIGHT password is now refused — the limit is on the route, not on
    // being wrong.
    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &a_tok, "alicepw1", "newpw123");
        try std.testing.expectEqual(@as(u16, 429), resp.status);
    }

    // Same IP (the fixture has exactly one), different account: Bob sails through.
    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &b_tok, "bobpw111", "bobpw222");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
    }
    // And Alice is rate-limited, not locked out: her ordinary session still works.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &a_tok, "", 200);
}

test "device login returns a body token, binds, and cannot cross into the control-plane face" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // Arrange an onboarded (non-must-change) user directly at the service layer.
    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111")); // clears must_change

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // Device login: equipmentNo present -> token in the body, isBindEquipment "N".
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

    // Bind the device using its x-access-token.
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

    // Cross-face: a device token hitting a web route is forbidden.
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

    // App login: `equipment:2` (a JSON INT), NO `equipmentNo` — the discriminator is
    // the self-declared face, not the serial. Expect a DEVICE session: token in the
    // body, `isBind:"Y"`, `isBindEquipment:"N"` (no serial supplied at login), and no
    // cookie.
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

    // The app carries its ANDROID-… serial per-request. A device route that a
    // control-plane token gets 403 on now succeeds, and the lazy auto-bind
    // registers the serial against the account (it never calls bindEquipment).
    const app_eno = "ANDROID-c0c59ca7-dead-beef";
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"equipmentNo\":\"{s}\"}}", .{app_eno});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/synchronous/start", &app_tok, app_eno, body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expect(try f.svc.isDeviceBound(alice, app_eno)); // auto-bound

    // bind/status -> true once the account holds an active binding.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/equipment/bind/status", &app_tok, app_eno, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { success: bool, bindStatus: bool }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expect(p.value.bindStatus);
    }

    // capacity/query -> the account's used/allotted bytes in the app's envelope.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/capacity/query", &app_tok, app_eno, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { success: bool, usedCapacity: i64, totalCapacity: i64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(authsvc.default_capacity, p.value.totalCapacity);
    }

    // REGRESSION GUARD: a web login (no `equipment`, no `equipmentNo`) still gets a
    // cookie and NO body token — the SPA path must be untouched.
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

    // No random code requested yet -> NO_CHALLENGE.
    {
        const body = "{\"account\":\"admin\",\"password\":\"" ++ ("0" ** 64) ++ "\"}";
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "NO_CHALLENGE");
    }

    // With a code but a wrong password -> INVALID_CREDENTIALS.
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

    // The login route allows 10/min per IP (burst = 10). The first 10 pass the
    // limiter (and fail auth with 200); the 11th is rejected with 429.
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

    // Admin creates a household user. The request carries NO password — the server
    // generates one and hands back the plaintext exactly once.
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
        // Diceware: a variable-length hyphen-joined string, not a fixed 18 hex.
        try std.testing.expect(parsed.value.temporaryPassword.len > 0 and parsed.value.temporaryPassword.len <= password.max_temp_len);
        bob_temp_len = parsed.value.temporaryPassword.len;
        @memcpy(bob_temp_buf[0..bob_temp_len], parsed.value.temporaryPassword);

        // Duplicate email is reported as a failure, not a crash.
        const dup = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, body);
        try expectFailure(dup.body, "EMAIL_EXISTS");
    }

    // Listing shows both accounts.
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

    // The generated password is the real credential: Bob onboards with it.
    // (A non-admin then gets a full control-plane session but is forbidden from
    // admin routes — plainly 403, never the elevation gate, so he learns nothing
    // about there being one.)
    const bob_temp = bob_temp_buf[0..bob_temp_len];
    const bob_tok = try onboardWeb(ctx, "bob", bob_temp, "bobpw123");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 403);

    // Admin resets Bob's password → a NEW server-generated plaintext comes back
    // once, and Bob's session is revoked (401 afterward).
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

    // Admin deletes Bob.
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
    // One buffer PER path: these are held across later requests, and a shared
    // scratch buffer would silently rewrite a path a previous line still points at.
    var devbuf: [96]u8 = undefined;
    var quotabuf: [96]u8 = undefined;
    var pbuf: [96]u8 = undefined;

    const devices_path = try std.fmt.bufPrint(&devbuf, "/api/admin/users/{d}/devices", .{alice});
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");

    // The gate first: an admin whose session is NOT elevated gets 428, on these
    // routes exactly as on the user-management ones — never 401, which would sign
    // them out of the app instead of showing the re-auth prompt.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &admin_tok, "", 428);
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    // Alice's devices — hers only, with the binding date and the soft status.
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

    // **THE CROSS-USER CHECK.** Alice's id, Bob's serial: 404 DEVICE_NOT_FOUND,
    // and Bob's binding is still active afterwards. Without the ownership check in
    // the service this answers 200 and the admin believes it worked.
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-BOB-1\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "DEVICE_NOT_FOUND") != null);
    }
    try std.testing.expectEqual(@as(i64, 1), try f.svc.deviceCount(bob));

    // A serial nobody holds answers IDENTICALLY — same status, same code — so the
    // endpoint cannot be used to probe whether another housemate owns a tablet.
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-NOBODY\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "DEVICE_NOT_FOUND") != null);
    }

    // The right pairing works, and the binding goes inactive rather than away.
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{bob});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-BOB-1\"}", 200);
    }
    try std.testing.expectEqual(@as(i64, 0), try f.svc.deviceCount(bob));

    // Quota: read the default, then lower it BELOW usage. Accepted, and the
    // response reports used > total rather than clamping or deleting.
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
    // An unknown user is a 404 on both halves.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users/9999/quota", &admin_tok, "", 404);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users/9999/devices", &admin_tok, "", 404);

    // And a NON-admin is refused with a plain 403 on every one of them — never the
    // 428 gate, which would tell him an admin console exists behind the refusal.
    const bob_temp = (try f.svc.resetPassword(admin, bob));
    const bob_tok = try onboardWeb(ctx, "bob", bob_temp.slice(), "bobpw123");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &bob_tok, "", 403);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", quota_path, &bob_tok, "", 403);
    {
        // Bob cannot unlink his OWN device through the admin route either: the
        // route is admin-only, and self-service lives at the control-plane unlink.
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
    // Both are `require_admin`, so both sit behind the gate.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/settings/retention", &admin_tok, "", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/health", &admin_tok, "", 428);
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    const Retention = struct { retentionDays: i64, defaultDays: i64, minDays: i64, maxDays: i64, changedAt: i64 };

    // A fresh install reads the compiled default and has never been changed.
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

    // A write round-trips, and `changedAt` is set — it is what starts the grace
    // that keeps a shortened window from purging the bin retroactively.
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

    // The recycle bin quotes the CONFIGURED window, not the constant — otherwise
    // the bin's countdown and the console that set it would disagree.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/bin", &admin_tok, "");
        var p = try std.json.parseFromSlice(struct { retentionDays: i64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 7), p.value.retentionDays);
    }

    // Health: household-wide totals, and NO per-person field of any kind. The
    // absence assertions are the point — a "lastSync"/"noteCount" creeping back in
    // is the surveillance this endpoint was explicitly ruled to exclude.
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

    // Alice owns one blob outright, and shares a second with Bob: identical bytes
    // dedup to ONE blob at refcount 2, which is the case a "delete the departing
    // user's blobs" fix would silently destroy for Bob.
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

    // Alice's sole-owned blob is gone; the shared one is merely decremented, and
    // its bytes are still on disk so Bob's note opens.
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT refcount FROM blobs;"));
    try std.testing.expect(f.files.blobs.has(&shared_md5));

    // Alice's rows are gone entirely, Bob's are untouched.
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

    // Default fixture config keeps history (keep = 5). A first synced upload, then
    // an edit replacing the blob under the SAME path — the sync hot path.
    const dir = try f.files.ensureFolderPath(alice, "NOTE/Note");
    const v1 = "first-version-of-the-note";
    const v2 = "second-version-of-the-note-that-is-a-bit-longer";
    const old_md5 = blobstore.md5HexOf(v1);

    const v1_id = try putSeed(f, alice, dir, "up.note", v1);
    try std.testing.expect(f.files.blobs.has(&old_md5));
    try std.testing.expectEqual(@as(i64, @intCast(v1.len)), try usedBytes(f, alice));

    const v2_id = try putSeed(f, alice, dir, "up.note", v2);
    try std.testing.expectEqual(v1_id, v2_id); // superseded the same file row, not a new one

    // The old version is RETAINED: one history row, and its blob is still on disk
    // (NOT GC'd, unlike prune-on-supersede).
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
    try std.testing.expectEqual(@as(i64, @intCast(v1.len)), try countRows(f, "SELECT size FROM file_history;"));
    try std.testing.expect(f.files.blobs.has(&old_md5));
    // And it is CHARGED. The retained version occupies disk
    // — its blob survives the GC gate on the strength of that history row alone —
    // so the owner pays for it, exactly as they pay for a trashed file. Usage is
    // the current blob PLUS the retained one; the meter used to read only the
    // current, which is precisely the figure that was lying.
    try std.testing.expectEqual(@as(i64, @intCast(v1.len + v2.len)), try usedBytes(f, alice));
    // Two blobs coexist now (current + retained); global search stays current-only
    // (the retained version never re-enters the FTS — the H2 invariant).
    try std.testing.expectEqual(@as(i64, 2), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM segment_search;"));
}

// ---- hot-cache versioning: "history of this file" HTTP endpoints (phases 3-6) ----

/// Seeds a one-page recognized `.note` under `name`, with page `bitmap` and
/// recognized `labels`. Calling it twice with the SAME name makes the second
/// upload SUPERSEDE the first (the sync hot path), retaining v1 in `file_history`.
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

/// Seeds an N-page recognized `.note` under `name` (every page the same `bitmap`
/// + one recognized `label`), superseding any same-named prior upload. Lets a test
/// give a RETAINED version a different page count than the file's current one.
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

/// The single retained-version md5 of `file_id` (the tests supersede exactly once
/// before reading it).
fn soleHistoryMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM file_history WHERE file_id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoHistory;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0)[0..32]);
    return out;
}

/// The blob md5 the live `files` row currently points at.
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
        // Newest first: the CURRENT (v2) leads, flagged; then the retained v1.
        try std.testing.expect(vs[0].current);
        try std.testing.expectEqualStrings(&v2md5, vs[0].md5);
        try std.testing.expect(!vs[1].current);
        try std.testing.expectEqualStrings(&v1md5, vs[1].md5);
    }

    // A foreign / unknown note id is a 404 (not an empty list) — same gate the
    // sibling `/note/{id}` routes use.
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

    // v1 has 3 pages; v2 (the current) supersedes it with 1 page. Their retained
    // `note_page_index` rows differ, so the two versions' page counts must differ.
    const id = try seedRecognizedVersionPages(f, admin, "hist.note", 3, "AAAA", "alpha");
    _ = try seedRecognizedVersionPages(f, admin, "hist.note", 1, "BBBB", "beta");
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    // Cross-check the served counts against the actual indexed rows per md5.
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
    // Newest first: current (v2) has 1 page; retained (v1) has 3 — each its own.
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

    // A `.pdf` — not a page-indexed type, so it has NO `note_page_index` rows
    // (unlike `.txt`/`.spd`, which are paragraph/page-indexed). Superseded once so
    // it also has a retained version. Neither version has a page count → both 0.
    const id = try putSeed(f, admin, null, "scan.pdf", "%PDF-1.4 first revision");
    _ = try putSeed(f, admin, null, "scan.pdf", "%PDF-1.4 second revision");
    // Sanity: this blob genuinely has zero indexed rows.
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

    // A POST carrying NEITHER a Content-Length NOR a Transfer-Encoding — a valid
    // empty-body request (`curl -X POST` with no body sends exactly this). std's
    // `discardBody`, run on the response path to ready the socket for keep-alive,
    // used to assert framing for a body-bearing method and panic the connection
    // thread the instant we responded before reading the (absent) body. The
    // transport drops keep-alive for such a request so the assert is skipped.
    // Without the guard this test does not fail — it CRASHES the whole run.

    // An unmatched path: the not_found responder answers 404.
    const unmatched = "POST /api/controlplane/nope HTTP/1.1\r\nhost: test\r\n\r\n";
    try std.testing.expectEqual(@as(u16, 404), (try roundtrip(ctx, unmatched, &obuf)).status);

    // A real POST route, unauthenticated: the scope gate answers 401 (the exact
    // early-reject-before-body-read path that `restore` newly exposed).
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

    // Distinct page bitmaps, so v1's rendered page bytes differ from v2's.
    const id = try seedRecognizedVersion(f, admin, "hist.note", "AAAA", &.{"alpha"});
    _ = try seedRecognizedVersion(f, admin, "hist.note", "ZZZZZZ", &.{"beta"});
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    // v1's page 0 through the history route — no `?v=` (the md5 pins the content).
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

    // v2's CURRENT page 0 (via note meta → page hash → the live page route), to
    // prove the history route served the OLD bytes, not today's.
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

    // v2's md5 is the CURRENT blob, NOT a `file_history` row → 404 (the current
    // version is never reachable as "history"). A bogus md5 → 404 too.
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
    // Two versions of the SAME file, each with a DIFFERENT recognized word AND a
    // DIFFERENT box. v2 supersedes v1 (same name), retaining v1 in `file_history`.
    // The version's page text/boxes come from ITS OWN retained `note_page_index`, so
    // the per-version route must return v1's word+box even though v2 is now current.
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

    // v1's page 0 transcript through the per-version route — no `?v=` (the `:md5`
    // pins the blob). SAME `PageTextVO` shape as the live route, `no-cache` (a
    // struct-serialised body the `:md5` cannot pin), never `immutable`.
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

    // The CURRENT page 0 (via note meta → textHash → the live text route) carries v2's
    // OWN word+box — proving the per-version route returned the OLD transcript, not
    // today's.
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

    // The CURRENT blob's md5 is not a `file_history` row → 404 (the live version is
    // never reachable as "history"), exactly like the sibling per-version routes.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v2md5 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // A bogus md5 not in this file's history → 404.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, "f" ** 32 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // A DIFFERENT user's file with its OWN real retained md5: admin does not own it, so
    // `historyVersion`'s `user_id` scope 404s — indistinguishable from a missing id.
    {
        const mid = try seedRecognizedVersion(f, mallory, "hers.note", "AAAA", &.{"one"});
        _ = try seedRecognizedVersion(f, mallory, "hers.note", "BBBB", &.{"two"});
        const mv1 = try soleHistoryMd5(f, mid);
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ mid, mv1 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // TRASH the file: `historyVersion` requires `f.deleted = 0`, so even its own owner
    // can no longer reach the retained version through this route.
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

    // A `.spd` (one of the client-side-rendered types this endpoint unlocks) with
    // two versions: the second supersedes the first, retaining v1 in `file_history`.
    const v1 = "spd-version-one-raw-bytes";
    const v2 = "spd-version-two-raw-bytes-and-a-little-longer";
    const id = try putSeed(f, admin, null, "draw.spd", v1);
    _ = try putSeed(f, admin, null, "draw.spd", v2); // v2 supersedes v1
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    // v1's raw bytes through the history route — no `?v=` (the path `:md5` pins the
    // blob). Headers are IDENTICAL to what live `/file/{id}` sends for a `.spd`:
    // octet-stream + attachment (a `.spd` is never inline), nosniff, immutable,
    // etag = the md5, and a DECLARED content-length (never chunked).
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

    // The LIVE `/file/{id}?v={v2md5}` serves v2's bytes with the same header shape —
    // proving the history route returned the OLD bytes, distinct from today's.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ id, v2md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(v2, resp.body);
        try std.testing.expect(!std.mem.eql(u8, v1, resp.body)); // distinct from the retained version
        try expectHeaderContains(resp.head, "content-type: application/octet-stream");
        try expectHeaderContains(resp.head, "content-disposition: attachment;");
    }

    // `?download=1` forces attachment on an INLINE type (an image), proving the
    // override rides the shared streaming tail exactly as it does on `/file/{id}`.
    {
        const img1 = "img-version-one";
        const img2 = "img-version-two-differs";
        const pid = try putSeed(f, admin, null, "pic.png", img1);
        _ = try putSeed(f, admin, null, "pic.png", img2);
        const pv1 = try soleHistoryMd5(f, pid);

        // Default: inline (an image is on the allowlist), and v1's exact bytes.
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ pid, pv1 });
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
            try std.testing.expectEqual(@as(u16, 200), resp.status);
            try std.testing.expectEqualStrings(img1, resp.body);
            try expectHeaderContains(resp.head, "content-type: image/png");
            try expectHeaderContains(resp.head, "content-disposition: inline;");
        }
        // `?download=1` → attachment.
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

    // The CURRENT blob is not a `file_history` row → 404 (the live version is never
    // reachable as "history"), exactly like the preview route.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ id, v2md5 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // A bogus md5 → 404.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ id, "f" ** 32 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // A DIFFERENT user's file, with its OWN real retained md5: admin does not own it,
    // so `historyVersion`'s `user_id` scope makes it 404 — indistinguishable from a
    // missing id, no cross-account existence oracle.
    {
        const mid = try putSeed(f, mallory, null, "hers.spd", "m1");
        _ = try putSeed(f, mallory, null, "hers.spd", "m2");
        const mv1 = try soleHistoryMd5(f, mid);
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/raw", .{ mid, mv1 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // TRASH the file: `historyVersion` requires `f.deleted = 0`, so even its own live
    // owner can no longer reach the retained version through this route.
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

    // v1 has THREE pages; v2 (current) supersedes it with ONE — the "I added/removed
    // pages since" case that used to render the CURRENT note's slot count for the
    // preview instead of the version's own geometry.
    const id = try seedRecognizedVersionPages(f, admin, "histmeta.note", 3, "AAAA", "alpha");
    _ = try seedRecognizedVersionPages(f, admin, "histmeta.note", 1, "BBBB", "beta");
    const v1md5 = try soleHistoryMd5(f, id);

    // The CURRENT note meta reports ONE page.
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

    // The VERSION meta reports v1's THREE pages — read from its OWN retained index,
    // with real per-page dims and `fileHash` set to the version md5.
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

    // A foreign / missing note id is a 404.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/99999/history/{s}/meta", .{v1md5});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    // The current blob's md5 is NOT a history row → 404; a bogus md5 → 404 too.
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

test "history search: one-document scan reads the OLD version's text, not the FTS" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    // "alpha" is recognized in v1 and EDITED OUT of v2 ("beta" replaces it).
    const id = try seedRecognizedVersion(f, admin, "hist.note", "AAAA", &.{ "alpha", "common" });
    _ = try seedRecognizedVersion(f, admin, "hist.note", "BBBB", &.{ "beta", "common" });
    const v1md5 = try soleHistoryMd5(f, id);

    // The FTS (current-only, H2) no longer holds "alpha" — proving the scan below
    // cannot be reading it from there.
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, admin, "alpha"));

    const PageMatch = struct { pageIndex: i64, matches: i64, terms: []const []const u8 };
    // Searching v1 for "alpha" finds its page via the one-document scan.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/search?q=alpha", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { query: []const u8, pages: []PageMatch, usedFuzzy: bool },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 1), parsed.value.pages.len);
        try std.testing.expectEqual(@as(i64, 0), parsed.value.pages[0].pageIndex);
        try std.testing.expect(parsed.value.pages[0].matches >= 1);
        try std.testing.expect(!parsed.value.usedFuzzy);
    }

    // A term that is in neither version returns no pages (not a 404 — the version
    // exists, it just has no match).
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/search?q=zzznope", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { pages: []PageMatch },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 0), parsed.value.pages.len);
    }

    // A md5 not in this file's history is a 404, not an empty result.
    {
        const bogus = "ffffffffffffffffffffffffffffffff";
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/search?q=alpha", .{ id, bogus });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "history restore: re-points via supersede, re-indexes the FTS, and is undoable" {
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

    // Current is v2: search finds "beta", not "alpha".
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, admin, "beta"));
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, admin, "alpha"));

    const RestoreVO = struct { success: bool, md5: []const u8, size: i64, createdAt: i64, current: bool };

    // Restore v1: the file re-points at v1, the DISPLACED v2 is retained, and the
    // FTS is re-indexed to v1's content (this MUST go through the supersede path,
    // not a raw md5 UPDATE — that is why global search flips).
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
    // v2 is now the retained version; the restored v1 is no longer a history row.
    try std.testing.expectEqualSlices(u8, &v2md5, &(try soleHistoryMd5(f, id)));

    // Undoable: restoring v2 back flips everything the other way.
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

/// Scalar count/lookup against the fixture's DB, for storage assertions.
fn countRows(f: *Fixture, sql: []const u8) !i64 {
    var s = try f.db.prepare(sql);
    defer s.finalize();
    _ = try s.step();
    return s.columnInt(0);
}

/// The md5 recorded for a single `files` row.
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

    // First login → pending session; the response flags mustChangePassword.
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

    // /me with the pending cookie: identity + still-must-change (this is what lets
    // the SPA route to change-password on a reload).
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

    // After the change, /me reports must-change cleared.
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

// ---- M1 device-sync read path ----

/// Runs a device-authenticated request (x-access-token + equipmentNo headers).
fn deviceRequest(ctx: *Context, obuf: []u8, reqbuf: []u8, method: []const u8, path: []const u8, token: []const u8, eno: []const u8, body: []const u8) !Response {
    const req = try buildRequest(reqbuf, method, path, &.{
        .{ .name = "content-type", .value = "application/json" },
        .{ .name = "x-access-token", .value = token },
        .{ .name = "equipmentNo", .value = eno },
    }, body);
    return roundtrip(ctx, req, obuf);
}

/// Logs `account`/`pw` in from a device (equipmentNo present) and returns the token.
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

    // login/equipment (device face, tolerating the extra `version` field).
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // check/exists/server: true for a real account, failure otherwise.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"alice\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
        const miss = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"ghost\"}"), &obuf);
        try expectFailure(miss.body, "USER_NOT_FOUND");
    }

    // query/server connectivity ping (public).
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/api/file/query/server", &.{}, ""), &obuf);
        try expectSuccess(resp.body);
    }

    // THE REAL ORDER, which is what made the naming bug possible: a file call
    // reaches the server BEFORE `bindEquipment` and binds the serial it has just
    // seen with a placeholder, because it has no name yet (`resolveEquipment`).
    // Simulated with the same call that path makes. Without this line the bind
    // below is the row's INSERT, the reported name arrives through it, and a test
    // asserting the name passes whether or not the handler adopts it — which is
    // exactly how the placeholder survived into every account screen.
    try f.svc.bindDevice(alice, "SN1", "Supernote app");

    // bindEquipment: creates the default label folders. The device-reported
    // `totalCapacity` is IGNORED — the server owns the quota, so a device cannot
    // set or raise its own (finding #6).
    {
        const body =
            "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\",\"totalCapacity\":\"25485312\"," ++
            "\"label\":[\"NOTE/Note\",\"NOTE/MyStyle\",\"EXPORT\",\"INBOX\"],\"version\":\"202407\"}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/terminal/user/bindEquipment", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expect(try f.svc.isDeviceBound(alice, "SN1"));
    // THE DEVICE'S REPORTED NAME LANDS, over the placeholder an earlier file call
    // will already have stamped ("Supernote app", from `resolveEquipment`). This
    // is asserted through the ROUTE rather than against `nameDevice` directly,
    // because the service function was never the broken part — the handler simply
    // did not call it, and a unit test of the function stayed green while every
    // account screen showed the placeholder for a tablet that had said its name.
    {
        const devs = try f.svc.listUserDevices(gpa, alice, alice);
        defer authsvc.Service.freeDevices(gpa, devs);
        try std.testing.expectEqual(@as(usize, 1), devs.len);
        try std.testing.expectEqualStrings("Nomad", devs[0].name);
    }
    // Quota is unchanged from the server default set at user creation — the bind's
    // reported 25485312 KB was NOT adopted.
    try std.testing.expectEqual(authsvc.default_capacity, try f.svc.userCapacity(alice));

    // Root now holds exactly the three label roots (NOTE, EXPORT, INBOX).
    {
        const root = try f.files.list(alice, null);
        defer filesmod.Files.freeEntries(gpa, root);
        try std.testing.expectEqual(@as(usize, 3), root.len);
        for (root) |e| try std.testing.expect(e.is_folder);
    }
    const note_id = try f.files.ensureFolderPath(alice, "NOTE/Note"); // idempotent → existing id

    // Seed two notes; capture the expected md5 of one for the assertion.
    const a_id = try putSeed(f, alice, note_id, "a.note", "aaaa");
    _ = try putSeed(f, alice, note_id, "b.note", "bbbbbb");
    const a_md5 = blobstore.md5HexOf("aaaa");

    // summary/hash → both files, with md5 + full path in metadataMap.
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

    // summary/id → full detail for the diffed id.
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

    // summary/group → the five folders (NOTE, Note, MyStyle, EXPORT, INBOX).
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/query/summary/group", &dev_tok, "SN1", "{\"page\":0,\"size\":100}");
        var p = try std.json.parseFromSlice(struct { totalRecords: i64, summaryDOList: []const struct { isSummaryGroup: []const u8 } }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 5), p.value.totalRecords);
        for (p.value.summaryDOList) |g| try std.testing.expectEqualStrings("Y", g.isSummaryGroup);
    }

    // user/query → the caller's user info.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/user/query", &dev_tok, "SN1", "{}");
        var p = try std.json.parseFromSlice(struct { success: bool, email: []const u8, totalCapacity: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("alice", p.value.email);
    }

    // synchronous/start (synType:true) and /end bracket the sync.
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

    // Cross-face guard still holds: a device token reaching a web route is 403.
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

    // A live, bound device with an active session.
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");
    try f.svc.bindDevice(alice, "SN1", "Nomad");
    try std.testing.expectEqual(@as(i64, 1), try f.svc.deviceCount(alice));
    try std.testing.expect((try f.svc.caller(&dev_tok)) != null);

    // An unauthenticated caller (no token) POSTs the serial. SECURITY: this must
    // NOT unbind the device or drop its sessions — otherwise any LAN client could
    // force-log-out the household device by its printed serial. It returns the
    // lenient success the device's pre-login step expects; bind re-establishes.
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

    // Simulate a freshly-onboarded account with NO capacity row (drop the one that
    // createUser made) — the exact state that used to make upload/apply 500.
    {
        var s = try f.db.prepare("DELETE FROM capacity WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }

    // wouldFit must NOT error on a missing row — it falls back to the default quota.
    try std.testing.expect(try f.files.wouldFit(alice, 1024));

    // bindEquipment recreates the missing capacity row at the SERVER DEFAULT — the
    // device-reported totalCapacity is ignored (finding #6: no self-set quota).
    {
        const body = "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\",\"totalCapacity\":\"25485312\",\"label\":[\"NOTE/Note\"]}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/terminal/user/bindEquipment", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // The row exists again, at the server default (NOT the reported 25485312 KB).
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

    // Seed a tree: /NOTE/Note/a.note (a real blob we can download) + a root file.
    const note_id = try f.files.ensureFolderPath(alice, "NOTE/Note");
    const blob_bytes = "hello supernote download blob";
    const a_id = try putSeed(f, alice, note_id, "a.note", blob_bytes);
    const top_id = try putSeed(f, alice, null, "top.note", "x"); // a second file, for cross-file scoping
    const a_md5 = blobstore.md5HexOf(blob_bytes);
    const a_entry = (try f.files.get(alice, a_id)).?;
    defer gpa.free(a_entry.name);
    defer if (a_entry.md5) |m| gpa.free(m);

    // --- list_folder("/NOTE/Note", non-recursive) → the one direct child a.note ---
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

    // --- list_folder("/", recursive) → the whole tree (NOTE, Note, a.note, top.note) ---
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const struct { tag: []const u8, path_display: []const u8, is_downloadable: bool },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 4), p.value.entries.len);
        // Folders advertise is_downloadable=false.
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.tag, "folder")) try std.testing.expect(!e.is_downloadable);
        }
    }

    // --- query/by/path_v3: found → entriesVO present; not found → field OMITTED ---
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
        // The absent optional means the field is not in the JSON at all.
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "entriesVO") == null);
        try expectSuccess(resp.body);
    }

    // --- query_v3 by id → same VO ---
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
        // The serial is echoed from caller.equipmentNo() AFTER the body read — this
        // asserts the inline copy survived it (no use-after-free on the head buffer).
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("a.note", p.value.entriesVO.?.name);
    }

    // --- download_v3 → a url back at our /oss/get/:id carrying a `?t=` capability token ---
    // The device sends NO x-access-token on the download GET, so the URL itself
    // authorizes it (see http/download_tokens.zig). Capture the minted token.
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
        // Serial echoed from caller.equipmentNo() after readBody — guards the UAF fix.
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        // buildRequest sends "host: test": the url names that host over plaintext http,
        // points at /oss/get/<id>, and carries a `?t=` token.
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

    // --- GET /oss/get/:id?t=<token> → the RAW blob bytes streamed back (octet-stream) ---
    // No x-access-token header: the `?t=` token is the only credential.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", oss_path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(blob_bytes, resp.body); // exact bytes, raw
        try std.testing.expect(std.ascii.indexOfIgnoreCase(resp.head, "application/octet-stream") != null);
        // Content-Disposition carries the filename (required for the device to materialize it).
        try std.testing.expect(std.ascii.indexOfIgnoreCase(resp.head, "content-disposition:") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "a.note") != null);
    }

    // --- multi-use within the TTL: a SECOND GET with the same token also succeeds ---
    // (the device may Range-request or retry; strict single-use would 403 the retry).
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", oss_path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(blob_bytes, resp.body);
    }

    // --- token failures → 403, NEVER 401 (a 401 would make the device log itself out) ---
    // No token at all.
    {
        var pbuf: [32]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}", .{a_id});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
    // A bad / unknown token.
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}?t=deadbeefdeadbeefdeadbeefdeadbeef", .{a_id});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
    // Cross-file: a token minted for a.note cannot fetch top.note (file-scoped) → 403.
    {
        const q = std.mem.indexOfScalar(u8, oss_path, '?').?;
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}{s}", .{ top_id, oss_path[q..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
    // A valid token but a foreign/missing file id is impossible (id is baked into the
    // token); an unknown id with a mismatching token is already a 403 above.

    // --- auth boundary on the still-device routes (list_folder) ---
    // No token → 401.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/2/files/list_folder", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"path\":\"/\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    // A control-plane session (cookie) crossing into a .device route → 403.
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &web_tok, "{\"path\":\"/\"}", 403);
    }
}

// The OLD `list_folder` computation, kept HERE as the reference oracle: walk the
// WHOLE tree, then filter in Zig. The handler no longer does this (it scopes the
// query), so this reproduces the pre-optimization behavior to prove the scoped
// result is the same SET. `underPath`: strict-descendant test (folder != "/").
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

// Hits list_folder over the wire and returns the sorted set of `path_display`
// strings (dupes owned by `a`).
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

    // A tree with depth, siblings, and a genuinely EMPTY folder:
    //   /A/one.note  /A/B/deep.note  /A/empty (no children)  /root.note
    const a_id = try f.files.ensureFolderPath(alice, "A");
    _ = try putSeed(f, alice, a_id, "one.note", "1");
    const b_id = try f.files.ensureFolderPath(alice, "A/B");
    _ = try putSeed(f, alice, b_id, "deep.note", "22");
    _ = try f.files.ensureFolderPath(alice, "A/empty");
    _ = try putSeed(f, alice, null, "root.note", "333");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    // For each case: the scoped endpoint result must equal the reference walk.
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

    // Charge a known amount of usage, then read it back over the wire.
    _ = try putSeed(f, alice, null, "a.note", "abcdefg"); // 7 bytes
    try std.testing.expectEqual(@as(i64, 7), try usedBytes(f, alice));

    // The SERIALIZED body is pinned, not just the parsed struct: the device
    // matched these literal names (`used`, nested `allocationVO.allocated`, and
    // the `tag`), so a field rename must fail this test.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/users/get_space_usage", &dev, "SN1", "{\"equipmentNo\":\"SN1\",\"version\":\"202407\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(
            "{\"success\":true,\"used\":7,\"allocationVO\":{\"tag\":\"Individual\",\"allocated\":10737418240}}",
            resp.body,
        );
    }

    // It REFLECTS a change: charge more and `used` moves with the capacity row.
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

    // A user with NO capacity row reads the server default rather than 500ing.
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

    // Scope: the device face only. No token → 401; a control-plane cookie → 403.
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

// ---- M2 device-sync upload byte-path ----

/// The user's charged capacity (`capacity.used_bytes`), read straight from the DB.
fn usedBytes(f: *Fixture, user_id: u64) !i64 {
    var s = try f.db.prepare("SELECT used_bytes FROM capacity WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    _ = try s.step();
    return s.columnInt(0);
}

/// Wraps `payload` in a single-part `multipart/form-data` body (one `name="file"`
/// part), exactly as the device frames its `/oss/put` upload. Caller frees.
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

/// How many files are staged under the blob store's `tmp/` directory — where a
/// half-written ingest lives before it is published, and the only place a refused
/// upload could strand bytes. Counted (not asserted empty inline) so a failure
/// reports how many were left.
fn blobTempCount(f: *Fixture) !usize {
    var d = try f.tmp.dir.openDir(std.testing.io, "tmp", .{ .iterate = true });
    defer d.close(std.testing.io);
    var it = d.iterate();
    var n: usize = 0;
    while (try it.next(std.testing.io)) |_| n += 1;
    return n;
}

/// Total bytes staged under the blob store's `tmp/` directory. The per-session
/// cap's real claim is about this number: with a per-PART cap, N chunked parts
/// could each stage up to the cap and the sum was unbounded, so counting the
/// files (`blobTempCount`) cannot see the difference — only their size can.
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

/// `len` bytes of a deterministic non-repeating pattern — big enough to outrun
/// the ingest cap, and containing no multipart delimiter look-alike.
fn filler(len: usize) ![]u8 {
    const buf = try gpa.alloc(u8, len);
    for (buf, 0..) |*b, i| b.* = @intCast((i * 31 + 7) & 0xFF);
    return buf;
}

/// `upload/apply` announcing `size` bytes, returning the minted `innerName` —
/// which is what the cap on the following `/oss/put` is measured against.
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

/// POSTs `payload` to `/oss/put/<inner>`, multipart-framed as the device frames
/// it; `query` is appended raw (the chunk parameters). The request buffer is
/// heap-allocated because these payloads are deliberately larger than any stack
/// buffer in this file.
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

/// The most of a request body a CAPPED ingest can legitimately have read before
/// refusing: the cap itself, plus the framing and the reader's lookahead — the
/// multipart extractor is fed in `chunk_len` reads and holds a boundary-sized
/// window back, and the HTTP reader fills its own `chunk_len` buffer ahead of it.
/// Three chunks of headroom is generous and still an order of magnitude below the
/// bodies these tests send, so "it stopped early" is unambiguous.
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

    // The .note bytes the device is uploading, and their true md5.
    const file_bytes = "SUPERNOTE upload payload — the real .note bytes\x00\x01\x02\r\n--not-a-boundary";
    const md5 = blobstore.md5HexOf(file_bytes);
    const before_version = try f.files.syncVersion(alice);

    // 1) upload/apply → an innerName + an /oss/put URL naming our Host.
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
        // buildRequest sends "host: test", so the URL names that host over http.
        var want: [64]u8 = undefined;
        try std.testing.expectEqualStrings(try std.fmt.bufPrint(&want, "http://test/oss/put/{s}", .{&inner}), p.value.fullUploadUrl);
    }

    // 2) POST /oss/put/<inner> with the multipart-wrapped bytes → empty 200.
    {
        const boundary = "----NomadUploadBoundaryZZ";
        const wire = try buildMultipart(boundary, file_bytes);
        defer gpa.free(wire);
        // The wire body is larger than the file by the multipart envelope.
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

    // The blob is now on disk (keyed by the ORIGINAL file's md5, not the wire body).
    try std.testing.expect(f.files.blobs.has(&md5));

    // 3) upload/finish → commit; returns the real created file id.
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

    // The files entry exists with the right md5/size/parent; quota charged; version bumped.
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

    // The consumed session is gone.
    {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        try std.testing.expect((try f.files.uploadSession(arena.allocator(), alice, &inner)) == null);
    }

    // The uploaded note now shows up to the device via list_folder.
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

    // apply + /oss/put to actually store the bytes.
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

    // finish with the WRONG content_hash → failure, and NO file is linked.
    {
        const wrong = "ffffffffffffffffffffffffffffffff";
        const body = try std.fmt.allocPrint(gpa, "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"bad.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}", .{ wrong, &inner, file_bytes.len });
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "HASH_MISMATCH");
    }
    // No entry appeared, and no quota was charged (the blob is left orphaned for the sweep).
    try std.testing.expect((try f.files.resolvePath(alice, "/NOTE/Note/bad.note")) == null);
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, alice));
    try std.testing.expect(f.files.blobs.has(&real_md5)); // stored but unreferenced

    // The age-based session sweep reclaims the stale session + its on-disk-only blob.
    {
        const swept = try f.files.sweepUploadSessions(-1); // cutoff in the future → sweep everything
        try std.testing.expectEqual(@as(usize, 1), swept);
        try std.testing.expect(!f.files.blobs.has(&real_md5)); // orphan reclaimed
    }

    // --- auth boundary on /oss/put ---
    // No token → 401.
    {
        const req = try buildRequest(&reqbuf, "POST", "/oss/put/deadbeefdeadbeef", &.{
            .{ .name = "content-type", .value = "multipart/form-data; boundary=BND" },
        }, "--BND\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nx\r\n--BND--\r\n");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    // A control-plane session (cookie) crossing into the .device route → 403.
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

    // The device declares a huge size but uploads a tiny payload. Trusting the
    // declared size would set files.size/quota to 5 MB (→ OOM on read, broken
    // download framing); we must commit the real ingested 4 bytes.
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

    // The committed size is the REAL 4 bytes, and quota is charged the real amount
    // — NOT the 5 MB the device declared.
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

    // The .note bytes the device is uploading, split in 3 parts
    const p1 = "SUPERNOTE upload payload ";
    const p2 = "— the real .note ";
    const p3 = "bytes\x00\x01\x02\r\n--not-a-boundary";

    const file_bytes = try std.mem.concat(gpa, u8, &.{ p1, p2, p3 });
    defer gpa.free(file_bytes);
    const md5 = blobstore.md5HexOf(file_bytes);

    // 1) upload/apply
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

    // 2) POST /oss/put/<inner> 3 times with chunk parameters
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

    // The blob is now on disk
    try std.testing.expect(f.files.blobs.has(&md5));

    // 3) upload/finish
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

    // Mint a session + innerName so the request gets past the ownership check and
    // reaches the chunk path — the rejection we want to prove is the uploadId one.
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

    // `../../pwned` carries both a slash and a dot — neither is in the uploadId
    // allowlist, so the handler must 400 before `beginChunkIngest` ever splices it
    // into a `tmp/<id>_1` path and escapes the staging dir.
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

// ---- the ingest cap: a body may not outrun what was declared ------------------

test "device /oss/put: a body past the declared size is refused MID-STREAM, leaving no session row and nothing on disk" {
    // Before the cap, `/oss/put` streamed whatever arrived straight onto disk and
    // quota was consulted only at `upload/finish` — i.e. after every byte had
    // landed. One authenticated request could therefore fill the disk with every
    // quota check in the codebase still passing, and on the Pi a full disk takes
    // the SQLite database with it.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // The device announces 4 KiB and then sends a body several caps long.
    const declared: usize = 4096;
    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "flood.note", declared);
    const payload = try filler(declared + 4 * uploadcap.slack_bytes);
    defer gpa.free(payload);

    const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, payload, "");
    const resp = sent.resp;

    // THE WIRE SHAPE IS THE PROTOCOL'S. The device sync protocol answers failures
    // as HTTP 200 carrying the coded envelope — the same `QUOTA_EXCEEDED` its
    // sibling steps (`upload/apply`, `upload/finish`) answer when there is no
    // room. A 4xx/5xx here would read to the tablet as a network failure
    // mid-sync rather than as a decision it can report.
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try expectFailure(resp.body, "QUOTA_EXCEEDED");

    // THE REFUSAL IS MID-STREAM, which is the whole claim: the server stopped
    // reading near the cap instead of swallowing the body and refusing at the end
    // (the old behaviour, which produces an identical response and an identical
    // aftermath — see `Sent`).
    try std.testing.expect(sent.consumed < cappedReadCeiling(uploadcap.limitFor(declared)));

    // THE DURABLE FACTS, not the response: the reservation is gone, no blob was
    // published, and nothing is staged in `tmp/` for the startup sweep to find.
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(payload)));
    try std.testing.expectEqual(@as(usize, 0), try blobTempCount(f));
    try std.testing.expectEqual(@as(i64, 0), (try f.files.capacity(alice)).used);

    // And the reservation really is unusable afterwards — `finish` finds nothing.
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

    // (a) The ordinary upload — exactly what was declared — goes all the way
    //     through apply → put → finish and lands in the tree.
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

    // (b) THE BOUNDARY: declared + the whole slack, to the byte, is ACCEPTED. The
    //     refusal above is one byte past this, so the two together pin the edge
    //     rather than "somewhere in that region".
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
    // The chunked path is the same hole with more steps: each part streamed to
    // disk unmeasured. Each part is now held to the same figure — no single part
    // can legitimately exceed the whole declared file.
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

    // Reservation gone, nothing published. (What the refused part had already
    // staged under `tmp/` is bounded by the cap and reclaimed by the startup
    // `sweepTmp`: `ChunkIngest.abort` closes the fd without unlinking, unlike its
    // single-shot sibling — a store-level asymmetry, noted with the review.)
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(payload)));

    // A later part of the same upload has nothing left to attach to.
    const again = try ossPut(ctx, &obuf, &dev_tok, &inner, "small", "?uploadId=abc123&totalChunks=3&partNumber=2");
    try std.testing.expectEqual(@as(u16, 404), again.resp.status);
}

test "device /oss/put chunked: the byte cap is per SESSION — N parts cannot each stage the whole budget" {
    // THE HOLE THE PER-PART CAP LEFT. Every part was measured against
    // `limitFor(declared)` on its own, and `totalChunks` is a number the CALLER
    // puts in the query string — so a device could declare 100 KB and then send
    // part after part, each one passing the cap, until the disk was full. The cap
    // closed the single-shot hole and left the chunked one exactly as it was.
    //
    // Each part below is EXACTLY the declared file size: unimpeachable on its own,
    // absurd in aggregate. That is what the session total is for.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // Deliberately much larger than `slack_bytes`, so "it stopped reading near the
    // remaining budget" and "it read the whole part" are numbers far apart.
    const declared: usize = 400_000;
    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "flood.note", declared);
    const part = try filler(declared);
    defer gpa.free(part);

    // Part 1 is within the session budget (`declared + slack`) and is accepted —
    // the cap removes an attack, not the feature.
    {
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, "?uploadId=floodid&totalChunks=9&partNumber=1");
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try std.testing.expectEqual(@as(usize, 0), sent.resp.body.len); // empty-200 success
    }

    // Part 2 is the same size and, under the per-part rule, equally acceptable.
    // Against the SESSION's remaining budget it is not, and it is refused
    // MID-STREAM — the server stops reading near the remainder rather than taking
    // the whole part and refusing afterwards.
    const remaining = uploadcap.limitFor(declared) - declared;
    {
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, "?uploadId=floodid&totalChunks=9&partNumber=2");
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try expectFailure(sent.resp.body, "QUOTA_EXCEEDED"); // the protocol's refusal, not a 413
        try std.testing.expect(sent.consumed < cappedReadCeiling(remaining));
    }

    // THE DURABLE, DISTINGUISHING FACT, and the one that needs no slack in it:
    // what this session managed to put on disk is bounded by ONE budget, however
    // many parts it send. Exactly `limitFor(declared)`, because the refused part's
    // sink was capped at the REMAINDER before a byte of it was written — not at
    // the whole figure again. Under the per-part rule these two parts alone stage
    // ~800 KB, and part 3 would have been welcome to another 400 KB.
    //
    // Refusing only AFTER a part has landed (the plausible half-fix: keep the
    // per-part sink limit, add the running total, check it at the end) also fails
    // here — it bounds the accounting but not the disk, which is the thing a full
    // SD card cares about. `ChunkIngest.abort` leaves what it staged for the
    // startup `sweepTmp`, so the bytes are real until the next boot.
    try std.testing.expect(try blobTempBytes(f) <= uploadcap.limitFor(declared));

    // And the reservation is gone, so the upload cannot simply be continued.
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    const again = try ossPut(ctx, &obuf, &dev_tok, &inner, "small", "?uploadId=floodid&totalChunks=9&partNumber=3");
    try std.testing.expectEqual(@as(u16, 404), again.resp.status);
}

test "device /oss/put chunked: re-sending a part is not charged twice" {
    // THE WAY A RUNNING TOTAL GOES WRONG. A part's temp file is named
    // deterministically (`tmp/<uploadId>_<n>`), so re-POSTing part 2 REPLACES it.
    // A total that only ever added would bill the session for both copies and
    // refuse a device that retried a part after a dropped connection — mid-sync,
    // for doing exactly what a resilient client should. `stagedPartSize` is what
    // gives the earlier copy back.
    //
    // The sizes are chosen so the double-charge is the only thing that can fail
    // it: two parts fit the budget, three do not, and the third request here is a
    // REPEAT of the second.
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

    // The retry: part 2 again, byte for byte. Accepted, because it replaces what
    // part 2 already contributed rather than adding to it.
    {
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, "?uploadId=retryid&totalChunks=3&partNumber=2");
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try std.testing.expectEqual(@as(usize, 0), sent.resp.body.len);
    }

    // The session survived it, and its running total still reads two parts — not
    // three. That is the durable fact: the response above would look the same if
    // the total had been left inflated and the refusal simply deferred.
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

    // upload/apply with size == i64max would overflow the quota math → rejected
    // with QUOTA_EXCEEDED, never a panic that would kill the single-threaded server.
    {
        const body = "{\"path\":\"/NOTE/Note/x.note\",\"fileName\":\"x.note\",\"equipmentNo\":\"SN1\",\"size\":9223372036854775807}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "QUOTA_EXCEEDED");
    }

    // bindEquipment with a totalCapacity near i64max would overflow kb*1024 → it
    // must fall back to the household default, not panic.
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

    // The route allows 20/min per IP. The first 20 pass (200); the 21st is 429.
    var i: usize = 0;
    while (i < 20) : (i += 1) {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/equipment/unlink", &.{.{ .name = "content-type", .value = "application/json" }}, body), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/equipment/unlink", &.{.{ .name = "content-type", .value = "application/json" }}, body), &obuf);
    try std.testing.expectEqual(@as(u16, 429), resp.status);
}

// ---- create_folder_v2 (the device's folder create) ----

/// How many live rows a user has under `name` — the check that a retried create
/// converged on one row instead of quietly forking the tree.
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

    // The exact wire shape the Nomad sent: autorename present and false.
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

    // THE POINT of the endpoint: the folder is in the tree with nothing in it,
    // and the device's own enumeration can see it. Before this route existed a
    // folder appeared only once a file was uploaded into it.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "/NOTE/Note/Trip") != null);
    }
    const entry = (try f.files.get(alice, id)).?;
    defer gpa.free(entry.name);
    try std.testing.expect(entry.is_folder);

    // The device retries. `autorename: false` must converge on the same row
    // rather than fail or create a second folder.
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

    // A missing path settles rather than 400s — see the handler's judgement call.
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

    // Bob creates the SAME path. It must be his own folder, not a conflict with
    // Alice's and not a way to learn hers exists.
    const b_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN2");
    const b_resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &b_tok, "SN2", body);
    try std.testing.expectEqual(@as(u16, 200), b_resp.status);
    try std.testing.expect(std.mem.indexOf(u8, b_resp.body, "\"name\":\"Shared\"") != null);

    // Two distinct rows, one per owner.
    const a_id = (try f.files.resolvePath(alice, "/NOTE/Shared")).?;
    const b_id = (try f.files.resolvePath(bob, "/NOTE/Shared")).?;
    try std.testing.expect(a_id != b_id);
    try std.testing.expect((try f.files.get(bob, a_id)) == null);
}

// ---- delete_folder_v3 (the device's only delete) ----

/// `SELECT deleted, deleted_at FROM files WHERE id = ?` — the tombstone as the
/// row itself records it, not as any read path reports it.
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

/// How many recognized-page hits `q` finds for `user_id`, through the one
/// exported search read (whose `files` join is the security boundary).
fn searchHits(f: *Fixture, user_id: u64, q: []const u8) !usize {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const r = try notesearch.searchPages(arena.allocator(), std.testing.io, f.db, user_id, q, 20, null);
    return r.hits.len;
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

    // A real recognized note, so the FTS side of "leaves search" is not a stub.
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

    // --- the delete, in the exact wire shape the Nomad sent ---
    var body_buf: [128]u8 = undefined;
    const del_body = try std.fmt.bufPrint(&body_buf, "{{\"equipmentNo\":\"SN1\",\"id\":\"{d}\"}}", .{rec_id});
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &dev_tok, "SN1", del_body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        // The SERIALIZED body is pinned, not just the parsed struct: the firmware
        // matched these literal names, and the capture stub's canned "note.note"
        // must have been replaced by the REAL name and the REAL tag.
        var want_buf: [256]u8 = undefined;
        const want = try std.fmt.bufPrint(
            &want_buf,
            "{{\"success\":true,\"equipmentNo\":\"SN1\",\"metadata\":{{\"tag\":\"file\",\"id\":\"{d}\",\"name\":\"rec.note\"}}}}",
            .{rec_id},
        );
        try std.testing.expectEqualStrings(want, resp.body);
    }

    // It is a tombstone, stamped for retention.
    const t = try tombstoneOf(f, rec_id);
    try std.testing.expect(t.deleted);
    try std.testing.expect(t.deleted_at > 0);

    // Gone from the device's own enumeration — this is what stops the zombie
    // re-download — and gone from search and from the live read path.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "rec.note") == null);
    }
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, alice, "Zebra"));
    try std.testing.expect((try f.files.get(alice, rec_id)) == null);

    // QUOTA IS NOT REFUNDED — a recorded decision, not an oversight. The bytes
    // still occupy disk until purge; refunding here would let a user exceed real
    // usage by cycling the bin.
    try std.testing.expectEqual(size_before, try usedBytes(f, alice));

    // THE POINT OF THE BIN: the blob was never released, so the row restores to
    // bytes that are actually still readable.
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

    // Restore is a flag flip, not a re-index: the md5-keyed rows survived, so the
    // note is searchable again with no re-parse.
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

    // The capture's shape exactly: a folder holding two notes.
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

    // seq 79-81: one request per entity, CHILDREN FIRST, parent last.
    {
        const r1 = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, a_id);
        try std.testing.expectEqual(@as(u16, 200), r1.status);
        try expectSuccess(r1.body);
        const r2 = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, b_id);
        try std.testing.expectEqual(@as(u16, 200), r2.status);
        try expectSuccess(r2.body);
        const r3 = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, dir.id);
        try std.testing.expectEqual(@as(u16, 200), r3.status);
        // The parent arrives with its children ALREADY gone, and is still a folder.
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

    // Backdate the tombstones to a distinct, recognizable instant so a restarted
    // retention clock cannot hide behind a coarse test clock.
    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = 1000 WHERE user_id = ?1 AND deleted = 1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }
    const ver_before = try f.files.syncVersion(alice);

    // THE RETRY. The device resends; `Files.get` would 404 these rows (it hardcodes
    // deleted = 0), which is exactly why the handler looks them up state-blind.
    for ([_]u64{ a_id, dir.id }) |id| {
        const r = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, id);
        try std.testing.expectEqual(@as(u16, 200), r.status);
        try expectSuccess(r.body);
    }
    try std.testing.expectEqual(@as(i64, 3), try countTrashed(f, alice));
    // The retention clock did NOT restart — an entry cannot be kept alive forever
    // by a device that keeps retrying.
    try std.testing.expectEqual(@as(i64, 1000), (try tombstoneOf(f, a_id)).deleted_at);
    try std.testing.expectEqual(@as(i64, 1000), (try tombstoneOf(f, dir.id)).deleted_at);
    try std.testing.expectEqual(@as(i64, 1000), (try tombstoneOf(f, b_id)).deleted_at);
    // And a no-op retry does not invalidate every cached listing in the browser.
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

    // Bob's id, and an id that has never existed, must produce the SAME response
    // — byte for byte. Any difference makes the endpoint an existence oracle over
    // another user's id space.
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

    // DELIBERATE: an unknown id answers success with `metadata` OMITTED — an
    // idempotent delete. A failure would risk the device retrying forever against
    // a state it can never reach, which is the bug this endpoint exists to fix.
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", foreign.body);
    // And of course Bob's file is untouched.
    {
        const still = (try f.files.get(bob, bob_id)).?;
        defer gpa.free(still.name);
        defer if (still.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("bob.note", still.name);
    }
    try std.testing.expectEqual(@as(i64, 0), try countTrashed(f, bob));

    // Unauthenticated → 401.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"id\":\"1\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    // A control-plane session (cookie) crossing into this .device route → 403.
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &web_tok, "{\"id\":\"1\"}", 403);
    }
}

// ---- move_v3 (the device's move/rename) ----

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

    // A real recognized note at the root, so "stays searchable" is not a stub.
    const id = try seedRecognizedNote(f, alice, "note.note", &.{ "Zebra", "Quokka" });
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));

    // The EXACT captured wire shape: a full destination path INCLUDING the new
    // filename, into a parent that does not exist yet, autorename false.
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
        // The entry AFTER the move: its real, authoritative destination path.
        try std.testing.expectEqualStrings("/NOTE/Note/corpus/note/custom_template.note", p.value.entriesVO.path_display);
        try std.testing.expectEqualStrings("/NOTE/Note/corpus/note", p.value.entriesVO.parent_path);
        try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.entriesVO.id, 10));
    }

    // The destination parent chain was PROVISIONED as folders, and the row moved
    // there — the device's own enumeration sees it at the new path, not the old.
    try std.testing.expect((try f.files.resolvePath(alice, "/NOTE/Note/corpus/note")) != null);
    try std.testing.expectEqual(@as(?u64, id), try f.files.resolvePath(alice, "/NOTE/Note/corpus/note/custom_template.note"));
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(alice, "/note.note"));
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "/NOTE/Note/corpus/note/custom_template.note") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"name\":\"note.note\"") == null);
    }

    // The blob-keyed index never moved, so the renamed note is STILL searchable.
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

    // An unknown id and Bob's id must produce the SAME settled body — a 404 here
    // aborts the device's sync, and any difference is a cross-account oracle.
    var mbuf: [200]u8 = undefined;
    var fbuf: [200]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&mbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", missing.body);

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&fbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing.body, foreign.body);

    // Bob's file did not move, and no phantom parent was created in his tree.
    {
        const still = (try f.files.get(bob, bob_id)).?;
        defer gpa.free(still.name);
        defer if (still.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("bob.note", still.name);
        try std.testing.expectEqual(@as(?u64, null), still.parent_id);
    }
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(bob, "/x"));

    // A control-plane cookie crossing into this .device route → 403; unauth → 401.
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

    // Two notes at the root; move one ONTO the other's name with autorename true.
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
    // The server's autorename choice, learned by the device from entriesVO.
    try std.testing.expectEqualStrings("keep (2).note", p.value.entriesVO.name);
    try std.testing.expectEqualStrings("/keep (2).note", p.value.entriesVO.path_display);
    try std.testing.expectEqual(@as(?u64, mover), try f.files.resolvePath(alice, "/keep (2).note"));
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note")); // the occupant intact
}

// ---- copy_v3 (the device's copy — conflict resolution) ----

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

    // The EXACT conflict-resolution wire shape: a full destination path into a
    // parent that does not exist yet, autorename false (the device chose the name).
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
        // The COPY is a NEW row, not the source — a distinct id.
        try std.testing.expect(id != try std.fmt.parseInt(u64, p.value.entriesVO.id, 10));
    }

    // The SOURCE is untouched and the COPY exists at the destination.
    try std.testing.expectEqual(@as(?u64, id), try f.files.resolvePath(alice, "/note.note"));
    const copy_id = (try f.files.resolvePath(alice, "/NOTE/Note/note_CONFLICT_20260726151728080.note")).?;
    try std.testing.expect(copy_id != id);

    // Content-addressed: the copy shares the source's blob, so it added NO bytes.
    try std.testing.expectEqual(used_before, (try f.files.capacity(alice)).used);

    // The blob-keyed index is shared, so BOTH notes are searchable — one hit per row.
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

    // An unknown id and Bob's id must produce the SAME settled body — a 404 aborts
    // the device's sync, and any difference is a cross-account existence oracle.
    var mbuf: [200]u8 = undefined;
    var fbuf: [200]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&mbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", missing.body);

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&fbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing.body, foreign.body);

    // Bob's file was not copied, and no phantom parent was created in his tree.
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, bob, "bob.note"));
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(bob, "/x"));

    // A control-plane cookie crossing into this .device route → 403; unauth → 401.
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

    // Copy a note ONTO an occupied name with autorename true: the occupant is kept
    // and the copy takes the next free suffix.
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
    // The copy landed at the renamed path; the occupant and the source both intact.
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
    // Settled success, no entry — and the occupant's bytes are untouched (never lossy).
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", resp.body);
    _ = keep;
    // Exactly one "keep.note" (the occupant), and the source is still present —
    // nothing was clobbered and no copy was written.
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note"));
    try std.testing.expectEqual(@as(?u64, src), try f.files.resolvePath(alice, "/src.note"));
}

// ---- Web-face browse/read endpoints ----

/// Serializes a synthetic `.note` (one main layer per page) and stores it as a
/// file under `parent` for `user_id`; returns the new file id.
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

    // A full control-plane session for the admin user; and a device session to prove the
    // .controlplane routes reject a device token.
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    // Seed a small tree: a folder "Work", a root note, and a 2-page note in Work.
    const work = try f.files.createFolder(admin, null, "Work");
    defer gpa.free(work.name);
    const top_id = try seedNoteHttp(f, admin, null, "top.note", &.{"AAAA"});
    _ = try seedNoteHttp(f, admin, work.id, "deep.note", &.{ "AAAA", "BBBBBB" });

    // --- auth: no session → 401; device token → 403 (cross-face) ---
    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/tree", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        // A device session must not reach a .controlplane route.
        const alice = (try f.svc.createUser(admin, "alice", false)).id;
        _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/tree", &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    // --- /api/controlplane/tree (root) ---
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
        // Folders sort first.
        try std.testing.expectEqualStrings("folder", p.value.entries[0].kind);
        try std.testing.expectEqualStrings("Work", p.value.entries[0].name);
        // A folder has no shape to freeze — and absent means OMITTED, never
        // `"thumbAspect":null`, which a client would read as a third state.
        try std.testing.expect(p.value.entries[0].thumbAspect == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"thumbAspect\":null") == null);
        const n = p.value.entries[1];
        try std.testing.expectEqualStrings("note", n.kind);
        try std.testing.expectEqualStrings("top.note", n.name);
        try std.testing.expectEqual(@as(i64, 1), n.pageCount.?);
        try std.testing.expectEqual(@as(usize, 32), n.firstPage.?.hash.len);
        try std.testing.expectEqual(@as(i64, 1404), n.firstPage.?.width);
        // The coverless note's aspect: page 0's effective dims, on the listing.
        try std.testing.expectEqual(@as(i64, 1404), n.thumbAspect.?.w);
        try std.testing.expectEqual(@as(i64, 1872), n.thumbAspect.?.h);
        try std.testing.expect(p.value.syncVersion > 0);
        @memcpy(work_id_str[0..p.value.entries[0].id.len], p.value.entries[0].id);
        work_id_len = p.value.entries[0].id.len;
    }

    // --- /api/controlplane/tree?parent={workId} → breadcrumb + the nested note ---
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

    // --- /api/controlplane/note/{id} → the full page list; capture page 0's hash ---
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

    // A missing note id → 404 NOT_FOUND.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/file/metadata/99999", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    // --- /note/{id}/page/0?v={hash} → 200, SNPG payload, immutable caching ---
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ top_id, page0_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(resp.body.len >= 4);
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") != null);
        try std.testing.expect(std.ascii.indexOfIgnoreCase(resp.head, "etag:") != null);
    }

    // A stale/wrong `?v=` → 404 (client should refetch the note metadata).
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ top_id, "0" ** 32 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    // An out-of-range page → 404.
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/9?v={s}", .{ top_id, page0_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    // --- /api/controlplane/events → a one-shot SSE frame carrying the current version ---
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "text/event-stream") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "data: ") != null);
    }
}

/// Seeds a one-page `.note` whose page carries finished recognition holding
/// `labels`, so the OCR-search path has something real to find.
fn seedRecognizedNote(f: *Fixture, user_id: u64, name: []const u8, labels: []const []const u8) !u64 {
    return seedRecognizedElements(f, user_id, name, "N6", blk: {
        const nb = @import("note_builder");
        const els = try gpa.alloc(nb.ElementSpec, labels.len);
        for (labels, els) |label, *e| e.* = .{ .label = label };
        break :blk els;
    }, true);
}

/// A recognized note with full control over `APPLY_EQUIPMENT` and the per-word
/// boxes. `equipment` may be null to seed a note whose hardware we have never
/// measured — the case where the mm→px scale must come back absent.
///
/// `owns_elements` frees the slice for the shorthand above; a caller passing a
/// literal keeps ownership.
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

/// A note whose page 0 was rasterised from an imported PDF template and kept
/// that page's links (`note-format.md` §14), page 1 an ordinary page with none.
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

    // --- the page list carries `linksHash` for the page that has links, and
    //     OMITS it everywhere else. That omission is what stops the reader from
    //     asking about pages that have nothing — which is nearly all of them.
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

    // --- the happy path: `{ links: [...] }`, no `{success}` envelope, revalidated.
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links?v={s}", .{ id, links_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // Serialised from a struct, so `?v=` versions its content and not its
        // shape — the rule `/text` learned the hard way.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null);

        var p = try std.json.parseFromSlice(struct {
            links: []const struct { x: f64, y: f64, w: f64, h: f64, page: i64, uri: []const u8 },
        }, gpa, resp.body, .{});
        defer p.deinit();
        // The `javascript:` record never crossed the wire: the allowlist is
        // applied server-side too, because the exporter reads this endpoint.
        try std.testing.expectEqual(@as(usize, 2), p.value.links.len);
        // 1-based page 2 → index 1; `none` → external, spelled -1.
        try std.testing.expectEqual(@as(i64, 1), p.value.links[0].page);
        try std.testing.expectEqual(@as(f64, 901), p.value.links[0].x);
        try std.testing.expectEqual(@as(i64, -1), p.value.links[1].page);
        try std.testing.expectEqualStrings("https://onplanners.com/g?a=1,2", p.value.links[1].uri);
    }

    // --- 404, one rule, four ways in: a stale version, a page with no link
    //     block, an out-of-range page, and no such note.
    const stale = "0" ** 32;
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
    // A missing `?v=` is the same stale case, not a 400.
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    // --- scope: no session → 401; a device token → 403 (cross-face).
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

    // --- ownership: the row is keyed by blob md5 and shared by dedup, so a
    //     second account holding byte-identical content must not reach this one.
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

    // --- the page list now carries `textHash`, which is what the reader's Text
    //     toggle keys off. Before this endpoint existed it was null everywhere.
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
    // ...and is OMITTED (not null, not "") for a page with no recognition.
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "textHash") == null);
    }

    // --- the happy path: `{ text }` with NO `{success}` envelope, revalidated.
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // This body is serialised from `PageTextVO`, so `?v=` versions its content
        // but not its SHAPE. It was `immutable` once and pinned a year of wordless
        // responses the day `words` was added — see the cache-policy pin below.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null); // raw VO
        var p = try std.json.parseFromSlice(struct { text: ?[]const u8 = null }, gpa, resp.body, .{});
        defer p.deinit();
        try std.testing.expectEqualStrings("Test\nMiddle", p.value.text.?); // v7: regions newline-joined
    }

    // --- 404, one rule, three ways in: a stale version, a page with no finished
    //     recognition, and an out-of-range page. All say "refetch the metadata".
    const stale = "0" ** 32;
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
    // A missing `?v=` entirely is the same stale case, not a 400.
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    // --- scope: no session → 401; a device token → 403 (cross-face).
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

    // --- ownership: the transcript row is keyed by blob md5 and shared by dedup,
    //     so a second account with byte-identical content must NOT reach this one.
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
    // The frontend's OCR transcript panel, in-note find, and the "has text"
    // badges key off two wire fields: per-note `hasRecognizedText` on the tree
    // listing, and per-page `textHash` on the note-detail page list. Assert both
    // light up for a note WITH finished recognition and stay dark for one without,
    // over the real transport (the FAKE api emits them in dev — this pins prod).
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const rec_id = try seedRecognizedNote(f, admin, "rec.note", &.{ "Test", "Middle" });
    const plain_id = try seedNoteHttp(f, admin, null, "plain.note", &.{"AAAA"}); // no recognition

    // --- /api/controlplane/tree → per-note `hasRecognizedText` ---
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
                // A finished-recognition note advertises true, so the badge shows
                // and the search filter includes it.
                try std.testing.expectEqual(true, e.hasRecognizedText.?);
            } else if (std.mem.eql(u8, e.name, "plain.note")) {
                saw_plain = true;
                // No finished recognition ⇒ false (the client reads `?? false`).
                try std.testing.expectEqual(false, e.hasRecognizedText.?);
            }
        }
        try std.testing.expect(saw_rec and saw_plain);
    }

    // --- /api/controlplane/note/{id} → per-page `textHash`: present on the
    //     recognized note's text-bearing page, absent everywhere on the plain one.
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
        // `textHash` is a distinct hash from the layer-bitmap `hash`.
        try std.testing.expect(!std.mem.eql(u8, p.value.pages[0].hash, p.value.pages[0].textHash.?));
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // OMITTED, not null and not "" — `emit_null_optional_fields = false`.
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
    // One element, four words, two of which are the device's NULL-box layout
    // separators. The boxes are millimetres on the 118.64 x 158.19 mm canvas.
    const elements = [_]nb.ElementSpec{.{ .label = "alpha beta", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10.5, .y = 20.25, .width = 30.5, .height = 8.125 } },
        .{ .label = "\n", .box = null },
        .{ .label = " ", .box = null },
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};

    const known_id = try seedRecognizedElements(f, admin, "known.note", "N6", &elements, false);
    // Same content, hardware we have never measured. `Dimensions.forEquipment`
    // still answers 1404x1872 for this — that fallback is exactly what must NOT
    // become a millimetre scale.
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

    // --- known hardware: the scale is advertised on the NOTE, not the page text.
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

    // --- unknown hardware: OMITTED, not zero and not the pixel table's default.
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

    // --- the boxes themselves, on the SAME endpoint the OCR panel already uses.
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ known_id, known_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // `words` ARRIVING HERE IS EXACTLY WHY THIS RESPONSE IS NOT IMMUTABLE.
        // `?v={textHash}` versions the transcript, not the struct around it, so
        // the browsers that had cached this URL before the field existed kept a
        // wordless copy for a year and silently drew nothing. Revalidated now.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);

        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();

        // The shipped `{text}` consumer is untouched by the new field.
        try std.testing.expectEqualStrings("alpha beta", p.value.text.?);

        // Two words, not four: the null-box separators are dropped rather than
        // defaulted to {0,0,0,0}, which would stack them both at the origin.
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

    // --- MILLIMETRES, verbatim: the payload is identical for the unknown device.
    //     The boxes are the device's own numbers and no scale is applied here, so
    //     hardware can only change `pxPerMm` above — never these values.
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

    // --- a recognized page with no positioned words at all omits `words`
    //     entirely rather than sending `[]` — same rule as every other optional.
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

test "control-plane OCR search: scope enforced, results are per-user, snippets are marked" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    // A second account whose note has BYTE-IDENTICAL content, so the blob store
    // dedups and both accounts' files point at one shared, md5-keyed transcript.
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));
    const labels = &[_][]const u8{"reunião de avaliação trimestral"};
    _ = try seedRecognizedNote(f, admin, "mine.note", labels);
    _ = try seedRecognizedNote(f, bob, "theirs.note", labels);
    // Deduped: one blob, one page row, one copy of the text.
    {
        var s = try f.db.prepare("SELECT COUNT(*) FROM note_page_index;");
        defer s.finalize();
        _ = try s.step();
        try std.testing.expectEqual(@as(i64, 1), s.columnInt(0));
    }

    // --- scope: no session → 401; a device token → 403 (cross-face) ---
    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search?q=trimestral", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN9");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search?q=trimestral", &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    const Body = struct {
        query: []const u8,
        hits: []const struct {
            noteId: []const u8,
            noteName: []const u8,
            pageIndex: i64,
            snippet: []const u8,
        },
    };

    // --- the happy path: percent-encoded, diacritic-folded, marked ---
    {
        // "avaliacao" (unaccented) must find "avaliação".
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search?q=avaliacao", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("avaliacao", p.value.query);
        // ONLY the caller's file, though the transcript row is shared with bob.
        try std.testing.expectEqual(@as(usize, 1), p.value.hits.len);
        try std.testing.expectEqualStrings("mine.note", p.value.hits[0].noteName);
        try std.testing.expectEqual(@as(i64, 0), p.value.hits[0].pageIndex);
        try std.testing.expect(std.mem.indexOf(u8, p.value.hits[0].snippet, "<mark>") != null);
    }
    {
        // A percent-encoded, accented, multi-word query.
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search?q=reuni%C3%A3o+trimestral&limit=5", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("reunião trimestral", p.value.query);
        try std.testing.expectEqual(@as(usize, 1), p.value.hits.len);
    }

    // A blank query is a normal empty result (search-as-you-type), not a 400.
    for ([_][]const u8{ "/api/controlplane/search", "/api/controlplane/search?q=", "/api/controlplane/search?q=%20" }) |path| {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 0), p.value.hits.len);
    }
    // A non-numeric limit is a client error.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search?q=x&limit=lots", &web_tok, "", 400);
}

test "control-plane note-scoped search: its own route, scoped like the note's other reads" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    // Byte-identical content again, so one deduplicated blob holds the single
    // copy of the transcript both accounts' files reference.
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));
    const labels = &[_][]const u8{"reunião de avaliação trimestral"};
    const mine = try seedRecognizedNote(f, admin, "mine.note", labels);
    const theirs = try seedRecognizedNote(f, bob, "theirs.note", labels);

    const mine_path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/search?q=avaliacao", .{mine});

    // --- scope: no session → 401; a device token → 403 (cross-face) ---
    {
        const req = try buildRequest(&reqbuf, "GET", mine_path, &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN9");
        const req = try buildRequest(&reqbuf, "GET", mine_path, &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    const Body = struct {
        query: []const u8,
        pages: []const struct { pageIndex: i64, matches: i64 },
    };

    // The happy path — and proof the nested route did not shadow (or get shadowed
    // by) `/api/controlplane/note/{id}`, which has no `pages[].matches`.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", mine_path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("avaliacao", p.value.query);
        try std.testing.expectEqual(@as(usize, 1), p.value.pages.len);
        try std.testing.expectEqual(@as(i64, 0), p.value.pages[0].pageIndex);
        try std.testing.expectEqual(@as(i64, 1), p.value.pages[0].matches);
    }

    // Bob's note, the caller's own transcript row — and still nothing. A foreign
    // id, a non-existent id and a blank query are one indistinguishable 200.
    const foreign = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/search?q=avaliacao", .{theirs});
    for ([_][]const u8{
        foreign,
        "/api/controlplane/note/99999/search?q=avaliacao",
    }) |path| {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 0), p.value.pages.len);
    }
    {
        const blank = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/search", .{mine});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", blank, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 0), p.value.pages.len);
    }
}

test "static SPA serving: index, assets, wasm, path-traversal refused, API precedence, disabled=404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // A fake built SPA (`dist/`): index.html + assets/x.js + note-decode.wasm.
    var web = std.testing.tmpDir(.{});
    defer web.cleanup();
    const index_html = "<!doctype html><title>SPA</title>";
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "index.html", .data = index_html });
    var assets = try web.dir.createDirPathOpen(std.testing.io, "assets", .{});
    assets.close(std.testing.io);
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/x.js", .data = "console.log(1)" });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "x.wasm", .data = "\x00asm\x01\x00\x00\x00" });

    // The tmp dir lives at `.zig-cache/tmp/<sub_path>` relative to cwd (the repo
    // root, where the tests run) — which is what the static server opens against.
    var wd_buf: [256]u8 = undefined;
    ctx.config.web_dir = try std.fmt.bufPrint(&wd_buf, ".zig-cache/tmp/{s}", .{web.sub_path});

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // GET / -> index.html with text/html.
    //
    // THE SPA SHELL MUST NOT BE IMMUTABLY CACHEABLE, and it must state a policy
    // rather than leaving one to be guessed. It is the one file whose URL never
    // changes and the one that POINTS AT the current hashed bundle, so a stale
    // copy pins the whole app to an old build. It shipped with no `cache-control`,
    // no `ETag` and no `Last-Modified` at all, which drops browsers into heuristic
    // freshness — a rebuilt app kept serving old behaviour until site data was
    // cleared by hand. `no-cache` still permits storage; it forbids blind reuse.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(index_html, resp.body);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/html") != null);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "max-age") == null);
    }

    // GET /index.html -> same file (explicit path), same policy. Both URLs reach
    // the shell, so a policy that only covered one of them would not cover it.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/index.html", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(index_html, resp.body);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
    }

    // GET /assets/x.js -> correct content-type + immutable cache header.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("console.log(1)", resp.body);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/javascript") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") != null);
    }

    // GET /note-decode.wasm-style single segment -> application/wasm (the renderer prefers it).
    //
    // Un-fingerprinted, so it revalidates like the shell — and here that is
    // load-bearing rather than hygiene: this is the SNPG decoder, and the page
    // payloads it decodes ARE cached for a year. A decoder that could lag behind
    // its own payload format is the one way that immutable page cache turns bad.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/x.wasm", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: application/wasm") != null);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
    }

    // Path traversal must never escape web_dir -> 403 (not a file read).
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/../../etc/passwd", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    // A missing static file (no SPA fallback — hash routing) -> 404.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/does-not-exist.js", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    // API routes take precedence: /api/version still hits the handler, not static.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/api/version", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(app.api_version, resp.body); // the handler ran, not static
    }

    // With static serving disabled (web_dir empty), an unmatched route still 404s.
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

    // A fake built SPA where one asset ships precompressed siblings and another
    // does not. The server just streams whichever file it picks — the sibling
    // bytes are DISTINCT sentinels (not real gzip/brotli), so the response body
    // proves which variant was chosen without decompressing anything.
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
    // A second asset with NO precompressed siblings: even an accepting client
    // must get the raw bytes.
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/y.css", .data = "body{color:red}" });

    var wd_buf: [256]u8 = undefined;
    ctx.config.web_dir = try std.fmt.bufPrint(&wd_buf, ".zig-cache/tmp/{s}", .{web.sub_path});

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // br accepted AND a .br exists -> serve the .br bytes, Content-Encoding: br,
    // the BASE Content-Type (text/javascript, not the suffix), Vary, and the
    // base path's immutable cache policy (assets/*).
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

    // gzip accepted, br NOT accepted -> serve the .gz bytes, Content-Encoding: gzip.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "gzip, deflate" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(gz, resp.body);
        try expectHeaderContains(resp.head, "content-encoding: gzip");
        try expectHeaderContains(resp.head, "vary: accept-encoding");
    }

    // No Accept-Encoding -> raw bytes, no Content-Encoding, no Vary.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(raw, resp.body);
        try expectHeaderAbsentSubstring(resp.head, "content-encoding:");
        try expectHeaderAbsentSubstring(resp.head, "vary:");
    }

    // identity only -> raw, no Content-Encoding (neither br nor gzip accepted).
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "identity" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(raw, resp.body);
        try expectHeaderAbsentSubstring(resp.head, "content-encoding:");
    }

    // br;q=0, gzip -> q=0 disables br, so gzip wins even though a .br exists.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "br;q=0, gzip" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(gz, resp.body);
        try expectHeaderContains(resp.head, "content-encoding: gzip");
    }

    // A variant absent (y.css has no .br/.gz) -> raw even when br is accepted.
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

/// `requestWithCookie` plus a `Range` header — the byte routes' one conditional
/// input. Separate rather than an optional parameter so every existing caller
/// stays a plain read.
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

    // Serve mode gives ctx a db_lock so the per-connection threads serialize DB
    // access; the other integration tests leave it null (single-threaded). Wire one
    // here so transport.handle's lock/unlock path is exercised — a dropped unlock
    // would deadlock the second request below, and a mislocked path would fault.
    var lock: std.Io.Mutex = .init;
    f.ctx.db_lock = &lock;
    const ctx = &f.ctx;

    _ = try f.svc.bootstrapAdmin("admin", "temp0000");

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    // Two sequential DB-touching requests under the same lock: both must succeed,
    // proving the lock is acquired and released around each whole handler.
    for (0..2) |_| {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"admin\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
    }
}

test "manual_db_lock is set on EXACTLY the two /oss routes, the page route, the raw-file routes, the thumbnail route, the SSE route, the device list_folder route and the web upload route" {
    // Pinned deliberately. `manual_db_lock` opts a route OUT of the automatic
    // whole-handler DB lock, so flagging a route whose handler touches the DB
    // without taking `ctx.db_lock` itself is a silent data race on the shared
    // SQLite connection — no crash, no failing assertion, just corruption under
    // concurrency. Adding a route here means auditing that handler's DB touches.
    // `/note/:id/page/:n` joined the set once its handler was narrowed to lock
    // only its single `files.get` (the blob read + parse now run unlocked).
    // `/file/:id` joined for the same reason and with the same audit: ONE
    // `files.get` under `ctx.db_lock`, then a pure blob→socket stream with the
    // lock released (a multi-MB PDF must not hold the global lock for its
    // download). Its handler touches the DB nowhere else.
    //
    // `/api/controlplane/events` joined for the SHARPEST version of the argument:
    // it holds its connection open for minutes, so the automatic whole-handler
    // lock would park the one global DB lock for the stream's whole lifetime and
    // block device sync behind an open browser tab. Audited the same way — its
    // only DB touches are two `files.syncVersion` reads, each in its own
    // `ctx.lockDb()`/`unlockDb()` bracket, with the lock held across neither the
    // poll sleep nor a socket write.
    //
    // The two BIN preview byte routes are the same two handlers as
    // `/note/:id/page/:n` and `/file/:id` — literally, via `pageBytes`/`rawFile`
    // — differing only in whether the entry is looked up live or trashed, so the
    // audit that admitted the originals covers them exactly.
    //
    // `/thumbnail/:hash` joined when its bytes moved from a DB BLOB to the
    // `thumbs/` derived store. Audited: ownership check + `thumbNeedsRepair`
    // gate (a blob-magic dispatch over both formats' memos) in ONE
    // `ctx.lockDb()` window, then — with the lock RELEASED — the optional
    // on-demand derive (`Files.repairDerivedThumb`: the `.spd` deserialize or
    // the `.note` cover parse, taking the lock itself only around its brief
    // row write; lock order repair-mutex → db-lock), then a pure fs→socket
    // stream. It touches the DB nowhere else, and the repair path is exactly
    // why it CANNOT hold the whole-handler lock: a 16 MiB untrusted-SQLite
    // deserialize (or a container parse) under the one global lock would stall
    // every request, and re-locking inside would deadlock the non-reentrant
    // mutex.
    //
    // `/api/file/2/files/list_folder` joined for the same shape as the SSE route: a
    // DEVICE route whose default whole-handler lock made it the burst-sync
    // monopolizer (~1 s under lock, ~11× `/tree`). Audited: its ONLY DB touches are
    // the scoped `resolvePath` + `walkChildren`/`walkSubtree`/`walkTree` inside one
    // `ctx.lockDb()`/`unlockDb()` bracket; the per-entry VO build and `json.respond`
    // run with the lock released.
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
        // The per-version preview is the same `writePageResponse` streaming tail as
        // `/note/:id/page/:n`, only keyed by the history `:md5` — its gate + plan
        // run in one `ctx.lockDb()` window, then the SNPG payload streams unlocked.
        "/api/controlplane/note/:id/history/:md5/page/:n",
        // The per-version RAW blob is the same `streamRawBlob` tail as `/file/:id`,
        // only keyed by the history `:md5` — its `historyVersion` gate + name lookup
        // run in one `ctx.lockDb()` window, then the blob streams unlocked.
        "/api/controlplane/note/:id/history/:md5/raw",
        // The bin history byte streamers are the SAME two handlers as their live
        // history twins (via `historyPage`/`historyRaw`), differing only in the gate's
        // scope (`historyVersionIn(.trashed)`) — the audit that admitted the originals
        // covers them exactly.
        "/api/controlplane/bin/note/:id/history/:md5/page/:n",
        "/api/controlplane/bin/note/:id/history/:md5/raw",
        // The web upload is the `/oss/put` argument on the browser face: a
        // multi-MB body streamed socket → md5 → filesystem, which must not hold
        // the one global lock for the transfer. Audited: its ONLY DB touches are
        // the destination `files.get` and the final `placeUpload` + `entryVO`,
        // each in its own `ctx.lockDb()`/`unlockDb()` bracket, with the ingest
        // between them touching the DB not at all.
        "/api/controlplane/folder/:id/upload",
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

// ---- the cache-policy pin ----------------------------------------------------
//
// THE RULE, and the only rule: a response may be `cache-control: immutable` only
// when its cache key covers EVERYTHING that can change about it. A content hash
// covers opaque bytes. It does not cover a Zig struct, which can gain or lose a
// field on any deploy while the key sits still.
//
// Both halves of this are pinned below because both halves have already been got
// wrong, silently, in production:
//
//   * `/note/:id/page/:n/text` was `immutable, max-age=1y` keyed on the
//     transcript's md5. When `PageTextVO` gained `words`, every browser that had
//     already fetched a page kept its old, wordless copy for a YEAR, on a URL that
//     could never change and with no validator to revalidate against. Nothing
//     errored: `pxPerMm` arrived (note metadata is not immutably cached), the match
//     counter was right (a different request), and the page just had nothing
//     circled on it. It presented as "broken for this note, fine for that one",
//     because different notes had been cached at different moments.
//   * `index.html` carried NO cache policy at all — no `Cache-Control`, no `ETag`,
//     no `Last-Modified` — so browsers fell back to heuristic freshness on the one
//     file whose URL never changes and which points at the current hashed bundle.
//     A rebuilt app kept serving the old build until site data was cleared by hand.
//
// Both failures are silent, which is why the guard is an EXHAUSTIVE classification
// of the route table rather than a spot check: a route added tomorrow does not get
// to quietly join the immutable set, and does not get to skip the decision either.

/// The ONLY routes allowed to answer `immutable`. Both serve opaque bytes under a
/// `?v=` that is the md5 of those exact bytes, and both 404 a mismatch — so the
/// URL is genuinely content-addressed and a year-old entry cannot outlive what it
/// described. Neither serialises a Zig struct into its body.
///
/// `/note/:id/page/:n` wraps its bytes in a 20-byte SNPG envelope that `?v=` does
/// NOT cover. That is bounded on purpose: SNPG is self-describing and versioned in
/// band (`page_payload.MAGIC`/`VERSION`) and the decoder rejects a mismatch loudly,
/// and the decoder itself (`/note-decode.wasm`) is un-fingerprinted and therefore
/// revalidated, so it can never lag its own payload format.
/// The two bin-preview twins qualify on identical grounds: same handlers, same
/// content-addressed `?v=`, same 404-on-mismatch. Trashing does not change the
/// bytes or the hash — it only hides the row — so a cached preview can never
/// outlive what it described any more than the live route's can.
/// `/thumbnail/:hash` qualifies on the same ground: the URL is the SOURCE blob
/// md5, and the thumbnail is derived once from that immutable content and stored
/// verbatim (write-once — re-ingest of dedup'd bytes does not re-extract), so a
/// given hash maps to the same opaque image bytes forever. No Zig struct is
/// serialised into the body. It has no `?v=`/404-on-mismatch because the address
/// IS the content key; a hash the caller does not hold 404s, which caches nothing
/// harmful (the miss is not `immutable` — `reply.notFound` sends no cache header).
/// `/note/:id/template/:hash` qualifies exactly as `/thumbnail/:hash` does: the
/// URL is content-addressed by the template's asset hash and the bytes are the
/// stored image, immutable and never re-encoded, so a given hash maps to the
/// same bytes forever. No Zig struct is serialised into the body; a foreign or
/// absent hash 404s (which caches nothing).
/// `/api/controlplane/note/:id/history/:md5/page/:n` qualifies for a REASON the
/// live page route needs `?v=` to earn: the URL's `:md5` IS the whole blob's
/// content key, so page `n`'s opaque SNPG bytes can never change under this URL
/// (a fixed blob is fixed forever) — the content addressing `?v=` buys the live
/// route, `:md5` buys this one for free. No Zig struct in the body; a `:md5` not
/// in the file's history 404s (which caches nothing).
/// `/api/controlplane/note/:id/history/:md5/raw` is the raw-blob twin of that,
/// and qualifies identically: the URL's `:md5` IS the whole blob's content key, so
/// the opaque raw bytes can never change under this URL — exactly what `?v=` buys
/// the live `/file/:id`, `:md5` buys this one for free. No Zig struct in the body;
/// a `:md5` not in the file's history 404s (which caches nothing).
/// The two BIN history byte twins qualify on IDENTICAL grounds to their live
/// history counterparts: same handlers, same `:md5`-pins-the-whole-blob content
/// addressing, same 404-on-miss. Trashing hides the row, never the bytes or the
/// hash, so a cached preview can no more outlive what it described than the live
/// history route's can.
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
};

/// EVERY OTHER ROUTE IN THE TABLE. Adding a route without listing it here (or in
/// `immutable_routes`) fails the test — that is the entire point. JSON belongs
/// here by construction: it is serialised from a struct, so its shape is not in
/// its cache key.
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
    "/api/controlplane/bin/note/:id/search",
    "/api/controlplane/bin/note/:id/history",
    "/api/controlplane/bin/note/:id/history/:md5/page/:n/text",
    "/api/controlplane/bin/note/:id/history/:md5/search",
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
    "/api/controlplane/note/:id/history/:md5/search",
    "/api/controlplane/note/:id/search",
    "/api/controlplane/note/:id/txt-search",
    "/api/controlplane/search",
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
    // Half one: the classification is EXHAUSTIVE and unambiguous over the live
    // route table. A new route is unclassified and fails here; a deleted route
    // leaves a stale entry and fails here too.
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
    try std.testing.expectEqual(@as(usize, 10), immutable_routes.len);
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

    // --- the two routes that MAY be immutable, on their 200 path ---
    const allowed = [_][]const u8{
        try std.fmt.bufPrint(pbuf[0..96], "/note/{d}/page/0?v={s}", .{ note_id, page_hash[0..] }),
        try std.fmt.bufPrint(pbuf[96..], "/file/{d}?v={s}", .{ pic.id, pic.md5[0..] }),
    };
    for (allowed) |path| {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
    }

    // --- and NOT on their 404 path. A stale `?v=` means "your metadata is old";
    //     answering that with a year-long immutable entry would cache the miss.
    {
        const stale = [_][]const u8{
            try std.fmt.bufPrint(pbuf[0..96], "/note/{d}/page/0?v={s}", .{ note_id, "0" ** 32 }),
            try std.fmt.bufPrint(pbuf[96..], "/file/{d}?v={s}", .{ pic.id, "0" ** 32 }),
        };
        for (stale) |path| {
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
            try std.testing.expectEqual(@as(u16, 404), resp.status);
            try expectHeaderAbsentSubstring(resp.head, "immutable");
        }
    }

    // --- every OTHER GET route the fixture can drive: no `immutable`, ever.
    //     Statuses differ (200/403/404) and that is fine — the assertion is about
    //     the cache policy, which must hold on every path out of the handler.
    const others = [_][]const u8{
        "/api/version",
        "/api/user/me",
        "/api/file/query/server",
        "/api/controlplane/tree",
        "/api/controlplane/bin",
        "/api/controlplane/account",
        "/api/controlplane/account/storage",
        "/api/controlplane/search?q=Test",
        "/api/controlplane/events",
        "/api/admin/users",
        "/oss/get/1?t=deadbeefdeadbeefdeadbeefdeadbeef",
        try std.fmt.bufPrint(pbuf[0..96], "/api/controlplane/file/metadata/{d}", .{note_id}),
        try std.fmt.bufPrint(pbuf[96..176], "/api/controlplane/note/{d}/search?q=Test", .{note_id}),
        try std.fmt.bufPrint(pbuf[176..], "/note/{d}/page/0/text?v={s}", .{ note_id, text_hash[0..] }),
    };
    for (others) |path| {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try expectHeaderAbsentSubstring(resp.head, "immutable");
    }

    // The page-text route specifically: it is the one that regressed, so pin the
    // exact policy rather than only the absence of `immutable`.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ note_id, text_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
    }
}

/// Fails if `needle` appears anywhere in the response head. Substring, not a
/// header-name match: `immutable` is a cache-control TOKEN, and the point is that
/// it must not appear under any header whatsoever.
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

    // `tryLock` succeeds only on an unlocked mutex, so it detects a leaked
    // acquire. The manual path has THREE windows (resolveCaller, plus the
    // handler's own) against the normal path's one, so an unbalanced
    // lock/unlock is a real risk — assert balance after each dispatch.
    const expectUnlocked = struct {
        fn check(m: *std.Io.Mutex) !void {
            try std.testing.expect(m.tryLock()); // would fail if handle() leaked the lock
            m.unlock(std.testing.io);
        }
    }.check;

    try expectUnlocked(&lock); // sanity: the guard can tell "unlocked"

    // A normal (whole-handler lock) route.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"admin\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try expectUnlocked(&lock);

    // A manual_db_lock route, served successfully: /oss/get with a valid token.
    // Also asserts the narrowed lock windows didn't break the read path — the
    // response must still be the exact blob bytes.
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

    // A manual_db_lock route on its ERROR path (bad token → 403 before any DB
    // touch): the resolveCaller window must still be released.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}?t=deadbeefdeadbeefdeadbeefdeadbeef", .{file_id});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
    try expectUnlocked(&lock);

    // The OTHER manual_db_lock route: /note/{id}/page/{n}. Same three windows
    // (resolveCaller + the handler's own lookup-and-plan), and the payload is
    // STREAMED off the blob with the lock RELEASED — so assert both that the
    // bytes are still right and that the lock came back.
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

    // And its 404 path (stale `?v=`), which returns after the handler's own lock
    // window has already opened and closed.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ note_id, "0" ** 32 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    try expectUnlocked(&lock);

    // The THIRD control-plane manual_db_lock route: /file/{id}. Its whole reason
    // for the flag is that the blob→socket transfer runs with the lock RELEASED,
    // so assert both the bytes and the balance, on the served and the 404 path.
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
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ pic.id, "0" ** 32 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    try expectUnlocked(&lock);
}

/// `putSeed`, but also returning the stored blob's md5 — the `?v=` version the
/// raw-file route requires.
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

/// The `head` of a response, lowercased into `buf`, for case-insensitive header
/// assertions. (`std.http.Server` writes our `extra_headers` verbatim, but an
/// assertion that depends on that is an assertion about the wrong thing.)
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
    // Mallory's sessions must be established BEFORE her device login: changing a
    // password revokes every session the user holds, device tokens included.
    const mtok = try onboardWeb(ctx, "mallory", "mpass111", "mallorypw1");
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "mallory", "mallorypw1", "SN9");

    const png_bytes = "\x89PNG\r\n\x1a\n not really a png, but exactly these bytes";
    const png = try putSeedHashed(f, admin, null, "20260719_165902_Page_1.png", png_bytes);

    // --- the happy path: exact bytes, exact length, inline, cacheable ---
    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ png.id, png.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(png_bytes, resp.body);

        // Content-Length is DECLARED (from `files.size`), not measured — so the
        // response is a plain sized body and never chunked.
        var lbuf: [64]u8 = undefined;
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-length: {d}", .{png_bytes.len}));
        try expectHeaderAbsent(resp.head, "transfer-encoding");

        try expectHeaderContains(resp.head, "content-type: image/png");
        try expectHeaderContains(resp.head, "content-disposition: inline;");
        try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "etag: \"{s}\"", .{png.md5[0..]}));
    }

    // --- RANGE: the PDF viewer's transport ---
    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ png.id, png.md5[0..] });
        var lbuf: [80]u8 = undefined;

        // Advertised on a PLAIN reply too — that is how a client learns it may ask.
        {
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
            try expectHeaderContains(resp.head, "accept-ranges: bytes");
        }

        // A window: 206, the exact bytes, an inclusive content-range, and a
        // content-length of the WINDOW rather than the file.
        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, "bytes=4-11");
            try std.testing.expectEqual(@as(u16, 206), resp.status);
            try std.testing.expectEqualStrings(png_bytes[4..12], resp.body);
            try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-range: bytes 4-11/{d}", .{png_bytes.len}));
            try expectHeaderContains(resp.head, "content-length: 8");
        }

        // Open-ended: to the end.
        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, "bytes=10-");
            try std.testing.expectEqual(@as(u16, 206), resp.status);
            try std.testing.expectEqualStrings(png_bytes[10..], resp.body);
        }

        // SUFFIX: the last 5 bytes, not the first 5. Read as an offset this would
        // serve the front of the file — which for a PDF is the one place its
        // trailer certainly is not, so every document would fail to open.
        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, "bytes=-5");
            try std.testing.expectEqual(@as(u16, 206), resp.status);
            try std.testing.expectEqualStrings(png_bytes[png_bytes.len - 5 ..], resp.body);
        }

        // Past the end is 416 WITH the unsatisfied-range form, not a 200 and not
        // a 404: the client needs the size to correct itself.
        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, "bytes=99999-");
            try std.testing.expectEqual(@as(u16, 416), resp.status);
            try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-range: bytes */{d}", .{png_bytes.len}));
        }

        // Malformed and multi-range are IGNORED — 200 with everything, per
        // RFC 9110 — rather than refused. A client that asks badly still reads.
        for ([_][]const u8{ "bytes=abc", "bytes=9-2", "bytes=0-3,8-11", "items=0-3" }) |bad| {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &web_tok, bad);
            try std.testing.expectEqual(@as(u16, 200), resp.status);
            try std.testing.expectEqualStrings(png_bytes, resp.body);
        }

        // A range still obeys the route's other rules: ownership is checked
        // BEFORE any of this, so a foreign caller gets the same 404 it always did
        // rather than a 206 leaking a window of someone else's file.
        {
            const resp = try requestRanged(ctx, &obuf, &reqbuf, path, &mtok, "bytes=0-3");
            try std.testing.expectEqual(@as(u16, 404), resp.status);
        }
    }

    // --- the SAME route, forced to a download ---
    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}&download=1", .{ png.id, png.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(png_bytes, resp.body);
        try expectHeaderContains(resp.head, "content-disposition: attachment;");
    }

    // --- the allowlist, type by type ---
    const Case = struct { name: []const u8, mime: []const u8, disposition: []const u8 };
    const cases = [_]Case{
        .{ .name = "a.jpg", .mime = "image/jpeg", .disposition = "inline" },
        .{ .name = "a.JPEG", .mime = "image/jpeg", .disposition = "inline" }, // case-insensitive
        .{ .name = "a.webp", .mime = "image/webp", .disposition = "inline" },
        .{ .name = "a.gif", .mime = "image/gif", .disposition = "inline" },
        .{ .name = "a.pdf", .mime = "application/pdf", .disposition = "inline" },
        // THE SVG CASE. An image by every other definition, but an XML document
        // that browsers execute script from — inline from our own origin would be
        // stored XSS with the session cookie in reach. Attachment, always.
        .{ .name = "a.svg", .mime = "application/octet-stream", .disposition = "attachment" },
        .{ .name = "a.html", .mime = "application/octet-stream", .disposition = "attachment" },
        .{ .name = "a.note", .mime = "application/octet-stream", .disposition = "attachment" },
        .{ .name = "a.spd", .mime = "application/octet-stream", .disposition = "attachment" },
        .{ .name = "noextension", .mime = "application/octet-stream", .disposition = "attachment" },
    };
    for (cases, 0..) |c, i| {
        // Distinct bytes per case so dedup can't collapse them onto one blob.
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
        // nosniff is unconditional: it is what stops a wrong label being
        // "corrected" into text/html by content sniffing.
        try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
    }

    // --- a device-authored filename carrying a quote and a CRLF ---
    {
        const nasty = "ev\"il\r\nX-Injected: yes.png";
        const bytes = "nasty-name-bytes";
        const seed = try putSeedHashed(f, admin, null, nasty, bytes);
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ seed.id, seed.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");

        // The response must still parse as ONE response with an intact body: if
        // the CRLF had reached the wire, the head would have ended early and the
        // body would be wrong.
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(bytes, resp.body);
        // The forged name survives only as TEXT inside one header's value — never
        // as a header of its own. That is the whole property: no CRLF reached the
        // wire, so no new header line was ever started.
        try expectHeaderAbsent(resp.head, "\r\nx-injected:");
        try expectHeaderContains(resp.head, "content-disposition: inline; filename=\"ev_il__x-injected_ yes.png\"");
        try expectHeaderContains(resp.head, "content-type: image/png");
        // status + 7 headers, no extras. The 7th is `accept-ranges`, added when
        // the route learned to serve byte ranges — and this count is deliberately
        // exact rather than a lower bound, because the property under test is
        // that a forged filename cannot MANUFACTURE a header line.
        try std.testing.expect(std.mem.count(u8, resp.head, "\r\n") == 7);
    }

    // --- versioning: `?v=` is required, and must name the bytes we hold ---
    {
        const bare = try std.fmt.bufPrint(&pbuf, "/file/{d}", .{png.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", bare, &web_tok, "", 404);
        const stale = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ png.id, "0" ** 32 });
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", stale, &web_tok, "", 404);
    }

    // --- ownership: another user's file is 404, NOT 403 ---
    // 403 would confirm the id exists and belongs to somebody, making the route an
    // existence oracle over the id space. `files.get` is user-scoped, so a foreign
    // id and a missing id are genuinely the same answer.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ png.id, png.md5[0..] });
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &mtok, "", 404);
        // And a folder / absent id, for the same 404.
        const ghost = try std.fmt.bufPrint(&pbuf, "/file/999999?v={s}", .{png.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", ghost, &web_tok, "", 404);
    }

    // --- auth: no session is 401; a DEVICE session is 403 (wrong face) ---
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
    // Task B pin: `/file/:id?v={hash}` is the ONE universal raw-bytes primitive —
    // it returns the exact stored bytes of ANY file, `.note` included (it is the
    // `.note` download path the reader builds via `rawFileUrl(..., {download:true})`).
    // The per-page SNPG route (`/note/:id/page/:n`) is a `.note` RENDER convenience
    // layered on top, NEVER the way to fetch `.note` bytes, and there is deliberately
    // no `.note`-specific download route: this SAME handler serves it like any blob.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    // A representative `.note` blob: the container magic + ~2 KiB of opaque bytes.
    // `/file` never parses it; the property under test is that the bytes flow
    // through the shared raw route unchanged.
    var note_bytes: [2048]u8 = undefined;
    const magic = "noteSN_FILE_VER_20230015";
    @memcpy(note_bytes[0..magic.len], magic);
    for (note_bytes[magic.len..], magic.len..) |*b, i| b.* = @truncate(i * 31 + 7);

    const note = try putSeedHashed(f, admin, null, "diary.note", &note_bytes);

    const path = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ note.id, note.md5[0..] });
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    // EXACT bytes, byte-for-byte — the same handler the `.spd`/`.txt`/image viewers hit.
    try std.testing.expectEqualStrings(&note_bytes, resp.body);

    // A `.note` is opaque to the browser and never on the inline allowlist, so the
    // disposition is `attachment` (a download), exactly what the reader intends.
    try expectHeaderContains(resp.head, "content-type: application/octet-stream");
    try expectHeaderContains(resp.head, "content-disposition: attachment;");
    try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
    // Same content-addressed cache contract as every other blob on this route.
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

    // Larger than `blobstore.chunk_len` (64 KiB) by more than one whole chunk, so
    // the transfer HAS to loop — and, deliberately, not a multiple of it, so a
    // short final chunk is exercised too. If the endpoint ever regressed to a
    // read-it-all-then-send, this is still the test that stays green — the memory
    // claim is upheld by the fixed `[chunk_len]u8` buffers in the handler, which
    // no black-box test can observe. What this DOES prove is that the chunked pump
    // reassembles byte-exactly across buffer boundaries.
    const big_len = 150 * 1024 + 7;
    const big = try gpa.alloc(u8, big_len);
    defer gpa.free(big);
    for (big, 0..) |*b, i| b.* = @truncate(i *% 31 +% 7);

    const seed = try putSeedHashed(f, admin, null, "scan.pdf", big);

    const obuf = try gpa.alloc(u8, 1 << 19);
    defer gpa.free(obuf);

    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    // The listing must advertise the version the raw route requires — otherwise
    // the URL simply cannot be built.
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

/// A minimal `.spd` (an SQLite db with a `config` table), serialized to bytes —
/// hermetic, no committed binary. `thumbnail` is the raw image blob to embed, or
/// null to omit the `thumbnail` row (an "empty" drawing). Mirrors the fixture
/// builder in `services/thumbnail.zig`'s own tests.
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

    const jpeg = "\xff\xd8\xff\xe0" ++ ("supernote-thumbnail-pixels" ** 8);

    // A `.spd` carrying an embedded JPEG thumbnail, ingested by admin. Extraction
    // rode `linkBlob` at put time, so serving is now a lookup.
    const spd = try buildSpdFixture(jpeg);
    defer gpa.free(spd);
    const drawing = try putSeedHashed(f, admin, null, "drawing.spd", spd);

    // --- 200: the extracted bytes, the SNIFFED Content-Type, immutable caching,
    //     and an exact Content-Length (streamed from `thumbs/`, not chunked).
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

    // --- 404: a `.txt` ships no embedded thumbnail. But `/file/{id}` DOES serve
    //     the `.txt` bytes (the client renders its snippet from them).
    const txt_body = "The quick brown fox.\nA second line the client would raster.\n";
    const note = try putSeedHashed(f, admin, null, "readme.txt", txt_body);
    {
        const tpath = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{note.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", tpath, &admin_tok, "", 404);
    }
    {
        // The `.txt` head-serving path the frontend relies on for text previews.
        const fpath = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ note.id, note.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", fpath, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(txt_body, resp.body);
    }

    // --- 404: a corrupt/garbage `.spd` skips cleanly at ingest — the upload still
    //     succeeds (putSeedHashed returned an id), it simply has no thumbnail.
    const corrupt = try putSeedHashed(f, admin, null, "broken.spd", "SQLite format 3\x00 then total garbage \xff\x00\xab");
    {
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{corrupt.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    }

    // --- 404: a malformed / non-32-hex hash is not even a lookup.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/thumbnail/not-a-hash", &admin_tok, "", 404);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/thumbnail/ffffffffffffffffffffffffffffffff", &admin_tok, "", 404);

    // --- 404: OWNERSHIP. Bob ingests his own `.spd` (a real thumbnail row exists,
    //     keyed by its md5), but admin does not hold that blob — so to admin it is
    //     indistinguishable from "no thumbnail". A foreign holder is no oracle.
    const bob_spd = try buildSpdFixture("\x89PNG\r\n\x1a\n" ++ ("bobs-private-drawing" ** 4));
    defer gpa.free(bob_spd);
    const bob_drawing = try putSeedHashed(f, bob, null, "secret.spd", bob_spd);
    {
        // The row exists (bob can read it — proven by seeding through the same path).
        try std.testing.expect(try f.files.holdsBlob(bob, &bob_drawing.md5));
        try std.testing.expect(!try f.files.holdsBlob(admin, &bob_drawing.md5));
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{bob_drawing.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    }

    // --- auth: no cookie at all is 401, not 404 (the auth layer runs first).
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

    const jpeg = "\xff\xd8\xff\xe0" ++ ("regenerate-me" ** 8);
    const spd = try buildSpdFixture(jpeg);
    defer gpa.free(spd);
    const drawing = try putSeedHashed(f, admin, null, "drawing.spd", spd);
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{drawing.md5[0..]});

    // Served once from the ingest-derived file.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    // Delete the derived file behind its back — a restore that (correctly)
    // skipped the backup-skippable `thumbs/` dir. The serve path must notice
    // (`needsRepair`: the row claims a thumbnail, the file is gone), re-derive
    // off the db lock, and serve the regenerated bytes — no restart, no sweep.
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

    // SQLite magic + garbage: passes the cheap pre-check, fails the real open,
    // so ingest memoized `indexable = 0`. Wipe the row to simulate a pre-v13
    // database, so the FIRST GET below is what pays the derive.
    const corrupt = try putSeedHashed(f, admin, null, "broken.spd", "SQLite format 3\x00 then total garbage \xff\x00\xab");
    try f.db.exec("DELETE FROM spd_index;");
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{corrupt.md5[0..]});

    // First GET: repairs (writes the indexable = 0 memo row), serves 404.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("SELECT indexable FROM spd_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &corrupt.md5);
        try std.testing.expect(try s.step()); // the memo row exists
        try std.testing.expectEqual(@as(i64, 0), s.columnInt(0)); // recorded as unparseable
    }

    // Plant a sentinel timestamp: a re-derive would upsert `indexed_at = now()`
    // and clobber it, so its survival across the next GET proves NO second
    // derive happened (equality of two real now() calls would prove nothing).
    try f.db.exec("UPDATE spd_index SET indexed_at = 12345;");

    // Second GET: the memo short-circuits `needsRepair` — 404 with NO re-derive.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("SELECT indexed_at FROM spd_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &corrupt.md5);
        try std.testing.expect(try s.step());
        try std.testing.expectEqual(@as(i64, 12345), s.columnInt(0));
    }
}

/// A real minimal PNG head (320×240 IHDR): sniffs as image/png AND yields dims —
/// the shape a `.note` cover fixture needs (the device writes complete PNGs).
const cover_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++
    "\x08\x02\x00\x00\x00" ++ ("p" ** 16);

/// A one-page synthetic `.note`, optionally carrying `cover` as its `COVER_2`
/// footer block — hermetic, via the parser package's builder.
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

    // --- 200: the cover STREAMED from the blob at the location the ingest parse
    //     recorded, recorded Content-Type, immutable caching, exact
    //     Content-Length — the identical serve contract the `.spd` thumbnail
    //     answers under, through the identical route.
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

    // --- 404, memoized: a coverless `.note` (the common case — covers are
    //     user-set). The sentinel timestamp proves the second GET did NOT
    //     re-parse: any re-derive would upsert `indexed_at = now()` over it.
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

    // A `.note` cover streams from the immutable blob — ingest writes NO thumbs
    // file. Served once from the location the ingest parse recorded.
    try std.testing.expect(!f.files.thumbs.has(&note.md5));
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
    }

    // Wipe the index row entirely — a pre-index (pre-cover-location) blob. The
    // magic dispatch must route the re-derive to the `.note` cover parse, which
    // repopulates the row's recorded cover location, and the next GET streams
    // the cover straight from the blob. Segment rows are derived state too;
    // their FK blocks deleting pages from under them, so wipe them first (a
    // pre-index database simply never had them).
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('delete-all');");
    try f.db.exec("DELETE FROM segment_search;");
    try f.db.exec("DELETE FROM note_index;");
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/png");
    }
    // The row healed: a current row now carries the cover location again.
    {
        var sqlbuf: [160]u8 = undefined;
        const sql = try std.fmt.bufPrintZ(&sqlbuf, "SELECT cover_offset IS NOT NULL FROM note_index WHERE blob_md5 = ?1 AND index_version = {d};", .{noteindex.index_version});
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

    // Owner: 200, the template bytes verbatim, an image content-type, immutable.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/template/{s}", .{ note.id, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/png");
        try expectHeaderContains(resp.head, "immutable");
    }
    // A hash no page of this note references: 404.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/template/{s}", .{ note.id, "00000000000000000000000000000000" });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    // A note id that does not exist (or is not owned): 404, indistinguishable.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/template/{s}", .{ note.id + 999, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

// ---- /api/controlplane/events: the held SSE stream ----
//
// These are the tests that matter for the lock discipline. The failure they
// guard against is INVISIBLE in normal use: a stream that holds the global
// `db_lock` for its lifetime serves the browser perfectly (it is the thing
// holding the lock) while silently freezing every other caller — above all the
// device, whose sync would just stop while the web UI looked healthy. Nothing
// short of driving a held stream and a concurrent request through `handle()` at
// the same time can catch it.

/// Runs ONE `/api/controlplane/events` request on its own thread, mirroring what
/// `connThread` does in serve mode: its own `Context` copy (so the per-request
/// `caller` stays thread-local) and its own buffers. Keeps the raw response so a
/// test can assert on the frames the stream emitted.
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

    /// Block until the stream has actually taken its slot, so a test never races
    /// the spawn and ends up asserting against a stream that never started.
    fn waitUntilHeld(self: *StreamRunner, streams: *eventstreams.EventStreams) !void {
        for (0..2000) |_| {
            if (streams.count(std.testing.io) == 1) return;
            if (!self.running.load(.acquire)) return error.StreamEndedBeforeItStarted;
            try std.testing.io.sleep(.fromMilliseconds(1), .awake);
        }
        return error.StreamNeverStarted;
    }
};

/// A logged-in control-plane session on a fresh fixture, plus the admin's id.
fn onboardedAdmin(f: *Fixture) !struct { id: u64, token: [32]u8 } {
    const id = try f.svc.bootstrapAdmin("admin", "temp0000");
    const token = try onboardWeb(&f.ctx, "admin", "temp0000", "s3cret-pw");
    return .{ .id = id, .token = token };
}

test "a HELD SSE stream never parks the global DB lock: concurrent requests are served throughout" {
    // THE test this whole change exists for. A stream is held open on one thread
    // while the main thread hammers an ordinary DB-touching route. Under the
    // default whole-handler lock policy the first of those requests would block
    // in `lockDb` until the stream ENDED — so "the stream is still running after
    // N served requests" is precisely the property that distinguishes a correct
    // `manual_db_lock` handler from one that freezes device sync.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // Serve mode's lock. Without it the test is vacuous — lockDb is a no-op.
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

    // Served WHILE the stream is held. Each one takes the whole-handler lock, so
    // each one proves the stream released it.
    var obuf: [8192]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    for (0..20) |_| {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &who.token, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    // Still held: the 20 requests above ran DURING the stream, not after it.
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

    // Mutate the tree the way a device sync would — under the DB lock, exactly as
    // a real handler does. This bumps the caller's syncVersion; the stream must
    // notice on its next poll and emit a second frame.
    {
        lock.lockUncancelable(std.testing.io);
        defer lock.unlock(std.testing.io);
        const dir = try f.files.createFolder(who.id, null, "Dir");
        gpa.free(dir.name);
    }

    // Wait for the stream to end on its own (it will, at max_lifetime_ms) rather
    // than asserting on a timer.
    t.join();
    try std.testing.expectEqual(@as(u16, 200), runner.status);

    const out = runner.output();
    // Held shape: a chunked body, not a sized one-shot response.
    try std.testing.expect(std.ascii.indexOfIgnoreCase(out, "transfer-encoding: chunked") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "text/event-stream") != null);
    // The client is told how to reconnect, on the held path too.
    try std.testing.expect(std.mem.indexOf(u8, out, "retry: ") != null);
    // Frame 1 at connect (version 0), frame 2 for the bump (version 1).
    try std.testing.expect(std.mem.indexOf(u8, out, "data: 0") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "data: 1") != null);

    // Teardown: the slot came back with the thread. A leak here is the failure
    // that silently downgrades the endpoint to one-shot forever.
    try std.testing.expectEqual(@as(u32, 0), streams.count(std.testing.io));
    try std.testing.expectEqual(@as(u32, 0), streams.countFor(std.testing.io, who.id));
}

test "an idle held stream emits heartbeat comment frames" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    // Nothing ever changes the tree here, so without a heartbeat this connection
    // would emit exactly one frame and then go silent forever — the state in
    // which a dead peer is indistinguishable from a quiet one.
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
    // `:` starts an SSE comment: ignored by EventSource, but real bytes on the
    // wire, which is the entire point.
    try std.testing.expect(std.mem.indexOf(u8, runner.output(), ": ping") != null);
    try std.testing.expectEqual(@as(u32, 0), streams.count(std.testing.io));
}

test "at the per-user cap the events endpoint DEGRADES to one-shot rather than refusing" {
    // Degrading, not refusing, is the contract: an over-cap tab must still learn
    // the current version and reconnect on `retry:` (a graceful poll). A 503 here
    // would surface as a broken live channel in a perfectly healthy household.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    var streams: eventstreams.EventStreams = .{ .max_total = 8, .max_per_user = 1 };
    ctx.event_streams = &streams;

    // Occupy the caller's only slot directly — deterministic, and it isolates the
    // admission decision from any timing.
    try std.testing.expect(streams.tryAcquire(std.testing.io, who.id));
    defer streams.release(std.testing.io, who.id);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &who.token, "");

    // 200 and a well-formed SSE frame — NOT 429/503.
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.head, "text/event-stream") != null);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "retry: ") != null);
    // The one-shot shape: a sized body that ended, not a held chunked stream.
    try std.testing.expect(std.ascii.indexOfIgnoreCase(resp.head, "content-length:") != null);
    try std.testing.expect(std.ascii.indexOfIgnoreCase(resp.head, "chunked") == null);
    // It also must not have consumed a slot of its own.
    try std.testing.expectEqual(@as(u32, 1), streams.count(std.testing.io));
}

test "with no stream registry (the single-threaded harness) the endpoint is one-shot" {
    // `ctx.event_streams == null` is how every other integration test reaches this
    // route: there is no thread to park, so holding a connection would hang the
    // caller outright. Pinned so nobody makes streaming unconditional.
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
    try std.testing.expect(std.ascii.indexOfIgnoreCase(resp.head, "chunked") == null);
}

test "a dead client tears the stream down and returns its slot, long before the lifetime cap" {
    // A closed tab / dropped Wi-Fi surfaces as a failing WRITE — which is why the
    // heartbeat exists at all: on a stream with no news, the heartbeat is the only
    // thing that ever touches the socket, so it is the only thing that can
    // discover the peer is gone. Modelled here by a response buffer that fills up,
    // which is what a full/dead socket looks like from the handler's side.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    // A long lifetime on purpose: if teardown depended on the lifetime cap rather
    // than on the write failure, this test would take 30s and time out.
    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 1,
        .heartbeat_ms = 1,
        .max_lifetime_ms = 30_000,
    };
    ctx.event_streams = &streams;

    var reqbuf: [1024]u8 = undefined;
    var small: [640]u8 = undefined; // head + the first frame, then no room
    const started = std.Io.Timestamp.now(std.testing.io, .awake);
    // Run inline: it must return promptly by itself.
    _ = requestWithCookie(ctx, &small, &reqbuf, "GET", "/api/controlplane/events", &who.token, "") catch {};
    const elapsed_ms = started.durationTo(std.Io.Timestamp.now(std.testing.io, .awake)).toMilliseconds();

    // Returned because the WRITE failed, not because the lifetime elapsed.
    try std.testing.expect(elapsed_ms < 10_000);
    // And the slot came back — no leaked stream, so nothing to leak a thread on.
    try std.testing.expectEqual(@as(u32, 0), streams.count(std.testing.io));
    try std.testing.expectEqual(@as(u32, 0), streams.countFor(std.testing.io, who.id));
}

// ---- the recycle bin, over HTTP (F8 + U2b) ----------------------------------

/// The parsed `GET /api/controlplane/bin` body. Kept minimal on purpose: the
/// tests assert on the facts the UI cannot render without, not on the whole VO.
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

    // THE DEVICE DOES THIS WALK ITSELF, one request per entity. The browser sends
    // ONE request, so the walk has to happen server-side — this is the assertion
    // that it does.
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
        // The fanout the undo toast has to state: the user clicked one row and
        // three entities went.
        try std.testing.expectEqual(@as(i64, 3), p.value.entries);
    }
    try std.testing.expectEqual(@as(i64, 3), try countTrashed(f, admin));

    // A second, standalone delete, so the listing has both shapes in it.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{loose});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }

    var parsed = try getBin(ctx, &obuf, &reqbuf, &web);
    defer parsed.deinit();
    const bin = parsed.value;
    try std.testing.expectEqual(@as(usize, 4), bin.entries.len);
    try std.testing.expectEqual(@as(i64, 30), bin.retentionDays);
    // 9 + 5 bytes of file content; the two FOLDER rows contribute nothing, which
    // is what stops the "frees N bytes" figure double-counting a folder with the
    // notes inside it.
    try std.testing.expectEqual(@as(i64, 14), bin.totalBytes);

    var deep_id_buf: [24]u8 = undefined;
    const deep_id = try std.fmt.bufPrint(&deep_id_buf, "{d}", .{deep});
    var seen_deep = false;
    for (bin.entries) |e| {
        try std.testing.expect(e.deletedAt > 0);
        if (std.mem.eql(u8, e.id, deep_id)) {
            seen_deep = true;
            // THE PATH THROUGH TOMBSTONES. Both ancestors are themselves trashed,
            // so a live-only parent walk would have called this `/deep.note`.
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

    // The bin has not leaked back into the library.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "loose.note") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"NOTE\"") == null);
    }
}

// ---- rename (POST /api/controlplane/entry/:id/rename) ----

/// Parse a rename response body to `{ kind, name }` — the load-bearing fields of
/// the listing-shaped `EntryVO` the handler returns for reconciliation.
const RenamedBody = struct { kind: []const u8, name: []const u8 };

fn renameEntry(ctx: *Context, obuf: []u8, reqbuf: []u8, tok: []const u8, id: u64, new_name: []const u8) !Response {
    var pbuf: [96]u8 = undefined;
    var bbuf: [256]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}/rename", .{id});
    const body = try std.fmt.bufPrint(&bbuf, "{{\"name\":\"{s}\"}}", .{new_name});
    return requestWithCookie(ctx, obuf, reqbuf, "POST", path, tok, body);
}

/// The current live name of an entry, owned by `gpa` (free it).
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

    // A user subfolder and a note inside it.
    const dir = try f.files.createFolder(admin, null, "Poems");
    defer gpa.free(dir.name);
    const note = try putSeed(f, admin, dir.id, "Ozymandias.note", "I met a traveller");

    // --- rename the file ---
    const v0 = try f.files.syncVersion(admin);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, note, "Sonnet.note");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(RenamedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("note", p.value.kind);
        try std.testing.expectEqualStrings("Sonnet.note", p.value.name);
    }
    // The rename is a tree change, so the control-plane counter moved.
    try std.testing.expect(try f.files.syncVersion(admin) > v0);
    {
        const nm = try liveName(f, admin, note);
        defer gpa.free(nm);
        try std.testing.expectEqualStrings("Sonnet.note", nm);
    }

    // The new name shows up in the folder listing.
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

    // --- rename the folder ---
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

    // The occupant was never clobbered and the mover kept its name; nothing moved,
    // so the sync counter did not advance either.
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

    // Mirror the device tree: root containers NOTE / DOCUMENT, plus the rail's
    // anchor subfolders NOTE/Note, NOTE/MyStyle, DOCUMENT/Document.
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

    // Every protected folder — the two roots exercised, and all three anchors —
    // refuses the rename with 403 and keeps its name.
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

    // A user's own "Note" folder that is NOT directly under a root-level "NOTE" is
    // not an anchor and renames fine — proving the guard keys on shape, not name.
    // (a) A root-level "Note" (no parent container).
    const loose_note = try f.files.createFolder(admin, null, "Note");
    defer gpa.free(loose_note.name);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, loose_note.id, "Journal");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // (b) A "Note" nested one level deeper — its parent is the ANCHOR "Note", not a
    // root-level "NOTE", so [parent.name, "Note"] = ["Note","Note"], not an anchor.
    const deep_note = try f.files.createFolder(admin, anchor_note.id, "Note");
    defer gpa.free(deep_note.name);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, deep_note.id, "Sub");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // (c) A "Note" under a user folder that is itself named "NOTE" but is NOT
    // root-level — its parent's parent is not null, so it is not an anchor.
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

    // Bob's id and a never-existed id both answer 404 — the admin's session is not
    // an existence oracle over the id space (blobs are deduplicated across users).
    const foreign = try renameEntry(ctx, &obuf, &reqbuf, &web, bob_id, "stolen.note");
    try std.testing.expectEqual(@as(u16, 404), foreign.status);
    const missing = try renameEntry(ctx, &obuf, &reqbuf, &web, 999999, "ghost.note");
    try std.testing.expectEqual(@as(u16, 404), missing.status);

    // Bob's file was untouched by the attempt.
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

    // The file kept its name through both refusals.
    const nm = try liveName(f, admin, note);
    defer gpa.free(nm);
    try std.testing.expectEqualStrings("keep.note", nm);
}

// ---- web upload (POST /api/controlplane/folder/:id/upload) -------------------

const upload_boundary = "----InkholdWebUploadBoundary";

/// Frames `payload` as the ONE file part of a browser upload, declaring
/// `filename` in the part header — the shape `FormData`/`XMLHttpRequest` sends.
/// Caller frees.
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

/// POST one file to `dest` ("root", or a folder id rendered as decimal).
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

/// `uploadFile`, reporting how much of the request the server read — the ingest
/// cap's one observable (see `Sent`).
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

/// `uploadFile` with a raw query string appended (`"?onConflict=replace"`), so
/// the conflict-mode cases drive the same wire path as everything else.
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

/// Serializes one browser upload request into `reqbuf`.
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

/// `dest` for a folder id.
fn destOf(buf: []u8, id: u64) ![]const u8 {
    return std.fmt.bufPrint(buf, "{d}", .{id});
}

/// The load-bearing fields of the listing-shaped `EntryVO` an upload returns —
/// the SAME shape `rename` answers with, which the SPA's `normalizeEntry` reads.
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

    // A PDF — the headline case: the web has no viewer for it, the DEVICE does.
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

    // The blob is on disk, content-addressed by the FILE's md5 (not the wire body's).
    try std.testing.expect(f.files.blobs.has(&md5));

    // The row is linked under the destination folder with the real size…
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
    // …quota is charged the real ingested byte count, and the tree changed.
    try std.testing.expectEqual(@as(i64, @intCast(bytes.len)), try usedBytes(f, admin));
    try std.testing.expect(try f.files.syncVersion(admin) > v0);

    // It shows up in the folder listing the SPA reads.
    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/tree?parent={d}", .{dir.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Ozymandias.pdf") != null);
    }

    // `root` is a real destination, not only a numeric id.
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

    // The SAME content under a DIFFERENT name: one blob on disk, two rows, and
    // not one extra byte charged — quota is per distinct blob per user, which is
    // what a content-addressed store actually occupies.
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

    // A second, DIFFERENT file that merely shares the name. The device's own
    // link path would REPLACE (a Nomad re-uploading means "new version of this
    // note"); a browser drop must not, so it takes the next free " (n)".
    const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "notes.pdf", "a completely different document");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("notes (2).pdf", p.value.name);
    try std.testing.expect(try std.fmt.parseInt(u64, p.value.id, 10) != first);

    // The occupant is untouched — same row, same name, same bytes.
    {
        const kept = (try f.files.get(admin, first)).?;
        defer gpa.free(kept.name);
        defer if (kept.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("notes.pdf", kept.name);
        try std.testing.expectEqualStrings(&blobstore.md5HexOf("the occupant's bytes"), kept.md5.?);
    }
    // A third drop of the same name climbs to " (3)".
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

    // A tiny allotment: 8 bytes total.
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

    // Nothing linked, nothing charged, nothing bumped — and the rejected blob was
    // dropped rather than left on disk.
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expectEqual(v0, try f.files.syncVersion(admin));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(bytes)));
    {
        const resp2 = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expect(std.mem.indexOf(u8, resp2.body, "big.pdf") == null);
    }
}

test "web upload: a body past the caller's remaining quota is refused MID-STREAM and stores nothing" {
    // The browser face has no `upload/apply`, so there is no declared size to hold
    // it to: the cap is the caller's REMAINING QUOTA — the figure `linkBlob` is
    // about to enforce anyway. The difference is where the bytes stop: at the cap,
    // instead of after the whole body has been written to disk and then refused.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;

    // A tiny allotment: 8 bytes total, so the cap is 8 + the slack.
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
    // The browser face is not the frozen device protocol: it answers the SPA's own
    // shape, the same 413 + QUOTA_EXCEEDED the link-time refusal uses.
    try std.testing.expectEqual(@as(u16, 413), resp.status);
    try expectFailure(resp.body, "QUOTA_EXCEEDED");

    // AND IT STOPPED THERE. Without the cap this same 413 arrives too — after the
    // whole body has been written to disk and then deleted, which is the disk-fill
    // this closes. The read count is the only thing that tells the two apart.
    try std.testing.expect(sent.consumed < cappedReadCeiling(uploadcap.limitFor(8)));

    // Durable facts: no blob published, nothing staged, nothing charged, no row.
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(payload)));
    try std.testing.expectEqual(@as(usize, 0), try blobTempCount(f));
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expectEqual(v0, try f.files.syncVersion(admin));
    {
        const tree = try requestWithCookie(ctx, &obuf, reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expect(std.mem.indexOf(u8, tree.body, "flood.pdf") == null);
    }

    // With room, the very same body uploads — the cap is a bound, not a ban.
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

    // 415: outside the accept-list. `.exe`, `.svg` (a script vector the browser
    // face deliberately never inlines), and an extensionless name.
    for ([_][]const u8{ "trojan.exe", "vector.svg", "README" }) |name| {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", name, bytes);
        try std.testing.expectEqual(@as(u16, 415), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "UNSUPPORTED_TYPE") != null);
    }
    // A bare extension is all suffix and no stem: a dotfile, not a PDF.
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", ".pdf", bytes);
        try std.testing.expectEqual(@as(u16, 415), resp.status);
    }

    // 400: the name cannot be a tree path component. The multipart parser has
    // already stripped any directory prefix, so `../../etc/x.pdf` arrives as
    // `x.pdf` and is FINE — these are the ones that survive that reduction.
    for ([_][]const u8{ "", "..", "..pdf", "a\x00b.pdf", "line\nbreak.pdf", "\xff\xfe.pdf" }) |name| {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", name, bytes);
        try std.testing.expectEqual(@as(u16, 400), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "INVALID_NAME") != null);
    }

    // Not one of them reached the store or the tree.
    try std.testing.expect(!f.files.blobs.has(&md5));
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));

    // A traversal attempt is NEUTRALIZED, not refused: the part header's
    // directory prefix is stripped, so the file lands under its basename at the
    // destination and nothing escapes anywhere.
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

    // Every accepted extension IS accepted, case-insensitively — the accept-list
    // is the feature, so pin it rather than trusting one representative.
    const accepted = [_][]const u8{
        "a.note", "b.SPD", "c.pdf",  "d.EPUB", "e.doc",  "f.docx",
        "g.txt",  "h.PNG", "i.jpg",  "j.jpeg", "k.webp", "l.cbz",
        "m.fb2",  "n.xps", "o.mobi", "p.azw",  "q.AZW3",
    };
    for (accepted, 0..) |name, i| {
        // Distinct content per file so each is its own blob (dedup would still
        // pass, but a distinct blob proves the link actually happened).
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

    // A stranger's folder is not an upload destination even by accident.
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, bob));
}

test "web upload: requires a control-plane session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const resp = try uploadFile(ctx, &obuf, &reqbuf, "0" ** 32, "root", "sneaky.pdf", "bytes");
    try std.testing.expectEqual(@as(u16, 401), resp.status);
}

// ---- web upload: the ?onConflict= choice --------------------------------------

/// One `versions` row of the history endpoint, for the supersede assertions.
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

    // Replace: same name, same row, new content.
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

    // Exactly one row of that name — a replace adds none.
    try std.testing.expectEqual(
        @as(i64, 1),
        try countRows(f, "SELECT COUNT(*) FROM files WHERE name = 'paper.pdf' AND deleted = 0;"),
    );

    // The superseded bytes are a RETAINED version, not a deletion — which is the
    // whole reason `replace` can be offered at all.
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
    // And it is restorable through the ordinary version-history route.
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
    // A create supersedes nothing, so it writes no version row.
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

    // The parameter absent entirely (what a client built before this shipped
    // sends), then a set of values that are not `replace`.
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

    // Through every one of them the occupant kept its name, its bytes and its
    // history — nothing was superseded.
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

    // A folder whose name reads like a file. A file may supersede a FILE; it may
    // never supersede a folder, under either mode.
    const dir = try f.files.createFolder(admin, null, "archive.pdf");
    defer gpa.free(dir.name);

    const bytes = "trying to become a folder";
    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "archive.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 409), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "NAME_TAKEN") != null);

    // The folder is untouched, nothing was charged, and the rejected blob left
    // no orphan behind.
    {
        const kept = (try f.files.get(admin, dir.id)).?;
        defer gpa.free(kept.name);
        defer if (kept.md5) |m| gpa.free(m);
        try std.testing.expect(kept.is_folder);
        try std.testing.expectEqualStrings("archive.pdf", kept.name);
    }
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(bytes)));

    // Under the default mode the same drop lands beside the folder instead.
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

    // `old` is deliberately a different length from `new` so the arithmetic is
    // visible rather than coincidentally balanced.
    const old_bytes = "old bytes";
    const new_bytes = "the replacement bytes, rather longer than the old";
    const old_len: i64 = @intCast(old_bytes.len);
    const new_len: i64 = @intCast(new_bytes.len);

    // --- case 1: this row is the user's ONLY holder of the old blob. ---
    const solo = try putSeed(f, admin, null, "solo.pdf", old_bytes);
    try std.testing.expectEqual(old_len, try usedBytes(f, admin));
    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "solo.pdf", new_bytes, "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // The old charge is NOT released, because the bytes did not leave the disk:
    // the retained version keeps them, so the owner keeps paying (
    // §6). That the blob is still there is exactly what makes it restorable — and
    // exactly why charging for it is the honest reading of the meter.
    try std.testing.expectEqual(old_len + new_len, try usedBytes(f, admin));
    try std.testing.expect(f.files.blobs.has(&blobstore.md5HexOf(old_bytes)));
    try std.testing.expectEqualSlices(u8, &blobstore.md5HexOf(old_bytes), &(try soleHistoryMd5(f, solo)));

    // --- case 2: a SECOND live file still holds the old content. ---
    // Two rows on one blob cost one charge; replacing one of them must NOT
    // release it, because the other still occupies those bytes.
    const shared_a = try putSeed(f, admin, null, "shared-a.pdf", old_bytes);
    _ = try putSeed(f, admin, null, "shared-b.pdf", old_bytes);
    _ = shared_a;
    const before = try usedBytes(f, admin);
    // The pair added NOTHING: those bytes are already on the account, held by
    // solo.pdf's retained version. Dedup against your own history is still dedup.
    try std.testing.expectEqual(new_len + old_len, before);
    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "shared-a.pdf", "third distinct payload", "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // Only the NEW blob's charge was added; the old one stayed, held by shared-b.
    try std.testing.expectEqual(before + @as(i64, "third distinct payload".len), try usedBytes(f, admin));
}

// ---- the account screen ----

test "ACCOUNT SCREEN: the wire shape the panel is built against, over a real session" {
    // The frontend reads these two bodies field by field, so pin the WIRE rather
    // than the service structs behind it — a rename here is a blank line on the
    // page, and nothing else in the suite would notice.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    // One of each live kind, plus an edit so there is a retained version to show.
    _ = try putSeed(f, admin, null, "bujo.note", "notebook bytes v1");
    _ = try putSeed(f, admin, null, "bujo.note", "notebook bytes v2 (edited)");
    _ = try putSeed(f, admin, null, "sketch.spd", "sketch bytes");
    _ = try putSeed(f, admin, null, "lease.pdf", "document bytes");
    // ...and something in the bin, the one line a person can act on immediately.
    const doomed = try putSeed(f, admin, null, "old.pdf", "trashed document bytes");
    try f.files.trash(admin, doomed);

    const AccountBody = struct {
        success: bool,
        email: []const u8,
        name: []const u8,
        isAdmin: bool,
        createdAt: i64,
        // `passwordChangedAt` is ABSENT until the password is changed, so it is
        // optional here on purpose — the JSON omits null optionals entirely.
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
        // `retainedPerFile` is what lets the settings control state its cost
        // before the button is pressed; pinned here because the control cannot
        // render without it. No `bytes`: the storage route owns that figure, and
        // `ignore_unknown_fields = false` below means this list is exact — if one
        // came back, this test would say so.
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
        // The onboarding flow changed the password, so the column is now true —
        // and it is a self-service change, which is the only thing that stamps it.
        try std.testing.expect(p.value.passwordChangedAt != null);
        // This browser is the ONLY live control-plane session, and it knows when
        // it started. `changePassword` revoked the rest on the way in.
        try std.testing.expect(p.value.thisSessionSince != null);
        try std.testing.expectEqual(@as(i64, 0), p.value.otherBrowsers);
        try std.testing.expectEqual(@as(usize, 0), p.value.devices.len); // no tablet bound here
        // The DEFAULT and the CEILING are two different numbers now: an account
        // that has never chosen starts at `history.keep` and may raise itself as
        // far as `history.max_keep`. Asserting they were equal is exactly what a
        // config with one knob looked like, and it is what the settings control
        // could not offer a choice within.
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
        // Every line is populated, so none of them is quietly always-zero...
        try std.testing.expect(b.notebooks > 0);
        try std.testing.expect(b.sketches > 0);
        try std.testing.expect(b.documents > 0);
        try std.testing.expect(b.recycle_bin > 0);
        try std.testing.expect(b.versions > 0);
        // ...and THE PROPERTY, on the wire: the parts add up to the whole.
        try std.testing.expectEqual(
            b.used_bytes,
            b.notebooks + b.sketches + b.documents + b.recycle_bin + b.versions,
        );
        try std.testing.expectEqual(b.used_bytes, try usedBytes(f, admin));
        try std.testing.expect(b.total_bytes > b.used_bytes);
    }

    // Self-service unlink refuses a serial that is not the caller's, with the same
    // answer an unknown one gets — it is no probe for what other households hold.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/account/devices/unlink", &web, "{\"equipmentNo\":\"SN-NOT-MINE\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    // AND IT ACTUALLY UNLINKS. Only the refusal was covered, which is the half
    // that fails safe: a unlink route that answered 200 and did nothing would
    // have passed every test here while the tablet kept syncing. Bound, unlinked
    // through the caller's OWN route, then read back off the account payload.
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

        // The binding is no longer ACTIVE. It may still be listed — the screen
        // shows revoked bindings too — so this asserts the status, not absence.
        const after = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
        var p = try std.json.parseFromSlice(AccountBody, gpa, after.body, .{ .ignore_unknown_fields = false });
        defer p.deinit();
        for (p.value.devices) |d| {
            if (std.mem.eql(u8, d.equipment_no, "SN-MINE-1")) try std.testing.expect(!d.active);
        }
    }

    // Sign out everywhere else leaves THIS browser signed in — the confirmation of
    // the act must not be a login screen.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/account/sign-out-others", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const after = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
        try std.testing.expectEqual(@as(u16, 200), after.status);
    }
}

test "abandoned upload sessions are reclaimed at startup, not left for ever" {
    // `putChunk`/`finishUpload` deliberately strand a staged blob on a hash
    // mismatch, a quota refusal, or a client that simply stops — each with a
    // comment saying the sweep reclaims it. The sweep existed and was called from
    // NOTHING but its own tests, so on a real install those blobs and their
    // `upload_sessions` rows accumulated for ever, on exactly the Pi-class box
    // where disk is the binding constraint.
    //
    // This asserts the RECLAMATION, not the call: a wiring that runs the sweep
    // with a window so wide it never collects anything would pass a "was it
    // called" test and leak just the same.
    const f = try Fixture.init();
    defer f.deinit();
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    _ = admin;

    try f.db.exec(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, blob_md5, created_at) " ++
            "VALUES('stale-inner-name', 1, '/Note', 'abandoned.note', 12, '0123456789abcdef0123456789abcdef', 0);",
    );
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));

    // A day's window, the same one `transport.run` uses. `created_at = 0` is far
    // outside it, so a correctly-wired sweep takes it.
    const swept = try f.files.sweepUploadSessions(24 * 60 * 60);
    try std.testing.expectEqual(@as(usize, 1), swept);
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
}

test "bindEquipment WITHOUT a token: accepted only on the strength of a live session for that serial" {
    // THE REAL NOMAD SENDS THIS UNAUTHENTICATED. Captured in
    // docs/scratch/nomad-login.log: login returns the token at t+0ms, the device
    // fires bindEquipment at t+9ms, and only stores the token at t+15ms — so the
    // one call carrying its name, model and firmware has no x-access-token. We
    // answered 401 to every pairing, the handler never ran, and the account
    // screen showed a placeholder for a tablet that had said what it was called.
    // Sync worked throughout, because the binding already existed, so nothing
    // about the failure was visible from either side.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    _ = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const created = try f.svc.createUser(admin, "alice@home", false);
    const alice = created.id;
    // Through the real first-login flow, so she has a usable password to log a
    // DEVICE in with — a `pending` account could not reach this route at all.
    _ = try onboardWeb(ctx, "alice@home", created.temp_password.slice(), "alicepw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bind_body =
        "{\"account\":\"alice@home\",\"equipmentNo\":\"SN-NOMAD-9\",\"name\":\"Supernote Nomad 2\"," ++
        "\"totalCapacity\":\"25485312\",\"label\":[\"NOTE/Note\"],\"version\":\"202407\"}";
    const tokenless = [_]Header{.{ .name = "content-type", .value = "application/json" }};

    // 1. NO SESSION for that serial -> still 401. The body alone proves nothing,
    //    which is the whole point: this must not become a way to bind a serial to
    //    an account you cannot already log into.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &tokenless, bind_body), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }

    // 2. A live session for that serial, but belonging to SOMEBODY ELSE -> 401.
    {
        _ = try deviceLogin(ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN-NOMAD-9");
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &tokenless, bind_body), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
        // ...and nothing was bound to alice on the way past.
        try std.testing.expect(!(try f.svc.isDeviceBound(alice, "SN-NOMAD-9")));
    }

    // 3. Alice logs in on that serial — now the session says so, and the bind is
    //    accepted with the name the device reported.
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

    // Same content ⇒ nothing superseded: no history row, no extra charge, one row.
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
    try std.testing.expectEqual(charged, try usedBytes(f, admin));
    try std.testing.expectEqual(
        @as(i64, 1),
        try countRows(f, "SELECT COUNT(*) FROM files WHERE name = 'same.pdf' AND deleted = 0;"),
    );
}

/// A minimal PNG whose IHDR carries 320×240 — dims the ingest-side sniff can
/// decode, so a `.spd` embedding it gets real `thumb_w/h` columns.
const aspect_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ ("p" ** 16);

test "a PDF's tree entry carries its REAL page count and shape, not the 1-page fallback" {
    // Every PDF card read "1 page" whatever the document was. `summaryFor` sets
    // `first` only for an indexable `.note`, so a `.pdf` always takes the
    // fallback return — and `fallbackFirst` hardcodes a count of 1, throwing away
    // the `page_count` the probe had just written one line above.
    //
    // THREE pages on purpose: a one-page fixture would pass either way.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    _ = try putSeed(f, admin, null, "doc.pdf", @embedFile("../pdf/testdata/three-page.pdf"));
    // A `.txt` alongside, whose `page_count` IS 0 and which must keep the
    // fallback: the fix must not hand a page count to something with no pages.
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

    // A coverless LANDSCAPE note (aspect = page 0's EFFECTIVE dims, honest and
    // wide), a `.spd` embedding a 320×240 PNG thumbnail, and a text file
    // (client-side shape by design — no server aspect).
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

    // --- the live tree ---
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
        // Absent means OMITTED on the wire, never `null` — a client reading
        // `"thumbAspect":null` would have a third state nobody defined.
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"thumbAspect\":null") == null);
    }

    // --- the bin: trashed entries still render previews, so the aspect rides
    //     the bin rows too ---
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

/// One layer descriptor as it appears on EITHER response — the frontend
/// normalizes the listing's `firstPage.layers` and the metadata's
/// `pages[].layers` through a single code path, so the two must be the same
/// object down to field names and casing.
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

    // The real capture whose page 0 carries a `#`-JSON LAYERINFO panel...
    const layered_id = try putSeed(f, admin, null, "layers.note", @embedFile("layers_edited.note"));

    // ...and a synthetic note whose one page carries NO layer records, which
    // must OMIT the field rather than send `null` or `[]`.
    const nb = @import("note_builder");
    const bare = try nb.serialize(gpa, .{ .pages = &.{.{ .style = "style_white", .layers = &.{} }} });
    defer gpa.free(bare);
    const bare_id = try putSeed(f, admin, null, "bare.note", bare);

    const Page = struct { index: i64 = 0, layers: ?[]const LayerRow = null };
    const Row = struct { name: []const u8, firstPage: ?Page = null };

    // --- what the READER will eventually see for page 0 ---
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
        // Copied out (the parse arena dies with `p`) so the listing below is
        // compared against the metadata response, not against a re-derivation.
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

    // --- the live tree: the summary the reader opens from ---
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
        // Absent is OMITTED on the wire — never `"layers":null`, never `[]`,
        // which a client would have to treat as a third state nobody defined.
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"layers\":null") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"layers\":[]") == null);
    }

    // --- the bin builds its `firstPage` through the same `pageRefAt`, so a
    //     trashed row reports exactly what it did while it was live ---
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

    // The page hash, taken while the note is still live.
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

    // --- every LIVE read now 404s, because `Files.get` hardcodes `deleted = 0`
    //     and is deliberately NOT relaxed. This is the gap U2b describes.
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

    // --- and the BIN-scoped twins serve them, which is the whole point: the
    //     decision to purge is made while looking at the thing.
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
        // Real bytes, not an empty 200: this works only because trash HELD the
        // blob reference. Under the old decref-at-tombstone behaviour there would
        // be nothing on disk to serve.
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/{d}?v={s}", .{ pic.id, pic.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("raw bytes", resp.body);
    }

    // --- the boundary runs BOTH ways. A LIVE id is a 404 through the bin routes,
    //     so they cannot quietly become a second general read path.
    {
        const kept = try putSeedHashed(f, admin, null, "kept.png", "kept bytes");
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/{d}?v={s}", .{ kept.id, kept.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    // …and search still excludes the trashed note, so the bin has not leaked into
    // the index either.
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, admin, "Zebra"));
}

test "bin parity phase 1: page-text ovals + find-in-note serve a TRASHED note's current version; live routes 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    // Two versions of ONE note, each with a recognized word AND a box: v1 says
    // "alpha", v2 (the current) "beta". v2 supersedes v1, retaining v1 in
    // `file_history`. Then TRASH the file — its blob, `note_index` and `file_history`
    // are all retained (H10), which is the whole reason the bin routes below can
    // serve anything at all (ovals included).
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
    const PageMatch = struct { pageIndex: i64, matches: i64, terms: []const []const u8 };

    // --- bin page-text: the CURRENT (v2) transcript + word boxes, `no-cache`,
    //     never `immutable`, raw VO — the same shape the live text route serves. ---
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

    // --- bin find-in-note: one COMPLETE response, matching the CURRENT text. ---
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/search?q=beta", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "cursor") == null); // no cursor
        var p = try std.json.parseFromSlice(
            struct { query: []const u8, pages: []PageMatch, usedFuzzy: bool },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.pages.len);
        try std.testing.expectEqual(@as(i64, 0), p.value.pages[0].pageIndex);
        try std.testing.expect(p.value.pages[0].matches >= 1);
        try std.testing.expect(!p.value.usedFuzzy);
    }
    // A term in neither version is a 200 with no pages (the box searches as you type).
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/search?q=zzznope", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { pages: []PageMatch }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 0), p.value.pages.len);
    }

    // --- the LIVE text route 404s the now-trashed id (`Files.get` hardcodes
    //     `deleted = 0`), and the live find-in-note excludes it (its files-join
    //     drops `deleted = 1`), so the degraded bin find is retired on the bin
    //     surface, not the live one. ---
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ id, "f" ** 32 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/search?q=beta", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status); // live search: empty, not 404
        var p = try std.json.parseFromSlice(struct { pages: []PageMatch }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 0), p.value.pages.len);
    }

    // --- the boundary runs BOTH ways: a LIVE note's id on the bin routes → 404,
    //     so they cannot quietly become a second general read path. ---
    {
        const live_id = try seedRecognizedNote(f, admin, "live.note", &.{"gamma"});
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/page/0/text", .{live_id});
            try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
        }
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/search?q=gamma", .{live_id});
            try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
        }
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

    // A `.note` with two versions (v1 "alpha", v2 "beta", each with a box), plus a
    // `.spd` with two raw versions. v2/spd-v2 supersede v1/spd-v1, retaining v1 in
    // `file_history`. Then TRASH both — `file_history` follows a file to the bin (H10),
    // which is what makes the view-only history twins below reachable.
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

    // --- the version list of a TRASHED note: current (flagged) + the retained v1. ---
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

    // --- the retained version's page bytes (SNPG), no ?v= (the :md5 pins the blob). ---
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/page/0", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]);
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
    }

    // --- the retained version's OWN transcript ("alpha"), DISTINCT from the current
    //     version's ("beta", via the phase-1 bin page-text route). ---
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

    // --- find-in-a-retained-version: the one-document scan finds "alpha" (edited out
    //     of the current version), and a bogus md5 is a 404 (not an empty result). ---
    const PageMatch = struct { pageIndex: i64, matches: i64, terms: []const []const u8 };
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/search?q=alpha", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { pages: []PageMatch }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.pages.len);
        try std.testing.expectEqual(@as(i64, 0), p.value.pages[0].pageIndex);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/search?q=alpha", .{ id, "f" ** 32 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }

    // --- the retained `.spd` version's raw bytes, through the bin history raw twin. ---
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/raw", .{ spd_id, spd_v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(spd_v1, resp.body); // v1's EXACT bytes
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
    }

    // --- NO per-version restore twin exists: the bin history is view-only. ---
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/restore", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status); // no such route
    }

    // --- the scope boundary runs BOTH ways, and the live-history gate is UNCHANGED:
    //     the now-trashed note's id on the LIVE history routes is a 404 (the live gate
    //     still hardcodes `deleted = 0`), and a LIVE note's id on the BIN history
    //     routes is a 404 too. ---
    {
        const live = [_][]const u8{
            try std.fmt.bufPrint(pbuf[0..90], "/api/controlplane/note/{d}/history", .{id}),
            try std.fmt.bufPrint(pbuf[90..], "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v1md5 }),
        };
        for (live) |path|
            try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }
    {
        // A LIVE note with its own retained version. Its LIVE history works (regression),
        // but its id on the BIN history routes is a 404.
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
    // TRASH REFUNDS NOTHING AND RELEASES NOTHING — a decision, not an oversight.
    try std.testing.expectEqual(charged, try usedBytes(f, admin));
    try std.testing.expect(f.files.blobs.has(&a.md5));

    // The device recreates the folder while the old one sits in the bin, so the
    // restore has to land on an occupied live name.
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
        // `Sub` itself did not collide — its ANCESTOR did, and was renamed to make
        // room. The count is what tells the user a second folder came back.
        try std.testing.expectEqualStrings("Sub", p.value.name);
        try std.testing.expectEqual(@as(i64, 1), p.value.ancestors);
        try std.testing.expectEqual(@as(i64, 1), p.value.descendants);
    }
    // The restored ancestor took the suffix, and both `Dir`s are live.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Dir (2)") != null);
    }

    // Trash it again, then PURGE — the only route that reaches `decref`.
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

    // Purge refuses a LIVE id, so a hard delete is never one mistyped id away.
    const live = try putSeedHashed(f, admin, null, "live.note", "live");
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}", .{live.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(f.files.blobs.has(&live.md5));
    }

    // Empty what is left of the bin in one call. (The restore above emptied it,
    // so put something back in first — the assertion is about the count.)
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
    // F5 landed after this test was written: the SERVER generates the temporary
    // password now, so it has to be carried from createUser rather than chosen here.
    const alice_new = try f.svc.createUser(admin, "alice", false);
    const alice = alice_new.id;
    const admin_web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const alice_web = try onboardWeb(ctx, "alice", alice_new.temp_password.slice(), "apass111");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [160]u8 = undefined;

    // THE CASE THAT ACTUALLY LEAKS. Both households hold the SAME bytes, so there
    // is one physical blob at refcount 2 and one shared `note_index` row. Only the
    // `files` row records whose copy is whose — every scoping claim below rests on
    // that and nothing else.
    const mine = try putSeedHashed(f, alice, null, "secret.note", "identical bytes");
    const theirs = try putSeedHashed(f, admin, null, "mine.note", "identical bytes");
    try std.testing.expectEqualStrings(&mine.md5, &theirs.md5);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{mine.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &alice_web, "", 200);
    }

    // Admin points every bin route at ALICE's id. A missing id (99999) must
    // produce the identical answer, or the endpoint is an existence oracle over
    // the whole id space — and here the bytes really are sitting on admin's disk.
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
            // Even holding the RIGHT `?v=` — admin's own blob md5, which is the
            // same md5 — the row is not theirs, so there is nothing to serve.
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/{d}?v={s}", .{ id, theirs.md5[0..] });
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_web, "", 404);
        }
    }

    // Alice's row survived every one of those, still trashed and still hers.
    var parsed = try getBin(ctx, &obuf, &reqbuf, &alice_web);
    defer parsed.deinit();
    try std.testing.expectEqual(@as(usize, 1), parsed.value.entries.len);
    try std.testing.expectEqualStrings("secret.note", parsed.value.entries[0].name);
    // Admin's bin is empty, and admin's own live copy is untouched.
    var admin_bin = try getBin(ctx, &obuf, &reqbuf, &admin_web);
    defer admin_bin.deinit();
    try std.testing.expectEqual(@as(usize, 0), admin_bin.value.entries.len);
    try std.testing.expect(f.files.blobs.has(&theirs.md5));
    const still_theirs = (try f.files.get(admin, theirs.id)).?;
    defer gpa.free(still_theirs.name);
    defer if (still_theirs.md5) |m| gpa.free(m);
}

// ---- admin elevation (re-authentication) over HTTP ----

test "the admin console is gated behind re-authentication, with a status the SPA cannot mistake for a dead session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    // Signed in as an administrator — and still outside the console. This is the
    // whole point: `is_admin` travels on a tablet left unlocked on a table, so it
    // is not on its own permission to delete a housemate's notes.
    //
    // 428, NOT 401. The SPA's failure sink maps 401 (and 403) to "your session
    // ended" and routes to the login page, so reusing either would sign the admin
    // out of the entire app instead of showing the re-auth gate.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 428), resp.status);
        try std.testing.expect(resp.status != 401);
        try std.testing.expect(resp.status != 403);
        try expectFailure(resp.body, "ELEVATION_REQUIRED");
    }

    // The gate covers EVERY admin route, the read-only listing above included —
    // otherwise an idle tablet still exposes every housemate's email and quota.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, "{\"email\":\"x\"}", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", "/api/admin/users/1", &admin_tok, "", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users/1/reset", &admin_tok, "", 428);

    // The ordinary control plane is untouched by the gate: elevation is not a
    // second audience, it is a capability of one route class.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &admin_tok, "", 200);

    // A wrong password does not open it, and leaves the session exactly as it was.
    {
        const resp = try tryElevate(ctx, &obuf, &reqbuf, "admin", "not-the-password", &admin_tok);
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 428);

    // Re-entering the password through the SAME challenge flow login uses opens it.
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 200);

    // Lock closes it again, immediately — the very next request is back at the gate.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/lock", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 428);

    // Lock is idempotent and never itself hits the gate — a caller whose elevation
    // already lapsed must still be able to say "lock", and get a 200 for it.
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

    // A PENDING session (still owing a password change) is turned away by the
    // route's scopes before it can even try: `must_change_password` exists to
    // force a change, and elevation must not route around it.
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

    // Bob completes onboarding into an ordinary account, then tries to elevate
    // with his OWN CORRECT password. He is refused with exactly the code a wrong
    // password produces — anything more specific would make this endpoint an
    // oracle for who in the household is an administrator.
    const bob_tok = try onboardWeb(ctx, "bob", bob.temp_password.slice(), "bobpw123");
    {
        const right = try tryElevate(ctx, &obuf, &reqbuf, "bob", "bobpw123", &bob_tok);
        try expectFailure(right.body, "INVALID_CREDENTIALS");
        const wrong = try tryElevate(ctx, &obuf, &reqbuf, "bob", "definitely-wrong", &bob_tok);
        try expectFailure(wrong.body, "INVALID_CREDENTIALS");
        try std.testing.expectEqual(right.status, wrong.status);
    }

    // And he is still refused the console the ordinary way — a plain 403, not the
    // 428 gate, so he is not even told a gate exists.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 403);
}

test "elevate is rate-limited per USER, so one housemate's fumbling cannot lock out another on the same IP" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // Two administrators, one household, ONE shared IP — the fixture's client_ip
    // is a single constant for every request below, which is the whole point.
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const second = try f.svc.createUser(admin, "second", true);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const a_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const b_tok = try onboardWeb(ctx, "second", second.temp_password.slice(), "secondpw1");

    // The first admin burns the whole bucket (5 per 5 minutes) on wrong guesses,
    // then is limited. `elevate` is a password oracle, so it must have a limit.
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

    // THE REGRESSION THIS TEST EXISTS FOR: the limit is keyed by USER, not by IP.
    // A household shares one address, so IP-keying (or `by = .both`) would mean one
    // person's fumbling locks every housemate out of the console. The second admin
    // — same IP, different account — sails straight through, correct password and
    // all.
    try elevate(ctx, &obuf, &reqbuf, "second", "secondpw1", &b_tok);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &b_tok, "", 200);

    // And the first admin is only rate-limited, not locked out of the app: their
    // ordinary session still works.
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

    // Both admins are in the console.
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &a_tok);
    try elevate(ctx, &obuf, &reqbuf, "second", "secondpw1", &b_tok);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &b_tok, "", 200);

    // One resets the other's password.
    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/reset", .{second.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &a_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    // The reset revoked the session ROW, and elevation lived on that row — so it
    // is gone for free, with no separate revocation to remember. 401 (a genuinely
    // dead session), NOT the 428 gate: there is nothing left to re-elevate.
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

    // Wind the idle deadline down to nearly-expired while leaving the ceiling far
    // away, so a renewal is both possible and unmistakable. (Real time cannot be
    // advanced 15 minutes inside a test; the window's arithmetic itself is covered
    // at the service layer.)
    const nearly = std.Io.Clock.real.now(std.testing.io).toSeconds() + 5;
    {
        var s = try f.db.prepare("UPDATE sessions SET elevated_until = ?1 WHERE token_hash = ?2;");
        defer s.finalize();
        s.bindInt(1, nearly);
        s.bindText(2, &password.hashToken(&admin_tok)); // rows are keyed by sha256(token)
        _ = try s.step();
    }

    // Browsing the ordinary control plane is NOT admin activity: the console's
    // window must track use of the console, not any tab the same session has open.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &admin_tok, "", 200);
    try std.testing.expectEqual(nearly, elevatedUntil(&f.db, &admin_tok).?);

    // Touching an admin route slides it forward by a fresh idle window.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 200);
    try std.testing.expect(elevatedUntil(&f.db, &admin_tok).? > nearly);

    // But renewal only ever EXTENDS a live elevation — it can never grant one.
    // That is what makes it safe to run before the request is authorized.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/lock", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 428);
    try std.testing.expect(elevatedUntil(&f.db, &admin_tok) == null); // the failed request did not revive it
}

/// A session's current elevation deadline, or null when it holds none.
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

    // --- Unauthenticated (no cookie): the login page reads this pre-auth. ---
    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/server-info", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        var p = try std.json.parseFromSlice(Info, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        // A fresh single-admin server that still owes its password change.
        try std.testing.expect(p.value.firstRun);
        // `address` is "host:port" — non-empty, carries a colon, and ends in the
        // configured port. The exact host depends on the test box's interfaces, so
        // assert shape rather than a literal.
        try std.testing.expect(p.value.address.len != 0);
        try std.testing.expect(std.mem.indexOfScalar(u8, p.value.address, ':') != null);
        try std.testing.expect(std.mem.endsWith(u8, p.value.address, ":8089"));
    }

    // --- Finish onboarding: the admin changes its temporary password. ---
    _ = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");

    // --- firstRun is now false; address is unchanged and still valid. ---
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
//
// These drive SYNTHETIC route tables rather than the real one, because what is
// under test is the DISPATCH POLICY: `read_only` says "run this handler on a
// pooled reader instead of holding `db_lock`", and that claim is about the
// mechanism, not about any particular route. The real table's classification is
// audited separately (see the `read_only` pin further down).

/// A handler that only reads, through the same `ctx.files` every real handler
/// uses — so a pooled dispatch is exercised end to end rather than simulated.
fn poolReadHandler(ctx: *Context, req: *router.Request, _: router.Params) anyerror!void {
    const files = ctx.files.?;
    _ = files.syncVersion(1) catch return serverErrorish(req);
    try req.respond("{\"success\":true}", .{ .status = .ok });
}

fn serverErrorish(req: *router.Request) anyerror!void {
    try req.respond("{\"success\":false}", .{ .status = .internal_server_error });
}

test "a read_only route runs on a pooled reader and a plain route does not, and the histogram says which" {
    // §6's trap, as a test. A pooled read takes no `db_lock`, so without the
    // reader window it would simply disappear from the per-route histogram —
    // "global search: 3.41 s" would become "global search: absent", which reads
    // like a fix. Both routes must appear, and the report must distinguish them.
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

    // The pooled route is still attributed — it did not vanish — and its window
    // is marked as a reader window rather than as lock occupancy.
    try std.testing.expect(pooled.count > 0);
    try std.testing.expectEqual(@as(u64, 1), pooled.read_count);
    try std.testing.expectEqual(@as(u64, 0), pooled.fallback_count);
    try std.testing.expect(pooled.read_total_s > 0 or pooled.read_total_ns_rem > 0);

    // The plain route recorded a window too, and NONE of it is a reader window.
    try std.testing.expect(locked.count > 0);
    try std.testing.expectEqual(@as(u64, 0), locked.read_count);

    // `totals` is the ceiling arithmetic's denominator, so it must count only
    // time actually spent holding the one lock — the pooled read's hold is
    // subtracted back out even though the route keeps it in its distribution.
    const t = f.stats.totals();
    try std.testing.expect(t.count > 0);
    try std.testing.expect(t.total_ns < nsOfSlot(pooled) + nsOfSlot(locked) + std.time.ns_per_s);

    // Every borrow was returned: a leaked lease starves the pool into permanent
    // fallback while the server goes on answering 200.
    try std.testing.expectEqual(@as(usize, 2), f.pool.?.available());
}

test "a read_only route falls back to the write lock when every reader is busy, and says so" {
    // §4's decision, driven: exhaustion must degrade to exactly the pre-pool
    // behaviour — never a wait, never a 503 — which is the property that makes
    // the pool's size a tuning knob rather than a correctness one.
    const f = try Fixture.initPooled(1);
    defer f.deinit();

    const table = [_]router.Route{
        .{ .method = .GET, .path = "/pooled", .scopes = &.{.public}, .handler = poolReadHandler, .read_only = true },
    };

    // Hold the pool's only reader, as a concurrent request would.
    const held = f.pool.?.acquire().?;
    try std.testing.expect(f.pool.?.acquire() == null);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var in = std.Io.Reader.fixed(try buildRequest(&reqbuf, "GET", "/pooled", &.{}, ""));
    var out = std.Io.Writer.fixed(&obuf);
    var server = std.http.Server.init(&in, &out);
    var req = try server.receiveHead();
    try transport.handle(&f.ctx, &table, &req);

    // Answered normally, on the writer.
    try std.testing.expectEqual(@as(u16, 200), (try parseResponse(obuf[0..out.end])).status);
    const s = f.slotFor(&table, "/pooled");
    try std.testing.expectEqual(@as(u64, 1), s.fallback_count);
    try std.testing.expectEqual(@as(u64, 0), s.read_count);
    try std.testing.expect(s.count > 0); // recorded as an ordinary lock window

    f.pool.?.release(held);
    // And the lock is not left behind by the fallback path.
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

/// Shared state for the blocking test below: the handler announces that it is
/// inside, then parks until the test lets it go.
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
    // The feature's reason for existing, stated as the only thing that can
    // actually prove it: while a `read_only` handler is mid-flight, `db_lock` —
    // the lock every WRITE needs — must be free, and a write must be able to
    // complete. "It compiles and the old tests pass" says nothing about this.
    //
    // Deterministic rather than timed: the reader parks INSIDE the handler and
    // waits to be released, so `tryLock` is asked the question at a moment that
    // is known to be mid-read.
    const f = try Fixture.initPooled(2);
    defer f.deinit();

    const pooled = [_]router.Route{
        .{ .method = .GET, .path = "/slow-read", .scopes = &.{.public}, .handler = SlowRead.handler, .read_only = true },
    };
    SlowRead.reset();
    var ctx_copy = f.ctx; // a connection thread gets its own Context, as in serve mode
    const t = try std.Thread.spawn(.{}, SlowRead.drive, .{ &ctx_copy, @as([]const router.Route, &pooled) });
    while (!SlowRead.inside.load(.seq_cst)) std.Thread.yield() catch {};

    // Mid-read, the write lock is free — and a real write goes through.
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
    // The control. Without it the test above proves only that the lock happened
    // to be free, not that the flag is what freed it — same handler, same
    // fixture, same moment, one field different.
    const f = try Fixture.initPooled(2);
    defer f.deinit();

    const locked = [_]router.Route{
        .{ .method = .GET, .path = "/slow-read", .scopes = &.{.public}, .handler = SlowRead.handler },
    };
    SlowRead.reset();
    var ctx_copy = f.ctx;
    const t = try std.Thread.spawn(.{}, SlowRead.drive, .{ &ctx_copy, @as([]const router.Route, &locked) });
    while (!SlowRead.inside.load(.seq_cst)) std.Thread.yield() catch {};

    // The whole-handler lock is held for the read's entire duration: every write
    // on the server is queued behind it. That is the status quo the pool exists
    // to end.
    try std.testing.expect(!f.db_lock.tryLock());

    SlowRead.let_go.store(true, .seq_cst);
    t.join();
    try std.testing.expect(f.db_lock.tryLock()); // and released afterwards
    f.db_lock.unlock(std.testing.io);
}

test "an SSE stream borrows no reader, so eight open tabs cannot exhaust the pool" {
    // Entry 4's deadlock, expressed as a test rather than a comment. A stream
    // that borrowed for its LIFETIME (minutes) while using microseconds of
    // connection would let a handful of browser tabs starve every read on the
    // server. Two things stop it, and both are asserted: the route is
    // `manual_db_lock`, which `router.readOnlyConflict` makes impossible to
    // combine with `read_only`; and dispatch borrows per OPERATION, so nothing
    // holds a lease across a handler that parks.
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

    // The pool is untouched: no lease was taken, so none can have been kept.
    try std.testing.expectEqual(@as(usize, 2), f.pool.?.available());
}

// ---- the read_only audit (§5) ----
//
// The classification is the dangerous half of the reader pool: a route wrongly
// flagged runs its writes through a connection that refuses them. So it is
// MECHANICALLY CHECKED rather than read through once, twice over, because the two
// checks catch different mistakes:
//
//   1. **Against a real reader.** SQLite answers `SQLITE_READONLY` to any write,
//      so a misclassified route surfaces as a 5xx here rather than as corruption.
//   2. **Against the writer, with a row-mutation hook armed.** That catches the
//      write check (1) cannot see: a heal or a bump whose failure is swallowed by
//      a `catch {}`, which on a reader would answer 200 with quietly degraded
//      data. `ControlPlaneService`'s lazy index backfill is exactly that shape,
//      and it is why the whole listing/metadata family is NOT flagged.
//
// A flagged route with no probe below fails the coverage assertion, so the audit
// grows with the table instead of decaying beside it.

/// One request that reaches a `read_only` route's handler. `route` is the
/// route's DECLARED path (the coverage key); `path` is the concrete URL.
const ReadOnlyProbe = struct {
    route: []const u8,
    path: []const u8,
    method: []const u8,
    body: []const u8 = "",
    face: enum { none, device, web } = .none,
};

/// Drives every probe and asserts none of them fails with a 5xx. A 404 is fine —
/// what is under test is that the handler ran to a decision without needing to
/// write, not that the fixture happens to hold the row it asked for.
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

/// Builds the probe list against seeded rows. Paths are arena-owned.
fn readOnlyProbes(a: std.mem.Allocator, note_id: u64, ver_id: u64, ver_md5: []const u8, trashed_id: u64, trashed_md5: []const u8) ![]const ReadOnlyProbe {
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
        .{ .route = "/api/controlplane/search", .path = "/api/controlplane/search?q=hello", .method = "GET", .face = .web },
    };
    try out.appendSlice(a, &fixed);

    // The id- and md5-bearing routes, against rows that really exist — a probe
    // that 404s before reaching the DB work would audit nothing.
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
    try out.append(a, .{
        .route = "/api/controlplane/note/:id/search",
        .path = try std.fmt.allocPrint(a, "/api/controlplane/note/{d}/search?q=hello", .{note_id}),
        .method = "GET",
        .face = .web,
    });
    try out.append(a, .{
        .route = "/api/controlplane/note/:id/txt-search",
        .path = try std.fmt.allocPrint(a, "/api/controlplane/note/{d}/txt-search?q=hello", .{note_id}),
        .method = "GET",
        .face = .web,
    });
    try out.append(a, .{
        .route = "/api/controlplane/note/:id/history/:md5/search",
        .path = try std.fmt.allocPrint(a, "/api/controlplane/note/{d}/history/{s}/search?q=hello", .{ ver_id, ver_md5 }),
        .method = "GET",
        .face = .web,
    });
    try out.append(a, .{
        .route = "/api/controlplane/bin/note/:id/search",
        .path = try std.fmt.allocPrint(a, "/api/controlplane/bin/note/{d}/search?q=hello", .{trashed_id}),
        .method = "GET",
        .face = .web,
    });
    try out.append(a, .{
        .route = "/api/controlplane/bin/note/:id/history/:md5/search",
        .path = try std.fmt.allocPrint(a, "/api/controlplane/bin/note/{d}/history/{s}/search?q=hello", .{ trashed_id, trashed_md5 }),
        .method = "GET",
        .face = .web,
    });
    return out.items;
}

/// Seeds the rows the probes need and returns a fixture ready to audit.
const AuditData = struct {
    web_tok: [32]u8,
    dev_tok: [32]u8,
    note_id: u64,
    ver_id: u64,
    ver_md5: [32]u8,
    trashed_id: u64,
    trashed_md5: [32]u8,
};

fn seedAuditData(f: *Fixture) !AuditData {
    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const web_tok = try onboardWeb(&f.ctx, "admin", "temp0000", "adminpw1");
    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(&f.ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN-AUDIT");

    const note_id = try seedRecognizedNote(f, admin, "audit.note", &.{"hello"});

    // A file with a RETAINED version: the same name uploaded twice.
    _ = try seedRecognizedVersion(f, admin, "versioned.note", "aaaa", &.{"hello"});
    const ver_id = try seedRecognizedVersion(f, admin, "versioned.note", "bbbb", &.{"hello"});
    const ver_md5 = try soleHistoryMd5(f, ver_id);

    // The same, then trashed — so the bin's own search and its view-only history
    // search each have something real to answer about. A probe that 404s before
    // reaching the DB work would audit nothing.
    _ = try seedRecognizedVersion(f, admin, "trashed.note", "cccc", &.{"hello"});
    const trashed_id = try seedRecognizedVersion(f, admin, "trashed.note", "dddd", &.{"hello"});
    const trashed_md5 = try soleHistoryMd5(f, trashed_id);
    try f.files.trash(admin, trashed_id);

    return .{
        .web_tok = web_tok,
        .dev_tok = dev_tok,
        .note_id = note_id,
        .ver_id = ver_id,
        .ver_md5 = ver_md5,
        .trashed_id = trashed_id,
        .trashed_md5 = trashed_md5,
    };
}

test "every read_only route has a probe, so the audit grows with the table instead of decaying" {
    // The coverage half. Without it a new `read_only` route would simply not be
    // audited, and the two tests below would keep passing while the claim they
    // check stopped covering the table.
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const probes = try readOnlyProbes(arena.allocator(), 1, 1, "0" ** 32, 1, "0" ** 32);

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

    // And nothing claims to probe a route that is not flagged — a stale probe
    // would make the coverage count look healthier than it is.
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
    // §5's check. The pool is real, so each of these runs on a connection SQLite
    // will not let write — a misclassified route fails here instead of failing on
    // a household's database.
    const f = try Fixture.initPooled(2);
    defer f.deinit();
    const d = try seedAuditData(f);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const probes = try readOnlyProbes(arena.allocator(), d.note_id, d.ver_id, &d.ver_md5, d.trashed_id, &d.trashed_md5);
    try driveReadOnlyProbes(f, probes, &d.web_tok, &d.dev_tok);

    // They really did run on readers, rather than all falling back and proving
    // nothing: at least one pooled window was recorded, and every lease came back.
    var pooled: u64 = 0;
    for (&f.stats.slots) |*s| pooled += s.read_count;
    try std.testing.expect(pooled >= probes.len);
    try std.testing.expectEqual(@as(usize, 2), f.pool.?.available());
}

test "no read_only route mutates a row, including through a write whose failure would be swallowed" {
    // The check a read-only connection CANNOT make. `ControlPlaneService`'s lazy
    // index backfill writes on the read path and discards its own error, so on a
    // reader it would answer 200 with degraded data — the exact silent
    // misclassification this whole flag has to avoid. Driving the same routes
    // against the WRITER with `sqlite3_update_hook` armed makes any row mutation
    // visible whether it succeeded, failed or was ignored.
    //
    // Pool size 0 so every route takes the writer path: the hook can only watch
    // the connection it is armed on.
    const f = try Fixture.initPooled(0);
    defer f.deinit();
    const d = try seedAuditData(f);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const probes = try readOnlyProbes(arena.allocator(), d.note_id, d.ver_id, &d.ver_md5, d.trashed_id, &d.trashed_md5);

    var watch: sqlite.WriteWatch = .{ .db = f.db };
    watch.arm();
    defer watch.disarm();
    // One probe at a time, so a failure NAMES the route. A single aggregate count
    // would say "something wrote" and leave the next person to bisect by hand.
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
    // The category where a mistake is corruption rather than slowness: each of
    // these reads a row, decides on it, and writes back — `upload/finish` (decref
    // + `addUsed`), purge, restore, elevate, login. They must hold the write lock
    // across every statement, and the flag defaulting to FALSE is what makes that
    // the outcome of forgetting rather than of remembering. Pinned by name so
    // "someone flags it while sweeping through the table" is a red test.
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

    // The flag's default, stated where it can be checked: an undeclared route is
    // slow, never wrong.
    const undeclared: router.Route = .{
        .method = .GET,
        .path = "/x",
        .scopes = &.{.public},
        .handler = poolReadHandler,
    };
    try std.testing.expect(!undeclared.read_only);
}
