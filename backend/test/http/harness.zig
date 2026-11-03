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

/// The single retained-version md5 of `file_id`.
pub fn soleHistoryMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM file_history WHERE file_id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoHistory;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0)[0..32]);
    return out;
}

pub fn currentFileMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM files WHERE id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoFile;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0)[0..32]);
    return out;
}

pub fn countRows(f: *Fixture, sql: []const u8) !i64 {
    var s = try f.db.prepare(sql);
    defer s.finalize();
    _ = try s.step();
    return s.columnInt(0);
}

pub fn deviceRequest(ctx: *Context, obuf: []u8, reqbuf: []u8, method: []const u8, path: []const u8, token: []const u8, eno: []const u8, body: []const u8) !Response {
    const req = try buildRequest(reqbuf, method, path, &.{
        .{ .name = "content-type", .value = "application/json" },
        .{ .name = "x-access-token", .value = token },
        .{ .name = "equipmentNo", .value = eno },
    }, body);
    return roundtrip(ctx, req, obuf);
}

pub fn deviceLogin(ctx: *Context, obuf: []u8, reqbuf: []u8, account: []const u8, pw: []const u8, eno: []const u8) ![32]u8 {
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

pub fn putSeed(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, data: []const u8) !u64 {
    var r = std.Io.Reader.fixed(data);
    const e = try f.files.putFile(user_id, parent, name, &r, null);
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
    return e.id;
}

pub fn usedBytes(f: *Fixture, user_id: u64) !i64 {
    var s = try f.db.prepare("SELECT used_bytes FROM capacity WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    _ = try s.step();
    return s.columnInt(0);
}

/// Files staged under the blob store's `tmp/`, where a refused upload could
/// strand bytes.
pub fn blobTempCount(f: *Fixture) !usize {
    var d = try f.tmp.dir.openDir(std.testing.io, "tmp", .{ .iterate = true });
    defer d.close(std.testing.io);
    var it = d.iterate();
    var n: usize = 0;
    while (try it.next(std.testing.io)) |_| n += 1;
    return n;
}

/// `len` bytes of a non-repeating pattern with no multipart delimiter look-alike.
pub fn filler(len: usize) ![]u8 {
    const buf = try gpa.alloc(u8, len);
    for (buf, 0..) |*b, i| b.* = @intCast((i * 31 + 7) & 0xFF);
    return buf;
}

/// The most a capped ingest may read before refusing: the cap plus three
/// `chunk_len` reads of framing and lookahead headroom.
pub fn cappedReadCeiling(limit: usize) usize {
    return limit + 3 * blobstore.chunk_len;
}

pub fn countTrashed(f: *Fixture, user_id: u64) !i64 {
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
pub fn searchHits(f: *Fixture, user_id: u64, q: []const u8) !usize {
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

/// Stores a synthetic `.note` (one main layer per page); returns the file id.
pub fn seedNoteHttp(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, page_bitmaps: []const []const u8) !u64 {
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

/// A one-page `.note` with finished recognition holding `labels`.
pub fn seedRecognizedNote(f: *Fixture, user_id: u64, name: []const u8, labels: []const []const u8) !u64 {
    return seedRecognizedElements(f, user_id, name, "N6", blk: {
        const nb = @import("note_builder");
        const els = try gpa.alloc(nb.ElementSpec, labels.len);
        for (labels, els) |label, *e| e.* = .{ .label = label };
        break :blk els;
    }, true);
}

/// A recognized note with explicit `APPLY_EQUIPMENT` (null = unmeasured
/// hardware) and per-word boxes. `owns_elements` frees the slice.
pub fn seedRecognizedElements(
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

/// `putSeed` plus the blob md5 (the raw-file route's `?v=`).
pub const Seeded = struct { id: u64, md5: [32]u8 };

pub fn putSeedHashed(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, data: []const u8) !Seeded {
    var r = std.Io.Reader.fixed(data);
    const e = try f.files.putFile(user_id, parent, name, &r, null);
    defer gpa.free(e.name);
    defer if (e.md5) |m| gpa.free(m);
    var out: Seeded = .{ .id = e.id, .md5 = undefined };
    @memcpy(&out.md5, e.md5.?);
    return out;
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

/// A minimal `.spd` (SQLite with a `config` table) as bytes; `thumbnail` null
/// omits the `thumbnail` row.
pub fn buildSpdFixture(thumb: ?[]const u8) ![]u8 {
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
