//! WASI-reactor entry points for the browser PDF viewer: a thin Zig module over
//! MuPDF 1.28.1 (pinned in `build.zig.zon`, built by `zig build
//! wasm-pdf-decode`), rendering client side so the 50 MB server budget never
//! sees a rasteriser.
//!
//! Every MuPDF call lives in `pdf_shim.c`, because `fz_try`/`fz_catch` is
//! `setjmp`/`longjmp` and a `longjmp` past a Zig frame would skip its `defer`s.
//! This file owns the ABI, the handle table and nothing else.
//!
//! ## C-ABI (little-endian; pointers are byte offsets into exported `memory`)
//!
//! `webapp/wasm/tests/pdf_decode_abi.mjs` pins the shape of every export; what
//! follows is what that test cannot say.
//!
//! **Packed returns.** Every `i64` export answers `(ptr << 32) | len`. NEGATIVE
//! is the error channel, so the pointer must stay under 2 GiB for the packed
//! value to read as positive. The buffer is valid only until the next call of
//! the same kind, so JS copies it out.
//!
//! **Error codes.** `-1` bad arguments or a dead handle, `-2` the shim refused
//! (`ink_error_ptr` says why), `-3` the buffer cannot be described by the packed
//! return. `ink_open` adds `-2` MuPDF context unavailable, `-3` not a document
//! we can open, `-4` no free handle slot; `ink_render` uses `-3`/`-4` for a
//! pixmap that is not the tightly-packed RGBA the ABI promises and `-5` for a
//! size the packed return cannot carry.
//!
//! **Ownership.** `ink_open` takes its buffer on EVERY path, success or failure:
//! JS must not free it or read it afterwards. `ink_free` is only for a buffer
//! that never reached `ink_open`.
//!
//! **Coordinates.** Every rect and point in the JSON is in the space
//! `ink_page_size` reports: top-left origin, y down, points (1/72").
//!
//! **`[]` is a SUCCESS** — from `ink_page_links`, `ink_page_words` and
//! `ink_load_outline` alike. "Nothing here" and "we could not read this" are
//! different answers and the caller acts differently on them.
//!
//! Payloads: links are `{x,y,w,h,page,uri}`, where `page` is the resolved
//! 0-based target of an INTERNAL link and -1 for an external one, and a uri
//! whose scheme is not http/https/mailto is DROPPED, never described (see
//! `pdf_shim.c`). Words are `{t,x,y,w,h}`. The outline is a FLAT array in
//! document order (pre-order, depth first) of `{d,t,p}` — depth (0 at the top),
//! title, 0-BASED destination page; `p` IS OMITTED when the destination resolves
//! to no page, and the entry is still listed.
//!
//! Render pixels are straight (NOT premultiplied) RGBA8888, row-major, tightly
//! packed at `ink_render_width() * 4` bytes per row; read the dimensions AFTER
//! the `ink_render` that produced the buffer.
//!
//! **The two export routes.** `ink_export_page` grafts one page whole into a
//! fresh document — text stays selectable, vectors stay vectors, page size
//! unchanged. `ink_annotate_page` + `ink_export_incremental` handles the whole
//! document instead: annotate each written-on page IN PLACE, then write once.
//! That route MUTATES the open document — every later render of an annotated
//! page shows the ink, and a second annotate draws it twice — and returns **the
//! delta only**, the bytes that belong AFTER the original file, which the caller
//! concatenates (`new Blob([original, delta])`). Not a PDF on its own.
//!
//! Both take `alpha`, `w*h` coverage bytes with 255 = full ink, placed by the
//! matrix `a..f` mapping the alpha image's OWN PIXEL SPACE onto the page;
//! covering the page is `w_pt/w, 0, 0, h_pt/h, 0, 0`.
//!
//! ## The one IMPORT
//!
//!   i32 ink.host_read(i64 off, u8* dst, i32 len) — fill `dst` with `len` bytes
//!        from `off`; return the count written, or negative to fail the read.
//!        Declared in `pdf_shim.c`, and REQUIRED AT INSTANTIATION even by a
//!        caller that only uses `ink_open` — a declared import the embedder
//!        omits is a link error.
//!
//! ## Suspension
//!
//! Every document call can suspend, because the embedder may wrap `host_read`
//! in `WebAssembly.Suspending`: on the streamed path, loading a page, resolving
//! a destination or building structured text all pull through it. So every such
//! export must be in the JS side's JSPI promising list — a promising import
//! under a non-promising export is a trap, not a slow path. Nothing in Zig sits
//! on that stack; the shim owns the `fz_try`.
//!
//! ## Handles, not pointers
//!
//! `ink_open` returns a small integer into a fixed table, the same posture
//! `spd_decode.zig` takes: a handle JS held across a `ink_close` is a rejected
//! integer, where a raw `fz_document*` would be a wild pointer into a heap that
//! has since been reused.
//!
//! `memory` can grow on any `ink_alloc`/`ink_open`/`ink_render` call, so JS must
//! re-read every pointer AFTER the call that produced it.

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

// libc's allocator, not `std.heap.wasm_allocator`: the input buffer is handed
// straight to MuPDF (`fz_new_buffer_from_data`), which frees it through its own
// default allocator — and that is `free`. Two allocators over one buffer is how
// you get a heap corruption that only shows up on the third document opened.
extern fn malloc(len: usize) ?*anyopaque;
extern fn free(ptr: ?*anyopaque) void;

/// Eight is generous for a viewer that shows one document at a time and keeps
/// at most a couple around for a page cache; a FIXED array also means
/// `ink_open` cannot be turned into an unbounded allocator by a caller that
/// forgets to close.
const max_documents = 8;
var documents: [max_documents]?*Document = @splat(null);

/// One live buffer per kind, module-scoped rather than per-document: a viewer
/// paints and exports one page at a time, and one resident pixmap is the memory
/// ceiling we want. The four JSON/export slots are SEPARATE rather than one
/// shared slot because their lifetimes overlap — find asks for a page's words
/// while the outline panel is open and the reader follows that page's links,
/// and a shared slot would free one out from under another.
var last_pixmap: ?*Pixmap = null;
var last_width: i32 = 0;
var last_height: i32 = 0;
var last_export: ?*Buffer = null;
var last_links: ?*Buffer = null;
var last_words: ?*Buffer = null;
var last_outline: ?*Buffer = null;

// ---- Buffers ----

export fn ink_alloc(len: u32) ?*anyopaque {
    if (len == 0) return null;
    return malloc(len);
}

/// `len` is accepted for symmetry with the note/spd modules' ABI and is unused
/// (libc tracks the size).
export fn ink_free(ptr: ?*anyopaque, len: u32) void {
    _ = len;
    free(ptr);
}

// ---- Document ----

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

/// `total_len` is the document's byte length, which the caller already knows
/// (the file listing carries it), so nothing has to probe for it. Nothing is
/// consumed on failure here — there is no buffer to own.
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

/// Null for 0, negatives, out-of-range and already-closed handles alike — a
/// stale handle is an integer, never a pointer.
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

/// The links on `page`, as UTF-8 JSON. `pdf_shim.c` builds the payload and
/// states the two coordinate traps it exists to close and the scheme allowlist
/// it enforces.
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

/// The words on `page` and where they sit, as UTF-8 JSON.
///
/// THE MODULE IS A LOCATOR, NOT A MATCHER. No needle crosses this boundary: the
/// server decided which pages matched and named the folded terms it counted, and
/// the client compares those against these words with the SAME fold the `.note`
/// and `.txt` find controllers use. `pdf_shim.c` states why that split is load
/// bearing rather than tidy.
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

/// The document's OUTLINE — its table of contents — as UTF-8 JSON. The nesting
/// is carried by `d` rather than by shape; `pdf_shim.c` says why a tree would
/// cost both sides more to say the same thing.
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
    // Nothing is left holding the store's contents once the last document goes,
    // and a viewer that closed a 400 MB book should not keep its decoded images
    // resident for the rest of the tab's life.
    for (documents) |d| {
        if (d != null) return;
    }
    dropLastRender();
    ink_shim_shrink_store();
    // NOT `ink_export_free()`. An exported PDF is a finished artefact that owes
    // the document nothing, and the natural call order is export, close, then
    // hand the bytes to the UI — freeing here would pull the buffer out from
    // under that. It is bounded anyway: one buffer, replaced by the next export.
}

// ---- Rendering ----

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
    // MuPDF's `fz_new_pixmap_with_bbox` allocates exactly `w * n` per row, so
    // this holds — but it is a promise JS indexes on, so check rather than assume.
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
    // Checked, not assumed, so a heap over 2 GiB fails as `-5` rather than as a
    // packed value JS reads as an error code.
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

// ---- Export ----

/// Shared by the two export routes, which take exactly the same overlay and
/// place it exactly the same way.
fn inkArgsOk(page: i32, w: u32, h: u32, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) bool {
    if (page < 0 or w == 0 or h == 0) return false;
    if (w > std.math.maxInt(c_int) or h > std.math.maxInt(c_int)) return false;
    // `w * h` is the length of a buffer JS already allocated, so it fits — but
    // the shim would multiply it out inside an `fz_try`, and an overflow there
    // is a wildly undersized allocation followed by a read off the end of the
    // heap rather than an exception. Refuse it here instead.
    _ = std.math.mul(u32, w, h) catch return false;
    for ([_]f32{ a, b, c, d, e, f }) |v| {
        // A NaN or an infinity reaches the content stream as the literal "nan",
        // which makes the page unparseable to every reader — a silently broken
        // export, which is worse than a refused one.
        if (!std.math.isFinite(v)) return false;
    }
    return true;
}

/// Whatever `slot` held is the caller's to have released first.
fn holdBuffer(slot: *?*Buffer, buf: *Buffer) i64 {
    const written = ink_shim_buffer_len(buf);
    const data = ink_shim_buffer_data(buf);
    if (written <= 0 or data == null) {
        ink_shim_drop_buffer(buf);
        return -3;
    }
    const len: u64 = @intCast(written);
    const ptr: u64 = @intFromPtr(data.?);
    // Checked, not assumed: see `ink_render`.
    if (ptr > std.math.maxInt(i32)) {
        ink_shim_drop_buffer(buf);
        return -3;
    }
    slot.* = buf;
    return @intCast((ptr << 32) | len);
}

/// Export one page, structure intact, with `alpha` inked over it. `pdf_shim.c`
/// explains the PDF-level choices, including the one thing that does NOT
/// survive the graft (/Annots). Rotation, a /CropBox offset and an off-origin
/// /MediaBox are all handled on the far side.
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

/// Draw `alpha` onto `page` of the OPEN document, in place — the first half of
/// the whole-document export.
///
/// WHY THIS EXISTS BESIDE `ink_export_page`. Grafting every page would lose the
/// `/Annots` of every page — the links and highlights the original carried —
/// because `pdf_graft_page` does not copy them. So the whole-document route does
/// not graft at all: it annotates in place and writes an INCREMENTAL UPDATE,
/// which keeps the original's bytes untouched. `pdf_shim.c` states the three
/// things MuPDF will not guard on that path and which of them are refused here.
///
/// THERE IS NO UNDO: a second annotate of the same page draws the ink twice.
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

/// THE DELTA ONLY, not a PDF on its own. `original || delta` is, and building it
/// that way is the whole memory argument: the browser concatenates two blobs,
/// which are disk-backed, so a 76 MB document is exported without any of it
/// entering a JS heap or this one.
///
/// THIS ONE READS THE WHOLE ORIGINAL: MuPDF's incremental write begins by
/// copying the file it is appending to, which the shim sinks byte for byte. On
/// the streamed path that is `ink.host_read` over the entire document, which is
/// why the worker points it at a local copy for the duration.
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

// ---- Diagnostics ----

/// The ABI's negative codes say which call failed; this says why, which is the
/// difference between "this PDF will not open" and "this PDF is encrypted".
/// Stable until the next failing call.
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
