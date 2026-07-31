//! Auth service: user provisioning, the random-code + login challenge flow,
//! session issuance, and device binding — operating on the SQLite database.
//!
//! HTTP handlers are thin wrappers over this; these functions are what the
//! integration tests drive directly against an in-memory database.

const std = @import("std");
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
    LastAdmin,
    /// No such account. Only ever raised by the ADMIN-scoped lookups, which are
    /// already past an `isAdmin` check — an admin may legitimately learn that an
    /// id is unused, and the console needs to tell "gone" from "broken".
    UserNotFound,
    /// The named user holds no binding for that serial. Deliberately the SAME
    /// error whether the serial is unknown or belongs to SOMEBODY ELSE — see
    /// `adminUnlinkDevice`.
    DeviceNotFound,
    /// A quota that is not a byte count (negative). Note that a quota BELOW
    /// current usage is not this: see `setUserQuota`.
    InvalidQuota,
} || sqlite.Error || std.mem.Allocator.Error;

/// Default per-user quota for a household (10 GiB). An alias: the value is
/// defined in the db layer, which is where the v10 repair migration also has to
/// write it in SQL. See `schema.default_capacity_bytes`.
pub const default_capacity: i64 = schema.default_capacity_bytes;

pub const code_len = 16; // hex chars (a 64-bit challenge nonce: anti-replay / anti-offline-brute headroom; single-use, 5-min TTL)
const token_len = 32; // hex chars (16 random bytes)
const challenge_ttl: i64 = 300; // 5 min

/// Scope-dependent session lifetime, generalising the elevation model
/// (`elevationLive`) to whole sessions: an ABSOLUTE cap measured from creation
/// (enforced by `caller` AND reclaimed by `sweepExpiredSessions`) plus, for
/// scopes that have one, an IDLE deadline measured from `last_used_at` (enforced
/// ONLY at resolve time in `caller` — the sweeper stays absolute-only).
///
///   | scope        | idle           | absolute        |
///   |--------------|----------------|-----------------|
///   | device       | none           | ~2 years        | revoke via UNLINK, not expiry
///   | controlplane | 14 days        | 90 days         |
///   | pending      | —              | 15 min          | the first-login window
///
/// Device tokens are near-permanent by design (the Nomad holds one indefinitely);
/// they age out only on the 2-year absolute cap, and are revoked by device unlink.
pub const device_absolute_s: i64 = 2 * 365 * 24 * 3600;
pub const controlplane_idle_s: i64 = 14 * 24 * 3600;
pub const controlplane_absolute_s: i64 = 90 * 24 * 3600;
pub const pending_absolute_s: i64 = 15 * 60;

/// Granularity for the lazy `last_used_at` bump: only rewrite the column when it
/// has moved by more than this, so a session-resolve is not a write per request.
const last_used_bump_s: i64 = 60;

/// The absolute lifetime cap for a scope, measured from creation.
fn absoluteCap(scope: Scope) i64 {
    return switch (scope) {
        .device => device_absolute_s,
        .controlplane => controlplane_absolute_s,
        .pending => pending_absolute_s,
        .public => controlplane_absolute_s, // never issued as a session audience; a safe default
    };
}

/// The idle window for a scope (since `last_used_at`), or null when the scope has
/// none — device (near-permanent) and pending (absolute-only).
fn idleWindow(scope: Scope) ?i64 {
    return switch (scope) {
        .controlplane => controlplane_idle_s,
        .device, .pending, .public => null,
    };
}

/// Admin elevation: the window slides on admin activity but can never outlive the
/// absolute ceiling measured from the moment the password was re-entered.
///
/// 15 minutes idle is roughly "you walked away from the machine"; the 60-minute
/// ceiling is what stops a console left open in a background tab from renewing
/// itself indefinitely off its own polling. Without the ceiling the sliding window
/// alone would make elevation effectively permanent for anyone who keeps the page
/// open — which is exactly the tablet-on-the-table case the gate exists for.
pub const elevation_idle_s: i64 = 15 * 60;
pub const elevation_absolute_s: i64 = 60 * 60;

/// A server-generated temporary password (diceware), handed back in plaintext
/// exactly once. A value type carrying its own buffer — read it via `.slice()`.
pub const TempPassword = password.TempPassword;

/// What `createUser` returns: the new account's id plus the ONE-TIME plaintext.
pub const NewUser = struct { id: u64, temp_password: TempPassword };

pub const Session = struct {
    token: [token_len]u8,
    user_id: u64,
    /// `.pending` for a first-login (must-change-password) token, else `.controlplane`/`.device`.
    audience: Scope,
};

/// One of a user's device bindings, for the admin console's per-person device
/// list (F6). Every slice is an owned copy — free the slice via `freeDevices`.
///
/// `model`/`firmware` are nullable because `devices` rows are created by
/// `bindDevice` with only a serial: a device that has logged in but never sent
/// its `bindEquipment` details has a row with both columns NULL, and the console
/// must render that rather than invent a model name.
pub const DeviceInfo = struct {
    equipment_no: []const u8,
    name: []const u8,
    model: ?[]const u8,
    firmware: ?[]const u8,
    /// `user_devices.status = 'Y'`. Revocation is a soft flip to `'N'`, not a
    /// row delete, which is exactly what makes an unlinked device re-pairable —
    /// so a revoked binding stays in this listing rather than vanishing from it.
    active: bool,
    /// When the binding was made (epoch seconds) — the row's "since".
    created_at: i64,
    /// **"Last seen", not "last synced"** — the newest `sessions.last_used_at`
    /// across this serial's `device`-audience sessions, i.e. the last REQUEST the
    /// tablet made. That is usually a sync and is NOT the same claim, and
    /// user-options.md §7 decided the narrower word against the data rather than
    /// the wish. Maintained lazily on a 60 s granularity (see `caller`), so it is
    /// accurate to about a minute.
    ///
    /// NULL when the device holds no session row at all — a binding that has never
    /// been used since the last sweep, which must render as "never seen" rather
    /// than as the epoch. `user_devices` carries only `created_at`; nothing needed
    /// to be added to it, because `sessions.last_used_at` already carries this.
    last_seen: ?i64,
};

/// A user's storage accounting for the admin console's meter (F7). Mirrors
/// `Files.Cap`, in the units the wire uses.
pub const Quota = struct { used_bytes: i64, total_bytes: i64 };

/// A user row for admin listing (`email` is an owned copy — free via `freeUsers`).
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
    /// The 32-byte key that encrypts the md5 credential at rest (`users.cred_enc`).
    /// Loaded at boot from a 0600 key file outside the DB; see `config.cred_key_path`.
    cred_key: [password.cred_key_len]u8,
    /// Transient login challenges, keyed by account (owned copies).
    challenges: std.StringHashMapUnmanaged(Challenge) = .empty,

    const Challenge = struct { code: [code_len]u8, expires: i64 };
    const User = struct { id: u64, password_md5: [password.md5_len]u8, is_admin: bool, must_change: bool };

    pub fn init(gpa: std.mem.Allocator, io: std.Io, db: sqlite.Db, cred_key: [password.cred_key_len]u8) Service {
        return .{ .gpa = gpa, .io = io, .db = db, .cred_key = cred_key };
    }

    /// Encrypt an md5 credential for storage in `users.cred_enc` (fresh nonce).
    fn encryptCred(self: *Service, md5: []const u8) [password.cred_enc_hex_len]u8 {
        var src: std.Random.IoSource = .{ .io = self.io };
        return password.encryptCred(self.cred_key, md5, src.interface());
    }

    /// Decrypt a `users.cred_enc` blob back to the md5 credential.
    fn decryptCred(self: *Service, cred_enc_hex: []const u8) password.CredError!password.Md5Hex {
        return password.decryptCred(self.cred_key, cred_enc_hex);
    }

    pub fn deinit(self: *Service) void {
        var it = self.challenges.iterator();
        while (it.next()) |e| self.gpa.free(e.key_ptr.*);
        self.challenges.deinit(self.gpa);
    }

    /// Wall-clock epoch seconds (via the Io clock; 0.16 has no std.time.timestamp).
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

    /// A fresh temporary password, via the ONE generator (`password.generateTemp`)
    /// that first-run bootstrap also uses.
    fn tempPassword(self: *Service) TempPassword {
        var src: std.Random.IoSource = .{ .io = self.io };
        return password.generateTemp(src.interface());
    }

    // ---- users ----

    /// Creates the first-run administrator (no acting user). Takes plaintext —
    /// the only place we have it, since bootstrap generates the temp password.
    pub fn bootstrapAdmin(self: *Service, email: []const u8, plaintext: []const u8) Error!u64 {
        return self.insertUser(email, &password.md5Hex(plaintext), true);
    }

    /// Admin-only user creation. **The SERVER chooses the temporary password**,
    /// returns the plaintext exactly once, and stores only its hash.
    ///
    /// It used to take `password_md5` from the caller, which meant an admin
    /// invented a housemate's credential and knew it forever after — and left the
    /// UI nothing to "show once", because the person who typed it already had it.
    /// Inverting it is what makes "this cannot be shown again" true rather than
    /// theatrical. The account starts `must_change_password = 1`, so the temporary
    /// password unlocks nothing but its own replacement.
    pub fn createUser(self: *Service, actor_user_id: u64, email: []const u8, is_admin: bool) Error!NewUser {
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
        const temp = self.tempPassword();
        const id = try self.insertUser(email, &password.md5Hex(temp.slice()), is_admin);
        return .{ .id = id, .temp_password = temp };
    }

    /// Admin-only: deletes a user. FK `ON DELETE CASCADE` removes their sessions,
    /// device bindings, and capacity — revoking all their tokens. Refuses to
    /// remove the last remaining admin (which would lock out administration).
    ///
    /// Takes `files` because the cascade is not enough on its own: it deletes the
    /// account's `files` rows but cannot decrement the `blobs.refcount` those rows
    /// were counted in, which would strand the blobs and their note/FTS index rows.
    /// `purgeUser` runs the same decref path as an ordinary delete first, so a blob
    /// shared with another user is decremented rather than reaped.
    pub fn deleteUser(self: *Service, actor_user_id: u64, target_user_id: u64, files: filesvc.Files) Error!void {
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
        if (try self.isAdmin(target_user_id) and (try self.adminCount()) <= 1) return error.LastAdmin;
        try files.purgeUser(target_user_id);
        var s = try self.db.prepare("DELETE FROM users WHERE id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(target_user_id));
        _ = try s.step();
    }

    /// Admin-only: sets a user's password to a **server-generated** temporary one,
    /// flags must-change, and revokes their sessions — the account-recovery path.
    /// Returns the plaintext exactly once; only its hash is stored.
    ///
    /// Same inversion as `createUser`, and the same reason: an admin recovering a
    /// housemate's account has no business knowing the credential that housemate
    /// will keep using. Revoking every session also drops any elevation those
    /// sessions held, since elevation lives on the session ROW.
    pub fn resetPassword(self: *Service, actor_user_id: u64, target_user_id: u64) Error!TempPassword {
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
        const temp = self.tempPassword();
        {
            // The credential is stored ENCRYPTED (`cred_enc`); `password_md5` is
            // blanked. See §5b — md5 must stay recoverable, so it is encrypted, not hashed.
            var s = try self.db.prepare("UPDATE users SET cred_enc = ?1, password_md5 = '', must_change_password = 1 WHERE id = ?2;");
            defer s.finalize();
            s.bindText(1, &self.encryptCred(&password.md5Hex(temp.slice())));
            s.bindInt(2, @intCast(target_user_id));
            _ = try s.step();
        }
        try self.revokeAllSessions(target_user_id);
        return temp;
    }

    /// Lists all users (admin view). Caller owns the result — free via `freeUsers`.
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
    //
    // Everything below is `actor` + `target`, never "the caller's". That change of
    // subject IS the security surface of these endpoints: the caller-scoped
    // versions (`unlinkDevice`, `Files.capacity`) got their safety for free from
    // passing `caller.user_id` into the WHERE clause, and here the id comes off the
    // URL instead. So each one re-derives the ownership it needs from the TARGET
    // and refuses anything that does not belong to them.

    /// May `actor` act on `target`'s bindings? Either because they ARE `target`,
    /// or because they administer the household.
    ///
    /// **The self case is what lets the account screen exist at all.** A non-admin
    /// cannot see their own device bindings today, because the only listing is
    /// admin-only (user-options.md §5) — and the fix must NOT be a second,
    /// self-scoped copy of the query with its own idea of ownership. Two places
    /// deciding who owns a device is how they come to disagree. So the self-service
    /// routes call the SAME `listUserDevices` / `adminUnlinkDevice` with the caller
    /// as both actor and target, and this is the one gate that widens.
    ///
    /// Nothing about the admin path changes: acting on SOMEBODY ELSE still demands
    /// `is_admin` (and, at the route layer, a live elevation), and
    /// `adminUnlinkDevice`'s per-binding ownership assertion still runs afterwards
    /// — so a self-service caller naming a serial that is not theirs is refused by
    /// that check exactly as a mistaken admin is.
    fn assertMayManage(self: *Service, actor_user_id: u64, target_user_id: u64) Error!void {
        if (actor_user_id == target_user_id) return;
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
    }

    /// Every device bound to `target_user_id`, active and revoked alike, newest
    /// binding first. Caller owns the result — free via `freeDevices`.
    ///
    /// A LEFT JOIN, not an inner one: `user_devices` is the binding and `devices`
    /// is the hardware, and an inner join would silently drop a binding whose
    /// device row is missing — turning a data-integrity problem into "that tablet
    /// is not linked", which is the one thing this screen exists to answer.
    pub fn listUserDevices(self: *Service, gpa: std.mem.Allocator, actor_user_id: u64, target_user_id: u64) Error![]DeviceInfo {
        try self.assertMayManage(actor_user_id, target_user_id);
        if (!try self.userExists(target_user_id)) return error.UserNotFound;

        var list: std.ArrayList(DeviceInfo) = .empty;
        errdefer {
            for (list.items) |d| freeDevice(gpa, d);
            list.deinit(gpa);
        }
        // The `last_seen` correlated subquery is scoped by BOTH `user_id` and
        // `equipment_no`: a serial re-bound to a different housemate must not
        // report the other household member's activity as this binding's.
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

    /// Admin-only: revoke a device binding belonging to `target_user_id`.
    ///
    /// **THE OWNERSHIP CHECK IS THE POINT OF THIS FUNCTION.** `unlinkDevice` below
    /// is already scoped — its UPDATE names both `user_id` and `equipment_no`, so
    /// it physically cannot touch another account's row. What it does instead is
    /// silently match zero rows, which as a caller-scoped self-service action is
    /// fine (idempotent) but as an admin action is not: an admin who mistypes an id
    /// and unlinks "Rui's tablet" from Ana's row would get a 200 and believe it
    /// happened. So the binding is asserted to exist for THIS user first.
    ///
    /// A serial that belongs to a DIFFERENT household member is refused with the
    /// exact same `DeviceNotFound` an unknown serial gets. A distinct error would
    /// make this endpoint a cross-account probe — "does anyone else have this
    /// tablet?" — which is precisely the id confusion the check exists to stop.
    ///
    /// An ALREADY-REVOKED binding is not an error: the row exists for this user, so
    /// the unlink is a no-op and answers 200. That keeps a double-click harmless
    /// without weakening the check, since `status` is never what is being asserted.
    pub fn adminUnlinkDevice(self: *Service, actor_user_id: u64, target_user_id: u64, equipment_no: []const u8) Error!void {
        try self.assertMayManage(actor_user_id, target_user_id);
        if (!try self.hasBinding(target_user_id, equipment_no)) return error.DeviceNotFound;
        try self.unlinkDevice(target_user_id, equipment_no);
    }

    /// Whether `user_id` holds a binding for this serial, in ANY status.
    fn hasBinding(self: *Service, user_id: u64, equipment_no: []const u8) Error!bool {
        var s = try self.db.prepare("SELECT 1 FROM user_devices WHERE user_id = ?1 AND equipment_no = ?2 LIMIT 1;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, equipment_no);
        return try s.step();
    }

    /// Admin-only: a user's used/allotted bytes, for the console's meter.
    /// A user with no `capacity` row reads as the server default, exactly as
    /// `Files.capacity` does — a missing row means "nothing stored yet", and the
    /// two must not disagree about what that shows.
    pub fn userQuota(self: *Service, actor_user_id: u64, target_user_id: u64) Error!Quota {
        if (!try self.isAdmin(actor_user_id)) return error.NotAdmin;
        if (!try self.userExists(target_user_id)) return error.UserNotFound;
        var r = (try self.db.row("SELECT used_bytes, total_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(target_user_id) }})) orelse
            return .{ .used_bytes = 0, .total_bytes = default_capacity };
        defer r.finalize();
        return .{ .used_bytes = r.int(0), .total_bytes = r.int(1) };
    }

    /// Admin-only: set a user's allotment, and report the resulting quota.
    ///
    /// **LOWERING IT BELOW CURRENT USAGE IS ALLOWED AND DELETES NOTHING.** That is
    /// the intended behaviour, not an edge case to reject: the new allotment stops
    /// further syncs until the owner frees space, and their existing notes stay
    /// exactly where they are. Clamping the write up to `used_bytes` would silently
    /// refuse the one instruction an admin most wants here ("stop growing"), and
    /// enforcing it by deleting would make an accounting change destructive.
    ///
    /// The only rejection is a negative total, which is not a byte count at all.
    /// Zero is deliberately legal — it is "no new uploads", the strongest form of
    /// the same instruction.
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
        // `password_md5` (the md5 hex) is stored ENCRYPTED in `cred_enc`; the legacy
        // plaintext column is written blank so nothing recoverable lives in it.
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

    /// Fetches a single user's info by id (for the web "who am I" endpoint).
    /// Caller owns `email` — free it.
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

    // ---- the caller's own account (user-options.md §7 "Signing in") ----

    /// Everything the account screen's identity block reads about the CALLER.
    /// `email` / `name` are owned copies — free via `freeAccount`.
    pub const AccountInfo = struct {
        email: []const u8,
        name: []const u8,
        is_admin: bool,
        /// When the account was created (epoch seconds).
        created_at: i64,
        /// When the password was last changed, or NULL for "never changed".
        ///
        /// The column only became true the day it landed (schema v3), so every
        /// account that predates it reads NULL until its owner next changes their
        /// password. **The copy has to say "never changed" and not imply the
        /// account is stale** — the fact was unknowable before, not neglected.
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

    /// "This browser, since Tuesday" + "2 other browsers signed in".
    pub const SessionSummary = struct {
        /// `sessions.created_at` for the presented token, or null when the token
        /// names no row (which the router makes unreachable — it resolved the
        /// caller from that very row — but the read is written not to assume it).
        this_since: ?i64,
        /// Other LIVE `controlplane` sessions of this user, the presented one
        /// excluded. Browsers only: a bound tablet is a `device` session and is
        /// shown as a device, not as a signed-in browser.
        other_browsers: i64,
    };

    /// The two session facts, for the token the caller actually presented — which
    /// the handler passes in RAW and this hashes itself, because the raw token
    /// never touches disk and `sessions` is keyed by `sha256(token)`.
    ///
    /// "Live" applies the SAME two deadlines `caller` enforces per request: the
    /// absolute cap in `expires_at` AND the idle window measured from
    /// `last_used_at`. Counting rows that `caller` would refuse would tell a person
    /// that somebody is signed in somewhere when nobody could actually use it —
    /// the one number on this screen that would send them looking for an intruder.
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

    /// "Sign out everywhere else": drop every one of this user's sessions except
    /// the presented one. Returns how many rows went.
    ///
    /// The honest answer to "I think someone else has been in my account", and
    /// distinct from sign-out: it must NOT log the caller out of the browser they
    /// are asking from, or the confirmation of the thing they just did is a login
    /// screen. `changePassword` already revokes ALL sessions as a side effect; this
    /// is that primitive offered on its own, minus the row the caller is holding.
    ///
    /// **Device sessions go too**, and that is deliberate: a tablet whose session
    /// is dropped re-authenticates from its stored credential, so sync resumes on
    /// its own — while a session token that leaked really is revoked. The binding
    /// (`user_devices`) is untouched; unlinking is the separate, deliberate act.
    pub fn signOutOtherSessions(self: *Service, user_id: u64, token: []const u8) Error!i64 {
        const th = password.hashToken(token);
        var s = try self.db.prepare("DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, &th);
        _ = try s.step();
        return self.db.changes();
    }

    /// True if an account with this email exists (device `check/exists/server`).
    pub fn userExistsByEmail(self: *Service, email: []const u8) Error!bool {
        var s = try self.db.prepare("SELECT 1 FROM users WHERE email = ?1 LIMIT 1;");
        defer s.finalize();
        s.bindText(1, email);
        return try s.step();
    }

    /// True if any account exists — used to decide first-run admin bootstrap.
    pub fn hasAnyUser(self: *Service) Error!bool {
        var s = try self.db.prepare("SELECT 1 FROM users LIMIT 1;");
        defer s.finalize();
        return try s.step();
    }

    /// True on a BRAND-NEW server: the only account is the bootstrap admin and it
    /// still holds its temporary password (`must_change_password = 1`) — i.e. no
    /// one has finished onboarding yet. Drives the login page's first-run
    /// rendering, read pre-auth via `GET /api/controlplane/server-info`.
    ///
    /// Exactly one user AND that user is an admin still owing a password change.
    /// A second account, or the admin having changed its password, both flip this
    /// to false — onboarding is then considered done.
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
        // The credential is decrypted just-in-time here (the md5_len invariant now
        // lives on the decrypted value). A missing/corrupt blob is InvalidCredentials.
        const md5 = self.decryptCred(r.text(1)) catch return error.InvalidCredentials;
        return .{
            .id = @intCast(r.int(0)),
            .password_md5 = md5,
            .is_admin = r.int(2) != 0,
            .must_change = r.int(3) != 0,
        };
    }

    /// Guarantees a `capacity` row for the user at the given quota WITHOUT
    /// clobbering an existing one (INSERT OR IGNORE). Used at user creation and on
    /// device bind — the device must not be able to set or raise its own quota, so
    /// bind ensures the row exists at the server default but never overwrites it.
    pub fn ensureCapacity(self: *Service, user_id: u64, total: i64) Error!void {
        var s = try self.db.prepare("INSERT OR IGNORE INTO capacity(user_id, total_bytes) VALUES(?1, ?2);");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, total);
        _ = try s.step();
    }

    /// Sets a user's total quota (the device bind reports its `totalCapacity`).
    /// UPSERTS: normally the row exists from user creation, but a freshly-onboarded
    /// account may not have one yet, so we create it on conflict rather than
    /// silently no-op'ing an UPDATE (which would leave the upload quota check
    /// hitting a missing row). `used_bytes` is untouched (0 on insert).
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

    /// A user's total quota in bytes (for the device `user/query` VO). 0 if absent.
    pub fn userCapacity(self: *Service, user_id: u64) Error!i64 {
        var r = (try self.db.row("SELECT total_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return 0;
        defer r.finalize();
        return r.int(0);
    }

    // ---- login challenge + session ----

    /// Issues a single-use random code for `account` (held in memory, 5-min TTL).
    pub fn getRandomCode(self: *Service, account: []const u8) Error![code_len]u8 {
        const code = self.randomHex(code_len);
        self.dropChallenge(account);
        const key = try self.gpa.dupe(u8, account);
        errdefer self.gpa.free(key);
        try self.challenges.put(self.gpa, key, .{ .code = code, .expires = self.now() + challenge_ttl });
        return code;
    }

    fn dropChallenge(self: *Service, account: []const u8) void {
        if (self.challenges.fetchRemove(account)) |old| self.gpa.free(old.key);
    }

    /// Verifies the challenge response and issues a session. The FACE is decided by
    /// the caller (`is_device`), not inferred from `equipment_no`: the official app
    /// is a device client that logs in WITHOUT a serial (supplying it per-request),
    /// so the handler reads the client's self-declared `equipment` kind and passes
    /// the verdict here. `equipment_no` is still stored on the session when present
    /// (null for the app — unknown until its first file call).
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

        // A user who must change their password gets a limited `pending` token —
        // usable only for the change-password route — regardless of face.
        const audience: Scope = if (user.must_change) .pending else if (is_device) .device else .controlplane;
        return self.issueSession(user.id, audience, equipment_no);
    }

    fn issueSession(self: *Service, user_id: u64, audience: Scope, equipment_no: ?[]const u8) Error!Session {
        const token = self.randomHex(token_len);
        try self.createSession(&token, user_id, audience, equipment_no);
        return .{ .token = token, .user_id = user_id, .audience = audience };
    }

    /// Sets a new password (`md5_hex(new_plaintext)`, computed by the client),
    /// clears must-change, **revokes ALL of the user's sessions** (logs out every
    /// device/browser — the pending first-login token included), and returns a
    /// fresh full **control-plane** session for the caller to swap to. Rejects reusing the
    /// current password.
    pub fn changePassword(self: *Service, user_id: u64, new_md5: []const u8) Error!Session {
        if (new_md5.len != password.md5_len) return error.InvalidPassword;
        {
            var r = (try self.db.row("SELECT cred_enc FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return error.InvalidCredentials;
            defer r.finalize();
            // Same-password check against the DECRYPTED current credential.
            const cur = self.decryptCred(r.text(0)) catch return error.InvalidCredentials;
            if (std.mem.eql(u8, &cur, new_md5)) return error.SamePassword;
        }
        {
            // `password_changed_at` is stamped HERE and only here — this is the one
            // path a person's own credential changes through (the first-login
            // `pending` caller and the self-service one both land in this function).
            // `resetPassword` deliberately does NOT stamp it: an admin issuing a
            // temporary password has not chosen the credential the account will keep,
            // and the screen's "last changed" line would then be measuring somebody
            // else's action. The forced change that follows the reset stamps it.
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

    /// Deletes the given session token (logout). Keyed by `sha256(token)`, since
    /// that is what the row stores (§token-at-rest).
    pub fn logout(self: *Service, token: []const u8) Error!void {
        var s = try self.db.prepare("DELETE FROM sessions WHERE token_hash = ?1;");
        defer s.finalize();
        s.bindText(1, &password.hashToken(token));
        _ = try s.step();
    }

    /// Deletes all of a user's sessions ("log out everywhere").
    fn revokeAllSessions(self: *Service, user_id: u64) Error!void {
        var s = try self.db.prepare("DELETE FROM sessions WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        _ = try s.step();
    }

    /// Housekeeping: delete sessions past their expiry (they are already rejected;
    /// this just reclaims rows). Cheap — run at startup and occasionally.
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
        s.bindText(1, &password.hashToken(token)); // store the HASH; the raw token never touches disk
        s.bindInt(2, @intCast(user_id));
        s.bindText(3, @tagName(audience));
        if (equipment_no) |e| s.bindText(4, e) else s.bindNull(4);
        s.bindInt(5, now_ts);
        s.bindInt(6, now_ts + absoluteCap(audience)); // absolute cap; idle is enforced in `caller`
        s.bindInt(7, now_ts); // last_used_at starts at creation
        _ = try s.step();
    }

    /// Resolves a session token to a Caller, or null if unknown/expired.
    /// (equipment identity for device requests comes from the request header, so
    /// it is not populated here.)
    pub fn caller(self: *Service, token: []const u8) Error!?Caller {
        const th = password.hashToken(token); // stored key + the lazy-bump key
        const t = self.now();
        var who: Caller = undefined;
        var last_used: i64 = 0;
        {
            var r = (try self.db.row(
                "SELECT s.user_id, s.audience, s.expires_at, u.is_admin, s.elevated_at, s.elevated_until, s.last_used_at " ++
                    "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1;",
                &.{.{ .text = &th }}, // look up by the stored hash
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
            // Idle expiry (since last use), enforced here rather than by the sweeper.
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
        // Slide the idle window forward LAZILY — only when it has moved past the
        // granularity, so an ordinary request is not a write. Best-effort: a failed
        // bump must never turn a valid session into a rejected one.
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

    /// Whether an elevation is live at `t`: inside the sliding idle deadline AND
    /// inside the absolute ceiling measured from when the password was re-entered.
    /// Pure, so both the read path and the renewal path agree by construction.
    fn elevationLive(t: i64, elevated_at: ?i64, elevated_until: ?i64) bool {
        const started = elevated_at orelse return false;
        const idle_deadline = elevated_until orelse return false;
        return t < idle_deadline and t < started + elevation_absolute_s;
    }

    /// Re-authenticate an existing session to grant admin elevation, and return the
    /// idle deadline it now holds.
    ///
    /// **Reuses the login challenge flow** (`getRandomCode` + `sha256(md5(pw)+code)`)
    /// rather than accepting a plain password. This deployment is plaintext HTTP
    /// over a LAN by default, where anything replayable is exposed on the wire —
    /// a "just POST the password" endpoint would be a real regression, and a second
    /// credential path to keep correct forever after.
    ///
    /// Every rejection is `InvalidCredentials`, including "you are not an admin"
    /// and "you still owe a password change": a non-admin probing this must not be
    /// able to tell a wrong password from a right one, or the endpoint becomes an
    /// oracle for who in the household is an administrator.
    ///
    /// A `must_change_password` account is refused outright — that flag exists to
    /// force a password change, and elevation must not route around it. (The route
    /// also omits `.pending` from its scopes, so such a session is turned away
    /// before it ever reaches here; this is the belt to that suspenders.)
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

    /// Drop this session's elevation immediately ("Lock console"). Idempotent, and
    /// deliberately the whole of revocation — clearing the two columns is all there
    /// is to undo, which is the payoff for elevation being a session capability
    /// rather than a second token with its own lifetime to chase.
    pub fn lockElevation(self: *Service, token: []const u8) Error!void {
        var s = try self.db.prepare("UPDATE sessions SET elevated_at = NULL, elevated_until = NULL WHERE token_hash = ?1;");
        defer s.finalize();
        s.bindText(1, &password.hashToken(token));
        _ = try s.step();
    }

    /// Slide a LIVE elevation's idle deadline forward on admin activity, clamped to
    /// the absolute ceiling. Returns the new deadline, or null if there was no live
    /// elevation to renew.
    ///
    /// It can only ever extend an elevation that is already live: a NULL, a lapsed
    /// or a ceiling-exceeded one is left exactly as it was. That is what lets the
    /// caller (transport) renew unconditionally on every admin request without
    /// having to decide first whether the request will be authorized — renewal can
    /// never grant elevation, only prolong one.
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

    /// Registers a device and binds it to the user (idempotent). Called after a
    /// successful device login (auto-bind).
    pub fn bindDevice(self: *Service, user_id: u64, equipment_no: []const u8, name: []const u8) Error!void {
        {
            var s = try self.db.prepare("INSERT OR IGNORE INTO devices(equipment_no, created_at) VALUES(?1, ?2);");
            defer s.finalize();
            s.bindText(1, equipment_no);
            s.bindInt(2, self.now());
            _ = try s.step();
        }
        {
            // AN UPSERT THAT REACTIVATES, not `INSERT OR IGNORE`.
            //
            // `unlinkDevice` marks the binding `status = 'N'` and KEEPS the row,
            // so `INSERT OR IGNORE` found it already there and did nothing —
            // which made unlinking a ONE-WAY DOOR. Pairing the same tablet to the
            // same account again could never bring it back: the device logged in
            // and got a live session, while its binding stayed revoked for ever.
            // The webapp then showed no device for a Supernote that was sitting
            // there syncing, and there was no way, from either side, to fix it.
            //
            // An ordinary re-bind of an ALREADY-ACTIVE device still changes
            // nothing, exactly as before — this path runs on every device login,
            // so it must not churn the name or the date. Only a REVOKED row is
            // touched, and then it is treated as the fresh binding it is: active
            // again, and re-dated, because the previous binding ended when it was
            // unlinked and `created_at` is what the screen calls "Linked".
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

    /// The user id behind a LIVE device session for `equipment_no`, but ONLY when
    /// that session belongs to the account named by `email`.
    ///
    /// **Why this exists — `bindEquipment` arrives unauthenticated.** Captured
    /// from a real Nomad (docs/scratch/nomad-login.log): login returns a token at
    /// t+0ms, the device fires `bindEquipment` at t+9ms, and only STORES the token
    /// at t+15ms. So the one call that carries the device's name, model and
    /// firmware goes out with no `x-access-token` header, we answered 401, and the
    /// tablet kept the placeholder name for ever while syncing perfectly.
    ///
    /// This is the token's evidence obtained from state we already hold: somebody
    /// completed a login on THIS serial, for THIS account, seconds ago, and the
    /// session proving it is in the table. It is deliberately not the same as
    /// trusting the body — a serial with no live session, or one whose session
    /// belongs to a different account, still gets nothing. So it cannot be used to
    /// bind a serial to an account you could not already log into, which is the
    /// whole risk of accepting an unauthenticated bind.
    ///
    /// Device sessions have no idle window (see `idleWindow`), so the absolute
    /// `expires_at` is the only clock that matters here.
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

    /// Adopts the name the DEVICE reports for itself ("Supernote Nomad AA").
    ///
    /// Separate from `bindDevice` because the two callers know different things.
    /// The file-call path binds a serial it has only just seen and has no name
    /// for, so it stamps a placeholder; `bindEquipment` is the device introducing
    /// itself and its name is the authoritative one. `bindDevice` deliberately
    /// does not overwrite an existing label — it runs on every login, and a
    /// placeholder must never overwrite a real name — so the authoritative name
    /// needs its own door, or it never lands: the row already exists by then and
    /// every account showed the literal "Supernote app" for a tablet that had
    /// told the server exactly what it was called.
    ///
    /// Only ever called with a name the device actually sent, never with a
    /// fallback, so this cannot overwrite a good label with a generic one.
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

    /// Best-effort device unlink by serial across all users: marks every binding
    /// of this serial inactive and drops its sessions. A no-op if the serial is
    /// unknown.
    ///
    /// NOTE: this is deliberately NOT wired to the public pre-login
    /// `equipment/unlink` route — doing so was an unauthenticated LAN DoS (any
    /// client could unbind + log out the household device by its printed serial).
    /// Retained for an authenticated/admin-scoped teardown path and its own test.
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

    /// True if this device is actively bound to the user (login reports this so
    /// the device knows whether it still needs to bind).
    pub fn isDeviceBound(self: *Service, user_id: u64, equipment_no: []const u8) Error!bool {
        var s = try self.db.prepare(
            "SELECT 1 FROM user_devices WHERE user_id = ?1 AND equipment_no = ?2 AND status = 'Y' LIMIT 1;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, equipment_no);
        return try s.step();
    }

    /// Count of active devices bound to a user.
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

/// A fixed, obviously-fake credential-encryption key for tests. Production loads a
/// real random key from `config.cred_key_path`.
const test_cred_key: [password.cred_key_len]u8 = @splat(0xA5);

/// The storage half `deleteUser` needs: a blob store on a temp dir plus the
/// `Files` service over it. Account deletion releases blob references, so these
/// tests can't hand it a stub.
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

/// Client-side: what a device/browser computes for the login password field.
fn clientHash(plaintext: []const u8, code: [code_len]u8) [password.sha256_len]u8 {
    return password.challengeHash(&password.md5Hex(plaintext), &code);
}

/// Admin-creates a user and completes the mandatory first-login change, leaving
/// the account "onboarded" with `final_pw`. Returns the user id.
///
/// It logs in with the temporary password the SERVER generated (there is no
/// caller-chosen one any more), which is also the only handover path a real
/// household user has.
fn onboardUser(svc: *Service, admin: u64, email: []const u8, final_pw: []const u8) !u64 {
    const created = try svc.createUser(admin, email, false);
    const code = try svc.getRandomCode(email);
    _ = try svc.login(email, &clientHash(created.temp_password.slice(), code), false, null); // pending token
    _ = try svc.changePassword(created.id, &password.md5Hex(final_pw));
    return created.id;
}

test "admin logs in (must change first) and creates a user" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();

    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");

    // First admin login yields a limited `pending` token.
    const code = try svc.getRandomCode("admin@home");
    const first = try svc.login("admin@home", &clientHash("adminpw", code), false, null);
    try std.testing.expectEqual(Scope.pending, first.audience);

    // Changing the password revokes it and returns a full web session.
    const full = try svc.changePassword(admin, &password.md5Hex("adminnew"));
    try std.testing.expectEqual(Scope.controlplane, full.audience);
    try std.testing.expect((try svc.caller(&first.token)) == null);

    // Admin creates a household user; a non-admin cannot.
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

    // Wrong password is rejected.
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

    // Auto-bind on device login (idempotent).
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

    // First login → limited `pending` token (both session and resolved caller).
    const code = try svc.getRandomCode("alice@home");
    const pending = try svc.login("alice@home", &clientHash(temp.slice(), code), false, null);
    try std.testing.expectEqual(Scope.pending, pending.audience);
    try std.testing.expectEqual(Scope.pending, (try svc.caller(&pending.token)).?.audience);

    // Reusing the current password is rejected.
    try std.testing.expectError(error.SamePassword, svc.changePassword(alice, &password.md5Hex(temp.slice())));

    // Change revokes the pending token and returns a full web session.
    const upgraded = try svc.changePassword(alice, &password.md5Hex("brandnew"));
    try std.testing.expectEqual(Scope.controlplane, upgraded.audience);
    try std.testing.expect((try svc.caller(&pending.token)) == null); // limited token dead
    try std.testing.expectEqual(Scope.controlplane, (try svc.caller(&upgraded.token)).?.audience);

    // Subsequent logins are full; the old password no longer works.
    {
        const c = try svc.getRandomCode("alice@home");
        try std.testing.expectEqual(Scope.controlplane, (try svc.login("alice@home", &clientHash("brandnew", c), false, null)).audience);
    }
    {
        const c = try svc.getRandomCode("alice@home");
        try std.testing.expectError(error.InvalidCredentials, svc.login("alice@home", &clientHash(temp.slice(), c), false, null));
    }
}

/// Logs `email` in as a web client and returns the session.
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

    // Two live sessions: a browser and a device.
    const web = try webLogin(&svc, "alice@home", "alicepw");
    const equipment_no = "SN2026NOMAD0001";
    const dev = blk: {
        const code = try svc.getRandomCode("alice@home");
        break :blk try svc.login("alice@home", &clientHash("alicepw", code), true, equipment_no);
    };
    try svc.bindDevice(dev.user_id, equipment_no, "Alice's Nomad");
    try std.testing.expect((try svc.caller(&web.token)) != null);
    try std.testing.expect((try svc.caller(&dev.token)) != null);

    // A voluntary password change logs out everywhere and hands back a fresh session.
    const fresh = try svc.changePassword(alice, &password.md5Hex("rotated!"));
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
    // `unlinkDevice` KEEPS the row and flips it to 'N', and `bindDevice` was
    // `INSERT OR IGNORE` — so the row already being there made every later
    // pairing a silent no-op. The tablet signed in, got a live device session,
    // and its binding stayed revoked for ever: the account screen showed no
    // device for a Supernote that was sitting there syncing, and there was no
    // way to undo it from the webapp OR from the device.
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

    // Signing back in on the tablet runs exactly this — and it must bring the
    // binding back rather than leave a live session attached to a revoked one.
    try svc.bindDevice(alice, equipment_no, "Alice's Nomad");
    try std.testing.expectEqual(@as(i64, 1), try svc.deviceCount(alice));

    const devs = try svc.listUserDevices(std.testing.allocator, alice, alice);
    defer Service.freeDevices(std.testing.allocator, devs);
    try std.testing.expectEqual(@as(usize, 1), devs.len); // ONE binding, not a duplicate
    try std.testing.expect(devs[0].active);
}

test "re-binding an ACTIVE device changes nothing — this path runs on every login" {
    // The other half of the upsert. `bindDevice` runs on every device login, so
    // a version that always wrote would reset the date on each sync — the screen
    // would read "linked seconds ago" for a tablet paired last year.
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
    // `resolveEquipment` binds a serial it has only just seen on the first file
    // call, with the literal "Supernote app" — it has no name yet. `bindEquipment`
    // is the device introducing itself, and by then the row already exists, so
    // `bindDevice` (which never overwrites a label, because it runs on every
    // login) left the placeholder in place for ever. The account screen showed
    // "Supernote app" for a tablet that had reported "Supernote Nomad AA".
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
    // The handler only calls this with a name the device actually sent, but the
    // guard is here too: a device that reports "" must not erase a good label and
    // leave a nameless row the screen has to fall back to the serial for.
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

    // A non-admin cannot delete anyone.
    try std.testing.expectError(error.NotAdmin, svc.deleteUser(alice, admin, storage.files));

    try svc.deleteUser(admin, alice, storage.files);
    try std.testing.expect((try svc.caller(&sess.token)) == null); // cascade revoked the session
    // The account is gone: a login attempt fails on credential lookup.
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

    // Plant an already-expired session row (expires_at in the past).
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

    // A broken RNG makes token-at-rest and everything else moot. A seeded userspace
    // PRNG (fixed seed) would make two INDEPENDENTLY constructed services draw the
    // SAME first token; the OS CSPRNG (getrandom, via std.Random.IoSource) does not.
    const a = svc1.randomHex(token_len);
    const b = svc2.randomHex(token_len);
    try std.testing.expect(!std.mem.eql(u8, &a, &b));

    // And successive draws within one service differ — not a stuck / all-zero source
    // — and are lowercase hex spanning more than one symbol.
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

    // Re-issuing supersedes the prior code (single-use) with a fresh one.
    const code2 = try svc.getRandomCode("someone@home");
    try std.testing.expect(!std.mem.eql(u8, &code, &code2));
}

test "a session token authenticates, but the DB stores only its sha256 hash" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const alice = try onboardUser(&svc, admin, "alice@home", "alicepw");

    const sess = try webLogin(&svc, "alice@home", "alicepw");
    // The RAW token resolves to the caller...
    try std.testing.expectEqual(alice, (try svc.caller(&sess.token)).?.user_id);

    // ...yet the stored key is sha256(token): a row exists under the hash, and NONE
    // under the raw token — so a stolen DB backup hands over no usable tokens.
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

    // Logout (keyed by the hash) still drops it.
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

    // A live web session and a live device session.
    const web = try webLogin(&svc, "alice@home", "alicepw");
    const equipment_no = "SN2026NOMAD0001";
    const dev = blk: {
        const code = try svc.getRandomCode("alice@home");
        break :blk try svc.login("alice@home", &clientHash("alicepw", code), true, equipment_no);
    };
    try std.testing.expect((try svc.caller(&web.token)) != null);
    try std.testing.expect((try svc.caller(&dev.token)) != null);

    // Wind BOTH sessions' last use back past the control-plane idle window (the
    // absolute cap stays far in the future). The web session lapses on IDLE; the
    // device session has no idle window and survives — it ages out only on unlink
    // or the ~2-year cap.
    const t = nowSeconds();
    try setLastUsed(&db, &web.token, t - controlplane_idle_s - 10);
    try setLastUsed(&db, &dev.token, t - controlplane_idle_s - 10);
    try std.testing.expect((try svc.caller(&web.token)) == null); // idle-expired
    try std.testing.expect((try svc.caller(&dev.token)) != null); // device: no idle expiry

    // A pending (first-login) session is absolute-only: past its 15-minute cap it
    // is gone, with no idle window in play.
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

    // Existence probe.
    try std.testing.expect(try svc.userExistsByEmail("alice@home"));
    try std.testing.expect(!try svc.userExistsByEmail("nobody@home"));

    // Capacity defaults to the household quota; can be overridden (device bind).
    try std.testing.expectEqual(default_capacity, try svc.userCapacity(alice));
    try svc.setCapacityTotal(alice, 25485312 * 1024);
    try std.testing.expectEqual(@as(i64, 25485312 * 1024), try svc.userCapacity(alice));

    // A device session, then a pre-login global unlink (no user context) kills it.
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

/// Counts session rows by their STORED key (`token_hash`). Callers pass the value
/// the row holds: a planted literal, or `password.hashToken(raw)` for a real token.
fn sessionRowCount(db: *sqlite.Db, token_hash: []const u8) i64 {
    var r = (db.row("SELECT COUNT(*) FROM sessions WHERE token_hash = ?1;", &.{.{ .text = token_hash }}) catch return -1) orelse return -1;
    defer r.finalize();
    return r.int(0);
}

/// Overwrites a session's `last_used_at` (keyed by the RAW token's hash) so a test
/// can place the idle window anywhere without waiting out the 14-day clock.
fn setLastUsed(db: *sqlite.Db, token: []const u8, v: i64) !void {
    var s = try db.prepare("UPDATE sessions SET last_used_at = ?1 WHERE token_hash = ?2;");
    defer s.finalize();
    s.bindInt(1, v);
    s.bindText(2, &password.hashToken(token));
    _ = try s.step();
}

/// Overwrites a session's `expires_at` (keyed by the RAW token's hash) — the only
/// knob that matters for an absolute-only scope like `pending`.
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

    // The last remaining admin cannot be deleted (would lock out administration).
    var storage = try TestStorage.init(db);
    defer storage.deinit();
    try std.testing.expectError(error.LastAdmin, svc.deleteUser(admin, admin, storage.files));

    // Reset logs the target out everywhere and re-flags must-change.
    const sess = try svc.changePassword(bob, &password.md5Hex("bobreal0")); // clears must_change, mints a session
    try std.testing.expect((try svc.caller(&sess.token)) != null);
    const temp = try svc.resetPassword(admin, bob);
    try std.testing.expect((try svc.caller(&sess.token)) == null); // revoked by reset

    const users = try svc.listUsers(std.testing.allocator);
    defer Service.freeUsers(std.testing.allocator, users);
    for (users) |u| {
        if (std.mem.eql(u8, u.email, "bob@home")) try std.testing.expect(u.must_change);
    }

    // The reset password is the SERVER's, handed back once: it works, the old one
    // does not, and nothing stored can reproduce the plaintext.
    {
        const c = try svc.getRandomCode("bob@home");
        try std.testing.expectEqual(Scope.pending, (try svc.login("bob@home", &clientHash(temp.slice(), c), false, null)).audience);
    }
    {
        const c = try svc.getRandomCode("bob@home");
        try std.testing.expectError(error.InvalidCredentials, svc.login("bob@home", &clientHash("bobreal0", c), false, null));
    }
}

test "the server, not the admin, chooses temporary passwords — and stores only their hash" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    var svc = try testService(db);
    defer svc.deinit();
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");

    const bob = try svc.createUser(admin, "bob@home", false);
    const carol = try svc.createUser(admin, "carol@home", false);

    // Generated, not chosen: two accounts made in a row do not share a password.
    try std.testing.expect(bob.temp_password.len > 0 and bob.temp_password.len <= password.max_temp_len);
    try std.testing.expect(!std.mem.eql(u8, bob.temp_password.slice(), carol.temp_password.slice()));

    // Nothing recoverable is stored: the legacy `password_md5` column is blanked,
    // and the credential lives ENCRYPTED in `cred_enc` — which holds neither the
    // temp password nor even its bare md5, only a ciphertext that decrypts (with the
    // server key) back to md5(temp). So "it cannot be shown again" is a fact about
    // the database, and a stolen backup yields nothing usable either.
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

    // And the account owes a password change, so that secret unlocks nothing else.
    const info = (try svc.userInfo(std.testing.allocator, bob.id)).?;
    defer std.testing.allocator.free(info.email);
    try std.testing.expect(info.must_change);

    // A non-admin still cannot create or reset.
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
    // Model/firmware are set by the device's own bind call, not by ours.
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
                // A device that never sent its details has NULL model/firmware, and
                // the console must be able to render that rather than be handed "".
                try std.testing.expect(d.model == null);
                try std.testing.expect(d.firmware == null);
            }
        }
    }

    // Unlinking is a soft status flip, so the binding STAYS in the listing —
    // that is what makes it re-pairable, and hiding it would misreport the tablet
    // as never having been linked.
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
    // Bob's tablet, and a live device session on it, so a stray unlink would be
    // visible twice over: as a status flip AND as his tablet being logged out.
    const bob_session = blk: {
        const code = try svc.getRandomCode("bob@home");
        break :blk try svc.login("bob@home", &clientHash("bobpw123", code), true, "SN-BOB-1");
    };
    try svc.bindDevice(bob, "SN-BOB-1", "Bob's Manta");

    // THE CASE: an elevated admin names Alice's user id and Bob's serial. The
    // caller-scoped `unlinkDevice` would have matched zero rows and reported
    // success, leaving the admin believing Bob's tablet was cut off.
    try std.testing.expectError(error.DeviceNotFound, svc.adminUnlinkDevice(admin, alice, "SN-BOB-1"));
    try std.testing.expectEqual(@as(i64, 1), try svc.deviceCount(bob)); // still bound
    try std.testing.expect((try svc.caller(&bob_session.token)) != null); // still signed in

    // A serial NOBODY has is refused identically — the two must be
    // indistinguishable, or this endpoint becomes a cross-account probe.
    try std.testing.expectError(error.DeviceNotFound, svc.adminUnlinkDevice(admin, alice, "SN-NOBODY"));

    // And the same for reading: listing is scoped to the named user, never merged.
    {
        const devices = try svc.listUserDevices(std.testing.allocator, admin, alice);
        defer Service.freeDevices(std.testing.allocator, devices);
        try std.testing.expectEqual(@as(usize, 1), devices.len);
        try std.testing.expectEqualStrings("SN-ALICE-1", devices[0].equipment_no);
    }

    // The correct pairing works, and takes the tablet's sessions with it.
    try svc.adminUnlinkDevice(admin, bob, "SN-BOB-1");
    try std.testing.expectEqual(@as(i64, 0), try svc.deviceCount(bob));
    try std.testing.expect((try svc.caller(&bob_session.token)) == null);

    // Idempotent on an already-revoked binding: the row still belongs to Bob, so
    // this is a no-op rather than a 404 — a double-click must not read as an error.
    try svc.adminUnlinkDevice(admin, bob, "SN-BOB-1");

    // A NON-admin reaches their OWN row through these same two calls, and nothing
    // else. That is the self-service half of the account screen: until it existed,
    // a household member could not see their own bindings at all (user-options.md
    // §5), and the fix must not be a second self-scoped copy of the query with its
    // own idea of ownership — so the SAME functions widen by exactly one case.
    // Alice is not an admin.
    {
        const mine = try svc.listUserDevices(std.testing.allocator, alice, alice);
        defer Service.freeDevices(std.testing.allocator, mine);
        try std.testing.expectEqual(@as(usize, 1), mine.len);
        try std.testing.expectEqualStrings("SN-ALICE-1", mine[0].equipment_no);
    }
    // Bob's row stays out of reach in BOTH directions — reading and acting.
    try std.testing.expectError(error.NotAdmin, svc.listUserDevices(std.testing.allocator, alice, bob));
    try std.testing.expectError(error.NotAdmin, svc.adminUnlinkDevice(alice, bob, "SN-BOB-1"));
    // And naming her OWN id with somebody else's serial is refused by the same
    // per-binding ownership check an admin hits, with the same `DeviceNotFound` an
    // unknown serial gets — so self-service is no cross-account probe either.
    try std.testing.expectError(error.DeviceNotFound, svc.adminUnlinkDevice(alice, alice, "SN-BOB-1"));
    try std.testing.expectError(error.DeviceNotFound, svc.adminUnlinkDevice(alice, alice, "SN-NOBODY"));
    // Her own binding, she may revoke.
    try svc.adminUnlinkDevice(alice, alice, "SN-ALICE-1");
    try std.testing.expectEqual(@as(i64, 0), try svc.deviceCount(alice));

    // An unknown TARGET is a plain not-found — an admin may learn an id is unused.
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

    // A fresh account reads the household default with nothing used.
    {
        const q = try svc.userQuota(admin, alice);
        try std.testing.expectEqual(@as(i64, 0), q.used_bytes);
        try std.testing.expectEqual(default_capacity, q.total_bytes);
    }

    // Plant real usage, as a sync would.
    try db.exec("UPDATE capacity SET used_bytes = 5000 WHERE user_id = (SELECT id FROM users WHERE email = 'alice@home');");

    // Raising the allotment is unremarkable.
    {
        const q = try svc.setUserQuota(admin, alice, 1_000_000);
        try std.testing.expectEqual(@as(i64, 5000), q.used_bytes);
        try std.testing.expectEqual(@as(i64, 1_000_000), q.total_bytes);
    }

    // THE POINT OF THE ITEM: an allotment BELOW current usage is accepted, is
    // stored verbatim (not clamped up to `used_bytes`), and destroys nothing. It
    // means "stop growing", and the meter has to be able to draw used > total.
    {
        const q = try svc.setUserQuota(admin, alice, 100);
        try std.testing.expectEqual(@as(i64, 100), q.total_bytes); // NOT clamped to 5000
        try std.testing.expectEqual(@as(i64, 5000), q.used_bytes); // usage untouched
        try std.testing.expect(q.used_bytes > q.total_bytes);
    }
    // Nothing was deleted to make the numbers agree.
    {
        var s = try db.prepare("SELECT used_bytes FROM capacity WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        try std.testing.expect(try s.step());
        try std.testing.expectEqual(@as(i64, 5000), s.columnInt(0));
    }

    // Zero is legal — the strongest form of the same instruction.
    try std.testing.expectEqual(@as(i64, 0), (try svc.setUserQuota(admin, alice, 0)).total_bytes);
    // A negative total is not a byte count, and a rejected write changes nothing.
    try std.testing.expectError(error.InvalidQuota, svc.setUserQuota(admin, alice, -1));
    try std.testing.expectEqual(@as(i64, 0), (try svc.userQuota(admin, alice)).total_bytes);

    // Authorization: non-admins are refused both ways, including on themselves —
    // a quota is an allotment, not a self-service setting.
    try std.testing.expectError(error.NotAdmin, svc.userQuota(alice, alice));
    try std.testing.expectError(error.NotAdmin, svc.setUserQuota(alice, alice, 1 << 40));
    try std.testing.expectError(error.UserNotFound, svc.userQuota(admin, 9999));
    try std.testing.expectError(error.UserNotFound, svc.setUserQuota(admin, 9999, 1));
}

// ---- admin elevation ----

/// Overwrites a session's elevation columns directly, so a test can place the
/// window anywhere relative to now without waiting out a 15-minute clock. The
/// production path only ever writes `now`-relative values; this is the only way
/// to exercise the boundaries themselves.
fn plantElevation(db: *sqlite.Db, token: []const u8, at: ?i64, until: ?i64) !void {
    var s = try db.prepare("UPDATE sessions SET elevated_at = ?1, elevated_until = ?2 WHERE token_hash = ?3;");
    defer s.finalize();
    s.bindIntOpt(1, at);
    s.bindIntOpt(2, until);
    s.bindText(3, &password.hashToken(token)); // callers pass the RAW token; the row is keyed by its hash
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
    _ = try svc.changePassword(admin, &password.md5Hex("adminnew")); // clear must_change

    // A fresh session is NOT elevated. Signing in is not proving you are at the
    // keyboard right now, which is the whole premise of the gate.
    const sess = try webLogin(&svc, "admin@home", "adminnew");
    try std.testing.expect(!(try svc.caller(&sess.token)).?.elevated);

    // Elevation requires a challenge code, exactly like login — there is no
    // second, replayable credential path.
    try std.testing.expectError(
        error.NoChallenge,
        svc.elevate(admin, &sess.token, &clientHash("adminnew", "abcdef0123456789".*)),
    );

    // Wrong password with a valid code: refused, and the session stays un-elevated.
    {
        const code = try svc.getRandomCode("admin@home");
        try std.testing.expectError(error.InvalidCredentials, svc.elevate(admin, &sess.token, &clientHash("wrongpw", code)));
        try std.testing.expect(!(try svc.caller(&sess.token)).?.elevated);
    }

    // Right password: elevated, with a deadline one idle window out.
    const before = nowSeconds();
    const code = try svc.getRandomCode("admin@home");
    const until = try svc.elevate(admin, &sess.token, &clientHash("adminnew", code));
    try std.testing.expect(until >= before + elevation_idle_s);
    try std.testing.expect((try svc.caller(&sess.token)).?.elevated);

    // The challenge was single-use: replaying the very same response fails.
    try std.testing.expectError(error.NoChallenge, svc.elevate(admin, &sess.token, &clientHash("adminnew", code)));

    // Elevation is per SESSION, not per user: a second browser is still outside.
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

    // Alice's password is CORRECT here. She is simply not an administrator, and
    // the error she gets must be the same one a wrong password produces — a
    // distinct "not an admin" would turn this endpoint into an oracle for who in
    // the household can administer the server.
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

    // The bootstrap admin before the mandatory first change: an ADMIN, with the
    // right password, holding a `pending` session.
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw");
    const pending = blk: {
        const code = try svc.getRandomCode("admin@home");
        break :blk try svc.login("admin@home", &clientHash("adminpw", code), false, null);
    };
    try std.testing.expectEqual(Scope.pending, pending.audience);

    // `must_change_password` exists to force a password change; elevation must not
    // be a way around it.
    const code = try svc.getRandomCode("admin@home");
    try std.testing.expectError(error.InvalidCredentials, svc.elevate(admin, &pending.token, &clientHash("adminpw", code)));
    try std.testing.expect(!(try svc.caller(&pending.token)).?.elevated);

    // After the change, the fresh session can elevate normally.
    const full = try svc.changePassword(admin, &password.md5Hex("adminnew"));
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
    _ = try svc.changePassword(admin, &password.md5Hex("adminnew"));
    const sess = try webLogin(&svc, "admin@home", "adminnew");
    const tok = &sess.token;

    // Elevated a while ago, well inside both bounds: activity slides the idle
    // deadline forward by a full window.
    {
        const t = nowSeconds();
        try plantElevation(&db, tok, t - 60, t + 60);
        const renewed = (try svc.renewElevation(tok)).?;
        try std.testing.expect(renewed >= t + elevation_idle_s - 5);
        try std.testing.expect((try svc.caller(tok)).?.elevated);
    }

    // Near the CEILING: the slide is clamped to `elevated_at + absolute`, not
    // `now + idle`. Without this clamp a console polling in a background tab would
    // renew itself forever and elevation would never actually end.
    {
        const t = nowSeconds();
        const started = t - (elevation_absolute_s - 120); // 2 min of ceiling left
        try plantElevation(&db, tok, started, t + 300);
        const renewed = (try svc.renewElevation(tok)).?;
        try std.testing.expectEqual(started + elevation_absolute_s, renewed);
        try std.testing.expect(renewed < t + elevation_idle_s); // clamped, not a full window
    }

    // PAST the ceiling, with the idle deadline still in the future: not elevated,
    // and activity cannot resurrect it. This is the case a single stored timestamp
    // could not have expressed.
    {
        const t = nowSeconds();
        try plantElevation(&db, tok, t - elevation_absolute_s - 60, t + 600);
        try std.testing.expect(!(try svc.caller(tok)).?.elevated);
        try std.testing.expect((try svc.renewElevation(tok)) == null);
    }

    // IDLE lapsed, ceiling still fine: also not elevated, also not renewable.
    {
        const t = nowSeconds();
        try plantElevation(&db, tok, t - 120, t - 1);
        try std.testing.expect(!(try svc.caller(tok)).?.elevated);
        try std.testing.expect((try svc.renewElevation(tok)) == null);
    }

    // A never-elevated session is not renewable either — renewal extends, it never
    // grants, which is what makes it safe to call before authorization.
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
    _ = try svc.changePassword(admin, &password.md5Hex("adminnew"));

    // A second admin, so the reset below is not the last-admin case.
    const other = try svc.createUser(admin, "other@home", true);
    _ = try svc.changePassword(other.id, &password.md5Hex("otherpw1"));

    const sess = try webLogin(&svc, "admin@home", "adminnew");
    {
        const code = try svc.getRandomCode("admin@home");
        _ = try svc.elevate(admin, &sess.token, &clientHash("adminnew", code));
    }
    try std.testing.expect((try svc.caller(&sess.token)).?.elevated);

    // Lock takes effect on the very next resolve — no cached capability outlives it.
    try svc.lockElevation(&sess.token);
    try std.testing.expect(!(try svc.caller(&sess.token)).?.elevated);
    try svc.lockElevation(&sess.token); // idempotent
    try std.testing.expect((try svc.caller(&sess.token)) != null); // the SESSION survives; only elevation went

    // Re-elevate, then have the other admin reset this account's password.
    {
        const code = try svc.getRandomCode("admin@home");
        _ = try svc.elevate(admin, &sess.token, &clientHash("adminnew", code));
    }
    try std.testing.expect((try svc.caller(&sess.token)).?.elevated);

    _ = try svc.resetPassword(other.id, admin);

    // The session row is gone, so the elevation on it is gone with it — this is
    // the payoff for elevation being a column on `sessions` rather than a second
    // token with a lifetime of its own to remember to revoke.
    try std.testing.expect((try svc.caller(&sess.token)) == null);
    try std.testing.expectEqual(@as(i64, 0), sessionRowCount(&db, &password.hashToken(&sess.token)));
}
