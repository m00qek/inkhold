//! The version-history endpoints over HTTP.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
const transport = @import("../../http/transport.zig");
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
const countRows = harness.countRows;
const putSeed = harness.putSeed;
const searchHits = harness.searchHits;
const seedRecognizedElements = harness.seedRecognizedElements;
const requestWithCookie = harness.requestWithCookie;
const expectHeaderContains = harness.expectHeaderContains;
const expectHeaderAbsent = harness.expectHeaderAbsent;

/// Seeds a one-page recognized `.note`; a second call with the same name
/// supersedes the first, retaining v1 in `file_history`.
fn seedRecognizedVersion(f: *Fixture, user_id: u64, name: []const u8, bitmap: []const u8, labels: []const []const u8) !u64 {
    const nb = @import("note_builder");
    const els = try gpa.alloc(nb.ElementSpec, labels.len);
    defer gpa.free(els);
    for (labels, els) |label, *e| e.* = .{ .label = label };

    const bytes = try nb.serialize(gpa, .{ .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }}, .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = bitmap }},
        .recogn_status = 1,
        .recogn_elements = els,
    }} });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
    return e.id;
}

/// N-page variant of `seedRecognizedVersion`, so a retained version can differ
/// in page count from the current one.
fn seedRecognizedVersionPages(f: *Fixture, user_id: u64, name: []const u8, page_count: usize, bitmap: []const u8, label: []const u8) !u64 {
    const nb = @import("note_builder");
    const els = try gpa.alloc(nb.ElementSpec, 1);
    defer gpa.free(els);
    els[0] = .{ .label = label };

    const pgs = try gpa.alloc(nb.PageSpec, page_count);
    defer gpa.free(pgs);
    for (pgs) |*p| p.* = .{
        .layers = &.{.{ .slot = .main, .bitmap = bitmap }},
        .recogn_status = 1,
        .recogn_elements = els,
    };

    const bytes = try nb.serialize(gpa, .{ .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }}, .pages = pgs });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
    return e.id;
}

test "history list: current + retained versions newest-first; foreign id is 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const id = try seedRecognizedVersion(f, admin, "hist.note", "AAAA", &.{ "alpha", "common" });
    _ = try seedRecognizedVersion(f, admin, "hist.note", "BBBB", &.{ "beta", "common" }); // v2 supersedes v1
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    const HistVersion = struct { md5: []const u8, size: i64, createdAt: i64, current: bool = false };
    var pbuf: [96]u8 = undefined;
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        var parsed = try std.json.parseFromSlice(
            struct { id: []const u8, versions: []HistVersion },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        const vs = parsed.value.versions;
        try std.testing.expectEqual(@as(usize, 2), vs.len);
        try std.testing.expect(vs[0].current);
        try std.testing.expectEqualStrings(&v2md5, vs[0].md5);
        try std.testing.expect(!vs[1].current);
        try std.testing.expectEqualStrings(&v1md5, vs[1].md5);
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/note/99999/history", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "history list: each version carries its OWN page count (current and retained differ)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const id = try seedRecognizedVersionPages(f, admin, "hist.note", 3, "AAAA", "alpha");
    _ = try seedRecognizedVersionPages(f, admin, "hist.note", 1, "BBBB", "beta");
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    var qbuf: [128]u8 = undefined;
    const v1_rows = try countRows(f, try std.fmt.bufPrint(&qbuf, "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = '{s}';", .{&v1md5}));
    var qbuf2: [128]u8 = undefined;
    const v2_rows = try countRows(f, try std.fmt.bufPrint(&qbuf2, "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = '{s}';", .{&v2md5}));
    try std.testing.expectEqual(@as(i64, 3), v1_rows);
    try std.testing.expectEqual(@as(i64, 1), v2_rows);

    const HistVersion = struct { md5: []const u8, size: i64, createdAt: i64, pageCount: i64 = 0, current: bool = false };
    var pbuf: [96]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history", .{id});
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    var parsed = try std.json.parseFromSlice(
        struct { id: []const u8, versions: []HistVersion },
        gpa,
        resp.body,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    const vs = parsed.value.versions;
    try std.testing.expectEqual(@as(usize, 2), vs.len);
    try std.testing.expect(vs[0].current);
    try std.testing.expectEqual(v2_rows, vs[0].pageCount);
    try std.testing.expectEqual(@as(i64, 1), vs[0].pageCount);
    try std.testing.expect(!vs[1].current);
    try std.testing.expectEqual(v1_rows, vs[1].pageCount);
    try std.testing.expectEqual(@as(i64, 3), vs[1].pageCount);
}

test "history list: a non-note file's versions report pageCount == 0" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    // A `.pdf` has no `note_page_index` rows, so both versions report 0 pages.
    const id = try putSeed(f, admin, null, "scan.pdf", "%PDF-1.4 first revision");
    _ = try putSeed(f, admin, null, "scan.pdf", "%PDF-1.4 second revision");
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM note_page_index;"));

    const HistVersion = struct { md5: []const u8, size: i64, createdAt: i64, pageCount: i64 = 0, current: bool = false };
    var pbuf: [96]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history", .{id});
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    var parsed = try std.json.parseFromSlice(
        struct { id: []const u8, versions: []HistVersion },
        gpa,
        resp.body,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    const vs = parsed.value.versions;
    try std.testing.expectEqual(@as(usize, 2), vs.len);
    for (vs) |v| try std.testing.expectEqual(@as(i64, 0), v.pageCount);
}

test "an unframed body-method request (POST, no Content-Length) responds instead of panicking the server" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var obuf: [4096]u8 = undefined;

    // A body-bearing method with neither Content-Length nor Transfer-Encoding:
    // std's `discardBody` asserts on it and panics the connection thread, so the
    // transport drops keep-alive. Without the guard this crashes the run.

    const unmatched = "POST /api/controlplane/nope HTTP/1.1\r\nhost: test\r\n\r\n";
    try std.testing.expectEqual(@as(u16, 404), (try roundtrip(ctx, unmatched, &obuf)).status);

    // Scope gate rejects before reading the body.
    const restore = "POST /api/controlplane/note/1/history/abc/restore HTTP/1.1\r\nhost: test\r\n\r\n";
    try std.testing.expectEqual(@as(u16, 401), (try roundtrip(ctx, restore, &obuf)).status);
}

test "history preview: serves v1's page bytes (distinct from v2); 404 for an md5 not in this file's history" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const id = try seedRecognizedVersion(f, admin, "hist.note", "AAAA", &.{"alpha"});
    _ = try seedRecognizedVersion(f, admin, "hist.note", "ZZZZZZ", &.{"beta"});
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    var v1_page: [4096]u8 = undefined;
    var v1_len: usize = 0;
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        @memcpy(v1_page[0..resp.body.len], resp.body);
        v1_len = resp.body.len;
        try std.testing.expect(v1_len > 0);
    }

    {
        const meta_path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{id});
        const meta = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", meta_path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), meta.status);
        var parsed = try std.json.parseFromSlice(
            struct { pages: []struct { hash: []const u8 } },
            gpa,
            meta.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        var hbuf: [40]u8 = undefined;
        const hash = try std.fmt.bufPrint(&hbuf, "{s}", .{parsed.value.pages[0].hash});

        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0?v={s}", .{ id, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(!std.mem.eql(u8, v1_page[0..v1_len], resp.body)); // distinct versions
    }

    // The current blob is never reachable as "history".
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0", .{ id, v2md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        const bogus = "ffffffffffffffffffffffffffffffff";
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0", .{ id, bogus });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "history page text: serves v1's OWN retained transcript + word boxes, distinct from the current page's" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const nb = @import("note_builder");
    // A version's text and boxes come from its own retained `note_page_index`.
    const v1_els = [_]nb.ElementSpec{.{ .label = "alpha", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10.5, .y = 20.25, .width = 30.5, .height = 8.125 } },
    } }};
    const v2_els = [_]nb.ElementSpec{.{ .label = "beta", .words = &.{
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};
    const id = try seedRecognizedElements(f, admin, "vtext.note", "N6", &v1_els, false);
    _ = try seedRecognizedElements(f, admin, "vtext.note", "N6", &v2_els, false);
    const v1md5 = try soleHistoryMd5(f, id);

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

    // Same `PageTextVO` as the live route; `no-cache`, never `immutable`.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null); // raw VO
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{});
        defer p.deinit();
        try std.testing.expectEqualStrings("alpha", p.value.text.?);
        try std.testing.expectEqual(@as(usize, 1), p.value.words.?.len);
        try std.testing.expectEqualStrings("alpha", p.value.words.?[0].text);
        try std.testing.expectApproxEqAbs(@as(f32, 10.5), p.value.words.?[0].xMm, 0.001);
        try std.testing.expectApproxEqAbs(@as(f32, 20.25), p.value.words.?[0].yMm, 0.001);
        try std.testing.expectApproxEqAbs(@as(f32, 30.5), p.value.words.?[0].wMm, 0.001);
        try std.testing.expectApproxEqAbs(@as(f32, 8.125), p.value.words.?[0].hMm, 0.001);
    }

    {
        const meta_path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{id});
        const meta = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", meta_path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), meta.status);
        var parsed = try std.json.parseFromSlice(
            struct { pages: []struct { textHash: ?[]const u8 = null } },
            gpa,
            meta.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        var hbuf: [40]u8 = undefined;
        const hash = try std.fmt.bufPrint(&hbuf, "{s}", .{parsed.value.pages[0].textHash.?});

        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ id, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{});
        defer p.deinit();
        try std.testing.expectEqualStrings("beta", p.value.text.?); // distinct from v1
        try std.testing.expectApproxEqAbs(@as(f32, 40), p.value.words.?[0].xMm, 0.001); // distinct box
    }
}

test "history page text: 404 (indistinguishable) for a non-history md5, a bogus md5, a foreign owner's id, and a trashed id" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const mallory = (try f.svc.createUser(admin, "mallory", false)).id;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;

    const id = try seedRecognizedVersion(f, admin, "vt404.note", "AAAA", &.{"alpha"});
    _ = try seedRecognizedVersion(f, admin, "vt404.note", "BBBB", &.{"beta"});
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v2md5 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, repeat(u8, "f", 32) });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // Another user's real retained md5: the `user_id` scope 404s it.
    {
        const mid = try seedRecognizedVersion(f, mallory, "hers.note", "AAAA", &.{"one"});
        _ = try seedRecognizedVersion(f, mallory, "hers.note", "BBBB", &.{"two"});
        const mv1 = try soleHistoryMd5(f, mid);
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ mid, mv1 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
    // `historyVersion` requires `f.deleted = 0`, even for the owner.
    {
        try f.files.trash(admin, id);
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v1md5 });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "")).status);
    }
}

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
