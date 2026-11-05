//! The device-sync read path over HTTP.

const std = @import("std");
const app = @import("../../routes.zig");
const authsvc = @import("../../services/auth/service.zig");
const password = @import("../../services/auth/password.zig");
const filesmod = @import("../../services/files.zig");
const library = @import("../../services/library.zig");
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
const expectFailure = harness.expectFailure;

test "device sync M1: login/equipment, bind (folders + capacity), and the hash-diff read path" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111")); // clears must_change

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"alice\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
        // The account's id and the library's: the tablet drops its sync
        // records at sign-in when either changed since it last stored them.
        var p = try std.json.parseFromSlice(struct { userId: u64, uniqueMachineId: []const u8 }, std.testing.allocator, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(alice, p.value.userId);
        try std.testing.expectEqualSlices(u8, &(try library.machineId(f.svc.db)), p.value.uniqueMachineId);
        const miss = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/official/user/check/exists/server", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"email\":\"ghost\"}"), &obuf);
        try expectFailure(miss.body, "USER_NOT_FOUND");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/api/file/query/server", &.{}, ""), &obuf);
        try expectSuccess(resp.body);
    }

    // Real order: a file call arrives before `bindEquipment` and binds the
    // serial with a placeholder name; the bind must then adopt the reported name.
    try f.svc.bindDevice(alice, "SN1", "Supernote app");

    // The device-reported `totalCapacity` is ignored: the server owns the quota.
    {
        const body =
            "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\",\"totalCapacity\":\"25485312\"," ++
            "\"label\":[\"NOTE/Note\",\"NOTE/MyStyle\",\"EXPORT\",\"INBOX\"],\"version\":\"202407\"}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/terminal/user/bindEquipment", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expect(try f.svc.isDeviceBound(alice, "SN1"));
    // Asserted through the route: the handler, not `nameDevice`, was the bug.
    {
        const devs = try f.svc.listUserDevices(gpa, alice, alice);
        defer authsvc.Service.freeDevices(gpa, devs);
        try std.testing.expectEqual(@as(usize, 1), devs.len);
        try std.testing.expectEqualStrings("Nomad", devs[0].name);
    }
    try std.testing.expectEqual(filesmod.Files.default_total_bytes, (try f.files.capacity(alice)).total);

    {
        const root = try f.files.list(alice, null);
        defer filesmod.Files.freeEntries(gpa, root);
        try std.testing.expectEqual(@as(usize, 3), root.len);
        for (root) |e| try std.testing.expect(e.is_folder);
    }
    const note_id = try f.files.ensureFolderPath(alice, "NOTE/Note"); // idempotent → existing id

    const a_id = try putSeed(f, alice, note_id, "a.note", "aaaa");
    _ = try putSeed(f, alice, note_id, "b.note", "bbbbbb");
    const a_md5 = blobstore.md5HexOf("aaaa");

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/query/summary/hash", &dev_tok, "SN1", "{\"page\":0,\"size\":100}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            totalRecords: i64,
            summaryInfoVOList: []const struct {
                id: i64,
                md5Hash: []const u8,
                handwriteMd5: []const u8,
                metadataMap: struct { path: []const u8 },
            },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(@as(i64, 2), p.value.totalRecords);
        try std.testing.expectEqual(@as(usize, 2), p.value.summaryInfoVOList.len);
        const first = p.value.summaryInfoVOList[0];
        try std.testing.expectEqual(a_id, @as(u64, @intCast(first.id)));
        try std.testing.expectEqualStrings(&a_md5, first.md5Hash);
        try std.testing.expectEqualStrings(&a_md5, first.handwriteMd5); // mirrored (§7.1)
        try std.testing.expectEqualStrings("/NOTE/Note/a.note", first.metadataMap.path);
    }

    {
        const body = try std.fmt.allocPrint(gpa, "{{\"ids\":[{d}]}}", .{a_id});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/query/summary/id", &dev_tok, "SN1", body);
        var p = try std.json.parseFromSlice(struct {
            summaryDOList: []const struct { id: i64, name: []const u8, sourcePath: []const u8, md5Hash: []const u8, isSummaryGroup: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.summaryDOList.len);
        const d = p.value.summaryDOList[0];
        try std.testing.expectEqualStrings("a.note", d.name);
        try std.testing.expectEqualStrings("/NOTE/Note/a.note", d.sourcePath);
        try std.testing.expectEqualStrings("N", d.isSummaryGroup);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/query/summary/group", &dev_tok, "SN1", "{\"page\":0,\"size\":100}");
        var p = try std.json.parseFromSlice(struct { totalRecords: i64, summaryDOList: []const struct { isSummaryGroup: []const u8 } }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 5), p.value.totalRecords);
        for (p.value.summaryDOList) |g| try std.testing.expectEqualStrings("Y", g.isSummaryGroup);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/user/query", &dev_tok, "SN1", "{}");
        var p = try std.json.parseFromSlice(struct { success: bool, email: []const u8, totalCapacity: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("alice", p.value.email);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/synchronous/start", &dev_tok, "SN1", "{\"equipmentNo\":\"SN1\"}");
        var p = try std.json.parseFromSlice(struct { success: bool, equipmentNo: []const u8, synType: bool }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success and p.value.synType);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
    }
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/synchronous/end", &dev_tok, "SN1", "{\"equipmentNo\":\"SN1\",\"flag\":\"Y\"}");
        try expectSuccess(resp.body);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &dev_tok, "{\"equipmentNo\":\"SN1\"}", 403);
}

test "pre-login device unlink is public, returns success, but is NON-DESTRUCTIVE (no token)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");
    try f.svc.bindDevice(alice, "SN1", "Nomad");
    try std.testing.expectEqual(@as(i64, 1), try f.svc.deviceCount(alice));
    try std.testing.expect((try f.svc.caller(&dev_tok)) != null);

    // An unauthenticated serial POST must not unbind or drop sessions (any LAN
    // client could log the device out); it returns the lenient success.
    const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/equipment/unlink", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"equipmentNo\":\"SN1\"}"), &obuf);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try expectSuccess(resp.body);
    try std.testing.expectEqual(@as(i64, 1), try f.svc.deviceCount(alice)); // binding SURVIVES
    try std.testing.expect((try f.svc.caller(&dev_tok)) != null); // session SURVIVES
}

test "capacity onboarding: wouldFit defaults for a user with no row; bindEquipment creates it at the server default" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    // No capacity row: the state that used to make upload/apply 500.
    {
        try f.db.run("DELETE FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(alice) }});
    }

    try std.testing.expect(try f.files.wouldFit(alice, 1024));

    {
        const body = "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\",\"totalCapacity\":\"25485312\",\"label\":[\"NOTE/Note\"]}";
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/terminal/user/bindEquipment", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    var s = try f.db.prepare("SELECT total_bytes FROM capacity WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(alice));
    try std.testing.expect(try s.step()); // the row was created
    try std.testing.expectEqual(filesmod.Files.default_total_bytes, s.columnInt(0));
}
