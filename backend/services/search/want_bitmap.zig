//! The `want=` parameter of the search-index stream: a BITMAP over manifest
//! positions, base64url, read here without allocating and without decoding it
//! into anything (`golden-search.md` §3.3).
//!
//! ## Why a bitmap and not a list of md5s
//!
//! The question the client has to ask is "the documents I do not have", which is
//! potentially hundreds of md5s. 200 of them is a **6.6 KB URL**, past what
//! proxies tolerate and past what several of them will even log rather than
//! truncate. The manifest is already ordered and already carries an ETag, so the
//! client can address documents by POSITION instead: 1,222 documents is **153
//! bytes, 204 base64url characters** — a URL that fits anywhere, verified by the
//! `1,222` test below.
//!
//! ## Why this lives beside the encoder rather than in `http/`
//!
//! `http/byte_range.zig` and its neighbours are protocol-generic: nothing there
//! knows what a manifest is. A position in this bitmap is meaningless except
//! against the exact row order `index_export.zig`'s `writeManifest` emitted, and
//! the two must change together. Its golden vector sits in the same `testdata/`
//! as the manifest's, for the same reason.
//!
//! ## The four refusals, and why none of them is a shrug
//!
//! §3.3's ETag exists precisely so a bitmap cannot be read against the wrong
//! ordering, and this reader is the other half of that promise. Every
//! disagreement is an ERROR the route answers, never a silent adjustment:
//!
//! - **Not base64url** → `MalformedWant`. Including standard-base64 `+` and `/`,
//!   which is the drift the golden vector's `_-` prefix is chosen to catch.
//! - **Non-canonical trailing bits** → `MalformedWant`. `std.base64` DROPS the
//!   leftover bits of a final 2- or 3-character group rather than checking them,
//!   so two different strings decode to the same bitmap and one of them was
//!   written by something that is not the encoder in `webapp/src/search/`.
//! - **Longer than the manifest** → `WantLongerThanManifest`, checked from the
//!   ENCODED length before a single character is examined, so a megabyte of
//!   query string costs a division rather than a scan.
//! - **A set bit past the manifest's last position** → `WantBitPastManifest`.
//!   Not a no-op: the client believes in a document this manifest does not have,
//!   which means the two disagree about the ordering, and **412 is the honest
//!   answer**. Skipping the bit would serve a stream silently misaligned with
//!   what was asked for.
//!
//! A bitmap SHORTER than the manifest is legal and common — see `parse`.
//!
//! ## Zero allocation, and it is not a micro-optimisation
//!
//! `parse` borrows the query string and stores a slice and a length. `isSet`
//! decodes the one 4-character group holding the byte it needs — a shift and
//! four table lookups, against the ~127-177 ms the manifest query costs on the
//! Pi anyway, and one call per manifest row. So the route holds no per-request
//! buffer, needs no ceiling on how many documents a household may own, and
//! cannot size that buffer wrongly — on a server whose whole posture is a 50 MB
//! budget and three concurrent first visits.

const std = @import("std");

pub const Error = error{
    /// Not base64url, or base64url written non-canonically. A 400: the client
    /// sent something no encoder of ours produces.
    MalformedWant,
    /// More bytes than the manifest has positions. A 412 for the same reason as
    /// `WantBitPastManifest` — the two sides disagree about the ordering.
    WantLongerThanManifest,
    /// A bit set at a position the manifest does not have. A 412.
    WantBitPastManifest,
};

/// base64url, unpadded. `-` and `_` rather than `+` and `/`, and no `=`: 153
/// bytes divides by 3, so the real payload never needs padding, and refusing it
/// leaves exactly one spelling per bitmap.
const alphabet = std.base64.url_safe_alphabet_chars;

/// Built here rather than borrowed from `std.base64`, whose equivalent sentinel
/// is private. Six lines, and it puts `=`, `+` and `/` in the same bucket as any
/// other junk byte — all three are simply not in this alphabet.
const invalid: u8 = 0xff;
const char_to_sextet: [256]u8 = blk: {
    var table = [_]u8{invalid} ** 256;
    for (alphabet, 0..) |c, i| table[c] = @intCast(i);
    break :blk table;
};

/// A validated `want=` parameter, answering "is manifest position N set?".
///
/// Borrows `encoded`, which for the route is the query string it already holds
/// for the life of the request.
pub const WantBitmap = struct {
    /// The base64url text itself, already proved well-formed by `parse`.
    encoded: []const u8,
    /// How many bytes it decodes to. Never more than `(manifest_len + 7) / 8`.
    byte_len: usize,

    /// Is the document at manifest position `position` being asked for?
    ///
    /// The caller walks the manifest IN ORDER — which is tier order, which is
    /// priority order — and asks this once per row, so an indexed query is the
    /// shape that matches rather than a materialised list of positions.
    ///
    /// A position past the end of the bitmap reads as unset, which is what makes
    /// a short bitmap work (see `parse`). A position past the MANIFEST cannot be
    /// asked about wrongly: `parse` already proved every such bit is zero.
    pub fn isSet(self: WantBitmap, position: usize) bool {
        const byte_index = position >> 3;
        if (byte_index >= self.byte_len) return false;
        const bit: u3 = @intCast(position & 7);
        return ((self.byteAt(byte_index) >> bit) & 1) == 1;
    }

    /// How many documents were asked for. The route's log line, and the tests'
    /// cheap way to say "all of them".
    pub fn countSet(self: WantBitmap) usize {
        var total: usize = 0;
        var i: usize = 0;
        while (i < self.byte_len) : (i += 1) total += @popCount(self.byteAt(i));
        return total;
    }

    /// Byte `index` of the bitmap, decoded from the one base64 group that holds
    /// it. LSB-FIRST within the byte: position N is bit `N & 7` of byte `N >> 3`,
    /// so position 0 is the low bit of the first byte. MSB-first would decode
    /// every byte's bits in reverse and produce a plausible, wrong document set;
    /// the golden vector's `0..7, 13, 14, 15` distinguishes the two.
    fn byteAt(self: WantBitmap, index: usize) u8 {
        const group = (index / 3) * 4;
        const c0: u8 = char_to_sextet[self.encoded[group]];
        const c1: u8 = char_to_sextet[self.encoded[group + 1]];
        // The masks are not decoration: a sextet is 6 bits in a u8, so `c1 << 4`
        // unmasked is 1008 and does not fit the byte it is being written into.
        return switch (index % 3) {
            0 => (c0 << 2) | (c1 >> 4),
            1 => ((c1 & 0x0f) << 4) | (char_to_sextet[self.encoded[group + 2]] >> 2),
            else => ((char_to_sextet[self.encoded[group + 2]] & 0x03) << 6) |
                char_to_sextet[self.encoded[group + 3]],
        };
    }
};

/// Read a `want=` parameter against a manifest of `manifest_len` documents.
///
/// An EMPTY parameter is a valid empty set, and so is a bitmap shorter than the
/// manifest: the encoder drops trailing zero bytes, so a client missing only the
/// two newest notes — which tier order puts FIRST — sends a handful of
/// characters rather than 204. Positions past the end simply read as unset.
///
/// Trailing zero bytes that were NOT trimmed are accepted too. Trimming is a
/// courtesy the encoder does for the URL's sake, not a rule worth a refusal, and
/// two spellings of the same set are harmless because nothing caches the string.
pub fn parse(want: []const u8, manifest_len: usize) Error!WantBitmap {
    // A base64 group is 2, 3 or 4 characters. One is not a length any encoder
    // can produce.
    if (want.len % 4 == 1) return error.MalformedWant;
    const byte_len = (want.len / 4) * 3 + switch (want.len % 4) {
        2 => @as(usize, 1),
        3 => @as(usize, 2),
        else => @as(usize, 0),
    };

    // FIRST, before any character is looked at: a bitmap longer than the
    // manifest is refused on arithmetic alone, so an absurd query string is a
    // division rather than a scan of it.
    if (byte_len > (manifest_len + 7) / 8) return error.WantLongerThanManifest;

    for (want) |c| {
        if (char_to_sextet[c] == invalid) return error.MalformedWant;
    }

    // The leftover bits of a short final group. `std.base64` discards these; a
    // client that sets them is not the encoder we ship, and letting it through
    // would give one bitmap several spellings.
    switch (want.len % 4) {
        2 => if ((char_to_sextet[want[want.len - 1]] & 0x0f) != 0) return error.MalformedWant,
        3 => if ((char_to_sextet[want[want.len - 1]] & 0x03) != 0) return error.MalformedWant,
        else => {},
    }

    const map: WantBitmap = .{ .encoded = want, .byte_len = byte_len };

    // The last byte may reach past the manifest's last position — 1,222
    // documents end six bits into byte 152. A bit set up there means the client
    // is addressing a document this ordering does not have: 412, not a skip.
    // Guarded rather than subtracted first, because a bitmap SHORTER than the
    // manifest has no overhang and `byte_len * 8 - manifest_len` would wrap.
    if (byte_len * 8 > manifest_len) {
        const overhang: u3 = @intCast(byte_len * 8 - manifest_len); // 1..7
        const keep: u8 = @as(u8, 0xff) >> overhang;
        if ((map.byteAt(byte_len - 1) & ~keep) != 0) return error.WantBitPastManifest;
    }
    return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

/// Encode a bitmap the way `webapp/src/search/wantBitmap.ts` does, for the tests
/// that need an input rather than an assertion. NOT used by the golden test,
/// which reads the checked-in string — a helper here that agreed with a bug in
/// the reader would pin nothing.
fn encodeForTest(buf: []u8, bytes: []const u8) []const u8 {
    return std.base64.url_safe_no_pad.Encoder.encode(buf, bytes);
}

// -- the golden vector ------------------------------------------------------

/// THE golden vector, one artifact and two implementations, exactly as
/// `testdata/manifest_golden.bin` pins the manifest. This side asserts what the
/// characters MEAN; `webapp/tests/unit/wantBitmap.test.ts` asserts that its
/// encoder produces these characters, from a position list written out by hand
/// there. Neither test can be made to pass by editing the other's code.
///
/// Seven characters, `_-ADAAI`, decoding to `ff e0 03 00 02` against a manifest
/// of 34 documents. Every part of it is load-bearing:
///
///   `_-`     sextets 63 and 62 — the two characters base64URL spells
///            differently from base64. A standard-alphabet encoder writes
///            `/+ADAAI` here and this test says so.
///   ff       positions 0..7: the first byte full, so bit 7 and bit 8 are on
///            opposite sides of a byte boundary
///   e0       positions 13, 14, 15 and NOT 8. Under MSB-first this byte would
///            decode as 8, 9, 10 — which is the whole reason the gap is here.
///   03       positions 16, 17 — a byte immediately after a partial one
///   00       an INTERIOR zero byte, which the encoder must not mistake for a
///            trailing one it may trim
///   02       position 33, the manifest's LAST — so bits 2..7 of this byte are
///            past the manifest and must be zero, and no trimming applies
///   7 chars  `want.len % 4 == 3`, so the final group carries two leftover bits
///            and the canonicality check has something to check
const want_golden = @embedFile("testdata/want_golden.txt");

/// The golden's positions, written out by hand HERE.
const golden_positions = [_]usize{ 0, 1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16, 17, 33 };
const golden_manifest_len = 34;

test "the golden want bitmap decodes to the positions written out beside it" {
    const map = try parse(want_golden, golden_manifest_len);

    var expected = [_]bool{false} ** golden_manifest_len;
    for (golden_positions) |p| expected[p] = true;

    for (0..golden_manifest_len) |position| {
        try testing.expectEqual(expected[position], map.isSet(position));
    }
    try testing.expectEqual(@as(usize, golden_positions.len), map.countSet());
}

test "the golden want bitmap is the string its annotated dump claims" {
    // A different length means the dump above has drifted from the file and
    // stopped being checkable by reading it.
    try testing.expectEqual(@as(usize, 7), want_golden.len);
    try testing.expectEqualStrings("_-ADAAI", want_golden);
    // And it really is base64URL: neither of the two characters standard base64
    // would have written appears.
    try testing.expect(std.mem.indexOfAny(u8, want_golden, "+/=") == null);
}

// -- the sets ---------------------------------------------------------------

test "an empty want is an empty set, not a refusal" {
    // A client that already holds everything. Legal, cheap, and the route
    // answers it with an empty stream rather than a 4xx.
    const map = try parse("", 1_222);
    try testing.expectEqual(@as(usize, 0), map.countSet());
    try testing.expect(!map.isSet(0));
    try testing.expect(!map.isSet(1_221));
}

test "a single bit, at each end of a byte" {
    var buf: [8]u8 = undefined;
    for ([_]usize{ 0, 1, 7, 8, 33 }) |position| {
        var bytes = [_]u8{0} ** 5;
        bytes[position >> 3] |= @as(u8, 1) << @intCast(position & 7);
        const map = try parse(encodeForTest(&buf, &bytes), 40);
        try testing.expectEqual(@as(usize, 1), map.countSet());
        try testing.expect(map.isSet(position));
        // The neighbours stay off — an off-by-one inside `byteAt` would light
        // one of these and nothing else would notice.
        if (position > 0) try testing.expect(!map.isSet(position - 1));
        try testing.expect(!map.isSet(position + 1));
    }
}

test "a sparse set, spread across groups so every byteAt branch runs" {
    // Set bits in bytes 0, 3, 5 and 9, but the assertion below reads EVERY
    // position 0..79 — so all ten bytes are decoded and all three of `byteAt`'s
    // branches run, each having to come back zero where nothing was set.
    const positions = [_]usize{ 2, 25, 40, 41, 79 };
    var bytes = [_]u8{0} ** 10;
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
    // 34 documents: byte 4 holds positions 32..39, of which only 32 and 33
    // exist, so a full set's last byte is 0x03 and not 0xff.
    var bytes = [_]u8{0xff} ** 5;
    bytes[4] = 0x03;
    var buf: [8]u8 = undefined;
    const map = try parse(encodeForTest(&buf, &bytes), 34);
    try testing.expectEqual(@as(usize, 34), map.countSet());
    for (0..34) |position| try testing.expect(map.isSet(position));
}

test "1,222 documents is 153 bytes and 204 characters, which is §3.3's whole claim" {
    // The measurement the design rests on. 200 md5s in a URL is 6.6 KB; the same
    // question as a bitmap is 204 characters, and 153 divides by 3 so it needs no
    // padding either. If this number moves, the URL argument moves with it.
    const documents = 1_222;
    const byte_len = (documents + 7) / 8;
    try testing.expectEqual(@as(usize, 153), byte_len);

    var bytes = [_]u8{0xff} ** 153;
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

// -- the refusals -----------------------------------------------------------

test "malformed base64url is refused, standard base64 included" {
    // `+` and `/` are the interesting two: a client built on a standard-alphabet
    // encoder produces a string that is valid base64 and wrong here, and the
    // symptom without this check is a bitmap that decodes to the wrong documents
    // rather than an error.
    try testing.expectError(error.MalformedWant, parse("gQ+A", 64));
    try testing.expectError(error.MalformedWant, parse("gQ/A", 64));
    // Padding: refused, so one bitmap has exactly one spelling.
    try testing.expectError(error.MalformedWant, parse("gQ==", 64));
    // Ordinary junk, and a stray space that survived a sloppy query parser.
    try testing.expectError(error.MalformedWant, parse("!!!!", 64));
    try testing.expectError(error.MalformedWant, parse("gQ A", 64));
    // A one-character group is not a length base64 can produce.
    try testing.expectError(error.MalformedWant, parse("g", 64));
    try testing.expectError(error.MalformedWant, parse("gQEAg", 64));
}

test "non-canonical leftover bits are refused rather than discarded" {
    // `std.base64` throws these bits away, so `AB` and `AA` would decode to the
    // same single zero byte. Two spellings for one bitmap is not a bug on its
    // own; it is a sign the sender is not the encoder we ship, which is worth
    // knowing before a stream is built on what it said.
    try testing.expectError(error.MalformedWant, parse("AB", 8)); // 2 chars: low 4 bits must be 0
    try testing.expectError(error.MalformedWant, parse("AAB", 16)); // 3 chars: low 2 bits must be 0
    // The canonical spellings of the same bitmaps are accepted.
    try testing.expectEqual(@as(usize, 0), (try parse("AA", 8)).countSet());
    try testing.expectEqual(@as(usize, 0), (try parse("AAA", 16)).countSet());
}

test "a bitmap longer than the manifest is refused, and cheaply" {
    // 34 documents fit in 5 bytes; 6 bytes of bitmap means the client counted a
    // different manifest. Refused on the ENCODED length, before any character is
    // examined — which is also what makes a megabyte of query string cheap.
    var buf: [16]u8 = undefined;
    const six = encodeForTest(&buf, &[_]u8{0} ** 6);
    try testing.expectError(error.WantLongerThanManifest, parse(six, 34));

    // Even all-zero, and even unreadable: the length check runs first, so this
    // one never gets as far as noticing the characters are junk.
    const junk = [_]u8{'!'} ** 4_096;
    try testing.expectError(error.WantLongerThanManifest, parse(&junk, 34));

    // An empty manifest accepts an empty want and nothing else.
    try testing.expectEqual(@as(usize, 0), (try parse("", 0)).countSet());
    try testing.expectError(error.WantLongerThanManifest, parse("AA", 0));
}

test "a bit set past the manifest's last position is a 412, not a no-op" {
    // §3.3's ETag exists so a bitmap cannot be read against the wrong ordering.
    // A stray high bit means it happened anyway, and skipping it would serve a
    // stream that is silently not the answer to the question asked.
    var buf: [16]u8 = undefined;

    // 34 documents: byte 4's bit 2 is position 34, one past the end.
    var one_past = [_]u8{0} ** 5;
    one_past[4] = 0x04;
    try testing.expectError(error.WantBitPastManifest, parse(encodeForTest(&buf, &one_past), 34));

    // The top bit of the last byte, the far end of the same overhang.
    var top = [_]u8{0} ** 5;
    top[4] = 0x80;
    try testing.expectError(error.WantBitPastManifest, parse(encodeForTest(&buf, &top), 34));

    // …and the bit immediately BELOW it is the manifest's last document, which
    // must still be accepted. This pair is the off-by-one.
    var last = [_]u8{0} ** 5;
    last[4] = 0x02;
    try testing.expectEqual(@as(usize, 1), (try parse(encodeForTest(&buf, &last), 34)).countSet());

    // A manifest that ends ON a byte boundary has no overhang to check, and the
    // full byte is legal.
    var full = [_]u8{0} ** 4;
    full[3] = 0xff;
    try testing.expectEqual(@as(usize, 8), (try parse(encodeForTest(&buf, &full), 32)).countSet());
}

test "a bitmap shorter than the manifest asks only about the positions it covers" {
    // The common case after a coalesced refetch: tier order puts new notes
    // first, so "the two documents I am missing" is a couple of characters
    // rather than 204. Everything past the end reads as unset.
    var buf: [8]u8 = undefined;
    const map = try parse(encodeForTest(&buf, &[_]u8{0x05}), 1_222);
    try testing.expectEqual(@as(usize, 2), map.countSet());
    try testing.expect(map.isSet(0));
    try testing.expect(map.isSet(2));
    try testing.expect(!map.isSet(1));
    try testing.expect(!map.isSet(8));
    try testing.expect(!map.isSet(1_221));
}
