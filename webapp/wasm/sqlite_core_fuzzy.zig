//! Typo tolerance for the search core: a fallback MATCH, never a widening of an exact one.

const std = @import("std");
const spd = @import("spd");
const c = spd.sqlite.c;
const no_db: i32 = -c.SQLITE_MISUSE;
const sqlite_core = @import("sqlite_core.zig");
const appendQuoted = sqlite_core.appendQuoted;
const buildMatch = sqlite_core.buildMatch;
const foldToken = sqlite_core.foldToken;
const fold_ddl = sqlite_core.fold_ddl;
const gpa = sqlite_core.gpa;
const idx_query = sqlite_core.idx_query;
const runMatch = sqlite_core.runMatch;
const setErrDb = sqlite_core.setErrDb;

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

    sqlite_core.match.clearRetainingCapacity();
    sqlite_core.expansion.clearRetainingCapacity();
    for (tokens.items) |t| {
        if (t.alts.items.len == 0) {
            for (t.terms, 0..) |term, i| {
                appendAnd() catch return -c.SQLITE_NOMEM;
                appendQuoted(term) catch return -c.SQLITE_NOMEM;
                if (t.prefix and i + 1 == t.terms.len) sqlite_core.match.append(gpa, '*') catch return -c.SQLITE_NOMEM;
            }
            continue;
        }
        appendAnd() catch return -c.SQLITE_NOMEM;
        sqlite_core.match.append(gpa, '(') catch return -c.SQLITE_NOMEM;
        appendQuoted(t.terms[0]) catch return -c.SQLITE_NOMEM;
        if (t.prefix) sqlite_core.match.append(gpa, '*') catch return -c.SQLITE_NOMEM;
        for (t.alts.items) |alt| {
            sqlite_core.match.appendSlice(gpa, " OR ") catch return -c.SQLITE_NOMEM;
            appendQuoted(alt) catch return -c.SQLITE_NOMEM;
            sqlite_core.expansion.appendSlice(gpa, t.raw) catch return -c.SQLITE_NOMEM;
            sqlite_core.expansion.append(gpa, '\t') catch return -c.SQLITE_NOMEM;
            sqlite_core.expansion.appendSlice(gpa, alt) catch return -c.SQLITE_NOMEM;
            sqlite_core.expansion.append(gpa, '\n') catch return -c.SQLITE_NOMEM;
        }
        sqlite_core.match.append(gpa, ')') catch return -c.SQLITE_NOMEM;
    }
    return 1;
}

fn appendAnd() !void {
    if (sqlite_core.match.items.len != 0) try sqlite_core.match.appendSlice(gpa, " AND ");
}

/// `idx_query` with the typo ladder, which runs only when the exact pass found
/// nothing; otherwise identical.
export fn idx_fuzzy(ptr: [*]const u8, len: usize, limit: u32) i32 {
    const h = sqlite_core.db orelse return no_db;

    const total = idx_query(ptr, len, limit);
    if (total != 0) return total;

    const rc = buildFuzzyMatch(h, ptr[0..len]);
    if (rc <= 0) return rc;
    return runMatch(h, limit);
}

export fn idx_expansion_ptr() ?[*]const u8 {
    return sqlite_core.expansion.items.ptr;
}

export fn idx_expansion_len() u32 {
    return @intCast(sqlite_core.expansion.items.len);
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
