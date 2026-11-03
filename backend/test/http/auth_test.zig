//! Sign-in, onboarding, password change, device binding and admin elevation over HTTP.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
const app = @import("../../routes.zig");
const sqlite = @import("../../db/sqlite.zig");
const authsvc = @import("../../services/auth/service.zig");
const password = @import("../../services/auth/password.zig");
const filesmod = @import("../../services/files.zig");
const blobstore = @import("../../store/blobs.zig");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Header = harness.Header;
const Response = harness.Response;
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const cookieToken = harness.cookieToken;
const challenge = harness.challenge;
const getCode = harness.getCode;
const onboardWeb = harness.onboardWeb;
const tryElevate = harness.tryElevate;
const elevate = harness.elevate;
const Fixture = harness.Fixture;
const countRows = harness.countRows;
const deviceRequest = harness.deviceRequest;
const deviceLogin = harness.deviceLogin;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const requestWithCookie = harness.requestWithCookie;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const expectSuccess = harness.expectSuccess;
const expectFailure = harness.expectFailure;
const listed = harness.listed;

test "control-plane first login is limited, change-password revokes it and unlocks web, logout kills the session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "temp0000"); // must_change_password = 1

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const code = try getCode(ctx, "admin");
    const hash = challenge("temp0000", &code);
    const login_body = try std.fmt.allocPrint(gpa, "{{\"account\":\"admin\",\"password\":\"{s}\"}}", .{hash[0..]});
    defer gpa.free(login_body);
    var pending_tok: [32]u8 = undefined;
    {
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, login_body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const tok = cookieToken(resp.set_cookie.?).?;
        try std.testing.expectEqual(@as(usize, 32), tok.len);
        @memcpy(&pending_tok, tok);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &pending_tok, "{\"equipmentNo\":\"X\"}", 403);

    var web_tok: [32]u8 = undefined;
    {
        const new_md5 = password.md5Hex("newpass1");
        const body = try std.fmt.allocPrint(gpa, "{{\"newPassword\":\"{s}\"}}", .{new_md5[0..]});
        defer gpa.free(body);
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/user/password", &pending_tok, body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const tok = cookieToken(resp.set_cookie.?).?;
        @memcpy(&web_tok, tok);
        try std.testing.expect(!std.mem.eql(u8, &pending_tok, &web_tok)); // rotated
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &pending_tok, "{\"equipmentNo\":\"X\"}", 401);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &web_tok, "{\"equipmentNo\":\"X\"}", 200);

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/user/logout", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.set_cookie.?, "Max-Age=0") != null);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/equipment/unlink", &web_tok, "{\"equipmentNo\":\"X\"}", 401);
}

/// Logs in with an owned password and returns the control-plane token; spends
/// no `PUT /api/user/password` budget, unlike `onboardWeb`.
fn webLogin(ctx: *Context, account: []const u8, pw: []const u8) ![32]u8 {
    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const code = try getCode(ctx, account);
    const hash = challenge(pw, &code);
    const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"{s}\",\"password\":\"{s}\"}}", .{ account, hash[0..] });
    defer gpa.free(body);
    const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
        .{ .name = "content-type", .value = "application/json" },
    }, body);
    const resp = try roundtrip(ctx, req, &obuf);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var tok: [32]u8 = undefined;
    @memcpy(&tok, cookieToken(resp.set_cookie.?).?);
    return tok;
}

/// A `PUT /api/user/password` body; `current` null omits the field.
fn changePasswordBody(current: ?[]const u8, new_pw: []const u8) ![]u8 {
    const new_md5 = password.md5Hex(new_pw);
    if (current) |c| {
        const cur_md5 = password.md5Hex(c);
        return std.fmt.allocPrint(gpa, "{{\"currentPassword\":\"{s}\",\"newPassword\":\"{s}\"}}", .{ cur_md5[0..], new_md5[0..] });
    }
    return std.fmt.allocPrint(gpa, "{{\"newPassword\":\"{s}\"}}", .{new_md5[0..]});
}

fn tryChangePassword(ctx: *Context, obuf: []u8, reqbuf: []u8, tok: []const u8, current: ?[]const u8, new_pw: []const u8) !Response {
    const body = try changePasswordBody(current, new_pw);
    defer gpa.free(body);
    return requestWithCookie(ctx, obuf, reqbuf, "PUT", "/api/user/password", tok, body);
}

test "CHANGE PASSWORD: a WRONG current password is refused and leaves every session standing" {
    // Verification must precede the UPDATE, `revokeAllSessions` and
    // `issueSession`, so a typo does not sign out every session.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const desk = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const phone = try webLogin(ctx, "admin", "adminpw1"); // a second browser, elsewhere
    const stamp_before = try passwordChangedAt(f, admin);

    const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &desk, "not-my-password", "adminpw2");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try expectFailure(resp.body, "INVALID_CREDENTIALS");
    try std.testing.expect(resp.set_cookie == null);

    // A refusal issued after revocation would pass the status check; this is
    // the durable half.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &desk, "", 200);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &phone, "", 200);

    try std.testing.expectEqual(stamp_before, try passwordChangedAt(f, admin));
    _ = try webLogin(ctx, "admin", "adminpw1");
    {
        const code = try getCode(ctx, "admin");
        const hash = challenge("adminpw2", &code);
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"admin\",\"password\":\"{s}\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const bad = try roundtrip(ctx, req, &obuf);
        try expectFailure(bad.body, "INVALID_CREDENTIALS");
    }
}

test "CHANGE PASSWORD: the RIGHT current password rotates it, revokes every other session, and stamps the change" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const desk = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const phone = try webLogin(ctx, "admin", "adminpw1");

    // Backdate so "it moved" holds even when the suite finishes within a second.
    {
        var s = try f.db.prepare("UPDATE users SET password_changed_at = 0 WHERE id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(admin));
        _ = try s.step();
    }

    var fresh: [32]u8 = undefined;
    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &desk, "adminpw1", "adminpw2");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
        const tok = cookieToken(resp.set_cookie.?).?;
        @memcpy(&fresh, tok);
        try std.testing.expect(!std.mem.eql(u8, &desk, &fresh)); // rotated
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &fresh, "", 200);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &desk, "", 401);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &phone, "", 401);
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM sessions;"));

    const stamp = (try passwordChangedAt(f, admin)) orelse return error.StampMissing;
    try std.testing.expect(stamp > 0);
    _ = try webLogin(ctx, "admin", "adminpw2");
}

test "CHANGE PASSWORD: a control-plane caller that OMITS the current password is refused" {
    // A live session is not proof enough; answered with the same code as a
    // wrong password.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const desk = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const stamp_before = try passwordChangedAt(f, admin);

    const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &desk, null, "adminpw2");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try expectFailure(resp.body, "INVALID_CREDENTIALS");
    try std.testing.expect(resp.set_cookie == null);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &desk, "", 200);
    try std.testing.expectEqual(stamp_before, try passwordChangedAt(f, admin));
    _ = try webLogin(ctx, "admin", "adminpw1");
}

test "CHANGE PASSWORD: a first-login PENDING caller needs no current password — but a wrong one still refuses it" {
    // Onboarding works with no current password, yet a `pending` caller that
    // sends one is still verified.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = try f.svc.createUser(admin, "bob", false);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const pending = try webLogin(ctx, "bob", bob.temp_password.slice());

    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &pending, "guessing", "bobpass1");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
        try std.testing.expect(resp.set_cookie == null);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &pending, "", 200);
    try std.testing.expectEqual(@as(?i64, null), try passwordChangedAt(f, bob.id));

    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &pending, null, "bobpass1");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
        try std.testing.expect(cookieToken(resp.set_cookie.?) != null);
    }
    try std.testing.expect((try passwordChangedAt(f, bob.id)) != null);
    _ = try webLogin(ctx, "bob", "bobpass1");
}

test "CHANGE PASSWORD is rate-limited per USER, so an unattended browser is not a password oracle" {
    // 5 per 5 minutes per account, not per IP: a household shares an address and
    // must not block a housemate's forced first-login change.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    // Provisioned at the service layer so both start with a full bucket.
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("alicepw1"));
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bobpw111"));

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const a_tok = try webLogin(ctx, "alice", "alicepw1");
    const b_tok = try webLogin(ctx, "bob", "bobpw111");

    var i: usize = 0;
    while (i < 5) : (i += 1) {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &a_tok, "guess", "newpw123");
        try std.testing.expectEqual(@as(u16, 200), resp.status); // allowed through, refused on merit
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
    }
    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &a_tok, "guess", "newpw123");
        try std.testing.expectEqual(@as(u16, 429), resp.status);
    }
    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &a_tok, "alicepw1", "newpw123");
        try std.testing.expectEqual(@as(u16, 429), resp.status);
    }

    {
        const resp = try tryChangePassword(ctx, &obuf, &reqbuf, &b_tok, "bobpw111", "bobpw222");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &a_tok, "", 200);
}

test "device login returns a body token, binds, and cannot cross into the control-plane face" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111")); // clears must_change

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const code = try getCode(ctx, "alice");
    const hash = challenge("apass111", &code);
    var dev_tok: [32]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"alice\",\"password\":\"{s}\",\"equipmentNo\":\"SN1\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(resp.set_cookie == null); // device face: no cookie

        var parsed = try std.json.parseFromSlice(
            struct { token: []const u8, isBindEquipment: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqualStrings("N", parsed.value.isBindEquipment);
        try std.testing.expectEqual(@as(usize, 32), parsed.value.token.len);
        @memcpy(&dev_tok, parsed.value.token);
    }

    {
        const req = try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &.{
            .{ .name = "content-type", .value = "application/json" },
            .{ .name = "x-access-token", .value = &dev_tok },
            .{ .name = "equipmentNo", .value = "SN1" },
        }, "{\"equipmentNo\":\"SN1\",\"name\":\"Nomad\"}");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expect(try f.svc.isDeviceBound(alice, "SN1"));

    {
        const req = try buildRequest(&reqbuf, "POST", "/api/controlplane/equipment/unlink", &.{
            .{ .name = "content-type", .value = "application/json" },
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "{\"equipmentNo\":\"SN1\"}");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }
}

test "app login (equipment:2, no serial) yields a body token, reaches device routes, lazily binds; web still gets a cookie" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111")); // clears must_change

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // `equipment:2` (a JSON int) with no `equipmentNo`: the self-declared face,
    // not the serial, picks a device session.
    const code = try getCode(ctx, "alice");
    const hash = challenge("apass111", &code);
    var app_tok: [32]u8 = undefined;
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"alice\",\"password\":\"{s}\",\"equipment\":2,\"equipmentNo\":null,\"devices\":\"ANDROID\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(resp.set_cookie == null); // device face: no cookie
        var p = try std.json.parseFromSlice(
            struct { token: []const u8, isBind: []const u8, isBindEquipment: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqualStrings("Y", p.value.isBind);
        try std.testing.expectEqualStrings("N", p.value.isBindEquipment);
        try std.testing.expectEqual(@as(usize, 32), p.value.token.len);
        @memcpy(&app_tok, p.value.token);
    }

    // The app sends its ANDROID-… serial per request and is auto-bound lazily;
    // it never calls bindEquipment.
    const app_eno = "ANDROID-c0c59ca7-dead-beef";
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"equipmentNo\":\"{s}\"}}", .{app_eno});
        defer gpa.free(body);
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/synchronous/start", &app_tok, app_eno, body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expect(try f.svc.isDeviceBound(alice, app_eno)); // auto-bound

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/equipment/bind/status", &app_tok, app_eno, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { success: bool, bindStatus: bool }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expect(p.value.bindStatus);
    }

    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/capacity/query", &app_tok, app_eno, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { success: bool, usedCapacity: i64, totalCapacity: i64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(authsvc.default_capacity, p.value.totalCapacity);
    }

    {
        const code2 = try getCode(ctx, "alice");
        const hash2 = challenge("apass111", &code2);
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"alice\",\"password\":\"{s}\"}}", .{hash2[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(resp.set_cookie != null); // cookie path
        var p = try std.json.parseFromSlice(struct { token: ?[]const u8 = null }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.token == null); // no body token for the SPA
    }
}

test "login rejects a missing challenge and a wrong password" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    _ = try f.svc.changePassword(admin, null, &password.md5Hex("adminpw1"));

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    {
        const body = "{\"account\":\"admin\",\"password\":\"" ++ (repeat(u8, "0", 64)) ++ "\"}";
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "NO_CHALLENGE");
    }

    {
        const code = try getCode(ctx, "admin");
        const hash = challenge("WRONGpw!", &code);
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"admin\",\"password\":\"{s}\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
    }
}

test "login is rate-limited by IP after too many attempts (429)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const body = "{\"account\":\"x\",\"password\":\"y\"}"; // no challenge -> 200 NO_CHALLENGE (not limited)

    // Login allows 10/min per IP; the 11th is 429.
    var i: usize = 0;
    while (i < 10) : (i += 1) {
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
        .{ .name = "content-type", .value = "application/json" },
    }, body);
    const resp = try roundtrip(ctx, req, &obuf);
    try std.testing.expectEqual(@as(u16, 429), resp.status);
}

const shared = @import("auth_helpers.zig");
const passwordChangedAt = shared.passwordChangedAt;
