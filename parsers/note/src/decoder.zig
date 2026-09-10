//! RATTA_RLE bitmap decoder (the "content tier").
//!
//! Decodes a layer's run-length-encoded bytes into an 8-bit grayscale bitmap,
//! row-major, `width * height` bytes. Two variants exist:
//!   - `.ratta_rle`    : original X-series color codes.
//!   - `.ratta_rle_x2` : A5X2/Nomad high-res grayscale (version >= 20230015).
//!
//! The stream is a sequence of `(colorcode, length)` byte pairs. A length byte
//! of 0xFF means a large fixed run; a length byte with bit 7 set is the high
//! part of a two-byte length resolved against the next pair. Unknown color codes
//! pass through literally as the grayscale value (this is how anti-aliasing gray
//! levels are stored in the X2 variant).
//!
//! Ported (clean reimplementation, not a copy) from the understanding in
//! supernote-tool (Apache-2.0); see note-format.md §6.
//!
//! ## Output is bounded, structurally
//!
//! `decodeInto` writes into a caller-provided fixed buffer and fails with
//! `error.SizeMismatch` the moment a run would overflow it. There is no growable
//! list to balloon: a decoder that grew its output freely and compared sizes
//! only at the end would let a hostile stream of 0xFF markers allocate ~8000x
//! the page size before failing.

const std = @import("std");

pub const Variant = enum { ratta_rle, ratta_rle_x2 };

/// The one decode-level error fact: the stream does not decode to exactly the
/// expected pixel count. Raised the moment output would overflow the
/// destination, or at the end when it underfills it.
pub const DecodeError = error{SizeMismatch};

pub const Error = DecodeError || std.mem.Allocator.Error;

// Grayscale palette values (see color table in note-format.md §7).
const BLACK: u8 = 0x00;
const DARK_GRAY: u8 = 0x9d;
const GRAY: u8 = 0xc9;
const WHITE: u8 = 0xfe;
const TRANSPARENT: u8 = 0xff;
const DARK_GRAY_COMPAT: u8 = 0x30;
const GRAY_COMPAT: u8 = 0x50;

const SPECIAL_LENGTH_MARKER: u8 = 0xff;
const SPECIAL_LENGTH: u32 = 0x4000;
const SPECIAL_LENGTH_FOR_BLANK: u32 = 0x400;

/// The RLE variant a container encodes its bitmaps with, given the signature's
/// high-res grayscale capability. One copy of the fact — `render.zig` and
/// `page_payload.zig` both go through it.
pub fn variantForHighres(highres: bool) Variant {
    return if (highres) .ratta_rle_x2 else .ratta_rle;
}

/// Maps a color code to its grayscale value; unknown codes pass through as-is.
fn grayFor(variant: Variant, code: u8) u8 {
    return switch (variant) {
        .ratta_rle => switch (code) {
            0x61 => BLACK,
            0x62 => TRANSPARENT,
            0x63 => DARK_GRAY,
            0x64 => GRAY,
            0x65 => WHITE,
            0x66 => BLACK,
            0x67 => DARK_GRAY,
            0x68 => GRAY,
            else => code,
        },
        .ratta_rle_x2 => switch (code) {
            0x61 => BLACK,
            0x62 => TRANSPARENT,
            0x65 => WHITE,
            0x66 => BLACK,
            0x9D => DARK_GRAY,
            0xC9 => GRAY,
            0x9E => DARK_GRAY,
            0xCA => GRAY,
            0x63 => DARK_GRAY_COMPAT,
            0x64 => GRAY_COMPAT,
            else => code, // literal pass-through (anti-aliasing grays)
        },
    };
}

const Pair = struct { code: u8, len_byte: u8 };

/// Decodes `data` into `dest`, which must be exactly the page's
/// `width * height` bytes. On success every byte of `dest` has been written.
///
/// Fails fast: a run that would write past `dest.len` is `SizeMismatch`
/// immediately — hostile input costs at most one bounds check, never an
/// allocation.
pub fn decodeInto(dest: []u8, variant: Variant, data: []const u8, all_blank: bool) DecodeError!void {
    var pos: usize = 0;
    var holder: ?Pair = null;
    var i: usize = 0;
    // Each step consumes a (code, length) pair; a lone trailing byte is ignored,
    // matching the reference which stops when it cannot read a full pair.
    while (i + 1 < data.len) : (i += 2) {
        const code = data[i];
        const len_byte = data[i + 1];
        var pushed = false;

        if (holder) |h| {
            holder = null;
            if (code == h.code) {
                // Two-byte length with a matching color: combine.
                const len = 1 + @as(u32, len_byte) + (((@as(u32, h.len_byte) & 0x7f) + 1) << 7);
                try emit(dest, &pos, variant, code, len);
                pushed = true;
            } else {
                // Held run flushes at its high-part length; current pair falls through.
                const held_len = ((@as(u32, h.len_byte) & 0x7f) + 1) << 7;
                try emit(dest, &pos, variant, h.code, held_len);
            }
        }

        if (!pushed) {
            if (len_byte == SPECIAL_LENGTH_MARKER) {
                const len = if (all_blank) SPECIAL_LENGTH_FOR_BLANK else SPECIAL_LENGTH;
                try emit(dest, &pos, variant, code, len);
            } else if (len_byte & 0x80 != 0) {
                holder = .{ .code = code, .len_byte = len_byte }; // resolved next pair
            } else {
                try emit(dest, &pos, variant, code, @as(u32, len_byte) + 1);
            }
        }
    }

    // A dangling held run fills exactly up to the expected size.
    if (holder) |h| {
        const gap = dest.len - pos; // pos <= dest.len: emit is bounded
        const len = tailLength(h.len_byte, gap);
        if (len > 0) try emit(dest, &pos, variant, h.code, len);
    }

    if (pos != dest.len) return error.SizeMismatch;
}

/// Decodes `data` into a fresh `width * height` grayscale bitmap owned by
/// `gpa`. Convenience wrapper over `decodeInto`; exactly one allocation.
pub fn decode(
    gpa: std.mem.Allocator,
    variant: Variant,
    data: []const u8,
    width: u32,
    height: u32,
    all_blank: bool,
) Error![]u8 {
    const expected: usize = @as(usize, width) * @as(usize, height);
    const out = try gpa.alloc(u8, expected);
    errdefer gpa.free(out);
    try decodeInto(out, variant, data, all_blank);
    return out;
}

/// A resumable pass that **sums a RATTA_RLE stream's run lengths** without
/// writing any pixels, fed a chunk at a time so a multi-MB background costs one
/// chunk of RSS rather than its own size. It walks the SAME `(code, len)`
/// grammar `decodeInto` enforces (with `all_blank = false`), stops the
/// arithmetic once the total passes `expected`, and `done()` reports whether the
/// stream totalled EXACTLY `expected`.
///
/// Chunk-straddling is handled via `pending`, so feeding `data` in any chunking
/// yields the same verdict as one `feed(data)` — and the same verdict
/// `decodeInto` reaches on the whole slice.
pub const RleTotalizer = struct {
    expected: u64,
    pos: u64 = 0,
    holder: ?Pair = null,
    /// A byte from the end of a previous chunk, awaiting its pair partner.
    pending: ?u8 = null,
    overflow: bool = false,

    pub fn init(expected: u64) RleTotalizer {
        return .{ .expected = expected };
    }

    /// Adds `chunk` to the running total. Cheap and early-exiting once overflow
    /// is known.
    pub fn feed(self: *RleTotalizer, chunk: []const u8) void {
        if (self.overflow) return;
        var i: usize = 0;
        // A byte held from the previous chunk pairs with this chunk's first byte.
        if (self.pending) |p| {
            if (chunk.len == 0) return;
            self.step(p, chunk[0]);
            self.pending = null;
            i = 1;
            if (self.overflow) return;
        }
        // Whole pairs within the chunk.
        while (i + 1 < chunk.len) : (i += 2) {
            self.step(chunk[i], chunk[i + 1]);
            if (self.overflow) return;
        }
        // A lone leftover byte is carried, not dropped: it may pair with the
        // first byte of the next chunk.
        if (i < chunk.len) self.pending = chunk[i];
    }

    /// Finalizes any dangling two-byte-length run (the same tail rule
    /// `decodeInto` applies) and reports whether the total is EXACTLY `expected`.
    pub fn done(self: *RleTotalizer) bool {
        if (self.overflow) return false;
        if (self.holder) |h| {
            const gap: usize = @intCast(self.expected - self.pos); // pos <= expected: every add was bounded
            const len = tailLength(h.len_byte, gap);
            if (len > 0) self.pos += len;
        }
        return self.pos == self.expected;
    }

    /// One `(code, len_byte)` pair — line-for-line the length arithmetic of
    /// `decodeInto`'s loop body, minus the pixel writes.
    fn step(self: *RleTotalizer, code: u8, len_byte: u8) void {
        var pushed = false;
        if (self.holder) |h| {
            self.holder = null;
            if (code == h.code) {
                self.add(1 + @as(u64, len_byte) + (((@as(u64, h.len_byte) & 0x7f) + 1) << 7));
                pushed = true;
            } else {
                self.add(((@as(u64, h.len_byte) & 0x7f) + 1) << 7);
            }
        }
        if (!pushed) {
            if (len_byte == SPECIAL_LENGTH_MARKER) {
                self.add(SPECIAL_LENGTH);
            } else if (len_byte & 0x80 != 0) {
                self.holder = .{ .code = code, .len_byte = len_byte };
            } else {
                self.add(@as(u64, len_byte) + 1);
            }
        }
    }

    fn add(self: *RleTotalizer, n: u64) void {
        self.pos += n;
        if (self.pos > self.expected) self.overflow = true;
    }
};

/// The one colour code that is NOT a mark: `0x62`, which decodes to the
/// transparent sentinel `0xFF` in BOTH colour tables (`note-format.md` §7.1).
/// Every other code — named, marker, or an unlisted anti-aliasing grey passing
/// through literally — paints something.
pub const TRANSPARENT_CODE: u8 = 0x62;

/// **Is there a mark anywhere in this RATTA_RLE stream?** `RleTotalizer`'s
/// sibling, fed a chunk at a time in the same way, asking one question instead
/// of summing: does any run carry a colour code other than `TRANSPARENT_CODE`?
///
/// **AND IT STOPS AT THE FIRST ONE.** That early exit is the whole cost story:
/// a WRITTEN page returns on the first stroke and never reads the rest of the
/// layer, while the only stream that scans to the end is one with no ink at all
/// — a handful of long transparent runs. The expensive case is the rare one.
///
/// ## It walks pairs, not lengths — and that is not a shortcut
///
/// `RleTotalizer` reproduces `decodeInto`'s length arithmetic because it needs
/// the TOTAL. This needs only the colours, which the grammar hands over
/// positionally. A held two-byte length changes how many pixels a pair emits and
/// never what colour they are: resolved against a matching next pair it is one
/// run of that shared colour, resolved against a different one it emits the held
/// run then the current one — both already counted here.
///
/// The end-of-stream tail rule is the one place the two could differ: a pair
/// still held at EOF emits nothing when no length fits the remaining gap, and
/// this counts its colour anyway. That needs a stream that both ends mid-pair
/// AND underfills its page, which is malformed; calling it inked is the safe
/// direction, because the failure it avoids is telling someone their written
/// page is empty.
///
/// **`0x65` COUNTS**, and it is a judgement rather than a reading. It decodes to
/// `0xFE` — an opaque near-white that MASKS the layer below rather than letting
/// it through, a difference `note-format.md` §7.1 calls load-bearing. Someone
/// drawing with a white pen has written on the page.
///
/// No `variant`: `0x62` is transparent in both tables, so the answer is
/// colour-table-independent for the same reason `decodesToExactly` is. A lone
/// trailing byte at the true end is ignored, exactly as `decodeInto` and
/// `RleTotalizer` ignore it.
pub const InkFinder = struct {
    found: bool = false,
    /// A byte from the end of a previous chunk, awaiting its pair partner.
    /// Carried so that feeding `data` in any chunking gives the same verdict as
    /// one `feed(data)` — the pairing is positional and must survive a split.
    pending: ?u8 = null,

    pub fn init() InkFinder {
        return .{};
    }

    /// A no-op once ink is found, so a caller that keeps feeding costs nothing
    /// — but the caller that stops reading is the one this is built for.
    pub fn feed(self: *InkFinder, chunk: []const u8) void {
        if (self.found) return;
        var i: usize = 0;
        // A byte held from the previous chunk pairs with this chunk's first byte.
        if (self.pending) |p| {
            if (chunk.len == 0) return;
            if (p != TRANSPARENT_CODE) {
                self.found = true;
                return;
            }
            self.pending = null;
            i = 1;
        }
        // Whole pairs within the chunk: the code is the first byte of each.
        while (i + 1 < chunk.len) : (i += 2) {
            if (chunk[i] != TRANSPARENT_CODE) {
                self.found = true;
                return;
            }
        }
        // A lone leftover byte is carried, not dropped: it may pair with the
        // first byte of the next chunk.
        if (i < chunk.len) self.pending = chunk[i];
    }

    /// Nothing is deferred to the end — this is `found` — but it is spelt as a
    /// call so the shape reads like `RleTotalizer`'s.
    pub fn done(self: *const InkFinder) bool {
        return self.found;
    }
};

/// `InkFinder` over a whole slice, for callers holding the layer's bytes
/// already. The streaming callers drive the struct instead, so they can stop
/// READING at the first stroke — which is where the saving actually is.
pub fn hasInk(data: []const u8) bool {
    var f = InkFinder.init();
    f.feed(data);
    return f.done();
}

/// **Does `data` decode as a RATTA_RLE stream of exactly `expected_pixels`
/// pixels?** The "looks like RLE? else treat it as a browser-native image" gate:
/// a PNG/JPG/WEBP fed here fails the total essentially always, so the caller
/// defaults it to "image" with no per-format magic allowlist to maintain.
///
/// Mirrors `decodeInto` with `all_blank = false`: the classifier is only ever
/// asked about a page's BACKGROUND under a custom style, which is never the
/// `style_white` blank-fill shortcut (that path is known RLE and skips this
/// check), so the `0xFF` special-length marker resolves to `SPECIAL_LENGTH`.
/// Takes no `variant`: the pixel COUNT is colour-independent — only run lengths
/// matter, never the grayscale mapping.
pub fn decodesToExactly(data: []const u8, expected_pixels: u64) bool {
    var t = RleTotalizer.init(expected_pixels);
    t.feed(data);
    return t.done();
}

/// The bound that turns "decode then notice it was too big" into "never produce
/// more than asked for".
fn emit(dest: []u8, pos: *usize, variant: Variant, code: u8, len: u32) DecodeError!void {
    const n: usize = len;
    if (dest.len - pos.* < n) return error.SizeMismatch;
    @memset(dest[pos.*..][0..n], grayFor(variant, code));
    pos.* += n;
}

/// Largest `((tail & 0x7f)+1) << i` (i in 7..0) that fits in `gap`.
fn tailLength(tail: u8, gap: usize) u32 {
    var i: u5 = 8;
    while (i > 0) {
        i -= 1;
        const l = ((@as(u32, tail) & 0x7f) + 1) << i;
        if (l <= gap) return l;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "single short run" {
    const gpa = std.testing.allocator;
    // black, length byte 0 => run of 1.
    const out = try decode(gpa, .ratta_rle_x2, &.{ 0x61, 0x00 }, 1, 1, false);
    defer gpa.free(out);
    try std.testing.expectEqualSlices(u8, &.{BLACK}, out);
}

test "background code maps to transparent" {
    const gpa = std.testing.allocator;
    const out = try decode(gpa, .ratta_rle_x2, &.{ 0x62, 0x04 }, 5, 1, false); // len 4+1
    defer gpa.free(out);
    try std.testing.expectEqualSlices(u8, &(.{TRANSPARENT} ** 5), out);
}

test "two-byte length, matching color, combines" {
    const gpa = std.testing.allocator;
    // 0x81 has bit7 set -> held; next matching -> 1 + 0 + ((1+1)<<7) = 257.
    const out = try decode(gpa, .ratta_rle_x2, &.{ 0x61, 0x81, 0x61, 0x00 }, 257, 1, false);
    defer gpa.free(out);
    try std.testing.expectEqual(@as(usize, 257), out.len);
    for (out) |b| try std.testing.expectEqual(BLACK, b);
}

test "two-byte length, non-matching color, flushes held run then current" {
    const gpa = std.testing.allocator;
    // held (0x61,0x81) -> 256 black; then (0x62,0x00) -> 1 transparent.
    const out = try decode(gpa, .ratta_rle_x2, &.{ 0x61, 0x81, 0x62, 0x00 }, 257, 1, false);
    defer gpa.free(out);
    try std.testing.expectEqual(@as(usize, 257), out.len);
    try std.testing.expectEqual(BLACK, out[255]);
    try std.testing.expectEqual(TRANSPARENT, out[256]);
}

test "x2 literal pass-through for anti-aliasing gray codes" {
    const gpa = std.testing.allocator;
    // 0x3f is not a named code -> passes through literally as gray 0x3f.
    const out = try decode(gpa, .ratta_rle_x2, &.{ 0x3f, 0x02 }, 3, 1, false);
    defer gpa.free(out);
    try std.testing.expectEqualSlices(u8, &.{ 0x3f, 0x3f, 0x3f }, out);
}

test "size mismatch is reported" {
    const gpa = std.testing.allocator;
    try std.testing.expectError(error.SizeMismatch, decode(gpa, .ratta_rle_x2, &.{ 0x61, 0x00 }, 10, 10, false));
}

test "decodeInto fills a caller-provided buffer exactly" {
    var buf: [5]u8 = undefined;
    try decodeInto(&buf, .ratta_rle_x2, &.{ 0x62, 0x04 }, false);
    try std.testing.expectEqualSlices(u8, &(.{TRANSPARENT} ** 5), &buf);
}

test "decodeInto: a too-small destination fails on the overflowing run" {
    // Stream decodes to 5 pixels; buffer holds 3 -> refused at the emit, and
    // the fourth/fifth pixel positions are never touched (there aren't any).
    var buf: [3]u8 = undefined;
    try std.testing.expectError(
        error.SizeMismatch,
        decodeInto(&buf, .ratta_rle_x2, &.{ 0x62, 0x04 }, false),
    );
}

test "decodeInto: a stream that underfills the destination is refused too" {
    var buf: [100]u8 = undefined;
    try std.testing.expectError(
        error.SizeMismatch,
        decodeInto(&buf, .ratta_rle_x2, &.{ 0x61, 0x00 }, false),
    );
}

test "hostile stream fails on its first oversized run — no ballooning" {
    // Each (code, 0xFF) pair emits a 0x4000-pixel run — ~8000x a 2x2 page for a
    // decoder that appends first and compares sizes at the end. The
    // FailingAllocator permits exactly ONE allocation (the 4-byte output), so
    // growing anything would be OutOfMemory; SizeMismatch means it never asked.
    const gpa = std.testing.allocator;
    var failing = std.testing.FailingAllocator.init(gpa, .{ .fail_index = 1 });
    const data = [_]u8{ 0x61, 0xFF } ** 64;
    try std.testing.expectError(
        error.SizeMismatch,
        decode(failing.allocator(), .ratta_rle_x2, &data, 2, 2, false),
    );
}

test "variantForHighres maps capability to variant" {
    try std.testing.expectEqual(Variant.ratta_rle_x2, variantForHighres(true));
    try std.testing.expectEqual(Variant.ratta_rle, variantForHighres(false));
}

test "decodesToExactly: a well-formed RLE stream totalling the expected pixels passes" {
    // (0x62 transparent, len 4+1 = 5) over a 5-pixel page.
    try std.testing.expect(decodesToExactly(&.{ 0x62, 0x04 }, 5));
    // Single black pixel.
    try std.testing.expect(decodesToExactly(&.{ 0x61, 0x00 }, 1));
    // Two-byte length, matching colour -> 257.
    try std.testing.expect(decodesToExactly(&.{ 0x61, 0x81, 0x61, 0x00 }, 257));
    // Two-byte length, non-matching colour flushes 256 then 1.
    try std.testing.expect(decodesToExactly(&.{ 0x61, 0x81, 0x62, 0x00 }, 257));
}

test "decodesToExactly: an over- or under-filling RLE stream is rejected" {
    // Decodes to 5 pixels; asked for 3 -> the run overflows.
    try std.testing.expect(!decodesToExactly(&.{ 0x62, 0x04 }, 3));
    // Decodes to 1 pixel; asked for 100 -> underfills.
    try std.testing.expect(!decodesToExactly(&.{ 0x61, 0x00 }, 100));
}

test "decodesToExactly: image magic bytes fail the total (default-to-image)" {
    // A browser-native image fed to the RLE grammar does not total the page's
    // pixel count: real Ratta pages are 1404x1872 and up, so these tiny
    // magic-byte prefixes cannot possibly sum to one.
    const page_pixels: u64 = 1404 * 1872;
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A ...
    const png = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D };
    try std.testing.expect(!decodesToExactly(&png, page_pixels));
    // JPEG SOI + APP0: FF D8 FF E0 00 10 4A 46 49 46 ...
    const jpeg = [_]u8{ 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46 };
    try std.testing.expect(!decodesToExactly(&jpeg, page_pixels));
    // WEBP: RIFF ....WEBP
    const webp = [_]u8{ 0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50 };
    try std.testing.expect(!decodesToExactly(&webp, page_pixels));
}

test "decodesToExactly: agrees with decodeInto on whether a stream is valid RLE" {
    // Cross-check: for a handful of streams, decodesToExactly must return true
    // exactly when decodeInto succeeds at the same expected size.
    const cases = [_]struct { data: []const u8, px: u32 }{
        .{ .data = &.{ 0x62, 0x04 }, .px = 5 },
        .{ .data = &.{ 0x61, 0x00 }, .px = 1 },
        .{ .data = &.{ 0x61, 0x81, 0x61, 0x00 }, .px = 257 },
        .{ .data = &.{ 0x3f, 0x02 }, .px = 3 },
        .{ .data = &.{ 0x62, 0x04 }, .px = 3 }, // overflow
        .{ .data = &.{ 0x61, 0x00 }, .px = 10 }, // underflow
    };
    const gpa = std.testing.allocator;
    for (cases) |c| {
        const buf = try gpa.alloc(u8, c.px);
        defer gpa.free(buf);
        const decode_ok = if (decodeInto(buf, .ratta_rle_x2, c.data, false)) |_| true else |_| false;
        try std.testing.expectEqual(decode_ok, decodesToExactly(c.data, c.px));
    }
}

test "RleTotalizer: chunked feed matches a single feed for the same stream" {
    // A stream with a two-byte-length pair, split at every possible boundary,
    // must reach the same verdict as feeding it whole.
    const data = [_]u8{ 0x61, 0x81, 0x61, 0x00, 0x62, 0x03 }; // 257 black + 4 transparent = 261
    const expected: u64 = 261;
    // Whole feed.
    try std.testing.expect(decodesToExactly(&data, expected));
    // Every split point, including one that straddles a pair.
    for (0..data.len + 1) |cut| {
        var t = RleTotalizer.init(expected);
        t.feed(data[0..cut]);
        t.feed(data[cut..]);
        try std.testing.expect(t.done());
    }
    // And a three-way split down to one byte at a time.
    var t1 = RleTotalizer.init(expected);
    for (data) |b| t1.feed(&[_]u8{b});
    try std.testing.expect(t1.done());
}

test "decodesToExactly: a dangling held run fills to exactly expected" {
    // (0x61, 0x81) alone: bit7 set, no following pair -> the tail fills up to the
    // expected size. tailLength picks the largest ((0x01)+1)<<i <= gap.
    // gap 256 -> 2<<7 = 256 exactly.
    try std.testing.expect(decodesToExactly(&.{ 0x61, 0x81 }, 256));
    // gap 100 -> largest 2<<i <= 100 is 2<<5 = 64, leaving pos=64 != 100 -> false.
    try std.testing.expect(!decodesToExactly(&.{ 0x61, 0x81 }, 100));
}

test "InkFinder: a transparent-only stream has no ink; one stroke anywhere has" {
    // The whole grammar in miniature. An all-transparent layer — what a blank
    // page's main layer is — reads 0; a single black pixel among a page of
    // nothing reads 1.
    try std.testing.expect(!hasInk(&.{ 0x62, 0xFF }));
    try std.testing.expect(!hasInk(&.{ 0x62, 0xFF, 0x62, 0xFF, 0x62, 0x0A }));
    try std.testing.expect(hasInk(&.{ 0x61, 0x00 }));
    try std.testing.expect(hasInk(&.{ 0x62, 0xFF, 0x62, 0xFF, 0x61, 0x00 }));
    // Empty is not ink. A layer with no bytes has nothing on it.
    try std.testing.expect(!hasInk(&.{}));
}

test "InkFinder: 0xFE (code 0x65) IS ink — a white pen is a pen" {
    // `0x65` decodes to an opaque near-white that MASKS what is under it, one
    // step from the `0xFF` transparent sentinel. Reading it as blank would tell
    // a user who drew in white that their page is empty.
    try std.testing.expect(hasInk(&.{ 0x65, 0x00 }));
    try std.testing.expectEqual(WHITE, grayFor(.ratta_rle, 0x65));
    try std.testing.expectEqual(WHITE, grayFor(.ratta_rle_x2, 0x65));
    try std.testing.expect(WHITE != TRANSPARENT);
}

test "InkFinder: held two-byte lengths are pairs like any other, in both resolutions" {
    // The held pair is where a colour-only walk could have gone wrong, so both
    // resolutions are driven: matching (one combined run) and non-matching (the
    // held run flushed, then the current one).
    try std.testing.expect(!hasInk(&.{ 0x62, 0x81, 0x62, 0x00 })); // 257 transparent
    try std.testing.expect(hasInk(&.{ 0x61, 0x81, 0x61, 0x00 })); // 257 black
    try std.testing.expect(hasInk(&.{ 0x62, 0x81, 0x61, 0x00 })); // 256 transparent, then black
    try std.testing.expect(hasInk(&.{ 0x61, 0x81, 0x62, 0x00 })); // black held, flushed by transparent
    // A dangling held transparent run is still transparent.
    try std.testing.expect(!hasInk(&.{ 0x62, 0x81 }));
    try std.testing.expect(hasInk(&.{ 0x61, 0x81 }));
}

test "InkFinder: a lone trailing byte is not a run, here as in decodeInto" {
    // An odd-length stream's last byte never pairs, so `decodeInto` ignores it
    // and so does this. A stream that ends on a would-be colour code has not
    // painted anything with it.
    try std.testing.expect(!hasInk(&.{0x61}));
    try std.testing.expect(!hasInk(&.{ 0x62, 0x04, 0x61 }));
}

test "InkFinder: chunked feed matches a single feed at every split point" {
    // The `RleTotalizer` property: a pair straddling a window boundary must not
    // shift the parity of everything after it. Driven on a stream whose ONLY
    // mark is the last pair, so a lost byte flips the answer.
    const inked = [_]u8{ 0x62, 0xFF, 0x62, 0xFF, 0x62, 0xFF, 0x61, 0x00 };
    const blank = [_]u8{ 0x62, 0xFF, 0x62, 0xFF, 0x62, 0xFF, 0x62, 0x00 };
    for (0..inked.len + 1) |cut| {
        var a = InkFinder.init();
        a.feed(inked[0..cut]);
        a.feed(inked[cut..]);
        try std.testing.expect(a.done());

        var b = InkFinder.init();
        b.feed(blank[0..cut]);
        b.feed(blank[cut..]);
        try std.testing.expect(!b.done());
    }
    // And one byte at a time, which is every boundary at once.
    var one = InkFinder.init();
    for (inked) |x| one.feed(&[_]u8{x});
    try std.testing.expect(one.done());
    var none = InkFinder.init();
    for (blank) |x| none.feed(&[_]u8{x});
    try std.testing.expect(!none.done());
}

test "InkFinder: it stops at the first stroke — the rest of the layer is never read" {
    // The performance claim, asserted structurally rather than timed: `feed`
    // returns the moment ink is found, so a streaming caller can stop READING.
    var f = InkFinder.init();
    f.feed(&.{ 0x61, 0x00 });
    try std.testing.expect(f.found);
    try std.testing.expect(f.pending == null); // it did not walk on to carry a byte

    // The same, mid-chunk: a 4 KB transparent run followed by one stroke and
    // then more bytes. `found` latches, and nothing after it can clear it.
    var g = InkFinder.init();
    g.feed(&([_]u8{ 0x62, 0xFF } ** 2048));
    try std.testing.expect(!g.found);
    g.feed(&.{ 0x61, 0x00 });
    try std.testing.expect(g.found);
    g.feed(&([_]u8{ 0x62, 0xFF } ** 2048));
    try std.testing.expect(g.done());
}

test "InkFinder: every named colour code but 0x62 is ink, and unlisted greys are too" {
    // Anything not `0x62` paints — named codes, marker codes, X2 greys, and
    // every anti-aliasing level passing through literally (`note-format.md`
    // §7.1). Driven as the rule rather than as a list of examples.
    var code: u16 = 0;
    while (code <= 0xFF) : (code += 1) {
        const c: u8 = @intCast(code);
        const stream = [_]u8{ c, 0x00 };
        try std.testing.expectEqual(c != TRANSPARENT_CODE, hasInk(&stream));
    }
}
