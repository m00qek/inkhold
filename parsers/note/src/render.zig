//! Tier 3 — page rendering: decode each layer's bitmap and composite them into
//! a single 8-bit grayscale image.
//!
//! Compositing mirrors the reference: layers are drawn bottom-to-top in the
//! order given by the page's `LAYERSEQ` (reversed — see `types.bottomUpOrder`),
//! starting from a white background. A pixel with the transparent value (0xff)
//! lets the layer beneath show through.
//!
//! The core (`renderPage`) needs only what Tier 1 + Tier 2 provide — a source,
//! the RLE variant, the dimensions and one parsed page — so a caller can render
//! a single page without ever building a full `Note`. `renderPageGray` is the
//! eager-`Note` convenience over it.

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

/// Renders one parsed page to a grayscale image, reading each present layer's
/// bitmap from `src`.
///
/// `dims` is the note's BASE (portrait) dims (`Note.dimensions()`); the page's
/// `ORIENTATION` is applied here. A landscape
/// (`1090`) page's raster is stored natively landscape — the same flat RLE
/// stream, but the true row width is the swapped base width — so the returned
/// `Image` is labeled with the page's EFFECTIVE dims (1872×1404 on a Nomad).
/// The decoded bytes are identical either way; only the declared shape changes
/// (`Dimensions.oriented` is the one copy of that fact).
///
/// One scratch buffer is reused for every layer's decode — per-page cost is two
/// page-sized buffers (composite + scratch) regardless of layer count.
///
/// NOTE deliberately NOT done: run-level compositing (decoding each RLE run
/// straight into the composite and skipping the scratch entirely). It would
/// halve the buffers and skip a full-page copy per layer, but nothing has been
/// measured to need it — an optimization without a measurement is a preference.
/// If page rendering ever shows up in a profile, this loop is the place.
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

    // Draw bottom-to-top: reversed LAYERSEQ order.
    var order_buf: [types.LayerSlot.all.len]types.LayerSlot = undefined;
    const order = types.bottomUpOrder(page, &order_buf);
    for (order) |slot| {
        const layer = page.layer(slot) orelse continue;
        const bitmap_addr = layer.bitmapAddress();
        if (bitmap_addr == 0) continue;

        // Borrowed for a slice source, copied for a ranged one — either way the
        // bitmap is live only for this layer's decode.
        const held = src.blockHeld(gpa, bitmap_addr) catch |e| return switch (e) {
            error.OutOfMemory => error.OutOfMemory,
            error.OutOfBounds => error.Truncated,
            error.ReadFailed => error.ReadFailed,
        };
        defer held.deinit(gpa);
        const data = held.bytes;

        // A custom-style background that does NOT decode as RATTA_RLE is a
        // browser-native image template (PNG/JPG/WEBP). This native compositor
        // has no image decoder — and must never feed image bytes to
        // `decodeInto` (it would fail) — so it skips the image background and
        // renders ink on the white base, exactly as the WASM `decodeRgba`
        // composite does. The browser reader underlays the actual image; the
        // CLI/dump path just shows the strokes over white.
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

/// Renders page `page_index` of an eagerly parsed `note`.
pub fn renderPageGray(gpa: std.mem.Allocator, note: note_mod.Note, page_index: usize) Error!Image {
    if (page_index >= note.pages.len) return error.PageOutOfRange;
    return renderPage(gpa, note.source, note.rleVariant(), note.dimensions(), note.pages[page_index]);
}

test "renderPageGray refuses an out-of-range page index" {
    // A hand-built empty Note; its arena never allocates, so no deinit needed.
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
