//! SSE streams borrow no reader, and the read_only audit.

const std = @import("std");
const app = @import("../../routes.zig");
const context = @import("../../http/context.zig");
const router = @import("../../http/router.zig");
const sqlite = @import("../../db/sqlite.zig");
const password = @import("../../services/auth/password.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Header = harness.Header;
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const onboardWeb = harness.onboardWeb;
const elevate = harness.elevate;
const Fixture = harness.Fixture;
const deviceLogin = harness.deviceLogin;
const seedRecognizedNote = harness.seedRecognizedNote;
const requestWithCookie = harness.requestWithCookie;
const shared = @import("pool_helpers.zig");
const poolReadHandler = shared.poolReadHandler;

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
        .{ .route = "/api/backup-notice", .path = "/api/backup-notice", .method = "GET", .face = .web },
        .{ .route = "/api/controlplane/todo", .path = "/api/controlplane/todo", .method = "GET", .face = .web },
        .{ .route = "/api/controlplane/digests", .path = "/api/controlplane/digests", .method = "GET", .face = .web },
        .{ .route = "/api/controlplane/digests/bin", .path = "/api/controlplane/digests/bin", .method = "GET", .face = .web },
        .{ .route = "/api/user/query", .path = "/api/user/query", .method = "POST", .body = "{}", .face = .device },
        .{ .route = "/api/equipment/bind/status", .path = "/api/equipment/bind/status", .method = "POST", .body = "{}", .face = .device },
        .{ .route = "/api/file/capacity/query", .path = "/api/file/capacity/query", .method = "POST", .body = "{}", .face = .device },
        .{ .route = "/api/file/2/users/get_space_usage", .path = "/api/file/2/users/get_space_usage", .method = "POST", .body = "{}", .face = .device },
        .{ .route = "/api/file/query/summary/group", .path = "/api/file/query/summary/group", .method = "POST", .body = "{\"page\":0,\"size\":50}", .face = .device },
        .{ .route = "/api/file/query/summary", .path = "/api/file/query/summary", .method = "POST", .body = "{\"page\":1,\"size\":1000}", .face = .device },
        .{ .route = "/api/file/query/summary/tag", .path = "/api/file/query/summary/tag", .method = "GET", .face = .device },
        .{ .route = "/api/file/download/summary", .path = "/api/file/download/summary", .method = "POST", .body = "{\"id\":1}", .face = .device },
        .{ .route = "/api/file/3/files/query/by/path_v3", .path = "/api/file/3/files/query/by/path_v3", .method = "POST", .body = "{\"path\":\"/audit.note\"}", .face = .device },
        // The manifest never calls `indexRowEnsuring`, so it heals nothing.
        .{ .route = "/api/controlplane/search-index/manifest", .path = "/api/controlplane/search-index/manifest", .method = "GET", .face = .web },
        .{ .route = "/api/controlplane/search-index/coverage", .path = "/api/controlplane/search-index/coverage", .method = "GET", .face = .web },
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
