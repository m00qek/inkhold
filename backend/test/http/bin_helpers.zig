//! Helpers shared by the `bin_test` tests.

const std = @import("std");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const requestWithCookie = harness.requestWithCookie;

/// The parsed `GET /api/controlplane/bin` body, only the fields the UI needs.
pub const BinBody = struct {
    entries: []const struct {
        kind: []const u8,
        id: []const u8,
        name: []const u8,
        path: []const u8,
        deletedAt: i64,
        size: i64,
        parentId: ?[]const u8 = null,
        isRoot: bool,
        fileType: ?[]const u8 = null,
        fileHash: ?[]const u8 = null,
        thumbAspect: ?struct { w: i64, h: i64 } = null,
    },
    totalBytes: i64,
    retentionDays: i64,
};

pub fn getBin(ctx: *Context, obuf: []u8, reqbuf: []u8, tok: []const u8) !std.json.Parsed(BinBody) {
    const resp = try requestWithCookie(ctx, obuf, reqbuf, "GET", "/api/controlplane/bin", tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    return std.json.parseFromSlice(BinBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
}
