//! Fixture and helpers shared by the `service` tests.

const std = @import("std");
const sqlite = @import("../../../db/sqlite.zig");
const schema = @import("../../../db/schema.zig");
const password = @import("../password.zig");
const authsvc = @import("../service.zig");
const code_len = authsvc.code_len;
const Session = authsvc.Session;
const Service = authsvc.Service;

pub fn testService(db: sqlite.Db) !Service {
    try schema.migrate(db);
    return Service.init(std.testing.allocator, std.testing.io, db, test_cred_key);
}

pub const test_cred_key: [password.cred_key_len]u8 = @splat(0xA5);

pub fn clientHash(plaintext: []const u8, code: [code_len]u8) [password.sha256_len]u8 {
    return password.challengeHash(&password.md5Hex(plaintext), &code);
}

/// Creates a user and completes the forced first-login change with `final_pw`.
pub fn onboardUser(svc: *Service, admin: u64, email: []const u8, final_pw: []const u8) !u64 {
    const created = try svc.createUser(admin, email, false);
    const code = try svc.getRandomCode(email);
    _ = try svc.login(email, &clientHash(created.temp_password.slice(), code), false, null); // pending token
    _ = try svc.changePassword(created.id, null, &password.md5Hex(final_pw));
    return created.id;
}

pub fn webLogin(svc: *Service, email: []const u8, pw: []const u8) !Session {
    const code = try svc.getRandomCode(email);
    return svc.login(email, &clientHash(pw, code), false, null);
}

/// Keyed by the stored value: a planted literal, or `hashToken(raw)`.
pub fn sessionRowCount(db: *sqlite.Db, token_hash: []const u8) i64 {
    var r = (db.row("SELECT COUNT(*) FROM sessions WHERE token_hash = ?1;", &.{.{ .text = token_hash }}) catch return -1) orelse return -1;
    defer r.finalize();
    return r.int(0);
}

pub fn nowSeconds() i64 {
    return std.Io.Clock.real.now(std.testing.io).toSeconds();
}
