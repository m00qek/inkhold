//! WASI-reactor entry points for the browser PDF viewer.
//!
//! This is the `.spd` arrangement applied to PDF:
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
//!   i64  ink_page_links(i32 doc, i32 page) — the page's links as UTF-8 JSON.
//!        Returns `(ptr << 32) | len`, or negative on error. The payload is an
//!        array of `{x,y,w,h,page,uri}`: the rect in the SAME space
//!        `ink_page_size` reports (top-left origin, y down, points), `page` the
//!        resolved 0-based target of an INTERNAL link or -1 for an external one,
//!        and `uri` what MuPDF read. A uri whose scheme is not http/https/mailto
//!        is DROPPED, never described — see `pdf_shim.c`. An empty page answers
//!        `[]`. Valid until the next `ink_page_links` or `ink_links_free`.
//!   void ink_links_free()              — release that buffer. Idempotent.
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
//! Export:
//!   i64  ink_export_page(i32 doc, i32 page, u8* alpha, u32 w, u32 h,
//!                        f32 a, f32 b, f32 c, f32 d, f32 e, f32 f)
//!        — a ONE-PAGE PDF holding `page` grafted whole (its text stays
//!        selectable, its fonts and vectors stay vectors, its page size is
//!        unchanged) with `alpha` drawn over it as ink. `alpha` is `w*h`
//!        coverage bytes, 255 = full ink, 0 = transparent. `a..f` map the alpha
//!        image's OWN PIXEL SPACE — (0,0) top-left, y downwards — onto the page
//!        in DISPLAY space, the same top-left-origin cropped-and-rotated box
//!        `ink_page_size` reports; covering the page is `w_pt/w, 0, 0, h_pt/h,
//!        0, 0`. Returns `(ptr << 32) | len` of the produced PDF, or negative.
//!   i32  ink_annotate_page(i32 doc, i32 page, u8* alpha, u32 w, u32 h,
//!                          f32 a, f32 b, f32 c, f32 d, f32 e, f32 f)
//!        — draw the same ink onto the OPEN document's page, IN PLACE. Writes
//!        nothing. Call once per annotated page (the set is sparse — 7 of 77 in
//!        the real corpus), then `ink_export_incremental` once. 0 on success,
//!        negative on error. THE DOCUMENT IS MUTATED: every later render of
//!        that page shows the ink, so a caller that keeps reading must reopen.
//!   i64  ink_export_incremental(i32 doc) — the whole document, as an
//!        INCREMENTAL UPDATE. Returns `(ptr << 32) | len` of **the delta only**
//!        — the bytes that belong AFTER the original file, which the caller
//!        concatenates (`new Blob([original, delta])`). Not a PDF on its own.
//!        Negative on error, including the refusals the shim makes for a
//!        repaired file, one with junk before `%PDF-`, and one with no backing
//!        file; `ink_error_ptr` carries the sentence.
//!   void ink_export_free()             — release either export's buffer.
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
//!        omits is a link error.
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
const Buffer = opaque {};

extern fn ink_shim_context() ?*anyopaque;
extern fn ink_shim_open(data: ?*anyopaque, len: u32) ?*Document;
extern fn ink_shim_open_stream(total: i64) ?*Document;
extern fn ink_shim_page_count(doc: *Document) c_int;
extern fn ink_shim_page_size(doc: *Document, number: c_int, w: *f32, h: *f32) c_int;
extern fn ink_shim_page_links(doc: *Document, number: c_int) ?*Buffer;
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

/// The last export, held for exactly as long as it takes JS to copy the bytes
/// out. Same one-at-a-time posture as `last_pixmap`, for the same reason: an
/// exported page is megabytes and nobody needs two.
var last_export: ?*Buffer = null;

/// The last page's links, as JSON. Its own slot rather than sharing
/// `last_export`: the two have unrelated lifetimes — a viewer reads the links of
/// the page it is looking at while an export of that page is still being built —
/// and a shared slot would free one out from under the other. It is hundreds of
/// bytes, so one at a time costs nothing.
var last_links: ?*Buffer = null;

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

/// The links on `page`, as UTF-8 JSON: `(ptr << 32) | len`, or negative.
///
/// -1 a dead handle or a negative page, -2 the shim refused (`ink_error_ptr`
/// says why — a page that will not load is the realistic one), -3 the produced
/// buffer cannot be described by the packed return.
///
/// The payload is documented at the top of this file and built in `pdf_shim.c`,
/// which also states the two coordinate traps it exists to close and the scheme
/// allowlist it enforces. An empty page answers `[]`, which is a SUCCESS: "this
/// page has no links" and "we could not read this page" are different answers
/// and the caller acts differently on them.
///
/// COPY THE BYTES OUT: they are valid only until the next `ink_page_links`.
///
/// LIKE EVERY OTHER DOCUMENT CALL, THIS CAN SUSPEND — loading the page and
/// resolving an internal destination both walk the xref, which on the streamed
/// path pulls through `ink.host_read`.
export fn ink_page_links(handle: i32, page: i32) i64 {
    const doc = lookup(handle) orelse return -1;
    if (page < 0) return -1;

    // Drop the previous answer FIRST, so one page's links are resident at a
    // time — the same posture `ink_render` and `ink_export_page` take, for a
    // far smaller buffer.
    ink_links_free();

    const buf = ink_shim_page_links(doc, page) orelse return -2;
    return holdBuffer(&last_links, buf);
}

/// Release the buffer `ink_page_links` returned. Idempotent, and safe to call
/// without ever having asked for links.
export fn ink_links_free() void {
    if (last_links) |buf| {
        last_links = null;
        ink_shim_drop_buffer(buf);
    }
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
    // NOT `ink_export_free()`. An exported PDF is a finished artefact that owes
    // the document nothing, and the natural call order is export, close, then
    // hand the bytes to the UI — freeing here would pull the buffer out from
    // under that. It is bounded anyway: one buffer, replaced by the next export.
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

// ---- Export ----

/// Are the ink arguments safe to hand to the shim? Shared by the two routes,
/// which take exactly the same overlay and place it exactly the same way.
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

/// Take ownership of a produced buffer, park it in `slot`, and pack it for JS:
/// `(ptr << 32) | len`, or -3 if it cannot be described that way. Whatever `slot`
/// held is the caller's to have released first.
fn holdBuffer(slot: *?*Buffer, buf: *Buffer) i64 {
    const written = ink_shim_buffer_len(buf);
    const data = ink_shim_buffer_data(buf);
    if (written <= 0 or data == null) {
        ink_shim_drop_buffer(buf);
        return -3;
    }
    const len: u64 = @intCast(written);
    const ptr: u64 = @intFromPtr(data.?);
    // The packed return has to stay POSITIVE — negative is the error channel —
    // which holds for any wasm heap under 2 GiB. Checked, not assumed.
    if (ptr > std.math.maxInt(i32)) {
        ink_shim_drop_buffer(buf);
        return -3;
    }
    slot.* = buf;
    return @intCast((ptr << 32) | len);
}

/// Export one page, structure intact, with `alpha` inked over it.
///
/// WHAT THIS IS FOR. The rasterising exporter turns a page into a picture of a
/// page: text stops being selectable, vectors stop being vectors, the geometry
/// becomes A4. This one grafts the ORIGINAL page into a fresh one-page document
/// and draws the ink on top, so all of that survives. `pdf_shim.c` explains the
/// PDF-level choices, including the one thing that does NOT survive (/Annots).
///
/// `alpha` is `w*h` coverage bytes in wasm memory, 255 = full ink. `a`..`f` are
/// a DISPLAY-space matrix (top-left origin, y down, points) applied to the alpha
/// image's own pixel space — so the page-covering case is `w_pt/w, 0, 0, h_pt/h,
/// 0, 0`, and rotation, a /CropBox offset and an off-origin /MediaBox are all
/// handled on the far side.
///
/// Returns `(ptr << 32) | len` of the produced PDF — valid until the next
/// `ink_export_page` or `ink_export_free`, so COPY IT OUT — or negative:
/// -1 bad arguments or a dead handle, -2 the export failed (`ink_error_ptr` says
/// why; not a PDF, or MuPDF refused the page), -3 the produced buffer cannot be
/// described by the packed return.
///
/// LIKE `ink_open_stream`, EVERY CALL HERE CAN SUSPEND: grafting reads the
/// source document, which on the streamed path pulls through `ink.host_read`.
/// Nothing in Zig sits on that stack — the shim owns the `fz_try`.
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

    // Drop the previous export FIRST, for the same reason `ink_render` does:
    // holding two page-sized buffers while the second is built is the difference
    // between an export and an out-of-memory tab.
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
/// WHY THIS EXISTS BESIDE `ink_export_page`. Grafting every page of a document
/// into a fresh one would lose the `/Annots` of every page — the links and
/// highlights the original carried — because `pdf_graft_page` does not copy
/// them. So the whole-document route does not graft at all: it annotates the
/// pages the user wrote on IN THE OPEN DOCUMENT and then writes an INCREMENTAL
/// UPDATE, which keeps the original's bytes untouched and appends only what
/// changed. `pdf_shim.c` states the three things MuPDF will not guard on that
/// path and which of them are refused here.
///
/// THE DOCUMENT IS MUTATED AND STAYS MUTATED. There is no undo: every render of
/// `page` after this shows the ink burnt in, and a second annotate of the same
/// page draws it twice. A caller that goes on displaying the document must close
/// and reopen it once the export is done.
///
/// `alpha`, `w`, `h` and `a`..`f` are exactly `ink_export_page`'s. 0 on success;
/// -1 on bad arguments or a dead handle; -2 when the shim refuses (not a PDF, a
/// page that will not load, or a document that cannot take an incremental
/// update at all) — `ink_error_ptr` says which.
///
/// LIKE `ink_export_page`, THIS CAN SUSPEND: loading the page walks the source
/// document's xref, which on the streamed path pulls through `ink.host_read`.
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

/// Write everything `ink_annotate_page` changed as an incremental update, and
/// return THE DELTA ONLY — the bytes that belong after the original file.
///
/// The result is NOT a PDF on its own. `original || delta` is, and building it
/// that way is the whole memory argument: the browser concatenates two blobs,
/// which are disk-backed, so a 76 MB document is exported without any of it
/// entering a JS heap or this one.
///
/// Returns `(ptr << 32) | len` — valid until the next export or
/// `ink_export_free`, so COPY IT OUT — or negative: -1 a dead handle, -2 the
/// write was refused or failed (`ink_error_ptr` says why: a repaired file, junk
/// before the header, no backing file, nothing annotated, or a MuPDF error),
/// -3 the produced buffer cannot be described by the packed return.
///
/// CAN SUSPEND, and this one reads the whole original: MuPDF's incremental write
/// begins by copying the file it is appending to, which the shim sinks byte for
/// byte. On the streamed path that is `ink.host_read` over the entire document,
/// which is why the worker points it at a local copy for the duration.
export fn ink_export_incremental(handle: i32) i64 {
    const doc = lookup(handle) orelse return -1;

    // Drop the previous export FIRST, for the same reason `ink_export_page`
    // does: two document-sized buffers at once is the difference between an
    // export and an out-of-memory tab.
    ink_export_free();

    const buf = ink_shim_export_incremental(doc) orelse return -2;
    return holdBuffer(&last_export, buf);
}

/// Release the buffer an export returned. Idempotent, and safe to call
/// without ever having exported.
export fn ink_export_free() void {
    if (last_export) |buf| {
        last_export = null;
        ink_shim_drop_buffer(buf);
    }
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
