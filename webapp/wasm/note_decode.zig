//! Freestanding WebAssembly entry points for the browser `.note` page renderer.
//!
//! This is the real decoder behind the frontend's `NoteRenderer` seam. It takes
//! ONE page's bytes — the compact "SNPG" payload the server's Option-3 endpoint
//! (`GET /note/{id}/page/{n}`) returns — and produces an RGBA8888 pixel buffer
//! the browser wraps into an `ImageBitmap`. The container is never parsed here;
//! all container knowledge lives server-side (see
//! `parsers/note/src/page_payload.zig`, which also defines the payload format
//! and its native producer).
//!
//! ## C-ABI (little-endian linear memory)
//!
//!   u8* alloc(usize len)          — allocate `len` bytes; JS copies the page
//!                                   payload in. Returns 0 (null) on OOM.
//!   void free(u8* ptr, usize len) — free a buffer from `alloc`.
//!
//!   i32  decode_page(u8* ptr, usize len)
//!        Decode+composite the SNPG payload at [ptr, ptr+len) — the DEFAULT
//!        (device-authored) composite: SNPG v2 records flagged `hidden` are
//!        skipped, so the pixels match what the device shows. v1 payloads
//!        (older client caches) still decode.
//!        Returns 0 on success; a negative error code otherwise:
//!          -1 bad/short/unsupported payload
//!          -2 RLE decode failed (a layer's size did not match width*height)
//!          -3 out of memory
//!        On success the result is retained until the next decode call and
//!        read via the getters below. The input buffer may be freed immediately.
//!
//!   i32  decode_layer(u8* ptr, usize len, u32 layer_index)
//!        Decode ONE layer record (bottom-to-top record order, hidden ones
//!        included — that is what they ship for) of the same payload into
//!        RGBA where the transparent value (0xff) has alpha 0: the
//!        stacked-canvas input for the layer panel. Same return codes, plus:
//!          -4 layer_index at or past the payload's layer_count
//!        Shares the result slot with decode_page: after EVERY call, re-read
//!        result_ptr()/result_len() — any decode invalidates the previous
//!        result's memory.
//!
//!   u8*  result_ptr()    — pointer to RGBA8888 pixels (row-major, w*h*4 bytes).
//!   usize result_len()   — byte length of the pixel buffer (== w*h*4).
//!   u32  result_width()  — image width in pixels.
//!   u32  result_height() — image height in pixels.
//!
//!   u8*  template_hash_ptr() — pointer to the last `decode_page`'s image-
//!        template asset HASH (UTF-8), or null when that page had no bit2 image
//!        background. The browser turns it into `GET /note/{id}/template/{hash}`
//!        and underlays the image. Reset (length 0) at the start of every
//!        `decode_page`; copied into a static buffer, so it is independent of the
//!        input payload's lifetime. `decode_layer` does not touch it.
//!   usize template_hash_len() — byte length of that hash (0 = none).
//!
//!   i32  snpg_enumerate(u8* ptr, usize len)
//!        Enumerate the SNPG v2 record heads of the payload at [ptr, ptr+len)
//!        for the layers panel — NO RLE is decoded, and this is independent of
//!        the `decode_page`/`decode_layer` result slot. Returns the record count
//!        (1..5) on success, or -1 for anything the stacked panel cannot present
//!        (v1 / foreign / truncated / unknown slot / over-claim / bad count /
//!        trailing junk). On success the dims + per-record identity are read via
//!        the getters below; any raster-image hash is copied into a static
//!        buffer, so it survives after the input buffer is freed. State is reset
//!        at the start of every call.
//!   u32  snpg_width()  / u32 snpg_height() — the enumerated page's dims (0 none).
//!   i32  snpg_record_slot(usize i)  — record i's wire slot id (0=main..4=bg), or
//!        -1 out of range.
//!   i32  snpg_record_flags(usize i) — record i's panel flag bits (bit1 excluded,
//!        bit2 raster-image), or -1 out of range.
//!   u8*  snpg_record_hash_ptr(usize i) / usize snpg_record_hash_len(usize i) —
//!        record i's asset HASH (UTF-8) for a raster-image background, else
//!        length 0. Valid until the next `snpg_enumerate`.
//!
//! `decode_page` pixels are opaque grayscale mapped to RGBA — black ink on a
//! white page, committing to no light/dark theme. The JS caller applies the
//! theme (e.g. invert the RGB channels for dark mode) before/while drawing.
//! `decode_layer` pixels are the same mapping except transparent (alpha 0)
//! where the layer has no ink.
//!
//! Imports the shared `supernote` module but references only `page_payload`, so
//! the freestanding build pulls in no parser/test/debug code it does not need.

const std = @import("std");
const sn = @import("supernote");

const gpa = std.heap.wasm_allocator;

var result: ?sn.page_payload.Rgba = null;

/// The last `decode_page`'s image-template asset hash, COPIED here so it outlives
/// the input payload (which JS may free immediately after decode). Read via
/// `template_hash_ptr`/`template_hash_len`; reset to length 0 each `decode_page`.
/// 256 bytes is far above any real asset hash (a 32-char `PAGESTYLEMD5`); a
/// longer one is truncated rather than overrun — a truncated hash simply misses
/// its template and degrades to ink-on-white, never a memory error.
var tmpl_hash_buf: [256]u8 = undefined;
var tmpl_hash_len: usize = 0;

/// Allocate `len` bytes in wasm memory; returns null on OOM.
export fn alloc(len: usize) ?[*]u8 {
    const buf = gpa.alloc(u8, len) catch return null;
    return buf.ptr;
}

/// Free a buffer previously returned by `alloc`.
export fn free(ptr: [*]u8, len: usize) void {
    gpa.free(ptr[0..len]);
}

/// Decode+composite the SNPG page payload at [ptr, ptr+len) into RGBA (the
/// default composite — hidden layers skipped). See the file header for the
/// return-code contract.
export fn decode_page(ptr: [*]const u8, len: usize) i32 {
    dropResult();
    tmpl_hash_len = 0; // reset before decode; stays 0 on any failure path
    const payload = ptr[0..len];
    const img = sn.page_payload.decodeRgba(gpa, payload) catch |err| return errCode(err);
    result = img;
    // Extract the bit2 image-template hash (aliases `payload`) and COPY it into
    // our static buffer, so it survives after JS frees the input buffer.
    if (sn.page_payload.backgroundImageHash(payload)) |hash| {
        const n = @min(hash.len, tmpl_hash_buf.len);
        @memcpy(tmpl_hash_buf[0..n], hash[0..n]);
        tmpl_hash_len = n;
    }
    return 0;
}

/// Decode ONE layer record of the payload into RGBA with transparent (0xff)
/// pixels at alpha 0 — the stacked-canvas input. Same result slot as
/// `decode_page`; re-read the result pointers after every call.
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

/// Pointer to the last decode's RGBA8888 pixels (4 bytes/pixel, row-major).
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

/// Pointer to the last `decode_page`'s image-template asset hash (UTF-8), or null
/// when that page had no bit2 image background. Valid until the next decode.
export fn template_hash_ptr() ?[*]const u8 {
    return if (tmpl_hash_len > 0) &tmpl_hash_buf else null;
}
export fn template_hash_len() usize {
    return tmpl_hash_len;
}

// ---------------------------------------------------------------------------
// SNPG record enumeration for the layers panel. Independent of the decode
// result slot: the browser enumerates once, then decodes records by index.
// ---------------------------------------------------------------------------

const max_records = sn.page_payload.max_layers;

/// The last `snpg_enumerate`'s result, flattened into plain arrays the C ABI can
/// read one field at a time. Any raster-image hash is COPIED into `snpg_hash`,
/// so it outlives the (potentially freed) input payload — the `data` slices
/// `enumerateRecords` returns alias that input and must not escape.
var snpg_count: usize = 0;
var snpg_w: u32 = 0;
var snpg_h: u32 = 0;
var snpg_slot: [max_records]u8 = undefined;
var snpg_flags: [max_records]u8 = undefined;
var snpg_hash_len: [max_records]usize = undefined;
var snpg_hash: [max_records][256]u8 = undefined;

/// Enumerate the SNPG v2 record heads at [ptr, ptr+len). Returns the record
/// count (1..5), or -1 for anything the panel cannot present. See the file
/// header for the getter contract.
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
