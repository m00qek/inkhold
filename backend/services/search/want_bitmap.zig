//! The `want=` parameter of the search-index stream: an LSB-first bitmap over
//! manifest positions, base64url, read without allocating. Any disagreement
//! with the manifest is an error, never a silent skip.

const std = @import("std");

pub const Error = error{
    /// Not base64url, or written non-canonically. A 400.
    MalformedWant,
    /// More bytes than the manifest has positions. A 412.
    WantLongerThanManifest,
    /// A bit set at a position the manifest does not have. A 412.
    WantBitPastManifest,
};

/// base64url, unpadded; `=` is refused so each bitmap has one spelling.
const alphabet = std.base64.url_safe_alphabet_chars;

/// `std.base64`'s equivalent sentinel is private.
const invalid: u8 = 0xff;
const char_to_sextet: [256]u8 = blk: {
    var table = @as([256]u8, @splat(invalid));
    for (alphabet, 0..) |c, i| table[c] = @intCast(i);
    break :blk table;
};

/// A validated `want=` parameter. Borrows `encoded` (the request's query string).
pub const WantBitmap = struct {
    encoded: []const u8,
    byte_len: usize,

    /// A position past the end of a short bitmap reads as unset.
    pub fn isSet(self: WantBitmap, position: usize) bool {
        const byte_index = position >> 3;
        if (byte_index >= self.byte_len) return false;
        const bit: u3 = @intCast(position & 7);
        return ((self.byteAt(byte_index) >> bit) & 1) == 1;
    }

    pub fn countSet(self: WantBitmap) usize {
        var total: usize = 0;
        var i: usize = 0;
        while (i < self.byte_len) : (i += 1) total += @popCount(self.byteAt(i));
        return total;
    }

    /// LSB-first: position N is bit `N & 7` of byte `N >> 3`.
    fn byteAt(self: WantBitmap, index: usize) u8 {
        const group = (index / 3) * 4;
        const c0: u8 = char_to_sextet[self.encoded[group]];
        const c1: u8 = char_to_sextet[self.encoded[group + 1]];
        return switch (index % 3) {
            0 => (c0 << 2) | (c1 >> 4),
            1 => ((c1 & 0x0f) << 4) | (char_to_sextet[self.encoded[group + 2]] >> 2),
            else => ((char_to_sextet[self.encoded[group + 2]] & 0x03) << 6) |
                char_to_sextet[self.encoded[group + 3]],
        };
    }
};

/// Reads `want` against a manifest of `manifest_len` documents. A bitmap
/// shorter than the manifest is legal (the encoder trims trailing zero bytes).
pub fn parse(want: []const u8, manifest_len: usize) Error!WantBitmap {
    if (want.len % 4 == 1) return error.MalformedWant;
    const byte_len = (want.len / 4) * 3 + switch (want.len % 4) {
        2 => @as(usize, 1),
        3 => @as(usize, 2),
        else => @as(usize, 0),
    };

    // Before the scan, so a megabyte of query string costs a division.
    if (byte_len > (manifest_len + 7) / 8) return error.WantLongerThanManifest;

    for (want) |c| {
        if (char_to_sextet[c] == invalid) return error.MalformedWant;
    }

    // `std.base64` silently discards a short group's leftover bits; refuse
    // them so one bitmap has one spelling.
    switch (want.len % 4) {
        2 => if ((char_to_sextet[want[want.len - 1]] & 0x0f) != 0) return error.MalformedWant,
        3 => if ((char_to_sextet[want[want.len - 1]] & 0x03) != 0) return error.MalformedWant,
        else => {},
    }

    const map: WantBitmap = .{ .encoded = want, .byte_len = byte_len };

    // A set bit in the last byte's overhang is a 412. Guarded: a short bitmap
    // has no overhang and the subtraction would wrap.
    if (byte_len * 8 > manifest_len) {
        const overhang: u3 = @intCast(byte_len * 8 - manifest_len); // 1..7
        const keep: u8 = @as(u8, 0xff) >> overhang;
        if ((map.byteAt(byte_len - 1) & ~keep) != 0) return error.WantBitPastManifest;
    }
    return map;
}

// ---- tests ----

const testing = std.testing;

/// Not used by the golden test, which must not share a bug with the reader.
fn encodeForTest(buf: []u8, bytes: []const u8) []const u8 {
    return std.base64.url_safe_no_pad.Encoder.encode(buf, bytes);
}

// ---- the golden vector ----

/// Shared with `webapp/tests/unit/wantBitmap.test.ts`. `_-ADAAI` decodes to
/// `ff e0 03 00 02` over 34 documents: `_-` differ from standard base64, `e0`
/// separates LSB- from MSB-first, `00` is an interior zero not to trim, `02` is
/// the last position, and 7 chars leave two leftover bits to check.
const want_golden = @embedFile("testdata/want_golden.txt");

const golden_positions = [_]usize{ 0, 1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16, 17, 33 };
const golden_manifest_len = 34;

test "the golden want bitmap decodes to the positions written out beside it" {
    const map = try parse(want_golden, golden_manifest_len);

    var expected = @as([golden_manifest_len]bool, @splat(false));
    for (golden_positions) |p| expected[p] = true;

    for (0..golden_manifest_len) |position| {
        try testing.expectEqual(expected[position], map.isSet(position));
    }
    try testing.expectEqual(@as(usize, golden_positions.len), map.countSet());
}

test "the golden want bitmap is the string its annotated dump claims" {
    try testing.expectEqual(@as(usize, 7), want_golden.len);
    try testing.expectEqualStrings("_-ADAAI", want_golden);
    try testing.expect(std.mem.indexOfAny(u8, want_golden, "+/=") == null);
}

// ---- the sets ----

test "an empty want is an empty set, not a refusal" {
    const map = try parse("", 1_222);
    try testing.expectEqual(@as(usize, 0), map.countSet());
    try testing.expect(!map.isSet(0));
    try testing.expect(!map.isSet(1_221));
}

test "a single bit, at each end of a byte" {
    var buf: [8]u8 = undefined;
    for ([_]usize{ 0, 1, 7, 8, 33 }) |position| {
        var bytes = @as([5]u8, @splat(0));
        bytes[position >> 3] |= @as(u8, 1) << @intCast(position & 7);
        const map = try parse(encodeForTest(&buf, &bytes), 40);
        try testing.expectEqual(@as(usize, 1), map.countSet());
        try testing.expect(map.isSet(position));
        if (position > 0) try testing.expect(!map.isSet(position - 1));
        try testing.expect(!map.isSet(position + 1));
    }
}

test "a sparse set, spread across groups so every byteAt branch runs" {
    const positions = [_]usize{ 2, 25, 40, 41, 79 };
    var bytes = @as([10]u8, @splat(0));
    for (positions) |p| bytes[p >> 3] |= @as(u8, 1) << @intCast(p & 7);

    var buf: [16]u8 = undefined;
    const map = try parse(encodeForTest(&buf, &bytes), 80);
    try testing.expectEqual(@as(usize, positions.len), map.countSet());
    for (0..80) |position| {
        const want_it = std.mem.indexOfScalar(usize, &positions, position) != null;
        try testing.expectEqual(want_it, map.isSet(position));
    }
}

test "every bit set, and the last byte's overhang stays legal" {
    var bytes = @as([5]u8, @splat(0xff));
    bytes[4] = 0x03;
    var buf: [8]u8 = undefined;
    const map = try parse(encodeForTest(&buf, &bytes), 34);
    try testing.expectEqual(@as(usize, 34), map.countSet());
    for (0..34) |position| try testing.expect(map.isSet(position));
}

test "1,222 documents is 153 bytes and 204 characters, which is §3.3's whole claim" {
    const documents = 1_222;
    const byte_len = (documents + 7) / 8;
    try testing.expectEqual(@as(usize, 153), byte_len);

    var bytes = @as([153]u8, @splat(0xff));
    bytes[152] = 0x3f; // positions 1216..1221; bits 6 and 7 are past the manifest
    var buf: [256]u8 = undefined;
    const encoded = encodeForTest(&buf, &bytes);
    try testing.expectEqual(@as(usize, 204), encoded.len);
    try testing.expect(std.mem.indexOfScalar(u8, encoded, '=') == null);

    const map = try parse(encoded, documents);
    try testing.expectEqual(@as(usize, documents), map.countSet());
    try testing.expect(map.isSet(0));
    try testing.expect(map.isSet(1_221));
    try testing.expect(!map.isSet(1_222));
}

// ---- the refusals ----

test "malformed base64url is refused, standard base64 included" {
    try testing.expectError(error.MalformedWant, parse("gQ+A", 64));
    try testing.expectError(error.MalformedWant, parse("gQ/A", 64));
    try testing.expectError(error.MalformedWant, parse("gQ==", 64));
    try testing.expectError(error.MalformedWant, parse("!!!!", 64));
    try testing.expectError(error.MalformedWant, parse("gQ A", 64));
    try testing.expectError(error.MalformedWant, parse("g", 64));
    try testing.expectError(error.MalformedWant, parse("gQEAg", 64));
}

test "non-canonical leftover bits are refused rather than discarded" {
    try testing.expectError(error.MalformedWant, parse("AB", 8)); // 2 chars: low 4 bits must be 0
    try testing.expectError(error.MalformedWant, parse("AAB", 16)); // 3 chars: low 2 bits must be 0
    try testing.expectEqual(@as(usize, 0), (try parse("AA", 8)).countSet());
    try testing.expectEqual(@as(usize, 0), (try parse("AAA", 16)).countSet());
}

test "a bitmap longer than the manifest is refused, and cheaply" {
    var buf: [16]u8 = undefined;
    const six = encodeForTest(&buf, &@as([6]u8, @splat(0)));
    try testing.expectError(error.WantLongerThanManifest, parse(six, 34));

    const junk = @as([4_096]u8, @splat('!'));
    try testing.expectError(error.WantLongerThanManifest, parse(&junk, 34));

    try testing.expectEqual(@as(usize, 0), (try parse("", 0)).countSet());
    try testing.expectError(error.WantLongerThanManifest, parse("AA", 0));
}

test "a bit set past the manifest's last position is a 412, not a no-op" {
    var buf: [16]u8 = undefined;

    var one_past = @as([5]u8, @splat(0));
    one_past[4] = 0x04;
    try testing.expectError(error.WantBitPastManifest, parse(encodeForTest(&buf, &one_past), 34));

    var top = @as([5]u8, @splat(0));
    top[4] = 0x80;
    try testing.expectError(error.WantBitPastManifest, parse(encodeForTest(&buf, &top), 34));

    // The bit just below the overhang is the last document: the off-by-one.
    var last = @as([5]u8, @splat(0));
    last[4] = 0x02;
    try testing.expectEqual(@as(usize, 1), (try parse(encodeForTest(&buf, &last), 34)).countSet());

    var full = @as([4]u8, @splat(0));
    full[3] = 0xff;
    try testing.expectEqual(@as(usize, 8), (try parse(encodeForTest(&buf, &full), 32)).countSet());
}

test "a bitmap shorter than the manifest asks only about the positions it covers" {
    var buf: [8]u8 = undefined;
    const map = try parse(encodeForTest(&buf, &[_]u8{0x05}), 1_222);
    try testing.expectEqual(@as(usize, 2), map.countSet());
    try testing.expect(map.isSet(0));
    try testing.expect(map.isSet(2));
    try testing.expect(!map.isSet(1));
    try testing.expect(!map.isSet(8));
    try testing.expect(!map.isSet(1_221));
}
