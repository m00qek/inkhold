//! JSON request/response helpers for handlers.

const std = @import("std");
const router = @import("router.zig");

/// Upper bound on a buffered request body.
pub const max_body = 64 * 1024;

pub const ReadError = error{BadRequest};

/// An `i64` that may arrive as a JSON number or string: the Android client
/// sends `equipment: 2`, the web sends `equipment: "1"`; `upload/finish`'s
/// `size` is equally loose.
pub const LooseInt = struct {
    value: i64,

    pub fn jsonParse(allocator: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !LooseInt {
        const token = try source.nextAllocMax(allocator, .alloc_if_needed, options.max_value_len.?);
        const slice = switch (token) {
            inline .number, .allocated_number, .string, .allocated_string => |s| s,
            else => return error.UnexpectedToken,
        };
        const parsed = std.fmt.parseInt(i64, slice, 10) catch return error.InvalidNumber;
        switch (token) {
            .allocated_number, .allocated_string => |s| allocator.free(s),
            else => {},
        }
        return .{ .value = parsed };
    }
};

test "LooseInt parses a number, a quoted number, and rejects non-numeric" {
    const T = struct { equipment: ?LooseInt = null };
    {
        var p = try std.json.parseFromSlice(T, std.testing.allocator, "{\"equipment\":2}", .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 2), p.value.equipment.?.value);
    }
    {
        var p = try std.json.parseFromSlice(T, std.testing.allocator, "{\"equipment\":\"1\"}", .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 1), p.value.equipment.?.value);
    }
    {
        var p = try std.json.parseFromSlice(T, std.testing.allocator, "{}", .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.equipment == null);
    }
    {
        try std.testing.expectError(error.InvalidNumber, std.json.parseFromSlice(T, std.testing.allocator, "{\"equipment\":\"x\"}", .{ .ignore_unknown_fields = true }));
    }
}

/// Reads and parses the body as `T`. Reading the body invalidates the request
/// head's strings; the returned `Parsed(T)` owns its memory.
pub fn readBody(comptime T: type, gpa: std.mem.Allocator, req: *router.Request) ReadError!std.json.Parsed(T) {
    var rbuf: [4096]u8 = undefined;
    const reader = req.readerExpectContinue(&rbuf) catch return error.BadRequest;
    const body = reader.allocRemaining(gpa, .limited(max_body)) catch return error.BadRequest;
    defer gpa.free(body);
    // `alloc_always`: the result must not point into `body`, freed here.
    return std.json.parseFromSlice(T, gpa, body, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_always,
    }) catch error.BadRequest;
}

/// Serializes `value` as a JSON response, with an optional Set-Cookie. Null
/// optional fields are omitted.
pub fn respond(
    gpa: std.mem.Allocator,
    req: *router.Request,
    status: std.http.Status,
    value: anytype,
    set_cookie: ?[]const u8,
) !void {
    const headers: [1]std.http.Header = .{.{ .name = "set-cookie", .value = set_cookie orelse "" }};
    return respondWith(gpa, req, status, value, if (set_cookie == null) &.{} else &headers);
}

/// `respond` with caller-supplied extra headers.
pub fn respondWith(
    gpa: std.mem.Allocator,
    req: *router.Request,
    status: std.http.Status,
    value: anytype,
    extra: []const std.http.Header,
) !void {
    const body = try std.json.Stringify.valueAlloc(gpa, value, .{ .emit_null_optional_fields = false });
    defer gpa.free(body);

    var headers: std.ArrayList(std.http.Header) = .empty;
    defer headers.deinit(gpa);
    try headers.append(gpa, .{ .name = "content-type", .value = "application/json" });
    try headers.appendSlice(gpa, extra);

    try req.respond(body, .{ .status = status, .extra_headers = headers.items });
}

test "round-trips a value through parse and stringify" {
    const T = struct { account: []const u8, n: u32 = 0 };
    const src = "{\"account\":\"admin\",\"n\":7,\"extra\":true}"; // unknown field ignored
    var parsed = try std.json.parseFromSlice(T, std.testing.allocator, src, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    try std.testing.expectEqualStrings("admin", parsed.value.account);
    try std.testing.expectEqual(@as(u32, 7), parsed.value.n);

    const out = try std.json.Stringify.valueAlloc(
        std.testing.allocator,
        .{ .success = true, .token = @as(?[]const u8, null) },
        .{ .emit_null_optional_fields = false },
    );
    defer std.testing.allocator.free(out);
    try std.testing.expectEqualStrings("{\"success\":true}", out); // null token omitted
}
