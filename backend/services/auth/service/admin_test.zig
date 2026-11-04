//! Tests for the admin's device, quota and elevation powers.

const std = @import("std");
const sqlite = @import("../../../db/sqlite.zig");
const password = @import("../password.zig");
const authscope = @import("../scope.zig");
const Scope = authscope.Scope;
const authsvc = @import("../service.zig");
const filesmod = @import("../../files.zig");
const default_capacity = filesmod.Files.default_total_bytes;
const TestStorage = @import("session_helpers.zig").TestStorage;
const elevation_idle_s = authsvc.elevation_idle_s;
const elevation_absolute_s = authsvc.elevation_absolute_s;
const Service = authsvc.Service;
const fixture = @import("fixture.zig");
const testService = fixture.testService;
const clientHash = fixture.clientHash;
const onboardUser = fixture.onboardUser;
const webLogin = fixture.webLogin;
const sessionRowCount = fixture.sessionRowCount;
const nowSeconds = fixture.nowSeconds;

test "admin device listing: every binding of the named user, revoked ones included" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    try svc.bindDevice(alice, "SN-NOMAD-1", "Alice's Nomad");
    try svc.bindDevice(alice, "SN-MANTA-2", "Alice's Manta");
    try db.exec("UPDATE devices SET model = 'N6', firmware = 'SN100.B000' WHERE equipment_no = 'SN-NOMAD-1';");

    {
        const devices = try svc.listUserDevices(std.testing.allocator, admin, alice);
        defer Service.freeDevices(std.testing.allocator, devices);
        try std.testing.expectEqual(@as(usize, 2), devices.len);
        for (devices) |d| {
            try std.testing.expect(d.active);
            if (std.mem.eql(u8, d.equipment_no, "SN-NOMAD-1")) {
                try std.testing.expectEqualStrings("Alice's Nomad", d.name);
                try std.testing.expectEqualStrings("N6", d.model.?);
                try std.testing.expectEqualStrings("SN100.B000", d.firmware.?);
            } else {
                try std.testing.expect(d.model == null);
                try std.testing.expect(d.firmware == null);
            }
        }
    }

    try svc.adminUnlinkDevice(admin, alice, "SN-MANTA-2");
    const devices = try svc.listUserDevices(std.testing.allocator, admin, alice);
    defer Service.freeDevices(std.testing.allocator, devices);
    try std.testing.expectEqual(@as(usize, 2), devices.len);
    for (devices) |d| {
        const expect_active = !std.mem.eql(u8, d.equipment_no, "SN-MANTA-2");
        try std.testing.expectEqual(expect_active, d.active);
    }
    try std.testing.expectEqual(@as(i64, 1), try svc.deviceCount(alice));
}

test "admin device unlink: A's admin action can NEVER reach B's binding by id confusion" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");
    const bob = try onboardUser(&svc, admin, "bob@home", "bobpw123");

    try svc.bindDevice(alice, "SN-ALICE-1", "Alice's Nomad");
    // A live session on Bob's tablet makes a stray unlink visible twice.
    const bob_session = blk: {
        const code = try svc.getRandomCode("bob@home");
        break :blk try svc.login("bob@home", &clientHash("bobpw123", code), true, "SN-BOB-1");
    };
    try svc.bindDevice(bob, "SN-BOB-1", "Bob's Manta");

    // Alice's id with Bob's serial: the scoped UPDATE would match zero rows and 200.
    try std.testing.expectError(error.DeviceNotFound, svc.adminUnlinkDevice(admin, alice, "SN-BOB-1"));
    try std.testing.expectEqual(@as(i64, 1), try svc.deviceCount(bob)); // still bound
    try std.testing.expect((try svc.caller(&bob_session.token)) != null); // still signed in

    try std.testing.expectError(error.DeviceNotFound, svc.adminUnlinkDevice(admin, alice, "SN-NOBODY"));

    {
        const devices = try svc.listUserDevices(std.testing.allocator, admin, alice);
        defer Service.freeDevices(std.testing.allocator, devices);
        try std.testing.expectEqual(@as(usize, 1), devices.len);
        try std.testing.expectEqualStrings("SN-ALICE-1", devices[0].equipment_no);
    }

    try svc.adminUnlinkDevice(admin, bob, "SN-BOB-1");
    try std.testing.expectEqual(@as(i64, 0), try svc.deviceCount(bob));
    try std.testing.expect((try svc.caller(&bob_session.token)) == null);

    try svc.adminUnlinkDevice(admin, bob, "SN-BOB-1");

    // Self-service: non-admin Alice reaches only her own row via the same calls.
    {
        const mine = try svc.listUserDevices(std.testing.allocator, alice, alice);
        defer Service.freeDevices(std.testing.allocator, mine);
        try std.testing.expectEqual(@as(usize, 1), mine.len);
        try std.testing.expectEqualStrings("SN-ALICE-1", mine[0].equipment_no);
    }
    try std.testing.expectError(error.NotAdmin, svc.listUserDevices(std.testing.allocator, alice, bob));
    try std.testing.expectError(error.NotAdmin, svc.adminUnlinkDevice(alice, bob, "SN-BOB-1"));
    try std.testing.expectError(error.DeviceNotFound, svc.adminUnlinkDevice(alice, alice, "SN-BOB-1"));
    try std.testing.expectError(error.DeviceNotFound, svc.adminUnlinkDevice(alice, alice, "SN-NOBODY"));
    try svc.adminUnlinkDevice(alice, alice, "SN-ALICE-1");
    try std.testing.expectEqual(@as(i64, 0), try svc.deviceCount(alice));

    try std.testing.expectError(error.UserNotFound, svc.listUserDevices(std.testing.allocator, admin, 9999));
}

test "admin quota: read defaults, write, and lowering BELOW usage is allowed and deletes nothing" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    var storage = try TestStorage.init(db);
    defer storage.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    {
        const q = try svc.userQuota(admin, alice, storage.files);
        try std.testing.expectEqual(@as(i64, 0), q.used_bytes);
        try std.testing.expectEqual(default_capacity, q.total_bytes);
    }

    // An account with no capacity row yet: the write path would create it, this seeds it directly.
    try storage.files.ensureCapacity(alice);
    try db.exec("UPDATE capacity SET used_bytes = 5000 WHERE user_id = (SELECT id FROM users WHERE email = 'alice@home');");

    {
        const q = try svc.setUserQuota(admin, alice, 1_000_000, storage.files);
        try std.testing.expectEqual(@as(i64, 5000), q.used_bytes);
        try std.testing.expectEqual(@as(i64, 1_000_000), q.total_bytes);
    }

    // Below usage: stored verbatim, nothing deleted; the meter draws used > total.
    {
        const q = try svc.setUserQuota(admin, alice, 100, storage.files);
        try std.testing.expectEqual(@as(i64, 100), q.total_bytes); // NOT clamped to 5000
        try std.testing.expectEqual(@as(i64, 5000), q.used_bytes); // usage untouched
        try std.testing.expect(q.used_bytes > q.total_bytes);
    }
    {
        var s = try db.prepare("SELECT used_bytes FROM capacity WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        try std.testing.expect(try s.step());
        try std.testing.expectEqual(@as(i64, 5000), s.columnInt(0));
    }

    try std.testing.expectEqual(@as(i64, 0), (try svc.setUserQuota(admin, alice, 0, storage.files)).total_bytes);
    try std.testing.expectError(error.InvalidQuota, svc.setUserQuota(admin, alice, -1, storage.files));
    try std.testing.expectEqual(@as(i64, 0), (try svc.userQuota(admin, alice, storage.files)).total_bytes);

    // A quota is an allotment, not a self-service setting.
    try std.testing.expectError(error.NotAdmin, svc.userQuota(alice, alice, storage.files));
    try std.testing.expectError(error.NotAdmin, svc.setUserQuota(alice, alice, 1 << 40, storage.files));
    try std.testing.expectError(error.UserNotFound, svc.userQuota(admin, 9999, storage.files));
    try std.testing.expectError(error.UserNotFound, svc.setUserQuota(admin, 9999, 1, storage.files));
}

/// Writes elevation columns directly, to test the window boundaries.
fn plantElevation(db: *sqlite.Db, token: []const u8, at: ?i64, until: ?i64) !void {
    try db.run(
        "UPDATE sessions SET elevated_at = ?1, elevated_until = ?2 WHERE token_hash = ?3;",
        &.{ .{ .int_opt = at }, .{ .int_opt = until }, .{ .text = &password.hashToken(token) } },
    );
}

test "elevation: an admin re-authenticates through the challenge flow; a session starts un-elevated" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    _ = try svc.changePassword(admin, null, &password.md5Hex("adminnew")); // clear must_change

    const sess = try webLogin(&svc, "admin@home", "adminnew");
    try std.testing.expect(!(try svc.caller(&sess.token)).?.elevated);

    try std.testing.expectError(
        error.NoChallenge,
        svc.elevate(admin, &sess.token, &clientHash("adminnew", "abcdef0123456789".*)),
    );

    {
        const code = try svc.getRandomCode("admin@home");
        try std.testing.expectError(error.InvalidCredentials, svc.elevate(admin, &sess.token, &clientHash("wrongpw", code)));
        try std.testing.expect(!(try svc.caller(&sess.token)).?.elevated);
    }

    const before = nowSeconds();
    const code = try svc.getRandomCode("admin@home");
    const until = try svc.elevate(admin, &sess.token, &clientHash("adminnew", code));
    try std.testing.expect(until >= before + elevation_idle_s);
    try std.testing.expect((try svc.caller(&sess.token)).?.elevated);

    try std.testing.expectError(error.NoChallenge, svc.elevate(admin, &sess.token, &clientHash("adminnew", code)));

    const other = try webLogin(&svc, "admin@home", "adminnew");
    try std.testing.expect(!(try svc.caller(&other.token)).?.elevated);
    try std.testing.expect((try svc.caller(&sess.token)).?.elevated); // and the first is unaffected
}

test "elevation: a non-admin is refused indistinguishably from a wrong password" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const sess = try webLogin(&svc, "alice@home", "alicepw");

    const right = blk: {
        const code = try svc.getRandomCode("alice@home");
        break :blk svc.elevate(alice, &sess.token, &clientHash("alicepw", code));
    };
    const wrong = blk: {
        const code = try svc.getRandomCode("alice@home");
        break :blk svc.elevate(alice, &sess.token, &clientHash("nonsense", code));
    };
    try std.testing.expectError(error.InvalidCredentials, right);
    try std.testing.expectError(error.InvalidCredentials, wrong);
    try std.testing.expect(!(try svc.caller(&sess.token)).?.elevated);
}

test "elevation: a session that still owes a password change cannot elevate around it" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();

    // Bootstrap admin, right password, `pending` session.
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const pending = blk: {
        const code = try svc.getRandomCode("admin@home");
        break :blk try svc.login("admin@home", &clientHash("adminpw", code), false, null);
    };
    try std.testing.expectEqual(Scope.pending, pending.audience);

    const code = try svc.getRandomCode("admin@home");
    try std.testing.expectError(error.InvalidCredentials, svc.elevate(admin, &pending.token, &clientHash("adminpw", code)));
    try std.testing.expect(!(try svc.caller(&pending.token)).?.elevated);

    const full = try svc.changePassword(admin, null, &password.md5Hex("adminnew"));
    const code2 = try svc.getRandomCode("admin@home");
    _ = try svc.elevate(admin, &full.token, &clientHash("adminnew", code2));
    try std.testing.expect((try svc.caller(&full.token)).?.elevated);
}

test "elevation: the window slides on activity but the absolute ceiling still ends it" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    _ = try svc.changePassword(admin, null, &password.md5Hex("adminnew"));
    const sess = try webLogin(&svc, "admin@home", "adminnew");
    const tok = &sess.token;

    {
        const t = nowSeconds();
        try plantElevation(&db, tok, t - 60, t + 60);
        const renewed = (try svc.renewElevation(tok)).?;
        try std.testing.expect(renewed >= t + elevation_idle_s - 5);
        try std.testing.expect((try svc.caller(tok)).?.elevated);
    }

    // Near the ceiling the slide clamps to `elevated_at + absolute`.
    {
        const t = nowSeconds();
        const started = t - (elevation_absolute_s - 120); // 2 min of ceiling left
        try plantElevation(&db, tok, started, t + 300);
        const renewed = (try svc.renewElevation(tok)).?;
        try std.testing.expectEqual(started + elevation_absolute_s, renewed);
        try std.testing.expect(renewed < t + elevation_idle_s); // clamped, not a full window
    }

    {
        const t = nowSeconds();
        try plantElevation(&db, tok, t - elevation_absolute_s - 60, t + 600);
        try std.testing.expect(!(try svc.caller(tok)).?.elevated);
        try std.testing.expect((try svc.renewElevation(tok)) == null);
    }

    {
        const t = nowSeconds();
        try plantElevation(&db, tok, t - 120, t - 1);
        try std.testing.expect(!(try svc.caller(tok)).?.elevated);
        try std.testing.expect((try svc.renewElevation(tok)) == null);
    }

    try plantElevation(&db, tok, null, null);
    try std.testing.expect((try svc.renewElevation(tok)) == null);
    try std.testing.expect(!(try svc.caller(tok)).?.elevated);
}

test "elevation: lock clears it at once, and a password reset takes it with the session" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    _ = try svc.changePassword(admin, null, &password.md5Hex("adminnew"));

    const other = try svc.createUser(admin, "other@home", true);
    _ = try svc.changePassword(other.id, null, &password.md5Hex("otherpw1"));

    const sess = try webLogin(&svc, "admin@home", "adminnew");
    {
        const code = try svc.getRandomCode("admin@home");
        _ = try svc.elevate(admin, &sess.token, &clientHash("adminnew", code));
    }
    try std.testing.expect((try svc.caller(&sess.token)).?.elevated);

    try svc.lockElevation(&sess.token);
    try std.testing.expect(!(try svc.caller(&sess.token)).?.elevated);
    try svc.lockElevation(&sess.token); // idempotent
    try std.testing.expect((try svc.caller(&sess.token)) != null); // the SESSION survives; only elevation went

    {
        const code = try svc.getRandomCode("admin@home");
        _ = try svc.elevate(admin, &sess.token, &clientHash("adminnew", code));
    }
    try std.testing.expect((try svc.caller(&sess.token)).?.elevated);

    _ = try svc.resetPassword(other.id, admin);

    try std.testing.expect((try svc.caller(&sess.token)) == null);
    try std.testing.expectEqual(@as(i64, 0), sessionRowCount(&db, &password.hashToken(&sess.token)));
}
