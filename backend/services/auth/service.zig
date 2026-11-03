//! Auth service: user provisioning, the challenge login flow, sessions and
//! device binding, over the SQLite database.

const std = @import("std");
const expiring = @import("../../expiring.zig");
const sqlite = @import("../../db/sqlite.zig");
const schema = @import("../../db/schema.zig");
const password = @import("password.zig");
const ctx = @import("../../http/context.zig");
const filesvc = @import("../files.zig");

const Scope = ctx.Scope;
const Caller = ctx.Caller;

pub const Error = error{
    EmailExists,
    InvalidCredentials,
    NotAdmin,
    NoChallenge,
    InvalidPassword,
    SamePassword,
    /// Wrong `currentPassword`; answered to the client as `INVALID_CREDENTIALS`.
    WrongCurrentPassword,
    CannotResetSelf,
    CannotDeleteSelf,
    LastAdmin,
    /// Only raised by admin-scoped lookups.
    UserNotFound,
    /// Also returned for a serial bound to someone else, so it is no cross-account probe.
    DeviceNotFound,
    InvalidQuota,
    /// A write on a `readerView`: a route wrongly marked `read_only`.
    ReadOnlyService,
} || sqlite.Error || std.mem.Allocator.Error;

/// 10 GiB, defined in the db layer so migrations can write it in SQL.
pub const default_capacity: i64 = schema.default_capacity_bytes;

pub const code_len = 16; // hex chars: a 64-bit single-use nonce, 5-min TTL
const token_len = 32; // hex chars (16 random bytes)
const challenge_ttl: i64 = 300; // 5 min

/// Bounds challenge-map bytes (4096 entries × ~278 B); 254 is RFC 5321's email
/// maximum, so no real account is refused.
pub const max_account_len: usize = 254;

/// Session lifetimes. Absolute caps (from creation) are enforced by `caller` and
/// reclaimed by the sweeper; idle windows (from `last_used_at`) only by `caller`.
/// Device tokens are near-permanent and are revoked by unlink, not expiry.
pub const device_absolute_s: i64 = 2 * 365 * 24 * 3600;
pub const controlplane_idle_s: i64 = 14 * 24 * 3600;
pub const controlplane_absolute_s: i64 = 90 * 24 * 3600;
pub const pending_absolute_s: i64 = 15 * 60;

/// Rewrite `last_used_at` only when it moved this much, so a resolve is not a
/// write per request.
const last_used_bump_s: i64 = 60;

fn absoluteCap(scope: Scope) i64 {
    return switch (scope) {
        .device => device_absolute_s,
        .controlplane => controlplane_absolute_s,
        .pending => pending_absolute_s,
        .public => controlplane_absolute_s, // never issued as a session audience; a safe default
    };
}

fn idleWindow(scope: Scope) ?i64 {
    return switch (scope) {
        .controlplane => controlplane_idle_s,
        .device, .pending, .public => null,
    };
}

/// Admin elevation slides on activity up to an absolute ceiling from the password
/// re-entry, so a console left open cannot renew itself forever by polling.
pub const elevation_idle_s: i64 = 15 * 60;
pub const elevation_absolute_s: i64 = 60 * 60;

pub const TempPassword = password.TempPassword;

pub const NewUser = struct { id: u64, temp_password: TempPassword };

pub const Session = struct {
    token: [token_len]u8,
    user_id: u64,
    audience: Scope,
};

/// One device binding for the console. Slices are owned; free via `freeDevices`.
/// `model`/`firmware` are null until the device sends `bindEquipment`.
pub const DeviceInfo = struct {
    equipment_no: []const u8,
    name: []const u8,
    model: ?[]const u8,
    firmware: ?[]const u8,
    /// Revocation flips `status` to 'N' (re-pairable), so revoked rows stay listed.
    active: bool,
    created_at: i64,
    /// Last request (not last sync) from this serial's device sessions, accurate to
    /// the 60 s bump granularity; null if it holds no session.
    last_seen: ?i64,
};

pub const Quota = struct { used_bytes: i64, total_bytes: i64 };

/// `email` is owned; free via `freeUsers`.
pub const UserInfo = struct {
    id: u64,
    email: []const u8,
    is_admin: bool,
    must_change: bool,
    created_at: i64,
};

pub const Service = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    /// Encrypts `users.cred_enc`; loaded at boot from a 0600 key file outside the DB.
    cred_key: [password.cred_key_len]u8,
    challenges: std.StringHashMapUnmanaged(Challenge) = .empty,
    /// Soft cap so the public `random/code` route cannot grow the map unboundedly.
    max_challenges: usize = 4096,
    read_only: bool = false,

    const Challenge = struct { code: [code_len]u8, expires: i64 };
    const User = struct { id: u64, password_md5: [password.md5_len]u8, is_admin: bool, must_change: bool };

    pub fn init(gpa: std.mem.Allocator, io: std.Io, db: sqlite.Db, cred_key: [password.cred_key_len]u8) Service {
        return .{ .gpa = gpa, .io = io, .db = db, .cred_key = cred_key };
    }

    /// A copy bound to one request's pooled read-only connection. `challenges` is
    /// emptied: the in-memory map is the one thing READONLY cannot protect, and
    /// `getRandomCode` refuses on a view so a misclassified route fails loudly.
    pub fn readerView(self: *const Service, db: sqlite.Db) Service {
        var v = self.*;
        v.db = db;
        v.read_only = true;
        v.challenges = .empty;
        return v;
    }

    fn encryptCred(self: *Service, md5: []const u8) [password.cred_enc_hex_len]u8 {
        var src: std.Random.IoSource = .{ .io = self.io };
        return password.encryptCred(self.cred_key, md5, src.interface());
    }

    fn decryptCred(self: *Service, cred_enc_hex: []const u8) password.CredError!password.Md5Hex {
        return password.decryptCred(self.cred_key, cred_enc_hex);
    }

    pub fn deinit(self: *Service) void {
        var it = self.challenges.iterator();
        while (it.next()) |e| self.gpa.free(e.key_ptr.*);
        self.challenges.deinit(self.gpa);
    }

    /// Epoch seconds (0.16 has no `std.time.timestamp`).
    fn now(self: *Service) i64 {
        return std.Io.Clock.real.now(self.io).toSeconds();
    }

    fn randomHex(self: *Service, comptime n: usize) [n]u8 {
        var raw: [n / 2]u8 = undefined;
        var src: std.Random.IoSource = .{ .io = self.io };
        src.interface().bytes(&raw);
        const digits = "0123456789abcdef";
        var out: [n]u8 = undefined;
        for (raw, 0..) |b, i| {
            out[2 * i] = digits[b >> 4];
            out[2 * i + 1] = digits[b & 0x0f];
        }
        return out;
    }

    fn tempPassword(self: *Service) TempPassword {
        var src: std.Random.IoSource = .{ .io = self.io };
        return password.generateTemp(src.interface());
    }

    // ---- users ----

    /// First-run administrator; takes plaintext because bootstrap generated it.
    pub fn bootstrapAdmin(self: *Service, email: []const u8, plaintext: []const u8) Error!u64 {
        return self.insertUser(email, &password.md5Hex(plaintext), true);
    }

    /// Admin-only. The server chooses the temporary password and returns it once,
    /// so no admin ever knows a housemate's credential; must-change is set.
    pub fn createUser(self: *Service, actor_user_id: u64, email: []const u8, is_admin: bool) Error!NewUser {
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
        const temp = self.tempPassword();
        const id = try self.insertUser(email, &password.md5Hex(temp.slice()), is_admin);
        return .{ .id = id, .temp_password = temp };
    }

    /// Admin-only. `purgeUser` runs first because the FK cascade cannot decrement
    /// `blobs.refcount`, which would strand blobs and their index rows.
    pub fn deleteUser(self: *Service, actor_user_id: u64, target_user_id: u64, files: filesvc.Files) Error!void {
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
        // LastAdmin before CannotDeleteSelf: a sole admin gets the error whose
        // advice applies. Both refuse before `purgeUser` destroys anything.
        if (try self.isAdmin(target_user_id) and (try self.adminCount()) <= 1) return error.LastAdmin;
        if (actor_user_id == target_user_id) return error.CannotDeleteSelf;
        try files.purgeUser(target_user_id);
        var s = try self.db.prepare("DELETE FROM users WHERE id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(target_user_id));
        _ = try s.step();
    }

    /// Admin-only recovery of another account: server-generated temp password,
    /// must-change, all sessions (and their elevation) revoked. Refuses the admin's
    /// own row; the account page is where you change your own password.
    pub fn resetPassword(self: *Service, actor_user_id: u64, target_user_id: u64) Error!TempPassword {
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
        if (actor_user_id == target_user_id) return error.CannotResetSelf;
        return self.resetPasswordFor(target_user_id);
    }

    /// The mechanism without policy. The recovery CLI calls it with no actor (it is
    /// authorised by data-dir access, which already implies `cred.key`); HTTP must
    /// go through `resetPassword`.
    pub fn resetPasswordFor(self: *Service, target_user_id: u64) Error!TempPassword {
        const temp = self.tempPassword();
        {
            // Stored encrypted in `cred_enc`; `password_md5` is blanked.
            var s = try self.db.prepare("UPDATE users SET cred_enc = ?1, password_md5 = '', must_change_password = 1 WHERE id = ?2;");
            defer s.finalize();
            s.bindText(1, &self.encryptCred(&password.md5Hex(temp.slice())));
            s.bindInt(2, @intCast(target_user_id));
            _ = try s.step();
        }
        try self.revokeAllSessions(target_user_id);
        return temp;
    }

    /// Sets or clears the admin flag; true when it changed. Policy-free like
    /// `resetPasswordFor`, but keeps the last-admin guard. `caller` reads `is_admin`
    /// by JOIN per request, so a demotion takes effect immediately.
    pub fn setAdmin(self: *Service, target_user_id: u64, is_admin: bool) Error!bool {
        if (!try self.userExists(target_user_id)) return error.UserNotFound;
        const was = try self.isAdmin(target_user_id);
        if (was == is_admin) return false;
        if (was and (try self.adminCount()) <= 1) return error.LastAdmin;
        var s = try self.db.prepare("UPDATE users SET is_admin = ?1 WHERE id = ?2;");
        defer s.finalize();
        s.bindInt(1, if (is_admin) 1 else 0);
        s.bindInt(2, @intCast(target_user_id));
        _ = try s.step();
        return true;
    }

    /// The account id behind an address, or null.
    pub fn userIdByEmail(self: *Service, email: []const u8) Error!?u64 {
        var r = (try self.db.row("SELECT id FROM users WHERE email = ?1;", &.{.{ .text = email }})) orelse return null;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// Caller owns the result; free via `freeUsers`.
    pub fn listUsers(self: *Service, gpa: std.mem.Allocator) Error![]UserInfo {
        var list: std.ArrayList(UserInfo) = .empty;
        errdefer {
            for (list.items) |u| gpa.free(u.email);
            list.deinit(gpa);
        }
        var s = try self.db.prepare("SELECT id, email, is_admin, must_change_password, created_at FROM users ORDER BY id;");
        defer s.finalize();
        while (try s.step()) {
            const email = try gpa.dupe(u8, s.columnText(1));
            errdefer gpa.free(email);
            try list.append(gpa, .{
                .id = @intCast(s.columnInt(0)),
                .email = email,
                .is_admin = s.columnInt(2) != 0,
                .must_change = s.columnInt(3) != 0,
                .created_at = s.columnInt(4),
            });
        }
        return list.toOwnedSlice(gpa);
    }

    pub fn freeUsers(gpa: std.mem.Allocator, users: []UserInfo) void {
        for (users) |u| gpa.free(u.email);
        gpa.free(users);
    }

    // ---- admin: one person's devices, and their quota ----
    // The target id comes off the URL, so each function re-derives ownership from
    // the target rather than relying on `caller.user_id` in the WHERE clause.

    /// Self, or an admin. Self-service routes reuse these admin functions with
    /// actor = target so ownership is decided in one place.
    fn assertMayManage(self: *Service, actor_user_id: u64, target_user_id: u64) Error!void {
        if (actor_user_id == target_user_id) return;
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
    }

    /// Newest binding first, revoked included; free via `freeDevices`. LEFT JOIN so
    /// a binding with a missing device row still shows.
    pub fn listUserDevices(self: *Service, gpa: std.mem.Allocator, actor_user_id: u64, target_user_id: u64) Error![]DeviceInfo {
        try self.assertMayManage(actor_user_id, target_user_id);
        if (!try self.userExists(target_user_id)) return error.UserNotFound;

        var list: std.ArrayList(DeviceInfo) = .empty;
        errdefer {
            for (list.items) |d| freeDevice(gpa, d);
            list.deinit(gpa);
        }
        // `last_seen` is scoped by user_id too: a re-bound serial must not report
        // a previous owner's activity.
        var s = try self.db.prepare(
            "SELECT ud.equipment_no, ud.name, d.model, d.firmware, ud.status, ud.created_at, " ++
                "  (SELECT MAX(s.last_used_at) FROM sessions s " ++
                "    WHERE s.user_id = ud.user_id AND s.equipment_no = ud.equipment_no AND s.audience = 'device') " ++
                "FROM user_devices ud LEFT JOIN devices d ON d.equipment_no = ud.equipment_no " ++
                "WHERE ud.user_id = ?1 ORDER BY ud.created_at DESC, ud.equipment_no;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(target_user_id));
        while (try s.step()) {
            const equipment_no = try gpa.dupe(u8, s.columnText(0));
            errdefer gpa.free(equipment_no);
            const name = try gpa.dupe(u8, s.columnText(1));
            errdefer gpa.free(name);
            const model: ?[]const u8 = if (s.columnIsNull(2)) null else try gpa.dupe(u8, s.columnText(2));
            errdefer if (model) |m| gpa.free(m);
            const firmware: ?[]const u8 = if (s.columnIsNull(3)) null else try gpa.dupe(u8, s.columnText(3));
            errdefer if (firmware) |fw| gpa.free(fw);
            try list.append(gpa, .{
                .equipment_no = equipment_no,
                .name = name,
                .model = model,
                .firmware = firmware,
                .active = std.mem.eql(u8, s.columnText(4), "Y"),
                .created_at = s.columnInt(5),
                .last_seen = s.columnIntOpt(6),
            });
        }
        return list.toOwnedSlice(gpa);
    }

    fn freeDevice(gpa: std.mem.Allocator, d: DeviceInfo) void {
        gpa.free(d.equipment_no);
        gpa.free(d.name);
        if (d.model) |m| gpa.free(m);
        if (d.firmware) |fw| gpa.free(fw);
    }

    pub fn freeDevices(gpa: std.mem.Allocator, devices: []DeviceInfo) void {
        for (devices) |d| freeDevice(gpa, d);
        gpa.free(devices);
    }

    /// Asserts the binding exists for this user first, so a mistaken id fails
    /// instead of a silent zero-row 200. A serial owned by someone else gets the same
    /// `DeviceNotFound`; an already-revoked binding is a no-op 200.
    pub fn adminUnlinkDevice(self: *Service, actor_user_id: u64, target_user_id: u64, equipment_no: []const u8) Error!void {
        try self.assertMayManage(actor_user_id, target_user_id);
        if (!try self.hasBinding(target_user_id, equipment_no)) return error.DeviceNotFound;
        try self.unlinkDevice(target_user_id, equipment_no);
    }

    fn hasBinding(self: *Service, user_id: u64, equipment_no: []const u8) Error!bool {
        var s = try self.db.prepare("SELECT 1 FROM user_devices WHERE user_id = ?1 AND equipment_no = ?2 LIMIT 1;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, equipment_no);
        return try s.step();
    }

    /// Admin-only. No `capacity` row reads as the default, matching `Files.capacity`.
    pub fn userQuota(self: *Service, actor_user_id: u64, target_user_id: u64) Error!Quota {
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
        if (!try self.userExists(target_user_id)) return error.UserNotFound;
        var r = (try self.db.row("SELECT used_bytes, total_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(target_user_id) }})) orelse
            return .{ .used_bytes = 0, .total_bytes = default_capacity };
        defer r.finalize();
        return .{ .used_bytes = r.int(0), .total_bytes = r.int(1) };
    }

    /// Admin-only. Below current usage is allowed and deletes nothing (it just stops
    /// further syncs); zero means "no new uploads".
    pub fn setUserQuota(self: *Service, actor_user_id: u64, target_user_id: u64, total_bytes: i64) Error!Quota {
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
        if (!try self.userExists(target_user_id)) return error.UserNotFound;
        if (total_bytes < 0) return error.InvalidQuota;
        try self.setCapacityTotal(target_user_id, total_bytes);
        return self.userQuota(actor_user_id, target_user_id);
    }

    fn userExists(self: *Service, user_id: u64) Error!bool {
        var s = try self.db.prepare("SELECT 1 FROM users WHERE id = ?1 LIMIT 1;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        return try s.step();
    }

    fn adminCount(self: *Service) Error!i64 {
        var s = try self.db.prepare("SELECT COUNT(*) FROM users WHERE is_admin = 1;");
        defer s.finalize();
        _ = try s.step();
        return s.columnInt(0);
    }

    fn insertUser(self: *Service, email: []const u8, password_md5: []const u8, is_admin: bool) Error!u64 {
        // The md5 goes encrypted into `cred_enc`; the legacy column stays blank.
        var s = try self.db.prepare("INSERT INTO users(email, password_md5, cred_enc, is_admin, created_at) VALUES(?1,'',?2,?3,?4);");
        defer s.finalize();
        s.bindText(1, email);
        s.bindText(2, &self.encryptCred(password_md5));
        s.bindInt(3, if (is_admin) 1 else 0);
        s.bindInt(4, self.now());
        _ = s.step() catch return error.EmailExists; // UNIQUE(email) violation
        const id: u64 = @intCast(self.db.lastInsertRowId());
        try self.ensureCapacity(id, default_capacity);
        return id;
    }

    /// Caller owns `email`.
    pub fn userInfo(self: *Service, gpa: std.mem.Allocator, user_id: u64) Error!?UserInfo {
        var r = (try self.db.row("SELECT id, email, is_admin, must_change_password, created_at FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return null;
        defer r.finalize();
        return .{
            .id = @intCast(r.int(0)),
            .email = try gpa.dupe(u8, r.text(1)),
            .is_admin = r.int(2) != 0,
            .must_change = r.int(3) != 0,
            .created_at = r.int(4),
        };
    }

    // ---- the caller's own account ----

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
        const t = self.now();
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

    fn isAdmin(self: *Service, user_id: u64) Error!bool {
        var r = (try self.db.row("SELECT is_admin FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return false;
        defer r.finalize();
        return r.int(0) != 0;
    }

    fn getUser(self: *Service, email: []const u8) Error!?User {
        var r = (try self.db.row("SELECT id, cred_enc, is_admin, must_change_password FROM users WHERE email = ?1;", &.{.{ .text = email }})) orelse return null;
        defer r.finalize();
        // A missing or corrupt blob is InvalidCredentials.
        const md5 = self.decryptCred(r.text(1)) catch return error.InvalidCredentials;
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

    // ---- login challenge + session ----

    /// Single-use code for `account`, in memory, 5-min TTL. The route is public and
    /// the account attacker-chosen, so expired entries are swept and a new account is
    /// refused at the cap rather than evicting (eviction would surface later as a
    /// confusing `NoChallenge`). Existence is not checked: no enumeration oracle.
    pub fn getRandomCode(self: *Service, account: []const u8) Error![code_len]u8 {
        // Minting into a pooled view would vanish with the request.
        if (self.read_only) return error.ReadOnlyService;
        if (account.len > max_account_len) return error.OutOfMemory;

        const code = self.randomHex(code_len);
        self.sweepChallenges(self.now()); // reclaim expired before we (maybe) grow

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
        gop.value_ptr.* = .{ .code = code, .expires = self.now() + challenge_ttl };
        return code;
    }

    fn sweepChallenges(self: *Service, now_s: i64) void {
        expiring.sweep(Challenge, self.gpa, &self.challenges, now_s, struct {
            fn f(c: Challenge, at: i64) bool {
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
        if (self.now() > ch.expires) {
            self.dropChallenge(account);
            return error.NoChallenge;
        }
        const user = (try self.getUser(account)) orelse return error.InvalidCredentials;
        if (!password.verifyChallenge(&user.password_md5, &ch.code, submitted_password)) {
            return error.InvalidCredentials;
        }
        self.dropChallenge(account); // single-use

        // must-change accounts get a `pending` token regardless of face.
        const audience: Scope = if (user.must_change) .pending else if (is_device) .device else .controlplane;
        return self.issueSession(user.id, audience, equipment_no);
    }

    fn issueSession(self: *Service, user_id: u64, audience: Scope, equipment_no: ?[]const u8) Error!Session {
        const token = self.randomHex(token_len);
        try self.createSession(&token, user_id, audience, equipment_no);
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
            const cur = self.decryptCred(r.text(0)) catch return error.InvalidCredentials;
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
            s.bindText(1, &self.encryptCred(new_md5));
            s.bindInt(2, @intCast(user_id));
            s.bindInt(3, self.now());
            _ = try s.step();
        }
        try self.revokeAllSessions(user_id);
        return try self.issueSession(user_id, .controlplane, null);
    }

    /// Keyed by `sha256(token)`.
    pub fn logout(self: *Service, token: []const u8) Error!void {
        var s = try self.db.prepare("DELETE FROM sessions WHERE token_hash = ?1;");
        defer s.finalize();
        s.bindText(1, &password.hashToken(token));
        _ = try s.step();
    }

    fn revokeAllSessions(self: *Service, user_id: u64) Error!void {
        var s = try self.db.prepare("DELETE FROM sessions WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        _ = try s.step();
    }

    /// Reclaims rows past the absolute cap.
    pub fn sweepExpiredSessions(self: *Service) Error!void {
        var s = try self.db.prepare("DELETE FROM sessions WHERE expires_at < ?1;");
        defer s.finalize();
        s.bindInt(1, self.now());
        _ = try s.step();
    }

    fn createSession(self: *Service, token: []const u8, user_id: u64, audience: Scope, equipment_no: ?[]const u8) Error!void {
        var s = try self.db.prepare(
            "INSERT INTO sessions(token_hash, user_id, audience, equipment_no, created_at, expires_at, last_used_at) " ++
                "VALUES(?1,?2,?3,?4,?5,?6,?7);",
        );
        defer s.finalize();
        const now_ts = self.now();
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
        const t = self.now();
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

    // ---- admin elevation (re-authentication) ----

    fn elevationLive(t: i64, elevated_at: ?i64, elevated_until: ?i64) bool {
        const started = elevated_at orelse return false;
        const idle_deadline = elevated_until orelse return false;
        return t < idle_deadline and t < started + elevation_absolute_s;
    }

    /// Grants admin elevation via the login challenge flow (no replayable plain
    /// password on LAN HTTP); returns the idle deadline. Every rejection, including
    /// not-admin and must-change, is `InvalidCredentials` so it is no admin oracle.
    pub fn elevate(self: *Service, user_id: u64, token: []const u8, submitted_password: []const u8) Error!i64 {
        const info = (try self.userInfo(self.gpa, user_id)) orelse return error.InvalidCredentials;
        defer self.gpa.free(info.email);

        const ch = self.challenges.get(info.email) orelse return error.NoChallenge;
        if (self.now() > ch.expires) {
            self.dropChallenge(info.email);
            return error.NoChallenge;
        }
        const user = (try self.getUser(info.email)) orelse return error.InvalidCredentials;
        const ok = password.verifyChallenge(&user.password_md5, &ch.code, submitted_password);
        self.dropChallenge(info.email); // single-use, right or wrong

        if (!ok or !user.is_admin or user.must_change) return error.InvalidCredentials;

        const t = self.now();
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
        const t = self.now();
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

    // ---- devices ----

    /// Registers the device and binds it (after device login).
    pub fn bindDevice(self: *Service, user_id: u64, equipment_no: []const u8, name: []const u8) Error!void {
        {
            var s = try self.db.prepare("INSERT OR IGNORE INTO devices(equipment_no, created_at) VALUES(?1, ?2);");
            defer s.finalize();
            s.bindText(1, equipment_no);
            s.bindInt(2, self.now());
            _ = try s.step();
        }
        {
            // Upsert that reactivates: unlink keeps the row as 'N', so OR IGNORE
            // would make unlinking permanent. An active row is untouched (this
            // runs every login); a revoked one is renamed and re-dated.
            var s = try self.db.prepare(
                "INSERT INTO user_devices(user_id, equipment_no, name, status, created_at) VALUES(?1,?2,?3,'Y',?4) " ++
                    "ON CONFLICT(user_id, equipment_no) DO UPDATE SET " ++
                    "  status = 'Y'," ++
                    "  name = CASE WHEN user_devices.status = 'N' THEN excluded.name ELSE user_devices.name END," ++
                    "  created_at = CASE WHEN user_devices.status = 'N' THEN excluded.created_at ELSE user_devices.created_at END;",
            );
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            s.bindText(2, equipment_no);
            s.bindText(3, name);
            s.bindInt(4, self.now());
            _ = try s.step();
        }
    }

    /// The user behind a live device session for this serial, only if it belongs to
    /// `email`. The Nomad sends `bindEquipment` ~9 ms after login but stores the token
    /// at ~15 ms, so that call carries no `x-access-token`; this stands in for it
    /// without letting a body bind a serial to an account nobody logged into.
    pub fn deviceSessionOwner(self: *Service, equipment_no: []const u8, email: []const u8) Error!?u64 {
        if (equipment_no.len == 0 or email.len == 0) return null;
        var r = (try self.db.row(
            "SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id " ++
                "WHERE s.equipment_no = ?1 AND s.audience = 'device' AND u.email = ?2 AND s.expires_at > ?3 " ++
                "LIMIT 1;",
            &.{ .{ .text = equipment_no }, .{ .text = email }, .{ .int = self.now() } },
        )) orelse return null;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// The device's self-reported name from `bindEquipment`; `bindDevice` never
    /// overwrites a label, so this is the only way a real name replaces the placeholder.
    pub fn nameDevice(self: *Service, user_id: u64, equipment_no: []const u8, name: []const u8) Error!void {
        if (name.len == 0) return;
        var s = try self.db.prepare("UPDATE user_devices SET name = ?3 WHERE user_id = ?1 AND equipment_no = ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, equipment_no);
        s.bindText(3, name);
        _ = try s.step();
    }

    /// Revokes a device: marks the binding inactive and deletes its sessions.
    pub fn unlinkDevice(self: *Service, user_id: u64, equipment_no: []const u8) Error!void {
        {
            var s = try self.db.prepare("UPDATE user_devices SET status = 'N' WHERE user_id = ?1 AND equipment_no = ?2;");
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            s.bindText(2, equipment_no);
            _ = try s.step();
        }
        {
            var s = try self.db.prepare("DELETE FROM sessions WHERE user_id = ?1 AND equipment_no = ?2;");
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            s.bindText(2, equipment_no);
            _ = try s.step();
        }
    }

    /// Unlinks a serial across all users. Must never back the public pre-login
    /// `equipment/unlink` route: that would be an unauthenticated LAN DoS.
    pub fn unlinkDeviceGlobal(self: *Service, equipment_no: []const u8) Error!void {
        {
            var s = try self.db.prepare("UPDATE user_devices SET status = 'N' WHERE equipment_no = ?1;");
            defer s.finalize();
            s.bindText(1, equipment_no);
            _ = try s.step();
        }
        {
            var s = try self.db.prepare("DELETE FROM sessions WHERE equipment_no = ?1;");
            defer s.finalize();
            s.bindText(1, equipment_no);
            _ = try s.step();
        }
    }

    /// Login reports this so the device knows whether to bind.
    pub fn isDeviceBound(self: *Service, user_id: u64, equipment_no: []const u8) Error!bool {
        var s = try self.db.prepare(
            "SELECT 1 FROM user_devices WHERE user_id = ?1 AND equipment_no = ?2 AND status = 'Y' LIMIT 1;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, equipment_no);
        return try s.step();
    }

    pub fn deviceCount(self: *Service, user_id: u64) Error!i64 {
        var s = try self.db.prepare("SELECT COUNT(*) FROM user_devices WHERE user_id = ?1 AND status = 'Y';");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        _ = try s.step();
        return s.columnInt(0);
    }
};

test {
    _ = @import("service/session_test.zig");
    _ = @import("service/admin_test.zig");
}

// ---- tests of private helpers ----

const fixture = @import("service/fixture.zig");
const testService = fixture.testService;

test "token entropy comes from the OS CSPRNG: two fresh services never replay a sequence" {
    var db1 = try sqlite.Db.openMemory();
    defer db1.close();
    var svc1 = try testService(db1);
    defer svc1.deinit();
    var db2 = try sqlite.Db.openMemory();
    defer db2.close();
    var svc2 = try testService(db2);
    defer svc2.deinit();

    // A fixed-seed PRNG would make two independent services draw the same token.
    const a = svc1.randomHex(token_len);
    const b = svc2.randomHex(token_len);
    try std.testing.expect(!std.mem.eql(u8, &a, &b));

    const c = svc1.randomHex(token_len);
    const d = svc1.randomHex(token_len);
    try std.testing.expect(!std.mem.eql(u8, &c, &d));
    var seen_nonzero = false;
    for (c) |ch| {
        try std.testing.expect(std.ascii.isHex(ch) and !std.ascii.isUpper(ch));
        if (ch != '0') seen_nonzero = true;
    }
    try std.testing.expect(seen_nonzero);
}
