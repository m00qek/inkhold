//! An admin acting on one person: their devices, quota and existence checks.

const std = @import("std");
const internal = @import("internal.zig");
const authsvc = @import("../service.zig");
const Service = authsvc.Service;
const Error = authsvc.Error;
const default_capacity = authsvc.default_capacity;
const DeviceInfo = authsvc.DeviceInfo;
const Quota = authsvc.Quota;
const UserInfo = authsvc.UserInfo;
const device_ops = @import("device_ops.zig");
const own_account = @import("own_account.zig");

/// Self, or an admin. Self-service routes reuse these admin functions with
/// actor = target so ownership is decided in one place.
fn assertMayManage(self: *Service, actor_user_id: u64, target_user_id: u64) Error!void {
    if (actor_user_id == target_user_id) return;
    if (!try own_account.isAdmin(self, actor_user_id)) return error.NotAdmin;
}

/// Newest binding first, revoked included; free via `freeDevices`. LEFT JOIN so
/// a binding with a missing device row still shows.
pub fn listUserDevices(self: *Service, gpa: std.mem.Allocator, actor_user_id: u64, target_user_id: u64) Error![]DeviceInfo {
    try assertMayManage(self, actor_user_id, target_user_id);
    if (!try userExists(self, target_user_id)) return error.UserNotFound;

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
    try assertMayManage(self, actor_user_id, target_user_id);
    if (!try hasBinding(self, target_user_id, equipment_no)) return error.DeviceNotFound;
    try device_ops.unlinkDevice(self, target_user_id, equipment_no);
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
    if (!try own_account.isAdmin(self, actor_user_id)) return error.NotAdmin;
    if (!try userExists(self, target_user_id)) return error.UserNotFound;
    var r = (try self.db.row("SELECT used_bytes, total_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(target_user_id) }})) orelse
        return .{ .used_bytes = 0, .total_bytes = default_capacity };
    defer r.finalize();
    return .{ .used_bytes = r.int(0), .total_bytes = r.int(1) };
}

/// Admin-only. Below current usage is allowed and deletes nothing (it just stops
/// further syncs); zero means "no new uploads".
pub fn setUserQuota(self: *Service, actor_user_id: u64, target_user_id: u64, total_bytes: i64) Error!Quota {
    if (!try own_account.isAdmin(self, actor_user_id)) return error.NotAdmin;
    if (!try userExists(self, target_user_id)) return error.UserNotFound;
    if (total_bytes < 0) return error.InvalidQuota;
    try own_account.setCapacityTotal(self, target_user_id, total_bytes);
    return userQuota(self, actor_user_id, target_user_id);
}

pub fn userExists(self: *Service, user_id: u64) Error!bool {
    var s = try self.db.prepare("SELECT 1 FROM users WHERE id = ?1 LIMIT 1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    return try s.step();
}

pub fn adminCount(self: *Service) Error!i64 {
    var s = try self.db.prepare("SELECT COUNT(*) FROM users WHERE is_admin = 1;");
    defer s.finalize();
    _ = try s.step();
    return s.columnInt(0);
}

pub fn insertUser(self: *Service, email: []const u8, password_md5: []const u8, is_admin: bool) Error!u64 {
    // The md5 goes encrypted into `cred_enc`; the legacy column stays blank.
    var s = try self.db.prepare("INSERT INTO users(email, password_md5, cred_enc, is_admin, created_at) VALUES(?1,'',?2,?3,?4);");
    defer s.finalize();
    s.bindText(1, email);
    s.bindText(2, &internal.encryptCred(self, password_md5));
    s.bindInt(3, if (is_admin) 1 else 0);
    s.bindInt(4, internal.now(
        self,
    ));
    _ = s.step() catch return error.EmailExists; // UNIQUE(email) violation
    const id: u64 = @intCast(self.db.lastInsertRowId());
    try own_account.ensureCapacity(self, id, default_capacity);
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
