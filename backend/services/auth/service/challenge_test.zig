//! Tests for login challenges, token storage, expiry and user administration.

const std = @import("std");
const sqlite = @import("../../../db/sqlite.zig");
const password = @import("../password.zig");
const authscope = @import("../scope.zig");
const Scope = authscope.Scope;
const authsvc = @import("../service.zig");
const max_account_len = authsvc.max_account_len;
const controlplane_idle_s = authsvc.controlplane_idle_s;
const Service = authsvc.Service;
const fixture = @import("fixture.zig");
const testService = fixture.testService;
const test_cred_key = fixture.test_cred_key;
const clientHash = fixture.clientHash;
const onboardUser = fixture.onboardUser;
const webLogin = fixture.webLogin;
const nowSeconds = fixture.nowSeconds;
const shared = @import("session_helpers.zig");
const TestStorage = shared.TestStorage;

test "the login challenge nonce is a 64-bit (16 hex) single-use code" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();

    const code = try svc.getRandomCode("someone@home");
    try std.testing.expectEqual(@as(usize, 16), code.len); // 16 hex = 64 bits
    for (code) |ch| try std.testing.expect(std.ascii.isHex(ch) and !std.ascii.isUpper(ch));

    const code2 = try svc.getRandomCode("someone@home");
    try std.testing.expect(!std.mem.eql(u8, &code, &code2));
    try std.testing.expectEqual(@as(u32, 1), svc.challenges.count());
}

test "issuing a challenge reclaims OTHER accounts' expired ones" {
    // Regression: expired entries for other accounts were never removed.
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();

    // The clock is real, so expiry is moved instead.
    for ([_][]const u8{ "junk1@x", "junk2@x", "junk3@x" }) |a| _ = try svc.getRandomCode(a);
    try std.testing.expectEqual(@as(u32, 3), svc.challenges.count());
    var it = svc.challenges.valueIterator();
    while (it.next()) |v| v.expires = 0;

    _ = try svc.getRandomCode("real@home");
    try std.testing.expectEqual(@as(u32, 1), svc.challenges.count());
    try std.testing.expect(svc.challenges.contains("real@home"));

    _ = try svc.getRandomCode("other@home");
    try std.testing.expectEqual(@as(u32, 2), svc.challenges.count());
    try std.testing.expect(svc.challenges.contains("real@home"));
}

test "the challenge table refuses to grow past its cap, but never refuses a live account" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    svc.max_challenges = 2;

    _ = try svc.getRandomCode("alice@home");
    _ = try svc.getRandomCode("bob@home");
    try std.testing.expectEqual(@as(u32, 2), svc.challenges.count());

    try std.testing.expectError(error.OutOfMemory, svc.getRandomCode("flood@x"));
    try std.testing.expectEqual(@as(u32, 2), svc.challenges.count());
    try std.testing.expect(!svc.challenges.contains("flood@x"));

    // A holder of a live challenge is never refused, and keeps its code.
    const again = try svc.getRandomCode("alice@home");
    try std.testing.expectEqual(@as(u32, 2), svc.challenges.count());
    try std.testing.expect(std.mem.eql(u8, &again, &svc.challenges.get("alice@home").?.code));

    // Expiry frees room again: a bound, not a latch.
    svc.challenges.getPtr("bob@home").?.expires = 0;
    _ = try svc.getRandomCode("carol@home");
    try std.testing.expectEqual(@as(u32, 2), svc.challenges.count());
    try std.testing.expect(svc.challenges.contains("carol@home"));
}

test "an account longer than any real email is refused, so the entry cap bounds BYTES" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();

    const long = @as([max_account_len + 1]u8, @splat('a'));
    try std.testing.expectError(error.OutOfMemory, svc.getRandomCode(&long));
    try std.testing.expectEqual(@as(u32, 0), svc.challenges.count());

    const at = @as([max_account_len]u8, @splat('a'));
    _ = try svc.getRandomCode(&at);
    try std.testing.expectEqual(@as(u32, 1), svc.challenges.count());
}

test "a session token authenticates, but the DB stores only its sha256 hash" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const sess = try webLogin(&svc, "alice@home", "alicepw");
    try std.testing.expectEqual(alice, (try svc.caller(&sess.token)).?.user_id);

    {
        var s = try db.prepare("SELECT COUNT(*) FROM sessions WHERE token_hash = ?1;");
        defer s.finalize();
        s.bindText(1, &password.hashToken(&sess.token));
        _ = try s.step();
        try std.testing.expectEqual(@as(i64, 1), s.columnInt(0));
    }
    {
        var s = try db.prepare("SELECT COUNT(*) FROM sessions WHERE token_hash = ?1;");
        defer s.finalize();
        s.bindText(1, &sess.token); // the raw token is not a stored key
        _ = try s.step();
        try std.testing.expectEqual(@as(i64, 0), s.columnInt(0));
    }

    try svc.logout(&sess.token);
    try std.testing.expect((try svc.caller(&sess.token)) == null);
}

test "scope-dependent expiry: idle lapses controlplane but never device; pending dies at its absolute cap" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");
    _ = alice;

    const web = try webLogin(&svc, "alice@home", "alicepw");
    const equipment_no = "SN2026NOMAD0001";
    const dev = blk: {
        const code = try svc.getRandomCode("alice@home");
        break :blk try svc.login("alice@home", &clientHash("alicepw", code), true, equipment_no);
    };
    try std.testing.expect((try svc.caller(&web.token)) != null);
    try std.testing.expect((try svc.caller(&dev.token)) != null);

    const t = nowSeconds();
    try setLastUsed(&db, &web.token, t - controlplane_idle_s - 10);
    try setLastUsed(&db, &dev.token, t - controlplane_idle_s - 10);
    try std.testing.expect((try svc.caller(&web.token)) == null); // idle-expired
    try std.testing.expect((try svc.caller(&dev.token)) != null); // device: no idle expiry

    const bob = try svc.createUser(admin, "bob@home", false);
    const pending = blk: {
        const code = try svc.getRandomCode("bob@home");
        break :blk try svc.login("bob@home", &clientHash(bob.temp_password.slice(), code), false, null);
    };
    try std.testing.expectEqual(Scope.pending, pending.audience);
    try std.testing.expect((try svc.caller(&pending.token)) != null);
    try setExpires(&db, &pending.token, t - 1);
    try std.testing.expect((try svc.caller(&pending.token)) == null); // past its absolute cap
}

test "user existence and pre-login global device unlink" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    try std.testing.expect(try svc.userExistsByEmail("alice@home"));
    try std.testing.expect(!try svc.userExistsByEmail("nobody@home"));

    const equipment_no = "SN2026NOMAD0001";
    const dev = blk: {
        const code = try svc.getRandomCode("alice@home");
        break :blk try svc.login("alice@home", &clientHash("alicepw", code), true, equipment_no);
    };
    try svc.bindDevice(alice, equipment_no, "Alice's Nomad");
    try std.testing.expect((try svc.caller(&dev.token)) != null);

    try svc.unlinkDeviceGlobal(equipment_no);
    try std.testing.expectEqual(@as(i64, 0), try svc.deviceCount(alice)); // binding inactive
    try std.testing.expect((try svc.caller(&dev.token)) == null); // session dropped
    try svc.unlinkDeviceGlobal("UNKNOWN-SERIAL"); // no-op, no error
}

fn setLastUsed(db: *sqlite.Db, token: []const u8, v: i64) !void {
    try db.run(
        "UPDATE sessions SET last_used_at = ?1 WHERE token_hash = ?2;",
        &.{ .{ .int = v }, .{ .text = &password.hashToken(token) } },
    );
}

fn setExpires(db: *sqlite.Db, token: []const u8, v: i64) !void {
    try db.run(
        "UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2;",
        &.{ .{ .int = v }, .{ .text = &password.hashToken(token) } },
    );
}

test "admin user management: list users, last-admin guard, and password reset" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();

    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const bob = (try svc.createUser(admin, "bob@home", false)).id;

    {
        const users = try svc.listUsers(std.testing.allocator);
        defer Service.freeUsers(std.testing.allocator, users);
        try std.testing.expectEqual(@as(usize, 2), users.len);
    }

    var storage = try TestStorage.init(db);
    defer storage.deinit();
    try std.testing.expectError(error.LastAdmin, svc.deleteUser(admin, admin, storage.files));

    const sess = try svc.changePassword(bob, null, &password.md5Hex("bobreal0")); // clears must_change, mints a session
    try std.testing.expect((try svc.caller(&sess.token)) != null);
    const temp = try svc.resetPassword(admin, bob);
    try std.testing.expect((try svc.caller(&sess.token)) == null); // revoked by reset

    const users = try svc.listUsers(std.testing.allocator);
    defer Service.freeUsers(std.testing.allocator, users);
    for (users) |u| {
        if (std.mem.eql(u8, u.email, "bob@home")) try std.testing.expect(u.must_change);
    }

    {
        const c = try svc.getRandomCode("bob@home");
        try std.testing.expectEqual(Scope.pending, (try svc.login("bob@home", &clientHash(temp.slice(), c), false, null)).audience);
    }
    {
        const c = try svc.getRandomCode("bob@home");
        try std.testing.expectError(error.InvalidCredentials, svc.login("bob@home", &clientHash("bobreal0", c), false, null));
    }
}

test "setAdmin promotes and demotes, reports whether the flag moved, and will not demote the last admin" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();

    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const bob = (try svc.createUser(admin, "bob@home", false)).id;

    try std.testing.expectError(error.LastAdmin, svc.setAdmin(admin, false));

    // Promotion is asserted through an admin-only call.
    try std.testing.expectError(error.NotAdmin, svc.createUser(bob, "carol@home", false));
    try std.testing.expect(try svc.setAdmin(bob, true));
    const carol = (try svc.createUser(bob, "carol@home", false)).id;

    // `make-admin` reports "already an administrator" off this false.
    try std.testing.expect(!try svc.setAdmin(bob, true));

    try std.testing.expect(try svc.setAdmin(admin, false));
    try std.testing.expectError(error.NotAdmin, svc.createUser(admin, "dave@home", false));

    try std.testing.expectError(error.LastAdmin, svc.setAdmin(bob, false));
    try std.testing.expect(!try svc.setAdmin(carol, false));
    try std.testing.expectError(error.UserNotFound, svc.setAdmin(9999, true));
}

test "userIdByEmail finds an account by the address a person actually knows" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    try std.testing.expectEqual(@as(?u64, admin), try svc.userIdByEmail("admin@home"));
    try std.testing.expect((try svc.userIdByEmail("admin@hom")) == null);
    try std.testing.expect((try svc.userIdByEmail("")) == null);
}

test "the server, not the admin, chooses temporary passwords — and stores only their hash" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");

    const bob = try svc.createUser(admin, "bob@home", false);
    const carol = try svc.createUser(admin, "carol@home", false);

    try std.testing.expect(bob.temp_password.len > 0 and bob.temp_password.len <= password.max_temp_len);
    try std.testing.expect(!std.mem.eql(u8, bob.temp_password.slice(), carol.temp_password.slice()));

    // `password_md5` is blank and `cred_enc` holds neither plaintext nor bare md5.
    {
        var s = try db.prepare("SELECT password_md5, cred_enc FROM users WHERE email = 'bob@home';");
        defer s.finalize();
        try std.testing.expect(try s.step());
        try std.testing.expectEqualStrings("", s.columnText(0)); // legacy plaintext column blanked
        const enc = s.columnText(1);
        try std.testing.expect(std.mem.indexOf(u8, enc, bob.temp_password.slice()) == null); // no plaintext
        try std.testing.expect(std.mem.indexOf(u8, enc, &password.md5Hex(bob.temp_password.slice())) == null); // not even the bare md5
        const md5 = try password.decryptCred(test_cred_key, enc);
        try std.testing.expectEqualStrings(&password.md5Hex(bob.temp_password.slice()), &md5); // decrypts to md5(temp)
    }

    const info = (try svc.userInfo(std.testing.allocator, bob.id)).?;
    defer std.testing.allocator.free(info.email);
    try std.testing.expect(info.must_change);

    try std.testing.expectError(error.NotAdmin, svc.createUser(bob.id, "dave@home", false));
    try std.testing.expectError(error.NotAdmin, svc.resetPassword(bob.id, carol.id));
}
