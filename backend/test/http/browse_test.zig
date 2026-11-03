//! The web app's browse and read endpoints over HTTP.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
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
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
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

test "control-plane page text: raw VO, versioned by textHash, revalidated, 404 on stale or unrecognized" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const rec_id = try seedRecognizedNote(f, admin, "rec.note", &.{ "Test", "Middle" });
    const plain_id = try seedNoteHttp(f, admin, null, "plain.note", &.{"AAAA"}); // no recognition

    var text_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8, textHash: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].textHash.?.len);
        @memcpy(&text_hash, p.value.pages[0].textHash.?);
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "textHash") == null);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // `PageTextVO` shape can change under the same `?v=`, so no-cache.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null); // raw VO
        var p = try std.json.parseFromSlice(struct { text: ?[]const u8 = null }, gpa, resp.body, .{});
        defer p.deinit();
        try std.testing.expectEqualStrings("Test\nMiddle", p.value.text.?); // v7: regions newline-joined
    }

    const stale = repeat(u8, "0", 32);
    const cases = [_]struct { id: u64, page: []const u8, v: []const u8 }{
        .{ .id = rec_id, .page = "0", .v = stale }, // stale `?v=`
        .{ .id = plain_id, .page = "0", .v = &text_hash }, // never recognized
        .{ .id = plain_id, .page = "0", .v = stale }, // ...with any version at all
        .{ .id = rec_id, .page = "9", .v = &text_hash }, // out of range
        .{ .id = 99999, .page = "0", .v = &text_hash }, // no such note
    };
    for (cases) |c| {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/{s}/text?v={s}", .{ c.id, c.page, c.v });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN9");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    // Keyed by blob md5 and shared by dedup: another account must not reach it.
    {
        const bob = try f.svc.createUser(admin, "bob", false);
        const bob_tok = try onboardWeb(ctx, "bob", bob.temp_password.slice(), "bpass111");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &bob_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "control-plane listing: hasRecognizedText tracks finished on-device recognition; textHash rides the page list" {
    // Pins `hasRecognizedText` on the tree and `textHash` on note detail over
    // the real transport (the fake API emits them in dev).
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const rec_id = try seedRecognizedNote(f, admin, "rec.note", &.{ "Test", "Middle" });
    const plain_id = try seedNoteHttp(f, admin, null, "plain.note", &.{"AAAA"}); // no recognition

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const struct {
                id: []const u8,
                name: []const u8,
                hasRecognizedText: ?bool = null,
            },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.entries.len);

        var saw_rec = false;
        var saw_plain = false;
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.name, "rec.note")) {
                saw_rec = true;
                try std.testing.expectEqual(true, e.hasRecognizedText.?);
            } else if (std.mem.eql(u8, e.name, "plain.note")) {
                saw_plain = true;
                try std.testing.expectEqual(false, e.hasRecognizedText.?);
            }
        }
        try std.testing.expect(saw_rec and saw_plain);
    }

    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8, textHash: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].textHash.?.len);
        try std.testing.expect(!std.mem.eql(u8, p.value.pages[0].hash, p.value.pages[0].textHash.?));
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "textHash") == null);
    }
}

test "control-plane page text: word boxes in millimetres, separators skipped, scale only for known hardware" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const nb = @import("note_builder");
    // Two of the four words are the device's null-box layout separators. Boxes
    // are mm on the 118.64 x 158.19 mm canvas.
    const elements = [_]nb.ElementSpec{.{ .label = "alpha beta", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10.5, .y = 20.25, .width = 30.5, .height = 8.125 } },
        .{ .label = "\n", .box = null },
        .{ .label = " ", .box = null },
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};

    const known_id = try seedRecognizedElements(f, admin, "known.note", "N6", &elements, false);
    // Unmeasured hardware: `Dimensions.forEquipment`'s 1404x1872 fallback must
    // not become a mm scale.
    const unknown_id = try seedRecognizedElements(f, admin, "unknown.note", "N5", &elements, false);

    const Meta = struct {
        pages: []const struct { textHash: ?[]const u8 = null },
        pxPerMm: ?f32 = null,
    };
    const Body = struct {
        text: ?[]const u8 = null,
        words: ?[]const struct {
            text: []const u8,
            xMm: f32,
            yMm: f32,
            wMm: f32,
            hMm: f32,
        } = null,
    };

    var known_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{known_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Meta, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectApproxEqAbs(@as(f32, 11.834), p.value.pxPerMm.?, 0.001);
        @memcpy(&known_hash, p.value.pages[0].textHash.?);
    }

    // Unknown hardware: omitted, not zero or the pixel table's default.
    var unknown_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{unknown_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "pxPerMm") == null);
        var p = try std.json.parseFromSlice(Meta, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.pxPerMm == null);
        @memcpy(&unknown_hash, p.value.pages[0].textHash.?);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ known_id, known_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // `?v={textHash}` versions the transcript, not the struct; an
        // immutable response once pinned wordless copies.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);

        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();

        try std.testing.expectEqualStrings("alpha beta", p.value.text.?);

        // Null-box separators are dropped, not defaulted to {0,0,0,0}.
        const words = p.value.words.?;
        try std.testing.expectEqual(@as(usize, 2), words.len);
        try std.testing.expectEqualStrings("alpha", words[0].text);
        try std.testing.expectApproxEqAbs(@as(f32, 10.5), words[0].xMm, 1e-4);
        try std.testing.expectApproxEqAbs(@as(f32, 20.25), words[0].yMm, 1e-4);
        try std.testing.expectApproxEqAbs(@as(f32, 30.5), words[0].wMm, 1e-4);
        try std.testing.expectApproxEqAbs(@as(f32, 8.125), words[0].hMm, 1e-4);
        try std.testing.expectEqualStrings("beta", words[1].text);
        try std.testing.expectApproxEqAbs(@as(f32, 100), words[1].yMm, 1e-4);
        for (words) |w| try std.testing.expect(w.xMm >= 0 and w.yMm >= 0);
    }

    // Boxes are the device's mm verbatim; hardware only changes `pxPerMm`.
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ unknown_id, unknown_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        const words = p.value.words.?;
        try std.testing.expectEqual(@as(usize, 2), words.len);
        try std.testing.expectApproxEqAbs(@as(f32, 10.5), words[0].xMm, 1e-4);
    }

    // No positioned words: `words` is omitted, not `[]`.
    {
        const bare = try seedRecognizedNote(f, admin, "bare.note", &.{"solo"});
        var pbuf: [96]u8 = undefined;
        const mpath = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{bare});
        const mresp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", mpath, &web_tok, "");
        var mp = try std.json.parseFromSlice(Meta, gpa, mresp.body, .{ .ignore_unknown_fields = true });
        defer mp.deinit();

        var tbuf: [128]u8 = undefined;
        const tpath = try std.fmt.bufPrint(&tbuf, "/note/{d}/page/0/text?v={s}", .{ bare, mp.value.pages[0].textHash.? });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", tpath, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "words") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "solo") != null);
    }
}

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
