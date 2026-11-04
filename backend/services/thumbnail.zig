//! Embedded-thumbnail recognition shared by ingest and `/thumbnail/{hash}`: the
//! type gate, size caps, MIME sniff, dimension probe and blob-magic dispatch.
//! All input is attacker-supplied: bounds-checked, no allocation, null on junk.

const std = @import("std");
const repeat = @import("../util/repeat.zig").repeat;
const sn = @import("supernote");

/// Largest source we buffer whole to extract from (SQLite `deserialize` needs
/// it contiguous); bigger `.spd` files get no thumbnail rather than an OOM.
pub const max_source_bytes: u64 = 16 * 1024 * 1024;

/// Largest extracted thumbnail we store and serve; bigger counts as none.
pub const max_thumbnail_bytes: usize = 2 * 1024 * 1024;

/// Largest `.note` cover block we serve (covers reach several MB). Never
/// buffered: the indexer records address + length from the 4-byte prefix and the
/// serve path streams it from the blob; a bigger block is "no cover".
pub const max_cover_bytes: usize = 20 * 1024 * 1024;

/// The SQLite file magic (16 bytes incl. NUL), a cheap pre-check.
pub const sqlite_magic = "SQLite format 3\x00";

/// `mime` is static (from `sniffMime`); `bytes` belong to the producer's allocator.
pub const Extracted = struct {
    mime: []const u8,
    bytes: []const u8,
};

/// Whether `name` may carry an embedded thumbnail (`.spd` or `.note`,
/// case-insensitive). The extractor is chosen with the narrower `wantsSpd`.
pub fn wants(name: []const u8) bool {
    const ext = extensionOf(name) orelse return false;
    return std.ascii.eqlIgnoreCase(ext, "spd") or std.ascii.eqlIgnoreCase(ext, "note");
}

/// `.spd` only: the gate in front of the SQLite deserializer, so a `.note`
/// upload never pays a whole-blob buffer.
pub fn wantsSpd(name: []const u8) bool {
    const ext = extensionOf(name) orelse return false;
    return std.ascii.eqlIgnoreCase(ext, "spd");
}

fn extensionOf(name: []const u8) ?[]const u8 {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return null;
    // `dot == 0` is a leading-dot name, `dot + 1 == len` a trailing dot.
    if (dot == 0 or dot + 1 == name.len) return null;
    return name[dot + 1 ..];
}

/// Source format by blob magic; repair dispatches on it because the URL carries
/// only an md5. `.none` 404s without deriving.
pub const SourceKind = enum { spd, note, none };

/// Feed at least `source_probe_len` bytes; hostile input is `.none`.
pub fn sourceKind(head: []const u8) SourceKind {
    if (head.len >= sqlite_magic.len and std.mem.eql(u8, head[0..sqlite_magic.len], sqlite_magic)) return .spd;
    if (sn.signature.detect(head)) |_| return .note else |_| {}
    return .none;
}

pub const source_probe_len = @max(sqlite_magic.len, sn.signature.probe_len);

/// MIME from magic bytes, or null for anything not a recognised image. Ingest
/// stores only bytes that pass, so a serve-time failure means corruption (404).
pub fn sniffMime(b: []const u8) ?[]const u8 {
    if (b.len >= 3 and b[0] == 0xFF and b[1] == 0xD8 and b[2] == 0xFF) return "image/jpeg";
    if (b.len >= 8 and std.mem.eql(u8, b[0..8], "\x89PNG\r\n\x1a\n")) return "image/png";
    if (b.len >= 12 and std.mem.eql(u8, b[0..4], "RIFF") and std.mem.eql(u8, b[8..12], "WEBP")) return "image/webp";
    if (b.len >= 6 and (std.mem.eql(u8, b[0..6], "GIF87a") or std.mem.eql(u8, b[0..6], "GIF89a"))) return "image/gif";
    return null;
}

pub const Dims = struct { w: u32, h: u32 };

/// JPEG/PNG pixel dimensions from the header, or null (truncated, hostile, or
/// WebP/GIF, which the gallery shows at its default aspect).
pub fn imageDims(b: []const u8) ?Dims {
    // PNG: IHDR must come first; width/height big-endian u32 at 16..24.
    if (b.len >= 24 and std.mem.eql(u8, b[0..8], "\x89PNG\r\n\x1a\n")) {
        if (!std.mem.eql(u8, b[12..16], "IHDR")) return null;
        return .{
            .w = std.mem.readInt(u32, b[16..20], .big),
            .h = std.mem.readInt(u32, b[20..24], .big),
        };
    }

    // JPEG: walk segments to the first SOFn (C0–CF except C4/C8/CC); height at
    // segment offset 5, width at 7.
    if (b.len >= 4 and b[0] == 0xFF and b[1] == 0xD8) {
        var i: usize = 2;
        while (i + 1 < b.len) {
            if (b[i] != 0xFF) return null; // lost sync: not a marker where one must be
            // Any number of 0xFF fill bytes may precede the marker id.
            var j = i + 1;
            while (j < b.len and b[j] == 0xFF) j += 1;
            if (j >= b.len) return null;
            const marker = b[j];
            i = j + 1;

            switch (marker) {
                0x01, 0xD0...0xD7 => continue, // standalone markers: no length field
                0xD8 => continue, // a stray SOI is odd but standalone too
                0xD9 => return null, // EOI before any SOF: no dimensions exist
                0xDA => return null, // SOS: entropy-coded data follows, no SOF was seen
                else => {},
            }

            // Segment length is big-endian and includes itself.
            if (i + 2 > b.len) return null;
            const seg_len: usize = std.mem.readInt(u16, b[i..][0..2], .big);
            if (seg_len < 2 or i + seg_len > b.len) return null;

            const is_sof = marker >= 0xC0 and marker <= 0xCF and
                marker != 0xC4 and marker != 0xC8 and marker != 0xCC;
            if (is_sof) {
                if (seg_len < 7) return null;
                return .{
                    .w = std.mem.readInt(u16, b[i + 5 ..][0..2], .big),
                    .h = std.mem.readInt(u16, b[i + 3 ..][0..2], .big),
                };
            }
            i += seg_len;
        }
        return null; // ran out of bytes without finding a frame header
    }

    return null; // not a format we probe (WebP/GIF/garbage)
}

// ---- tests ----

const testing = std.testing;

test "wants covers .spd and .note, case-insensitively; wantsSpd stays the deserializer gate" {
    try testing.expect(wants("drawing.spd"));
    try testing.expect(wants("DRAWING.SPD"));
    try testing.expect(wants("a.b.spd"));
    try testing.expect(wants("note.note")); // a .note may ship a cover
    try testing.expect(wants("NOTE.NOTE"));
    try testing.expect(!wants("doc.pdf"));
    try testing.expect(!wants("spd")); // no extension
    try testing.expect(!wants(".spd")); // a leading-dot name is not an extension
    try testing.expect(!wants("trailing."));

    try testing.expect(wantsSpd("drawing.spd"));
    try testing.expect(!wantsSpd("note.note"));
    try testing.expect(!wantsSpd(".spd"));
}

test "sourceKind dispatches on the blob's own magic, never on a name" {
    try testing.expectEqual(SourceKind.spd, sourceKind(sqlite_magic ++ "rest of a database"));
    try testing.expectEqual(SourceKind.note, sourceKind("noteSN_FILE_VER_20260016 body"));
    try testing.expectEqual(SourceKind.note, sourceKind("SN_FILE_ASA_20190529....")); // original family
    try testing.expectEqual(SourceKind.none, sourceKind("\xff\xd8\xff\xe0 a jpeg"));
    try testing.expectEqual(SourceKind.none, sourceKind("SQLite format 3")); // magic truncated (15 bytes)
    try testing.expectEqual(SourceKind.none, sourceKind(""));
    try testing.expect(source_probe_len >= sqlite_magic.len);
}

test "sniffMime recognises the four image magics and refuses everything else" {
    try testing.expectEqualStrings("image/jpeg", sniffMime("\xff\xd8\xff\xe0rest").?);
    try testing.expectEqualStrings("image/png", sniffMime("\x89PNG\r\n\x1a\nrest").?);
    try testing.expectEqualStrings("image/webp", sniffMime("RIFF\x00\x00\x00\x00WEBPrest").?);
    try testing.expectEqualStrings("image/gif", sniffMime("GIF89arest").?);
    try testing.expectEqualStrings("image/gif", sniffMime("GIF87arest").?);
    try testing.expect(sniffMime("just some bytes") == null);
    try testing.expect(sniffMime("") == null);
    try testing.expect(sniffMime("\xff\xd8") == null); // truncated below the magic
}

/// SOI, APP0, then a SOF segment with the given marker and dims.
fn miniJpeg(buf: []u8, sof_marker: u8, w: u16, h: u16) []const u8 {
    var i: usize = 0;
    const put = struct {
        fn bytes(b: []u8, at: *usize, s: []const u8) void {
            @memcpy(b[at.*..][0..s.len], s);
            at.* += s.len;
        }
    }.bytes;
    put(buf, &i, "\xff\xd8"); // SOI
    put(buf, &i, "\xff\xe0\x00\x04\x4a\x46"); // APP0, len 4, 2 payload bytes
    put(buf, &i, &[_]u8{ 0xFF, sof_marker, 0x00, 0x0B, 0x08 }); // SOFn, len 11, precision 8
    put(buf, &i, &[_]u8{ @intCast(h >> 8), @truncate(h), @intCast(w >> 8), @truncate(w) });
    put(buf, &i, &[_]u8{ 0x03, 0x01, 0x11, 0x00 }); // component stub to fill the length
    return buf[0..i];
}

test "imageDims reads JPEG SOF0/SOF2 and PNG IHDR dimensions" {
    var buf: [64]u8 = undefined;
    {
        const d = imageDims(miniJpeg(&buf, 0xC0, 800, 600)).?;
        try testing.expectEqual(@as(u32, 800), d.w);
        try testing.expectEqual(@as(u32, 600), d.h);
    }
    {
        const d = imageDims(miniJpeg(&buf, 0xC2, 1404, 1872)).?;
        try testing.expectEqual(@as(u32, 1404), d.w);
        try testing.expectEqual(@as(u32, 1872), d.h);
    }
    {
        const png = "\x89PNG\r\n\x1a\n" ++ // signature
            "\x00\x00\x00\x0d" ++ "IHDR" ++ // IHDR length + tag
            "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
            "\x08\x02\x00\x00\x00"; // bit depth etc.
        const d = imageDims(png).?;
        try testing.expectEqual(@as(u32, 320), d.w);
        try testing.expectEqual(@as(u32, 240), d.h);
    }
}

test "imageDims returns null for webp/gif and undecodable formats" {
    try testing.expect(imageDims("RIFF\x00\x00\x00\x00WEBP" ++ (repeat(u8, "w", 20))) == null);
    try testing.expect(imageDims("GIF89a" ++ (repeat(u8, "g", 20))) == null);
    try testing.expect(imageDims("not an image at all") == null);
    try testing.expect(imageDims("") == null);
}

test "imageDims survives truncated and hostile inputs without panic or over-read" {
    var buf: [64]u8 = undefined;
    const good = miniJpeg(&buf, 0xC0, 800, 600);

    var n: usize = 0;
    while (n < good.len) : (n += 1) {
        try testing.expect(imageDims(good[0..n]) == null);
    }

    {
        var evil: [16]u8 = undefined;
        @memcpy(evil[0..8], "\xff\xd8\xff\xe0\xff\xff\x4a\x46"); // APP0 claiming len 0xFFFF
        @memset(evil[8..], 0);
        try testing.expect(imageDims(&evil) == null);
    }
    try testing.expect(imageDims("\xff\xd8\xff\xe0\x00\x01") == null);
    try testing.expect(imageDims("\xff\xd8\xff\xc0\x00\x04\x08\x00") == null);
    try testing.expect(imageDims("\xff\xd8\x00\xc0\x00\x0b") == null);
    try testing.expect(imageDims("\xff\xd8\xff\xd9") == null);
    try testing.expect(imageDims("\xff\xd8\xff\xda\x00\x04\x01\x00") == null);
    // C4/C8/CC are not frame headers.
    for ([_]u8{ 0xC4, 0xC8, 0xCC }) |m| {
        var seg = [_]u8{ 0xff, 0xd8, 0xff, m, 0x00, 0x0B, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x11, 0x00 };
        try testing.expect(imageDims(&seg) == null);
    }
    {
        const padded = "\xff\xd8\xff\xff\xff\xe0\x00\x04\x4a\x46" ++
            "\xff\xc0\x00\x0b\x08\x02\x58\x03\x20\x03\x01\x11\x00";
        const d = imageDims(padded).?;
        try testing.expectEqual(@as(u32, 800), d.w);
        try testing.expectEqual(@as(u32, 600), d.h);
    }

    try testing.expect(imageDims("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dNOPE\x00\x00\x01\x40\x00\x00\x00\xf0") == null);
    try testing.expect(imageDims("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIH") == null);
}
