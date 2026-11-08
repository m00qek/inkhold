//! The db lock, the reader pool and the read_only audit.

const std = @import("std");
const repeat = @import("../../util/repeat.zig").repeat;
const app = @import("../../routes.zig");
const transport = @import("../../http/transport.zig");
const context = @import("../../http/context.zig");
const router = @import("../../http/router.zig");
const sqlite = @import("../../db/sqlite.zig");
const password = @import("../../services/auth/password.zig");
const lockstats = @import("../../http/lock_stats.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Header = harness.Header;
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const parseResponse = harness.parseResponse;
const onboardWeb = harness.onboardWeb;
const elevate = harness.elevate;
const Fixture = harness.Fixture;
const deviceLogin = harness.deviceLogin;
const putSeed = harness.putSeed;
const seedNoteHttp = harness.seedNoteHttp;
const seedRecognizedNote = harness.seedRecognizedNote;
const requestWithCookie = harness.requestWithCookie;
const expectSuccess = harness.expectSuccess;
const putSeedHashed = harness.putSeedHashed;

/// A slot's (seconds, remainder) pair as nanoseconds (the pair exists because
/// ARMv6 has no 64-bit atomic).
fn nsOfSlot(s: *const lockstats.Slot) u64 {
    return @as(u64, s.total_s) * std.time.ns_per_s + s.total_ns_rem;
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

test "manual_db_lock is set on EXACTLY the two /oss routes, the page route, the raw-file routes, the thumbnail route, the SSE route, the device socket route, the device list_folder route and the web upload route" {
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
        // Held for the tablet's whole connection; locks only to check the token.
        "/socket.io/",
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
        // A digest's handwritten note: streamed bytes, like `/oss/get/:id`.
        "/oss/summary/:id",
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
        _ = ctx.files.syncVersion(1) catch {};
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

const shared = @import("pool_helpers.zig");
const poolReadHandler = shared.poolReadHandler;
