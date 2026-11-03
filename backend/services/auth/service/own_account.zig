//! The caller's own account: sign-in facts, other sessions, capacity.

const std = @import("std");
const internal = @import("internal.zig");
const password = @import("../password.zig");
const service = @import("../service.zig");
const Service = service.Service;
const Error = service.Error;
const idleWindow = service.idleWindow;

/// The caller's identity block; free via `freeAccount`.
pub const AccountInfo = struct {
    email: []const u8,
    name: []const u8,
    is_admin: bool,
    created_at: i64,
    /// Null means never changed, or changed before schema v3 tracked it.
    password_changed_at: ?i64,
};

pub fn accountInfo(self: *Service, gpa: std.mem.Allocator, user_id: u64) Error!?AccountInfo {
    var r = (try self.db.row(
        "SELECT email, name, is_admin, created_at, password_changed_at FROM users WHERE id = ?1;",
        &.{.{ .int = @intCast(user_id) }},
    )) orelse return null;
    defer r.finalize();
    const email = try gpa.dupe(u8, r.text(0));
    errdefer gpa.free(email);
    const name = try gpa.dupe(u8, r.text(1));
    return .{
        .email = email,
        .name = name,
        .is_admin = r.int(2) != 0,
        .created_at = r.int(3),
        .password_changed_at = r.intOpt(4),
    };
}

pub fn freeAccount(gpa: std.mem.Allocator, a: AccountInfo) void {
    gpa.free(a.email);
    gpa.free(a.name);
}

pub const SessionSummary = struct {
    /// Created-at of the presented token's row.
    this_since: ?i64,
    /// Other live `controlplane` sessions; tablets are `device` sessions, not counted.
    other_browsers: i64,
};

/// Takes the raw token and hashes it. "Live" applies both deadlines `caller`
/// enforces, so no unusable session is reported as signed in.
pub fn sessionSummary(self: *Service, user_id: u64, token: []const u8) Error!SessionSummary {
    const th = password.hashToken(token);
    const t = internal.now(
        self,
    );
    const idle = idleWindow(.controlplane) orelse 0;

    var this_since: ?i64 = null;
    {
        if (try self.db.row(
            "SELECT created_at FROM sessions WHERE token_hash = ?1 AND user_id = ?2;",
            &.{ .{ .text = &th }, .{ .int = @intCast(user_id) } },
        )) |r| {
            defer r.finalize();
            this_since = r.int(0);
        }
    }

    var others: i64 = 0;
    {
        var r = (try self.db.row(
            "SELECT COUNT(*) FROM sessions WHERE user_id = ?1 AND audience = 'controlplane' " ++
                "AND token_hash <> ?2 AND expires_at > ?3 AND last_used_at + ?4 > ?3;",
            &.{ .{ .int = @intCast(user_id) }, .{ .text = &th }, .{ .int = t }, .{ .int = idle } },
        )) orelse return .{ .this_since = this_since, .other_browsers = 0 };
        defer r.finalize();
        others = r.int(0);
    }
    return .{ .this_since = this_since, .other_browsers = others };
}

/// Deletes every session of the user except the presented one; returns the count.
/// Device sessions go too (tablets re-authenticate from their stored credential);
/// bindings are untouched.
pub fn signOutOtherSessions(self: *Service, user_id: u64, token: []const u8) Error!i64 {
    const th = password.hashToken(token);
    var s = try self.db.prepare("DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindText(2, &th);
    _ = try s.step();
    return self.db.changes();
}

/// Device `check/exists/server`.
pub fn userExistsByEmail(self: *Service, email: []const u8) Error!bool {
    var s = try self.db.prepare("SELECT 1 FROM users WHERE email = ?1 LIMIT 1;");
    defer s.finalize();
    s.bindText(1, email);
    return try s.step();
}

pub fn hasAnyUser(self: *Service) Error!bool {
    var s = try self.db.prepare("SELECT 1 FROM users LIMIT 1;");
    defer s.finalize();
    return try s.step();
}

/// Exactly one user, an admin still owing its first password change. Drives the
/// pre-auth first-run login page.
pub fn isFirstRun(self: *Service) Error!bool {
    var s = try self.db.prepare(
        \\SELECT (SELECT COUNT(*) FROM users) = 1
        \\   AND EXISTS(SELECT 1 FROM users WHERE is_admin = 1 AND must_change_password = 1);
    );
    defer s.finalize();
    _ = try s.step();
    return s.columnInt(0) != 0;
}

pub fn isAdmin(self: *Service, user_id: u64) Error!bool {
    var r = (try self.db.row("SELECT is_admin FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return false;
    defer r.finalize();
    return r.int(0) != 0;
}

pub fn getUser(self: *Service, email: []const u8) Error!?Service.User {
    var r = (try self.db.row("SELECT id, cred_enc, is_admin, must_change_password FROM users WHERE email = ?1;", &.{.{ .text = email }})) orelse return null;
    defer r.finalize();
    // A missing or corrupt blob is InvalidCredentials.
    const md5 = internal.decryptCred(self, r.text(1)) catch return error.InvalidCredentials;
    return .{
        .id = @intCast(r.int(0)),
        .password_md5 = md5,
        .is_admin = r.int(2) != 0,
        .must_change = r.int(3) != 0,
    };
}

/// INSERT OR IGNORE: device bind must never set or raise its own quota.
pub fn ensureCapacity(self: *Service, user_id: u64, total: i64) Error!void {
    var s = try self.db.prepare("INSERT OR IGNORE INTO capacity(user_id, total_bytes) VALUES(?1, ?2);");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindInt(2, total);
    _ = try s.step();
}

/// Upsert, since a freshly onboarded account may lack the row.
pub fn setCapacityTotal(self: *Service, user_id: u64, total_bytes: i64) Error!void {
    var s = try self.db.prepare(
        "INSERT INTO capacity(user_id, total_bytes) VALUES(?1, ?2) " ++
            "ON CONFLICT(user_id) DO UPDATE SET total_bytes = ?2;",
    );
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindInt(2, total_bytes);
    _ = try s.step();
}

/// For the device `user/query` VO; 0 if absent.
pub fn userCapacity(self: *Service, user_id: u64) Error!i64 {
    var r = (try self.db.row("SELECT total_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return 0;
    defer r.finalize();
    return r.int(0);
}
