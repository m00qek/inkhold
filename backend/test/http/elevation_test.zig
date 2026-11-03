//! The account screen, device binding, admin elevation and server-info over HTTP.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const authsvc = @import("../../services/auth/service.zig");
const password = @import("../../services/auth/password.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Header = harness.Header;
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const cookieToken = harness.cookieToken;
const challenge = harness.challenge;
const getCode = harness.getCode;
const onboardWeb = harness.onboardWeb;
const tryElevate = harness.tryElevate;
const elevate = harness.elevate;
const Fixture = harness.Fixture;
const deviceLogin = harness.deviceLogin;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const requestWithCookie = harness.requestWithCookie;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const expectFailure = harness.expectFailure;
const listed = harness.listed;
const shared = @import("auth_helpers.zig");
const passwordChangedAt = shared.passwordChangedAt;

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
