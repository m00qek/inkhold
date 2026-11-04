//! The web app's browse and read endpoints over HTTP.

const std = @import("std");
const repeat = @import("../../util/repeat.zig").repeat;
const transport = @import("../../http/transport.zig");
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
const seedNoteHttp = harness.seedNoteHttp;
const seedRecognizedNote = harness.seedRecognizedNote;
const seedRecognizedElements = harness.seedRecognizedElements;
const headerValue = harness.headerValue;
const requestWithCookie = harness.requestWithCookie;
const expectHeaderAbsentSubstring = harness.expectHeaderAbsentSubstring;
const expectHeaderContains = harness.expectHeaderContains;
const buildSpdFixture = harness.buildSpdFixture;

test "control-plane browse/read: tree, note meta, page bytes (immutable), and SSE — auth enforced" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const work = try f.files.createFolder(admin, null, "Work");
    defer gpa.free(work.name);
    const top_id = try seedNoteHttp(f, admin, null, "top.note", &.{"AAAA"});
    _ = try seedNoteHttp(f, admin, work.id, "deep.note", &.{ "AAAA", "BBBBBB" });

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/tree", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const alice = (try f.svc.createUser(admin, "alice", false)).id;
        _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/tree", &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    var work_id_str: [20]u8 = undefined;
    var work_id_len: usize = 0;
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            folderId: ?[]const u8 = null,
            path: []const struct { kind: []const u8, id: []const u8, name: []const u8 },
            entries: []const struct {
                kind: []const u8,
                id: []const u8,
                name: []const u8,
                pageCount: ?i64 = null,
                firstPage: ?struct { index: i64, hash: []const u8, width: i64, height: i64 } = null,
                updatedAt: ?i64 = null,
                thumbAspect: ?struct { w: i64, h: i64 } = null,
            },
            syncVersion: i64,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.folderId == null);
        try std.testing.expectEqual(@as(usize, 0), p.value.path.len);
        try std.testing.expectEqual(@as(usize, 2), p.value.entries.len);
        try std.testing.expectEqualStrings("folder", p.value.entries[0].kind);
        try std.testing.expectEqualStrings("Work", p.value.entries[0].name);
        // Absent is omitted, never `"thumbAspect":null`.
        try std.testing.expect(p.value.entries[0].thumbAspect == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"thumbAspect\":null") == null);
        const n = p.value.entries[1];
        try std.testing.expectEqualStrings("note", n.kind);
        try std.testing.expectEqualStrings("top.note", n.name);
        try std.testing.expectEqual(@as(i64, 1), n.pageCount.?);
        try std.testing.expectEqual(@as(usize, 32), n.firstPage.?.hash.len);
        try std.testing.expectEqual(@as(i64, 1404), n.firstPage.?.width);
        try std.testing.expectEqual(@as(i64, 1404), n.thumbAspect.?.w);
        try std.testing.expectEqual(@as(i64, 1872), n.thumbAspect.?.h);
        try std.testing.expect(p.value.syncVersion > 0);
        @memcpy(work_id_str[0..p.value.entries[0].id.len], p.value.entries[0].id);
        work_id_len = p.value.entries[0].id.len;
    }

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/tree?parent={s}", .{work_id_str[0..work_id_len]});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            folderId: ?[]const u8 = null,
            path: []const struct { name: []const u8 },
            entries: []const struct { name: []const u8, pageCount: ?i64 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings(work_id_str[0..work_id_len], p.value.folderId.?);
        try std.testing.expectEqual(@as(usize, 1), p.value.path.len);
        try std.testing.expectEqualStrings("Work", p.value.path[0].name);
        try std.testing.expectEqual(@as(usize, 1), p.value.entries.len);
        try std.testing.expectEqual(@as(i64, 2), p.value.entries[0].pageCount.?);
    }

    var page0_hash: [32]u8 = undefined;
    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{top_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            id: []const u8,
            name: []const u8,
            pages: []const struct { index: i64, hash: []const u8, width: i64, height: i64 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("top.note", p.value.name);
        try std.testing.expectEqual(@as(usize, 1), p.value.pages.len);
        try std.testing.expectEqual(@as(i64, 0), p.value.pages[0].index);
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].hash.len);
        @memcpy(&page0_hash, p.value.pages[0].hash);
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/file/metadata/99999", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ top_id, page0_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(resp.body.len >= 4);
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") != null);
        try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "etag:") != null);
    }

    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ top_id, repeat(u8, "0", 32) });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/9?v={s}", .{ top_id, page0_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "text/event-stream") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "data: ") != null);
    }
}

/// Page 0 rasterised from a PDF template with its links (`note-format.md`
/// §14); page 1 has none.
fn seedLinkedNote(f: *Fixture, user_id: u64, name: []const u8) !u64 {
    const nb = @import("note_builder");
    const bytes = try nb.serialize(gpa, .{ .pages = &.{
        .{
            .style = "user_pdf_planner_1",
            .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
            .links = &.{
                .{ .target_page = 2, .x = 901, .y = 192, .w = 407, .h = 50 },
                .{ .uri = "https://onplanners.com/g?a=1,2", .x = 53, .y = 464, .w = 297, .h = 121 },
                .{ .uri = "javascript:alert(1)", .x = 10, .y = 10, .w = 50, .h = 50 },
            },
        },
        .{ .layers = &.{.{ .slot = .main, .bitmap = "BBBB" }} },
    } });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer e.deinit(gpa);
    return e.id;
}

test "control-plane page links: raw VO, versioned by linksHash, revalidated, 404 where there are none" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const id = try seedLinkedNote(f, admin, "planner.note");
    const plain_id = try seedNoteHttp(f, admin, null, "plain.note", &.{"AAAA"});

    // `linksHash` is omitted on pages without links, so the reader never asks.
    var links_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8, linksHash: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].linksHash.?.len);
        try std.testing.expect(p.value.pages[1].linksHash == null);
        @memcpy(&links_hash, p.value.pages[0].linksHash.?);
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "linksHash") == null);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links?v={s}", .{ id, links_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // Struct-serialised: `?v=` versions content, not shape, so no-cache.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null);

        var p = try std.json.parseFromSlice(struct {
            links: []const struct { x: f64, y: f64, w: f64, h: f64, page: i64, uri: []const u8 },
        }, gpa, resp.body, .{});
        defer p.deinit();
        // The `javascript:` record is filtered server-side too (the exporter
        // reads this endpoint).
        try std.testing.expectEqual(@as(usize, 2), p.value.links.len);
        // 1-based page 2 is index 1; `none` is external, spelled -1.
        try std.testing.expectEqual(@as(i64, 1), p.value.links[0].page);
        try std.testing.expectEqual(@as(f64, 901), p.value.links[0].x);
        try std.testing.expectEqual(@as(i64, -1), p.value.links[1].page);
        try std.testing.expectEqualStrings("https://onplanners.com/g?a=1,2", p.value.links[1].uri);
    }

    const stale = repeat(u8, "0", 32);
    const cases = [_]struct { id: u64, page: []const u8, v: []const u8 }{
        .{ .id = id, .page = "0", .v = stale },
        .{ .id = id, .page = "1", .v = &links_hash }, // the ordinary page
        .{ .id = plain_id, .page = "0", .v = &links_hash },
        .{ .id = id, .page = "9", .v = &links_hash },
        .{ .id = 99999, .page = "0", .v = &links_hash },
    };
    for (cases) |c| {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/{s}/links?v={s}", .{ c.id, c.page, c.v });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links?v={s}", .{ id, links_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN9");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links?v={s}", .{ id, links_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    // The row is keyed by blob md5 and shared by dedup; another account with
    // identical bytes must not reach it.
    {
        const bob = try f.svc.createUser(admin, "bob", false);
        const bob_tok = try onboardWeb(ctx, "bob", bob.temp_password.slice(), "bpass111");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/links?v={s}", .{ id, links_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &bob_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}
