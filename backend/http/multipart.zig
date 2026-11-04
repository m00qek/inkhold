//! Streaming extractor for a single-file `multipart/form-data` body (the
//! device's `/oss/put`, web uploads). Never buffers the file: only the part
//! headers and a boundary-sized hold-back so a delimiter split across reads is
//! still caught.

const std = @import("std");
const repeat = @import("../util/repeat.zig").repeat;

/// Longest boundary accepted including `\r\n--` (RFC 2046 caps it at 70).
pub const max_term = 128;
const max_prologue = 8 * 1024;
const read_chunk = 64 * 1024;
/// Longer `filename=` values are reported absent, not truncated: a truncated
/// name would silently be a different file.
pub const max_filename = 255;

pub const Error = error{
    BadBoundary,
    MalformedPrologue,
    MissingTerminator,
};

/// Copies the `boundary=` token (unquoted) into `buf`. Call before reading the
/// body, which invalidates header strings.
pub fn boundaryFromContentType(content_type: []const u8, buf: []u8) ?[]const u8 {
    const marker = "boundary=";
    const at = std.ascii.findIgnoreCase(content_type, marker) orelse return null;
    var rest = content_type[at + marker.len ..];
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

/// The consumed part headers, their `filename=`, and content over-read past
/// the blank line. Separate from the body stream so a caller can vet the name
/// before accepting a byte.
pub const Prologue = struct {
    buf: [max_prologue]u8 = undefined,
    filled: usize = 0,
    sep_end: usize = 0,
    name_buf: [max_filename]u8 = undefined,
    name_len: usize = 0,

    pub fn headers(self: *const Prologue) []const u8 {
        return self.buf[0..self.sep_end];
    }
    pub fn leftover(self: *const Prologue) []const u8 {
        return self.buf[self.sep_end..self.filled];
    }
    /// The declared filename reduced to a basename; "" when absent or too long.
    /// Still untrusted.
    pub fn filename(self: *const Prologue) []const u8 {
        return self.name_buf[0..self.name_len];
    }
};

/// Reads the part headers into `out`. Pass the same `out` to `streamPart`,
/// which replays the over-read bytes.
pub fn readPrologue(reader: *std.Io.Reader, out: *Prologue) !void {
    out.filled = 0;
    out.sep_end = 0;
    out.name_len = 0;
    while (true) {
        if (out.filled == out.buf.len) return Error.MalformedPrologue;
        const n = try reader.readSliceShort(out.buf[out.filled..]);
        if (n == 0) return Error.MalformedPrologue;
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

/// The plain `filename=` value, reduced to its basename so a client-sent path
/// can't survive as a traversal. RFC 5987 `filename*=` is not read.
fn parseFilename(headers: []const u8) []const u8 {
    const marker = "filename=";
    const at = std.ascii.findIgnoreCase(headers, marker) orelse return "";
    var rest = headers[at + marker.len ..];
    if (rest.len > 0 and rest[0] == '"') {
        rest = rest[1..];
        const end = std.mem.indexOfScalar(u8, rest, '"') orelse return "";
        rest = rest[0..end];
    } else {
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

/// Streams the part's bytes into `sink` (`write([]const u8) !void`), starting
/// from `pro`'s over-read. `boundary` excludes the `--`. Peak extra memory is
/// `read_chunk + max_term`.
pub fn streamPart(reader: *std.Io.Reader, boundary: []const u8, pro: *const Prologue, sink: anytype) !void {
    var term_buf: [max_term]u8 = undefined;
    if (4 + boundary.len > term_buf.len) return Error.BadBoundary;
    @memcpy(term_buf[0..4], "\r\n--");
    @memcpy(term_buf[4..][0..boundary.len], boundary);
    const term = term_buf[0 .. 4 + boundary.len];

    // Hold back a `term`-sized tail so a split delimiter is caught and never emitted.
    var src: Source = .{ .leftover = pro.leftover(), .reader = reader };
    var pending: [max_term]u8 = undefined;
    var pending_len: usize = 0;
    var work: [read_chunk + max_term]u8 = undefined;
    while (true) {
        @memcpy(work[0..pending_len], pending[0..pending_len]);
        const n = try src.read(work[pending_len..]);
        if (n == 0) return Error.MissingTerminator;
        const total = pending_len + n;
        if (std.mem.indexOf(u8, work[0..total], term)) |idx| {
            try sink.write(work[0..idx]);
            return;
        }
        const keep = @min(total, term.len - 1);
        const emit = total - keep;
        try sink.write(work[0..emit]);
        @memcpy(pending[0..keep], work[emit..total]);
        pending_len = keep;
    }
}

/// `readPrologue` + `streamPart`, discarding the filename.
pub fn extract(reader: *std.Io.Reader, boundary: []const u8, sink: anytype) !void {
    // Refuse an unmatchable boundary before consuming any body.
    if (4 + boundary.len > max_term) return Error.BadBoundary;
    var pro: Prologue = .{};
    try readPrologue(reader, &pro);
    return streamPart(reader, boundary, &pro, sink);
}

/// Yields the prologue's over-read bytes, then the request body.
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

const Collector = struct {
    buf: std.ArrayList(u8) = .empty,
    fn write(self: *Collector, bytes: []const u8) !void {
        try self.buf.appendSlice(testing.allocator, bytes);
    }
    fn deinit(self: *Collector) void {
        self.buf.deinit(testing.allocator);
    }
};

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
    const payload = &[_]u8{ 0, '\r', '\n', '-', '-', 'b', 0, 0xFF, '\n', '-', '-', 'b', '0', 'x' };
    const body = try buildBody(testing.allocator, boundary, payload);
    defer testing.allocator.free(body);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(testing.allocator);
    try runExtract(boundary, body, &out);
    try testing.expectEqualSlices(u8, payload, out.items);

    const eb = try buildBody(testing.allocator, boundary, "");
    defer testing.allocator.free(eb);
    var out2: std.ArrayList(u8) = .empty;
    defer out2.deinit(testing.allocator);
    try runExtract(boundary, eb, &out2);
    try testing.expectEqual(@as(usize, 0), out2.items.len);
}

test "extract handles the terminator split across read chunks, at every chunk size" {
    const boundary = "SplitTest-Boundary";
    var payload: [4096]u8 = undefined;
    for (&payload, 0..) |*b, i| b.* = @intCast((i * 31 + 7) & 0xFF);
    const body = try buildBody(testing.allocator, boundary, &payload);
    defer testing.allocator.free(body);

    // Every chunk size lands the delimiter on a different split.
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
    const bad = "--z\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nunterminated content";
    var base = std.Io.Reader.fixed(bad);
    var col: Collector = .{};
    defer col.deinit();
    try testing.expectError(Error.MissingTerminator, extract(&base, boundary, &col));
}

test "extract rejects a body whose part headers never end" {
    const boundary = "z";
    const bad = "--z\r\nContent-Disposition: form-data; name=\"file\"";
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
        .{ .hdr = "Content-Disposition: form-data; filename=plain.txt; x=1\r\n\r\n", .want = "plain.txt" },
        .{ .hdr = "Content-Disposition: form-data; filename=tail.txt\r\n\r\n", .want = "tail.txt" },
        .{ .hdr = "Content-Disposition: form-data; filename=\"../../etc/passwd\"\r\n\r\n", .want = "passwd" },
        .{ .hdr = "Content-Disposition: form-data; filename=\"C:\\\\Users\\\\me\\\\x.epub\"\r\n\r\n", .want = "x.epub" },
        .{ .hdr = "content-disposition: form-data; FILENAME=\"Up.NOTE\"\r\n\r\n", .want = "Up.NOTE" },
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

    const long = repeat(u8, "x", max_filename + 1);
    const body = try std.fmt.allocPrint(testing.allocator, "--b\r\nContent-Disposition: form-data; filename=\"{s}\"\r\n\r\n\r\n--b--\r\n", .{long});
    defer testing.allocator.free(body);
    var base = std.Io.Reader.fixed(body);
    var pro: Prologue = .{};
    try readPrologue(&base, &pro);
    try testing.expectEqual(@as(usize, 0), pro.filename().len);
}

/// Hands out at most `chunk` bytes per `stream` call.
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
        const want = @min(@min(self.chunk, @backingInt(limit)), self.data.len - self.pos);
        const n = try w.write(self.data[self.pos..][0..want]);
        self.pos += n;
        return n;
    }
};
