//! Login challenges, sessions, password change and admin elevation.

const context = @import("../../../http/context.zig");
const std = @import("std");
const internal = @import("internal.zig");
const expiring = @import("../../../util/expiring.zig");
const password = @import("../password.zig");
const Scope = context.Scope;
const Caller = context.Caller;
const token_len = 32; // hex chars (16 random bytes)
const challenge_ttl: i64 = 300; // 5 min
const last_used_bump_s: i64 = 60;
const authsvc = @import("../service.zig");
const Service = authsvc.Service;
const Error = authsvc.Error;
const code_len = authsvc.code_len;
const max_account_len = authsvc.max_account_len;
const absoluteCap = authsvc.absoluteCap;
const idleWindow = authsvc.idleWindow;
const elevation_idle_s = authsvc.elevation_idle_s;
const elevation_absolute_s = authsvc.elevation_absolute_s;
const Session = authsvc.Session;
const admin_ops = @import("admin_ops.zig");
const own_account = @import("own_account.zig");

/// Single-use code for `account`, in memory, 5-min TTL. The route is public and
/// the account attacker-chosen, so expired entries are swept and a new account is
/// refused at the cap rather than evicting (eviction would surface later as a
/// confusing `NoChallenge`). Existence is not checked: no enumeration oracle.
pub fn getRandomCode(self: *Service, account: []const u8) Error![code_len]u8 {
    // Minting into a pooled view would vanish with the request.
    if (self.read_only) return error.ReadOnlyService;
    if (account.len > max_account_len) return error.OutOfMemory;

    const code = internal.randomHex(self, code_len);
    sweepChallenges(self, internal.now(
        self,
    )); // reclaim expired before we (maybe) grow

    if (self.challenges.count() >= self.max_challenges and !self.challenges.contains(account)) {
        return error.OutOfMemory;
    }

    // getOrPut: a re-request overwrites the code in place, no window where a
    // refusal could destroy a live challenge.
    const gop = try self.challenges.getOrPut(self.gpa, account);
    if (!gop.found_existing) {
        const owned = self.gpa.dupe(u8, account) catch |e| {
            _ = self.challenges.remove(account); // undo the half-inserted entry
            return e;
        };
        gop.key_ptr.* = owned;
    }
    gop.value_ptr.* = .{ .code = code, .expires = internal.now(
        self,
    ) + challenge_ttl };
    return code;
}

fn sweepChallenges(self: *Service, now_s: i64) void {
    expiring.sweep(Service.Challenge, self.gpa, &self.challenges, now_s, struct {
        fn f(c: Service.Challenge, at: i64) bool {
            return at > c.expires;
        }
    }.f);
}

fn dropChallenge(self: *Service, account: []const u8) void {
    if (self.challenges.fetchRemove(account)) |old| self.gpa.free(old.key);
}

/// The face comes from the caller (`is_device`), not from `equipment_no`: the
/// official app is a device client that logs in without a serial.
pub fn login(self: *Service, account: []const u8, submitted_password: []const u8, is_device: bool, equipment_no: ?[]const u8) Error!Session {
    const ch = self.challenges.get(account) orelse return error.NoChallenge;
    if (internal.now(
        self,
    ) > ch.expires) {
        dropChallenge(self, account);
        return error.NoChallenge;
    }
    const user = (try own_account.getUser(self, account)) orelse return error.InvalidCredentials;
    if (!password.verifyChallenge(&user.password_md5, &ch.code, submitted_password)) {
        return error.InvalidCredentials;
    }
    dropChallenge(self, account); // single-use

    // must-change accounts get a `pending` token regardless of face.
    const audience: Scope = if (user.must_change) .pending else if (is_device) .device else .controlplane;
    return issueSession(self, user.id, audience, equipment_no);
}

pub fn issueSession(self: *Service, user_id: u64, audience: Scope, equipment_no: ?[]const u8) Error!Session {
    const token = internal.randomHex(self, token_len);
    try createSession(self, &token, user_id, audience, equipment_no);
    return .{ .token = token, .user_id = user_id, .audience = audience };
}

/// Sets `md5_hex(new)` (client-computed), clears must-change, revokes all
/// sessions and returns a fresh control-plane session. A supplied `current_md5`
/// is always verified; which callers must supply it is the handler's policy.
/// Verification precedes every write so a wrong password changes nothing.
pub fn changePassword(self: *Service, user_id: u64, current_md5: ?[]const u8, new_md5: []const u8) Error!Session {
    if (new_md5.len != password.md5_len) return error.InvalidPassword;
    {
        var r = (try self.db.row("SELECT cred_enc FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return error.InvalidCredentials;
        defer r.finalize();
        const cur = internal.decryptCred(self, r.text(0)) catch return error.InvalidCredentials;
        // Verify before the same-password check, which is itself an oracle.
        if (current_md5) |given| {
            if (!password.verifyCurrent(&cur, given)) return error.WrongCurrentPassword;
        }
        if (std.mem.eql(u8, &cur, new_md5)) return error.SamePassword;
    }
    {
        // Only path that stamps `password_changed_at`; an admin reset does not
        // choose the kept credential, so it doesn't.
        var s = try self.db.prepare("UPDATE users SET cred_enc = ?1, password_md5 = '', must_change_password = 0, password_changed_at = ?3 WHERE id = ?2;");
        defer s.finalize();
        s.bindText(1, &internal.encryptCred(self, new_md5));
        s.bindInt(2, @intCast(user_id));
        s.bindInt(3, internal.now(
            self,
        ));
        _ = try s.step();
    }
    try revokeAllSessions(self, user_id);
    return try issueSession(self, user_id, .controlplane, null);
}

/// Keyed by `sha256(token)`.
pub fn logout(self: *Service, token: []const u8) Error!void {
    var s = try self.db.prepare("DELETE FROM sessions WHERE token_hash = ?1;");
    defer s.finalize();
    s.bindText(1, &password.hashToken(token));
    _ = try s.step();
}

pub fn revokeAllSessions(self: *Service, user_id: u64) Error!void {
    var s = try self.db.prepare("DELETE FROM sessions WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    _ = try s.step();
}

/// Reclaims rows past the absolute cap.
pub fn sweepExpiredSessions(self: *Service) Error!void {
    var s = try self.db.prepare("DELETE FROM sessions WHERE expires_at < ?1;");
    defer s.finalize();
    s.bindInt(1, internal.now(
        self,
    ));
    _ = try s.step();
}

fn createSession(self: *Service, token: []const u8, user_id: u64, audience: Scope, equipment_no: ?[]const u8) Error!void {
    var s = try self.db.prepare(
        "INSERT INTO sessions(token_hash, user_id, audience, equipment_no, created_at, expires_at, last_used_at) " ++
            "VALUES(?1,?2,?3,?4,?5,?6,?7);",
    );
    defer s.finalize();
    const now_ts = internal.now(
        self,
    );
    s.bindText(1, &password.hashToken(token)); // the raw token never touches disk
    s.bindInt(2, @intCast(user_id));
    s.bindText(3, @tagName(audience));
    if (equipment_no) |e| s.bindText(4, e) else s.bindNull(4);
    s.bindInt(5, now_ts);
    s.bindInt(6, now_ts + absoluteCap(audience)); // absolute cap; idle is enforced in `caller`
    s.bindInt(7, now_ts); // last_used_at starts at creation
    _ = try s.step();
}

/// Null if unknown or expired. Equipment identity comes from the request header.
pub fn caller(self: *Service, token: []const u8) Error!?Caller {
    const th = password.hashToken(token);
    const t = internal.now(
        self,
    );
    var who: Caller = undefined;
    var last_used: i64 = 0;
    {
        var r = (try self.db.row(
            "SELECT s.user_id, s.audience, s.expires_at, u.is_admin, s.elevated_at, s.elevated_until, s.last_used_at " ++
                "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1;",
            &.{.{ .text = &th }},
        )) orelse return null;
        defer r.finalize();
        if (t > r.int(2)) return null; // absolute cap
        const a = r.text(1);
        const audience: Scope = if (std.mem.eql(u8, a, "device"))
            .device
        else if (std.mem.eql(u8, a, "pending"))
            .pending
        else
            .controlplane;
        last_used = r.int(6);
        if (idleWindow(audience)) |idle| {
            if (t > last_used + idle) return null;
        }
        who = .{
            .user_id = @intCast(r.int(0)),
            .audience = audience,
            .is_admin = r.int(3) != 0,
            .elevated = elevationLive(t, r.intOpt(4), r.intOpt(5)),
        };
    }
    // Lazy, best-effort bump: a failed write must not reject a valid session.
    if (t - last_used > last_used_bump_s) {
        if (self.db.prepare("UPDATE sessions SET last_used_at = ?1 WHERE token_hash = ?2;")) |u| {
            defer u.finalize();
            u.bindInt(1, t);
            u.bindText(2, &th);
            _ = u.step() catch {};
        } else |_| {}
    }
    return who;
}

fn elevationLive(t: i64, elevated_at: ?i64, elevated_until: ?i64) bool {
    const started = elevated_at orelse return false;
    const idle_deadline = elevated_until orelse return false;
    return t < idle_deadline and t < started + elevation_absolute_s;
}

/// Grants admin elevation via the login challenge flow (no replayable plain
/// password on LAN HTTP); returns the idle deadline. Every rejection, including
/// not-admin and must-change, is `InvalidCredentials` so it is no admin oracle.
pub fn elevate(self: *Service, user_id: u64, token: []const u8, submitted_password: []const u8) Error!i64 {
    const info = (try admin_ops.userInfo(self, self.gpa, user_id)) orelse return error.InvalidCredentials;
    defer self.gpa.free(info.email);

    const ch = self.challenges.get(info.email) orelse return error.NoChallenge;
    if (internal.now(
        self,
    ) > ch.expires) {
        dropChallenge(self, info.email);
        return error.NoChallenge;
    }
    const user = (try own_account.getUser(self, info.email)) orelse return error.InvalidCredentials;
    const ok = password.verifyChallenge(&user.password_md5, &ch.code, submitted_password);
    dropChallenge(self, info.email); // single-use, right or wrong

    if (!ok or !user.is_admin or user.must_change) return error.InvalidCredentials;

    const t = internal.now(
        self,
    );
    const until = t + elevation_idle_s;
    var s = try self.db.prepare("UPDATE sessions SET elevated_at = ?1, elevated_until = ?2 WHERE token_hash = ?3;");
    defer s.finalize();
    s.bindInt(1, t);
    s.bindInt(2, until);
    s.bindText(3, &password.hashToken(token));
    _ = try s.step();
    return until;
}

/// Clears this session's elevation ("Lock console"); idempotent.
pub fn lockElevation(self: *Service, token: []const u8) Error!void {
    var s = try self.db.prepare("UPDATE sessions SET elevated_at = NULL, elevated_until = NULL WHERE token_hash = ?1;");
    defer s.finalize();
    s.bindText(1, &password.hashToken(token));
    _ = try s.step();
}

/// Extends only an already-live elevation, clamped to the ceiling; null if none.
/// So transport can renew on every admin request without granting anything.
pub fn renewElevation(self: *Service, token: []const u8) Error!?i64 {
    const t = internal.now(
        self,
    );
    var started: i64 = undefined;
    {
        var r = (try self.db.row("SELECT elevated_at, elevated_until FROM sessions WHERE token_hash = ?1;", &.{.{ .text = &password.hashToken(token) }})) orelse return null;
        defer r.finalize();
        if (!elevationLive(t, r.intOpt(0), r.intOpt(1))) return null;
        started = r.int(0);
    }
    const until = @min(t + elevation_idle_s, started + elevation_absolute_s);
    var s = try self.db.prepare("UPDATE sessions SET elevated_until = ?1 WHERE token_hash = ?2;");
    defer s.finalize();
    s.bindInt(1, until);
    s.bindText(2, &password.hashToken(token));
    _ = try s.step();
    return until;
}
