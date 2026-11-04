//! Auth service: user provisioning, the challenge login flow, sessions and
//! device binding, over the SQLite database.

const std = @import("std");
const internal = @import("service/internal.zig");
const expiring = @import("../../util/expiring.zig");
const sqlite = @import("../../db/sqlite.zig");
const schema = @import("../../db/schema.zig");
const password = @import("password.zig");
const authscope = @import("scope.zig");
const filesmod = @import("../files.zig");
const admin_ops = @import("service/admin_ops.zig");
const own_account = @import("service/own_account.zig");
const session_ops = @import("service/session_ops.zig");
const device_ops = @import("service/device_ops.zig");

const Scope = authscope.Scope;
const Caller = authscope.Caller;

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

pub fn absoluteCap(scope: Scope) i64 {
    return switch (scope) {
        .device => device_absolute_s,
        .controlplane => controlplane_absolute_s,
        .pending => pending_absolute_s,
        .public => controlplane_absolute_s, // never issued as a session audience; a safe default
    };
}

pub fn idleWindow(scope: Scope) ?i64 {
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

    // Shared with the parts under `service/`.
    const encryptCred = internal.encryptCred;
    const randomHex = internal.randomHex;

    pub const Challenge = struct { code: [code_len]u8, expires: i64 };
    pub const User = struct { id: u64, password_md5: [password.md5_len]u8, is_admin: bool, must_change: bool };

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

    pub fn deinit(self: *Service) void {
        var it = self.challenges.iterator();
        while (it.next()) |e| self.gpa.free(e.key_ptr.*);
        self.challenges.deinit(self.gpa);
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
    pub fn deleteUser(self: *Service, actor_user_id: u64, target_user_id: u64, files: filesmod.Files) Error!void {
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

    // The rest of the API, one concern per file under `service/`; the doc
    // comments live on the definitions.

    // ---- admin: users, one person's devices and quota (`service/admin_ops.zig`) ----
    // The target id comes off the URL, so each function re-derives ownership from
    // the target rather than relying on `caller.user_id` in the WHERE clause.
    pub const listUserDevices = admin_ops.listUserDevices;
    pub const freeDevices = admin_ops.freeDevices;
    pub const adminUnlinkDevice = admin_ops.adminUnlinkDevice;
    pub const userQuota = admin_ops.userQuota;
    pub const setUserQuota = admin_ops.setUserQuota;
    const userExists = admin_ops.userExists;
    const adminCount = admin_ops.adminCount;
    const insertUser = admin_ops.insertUser;
    pub const userInfo = admin_ops.userInfo;

    // ---- the caller's own account (`service/own_account.zig`) ----
    pub const AccountInfo = own_account.AccountInfo;
    pub const accountInfo = own_account.accountInfo;
    pub const freeAccount = own_account.freeAccount;
    pub const SessionSummary = own_account.SessionSummary;
    pub const sessionSummary = own_account.sessionSummary;
    pub const signOutOtherSessions = own_account.signOutOtherSessions;
    pub const userExistsByEmail = own_account.userExistsByEmail;
    pub const hasAnyUser = own_account.hasAnyUser;
    pub const isFirstRun = own_account.isFirstRun;
    const isAdmin = own_account.isAdmin;
    pub const ensureCapacity = own_account.ensureCapacity;
    pub const setCapacityTotal = own_account.setCapacityTotal;
    pub const userCapacity = own_account.userCapacity;

    // ---- login challenge, sessions and admin elevation (`service/session_ops.zig`) ----
    pub const getRandomCode = session_ops.getRandomCode;
    pub const login = session_ops.login;
    pub const changePassword = session_ops.changePassword;
    pub const logout = session_ops.logout;
    const revokeAllSessions = session_ops.revokeAllSessions;
    pub const sweepExpiredSessions = session_ops.sweepExpiredSessions;
    pub const caller = session_ops.caller;
    pub const elevate = session_ops.elevate;
    pub const lockElevation = session_ops.lockElevation;
    pub const renewElevation = session_ops.renewElevation;

    // ---- devices (`service/device_ops.zig`) ----
    pub const bindDevice = device_ops.bindDevice;
    pub const deviceSessionOwner = device_ops.deviceSessionOwner;
    pub const nameDevice = device_ops.nameDevice;
    pub const unlinkDevice = device_ops.unlinkDevice;
    pub const unlinkDeviceGlobal = device_ops.unlinkDeviceGlobal;
    pub const isDeviceBound = device_ops.isDeviceBound;
    pub const deviceCount = device_ops.deviceCount;
};

test {
    _ = @import("service/session_test.zig");
    _ = @import("service/challenge_test.zig");
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
