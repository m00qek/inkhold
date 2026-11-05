//! Static SPA serving and precompressed variants.

const std = @import("std");
const app = @import("../../routes.zig");
const harness = @import("harness.zig");
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const Fixture = harness.Fixture;
const expectHeaderAbsentSubstring = harness.expectHeaderAbsentSubstring;
const expectHeaderContains = harness.expectHeaderContains;

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

test "static serving validates: an ETag per representation, and a 304 with no body when it matches" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    var web = std.testing.tmpDir(.{});
    defer web.cleanup();
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "big.wasm", .data = "\x00asm\x01\x00\x00\x00RAW" });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "big.wasm.br", .data = "BROTLI" });

    var wd_buf: [256]u8 = undefined;
    ctx.config.web_dir = try std.fmt.bufPrint(&wd_buf, ".zig-cache/tmp/{s}", .{web.sub_path});

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var tag_buf: [128]u8 = undefined;
    var br_tag_buf: [128]u8 = undefined;
    var hdr_buf: [160]u8 = undefined;

    const raw_tag = blk: {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/big.wasm", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        const t = try harness.headerValue(resp.head, "etag", &tag_buf);
        try std.testing.expect(t.len > 2 and t[0] == '"' and t[t.len - 1] == '"');
        break :blk t;
    };
    const br_tag = blk: {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/big.wasm", &.{
            .{ .name = "accept-encoding", .value = "br" },
        }, ""), &obuf);
        try std.testing.expectEqualStrings("BROTLI", resp.body);
        break :blk try harness.headerValue(resp.head, "etag", &br_tag_buf);
    };
    // The br and raw bytes are different representations: never one tag.
    try std.testing.expect(!std.mem.eql(u8, raw_tag, br_tag));

    // The browser's revalidation: a match is a 304 with no body.
    {
        const inm = try std.fmt.bufPrint(&hdr_buf, "{s}", .{br_tag});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/big.wasm", &.{
            .{ .name = "accept-encoding", .value = "br" },
            .{ .name = "if-none-match", .value = inm },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 304), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
    }

    // A tag for another representation is no match: the bytes are sent.
    {
        const inm = try std.fmt.bufPrint(&hdr_buf, "{s}", .{raw_tag});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/big.wasm", &.{
            .{ .name = "accept-encoding", .value = "br" },
            .{ .name = "if-none-match", .value = inm },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("BROTLI", resp.body);
    }
}

test "a rebuilt index.html of the same size and modification time still gets a new ETag" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    var web = std.testing.tmpDir(.{});
    defer web.cleanup();
    var wd_buf: [256]u8 = undefined;
    ctx.config.web_dir = try std.fmt.bufPrint(&wd_buf, ".zig-cache/tmp/{s}", .{web.sub_path});

    // A rebuild renames the hashed bundle and keeps its length; a reproducible
    // build may also pin every file's modification time.
    const pinned: std.Io.Timestamp = .{ .nanoseconds = 1_700_000_000 * std.time.ns_per_s };
    const builds = [_][]const u8{
        "<script src=\"./assets/index-AAAAAAAA.js\"></script>",
        "<script src=\"./assets/index-BBBBBBBB.js\"></script>",
    };
    var tags: [2][128]u8 = undefined;
    var lens: [2]usize = undefined;
    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    for (builds, 0..) |html, i| {
        try web.dir.writeFile(std.testing.io, .{ .sub_path = "index.html", .data = html });
        var file = try web.dir.openFile(std.testing.io, "index.html", .{ .mode = .read_write });
        try file.setTimestamps(std.testing.io, .{ .modify_timestamp = .{ .new = pinned } });
        file.close(std.testing.io);

        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/", &.{}, ""), &obuf);
        try std.testing.expectEqualStrings(html, resp.body);
        const t = try harness.headerValue(resp.head, "etag", &tags[i]);
        lens[i] = t.len;
    }
    try std.testing.expect(!std.mem.eql(u8, tags[0][0..lens[0]], tags[1][0..lens[1]]));

    // And the old tag no longer earns a 304: the browser gets the new page.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/", &.{
            .{ .name = "if-none-match", .value = tags[0][0..lens[0]] },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(builds[1], resp.body);
    }
}
