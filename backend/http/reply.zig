//! Shared reply and request-parsing helpers for the handlers.

const std = @import("std");
const repeat = @import("../util/repeat.zig").repeat;
const json = @import("json.zig");
const context = @import("context.zig");
const router = @import("router.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;

/// The official response envelope; null fields are omitted.
pub const BaseVO = struct { success: bool, errorCode: ?[]const u8 = null, errorMsg: ?[]const u8 = null };

pub fn fail(ctx: *Context, req: *Request, status: std.http.Status, code: []const u8, msg: []const u8) anyerror!void {
    try json.respond(ctx.gpa, req, status, BaseVO{ .success = false, .errorCode = code, .errorMsg = msg }, null);
}

pub fn badRequest(ctx: *Context, req: *Request) anyerror!void {
    try fail(ctx, req, .bad_request, "BAD_REQUEST", "invalid request body");
}

pub fn serverError(ctx: *Context, req: *Request) anyerror!void {
    try fail(ctx, req, .internal_server_error, "SERVER_ERROR", "internal error");
}

pub fn notFound(req: *Request) anyerror!void {
    try req.respond("not found\n", .{ .status = .not_found });
}

/// A plain 403 for byte endpoints. Not 401: the device treats a 401 as an
/// invalid session and logs itself out.
pub fn forbidden(req: *Request) anyerror!void {
    try req.respond("forbidden\n", .{ .status = .forbidden });
}

pub fn pathId(params: Params) ?u64 {
    const s = params.get("id") orelse return null;
    return std.fmt.parseInt(u64, s, 10) catch null;
}

/// A raw query parameter from a request target, not URL-decoded.
pub fn queryParam(target: []const u8, name: []const u8) ?[]const u8 {
    const q = std.mem.indexOfScalar(u8, target, '?') orelse return null;
    var it = std.mem.splitScalar(u8, target[q + 1 ..], '&');
    while (it.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (std.mem.eql(u8, pair[0..eq], name)) return pair[eq + 1 ..];
    }
    return null;
}

/// Percent-decodes a query value into `arena` (`%XX`, and `+` as space). A
/// malformed escape stays literal.
pub fn percentDecode(arena: std.mem.Allocator, s: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.ensureTotalCapacity(arena, s.len);
    var i: usize = 0;
    while (i < s.len) {
        switch (s[i]) {
            '+' => {
                out.appendAssumeCapacity(' ');
                i += 1;
            },
            '%' => {
                if (i + 2 < s.len) {
                    if (std.fmt.parseInt(u8, s[i + 1 ..][0..2], 16)) |byte| {
                        out.appendAssumeCapacity(byte);
                        i += 3;
                        continue;
                    } else |_| {}
                }
                out.appendAssumeCapacity('%');
                i += 1;
            },
            else => {
                out.appendAssumeCapacity(s[i]);
                i += 1;
            },
        }
    }
    return out.items;
}

/// Longest device-supplied filename echoed in a `Content-Disposition`.
const max_disposition_name = 128;

const hex_digits = "0123456789ABCDEF";

/// Bytes allowed verbatim in the quoted `filename="…"`; an allowlist, so no
/// quote, CR/LF, separator or non-ASCII byte can reach the header.
fn isSafeFilenameByte(c: u8) bool {
    return switch (c) {
        'a'...'z', 'A'...'Z', '0'...'9', ' ', '.', '_', '-', '(', ')', '[', ']', '+', ',' => true,
        else => false,
    };
}

/// Truncates on a UTF-8 boundary, so `filename*` stays valid UTF-8.
fn truncateUtf8(name: []const u8, max: usize) []const u8 {
    if (name.len <= max) return name;
    var end = max;
    while (end > 0 and (name[end] & 0xC0) == 0x80) end -= 1;
    return name[0..end];
}

/// Renders a header-safe `Content-Disposition` into `buf`. The name is
/// device-authored, so the quoted form is allowlisted (`_` elsewhere), the real
/// name travels percent-encoded as RFC 5987 `filename*`, both are truncated,
/// and an empty name becomes `download`.
pub fn contentDisposition(buf: []u8, disposition: []const u8, name: []const u8) ![]const u8 {
    const trimmed = truncateUtf8(name, max_disposition_name);
    const safe: []const u8 = if (trimmed.len == 0) "download" else trimmed;

    var w = std.Io.Writer.fixed(buf);
    try w.writeAll(disposition);

    try w.writeAll("; filename=\"");
    for (safe) |c| try w.writeByte(if (isSafeFilenameByte(c)) c else '_');
    try w.writeAll("\"");

    try w.writeAll("; filename*=UTF-8''");
    for (safe) |c| switch (c) {
        'a'...'z', 'A'...'Z', '0'...'9', '-', '.', '_', '~' => try w.writeByte(c),
        else => {
            try w.writeByte('%');
            try w.writeByte(hex_digits[c >> 4]);
            try w.writeByte(hex_digits[c & 0x0F]);
        },
    };

    return buf[0..w.end];
}

test "contentDisposition neutralizes quotes, newlines and separators" {
    var buf: [1024]u8 = undefined;

    try std.testing.expectEqualStrings(
        "inline; filename=\"a b.png\"; filename*=UTF-8''a%20b.png",
        try contentDisposition(&buf, "inline", "a b.png"),
    );

    const nasty = "ev\"il\r\nX-Injected: 1\n.png";
    const out = try contentDisposition(&buf, "attachment", nasty);
    try std.testing.expect(std.mem.indexOfScalar(u8, out, '\r') == null);
    try std.testing.expect(std.mem.indexOfScalar(u8, out, '\n') == null);
    var quotes: usize = 0;
    for (out) |c| {
        if (c == '"') quotes += 1;
    }
    try std.testing.expectEqual(@as(usize, 2), quotes);
    try std.testing.expect(std.mem.indexOf(u8, out, "%0D%0A") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "X-Injected%3A") != null);

    const trav = try contentDisposition(&buf, "attachment", "../../etc/passwd");
    try std.testing.expect(std.mem.indexOfScalar(u8, trav, '/') == null);

    const uni = try contentDisposition(&buf, "inline", "café.png");
    try std.testing.expect(std.mem.indexOf(u8, uni, "filename=\"caf__.png\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, uni, "filename*=UTF-8''caf%C3%A9.png") != null);

    try std.testing.expectEqualStrings(
        "attachment; filename=\"download\"; filename*=UTF-8''download",
        try contentDisposition(&buf, "attachment", ""),
    );
}

test "contentDisposition truncates long names on a UTF-8 boundary" {
    var buf: [1024]u8 = undefined;
    const long = repeat(u8, "é", 200); // 400 bytes, every one of them multi-byte
    const out = try contentDisposition(&buf, "inline", long);
    try std.testing.expect(!std.mem.endsWith(u8, out, "%C3"));
    try std.testing.expect(std.mem.indexOf(u8, out, "filename*=UTF-8''") != null);
}

test "percentDecode handles escapes, plus-as-space, and malformed input" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try std.testing.expectEqualStrings("ação", try percentDecode(a, "a%C3%A7%C3%A3o"));
    try std.testing.expectEqualStrings("two words", try percentDecode(a, "two+words"));
    try std.testing.expectEqualStrings("a b", try percentDecode(a, "a%20b"));
    try std.testing.expectEqualStrings("plain", try percentDecode(a, "plain"));
    try std.testing.expectEqualStrings("%", try percentDecode(a, "%"));
    try std.testing.expectEqualStrings("%zz", try percentDecode(a, "%zz"));
    try std.testing.expectEqualStrings("%C", try percentDecode(a, "%C"));
}

test "queryParam extracts values and handles absence" {
    try std.testing.expectEqualStrings("9", queryParam("/api/controlplane/tree?parent=9", "parent").?);
    try std.testing.expect(queryParam("/api/controlplane/tree", "parent") == null);
    try std.testing.expect(queryParam("/p?a=1&b=2", "b") != null);
    try std.testing.expectEqualStrings("2", queryParam("/p?a=1&b=2", "b").?);
}
