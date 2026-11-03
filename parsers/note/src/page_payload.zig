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

const page_payload_decode = @import("page_payload_decode.zig");
pub const decodeRgba = page_payload_decode.decodeRgba;
pub const decodeLayerRgba = page_payload_decode.decodeLayerRgba;
pub const backgroundImageHash = page_payload_decode.backgroundImageHash;
pub const RecordInfo = page_payload_decode.RecordInfo;
pub const Enumeration = page_payload_decode.Enumeration;
pub const enumerateRecords = page_payload_decode.enumerateRecords;

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

test {
    _ = page_payload_decode;
}
