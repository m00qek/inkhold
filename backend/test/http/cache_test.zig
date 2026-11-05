//! The cache-policy pin: every route classified, every response matching.

const std = @import("std");
const repeat = @import("../../util/repeat.zig").repeat;
const app = @import("../../routes.zig");
const password = @import("../../services/auth/password.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const onboardWeb = harness.onboardWeb;
const elevate = harness.elevate;
const Fixture = harness.Fixture;
const seedRecognizedNote = harness.seedRecognizedNote;
const requestWithCookie = harness.requestWithCookie;
const listed = harness.listed;
const expectHeaderAbsentSubstring = harness.expectHeaderAbsentSubstring;
const putSeedHashed = harness.putSeedHashed;
const expectHeaderContains = harness.expectHeaderContains;

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
    "/api/admin/backups",
    "/api/admin/backups/dismissed",
    "/api/admin/backups/forget",
    "/api/backup-notice",
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
    "/socket.io/",
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
    "/api/file/schedule/group",
    "/api/file/schedule/group/:id",
    "/api/file/schedule/group/all",
    "/api/file/schedule/task",
    "/api/file/schedule/task/:id",
    "/api/file/schedule/task/all",
    "/api/file/schedule/task/list",
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
