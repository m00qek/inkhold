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

/// A single-part `multipart/form-data` body, framed as the device frames
/// `/oss/put`. Caller frees.
fn buildMultipart(boundary: []const u8, payload: []const u8) ![]u8 {
    const head = try std.fmt.allocPrint(gpa, "--{s}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"up.note\"\r\nContent-Type: application/octet-stream\r\n\r\n", .{boundary});
    defer gpa.free(head);
    const tail = try std.fmt.allocPrint(gpa, "\r\n--{s}--\r\n", .{boundary});
    defer gpa.free(tail);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, head);
    try out.appendSlice(gpa, payload);
    try out.appendSlice(gpa, tail);
    return out.toOwnedSlice(gpa);
}

/// Total bytes staged under `tmp/`: the per-session cap bounds this, which a
/// file count cannot see.
fn blobTempBytes(f: *Fixture) !u64 {
    var d = try f.tmp.dir.openDir(std.testing.io, "tmp", .{ .iterate = true });
    defer d.close(std.testing.io);
    var it = d.iterate();
    var total: u64 = 0;
    while (try it.next(std.testing.io)) |e| {
        var file = d.openFile(std.testing.io, e.name, .{}) catch continue;
        defer file.close(std.testing.io);
        const st = file.stat(std.testing.io) catch continue;
        total += st.size;
    }
    return total;
}

/// `upload/apply` announcing `size` bytes; returns the minted `innerName`.
fn applyUpload(ctx: *Context, obuf: []u8, reqbuf: []u8, tok: []const u8, name: []const u8, size: usize) ![16]u8 {
    const body = try std.fmt.allocPrint(
        gpa,
        "{{\"path\":\"/NOTE/Note/{s}\",\"fileName\":\"{s}\",\"equipmentNo\":\"SN1\",\"size\":{d}}}",
        .{ name, name, size },
    );
    defer gpa.free(body);
    const resp = try deviceRequest(ctx, obuf, reqbuf, "POST", "/api/file/3/files/upload/apply", tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(struct { success: bool, innerName: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expect(p.value.success);
    var inner: [16]u8 = undefined;
    @memcpy(&inner, p.value.innerName);
    return inner;
}

/// POSTs `payload` multipart-framed to `/oss/put/<inner>`; `query` is appended
/// raw. Heap request buffer: payloads exceed any stack buffer here.
fn ossPut(ctx: *Context, obuf: []u8, tok: []const u8, inner: []const u8, payload: []const u8, query: []const u8) !Sent {
    const boundary = "----NomadUploadBoundaryZZ";
    const wire = try buildMultipart(boundary, payload);
    defer gpa.free(wire);
    const reqbuf = try gpa.alloc(u8, wire.len + 1024);
    defer gpa.free(reqbuf);
    var pbuf: [160]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/oss/put/{s}{s}", .{ inner, query });
    const req = try buildRequest(reqbuf, "POST", path, &.{
        .{ .name = "content-type", .value = "multipart/form-data; boundary=" ++ boundary },
        .{ .name = "x-access-token", .value = tok },
        .{ .name = "equipmentNo", .value = "SN1" },
    }, wire);
    return roundtripCounting(ctx, req, obuf);
}

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
        defer gpa.free(entry.name);
        defer if (entry.md5) |m| gpa.free(m);
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
    defer gpa.free(entry.name);
    defer if (entry.md5) |m| gpa.free(m);
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

test "device /oss/put: a body past the declared size is refused MID-STREAM, leaving no session row and nothing on disk" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const declared: usize = 4096;
    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "flood.note", declared);
    const payload = try filler(declared + 4 * uploadcap.slack_bytes);
    defer gpa.free(payload);

    const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, payload, "");
    const resp = sent.resp;

    // Device protocol failures are HTTP 200 with the coded envelope; a 4xx/5xx
    // reads to the tablet as a network failure.
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try expectFailure(resp.body, "QUOTA_EXCEEDED");

    // Refused mid-stream, near the cap (see `Sent`).
    try std.testing.expect(sent.consumed < cappedReadCeiling(uploadcap.limitFor(declared)));

    // Reservation gone, no blob published, nothing staged in `tmp/`.
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(payload)));
    try std.testing.expectEqual(@as(usize, 0), try blobTempCount(f));
    try std.testing.expectEqual(@as(i64, 0), (try f.files.capacity(alice)).used);

    {
        const md5 = blobstore.md5HexOf(payload);
        const body = try std.fmt.allocPrint(
            gpa,
            "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"flood.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}",
            .{ &md5, &inner, payload.len },
        );
        defer gpa.free(body);
        const fin = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), fin.status);
        try expectFailure(fin.body, "NOT_FOUND");
    }
}

test "device /oss/put: the declared size, and the cap itself, both still upload — the cap removes an attack, not the feature" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const declared: usize = 4096;

    {
        const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "normal.note", declared);
        const payload = try filler(declared);
        defer gpa.free(payload);
        const md5 = blobstore.md5HexOf(payload);

        const resp = (try ossPut(ctx, &obuf, &dev_tok, &inner, payload, "")).resp;
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len); // the empty-200 success shape
        try std.testing.expect(f.files.blobs.has(&md5));

        const body = try std.fmt.allocPrint(
            gpa,
            "{{\"content_hash\":\"{s}\",\"equipmentNo\":\"SN1\",\"fileName\":\"normal.note\",\"innerName\":\"{s}\",\"path\":\"/NOTE/Note/\",\"size\":\"{d}\"}}",
            .{ &md5, &inner, payload.len },
        );
        defer gpa.free(body);
        const fin = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/upload/finish", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), fin.status);
        var p = try std.json.parseFromSlice(struct { success: bool, id: []const u8 }, gpa, fin.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(@as(i64, @intCast(payload.len)), try usedBytes(f, alice));
    }

    // Declared + the whole slack is accepted; one byte more is refused above.
    {
        const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "edge.note", declared);
        const payload = try filler(declared + uploadcap.slack_bytes);
        defer gpa.free(payload);
        const resp = (try ossPut(ctx, &obuf, &dev_tok, &inner, payload, "")).resp;
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqual(@as(usize, 0), resp.body.len);
        try std.testing.expect(f.files.blobs.has(&blobstore.md5HexOf(payload)));
    }
}

test "device /oss/put chunked: an over-cap PART is refused with the same envelope, and takes the session with it" {
    // Each chunked part is held to the same figure.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const declared: usize = 4096;
    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "flood.note", declared);
    const payload = try filler(declared + 4 * uploadcap.slack_bytes);
    defer gpa.free(payload);

    const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, payload, "?uploadId=abc123&totalChunks=3&partNumber=1");
    try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
    try expectFailure(sent.resp.body, "QUOTA_EXCEEDED");
    try std.testing.expect(sent.consumed < cappedReadCeiling(uploadcap.limitFor(declared)));

    // `ChunkIngest.abort` closes without unlinking; the startup `sweepTmp`
    // reclaims what the refused part staged.
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(payload)));

    const again = try ossPut(ctx, &obuf, &dev_tok, &inner, "small", "?uploadId=abc123&totalChunks=3&partNumber=2");
    try std.testing.expectEqual(@as(u16, 404), again.resp.status);
}

test "device /oss/put chunked: the byte cap is per SESSION — N parts cannot each stage the whole budget" {
    // `totalChunks` is caller-supplied, so a per-part cap alone is unbounded in
    // aggregate. Each part here is exactly the declared size.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // Much larger than `slack_bytes`, so "stopped near the remainder" and "read
    // the whole part" are far apart.
    const declared: usize = 400_000;
    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "flood.note", declared);
    const part = try filler(declared);
    defer gpa.free(part);

    {
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, "?uploadId=floodid&totalChunks=9&partNumber=1");
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try std.testing.expectEqual(@as(usize, 0), sent.resp.body.len); // empty-200 success
    }

    // Part 2 exceeds the session's remaining budget and is refused mid-stream.
    const remaining = uploadcap.limitFor(declared) - declared;
    {
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, "?uploadId=floodid&totalChunks=9&partNumber=2");
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try expectFailure(sent.resp.body, "QUOTA_EXCEEDED"); // the protocol's refusal, not a 413
        try std.testing.expect(sent.consumed < cappedReadCeiling(remaining));
    }

    // Staged bytes are bounded by one budget: the refused part's sink was capped
    // at the remainder. A check only after a part lands would bound accounting
    // but not the disk.
    try std.testing.expect(try blobTempBytes(f) <= uploadcap.limitFor(declared));

    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    const again = try ossPut(ctx, &obuf, &dev_tok, &inner, "small", "?uploadId=floodid&totalChunks=9&partNumber=3");
    try std.testing.expectEqual(@as(u16, 404), again.resp.status);
}

test "device /oss/put chunked: re-sending a part is not charged twice" {
    // Part temp files are `tmp/<uploadId>_<n>`, so re-POSTing a part replaces
    // it; `stagedPartSize` must refund the earlier copy or a retry is refused.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const declared: usize = 50_000; // budget = 50_000 + 65_536 = 115_536
    const part = try filler(50_000); //  2 parts = 100_000 (fits), 3 = 150_000 (does not)
    defer gpa.free(part);
    try std.testing.expect(2 * part.len <= uploadcap.limitFor(declared));
    try std.testing.expect(3 * part.len > uploadcap.limitFor(declared));

    const inner = try applyUpload(ctx, &obuf, &reqbuf, &dev_tok, "retry.note", declared);
    for ([_]u8{ 1, 2 }) |n| {
        var q: [64]u8 = undefined;
        const query = try std.fmt.bufPrint(&q, "?uploadId=retryid&totalChunks=3&partNumber={d}", .{n});
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, query);
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try std.testing.expectEqual(@as(usize, 0), sent.resp.body.len);
    }

    {
        const sent = try ossPut(ctx, &obuf, &dev_tok, &inner, part, "?uploadId=retryid&totalChunks=3&partNumber=2");
        try std.testing.expectEqual(@as(u16, 200), sent.resp.status);
        try std.testing.expectEqual(@as(usize, 0), sent.resp.body.len);
    }

    // The running total still reads two parts, not three.
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
    try std.testing.expectEqual(
        @as(i64, @intCast(2 * part.len)),
        try countRows(f, "SELECT received_bytes FROM upload_sessions;"),
    );
}

test "oversized device numbers are rejected, not panicked (overflow guard)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // size == i64max must not overflow the quota math and panic.
    {
        const body = "{\"path\":\"/NOTE/Note/x.note\",\"fileName\":\"x.note\",\"equipmentNo\":\"SN1\",\"size\":9223372036854775807}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/upload/apply", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "QUOTA_EXCEEDED");
    }

    {
        const body = "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\",\"totalCapacity\":\"9223372036854775000\"}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/terminal/user/bindEquipment", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqual(authsvc.default_capacity, try f.svc.userCapacity(alice));
}

test "public pre-auth unlink is IP rate-limited (429 after the burst)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    var obuf: [2048]u8 = undefined;
    var reqbuf: [512]u8 = undefined;
    const body = "{\"equipmentNo\":\"SN1\"}";

    var i: usize = 0;
    while (i < 20) : (i += 1) {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/equipment/unlink", &.{.{ .name = "content-type", .value = "application/json" }}, body), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/equipment/unlink", &.{.{ .name = "content-type", .value = "application/json" }}, body), &obuf);
    try std.testing.expectEqual(@as(u16, 429), resp.status);
}

/// Live rows a user has under `name`: a retried create must converge on one.
fn countNamed(f: *Fixture, user_id: u64, name: []const u8) !i64 {
    var s = try f.db.prepare("SELECT COUNT(*) FROM files WHERE user_id = ?1 AND name = ?2 AND deleted = 0;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindText(2, name);
    _ = try s.step();
    return s.columnInt(0);
}

test "create_folder_v2: a device folder reaches the server without a file in it" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // The Nomad's wire shape.
    const body = "{\"equipmentNo\":\"SN1\",\"autorename\":false,\"path\":\"/NOTE/Note/Trip\"}";
    const id = blk: {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            metadata: struct { tag: []const u8, id: []const u8, name: []const u8, path_display: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("folder", p.value.metadata.tag);
        try std.testing.expectEqualStrings("Trip", p.value.metadata.name);
        try std.testing.expectEqualStrings("/NOTE/Note/Trip", p.value.metadata.path_display);
        break :blk try std.fmt.parseInt(u64, p.value.metadata.id, 10);
    };

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "/NOTE/Note/Trip") != null);
    }
    const entry = (try f.files.get(alice, id)).?;
    defer gpa.free(entry.name);
    try std.testing.expect(entry.is_folder);

    // A retry with `autorename: false` converges on the same row.
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var want: [64]u8 = undefined;
        try std.testing.expect(std.mem.indexOf(
            u8,
            resp.body,
            try std.fmt.bufPrint(&want, "\"id\":\"{d}\"", .{id}),
        ) != null);
    }
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "Trip")); // not forked

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &dev_tok, "SN1", "{\"equipmentNo\":\"SN1\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", resp.body);
    }
}

test "create_folder_v2 is device-scoped and cannot reach another user's tree" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const body = "{\"autorename\":false,\"path\":\"/NOTE/Shared\"}";

    const a_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");
    const a_resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &a_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), a_resp.status);

    // Same path for Bob is his own folder, not a conflict or an oracle.
    const b_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN2");
    const b_resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/create_folder_v2", &b_tok, "SN2", body);
    try std.testing.expectEqual(@as(u16, 200), b_resp.status);
    try std.testing.expect(std.mem.indexOf(u8, b_resp.body, "\"name\":\"Shared\"") != null);

    const a_id = (try f.files.resolvePath(alice, "/NOTE/Shared")).?;
    const b_id = (try f.files.resolvePath(bob, "/NOTE/Shared")).?;
    try std.testing.expect(a_id != b_id);
    try std.testing.expect((try f.files.get(bob, a_id)) == null);
}

/// The tombstone as the row records it, not as any read path reports it.
const Tombstone = struct { deleted: bool, deleted_at: i64 };

fn tombstoneOf(f: *Fixture, id: u64) !Tombstone {
    var s = try f.db.prepare("SELECT deleted, COALESCE(deleted_at, 0) FROM files WHERE id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(id));
    try std.testing.expect(try s.step());
    return .{ .deleted = s.columnInt(0) != 0, .deleted_at = s.columnInt(1) };
}

test "device delete_folder_v3 soft-deletes: leaves listings and search, but the blob survives and the row restores to readable bytes" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const rec_id = try seedRecognizedNote(f, alice, "rec.note", &.{ "Zebra", "Quokka" });
    const md5 = blk: {
        const e = (try f.files.get(alice, rec_id)).?;
        defer gpa.free(e.name);
        defer if (e.md5) |m| gpa.free(m);
        var out: [blobstore.md5_hex_len]u8 = undefined;
        @memcpy(&out, e.md5.?);
        break :blk out;
    };
    const size_before = try usedBytes(f, alice);
    try std.testing.expect(size_before > 0);
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));

    var body_buf: [128]u8 = undefined;
    const del_body = try std.fmt.bufPrint(&body_buf, "{{\"equipmentNo\":\"SN1\",\"id\":\"{d}\"}}", .{rec_id});
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &dev_tok, "SN1", del_body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        // Pinned serialized: the firmware matches these literal names.
        var want_buf: [256]u8 = undefined;
        const want = try std.fmt.bufPrint(
            &want_buf,
            "{{\"success\":true,\"equipmentNo\":\"SN1\",\"metadata\":{{\"tag\":\"file\",\"id\":\"{d}\",\"name\":\"rec.note\"}}}}",
            .{rec_id},
        );
        try std.testing.expectEqualStrings(want, resp.body);
    }

    const t = try tombstoneOf(f, rec_id);
    try std.testing.expect(t.deleted);
    try std.testing.expect(t.deleted_at > 0);

    // Gone from the device's enumeration (stops the zombie re-download).
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "rec.note") == null);
    }
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, alice, "Zebra"));
    try std.testing.expect((try f.files.get(alice, rec_id)) == null);

    // Quota is not refunded on trash: the bytes stay on disk until purge.
    try std.testing.expectEqual(size_before, try usedBytes(f, alice));

    try std.testing.expect(f.files.blobs.has(&md5));
    (try f.files.restore(alice, rec_id)).deinit(gpa);

    const back = (try f.files.get(alice, rec_id)).?;
    defer gpa.free(back.name);
    defer if (back.md5) |m| gpa.free(m);
    const want_bytes = try f.files.blobs.sizeOf(back.md5.?);
    const got = try gpa.alloc(u8, @intCast(want_bytes));
    defer gpa.free(got);
    const read = try f.files.blobs.readRange(back.md5.?, 0, want_bytes, got);
    try std.testing.expectEqual(@as(usize, @intCast(want_bytes)), read.len);
    try std.testing.expectEqualStrings(&md5, &blobstore.md5HexOf(read)); // the ORIGINAL bytes

    // Restore is a flag flip; the md5-keyed rows survived.
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));
}

test "device delete_folder_v3: an idempotent retry succeeds without restarting the retention clock, and children-then-parent trashes the whole subtree" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const dir = try f.files.createFolder(alice, null, "Dir");
    defer gpa.free(dir.name);
    const a_id = try putSeed(f, alice, dir.id, "a.note", "aaa");
    const b_id = try putSeed(f, alice, dir.id, "b.note", "bbb");

    var body_buf: [128]u8 = undefined;
    const del = struct {
        fn go(c: *Context, o: []u8, rq: []u8, bb: []u8, tok: []const u8, id: u64) !Response {
            const body = try std.fmt.bufPrint(bb, "{{\"equipmentNo\":\"SN1\",\"id\":\"{d}\"}}", .{id});
            return deviceRequest(c, o, rq, "POST", "/api/file/3/files/delete_folder_v3", tok, "SN1", body);
        }
    };

    // The device sends one request per entity, children first, parent last.
    {
        const r1 = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, a_id);
        try std.testing.expectEqual(@as(u16, 200), r1.status);
        try expectSuccess(r1.body);
        const r2 = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, b_id);
        try std.testing.expectEqual(@as(u16, 200), r2.status);
        try expectSuccess(r2.body);
        const r3 = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, dir.id);
        try std.testing.expectEqual(@as(u16, 200), r3.status);
        var want_buf: [256]u8 = undefined;
        try std.testing.expectEqualStrings(try std.fmt.bufPrint(
            &want_buf,
            "{{\"success\":true,\"equipmentNo\":\"SN1\",\"metadata\":{{\"tag\":\"folder\",\"id\":\"{d}\",\"name\":\"Dir\"}}}}",
            .{dir.id},
        ), r3.body);
    }
    try std.testing.expectEqual(@as(i64, 3), try countTrashed(f, alice)); // the whole subtree
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\",\"entries\":[]}", resp.body);
    }

    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = 1000 WHERE user_id = ?1 AND deleted = 1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }
    const ver_before = try f.files.syncVersion(alice);

    // A retry: `Files.get` hardcodes deleted = 0, so the handler looks up
    // state-blind.
    for ([_]u64{ a_id, dir.id }) |id| {
        const r = try del.go(ctx, &obuf, &reqbuf, &body_buf, &dev_tok, id);
        try std.testing.expectEqual(@as(u16, 200), r.status);
        try expectSuccess(r.body);
    }
    try std.testing.expectEqual(@as(i64, 3), try countTrashed(f, alice));
    // The retention clock does not restart on retry.
    try std.testing.expectEqual(@as(i64, 1000), (try tombstoneOf(f, a_id)).deleted_at);
    try std.testing.expectEqual(@as(i64, 1000), (try tombstoneOf(f, dir.id)).deleted_at);
    try std.testing.expectEqual(@as(i64, 1000), (try tombstoneOf(f, b_id)).deleted_at);
    try std.testing.expectEqual(ver_before, try f.files.syncVersion(alice));
}

test "device delete_folder_v3: scope enforced, and a foreign id is indistinguishable from a missing one" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    // Bob's id and a never-existing id must answer byte-identically.
    var body_buf: [128]u8 = undefined;
    var foreign_body_buf: [128]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&body_buf, "{{\"equipmentNo\":\"SN1\",\"id\":\"{d}\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    var missing_body: [256]u8 = undefined;
    @memcpy(missing_body[0..missing.body.len], missing.body);
    const missing_len = missing.body.len;

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&foreign_body_buf, "{{\"equipmentNo\":\"SN1\",\"id\":\"{d}\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing_body[0..missing_len], foreign.body);

    // Unknown id: success with `metadata` omitted, or the device retries forever.
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", foreign.body);
    {
        const still = (try f.files.get(bob, bob_id)).?;
        defer gpa.free(still.name);
        defer if (still.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("bob.note", still.name);
    }
    try std.testing.expectEqual(@as(i64, 0), try countTrashed(f, bob));

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"id\":\"1\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/delete_folder_v3", &web_tok, "{\"id\":\"1\"}", 403);
    }
}

test "device move_v3: renames + relocates a note, provisioning the destination parent, and it stays searchable" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const id = try seedRecognizedNote(f, alice, "note.note", &.{ "Zebra", "Quokka" });
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));

    // Captured shape: full destination path including the new filename, into a
    // parent that does not exist yet, autorename false.
    var body_buf: [256]u8 = undefined;
    const body = try std.fmt.bufPrint(
        &body_buf,
        "{{\"id\":\"{d}\",\"to_path\":\"/NOTE/Note/corpus/note/custom_template.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}",
        .{id},
    );
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            entriesVO: struct { tag: []const u8, id: []const u8, name: []const u8, path_display: []const u8, parent_path: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("file", p.value.entriesVO.tag);
        try std.testing.expectEqualStrings("custom_template.note", p.value.entriesVO.name);
        try std.testing.expectEqualStrings("/NOTE/Note/corpus/note/custom_template.note", p.value.entriesVO.path_display);
        try std.testing.expectEqualStrings("/NOTE/Note/corpus/note", p.value.entriesVO.parent_path);
        try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.entriesVO.id, 10));
    }

    try std.testing.expect((try f.files.resolvePath(alice, "/NOTE/Note/corpus/note")) != null);
    try std.testing.expectEqual(@as(?u64, id), try f.files.resolvePath(alice, "/NOTE/Note/corpus/note/custom_template.note"));
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(alice, "/note.note"));
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "/NOTE/Note/corpus/note/custom_template.note") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"name\":\"note.note\"") == null);
    }

    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));
}

test "device move_v3 NEVER 404s: unknown and foreign ids settle as idempotent success, byte-for-byte" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    // Same settled body for unknown and foreign ids: a 404 aborts the device's
    // sync, and a difference is an oracle.
    var mbuf: [200]u8 = undefined;
    var fbuf: [200]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&mbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", missing.body);

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&fbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing.body, foreign.body);

    {
        const still = (try f.files.get(bob, bob_id)).?;
        defer gpa.free(still.name);
        defer if (still.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("bob.note", still.name);
        try std.testing.expectEqual(@as(?u64, null), still.parent_id);
    }
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(bob, "/x"));

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/3/files/move_v3", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"id\":\"1\",\"to_path\":\"/a.note\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &web_tok, "{\"id\":\"1\",\"to_path\":\"/a.note\"}", 403);
    }
}

test "device move_v3: autorename settles a destination-name conflict and reports the chosen name" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const keep = try putSeed(f, alice, null, "keep.note", "kkkk");
    const mover = try putSeed(f, alice, null, "mover.note", "mmmm");
    _ = keep;

    var body_buf: [200]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"id\":\"{d}\",\"to_path\":\"/keep.note\",\"autorename\":true,\"equipmentNo\":\"SN1\"}}", .{mover});
    const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    const p = try std.json.parseFromSlice(struct {
        success: bool,
        entriesVO: struct { name: []const u8, path_display: []const u8 },
    }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("keep (2).note", p.value.entriesVO.name);
    try std.testing.expectEqualStrings("/keep (2).note", p.value.entriesVO.path_display);
    try std.testing.expectEqual(@as(?u64, mover), try f.files.resolvePath(alice, "/keep (2).note"));
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note")); // the occupant intact
}

test "device copy_v3: duplicates a note sharing its blob (no extra quota), both stay searchable" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const id = try seedRecognizedNote(f, alice, "note.note", &.{ "Zebra", "Quokka" });
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));
    const used_before = (try f.files.capacity(alice)).used;

    var body_buf: [256]u8 = undefined;
    const body = try std.fmt.bufPrint(
        &body_buf,
        "{{\"to_path\":\"/NOTE/Note/note_CONFLICT_20260726151728080.note\",\"equipmentNo\":\"SN1\",\"id\":\"{d}\",\"autorename\":false}}",
        .{id},
    );
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            entriesVO: struct { tag: []const u8, id: []const u8, name: []const u8, path_display: []const u8, parent_path: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("file", p.value.entriesVO.tag);
        try std.testing.expectEqualStrings("note_CONFLICT_20260726151728080.note", p.value.entriesVO.name);
        try std.testing.expectEqualStrings("/NOTE/Note/note_CONFLICT_20260726151728080.note", p.value.entriesVO.path_display);
        try std.testing.expect(id != try std.fmt.parseInt(u64, p.value.entriesVO.id, 10));
    }

    try std.testing.expectEqual(@as(?u64, id), try f.files.resolvePath(alice, "/note.note"));
    const copy_id = (try f.files.resolvePath(alice, "/NOTE/Note/note_CONFLICT_20260726151728080.note")).?;
    try std.testing.expect(copy_id != id);

    try std.testing.expectEqual(used_before, (try f.files.capacity(alice)).used);

    try std.testing.expectEqual(@as(usize, 2), try searchHits(f, alice, "Zebra"));
}

test "device copy_v3 NEVER 404s: unknown and foreign ids settle as idempotent success, byte-for-byte" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    var mbuf: [200]u8 = undefined;
    var fbuf: [200]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&mbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", missing.body);

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&fbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing.body, foreign.body);

    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, bob, "bob.note"));
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(bob, "/x"));

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/3/files/copy_v3", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"id\":\"1\",\"to_path\":\"/a.note\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &web_tok, "{\"id\":\"1\",\"to_path\":\"/a.note\"}", 403);
    }
}

test "device copy_v3: autorename settles a destination-name conflict and reports the chosen name" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const keep = try putSeed(f, alice, null, "keep.note", "kkkk");
    const src = try putSeed(f, alice, null, "src.note", "ssss");
    _ = keep;

    var body_buf: [200]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"id\":\"{d}\",\"to_path\":\"/keep.note\",\"autorename\":true,\"equipmentNo\":\"SN1\"}}", .{src});
    const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    const p = try std.json.parseFromSlice(struct {
        success: bool,
        entriesVO: struct { name: []const u8, path_display: []const u8 },
    }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("keep (2).note", p.value.entriesVO.name);
    try std.testing.expectEqualStrings("/keep (2).note", p.value.entriesVO.path_display);
    try std.testing.expect((try f.files.resolvePath(alice, "/keep (2).note")) != null);
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note"));
    try std.testing.expectEqual(@as(?u64, src), try f.files.resolvePath(alice, "/src.note"));
}

test "device copy_v3: a name conflict under autorename:false never clobbers the occupant" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const keep = try putSeed(f, alice, null, "keep.note", "original");
    const src = try putSeed(f, alice, null, "src.note", "different");

    var body_buf: [200]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"id\":\"{d}\",\"to_path\":\"/keep.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{src});
    const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", resp.body);
    _ = keep;
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note"));
    try std.testing.expectEqual(@as(?u64, src), try f.files.resolvePath(alice, "/src.note"));
}

test "abandoned upload sessions are reclaimed at startup, not left for ever" {
    // Upload failures strand staged blobs for the sweep; assert the sweep
    // actually reclaims them, not merely that it runs.
    const f = try Fixture.init();
    defer f.deinit();
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    _ = admin;

    try f.db.exec(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, blob_md5, created_at) " ++
            "VALUES('stale-inner-name', 1, '/Note', 'abandoned.note', 12, '0123456789abcdef0123456789abcdef', 0);",
    );
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));

    // A day's window, as `transport.run` uses.
    const swept = try f.files.sweepUploadSessions(24 * 60 * 60);
    try std.testing.expectEqual(@as(usize, 1), swept);
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
}
