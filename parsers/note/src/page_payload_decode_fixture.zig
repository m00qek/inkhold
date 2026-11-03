//! Fixture and helpers shared by the `page_payload_decode` tests.

const std = @import("std");
const types = @import("types.zig");
const page_payload = @import("page_payload.zig");
const FLAG_ALL_BLANK = page_payload.FLAG_ALL_BLANK;
const MAGIC = page_payload.MAGIC;
const VERSION = page_payload.VERSION;

pub fn buildOneLayer(gpa: std.mem.Allocator, variant: u8, w: u32, h: u32, all_blank: bool, rle: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION);
    try out.append(gpa, variant);
    try out.appendSlice(gpa, &.{ 0, 0 });
    try appendU32(&out, gpa, w);
    try appendU32(&out, gpa, h);
    try appendU32(&out, gpa, 1);
    try out.append(gpa, if (all_blank) FLAG_ALL_BLANK else 0x00);
    try out.append(gpa, types.LayerSlot.main.wireId());
    try appendU32(&out, gpa, @intCast(rle.len));
    try out.appendSlice(gpa, rle);
    return out.toOwnedSlice(gpa);
}

pub fn appendU32(out: *std.ArrayList(u8), gpa: std.mem.Allocator, v: u32) std.mem.Allocator.Error!void {
    var b: [4]u8 = undefined;
    std.mem.writeInt(u32, &b, v, .little);
    try out.appendSlice(gpa, &b);
}
