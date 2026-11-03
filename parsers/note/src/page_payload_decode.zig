//! The SNPG consumer: header and record reads, composite and per-layer decode, enumeration. Also compiled into the freestanding wasm.

const std = @import("std");
const decoder = @import("decoder.zig");
const types = @import("types.zig");
const TRANSPARENT: u8 = 0xff;
const WHITE: u8 = 0xff;
const max_pixels: u64 = 1 << 24;
const page_payload = @import("page_payload.zig");
const Error = page_payload.Error;
const FLAG_ALL_BLANK = page_payload.FLAG_ALL_BLANK;
const FLAG_HIDDEN = page_payload.FLAG_HIDDEN;
const FLAG_RASTER_IMAGE = page_payload.FLAG_RASTER_IMAGE;
const MAGIC = page_payload.MAGIC;
const Rgba = page_payload.Rgba;
const VERSION = page_payload.VERSION;
const VERSION_1 = page_payload.VERSION_1;
const max_layers = page_payload.max_layers;

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

test {
    _ = @import("page_payload_test.zig");
}

test {
    _ = @import("page_payload_decode_test.zig");
}

// ---- tests of private helpers ----

const appendU32 = @import("page_payload_decode_fixture.zig").appendU32;

const testing = std.testing;
const fixture = @import("page_payload_decode_fixture.zig");
const buildOneLayer = fixture.buildOneLayer;

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
