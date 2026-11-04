//! Stitches stored raw-deflate fragments into one gzip stream: serving costs a
//! header, N file reads and a trailer, with no (de)compression.
//!
//! Concatenated gzip members won't do: Chromium and curl decode only the first
//! and report success (Node's zlib decodes all, so Node tests lie). Fragments
//! are `flush()`ed, never `finish()`ed, so none carries BFINAL. Zig's
//! `flate.Decompress` never verifies the gzip footer (`WrongGzipChecksum` is
//! never raised), so tests compare it explicitly; gzip and browsers do check.

const std = @import("std");
const assert = std.debug.assert;
const Writer = std.Io.Writer;

pub const header = std.compress.flate.Container.gzip.header();

/// The empty final stored block (BFINAL=1, BTYPE=00); exactly one, at the end.
pub const terminator = [_]u8{ 0x03, 0x00 };

// --- crc32Combine -----------------------------------------------------------

const dim = 32;
/// CRC-32, reflected: gzip's polynomial.
const poly: u32 = 0xedb88320;

/// GF(2) bit-vector times bit-matrix: XOR the rows the vector selects.
fn matrixTimes(mat: *const [dim]u32, vec_in: u32) u32 {
    var sum: u32 = 0;
    var vec = vec_in;
    var i: usize = 0;
    while (vec != 0) : ({
        vec >>= 1;
        i += 1;
    }) {
        if (vec & 1 != 0) sum ^= mat[i];
    }
    return sum;
}

fn matrixSquare(square: *[dim]u32, mat: *const [dim]u32) void {
    for (0..dim) |n| square[n] = matrixTimes(mat, mat[n]);
}

/// `crc(A ++ B)` from `crc(A)`, `crc(B)` and B's length (zlib's GF(2)
/// matrix-squaring method, O(log n)). Takes final, post-conditioned values;
/// the conditionings cancel across the concatenation.
pub fn crc32Combine(crc_a: u32, crc_b: u32, len_b: u64) u32 {
    // The loop below would apply one squaring to a zero length.
    if (len_b == 0) return crc_a;

    var odd: [dim]u32 = undefined;
    var even: [dim]u32 = undefined;

    // `odd` = the operator for a single zero BIT.
    odd[0] = poly;
    var row: u32 = 1;
    for (1..dim) |n| {
        odd[n] = row;
        row <<= 1;
    }

    matrixSquare(&even, &odd); // two zero bits
    matrixSquare(&odd, &even); // four zero bits — i.e. one zero BYTE

    var crc = crc_a;
    var len = len_b;
    while (true) {
        matrixSquare(&even, &odd);
        if (len & 1 != 0) crc = matrixTimes(&even, crc);
        len >>= 1;
        if (len == 0) break;

        matrixSquare(&odd, &even);
        if (len & 1 != 0) crc = matrixTimes(&odd, crc);
        len >>= 1;
        if (len == 0) break;
    }

    return crc ^ crc_b;
}

// --- the accumulator a serve path uses --------------------------------------

/// Accumulates the trailer while fragments stream past: `header`, then per
/// fragment its bytes and `append(crc, len)` from stored metadata, then `finish`.
pub const Trailer = struct {
    crc: u32 = 0,
    /// ISIZE is modulo 2^32, so truncating on write is correct.
    len: u64 = 0,
    empty: bool = true,

    pub fn append(t: *Trailer, fragment_crc: u32, fragment_len: u64) void {
        if (t.empty) {
            t.crc = fragment_crc;
            t.len = fragment_len;
            t.empty = false;
            return;
        }
        t.crc = crc32Combine(t.crc, fragment_crc, fragment_len);
        t.len += fragment_len;
    }

    pub fn finish(t: *const Trailer, w: *Writer) Writer.Error!void {
        try w.writeAll(&terminator);
        try w.writeInt(u32, t.crc, .little);
        try w.writeInt(u32, @truncate(t.len), .little);
    }
};

// --- tests ------------------------------------------------------------------

const testing = std.testing;

fn expectCombines(parts: []const []const u8) !void {
    var whole: std.hash.Crc32 = .init();
    for (parts) |p| whole.update(p);

    var t: Trailer = .{};
    var total: u64 = 0;
    for (parts) |p| {
        t.append(std.hash.Crc32.hash(p), p.len);
        total += p.len;
    }
    try testing.expectEqual(whole.final(), t.crc);
    try testing.expectEqual(total, t.len);
}

test "crc32Combine: two fragments" {
    try expectCombines(&.{ "hello, ", "world" });
}

test "crc32Combine: an empty fragment is the identity" {
    try testing.expectEqual(
        std.hash.Crc32.hash("abc"),
        crc32Combine(std.hash.Crc32.hash("abc"), std.hash.Crc32.hash(""), 0),
    );
    try expectCombines(&.{ "", "the whole payload" });
    try expectCombines(&.{ "the whole payload", "" });
}

test "crc32Combine: lengths straddling powers of two" {
    // The combine walks the bits of the length; vary them to hit both buffers.
    var buf: [65537]u8 = undefined;
    for (&buf, 0..) |*b, i| b.* = @truncate(i *% 31 +% 7);
    for ([_]usize{
        1,  2,  3,  4,   7,   8,   9,    15,   16,   17,    31,    32,    33,
        63, 64, 65, 255, 256, 257, 1023, 1024, 1025, 65535, 65536, 65537,
    }) |n| {
        try expectCombines(&.{ "prefix bytes that stay put", buf[0..n] });
    }
}

test "crc32Combine: many fragments, JSONL-shaped like the real stream" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var parts: std.ArrayList([]const u8) = .empty;
    var prng = std.Random.DefaultPrng.init(0x5EED);
    const rand = prng.random();
    for (0..200) |_| {
        const buf = try a.alloc(u8, 1 + rand.uintLessThan(usize, 4096));
        for (buf) |*b| b.* = rand.intRangeAtMost(u8, 32, 126);
        try parts.append(a, buf);
    }
    try expectCombines(parts.items);
}

/// Compresses like derive time: raw deflate, flushed, never finished.
fn deriveFragment(a: std.mem.Allocator, payload: []const u8) ![]u8 {
    var out: Writer.Allocating = try .initCapacity(a, 4096);
    errdefer out.deinit();
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var c = try std.compress.flate.Compress.init(&out.writer, &window, .raw, .level_6);
    try c.writer.writeAll(payload);
    try c.writer.flush();
    return out.toOwnedSlice();
}

test "a stitched stream is one valid gzip, and its trailer comes only from stored metadata" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var fragments: std.ArrayList([]const u8) = .empty;
    var crcs: std.ArrayList(u32) = .empty;
    var lens: std.ArrayList(u64) = .empty;
    var expected: Writer.Allocating = .init(a);

    for (0..64) |i| {
        const doc = try std.fmt.allocPrint(
            a,
            "{{\"md5\":\"{x:0>32}\",\"v\":7,\"t\":{{\"reuniao\":[0,3],\"orcamento\":[{d}]}}}}\n",
            .{ i, i % 17 },
        );
        try fragments.append(a, try deriveFragment(a, doc));
        try crcs.append(a, std.hash.Crc32.hash(doc));
        try lens.append(a, doc.len);
        try expected.writer.writeAll(doc);
    }

    var stream: Writer.Allocating = .init(a);
    try stream.writer.writeAll(header);
    var trailer: Trailer = .{};
    for (fragments.items, crcs.items, lens.items) |frag, crc, len| {
        try stream.writer.writeAll(frag);
        trailer.append(crc, len);
    }
    try trailer.finish(&stream.writer);

    const plaintext = expected.written();
    try testing.expectEqual(std.hash.Crc32.hash(plaintext), trailer.crc);
    try testing.expectEqual(plaintext.len, trailer.len);

    // Must decode as one gzip member. `Decompress` doesn't check the footer, so
    // compare it explicitly.
    var input: std.Io.Reader = .fixed(stream.written());
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .gzip, &window);
    var got: Writer.Allocating = .init(a);
    _ = try d.reader.streamRemaining(&got.writer);
    try testing.expectEqualStrings(plaintext, got.written());
    try testing.expectEqual(trailer.crc, d.container_metadata.gzip.crc);
    try testing.expectEqual(@as(u32, @truncate(trailer.len)), d.container_metadata.gzip.count);
}

test "a corrupt trailer disagrees with the payload, which is what gzip rejects on" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const doc = "{\"md5\":\"0\",\"t\":{\"reuniao\":[0]}}\n";
    const frag = try deriveFragment(a, doc);

    var stream: Writer.Allocating = .init(a);
    try stream.writer.writeAll(header);
    try stream.writer.writeAll(frag);
    var trailer: Trailer = .{};
    trailer.append(std.hash.Crc32.hash(doc), doc.len);
    trailer.crc ^= 1; // one flipped bit
    try trailer.finish(&stream.writer);

    var input: std.Io.Reader = .fixed(stream.written());
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .gzip, &window);
    var got: Writer.Allocating = .init(a);
    // Zig decodes it without validating; gzip and browsers reject the CRC.
    _ = try d.reader.streamRemaining(&got.writer);
    try testing.expectEqualStrings(doc, got.written());
    try testing.expect(d.container_metadata.gzip.crc != std.hash.Crc32.hash(got.written()));
}
