//! Structure types for a parsed `.note` container (the "container tier").
//!
//! These describe structure and metadata only — no bitmap decoding. Rendering
//! (RATTA_RLE etc.) is a separate concern layered on top of this.
//!
//! This module also holds the *shared format facts* that both `render.zig`
//! and `page_payload.zig` depend on — the bottom-to-top layer draw order
//! (`bottomUpOrder`), the blank-background shortcut
//! (`special_white_style_block_size`) and the landscape row-width swap
//! (`Dimensions.oriented`) — so the consumers can never hold differing
//! opinions of them.

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

    /// The metadata key a page uses to point at this slot's layer block.
    pub fn key(self: LayerSlot) []const u8 {
        return switch (self) {
            .main => "MAINLAYER",
            .layer1 => "LAYER1",
            .layer2 => "LAYER2",
            .layer3 => "LAYER3",
            .background => "BGLAYER",
        };
    }

    /// Maps a `LAYERINFO` `layerId` to its slot: `0` = MAINLAYER, `1..3` =
    /// LAYERn, **`-1` = BGLAYER** (capture-confirmed: the background entry says
    /// `layerId:-1, isBackgroundLayer:true`). Null for any other id.
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

    /// The slot's one-byte SNPG v2 wire id — the enum value itself (`main`=0,
    /// `layer1..3`=1..3, `background`=4). `LAYERINFO`'s `-1` background id maps
    /// to **4** on the wire: the record head is a single unsigned byte, and 4
    /// is the id `fromWireId` round-trips. One copy of the encoding, consumed
    /// by the producer, the consumer and the index packing.
    pub fn wireId(self: LayerSlot) u8 {
        return @intFromEnum(self);
    }

    /// Inverse of `wireId`; null for a byte outside the five slots.
    pub fn fromWireId(id: u8) ?LayerSlot {
        if (id > @intFromEnum(LayerSlot.background)) return null;
        return @enumFromInt(id);
    }

    pub const all = [_]LayerSlot{ .main, .layer1, .layer2, .layer3, .background };
};

/// Per-page `ORIENTATION`. The device encodes it as `1000 + degrees` of
/// rotation: `1000` = 0°, `1090` = 90°, `1180` = 180°, `1270` = 270° (there is
/// no file-level orientation — `HORIZONTAL_CHECK` is a dead header key, see
/// note-format.md §9.3).
///
/// What matters for the raster is the ROW WIDTH: a 90° **or** 270° rotation
/// stores the RATTA_RLE raster **natively landscape** (the same flat byte
/// stream, but the true row width is the swapped base width — 1872 on a Nomad),
/// so BOTH are `horizontal`. 0° and 180° keep the base portrait dims (a 180°
/// page is portrait-shaped, just written upside down), so they are `vertical`.
/// `Dimensions.oriented` is the one copy of that swap fact.
pub const Orientation = enum {
    vertical,
    horizontal,

    /// A representative metadata value the device writes for this orientation
    /// (horizontal has two — 90° and 270° — this returns the 90° form). Used for
    /// building fixtures / dump output, never for parsing; `fromValue` is the
    /// parse.
    pub fn value(self: Orientation) []const u8 {
        return switch (self) {
            .vertical => "1000",
            .horizontal => "1090",
        };
    }

    /// Maps a raw `ORIENTATION` value. `"1090"` (90°) and `"1270"` (270°) are the
    /// landscape rotations that swap the raster's row width, so both are
    /// horizontal; every other value — `"1000"`, `"1180"`, an unrecognized code,
    /// or an absent key — is vertical.
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
    /// The page's own number, read from its `PAGE<n>` key in the footer, 1-based.
    ///
    /// For a notebook this is just the index plus one — the footer runs `PAGE1`,
    /// `PAGE2`, … with no gaps. For a `.mark` it is NOT: a mark holds only the
    /// pages that were annotated, and its footer names them
    /// (`<PAGE2:…><PAGE5:…><PAGE6:…>`), where the number is the page of the PDF
    /// the mark belongs to (`note-format.md` §13.2). Dropping it — which this
    /// parser did — leaves a 3-page mark looking like pages 1, 2, 3 of nothing.
    number: u32,
    /// Only the layers actually present (non-zero address), in slot order.
    layers: []const Layer,
    /// The parsed `LAYERINFO` panel state (full stack, top-to-bottom, hidden
    /// and deleted entries included), or **null when the page carries none or
    /// it is malformed** — a recorded fact, mirroring the parser's
    /// hostile-input posture (see `layerinfo.zig`). Tier-2 data: it lives in
    /// the page block, so parsing it costs no extra reads.
    layer_info: ?[]const layerinfo.Entry = null,

    pub fn style(self: Page) ?[]const u8 {
        return self.block.get("PAGESTYLE");
    }
    /// The `PAGESTYLEMD5` — the content hash of the page's style asset. `"0"`
    /// (or absent) means "no custom asset" (blank / a built-in style). A custom
    /// image template names its asset here, shared by every page that references
    /// the same hash. See note-format.md §4.3.
    pub fn styleMd5(self: Page) ?[]const u8 {
        return self.block.get("PAGESTYLEMD5");
    }
    /// True when the page names a **custom style asset** — `PAGESTYLEMD5 != "0"`
    /// and not the `style_white` blank shortcut. This is the gate for the
    /// image-template classifier: only a custom-style background is ever worth
    /// asking "is this a RATTA_RLE stream or a browser-native image?" (a blank /
    /// built-in / white background is known RLE and skips the check). A custom
    /// style whose asset happens to be RLE (a built-in re-encoded template) still
    /// passes the gate and is correctly classified as RLE by `decodesToExactly`.
    pub fn hasCustomStyle(self: Page) bool {
        const md5 = self.styleMd5() orelse return false;
        if (std.mem.eql(u8, md5, "0")) return false;
        return !self.isWhiteStyle();
    }
    /// The page's typed orientation. A `.horizontal` page's raster is stored
    /// natively landscape — decode/label it at the effective dims
    /// (`Dimensions.oriented`), never the base portrait dims.
    pub fn orientation(self: Page) Orientation {
        return Orientation.fromValue(self.orientationRaw());
    }
    /// Raw `ORIENTATION` value (`"1000"`/`"1090"`), null when absent. The typed
    /// `orientation()` is what consumers should branch on; this exists for
    /// dump/debug output and for pinning the raw value in tests.
    pub fn orientationRaw(self: Page) ?[]const u8 {
        return self.block.get("ORIENTATION");
    }
    pub fn pageId(self: Page) ?[]const u8 {
        return self.block.get("PAGEID");
    }
    /// Address of the page's vector stroke data (0 == none) — the strokes as
    /// drawn, before they were flattened into `LAYERBITMAP`.
    ///
    /// The format is CHARTED, just not decoded here: see `note-format.md` §10
    /// for the stroke layout (head, pen and colour enums, the parallel
    /// point/pressure/tilt arrays) and §10.1 for the coordinate transform. That
    /// mapping is second-hand and unverified against a file we hold, and
    /// nothing in the renderer needs it — we composite the raster layers — so
    /// this returns the address and stops. It is the block worth reaching for
    /// if we ever want pressure, tilt, or the strokes an eraser masked, none of
    /// which survive into the bitmap.
    pub fn totalPathAddress(self: Page) u32 {
        return @intCast(self.block.getInt("TOTALPATH") orelse 0);
    }

    /// Handwriting-recognition status: 0 none, 1 done, 2 running.
    pub fn recognitionStatus(self: Page) u8 {
        return @intCast(self.block.getInt("RECOGNSTATUS") orelse 0);
    }
    /// Address of the base64-JSON recognized-text block (0 == none / unfinished).
    pub fn recognitionAddress(self: Page) u32 {
        return @intCast(self.block.getInt("RECOGNTEXT") orelse 0);
    }

    /// Address of the page's `EXTERNALLINKINFO` block — the link rectangles a
    /// PDF used as this page's template brought with it (`note-format.md` §14,
    /// decoded by `links.zig`). **0 is the overwhelming default**: a page on a
    /// built-in style has no links to preserve, so every page of every ordinary
    /// `.note` reads 0 here and costs no read.
    pub fn linksAddress(self: Page) u32 {
        return @intCast(self.block.getInt("EXTERNALLINKINFO") orelse 0);
    }

    pub fn layer(self: Page, slot: LayerSlot) ?Layer {
        for (self.layers) |l| {
            if (l.slot == slot) return l;
        }
        return null;
    }

    /// The `LAYERINFO` entry describing `slot`, or null when the page has no
    /// (usable) `LAYERINFO` or no entry maps to that slot.
    pub fn infoForSlot(self: Page, slot: LayerSlot) ?layerinfo.Entry {
        const entries = self.layer_info orelse return null;
        for (entries) |e| {
            if (LayerSlot.fromLayerId(e.layer_id) == slot) return e;
        }
        return null;
    }

    /// True for the `style_white` page style — one half of the blank-background
    /// RLE shortcut (see `special_white_style_block_size`).
    pub fn isWhiteStyle(self: Page) bool {
        const s = self.style() orelse return false;
        return std.mem.eql(u8, s, "style_white");
    }
};

/// A background block of exactly this content size on a `style_white` page is
/// the blank-fill shortcut: its RLE special-length marker means `0x400` pixels
/// instead of `0x4000` (see `decoder.zig`). One copy of the fact, consumed by
/// both `render.zig` and `page_payload.zig`.
pub const special_white_style_block_size: usize = 0x140e;

/// The bottom-to-top default draw order when a page carries no `LAYERSEQ`.
pub const default_bottom_up = [_]LayerSlot{ .background, .main, .layer1, .layer2, .layer3 };

/// Fills `buf` with the layer slots in bottom-to-top draw order and returns the
/// used prefix. `LAYERSEQ` is top-to-bottom, so we walk it in reverse; when it
/// is absent (or contains no recognisable token) we fall back to the default.
pub fn bottomUpOrder(page: Page, buf: *[LayerSlot.all.len]LayerSlot) []const LayerSlot {
    const seq_str = page.block.get("LAYERSEQ") orelse {
        @memcpy(buf, &default_bottom_up);
        return buf[0..];
    };

    // Collect tokens (top-to-bottom), then reverse into `buf`.
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

/// One entry of the SNPG **emit** order: which slot ships, and whether its
/// stream rides the wire flagged hidden (excluded from the default composite).
pub const EmitLayer = struct { slot: LayerSlot, hidden: bool };

/// Fills `buf` with the bottom-to-top EMIT order for a page's SNPG payload and
/// returns the used prefix: **`LAYERINFO` order minus deleted entries** —
/// hidden layers stay in, flagged, so the client can toggle them ON (their
/// bitmaps persist in the file; capture-proven on `layers_edited.note`).
///
/// `LAYERINFO`'s array is the full stack top-to-bottom, so it is walked in
/// reverse; `LAYERSEQ` is that order filtered to drawn layers, which is why the
/// two agree on every drawn layer's position. When `LAYERINFO` is absent,
/// malformed, or yields no mappable entry, this degrades to the
/// `LAYERSEQ`-driven `bottomUpOrder` with nothing hidden — exactly today's
/// wire, never a failure.
///
/// This sits beside `bottomUpOrder` on purpose: that one stays the DRAW list
/// (`render.zig`'s device-authored composite), this one is the WIRE list.
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
            // A hostile LAYERINFO could repeat a slot; first (bottom-most) wins.
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

/// Maps one `LAYERSEQ` token (e.g. "MAINLAYER") to its slot, or null for a
/// token the format does not define.
pub fn slotFromKey(key: []const u8) ?LayerSlot {
    for (LayerSlot.all) |slot| {
        if (std.mem.eql(u8, key, slot.key())) return slot;
    }
    return null;
}

/// Page pixel dimensions, selected by the header's `APPLY_EQUIPMENT`.
pub const Dimensions = struct {
    width: u32,
    height: u32,

    pub const default: Dimensions = .{ .width = 1404, .height = 1872 };
    pub const a5x2: Dimensions = .{ .width = 1920, .height = 2560 };

    /// N5 == A5X2/Manta. Everything else (incl. N6/Nomad) uses the default,
    /// which is correct for A5X/A6X/Nomad.
    pub fn forEquipment(apply_equipment: ?[]const u8) Dimensions {
        const eq = apply_equipment orelse return .default;
        if (std.mem.eql(u8, eq, "N5")) return .a5x2;
        return .default;
    }

    /// The EFFECTIVE dims for a page with orientation `o`: swapped for
    /// horizontal, unchanged for vertical. `self` is the note's base (portrait)
    /// dims from `forEquipment`.
    ///
    /// This is the ONE copy of the landscape storage fact (note-format.md
    /// §9.3): a `1090` page's raster is the same flat RATTA_RLE stream, but its
    /// true row width is the swapped base width — 1872 on a Nomad. `render`,
    /// `page_payload` and the server's `note_index` all consume this function,
    /// so none of them can hold a differing opinion of the swap.
    pub fn oriented(self: Dimensions, o: Orientation) Dimensions {
        return switch (o) {
            .vertical => self,
            .horizontal => .{ .width = self.height, .height = self.width },
        };
    }
};

/// The page canvas in **millimetres** — the unit `RECOGNTEXT` bounding boxes are
/// written in (see `recognition.zig`). It exists to answer exactly one
/// question: how many device pixels is one millimetre on this hardware.
///
/// **THIS IS A SEPARATE TABLE FROM `Dimensions`, AND IT HAS NO FALLBACK. THAT IS
/// THE ENTIRE POINT.** `Dimensions.forEquipment` answers `default` (1404×1872)
/// for every code it does not know, which is a fine guess for pixels — a wrong
/// pixel size produces a visibly wrong render, and the render is checked against
/// the payload anyway. Guessing a *millimetre* size is a different kind of
/// mistake: the only consumer is the searchable-PDF text layer, which is
/// INVISIBLE. An N5/Manta is 1920×2560 at the same aspect ratio, so it falls
/// through to `default` today and its true scale is plausibly ~10% from this
/// one. A PDF whose invisible text sits 10% off looks perfect and betrays itself
/// only much later, when someone copies text out of it and gets the wrong words.
/// A PDF with no text layer at all is obviously text-free the moment you try.
///
/// So: unknown equipment returns **null**, callers must handle it, and the
/// export path degrades to a raster-only PDF and says so. Adding a code here
/// requires a real sample from that device whose boxes have been checked against
/// its render — not an inference from the pixel table.
pub const CanvasMm = struct {
    width: f32,
    height: f32,

    /// The 1404×1872 X-series class. VERIFIED: the format's canvas is documented
    /// as 11864 × 15819 in 10-µm units (`note-format.md` §8) and the boxes in
    /// our real `N6` captures land on their glyphs at the scale this implies —
    /// 1404 / 118.64 = 1872 / 158.19 = 11.834 px/mm, isotropic.
    pub const x_series: CanvasMm = .{ .width = 118.64, .height = 158.19 };

    /// Pixels per millimetre for a page rendered `px_width` pixels wide. One
    /// scalar rather than two because the canvas is isotropic (see `x_series`).
    pub fn pxPerMm(self: CanvasMm, px_width: u32) f32 {
        return @as(f32, @floatFromInt(px_width)) / self.width;
    }

    /// The verified canvas for `apply_equipment`, or **null when we have never
    /// measured this hardware**. Null is a real answer, not a failure — see the
    /// type docs for why it must not be a guess.
    pub fn forEquipment(apply_equipment: ?[]const u8) ?CanvasMm {
        const eq = apply_equipment orelse return null;
        // The allowlist. One entry, because one entry is what we have samples for.
        if (std.mem.eql(u8, eq, "N6")) return .x_series;
        return null;
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    // The two landscape rotations — both swap the raster's row width. 1270 is a
    // real Nomad value (regression: a 1270 note was decoded at portrait width
    // and sheared until this case was added).
    try testing.expectEqual(Orientation.horizontal, Orientation.fromValue("1090"));
    try testing.expectEqual(Orientation.horizontal, Orientation.fromValue("1270"));
    // Portrait-shaped rotations: 0° and 180° keep the base dims.
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue("1000"));
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue("1180"));

    // The reference's posture, mirrored: absent, garbage or near-miss values
    // all read as vertical rather than an error — a page never fails to have
    // an orientation.
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue(null));
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue(""));
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue("1090 "));
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue("landscape"));

    // The named raw values round-trip.
    try testing.expectEqual(Orientation.vertical, Orientation.fromValue(Orientation.vertical.value()));
    try testing.expectEqual(Orientation.horizontal, Orientation.fromValue(Orientation.horizontal.value()));
}

test "Dimensions.oriented swaps for horizontal only" {
    const base = Dimensions.default; // 1404×1872
    try testing.expectEqual(base, base.oriented(.vertical));
    try testing.expectEqual(Dimensions{ .width = 1872, .height = 1404 }, base.oriented(.horizontal));
    // N5/Manta: the landscape row width is the swapped base width, 2560.
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

    // The three ways to be unknown. Every one of them must be null rather than
    // the default the PIXEL table would have handed back — including N5, which
    // is exactly the case that would be silently wrong at the default scale.
    try testing.expectEqual(@as(?CanvasMm, null), CanvasMm.forEquipment("N5"));
    try testing.expectEqual(@as(?CanvasMm, null), CanvasMm.forEquipment("NX"));
    try testing.expectEqual(@as(?CanvasMm, null), CanvasMm.forEquipment(null));
}

test "CanvasMm scale matches the documented canvas on both axes" {
    const c = CanvasMm.x_series;
    try testing.expectApproxEqAbs(@as(f32, 11.834), c.pxPerMm(1404), 0.001);
    // Isotropic: the height axis must agree, or `pxPerMm` would be a lie.
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

    // The layers_edited.note page-2 shape: stack 3,1,2(hidden),0,-1 top-down,
    // LAYERSEQ omitting the hidden LAYER2.
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

    // A deleted entry is excluded outright.
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

    // Absent LAYERINFO: exactly bottomUpOrder, nothing hidden.
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

    // Present but yielding no mappable entry (all deleted / unknown ids):
    // same degrade — never an empty wire for a page LAYERSEQ still draws.
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

    // A hostile duplicate slot id appears once (bottom-most wins).
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

/// Builds a Page over an arena whose only content is a LAYERSEQ entry.
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

    // The device's usual sequence: MAINLAYER first (topmost). Drawing must go
    // bottom-to-top, so the background comes out first.
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
