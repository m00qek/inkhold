//! Helpers shared by the `auth_test` tests.

const std = @import("std");
const harness = @import("harness.zig");
const Fixture = harness.Fixture;

pub fn passwordChangedAt(f: *Fixture, user_id: u64) !?i64 {
    var r = (try f.db.row("SELECT password_changed_at FROM users WHERE id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return error.NoSuchUser;
    defer r.finalize();
    return r.intOpt(0);
}
