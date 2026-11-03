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

fn passwordChangedAt(f: *Fixture, user_id: u64) !?i64 {
    var r = (try f.db.row("SELECT password_changed_at FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return error.NoSuchUser;
    defer r.finalize();
    return r.intOpt(0);
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

test "admin manages household users over HTTP; non-admins are forbidden (require_admin)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00"); // is_admin, must_change

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    var bob_id: u64 = undefined;
    var bob_temp_buf: [password.max_temp_len]u8 = undefined;
    var bob_temp_len: usize = 0;
    {
        const body = "{\"email\":\"bob\"}";
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { userId: u64, temporaryPassword: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        bob_id = parsed.value.userId;
        try std.testing.expect(parsed.value.temporaryPassword.len > 0 and parsed.value.temporaryPassword.len <= password.max_temp_len);
        bob_temp_len = parsed.value.temporaryPassword.len;
        @memcpy(bob_temp_buf[0..bob_temp_len], parsed.value.temporaryPassword);

        const dup = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, body);
        try expectFailure(dup.body, "EMAIL_EXISTS");
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { users: []struct { email: []const u8 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 2), parsed.value.users.len);
    }

    // A non-admin gets a plain 403 on admin routes, never the elevation gate.
    const bob_temp = bob_temp_buf[0..bob_temp_len];
    const bob_tok = try onboardWeb(ctx, "bob", bob_temp, "bobpw123");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 403);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/reset", .{bob_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { temporaryPassword: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expect(parsed.value.temporaryPassword.len > 0 and parsed.value.temporaryPassword.len <= password.max_temp_len);
        try std.testing.expect(!std.mem.eql(u8, bob_temp, parsed.value.temporaryPassword)); // a fresh one
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 401);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}", .{bob_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "");
        var parsed = try std.json.parseFromSlice(
            struct { users: []struct { email: []const u8 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 1), parsed.value.users.len); // only admin remains
    }
}

test "admin devices + quota over HTTP: the gate, the 403, and the cross-user unlink that must not land" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp0");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    try f.svc.bindDevice(alice, "SN-ALICE-1", "Alice's Nomad");
    try f.svc.bindDevice(bob, "SN-BOB-1", "Bob's Manta");

    var obuf: [8192]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    // One buffer per path: these are held across later requests.
    var devbuf: [96]u8 = undefined;
    var quotabuf: [96]u8 = undefined;
    var pbuf: [96]u8 = undefined;

    const devices_path = try std.fmt.bufPrint(&devbuf, "/api/admin/users/{d}/devices", .{alice});
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");

    // Unelevated admin gets 428, never 401 (which would sign them out).
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &admin_tok, "", 428);
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { devices: []struct { equipment_no: []const u8, name: []const u8, active: bool, created_at: i64 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 1), parsed.value.devices.len);
        try std.testing.expectEqualStrings("SN-ALICE-1", parsed.value.devices[0].equipment_no);
        try std.testing.expect(parsed.value.devices[0].active);
    }

    // Alice's id with Bob's serial must 404 and leave Bob's binding active.
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-BOB-1\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "DEVICE_NOT_FOUND") != null);
    }
    try std.testing.expectEqual(@as(i64, 1), try f.svc.deviceCount(bob));

    // An unheld serial answers identically, so ownership cannot be probed.
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-NOBODY\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "DEVICE_NOT_FOUND") != null);
    }

    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{bob});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-BOB-1\"}", 200);
    }
    try std.testing.expectEqual(@as(i64, 0), try f.svc.deviceCount(bob));

    // Quota below usage is accepted and reports used > total.
    const quota_path = try std.fmt.bufPrint(&quotabuf, "/api/admin/users/{d}/quota", .{alice});
    {
        var s = try f.db.prepare("UPDATE capacity SET used_bytes = 5000 WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", quota_path, &admin_tok, "{\"totalBytes\":100}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { used_bytes: i64, total_bytes: i64 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(i64, 100), parsed.value.total_bytes);
        try std.testing.expectEqual(@as(i64, 5000), parsed.value.used_bytes);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", quota_path, &admin_tok, "{\"totalBytes\":-1}");
        try std.testing.expectEqual(@as(u16, 400), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "INVALID_QUOTA") != null);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users/9999/quota", &admin_tok, "", 404);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users/9999/devices", &admin_tok, "", 404);

    const bob_temp = (try f.svc.resetPassword(admin, bob));
    const bob_tok = try onboardWeb(ctx, "bob", bob_temp.slice(), "bobpw123");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &bob_tok, "", 403);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", quota_path, &bob_tok, "", 403);
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{bob});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &bob_tok, "{\"equipmentNo\":\"SN-BOB-1\"}", 403);
    }
}

test "admin retention and health over HTTP: the window round-trips and health names no one" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    _ = try f.svc.bootstrapAdmin("admin", "admtemp0");

    var obuf: [8192]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/settings/retention", &admin_tok, "", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/health", &admin_tok, "", 428);
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    const Retention = struct { retentionDays: i64, defaultDays: i64, minDays: i64, maxDays: i64, changedAt: i64 };

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/settings/retention", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Retention, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 30), p.value.retentionDays);
        try std.testing.expectEqual(@as(i64, 30), p.value.defaultDays);
        try std.testing.expectEqual(@as(i64, 1), p.value.minDays);
        try std.testing.expectEqual(@as(i64, 365), p.value.maxDays);
        try std.testing.expectEqual(@as(i64, 0), p.value.changedAt);
    }

    // `changedAt` starts the grace that stops a shortened window purging the
    // bin retroactively.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/settings/retention", &admin_tok, "{\"retentionDays\":7}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Retention, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 7), p.value.retentionDays);
        try std.testing.expect(p.value.changedAt > 0);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/settings/retention", &admin_tok, "{\"retentionDays\":0}", 400);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/settings/retention", &admin_tok, "{\"retentionDays\":9999}", 400);

    // The bin quotes the configured window, not the constant.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/bin", &admin_tok, "");
        var p = try std.json.parseFromSlice(struct { retentionDays: i64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 7), p.value.retentionDays);
    }

    // Household-wide totals only; the absence assertions guard against
    // per-person fields.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/health", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { health: struct { version: []const u8, memory_budget_bytes: i64, blob_bytes: i64, blob_count: i64 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqualStrings(app.api_version, p.value.health.version);
        try std.testing.expectEqual(@as(i64, 50 * 1024 * 1024), p.value.health.memory_budget_bytes);
        try std.testing.expectEqual(@as(i64, 0), p.value.health.blob_count);
        for ([_][]const u8{ "lastSync", "last_sync", "noteCount", "note_count", "user", "email" }) |leak| {
            if (std.mem.indexOf(u8, resp.body, leak) != null) {
                std.debug.print("health response leaked per-person field: {s}\n", .{leak});
                return error.HealthLeaksActivity;
            }
        }
    }
}

test "DELETE /api/admin/users releases the account's blobs, but only decrements one shared with another user" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp0");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    // Identical bytes dedup to one blob at refcount 2; deleting Alice must not
    // destroy Bob's copy.
    _ = try putSeed(f, alice, null, "solo.note", "alice private bytes");
    _ = try putSeed(f, alice, null, "shared.note", "bytes both of them have");
    const bob_shared = try putSeed(f, bob, null, "shared.note", "bytes both of them have");

    try std.testing.expectEqual(@as(i64, 2), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
    const shared_md5 = try soleMd5(f, bob_shared);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT refcount FROM blobs;"));
    try std.testing.expect(f.files.blobs.has(&shared_md5));

    try std.testing.expectEqual(@as(usize, 0), (try f.files.list(alice, null)).len);
    const listing = try f.files.list(bob, null);
    defer filesmod.Files.freeEntries(gpa, listing);
    try std.testing.expectEqual(@as(usize, 1), listing.len);
    try std.testing.expectEqualStrings("shared.note", listing[0].name);
    try std.testing.expectEqualSlices(u8, &shared_md5, listing[0].md5.?);
}

test "sync supersede RETAINS the prior version: history row, old blob kept, and BOTH are charged" {
    const f = try Fixture.init();
    defer f.deinit();

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp0");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;

    // Default fixture keeps history (keep = 5); an edit under the same path.
    const dir = try f.files.ensureFolderPath(alice, "NOTE/Note");
    const v1 = "first-version-of-the-note";
    const v2 = "second-version-of-the-note-that-is-a-bit-longer";
    const old_md5 = blobstore.md5HexOf(v1);

    const v1_id = try putSeed(f, alice, dir, "up.note", v1);
    try std.testing.expect(f.files.blobs.has(&old_md5));
    try std.testing.expectEqual(@as(i64, @intCast(v1.len)), try usedBytes(f, alice));

    const v2_id = try putSeed(f, alice, dir, "up.note", v2);
    try std.testing.expectEqual(v1_id, v2_id); // superseded the same file row, not a new one

    // v1 is retained: one history row, blob not GC'd.
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
    try std.testing.expectEqual(@as(i64, @intCast(v1.len)), try countRows(f, "SELECT size FROM file_history;"));
    try std.testing.expect(f.files.blobs.has(&old_md5));
    // The retained version is charged to the owner, like a trashed file.
    try std.testing.expectEqual(@as(i64, @intCast(v1.len + v2.len)), try usedBytes(f, alice));
    // Two blobs coexist; search stays current-only because the manifest only
    // reaches blobs a live row points at.
    try std.testing.expectEqual(@as(i64, 2), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
}

fn soleMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM files WHERE id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoSuchFile;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0));
    return out;
}

test "ACCOUNT SCREEN: the wire shape the panel is built against, over a real session" {
    // Pins the wire, which the frontend reads field by field.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    _ = try putSeed(f, admin, null, "bujo.note", "notebook bytes v1");
    _ = try putSeed(f, admin, null, "bujo.note", "notebook bytes v2 (edited)");
    _ = try putSeed(f, admin, null, "sketch.spd", "sketch bytes");
    _ = try putSeed(f, admin, null, "lease.pdf", "document bytes");
    const doomed = try putSeed(f, admin, null, "old.pdf", "trashed document bytes");
    try f.files.trash(admin, doomed);

    const AccountBody = struct {
        success: bool,
        email: []const u8,
        name: []const u8,
        isAdmin: bool,
        createdAt: i64,
        passwordChangedAt: ?i64 = null,
        thisSessionSince: ?i64 = null,
        otherBrowsers: i64,
        devices: []const struct {
            equipment_no: []const u8,
            name: []const u8,
            model: ?[]const u8 = null,
            firmware: ?[]const u8 = null,
            active: bool,
            created_at: i64,
            last_seen: ?i64 = null,
        },
        // No `bytes` (the storage route owns it); unknown fields are rejected.
        versions: struct { keep: u32, maxKeep: u32, retainedPerFile: []const u32 },
    };

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(AccountBody, gpa, resp.body, .{ .ignore_unknown_fields = false });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("admin", p.value.email);
        try std.testing.expect(p.value.isAdmin);
        // Only a self-service change stamps this.
        try std.testing.expect(p.value.passwordChangedAt != null);
        try std.testing.expect(p.value.thisSessionSince != null);
        try std.testing.expectEqual(@as(i64, 0), p.value.otherBrowsers);
        try std.testing.expectEqual(@as(usize, 0), p.value.devices.len); // no tablet bound here
        // Default (`history.keep`) and ceiling (`history.max_keep`) differ.
        try std.testing.expectEqual(@as(u32, 5), p.value.versions.keep); // the config default
        try std.testing.expectEqual(@as(u32, 15), p.value.versions.maxKeep); // the config ceiling
        try std.testing.expect(p.value.versions.maxKeep > p.value.versions.keep);
    }

    const StorageBody = struct {
        success: bool,
        used_bytes: i64,
        total_bytes: i64,
        notebooks: i64,
        sketches: i64,
        documents: i64,
        recycle_bin: i64,
        versions: i64,
    };

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account/storage", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(StorageBody, gpa, resp.body, .{ .ignore_unknown_fields = false });
        defer p.deinit();
        const b = p.value;
        try std.testing.expect(b.notebooks > 0);
        try std.testing.expect(b.sketches > 0);
        try std.testing.expect(b.documents > 0);
        try std.testing.expect(b.recycle_bin > 0);
        try std.testing.expect(b.versions > 0);
        // The parts add up to the whole.
        try std.testing.expectEqual(
            b.used_bytes,
            b.notebooks + b.sketches + b.documents + b.recycle_bin + b.versions,
        );
        try std.testing.expectEqual(b.used_bytes, try usedBytes(f, admin));
        try std.testing.expect(b.total_bytes > b.used_bytes);
    }

    // A foreign serial answers like an unknown one.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/account/devices/unlink", &web, "{\"equipmentNo\":\"SN-NOT-MINE\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    // Unlink must actually deactivate the binding, not just answer 200.
    {
        try f.svc.bindDevice(admin, "SN-MINE-1", "My Nomad");
        {
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
            try std.testing.expectEqual(@as(u16, 200), resp.status);
            var p = try std.json.parseFromSlice(AccountBody, gpa, resp.body, .{ .ignore_unknown_fields = false });
            defer p.deinit();
            var found = false;
            for (p.value.devices) |d| {
                if (std.mem.eql(u8, d.equipment_no, "SN-MINE-1")) {
                    found = true;
                    try std.testing.expect(d.active); // bound and live before we touch it
                }
            }
            try std.testing.expect(found);
        }

        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/account/devices/unlink", &web, "{\"equipmentNo\":\"SN-MINE-1\"}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        // Revoked bindings stay listed, so assert status, not absence.
        const after = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
        var p = try std.json.parseFromSlice(AccountBody, gpa, after.body, .{ .ignore_unknown_fields = false });
        defer p.deinit();
        for (p.value.devices) |d| {
            if (std.mem.eql(u8, d.equipment_no, "SN-MINE-1")) try std.testing.expect(!d.active);
        }
    }

    // Sign out elsewhere keeps this browser signed in.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/controlplane/account/sign-out-others", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const after = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/account", &web, "");
        try std.testing.expectEqual(@as(u16, 200), after.status);
    }
}

test "bindEquipment WITHOUT a token: accepted only on the strength of a live session for that serial" {
    // The Nomad sends bindEquipment unauthenticated: it fires the call ~9ms
    // after login and stores the token ~6ms later, so name, model and firmware
    // arrive with no x-access-token.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    _ = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const created = try f.svc.createUser(admin, "alice@home", false);
    const alice = created.id;
    // Real first-login flow: a `pending` account could not log a device in.
    _ = try onboardWeb(ctx, "alice@home", created.temp_password.slice(), "alicepw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bind_body =
        "{\"account\":\"alice@home\",\"equipmentNo\":\"SN-NOMAD-9\",\"name\":\"Supernote Nomad 2\"," ++
        "\"totalCapacity\":\"25485312\",\"label\":[\"NOTE/Note\"],\"version\":\"202407\"}";
    const tokenless = [_]Header{.{ .name = "content-type", .value = "application/json" }};

    // No session for that serial: 401, so the body cannot bind a serial to an
    // account you cannot log into.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &tokenless, bind_body), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }

    {
        _ = try deviceLogin(ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN-NOMAD-9");
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &tokenless, bind_body), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
        try std.testing.expect(!(try f.svc.isDeviceBound(alice, "SN-NOMAD-9")));
    }

    {
        _ = try deviceLogin(ctx, &obuf, &reqbuf, "alice@home", "alicepw1", "SN-NOMAD-9");
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/terminal/user/bindEquipment", &tokenless, bind_body), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(try f.svc.isDeviceBound(alice, "SN-NOMAD-9"));

        const devs = try f.svc.listUserDevices(gpa, alice, alice);
        defer authsvc.Service.freeDevices(gpa, devs);
        try std.testing.expectEqualStrings("Supernote Nomad 2", devs[0].name);
    }
}

test "the admin console is gated behind re-authentication, with a status the SPA cannot mistake for a dead session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    // `is_admin` alone is not permission. 428, not 401/403, which the SPA maps
    // to "session ended" and a login redirect.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 428), resp.status);
        try std.testing.expect(resp.status != 401);
        try std.testing.expect(resp.status != 403);
        try expectFailure(resp.body, "ELEVATION_REQUIRED");
    }

    // The gate covers every admin route, read-only ones included.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, "{\"email\":\"x\"}", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", "/api/admin/users/1", &admin_tok, "", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users/1/reset", &admin_tok, "", 428);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &admin_tok, "", 200);

    {
        const resp = try tryElevate(ctx, &obuf, &reqbuf, "admin", "not-the-password", &admin_tok);
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 428);

    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 200);

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/lock", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 428);

    // Lock is idempotent and never hits the gate.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/lock", &admin_tok, "", 200);
}

test "elevation: a non-admin's failure is indistinguishable from a wrong password, and a pending session cannot elevate at all" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = try f.svc.createUser(admin, "bob", false);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // A pending session cannot elevate around `must_change_password`.
    var pending_tok: [32]u8 = undefined;
    {
        const code = try getCode(ctx, "bob");
        const hash = challenge(bob.temp_password.slice(), &code);
        const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"bob\",\"password\":\"{s}\"}}", .{hash[0..]});
        defer gpa.free(body);
        const req = try buildRequest(&reqbuf, "POST", "/api/official/user/account/login/new", &.{
            .{ .name = "content-type", .value = "application/json" },
        }, body);
        const resp = try roundtrip(ctx, req, &obuf);
        @memcpy(&pending_tok, cookieToken(resp.set_cookie.?).?);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/elevate", &pending_tok, "{\"password\":\"x\"}", 403);

    // A non-admin with a correct password gets the wrong-password code: no
    // oracle for who is an admin.
    const bob_tok = try onboardWeb(ctx, "bob", bob.temp_password.slice(), "bobpw123");
    {
        const right = try tryElevate(ctx, &obuf, &reqbuf, "bob", "bobpw123", &bob_tok);
        try expectFailure(right.body, "INVALID_CREDENTIALS");
        const wrong = try tryElevate(ctx, &obuf, &reqbuf, "bob", "definitely-wrong", &bob_tok);
        try expectFailure(wrong.body, "INVALID_CREDENTIALS");
        try std.testing.expectEqual(right.status, wrong.status);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 403);
}

test "elevate is rate-limited per USER, so one housemate's fumbling cannot lock out another on the same IP" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // Two admins, one shared IP (the fixture's `client_ip`).
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const second = try f.svc.createUser(admin, "second", true);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const a_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const b_tok = try onboardWeb(ctx, "second", second.temp_password.slice(), "secondpw1");

    // 5 per 5 minutes: `elevate` is a password oracle.
    var i: usize = 0;
    while (i < 5) : (i += 1) {
        const resp = try tryElevate(ctx, &obuf, &reqbuf, "admin", "wrong-guess", &a_tok);
        try std.testing.expectEqual(@as(u16, 200), resp.status); // allowed through, auth fails
        try expectFailure(resp.body, "INVALID_CREDENTIALS");
    }
    {
        const resp = try tryElevate(ctx, &obuf, &reqbuf, "admin", "wrong-guess", &a_tok);
        try std.testing.expectEqual(@as(u16, 429), resp.status);
    }

    // Keyed by user, not IP: one person's fumbling must not lock out housemates.
    try elevate(ctx, &obuf, &reqbuf, "second", "secondpw1", &b_tok);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &b_tok, "", 200);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &a_tok, "", 200);
}

test "a password reset drops the target's elevation along with their session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const second = try f.svc.createUser(admin, "second", true);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const a_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const b_tok = try onboardWeb(ctx, "second", second.temp_password.slice(), "secondpw1");

    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &a_tok);
    try elevate(ctx, &obuf, &reqbuf, "second", "secondpw1", &b_tok);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &b_tok, "", 200);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/reset", .{second.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &a_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    // Elevation lived on the revoked session row; 401, not 428.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &b_tok, "", 401);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &b_tok, "", 401);
}

test "admin activity slides the elevation window; ordinary browsing does not" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    // Idle deadline nearly expired, ceiling far away, so a renewal is visible.
    const nearly = std.Io.Clock.real.now(std.testing.io).toSeconds() + 5;
    {
        var s = try f.db.prepare("UPDATE sessions SET elevated_until = ?1 WHERE token_hash = ?2;");
        defer s.finalize();
        s.bindInt(1, nearly);
        s.bindText(2, &password.hashToken(&admin_tok)); // rows are keyed by sha256(token)
        _ = try s.step();
    }

    // Ordinary control-plane traffic does not renew elevation.
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/user/me", &admin_tok, "", 200);
    try std.testing.expectEqual(nearly, elevatedUntil(&f.db, &admin_tok).?);

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 200);
    try std.testing.expect(elevatedUntil(&f.db, &admin_tok).? > nearly);

    // Renewal only extends a live elevation, so it is safe before authorization.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/lock", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "", 428);
    try std.testing.expect(elevatedUntil(&f.db, &admin_tok) == null); // the failed request did not revive it
}

fn elevatedUntil(db: *sqlite.Db, token: []const u8) ?i64 {
    var r = (db.row("SELECT elevated_until FROM sessions WHERE token_hash = ?1;", &.{.{ .text = &password.hashToken(token) }}) catch return null) orelse return null;
    defer r.finalize();
    return r.intOpt(0);
}

test "server-info: public, reports the LAN address, and firstRun flips once onboarding completes" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "temp0000"); // the sole account, must_change_password = 1

    var obuf: [2048]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const Info = struct { address: []const u8, firstRun: bool };

    // Unauthenticated: the login page reads this pre-auth.
    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/server-info", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        var p = try std.json.parseFromSlice(Info, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.firstRun);
        // `address` is "host:port"; the host depends on the box, so assert shape.
        try std.testing.expect(p.value.address.len != 0);
        try std.testing.expect(std.mem.indexOfScalar(u8, p.value.address, ':') != null);
        try std.testing.expect(std.mem.endsWith(u8, p.value.address, ":8089"));
    }

    _ = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/server-info", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);

        var p = try std.json.parseFromSlice(Info, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(!p.value.firstRun);
        try std.testing.expect(p.value.address.len != 0);
    }
}
