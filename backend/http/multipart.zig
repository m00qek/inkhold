//! Streaming extractor for the single-file `multipart/form-data` body the device
//! POSTs to `/oss/put`. The wire shape (from the live capture) is one part:
//!
//!     --<boundary>\r\n
//!     Content-Disposition: form-data; name="file"; filename="..."\r\n
//!     [Content-Type: application/octet-stream\r\n]
//!     \r\n
//!     <raw .note bytes>\r\n
//!     --<boundary>--\r\n
//!
//! We stream the raw bytes straight into a sink (the blob store's `Ingest`)
//! WITHOUT ever buffering the whole file — a 2 MB upload must not cost 2 MB of
//! RSS (see [[resource-budget]]). The only buffering is the small part-header
//! prologue and a `boundary`-sized hold-back window so the trailing
//! `\r\n--<boundary>--` delimiter is detected and stripped even when it straddles
//! two read chunks (the nasty case the unit tests hammer).

const std = @import("std");

/// Longest boundary we accept, including the leading `\r\n--`. RFC 2046 caps a
/// boundary at 70 chars; +4 for `\r\n--` and slack.
pub const max_term = 128;
/// Cap on the part-header prologue (`--boundary\r\n` + headers + `\r\n\r\n`).
const max_prologue = 8 * 1024;
const read_chunk = 64 * 1024;

pub const Error = error{
    /// No `boundary=` in the Content-Type, or it is too long / empty.
    BadBoundary,
    /// The part-header prologue had no `\r\n\r\n` within `max_prologue`.
    MalformedPrologue,
    /// The body ended before the closing `\r\n--<boundary>` delimiter.
    MissingTerminator,
};

/// Copies the `boundary=` token out of a Content-Type header value into `buf`,
/// returning the slice (or null if absent/malformed). Surrounding quotes are
/// stripped; a trailing `;`-separated parameter is ignored. Call this BEFORE
/// reading the request body (header strings are invalidated once the body reader
/// is created).
pub fn boundaryFromContentType(content_type: []const u8, buf: []u8) ?[]const u8 {
    const marker = "boundary=";
    const at = std.ascii.indexOfIgnoreCase(content_type, marker) orelse return null;
    var rest = content_type[at + marker.len ..];
    // A boundary runs to the next ';' or end; it may be double-quoted.
    if (rest.len > 0 and rest[0] == '"') {
        rest = rest[1..];
        const end = std.mem.indexOfScalar(u8, rest, '"') orelse return null;
        rest = rest[0..end];
    } else if (std.mem.indexOfScalar(u8, rest, ';')) |semi| {
        rest = rest[0..semi];
    }
    rest = std.mem.trim(u8, rest, " \t");
    if (rest.len == 0 or rest.len > buf.len) return null;
    @memcpy(buf[0..rest.len], rest);
    return buf[0..rest.len];
}

/// Reads the multipart body from `reader` and streams the `file` part's raw
/// bytes into `sink` (anything with `pub fn write(self, []const u8) !void`).
/// `boundary` is the token from the Content-Type (WITHOUT the `--` prefix).
/// Streams incrementally; the peak extra memory is `read_chunk + max_term`.
pub fn extract(reader: *std.Io.Reader, boundary: []const u8, sink: anytype) !void {
    // The delimiter that closes the part is CRLF + "--" + boundary. Content ends
    // immediately before it.
    var term_buf: [max_term]u8 = undefined;
    if (4 + boundary.len > term_buf.len) return Error.BadBoundary;
    @memcpy(term_buf[0..4], "\r\n--");
    @memcpy(term_buf[4..][0..boundary.len], boundary);
    const term = term_buf[0 .. 4 + boundary.len];

    // Phase 1: consume the part-header prologue up to and including "\r\n\r\n".
    // Whatever we over-read past it is the START of the file content.
    var prologue: [max_prologue]u8 = undefined;
    var filled: usize = 0;
    var sep_end: usize = 0;
    while (true) {
        if (filled == prologue.len) return Error.MalformedPrologue;
        const n = try reader.readSliceShort(prologue[filled..]);
        if (n == 0) return Error.MalformedPrologue; // EOF before headers ended
        const search_from = if (filled >= 3) filled - 3 else 0; // "\r\n\r\n" can straddle
        filled += n;
        if (std.mem.indexOfPos(u8, prologue[0..filled], search_from, "\r\n\r\n")) |i| {
            sep_end = i + 4;
            break;
        }
    }
    const leftover = prologue[sep_end..filled];

    // Phase 2: stream content until `term`, holding back a `term`-sized window so
    // a delimiter split across reads is still caught, and its bytes never leak.
    var src: Source = .{ .leftover = leftover, .reader = reader };
    var pending: [max_term]u8 = undefined;
    var pending_len: usize = 0;
    var work: [read_chunk + max_term]u8 = undefined;
    while (true) {
        @memcpy(work[0..pending_len], pending[0..pending_len]);
        const n = try src.read(work[pending_len..]);
        if (n == 0) return Error.MissingTerminator; // EOF before the closing delimiter
        const total = pending_len + n;
        if (std.mem.indexOf(u8, work[0..total], term)) |idx| {
            try sink.write(work[0..idx]);
            return;
        }
        // No full match: everything except a possible term-prefix tail is safe to emit.
        const keep = @min(total, term.len - 1);
        const emit = total - keep;
        try sink.write(work[0..emit]);
        @memcpy(pending[0..keep], work[emit..total]);
        pending_len = keep;
    }
}

/// A byte source that yields `leftover` (the content bytes over-read during the
/// prologue scan) before falling through to the request-body `reader`.
const Source = struct {
    leftover: []const u8,
    off: usize = 0,
    reader: *std.Io.Reader,

    fn read(self: *Source, buf: []u8) !usize {
        if (self.off < self.leftover.len) {
            const n = @min(buf.len, self.leftover.len - self.off);
            @memcpy(buf[0..n], self.leftover[self.off..][0..n]);
            self.off += n;
            return n;
        }
        return self.reader.readSliceShort(buf);
    }
};

// ---- tests ----

const testing = std.testing;

/// A test sink that just accumulates everything written into it.
const Collector = struct {
    buf: std.ArrayList(u8) = .empty,
    fn write(self: *Collector, bytes: []const u8) !void {
        try self.buf.appendSlice(testing.allocator, bytes);
    }
    fn deinit(self: *Collector) void {
        self.buf.deinit(testing.allocator);
    }
};

/// Builds a single-part `multipart/form-data` body wrapping `payload`.
fn buildBody(alloc: std.mem.Allocator, boundary: []const u8, payload: []const u8) ![]u8 {
    const head = try std.fmt.allocPrint(alloc, "--{s}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.note\"\r\nContent-Type: application/octet-stream\r\n\r\n", .{boundary});
    defer alloc.free(head);
    const tail = try std.fmt.allocPrint(alloc, "\r\n--{s}--\r\n", .{boundary});
    defer alloc.free(tail);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    try out.appendSlice(alloc, head);
    try out.appendSlice(alloc, payload);
    try out.appendSlice(alloc, tail);
    return out.toOwnedSlice(alloc);
}

/// Feeds `body` (whole, via a fixed reader) through `extract`, appending the
/// extracted bytes to `out`.
fn runExtract(boundary: []const u8, body: []const u8, out: *std.ArrayList(u8)) !void {
    var base = std.Io.Reader.fixed(body);
    var col: Collector = .{};
    defer col.deinit();
    try extract(&base, boundary, &col);
    try out.appendSlice(testing.allocator, col.buf.items);
}

test "boundaryFromContentType parses plain, quoted, and parameterized values" {
    var buf: [128]u8 = undefined;
    try testing.expectEqualStrings("abc123", boundaryFromContentType("multipart/form-data; boundary=abc123", &buf).?);
    try testing.expectEqualStrings("a-b-c", boundaryFromContentType("multipart/form-data; boundary=\"a-b-c\"", &buf).?);
    try testing.expectEqualStrings("xyz", boundaryFromContentType("multipart/form-data; boundary=xyz; charset=utf-8", &buf).?);
    // Case-insensitive header token, tolerant of spacing.
    try testing.expectEqualStrings("QQ", boundaryFromContentType("multipart/form-data;  BOUNDARY=QQ", &buf).?);
    try testing.expect(boundaryFromContentType("application/json", &buf) == null);
    try testing.expect(boundaryFromContentType("multipart/form-data; boundary=", &buf) == null);
}

test "extract pulls the raw file bytes out of a well-formed body" {
    const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
    const payload = "hello supernote — these are the .note bytes";
    const body = try buildBody(testing.allocator, boundary, payload);
    defer testing.allocator.free(body);

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(testing.allocator);
    try runExtract(boundary, body, &out);
    try testing.expectEqualStrings(payload, out.items);
}

test "extract is byte-exact for empty and binary payloads" {
    const boundary = "b0";
    // A payload containing NULs, CRs, LFs and partial boundary look-alikes.
    const payload = &[_]u8{ 0, '\r', '\n', '-', '-', 'b', 0, 0xFF, '\n', '-', '-', 'b', '0', 'x' };
    const body = try buildBody(testing.allocator, boundary, payload);
    defer testing.allocator.free(body);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(testing.allocator);
    try runExtract(boundary, body, &out);
    try testing.expectEqualSlices(u8, payload, out.items);

    // Empty payload → empty extraction.
    const eb = try buildBody(testing.allocator, boundary, "");
    defer testing.allocator.free(eb);
    var out2: std.ArrayList(u8) = .empty;
    defer out2.deinit(testing.allocator);
    try runExtract(boundary, eb, &out2);
    try testing.expectEqual(@as(usize, 0), out2.items.len);
}

test "extract handles the terminator split across read chunks, at every chunk size" {
    const boundary = "SplitTest-Boundary";
    // A payload whose tail is a near-copy of the delimiter, to stress the holdback.
    var payload: [4096]u8 = undefined;
    for (&payload, 0..) |*b, i| b.* = @intCast((i * 31 + 7) & 0xFF);
    const body = try buildBody(testing.allocator, boundary, &payload);
    defer testing.allocator.free(body);

    // Drive the SAME body through a reader that emits it in every awkward chunk
    // size from 1 upward — each size lands the "\r\n--boundary--" tail on a
    // different split. All must reproduce the payload byte-for-byte.
    var chunk: usize = 1;
    while (chunk <= 200) : (chunk += 1) {
        var cr: ChunkedReader = .{ .data = body, .chunk = chunk };
        cr.init();
        var col: Collector = .{};
        defer col.deinit();
        try extract(&cr.iface, boundary, &col);
        try testing.expectEqualSlices(u8, &payload, col.buf.items);
    }
}

test "extract rejects a body with no closing delimiter" {
    const boundary = "z";
    // Prologue present, but the content is never terminated.
    const bad = "--z\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nunterminated content";
    var base = std.Io.Reader.fixed(bad);
    var col: Collector = .{};
    defer col.deinit();
    try testing.expectError(Error.MissingTerminator, extract(&base, boundary, &col));
}

test "extract rejects a body whose part headers never end" {
    const boundary = "z";
    const bad = "--z\r\nContent-Disposition: form-data; name=\"file\""; // no blank line
    var base = std.Io.Reader.fixed(bad);
    var col: Collector = .{};
    defer col.deinit();
    try testing.expectError(Error.MalformedPrologue, extract(&base, boundary, &col));
}

/// A `std.Io.Reader` that hands out at most `chunk` bytes per `stream` call, to
/// force the extractor's holdback logic across every possible split point.
const ChunkedReader = struct {
    data: []const u8,
    pos: usize = 0,
    chunk: usize,
    iface: std.Io.Reader = undefined,

    fn init(self: *ChunkedReader) void {
        self.iface = .{
            .vtable = &.{ .stream = streamFn },
            .buffer = &.{},
            .seek = 0,
            .end = 0,
        };
    }

    fn streamFn(r: *std.Io.Reader, w: *std.Io.Writer, limit: std.Io.Limit) std.Io.Reader.StreamError!usize {
        const self: *ChunkedReader = @fieldParentPtr("iface", r);
        if (self.pos >= self.data.len) return error.EndOfStream;
        const want = @min(@min(self.chunk, @intFromEnum(limit)), self.data.len - self.pos);
        const n = try w.write(self.data[self.pos..][0..want]);
        self.pos += n;
        return n;
    }
};
