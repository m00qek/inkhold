//! Stitching stored deflate fragments into ONE gzip stream: serving costs a
//! header, N file reads and a trailer — no compression,
//! no decompression — on a Pi 1 B+.
//!
//! Must not break:
//!   * Concatenated `.gz` MEMBERS are not an option: under `Content-Encoding:
//!     gzip` Chromium and curl decode the FIRST member only and report success
//!     (37 bytes of 7,980, §3.1). Node's zlib decodes them all, so a Node test
//!     passes on a stream the browser truncates.
//!   * Fragments are raw deflate, byte-aligned, `flush()` and never `finish()`
//!     (`byteAlignBlocks()`), so none carries BFINAL and they concatenate into
//!     one deflate stream under a single header and trailer.
//!   * `std.hash.Crc32` has no combine primitive; `crc32Combine` is zlib's.
//!   * `std.compress.flate.Decompress` reads the gzip footer and NEVER verifies
//!     it: `WrongGzipChecksum` is declared in std and raised nowhere. A check
//!     must compare `container_metadata.gzip` against its own hash of the
//!     output, as the tests do. `gzip -t` and every browser do reject on it.

const std = @import("std");
const assert = std.debug.assert;
const Writer = std.Io.Writer;

/// The 10-byte gzip header, straight from `std.compress.flate`.
pub const header = std.compress.flate.Container.gzip.header();

/// The empty FINAL stored block (BFINAL=1, BTYPE=00, padded to a byte). No
/// fragment carries one; exactly one goes at the end.
pub const terminator = [_]u8{ 0x03, 0x00 };

// --- crc32Combine -----------------------------------------------------------

const dim = 32;
/// CRC-32, reflected — `std.hash.Crc32` (ISO-HDLC) and gzip's polynomial.
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

/// `square = mat * mat` — the operator for twice as many zero bits.
fn matrixSquare(square: *[dim]u32, mat: *const [dim]u32) void {
    for (0..dim) |n| square[n] = matrixTimes(mat, mat[n]);
}

/// `crc(A ++ B)` from `crc(A)`, `crc(B)` and B's length — no plaintext needed.
///
/// CRC32 is linear over GF(2), so appending `len_b` zero bytes is a linear
/// operator: `crc(A ++ B) = zeros_op(len_b) * crc(A) XOR crc(B)`. zlib's
/// method: "advance one zero BIT" as a 32x32 GF(2) bit-matrix, squared to get
/// "advance 2^k bits", walking the bits of `len_b` — O(log n).
///
/// Operates on FINAL, post-conditioned values (what `std.hash.Crc32.final()`
/// returns): gzip's `init`/`xorout` conditionings cancel across the
/// concatenation, so the missing unconditioning is correct, not an omission.
pub fn crc32Combine(crc_a: u32, crc_b: u32, len_b: u64) u32 {
    // Not only an identity: the loop is do-while shaped and would apply one
    // squaring to a zero length.
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
    // Walks the bits of `len_b`, alternating buffers to avoid a copy.
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

/// Accumulates the trailer while fragments stream past: write `header`, then per
/// fragment its bytes and `append(crc, len)` from the numbers stored beside it,
/// then `finish`. A missing fragment is simply not appended (§3.3).
pub const Trailer = struct {
    crc: u32 = 0,
    /// Truncated only when written: ISIZE is defined modulo 2^32, so wrapping
    /// is correct rather than an overflow to guard.
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

    /// The terminating block, then the 8-byte gzip trailer.
    pub fn finish(t: *const Trailer, w: *Writer) Writer.Error!void {
        try w.writeAll(&terminator);
        try w.writeInt(u32, t.crc, .little);
        try w.writeInt(u32, @truncate(t.len), .little);
    }
};

// --- tests ------------------------------------------------------------------

const testing = std.testing;

/// The property the trailer depends on: combining per-fragment CRCs must equal
/// the CRC of the whole plaintext.
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
    // The combine walks the BITS of the length, so uniform sizes would exercise
    // one path through the loop and hide the alternation between `odd`/`even`.
    var buf: [65537]u8 = undefined;
    for (&buf, 0..) |*b, i| b.* = @truncate(i *% 31 +% 7);
    for ([_]usize{
        1, 2, 3, 4, 7, 8, 9, 15, 16, 17, 31, 32, 33,
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

/// Compress `payload` the way DERIVE TIME does: raw deflate, `flush()` and never
/// `finish()`, so the fragment carries no BFINAL block and is byte-aligned.
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

    // Derive time: each document compressed independently. Only the fragment,
    // its CRC and its length are kept — the plaintext is NOT retained by the
    // serve path, and `expected` below exists solely so the test can check.
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

    // Serve time: header, fragments, trailer. No compression, no plaintext.
    var stream: Writer.Allocating = .init(a);
    try stream.writer.writeAll(header);
    var trailer: Trailer = .{};
    for (fragments.items, crcs.items, lens.items) |frag, crc, len| {
        try stream.writer.writeAll(frag);
        trailer.append(crc, len);
    }
    try trailer.finish(&stream.writer);

    // The trailer must match a CRC taken over the real concatenation...
    const plaintext = expected.written();
    try testing.expectEqual(std.hash.Crc32.hash(plaintext), trailer.crc);
    try testing.expectEqual(plaintext.len, trailer.len);

    // ...and the whole thing must decode as ONE gzip member, recovering every
    // document. This is what proves the fragments concatenate: 64 independently
    // compressed pieces, one deflate stream.
    //
    // NOTE `Decompress` does NOT check the footer (see the header), so the
    // trailer is verified explicitly against what it parsed — which is exactly
    // the comparison `gzip -t` and the browser make.
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
    // Zig decodes it happily — it does not validate. The payload is intact; it
    // is the TRAILER that lies, and a validating decoder (gzip, every browser)
    // is what turns that into "invalid compressed data--crc error".
    _ = try d.reader.streamRemaining(&got.writer);
    try testing.expectEqualStrings(doc, got.written());
    try testing.expect(d.container_metadata.gzip.crc != std.hash.Crc32.hash(got.written()));
}
