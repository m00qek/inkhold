//! WASI-reactor entry points for the browser PDF viewer.
//!
//! This is the `.spd` arrangement applied to PDF (`docs/scratch/pdf-viewer.md` §2):
//! a thin Zig module over a compiled-in C library — here MuPDF 1.28.1, pinned in
//! `build.zig.zon` and built by `zig build wasm-pdf-decode` — rendering client
//! side so the 50 MB server budget never sees a rasteriser.
//!
//! Every MuPDF call lives in `pdf_shim.c`, because `fz_try`/`fz_catch` is
//! `setjmp`/`longjmp` and a `longjmp` past a Zig frame would skip its `defer`s.
//! This file owns the ABI, the handle table and nothing else.
//!
//! ## C-ABI (little-endian; pointers are byte offsets into exported `memory`)
//!
//! Buffers:
//!   u8*  ink_alloc(u32 len)            — allocate; JS copies the whole file in.
//!                                        0 on OOM.
//!   void ink_free(u8* ptr, u32 len)    — free an `ink_alloc` buffer that was
//!                                        never handed to `ink_open`.
//!
//! Document:
//!   i32  ink_open(u8* ptr, u32 len)    — open the document at [ptr,ptr+len).
//!        Returns a HANDLE (>= 1), or negative on error: -1 bad arguments,
//!        -2 MuPDF context unavailable, -3 not a document we can open,
//!        -4 no free handle slot.
//!        OWNERSHIP: the module takes the buffer on EVERY path, success or
//!        failure. JS must not free it or read it afterwards.
//!   i32  ink_open_stream(i64 total_len) — open over the `ink.host_read` IMPORT
//!        instead of a buffer; `total_len` is the document's byte length. Same
//!        handle and error contract as `ink_open`. The whole-file entry point
//!        above stays, because the no-JSPI fallback still needs it.
//!   i32  ink_page_count(i32 doc)       — page count, or negative on error.
//!   i32  ink_page_size(i32 doc, i32 page, f32* w, f32* h) — page size in POINTS
//!        (1/72"). 0 on success, negative on error; `*w`/`*h` untouched on error.
//!   void ink_close(i32 doc)            — release the document. A stale or
//!        out-of-range handle is ignored, not dereferenced.
//!
//! Rendering:
//!   i64  ink_render(i32 doc, i32 page, f32 scale) — render at `scale` (1.0 =
//!        72 dpi). Returns `(ptr << 32) | len` packed, or negative on error.
//!        Pixels are straight (NOT premultiplied) RGBA8888, row-major, tightly
//!        packed at `ink_render_width() * 4` bytes per row.
//!   i32  ink_render_width() / ink_render_height() — the last render's pixel
//!        dimensions. Read them AFTER the `ink_render` that produced the buffer.
//!
//! Diagnostics:
//!   u8*  ink_error_ptr() / u32 ink_error_len() — UTF-8 bytes of the most recent
//!        MuPDF error message (length 0 if nothing has failed).
//!
//! ## The one IMPORT
//!
//!   i32 ink.host_read(i64 off, u8* dst, i32 len) — fill `dst` with `len` bytes
//!        from `off`; return the count written, or negative to fail the read.
//!        Declared in `pdf_shim.c`, and REQUIRED AT INSTANTIATION even by a
//!        caller that only uses `ink_open` — a declared import the embedder
//!        omits is a link error. `docs/scratch/pdf-ranges.md` §4.
//!
//! ## Handles, not pointers
//!
//! `ink_open` returns a small integer into a fixed table, the same posture
//! `spd_decode.zig` takes: a handle JS held across a `ink_close` is a rejected
//! integer, where a raw `fz_document*` would be a wild pointer into a heap that
//! has since been reused.
//!
//! ## Lifetime rules (same as `note_decode`/`spd_decode`)
//!
//! `memory` can grow on any `ink_alloc`/`ink_open`/`ink_render` call, so JS must
//! re-read every pointer AFTER the call that produced it. The render buffer is
//! owned by the module and is valid only until the next `ink_render` — copy it
//! (or `putImageData` it) before rendering another page.

const std = @import("std");

// ---- pdf_shim.c ----
const Document = opaque {};
const Pixmap = opaque {};

extern fn ink_shim_context() ?*anyopaque;
extern fn ink_shim_open(data: ?*anyopaque, len: u32) ?*Document;
extern fn ink_shim_open_stream(total: i64) ?*Document;
extern fn ink_shim_page_count(doc: *Document) c_int;
extern fn ink_shim_page_size(doc: *Document, number: c_int, w: *f32, h: *f32) c_int;
extern fn ink_shim_render(doc: *Document, number: c_int, scale: f32) ?*Pixmap;
extern fn ink_shim_pixmap_samples(pix: *Pixmap) [*]u8;
extern fn ink_shim_pixmap_width(pix: *Pixmap) c_int;
extern fn ink_shim_pixmap_height(pix: *Pixmap) c_int;
extern fn ink_shim_pixmap_components(pix: *Pixmap) c_int;
extern fn ink_shim_pixmap_stride(pix: *Pixmap) c_int;
extern fn ink_shim_drop_pixmap(pix: *Pixmap) void;
extern fn ink_shim_drop_document(doc: *Document) void;
extern fn ink_shim_shrink_store() void;
extern fn ink_shim_error() [*:0]const u8;

// libc's allocator, not `std.heap.wasm_allocator`: the input buffer is handed
// straight to MuPDF (`fz_new_buffer_from_data`), which frees it through its own
// default allocator — and that is `free`. Two allocators over one buffer is how
// you get a heap corruption that only shows up on the third document opened.
extern fn malloc(len: usize) ?*anyopaque;
extern fn free(ptr: ?*anyopaque) void;

/// Fixed handle table. Eight is generous for a viewer that shows one document
/// at a time and keeps at most a couple around for a page cache; a fixed array
/// also means `ink_open` cannot be turned into an unbounded allocator by a
/// caller that forgets to close.
const max_documents = 8;
var documents: [max_documents]?*Document = @splat(null);

/// The last render. Module-scoped rather than per-document on purpose: a viewer
/// paints one page at a time, and one live pixmap is the memory ceiling we want.
var last_pixmap: ?*Pixmap = null;
var last_width: i32 = 0;
var last_height: i32 = 0;

// ---- Buffers ----

/// Allocate `len` bytes in wasm memory; 0 on OOM.
export fn ink_alloc(len: u32) ?*anyopaque {
    if (len == 0) return null;
    return malloc(len);
}

/// Free an `ink_alloc` buffer. Only for buffers NOT passed to `ink_open` —
/// `ink_open` consumes the buffer on every path. `len` is accepted for symmetry
/// with the note/spd modules' ABI and is unused (libc tracks the size).
export fn ink_free(ptr: ?*anyopaque, len: u32) void {
    _ = len;
    free(ptr);
}

// ---- Document ----

/// Open the document at [ptr, ptr+len). See the header for the error contract.
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

/// Open the document over the `ink.host_read` CALLBACK rather than a buffer.
/// `total_len` is the document's byte length, which the caller already knows
/// (the file listing carries it), so nothing has to probe for it.
///
/// Same handle contract and same error codes as `ink_open`, minus -1's "bad
/// buffer": there is no buffer to own, so nothing is consumed on failure.
///
/// EVERY CALL REACHABLE FROM HERE CAN SUSPEND, because `ink_host_read` is an
/// import the embedder may wrap in `WebAssembly.Suspending`. Nothing in Zig sits
/// on that stack — the shim owns the `fz_try` and this function is a plain
/// forward — which is the same rule that keeps `longjmp` away from Zig frames.
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

/// Resolve a handle to a live document. Null for 0, negatives, out-of-range and
/// already-closed handles alike — a stale handle is an integer, never a pointer.
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

/// Release a document. Idempotent, and safe for any integer.
export fn ink_close(handle: i32) void {
    if (handle < 1 or handle > max_documents) return;
    const slot: usize = @intCast(handle - 1);
    const doc = documents[slot] orelse return;
    documents[slot] = null;
    ink_shim_drop_document(doc);
    // Nothing is left holding the store's contents once the last document goes,
    // and a viewer that closed a 400 MB book should not keep its decoded images
    // resident for the rest of the tab's life.
    for (documents) |d| {
        if (d != null) return;
    }
    dropLastRender();
    ink_shim_shrink_store();
}

// ---- Rendering ----

/// Render `page` at `scale`. Returns `(ptr << 32) | len`, or negative on error.
export fn ink_render(handle: i32, page: i32, scale: f32) i64 {
    const doc = lookup(handle) orelse return -1;
    if (page < 0 or !(scale > 0) or !std.math.isFinite(scale)) return -1;

    // Drop the previous render FIRST: at browser zoom levels a single page is
    // tens of megabytes, and holding two while the new one rasterises is the
    // difference between a re-render and an out-of-memory tab.
    dropLastRender();

    const pix = ink_shim_render(doc, page, scale) orelse return -2;
    if (ink_shim_pixmap_components(pix) != 4) {
        // The shim always asks for RGBA; a different component count means the
        // build changed under us. Refuse rather than hand JS a mislabelled buffer.
        ink_shim_drop_pixmap(pix);
        return -3;
    }
    const w = ink_shim_pixmap_width(pix);
    const h = ink_shim_pixmap_height(pix);
    if (w <= 0 or h <= 0) {
        ink_shim_drop_pixmap(pix);
        return -4;
    }
    // The ABI says rows are tightly packed. MuPDF's own `fz_new_pixmap_with_bbox`
    // allocates exactly `w * n` per row, so this holds — but it is a promise JS
    // indexes on, so it is checked rather than assumed.
    if (ink_shim_pixmap_stride(pix) != w * 4) {
        ink_shim_drop_pixmap(pix);
        return -4;
    }
    // A page can be scaled past what a u32 byte count can address; catch it here
    // rather than truncating the length JS reads.
    const pixels = std.math.mul(u64, @intCast(w), @intCast(h)) catch {
        ink_shim_drop_pixmap(pix);
        return -5;
    };
    const len = std.math.mul(u64, pixels, 4) catch {
        ink_shim_drop_pixmap(pix);
        return -5;
    };
    const ptr: u64 = @intFromPtr(ink_shim_pixmap_samples(pix));
    // The packed return has to stay POSITIVE, because negative is the error
    // channel. That holds as long as the pointer fits in 31 bits — true for any
    // wasm heap under 2 GiB, which is every heap this module can reach. Checked
    // rather than assumed, so the failure is `-5` and not a length JS reads as
    // an error code.
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

// ---- Diagnostics ----

/// UTF-8 bytes of the most recent MuPDF error, and their length. The ABI's
/// negative codes say which call failed; this says why, which is the difference
/// between "this PDF will not open" and "this PDF is encrypted". Stable until
/// the next failing call; the length is 0 when nothing has failed.
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
