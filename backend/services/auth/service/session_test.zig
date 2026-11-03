//! Tests for login, sessions, passwords, devices and challenges.

const std = @import("std");
const sqlite = @import("../../../db/sqlite.zig");
const password = @import("../password.zig");
const ctx = @import("../../../http/context.zig");
const filesvc = @import("../../files.zig");
const Scope = ctx.Scope;
const blobstore = @import("../../../store/blobs.zig");
const thumbstore = @import("../../../store/thumbs.zig");
const service = @import("../service.zig");
const default_capacity = service.default_capacity;
const max_account_len = service.max_account_len;
const controlplane_idle_s = service.controlplane_idle_s;
const Service = service.Service;
const fixture = @import("fixture.zig");
const testService = fixture.testService;
const test_cred_key = fixture.test_cred_key;
const clientHash = fixture.clientHash;
const onboardUser = fixture.onboardUser;
const webLogin = fixture.webLogin;
const sessionRowCount = fixture.sessionRowCount;
const nowSeconds = fixture.nowSeconds;

test "admin logs in (must change first) and creates a user" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();

    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");

    const code = try svc.getRandomCode("admin@home");
    const first = try svc.login("admin@home", &clientHash("adminpw", code), false, null);
    try std.testing.expectEqual(Scope.pending, first.audience);

    const full = try svc.changePassword(admin, null, &password.md5Hex("adminnew"));
    try std.testing.expectEqual(Scope.controlplane, full.audience);
    try std.testing.expect((try svc.caller(&first.token)) == null);

    const alice = (try svc.createUser(admin, "alice@home", false)).id;
    try std.testing.expect(alice != admin);
    try std.testing.expectError(error.NotAdmin, svc.createUser(alice, "bob@home", false));
}

test "onboarded user logs in as web client and gets a working token" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const code = try svc.getRandomCode("alice@home");
    const sess = try svc.login("alice@home", &clientHash("alicepw", code), false, null);
    try std.testing.expectEqual(Scope.controlplane, sess.audience);

    const who = (try svc.caller(&sess.token)) orelse return error.NoSession;
    try std.testing.expectEqual(alice, who.user_id);
    try std.testing.expectEqual(Scope.controlplane, who.audience);

    const code2 = try svc.getRandomCode("alice@home");
    try std.testing.expectError(
        error.InvalidCredentials,
        svc.login("alice@home", &clientHash("wrongpw", code2), false, null),
    );
}

test "onboarded user logs in as device client, gets a token, and registers a device" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const equipment_no = "SN2026NOMAD0001";
    const code = try svc.getRandomCode("alice@home");
    const sess = try svc.login("alice@home", &clientHash("alicepw", code), true, equipment_no);
    try std.testing.expectEqual(Scope.device, sess.audience);
    try std.testing.expectEqual(alice, sess.user_id);

    try svc.bindDevice(sess.user_id, equipment_no, "Alice's Nomad");
    try svc.bindDevice(sess.user_id, equipment_no, "Alice's Nomad");
    try std.testing.expectEqual(@as(i64, 1), try svc.deviceCount(alice));

    const who = (try svc.caller(&sess.token)) orelse return error.NoSession;
    try std.testing.expectEqual(Scope.device, who.audience);
}

test "first login issues a limited token; change reissues a full one" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const created = try svc.createUser(admin, "alice@home", false);
    const alice = created.id;
    const temp = created.temp_password; // server-generated; the admin hands it over once

    const code = try svc.getRandomCode("alice@home");
    const pending = try svc.login("alice@home", &clientHash(temp.slice(), code), false, null);
    try std.testing.expectEqual(Scope.pending, pending.audience);
    try std.testing.expectEqual(Scope.pending, (try svc.caller(&pending.token)).?.audience);

    try std.testing.expectError(error.SamePassword, svc.changePassword(alice, null, &password.md5Hex(temp.slice())));

    const upgraded = try svc.changePassword(alice, null, &password.md5Hex("brandnew"));
    try std.testing.expectEqual(Scope.controlplane, upgraded.audience);
    try std.testing.expect((try svc.caller(&pending.token)) == null); // limited token dead
    try std.testing.expectEqual(Scope.controlplane, (try svc.caller(&upgraded.token)).?.audience);

    {
        const c = try svc.getRandomCode("alice@home");
        try std.testing.expectEqual(Scope.controlplane, (try svc.login("alice@home", &clientHash("brandnew", c), false, null)).audience);
    }
    {
        const c = try svc.getRandomCode("alice@home");
        try std.testing.expectError(error.InvalidCredentials, svc.login("alice@home", &clientHash(temp.slice(), c), false, null));
    }
}

test "changePassword VERIFIES a supplied current password, and refuses without touching anything" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");
    const sess = try webLogin(&svc, "alice@home", "alicepw");

    try std.testing.expectError(
        error.WrongCurrentPassword,
        svc.changePassword(alice, &password.md5Hex("not-alicepw"), &password.md5Hex("alicepw2")),
    );
    try std.testing.expectError(
        error.WrongCurrentPassword,
        svc.changePassword(alice, "abc", &password.md5Hex("alicepw2")),
    );
    // A refusal must leave sessions and credential intact.
    try std.testing.expect((try svc.caller(&sess.token)) != null);
    _ = try webLogin(&svc, "alice@home", "alicepw");

    // `SamePassword` must not answer for a caller who failed verification.
    try std.testing.expectError(
        error.WrongCurrentPassword,
        svc.changePassword(alice, &password.md5Hex("wrong"), &password.md5Hex("alicepw")),
    );

    const fresh = try svc.changePassword(alice, &password.md5Hex("alicepw"), &password.md5Hex("alicepw2"));
    try std.testing.expectEqual(Scope.controlplane, fresh.audience);
    try std.testing.expect((try svc.caller(&sess.token)) == null);
    _ = try webLogin(&svc, "alice@home", "alicepw2");
}

test "logout deletes the presented session token" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    _ = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const sess = try webLogin(&svc, "alice@home", "alicepw");
    try std.testing.expect((try svc.caller(&sess.token)) != null);

    try svc.logout(&sess.token);
    try std.testing.expect((try svc.caller(&sess.token)) == null);
}

test "changing the password revokes every existing session and reissues one" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const web = try webLogin(&svc, "alice@home", "alicepw");
    const equipment_no = "SN2026NOMAD0001";
    const dev = blk: {
        const code = try svc.getRandomCode("alice@home");
        break :blk try svc.login("alice@home", &clientHash("alicepw", code), true, equipment_no);
    };
    try svc.bindDevice(dev.user_id, equipment_no, "Alice's Nomad");
    try std.testing.expect((try svc.caller(&web.token)) != null);
    try std.testing.expect((try svc.caller(&dev.token)) != null);

    const fresh = try svc.changePassword(alice, null, &password.md5Hex("rotated!"));
    try std.testing.expectEqual(Scope.controlplane, fresh.audience);
    try std.testing.expect((try svc.caller(&web.token)) == null); // browser revoked
    try std.testing.expect((try svc.caller(&dev.token)) == null); // device revoked
    try std.testing.expect((try svc.caller(&fresh.token)) != null); // new one works
}

test "unlinking a device marks the binding inactive and kills its sessions" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const equipment_no = "SN2026NOMAD0001";
    const dev = blk: {
        const code = try svc.getRandomCode("alice@home");
        break :blk try svc.login("alice@home", &clientHash("alicepw", code), true, equipment_no);
    };
    try svc.bindDevice(alice, equipment_no, "Alice's Nomad");
    try std.testing.expectEqual(@as(i64, 1), try svc.deviceCount(alice));
    try std.testing.expect((try svc.caller(&dev.token)) != null);

    try svc.unlinkDevice(alice, equipment_no);
    try std.testing.expectEqual(@as(i64, 0), try svc.deviceCount(alice)); // binding inactive
    try std.testing.expect((try svc.caller(&dev.token)) == null); // device token revoked
}

test "re-pairing an UNLINKED device brings it back — unlink is not a one-way door" {
    // Regression: `bindDevice` was INSERT OR IGNORE, so a revoked row could never
    // come back.
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const equipment_no = "SN2026NOMAD0001";
    try svc.bindDevice(alice, equipment_no, "Alice's Nomad");
    try std.testing.expectEqual(@as(i64, 1), try svc.deviceCount(alice));

    try svc.unlinkDevice(alice, equipment_no);
    try std.testing.expectEqual(@as(i64, 0), try svc.deviceCount(alice));

    try svc.bindDevice(alice, equipment_no, "Alice's Nomad");
    try std.testing.expectEqual(@as(i64, 1), try svc.deviceCount(alice));

    const devs = try svc.listUserDevices(std.testing.allocator, alice, alice);
    defer Service.freeDevices(std.testing.allocator, devs);
    try std.testing.expectEqual(@as(usize, 1), devs.len); // ONE binding, not a duplicate
    try std.testing.expect(devs[0].active);
}

test "re-binding an ACTIVE device changes nothing — this path runs on every login" {
    // Runs every login, so it must not re-date or rename an active binding.
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const equipment_no = "SN2026NOMAD0001";
    try svc.bindDevice(alice, equipment_no, "The name it was given");
    const before = blk: {
        const devs = try svc.listUserDevices(std.testing.allocator, alice, alice);
        defer Service.freeDevices(std.testing.allocator, devs);
        break :blk devs[0].created_at;
    };

    try svc.bindDevice(alice, equipment_no, "A different name");

    const devs = try svc.listUserDevices(std.testing.allocator, alice, alice);
    defer Service.freeDevices(std.testing.allocator, devs);
    try std.testing.expectEqual(before, devs[0].created_at); // not re-dated
    try std.testing.expectEqualStrings("The name it was given", devs[0].name); // not renamed
    try std.testing.expect(devs[0].active);
}

test "the device's OWN name replaces the placeholder the file path stamped" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const equipment_no = "SN2026NOMAD0001";
    try svc.bindDevice(alice, equipment_no, "Supernote app"); // the placeholder
    try svc.nameDevice(alice, equipment_no, "Supernote Nomad AA"); // the device speaks

    const devs = try svc.listUserDevices(std.testing.allocator, alice, alice);
    defer Service.freeDevices(std.testing.allocator, devs);
    try std.testing.expectEqualStrings("Supernote Nomad AA", devs[0].name);
}

test "an empty reported name never blanks the one already there" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const equipment_no = "SN2026NOMAD0001";
    try svc.bindDevice(alice, equipment_no, "Supernote Nomad AA");
    try svc.nameDevice(alice, equipment_no, "");

    const devs = try svc.listUserDevices(std.testing.allocator, alice, alice);
    defer Service.freeDevices(std.testing.allocator, devs);
    try std.testing.expectEqualStrings("Supernote Nomad AA", devs[0].name);
}

test "an admin may not delete themselves — and the sole admin is told the other reason" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    var storage = try TestStorage.init(db);
    defer storage.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const bob = try onboardUser(&svc, admin, "bob@home", "bobpw");

    try std.testing.expectError(error.LastAdmin, svc.deleteUser(admin, admin, storage.files));

    _ = try svc.setAdmin(bob, true);
    try std.testing.expectError(error.CannotDeleteSelf, svc.deleteUser(admin, admin, storage.files));
    try std.testing.expectError(error.CannotDeleteSelf, svc.deleteUser(bob, bob, storage.files));

    // Both guards run before `purgeUser` destroys files.
    const users = try svc.listUsers(std.testing.allocator);
    defer Service.freeUsers(std.testing.allocator, users);
    try std.testing.expectEqual(@as(usize, 2), users.len);

    try svc.deleteUser(admin, bob, storage.files);
}

test "an admin may NOT reset their own password from the console" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    try std.testing.expectError(error.CannotResetSelf, svc.resetPassword(admin, admin));

    const sess = try webLogin(&svc, "admin@home", "adminpw");
    try std.testing.expect((try svc.caller(&sess.token)) != null);

    _ = try svc.resetPassword(admin, alice);

    // The CLI recovery path has no actor and is unaffected.
    _ = try svc.resetPasswordFor(admin);
}

test "deleting a user (admin-only) cascades away their sessions" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    var storage = try TestStorage.init(db);
    defer storage.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const sess = try webLogin(&svc, "alice@home", "alicepw");
    try std.testing.expect((try svc.caller(&sess.token)) != null);

    try std.testing.expectError(error.NotAdmin, svc.deleteUser(alice, admin, storage.files));

    try svc.deleteUser(admin, alice, storage.files);
    try std.testing.expect((try svc.caller(&sess.token)) == null); // cascade revoked the session
    const code = try svc.getRandomCode("alice@home");
    try std.testing.expectError(error.InvalidCredentials, svc.login("alice@home", &clientHash("alicepw", code), false, null));
}

test "expired sessions are swept but live ones survive" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const live = try webLogin(&svc, "alice@home", "alicepw");

    {
        var s = try db.prepare(
            "INSERT INTO sessions(token_hash, user_id, audience, equipment_no, created_at, expires_at) " ++
                "VALUES('expired-token', ?1, 'controlplane', NULL, 0, 1);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }
    try std.testing.expectEqual(@as(i64, 1), sessionRowCount(&db, "expired-token"));

    try svc.sweepExpiredSessions();

    try std.testing.expectEqual(@as(i64, 0), sessionRowCount(&db, "expired-token")); // reclaimed
    try std.testing.expect((try svc.caller(&live.token)) != null); // live session untouched
}

const shared = @import("session_helpers.zig");
const TestStorage = shared.TestStorage;
