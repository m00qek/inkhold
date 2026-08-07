//! Tier 3 — the links a PDF template brought with it, from a page's
//! `EXTERNALLINKINFO` block (`note-format.md` §14).
//!
//! A PDF imported as a template keeps its links: the device rasterises each PDF
//! page into the page's background and records that page's link rectangles
//! separately, here. Address `0` — every page of every ordinary `.note` — means
//! the page has none.
//!
//! ## The grammar, and why it gets its own decoder
//!
//! `EXTERNALLINKINFO` is the odd one out among the page's content blocks. Its
//! neighbours `LAYERINFO`, `RECOGNTEXT` and `HIGHLIGHTINFO` are base64 of JSON,
//! so they all go through a base64 → `std.json` path. This one is base64 of
//! NOTHING — the base64 is per FIELD:
//!
//! ```text
//!   record | record | record |
//!   record := b64(f1) , b64(f2) , … , b64(f9) ,
//! ```
//!
//! **Every field is individually base64, including the plain integers** — `2` is
//! stored as `Mg==`. That is what makes the two separators safe: base64's
//! alphabet contains neither `,` nor `|`, so a URL with a comma in it (or with
//! `=`, which 3,199 of the corpus's URLs carry as a query separator) cannot
//! split a record. The tests assert that rather than trust it.
//!
//! **Both separators are TRAILING, not infix.** Every record in the 51,256-record
//! corpus ends with a `,` and so decodes as ten fields whose last is empty, and
//! every block ends with a `|` and so ends with an empty record. A decoder that
//! demanded exactly nine fields, or that treated an empty record as corruption,
//! would reject every real file. So the reading is "at least nine fields" and
//! "skip what does not parse", which is the same posture the client's own
//! `render/pdfLinks.ts` takes on the other side of the wire: a record we cannot
//! read costs its own link and nothing else, because a page missing one link is
//! still a page, and a page whose links all vanished because of a stray byte is
//! not.
//!
//! ## What the fields mean
//!
//! Verified against the 1703-page teacher-planner capture — every record of it,
//! not a sample:
//!
//! | # | meaning |
//! |---|---|
//! | 1 | the page these links are ON, 1-based — always the containing page |
//! | 2 | the TARGET page's `PAGEID` (see `Link.target_id`) |
//! | 3 | the TARGET page number, 1-based |
//! | 4–7 | the rect: x, y, w, h, in **DEVICE PANEL PIXELS** |
//! | 8 | kind: `1` web, `0` internal page jump |
//! | 9 | the URL, or the literal `none` for an internal link |
//!
//! **The rect needs no coordinate transform to sit on the page**: a `.note` page
//! IS the panel, the same space the ink is in (§9.1) — unlike a `.mark`'s ink
//! over the PDF it annotates, which needs §13.3's mapping. Across the corpus the
//! extremes are `x+w = 1401` and `y+h = 1865`, both just inside the N6's
//! 1404 × 1872.

const std = @import("std");
const note_mod = @import("note.zig");
const types = @import("types.zig");

/// A block that is not readable as records at all is `error.Corrupt`. Individual
/// unreadable RECORDS are not an error — they are skipped (see the header).
pub const Error = error{Corrupt} || std.mem.Allocator.Error;

/// Field 8. `1` is a web URL, `0` an internal page jump.
///
/// **It is a claim, not a guarantee.** Two records in the corpus say `web` and
/// carry the URI `none`, i.e. a web link with nowhere to go. Nothing here
/// repairs that — the record is reported as written and the consumer's scheme
/// allowlist refuses it, which is the same treatment any other unusable URI
/// gets.
pub const Kind = enum(u8) {
    internal = 0,
    web = 1,

    fn fromDecoded(s: []const u8) ?Kind {
        if (s.len != 1) return null;
        return switch (s[0]) {
            '0' => .internal,
            '1' => .web,
            else => null,
        };
    }
};

/// The literal a record carries in field 9 when there is no URL — an internal
/// page jump. It is the string `none`, not an empty field.
pub const no_uri = "none";

/// One link rectangle on one page. Strings borrow from the owning `Links`.
pub const Link = struct {
    /// Field 1: the page this link is ON, 1-based. Every record of the corpus
    /// repeats its own containing page here, so it is a redundancy rather than
    /// information — kept because it is the one field that can be checked
    /// against something known, which is what makes a garbled block detectable.
    source_page: u32,
    /// Field 2: **the TARGET page's `PAGEID`.** §14 filed this as a guess ("it is
    /// shaped like a PAGEID and varies per record"); it holds for all 51,256
    /// records of the corpus, matched against the `PAGEID` each page block
    /// actually carries. It is the stable form of `target_page`, and the one a
    /// consumer should prefer if page numbers are ever rewritten under it.
    target_id: []const u8,
    /// Field 3: the target page NUMBER, 1-based — not an index. `1` and
    /// meaningless on a web record, which is what `kind` is for.
    target_page: u32,
    /// Fields 4–7, **device panel pixels**, origin top-left, y down.
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    kind: Kind,
    /// Field 9: the URL, or `no_uri` (`"none"`) for an internal jump. Verbatim
    /// device-authored text — never trusted as a target without a scheme check.
    uri: []const u8,
};

/// A page's links, owning their strings.
pub const Links = struct {
    arena: std.heap.ArenaAllocator,
    items: []const Link,

    pub fn deinit(self: *Links) void {
        self.arena.deinit();
    }
};

/// Decodes an `EXTERNALLINKINFO` block's content bytes.
///
/// Records that do not decode are skipped, not fatal — including the empty one
/// the block's trailing `|` produces, which is why "skip" is the only workable
/// reading (see the header). An empty block, or one made entirely of unreadable
/// records, yields an empty list: a page with no usable links, stated as such.
pub fn parse(gpa: std.mem.Allocator, content: []const u8) Error!Links {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    var out: std.ArrayList(Link) = .empty;
    var records = std.mem.splitScalar(u8, content, '|');
    while (records.next()) |record| {
        const link = (try parseRecord(a, record)) orelse continue;
        try out.append(a, link);
    }
    return .{ .arena = arena, .items = out.items };
}

/// One record, or null when it is not one. Only allocation failure escapes: a
/// field that is not base64, a count below nine, an integer that is not one and
/// a kind that is neither `0` nor `1` are all "not a record".
fn parseRecord(a: std.mem.Allocator, record: []const u8) Error!?Link {
    // Nine fields is the record; a tenth empty one is the trailing `,` every
    // real record ends with, and anything beyond is ignored rather than fatal —
    // a firmware that appends a field must not cost the page its links.
    var fields: [9][]const u8 = undefined;
    var n: usize = 0;
    var it = std.mem.splitScalar(u8, record, ',');
    while (it.next()) |field| {
        if (n == fields.len) break;
        fields[n] = decodeField(a, field) catch |e| switch (e) {
            error.OutOfMemory => return error.OutOfMemory,
            error.Corrupt => return null,
        };
        n += 1;
    }
    if (n < fields.len) return null;

    return .{
        .source_page = parseU32(fields[0]) orelse return null,
        .target_id = fields[1],
        .target_page = parseU32(fields[2]) orelse return null,
        .x = parseI32(fields[3]) orelse return null,
        .y = parseI32(fields[4]) orelse return null,
        .w = parseI32(fields[5]) orelse return null,
        .h = parseI32(fields[6]) orelse return null,
        .kind = Kind.fromDecoded(fields[7]) orelse return null,
        .uri = fields[8],
    };
}

fn decodeField(a: std.mem.Allocator, field: []const u8) Error![]const u8 {
    const dec = std.base64.standard.Decoder;
    const len = dec.calcSizeForSlice(field) catch return error.Corrupt;
    const buf = try a.alloc(u8, len);
    dec.decode(buf, field) catch return error.Corrupt;
    return buf;
}

fn parseU32(s: []const u8) ?u32 {
    return std.fmt.parseInt(u32, s, 10) catch null;
}

fn parseI32(s: []const u8) ?i32 {
    return std.fmt.parseInt(i32, s, 10) catch null;
}

/// Reads and decodes page `page_index`'s links, or null when the page has no
/// `EXTERNALLINKINFO` block (address 0 — every page of an ordinary `.note`).
pub fn forPage(
    gpa: std.mem.Allocator,
    note: note_mod.Note,
    page_index: usize,
) (Error || note_mod.Error)!?Links {
    if (page_index >= note.pages.len) return null;
    return forParsedPage(gpa, note.source, note.pages[page_index]);
}

/// The bare-page flavour of `forPage`, for a caller holding one parsed page and
/// a source rather than a whole `Note` (the indexer's shape).
pub fn forParsedPage(
    gpa: std.mem.Allocator,
    src: note_mod.Source,
    page: types.Page,
) (Error || note_mod.Error)!?Links {
    const addr = page.linksAddress();
    if (addr == 0) return null;
    const held = src.blockHeld(gpa, addr) catch |e| return switch (e) {
        error.OutOfMemory => error.OutOfMemory,
        error.OutOfBounds => error.Truncated,
        error.ReadFailed => error.ReadFailed,
    };
    defer held.deinit(gpa);
    return try parse(gpa, held.bytes);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Builds a block the way the device writes one: every field base64, fields
/// joined with `,` **and trailed by one**, records joined with `|` **and trailed
/// by one**. Both trailers are the real shape (see the header), so a test that
/// used infix separators would be testing a file that does not exist.
fn buildBlock(a: std.mem.Allocator, records: []const []const []const u8) ![]u8 {
    const enc = std.base64.standard.Encoder;
    var out: std.ArrayList(u8) = .empty;
    for (records) |record| {
        for (record) |field| {
            const buf = try a.alloc(u8, enc.calcSize(field.len));
            _ = enc.encode(buf, field);
            try out.appendSlice(a, buf);
            try out.append(a, ',');
        }
        try out.append(a, '|');
    }
    return out.toOwnedSlice(a);
}

test "the |/comma/base64 grammar, with both separators trailing" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // Two records in the device's exact shape: one web, one internal.
    const block = try buildBlock(a, &.{
        &.{ "2", "P20260804145314013102EjfmKbJyxu7V", "1", "819", "614", "187", "28", "1", "https://onplanners.com/x" },
        &.{ "2", "P20260804145735477580ALeRux3tsxK6", "21", "1358", "1076", "43", "130", "0", "none" },
    });

    var links = try parse(std.testing.allocator, block);
    defer links.deinit();

    // TWO, not three: the trailing `|` makes an empty final record, and the
    // trailing `,` a tenth empty field. Neither is a link and neither is fatal.
    try std.testing.expectEqual(@as(usize, 2), links.items.len);

    const web = links.items[0];
    try std.testing.expectEqual(@as(u32, 2), web.source_page);
    try std.testing.expectEqualStrings("P20260804145314013102EjfmKbJyxu7V", web.target_id);
    try std.testing.expectEqual(Kind.web, web.kind);
    try std.testing.expectEqual(@as(i32, 819), web.x);
    try std.testing.expectEqual(@as(i32, 614), web.y);
    try std.testing.expectEqual(@as(i32, 187), web.w);
    try std.testing.expectEqual(@as(i32, 28), web.h);
    try std.testing.expectEqualStrings("https://onplanners.com/x", web.uri);

    const jump = links.items[1];
    try std.testing.expectEqual(Kind.internal, jump.kind);
    try std.testing.expectEqual(@as(u32, 21), jump.target_page);
    try std.testing.expectEqualStrings(no_uri, jump.uri);
}

test "a URI carrying a comma and an = survives the field split" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The whole reason every field is base64. 3,199 of the corpus's 3,209 URLs
    // carry `=`; a comma inside one is what would silently shear a record in
    // two if the encoding were plain text, so it is asserted, not assumed.
    const uri = "https://example.com/a,b?q=1&r=2,3#frag=x";
    const block = try buildBlock(a, &.{
        &.{ "7", "PID", "1", "10", "20", "30", "40", "1", uri },
    });
    // The encoded record must itself contain neither separator — the property
    // that makes the grammar work at all.
    try std.testing.expect(std.mem.indexOfScalar(u8, block[0 .. block.len - 1], '|') == null);

    var links = try parse(std.testing.allocator, block);
    defer links.deinit();
    try std.testing.expectEqual(@as(usize, 1), links.items.len);
    try std.testing.expectEqualStrings(uri, links.items[0].uri);
}

test "a record that is not one is skipped, and costs only itself" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const good = try buildBlock(a, &.{
        &.{ "3", "PID", "5", "48", "283", "483", "46", "0", "none" },
    });
    var block: std.ArrayList(u8) = .empty;
    // Too few fields, a field that is not base64, a non-numeric rect, and an
    // unknown kind — each between two good records.
    try block.appendSlice(a, good);
    try block.appendSlice(a, "Mw==,UElE,|"); // 3 fields
    try block.appendSlice(a, good);
    try block.appendSlice(a, "!!!,not,base64,at,all,here,ok,ok,ok,|");
    try block.appendSlice(a, good);
    try block.appendSlice(a, try buildBlock(a, &.{
        &.{ "3", "PID", "5", "forty", "283", "483", "46", "0", "none" },
    }));
    try block.appendSlice(a, good);
    try block.appendSlice(a, try buildBlock(a, &.{
        &.{ "3", "PID", "5", "48", "283", "483", "46", "9", "none" },
    }));

    var links = try parse(std.testing.allocator, block.items);
    defer links.deinit();
    try std.testing.expectEqual(@as(usize, 4), links.items.len);
    for (links.items) |l| try std.testing.expectEqual(@as(i32, 48), l.x);
}

test "an empty block, and a block of nothing but separators, are zero links" {
    var empty = try parse(std.testing.allocator, "");
    defer empty.deinit();
    try std.testing.expectEqual(@as(usize, 0), empty.items.len);

    var seps = try parse(std.testing.allocator, "|||");
    defer seps.deinit();
    try std.testing.expectEqual(@as(usize, 0), seps.items.len);
}

// The container-level half of this module's tests — a page whose links come off
// a real block address, and the zero-address page that must cost no read — lives
// in `tests/note_test.zig`, which is the module that can reach the builder.
