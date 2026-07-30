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
/// Cap on the `filename=` value we will carry out of the part headers. Longer
/// than any sane filename (and than every filesystem's own limit), so a value
/// past it is reported as ABSENT rather than truncated — a truncated name would
/// silently become a different file.
pub const max_filename = 255;

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

/// The consumed part-header prologue: the headers themselves, the `filename=`
/// they declared, and whatever content bytes were over-read past the blank line.
///
/// It is a SEPARATE step from the body stream because the filename is the one
/// thing a caller may need to VET before accepting a single byte — the web
/// upload endpoint rejects an unsupported extension or an unsafe name with
/// nothing written to disk. `extract` below is still the one-call form for
/// callers (the device's `/oss/put`) that already know what they are storing.
pub const Prologue = struct {
    buf: [max_prologue]u8 = undefined,
    /// Bytes read into `buf` (headers + over-read content).
    filled: usize = 0,
    /// One past the `\r\n\r\n` that ends the part headers.
    sep_end: usize = 0,
    name_buf: [max_filename]u8 = undefined,
    name_len: usize = 0,

    /// The part headers, including the trailing blank line.
    pub fn headers(self: *const Prologue) []const u8 {
        return self.buf[0..self.sep_end];
    }
    /// Content bytes over-read while scanning for the blank line.
    pub fn leftover(self: *const Prologue) []const u8 {
        return self.buf[self.sep_end..self.filled];
    }
    /// The part's declared `filename`, reduced to a BASENAME (any directory
    /// prefix a client sent is dropped) — "" when absent, unparseable, or longer
    /// than `max_filename`. Still untrusted: the caller must validate it before
    /// using it as a path or tree component.
    pub fn filename(self: *const Prologue) []const u8 {
        return self.name_buf[0..self.name_len];
    }
};

/// Consumes the part-header prologue from `reader` into `out`, stopping at the
/// blank line that starts the content. Call `streamPart` next with the SAME
/// `out` to write the body — it replays the over-read bytes `out` is holding.
pub fn readPrologue(reader: *std.Io.Reader, out: *Prologue) !void {
    out.filled = 0;
    out.sep_end = 0;
    out.name_len = 0;
    while (true) {
        if (out.filled == out.buf.len) return Error.MalformedPrologue;
        const n = try reader.readSliceShort(out.buf[out.filled..]);
        if (n == 0) return Error.MalformedPrologue; // EOF before headers ended
        const search_from = if (out.filled >= 3) out.filled - 3 else 0; // "\r\n\r\n" can straddle
        out.filled += n;
        if (std.mem.indexOfPos(u8, out.buf[0..out.filled], search_from, "\r\n\r\n")) |i| {
            out.sep_end = i + 4;
            break;
        }
    }
    const name = parseFilename(out.headers());
    if (name.len > 0 and name.len <= out.name_buf.len) {
        @memcpy(out.name_buf[0..name.len], name);
        out.name_len = name.len;
    }
}

/// The `filename=` value in a `Content-Disposition` part header, reduced to its
/// basename. "" when absent or malformed.
///
/// Only the plain `filename=` form is read; RFC 5987's `filename*=` is
/// deliberately not matched (searching for the literal `filename=` skips it),
/// because decoding its charset/language envelope would be a second, richer
/// parser for a form no mainstream browser sends for a file part.
///
/// The basename reduction is a SECURITY step, not a convenience: a few clients
/// (and every hand-rolled one) put a full path in `filename`, and the value goes
/// on to name a tree entry. Everything up to the last `/` or `\` is dropped here
/// so a traversal attempt cannot survive as a path at all; the caller still
/// validates what is left.
fn parseFilename(headers: []const u8) []const u8 {
    const marker = "filename=";
    const at = std.ascii.indexOfIgnoreCase(headers, marker) orelse return "";
    var rest = headers[at + marker.len ..];
    if (rest.len > 0 and rest[0] == '"') {
        rest = rest[1..];
        const end = std.mem.indexOfScalar(u8, rest, '"') orelse return "";
        rest = rest[0..end];
    } else {
        // An unquoted token runs to the next ';' or the end of the header line.
        var end: usize = rest.len;
        for (rest, 0..) |c, i| {
            if (c == ';' or c == '\r' or c == '\n') {
                end = i;
                break;
            }
        }
        rest = rest[0..end];
    }
    rest = std.mem.trim(u8, rest, " \t");
    if (std.mem.lastIndexOfAny(u8, rest, "/\\")) |i| rest = rest[i + 1 ..];
    return rest;
}

/// Streams the part's raw bytes into `sink` (anything with
/// `pub fn write(self, []const u8) !void`), starting from the content `pro`
/// already over-read. `boundary` is the token from the Content-Type (WITHOUT the
/// `--` prefix). Streams incrementally; the peak extra memory is
/// `read_chunk + max_term`.
pub fn streamPart(reader: *std.Io.Reader, boundary: []const u8, pro: *const Prologue, sink: anytype) !void {
    // The delimiter that closes the part is CRLF + "--" + boundary. Content ends
    // immediately before it.
    var term_buf: [max_term]u8 = undefined;
    if (4 + boundary.len > term_buf.len) return Error.BadBoundary;
    @memcpy(term_buf[0..4], "\r\n--");
    @memcpy(term_buf[4..][0..boundary.len], boundary);
    const term = term_buf[0 .. 4 + boundary.len];

    // Stream content until `term`, holding back a `term`-sized window so a
    // delimiter split across reads is still caught, and its bytes never leak.
    var src: Source = .{ .leftover = pro.leftover(), .reader = reader };
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

/// Reads the multipart body from `reader` and streams the file part's raw bytes
/// into `sink` — `readPrologue` + `streamPart` in one call, for callers that do
/// not need to see the part headers first. The part's `filename` is discarded.
pub fn extract(reader: *std.Io.Reader, boundary: []const u8, sink: anytype) !void {
    // Checked here as well as in `streamPart` so a boundary too long to match is
    // refused BEFORE any of the body is consumed, as it always has been.
    if (4 + boundary.len > max_term) return Error.BadBoundary;
    var pro: Prologue = .{};
    try readPrologue(reader, &pro);
    return streamPart(reader, boundary, &pro, sink);
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

test "readPrologue reports the part's filename and streamPart still yields the body" {
    const boundary = "PrologueBoundary";
    const payload = "the bytes";
    const body = try buildBody(testing.allocator, boundary, payload);
    defer testing.allocator.free(body);

    var base = std.Io.Reader.fixed(body);
    var pro: Prologue = .{};
    try readPrologue(&base, &pro);
    try testing.expectEqualStrings("x.note", pro.filename());

    var col: Collector = .{};
    defer col.deinit();
    try streamPart(&base, boundary, &pro, &col);
    try testing.expectEqualStrings(payload, col.buf.items);
}

test "part filenames: quoted, unquoted, path-stripped, absent, over-long" {
    const cases = [_]struct { hdr: []const u8, want: []const u8 }{
        .{ .hdr = "Content-Disposition: form-data; name=\"file\"; filename=\"a b.pdf\"\r\n\r\n", .want = "a b.pdf" },
        // Unquoted token, and a following parameter that must not be swallowed.
        .{ .hdr = "Content-Disposition: form-data; filename=plain.txt; x=1\r\n\r\n", .want = "plain.txt" },
        .{ .hdr = "Content-Disposition: form-data; filename=tail.txt\r\n\r\n", .want = "tail.txt" },
        // A client that sent a whole path keeps only the basename — both separators.
        .{ .hdr = "Content-Disposition: form-data; filename=\"../../etc/passwd\"\r\n\r\n", .want = "passwd" },
        .{ .hdr = "Content-Disposition: form-data; filename=\"C:\\\\Users\\\\me\\\\x.epub\"\r\n\r\n", .want = "x.epub" },
        // Header-name case does not matter.
        .{ .hdr = "content-disposition: form-data; FILENAME=\"Up.NOTE\"\r\n\r\n", .want = "Up.NOTE" },
        // Absent, unterminated, and RFC 5987's `filename*=` all read as absent.
        .{ .hdr = "Content-Disposition: form-data; name=\"file\"\r\n\r\n", .want = "" },
        .{ .hdr = "Content-Disposition: form-data; filename=\"unclosed\r\n\r\n", .want = "" },
        .{ .hdr = "Content-Disposition: form-data; filename*=UTF-8''a.pdf\r\n\r\n", .want = "" },
    };
    for (cases) |c| {
        const body = try std.mem.concat(testing.allocator, u8, &.{ "--b\r\n", c.hdr, "\r\n--b--\r\n" });
        defer testing.allocator.free(body);
        var base = std.Io.Reader.fixed(body);
        var pro: Prologue = .{};
        try readPrologue(&base, &pro);
        try testing.expectEqualStrings(c.want, pro.filename());
    }

    // A name past `max_filename` is reported ABSENT rather than truncated — a
    // truncated name would silently be a different file.
    const long = "x" ** (max_filename + 1);
    const body = try std.fmt.allocPrint(testing.allocator, "--b\r\nContent-Disposition: form-data; filename=\"{s}\"\r\n\r\n\r\n--b--\r\n", .{long});
    defer testing.allocator.free(body);
    var base = std.Io.Reader.fixed(body);
    var pro: Prologue = .{};
    try readPrologue(&base, &pro);
    try testing.expectEqual(@as(usize, 0), pro.filename().len);
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
