//! The device-sync upload path and the ingest cap over HTTP.

const std = @import("std");
const transport = @import("../../http/transport.zig");
const authsvc = @import("../../services/auth/service.zig");
const password = @import("../../services/auth/password.zig");
const blobstore = @import("../../store/blobs.zig");
const uploadcap = @import("../../handlers/upload_cap.zig");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Response = harness.Response;
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const Sent = harness.Sent;
const roundtripCounting = harness.roundtripCounting;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const countRows = harness.countRows;
const deviceRequest = harness.deviceRequest;
const deviceLogin = harness.deviceLogin;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const blobTempCount = harness.blobTempCount;
const filler = harness.filler;
const cappedReadCeiling = harness.cappedReadCeiling;
const countTrashed = harness.countTrashed;
const searchHits = harness.searchHits;
const seedRecognizedNote = harness.seedRecognizedNote;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const expectSuccess = harness.expectSuccess;
const expectFailure = harness.expectFailure;

test "device upload M2: apply → /oss/put → finish stores the blob and links it into the tree" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const file_bytes = "SUPERNOTE upload payload — the real .note bytes\x00\x01\x02\r\n--not-a-boundary";
    const md5 = blobstore.md5HexOf(file_bytes);
    const before_version = try f.files.syncVersion(alice);

    var inner: [16]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"path\":\"/NOTE/Note/up.note\",\"fileName\":\"up.note\",\"equipmentNo\":\"SN1\",\"size\":{d}}}", .{file_bytes.len});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            innerName: []const u8,
            bucketName: []const u8,
            fullUploadUrl: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(@as(usize, 16), p.value.innerName.len);
        try std.testing.expectEqualStrings("ufile", p.value.bucketName);
        @memcpy(&inner, p.value.innerName);
        var want: [64]u8 = undefined;
        try std.testing.expectEqualStrings(try std.fmt.bufPrint(&want, "http://test/oss/put/{s}", .{&inner}), p.value.fullUploadUrl);
    }

    {
        const boundary = "----NomadUploadBoundaryZZ";
        const wire = try buildMultipart(boundary, file_bytes);
        defer gpa.free(wire);
        try std.testing.expect(wire.len > file_bytes.len);

        var ctbuf: [96]u8 = undefined;
        const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});
        var pbuf: [48]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}", .{&inner});
        const req = try buildRequest(&reqbuf, "POST", path, &.{
            .{ .name = "content-type", .value = ct },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, wire);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len); // empty success body
    }

    // Keyed by the file's md5, not the wire body's.
    try std.testing.expect(f.files.blobs.has(&md5));

    var file_id: u64 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"up.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}", .{ &md5, &inner, file_bytes.len });
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            id: []const u8,
            name: []const u8,
            path_display: []const u8,
            content_hash: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("up.note", p.value.name);
        try std.testing.expectEqualStrings(&md5, p.value.content_hash);
        try std.testing.expectEqualStrings("/NOTE/Note/", p.value.path_display);
        file_id = try std.fmt.parseInt(u64, p.value.id, 10);
    }

    {
        const entry = (try f.files.get(alice, file_id)).?;
        defer entry.deinit(gpa);
        try std.testing.expectEqualStrings("up.note", entry.name);
        try std.testing.expect(!entry.is_folder);
        try std.testing.expectEqualStrings(&md5, entry.md5.?);
        try std.testing.expectEqual(@as(u64, file_bytes.len), entry.size);

        const note_id = (try f.files.resolvePath(alice, "/NOTE/Note")).?;
        try std.testing.expectEqual(note_id, entry.parent_id.?); // linked under the bound folder

        try std.testing.expectEqual(@as(i64, @intCast(file_bytes.len)), try usedBytes(f, alice));
        try std.testing.expect(try f.files.syncVersion(alice) > before_version);
    }

    {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        try std.testing.expect((try f.files.uploadSession(arena.allocator(), alice, &inner)) == null);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/NOTE/Note\",\"recursive\":false}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const struct { name: []const u8, content_hash: []const u8, size: i64 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.entries.len);
        try std.testing.expectEqualStrings("up.note", p.value.entries[0].name);
        try std.testing.expectEqualStrings(&md5, p.value.entries[0].content_hash);
    }
}

test "device upload M2: content_hash mismatch rejects the commit; auth is enforced" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const file_bytes = "these bytes are stored fine";
    const real_md5 = blobstore.md5HexOf(file_bytes);

    var inner: [16]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"path\":\"/NOTE/Note/bad.note\",\"fileName\":\"bad.note\",\"equipmentNo\":\"SN1\",\"size\":{d}}}", .{file_bytes.len});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        var p = try std.json.parseFromSlice(struct { innerName: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&inner, p.value.innerName);
    }
    {
        const boundary = "BND";
        const wire = try buildMultipart(boundary, file_bytes);
        defer gpa.free(wire);
        var ctbuf: [64]u8 = undefined;
        const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});
        var pbuf: [48]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}", .{&inner});
        const req = try buildRequest(&reqbuf, "POST", path, &.{
            .{ .name = "content-type", .value = ct },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, wire);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    {
        const wrong = "ffffffffffffffffffffffffffffffff";
        const body = try std.fmt.allocPrint(gpa, "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"bad.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}", .{ wrong, &inner, file_bytes.len });
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "HASH_MISMATCH");
    }
    try std.testing.expect((try f.files.resolvePath(alice, "/NOTE/Note/bad.note")) == null);
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, alice));
    try std.testing.expect(f.files.blobs.has(&real_md5)); // stored but unreferenced

    {
        const swept = try f.files.sweepUploadSessions(-1); // cutoff in the future → sweep everything
        try std.testing.expectEqual(@as(usize, 1), swept);
        try std.testing.expect(!f.files.blobs.has(&real_md5)); // orphan reclaimed
    }

    {
        const req = try buildRequest(&reqbuf, "POST", "/oss/put/deadbeefdeadbeef", &.{
            .{ .name = "content-type", .value = "multipart/form-data; boundary=BND" },
        }, "--BND\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nx\r\n--BND--\r\n");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/oss/put/deadbeefdeadbeef", &web_tok, "", 403);
    }
}

test "device upload M2: commits the INGESTED size, not the device-declared size" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // A declared size larger than the payload must not reach files.size or quota.
    const file_bytes = "tiny"; // 4 real bytes
    const md5 = blobstore.md5HexOf(file_bytes);
    const declared: usize = 5_000_000; // fits the default quota, so apply passes

    var inner: [16]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"path\":\"/NOTE/Note/up.note\",\"fileName\":\"up.note\",\"equipmentNo\":\"SN1\",\"size\":{d}}}", .{declared});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { innerName: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&inner, p.value.innerName);
    }
    {
        const boundary = "----NomadBoundaryQ";
        const wire = try buildMultipart(boundary, file_bytes);
        defer gpa.free(wire);
        var ctbuf: [96]u8 = undefined;
        const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});
        var pbuf: [48]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}", .{&inner});
        const req = try buildRequest(&reqbuf, "POST", path, &.{
            .{ .name = "content-type", .value = ct },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, wire);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    var file_id: u64 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"up.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}", .{ &md5, &inner, declared });
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { id: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        file_id = try std.fmt.parseInt(u64, p.value.id, 10);
    }

    const entry = (try f.files.get(alice, file_id)).?;
    defer entry.deinit(gpa);
    try std.testing.expectEqual(@as(u64, file_bytes.len), entry.size);
    try std.testing.expectEqual(@as(i64, @intCast(file_bytes.len)), try usedBytes(f, alice));
}

test "device upload chunked: parts are merged on the final part" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const p1 = "SUPERNOTE upload payload ";
    const p2 = "— the real .note ";
    const p3 = "bytes\x00\x01\x02\r\n--not-a-boundary";

    const file_bytes = try std.mem.concat(gpa, u8, &.{ p1, p2, p3 });
    defer gpa.free(file_bytes);
    const md5 = blobstore.md5HexOf(file_bytes);

    var inner: [16]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"path\":\"/NOTE/Note/up.note\",\"fileName\":\"up.note\",\"equipmentNo\":\"SN1\",\"size\":{d}}}", .{file_bytes.len});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            innerName: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        @memcpy(&inner, p.value.innerName);
    }

    const boundary = "----NomadUploadBoundaryZZ";
    const upload_id = "1785154238763_ad76ebd7";
    for ([_][]const u8{ p1, p2, p3 }, 1..) |part_bytes, part_num| {
        const wire = try buildMultipart(boundary, part_bytes);
        defer gpa.free(wire);

        var ctbuf: [96]u8 = undefined;
        const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}?uploadId={s}&totalChunks=3&partNumber={d}", .{ &inner, upload_id, part_num });
        const req = try buildRequest(&reqbuf, "POST", path, &.{
            .{ .name = "content-type", .value = ct },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, wire);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len); // empty success body
    }

    try std.testing.expect(f.files.blobs.has(&md5));

    {
        const body = try std.fmt.allocPrint(gpa, "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"up.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}", .{ &md5, &inner, file_bytes.len });
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            content_hash: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings(&md5, p.value.content_hash);
    }
}

test "device upload chunked: a path-traversal uploadId is rejected before it names a file" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // Get past the ownership check so the uploadId check is what rejects.
    var inner: [16]u8 = undefined;
    {
        const body = "{\"path\":\"/NOTE/Note/evil.note\",\"fileName\":\"evil.note\",\"equipmentNo\":\"SN1\",\"size\":10}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            innerName: []const u8,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&inner, p.value.innerName);
    }

    const boundary = "----NomadUploadBoundaryZZ";
    const wire = try buildMultipart(boundary, "pwn");
    defer gpa.free(wire);
    var ctbuf: [96]u8 = undefined;
    const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});

    // Must 400 before `beginChunkIngest` splices it into a `tmp/<id>_1` path.
    var pbuf: [160]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}?uploadId=../../pwned&totalChunks=3&partNumber=1", .{&inner});
    const req = try buildRequest(&reqbuf, "POST", path, &.{
        .{ .name = "content-type", .value = ct },
        .{ .name = "x-access-token", .value = &dev_tok },
        .{ .name = "equipmentNo", .value = "SN1" },
    }, wire);
    const resp = try roundtrip(ctx, req, &obuf);
    try std.testing.expectEqual(@as(u16, 400), resp.status);
}

const shared = @import("device_helpers.zig");
const buildMultipart = shared.buildMultipart;
