//! The db lock, the reader pool and the read_only audit.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
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
