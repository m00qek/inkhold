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
const gpa = if (builtin.target.cpu.arch.isWasm())
    std.heap.wasm_allocator
else
    std.heap.page_allocator;

/// The server's FTS5 tokenizer (`backend/db/schema.zig`), so queries fold
/// exactly as the shipped terms did.
const tokenizer = @import("schema").fts_tokenizer;

/// Bump when `index_ddl` or `tokenizer` changes: stored images go stale with
/// nothing server-side moving.
const schema_version: u32 = 1;

/// No `prefix=`: prefix queries measured fast without one, and it would grow
/// the stored image.
const index_ddl = "CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='" ++ tokenizer ++ "');";

/// A one-row FTS5 table used to fold the query the way the index folded its
/// text. `content=''` enables `'delete-all'`: `DELETE FROM` only appends
/// tombstones, so the fold would slow down for the life of the tab.
const fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold USING fts5(t, content='', tokenize='" ++ tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold_vocab USING fts5vocab('temp','token_fold','row');";

const fold_reset_sql = "INSERT INTO temp.token_fold(token_fold) VALUES('delete-all');";

var db: ?*c.sqlite3 = null;
/// Cached so the INSERT is not re-parsed per document.
var add_stmt: ?*c.sqlite3_stmt = null;
var image: ?[*]u8 = null;
var image_len: usize = 0;
/// Bound with `SQLITE_STATIC`, so it must outlive its statement.
var match: std.ArrayList(u8) = .empty;
var hits: std.ArrayList(u32) = .empty;
var errbuf: std.ArrayList(u8) = .empty;
/// What the typo ladder substituted, `typed \t matched \n`; cleared by every
/// query so it never outlives its answer.
var expansion: std.ArrayList(u8) = .empty;

const no_db: i32 = -c.SQLITE_MISUSE;

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

fn setErrDb() void {
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

/// `doc_id` is the rowid; a repeat is a constraint failure, never an overwrite.
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

/// Appends `term` as a quoted FTS5 string, doubling `"` so the expression is
/// safe regardless of tokenizer.
fn appendQuoted(term: []const u8) !void {
    try match.append(gpa, '"');
    for (term) |ch| {
        if (ch == '"') try match.append(gpa, '"');
        try match.append(gpa, ch);
    }
    try match.append(gpa, '"');
}

/// Builds `match` from the raw query, folding each token through the index's
/// tokenizer. Terms are ANDed; only the last gets `*`, and not after trailing
/// whitespace. A token that folds to nothing contributes nothing.
fn buildMatch(h: *c.sqlite3, query: []const u8) i32 {
    match.clearRetainingCapacity();

    var rc = c.sqlite3_exec(h, fold_ddl, null, null, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }

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

/// Every term `tok` folds to, duped from `alloc` (empty for punctuation);
/// `fold_ddl` must have run. Shared by `buildMatch` and the typo ladder so
/// both use one tokenizer. Returns 0 or `-rc`.
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
        // Duped: the row dies at the next step, and the ladder keeps every term.
        const owned = alloc.dupe(u8, std.mem.span(text)) catch return -c.SQLITE_NOMEM;
        out.append(alloc, owned) catch return -c.SQLITE_NOMEM;
    }
    return 0;
}

/// Returns the exact total; `idx_hit(i)` reads the first `min(total, limit)`.
export fn idx_query(ptr: [*]const u8, len: usize, limit: u32) i32 {
    const h = db orelse return no_db;
    hits.clearRetainingCapacity();
    expansion.clearRetainingCapacity();

    const rc0 = buildMatch(h, ptr[0..len]);
    if (rc0 != 0) return rc0;
    if (match.items.len == 0) return 0;

    return runMatch(h, limit);
}

/// Steps `match`, buffering `limit` rowids and returning the exact total;
/// shared by the exact and fuzzy passes.
fn runMatch(h: *c.sqlite3, limit: u32) i32 {
    hits.clearRetainingCapacity();

    var stmt: ?*c.sqlite3_stmt = null;
    var rc = c.sqlite3_prepare_v2(h, "SELECT rowid FROM docs WHERE docs MATCH ?1 ORDER BY rank", -1, &stmt, null);
    if (rc != c.SQLITE_OK) {
        setErrDb();
        return -rc;
    }
    defer _ = c.sqlite3_finalize(stmt);
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

// ---- typo tolerance: a fallback, never a widening ----
// The corpus is device handwriting recognition, so it is misspelt too. Done in
// wasm so folding and codepoints match the index, over the index's own
// vocabulary. Each fallback scans the whole vocabulary, linear in V with capped
// distance and shortlist; a much larger vocabulary needs an n-gram index, not a
// bigger cap.

/// Ceiling on terms one search may add; usually only one or two survive
/// ranking.
const max_fuzzy_terms: usize = 32;

/// Longer tokens stay exact; also sizes `editDistance`'s stack rows.
const max_fuzzy_term_cp: usize = 64;

/// `fts5vocab` over the index's terms, created per call: a deserialized
/// connection has no temp tables.
const vocab_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.docs_vocab USING fts5vocab('main','docs','row');";

const vocab_select_sql = "SELECT term FROM temp.docs_vocab;";

/// Allowed edits by token length in codepoints: 0 up to 3, then 1, then 2. A
/// flat threshold would let short tokens match almost anything.
fn maxEdits(len: usize) usize {
    if (len <= 3) return 0;
    if (len <= 7) return 1;
    return 2;
}

/// A near-miss, with what ranks it.
const Candidate = struct {
    term: []const u8,
    dist: usize,
    /// Length difference in codepoints; see `betterCandidate`.
    delta: usize,
};

/// Ranks two near-misses: smaller distance, then smaller length difference
/// (`tset` prefers `test` over `set`), then byte order so results don't depend
/// on `fts5vocab` iteration order.
fn betterCandidate(a: Candidate, b: Candidate) bool {
    if (a.dist != b.dist) return a.dist < b.dist;
    if (a.delta != b.delta) return a.delta < b.delta;
    return std.mem.order(u8, a.term, b.term) == .lt;
}

const FuzzyToken = struct {
    /// As typed, for the UI.
    raw: []const u8,
    terms: []const []const u8,
    /// The term when the token folded to exactly one and the ladder allows
    /// edits; only then can it expand.
    term: ?[]const u8,
    prefix: bool,
    /// `raw`'s length in term-codepoints.
    len: usize,
    /// `term`'s length in codepoints, for `delta`.
    term_len: usize,
    budget: usize,
    cands: std.ArrayList(Candidate) = .empty,
    alts: std.ArrayList([]const u8) = .empty,
};

/// Offers a near-miss, keeping the list sorted and at most `cap` long so the
/// scan stays linear. `cand.term` is borrowed and duped only if kept.
fn offer(alloc: std.mem.Allocator, t: *FuzzyToken, cap: usize, cand: Candidate) !void {
    if (cap == 0) return;
    var i: usize = 0;
    while (i < t.cands.items.len and !betterCandidate(cand, t.cands.items[i])) : (i += 1) {}
    if (i >= cap) return;

    var owned = cand;
    owned.term = try alloc.dupe(u8, cand.term);
    if (t.cands.items.len < cap) {
        try t.cands.insert(alloc, i, owned);
    } else {
        var j = t.cands.items.len - 1;
        while (j > i) : (j -= 1) t.cands.items[j] = t.cands.items[j - 1];
        t.cands.items[i] = owned;
    }
}

/// Rebuilds `match` with an OR-group per expanded token and records
/// `expansion`. Returns 1 if widened, 0 if not (the caller must not re-run), or
/// `-rc`. AND is explicit because FTS5 rejects `"a" ("b" OR "c")`. Only the
/// best-ranked tier joins a group: bm25 would score `set` like `test`.
/// Vocabulary terms are quoted too.
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
    // Same `*` rule as `buildMatch`, on the last token that produced a term.
    if (query.len != 0 and !std.ascii.isWhitespace(query[query.len - 1])) {
        var i = tokens.items.len;
        while (i > 0) : (i -= 1) {
            if (tokens.items[i - 1].terms.len != 0) {
                tokens.items[i - 1].prefix = true;
                break;
            }
        }
    }
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
            // While typing, compare against the vocabulary term truncated to the
            // typed length, or a typo mid-word is out of reach.
            const cand = if (t.prefix) truncCodepoints(vterm, t.len) else vterm;
            const d = editDistance(term, cand, t.budget) orelse continue;
            if (d == 0) continue;
            const cand_len = cpLen(cand);
            offer(arena, t, max_fuzzy_terms, .{
                .term = vterm,
                .dist = d,
                .delta = if (cand_len > t.term_len) cand_len - t.term_len else t.term_len - cand_len,
            }) catch return -c.SQLITE_NOMEM;
        }
    }

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

    // The budget is shared round-robin, so one word can't consume it all.
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
            for (t.terms, 0..) |term, i| {
                appendAnd() catch return -c.SQLITE_NOMEM;
                appendQuoted(term) catch return -c.SQLITE_NOMEM;
                if (t.prefix and i + 1 == t.terms.len) match.append(gpa, '*') catch return -c.SQLITE_NOMEM;
            }
            continue;
        }
        appendAnd() catch return -c.SQLITE_NOMEM;
        match.append(gpa, '(') catch return -c.SQLITE_NOMEM;
        appendQuoted(t.terms[0]) catch return -c.SQLITE_NOMEM;
        if (t.prefix) match.append(gpa, '*') catch return -c.SQLITE_NOMEM;
        for (t.alts.items) |alt| {
            match.appendSlice(gpa, " OR ") catch return -c.SQLITE_NOMEM;
            appendQuoted(alt) catch return -c.SQLITE_NOMEM;
            expansion.appendSlice(gpa, t.raw) catch return -c.SQLITE_NOMEM;
            expansion.append(gpa, '\t') catch return -c.SQLITE_NOMEM;
            expansion.appendSlice(gpa, alt) catch return -c.SQLITE_NOMEM;
            expansion.append(gpa, '\n') catch return -c.SQLITE_NOMEM;
        }
        match.append(gpa, ')') catch return -c.SQLITE_NOMEM;
    }
    return 1;
}

fn appendAnd() !void {
    if (match.items.len != 0) try match.appendSlice(gpa, " AND ");
}

/// `idx_query` with the typo ladder, which runs only when the exact pass found
/// nothing; otherwise identical.
export fn idx_fuzzy(ptr: [*]const u8, len: usize, limit: u32) i32 {
    const h = db orelse return no_db;

    const total = idx_query(ptr, len, limit);
    if (total != 0) return total;

    const rc = buildFuzzyMatch(h, ptr[0..len]);
    if (rc <= 0) return rc;
    return runMatch(h, limit);
}

export fn idx_expansion_ptr() ?[*]const u8 {
    return expansion.items.ptr;
}

export fn idx_expansion_len() u32 {
    return @intCast(expansion.items.len);
}

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

/// Decodes `s` into codepoints; invalid bytes count as one codepoint each.
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

/// Damerau-Levenshtein (optimal string alignment) distance in codepoints, or
/// null past `budget`. Swaps cost one edit. OSA's restriction is irrelevant
/// within two edits and needs one extra row, not an alphabet table. The
/// row-minimum early exit stays valid with transpositions.
fn editDistance(a: []const u8, b: []const u8, budget: usize) ?usize {
    var abuf: [max_fuzzy_term_cp]u21 = undefined;
    var bbuf: [max_fuzzy_term_cp]u21 = undefined;
    const x = codepoints(&abuf, a);
    const y = codepoints(&bbuf, b);

    const diff = if (x.len > y.len) x.len - y.len else y.len - x.len;
    if (diff > budget) return null;

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

/// Codepoint count by `codepoints`' rule.
fn cpLen(s: []const u8) usize {
    var buf: [max_fuzzy_term_cp]u21 = undefined;
    return codepoints(&buf, s).len;
}

/// Codepoints of `tok` that `unicode61` keeps as term characters.
fn termLen(tok: []const u8) usize {
    var n: usize = 0;
    for (tok) |ch| {
        if (ch & 0xC0 == 0x80) continue;
        if (std.ascii.isAlphanumeric(ch) or ch >= 0x80) n += 1;
    }
    return n;
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
