//! Embedded-thumbnail recognition: the type gate, the size caps, the MIME
//! sniff, the image-dimension probe, and the blob-magic dispatch that the two
//! derivations (`services/spd_index.zig`, `services/note_index.zig`) and the
//! `/thumbnail/{hash}` serve path share.
//!
//! Some file types ship a ready-made preview image *inside* the file, so the
//! server can hand the library a thumbnail WITHOUT rendering a single pixel —
//! the one thing this project's "client renders, server does not rasterise"
//! rule forbids (see `docs/explanation/client-side-rendering.md`). Two such
//! types exist today:
//!
//!   - a `.spd` (an SQLite drawing): `SELECT value FROM config WHERE
//!     name='thumbnail'` is a raw image blob, usually a JPEG;
//!   - a `.note` with a user-set COVER: the footer's `COVER_2` key addresses a
//!     complete firmware-rendered PNG at device resolution (covers are NOT
//!     auto-generated — most notes have none; see note-format.md §5).
//!
//! The extractions themselves live in the format's own index service
//! (`spd_index.derive` — one parser open shared with the metadata scalars;
//! `note_index.parseBlobSource` — the cover rides the footer the index parse
//! already reads); the bytes land on disk in the `thumbs/` derived store
//! (`store/thumbs.zig`), keyed by source blob md5, and are served off the DB
//! lock through the streaming path. What stays HERE is everything about
//! *recognizing* bytes, so the ingest gates and the serve path cannot hold
//! differing opinions:
//!
//!   - `wants` — the filename type gate (which names may ship an embedded
//!     thumbnail at all);
//!   - `max_source_bytes` / `max_thumbnail_bytes` — the two RSS caps;
//!   - `sqlite_magic` — the cheap pre-check before the deserializer sees bytes;
//!   - `sourceKind` — the blob-magic dispatch the on-demand repair uses to pick
//!     an extractor for a bare md5 (the URL carries no filename);
//!   - `sniffMime` — magic-byte MIME recognition (ingest validates with it,
//!     serving labels with it);
//!   - `imageDims` — the bounded JPEG/PNG dimension probe whose result becomes
//!     `spd_index.thumb_w/h` / `note_index.cover_w/h`, the masonry gallery's
//!     aspect source.
//!
//! Everything here treats its input as attacker-supplied: bounds-checked, no
//! allocation, null on anything malformed — never a panic, never an over-read.
//!
//! ## Adding a third embedded-thumbnail type
//!
//! A later type (a PDF's embedded thumbnail) plugs in as another extractor in
//! its own index service returning the same `Extracted`; the `thumbs/` store
//! and the serving path are format-agnostic. The dispatch is one branch each in
//! `wants` (ingest, by filename) and `sourceKind` (repair, by magic). No
//! speculative generality is built ahead of that need.

const std = @import("std");
const sn = @import("supernote");

/// The largest source file we will buffer whole to attempt extraction. SQLite's
/// `deserialize` needs the entire database contiguous in memory, so this bounds
/// the RSS one ingest can spend on a thumbnail against the ~50 MB budget. A `.spd`
/// gallery file is sparse PNG tiles — hundreds of KB to a few MB in practice — so
/// this is generous headroom; a `.spd` larger than this simply gets no thumbnail
/// (best-effort), never an OOM or a failed upload.
pub const max_source_bytes: u64 = 16 * 1024 * 1024;

/// The largest extracted thumbnail we will store and later serve. An embedded
/// gallery thumbnail is tens of KB; this is two orders of magnitude of headroom
/// and a hard ceiling on what one `thumbs/` file — and one `/thumbnail/{hash}`
/// response — can cost. An oversized `config.thumbnail` blob is treated as "no
/// thumbnail".
pub const max_thumbnail_bytes: usize = 2 * 1024 * 1024;

/// The largest `.note` COVER block we will serve. A user-set cover is a
/// complete firmware-rendered PNG at device resolution and can run to several
/// megabytes (the real `user_cover.note` incident was a 6.5 MB `COVER_3` PNG),
/// far past `max_thumbnail_bytes`. It is NOT stored or buffered like a `.spd`
/// thumbnail: the indexer records only the block's address + length (read from
/// the 4-byte length prefix, never the body) and the serve path streams those
/// bytes straight out of the immutable blob in `blobstore.chunk_len` windows,
/// so a 20 MB cover is never resident. This is the hard ceiling on that stream
/// and on the block-length gate — a cover block larger than this is "no cover",
/// refused from the length prefix before a single body byte is read.
pub const max_cover_bytes: usize = 20 * 1024 * 1024;

/// The SQLite file magic (16 bytes, trailing NUL included). A pre-check before the
/// deserializer, so obvious non-databases are rejected cheaply rather than opened.
pub const sqlite_magic = "SQLite format 3\x00";

/// An extracted embedded thumbnail. `mime` is a static string (from `sniffMime`);
/// `bytes` are owned by whatever allocator the producing derivation used (an
/// arena, for `spd_index.Derived`).
pub const Extracted = struct {
    mime: []const u8,
    bytes: []const u8,
};

/// Does this filename name a type we know how to extract an embedded thumbnail
/// from? A `.spd` (embedded gallery preview) or a `.note` (user-set cover) —
/// case-insensitive. This is the coarse "may any derive work happen" gate; the
/// ingest path picks the EXTRACTOR with the narrower `wantsSpd` (only a `.spd`
/// name reaches the SQLite deserializer — the `.note` cover rides the note
/// parse that runs for every blob anyway).
pub fn wants(name: []const u8) bool {
    const ext = extensionOf(name) orelse return false;
    return std.ascii.eqlIgnoreCase(ext, "spd") or std.ascii.eqlIgnoreCase(ext, "note");
}

/// The `.spd` half of `wants`: the filename gate in front of the SQLite
/// deserializer at ingest. Kept separate so a `.note` upload never pays a
/// whole-blob buffer just to fail the SQLite magic pre-check.
pub fn wantsSpd(name: []const u8) bool {
    const ext = extensionOf(name) orelse return false;
    return std.ascii.eqlIgnoreCase(ext, "spd");
}

fn extensionOf(name: []const u8) ?[]const u8 {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return null;
    // `dot == 0` is a leading-dot name (`.spd`), not an extension separator;
    // `dot + 1 == len` is a trailing dot. Same rule as `controlplane.extensionOf`.
    if (dot == 0 or dot + 1 == name.len) return null;
    return name[dot + 1 ..];
}

/// The formats an embedded thumbnail can be derived FROM, recognized by a
/// blob's own leading bytes. The on-demand repair dispatches on this: the
/// `/thumbnail/{hash}` URL carries only an md5, so the blob's magic — not a
/// filename — decides which extractor could serve it (plan decision 3 in
/// docs/scratch/archive/notes-with-covers.md). `.none` means neither format claims the
/// bytes and the serve path 404s WITHOUT deriving anything.
pub const SourceKind = enum { spd, note, none };

/// Recognizes which derivation `head` (a blob's first bytes — feed it at least
/// `source_probe_len`) selects. Pure over the bytes; hostile input is `.none`.
pub fn sourceKind(head: []const u8) SourceKind {
    if (head.len >= sqlite_magic.len and std.mem.eql(u8, head[0..sqlite_magic.len], sqlite_magic)) return .spd;
    if (sn.signature.detect(head)) |_| return .note else |_| {}
    return .none;
}

/// How many leading bytes `sourceKind` needs to answer definitively: the
/// larger of the SQLite magic and the `.note` signature probe.
pub const source_probe_len = @max(sqlite_magic.len, sn.signature.probe_len);

/// Recognises the image type of a thumbnail blob from its magic bytes, returning
/// the MIME to serve it under, or null for anything we do not recognise as an
/// image. Refusing the unknown case (rather than defaulting to a made-up type)
/// keeps `/thumbnail`'s `Content-Type` always a real, correct image type — an
/// `<img>` can only render what it can decode, and a wrong label plus `nosniff`
/// would render nothing anyway. Ingest only ever stores bytes that pass this, so
/// a sniff failure at serve time means on-disk corruption and maps to 404.
pub fn sniffMime(b: []const u8) ?[]const u8 {
    if (b.len >= 3 and b[0] == 0xFF and b[1] == 0xD8 and b[2] == 0xFF) return "image/jpeg";
    if (b.len >= 8 and std.mem.eql(u8, b[0..8], "\x89PNG\r\n\x1a\n")) return "image/png";
    if (b.len >= 12 and std.mem.eql(u8, b[0..4], "RIFF") and std.mem.eql(u8, b[8..12], "WEBP")) return "image/webp";
    if (b.len >= 6 and (std.mem.eql(u8, b[0..6], "GIF87a") or std.mem.eql(u8, b[0..6], "GIF89a"))) return "image/gif";
    return null;
}

/// A decoded thumbnail's pixel dimensions.
pub const Dims = struct { w: u32, h: u32 };

/// The pixel dimensions of a JPEG or PNG thumbnail, read from its own header
/// bytes, or null when they cannot be decoded (a truncated/hostile file, or a
/// format whose header we do not walk — WebP/GIF map to "dims unknown" and the
/// masonry layout falls back to its default aspect).
///
/// The input is attacker-supplied. Every access is bounds-checked, nothing
/// allocates, and any malformed structure — an odd marker length, a segment
/// running past EOF, a missing SOF — is null, never a panic or an over-read.
pub fn imageDims(b: []const u8) ?Dims {
    // PNG: 8-byte signature, then the IHDR chunk MUST come first — 4-byte
    // length, "IHDR" tag at 12..16, width/height as big-endian u32 at 16..24.
    if (b.len >= 24 and std.mem.eql(u8, b[0..8], "\x89PNG\r\n\x1a\n")) {
        if (!std.mem.eql(u8, b[12..16], "IHDR")) return null;
        return .{
            .w = std.mem.readInt(u32, b[16..20], .big),
            .h = std.mem.readInt(u32, b[20..24], .big),
        };
    }

    // JPEG: walk the marker segments from SOI to the first SOFn frame header
    // (0xC0–0xCF excluding the non-frame C4/C8/CC), which carries height at
    // segment offset 5 and width at 7 (both big-endian, after the 2-byte
    // length + 1-byte precision).
    if (b.len >= 4 and b[0] == 0xFF and b[1] == 0xD8) {
        var i: usize = 2;
        while (i + 1 < b.len) {
            if (b[i] != 0xFF) return null; // lost sync: not a marker where one must be
            // Fill bytes: any number of 0xFF may pad before the marker id.
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

            // Every remaining marker carries a 2-byte big-endian length that
            // INCLUDES itself; anything under 2 or past EOF is malformed.
            if (i + 2 > b.len) return null;
            const seg_len: usize = std.mem.readInt(u16, b[i..][0..2], .big);
            if (seg_len < 2 or i + seg_len > b.len) return null;

            const is_sof = marker >= 0xC0 and marker <= 0xCF and
                marker != 0xC4 and marker != 0xC8 and marker != 0xCC;
            if (is_sof) {
                // length(2) + precision(1) + height(2) + width(2) = 7 minimum.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

    // Only a `.spd` NAME may reach the SQLite deserializer at ingest.
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

/// A syntactically valid JPEG head: SOI, one APP0, then a SOF segment carrying
/// the given dims. `sof_marker` lets tests exercise baseline (C0), progressive
/// (C2) and the excluded non-frame markers.
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
    // Baseline JPEG.
    {
        const d = imageDims(miniJpeg(&buf, 0xC0, 800, 600)).?;
        try testing.expectEqual(@as(u32, 800), d.w);
        try testing.expectEqual(@as(u32, 600), d.h);
    }
    // Progressive JPEG (SOF2) — the other frame type real encoders emit.
    {
        const d = imageDims(miniJpeg(&buf, 0xC2, 1404, 1872)).?;
        try testing.expectEqual(@as(u32, 1404), d.w);
        try testing.expectEqual(@as(u32, 1872), d.h);
    }
    // PNG IHDR: width 320, height 240, big-endian at 16..24.
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
    try testing.expect(imageDims("RIFF\x00\x00\x00\x00WEBP" ++ ("w" ** 20)) == null);
    try testing.expect(imageDims("GIF89a" ++ ("g" ** 20)) == null);
    try testing.expect(imageDims("not an image at all") == null);
    try testing.expect(imageDims("") == null);
}

test "imageDims survives truncated and hostile inputs without panic or over-read" {
    var buf: [64]u8 = undefined;
    const good = miniJpeg(&buf, 0xC0, 800, 600);

    // Every truncation of a valid JPEG is null, never a crash.
    var n: usize = 0;
    while (n < good.len) : (n += 1) {
        try testing.expect(imageDims(good[0..n]) == null);
    }

    // A segment length that runs past EOF.
    {
        var evil: [16]u8 = undefined;
        @memcpy(evil[0..8], "\xff\xd8\xff\xe0\xff\xff\x4a\x46"); // APP0 claiming len 0xFFFF
        @memset(evil[8..], 0);
        try testing.expect(imageDims(&evil) == null);
    }
    // A segment length below the 2 bytes it must at least cover.
    try testing.expect(imageDims("\xff\xd8\xff\xe0\x00\x01") == null);
    // A SOF whose segment is too short to carry dimensions.
    try testing.expect(imageDims("\xff\xd8\xff\xc0\x00\x04\x08\x00") == null);
    // Lost marker sync (a non-FF byte where a marker must start).
    try testing.expect(imageDims("\xff\xd8\x00\xc0\x00\x0b") == null);
    // EOI / SOS before any SOF: no dimensions exist to report.
    try testing.expect(imageDims("\xff\xd8\xff\xd9") == null);
    try testing.expect(imageDims("\xff\xd8\xff\xda\x00\x04\x01\x00") == null);
    // The excluded non-frame markers (C4/C8/CC) must NOT be read as SOF; with
    // nothing after them the walk runs out of bytes and reports null.
    for ([_]u8{ 0xC4, 0xC8, 0xCC }) |m| {
        var seg = [_]u8{ 0xff, 0xd8, 0xff, m, 0x00, 0x0B, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x11, 0x00 };
        try testing.expect(imageDims(&seg) == null);
    }
    // Marker fill bytes (repeated 0xFF) are tolerated on the way to the SOF.
    {
        const padded = "\xff\xd8\xff\xff\xff\xe0\x00\x04\x4a\x46" ++
            "\xff\xc0\x00\x0b\x08\x02\x58\x03\x20\x03\x01\x11\x00";
        const d = imageDims(padded).?;
        try testing.expectEqual(@as(u32, 800), d.w);
        try testing.expectEqual(@as(u32, 600), d.h);
    }

    // A PNG whose first chunk is not IHDR, and a truncated PNG.
    try testing.expect(imageDims("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dNOPE\x00\x00\x01\x40\x00\x00\x00\xf0") == null);
    try testing.expect(imageDims("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIH") == null);
}
