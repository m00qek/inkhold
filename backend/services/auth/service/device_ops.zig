//! Device bindings: bind, name, unlink and lookups.

const std = @import("std");
const internal = @import("internal.zig");
const authsvc = @import("../service.zig");
const Service = authsvc.Service;
const Error = authsvc.Error;

/// Registers the device and binds it (after device login).
pub fn bindDevice(self: *Service, user_id: u64, equipment_no: []const u8, name: []const u8) Error!void {
    {
        var s = try self.db.prepare("INSERT OR IGNORE INTO devices(equipment_no, created_at) VALUES(?1, ?2);");
        defer s.finalize();
        s.bindText(1, equipment_no);
        s.bindInt(2, internal.now(
            self,
        ));
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
        s.bindInt(4, internal.now(
            self,
        ));
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
        &.{ .{ .text = equipment_no }, .{ .text = email }, .{ .int = internal.now(
            self,
        ) } },
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
