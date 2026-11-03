//! RATTA_RLE bitmap decoder (`note-format.md` §7.1): `(colorcode, length)`
//! pairs into 8-bit grayscale. A clean reimplementation of supernote-tool's
//! understanding. Output goes into a fixed buffer and fails the moment a run
//! would overflow, so hostile 0xFF runs cannot balloon memory.

const std = @import("std");

pub const Variant = enum { ratta_rle, ratta_rle_x2 };

/// The stream does not decode to exactly the expected pixel count.
pub const DecodeError = error{SizeMismatch};

pub const Error = DecodeError || std.mem.Allocator.Error;

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

/// The RLE variant for a signature's high-res grayscale capability.
pub fn variantForHighres(highres: bool) Variant {
    return if (highres) .ratta_rle_x2 else .ratta_rle;
}

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

/// Decodes `data` into `dest` (exactly `width * height`). An overflowing run is
/// `SizeMismatch` immediately, never an allocation.
pub fn decodeInto(dest: []u8, variant: Variant, data: []const u8, all_blank: bool) DecodeError!void {
    var pos: usize = 0;
    var holder: ?Pair = null;
    var i: usize = 0;
    // A lone trailing byte is ignored, as in the reference.
    while (i + 1 < data.len) : (i += 2) {
        const code = data[i];
        const len_byte = data[i + 1];
        var pushed = false;

        if (holder) |h| {
            holder = null;
            if (code == h.code) {
                const len = 1 + @as(u32, len_byte) + (((@as(u32, h.len_byte) & 0x7f) + 1) << 7);
                try emit(dest, &pos, variant, code, len);
                pushed = true;
            } else {
        // The held run flushes at its high-part length; the current pair follows.
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

    if (holder) |h| {
        const gap = dest.len - pos; // pos <= dest.len: emit is bounded
        const len = tailLength(h.len_byte, gap);
        if (len > 0) try emit(dest, &pos, variant, h.code, len);
    }

    if (pos != dest.len) return error.SizeMismatch;
}

/// `decodeInto` into a fresh bitmap owned by `gpa`.
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

/// Sums a stream's run lengths chunk by chunk without writing pixels, using
/// `decodeInto`'s grammar (`all_blank = false`); any chunking gives the same
/// verdict. `done()` reports whether the total is exactly `expected`.
pub const RleTotalizer = struct {
    expected: u64,
    pos: u64 = 0,
    holder: ?Pair = null,
    pending: ?u8 = null,
    overflow: bool = false,

    pub fn init(expected: u64) RleTotalizer {
        return .{ .expected = expected };
    }

    pub fn feed(self: *RleTotalizer, chunk: []const u8) void {
        if (self.overflow) return;
        var i: usize = 0;
        if (self.pending) |p| {
            if (chunk.len == 0) return;
            self.step(p, chunk[0]);
            self.pending = null;
            i = 1;
            if (self.overflow) return;
        }
        while (i + 1 < chunk.len) : (i += 2) {
            self.step(chunk[i], chunk[i + 1]);
            if (self.overflow) return;
        }
        // A leftover byte may pair with the next chunk's first.
        if (i < chunk.len) self.pending = chunk[i];
    }

    /// Finalizes a dangling held run (as `decodeInto` does) and checks the total.
    pub fn done(self: *RleTotalizer) bool {
        if (self.overflow) return false;
        if (self.holder) |h| {
            const gap: usize = @intCast(self.expected - self.pos); // pos <= expected: every add was bounded
            const len = tailLength(h.len_byte, gap);
            if (len > 0) self.pos += len;
        }
        return self.pos == self.expected;
    }

    /// `decodeInto`'s length arithmetic for one pair, minus the writes.
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

/// The only colour code that is not a mark: decodes to transparent `0xFF` in
/// both tables.
pub const TRANSPARENT_CODE: u8 = 0x62;

/// Whether any run has a colour code other than `TRANSPARENT_CODE`, fed chunk
/// by chunk; stops at the first, so written pages are cheap. Colours are
/// positional, so held lengths need no arithmetic. A pair held at a malformed
/// EOF counts as ink (the safe direction). `0x65` (opaque near-white, masks
/// below) counts: a white pen has written on the page.
pub const InkFinder = struct {
    found: bool = false,
    /// A byte awaiting its pair partner across a chunk boundary.
    pending: ?u8 = null,

    pub fn init() InkFinder {
        return .{};
    }

    /// A no-op once ink is found.
    pub fn feed(self: *InkFinder, chunk: []const u8) void {
        if (self.found) return;
        var i: usize = 0;
        if (self.pending) |p| {
            if (chunk.len == 0) return;
            if (p != TRANSPARENT_CODE) {
                self.found = true;
                return;
            }
            self.pending = null;
            i = 1;
        }
        while (i + 1 < chunk.len) : (i += 2) {
            if (chunk[i] != TRANSPARENT_CODE) {
                self.found = true;
                return;
            }
        }
        // A leftover byte may pair with the next chunk's first.
        if (i < chunk.len) self.pending = chunk[i];
    }

    pub fn done(self: *const InkFinder) bool {
        return self.found;
    }
};

/// `InkFinder` over a whole slice; streaming callers drive the struct to stop
/// reading early.
pub fn hasInk(data: []const u8) bool {
    var f = InkFinder.init();
    f.feed(data);
    return f.done();
}

/// Whether `data` decodes as RLE of exactly `expected_pixels`: the gate that
/// treats anything else (PNG/JPG/WEBP) as an image. Asked only about custom
/// backgrounds, so `0xFF` resolves to `SPECIAL_LENGTH` (`all_blank = false`).
pub fn decodesToExactly(data: []const u8, expected_pixels: u64) bool {
    var t = RleTotalizer.init(expected_pixels);
    t.feed(data);
    return t.done();
}

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

// ---- tests ----


/// Test helper: `unit` repeated `n` times (Zig 0.17 removed `**`).
fn repeat(comptime T: type, comptime unit: []const T, comptime n: usize) *const [unit.len * n]T {
    const out = comptime blk: {
        @setEvalBranchQuota(10 * unit.len * n + 1000);
        var a: [unit.len * n]T = undefined;
        for (0..n) |k| @memcpy(a[k * unit.len ..][0..unit.len], unit);
        break :blk a;
    };
    return &out;
}
test "single short run" {
    const gpa = std.testing.allocator;
    const out = try decode(gpa, .ratta_rle_x2, &.{ 0x61, 0x00 }, 1, 1, false);
    defer gpa.free(out);
    try std.testing.expectEqualSlices(u8, &.{BLACK}, out);
}

test "background code maps to transparent" {
    const gpa = std.testing.allocator;
    const out = try decode(gpa, .ratta_rle_x2, &.{ 0x62, 0x04 }, 5, 1, false); // len 4+1
    defer gpa.free(out);
    try std.testing.expectEqualSlices(u8, &(@as([5]u8, @splat(TRANSPARENT))), out);
}

test "two-byte length, matching color, combines" {
    const gpa = std.testing.allocator;
    const out = try decode(gpa, .ratta_rle_x2, &.{ 0x61, 0x81, 0x61, 0x00 }, 257, 1, false);
    defer gpa.free(out);
    try std.testing.expectEqual(@as(usize, 257), out.len);
    for (out) |b| try std.testing.expectEqual(BLACK, b);
}

test "two-byte length, non-matching color, flushes held run then current" {
    const gpa = std.testing.allocator;
    const out = try decode(gpa, .ratta_rle_x2, &.{ 0x61, 0x81, 0x62, 0x00 }, 257, 1, false);
    defer gpa.free(out);
    try std.testing.expectEqual(@as(usize, 257), out.len);
    try std.testing.expectEqual(BLACK, out[255]);
    try std.testing.expectEqual(TRANSPARENT, out[256]);
}

test "x2 literal pass-through for anti-aliasing gray codes" {
    const gpa = std.testing.allocator;
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
    try std.testing.expectEqualSlices(u8, &(@as([5]u8, @splat(TRANSPARENT))), &buf);
}

test "decodeInto: a too-small destination fails on the overflowing run" {
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
    // Each (code, 0xFF) pair is a 0x4000-pixel run; the FailingAllocator allows
    // one allocation, so SizeMismatch proves nothing grew.
    const gpa = std.testing.allocator;
    var failing = std.testing.FailingAllocator.init(gpa, .{ .fail_index = 1 });
    const data = repeat(u8, &.{ 0x61, 0xFF }, 64).*;
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
    try std.testing.expect(decodesToExactly(&.{ 0x62, 0x04 }, 5));
    try std.testing.expect(decodesToExactly(&.{ 0x61, 0x00 }, 1));
    try std.testing.expect(decodesToExactly(&.{ 0x61, 0x81, 0x61, 0x00 }, 257));
    try std.testing.expect(decodesToExactly(&.{ 0x61, 0x81, 0x62, 0x00 }, 257));
}

test "decodesToExactly: an over- or under-filling RLE stream is rejected" {
    try std.testing.expect(!decodesToExactly(&.{ 0x62, 0x04 }, 3));
    try std.testing.expect(!decodesToExactly(&.{ 0x61, 0x00 }, 100));
}

test "decodesToExactly: image magic bytes fail the total (default-to-image)" {
    const page_pixels: u64 = 1404 * 1872;
    const png = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D };
    try std.testing.expect(!decodesToExactly(&png, page_pixels));
    const jpeg = [_]u8{ 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46 };
    try std.testing.expect(!decodesToExactly(&jpeg, page_pixels));
    const webp = [_]u8{ 0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50 };
    try std.testing.expect(!decodesToExactly(&webp, page_pixels));
}

test "decodesToExactly: agrees with decodeInto on whether a stream is valid RLE" {
    // decodesToExactly must agree with decodeInto.
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
    const data = [_]u8{ 0x61, 0x81, 0x61, 0x00, 0x62, 0x03 }; // 257 black + 4 transparent = 261
    const expected: u64 = 261;
    try std.testing.expect(decodesToExactly(&data, expected));
    for (0..data.len + 1) |cut| {
        var t = RleTotalizer.init(expected);
        t.feed(data[0..cut]);
        t.feed(data[cut..]);
        try std.testing.expect(t.done());
    }
    var t1 = RleTotalizer.init(expected);
    for (data) |b| t1.feed(&[_]u8{b});
    try std.testing.expect(t1.done());
}

test "decodesToExactly: a dangling held run fills to exactly expected" {
    // A lone held (0x61, 0x81) fills the gap with the largest ((0x01)+1)<<i.
    try std.testing.expect(decodesToExactly(&.{ 0x61, 0x81 }, 256));
    try std.testing.expect(!decodesToExactly(&.{ 0x61, 0x81 }, 100));
}

test "InkFinder: a transparent-only stream has no ink; one stroke anywhere has" {
    try std.testing.expect(!hasInk(&.{ 0x62, 0xFF }));
    try std.testing.expect(!hasInk(&.{ 0x62, 0xFF, 0x62, 0xFF, 0x62, 0x0A }));
    try std.testing.expect(hasInk(&.{ 0x61, 0x00 }));
    try std.testing.expect(hasInk(&.{ 0x62, 0xFF, 0x62, 0xFF, 0x61, 0x00 }));
    try std.testing.expect(!hasInk(&.{}));
}

test "InkFinder: 0xFE (code 0x65) IS ink — a white pen is a pen" {
    try std.testing.expect(hasInk(&.{ 0x65, 0x00 }));
    try std.testing.expectEqual(WHITE, grayFor(.ratta_rle, 0x65));
    try std.testing.expectEqual(WHITE, grayFor(.ratta_rle_x2, 0x65));
    try std.testing.expect(WHITE != TRANSPARENT);
}

test "InkFinder: held two-byte lengths are pairs like any other, in both resolutions" {
    try std.testing.expect(!hasInk(&.{ 0x62, 0x81, 0x62, 0x00 })); // 257 transparent
    try std.testing.expect(hasInk(&.{ 0x61, 0x81, 0x61, 0x00 })); // 257 black
    try std.testing.expect(hasInk(&.{ 0x62, 0x81, 0x61, 0x00 })); // 256 transparent, then black
    try std.testing.expect(hasInk(&.{ 0x61, 0x81, 0x62, 0x00 })); // black held, flushed by transparent
    try std.testing.expect(!hasInk(&.{ 0x62, 0x81 }));
    try std.testing.expect(hasInk(&.{ 0x61, 0x81 }));
}

test "InkFinder: a lone trailing byte is not a run, here as in decodeInto" {
    try std.testing.expect(!hasInk(&.{0x61}));
    try std.testing.expect(!hasInk(&.{ 0x62, 0x04, 0x61 }));
}

test "InkFinder: chunked feed matches a single feed at every split point" {
    // The only mark is the last pair, so a byte lost at a boundary flips it.
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
    var one = InkFinder.init();
    for (inked) |x| one.feed(&[_]u8{x});
    try std.testing.expect(one.done());
    var none = InkFinder.init();
    for (blank) |x| none.feed(&[_]u8{x});
    try std.testing.expect(!none.done());
}

test "InkFinder: it stops at the first stroke — the rest of the layer is never read" {
    // `feed` returns at the first ink, so streaming callers can stop reading.
    var f = InkFinder.init();
    f.feed(&.{ 0x61, 0x00 });
    try std.testing.expect(f.found);
    try std.testing.expect(f.pending == null); // it did not walk on to carry a byte

    var g = InkFinder.init();
    g.feed(&(repeat(u8, &.{ 0x62, 0xFF }, 2048).*));
    try std.testing.expect(!g.found);
    g.feed(&.{ 0x61, 0x00 });
    try std.testing.expect(g.found);
    g.feed(&(repeat(u8, &.{ 0x62, 0xFF }, 2048).*));
    try std.testing.expect(g.done());
}

test "InkFinder: every named colour code but 0x62 is ink, and unlisted greys are too" {
    var code: u16 = 0;
    while (code <= 0xFF) : (code += 1) {
        const c: u8 = @intCast(code);
        const stream = [_]u8{ c, 0x00 };
        try std.testing.expectEqual(c != TRANSPARENT_CODE, hasInk(&stream));
    }
}
