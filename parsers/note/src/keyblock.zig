//! Parser for `.note` keyword blocks (metadata blocks).
//!
//! A metadata block's payload is a flat sequence of `<KEY:VALUE>` pairs, e.g.
//! `<PAGE1:138538><FILE_FEATURE:9179>`. Keys contain no `:`, `<`, or `>`; a
//! value runs from the first `:` to the next `>`. Keys may repeat (e.g. several
//! `PAGE*` entries), so we keep an ordered list of entries rather than a map —
//! this preserves order and duplicates, and for the handful of entries per block
//! a linear scan is faster than hashing.
//!
//! (This module was `metadata.zig` in the original layout; renamed to name what
//! it is — a `<KEY:VALUE>` block parser. Logic unchanged.)

const std = @import("std");

pub const Entry = struct {
    key: []const u8,
    value: []const u8,
};

pub const Block = struct {
    /// Entries in file order. Slices borrow from the parsed payload.
    entries: []const Entry,

    /// Returns the value of the first entry with `key`, or null.
    pub fn get(self: Block, key: []const u8) ?[]const u8 {
        for (self.entries) |e| {
            if (std.mem.eql(u8, e.key, key)) return e.value;
        }
        return null;
    }

    /// Returns the first entry's value parsed as an unsigned integer, or null
    /// if the key is absent or the value is not a valid base-10 integer.
    pub fn getInt(self: Block, key: []const u8) ?u64 {
        const v = self.get(key) orelse return null;
        return std.fmt.parseInt(u64, v, 10) catch null;
    }

    /// Number of entries whose key equals `key`.
    pub fn count(self: Block, key: []const u8) usize {
        var n: usize = 0;
        for (self.entries) |e| {
            if (std.mem.eql(u8, e.key, key)) n += 1;
        }
        return n;
    }
};

/// Parses a metadata block payload into an ordered `Block`.
///
/// The returned `Block.entries` slice is allocated with `allocator`; the key and
/// value slices inside it borrow from `payload` (which must outlive the Block).
pub fn parse(allocator: std.mem.Allocator, payload: []const u8) std.mem.Allocator.Error!Block {
    // Two passes: count entries, then fill an exact-size slice. This avoids a
    // growable list and gives a tight allocation.
    const n = countEntries(payload);
    const entries = try allocator.alloc(Entry, n);
    var i: usize = 0;
    var it = Iterator{ .payload = payload };
    while (it.next()) |e| : (i += 1) entries[i] = e;
    return .{ .entries = entries };
}

fn countEntries(payload: []const u8) usize {
    var n: usize = 0;
    var it = Iterator{ .payload = payload };
    while (it.next()) |_| n += 1;
    return n;
}

/// Scans `<KEY:VALUE>` pairs without allocating. Malformed fragments are skipped.
const Iterator = struct {
    payload: []const u8,
    pos: usize = 0,

    fn next(self: *Iterator) ?Entry {
        const p = self.payload;
        while (self.pos < p.len) {
            const open = std.mem.indexOfScalarPos(u8, p, self.pos, '<') orelse return null;
            const colon = std.mem.indexOfScalarPos(u8, p, open + 1, ':') orelse return null;
            const close = std.mem.indexOfScalarPos(u8, p, colon + 1, '>') orelse return null;
            const key = p[open + 1 .. colon];
            const value = p[colon + 1 .. close];
            // A well-formed key has no nested '<' before the ':'. When it does,
            // the ':' search ran past an unterminated '<KEY' fragment and into a
            // LATER pair's separator, so `close` belongs to that later pair —
            // skipping to `close + 1` would swallow it (e.g. `<KEY><A:B>` would
            // drop the valid `<A:B>`). Rescan from just past the offending '<'
            // instead: `pos` still advances strictly (no infinite loop), only the
            // malformed fragment is discarded, and the following pair is recovered.
            if (std.mem.indexOfScalar(u8, key, '<') != null) {
                self.pos = open + 1;
                continue;
            }
            self.pos = close + 1;
            return .{ .key = key, .value = value };
        }
        return null;
    }
};

test "parse extracts ordered key/value pairs" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const b = try parse(arena.allocator(), "<PAGE1:138538><FILE_FEATURE:9179><STYLE_x:330>");
    try std.testing.expectEqual(@as(usize, 3), b.entries.len);
    try std.testing.expectEqualStrings("138538", b.get("PAGE1").?);
    try std.testing.expectEqual(@as(u64, 9179), b.getInt("FILE_FEATURE").?);
    try std.testing.expect(b.get("MISSING") == null);
}

test "value may contain characters that are not '>'" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    // LAYERINFO-style value: JSON using '#' and commas, no '>'.
    const b = try parse(arena.allocator(), "<LAYERINFO:[{\"id\"#0,\"v\"#true}]><ORIENTATION:1000>");
    try std.testing.expectEqualStrings("[{\"id\"#0,\"v\"#true}]", b.get("LAYERINFO").?);
    try std.testing.expectEqualStrings("1000", b.get("ORIENTATION").?);
}

test "duplicate keys are preserved and counted" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const b = try parse(arena.allocator(), "<PAGE:1><PAGE:2><PAGE:3>");
    try std.testing.expectEqual(@as(usize, 3), b.count("PAGE"));
    try std.testing.expectEqualStrings("1", b.get("PAGE").?); // first match
}

test "getInt returns null for non-integer values" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const b = try parse(arena.allocator(), "<APPLY_EQUIPMENT:N6>");
    try std.testing.expect(b.getInt("APPLY_EQUIPMENT") == null);
}

test "recovery after a malformed fragment keeps the following valid pair" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    // `<KEY>` has no ':' of its own, so the colon scan jumps into `<A:B>`; the
    // computed key `KEY><A` carries a nested '<'. The fragment is discarded, but
    // the recovery must rescan from just past that '<' — not past the '>' it
    // wrongly latched onto — so the genuine `<A:B>` pair is still returned.
    const b = try parse(arena.allocator(), "<KEY><A:B>");
    try std.testing.expectEqual(@as(usize, 1), b.entries.len);
    try std.testing.expectEqualStrings("A", b.entries[0].key);
    try std.testing.expectEqualStrings("B", b.entries[0].value);
    try std.testing.expectEqualStrings("B", b.get("A").?);
    try std.testing.expect(b.get("KEY") == null);
}
