//! Stitching stored deflate fragments into ONE gzip stream — the transport
//! `golden-search.md` §3.2 specifies, and the arithmetic that makes it possible.
//!
//! ## Why this exists
//!
//! The search stream serves per-document records that were compressed ONCE, at
//! derive time. Serving is meant to cost a header, N file reads and a footer:
//! no compression, no decompression, no query interpretation, because the thing
//! doing it is a Pi 1 B+.
//!
//! The obvious way to do that — concatenate ordinary `.gz` members — **is broken
//! and fails SILENTLY**. Under `Content-Encoding: gzip` Chromium (and curl)
//! decode the FIRST MEMBER ONLY and report success: 37 bytes delivered out of
//! 7,980, `fetch()` resolving happily. §3.1. Node's zlib decodes all members,
//! which is worse than useless — it means a Node test PASSES on a stream the
//! browser truncates by 99.5%.
//!
//! So the fragments are **raw deflate, byte-aligned, with no BFINAL block**
//! (`Container.raw` + `Compress.flush`, which ends in `byteAlignBlocks()`).
//! Concatenated they are one valid deflate stream, and wrapping that in a single
//! gzip header and trailer yields a single-member gzip that every decoder agrees
//! about.
//!
//! ## The part that needs arithmetic
//!
//! The gzip trailer is the CRC32 of the whole uncompressed payload and its
//! total length — but the serve path never sees a plaintext byte. All it has is
//! each fragment and the two numbers stored beside it. `crc32Combine` turns
//! per-fragment CRCs into the CRC of their concatenation, which is what lets the
//! trailer exist without inflating anything.
//!
//! **`std.hash.Crc32` has no combine primitive** (checked: `std/hash/crc.zig` is
//! a generic `Crc(...)` builder over many polynomials, and none expose one), so
//! it is written here.
//!
//! Getting the trailer wrong fails LOUDLY in the places that matter — `gzip -t`
//! reports "invalid compressed data--crc error", and browsers reject the body.
//! That is the opposite of §3.1's failure mode and is the reason this is a safe
//! thing to compute rather than a risky one.
//!
//! **But do not expect Zig to tell you.** `std.compress.flate.Decompress` reads
//! the gzip footer into `container_metadata` and **never verifies it**:
//! `Container.Error.WrongGzipChecksum` is declared and, as of this writing, is
//! raised nowhere in the standard library. A caller wanting validation must
//! compare `container_metadata.gzip` against its own hash of the output, which
//! is what the tests below do. Worth knowing before writing a server-side check
//! that would silently pass everything.

const std = @import("std");
const assert = std.debug.assert;
const Writer = std.Io.Writer;

/// The 10-byte gzip header, straight from `std.compress.flate`. Named here so a
/// serve path reads as header/body/trailer rather than reaching into flate for
/// one constant.
pub const header = std.compress.flate.Container.gzip.header();

/// The empty FINAL stored block that terminates the deflate stream: BFINAL=1,
/// BTYPE=00, then the padding to a byte boundary. Every fragment was written
/// with `flush()` rather than `finish()` precisely so that none of them carries
/// this, and exactly one of them appears here at the end.
pub const terminator = [_]u8{ 0x03, 0x00 };

// --- crc32Combine -----------------------------------------------------------

const dim = 32;
/// The CRC-32 polynomial, reflected — the same one `std.hash.Crc32` (ISO-HDLC)
/// uses, and therefore the same one gzip requires.
const poly: u32 = 0xedb88320;

/// Multiply a GF(2) bit-vector by a bit-matrix: XOR together the rows the vector
/// selects.
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

/// `crc(A ++ B)` from `crc(A)`, `crc(B)` and the LENGTH of B in bytes — neither
/// plaintext required.
///
/// CRC32 is linear over GF(2), so appending `len_b` zero bytes to A is a linear
/// operator on the 32-bit register and
///
///     crc(A ++ B) = zeros_op(len_b) * crc(A)  XOR  crc(B)
///
/// Applying that a byte at a time would be O(len_b), which would defeat the
/// point. This is zlib's approach: represent "advance one zero BIT" as a 32x32
/// bit-matrix over GF(2) and repeatedly SQUARE it to get "advance 2^k bits",
/// then walk the bits of `len_b` multiplying in the matching square. O(log n),
/// ~64 tiny matrix operations for any length that can exist.
///
/// It operates on FINAL, post-conditioned CRC values — the ones
/// `std.hash.Crc32.final()` returns — because gzip's `init = 0xFFFFFFFF` /
/// `xorout = 0xFFFFFFFF` conditionings cancel across the concatenation. That is
/// why no unconditioning appears below; its absence is correct, not an omission.
pub fn crc32Combine(crc_a: u32, crc_b: u32, len_b: u64) u32 {
    // An empty B leaves A's checksum untouched. Worth an early return as well as
    // a correctness note: the loop below is do-while shaped and would apply one
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
    // Each squaring doubles the byte count, so this walks the bits of `len_b`,
    // alternating which buffer holds the current operator to avoid a copy.
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

/// Accumulates the trailer while fragments stream past, so the serve path never
/// holds the payload.
///
/// Usage: write `header`, then for each stored fragment write its bytes and call
/// `append` with the CRC32 and uncompressed length recorded beside it, then
/// `finish`. A fragment whose file is MISSING is skipped entirely — it is simply
/// not appended, and the stream stays valid (§3.3).
pub const Trailer = struct {
    crc: u32 = 0,
    /// Total uncompressed length. Kept at u64 and truncated only when written:
    /// ISIZE is defined modulo 2^32, so wrapping is correct rather than an
    /// overflow to guard.
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

    /// Write the terminating block and the 8-byte gzip trailer.
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
