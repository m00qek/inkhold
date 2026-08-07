//! Freestanding-WASM entry points for the browser `.spd` (Atelier) viewer.
//!
//! This is the SAME parser the backend uses (`parsers/spd/`), compiled to WASM
//! instead of re-implemented in JS — the one governing rule of the `.spd`
//! integration plan: the reverse-engineered
//! format is parsed in exactly one place, so the `tid` mapping and WAL handling
//! cannot silently drift between the two faces.
//!
//! The module **extracts, it does not rasterise.** It opens a raw `.spd` (a
//! SQLite database) in memory, hands out the layer tree and each layer's PNG
//! tiles with their grid coordinates, and lets the browser decode the PNGs
//! (`createImageBitmap`) and composite them onto a canvas. Rendering stays
//! client-side; the parse stays in the shared parser.
//!
//! ## C-ABI (little-endian; pointers are byte offsets into exported `memory`)
//!
//! Exports are `spd_`-prefixed: this build links wasi-libc (SQLite needs its
//! headers), whose own `free`/`open`/`close` symbols an unprefixed ABI would
//! collide with. `note_decode` is freestanding and can use bare names; this one
//! cannot.
//!
//! Buffers:
//!   u8*  spd_alloc(usize len)          — allocate; JS copies the raw `.spd` in. 0 on OOM.
//!   void spd_free(u8* ptr, usize len)  — free an `spd_alloc` buffer.
//!
//! Document:
//!   i32  spd_open(u8* ptr, usize len)  — parse the `.spd` at [ptr,ptr+len). The
//!        input may be freed immediately after (it is copied). 0 on success;
//!        negative on error: -1 not-SQLite, -2 not-an-.spd, -3 corrupt,
//!        -4 out-of-memory, -5 malformed layer tree, -6 other.
//!   void spd_close()                   — release the open document + iterator.
//!   u32  spd_doc_width() / spd_doc_height() — surface px (0 if the file omits it).
//!
//! Layer tree (Z-order: index 0 = topmost, matching the parser):
//!   u32  spd_layer_count()
//!   i32  spd_layer_id(u32 i)           — internal id; -1 if `i` out of range.
//!   u32  spd_layer_visible(u32 i)      — 1 visible, 0 hidden.
//!   u32  spd_layer_opacity(u32 i)      — 0..255.
//!   u8*  spd_layer_name_ptr(u32 i)     — UTF-8 name bytes (not NUL-terminated).
//!   u32  spd_layer_name_len(u32 i)
//!
//! Tile iteration (one layer at a time):
//!   i32  spd_tiles_begin(i32 layer_id) — start iterating `surface_<id>`. 0 ok
//!        (an absent/empty layer is ok and yields zero tiles), negative on error.
//!   i32  spd_tile_next()               — 1 = a tile is ready (read via the getters
//!        below), 0 = done, negative on error.
//!   u32  spd_tile_x() / spd_tile_y()   — tile grid coords; absolute px = coord*128.
//!   u8*  spd_tile_png_ptr()            — current tile's PNG bytes.
//!   u32  spd_tile_png_len()
//!
//! ## Lifetime rules (same as `note_decode`)
//!
//! `memory` can grow on any `spd_alloc`/`spd_open`/`spd_tile_next` call, so JS
//! must re-read every pointer AFTER the call that produced it and copy the bytes
//! out before the next call. `spd_layer_name_*` and `spd_doc_*` are stable until
//! the next `spd_open`/`spd_close`. The current tile's PNG (`spd_tile_png_*`) is
//! valid only until the next `spd_tile_next`/`spd_tiles_begin`/`spd_close`; copy
//! it (or `createImageBitmap` it) before advancing.

const std = @import("std");
const builtin = @import("builtin");
const spd = @import("spd");
const c = spd.sqlite.c;

/// wasm_allocator in the browser; page_allocator natively (the ABI test).
/// SQLite itself uses libc `malloc` — this allocator backs only the parser's
/// own copies (the image, metadata arena, the tile PNG buffer).
const gpa = if (builtin.target.cpu.arch.isWasm())
    std.heap.wasm_allocator
else
    std.heap.page_allocator;

var doc: ?spd.Spd = null;
var meta: ?spd.Metadata = null;
var tile_it: ?spd.TileIterator = null;
/// The current tile's PNG, copied out of SQLite's row memory so the pointer we
/// hand JS survives an intervening `memory.grow` and an async `createImageBitmap`.
var cur_png: std.ArrayList(u8) = .empty;
var cur_x: u32 = 0;
var cur_y: u32 = 0;

/// Allocate `len` bytes in wasm memory; null on OOM.
export fn spd_alloc(len: usize) ?[*]u8 {
    const buf = gpa.alloc(u8, len) catch return null;
    return buf.ptr;
}

/// Free a buffer previously returned by `alloc`.
export fn spd_free(ptr: [*]u8, len: usize) void {
    gpa.free(ptr[0..len]);
}

fn resetTiles() void {
    if (tile_it) |*it| {
        it.deinit();
        tile_it = null;
    }
    cur_png.clearRetainingCapacity();
    cur_x = 0;
    cur_y = 0;
}

/// Release the open document, its metadata, and any active tile iterator.
export fn spd_close() void {
    resetTiles();
    if (meta) |*m| {
        m.deinit();
        meta = null;
    }
    if (doc) |*d| {
        d.deinit();
        doc = null;
    }
}

/// Parse the `.spd` at [ptr, ptr+len). See the header for the return contract.
export fn spd_open(ptr: [*]const u8, len: usize) i32 {
    spd_close();

    // SQLITE_OMIT_AUTOINIT is set in the wasm build, so the single entry point
    // must initialise explicitly (this registers the null VFS). Idempotent, and
    // a harmless no-op on the native build where autoinit is present.
    if (c.sqlite3_initialize() != c.SQLITE_OK) return -6;

    var d = spd.open(gpa, ptr[0..len]) catch |err| return openErr(err);
    const m = d.metadata(gpa) catch |err| {
        d.deinit();
        return openErr(err);
    };
    doc = d;
    meta = m;
    return 0;
}

fn openErr(err: spd.Error) i32 {
    return switch (err) {
        error.NotSqlite => -1,
        error.NotSpd => -2,
        error.Corrupt => -3,
        error.OutOfMemory => -4,
        error.Malformed, error.VarintOverflow, error.Truncated => -5,
        else => -6, // TileCoordOverflow / BadTid — not reachable from open()
    };
}

export fn spd_doc_width() u32 {
    const m = meta orelse return 0;
    return floatToPx(m.width);
}
export fn spd_doc_height() u32 {
    const m = meta orelse return 0;
    return floatToPx(m.height);
}
fn floatToPx(v: ?f32) u32 {
    const f = v orelse return 0;
    if (f <= 0 or f >= 4294967296.0) return 0;
    return @intFromFloat(@round(f));
}

// ---- Layer tree ----

fn layers() []const spd.LayerInfo {
    const m = meta orelse return &.{};
    return m.layers;
}

export fn spd_layer_count() u32 {
    return @intCast(layers().len);
}
export fn spd_layer_id(i: u32) i32 {
    const ls = layers();
    if (i >= ls.len) return -1;
    return ls[i].id;
}
export fn spd_layer_visible(i: u32) u32 {
    const ls = layers();
    if (i >= ls.len) return 0;
    return @intFromBool(ls[i].visible);
}
export fn spd_layer_opacity(i: u32) u32 {
    const ls = layers();
    if (i >= ls.len) return 0;
    return ls[i].opacity;
}
export fn spd_layer_name_ptr(i: u32) ?[*]const u8 {
    const ls = layers();
    if (i >= ls.len) return null;
    return ls[i].name.ptr;
}
export fn spd_layer_name_len(i: u32) u32 {
    const ls = layers();
    if (i >= ls.len) return 0;
    return @intCast(ls[i].name.len);
}

// ---- Tile iteration ----

/// Begin iterating a layer's tiles. Safe to call for any id: a layer with no
/// `surface_<id>` table yields zero tiles (returns 0, then `tile_next` = 0).
export fn spd_tiles_begin(id: i32) i32 {
    if (doc == null) return -6;
    resetTiles();
    tile_it = (&doc.?).iterateLayer(id) catch |err| return openErr(err);
    return 0;
}

/// Advance the iterator. 1 = tile ready, 0 = done, negative = error.
export fn spd_tile_next() i32 {
    const it = &(tile_it orelse return -6);
    const tile = it.next() catch |err| return openErr(err);
    const t = tile orelse return 0;
    cur_png.clearRetainingCapacity();
    cur_png.appendSlice(gpa, t.png) catch return -4;
    cur_x = t.x;
    cur_y = t.y;
    return 1;
}

export fn spd_tile_x() u32 {
    return cur_x;
}
export fn spd_tile_y() u32 {
    return cur_y;
}
export fn spd_tile_png_ptr() ?[*]const u8 {
    return cur_png.items.ptr;
}
export fn spd_tile_png_len() u32 {
    return @intCast(cur_png.items.len);
}
