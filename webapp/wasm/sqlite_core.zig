//! `sqlite-core.wasm`: the one SQLite the browser gets, carrying the `.spd`
//! viewer (`spd_*`) and the local search index (`idx_*`) so the amalgamation
//! ships once.
//!
//! `-DSQLITE_TEMP_STORE=3` is required: the null VFS cannot open files, so any
//! temp spill would fail as a corrupt index. No household-scale test reaches
//! that path, so `idx_open`/`idx_deserialize` ask the compiled amalgamation
//! (`sqlite3_compileoption_used`) and refuse with -100 otherwise. Other
//! negatives are `-rc`; -21 (`SQLITE_MISUSE`) is "no open database".
//!
//! Two traps: a deserialize target must come from `sqlite3_malloc`
//! (`idx_image_alloc`), since `FREEONCLOSE` frees it on SQLite's heap; and
//! under `OMIT_AUTOINIT` `sqlite3_malloc64` traps until `sqlite3_initialize()`,
//! so every possible first call initialises.
//!
//! This module owns the schema (`idx_schema_version`) and the query fold, so
//! JS never runs a second tokenizer. `idx_errmsg_*` is set on failure and not
//! cleared on success. `memory` can grow on any call; re-read pointers after
//! each.

const std = @import("std");
const builtin = @import("builtin");
const spd = @import("spd");
const c = spd.sqlite.c;

// The `.spd` viewer's exports, in this same artifact.
comptime {
    _ = @import("spd_decode.zig");
}

/// wasm_allocator in the browser, page_allocator natively. SQLite never uses
/// it, hence `idx_image_alloc`.
pub const gpa = if (builtin.target.cpu.arch.isWasm())
    std.heap.wasm_allocator
else
    std.heap.page_allocator;

/// The server's FTS5 tokenizer (`backend/db/schema.zig`), so queries fold
/// exactly as the shipped terms did.
const tokenizer = @import("schema").fts_tokenizer;

const sqlite_core_fuzzy = @import("sqlite_core_fuzzy.zig");
pub const q = @import("sqlite_core_query.zig");

/// Bump when `index_ddl` or `tokenizer` changes: stored images go stale with
/// nothing server-side moving.
const schema_version: u32 = 1;

/// No `prefix=`: prefix queries measured fast without one, and it would grow
/// the stored image.
const index_ddl = "CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='" ++ tokenizer ++ "');";

/// A one-row FTS5 table used to fold the query the way the index folded its
/// text. `content=''` enables `'delete-all'`: `DELETE FROM` only appends
/// tombstones, so the fold would slow down for the life of the tab.
pub const fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold USING fts5(t, content='', tokenize='" ++ tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold_vocab USING fts5vocab('temp','token_fold','row');";

const fold_reset_sql = "INSERT INTO temp.token_fold(token_fold) VALUES('delete-all');";

pub var db: ?*c.sqlite3 = null;
/// Cached so the INSERT is not re-parsed per document.
var add_stmt: ?*c.sqlite3_stmt = null;
var image: ?[*]u8 = null;
var image_len: usize = 0;
/// Bound with `SQLITE_STATIC`, so it must outlive its statement.
pub var match: std.ArrayList(u8) = .empty;
/// `match` with quoted phrases held to their order, for the text rows; empty
/// when the query quotes none.
pub var phrase_match: std.ArrayList(u8) = .empty;
var hits: std.ArrayList(u32) = .empty;
var errbuf: std.ArrayList(u8) = .empty;
/// What the typo ladder substituted, `typed \t matched \n`; cleared by every
/// query so it never outlives its answer.
pub var expansion: std.ArrayList(u8) = .empty;

const no_db: i32 = -c.SQLITE_MISUSE;

/// A rowid carries its kind in its top bits, `rowid >> kind_shift`, so one
/// query answers every kind with a limit and an exact total of its own. Kind
/// 0 is a document page, a set of words; the others are running text.
const kind_shift = 28;
/// Under 2^31 in all, so `idx_hit`'s i32 holds every rowid.
const kinds = 8;
const text_base: i64 = 1 << kind_shift;
const rowid_end: i64 = kinds << kind_shift;
var kind_totals: [kinds]u32 = @splat(0);
var kind_hits: [kinds]u32 = @splat(0);

/// Built without `-DSQLITE_TEMP_STORE=3`; outside SQLite's result-code range.
const bad_build: i32 = -100;

/// Initialises SQLite and refuses if temp storage could reach the null VFS,
/// asking the compiled amalgamation rather than `build.zig`.
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

pub fn setErrDb() void {
    if (db) |h| setErr(std.mem.span(c.sqlite3_errmsg(h))) else setErr("no database");
}

export fn idx_errmsg_ptr() ?[*]const u8 {
    return errbuf.items.ptr;
}

export fn idx_errmsg_len() u32 {
    return @intCast(errbuf.items.len);
}

/// Fresh `:memory:` db plus the FTS5 table; also "start over".
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
    phrase_match.clearRetainingCapacity();
    expansion.clearRetainingCapacity();
}

/// One transaction per build: FTS5 writes a level-0 segment at every COMMIT.
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

/// `doc_id` is the rowid, its kind in the top bits (`kind_shift`); a repeat is
/// a constraint failure, never an overwrite.
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
    // SQLITE_STATIC: the caller's buffer outlives the step, so no copy.
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

/// Builds `match` and, when the query quotes a phrase, `phrase_match` from
/// the raw query, folding each token through the index's tokenizer
/// (`sqlite_core_query.zig`). A token that folds to nothing contributes nothing.
pub fn buildMatch(h: *c.sqlite3, query: []const u8) i32 {
    match.clearRetainingCapacity();
    phrase_match.clearRetainingCapacity();

    const rc = c.sqlite3_exec(h, fold_ddl, null, null, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var s: q.Scan = undefined;
    const rc2 = q.scan(h, arena_state.allocator(), foldToken, query, &s);
    if (rc2 != 0) return rc2;
    q.emit(gpa, &match, s, null, false) catch return -c.SQLITE_NOMEM;
    if (s.hasPhrase()) q.emit(gpa, &phrase_match, s, null, true) catch return -c.SQLITE_NOMEM;
    return 0;
}

/// Every term `tok` folds to, duped from `alloc` (empty for punctuation);
/// `fold_ddl` must have run. Shared by `buildMatch` and the typo ladder so
/// both use one tokenizer. Returns 0 or `-rc`.
pub fn foldToken(
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
        // Duped: the row dies at the next step, and the ladder keeps every term.
        const owned = alloc.dupe(u8, std.mem.span(text)) catch return -c.SQLITE_NOMEM;
        out.append(alloc, owned) catch return -c.SQLITE_NOMEM;
    }
    return 0;
}

/// Returns the exact total; `idx_hit(i)` reads the buffered hits, up to
/// `limit` of each kind (`idx_kind_total`), and -1 past them.
pub export fn idx_query(ptr: [*]const u8, len: usize, limit: u32) i32 {
    const h = db orelse return no_db;
    hits.clearRetainingCapacity();
    @memset(&kind_totals, 0);
    expansion.clearRetainingCapacity();

    const rc0 = buildMatch(h, ptr[0..len]);
    if (rc0 != 0) return rc0;
    if (match.items.len == 0) return 0;

    return runMatch(h, limit);
}

/// Steps `match` (and `phrase_match` over the text rows), buffering up to
/// `limit` rowids of each kind and returning the exact total; shared by the
/// exact and fuzzy passes.
pub fn runMatch(h: *c.sqlite3, limit: u32) i32 {
    hits.clearRetainingCapacity();
    @memset(&kind_totals, 0);
    @memset(&kind_hits, 0);
    if (phrase_match.items.len == 0) return stepRange(h, match.items, 0, rowid_end, limit);
    const pages = stepRange(h, match.items, 0, text_base, limit);
    if (pages < 0) return pages;
    const text = stepRange(h, phrase_match.items, text_base, rowid_end, limit);
    if (text < 0) return text;
    return pages + text;
}

/// One MATCH over the rowids `[lo, hi)`, best ranked first.
fn stepRange(h: *c.sqlite3, expr: []const u8, lo: i64, hi: i64, limit: u32) i32 {
    var stmt: ?*c.sqlite3_stmt = null;
    var rc = c.sqlite3_prepare_v2(h, "SELECT rowid FROM docs WHERE docs MATCH ?1 AND rowid >= ?2 AND rowid < ?3 ORDER BY rank", -1, &stmt, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    defer _ = c.sqlite3_finalize(stmt);
    rc = c.sqlite3_bind_text(stmt, 1, expr.ptr, @intCast(expr.len), null);
    if (rc == c.SQLITE_OK) rc = c.sqlite3_bind_int64(stmt, 2, lo);
    if (rc == c.SQLITE_OK) rc = c.sqlite3_bind_int64(stmt, 3, hi);
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
        const rowid: u32 = @intCast(c.sqlite3_column_int64(stmt, 0));
        const kind = rowid >> kind_shift;
        if (kind_hits[kind] < limit) {
            hits.append(gpa, rowid) catch return -c.SQLITE_NOMEM;
            kind_hits[kind] += 1;
        }
        kind_totals[kind] += 1;
        total += 1;
    }
    return total;
}

/// The last query's exact total for one kind of row (`rowid >> 28`).
export fn idx_kind_total(kind: u32) i32 {
    if (kind >= kinds) return 0;
    return @intCast(kind_totals[kind]);
}

/// Removes one row: a to-do or digest changed, a name went. A missing rowid is no error.
export fn idx_delete(rowid: u32) i32 {
    const h = db orelse return no_db;
    var s: ?*c.sqlite3_stmt = null;
    var rc = c.sqlite3_prepare_v2(h, "DELETE FROM docs WHERE rowid = ?1", -1, &s, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    defer _ = c.sqlite3_finalize(s);
    rc = c.sqlite3_bind_int64(s, 1, @intCast(rowid));
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    rc = c.sqlite3_step(s);
    if (rc != c.SQLITE_DONE) {
        setErrDb();
        return -rc;
    }
    return 0;
}

export fn idx_hit(i: u32) i32 {
    if (i >= hits.items.len) return -1;
    return @intCast(hits.items[i]);
}

/// Serializes `main` to `idx_image_ptr()` until the next serialize or close.
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

/// A deserialize target on SQLite's heap.
export fn idx_image_alloc(len: usize) ?[*]u8 {
    // Often the first call into SQLite (restoring from IndexedDB).
    if (c.sqlite3_initialize() != c.SQLITE_OK) return null;
    return @ptrCast(c.sqlite3_malloc64(@intCast(len)));
}

/// Restores an `idx_serialize` image from `idx_image_alloc`; SQLite takes
/// ownership. No copy.
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

test {
    _ = sqlite_core_fuzzy;
}

comptime {
    _ = sqlite_core_fuzzy; // its `export fn`s are part of the wasm ABI
}
