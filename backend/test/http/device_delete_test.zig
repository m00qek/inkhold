//! Device folder creation and soft delete over HTTP.

const std = @import("std");
const password = @import("../../services/auth/password.zig");
const blobstore = @import("../../store/blobs.zig");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Response = harness.Response;
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const deviceRequest = harness.deviceRequest;
const deviceLogin = harness.deviceLogin;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const countTrashed = harness.countTrashed;
const searchHits = harness.searchHits;
const seedRecognizedNote = harness.seedRecognizedNote;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const expectSuccess = harness.expectSuccess;
const shared = @import("device_helpers.zig");
const countNamed = shared.countNamed;

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
