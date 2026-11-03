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

/// `deleteUser` releases blob references, so it needs a real store.
const TestStorage = struct {
    tmp: std.testing.TmpDir,
    files: filesvc.Files,

    fn init(db: sqlite.Db) !TestStorage {
        const tmp = std.testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(std.testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(std.testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(std.testing.io, thumbs_dir);
        return .{ .tmp = tmp, .files = filesvc.Files.init(std.testing.allocator, std.testing.io, db, store, thumbs) };
    }

    fn deinit(s: *TestStorage) void {
        s.tmp.cleanup();
    }
};

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

test "user existence, capacity set/read, and pre-login global device unlink" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    try std.testing.expect(try svc.userExistsByEmail("alice@home"));
    try std.testing.expect(!try svc.userExistsByEmail("nobody@home"));

    try std.testing.expectEqual(default_capacity, try svc.userCapacity(alice));
    try svc.setCapacityTotal(alice, 25485312 * 1024);
    try std.testing.expectEqual(@as(i64, 25485312 * 1024), try svc.userCapacity(alice));

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
    var s = try db.prepare("UPDATE sessions SET last_used_at = ?1 WHERE token_hash = ?2;");
    defer s.finalize();
    s.bindInt(1, v);
    s.bindText(2, &password.hashToken(token));
    _ = try s.step();
}

fn setExpires(db: *sqlite.Db, token: []const u8, v: i64) !void {
    var s = try db.prepare("UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2;");
    defer s.finalize();
    s.bindInt(1, v);
    s.bindText(2, &password.hashToken(token));
    _ = try s.step();
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
