//! History raw bytes, version meta, restore and the must-change signal over HTTP.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
const password = @import("../../services/auth/password.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const cookieToken = harness.cookieToken;
const challenge = harness.challenge;
const getCode = harness.getCode;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const soleHistoryMd5 = harness.soleHistoryMd5;
const currentFileMd5 = harness.currentFileMd5;
const putSeed = harness.putSeed;
const searchHits = harness.searchHits;
const requestWithCookie = harness.requestWithCookie;
const expectHeaderContains = harness.expectHeaderContains;
const expectHeaderAbsent = harness.expectHeaderAbsent;
const shared = @import("history_helpers.zig");
const seedRecognizedVersion = shared.seedRecognizedVersion;
const seedRecognizedVersionPages = shared.seedRecognizedVersionPages;

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
