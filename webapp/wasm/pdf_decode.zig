//! WASI-reactor entry points for the browser PDF viewer: a thin Zig module over
//! MuPDF (pinned in `build.zig.zon`). Every MuPDF call lives in `pdf_shim.c`,
//! because `fz_try` is `setjmp`/`longjmp` and a `longjmp` past a Zig frame
//! would skip its `defer`s. `tests/pdf_decode_abi.mjs` pins the export shapes.
//!
//! Every `i64` export returns `(ptr << 32) | len`, negative on error (so `ptr`
//! must stay under 2 GiB), valid until the next call of the same kind. `-1` bad
//! arguments or dead handle, `-2` shim refused (`ink_error_ptr` says why), `-3`
//! not packable; `ink_open` adds `-2` no context, `-3` unopenable, `-4` no slot.
//! `ink_open` takes ownership of its buffer on every path. `[]` from the JSON
//! exports is success ("nothing here"), not failure. Coordinates are points,
//! top-left origin, y down. `ink_annotate_page` mutates the open document and
//! `ink_export_incremental` returns only the delta to append to the original.
//!
//! The one import, `ink.host_read(off, dst, len)`, is required at instantiation.
//! The embedder may wrap it in `WebAssembly.Suspending`, so every document call
//! must be in JS's JSPI promising list. `memory` can grow on
//! `ink_alloc`/`ink_open`/`ink_render`; re-read pointers after each call.

const std = @import("std");

// ---- pdf_shim.c ----
const Document = opaque {};
const Pixmap = opaque {};
const Buffer = opaque {};

extern fn ink_shim_context() ?*anyopaque;
extern fn ink_shim_open(data: ?*anyopaque, len: u32) ?*Document;
extern fn ink_shim_open_stream(total: i64) ?*Document;
extern fn ink_shim_page_count(doc: *Document) c_int;
extern fn ink_shim_page_size(doc: *Document, number: c_int, w: *f32, h: *f32) c_int;
extern fn ink_shim_page_links(doc: *Document, number: c_int) ?*Buffer;
extern fn ink_shim_page_words(doc: *Document, number: c_int) ?*Buffer;
extern fn ink_shim_outline(doc: *Document) ?*Buffer;
extern fn ink_shim_render(doc: *Document, number: c_int, scale: f32) ?*Pixmap;
extern fn ink_shim_pixmap_samples(pix: *Pixmap) [*]u8;
extern fn ink_shim_pixmap_width(pix: *Pixmap) c_int;
extern fn ink_shim_pixmap_height(pix: *Pixmap) c_int;
extern fn ink_shim_pixmap_components(pix: *Pixmap) c_int;
extern fn ink_shim_pixmap_stride(pix: *Pixmap) c_int;
extern fn ink_shim_drop_pixmap(pix: *Pixmap) void;
extern fn ink_shim_export_page(
    doc: *Document,
    number: c_int,
    alpha: [*]const u8,
    w: c_int,
    h: c_int,
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    e: f32,
    f: f32,
) ?*Buffer;
extern fn ink_shim_annotate_page(
    doc: *Document,
    number: c_int,
    alpha: [*]const u8,
    w: c_int,
    h: c_int,
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    e: f32,
    f: f32,
) c_int;
extern fn ink_shim_export_incremental(doc: *Document) ?*Buffer;
extern fn ink_shim_buffer_data(buf: *Buffer) ?[*]u8;
extern fn ink_shim_buffer_len(buf: *Buffer) c_int;
extern fn ink_shim_drop_buffer(buf: *Buffer) void;
extern fn ink_shim_drop_document(doc: *Document) void;
extern fn ink_shim_shrink_store() void;
extern fn ink_shim_error() [*:0]const u8;

// libc's allocator: MuPDF frees the input buffer (`fz_new_buffer_from_data`)
// through `free`, so it must come from `malloc`.
extern fn malloc(len: usize) ?*anyopaque;
extern fn free(ptr: ?*anyopaque) void;

/// A fixed table, so a caller that forgets to close cannot grow it unboundedly.
const max_documents = 8;
var documents: [max_documents]?*Document = @splat(null);

/// One live buffer per kind (one resident pixmap is the memory ceiling). The
/// JSON/export slots are separate because their lifetimes overlap.
var last_pixmap: ?*Pixmap = null;
var last_width: i32 = 0;
var last_height: i32 = 0;
var last_export: ?*Buffer = null;
var last_links: ?*Buffer = null;
var last_words: ?*Buffer = null;
var last_outline: ?*Buffer = null;

// ---- buffers ----

export fn ink_alloc(len: u32) ?*anyopaque {
    if (len == 0) return null;
    return malloc(len);
}

/// `len` is unused (libc tracks the size), kept for ABI symmetry.
export fn ink_free(ptr: ?*anyopaque, len: u32) void {
    _ = len;
    free(ptr);
}

// ---- document ----

export fn ink_open(ptr: ?*anyopaque, len: u32) i32 {
    if (ptr == null or len == 0) {
        free(ptr);
        return -1;
    }
    if (ink_shim_context() == null) {
        free(ptr);
        return -2;
    }
    const slot = freeSlot() orelse {
        free(ptr);
        return -4;
    };
    const doc = ink_shim_open(ptr, len) orelse return -3; // shim consumed `ptr`
    documents[slot] = doc;
    return @intCast(slot + 1);
}

/// `total_len` is known from the file listing. Consumes nothing on failure.
export fn ink_open_stream(total_len: i64) i32 {
    if (total_len <= 0) return -1;
    if (ink_shim_context() == null) return -2;
    const slot = freeSlot() orelse return -4;
    const doc = ink_shim_open_stream(total_len) orelse return -3;
    documents[slot] = doc;
    return @intCast(slot + 1);
}

fn freeSlot() ?usize {
    for (documents, 0..) |d, i| {
        if (d == null) return i;
    }
    return null;
}

/// Null for any invalid or closed handle: a stale handle is an integer, never
/// a pointer.
fn lookup(handle: i32) ?*Document {
    if (handle < 1 or handle > max_documents) return null;
    return documents[@intCast(handle - 1)];
}

export fn ink_page_count(handle: i32) i32 {
    const doc = lookup(handle) orelse return -1;
    return ink_shim_page_count(doc);
}

export fn ink_page_size(handle: i32, page: i32, w: *f32, h: *f32) i32 {
    const doc = lookup(handle) orelse return -1;
    if (page < 0) return -1;
    return ink_shim_page_size(doc, page, w, h);
}

/// The links on `page` as UTF-8 JSON; see `pdf_shim.c`.
export fn ink_page_links(handle: i32, page: i32) i64 {
    const doc = lookup(handle) orelse return -1;
    if (page < 0) return -1;
    ink_links_free();

    const buf = ink_shim_page_links(doc, page) orelse return -2;
    return holdBuffer(&last_links, buf);
}

export fn ink_links_free() void {
    if (last_links) |buf| {
        last_links = null;
        ink_shim_drop_buffer(buf);
    }
}

/// The words on `page` as UTF-8 JSON. A locator, not a matcher: the client
/// folds and compares terms itself.
export fn ink_page_words(handle: i32, page: i32) i64 {
    const doc = lookup(handle) orelse return -1;
    if (page < 0) return -1;
    ink_words_free();

    const buf = ink_shim_page_words(doc, page) orelse return -2;
    return holdBuffer(&last_words, buf);
}

export fn ink_words_free() void {
    if (last_words) |buf| {
        last_words = null;
        ink_shim_drop_buffer(buf);
    }
}

/// The outline as a flat UTF-8 JSON array, depth in `d`.
export fn ink_load_outline(handle: i32) i64 {
    const doc = lookup(handle) orelse return -1;
    ink_outline_free();

    const buf = ink_shim_outline(doc) orelse return -2;
    return holdBuffer(&last_outline, buf);
}

export fn ink_outline_free() void {
    if (last_outline) |buf| {
        last_outline = null;
        ink_shim_drop_buffer(buf);
    }
}

/// Idempotent, and safe for any integer.
export fn ink_close(handle: i32) void {
    if (handle < 1 or handle > max_documents) return;
    const slot: usize = @intCast(handle - 1);
    const doc = documents[slot] orelse return;
    documents[slot] = null;
    ink_shim_drop_document(doc);
    // Release the store once the last document goes, so a closed book's decoded
    // images don't stay resident.
    for (documents) |d| {
        if (d != null) return;
    }
    dropLastRender();
    ink_shim_shrink_store();
    // Not `ink_export_free()`: the natural order is export, close, then hand the
    // bytes to the UI.
}

// ---- rendering ----

export fn ink_render(handle: i32, page: i32, scale: f32) i64 {
    const doc = lookup(handle) orelse return -1;
    if (page < 0 or !(scale > 0) or !std.math.isFinite(scale)) return -1;

    // Drop the previous render first: two zoomed pages can exhaust the tab.
    dropLastRender();

    const pix = ink_shim_render(doc, page, scale) orelse return -2;
    if (ink_shim_pixmap_components(pix) != 4) {
        // Not RGBA means the build changed under us; refuse.
        ink_shim_drop_pixmap(pix);
        return -3;
    }
    const w = ink_shim_pixmap_width(pix);
    const h = ink_shim_pixmap_height(pix);
    if (w <= 0 or h <= 0) {
        ink_shim_drop_pixmap(pix);
        return -4;
    }
    // JS indexes on the stride, so check it.
    if (ink_shim_pixmap_stride(pix) != w * 4) {
        ink_shim_drop_pixmap(pix);
        return -4;
    }
    const pixels = std.math.mul(u64, @intCast(w), @intCast(h)) catch {
        ink_shim_drop_pixmap(pix);
        return -5;
    };
    const len = std.math.mul(u64, pixels, 4) catch {
        ink_shim_drop_pixmap(pix);
        return -5;
    };
    const ptr: u64 = @intFromPtr(ink_shim_pixmap_samples(pix));
    // A heap over 2 GiB fails as `-5`, not as a negative packed value.
    if (len > std.math.maxInt(u32) or ptr > std.math.maxInt(i32)) {
        ink_shim_drop_pixmap(pix);
        return -5;
    }

    last_pixmap = pix;
    last_width = w;
    last_height = h;

    return @intCast((ptr << 32) | len);
}

export fn ink_render_width() i32 {
    return last_width;
}

export fn ink_render_height() i32 {
    return last_height;
}

// ---- export ----

fn inkArgsOk(page: i32, w: u32, h: u32, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) bool {
    if (page < 0 or w == 0 or h == 0) return false;
    if (w > std.math.maxInt(c_int) or h > std.math.maxInt(c_int)) return false;
    // The shim multiplies `w * h` inside `fz_try`, where overflow would be an
    // undersized allocation rather than an exception.
    _ = std.math.mul(u32, w, h) catch return false;
    for ([_]f32{ a, b, c, d, e, f }) |v| {
        // A NaN reaches the content stream as "nan" and breaks the page.
        if (!std.math.isFinite(v)) return false;
    }
    return true;
}

fn holdBuffer(slot: *?*Buffer, buf: *Buffer) i64 {
    const written = ink_shim_buffer_len(buf);
    const data = ink_shim_buffer_data(buf);
    if (written <= 0 or data == null) {
        ink_shim_drop_buffer(buf);
        return -3;
    }
    const len: u64 = @intCast(written);
    const ptr: u64 = @intFromPtr(data.?);
    if (ptr > std.math.maxInt(i32)) {
        ink_shim_drop_buffer(buf);
        return -3;
    }
    slot.* = buf;
    return @intCast((ptr << 32) | len);
}

/// Exports one page with `alpha` inked over it, grafted into a new document
/// (see `pdf_shim.c`; /Annots do not survive the graft).
export fn ink_export_page(
    handle: i32,
    page: i32,
    alpha: ?[*]const u8,
    w: u32,
    h: u32,
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    e: f32,
    f: f32,
) i64 {
    const doc = lookup(handle) orelse return -1;
    const bytes = alpha orelse return -1;
    if (!inkArgsOk(page, w, h, a, b, c, d, e, f)) return -1;

    ink_export_free();

    const buf = ink_shim_export_page(
        doc,
        page,
        bytes,
        @intCast(w),
        @intCast(h),
        a,
        b,
        c,
        d,
        e,
        f,
    ) orelse return -2;
    return holdBuffer(&last_export, buf);
}

/// Draws `alpha` onto `page` of the open document in place, for the
/// whole-document incremental export that keeps every page's /Annots. No undo:
/// annotating twice draws twice.
export fn ink_annotate_page(
    handle: i32,
    page: i32,
    alpha: ?[*]const u8,
    w: u32,
    h: u32,
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    e: f32,
    f: f32,
) i32 {
    const doc = lookup(handle) orelse return -1;
    const bytes = alpha orelse return -1;
    if (!inkArgsOk(page, w, h, a, b, c, d, e, f)) return -1;
    if (ink_shim_annotate_page(doc, page, bytes, @intCast(w), @intCast(h), a, b, c, d, e, f) < 0) {
        return -2;
    }
    return 0;
}

/// The incremental delta only; the browser concatenates `original || delta` as
/// disk-backed blobs. Reads the whole original via `host_read`.
export fn ink_export_incremental(handle: i32) i64 {
    const doc = lookup(handle) orelse return -1;
    ink_export_free();

    const buf = ink_shim_export_incremental(doc) orelse return -2;
    return holdBuffer(&last_export, buf);
}

export fn ink_export_free() void {
    if (last_export) |buf| {
        last_export = null;
        ink_shim_drop_buffer(buf);
    }
}

// ---- diagnostics ----

/// Why the last call failed; stable until the next failing call.
export fn ink_error_ptr() [*:0]const u8 {
    return ink_shim_error();
}

export fn ink_error_len() u32 {
    return @intCast(std.mem.len(ink_shim_error()));
}

fn dropLastRender() void {
    if (last_pixmap) |pix| {
        last_pixmap = null;
        last_width = 0;
        last_height = 0;
        ink_shim_drop_pixmap(pix);
    }
}
