//! THROWAWAY MEASUREMENT HARNESS — not product code, not shipped, not tested.
//!
//! Built by `zig build wasm-fts-bench`. Its only purpose is to produce the
//! numbers in `docs/scratch/wasm-search-bench.md`: the client-side-search plan
//! asserts that FTS5-in-wasm makes global search "instant" and measures every
//! SIZE while measuring no RUNTIME at all. This module is the instrument.
//!
//! **Delete this file (and its build step) once that document is written and
//! the plan is accepted or rejected.** If client-side search is actually built,
//! the real module is `spd-decode` renamed and extended (plan §5, "one module,
//! not two") with a narrow, reviewed ABI — not this.
//!
//! It deliberately compiles `spd_decode.zig` in alongside itself, so the
//! artifact is the FUSED module the plan proposes (the `.spd` decoder + FTS5)
//! rather than a synthetic FTS5-only blob. That makes the compile/instantiate
//! timing transferable to the thing that would actually ship.
//!
//! ## Why the ABI takes raw SQL
//!
//! A measurement harness wants to vary the query without a rebuild, and the
//! numbers must not include JS<->wasm marshalling of results — so `fb_query`
//! steps the statement to completion inside wasm and returns only a row count.
//! A product ABI would never expose `fb_exec`; this one is loaded from a local
//! benchmark page with a corpus this same page generated.
//!
//! ## ABI (pointers are byte offsets into exported `memory`)
//!
//!   u8*   fb_alloc(usize len) / void fb_free(u8*, usize)
//!   i32   fb_open()            — sqlite3_open(":memory:") + the FTS5 table
//!   void  fb_close()
//!   i32   fb_exec(u8* sql, usize len)              — rc, 0 = SQLITE_OK
//!   i32   fb_build(u8* corpus, usize len)          — insert '\n'-separated docs
//!   i32   fb_query(u8* sql, usize len)             — rows stepped, or -rc
//!   i32   fb_serialize()                           — image len, or -rc
//!   u8*   fb_image_ptr()
//!   i32   fb_deserialize(u8* img, usize len)       — rc (SQLite takes ownership)
//!   u32   fb_heap_pages()                          — 64 KiB wasm pages
//!   u8*   fb_errmsg_ptr() / u32 fb_errmsg_len()

const std = @import("std");
const builtin = @import("builtin");
const spd = @import("spd");
const c = spd.sqlite.c;

// Pull the real `.spd` decoder's exports into this artifact so the measured
// module is the fused one the plan proposes, at the size the plan quotes.
comptime {
    _ = @import("spd_decode.zig");
}

const gpa = if (builtin.target.cpu.arch.isWasm())
    std.heap.wasm_allocator
else
    std.heap.page_allocator;

var db: ?*c.sqlite3 = null;
/// Owned by SQLite after a successful `fb_serialize`; freed with `sqlite3_free`.
var image: ?[*]u8 = null;
var image_len: usize = 0;
var errbuf: std.ArrayList(u8) = .empty;

export fn fb_alloc(len: usize) ?[*]u8 {
    const buf = gpa.alloc(u8, len) catch return null;
    return buf.ptr;
}

export fn fb_free(ptr: [*]u8, len: usize) void {
    gpa.free(ptr[0..len]);
}

fn setErr(msg: []const u8) void {
    errbuf.clearRetainingCapacity();
    errbuf.appendSlice(gpa, msg) catch {};
}

fn setErrDb() void {
    if (db) |h| setErr(std.mem.span(c.sqlite3_errmsg(h))) else setErr("no db");
}

export fn fb_errmsg_ptr() ?[*]const u8 {
    return errbuf.items.ptr;
}
export fn fb_errmsg_len() u32 {
    return @intCast(errbuf.items.len);
}

/// 64 KiB pages currently committed to the wasm linear memory. This is the
/// number that matters for "does the heap balloon on a phone" — it never
/// shrinks, so read it as a high-water mark.
export fn fb_heap_pages() u32 {
    if (!builtin.target.cpu.arch.isWasm()) return 0;
    return @intCast(@wasmMemorySize(0));
}

/// Open a fresh in-memory database. The FTS5 table is NOT created here — the
/// build measurement wants `CREATE VIRTUAL TABLE` inside its own timing window,
/// so the page issues it through `fb_exec`.
export fn fb_open() i32 {
    fb_close();
    // SQLITE_OMIT_AUTOINIT is set for this build (inherited from the `.spd`
    // flag set), so initialise explicitly — this is what registers the null VFS.
    var rc = c.sqlite3_initialize();
    if (rc != c.SQLITE_OK) return rc;
    var h: ?*c.sqlite3 = null;
    rc = c.sqlite3_open(":memory:", &h);
    if (rc != c.SQLITE_OK) {
        if (h) |x| _ = c.sqlite3_close(x);
        return rc;
    }
    db = h;
    return 0;
}

export fn fb_close() void {
    if (image) |p| {
        c.sqlite3_free(p);
        image = null;
        image_len = 0;
    }
    if (db) |h| {
        _ = c.sqlite3_close(h);
        db = null;
    }
}

export fn fb_exec(ptr: [*]const u8, len: usize) i32 {
    const h = db orelse return -1;
    const sql = gpa.dupeZ(u8, ptr[0..len]) catch return -2;
    defer gpa.free(sql);
    const rc = c.sqlite3_exec(h, sql.ptr, null, null, null);
    if (rc != c.SQLITE_OK) setErrDb();
    return rc;
}

/// Insert the corpus: one row per '\n'-separated line, each line a document's
/// space-separated folded terms. The whole loop runs inside wasm, wrapped in
/// one transaction and one prepared statement — the shape a real client would
/// use, and the shape that keeps JS<->wasm call overhead out of the number.
/// Returns rows inserted, or a negative SQLite rc.
export fn fb_build(ptr: [*]const u8, len: usize) i32 {
    const h = db orelse return -1;

    var rc = c.sqlite3_exec(h, "BEGIN", null, null, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }

    var stmt: ?*c.sqlite3_stmt = null;
    rc = c.sqlite3_prepare_v2(h, "INSERT INTO docs(body) VALUES(?1)", -1, &stmt, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    defer _ = c.sqlite3_finalize(stmt);

    var rows: i32 = 0;
    var it = std.mem.splitScalar(u8, ptr[0..len], '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        _ = c.sqlite3_reset(stmt);
        // SQLITE_STATIC: the corpus buffer outlives the step, so no copy.
        rc = c.sqlite3_bind_text(stmt, 1, line.ptr, @intCast(line.len), null);
        if (rc != c.SQLITE_OK) {
            setErrDb();
            return -rc;
        }
        rc = c.sqlite3_step(stmt);
        if (rc != c.SQLITE_DONE) {
            setErrDb();
            return -rc;
        }
        rows += 1;
    }

    rc = c.sqlite3_exec(h, "COMMIT", null, null, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    return rows;
}

/// Run `sql` to completion and return how many rows it produced. Results are
/// materialised but never crossed back into JS: the question is engine latency,
/// and a real caller would only ever pull ten rows plus snippets.
export fn fb_query(ptr: [*]const u8, len: usize) i32 {
    const h = db orelse return -1;
    var stmt: ?*c.sqlite3_stmt = null;
    var rc = c.sqlite3_prepare_v2(h, ptr, @intCast(len), &stmt, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    defer _ = c.sqlite3_finalize(stmt);

    var rows: i32 = 0;
    while (true) {
        rc = c.sqlite3_step(stmt);
        if (rc == c.SQLITE_ROW) {
            // Touch column 0 so the engine cannot elide the work we are timing.
            _ = c.sqlite3_column_int64(stmt, 0);
            rows += 1;
            continue;
        }
        if (rc == c.SQLITE_DONE) break;
        setErrDb();
        return -rc;
    }
    return rows;
}

/// Serialize the main database. Returns the image length; the bytes live at
/// `fb_image_ptr()` until the next serialize/close.
export fn fb_serialize() i32 {
    const h = db orelse return -1;
    if (image) |p| {
        c.sqlite3_free(p);
        image = null;
        image_len = 0;
    }
    var n: c.sqlite3_int64 = 0;
    const p = c.sqlite3_serialize(h, "main", &n, 0) orelse {
        setErr("serialize returned null");
        return -1;
    };
    image = p;
    image_len = @intCast(n);
    return @intCast(n);
}

export fn fb_image_ptr() ?[*]const u8 {
    return image;
}

/// Allocate a deserialize target through **sqlite3_malloc**, not the Zig
/// allocator. `SQLITE_DESERIALIZE_FREEONCLOSE`/`RESIZEABLE` make SQLite free and
/// realloc the buffer itself, so it must have come from SQLite's own heap —
/// handing it an `fb_alloc` pointer would be a cross-allocator free.
export fn fb_image_alloc(len: usize) ?[*]u8 {
    // OMIT_AUTOINIT again: on a FRESH instance nothing has initialised SQLite
    // yet, so its memory subsystem's method vtable is still null and
    // sqlite3_malloc64 traps ("null function or function signature mismatch").
    if (c.sqlite3_initialize() != c.SQLITE_OK) return null;
    return @ptrCast(c.sqlite3_malloc64(@intCast(len)));
}

/// Deserialize `len` bytes at `ptr` into a fresh in-memory database, the way
/// the second visit would restore from IndexedDB. `ptr` must come from
/// `fb_image_alloc`; SQLite takes ownership and the caller must not free it.
export fn fb_deserialize(ptr: [*]u8, len: usize) i32 {
    fb_close();
    var rc = c.sqlite3_initialize();
    if (rc != c.SQLITE_OK) return rc;
    var h: ?*c.sqlite3 = null;
    rc = c.sqlite3_open(":memory:", &h);
    if (rc != c.SQLITE_OK) {
        if (h) |x| _ = c.sqlite3_close(x);
        return rc;
    }
    db = h;
    rc = c.sqlite3_deserialize(
        h,
        "main",
        ptr,
        @intCast(len),
        @intCast(len),
        c.SQLITE_DESERIALIZE_FREEONCLOSE | c.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    if (rc != c.SQLITE_OK) setErrDb();
    return rc;
}
