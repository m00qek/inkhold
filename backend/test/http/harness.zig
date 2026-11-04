//! The HTTP test harness: an in-memory transport, a fixture, and the helpers
//! more than one test file shares.

const std = @import("std");
const app = @import("../../routes.zig");
const transport = @import("../../http/transport.zig");
const context = @import("../../http/context.zig");
const router = @import("../../http/router.zig");
const sqlite = @import("../../db/sqlite.zig");
const schema = @import("../../db/schema.zig");
const authsvc = @import("../../services/auth/service.zig");
const password = @import("../../services/auth/password.zig");
const ratelimit = @import("../../http/ratelimit.zig");
const dltokensmod = @import("../../http/download_tokens.zig");
const filesmod = @import("../../services/files.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const readerpool = @import("../../db/reader_pool.zig");
const lockstats = @import("../../http/lock_stats.zig");
const Context = context.Context;
const gpa = std.testing.allocator;

const harness_seed = @import("harness_seed.zig");
pub const soleHistoryMd5 = harness_seed.soleHistoryMd5;
pub const currentFileMd5 = harness_seed.currentFileMd5;
pub const countRows = harness_seed.countRows;
pub const deviceRequest = harness_seed.deviceRequest;
pub const deviceLogin = harness_seed.deviceLogin;
pub const putSeed = harness_seed.putSeed;
pub const usedBytes = harness_seed.usedBytes;
pub const blobTempCount = harness_seed.blobTempCount;
pub const filler = harness_seed.filler;
pub const cappedReadCeiling = harness_seed.cappedReadCeiling;
pub const countTrashed = harness_seed.countTrashed;
pub const searchHits = harness_seed.searchHits;
pub const seedNoteHttp = harness_seed.seedNoteHttp;
pub const seedRecognizedNote = harness_seed.seedRecognizedNote;
pub const seedRecognizedElements = harness_seed.seedRecognizedElements;
pub const Seeded = harness_seed.Seeded;
pub const putSeedHashed = harness_seed.putSeedHashed;
pub const buildSpdFixture = harness_seed.buildSpdFixture;

pub const Header = struct { name: []const u8, value: []const u8 };

pub const Response = struct {
    status: u16,
    body: []const u8, // slice into the caller's response buffer
    set_cookie: ?[]const u8,
    head: []const u8, // the raw header block (status line + headers), for header assertions
};

pub fn buildRequest(buf: []u8, method: []const u8, path: []const u8, headers: []const Header, body: []const u8) ![]const u8 {
    var w = std.Io.Writer.fixed(buf);
    try w.print("{s} {s} HTTP/1.1\r\n", .{ method, path });
    try w.writeAll("host: test\r\n");
    for (headers) |h| try w.print("{s}: {s}\r\n", .{ h.name, h.value });
    try w.print("content-length: {d}\r\n\r\n", .{body.len});
    try w.writeAll(body);
    return buf[0..w.end];
}

pub fn roundtrip(ctx: *Context, req_bytes: []const u8, out_buf: []u8) !Response {
    var in = std.Io.Reader.fixed(req_bytes);
    var out = std.Io.Writer.fixed(out_buf);
    var server = std.http.Server.init(&in, &out);
    var req = try server.receiveHead();
    try transport.handle(ctx, &app.routes, &req);
    return parseResponse(out_buf[0..out.end]);
}

/// `roundtrip` plus how many request bytes the server read: the ingest cap is
/// about where a body stops, so tests assert on this, not just the aftermath.
pub const Sent = struct { resp: Response, consumed: usize };

pub fn roundtripCounting(ctx: *Context, req_bytes: []const u8, out_buf: []u8) !Sent {
    var in = std.Io.Reader.fixed(req_bytes);
    var out = std.Io.Writer.fixed(out_buf);
    var server = std.http.Server.init(&in, &out);
    var req = try server.receiveHead();
    try transport.handle(ctx, &app.routes, &req);
    return .{ .resp = try parseResponse(out_buf[0..out.end]), .consumed = in.seek };
}

pub fn parseResponse(raw: []const u8) !Response {
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
pub fn cookieToken(set_cookie: []const u8) ?[]const u8 {
    const prefix = context.session_cookie_name ++ "=";
    if (!std.mem.startsWith(u8, set_cookie, prefix)) return null;
    const rest = set_cookie[prefix.len..];
    const end = std.mem.indexOfScalar(u8, rest, ';') orelse rest.len;
    return rest[0..end];
}

/// The login password field: `sha256_hex(md5_hex(pw) + randomCode)` over the
/// full nonce.
pub fn challenge(pw: []const u8, code: []const u8) [password.sha256_len]u8 {
    return password.challengeHash(&password.md5Hex(pw), code);
}

/// A random code for `account`, copied out (the response buffer is reused).
pub fn getCode(ctx: *Context, account: []const u8) ![authsvc.code_len]u8 {
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
pub fn onboardWeb(ctx: *Context, account: []const u8, temp: []const u8, final_pw: []const u8) ![32]u8 {
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
pub fn tryElevate(ctx: *Context, obuf: []u8, reqbuf: []u8, account: []const u8, pw: []const u8, tok: []const u8) !Response {
    const code = try getCode(ctx, account);
    const hash = challenge(pw, &code);
    const body = try std.fmt.allocPrint(gpa, "{{\"password\":\"{s}\"}}", .{hash[0..]});
    defer gpa.free(body);
    return requestWithCookie(ctx, obuf, reqbuf, "POST", "/api/admin/elevate", tok, body);
}

pub fn elevate(ctx: *Context, obuf: []u8, reqbuf: []u8, account: []const u8, pw: []const u8, tok: []const u8) !void {
    const resp = try tryElevate(ctx, obuf, reqbuf, account, pw, tok);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
}

pub const Fixture = struct {
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

    pub fn init() !*Fixture {
        return initWith(false, readerpool.default_size);
    }

    /// On-disk DB, real `db_lock`, per-route histogram and `readers` readers
    /// (`0` = pool always empty).
    pub fn initPooled(readers: usize) !*Fixture {
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
            .db = f.db,
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

    pub fn deinit(f: *Fixture) void {
        f.svc.deinit();
        f.limiter.deinit();
        f.dltokens.deinit();
        // Readers close before the writer, which keeps the `-shm` file alive.
        if (f.pool) |*p| p.close(gpa);
        f.db.close();
        f.tmp.cleanup();
        gpa.destroy(f);
    }

    pub fn slotFor(f: *Fixture, table: []const router.Route, path: []const u8) *const lockstats.Slot {
        for (table, 0..) |r, i| {
            if (std.mem.eql(u8, r.path, path)) return &f.stats.slots[i];
        }
        unreachable;
    }
};

/// One header's value copied out of the head, so a test can echo back the
/// exact `ETag` minted.
pub fn headerValue(head: []const u8, name: []const u8, buf: []u8) ![]const u8 {
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

pub fn requestWithCookie(
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

pub fn expectStatusWithCookie(
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

pub fn expectSuccess(body: []const u8) !void {
    var parsed = try std.json.parseFromSlice(struct { success: bool }, gpa, body, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    try std.testing.expect(parsed.value.success);
}

pub fn expectFailure(body: []const u8, code: []const u8) !void {
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

pub fn listed(list: []const []const u8, path: []const u8) bool {
    for (list) |p| {
        if (std.mem.eql(u8, p, path)) return true;
    }
    return false;
}

/// Fails if `needle` appears anywhere in the response head, under any header.
pub fn expectHeaderAbsentSubstring(head: []const u8, needle: []const u8) !void {
    if (std.mem.indexOf(u8, head, needle) != null) {
        std.debug.print("unexpected `{s}` in response head:\n{s}\n", .{ needle, head });
        return error.UnexpectedHeaderToken;
    }
}

/// The response head lowercased into `buf`, for case-insensitive assertions.
pub fn lowerHead(buf: []u8, head: []const u8) []const u8 {
    const n = @min(buf.len, head.len);
    for (head[0..n], 0..) |c, i| buf[i] = std.ascii.toLower(c);
    return buf[0..n];
}

pub fn expectHeaderContains(head: []const u8, needle: []const u8) !void {
    var buf: [4096]u8 = undefined;
    const lower = lowerHead(&buf, head);
    if (std.mem.indexOf(u8, lower, needle) == null) {
        std.debug.print("missing header fragment `{s}` in:\n{s}\n", .{ needle, head });
        return error.HeaderMissing;
    }
}

pub fn expectHeaderAbsent(head: []const u8, needle: []const u8) !void {
    var buf: [4096]u8 = undefined;
    const lower = lowerHead(&buf, head);
    if (std.mem.indexOf(u8, lower, needle) != null) {
        std.debug.print("unexpected header fragment `{s}` in:\n{s}\n", .{ needle, head });
        return error.UnexpectedHeader;
    }
}
