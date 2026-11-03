//! Parser for `.note` `<KEY:VALUE>` metadata blocks. Keys may repeat, so
//! entries stay an ordered list.

const std = @import("std");

pub const Entry = struct {
    key: []const u8,
    value: []const u8,
};

pub const Block = struct {
    /// Entries in file order, borrowing from the payload.
    entries: []const Entry,

    pub fn get(self: Block, key: []const u8) ?[]const u8 {
        for (self.entries) |e| {
            if (std.mem.eql(u8, e.key, key)) return e.value;
        }
        return null;
    }

    pub fn getInt(self: Block, key: []const u8) ?u64 {
        const v = self.get(key) orelse return null;
        return std.fmt.parseInt(u64, v, 10) catch null;
    }

    pub fn count(self: Block, key: []const u8) usize {
        var n: usize = 0;
        for (self.entries) |e| {
            if (std.mem.eql(u8, e.key, key)) n += 1;
        }
        return n;
    }
};

/// Parses a block payload. `entries` is allocated with `allocator`; keys and
/// values borrow from `payload`.
pub fn parse(allocator: std.mem.Allocator, payload: []const u8) std.mem.Allocator.Error!Block {
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
            // A '<' inside the key means the ':' search ran past an unterminated
            // fragment into a later pair; rescan from just past that '<' so the
            // later pair (`<KEY><A:B>`) is recovered.
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
    // The recovery must rescan past the nested '<', not the '>' it latched onto.
    const b = try parse(arena.allocator(), "<KEY><A:B>");
    try std.testing.expectEqual(@as(usize, 1), b.entries.len);
    try std.testing.expectEqualStrings("A", b.entries[0].key);
    try std.testing.expectEqualStrings("B", b.entries[0].value);
    try std.testing.expectEqualStrings("B", b.get("A").?);
    try std.testing.expect(b.get("KEY") == null);
}
