//! Freestanding WASM entry points for the browser `.note` page renderer: SNPG
//! payload in (`parsers/note/src/page_payload.zig`), RGBA8888 out. The
//! container is never parsed here.
//!
//! Return codes: -1 bad payload, -2 RLE size mismatch, -3 OOM, -4 layer index
//! out of range. `decode_page` and `decode_layer` share one result slot, so
//! re-read `result_*` after every call. `snpg_enumerate` (record count or -1)
//! has its own state. Hashes are copied into static buffers, so the input may
//! be freed right after any call.

const std = @import("std");
const sn = @import("supernote");

const gpa = std.heap.wasm_allocator;

var result: ?sn.page_payload.Rgba = null;

/// The last `decode_page`'s template hash, copied so it outlives the input. A
/// hash past 256 bytes is truncated and simply misses its template.
var tmpl_hash_buf: [256]u8 = undefined;
var tmpl_hash_len: usize = 0;

export fn alloc(len: usize) ?[*]u8 {
    const buf = gpa.alloc(u8, len) catch return null;
    return buf.ptr;
}

export fn free(ptr: [*]u8, len: usize) void {
    gpa.free(ptr[0..len]);
}

/// The default composite (hidden layers skipped).
export fn decode_page(ptr: [*]const u8, len: usize) i32 {
    dropResult();
    tmpl_hash_len = 0; // reset before decode; stays 0 on any failure path
    const payload = ptr[0..len];
    const img = sn.page_payload.decodeRgba(gpa, payload) catch |err| return errCode(err);
    result = img;
    if (sn.page_payload.backgroundImageHash(payload)) |hash| {
        const n = @min(hash.len, tmpl_hash_buf.len);
        @memcpy(tmpl_hash_buf[0..n], hash[0..n]);
        tmpl_hash_len = n;
    }
    return 0;
}

/// One record into RGBA with 0xff at alpha 0, hidden records included.
export fn decode_layer(ptr: [*]const u8, len: usize, layer_index: u32) i32 {
    dropResult();
    const img = sn.page_payload.decodeLayerRgba(gpa, ptr[0..len], layer_index) catch |err| return errCode(err);
    result = img;
    return 0;
}

fn dropResult() void {
    if (result) |r| {
        r.deinit(gpa);
        result = null;
    }
}

fn errCode(err: anyerror) i32 {
    return switch (err) {
        error.OutOfMemory => -3,
        error.SizeMismatch => -2,
        error.LayerOutOfRange => -4,
        else => -1, // BadPayload / Truncated / PageOutOfRange
    };
}

export fn result_ptr() ?[*]u8 {
    return if (result) |r| r.pixels.ptr else null;
}
export fn result_len() usize {
    return if (result) |r| r.pixels.len else 0;
}
export fn result_width() u32 {
    return if (result) |r| r.width else 0;
}
export fn result_height() u32 {
    return if (result) |r| r.height else 0;
}

/// The last `decode_page`'s template hash (UTF-8), or null.
export fn template_hash_ptr() ?[*]const u8 {
    return if (tmpl_hash_len > 0) &tmpl_hash_buf else null;
}
export fn template_hash_len() usize {
    return tmpl_hash_len;
}

// ---- SNPG record enumeration for the layers panel ----

const max_records = sn.page_payload.max_layers;

/// The last `snpg_enumerate`'s result as flat arrays. Hashes are copied: the
/// `data` slices alias the input and must not escape.
var snpg_count: usize = 0;
var snpg_w: u32 = 0;
var snpg_h: u32 = 0;
var snpg_slot: [max_records]u8 = undefined;
var snpg_flags: [max_records]u8 = undefined;
var snpg_hash_len: [max_records]usize = undefined;
var snpg_hash: [max_records][256]u8 = undefined;

/// Record count (1..5), or -1 for anything the panel cannot present.
export fn snpg_enumerate(ptr: [*]const u8, len: usize) i32 {
    snpg_count = 0;
    snpg_w = 0;
    snpg_h = 0;
    var buf: [max_records]sn.page_payload.RecordInfo = undefined;
    const en = sn.page_payload.enumerateRecords(ptr[0..len], &buf) orelse return -1;
    snpg_w = en.width;
    snpg_h = en.height;
    for (en.records, 0..) |rec, i| {
        snpg_slot[i] = rec.slot.wireId();
        var f: u8 = 0;
        if (rec.excluded) f |= 0b10; // bit1
        if (rec.raster_image) f |= 0b100; // bit2
        snpg_flags[i] = f;
        if (rec.raster_image) {
            const n = @min(rec.data.len, snpg_hash[i].len);
            @memcpy(snpg_hash[i][0..n], rec.data[0..n]);
            snpg_hash_len[i] = n;
        } else {
            snpg_hash_len[i] = 0; // non-raster data (RLE) is never exposed here
        }
    }
    snpg_count = en.records.len;
    return @intCast(en.records.len);
}

export fn snpg_width() u32 {
    return snpg_w;
}
export fn snpg_height() u32 {
    return snpg_h;
}
export fn snpg_record_slot(i: usize) i32 {
    return if (i < snpg_count) snpg_slot[i] else -1;
}
export fn snpg_record_flags(i: usize) i32 {
    return if (i < snpg_count) snpg_flags[i] else -1;
}
export fn snpg_record_hash_ptr(i: usize) ?[*]const u8 {
    return if (i < snpg_count and snpg_hash_len[i] > 0) &snpg_hash[i] else null;
}
export fn snpg_record_hash_len(i: usize) usize {
    return if (i < snpg_count) snpg_hash_len[i] else 0;
}
