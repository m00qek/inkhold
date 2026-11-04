//! Helpers shared by the `history_test` tests.

const std = @import("std");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Fixture = harness.Fixture;

/// Seeds a one-page recognized `.note`; a second call with the same name
/// supersedes the first, retaining v1 in `file_history`.
pub fn seedRecognizedVersion(f: *Fixture, user_id: u64, name: []const u8, bitmap: []const u8, labels: []const []const u8) !u64 {
    const nb = @import("note_builder");
    const els = try gpa.alloc(nb.ElementSpec, labels.len);
    defer gpa.free(els);
    for (labels, els) |label, *e| e.* = .{ .label = label };

    const bytes = try nb.serialize(gpa, .{ .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }}, .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = bitmap }},
        .recogn_status = 1,
        .recogn_elements = els,
    }} });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer e.deinit(gpa);
    return e.id;
}

/// N-page variant of `seedRecognizedVersion`, so a retained version can differ
/// in page count from the current one.
pub fn seedRecognizedVersionPages(f: *Fixture, user_id: u64, name: []const u8, page_count: usize, bitmap: []const u8, label: []const u8) !u64 {
    const nb = @import("note_builder");
    const els = try gpa.alloc(nb.ElementSpec, 1);
    defer gpa.free(els);
    els[0] = .{ .label = label };

    const pgs = try gpa.alloc(nb.PageSpec, page_count);
    defer gpa.free(pgs);
    for (pgs) |*p| p.* = .{
        .layers = &.{.{ .slot = .main, .bitmap = bitmap }},
        .recogn_status = 1,
        .recogn_elements = els,
    };

    const bytes = try nb.serialize(gpa, .{ .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }}, .pages = pgs });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer e.deinit(gpa);
    return e.id;
}
