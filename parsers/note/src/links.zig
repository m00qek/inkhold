//! Tier 3: a PDF template's link rectangles from a page's `EXTERNALLINKINFO`
//! block (`note-format.md` §14). Per-field base64, not base64 JSON, with
//! trailing `,` and `|` separators; unreadable records are skipped.

const std = @import("std");
const note_mod = @import("note.zig");
const types = @import("types.zig");

/// A block unreadable as records at all; bad individual records are skipped.
pub const Error = error{Corrupt} || std.mem.Allocator.Error;

/// Field 8. A claim only: some `web` records carry `none`; the consumer's
/// scheme allowlist refuses those.
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

/// Field 9 for an internal jump: the string `none`, not an empty field.
pub const no_uri = "none";

pub const Link = struct {
    /// Field 1: always the containing page, kept as a corruption check.
    source_page: u32,
    /// Field 2: the target page's `PAGEID`, the stable form of `target_page`.
    target_id: []const u8,
    /// Field 3: the target page number, 1-based (meaningless on web records).
    target_page: u32,
    /// Fields 4–7, device panel pixels, origin top-left, y down.
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    kind: Kind,
    /// Field 9, untrusted device text; scheme-check before use.
    uri: []const u8,
};

pub const Links = struct {
    arena: std.heap.ArenaAllocator,
    items: []const Link,

    pub fn deinit(self: *Links) void {
        self.arena.deinit();
    }
};

/// Decodes a block's content bytes; undecodable records (including the empty
/// trailing one) are skipped.
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

/// One record, or null; only allocation failure escapes.
fn parseRecord(a: std.mem.Allocator, record: []const u8) Error!?Link {
    // A tenth empty field is the trailing `,`; extra fields are ignored.
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

/// Page `page_index`'s links, or null at address 0.
pub fn forPage(
    gpa: std.mem.Allocator,
    note: note_mod.Note,
    page_index: usize,
) (Error || note_mod.Error)!?Links {
    if (page_index >= note.pages.len) return null;
    return forParsedPage(gpa, note.source, note.pages[page_index]);
}

/// `forPage` for one parsed page and a source.
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

// ---- tests ----

/// Builds a block as the device does, with trailing `,` and `|`.
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

    const block = try buildBlock(a, &.{
        &.{ "2", "P20260804145314013102EjfmKbJyxu7V", "1", "819", "614", "187", "28", "1", "https://onplanners.com/x" },
        &.{ "2", "P20260804145735477580ALeRux3tsxK6", "21", "1358", "1076", "43", "130", "0", "none" },
    });

    var links = try parse(std.testing.allocator, block);
    defer links.deinit();

    // Two: the trailers make an empty record and an empty tenth field.
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

    // Commas inside a URL must not shear a record.
    const uri = "https://example.com/a,b?q=1&r=2,3#frag=x";
    const block = try buildBlock(a, &.{
        &.{ "7", "PID", "1", "10", "20", "30", "40", "1", uri },
    });
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

// Container-level link tests live in `tests/note_test.zig`.
