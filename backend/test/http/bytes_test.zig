//! The byte routes: raw files, thumbnails and templates.

const std = @import("std");
const repeat = @import("../../util/repeat.zig").repeat;
const password = @import("../../services/auth/password.zig");
const noteindex = @import("../../services/note_index.zig");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Response = harness.Response;
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const deviceLogin = harness.deviceLogin;
const requestWithCookie = harness.requestWithCookie;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const putSeedHashed = harness.putSeedHashed;
const expectHeaderContains = harness.expectHeaderContains;
const expectHeaderAbsent = harness.expectHeaderAbsent;
const buildSpdFixture = harness.buildSpdFixture;

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
