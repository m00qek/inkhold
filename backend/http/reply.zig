//! Shared HTTP reply + request-parsing helpers for the handlers.
//!
//! Every handler follows the same parse → service → respond shape, and shares
//! the official response envelope (`BaseVO` + `fail`/`badRequest`/`serverError`)
//! and a few tiny request-parsing helpers (`pathId`, `queryParam`, `notFound`).
//! Pulling them here keeps the per-face handler files thin and consistent.

const std = @import("std");
const json = @import("json.zig");
const context = @import("context.zig");
const router = @import("router.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;

/// The official response envelope: every response carries `success` (+
/// `errorCode`/`errorMsg` on failure); null fields are omitted.
pub const BaseVO = struct { success: bool, errorCode: ?[]const u8 = null, errorMsg: ?[]const u8 = null };

/// Emit a failure envelope with the given status/code/message.
pub fn fail(ctx: *Context, req: *Request, status: std.http.Status, code: []const u8, msg: []const u8) anyerror!void {
    try json.respond(ctx.gpa, req, status, BaseVO{ .success = false, .errorCode = code, .errorMsg = msg }, null);
}

pub fn badRequest(ctx: *Context, req: *Request) anyerror!void {
    try fail(ctx, req, .bad_request, "BAD_REQUEST", "invalid request body");
}

pub fn serverError(ctx: *Context, req: *Request) anyerror!void {
    try fail(ctx, req, .internal_server_error, "SERVER_ERROR", "internal error");
}

/// A plain 404 (for non-JSON byte endpoints).
pub fn notFound(req: *Request) anyerror!void {
    try req.respond("not found\n", .{ .status = .not_found });
}

/// A plain 403 (for non-JSON byte endpoints — e.g. a missing/expired URL
/// capability token on a public download). Deliberately NOT 401: the device
/// treats a 401 as an invalid session and logs itself out.
pub fn forbidden(req: *Request) anyerror!void {
    try req.respond("forbidden\n", .{ .status = .forbidden });
}

/// Parses the `:id` path parameter as a u64 id.
pub fn pathId(params: Params) ?u64 {
    const s = params.get("id") orelse return null;
    return std.fmt.parseInt(u64, s, 10) catch null;
}

/// Extracts a query parameter `name` from a raw request target (`/p?a=1&b=2`).
/// Values are not URL-decoded (our params are numeric ids / hex hashes).
pub fn queryParam(target: []const u8, name: []const u8) ?[]const u8 {
    const q = std.mem.indexOfScalar(u8, target, '?') orelse return null;
    var it = std.mem.splitScalar(u8, target[q + 1 ..], '&');
    while (it.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (std.mem.eql(u8, pair[0..eq], name)) return pair[eq + 1 ..];
    }
    return null;
}

/// Percent-decodes a query-string value into `arena` (`%XX` escapes, and `+` as
/// a space — browsers encode form/`URLSearchParams` values that way).
///
/// `queryParam` deliberately does not decode: everywhere else on this face the
/// values are numeric ids or hex hashes, where decoding would be noise. A search
/// term is the exception — it is arbitrary user text and arrives encoded. A
/// malformed escape is left as its literal characters rather than rejected;
/// there is nothing safer to do with it, and the value only ever becomes a bound
/// SQL parameter.
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

/// The longest raw filename we will echo back in a `Content-Disposition`. Names
/// are device-supplied; a header is not the place to discover how long one can be.
const max_disposition_name = 128;

const hex_digits = "0123456789ABCDEF";

/// Bytes we let through verbatim into the quoted `filename="…"` form. The set is
/// an ALLOWLIST on purpose: everything outside it — quotes, backslashes, CR, LF,
/// path separators, control bytes, and every byte >= 0x80 — becomes `_`. That is
/// what makes header injection impossible rather than merely unlikely.
fn isSafeFilenameByte(c: u8) bool {
    return switch (c) {
        'a'...'z', 'A'...'Z', '0'...'9', ' ', '.', '_', '-', '(', ')', '[', ']', '+', ',' => true,
        else => false,
    };
}

/// `name` truncated to at most `max` bytes, backing off to a UTF-8 boundary so a
/// long name can never be cut mid-sequence (which would make `filename*`'s
/// declared UTF-8 a lie).
fn truncateUtf8(name: []const u8, max: usize) []const u8 {
    if (name.len <= max) return name;
    var end = max;
    while (end > 0 and (name[end] & 0xC0) == 0x80) end -= 1;
    return name[0..end];
}

/// Renders a header-safe `Content-Disposition` value into `buf`, e.g.
/// `inline; filename="a b.png"; filename*=UTF-8''a%20b.png`.
///
/// **The filename is DEVICE-AUTHORED**: it arrives over the sync API and may hold
/// quotes, backslashes, CR/LF, path separators or arbitrary non-ASCII. Splicing it
/// raw into a header is a header-injection route (a `\r\n` would let the device
/// author forge response headers), so nothing here trusts it:
///
///   - the quoted form is built from an **allowlist** (`isSafeFilenameByte`),
///     every other byte replaced by `_`, so no quote or newline can survive;
///   - the real name is carried alongside as RFC 5987 `filename*=UTF-8''…`,
///     percent-encoded down to the unreserved set — so a non-ASCII name is
///     preserved for modern browsers without a single raw byte reaching the wire;
///   - both forms are truncated to `max_disposition_name` bytes on a UTF-8
///     boundary; an empty (or entirely-unsafe, hence empty) name becomes
///     `download`, because `filename=""` is not a filename.
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

    // The header-injection attempt: a quote, a CR and an LF. None may survive
    // into either form, and no header boundary may appear in the output.
    const nasty = "ev\"il\r\nX-Injected: 1\n.png";
    const out = try contentDisposition(&buf, "attachment", nasty);
    try std.testing.expect(std.mem.indexOfScalar(u8, out, '\r') == null);
    try std.testing.expect(std.mem.indexOfScalar(u8, out, '\n') == null);
    // Exactly one quote pair — the one we wrote — so the quoted form cannot be
    // closed early and followed by attacker-chosen parameters.
    var quotes: usize = 0;
    for (out) |c| {
        if (c == '"') quotes += 1;
    }
    try std.testing.expectEqual(@as(usize, 2), quotes);
    // The CRLF survives only as encoded TEXT inside a header value, which cannot
    // start a header. The colon that would have to follow it is encoded too.
    try std.testing.expect(std.mem.indexOf(u8, out, "%0D%0A") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "X-Injected%3A") != null);

    // Path separators are not filename bytes.
    const trav = try contentDisposition(&buf, "attachment", "../../etc/passwd");
    try std.testing.expect(std.mem.indexOfScalar(u8, trav, '/') == null);

    // Non-ASCII: mangled in the quoted fallback, exact in `filename*`.
    const uni = try contentDisposition(&buf, "inline", "café.png");
    try std.testing.expect(std.mem.indexOf(u8, uni, "filename=\"caf__.png\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, uni, "filename*=UTF-8''caf%C3%A9.png") != null);

    // An empty name is still a filename.
    try std.testing.expectEqualStrings(
        "attachment; filename=\"download\"; filename*=UTF-8''download",
        try contentDisposition(&buf, "attachment", ""),
    );
}

test "contentDisposition truncates long names on a UTF-8 boundary" {
    var buf: [1024]u8 = undefined;
    const long = "é" ** 200; // 400 bytes, every one of them multi-byte
    const out = try contentDisposition(&buf, "inline", long);
    // The encoded name must decode as whole code points: no trailing lone
    // continuation byte, which `%C3` with nothing after it would be.
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
    // Truncated / non-hex escapes stay literal instead of erroring.
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
