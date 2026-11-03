//! Tier 3: decode each layer's bitmap and composite bottom-to-top (reversed
//! `LAYERSEQ`) over white; 0xff is transparent. `renderPage` needs no full
//! `Note`.

const std = @import("std");
const decoder = @import("decoder.zig");
const note_mod = @import("note.zig");
const source = @import("source.zig");
const types = @import("types.zig");

const TRANSPARENT: u8 = 0xff;
const WHITE: u8 = 0xff;

pub const Error = note_mod.Error || decoder.DecodeError;

pub const Image = struct {
    width: u32,
    height: u32,
    /// Row-major 8-bit grayscale, `width * height` bytes. Owned by caller.
    pixels: []u8,

    pub fn deinit(self: Image, gpa: std.mem.Allocator) void {
        gpa.free(self.pixels);
    }
};

/// Renders one parsed page to grayscale from `src`. `dims` are the note's base
/// (portrait) dims; a landscape (`1090`) page's raster is stored natively
/// landscape, so the result carries the effective dims (`Dimensions.oriented`).
/// One scratch buffer is reused across layers.
pub fn renderPage(
    gpa: std.mem.Allocator,
    src: source.Source,
    variant: decoder.Variant,
    dims: types.Dimensions,
    page: types.Page,
) Error!Image {
    const eff = dims.oriented(page.orientation());
    const w = eff.width;
    const h = eff.height;
    const npix = @as(usize, w) * @as(usize, h);

    const pixels = try gpa.alloc(u8, npix);
    errdefer gpa.free(pixels);
    @memset(pixels, WHITE);

    const scratch = try gpa.alloc(u8, npix);
    defer gpa.free(scratch);

    var order_buf: [types.LayerSlot.all.len]types.LayerSlot = undefined;
    const order = types.bottomUpOrder(page, &order_buf);
    for (order) |slot| {
        const layer = page.layer(slot) orelse continue;
        const bitmap_addr = layer.bitmapAddress();
        if (bitmap_addr == 0) continue;

        const held = src.blockHeld(gpa, bitmap_addr) catch |e| return switch (e) {
            error.OutOfMemory => error.OutOfMemory,
            error.OutOfBounds => error.Truncated,
            error.ReadFailed => error.ReadFailed,
        };
        defer held.deinit(gpa);
        const data = held.bytes;

        // A custom background that is not RATTA_RLE is an image template
        // (PNG/JPG/WEBP); skip it and draw ink over white, as WASM `decodeRgba`
        // does.
        if (slot == .background and page.hasCustomStyle() and
            !decoder.decodesToExactly(data, npix))
            continue;

        const all_blank = slot == .background and page.isWhiteStyle() and
            data.len == types.special_white_style_block_size;

        try decoder.decodeInto(scratch, variant, data, all_blank);

        for (pixels, scratch) |*dst, s| {
            if (s != TRANSPARENT) dst.* = s;
        }
    }

    return .{ .width = w, .height = h, .pixels = pixels };
}

pub fn renderPageGray(gpa: std.mem.Allocator, note: note_mod.Note, page_index: usize) Error!Image {
    if (page_index >= note.pages.len) return error.PageOutOfRange;
    return renderPage(gpa, note.source, note.rleVariant(), note.dimensions(), note.pages[page_index]);
}

test "renderPageGray refuses an out-of-range page index" {
    const empty = note_mod.Note{
        .arena = std.heap.ArenaAllocator.init(std.testing.allocator),
        .source = source.Source.fromSlice(""),
        .signature = .{ .family = .x_series, .version = 20260016, .filetype = "note", .raw = "" },
        .header = .{ .entries = &.{} },
        .footer = .{ .entries = &.{} },
        .pages = &.{},
    };
    try std.testing.expectError(error.PageOutOfRange, renderPageGray(std.testing.allocator, empty, 0));
}
