//! Structure types for a parsed `.note` container, plus the format facts both
//! `render.zig` and `page_payload.zig` depend on (draw order, blank-background
//! shortcut, landscape row-width swap), kept in one place.

const std = @import("std");
const keyblock = @import("keyblock.zig");
const layerinfo = @import("layerinfo.zig");

/// The five fixed layer slots, in the order the format stores them.
pub const LayerSlot = enum(u8) {
    main = 0,
    layer1 = 1,
    layer2 = 2,
    layer3 = 3,
    background = 4,

    pub fn key(self: LayerSlot) []const u8 {
        return switch (self) {
            .main => "MAINLAYER",
            .layer1 => "LAYER1",
            .layer2 => "LAYER2",
            .layer3 => "LAYER3",
            .background => "BGLAYER",
        };
    }

    /// `0` = MAINLAYER, `1..3` = LAYERn, `-1` = BGLAYER; null otherwise.
    pub fn fromLayerId(id: i32) ?LayerSlot {
        return switch (id) {
            0 => .main,
            1 => .layer1,
            2 => .layer2,
            3 => .layer3,
            -1 => .background,
            else => null,
        };
    }

    /// The slot's one-byte SNPG v2 wire id (the enum value; background = 4).
    pub fn wireId(self: LayerSlot) u8 {
        return @intFromEnum(self);
    }

    pub fn fromWireId(id: u8) ?LayerSlot {
        if (id > @intFromEnum(LayerSlot.background)) return null;
        return @enumFromInt(id);
    }

    pub const all = [_]LayerSlot{ .main, .layer1, .layer2, .layer3, .background };
};

/// Per-page `ORIENTATION`, `1000 + degrees` (`note-format.md` §9.3). 90° and
/// 270° store the raster natively landscape (swapped row width), so both are
/// `horizontal`; 0° and 180° are `vertical`.
pub const Orientation = enum {
    vertical,
    horizontal,

    /// A representative raw value (90° for horizontal), for fixtures and dumps.
    pub fn value(self: Orientation) []const u8 {
        return switch (self) {
            .vertical => "1000",
            .horizontal => "1090",
        };
    }

    /// `"1090"` and `"1270"` are horizontal; anything else, or absent, vertical.
    pub fn fromValue(raw: ?[]const u8) Orientation {
        const s = raw orelse return .vertical;
        return if (std.mem.eql(u8, s, "1090") or std.mem.eql(u8, s, "1270"))
            .horizontal
        else
            .vertical;
    }
};

pub const Layer = struct {
    slot: LayerSlot,
    block: keyblock.Block,

    pub fn name(self: Layer) ?[]const u8 {
        return self.block.get("LAYERNAME");
    }
    pub fn protocol(self: Layer) ?[]const u8 {
        return self.block.get("LAYERPROTOCOL");
    }
    pub fn layerType(self: Layer) ?[]const u8 {
        return self.block.get("LAYERTYPE");
    }
    /// Address of this layer's bitmap content block (0 == none).
    pub fn bitmapAddress(self: Layer) u32 {
        return @intCast(self.block.getInt("LAYERBITMAP") orelse 0);
    }
};

pub const Page = struct {
    block: keyblock.Block,
    /// The `<n>` of the page's footer `PAGE<n>` key, 1-based. Not index + 1 for
    /// a `.mark`, which stores only annotated pages (`note-format.md` §13.2).
    number: u32,
    layers: []const Layer,
    /// Parsed `LAYERINFO`, or null when absent or malformed.
    layer_info: ?[]const layerinfo.Entry = null,

    pub fn style(self: Page) ?[]const u8 {
        return self.block.get("PAGESTYLE");
    }
    /// `PAGESTYLEMD5`, the style asset's hash; `"0"` or absent is no custom
    /// asset.
    pub fn styleMd5(self: Page) ?[]const u8 {
        return self.block.get("PAGESTYLEMD5");
    }
    /// A custom style asset (`PAGESTYLEMD5 != "0"`, not `style_white`): the gate
    /// for asking whether the background is RLE or a browser-native image.
    pub fn hasCustomStyle(self: Page) bool {
        const md5 = self.styleMd5() orelse return false;
        if (std.mem.eql(u8, md5, "0")) return false;
        return !self.isWhiteStyle();
    }
    /// A `.horizontal` page is decoded at `Dimensions.oriented` dims.
    pub fn orientation(self: Page) Orientation {
        return Orientation.fromValue(self.orientationRaw());
    }
    /// Raw `ORIENTATION`, for dumps and tests; branch on `orientation()`.
    pub fn orientationRaw(self: Page) ?[]const u8 {
        return self.block.get("ORIENTATION");
    }
    pub fn pageId(self: Page) ?[]const u8 {
        return self.block.get("PAGEID");
    }
    /// Address of the vector strokes (`TOTALPATH`, 0 == none), charted in
    /// `note-format.md` §10 but not decoded: rendering uses the rasters.
    pub fn totalPathAddress(self: Page) u32 {
        return @intCast(self.block.getInt("TOTALPATH") orelse 0);
    }

    /// Handwriting-recognition status: 0 none, 1 done, 2 running.
    pub fn recognitionStatus(self: Page) u8 {
        return @intCast(self.block.getInt("RECOGNSTATUS") orelse 0);
    }
    pub fn recognitionAddress(self: Page) u32 {
        return @intCast(self.block.getInt("RECOGNTEXT") orelse 0);
    }

    /// Address of `EXTERNALLINKINFO` (`note-format.md` §14); 0 on ordinary pages.
    pub fn linksAddress(self: Page) u32 {
        return @intCast(self.block.getInt("EXTERNALLINKINFO") orelse 0);
    }

    pub fn layer(self: Page, slot: LayerSlot) ?Layer {
        for (self.layers) |l| {
            if (l.slot == slot) return l;
        }
        return null;
    }

    pub fn infoForSlot(self: Page, slot: LayerSlot) ?layerinfo.Entry {
        const entries = self.layer_info orelse return null;
        for (entries) |e| {
            if (LayerSlot.fromLayerId(e.layer_id) == slot) return e;
        }
        return null;
    }

    /// The `style_white` style, half of the blank-background shortcut.
    pub fn isWhiteStyle(self: Page) bool {
        const s = self.style() orelse return false;
        return std.mem.eql(u8, s, "style_white");
    }
};

/// A `style_white` background block of exactly this size is the blank-fill
/// shortcut: its special-length marker means `0x400` pixels, not `0x4000`.
pub const special_white_style_block_size: usize = 0x140e;

pub const default_bottom_up = [_]LayerSlot{ .background, .main, .layer1, .layer2, .layer3 };

/// Bottom-to-top draw order: `LAYERSEQ` (top-to-bottom) reversed, or the
/// default when absent or unrecognised.
pub fn bottomUpOrder(page: Page, buf: *[LayerSlot.all.len]LayerSlot) []const LayerSlot {
    const seq_str = page.block.get("LAYERSEQ") orelse {
        @memcpy(buf, &default_bottom_up);
        return buf[0..];
    };

    var tokens: [LayerSlot.all.len]LayerSlot = undefined;
    var n: usize = 0;
    var it = std.mem.splitScalar(u8, seq_str, ',');
    while (it.next()) |tok| {
        if (n >= tokens.len) break;
        if (slotFromKey(tok)) |slot| {
            tokens[n] = slot;
            n += 1;
        }
    }
    if (n == 0) {
        @memcpy(buf, &default_bottom_up);
        return buf[0..];
    }
    for (0..n) |i| buf[i] = tokens[n - 1 - i]; // reverse -> bottom-up
    return buf[0..n];
}

/// One SNPG emit entry; `hidden` streams are excluded from the default
/// composite.
pub const EmitLayer = struct { slot: LayerSlot, hidden: bool };

/// Bottom-to-top SNPG emit order: `LAYERINFO` minus deleted entries, with hidden
/// layers kept and flagged so the client can toggle them. Degrades to
/// `bottomUpOrder` with nothing hidden. `bottomUpOrder` stays the draw list.
pub fn bottomUpEmitOrder(page: Page, buf: *[LayerSlot.all.len]EmitLayer) []const EmitLayer {
    if (page.layer_info) |entries| {
        var n: usize = 0;
        var i = entries.len;
        while (i > 0) {
            i -= 1; // reverse: entries are top-to-bottom
            const e = entries[i];
            if (e.is_deleted) continue;
            const slot = LayerSlot.fromLayerId(e.layer_id) orelse continue;
            if (n >= buf.len) break;
            var dup = false;
            for (buf[0..n]) |seen| dup = dup or seen.slot == slot;
            if (dup) continue;
            buf[n] = .{ .slot = slot, .hidden = !e.is_visible };
            n += 1;
        }
        if (n > 0) return buf[0..n];
    }
    var seq_buf: [LayerSlot.all.len]LayerSlot = undefined;
    const order = bottomUpOrder(page, &seq_buf);
    for (order, buf[0..order.len]) |slot, *out| out.* = .{ .slot = slot, .hidden = false };
    return buf[0..order.len];
}

pub fn slotFromKey(key: []const u8) ?LayerSlot {
    for (LayerSlot.all) |slot| {
        if (std.mem.eql(u8, key, slot.key())) return slot;
    }
    return null;
}

pub const Dimensions = struct {
    width: u32,
    height: u32,

    pub const default: Dimensions = .{ .width = 1404, .height = 1872 };
    pub const a5x2: Dimensions = .{ .width = 1920, .height = 2560 };

    /// N5 == A5X2/Manta; everything else (A5X/A6X/Nomad) uses the default.
    pub fn forEquipment(apply_equipment: ?[]const u8) Dimensions {
        const eq = apply_equipment orelse return .default;
        if (std.mem.eql(u8, eq, "N5")) return .a5x2;
        return .default;
    }

    /// Effective dims for orientation `o`: swapped for horizontal. The one copy
    /// of the landscape swap, also used by the server's `note_index`.
    pub fn oriented(self: Dimensions, o: Orientation) Dimensions {
        return switch (o) {
            .vertical => self,
            .horizontal => .{ .width = self.height, .height = self.width },
        };
    }
};

/// The page canvas in millimetres, the unit of `RECOGNTEXT` boxes. Unlike
/// `Dimensions` it has no fallback: unknown equipment is null, because a wrong
/// scale yields an invisible, plausibly-wrong PDF text layer. Add a code only
/// from a real sample whose boxes were checked against its render.
pub const CanvasMm = struct {
    width: f32,
    height: f32,

    /// The 1404×1872 X-series class: 11864 × 15819 in 10-µm units, verified on
    /// N6 captures (11.834 px/mm, isotropic).
    pub const x_series: CanvasMm = .{ .width = 118.64, .height = 158.19 };

    /// Pixels per mm; one scalar because the canvas is isotropic.
    pub fn pxPerMm(self: CanvasMm, px_width: u32) f32 {
        return @as(f32, @floatFromInt(px_width)) / self.width;
    }

    /// The verified canvas, or null for unmeasured hardware.
    pub fn forEquipment(apply_equipment: ?[]const u8) ?CanvasMm {
        const eq = apply_equipment orelse return null;
        if (std.mem.eql(u8, eq, "N6")) return .x_series;
        return null;
    }
};

// ---- tests ----

const testing = std.testing;

test "LayerSlot keys match the format" {
    try testing.expectEqualStrings("MAINLAYER", LayerSlot.main.key());
    try testing.expectEqualStrings("BGLAYER", LayerSlot.background.key());
}

test "Dimensions select by equipment code" {
    try testing.expectEqual(Dimensions.a5x2, Dimensions.forEquipment("N5"));
    try testing.expectEqual(Dimensions.default, Dimensions.forEquipment("N6"));
    try testing.expectEqual(Dimensions.default, Dimensions.forEquipment(null));
}

test "Orientation: 90° (1090) and 270° (1270) are horizontal; 0°/180°/other are vertical" {
    // 1270 is a real Nomad value that once decoded sheared at portrait width.
    try testing.expectEqual(Orientation.horizontal, Orientation.fromValue("1090"));
    try testing.expectEqual(Orientation.horizontal, Orientation.fromValue("1270"));
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue("1000"));
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue("1180"));

    // Absent or garbage reads as vertical, never an error.
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue(null));
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue(""));
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue("1090 "));
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue("landscape"));

    try testing.expectEqual(Orientation.vertical, Orientation.fromValue(Orientation.vertical.value()));
    try testing.expectEqual(Orientation.horizontal, Orientation.fromValue(Orientation.horizontal.value()));
}

test "Dimensions.oriented swaps for horizontal only" {
    const base = Dimensions.default; // 1404×1872
    try testing.expectEqual(base, base.oriented(.vertical));
    try testing.expectEqual(Dimensions{ .width = 1872, .height = 1404 }, base.oriented(.horizontal));
    try testing.expectEqual(Dimensions{ .width = 2560, .height = 1920 }, Dimensions.a5x2.oriented(.horizontal));
}

test "Page.orientation: typed accessor over the raw key, vertical when absent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const landscape: Page = .{
        .number = 1,
        .block = try keyblock.parse(a, "<PAGESTYLE:style_white><ORIENTATION:1090>"),
        .layers = &.{},
    };
    try testing.expectEqual(Orientation.horizontal, landscape.orientation());
    try testing.expectEqualStrings("1090", landscape.orientationRaw().?);

    const portrait: Page = .{
        .number = 1,
        .block = try keyblock.parse(a, "<ORIENTATION:1000>"),
        .layers = &.{},
    };
    try testing.expectEqual(Orientation.vertical, portrait.orientation());

    const absent: Page = .{
        .number = 1,
        .block = try keyblock.parse(a, "<PAGESTYLE:style_white>"),
        .layers = &.{},
    };
    try testing.expectEqual(Orientation.vertical, absent.orientation());
    try testing.expectEqual(@as(?[]const u8, null), absent.orientationRaw());
}

test "CanvasMm is an allowlist, not a fallback" {
    try testing.expectEqual(CanvasMm.x_series, CanvasMm.forEquipment("N6").?);

    // Unknown is null, including N5, which would be silently wrong at the default.
    try testing.expectEqual(@as(?CanvasMm, null), CanvasMm.forEquipment("N5"));
    try testing.expectEqual(@as(?CanvasMm, null), CanvasMm.forEquipment("NX"));
    try testing.expectEqual(@as(?CanvasMm, null), CanvasMm.forEquipment(null));
}

test "CanvasMm scale matches the documented canvas on both axes" {
    const c = CanvasMm.x_series;
    try testing.expectApproxEqAbs(@as(f32, 11.834), c.pxPerMm(1404), 0.001);
    try testing.expectApproxEqAbs(@as(f32, 11.834), 1872.0 / c.height, 0.001);
}

test "slotFromKey maps LAYERSEQ tokens" {
    try testing.expectEqual(LayerSlot.main, slotFromKey("MAINLAYER").?);
    try testing.expectEqual(LayerSlot.background, slotFromKey("BGLAYER").?);
    try testing.expect(slotFromKey("NOPE") == null);
}

test "LayerSlot.fromLayerId: the confirmed map, -1 = background, others null" {
    try testing.expectEqual(LayerSlot.main, LayerSlot.fromLayerId(0).?);
    try testing.expectEqual(LayerSlot.layer1, LayerSlot.fromLayerId(1).?);
    try testing.expectEqual(LayerSlot.layer3, LayerSlot.fromLayerId(3).?);
    try testing.expectEqual(LayerSlot.background, LayerSlot.fromLayerId(-1).?);
    try testing.expect(LayerSlot.fromLayerId(4) == null);
    try testing.expect(LayerSlot.fromLayerId(-2) == null);
}

test "LayerSlot wire ids round-trip; -1 background rides as 4" {
    for (LayerSlot.all) |slot| {
        try testing.expectEqual(slot, LayerSlot.fromWireId(slot.wireId()).?);
    }
    try testing.expectEqual(@as(u8, 4), LayerSlot.fromLayerId(-1).?.wireId());
    try testing.expect(LayerSlot.fromWireId(5) == null);
    try testing.expect(LayerSlot.fromWireId(0xff) == null);
}

test "bottomUpEmitOrder: LAYERINFO order minus deleted, hidden kept and flagged" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // layers_edited.note page 2: stack 3,1,2(hidden),0,-1; LAYERSEQ omits LAYER2.
    const info = [_]layerinfo.Entry{
        .{ .layer_id = 3, .name = "Layer Renamed", .is_visible = true, .is_deleted = false, .is_current = true, .is_background = false },
        .{ .layer_id = 1, .name = "Layer 1", .is_visible = true, .is_deleted = false, .is_current = false, .is_background = false },
        .{ .layer_id = 2, .name = "Layer 2", .is_visible = false, .is_deleted = false, .is_current = false, .is_background = false },
        .{ .layer_id = 0, .name = "Main Layer", .is_visible = true, .is_deleted = false, .is_current = false, .is_background = false },
        .{ .layer_id = -1, .name = "Background Layer", .is_visible = true, .is_deleted = false, .is_current = false, .is_background = true },
    };
    const page: Page = .{
        .number = 1,
        .block = try keyblock.parse(a, "<LAYERSEQ:LAYER3,LAYER1,MAINLAYER,BGLAYER>"),
        .layers = &.{},
        .layer_info = &info,
    };

    var buf: [LayerSlot.all.len]EmitLayer = undefined;
    const order = bottomUpEmitOrder(page, &buf);
    try testing.expectEqualSlices(EmitLayer, &.{
        .{ .slot = .background, .hidden = false },
        .{ .slot = .main, .hidden = false },
        .{ .slot = .layer2, .hidden = true }, // in the emit list, NOT in LAYERSEQ
        .{ .slot = .layer1, .hidden = false },
        .{ .slot = .layer3, .hidden = false },
    }, order);

    const with_deleted = [_]layerinfo.Entry{
        .{ .layer_id = 3, .name = "Layer 3", .is_visible = true, .is_deleted = true, .is_current = false, .is_background = false },
        .{ .layer_id = 0, .name = "Main Layer", .is_visible = true, .is_deleted = false, .is_current = true, .is_background = false },
        .{ .layer_id = -1, .name = "Background Layer", .is_visible = true, .is_deleted = false, .is_current = false, .is_background = true },
    };
    const page2: Page = .{
        .number = 1,
        .block = try keyblock.parse(a, "<LAYERSEQ:MAINLAYER,BGLAYER>"),
        .layers = &.{},
        .layer_info = &with_deleted,
    };
    const order2 = bottomUpEmitOrder(page2, &buf);
    try testing.expectEqualSlices(EmitLayer, &.{
        .{ .slot = .background, .hidden = false },
        .{ .slot = .main, .hidden = false },
    }, order2);
}

test "bottomUpEmitOrder degrades to the LAYERSEQ draw order when LAYERINFO is absent or unusable" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var buf: [LayerSlot.all.len]EmitLayer = undefined;

    const page: Page = .{
        .number = 1,
        .block = try keyblock.parse(a, "<LAYERSEQ:MAINLAYER,LAYER1,BGLAYER>"),
        .layers = &.{},
    };
    const order = bottomUpEmitOrder(page, &buf);
    try testing.expectEqualSlices(EmitLayer, &.{
        .{ .slot = .background, .hidden = false },
        .{ .slot = .layer1, .hidden = false },
        .{ .slot = .main, .hidden = false },
    }, order);

    const useless = [_]layerinfo.Entry{
        .{ .layer_id = 9, .name = "?", .is_visible = true, .is_deleted = false, .is_current = false, .is_background = false },
        .{ .layer_id = 0, .name = "Main Layer", .is_visible = true, .is_deleted = true, .is_current = false, .is_background = false },
    };
    const page2: Page = .{
        .number = 1,
        .block = try keyblock.parse(a, "<LAYERSEQ:MAINLAYER,BGLAYER>"),
        .layers = &.{},
        .layer_info = &useless,
    };
    const order2 = bottomUpEmitOrder(page2, &buf);
    try testing.expectEqualSlices(EmitLayer, &.{
        .{ .slot = .background, .hidden = false },
        .{ .slot = .main, .hidden = false },
    }, order2);

    const dup = [_]layerinfo.Entry{
        .{ .layer_id = 0, .name = "A", .is_visible = false, .is_deleted = false, .is_current = false, .is_background = false },
        .{ .layer_id = 0, .name = "B", .is_visible = true, .is_deleted = false, .is_current = false, .is_background = false },
    };
    const page3: Page = .{
        .number = 1,
        .block = try keyblock.parse(a, "<PAGESTYLE:x>"),
        .layers = &.{},
        .layer_info = &dup,
    };
    const order3 = bottomUpEmitOrder(page3, &buf);
    try testing.expectEqualSlices(EmitLayer, &.{.{ .slot = .main, .hidden = false }}, order3);
}

fn pageWithSeq(a: std.mem.Allocator, seq: ?[]const u8) !Page {
    const payload = if (seq) |s|
        try std.fmt.allocPrint(a, "<LAYERSEQ:{s}>", .{s})
    else
        try a.dupe(u8, "<PAGESTYLE:x>");
    return .{ .number = 1, .block = try keyblock.parse(a, payload), .layers = &.{} };
}

test "bottomUpOrder reverses LAYERSEQ (which is stored top-to-bottom)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var buf: [LayerSlot.all.len]LayerSlot = undefined;

    const page = try pageWithSeq(a, "MAINLAYER,LAYER1,BGLAYER");
    const order = bottomUpOrder(page, &buf);
    try testing.expectEqualSlices(
        LayerSlot,
        &.{ .background, .layer1, .main },
        order,
    );
}

test "bottomUpOrder falls back to the default when LAYERSEQ is absent or garbage" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var buf: [LayerSlot.all.len]LayerSlot = undefined;

    const absent = try pageWithSeq(a, null);
    try testing.expectEqualSlices(LayerSlot, &default_bottom_up, bottomUpOrder(absent, &buf));

    const garbage = try pageWithSeq(a, "WAT,NOPE");
    try testing.expectEqualSlices(LayerSlot, &default_bottom_up, bottomUpOrder(garbage, &buf));
}

test "bottomUpOrder skips unknown tokens but keeps the known ones" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var buf: [LayerSlot.all.len]LayerSlot = undefined;

    const page = try pageWithSeq(a, "MAINLAYER,MYSTERY,BGLAYER");
    try testing.expectEqualSlices(LayerSlot, &.{ .background, .main }, bottomUpOrder(page, &buf));
}
