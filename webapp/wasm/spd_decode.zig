//! Freestanding WASM entry points for the browser `.spd` viewer, compiled from
//! the shared `parsers/spd/` so the format is parsed in one place. It extracts
//! layers and PNG tiles; the browser decodes and composites them.
//!
//! Exports are `spd_`-prefixed because this build links wasi-libc, whose
//! `free`/`open`/`close` would collide. `spd_open` returns -1 not SQLite, -2 not
//! an .spd, -3 corrupt, -4 OOM, -5 malformed layer tree, -6 other.
//!
//! `memory` can grow on `spd_alloc`/`spd_open`/`spd_tile_next`, so re-read
//! pointers after each call. Layer names and doc dims are stable until the next
//! `spd_open`/`spd_close`; a tile's PNG only until the next tile call.

const std = @import("std");
const builtin = @import("builtin");
const spd = @import("spd");
const c = spd.sqlite.c;

/// wasm_allocator in the browser, page_allocator natively. Backs only the
/// parser's copies; SQLite uses libc `malloc`.
const gpa = if (builtin.target.cpu.arch.isWasm())
    std.heap.wasm_allocator
else
    std.heap.page_allocator;

var doc: ?spd.Spd = null;
var meta: ?spd.Metadata = null;
var tile_it: ?spd.TileIterator = null;
/// The current tile's PNG, copied out of SQLite's row memory so it survives
/// `memory.grow` and an async `createImageBitmap`.
var cur_png: std.ArrayList(u8) = .empty;
var cur_x: u32 = 0;
var cur_y: u32 = 0;

export fn spd_alloc(len: usize) ?[*]u8 {
    const buf = gpa.alloc(u8, len) catch return null;
    return buf.ptr;
}

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

export fn spd_open(ptr: [*]const u8, len: usize) i32 {
    spd_close();

    // SQLITE_OMIT_AUTOINIT in the wasm build: initialise explicitly (registers
    // the null VFS). Idempotent.
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

// ---- layer tree ----

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

// ---- tile iteration ----

/// A layer with no `surface_<id>` table yields zero tiles.
export fn spd_tiles_begin(id: i32) i32 {
    if (doc == null) return -6;
    resetTiles();
    tile_it = (&doc.?).iterateLayer(id) catch |err| return openErr(err);
    return 0;
}

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
