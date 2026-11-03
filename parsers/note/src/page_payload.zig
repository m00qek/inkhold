//! Tier 3: SNPG, the self-describing single-page payload between the server's
//! `/note/{id}/page/{n}` endpoint and the browser's WASM decoder. Both the
//! producer (`serialize`) and consumer (`decodeRgba`) live here so they cannot
//! drift.
//!
//! SNPG v2, little-endian:
//! ```
//! 0  4  "SNPG"        4  1  version = 2     5  1  variant (0 RLE, 1 RLE X2)
//! 6  2  reserved      8  4  width          12  4  height (effective dims)
//! 16 4  layer_count   20 .. records, bottom-to-top:
//!       1 flags (bit0 all_blank, bit1 hidden, bit2 raster-image background)
//!       1 slot (`types.LayerSlot.wireId`)   4 data_len   data_len bytes
//! ```
//! Records are `LAYERINFO` order minus deleted; the default composite skips
//! hidden ones. v1 (5-byte heads, no slot byte, no hidden bit) is still
//! accepted because old payloads may sit in client caches.

const std = @import("std");
const decoder = @import("decoder.zig");
const note_mod = @import("note.zig");
const source = @import("source.zig");
const types = @import("types.zig");

pub const MAGIC = "SNPG";
pub const VERSION: u8 = 2;
pub const VERSION_1: u8 = 1;
pub const HEADER_SIZE: usize = 20;
pub const LAYER_HEADER_SIZE: usize = 6;
pub const LAYER_HEADER_SIZE_V1: usize = 5;

pub const FLAG_ALL_BLANK: u8 = 0x01;
pub const FLAG_HIDDEN: u8 = 0x02;
/// bit2: the background record's `data` is the asset hash (`PAGESTYLEMD5`) of a
/// browser-native image template, fetched via `/note/{id}/template/{hash}`;
/// the RLE decoders skip it.
pub const FLAG_RASTER_IMAGE: u8 = 0x04;

const TRANSPARENT: u8 = 0xff;
const WHITE: u8 = 0xff;

/// The largest page `decodeRgba` will decode (16 Mpx). On wasm32 `usize` is 32
/// bits and the ReleaseSmall build has no overflow traps, so an unchecked
/// `width * height * 4` from the untrusted header can wrap to 0 and overrun.
/// The checked multiplies are the fix; this ceiling (Manta is 4.9 Mpx) is
/// testable on 64-bit hosts.
const max_pixels: u64 = 1 << 24;

pub const Error = error{
    /// Shorter than its fields claim, or a bad magic/version.
    BadPayload,
    LayerOutOfRange,
} || note_mod.Error || decoder.DecodeError;

/// RGBA8888, row-major. Owned by caller.
pub const Rgba = struct {
    width: u32,
    height: u32,
    pixels: []u8,

    pub fn deinit(self: Rgba, gpa: std.mem.Allocator) void {
        gpa.free(self.pixels);
    }
};

// ---- producer (server side) ----

pub const max_layers = types.LayerSlot.all.len;

/// Where one emitted layer's RLE bytes live in the container, plus its record
/// flags. `serialize` and the server's blob index both use `emitLayers`.
pub const LayerRef = struct {
    /// Absolute offset just past the block's `u32` length prefix.
    offset: u32,
    len: u32,
    slot: types.LayerSlot,
    all_blank: bool,
    hidden: bool,
    /// Background only. `offset`/`len` still point at the image bytes (ranged
    /// by `/template/{hash}`); on the wire the record carries the hash.
    raster_image: bool = false,
};

/// Page `page_index`'s layers in `serialize`'s order and flags, bounds-checked
/// against `note.source`. Reads only each block's 4-byte length prefix, so an
/// indexer never touches bitmaps.
pub fn emitLayers(note: note_mod.Note, page_index: usize, buf: *[max_layers]LayerRef) Error![]const LayerRef {
    if (page_index >= note.pages.len) return error.PageOutOfRange;
    return emitPageLayers(note.source, note.pages[page_index], buf);
}

/// `emitLayers` for one parsed page and a source, in `types.bottomUpEmitOrder`.
/// Slots with no layer block or bitmap are skipped.
pub fn emitPageLayers(src: source.Source, page: types.Page, buf: *[max_layers]LayerRef) Error![]const LayerRef {
    var order_buf: [max_layers]types.EmitLayer = undefined;
    const order = types.bottomUpEmitOrder(page, &order_buf);

    var n: usize = 0;
    for (order) |emit| {
        if (n >= buf.len) break;
        const layer = page.layer(emit.slot) orelse continue;
        const addr = layer.bitmapAddress();
        if (addr == 0) continue;

        const range = src.blockRange(addr) catch |e| return note_mod.lift(e);
        if (range.offset > std.math.maxInt(u32)) return error.Truncated;
        buf[n] = .{
            .offset = @intCast(range.offset), // past the block's length prefix
            .len = range.len,
            .slot = emit.slot,
            .all_blank = emit.slot == .background and page.isWhiteStyle() and
                @as(usize, range.len) == types.special_white_style_block_size,
            .hidden = emit.hidden,
        };
        n += 1;
    }
    return buf[0..n];
}

pub fn variantOf(note: note_mod.Note) decoder.Variant {
    return note.rleVariant();
}

/// Serializes page `page_index` into an SNPG payload owned by `gpa`; decoding
/// it reproduces `renderPageGray` (pinned in tests/content_test.zig).
pub fn serialize(gpa: std.mem.Allocator, note: note_mod.Note, page_index: usize) Error![]u8 {
    var refs_buf: [max_layers]LayerRef = undefined;
    const refs = try emitLayers(note, page_index, &refs_buf);
    const page = note.pages[page_index];
    // Effective dims: a landscape page's stream is natively landscape.
    const dims = note.dimensions().oriented(page.orientation());
    const expected_px: u64 = @as(u64, dims.width) * dims.height;
    const variant = note.rleVariant();

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);

    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION);
    try out.append(gpa, @backingInt(variant));
    try out.appendSlice(gpa, &.{ 0, 0 }); // reserved
    try appendU32(&out, gpa, dims.width);
    try appendU32(&out, gpa, dims.height);
    try appendU32(&out, gpa, @intCast(refs.len));

    for (refs) |r| {
        // A non-RLE custom background ships its asset hash, flagged bit2, so the
        // payload stays small and the shared asset is fetched once.
        if (r.slot == .background and page.hasCustomStyle()) {
            const scratch = try gpa.alloc(u8, r.len);
            defer gpa.free(scratch);
            note.source.read(r.offset, scratch) catch |e| return note_mod.lift(e);
            if (!decoder.decodesToExactly(scratch, expected_px)) {
                const hash = page.styleMd5() orelse "";
                try out.append(gpa, recordFlags(r) | FLAG_RASTER_IMAGE);
                try out.append(gpa, r.slot.wireId());
                try appendU32(&out, gpa, @intCast(hash.len));
                try out.appendSlice(gpa, hash);
                continue;
            }
            try out.append(gpa, recordFlags(r));
            try out.append(gpa, r.slot.wireId());
            try appendU32(&out, gpa, r.len);
            try out.appendSlice(gpa, scratch);
            continue;
        }
        try out.append(gpa, recordFlags(r));
        try out.append(gpa, r.slot.wireId());
        try appendU32(&out, gpa, r.len);
        // Read straight into the payload's tail, no intermediate copy.
        const at = out.items.len;
        try out.resize(gpa, at + r.len);
        note.source.read(r.offset, out.items[at..]) catch |e| return note_mod.lift(e);
    }
    return out.toOwnedSlice(gpa);
}

fn appendU32(out: *std.ArrayList(u8), gpa: std.mem.Allocator, v: u32) std.mem.Allocator.Error!void {
    var b: [4]u8 = undefined;
    std.mem.writeInt(u32, &b, v, .little);
    try out.appendSlice(gpa, &b);
}

/// A record's flags byte: the one place the bit layout is written.
pub fn recordFlags(ref: LayerRef) u8 {
    var f: u8 = 0;
    if (ref.all_blank) f |= FLAG_ALL_BLANK;
    if (ref.hidden) f |= FLAG_HIDDEN;
    if (ref.raster_image) f |= FLAG_RASTER_IMAGE;
    return f;
}

// ---- consumer (also compiled into the freestanding wasm) ----

/// The fixed header plus a cursor at the first record, shared by every walker.
const Header = struct {
    version: u8,
    variant: decoder.Variant,
    width: u32,
    height: u32,
    layer_count: u32,
    /// Validated against `max_pixels`.
    npix: usize,
};

fn readHeader(cur: *Cursor) Error!Header {
    if (!std.mem.eql(u8, try cur.take(4), MAGIC)) return error.BadPayload;
    const version = (try cur.take(1))[0];
    if (version != VERSION and version != VERSION_1) return error.BadPayload;
    const variant: decoder.Variant = switch ((try cur.take(1))[0]) {
        0 => .ratta_rle,
        1 => .ratta_rle_x2,
        else => return error.BadPayload,
    };
    _ = try cur.take(2); // reserved
    const width = try cur.u32le();
    const height = try cur.u32le();
    const layer_count = try cur.u32le();

    // Widen before multiplying: two untrusted u32s on a 32-bit `usize`.
    const npix64: u64 = @as(u64, width) * @as(u64, height);
    if (npix64 == 0 or npix64 > max_pixels) return error.BadPayload;

    return .{
        .version = version,
        .variant = variant,
        .width = width,
        .height = height,
        .layer_count = layer_count,
        .npix = @intCast(npix64), // <= max_pixels, so this cannot truncate
    };
}

/// One record; `slot` is null on v1.
const Record = struct {
    all_blank: bool,
    hidden: bool,
    raster_image: bool,
    slot: ?types.LayerSlot,
    data: []const u8,
};

fn readRecord(cur: *Cursor, version: u8) Error!Record {
    const flags = (try cur.take(1))[0];
    const slot: ?types.LayerSlot = if (version >= VERSION)
        // An unknown slot byte is tolerated: identity is panel metadata, not
        // decode geometry.
        types.LayerSlot.fromWireId((try cur.take(1))[0])
    else
        null;
    const data_len = try cur.u32le();
    return .{
        .all_blank = flags & FLAG_ALL_BLANK != 0,
        .hidden = version >= VERSION and flags & FLAG_HIDDEN != 0,
        .raster_image = version >= VERSION and flags & FLAG_RASTER_IMAGE != 0,
        .slot = slot,
        .data = try cur.take(data_len),
    };
}

/// Composites a payload into opaque RGBA, skipping hidden records: the device's
/// default render. Gray `g` becomes `(g, g, g, 255)`; theming is the caller's.
pub fn decodeRgba(gpa: std.mem.Allocator, payload: []const u8) Error!Rgba {
    var cur = Cursor{ .buf = payload };
    const head = try readHeader(&cur);
    const rgba_len: usize = head.npix * 4; // <= 64 MiB, well inside usize on wasm32

    // Composite in grayscale, then expand; one scratch buffer for all layers.
    const gray = try gpa.alloc(u8, head.npix);
    defer gpa.free(gray);
    @memset(gray, WHITE);

    const scratch = try gpa.alloc(u8, head.npix);
    defer gpa.free(scratch);

    var layer: u32 = 0;
    while (layer < head.layer_count) : (layer += 1) {
        const rec = try readRecord(&cur, head.version);
        if (rec.hidden) continue; // shipped for the panel, not for the default view
        // Raster backgrounds are underlaid by the browser; never RLE-decode them.
        if (rec.raster_image) continue;

        try decoder.decodeInto(scratch, head.variant, rec.data, rec.all_blank);
        for (gray, scratch) |*dst, s| {
            if (s != TRANSPARENT) dst.* = s;
        }
    }

    const pixels = try gpa.alloc(u8, rgba_len);
    errdefer gpa.free(pixels);
    for (gray, 0..) |g, i| {
        pixels[i * 4 + 0] = g;
        pixels[i * 4 + 1] = g;
        pixels[i * 4 + 2] = g;
        pixels[i * 4 + 3] = 0xff;
    }
    return .{ .width = head.width, .height = head.height, .pixels = pixels };
}

/// Decodes one record into RGBA with 0xff mapped to alpha 0, for the stacked
/// per-layer view. Hidden records decode too; works on v1.
pub fn decodeLayerRgba(gpa: std.mem.Allocator, payload: []const u8, layer_index: u32) Error!Rgba {
    var cur = Cursor{ .buf = payload };
    const head = try readHeader(&cur);
    if (layer_index >= head.layer_count) return error.LayerOutOfRange;

    // Walk (and bounds-check) the preceding records without decoding them.
    var i: u32 = 0;
    var rec = try readRecord(&cur, head.version);
    while (i < layer_index) : (i += 1) rec = try readRecord(&cur, head.version);

    const pixels = try gpa.alloc(u8, head.npix * 4);
    errdefer gpa.free(pixels);

    // A raster background yields a transparent layer; the image is fetched
    // separately.
    if (rec.raster_image) {
        @memset(pixels, 0x00);
        return .{ .width = head.width, .height = head.height, .pixels = pixels };
    }

    const gray = try gpa.alloc(u8, head.npix);
    defer gpa.free(gray);
    try decoder.decodeInto(gray, head.variant, rec.data, rec.all_blank);

    for (gray, 0..) |g, i_px| {
        pixels[i_px * 4 + 0] = g;
        pixels[i_px * 4 + 1] = g;
        pixels[i_px * 4 + 2] = g;
        pixels[i_px * 4 + 3] = if (g == TRANSPARENT) 0x00 else 0xff;
    }
    return .{ .width = head.width, .height = head.height, .pixels = pixels };
}

/// The background record's asset hash when it is flagged `FLAG_RASTER_IMAGE`,
/// else null, so the browser needs no knowledge of the layout. Never errors on
/// untrusted input; v1 yields null. The slice aliases `snpg`.
pub fn backgroundImageHash(snpg: []const u8) ?[]const u8 {
    var cur = Cursor{ .buf = snpg };
    const head = readHeader(&cur) catch return null;
    var i: u32 = 0;
    while (i < head.layer_count) : (i += 1) {
        const rec = readRecord(&cur, head.version) catch return null;
        if (rec.raster_image and rec.slot == .background) return rec.data;
    }
    return null;
}

/// One record's identity for the layers panel; `data` aliases the input.
pub const RecordInfo = struct {
    slot: types.LayerSlot,
    excluded: bool,
    raster_image: bool,
    data: []const u8,
};

/// Effective dims plus records (in the caller's buffer, aliasing the payload).
pub const Enumeration = struct {
    width: u32,
    height: u32,
    records: []const RecordInfo,
};

/// Enumerates v2 record heads for the layers panel, touching no RLE. Null for
/// anything the panel can't present: v1, a short or foreign blob, an unknown
/// slot, an over-long record, 0 or > `max_layers` records, or trailing junk.
pub fn enumerateRecords(snpg: []const u8, buf: *[max_layers]RecordInfo) ?Enumeration {
    var cur = Cursor{ .buf = snpg };
    const head = readHeader(&cur) catch return null;
    if (head.version != VERSION) return null; // v2 only: v1 carries no slot id
    if (head.layer_count == 0 or head.layer_count > max_layers) return null;

    var n: usize = 0;
    var i: u32 = 0;
    while (i < head.layer_count) : (i += 1) {
        const rec = readRecord(&cur, head.version) catch return null;
        const slot = rec.slot orelse return null; // unknown wire id: no identity
        buf[n] = .{
            .slot = slot,
            .excluded = rec.hidden,
            .raster_image = rec.raster_image,
            .data = rec.data,
        };
        n += 1;
    }
    if (cur.pos != snpg.len) return null; // trailing junk: not our payload
    return .{ .width = head.width, .height = head.height, .records = buf[0..n] };
}

const Cursor = struct {
    buf: []const u8,
    pos: usize = 0,

    fn take(self: *Cursor, n: usize) Error![]const u8 {
        // Checked add: on wasm32 an untrusted `n` can wrap `pos + n`.
        const end = std.math.add(usize, self.pos, n) catch return error.BadPayload;
        if (end > self.buf.len) return error.BadPayload;
        const s = self.buf[self.pos..end];
        self.pos = end;
        return s;
    }

    fn u32le(self: *Cursor) Error!u32 {
        const s = try self.take(4);
        return std.mem.readInt(u32, s[0..4], .little);
    }
};

// ---- tests (hand-built payloads; the real-fixture cross-check is in
// tests/content_test.zig) ----

const testing = std.testing;

fn buildOneLayer(gpa: std.mem.Allocator, variant: u8, w: u32, h: u32, all_blank: bool, rle: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION);
    try out.append(gpa, variant);
    try out.appendSlice(gpa, &.{ 0, 0 });
    try appendU32(&out, gpa, w);
    try appendU32(&out, gpa, h);
    try appendU32(&out, gpa, 1);
    try out.append(gpa, if (all_blank) FLAG_ALL_BLANK else 0x00);
    try out.append(gpa, types.LayerSlot.main.wireId());
    try appendU32(&out, gpa, @intCast(rle.len));
    try out.appendSlice(gpa, rle);
    return out.toOwnedSlice(gpa);
}

fn appendRecord(out: *std.ArrayList(u8), gpa: std.mem.Allocator, flags: u8, slot: types.LayerSlot, rle: []const u8) !void {
    try out.append(gpa, flags);
    try out.append(gpa, slot.wireId());
    try appendU32(out, gpa, @intCast(rle.len));
    try out.appendSlice(gpa, rle);
}

test "decodeRgba: single black pixel -> opaque black RGBA" {
    const gpa = testing.allocator;
    const payload = try buildOneLayer(gpa, 1, 1, 1, false, &.{ 0x61, 0x00 });
    defer gpa.free(payload);

    const img = try decodeRgba(gpa, payload);
    defer img.deinit(gpa);
    try testing.expectEqual(@as(u32, 1), img.width);
    try testing.expectEqual(@as(u32, 1), img.height);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels);
}

test "decodeRgba: transparent code composites to the white base" {
    const gpa = testing.allocator;
    const payload = try buildOneLayer(gpa, 1, 5, 1, false, &.{ 0x62, 0x04 });
    defer gpa.free(payload);

    const img = try decodeRgba(gpa, payload);
    defer img.deinit(gpa);
    try testing.expectEqual(@as(usize, 5 * 4), img.pixels.len);
    for (0..5) |i| {
        try testing.expectEqualSlices(u8, &.{ 0xff, 0xff, 0xff, 0xff }, img.pixels[i * 4 ..][0..4]);
    }
}

test "decodeRgba: two-byte length run fills the row" {
    const gpa = testing.allocator;
    const payload = try buildOneLayer(gpa, 1, 257, 1, false, &.{ 0x61, 0x81, 0x61, 0x00 });
    defer gpa.free(payload);

    const img = try decodeRgba(gpa, payload);
    defer img.deinit(gpa);
    try testing.expectEqual(@as(usize, 257 * 4), img.pixels.len);
    for (0..257) |i| {
        try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels[i * 4 ..][0..4]);
    }
}

fn beginPayload(gpa: std.mem.Allocator, layer_count: u32) !std.ArrayList(u8) {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION);
    try out.append(gpa, 1); // x2 variant
    try out.appendSlice(gpa, &.{ 0, 0 });
    try appendU32(&out, gpa, 2); // width
    try appendU32(&out, gpa, 1); // height
    try appendU32(&out, gpa, layer_count);
    return out;
}

test "decodeRgba: two layers composite bottom-to-top (top ink wins)" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0xC9, 0x01 });
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00, 0x62, 0x00 });

    const img = try decodeRgba(gpa, out.items);
    defer img.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels[0..4]);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff }, img.pixels[4..8]);
}

test "decodeRgba: a hidden-flagged record is skipped by the default composite" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0xC9, 0x01 });
    try appendRecord(&out, gpa, FLAG_HIDDEN, .layer2, &.{ 0x61, 0x00, 0x62, 0x00 });

    const img = try decodeRgba(gpa, out.items);
    defer img.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff }, img.pixels[0..4]);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff }, img.pixels[4..8]);

    const hidden = try decodeLayerRgba(gpa, out.items, 1);
    defer hidden.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, hidden.pixels[0..4]);
}

test "decodeRgba: a v1 payload (5-byte heads, no slot) still decodes" {
    const gpa = testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION_1);
    try out.append(gpa, 1); // x2 variant
    try out.appendSlice(gpa, &.{ 0, 0 });
    try appendU32(&out, gpa, 1);
    try appendU32(&out, gpa, 1);
    try appendU32(&out, gpa, 1);
    try out.append(gpa, 0x00); // v1 head: flags only, no slot byte
    try appendU32(&out, gpa, 2);
    try out.appendSlice(gpa, &.{ 0x61, 0x00 }); // 1 black px

    const img = try decodeRgba(gpa, out.items);
    defer img.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels);

    const one = try decodeLayerRgba(gpa, out.items, 0);
    defer one.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, one.pixels);

    out.items[4] = 3;
    try testing.expectError(error.BadPayload, decodeRgba(gpa, out.items));
}

test "decodeLayerRgba: one record, transparent 0xff maps to alpha 0" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0xC9, 0x01 }); // gray, gray
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00, 0x62, 0x00 }); // black, transparent

    const bg = try decodeLayerRgba(gpa, out.items, 0);
    defer bg.deinit(gpa);
    try testing.expectEqual(@as(u32, 2), bg.width);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff, 0xc9, 0xc9, 0xc9, 0xff }, bg.pixels);

    const main_l = try decodeLayerRgba(gpa, out.items, 1);
    defer main_l.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, main_l.pixels[0..4]);
    try testing.expectEqual(@as(u8, 0x00), main_l.pixels[7]); // alpha 0
    try testing.expectEqual(@as(u8, 0xff), main_l.pixels[4]); // rgb stays white under it

    try testing.expectError(error.LayerOutOfRange, decodeLayerRgba(gpa, out.items, 2));
}

test "decodeRgba: hostile dimensions are refused before anything is allocated" {
    const gpa = testing.allocator;

    // On wasm32 `npix * 4` wraps to 0; here (64-bit) assert the dimensions are
    // rejected before any allocation.
    {
        const payload = try buildOneLayer(gpa, 0, 0x2000_0000, 2, false, &.{});
        defer gpa.free(payload);
        try testing.expectError(error.BadPayload, decodeRgba(gpa, payload));
    }
    {
        const payload = try buildOneLayer(gpa, 0, 0x1_0000, 0x1_0000, false, &.{});
        defer gpa.free(payload);
        try testing.expectError(error.BadPayload, decodeRgba(gpa, payload));
    }
    {
        const payload = try buildOneLayer(gpa, 0, 1 << 12, (1 << 12) + 1, false, &.{});
        defer gpa.free(payload);
        try testing.expectError(error.BadPayload, decodeRgba(gpa, payload));
    }
    try testing.expect(@as(u64, 1920) * 2560 < max_pixels);

    {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(gpa);
        try out.appendSlice(gpa, MAGIC);
        try out.append(gpa, VERSION);
        try out.append(gpa, 0);
        try out.appendSlice(gpa, &.{ 0, 0 });
        try appendU32(&out, gpa, 2);
        try appendU32(&out, gpa, 2);
        try appendU32(&out, gpa, 1);
        try out.append(gpa, 0x00);
        try out.append(gpa, types.LayerSlot.main.wireId());
        try appendU32(&out, gpa, 0xffff_ffff); // claims 4 GiB of layer data
        try testing.expectError(error.BadPayload, decodeRgba(gpa, out.items));
        try testing.expectError(error.BadPayload, decodeLayerRgba(gpa, out.items, 0));
    }
}

test "decodeRgba: bad magic / short buffer rejected, never crashes" {
    const gpa = testing.allocator;
    try testing.expectError(error.BadPayload, decodeRgba(gpa, "XXXX\x01\x01\x00\x00"));
    try testing.expectError(error.BadPayload, decodeRgba(gpa, "SN"));
}

test "backgroundImageHash: a bit2 background record yields its asset hash" {
    const gpa = testing.allocator;
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, FLAG_RASTER_IMAGE, .background, hash);
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00 });
    try testing.expectEqualStrings(hash, backgroundImageHash(out.items).?);
}

test "backgroundImageHash: null for an ordinary RLE page (no bit2 anywhere)" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0x65, 0x03 });
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00 });
    try testing.expect(backgroundImageHash(out.items) == null);
}

test "backgroundImageHash: a raster-image flag on a non-background slot is ignored" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 1);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, FLAG_RASTER_IMAGE, .main, "x");
    try testing.expect(backgroundImageHash(out.items) == null);
}

test "backgroundImageHash: short / foreign / truncated input returns null, never crashes" {
    const gpa = testing.allocator;
    try testing.expect(backgroundImageHash("SN") == null);
    try testing.expect(backgroundImageHash("XXXX\x02\x01\x00\x00") == null);
    var out = try beginPayload(gpa, 1);
    defer out.deinit(gpa);
    try out.append(gpa, FLAG_RASTER_IMAGE);
    try out.append(gpa, types.LayerSlot.background.wireId());
    try appendU32(&out, gpa, 64); // claims 64 bytes of hash; none follow
    try testing.expect(backgroundImageHash(out.items) == null);
}

test "enumerateRecords: v2 records yield slot + flag bits + hash, dims from header" {
    const gpa = testing.allocator;
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    var out = try beginPayload(gpa, 2); // 2x1 header
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, FLAG_RASTER_IMAGE, .background, hash);
    try appendRecord(&out, gpa, FLAG_HIDDEN, .main, &.{ 0x61, 0x03 });

    var buf: [max_layers]RecordInfo = undefined;
    const en = enumerateRecords(out.items, &buf).?;
    try testing.expectEqual(@as(u32, 2), en.width);
    try testing.expectEqual(@as(u32, 1), en.height);
    try testing.expectEqual(@as(usize, 2), en.records.len);

    try testing.expectEqual(types.LayerSlot.background, en.records[0].slot);
    try testing.expect(!en.records[0].excluded);
    try testing.expect(en.records[0].raster_image);
    try testing.expectEqualStrings(hash, en.records[0].data);

    try testing.expectEqual(types.LayerSlot.main, en.records[1].slot);
    try testing.expect(en.records[1].excluded);
    try testing.expect(!en.records[1].raster_image);
}

test "enumerateRecords: rejects everything the stacked panel cannot present" {
    const gpa = testing.allocator;
    var buf: [max_layers]RecordInfo = undefined;

    {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(gpa);
        try out.appendSlice(gpa, MAGIC);
        try out.append(gpa, VERSION_1);
        try out.append(gpa, 1);
        try out.appendSlice(gpa, &.{ 0, 0 });
        try appendU32(&out, gpa, 2);
        try appendU32(&out, gpa, 1);
        try appendU32(&out, gpa, 1);
        try out.append(gpa, 0x00); // v1 head: flags only
        try appendU32(&out, gpa, 2);
        try out.appendSlice(gpa, &.{ 0x61, 0x00 });
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    try testing.expect(enumerateRecords("XXXX\x02\x01\x00\x00", &buf) == null);
    try testing.expect(enumerateRecords(&.{ 0x53, 0x4e, 0x50, 0x47, 2 }, &buf) == null);

    {
        var out = try beginPayload(gpa, 1);
        defer out.deinit(gpa);
        try out.append(gpa, 0x00);
        try out.append(gpa, 5); // no such slot
        try appendU32(&out, gpa, 2);
        try out.appendSlice(gpa, &.{ 0x61, 0x00 });
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    {
        var out = try beginPayload(gpa, 1);
        defer out.deinit(gpa);
        try out.append(gpa, 0x00);
        try out.append(gpa, types.LayerSlot.main.wireId());
        try appendU32(&out, gpa, 999); // claims bytes the payload lacks
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    {
        var out = try beginPayload(gpa, 1);
        defer out.deinit(gpa);
        try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00 });
        try out.appendSlice(gpa, &.{ 0xde, 0xad }); // not our payload
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    {
        var zero = try beginPayload(gpa, 0);
        defer zero.deinit(gpa);
        try testing.expect(enumerateRecords(zero.items, &buf) == null);

        var over = try beginPayload(gpa, 6);
        defer over.deinit(gpa);
        try testing.expect(enumerateRecords(over.items, &buf) == null);
    }
}
