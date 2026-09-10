//! `sqlite-core.wasm` — the ONE SQLite the browser gets, and both ABIs built on it.
//!
//! Two features need SQLite client-side: the `.spd` viewer (`spd_*`, defined in
//! `spd_decode.zig` and compiled in below) and the local search index (`idx_*`,
//! here). They are ONE artifact because splitting them would ship the ~290 KB
//! amalgamation TWICE to avoid ~10 KB of Zig a given page happens not to call —
//! §5, which also explains the file's name: an
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
//! a build error"* (§0).
//!
//! **And it cannot be tested by behaviour, which is why `idx_open` refuses.**
//! MEASURED while building this: with the flag REMOVED the module is
//! indistinguishable — 80,000 documents built, an 80,000-row `ORDER BY rank`
//! stepped to completion, hundreds of autocommitted inserts forcing level-0
//! merges, all identical. Nothing at household scale reaches
//! `vdbeSorterOpenTempFile`, so the flag protects a path a test cannot provoke
//! and a household might. `idx_open`/`idx_deserialize` therefore ask the
//! COMPILED AMALGAMATION (`sqlite3_compileoption_used`, not a build variable
//! that could agree with itself) and refuse to hand back an index they cannot
//! vouch for; `tests/sqlite_core_abi.mjs` asserts that refusal.
//!
//! ## Two ABI traps, both silent until they are not
//!
//! Recorded in §6, where they cost a debugging cycle, and
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
//!     serialized image cannot drift from the DDL that produced it — a change to
//!     the table definition or its `tokenize=` makes a stored image stale with
//!     no server-side version moving.
//!   * `idx_query` takes the user's RAW string and folds it through the index's
//!     own tokenizer before building the MATCH expression. A JS-side fold would
//!     be the second tokenizer implementation the whole design exists to avoid,
//!     and a JS-side escaper would have to decide what FTS5 does with `-`.
//!   * `idx_fuzzy` owns the TYPO LADDER for the same reason twice over: the
//!     distance is measured on the folded token against the folded vocabulary
//!     (`foldToken`), and the vocabulary it scans is inside this module.
//!
//! `search/query.ts` keeps ranking policy, snippets and the staleness count —
//! `idx_query` reports bm25 rank order and the exact total, and the client is
//! free to reorder what it is given.
//!
//! ## `idx_*` ABI (pointers are byte offsets into exported `memory`)
//!
//! `tests/sqlite_core_abi.mjs` pins every export; what follows is what it
//! cannot say. A negative return is `-rc` for a SQLite result code, with
//! `-SQLITE_MISUSE` (-21) for "no open database" and `-100` for "built without
//! `-DSQLITE_TEMP_STORE=3`" — deliberately outside SQLite's range, because
//! nothing went wrong at runtime and the binary is wrong.
//!
//!   u32  idx_schema_version()   — bump when the DDL or `tokenize=` changes.
//!   i32  idx_open()             — fresh `:memory:` db + the FTS5 table. Also
//!                                 the "start over" call.
//!   i32  idx_add(u32 doc_id, u8* text, usize len)  — `doc_id` is the FTS5
//!        rowid; a repeat is a constraint failure, never a silent overwrite.
//!   i32  idx_query(u8* q, usize len, u32 limit)    — the TOTAL, exact, not a
//!        floor; `idx_hit(i)` reads the first `min(total, limit)` of them.
//!   i32  idx_fuzzy(u8* q, usize len, u32 limit)
//!        `idx_query` with the ladder attached, and IDENTICAL to it — same
//!        total, same `idx_hit` buffer, same errors — whenever the query AS
//!        TYPED matched anything. Only a total of 0 re-runs a widened
//!        expression, so a caller may switch to it wholesale.
//!   u8*  idx_expansion_ptr() / u32 idx_expansion_len()
//!        WHAT was substituted, so the UI can say "matched **reunião**": UTF-8
//!        `typed \t matched \n` per pair, in the order the expression names
//!        them. Rewritten by EVERY query, so an exact query that matched leaves
//!        it empty. Neither half can contain a delimiter — `typed` is
//!        whitespace-delimited and `matched` is an fts5 term, which `unicode61`
//!        cannot emit containing a tab or a newline.
//!   i32  idx_serialize()        — image length; bytes at `idx_image_ptr`.
//!   u8*  idx_image_alloc(usize len)                — trap 1 above; SQLite's heap.
//!   i32  idx_deserialize(u8* img, usize len)       — SQLite TAKES OWNERSHIP.
//!   u8*  idx_errmsg_ptr() / u32 idx_errmsg_len()
//!        Set on FAILURE and NOT cleared on success, so read it only after a
//!        negative return — otherwise it is whatever failed last, which reads
//!        like a fresh diagnosis and is not one. Length 0 means never set, and
//!        the pointer must not be dereferenced.
//!
//! ## Lifetime rules (the same hazard `spd_decode.zig` documents)
//!
//! `memory` can grow on any call, so JS must re-read every pointer AFTER the call
//! that produced it. `idx_image_ptr` is valid until the next
//! `idx_serialize`/`idx_close`; the expansion until the next query of either
//! kind; the error message until the next call of any kind.

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

/// The FTS5 tokenizer, TAKEN from the server rather than restated: one
/// declaration in `backend/db/schema.zig`. The terms the server ships are the
/// output of that tokenizer, and a different one here would index a folded term
/// against a differently-folded query and quietly miss — so the two cannot be
/// configured apart. `tests/sqlite_core_abi.mjs` pins what it DOES (an accented
/// query finding an unaccented term), so behaviour is guarded as well as
/// spelling.
const tokenizer = @import("schema").fts_tokenizer;

/// How the local index is SHAPED. Bumped when `index_ddl` or `tokenizer`
/// changes — a stored image built under an older shape is unusable, and nothing
/// server-side moves to say so.
const schema_version: u32 = 1;

/// No `prefix=` option, deliberately: the server's own index has none
/// (§213 blames it for the Pi's seek storm), the bench
/// measured prefix queries at 0.034–0.075 ms without one, and a prefix index
/// would grow the serialized image the client has to store for no measured gain.
const index_ddl = "CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='" ++ tokenizer ++ "');";

/// A one-row FTS5 table used purely to see the user's query the way the index
/// saw its own text.
///
/// `content=''` is not a space saving: it is the precondition for `'delete-all'`
/// below. `DELETE FROM` does not empty an FTS5 index, it appends tombstones, so
/// on a long-lived instance every fold keeps paying for the biggest thing ever
/// folded — "search gets slower the longer the tab has been open", measured
/// server-side at 0.4 ms → 13.9 ms.
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
/// What the typo ladder substituted, as `typed \t matched \n` pairs. Cleared by
/// EVERY query rather than only by a fuzzy one, so it can never outlive the
/// answer it explains — see the header's ABI note.
var expansion: std.ArrayList(u8) = .empty;

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
    expansion.clearRetainingCapacity();
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

/// A repeated `doc_id` is a constraint failure rather than a silent overwrite —
/// the client's ordinals come from one manifest, so a collision means the
/// caller mixed two.
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
/// contributes no terms and is NOT an error. That is why the fold is here rather
/// than in JS: an escaper would have had to guess what FTS5 makes of `"-"`, and
/// guessing wrong is a syntax error on a keystroke.
fn buildMatch(h: *c.sqlite3, query: []const u8) i32 {
    match.clearRetainingCapacity();

    var rc = c.sqlite3_exec(h, fold_ddl, null, null, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }

    // The terms of ONE token at a time; nothing here outlives the query.
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var terms: std.ArrayList([]const u8) = .empty;

    var it = std.mem.tokenizeAny(u8, query, " \t\r\n\x0b\x0c");
    while (it.next()) |tok| {
        terms.clearRetainingCapacity();
        rc = foldToken(h, arena, tok, &terms);
        if (rc != 0) return rc;
        for (terms.items) |term| {
            if (match.items.len != 0) match.append(gpa, ' ') catch return -c.SQLITE_NOMEM;
            appendQuoted(term) catch return -c.SQLITE_NOMEM;
        }
    }

    const open_ended = query.len != 0 and !std.ascii.isWhitespace(query[query.len - 1]);
    if (match.items.len != 0 and open_ended) match.append(gpa, '*') catch return -c.SQLITE_NOMEM;
    return 0;
}

/// Every term `tok` tokenizes to, in vocabulary order, appended to `out` and
/// duped from `alloc`. Empty for punctuation. `fold_ddl` must already have run
/// on `h`. Returns 0, or `-rc`.
///
/// THE fold, singular: `buildMatch` asks it what to search for and the typo
/// ladder asks it what to measure a distance against, so the string the index is
/// queried with and the string a candidate is compared to cannot come from two
/// different tokenizers. That is the same argument that put the fold in wasm at
/// all, applied one level down.
fn foldToken(
    h: *c.sqlite3,
    alloc: std.mem.Allocator,
    tok: []const u8,
    out: *std.ArrayList([]const u8),
) i32 {
    var rc = c.sqlite3_exec(h, fold_reset_sql, null, null, null);
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
        // Duped because the row is invalidated by the next step, and the ladder
        // holds every token's terms across the whole vocabulary scan.
        const owned = alloc.dupe(u8, std.mem.span(text)) catch return -c.SQLITE_NOMEM;
        out.append(alloc, owned) catch return -c.SQLITE_NOMEM;
    }
    return 0;
}

/// The total is EXACT and free here, which is why the server's "N+" floors are
/// retired: they existed only to avoid paying for matches early termination had
/// skipped, and a client holding the index has already paid. Stepping the whole
/// rank-ordered result costs 12 ms at the bench's pathological `con*` over 24k
/// segments and 0.06 ms at tier 1.
export fn idx_query(ptr: [*]const u8, len: usize, limit: u32) i32 {
    const h = db orelse return no_db;
    hits.clearRetainingCapacity();
    // An exact query explains nothing, and a stale explanation reads like a
    // fresh one — the same trap the error message documents.
    expansion.clearRetainingCapacity();

    const rc0 = buildMatch(h, ptr[0..len]);
    if (rc0 != 0) return rc0;
    // Nothing tokenizable: no results, and not an error.
    if (match.items.len == 0) return 0;

    return runMatch(h, limit);
}

/// Step whatever expression is in `match`, buffering the first `limit` rowids
/// for `idx_hit` and returning the exact total. Shared by the exact pass and the
/// fuzzy re-run so the two cannot count differently.
fn runMatch(h: *c.sqlite3, limit: u32) i32 {
    hits.clearRetainingCapacity();

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

// ---------------------------------------------------------------------------
// Typo tolerance — a FALLBACK, never a widening
// ---------------------------------------------------------------------------
//
// IN THE WASM rather than in `webapp/src/search/` for three reasons, the first
// of which the design rests on:
//
//   1. `foldToken` runs the query token through THE INDEX'S OWN TOKENIZER, so
//      "calígrafa" and "caligrafa" reach the distance function as one string and
//      the comparison is folded-against-folded. A TypeScript fold would be a
//      second opinion about `remove_diacritics 2`.
//   2. The distance is over CODEPOINTS of Portuguese text. A TypeScript decoder
//      would be a second opinion about Unicode as well.
//   3. The vocabulary lives inside this module's FTS5 index; exporting tens of
//      thousands of terms across the JS boundary on every failed search would
//      cost far more than scanning them where they already are.
//
// Why any of it exists: the searchable text is the device's own handwriting
// recognition, so the CORPUS is misspelt, not just the query. "Danie Witches.
// Arch Interview" and "usar infra-set dá trabalho!" are real rows. Exact
// matching therefore fails even when the user types the word correctly, which is
// a stronger case than ordinary typo tolerance.
//
// `spellfix1`, `editdist3` and `soundex` are not in this build, and vendoring
// spellfix1 was rejected: its phonetics are English-oriented, the same reason the
// `porter` stemmer was rejected for a Portuguese corpus. So the index's own
// vocabulary is walked and the distance computed here.
//
// ## SCALING ASSUMPTION — the shape is unchanged, the DANGER is not
//
// Every fallback search scans the ENTIRE vocabulary once, comparing each term
// against each query token: `O(V · T · (L² + cap))` for V terms and T query
// tokens of at most L codepoints. Both the distance and the shortlist are capped
// by constants, so the scan is LINEAR in V and stays linear. That shape and those
// caps are carried over exactly.
//
// In the browser there is no lock and nothing is queued behind the scan, so the
// worst case is one tab's own search box on a search that already returned
// nothing — where on the Pi the zero-hit prefix `reunaio` measured 6,133.8 ms
// p50 under the global DB lock, 98% of it in this scan.
// What remains is the linear-in-V assumption, and it does remain: a large or
// multi-tenant vocabulary would need this replaced by an n-gram or
// deletion-neighbour index, or a real fuzzy extension, NOT a bigger cap.
//
// MEASURED here over the real library — 23,964 pages, 63,577 distinct terms —
// through the shipped artifact: a query that MATCHES costs 1.42 ms against the
// exact path's 1.37 ms, so the fallback is free when it does not fire, and one
// that does not costs 71.3 ms p50 for the whole scan. Two orders of magnitude
// better than the Pi, and still the most expensive thing this module does.

/// How many vocabulary terms one search may add. bm25 over a hundred OR'd terms
/// is not a ranking, it is noise — and each extra term is another posting list to
/// merge. 32 is far more than a real typo needs (a misspelt word has a handful of
/// near neighbours, not dozens) while keeping the expression small.
///
/// It is a CEILING, not a target. What the expansion actually offers is the
/// best-ranked tier and nothing else (see `betterCandidate`), which in practice
/// is one or two terms; the cap only decides what happens when a query has more
/// equally-good readings than are worth searching for.
const max_fuzzy_terms: usize = 32;

/// Longest token, in codepoints, the distance function will consider. Past this
/// the token is left exact: a 64-character "word" is not a typo. Also the size of
/// `editDistance`'s stack rows, which is why it is a constant and not a policy.
const max_fuzzy_term_cp: usize = 64;

/// The `fts5vocab` view of the index's OWN terms — the candidate pool. Created
/// per call with `IF NOT EXISTS` for the same reason the fold table is: a
/// deserialized connection is a new connection and has no temp tables at all.
const vocab_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.docs_vocab USING fts5vocab('main','docs','row');";

const vocab_select_sql = "SELECT term FROM temp.docs_vocab;";

/// The edit distance a token of `len` term-codepoints tolerates.
///
/// "Edit" here is `editDistance`'s, i.e. Damerau-Levenshtein: a swap of two
/// adjacent characters costs ONE, like an insertion or a deletion. The rungs
/// below are unchanged by that — what changes is which words a rung can reach,
/// not how far it reaches.
///
/// The threshold MUST scale with length. One edit on a four-letter word is a huge
/// net — "casa" reaches casa/cara/caso/asa/cama and on — while one edit on a
/// twelve-letter word is very nearly the word itself. A flat threshold makes
/// short tokens match almost anything, which is exactly the precision loss this
/// whole design is trying to avoid. The 0 / 1 / 2 ladder is the conventional one,
/// and the ≤3 rung means short tokens get NO expansion at all: at that length a
/// single edit is not a typo signal, it is a different word.
///
/// `len` is counted by `termLen`, i.e. in CODEPOINTS — the corpus is Portuguese,
/// and "ção" must be three characters and not five.
fn maxEdits(len: usize) usize {
    if (len <= 3) return 0;
    if (len <= 7) return 1;
    return 2;
}

/// One vocabulary term the scan found near a query token, with the two numbers
/// that decide whether it is a BETTER guess than another one.
const Candidate = struct {
    /// The vocabulary term itself, as the index holds it (already folded).
    term: []const u8,
    /// Edit distance from the query token, `editDistance`'s answer.
    dist: usize,
    /// How much longer or shorter the candidate is than the token, in
    /// codepoints. See `betterCandidate` for why this is the tiebreak.
    delta: usize,
};

/// The ranking rule, in one place: which of two near-misses is the better guess.
///
///   1. **Shorter edit distance wins.** One edit away is a likelier reading of
///      what was meant than two.
///   2. **Then the smaller length difference.** This is what separates a
///      transposition from a deletion at the same distance, and it is why `tset`
///      prefers `test` over `set`: both are one edit away, but the swap preserves
///      length (delta 0) while dropping the leading `t` does not (delta 1).
///      Somebody who typed four characters more probably meant a four-character
///      word than a three-character one.
///   3. **Then the term itself, byte order.** Not meaningful, deliberately — it
///      exists so that two candidates the first two rules cannot separate are
///      still ordered the SAME WAY on every run. Without it the survivors of the
///      cap would depend on `fts5vocab` iteration order, i.e. on which document
///      happened to be indexed first, and the same query would answer differently
///      before and after an unrelated sync.
fn betterCandidate(a: Candidate, b: Candidate) bool {
    if (a.dist != b.dist) return a.dist < b.dist;
    if (a.delta != b.delta) return a.delta < b.delta;
    return std.mem.order(u8, a.term, b.term) == .lt;
}

/// One query token on the fallback path.
const FuzzyToken = struct {
    /// The token as the PERSON typed it, which is half of what the UI renders.
    raw: []const u8,
    /// Every term it folded to — what the primary expression emits for it.
    terms: []const []const u8,
    /// The single term when it folded to exactly one, which is the only case
    /// that can be expanded: a distance is measured against a vocabulary term,
    /// and punctuation (no terms) or something that splits (several) has none to
    /// measure. Null otherwise, and null when the ladder allows no edits.
    term: ?[]const u8,
    /// Whether the primary expression prefix-matches this token's last term.
    prefix: bool,
    /// `raw`'s length in term-codepoints, which is what the ladder rungs read and
    /// what a mid-typing candidate is truncated to.
    len: usize,
    /// `term`'s length in codepoints, for the ranking's `delta`. Kept beside
    /// `len` so the comparison is folded-against-folded, exactly like the
    /// distance itself.
    term_len: usize,
    budget: usize,
    /// Near-misses found by the scan, sorted by `betterCandidate`, never longer
    /// than the cap.
    cands: std.ArrayList(Candidate) = .empty,
    /// The candidates that survived ranking and the shared cap, in rank order —
    /// what actually goes into the expression.
    alts: std.ArrayList([]const u8) = .empty,
};

/// Offers one near-miss to a token, keeping its list sorted by `betterCandidate`
/// and never longer than `cap`.
///
/// A BOUNDED insertion sort rather than "collect everything, then sort": a query
/// whose budget admits most of the vocabulary would otherwise materialise all of
/// it per token before throwing nearly all of it away. At most `cap` long at
/// every moment, so the scan stays LINEAR in vocabulary size — the property the
/// scaling note above depends on.
///
/// `cand.term` is BORROWED (a live `fts5vocab` row); it is duped only if it is
/// actually kept, so a rejected candidate costs no allocation at all.
fn offer(alloc: std.mem.Allocator, t: *FuzzyToken, cap: usize, cand: Candidate) !void {
    if (cap == 0) return;
    var i: usize = 0;
    while (i < t.cands.items.len and !betterCandidate(cand, t.cands.items[i])) : (i += 1) {}
    // Worse than everything already held, with no room left to hold it.
    if (i >= cap) return;

    var owned = cand;
    owned.term = try alloc.dupe(u8, cand.term);
    if (t.cands.items.len < cap) {
        try t.cands.insert(alloc, i, owned);
    } else {
        // Full: the worst entry falls off the end to make room.
        var j = t.cands.items.len - 1;
        while (j > i) : (j -= 1) t.cands.items[j] = t.cands.items[j - 1];
        t.cands.items[i] = owned;
    }
}

/// Rebuild `match` as the primary expression with an OR-group spliced in per
/// expanded token, and `expansion` as the `typed \t matched \n` record of what
/// that group added. Returns 1 when it widened anything, 0 when there was nothing
/// to widen — in which case the caller must NOT re-run, because the expression
/// would be the byte-identical one that just returned nothing — or `-rc`.
///
/// The shape is:
///
///     primary:  "funciona" "caligrafa"*
///     fuzzy:    "funciona" AND ("caligrafa"* OR "caligrafia")
///
/// so the AND between tokens is preserved and every term — including the ones
/// read out of `fts5vocab` — goes through the same quoting as before. The AND is
/// written out rather than left implicit because FTS5 only lets the operator be
/// omitted between two phrases: `"a" ("b" OR "c")` is a syntax error. Spelling it
/// everywhere rather than only where a group appears keeps one rule instead of
/// two, and means the same thing.
///
/// ## What goes into the OR-group is RANKED, not merely near enough
///
/// Every vocabulary term inside a token's budget is a candidate, but only the
/// best tier is offered: `betterCandidate` orders them and everything the
/// ordering can separate from the winner is dropped. Widening to the whole budget
/// was how `tset` came back with `set` — one deletion away, exactly as `test` is
/// one transposition away — and once both are in the group bm25 scores them
/// alike, because it has no notion that one is a likelier reading of what was
/// typed. Genuinely tied candidates all survive ("cala" really is equally close
/// to casa, cara and cama); a worse one does not.
///
/// Terms from the vocabulary are index-derived rather than user-typed, but they
/// are quoted anyway: expansion must not become a second, unaudited path into the
/// parser, and defence in depth costs nothing here.
fn buildFuzzyMatch(h: *c.sqlite3, query: []const u8) i32 {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var rc = c.sqlite3_exec(h, fold_ddl, null, null, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }

    var tokens: std.ArrayList(FuzzyToken) = .empty;
    var it = std.mem.tokenizeAny(u8, query, " \t\r\n\x0b\x0c");
    var expandable = false;
    while (it.next()) |tok| {
        var terms: std.ArrayList([]const u8) = .empty;
        rc = foldToken(h, arena, tok, &terms);
        if (rc != 0) return rc;
        const len = termLen(tok);
        const budget = if (len <= max_fuzzy_term_cp) maxEdits(len) else 0;
        const term: ?[]const u8 = if (budget > 0 and terms.items.len == 1) terms.items[0] else null;
        if (term != null) expandable = true;
        tokens.append(arena, .{
            .raw = tok,
            .terms = terms.items,
            .term = term,
            .prefix = false,
            .len = len,
            .term_len = if (term) |x| cpLen(x) else 0,
            .budget = budget,
        }) catch return -c.SQLITE_NOMEM;
    }
    // Where `buildMatch` puts the `*`, restated: on the last term it emitted,
    // when the query does not end in whitespace. That is the last term of the
    // last token THAT PRODUCED ANY — `casa -` prefix-matches `casa`, because the
    // hyphen folds away and contributes nothing to hang a star on.
    if (query.len != 0 and !std.ascii.isWhitespace(query[query.len - 1])) {
        var i = tokens.items.len;
        while (i > 0) : (i -= 1) {
            if (tokens.items[i - 1].terms.len != 0) {
                tokens.items[i - 1].prefix = true;
                break;
            }
        }
    }
    // Every token is too short (or unfoldable) to expand: the fallback has
    // nothing to offer that the primary pass did not already try.
    if (!expandable) return 0;

    rc = c.sqlite3_exec(h, vocab_ddl, null, null, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    var vocab: ?*c.sqlite3_stmt = null;
    rc = c.sqlite3_prepare_v2(h, vocab_select_sql, -1, &vocab, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    defer _ = c.sqlite3_finalize(vocab);
    while (true) {
        rc = c.sqlite3_step(vocab);
        if (rc == c.SQLITE_DONE) break;
        if (rc != c.SQLITE_ROW) {
            setErrDb();
            return -rc;
        }
        const raw_term = c.sqlite3_column_text(vocab, 0) orelse continue;
        const vterm = std.mem.span(raw_term);
        for (tokens.items) |*t| {
            const term = t.term orelse continue;
            // For the word still being typed the vocabulary term is TRUNCATED to
            // the length typed so far, so a typo inside a half-written word is
            // still reachable: "calugraf" vs "caligrafia"[0..8] is one edit,
            // while against the whole term it is three and would be missed.
            const cand = if (t.prefix) truncCodepoints(vterm, t.len) else vterm;
            const d = editDistance(term, cand, t.budget) orelse continue;
            // Distance 0 is the term the primary pass already searched for.
            if (d == 0) continue;
            const cand_len = cpLen(cand);
            offer(arena, t, max_fuzzy_terms, .{
                .term = vterm,
                .dist = d,
                // Measured against the string the DISTANCE was measured against,
                // so a truncated mid-typing candidate is compared on the same
                // footing as a whole term.
                .delta = if (cand_len > t.term_len) cand_len - t.term_len else t.term_len - cand_len,
            }) catch return -c.SQLITE_NOMEM;
        }
    }

    // Only the BEST tier survives — see the `tset`/`set` case in the doc comment.
    for (tokens.items) |*t| {
        if (t.cands.items.len == 0) continue;
        const best = t.cands.items[0];
        var n: usize = 1;
        while (n < t.cands.items.len and
            t.cands.items[n].dist == best.dist and
            t.cands.items[n].delta == best.delta) : (n += 1)
        {}
        t.cands.shrinkRetainingCapacity(n);
    }

    // `max_fuzzy_terms` is a budget for the whole SEARCH, so a multi-token query
    // shares it round-robin: every token gets its best candidate before any token
    // gets its second. Taking tokens in order instead would let one misspelt word
    // eat the budget and leave the next unexpanded.
    var added: usize = 0;
    var round: usize = 0;
    outer: while (true) : (round += 1) {
        var progressed = false;
        for (tokens.items) |*t| {
            if (round >= t.cands.items.len) continue;
            if (added >= max_fuzzy_terms) break :outer;
            t.alts.append(arena, t.cands.items[round].term) catch return -c.SQLITE_NOMEM;
            added += 1;
            progressed = true;
        }
        if (!progressed) break;
    }
    if (added == 0) return 0;

    match.clearRetainingCapacity();
    expansion.clearRetainingCapacity();
    for (tokens.items) |t| {
        if (t.alts.items.len == 0) {
            // Byte-for-byte what `buildMatch` emits for this token.
            for (t.terms, 0..) |term, i| {
                appendAnd() catch return -c.SQLITE_NOMEM;
                appendQuoted(term) catch return -c.SQLITE_NOMEM;
                if (t.prefix and i + 1 == t.terms.len) match.append(gpa, '*') catch return -c.SQLITE_NOMEM;
            }
            continue;
        }
        // An expandable token folded to exactly one term, so the group is that
        // term OR the near-misses the ranking could not separate from each other.
        appendAnd() catch return -c.SQLITE_NOMEM;
        match.append(gpa, '(') catch return -c.SQLITE_NOMEM;
        appendQuoted(t.terms[0]) catch return -c.SQLITE_NOMEM;
        if (t.prefix) match.append(gpa, '*') catch return -c.SQLITE_NOMEM;
        for (t.alts.items) |alt| {
            match.appendSlice(gpa, " OR ") catch return -c.SQLITE_NOMEM;
            appendQuoted(alt) catch return -c.SQLITE_NOMEM;
            // Written from the SAME loop that writes the expression, so what is
            // reported cannot name a substitution the search was not widened by.
            expansion.appendSlice(gpa, t.raw) catch return -c.SQLITE_NOMEM;
            expansion.append(gpa, '\t') catch return -c.SQLITE_NOMEM;
            expansion.appendSlice(gpa, alt) catch return -c.SQLITE_NOMEM;
            expansion.append(gpa, '\n') catch return -c.SQLITE_NOMEM;
        }
        match.append(gpa, ')') catch return -c.SQLITE_NOMEM;
    }
    return 1;
}

/// The explicit `AND` between two emitted phrases. See `buildFuzzyMatch`.
fn appendAnd() !void {
    if (match.items.len != 0) try match.appendSlice(gpa, " AND ");
}

/// `idx_query`, with the typo ladder behind it.
///
/// The exact pass runs FIRST and unmodified, and the ladder is reached only when
/// it returned a total of zero. That ordering is the whole rule — expansion is a
/// FALLBACK, never a widening — and it is enforced here rather than left to the
/// caller, so there is no way to ask for a correction to a query that already had
/// an answer.
export fn idx_fuzzy(ptr: [*]const u8, len: usize, limit: u32) i32 {
    const h = db orelse return no_db;

    const total = idx_query(ptr, len, limit);
    // Non-zero is either hits — nothing to correct — or a failure, which has
    // nothing to fall back to. Either way this is `idx_query`'s answer verbatim.
    if (total != 0) return total;

    const rc = buildFuzzyMatch(h, ptr[0..len]);
    // 0 is "nothing to expand", and re-running would ask the identical question.
    if (rc <= 0) return rc;
    return runMatch(h, limit);
}

export fn idx_expansion_ptr() ?[*]const u8 {
    return expansion.items.ptr;
}

export fn idx_expansion_len() u32 {
    return @intCast(expansion.items.len);
}

/// The first `n` codepoints of `s` (all of it when shorter).
fn truncCodepoints(s: []const u8, n: usize) []const u8 {
    var seen: usize = 0;
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] & 0xC0 == 0x80) continue; // continuation byte
        if (seen == n) return s[0..i];
        seen += 1;
    }
    return s;
}

/// Decodes `s` into codepoints. Invalid UTF-8 degrades to one codepoint per byte
/// rather than erroring: this is a ranking heuristic, not a parser.
fn codepoints(buf: []u21, s: []const u8) []u21 {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len and n < buf.len) {
        const l = std.unicode.utf8ByteSequenceLength(s[i]) catch 1;
        if (i + l > s.len) break;
        buf[n] = std.unicode.utf8Decode(s[i..][0..l]) catch s[i];
        n += 1;
        i += l;
    }
    return buf[0..n];
}

/// Damerau-Levenshtein distance between `a` and `b` in CODEPOINTS, or null when
/// it exceeds `budget`.
///
/// ## Why transposition is one edit and not two
///
/// Swapping two adjacent characters is one of the commonest human typos, and
/// under plain Levenshtein it costs TWO edits — so `wtiches` never reached
/// `witches` at all, and `tset` reached `set` (drop the leading `t`, one edit)
/// while missing `test`. Landing on a different word is worse than missing: the
/// answer looks plausible and is not one. Counting the swap as one edit puts
/// `test` in reach at the same distance the ladder already allows.
///
/// ## Which variant
///
/// The OPTIMAL STRING ALIGNMENT variant: it forbids editing a substring twice, so
/// `ca` → `abc` is 3 rather than the unrestricted 2. That restriction is
/// irrelevant here — the ladder never allows more than two edits, and two edits
/// cannot re-cross the same substring — while OSA needs only one extra rolling
/// row instead of the alphabet-indexed last-occurrence table the unrestricted
/// algorithm requires. Same answers within budget, less state.
///
/// Codepoints, not bytes, because the corpus is accented: on bytes, "ção" is five
/// units and a single mistyped accent would read as a two-edit difference. The
/// length pre-check and the per-row floor let a hopeless pair fall out early,
/// which is what keeps the full-vocabulary scan cheap. Both survive the
/// transposition rule: a swap does not change length, and `d[i][j]` via
/// transposition is `d[i-2][j-2] + 1`, which is `>= min(row i-1)` because
/// adjacent diagonal cells differ by at most 1 — so a row whose minimum already
/// exceeds the budget still cannot be rescued by a later swap.
fn editDistance(a: []const u8, b: []const u8, budget: usize) ?usize {
    var abuf: [max_fuzzy_term_cp]u21 = undefined;
    var bbuf: [max_fuzzy_term_cp]u21 = undefined;
    const x = codepoints(&abuf, a);
    const y = codepoints(&bbuf, b);

    const diff = if (x.len > y.len) x.len - y.len else y.len - x.len;
    if (diff > budget) return null;

    // Three rolling rows, not two: the transposition step reads `d[i-2][j-2]`.
    var prev2: [max_fuzzy_term_cp + 1]usize = undefined;
    var prev: [max_fuzzy_term_cp + 1]usize = undefined;
    var curr: [max_fuzzy_term_cp + 1]usize = undefined;
    for (0..y.len + 1) |j| prev[j] = j;

    for (x, 0..) |xc, i| {
        curr[0] = i + 1;
        var row_min = curr[0];
        for (y, 0..) |yc, j| {
            const cost: usize = if (xc == yc) 0 else 1;
            var v = @min(@min(curr[j] + 1, prev[j + 1] + 1), prev[j] + cost);
            // The two characters are each other's neighbour, swapped: one edit.
            if (i > 0 and j > 0 and xc == y[j - 1] and x[i - 1] == yc) {
                v = @min(v, prev2[j - 1] + 1);
            }
            curr[j + 1] = v;
            row_min = @min(row_min, v);
        }
        if (row_min > budget) return null;
        @memcpy(prev2[0 .. y.len + 1], prev[0 .. y.len + 1]);
        @memcpy(prev[0 .. y.len + 1], curr[0 .. y.len + 1]);
    }
    const d = prev[y.len];
    return if (d > budget) null else d;
}

/// How many codepoints `s` decodes to, by the same forgiving rule as
/// `codepoints` — so the ranking's length comparison and the distance function
/// count the same units.
fn cpLen(s: []const u8) usize {
    var buf: [max_fuzzy_term_cp]u21 = undefined;
    return codepoints(&buf, s).len;
}

/// How many characters of a token `unicode61` would keep as part of a term — i.e.
/// how much the user has actually typed, ignoring punctuation they may have leant
/// on. Counted in CODEPOINTS, not bytes, so an accented word is not credited
/// double: `sé` is two characters, and so is `se`.
fn termLen(tok: []const u8) usize {
    var n: usize = 0;
    for (tok) |ch| {
        // Skip UTF-8 continuation bytes: one codepoint counts once.
        if (ch & 0xC0 == 0x80) continue;
        if (std.ascii.isAlphanumeric(ch) or ch >= 0x80) n += 1;
    }
    return n;
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
