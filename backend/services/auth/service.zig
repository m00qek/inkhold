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

// ---- integration tests (in-memory SQLite, full auth flows) ----

const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");

fn testService(db: sqlite.Db) !Service {
    try schema.migrate(db);
    return Service.init(std.testing.allocator, std.testing.io, db, test_cred_key);
}

const test_cred_key: [password.cred_key_len]u8 = @splat(0xA5);

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

fn clientHash(plaintext: []const u8, code: [code_len]u8) [password.sha256_len]u8 {
    return password.challengeHash(&password.md5Hex(plaintext), &code);
}

/// Creates a user and completes the forced first-login change with `final_pw`.
fn onboardUser(svc: *Service, admin: u64, email: []const u8, final_pw: []const u8) !u64 {
    const created = try svc.createUser(admin, email, false);
    const code = try svc.getRandomCode(email);
    _ = try svc.login(email, &clientHash(created.temp_password.slice(), code), false, null); // pending token
    _ = try svc.changePassword(created.id, null, &password.md5Hex(final_pw));
    return created.id;
}

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

fn webLogin(svc: *Service, email: []const u8, pw: []const u8) !Session {
    const code = try svc.getRandomCode(email);
    return svc.login(email, &clientHash(pw, code), false, null);
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

/// Keyed by the stored value: a planted literal, or `hashToken(raw)`.
fn sessionRowCount(db: *sqlite.Db, token_hash: []const u8) i64 {
    var r = (db.row("SELECT COUNT(*) FROM sessions WHERE token_hash = ?1;", &.{.{ .text = token_hash }}) catch return -1) orelse return -1;
    defer r.finalize();
    return r.int(0);
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

// ---- admin: devices per person (F6) ----

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

// ---- admin: quota (F7) ----

test "admin quota: read defaults, write, and lowering BELOW usage is allowed and deletes nothing" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    {
        const q = try svc.userQuota(admin, alice);
        try std.testing.expectEqual(@as(i64, 0), q.used_bytes);
        try std.testing.expectEqual(default_capacity, q.total_bytes);
    }

    try db.exec("UPDATE capacity SET used_bytes = 5000 WHERE user_id = (SELECT id FROM users WHERE email = 'alice@home');");

    {
        const q = try svc.setUserQuota(admin, alice, 1_000_000);
        try std.testing.expectEqual(@as(i64, 5000), q.used_bytes);
        try std.testing.expectEqual(@as(i64, 1_000_000), q.total_bytes);
    }

    // Below usage: stored verbatim, nothing deleted; the meter draws used > total.
    {
        const q = try svc.setUserQuota(admin, alice, 100);
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

    try std.testing.expectEqual(@as(i64, 0), (try svc.setUserQuota(admin, alice, 0)).total_bytes);
    try std.testing.expectError(error.InvalidQuota, svc.setUserQuota(admin, alice, -1));
    try std.testing.expectEqual(@as(i64, 0), (try svc.userQuota(admin, alice)).total_bytes);

    // A quota is an allotment, not a self-service setting.
    try std.testing.expectError(error.NotAdmin, svc.userQuota(alice, alice));
    try std.testing.expectError(error.NotAdmin, svc.setUserQuota(alice, alice, 1 << 40));
    try std.testing.expectError(error.UserNotFound, svc.userQuota(admin, 9999));
    try std.testing.expectError(error.UserNotFound, svc.setUserQuota(admin, 9999, 1));
}

// ---- admin elevation ----

/// Writes elevation columns directly, to test the window boundaries.
fn plantElevation(db: *sqlite.Db, token: []const u8, at: ?i64, until: ?i64) !void {
    var s = try db.prepare("UPDATE sessions SET elevated_at = ?1, elevated_until = ?2 WHERE token_hash = ?3;");
    defer s.finalize();
    s.bindIntOpt(1, at);
    s.bindIntOpt(2, until);
    s.bindText(3, &password.hashToken(token));
    _ = try s.step();
}

fn nowSeconds() i64 {
    return std.Io.Clock.real.now(std.testing.io).toSeconds();
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
