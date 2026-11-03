//! `LAYERINFO` parser: per-page layer-panel state, full stack top-to-bottom
//! (see `note-format.md` §4.3). Encoding is detected per value on the first
//! byte. Malformed values are a recorded absence, never an error.

const std = @import("std");

/// One layer's panel state, in file order (top-to-bottom).
pub const Entry = struct {
    /// `0` = MAINLAYER, `1..3` = LAYER1..3, `-1` = BGLAYER.
    layer_id: i32,
    /// The user's display name; the only place names exist in the format.
    name: []const u8,
    is_visible: bool,
    is_deleted: bool,
    is_current: bool,
    is_background: bool,
};

/// The device's JSON shape; `layerId` is required, unknown fields ignored.
const Wire = struct {
    layerId: i64,
    name: []const u8 = "",
    isBackgroundLayer: bool = false,
    isCurrentLayer: bool = false,
    isVisible: bool = true,
    isDeleted: bool = false,
};

/// Parses a raw `LAYERINFO` value, or null when malformed. `[`/`{` first means
/// `#`-JSON, anything else base64. Allocates from `a`, expected to be an arena.
pub fn parse(a: std.mem.Allocator, raw: []const u8) std.mem.Allocator.Error!?[]const Entry {
    if (raw.len == 0) return null;

    const doc: []const u8 = switch (raw[0]) {
        '[', '{' => try decodeHashJson(a, raw),
        else => decodeBase64(a, raw) catch |e| switch (e) {
            error.OutOfMemory => return error.OutOfMemory,
            error.Malformed => return null,
        },
    };

    const wires = std.json.parseFromSliceLeaky([]Wire, a, doc, .{
        .ignore_unknown_fields = true,
    }) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return null, // junk JSON, wrong shape, missing layerId, ...
    };

    const out = try a.alloc(Entry, wires.len);
    for (wires, out) |w, *entry| {
        entry.* = .{
            .layer_id = std.math.cast(i32, w.layerId) orelse return null,
            .name = w.name,
            .is_visible = w.isVisible,
            .is_deleted = w.isDeleted,
            .is_current = w.isCurrentLayer,
            .is_background = w.isBackgroundLayer,
        };
    }
    return out;
}

/// Turns `#` back into `:` only outside JSON strings, so a `#` in a layer name
/// survives.
fn decodeHashJson(a: std.mem.Allocator, raw: []const u8) std.mem.Allocator.Error![]u8 {
    const out = try a.dupe(u8, raw);
    var in_string = false;
    var escaped = false;
    for (out) |*c| {
        if (in_string) {
            if (escaped) {
                escaped = false;
            } else switch (c.*) {
                '\\' => escaped = true,
                '"' => in_string = false,
                else => {},
            }
        } else switch (c.*) {
            '"' => in_string = true,
            '#' => c.* = ':',
            else => {},
        }
    }
    return out;
}

fn decodeBase64(a: std.mem.Allocator, raw: []const u8) (std.mem.Allocator.Error || error{Malformed})![]u8 {
    const dec = std.base64.standard.Decoder;
    const n = dec.calcSizeForSlice(raw) catch return error.Malformed;
    const buf = try a.alloc(u8, n);
    dec.decode(buf, raw) catch return error.Malformed;
    return buf;
}

// ---- tests (strings verbatim from captures) ----

const testing = std.testing;

const hash_json =
    "[{\"layerId\"#0,\"name\"#\"Main Layer\",\"isBackgroundLayer\"#false," ++
    "\"isAllowAdd\"#false,\"isCurrentLayer\"#true,\"isVisible\"#true," ++
    "\"isDeleted\"#false,\"isAllowUp\"#false,\"isAllowDown\"#false}," ++
    "{\"layerId\"#-1,\"name\"#\"Background Layer\",\"isBackgroundLayer\"#true," ++
    "\"isAllowAdd\"#true,\"isCurrentLayer\"#false,\"isVisible\"#true," ++
    "\"isDeleted\"#false,\"isAllowUp\"#false,\"isAllowDown\"#false}]";

test "parse: #-JSON — typed facts, including the -1 background id" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    const entries = (try parse(arena.allocator(), hash_json)).?;
    try testing.expectEqual(@as(usize, 2), entries.len);

    try testing.expectEqual(@as(i32, 0), entries[0].layer_id);
    try testing.expectEqualStrings("Main Layer", entries[0].name);
    try testing.expect(entries[0].is_current);
    try testing.expect(entries[0].is_visible);
    try testing.expect(!entries[0].is_deleted);
    try testing.expect(!entries[0].is_background);

    try testing.expectEqual(@as(i32, -1), entries[1].layer_id);
    try testing.expectEqualStrings("Background Layer", entries[1].name);
    try testing.expect(entries[1].is_background);
    try testing.expect(!entries[1].is_current);
}

test "parse: base64 of plain JSON — the on-device-edit encoding" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const plain =
        "[{\"layerId\":2,\"name\":\"Layer 2\",\"isBackgroundLayer\":false," ++
        "\"isCurrentLayer\":false,\"isVisible\":false,\"isDeleted\":false}]";
    const enc = std.base64.standard.Encoder;
    const b64 = try a.alloc(u8, enc.calcSize(plain.len));
    _ = enc.encode(b64, plain);

    const entries = (try parse(a, b64)).?;
    try testing.expectEqual(@as(usize, 1), entries.len);
    try testing.expectEqual(@as(i32, 2), entries[0].layer_id);
    try testing.expectEqualStrings("Layer 2", entries[0].name);
    try testing.expect(!entries[0].is_visible); // hidden, NOT deleted
    try testing.expect(!entries[0].is_deleted);
}

test "parse: a '#' inside a NAME survives — the fixup is structural only" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    const doc = "[{\"layerId\"#1,\"name\"#\"tag #1 \\\"quoted\\\"\",\"isVisible\"#true}]";
    const entries = (try parse(arena.allocator(), doc)).?;
    try testing.expectEqual(@as(usize, 1), entries.len);
    try testing.expectEqualStrings("tag #1 \"quoted\"", entries[0].name);
}

test "parse: hostile inputs are a recorded absence, never an error" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "W3sibGF5ZXJJZCI6"));
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "aGVsbG8gd29ybGQ="));
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "!!not a thing!!"));
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "{\"layerId\"#0}"));
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "[{\"name\"#\"x\"}]"));
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "[{\"layerId\"#0,"));
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "[{\"layerId\"#99999999999}]"));
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, ""));

    const empty = (try parse(a, "[]")).?;
    try testing.expectEqual(@as(usize, 0), empty.len);
}
