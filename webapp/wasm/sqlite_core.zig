//! `sqlite-core.wasm` — the ONE SQLite the browser gets, and both ABIs built on it.
//!
//! Two features need SQLite client-side: the `.spd` viewer (`spd_*`, defined in
//! `spd_decode.zig` and compiled in below) and the local search index (`idx_*`,
//! here). They are ONE artifact because splitting them would ship the ~290 KB
//! amalgamation TWICE to avoid ~10 KB of Zig a given page happens not to call —
//! `client-side-search-impl.md` §5, which also explains the file's name: an
//! artifact called `spd-decode` that also runs search is a lie in the build graph.
//!
//! ## The flags, and the one that is dangerous
//!
//! `build.zig`'s `sqlite_core_wasm_flags`: the hard-trimmed, OS-less profile the
//! `.spd` viewer always had, plus `-DSQLITE_ENABLE_FTS5` and
//! `-DSQLITE_TEMP_STORE=3`. The last is NOT cosmetic. `sqlite_vfs_null.c` cannot
//! open a file — `nullOpen` returns `SQLITE_IOERR` unconditionally — so anything
//! that spilled to temp STORAGE would spill to a temp FILE and fail. Forcing temp
//! storage to memory is a prerequisite for FTS5 under `OS_OTHER=1`, and the
//! failure it prevents *"surfaces as a corrupt index in production rather than as
//! a build error"* (`wasm-search-bench.md` §0).
//!
//! **And it cannot be tested by behaviour, which is why `idx_open` refuses.**
//! MEASURED while building this: with the flag REMOVED, the module is
//! indistinguishable — 80,000 documents built, an 80,000-row `ORDER BY rank`
//! stepped to completion, hundreds of autocommitted inserts forcing level-0
//! merges, the query fold's `temp.` table, all identical. Nothing at household
//! scale reaches `vdbeSorterOpenTempFile`, so the flag protects a path a test
//! cannot provoke and a household might. `idx_open`/`idx_deserialize` therefore
//! ask the COMPILED AMALGAMATION (`sqlite3_compileoption_used`, not a build
//! variable that could agree with itself) and refuse to hand back an index they
//! cannot vouch for. `tests/sqlite_core_abi.mjs` asserts that refusal, so
//! dropping the flag is a red test rather than a silent corruption later.
//!
//! ## Two ABI traps, both silent until they are not
//!
//! Recorded in `wasm-search-bench.md` §6, where they cost a debugging cycle, and
//! both are consequences of the flag set rather than of anything here:
//!
//!   1. the `sqlite3_deserialize` target must come from **`sqlite3_malloc`**, not
//!      the Zig allocator — `FREEONCLOSE` hands the buffer back to SQLite's own
//!      heap, so an `idx_alloc` pointer would be a cross-allocator free. Hence
//!      `idx_image_alloc`, which exists for no other reason.
//!   2. `sqlite3_malloc64` **traps outright on a fresh instance** ("null function
//!      or function signature mismatch") until `sqlite3_initialize()` has run,
//!      because `OMIT_AUTOINIT` leaves the memory subsystem's method vtable null.
//!      So every entry point that can be the FIRST call into the module
//!      initialises explicitly; it is idempotent.
//!
//! ## What this module owns, and what `webapp/src/search/` owns
//!
//! It owns the SCHEMA and the FOLD, because both are parity surfaces:
//!
//!   * `schema_version` is exported so the TypeScript record that caches a
//!     serialized image cannot drift from the DDL that produced it. A change to
//!     the table definition or its `tokenize=` makes a stored image stale with no
//!     server-side version moving (`client-side-search-impl.md` §4).
//!   * `idx_query` takes the user's RAW string and folds it through the index's
//!     own tokenizer before building the MATCH expression. A JS-side fold would
//!     be the second tokenizer implementation the whole design exists to avoid,
//!     and a JS-side escaper would have to decide what FTS5 does with `-` — this
//!     way punctuation simply folds to no terms.
//!
//! `search/query.ts` keeps ranking policy, snippets and the staleness count;
//! §9.4 (tier-1 order vs bm25 order) is a client decision and nothing here
//! forecloses it — `idx_query` reports bm25 rank order and the exact total, and
//! the client is free to reorder what it is given.
//!
//! ## `idx_*` ABI (pointers are byte offsets into exported `memory`)
//!
//! Buffers:
//!   u8*  idx_alloc(usize len) / void idx_free(u8*, usize)
//!
//! Identity:
//!   u32  idx_schema_version()   — bump when the DDL or `tokenize=` changes.
//!
//! Build:
//!   i32  idx_open()             — fresh `:memory:` db + the FTS5 table. 0, or -rc.
//!   void idx_close()
//!   i32  idx_begin() / idx_commit()
//!   i32  idx_add(u32 doc_id, u8* text, usize len)  — one document. 0, or -rc.
//!
//! Query:
//!   i32  idx_query(u8* q, usize len, u32 limit)    — TOTAL matches, or -rc.
//!   i32  idx_hit(u32 i)         — doc id of hit `i` (i < min(total, limit)), or -1.
//!
//! Persistence:
//!   i32  idx_serialize()        — image length, or -rc. Bytes at `idx_image_ptr`.
//!   u8*  idx_image_ptr()
//!   u8*  idx_image_alloc(usize len)                — trap 1 above; SQLite's heap.
//!   i32  idx_deserialize(u8* img, usize len)       — SQLite TAKES OWNERSHIP.
//!
//! Errors:
//!   u8*  idx_errmsg_ptr() / u32 idx_errmsg_len()
//!        Set on FAILURE and not cleared on success, so read it only after a
//!        negative return — otherwise it is whatever failed last, which reads
//!        like a fresh diagnosis and is not one. A length of 0 means no message
//!        has ever been set and the pointer must not be dereferenced.
//!
//! Negative returns are `-rc` for a SQLite result code; `-SQLITE_MISUSE` (-21)
//! means there is no open database, and `-100` means this artifact was built
//! without `-DSQLITE_TEMP_STORE=3` (see above — it is a build defect, so it is
//! deliberately outside SQLite's result-code range).
//!
//! ## Lifetime rules (the same hazard `spd_decode.zig` documents)
//!
//! `memory` can grow on any call, so JS must re-read every pointer AFTER the call
//! that produced it. `idx_image_ptr` is valid until the next
//! `idx_serialize`/`idx_close`; the error message until the next call of any kind.

const std = @import("std");
const builtin = @import("builtin");
const spd = @import("spd");
const c = spd.sqlite.c;

// The `.spd` viewer's `spd_*` exports, pulled into THIS artifact. One module,
// one SQLite — see the header.
comptime {
    _ = @import("spd_decode.zig");
}

/// wasm_allocator in the browser; page_allocator natively (the ABI test). SQLite
/// has its own heap and never uses this one — which is exactly why
/// `idx_image_alloc` exists.
const gpa = if (builtin.target.cpu.arch.isWasm())
    std.heap.wasm_allocator
else
    std.heap.page_allocator;

/// MUST stay identical to `backend/services/search/fuzzy.zig`'s `fts_tokenizer`
/// and to `segment_fts` in `schema.zig`. The terms the server ships are the
/// output of THAT tokenizer; a different one here would index a folded term
/// against a differently-folded query and quietly miss.
const tokenizer = "unicode61 remove_diacritics 2";

/// How the local index is SHAPED. Bumped when `index_ddl` or `tokenizer`
/// changes — a stored image built under an older shape is unusable, and nothing
/// server-side moves to say so.
const schema_version: u32 = 1;

/// No `prefix=` option, deliberately: the server's own index has none
/// (`search-baseline.md` §213 blames it for the Pi's seek storm), the bench
/// measured prefix queries at 0.034–0.075 ms without one, and a prefix index
/// would grow the serialized image the client has to store for no measured gain.
const index_ddl = "CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='" ++ tokenizer ++ "');";

/// A one-row FTS5 table used purely to see the user's query the way the index
/// saw its own text — the same device, and the same two statements, as
/// `fuzzy.zig`'s `fold_ddl`.
///
/// `content=''` is not a space saving: it is the precondition for `'delete-all'`
/// below. `DELETE FROM` does not empty an FTS5 index, it appends tombstones, so
/// on a long-lived instance every fold would keep paying for the biggest thing
/// ever folded. That failure — "search gets slower the longer the tab has been
/// open" — is `optimizations.md` entry 11b, measured server-side at 0.4 ms → 13.9 ms.
/// A search worker is exactly as long-lived as the connections that found it.
const fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold USING fts5(t, content='', tokenize='" ++ tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold_vocab USING fts5vocab('temp','token_fold','row');";

/// Truncates the fold table for real, rather than tombstoning it. See `fold_ddl`.
const fold_reset_sql = "INSERT INTO temp.token_fold(token_fold) VALUES('delete-all');";

var db: ?*c.sqlite3 = null;
/// Cached across `idx_add` calls: preparing per document would re-parse the same
/// INSERT once per blob in the library.
var add_stmt: ?*c.sqlite3_stmt = null;
/// Owned by SQLite after a successful `idx_serialize`; freed with `sqlite3_free`.
var image: ?[*]u8 = null;
var image_len: usize = 0;
/// The MATCH expression `idx_query` builds, kept alive for the duration of the
/// statement it is bound to with `SQLITE_STATIC`.
var match: std.ArrayList(u8) = .empty;
var hits: std.ArrayList(u32) = .empty;
var errbuf: std.ArrayList(u8) = .empty;

/// `-SQLITE_MISUSE`: the caller reached a query/build entry point with no open
/// database. Distinct from `-SQLITE_ERROR`, which is a real statement failure.
const no_db: i32 = -c.SQLITE_MISUSE;

/// This artifact was compiled without `-DSQLITE_TEMP_STORE=3`. Outside SQLite's
/// result-code range on purpose: nothing went wrong at runtime, the binary is
/// wrong. See the header for why no behavioural test can find this.
const bad_build: i32 = -100;

/// Initialise SQLite (trap 2 in the header: `OMIT_AUTOINIT`) and refuse to
/// proceed if temp storage could reach the null VFS.
///
/// Asked of the compiled amalgamation rather than of `build.zig`, because a
/// build variable checking itself proves only that build.zig is self-consistent
/// — the question is what the C compiler was actually handed.
fn initSqlite() i32 {
    if (c.sqlite3_compileoption_used("TEMP_STORE=3") == 0) {
        setErr("sqlite-core was built without -DSQLITE_TEMP_STORE=3; temp storage could reach the null VFS");
        return bad_build;
    }
    const rc = c.sqlite3_initialize();
    if (rc != c.SQLITE_OK) {
        setErr("sqlite3_initialize failed");
        return -rc;
    }
    return 0;
}

export fn idx_alloc(len: usize) ?[*]u8 {
    const buf = gpa.alloc(u8, len) catch return null;
    return buf.ptr;
}

export fn idx_free(ptr: [*]u8, len: usize) void {
    gpa.free(ptr[0..len]);
}

export fn idx_schema_version() u32 {
    return schema_version;
}

fn setErr(msg: []const u8) void {
    errbuf.clearRetainingCapacity();
    errbuf.appendSlice(gpa, msg) catch {};
}

fn setErrDb() void {
    if (db) |h| setErr(std.mem.span(c.sqlite3_errmsg(h))) else setErr("no database");
}

export fn idx_errmsg_ptr() ?[*]const u8 {
    return errbuf.items.ptr;
}

export fn idx_errmsg_len() u32 {
    return @intCast(errbuf.items.len);
}

/// Open a fresh in-memory database and create the FTS5 table. Any previously
/// open database is closed first, so this is also the "start over" call.
///
/// A build without FTS5 fails HERE, on the DDL ("no such module: fts5"), which
/// is loud enough on its own; the flag that needs the guard above is the one
/// whose absence changes nothing until it changes everything.
export fn idx_open() i32 {
    idx_close();
    var rc = initSqlite(); // also what registers the null VFS
    if (rc != 0) return rc;
    var h: ?*c.sqlite3 = null;
    rc = c.sqlite3_open(":memory:", &h);
    if (rc != c.SQLITE_OK) {
        if (h) |x| _ = c.sqlite3_close(x);
        return -rc;
    }
    db = h;
    rc = c.sqlite3_exec(h, index_ddl, null, null, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    return 0;
}

export fn idx_close() void {
    if (add_stmt) |s| {
        _ = c.sqlite3_finalize(s);
        add_stmt = null;
    }
    if (image) |p| {
        c.sqlite3_free(p);
        image = null;
        image_len = 0;
    }
    if (db) |h| {
        _ = c.sqlite3_close(h);
        db = null;
    }
    hits.clearRetainingCapacity();
    match.clearRetainingCapacity();
}

/// One explicit transaction around a whole build, because FTS5 flushes its
/// pending in-memory index to a new level-0 segment at every COMMIT: 40
/// autocommitted inserts are 40 segments and the merges that follow, against one
/// segment for 40 inserts inside a transaction.
export fn idx_begin() i32 {
    const h = db orelse return no_db;
    const rc = c.sqlite3_exec(h, "BEGIN", null, null, null);
    if (rc != c.SQLITE_OK) setErrDb();
    return -rc;
}

export fn idx_commit() i32 {
    const h = db orelse return no_db;
    const rc = c.sqlite3_exec(h, "COMMIT", null, null, null);
    if (rc != c.SQLITE_OK) setErrDb();
    return -rc;
}

/// Index one document under `doc_id`, which becomes the FTS5 rowid and is what
/// `idx_hit` hands back. A repeated id is a constraint failure rather than a
/// silent overwrite — the client's ordinals come from one manifest, so a
/// collision means the caller mixed two.
export fn idx_add(doc_id: u32, ptr: [*]const u8, len: usize) i32 {
    const h = db orelse return no_db;
    if (add_stmt == null) {
        var s: ?*c.sqlite3_stmt = null;
        const rc = c.sqlite3_prepare_v2(h, "INSERT INTO docs(rowid, body) VALUES(?1, ?2)", -1, &s, null);
        if (rc != c.SQLITE_OK) {
            setErrDb();
            return -rc;
        }
        add_stmt = s;
    }
    const stmt = add_stmt;
    _ = c.sqlite3_reset(stmt);
    var rc = c.sqlite3_bind_int64(stmt, 1, @intCast(doc_id));
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    // SQLITE_STATIC (a null destructor): the caller's buffer outlives the step,
    // so FTS5 tokenizes straight out of it with no copy.
    rc = c.sqlite3_bind_text(stmt, 2, ptr, @intCast(len), null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    rc = c.sqlite3_step(stmt);
    if (rc != c.SQLITE_DONE) {
        setErrDb();
        return -rc;
    }
    return 0;
}

/// Append `term` to the MATCH expression as a quoted FTS5 string.
///
/// `unicode61` never emits a `"` — it is a separator — so the doubling below is
/// belt and braces. It stays because it makes the expression safe by
/// CONSTRUCTION rather than safe by a property of the tokenizer that a future
/// `tokenize=` change could take away.
fn appendQuoted(term: []const u8) !void {
    try match.append(gpa, '"');
    for (term) |ch| {
        if (ch == '"') try match.append(gpa, '"');
        try match.append(gpa, ch);
    }
    try match.append(gpa, '"');
}

/// Build `match` from the user's raw `query`, folding each whitespace-separated
/// token through the index's own tokenizer.
///
/// Terms are ANDed (FTS5's implicit operator). Only the LAST term gets a `*`,
/// and only when the query does not end in whitespace: a trailing space is the
/// user saying they finished the word, and prefix-matching it anyway would let
/// `foo ` keep matching `foobar`.
///
/// A token that folds to nothing — punctuation, an emoji, a lone hyphen —
/// contributes no terms and is not an error. That is the whole reason the fold
/// is here rather than in JS: an escaper would have had to guess what FTS5 makes
/// of `"-"`, and guessing wrong is a syntax error on a keystroke.
fn buildMatch(h: *c.sqlite3, query: []const u8) i32 {
    match.clearRetainingCapacity();

    var rc = c.sqlite3_exec(h, fold_ddl, null, null, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }

    var it = std.mem.tokenizeAny(u8, query, " \t\r\n\x0b\x0c");
    while (it.next()) |tok| {
        rc = c.sqlite3_exec(h, fold_reset_sql, null, null, null);
        if (rc != c.SQLITE_OK) {
            setErrDb();
            return -rc;
        }
        {
            var s: ?*c.sqlite3_stmt = null;
            rc = c.sqlite3_prepare_v2(h, "INSERT INTO temp.token_fold(rowid, t) VALUES(1, ?1)", -1, &s, null);
            if (rc != c.SQLITE_OK) {
                setErrDb();
                return -rc;
            }
            defer _ = c.sqlite3_finalize(s);
            rc = c.sqlite3_bind_text(s, 1, tok.ptr, @intCast(tok.len), null);
            if (rc != c.SQLITE_OK) {
                setErrDb();
                return -rc;
            }
            rc = c.sqlite3_step(s);
            if (rc != c.SQLITE_DONE) {
                setErrDb();
                return -rc;
            }
        }
        var s: ?*c.sqlite3_stmt = null;
        rc = c.sqlite3_prepare_v2(h, "SELECT term FROM temp.token_fold_vocab", -1, &s, null);
        if (rc != c.SQLITE_OK) {
            setErrDb();
            return -rc;
        }
        defer _ = c.sqlite3_finalize(s);
        while (true) {
            rc = c.sqlite3_step(s);
            if (rc == c.SQLITE_DONE) break;
            if (rc != c.SQLITE_ROW) {
                setErrDb();
                return -rc;
            }
            const text = c.sqlite3_column_text(s, 0) orelse continue;
            if (match.items.len != 0) match.append(gpa, ' ') catch return -c.SQLITE_NOMEM;
            appendQuoted(std.mem.span(text)) catch return -c.SQLITE_NOMEM;
        }
    }

    const open_ended = query.len != 0 and !std.ascii.isWhitespace(query[query.len - 1]);
    if (match.items.len != 0 and open_ended) match.append(gpa, '*') catch return -c.SQLITE_NOMEM;
    return 0;
}

/// Run `query` and return how many documents matched IN TOTAL, buffering the
/// first `limit` of them for `idx_hit`.
///
/// The total is exact and free here, which is the point: §9.5 retires the
/// server's "N+" floors precisely because they existed only to avoid paying for
/// matches early termination had skipped, and a client holding the index has
/// already paid. Stepping the whole rank-ordered result costs 12 ms at the
/// bench's pathological `con*` over 24k segments and 0.06 ms at tier 1.
export fn idx_query(ptr: [*]const u8, len: usize, limit: u32) i32 {
    const h = db orelse return no_db;
    hits.clearRetainingCapacity();

    const rc0 = buildMatch(h, ptr[0..len]);
    if (rc0 != 0) return rc0;
    // Nothing tokenizable: no results, and not an error.
    if (match.items.len == 0) return 0;

    var stmt: ?*c.sqlite3_stmt = null;
    var rc = c.sqlite3_prepare_v2(h, "SELECT rowid FROM docs WHERE docs MATCH ?1 ORDER BY rank", -1, &stmt, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    defer _ = c.sqlite3_finalize(stmt);
    // SQLITE_STATIC again: `match` is not touched until the next `idx_query`.
    rc = c.sqlite3_bind_text(stmt, 1, match.items.ptr, @intCast(match.items.len), null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }

    var total: i32 = 0;
    while (true) {
        rc = c.sqlite3_step(stmt);
        if (rc == c.SQLITE_DONE) break;
        if (rc != c.SQLITE_ROW) {
            setErrDb();
            return -rc;
        }
        if (hits.items.len < limit) {
            hits.append(gpa, @intCast(c.sqlite3_column_int64(stmt, 0))) catch return -c.SQLITE_NOMEM;
        }
        total += 1;
    }
    return total;
}

export fn idx_hit(i: u32) i32 {
    if (i >= hits.items.len) return -1;
    return @intCast(hits.items[i]);
}

/// Serialize `main`. The bytes live at `idx_image_ptr()` until the next
/// serialize or close. `temp.token_fold` is not in `main` and so is not carried
/// into the stored image — which is right, it is a scratch pad for one query.
export fn idx_serialize() i32 {
    const h = db orelse return no_db;
    if (image) |p| {
        c.sqlite3_free(p);
        image = null;
        image_len = 0;
    }
    var n: c.sqlite3_int64 = 0;
    const p = c.sqlite3_serialize(h, "main", &n, 0) orelse {
        setErr("sqlite3_serialize returned null");
        return -c.SQLITE_NOMEM;
    };
    image = p;
    image_len = @intCast(n);
    return @intCast(n);
}

export fn idx_image_ptr() ?[*]const u8 {
    return image;
}

/// Allocate a deserialize target on **SQLite's** heap — trap 1 in the header.
/// `FREEONCLOSE`/`RESIZEABLE` make SQLite free and realloc this buffer itself,
/// so handing it an `idx_alloc` pointer is a cross-allocator free.
export fn idx_image_alloc(len: usize) ?[*]u8 {
    // Trap 2, and this is the entry point where it actually bites: on a fresh
    // instance restoring from IndexedDB, this is the FIRST call into SQLite.
    if (c.sqlite3_initialize() != c.SQLITE_OK) return null;
    return @ptrCast(c.sqlite3_malloc64(@intCast(len)));
}

/// Restore an image produced by `idx_serialize` — the second-visit path. `ptr`
/// must come from `idx_image_alloc`; SQLite takes ownership and the caller must
/// not free it. Deserialize does not COPY, so this is ~0.1 ms whatever the size.
export fn idx_deserialize(ptr: [*]u8, len: usize) i32 {
    idx_close();
    var rc = initSqlite();
    if (rc != 0) return rc;
    var h: ?*c.sqlite3 = null;
    rc = c.sqlite3_open(":memory:", &h);
    if (rc != c.SQLITE_OK) {
        if (h) |x| _ = c.sqlite3_close(x);
        return -rc;
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
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    return 0;
}
