//! The device upload byte caps, number guards and the pre-auth unlink limit.

const std = @import("std");
const filesmod = @import("../../services/files.zig");
const password = @import("../../services/auth/password.zig");
const blobstore = @import("../../store/blobs.zig");
const uploadcap = @import("../../handlers/upload_cap.zig");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const Sent = harness.Sent;
const roundtripCounting = harness.roundtripCounting;
const Fixture = harness.Fixture;
const countRows = harness.countRows;
const deviceRequest = harness.deviceRequest;
const deviceLogin = harness.deviceLogin;
const usedBytes = harness.usedBytes;
const blobTempCount = harness.blobTempCount;
const filler = harness.filler;
const cappedReadCeiling = harness.cappedReadCeiling;
const expectFailure = harness.expectFailure;
const shared = @import("device_helpers.zig");
const buildMultipart = shared.buildMultipart;

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
    try std.testing.expectEqual(filesmod.Files.default_total_bytes, (try f.files.capacity(alice)).total);
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
