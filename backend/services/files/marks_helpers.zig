//! Helpers shared by the `marks_test` tests.

const std = @import("std");
const filesmod = @import("../files.zig");
const Entry = filesmod.Entry;
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const freeEntry = fx.freeEntry;

/// Distinct bytes so the quota arithmetic can tell them apart. Caller frees both.
pub const MarkPair = struct { pdf: Entry, mark: Entry };

pub fn putPair(f: *Fixture, parent: ?u64, stem: []const u8, pdf_bytes: []const u8, mark_bytes: []const u8) !MarkPair {
    var buf: [128]u8 = undefined;
    const pdf_name = try std.fmt.bufPrint(&buf, "{s}.pdf", .{stem});
    const pdf = try putBytes(f, 1, parent, pdf_name, pdf_bytes);
    errdefer freeEntry(pdf);
    var buf2: [128]u8 = undefined;
    const mark_name = try std.fmt.bufPrint(&buf2, "{s}.pdf.mark", .{stem});
    const mark = try putBytes(f, 1, parent, mark_name, mark_bytes);
    return .{ .pdf = pdf, .mark = mark };
}

/// Straight from the table, never through the folding API.
pub fn deletedFlagOf(f: *Fixture, id: u64) !i64 {
    var r = (try f.db.row("SELECT deleted FROM files WHERE id = ?1;", &.{.{ .int = @intCast(id) }})) orelse return -1;
    defer r.finalize();
    return r.int(0);
}

/// Straight from the table; "" when the row is gone.
pub fn nameOf(f: *Fixture, arena: std.mem.Allocator, id: u64) ![]const u8 {
    var r = (try f.db.row("SELECT name FROM files WHERE id = ?1;", &.{.{ .int = @intCast(id) }})) orelse return "";
    defer r.finalize();
    return arena.dupe(u8, r.text(0));
}
