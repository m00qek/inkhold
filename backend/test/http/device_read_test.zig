//! The device-sync read path over HTTP.

const std = @import("std");
const app = @import("../../routes.zig");
const authsvc = @import("../../services/auth/service.zig");
const password = @import("../../services/auth/password.zig");
const filesmod = @import("../../services/files.zig");
const library = @import("../../services/library.zig");
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

test "device sync M1: login/equipment, bind (folders + capacity), and the Digest and To-Do listings refused" {
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

    // The To-Do listings are refused: an empty list would make the tablet
    // delete every list it once synced (decompiled TaskSync), and a page
    // token of "" looped it into a crash.
    {
        const groups = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/group/all", &dev_tok, "SN1", "{\"maxResults\":\"200\",\"pageToken\":\"\"}");
        try std.testing.expectEqual(@as(u16, 200), groups.status);
        try expectFailure(groups.body, "TODO_SYNC_UNSUPPORTED");
        try std.testing.expect(std.mem.indexOf(u8, groups.body, "scheduleTaskGroup") == null);
        const tasks = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/task/all", &dev_tok, "SN1", "{\"maxResults\":\"200\"}");
        try std.testing.expectEqual(@as(u16, 200), tasks.status);
        try expectFailure(tasks.body, "TODO_SYNC_UNSUPPORTED");
    }

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

    // Files exist, so a listing that leaked them would show.
    _ = try putSeed(f, alice, note_id, "a.note", "aaaa");
    _ = try putSeed(f, alice, note_id, "b.note", "bbbbbb");

    // The Digest listings are refused: they used to present files as Digest
    // data, and the tablet imported every folder as a Digest collection.
    for ([_][]const u8{ "/api/file/query/summary/hash", "/api/file/query/summary/id", "/api/file/query/summary/group" }) |path| {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", path, &dev_tok, "SN1", "{\"page\":0,\"size\":100}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "DIGEST_SYNC_UNSUPPORTED");
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "summaryDOList") == null);
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
