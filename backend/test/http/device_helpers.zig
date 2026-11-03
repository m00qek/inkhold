//! Helpers shared by the `device_upload_test` tests.

const std = @import("std");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Fixture = harness.Fixture;

/// A single-part `multipart/form-data` body, framed as the device frames
/// `/oss/put`. Caller frees.
pub fn buildMultipart(boundary: []const u8, payload: []const u8) ![]u8 {
    const head = try std.fmt.allocPrint(gpa, "--{s}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"up.note\"\r\nContent-Type: application/octet-stream\r\n\r\n", .{boundary});
    defer gpa.free(head);
    const tail = try std.fmt.allocPrint(gpa, "\r\n--{s}--\r\n", .{boundary});
    defer gpa.free(tail);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, head);
    try out.appendSlice(gpa, payload);
    try out.appendSlice(gpa, tail);
    return out.toOwnedSlice(gpa);
}

/// Live rows a user has under `name`: a retried create must converge on one.
pub fn countNamed(f: *Fixture, user_id: u64, name: []const u8) !i64 {
    var s = try f.db.prepare("SELECT COUNT(*) FROM files WHERE user_id = ?1 AND name = ?2 AND deleted = 0;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindText(2, name);
    _ = try s.step();
    return s.columnInt(0);
}
