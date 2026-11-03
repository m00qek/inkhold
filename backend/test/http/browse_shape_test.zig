//! The manifest bytes, PDF page shape, thumbAspect and layer descriptors over HTTP.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
const password = @import("../../services/auth/password.zig");
const deferredmod = @import("../../services/deferred.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const deviceLogin = harness.deviceLogin;
const putSeed = harness.putSeed;
const seedRecognizedNote = harness.seedRecognizedNote;
const headerValue = harness.headerValue;
const requestWithCookie = harness.requestWithCookie;
const expectHeaderAbsentSubstring = harness.expectHeaderAbsentSubstring;
const expectHeaderContains = harness.expectHeaderContains;
const buildSpdFixture = harness.buildSpdFixture;

test "the search-index manifest is served as bytes, and an unchanged one answers 304" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const keep = try seedRecognizedNote(f, admin, "keep.note", &.{"trimestral"});
    _ = keep;
    const gone = try seedRecognizedNote(f, admin, "gone.note", &.{"trimestral"});

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/manifest", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const bob = (try f.svc.createUser(admin, "bob", false)).id;
        _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN9");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/manifest", &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    var etag_buf: [64]u8 = undefined;
    var etag: []const u8 = "";
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // Binary (`SMAN`), not the 5.2x-larger JSON.
        try std.testing.expect(std.mem.startsWith(u8, resp.body, "SMAN"));
        try std.testing.expectEqual(@as(u8, 1), resp.body[4]);
        try std.testing.expectEqual(@as(u32, 2), std.mem.readInt(u32, resp.body[5..9], .little));
        // Names are deliberately not on the wire; the client has the listing.
        try std.testing.expect(std.mem.indexOf(u8, resp.body, ".note") == null);

        try expectHeaderContains(resp.head, "content-type: application/octet-stream");
        // Not `immutable`: absence from the manifest is the only removal channel.
        try expectHeaderContains(resp.head, "cache-control: private, no-cache");
        try expectHeaderAbsentSubstring(resp.head, "immutable");
        etag = try headerValue(resp.head, "etag", &etag_buf);
        try std.testing.expect(etag.len > 2);
    }

    var cookie_buf: [64]u8 = undefined;
    const cookie = try std.fmt.bufPrint(&cookie_buf, "sn_session={s}", .{web_tok});

    // An unchanged manifest costs a bodiless 304.
    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/manifest", &.{
            .{ .name = "cookie", .value = cookie },
            .{ .name = "if-none-match", .value = etag },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 304), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len);
        // The validator rides on the 304 too, or a client may drop it.
        try expectHeaderContains(resp.head, "etag:");
    }

    // A manifest that lost a row must not 304 (a version-counter validator
    // would): absence is how deletions reach the client.
    {
        try f.files.trash(admin, gone);
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/manifest", &.{
            .{ .name = "cookie", .value = cookie },
            .{ .name = "if-none-match", .value = etag },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(u32, 1), std.mem.readInt(u32, resp.body[5..9], .little));
    }
}

/// A minimal PNG with a 320×240 IHDR, so a `.spd` embedding it gets `thumb_w/h`.
const aspect_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

test "a PDF's tree entry carries its REAL page count and shape, not the 1-page fallback" {
    // A `.pdf` card must report its `page_count`, not the fallback's 1. Three
    // pages, since one would pass either way.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    _ = try putSeed(f, admin, null, "doc.pdf", @embedFile("../../pdf/testdata/three-page.pdf"));
    // A `.txt` (`page_count` 0) keeps the fallback.
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

    // A coverless landscape note, a `.spd` with a 320×240 thumbnail, and a text
    // file (shaped client-side, no server aspect).
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
        // Absent is omitted, never `null`.
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"thumbAspect\":null") == null);
    }

    // Trashed entries still render previews, so the aspect rides bin rows too.
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

/// One layer descriptor; the listing's `firstPage.layers` and the metadata's
/// `pages[].layers` must match exactly (one client code path).
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

    // A real capture whose page 0 carries a `#`-JSON LAYERINFO panel.
    const layered_id = try putSeed(f, admin, null, "layers.note", @embedFile("layers_edited.note"));

    // A page with no layer records must omit the field.
    const nb = @import("note_builder");
    const bare = try nb.serialize(gpa, .{ .pages = &.{.{ .style = "style_white", .layers = &.{} }} });
    defer gpa.free(bare);
    const bare_id = try putSeed(f, admin, null, "bare.note", bare);

    const Page = struct { index: i64 = 0, layers: ?[]const LayerRow = null };
    const Row = struct { name: []const u8, firstPage: ?Page = null };

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
        // Copied out: the parse arena dies with `p`.
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
        // Omitted, never `"layers":null` or `[]`.
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"layers\":null") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"layers\":[]") == null);
    }

    // The bin builds `firstPage` through the same `pageRefAt`.
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
