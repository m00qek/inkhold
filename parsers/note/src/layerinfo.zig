//! `LAYERINFO` parser — the per-page layer-panel state (tier-2 page data).
//!
//! A page block may carry a `LAYERINFO` value: a JSON array describing the FULL
//! layer stack in **top-to-bottom order, including hidden and deleted entries**.
//! `LAYERSEQ` is that same order filtered down to the layers the device actually
//! draws (hidden and deleted both omitted) — capture-proven on
//! `tests/fixtures/layers_edited.note`. Display names live ONLY here: the layer
//! block's `LAYERNAME` is a slot constant (`LAYER3`), never the user's name.
//!
//! ## Two encodings, both real — mixed per page within one file
//!
//! - **`#`-JSON** (legacy): literal JSON with `#` standing in where JSON syntax
//!   expects `:`. First byte `[` or `{`.
//! - **base64 of plain JSON**: an on-device layer-panel edit REWRITES that
//!   page's `LAYERINFO` as base64-encoded ordinary JSON. First byte is neither
//!   `[` nor `{`.
//!
//! `layers_edited.note` carries both at once (page 1 `#`-JSON, page 2 base64),
//! which is why detection is per-value, on the first byte.
//!
//! The `#` fixup is applied **only at structural positions** — while scanning
//! OUTSIDE a JSON string (with escape handling) — never inside one, so a layer
//! *name* containing a literal `#` survives. A naive global replace would
//! corrupt it.
//!
//! ## Hostile-input posture
//!
//! Mirrors the container parser's: malformed `LAYERINFO` (bad base64, junk
//! JSON, an id that fits no layer model) is a **recorded absence**, never an
//! error — the note still parses. Only `Allocator.Error` escapes `parse`.

const std = @import("std");

/// One layer's panel state, typed. Order within the parsed slice is the file's
/// order: the full stack, top-to-bottom.
pub const Entry = struct {
    /// `0` = MAINLAYER, `1..3` = LAYER1..LAYER3, `-1` = BGLAYER (the
    /// background/template layer; `is_background` is set on the same entry).
    layer_id: i32,
    /// The user-visible display name (user-renamable, e.g. "Layer Renamed").
    /// This is the ONLY place display names exist in the format.
    name: []const u8,
    is_visible: bool,
    is_deleted: bool,
    is_current: bool,
    is_background: bool,
};

/// The JSON shape the device writes. Unknown fields (`isAllowAdd`,
/// `isAllowUp`, `isAllowDown`) are ignored; `layerId` is required — an entry
/// without one describes no layer and marks the whole value malformed.
const Wire = struct {
    layerId: i64,
    name: []const u8 = "",
    isBackgroundLayer: bool = false,
    isCurrentLayer: bool = false,
    isVisible: bool = true,
    isDeleted: bool = false,
};

/// Parses a raw `LAYERINFO` value into typed entries, or **null when the value
/// is malformed in any way** (the recorded-absence posture above). Detection is
/// on the first byte: `[`/`{` → `#`-JSON, anything else → base64.
///
/// Everything allocated (including the returned slice and the names it holds)
/// comes from `a`, which is expected to be an arena: intermediate buffers are
/// not individually freed, and names may alias them.
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
            // An id outside i32 fits no layer model this format has ever shown.
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

/// Copies `raw` and turns `#` back into `:` at STRUCTURAL positions only —
/// scanning with JSON string/escape state, so a `#` inside a quoted name is
/// left alone. This is the tokenizer-level substitution the encoding calls for:
/// the device wrote `#` wherever JSON syntax wanted `:` (the `:` would not
/// survive the `<KEY:VALUE>` grammar of its own metadata parser).
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

// ---------------------------------------------------------------------------
// Tests. Real-value strings are verbatim from the captures; the full-fixture
// assertions live in tests/note_test.zig.
// ---------------------------------------------------------------------------

const testing = std.testing;

/// A verbatim `#`-JSON entry pair from the captures' shape.
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

    // Truncated base64 (a real base64 prefix cut mid-quantum).
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "W3sibGF5ZXJJZCI6"));
    // Base64 alphabet, but the decoded bytes are not JSON.
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "aGVsbG8gd29ybGQ="));
    // Junk that is neither JSON-first-byte nor base64.
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "!!not a thing!!"));
    // JSON, but not the array shape.
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "{\"layerId\"#0}"));
    // An array of the wrong element shape (no layerId).
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "[{\"name\"#\"x\"}]"));
    // Truncated #-JSON.
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "[{\"layerId\"#0,"));
    // A layerId that fits no layer model.
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, "[{\"layerId\"#99999999999}]"));
    // Empty value.
    try testing.expectEqual(@as(?[]const Entry, null), try parse(a, ""));

    // An empty ARRAY is well-formed: present, zero entries.
    const empty = (try parse(a, "[]")).?;
    try testing.expectEqual(@as(usize, 0), empty.len);
}
