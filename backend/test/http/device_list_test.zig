//! Device file enumeration, scoped queries and space usage over HTTP.

const std = @import("std");
const password = @import("../../services/auth/password.zig");
const filesmod = @import("../../services/files.zig");
const blobstore = @import("../../store/blobs.zig");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const deviceRequest = harness.deviceRequest;
const deviceLogin = harness.deviceLogin;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const expectSuccess = harness.expectSuccess;

test "device sync M1: file enumeration (list_folder, query_v3, download_v3) + raw /oss/get, auth enforced" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const note_id = try f.files.ensureFolderPath(alice, "NOTE/Note");
    const blob_bytes = "hello supernote download blob";
    const a_id = try putSeed(f, alice, note_id, "a.note", blob_bytes);
    const top_id = try putSeed(f, alice, null, "top.note", "x"); // a second file, for cross-file scoping
    const a_md5 = blobstore.md5HexOf(blob_bytes);
    const a_entry = (try f.files.get(alice, a_id)).?;
    defer a_entry.deinit(gpa);

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/NOTE/Note\",\"recursive\":false}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            entries: []const struct {
                tag: []const u8,
                id: []const u8,
                name: []const u8,
                path_display: []const u8,
                content_hash: []const u8,
                is_downloadable: bool,
                size: i64,
                lastUpdateTime: i64,
                parent_path: []const u8,
            },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqual(@as(usize, 1), p.value.entries.len);
        const e = p.value.entries[0];
        try std.testing.expectEqualStrings("file", e.tag);
        try std.testing.expectEqualStrings("a.note", e.name);
        try std.testing.expectEqualStrings("/NOTE/Note/a.note", e.path_display);
        try std.testing.expectEqualStrings("/NOTE/Note", e.parent_path);
        try std.testing.expectEqualStrings(&a_md5, e.content_hash);
        try std.testing.expect(e.is_downloadable); // !is_folder (FLAGGED)
        try std.testing.expectEqual(@as(i64, @intCast(blob_bytes.len)), e.size);
        try std.testing.expectEqual(a_entry.updated_at * 1000, e.lastUpdateTime); // ms (FLAGGED)
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const struct { tag: []const u8, path_display: []const u8, is_downloadable: bool },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 4), p.value.entries.len);
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.tag, "folder")) try std.testing.expect(!e.is_downloadable);
        }
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/query/by/path_v3", &dev_tok, "SN1", "{\"path\":\"/NOTE/Note/a.note\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            entriesVO: ?struct { id: []const u8, name: []const u8, content_hash: []const u8, path_display: []const u8 } = null,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.entriesVO != null);
        try std.testing.expectEqualStrings("a.note", p.value.entriesVO.?.name);
        try std.testing.expectEqualStrings(&a_md5, p.value.entriesVO.?.content_hash);
    }
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/query/by/path_v3", &dev_tok, "SN1", "{\"path\":\"/NOTE/ghost.note\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "entriesVO") == null);
        try expectSuccess(resp.body);
    }

    {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":\"{d}\"}}", .{a_id});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/query_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            equipmentNo: []const u8,
            entriesVO: ?struct { name: []const u8 } = null,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        // Echoed after the body read: guards a use-after-free on the head buffer.
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("a.note", p.value.entriesVO.?.name);
    }

    // The device sends no x-access-token on the download GET, so the URL
    // carries a `?t=` capability token.
    var oss_url_buf: [128]u8 = undefined;
    var oss_url_len: usize = 0;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":\"{d}\"}}", .{a_id});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/download_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            id: []const u8,
            url: []const u8,
            content_hash: []const u8,
            is_downloadable: bool,
            size: i64,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        var prefix_buf: [64]u8 = undefined;
        const prefix = try std.fmt.bufPrint(&prefix_buf, "http://test/oss/get/{d}?t=", .{a_id});
        try std.testing.expect(std.mem.startsWith(u8, p.value.url, prefix));
        try std.testing.expect(p.value.url.len > prefix.len); // a non-empty token follows
        try std.testing.expectEqualStrings(&a_md5, p.value.content_hash);
        try std.testing.expect(p.value.is_downloadable);
        try std.testing.expectEqual(@as(i64, @intCast(blob_bytes.len)), p.value.size);
        @memcpy(oss_url_buf[0..p.value.url.len], p.value.url);
        oss_url_len = p.value.url.len;
    }
    const oss_url = oss_url_buf[0..oss_url_len]; // "/oss/get/<a_id>?t=<token>" after the host
    const oss_path = oss_url["http://test".len..]; // path+query the device GETs (no token header)

    // No x-access-token header: the `?t=` token is the only credential.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", oss_path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(blob_bytes, resp.body); // exact bytes, raw
        try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "application/octet-stream") != null);
        try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "content-disposition:") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "a.note") != null);
    }

    // Multi-use within the TTL: the device may Range-request or retry.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", oss_path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(blob_bytes, resp.body);
    }

    // Token failures are 403, never 401 (a 401 logs the device out).
    {
        var pbuf: [32]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}", .{a_id});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}?t=deadbeefdeadbeefdeadbeefdeadbeef", .{a_id});
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
    {
        const q = std.mem.indexOfScalar(u8, oss_path, '?').?;
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}{s}", .{ top_id, oss_path[q..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/2/files/list_folder", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"path\":\"/\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &web_tok, "{\"path\":\"/\"}", 403);
    }
}

// Reference oracle: walk the whole tree, then filter in Zig, to prove the
// scoped `list_folder` query returns the same set.
fn underPathT(path: []const u8, folder: []const u8) bool {
    return path.len > folder.len and std.mem.startsWith(u8, path, folder) and path[folder.len] == '/';
}

fn walkAndFilterPaths(a: std.mem.Allocator, files: *filesmod.Files, user_id: u64, target: []const u8, recursive: bool) ![][]const u8 {
    const nodes = try files.walkTree(a, user_id);
    var out: std.ArrayList([]const u8) = .empty;
    for (nodes) |n| {
        const include = if (recursive)
            (std.mem.eql(u8, target, "/") or underPathT(n.path_display, target))
        else
            std.mem.eql(u8, n.parent_path, target);
        if (include) try out.append(a, n.path_display);
    }
    const s = try out.toOwnedSlice(a);
    std.mem.sort([]const u8, s, {}, lessPath);
    return s;
}

fn lessPath(_: void, x: []const u8, y: []const u8) bool {
    return std.mem.order(u8, x, y) == .lt;
}

// `list_folder` over the wire as a sorted set of `path_display` (owned by `a`).
fn endpointPaths(a: std.mem.Allocator, ctx: *Context, obuf: []u8, reqbuf: []u8, token: []const u8, target: []const u8, recursive: bool) ![][]const u8 {
    const body = try std.fmt.allocPrint(a, "{{\"path\":\"{s}\",\"recursive\":{}}}", .{ target, recursive });
    const resp = try deviceRequest(ctx, obuf, reqbuf, "POST", "/api/file/2/files/list_folder", token, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(struct {
        entries: []const struct { path_display: []const u8 },
    }, a, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    var out: std.ArrayList([]const u8) = .empty;
    for (p.value.entries) |e| try out.append(a, try a.dupe(u8, e.path_display));
    const s = try out.toOwnedSlice(a);
    std.mem.sort([]const u8, s, {}, lessPath);
    return s;
}

test "list_folder scoped query returns the SAME SET as the old whole-tree walk-and-filter (nested, recursive, empty, root)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // /A/one.note  /A/B/deep.note  /A/empty  /root.note
    const a_id = try f.files.ensureFolderPath(alice, "A");
    _ = try putSeed(f, alice, a_id, "one.note", "1");
    const b_id = try f.files.ensureFolderPath(alice, "A/B");
    _ = try putSeed(f, alice, b_id, "deep.note", "22");
    _ = try f.files.ensureFolderPath(alice, "A/empty");
    _ = try putSeed(f, alice, null, "root.note", "333");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const Case = struct { target: []const u8, recursive: bool, expect_len: usize };
    const cases = [_]Case{
        .{ .target = "/A", .recursive = false, .expect_len = 3 }, // one.note, B, empty
        .{ .target = "/A", .recursive = true, .expect_len = 4 }, // one.note, B, empty, deep.note (- the folder itself)
        .{ .target = "/A/empty", .recursive = false, .expect_len = 0 }, // empty folder
        .{ .target = "/A/empty", .recursive = true, .expect_len = 0 }, // empty subtree
        .{ .target = "/", .recursive = false, .expect_len = 2 }, // A, root.note
        .{ .target = "/", .recursive = true, .expect_len = 6 }, // the whole tree
    };
    for (cases) |c| {
        const want = try walkAndFilterPaths(a, &f.files, alice, c.target, c.recursive);
        const got = try endpointPaths(a, ctx, &obuf, &reqbuf, &dev, c.target, c.recursive);
        try std.testing.expectEqual(c.expect_len, want.len); // the oracle itself is right
        try std.testing.expectEqual(want.len, got.len);
        for (want, got) |w, g| try std.testing.expectEqualStrings(w, g);
    }
}

test "get_space_usage reports the caller's real capacity row, in the exact shape the device accepted" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    try f.files.setCapacityTotal(alice, 10 * 1024 * 1024 * 1024); // 10 GiB, server-owned

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const dev = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    _ = try putSeed(f, alice, null, "a.note", "abcdefg"); // 7 bytes
    try std.testing.expectEqual(@as(i64, 7), try usedBytes(f, alice));

    // The serialized body is pinned: the device matches these literal names.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/users/get_space_usage", &dev, "SN1", "{\"equipmentNo\":\"SN1\",\"version\":\"202407\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(
            "{\"success\":true,\"used\":7,\"allocationVO\":{\"tag\":\"Individual\",\"allocated\":10737418240}}",
            resp.body,
        );
    }

    _ = try putSeed(f, alice, null, "b.note", "xyz"); // +3 → 10
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/users/get_space_usage", &dev, "SN1", "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { success: bool, used: i64, allocationVO: struct { tag: []const u8, allocated: i64 } },
            gpa,
            resp.body,
            .{},
        );
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(@as(i64, 10), p.value.used);
        try std.testing.expectEqual(@as(i64, 10 * 1024 * 1024 * 1024), p.value.allocationVO.allocated);
        try std.testing.expectEqualStrings("Individual", p.value.allocationVO.tag);
    }

    {
        try f.db.run("DELETE FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(alice) }});
    }
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/users/get_space_usage", &dev, "SN1", "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var buf: [160]u8 = undefined;
        const want = try std.fmt.bufPrint(
            &buf,
            "{{\"success\":true,\"used\":0,\"allocationVO\":{{\"tag\":\"Individual\",\"allocated\":{d}}}}}",
            .{filesmod.Files.default_total_bytes},
        );
        try std.testing.expectEqualStrings(want, resp.body);
    }

    {
        const req = try buildRequest(&reqbuf, "POST", "/api/file/2/users/get_space_usage", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, "{}");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/2/users/get_space_usage", &web_tok, "{}", 403);
    }
}
