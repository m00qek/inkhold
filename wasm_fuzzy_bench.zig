//! THROWAWAY MEASUREMENT HARNESS — not product code, not shipped, not tested.
//!
//! Sibling of `webapp/wasm/fts_bench.zig`, built by `zig build wasm-fuzzy-bench`.
//! IT LIVES AT THE REPO ROOT AND THAT IS NOT AN ACCIDENT: a Zig module may not
//! `@import` a file outside its own root directory, and this harness has to
//! reach `backend/` and `webapp/` at once. That constraint is itself part of
//! the finding — see the report. Its only
//! purpose is to produce the numbers in `docs/scratch/wasm-fuzzy-bench.md`, and
//! to answer one question a COMPILER must answer rather than a reader:
//!
//! **Does `backend/services/search/fuzzy.zig` compile to wasm32 UNCHANGED?**
//! `client-side-search-impl.md` §9.3 asserts it does, from its import list. This
//! file is the test: it imports the SHIPPING `fuzzy.zig` by relative path, with
//! no shim and no fork, and drives `buildFuzzyMatch` over the ABI.
//!
//! **Delete this file and its build step once that document is written.**
//!
//! ## The import that §9.3 gets wrong, and it is not `fuzzy.zig`'s fault
//!
//! `fuzzy.zig` imports `../../db/sqlite.zig` — the BACKEND's wrapper, which is
//! where `Db`, `Stmt`, `prepare`, `exec` and `columnText` live. The wasm module
//! the plan already builds carries `parsers/spd/src/sqlite.zig`, a 34-line file
//! exposing only the `@cImport` and none of that API. They are different files
//! that share a name, so "`sqlite.zig` exists in the wasm module" does not make
//! `fuzzy.zig` link. This harness therefore compiles the BACKEND wrapper into
//! the wasm artifact, which is what a port would actually have to do — and that
//! is the honest form of the claim. See §2 of the report for what came with it.
//!
//! ## ABI (pointers are byte offsets into exported `memory`)
//!
//!   u8*  fz_alloc(usize) / void fz_free(u8*, usize)
//!   i32  fz_open()                                 — :memory: + segment_fts
//!   void fz_close()
//!   i32  fz_build(u8* corpus, usize len)           — '\n'-separated documents
//!   i32  fz_vocab()                                — distinct terms, or -1
//!   i32  fz_fuzzy(u8* q, usize, i32 prefix, i32 reps)
//!                                                  — the ladder, `reps` times;
//!                                                    alts of the last run, or -1
//!   u32  fz_match_len() / u8* fz_match_ptr()       — the expression it built
//!   u32  fz_heap_pages()                           — 64 KiB wasm pages

const std = @import("std");
const builtin = @import("builtin");
const spd = @import("spd");

/// THE SUBJECT OF THE EXPERIMENT — the shipping file, by path, unmodified. This
/// line either compiles for wasm32 or it does not, and that is the finding.
const fuzzy = @import("backend/services/search/fuzzy.zig");
/// The wrapper it imports, which has to come with it. Same relative-path form,
/// so both land in this root module and `fuzzy`'s own `@import` resolves to the
/// SAME file rather than a second copy.
const sqlite = @import("backend/db/sqlite.zig");

comptime {
    _ = @import("webapp/wasm/spd_decode.zig");
}

const gpa = if (builtin.target.cpu.arch.isWasm())
    std.heap.wasm_allocator
else
    std.heap.page_allocator;

var db: ?sqlite.Db = null;
/// The last run's arena, kept alive so `fz_match_ptr` still points at something.
var kept: ?std.heap.ArenaAllocator = null;
var last_match: []const u8 = &.{};

export fn fz_alloc(len: usize) ?[*]u8 {
    const buf = gpa.alloc(u8, len) catch return null;
    return buf.ptr;
}

export fn fz_free(ptr: [*]u8, len: usize) void {
    gpa.free(ptr[0..len]);
}

export fn fz_heap_pages() u32 {
    if (!builtin.target.cpu.arch.isWasm()) return 0;
    return @intCast(@wasmMemorySize(0));
}

/// The index the ladder scans, declared with the SAME tokenizer constant
/// `schema.zig`'s `segment_fts` uses — taken from `fuzzy.zig` itself, so the
/// harness cannot fold differently from the code under test.
const schema_sql =
    "CREATE VIRTUAL TABLE segment_fts USING fts5(txt, tokenize='" ++
    fuzzy.fts_tokenizer ++ "');";

export fn fz_open() i32 {
    fz_close();
    // SQLITE_OMIT_AUTOINIT is set for this build (inherited from the `.spd` flag
    // set) and `sqlite.Db.open` does NOT initialise — it never had to, because
    // the backend build has autoinit. Without this the null VFS is unregistered
    // and the open fails. PORT FINDING, recorded in the report.
    if (spd.sqlite.c.sqlite3_initialize() != 0) return -1;
    const h = sqlite.Db.open(":memory:") catch return -2;
    db = h;
    h.exec(schema_sql) catch return -3;
    return 0;
}

export fn fz_close() void {
    if (kept) |*a| {
        a.deinit();
        kept = null;
    }
    last_match = &.{};
    if (db) |h| {
        h.close();
        db = null;
    }
}

export fn fz_build(ptr: [*]const u8, len: usize) i32 {
    const h = db orelse return -1;
    h.exec("BEGIN;") catch return -2;
    var s = h.prepare("INSERT INTO segment_fts(txt) VALUES(?1);") catch return -3;
    defer s.finalize();
    var rows: i32 = 0;
    var it = std.mem.splitScalar(u8, ptr[0..len], '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        s.reset();
        s.bindText(1, line);
        _ = s.step() catch return -4;
        rows += 1;
    }
    h.exec("COMMIT;") catch return -5;
    // One segment, as the server's index is after a merge — so a rung is not
    // accidentally measuring FTS5's incidental merge state.
    h.exec("INSERT INTO segment_fts(segment_fts) VALUES('optimize');") catch return -6;
    return rows;
}

export fn fz_vocab() i32 {
    const h = db orelse return -1;
    h.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.v USING fts5vocab('main','segment_fts','row');") catch return -2;
    var s = h.prepare("SELECT COUNT(*) FROM temp.v;") catch return -3;
    defer s.finalize();
    if (!(s.step() catch return -4)) return -5;
    return @intCast(s.columnInt(0));
}

/// THE MEASURED CALL. `reps` iterations inside one JS timing window, because
/// `performance.now()` is coarsened to 100 us on a page that is not
/// cross-origin-isolated (`wasm-search-bench.md` §1) — a single ladder run at
/// tier-1 scale sits inside the quantisation.
///
/// Each rep gets a FRESH ARENA, exactly as `searchPages` hands the fallback a
/// per-request arena. Reusing one would measure a warm allocator the server
/// never has.
export fn fz_fuzzy(ptr: [*]const u8, len: usize, prefix: i32, reps: i32) i32 {
    const h = db orelse return -1;
    if (kept) |*a| {
        a.deinit();
        kept = null;
    }
    last_match = &.{};

    var alts: i32 = -1;
    var n: i32 = 0;
    while (n < reps) : (n += 1) {
        var arena = std.heap.ArenaAllocator.init(gpa);
        const last = n == reps - 1;
        const e = fuzzy.buildFuzzyMatch(
            arena.allocator(),
            h,
            ptr[0..len],
            prefix != 0,
            fuzzy.max_fuzzy_terms,
            .corpus,
        ) catch {
            arena.deinit();
            return -2;
        };
        if (last) {
            if (e) |x| {
                alts = @intCast(x.alts.len);
                last_match = x.match;
            } else {
                alts = 0;
            }
            kept = arena;
        } else {
            if (e) |x| std.mem.doNotOptimizeAway(x.match.ptr);
            arena.deinit();
        }
    }
    return alts;
}

export fn fz_match_ptr() ?[*]const u8 {
    return last_match.ptr;
}
export fn fz_match_len() u32 {
    return @intCast(last_match.len);
}
