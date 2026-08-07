//! The search package's self-contained leaf: the fuzzy fallback (`buildFuzzyMatch`
//! + `editDistance` + the ranked candidate scan + the entry-8b `VocabSource` pool
//! selector) and the shared tokenizer/fold primitives (`fold_ddl`/`foldRows`/
//! `foldTerms`, `appendToken`, `termLen`, `fts_tokenizer`, `min_prefix_len`) that
//! the primary read expression and the counting pass both fold through. Both
//! `query.zig` (reads) and `maintain.zig` (writes) build on this module; it
//! imports neither. The reads and writes of `segment_fts` itself stay there.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");

/// How many term characters the word being typed must carry before it is
/// searched as a prefix. A one-character prefix matches very nearly the whole
/// index: expensive to score and useless as a result set (every note that
/// contains a word starting with "a"). Two is the conventional floor and is
/// where a prefix starts to discriminate. It gates ONLY the `*`; a one-letter
/// token is still searched, just as an exact term.
pub const min_prefix_len: usize = 2;

// ---------------------------------------------------------------------------
// Typo tolerance — a FALLBACK, never a widening
// ---------------------------------------------------------------------------

// Why this exists at all: the searchable text is the device's own handwriting
// recognition, so the CORPUS is misspelt, not just the query. "Danie Witches.
// Arch Interview" and "usar infra-set dá trabalho!" are real rows. Exact
// matching therefore fails even when the user types the word correctly, which
// is a stronger case than ordinary typo tolerance.
//
// `spellfix1`, `editdist3` and `soundex` are not in this build, and vendoring
// spellfix1 was rejected: its phonetics are English-oriented, the same reason
// the `porter` stemmer was rejected for a Portuguese corpus. So the index's own
// vocabulary (`fts5vocab`) is pulled out and the distance is computed here.
//
// ## SCALING ASSUMPTION — read this before reusing the code
//
// Every fallback search scans the ENTIRE vocabulary of the FTS index, once,
// comparing each term against each query token. That is fine here and only
// here: this server holds one household's notes (71 distinct terms in the live
// library today), the scan happens only on searches that already returned
// nothing, and the whole thing is behind a per-search term cap. A large or
// multi-tenant index would need this replaced — an n-gram or deletion-neighbour
// index, or a real fuzzy extension — NOT merely a bigger cap. The linear scan
// is the part that does not survive growth.
//
// The cost is `O(V · T · (L² + cap))` for a vocabulary of V terms and T query
// tokens of at most L codepoints: one bounded distance computation per pair,
// plus a bounded insertion into that token's ranked shortlist when the term is
// near enough to be a candidate at all. Both the distance and the shortlist are
// capped by constants, so the scan is LINEAR in V and stays linear — which
// matters more than it looks, because this server takes a coarse global DB lock
// around a request: a scan that went quadratic in vocabulary size would not
// merely make search slow, it would stall device sync behind it.
//
// Note also that the vocabulary is global: terms come from every user's notes,
// because the FTS index is keyed by deduplicated blob md5. That is not a leak —
// the expanded terms are only ever fed back through `search_sql`, whose `files`
// join still restricts every returned row to the caller's own, undeleted notes.
// A term drawn from someone else's note can widen the search but can never
// produce a row the caller was not already entitled to see.

/// How many vocabulary terms one search may add. bm25 over a hundred OR'd terms
/// is not a ranking, it is noise — and each extra term is another posting list
/// to merge. 32 is far more than a real typo needs (a misspelt word has a
/// handful of near neighbours, not dozens) while keeping the MATCH expression
/// small enough to stay debuggable in a log line.
///
/// It is a CEILING, not a target. What the expansion actually offers is the
/// best-ranked tier and nothing else (see `betterCandidate`), which in practice
/// is one or two terms; the cap only decides what happens when a query has more
/// equally-good readings than are worth searching for.
pub const max_fuzzy_terms: usize = 32;

/// Longest token, in codepoints, the distance function will consider. Past this
/// the token is left exact: a 64-character "word" is not a typo.
pub const max_fuzzy_term_cp: usize = 64;

/// MUST stay identical to the `tokenize=` of `segment_fts` in `schema.zig`.
/// The fold below runs the user's token through a temp table with this exact
/// tokenizer so that "calígrafa" and "caligrafa" reach the distance function as
/// the same string — the same folding `remove_diacritics 2` already applied to
/// the vocabulary. A test asserts the two spellings have not drifted apart.
pub const fts_tokenizer = "unicode61 remove_diacritics 2";

/// The edit distance a token of `len` term-codepoints tolerates.
///
/// "Edit" here is `editDistance`'s, i.e. Damerau-Levenshtein: a swap of two
/// adjacent characters costs ONE, like an insertion or a deletion. The rungs
/// below are unchanged by that — what changes is which words a rung can reach,
/// not how far it reaches.
///
/// The threshold MUST scale with length. One edit on a four-letter word is a
/// huge net — "casa" reaches casa/cara/caso/asa/cama and on — while one edit on
/// a twelve-letter word is very nearly the word itself. A flat threshold makes
/// short tokens match almost anything, which is exactly the precision loss this
/// whole design is trying to avoid. The 0 / 1 / 2 ladder is the conventional
/// one, and the ≤3 rung means short tokens get NO expansion at all: at that
/// length a single edit is not a typo signal, it is a different word.
///
/// `len` is counted by `termLen`, i.e. in CODEPOINTS — the corpus is Portuguese,
/// and "ção" must be three characters and not five.
pub fn maxEdits(len: usize) usize {
    if (len <= 3) return 0;
    if (len <= 7) return 1;
    return 2;
}

/// One vocabulary term the scan found near a query token, with the two numbers
/// that decide whether it is a BETTER guess than another one.
pub const Candidate = struct {
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
///      transposition from a deletion at the same distance, and it is why
///      `tset` prefers `test` over `set`: both are one edit away, but the swap
///      preserves length (delta 0) while dropping the leading `t` does not
///      (delta 1). Somebody who typed four characters more probably meant a
///      four-character word than a three-character one.
///   3. **Then the term itself, byte order.** Not meaningful, deliberately — it
///      exists so that two candidates the first two rules cannot separate are
///      still ordered the SAME WAY on every run. Without it the survivors of the
///      cap would depend on `fts5vocab` iteration order, i.e. on which note
///      happened to be uploaded first, and the same query would answer
///      differently before and after an unrelated sync.
pub fn betterCandidate(a: Candidate, b: Candidate) bool {
    if (a.dist != b.dist) return a.dist < b.dist;
    if (a.delta != b.delta) return a.delta < b.delta;
    return std.mem.order(u8, a.term, b.term) == .lt;
}

/// Offers one near-miss to a token, keeping its list sorted by `betterCandidate`
/// and never longer than `cap`.
///
/// A BOUNDED insertion sort rather than "collect everything, then sort": the
/// scan walks the whole vocabulary, and a query whose budget happens to admit
/// most of it would otherwise materialise the whole vocabulary per token before
/// throwing nearly all of it away. Here the list is at most `cap` long at every
/// moment, so the extra work per accepted candidate is `O(cap)` and the extra
/// memory is `O(cap)` — the scan stays linear in vocabulary size, which is the
/// property the scaling note above depends on.
///
/// `c.term` is BORROWED (a live `fts5vocab` row); it is duped only if it is
/// actually kept, so a rejected candidate costs no allocation at all.
fn offer(arena: std.mem.Allocator, t: *FuzzyToken, cap: usize, c: Candidate) !void {
    if (cap == 0) return;
    var i: usize = 0;
    while (i < t.cands.items.len and !betterCandidate(c, t.cands.items[i])) : (i += 1) {}
    // Worse than everything already held, with no room left to hold it.
    if (i >= cap) return;

    var owned = c;
    owned.term = try arena.dupe(u8, c.term);
    if (t.cands.items.len < cap) {
        try t.cands.insert(arena, i, owned);
    } else {
        // Full: the worst entry falls off the end to make room.
        var j = t.cands.items.len - 1;
        while (j > i) : (j -= 1) t.cands.items[j] = t.cands.items[j - 1];
        t.cands.items[i] = owned;
    }
}

/// One query token on the fallback path.
const FuzzyToken = struct {
    /// The raw token, quoted exactly as the primary pass quotes it.
    raw: []const u8,
    /// Whether the primary pass would prefix-match this token.
    prefix: bool,
    /// The token as the FTS5 tokenizer sees it (folded, diacritics removed), or
    /// null when it is not a single searchable term — punctuation, or something
    /// that splits into several terms. Such tokens are never expanded.
    term: ?[]const u8,
    len: usize,
    /// `term`'s length in codepoints, for the ranking's `delta`. Kept beside
    /// `len` (which counts the RAW token) so the comparison is folded-against-
    /// folded, exactly like the distance itself.
    term_len: usize,
    budget: usize,
    /// Near-misses found by the scan, kept sorted by `betterCandidate` and never
    /// longer than the cap.
    cands: std.ArrayList(Candidate) = .empty,
    /// The candidates that survived ranking and the shared cap, in rank order —
    /// what actually goes into the expression.
    alts: std.ArrayList([]const u8) = .empty,
};

/// Where the fuzzy ladder draws its CANDIDATE TERMS from — the pool a typo is
/// ranked against. This is the ONLY thing that differs between global and
/// in-document fuzzy: the ladder, the edit-distance, the ranking and the
/// re-MATCH are byte-identical whichever source is chosen (`buildFuzzyMatch`
/// never forks). Narrowing the SOURCE is what makes in-doc fuzzy O(document)
/// without changing which corrections it can find — a correction absent from a
/// document cannot MATCH inside it, so the document's own term set is
/// result-identical to the whole corpus for a search scoped to that document
/// (entry 8b).
pub const VocabSource = union(enum) {
    /// The whole-corpus vocabulary — `fts5vocab(row)` over every term the FTS
    /// index holds. Global search (`searchPages`) keeps this source.
    corpus,
    /// One open document's own distinct terms — an index SEEK into `doc_terms`.
    /// The two in-document reads (`searchNotePages`, `searchTxtSegments`) pass
    /// this so the pool is the note's few-hundred terms, not the library's.
    doc: DocScope,
};

/// Identifies the open document whose term set scopes an in-doc fuzzy pool. The
/// `files` gate is re-applied on the `doc_terms` read (defense in depth — the
/// same ownership boundary the search itself enforces), so a foreign, trashed
/// or non-existent note derives an EMPTY pool and offers no corrections.
pub const DocScope = struct {
    /// The open note's `files.id`.
    note_id: u64,
    /// Its owner — the same id the search's `files` join gates on.
    user_id: u64,
    /// The owner's active search partition — `doc_terms`' first key column, so
    /// "the terms of this document" is a primary-key seek.
    partition_id: i64,
};

/// Prepares the statement that yields the fuzzy candidate terms for `src`. The
/// corpus source is the whole-index `fts5vocab` SCAN; the doc source is a
/// primary-key SEEK into `doc_terms` (EXPLAIN-pinned), scoped to one note and
/// re-gated by the `files` join. The returned statement is stepped by
/// `buildFuzzyMatch` exactly the same way for both — the matcher does not know
/// or care which source it drew from.
fn prepareVocab(db: sqlite.Db, src: VocabSource) !sqlite.Stmt {
    switch (src) {
        .corpus => {
            try db.exec(vocab_ddl);
            return db.prepare(vocab_select_sql);
        },
        .doc => |d| {
            var s = try db.prepare(doc_terms_select_sql);
            s.bindInt(1, d.partition_id);
            s.bindInt(2, @intCast(d.note_id));
            s.bindInt(3, @intCast(d.user_id));
            return s;
        },
    }
}

/// A widened MATCH expression, plus the vocabulary terms that widened it.
pub const Expansion = struct {
    /// The expression to re-run the search with.
    match: []const u8,
    /// Every term the vocabulary scan spliced in, flattened across tokens.
    ///
    /// Already FOLDED — they come straight out of `fts5vocab`, which holds the
    /// index's own post-tokenizer terms — so they are directly comparable with
    /// what a page's text folds to. `searchPages` ignores them (its highlight is
    /// `snippet()`'s, produced by FTS5 itself); `searchNotePages` needs them to
    /// report WHICH near-miss it counted, because that is what the reader draws
    /// an oval round.
    alts: []const []const u8,
};

/// Expands `query` into an FTS5 MATCH that also accepts near-misses, or null
/// when there is nothing to expand (in which case the caller must NOT re-run:
/// the expression would be byte-identical to the primary one that just returned
/// nothing).
///
/// The shape is the primary expression with an OR-group spliced in per token:
///
///     primary:  "funciona" "caligrafa"*
///     fuzzy:    "funciona" ("caligrafa"* OR "caligrafia")
///
/// so the AND between tokens is preserved and every term — including the ones
/// read out of `fts5vocab` — goes through the same quoting as before.
///
/// ## What goes into the OR-group is RANKED, not merely near enough
///
/// Every vocabulary term inside a token's budget is a candidate, but only the
/// best tier is offered: `betterCandidate` orders them and everything the
/// ordering can separate from the winner is dropped. Widening to the whole
/// budget was how `tset` came back with `set` — one deletion away, exactly as
/// `test` is one transposition away — and once both are in the group bm25 scores
/// them alike, because it has no notion that one is a likelier reading of what
/// was typed. Genuinely tied candidates all survive ("cala" really is equally
/// close to casa, cara and cama); a worse one does not.
///
/// Terms from
/// the vocabulary are index-derived rather than user-typed, but they are quoted
/// anyway: expansion must not become a second, unaudited path into the parser,
/// and defence in depth costs nothing here.
pub fn buildFuzzyMatch(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    query: []const u8,
    still_typing: bool,
    cap: usize,
    src: VocabSource,
) !?Expansion {
    var tokens: std.ArrayList(FuzzyToken) = .empty;
    var it = std.mem.tokenizeAny(u8, query, " \t\r\n");
    var expandable = false;
    while (it.next()) |tok| {
        const len = termLen(tok);
        const budget = if (len <= max_fuzzy_term_cp) maxEdits(len) else 0;
        const term = if (budget > 0) try foldToken(arena, db, tok) else null;
        if (term != null) expandable = true;
        try tokens.append(arena, .{
            .raw = tok,
            .prefix = still_typing and it.peek() == null and len >= min_prefix_len,
            .term = term,
            .len = len,
            .term_len = if (term) |t| cpLen(t) else 0,
            .budget = budget,
        });
    }
    // Every token is too short (or unfoldable) to expand: the fallback has
    // nothing to offer that the primary pass did not already try.
    if (!expandable) return null;

    // The candidate pool — corpus-wide or scoped to the open document. Only
    // where the terms COME FROM changes; everything below is identical.
    var vocab = try prepareVocab(db, src);
    defer vocab.finalize();
    while (try vocab.step()) {
        const vterm = vocab.columnText(0);
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
            try offer(arena, t, cap, .{
                .term = vterm,
                .dist = d,
                // Measured against the string the DISTANCE was measured against,
                // so the truncated mid-typing candidate is compared on the same
                // footing as the whole term.
                .delta = if (cand_len > t.term_len) cand_len - t.term_len else t.term_len - cand_len,
            });
        }
    }

    // Only the BEST tier survives. Offering everything inside the budget is what
    // let `tset` come back with `set` alongside `test`: both are one edit away,
    // and once both are in the OR-group bm25 has no idea one of them is a better
    // reading of what was typed. Keeping only the candidates the ranking cannot
    // separate from the winner is the difference between "near enough" and "the
    // closest thing the vocabulary has".
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

    // `cap` is a budget for the whole SEARCH, so a multi-token query shares it
    // round-robin: every token gets its best candidate before any token gets its
    // second. Taking tokens in order instead would let one misspelt word eat the
    // budget and leave the next unexpanded.
    var added: usize = 0;
    var round: usize = 0;
    outer: while (true) : (round += 1) {
        var progressed = false;
        for (tokens.items) |*t| {
            if (round >= t.cands.items.len) continue;
            if (added >= cap) break :outer;
            try t.alts.append(arena, t.cands.items[round].term);
            added += 1;
            progressed = true;
        }
        if (!progressed) break;
    }
    if (added == 0) return null;

    var out: std.ArrayList(u8) = .empty;
    var alts: std.ArrayList([]const u8) = .empty;
    for (tokens.items) |t| {
        // EXPLICIT `AND`, unlike the primary pass. FTS5 only lets the operator be
        // omitted between two phrases; `"a" ("b" OR "c")` is a syntax error, so
        // the moment a token becomes a parenthesised group the AND has to be
        // written out. Same meaning, and the primary expression is untouched.
        if (out.items.len != 0) try out.appendSlice(arena, " AND ");
        if (t.alts.items.len == 0) {
            try appendToken(arena, &out, t.raw, t.prefix);
            continue;
        }
        try out.append(arena, '(');
        try appendToken(arena, &out, t.raw, t.prefix);
        for (t.alts.items) |alt| {
            try out.appendSlice(arena, " OR ");
            try appendToken(arena, &out, alt, false);
            try alts.append(arena, alt);
        }
        try out.append(arena, ')');
    }
    // Collected from the SAME loop that writes the expression, so the reported
    // terms cannot name anything the search was not actually widened by.
    return .{ .match = out.items, .alts = alts.items };
}

/// Appends one token to a MATCH expression, double-quoted so every character in
/// it is a literal, with the FTS5 prefix `*` OUTSIDE the closing quote when
/// asked. Shared by the primary pass, the expansion and the re-ranker precisely
/// so the three cannot drift apart on escaping.
pub fn appendToken(arena: std.mem.Allocator, out: *std.ArrayList(u8), tok: []const u8, prefix: bool) !void {
    try out.append(arena, '"');
    // Inside an FTS5 string a literal `"` is written `""`.
    for (tok) |ch| {
        if (ch == '"') try out.append(arena, '"');
        try out.append(arena, ch);
    }
    try out.append(arena, '"');
    if (prefix) try out.append(arena, '*');
}

const vocab_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.segment_vocab " ++
    "USING fts5vocab('main','segment_fts','row');";

const vocab_select_sql = "SELECT term FROM temp.segment_vocab;";

/// The DOC-scoped candidate pool: one document's own distinct terms, an index
/// SEEK into `doc_terms` on its `(partition_id, blob_md5)` key prefix (the
/// `files` join resolves the note id to its blob and RE-APPLIES the ownership
/// gate — a foreign/trashed note reads back nothing). EXPLAIN-pinned to
/// `SEARCH … USING … PRIMARY KEY`, never the whole-corpus `fts5vocab` SCAN.
/// `?1` partition id, `?2` note id, `?3` owner id.
pub const doc_terms_select_sql =
    "SELECT dt.term FROM doc_terms dt " ++
    "JOIN files f ON f.md5 = dt.blob_md5 " ++
    "WHERE dt.partition_id = ?1 AND f.id = ?2 AND f.user_id = ?3 " ++
    "AND f.deleted = 0 AND f.is_folder = 0;";

/// A one-row FTS5 table with the SAME tokenizer as the index, used purely to
/// see an arbitrary string the way the index saw its own text. Shared by the
/// fuzzy fold and by find-in-note's counting, so there is one tokenizer
/// declaration rather than two that could drift.
pub const fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold USING fts5(t, tokenize='" ++ fts_tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold_vocab USING fts5vocab('temp','token_fold','row');";

/// Tokenizes `text` and returns a LIVE statement over its `(term, doc, cnt)`
/// vocabulary. The caller steps it and MUST finalize it.
///
/// Returning the statement rather than a slice is what lets the counting path
/// avoid materialising a page's whole vocabulary just to add up a few terms.
pub fn foldRows(db: sqlite.Db, text: []const u8) !sqlite.Stmt {
    try db.exec(fold_ddl);
    try db.exec("DELETE FROM temp.token_fold;");
    {
        var s = try db.prepare("INSERT INTO temp.token_fold(rowid, t) VALUES(1, ?1);");
        defer s.finalize();
        s.bindText(1, text);
        _ = try s.step();
    }
    return db.prepare("SELECT term, cnt FROM temp.token_fold_vocab;");
}

/// Every term `tok` tokenizes to, in vocabulary order. Empty for punctuation.
pub fn foldTerms(arena: std.mem.Allocator, db: sqlite.Db, tok: []const u8) ![]const []const u8 {
    var s = try foldRows(db, tok);
    defer s.finalize();
    var out: std.ArrayList([]const u8) = .empty;
    while (try s.step()) try out.append(arena, try arena.dupe(u8, s.columnText(0)));
    return out.items;
}

/// Runs `tok` through the index's own tokenizer and returns the single term it
/// produces, or null if it produces none (punctuation) or several.
///
/// Doing it with the tokenizer rather than a hand-written folding table is the
/// whole point: `remove_diacritics 2` has a specific mapping, and a second
/// implementation of it here would be one more thing to keep in step. The
/// distance function then compares like with like — a folded token against the
/// already-folded vocabulary — so "calígrafa" and "caligrafa" are one string.
fn foldToken(arena: std.mem.Allocator, db: sqlite.Db, tok: []const u8) !?[]const u8 {
    const terms = try foldTerms(arena, db, tok);
    return if (terms.len == 1) terms[0] else null;
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

/// Decodes `s` into codepoints. Invalid UTF-8 degrades to one codepoint per
/// byte rather than erroring: this is a ranking heuristic, not a parser.
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
/// The OPTIMAL STRING ALIGNMENT variant: it forbids editing a substring twice,
/// so `ca` → `abc` is 3 rather than the unrestricted 2. That restriction is
/// irrelevant here — the ladder never allows more than two edits, and two edits
/// cannot re-cross the same substring — while OSA needs only one extra
/// rolling row instead of the alphabet-indexed last-occurrence table the
/// unrestricted algorithm requires. Same answers within budget, less state.
///
/// Codepoints, not bytes, because the corpus is accented: on bytes, "ção" is
/// five units and a single mistyped accent would read as a two-edit difference.
/// The length pre-check and the per-row floor let a hopeless pair fall out early,
/// which is what keeps the full-vocabulary scan cheap. Both survive the
/// transposition rule: a swap does not change length, and `d[i][j]` via
/// transposition is `d[i-2][j-2] + 1`, which is `>= min(row i-1)` because
/// adjacent diagonal cells differ by at most 1 — so a row whose minimum already
/// exceeds the budget still cannot be rescued by a later swap.
pub fn editDistance(a: []const u8, b: []const u8, budget: usize) ?usize {
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

/// How many characters of a token `unicode61` would keep as part of a term —
/// i.e. how much the user has actually typed, ignoring punctuation they may
/// have leant on. Counted in CODEPOINTS, not bytes, so an accented word is not
/// credited double: `sé` is two characters, and so is `se`.
pub fn termLen(tok: []const u8) usize {
    var n: usize = 0;
    for (tok) |ch| {
        // Skip UTF-8 continuation bytes: one codepoint counts once.
        if (ch & 0xC0 == 0x80) continue;
        if (std.ascii.isAlphanumeric(ch) or ch >= 0x80) n += 1;
    }
    return n;
}
