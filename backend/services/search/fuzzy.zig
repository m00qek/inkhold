//! The search package's self-contained leaf: the shared tokenizer/fold
//! primitives (`fold_ddl`/`foldRows`/`foldTerms`, `appendToken`, `termLen`,
//! `fts_tokenizer`, `min_prefix_len`) that the read expression and the counting
//! pass both fold through. `query.zig` builds on this module; it imports
//! nothing of the package's. The reads and writes of `segment_fts` itself stay
//! there.
//!
//! **THE TYPO LADDER USED TO LIVE HERE AND DOES NOT.** `golden-search.md` §6
//! step 6 moved it into `webapp/wasm/sqlite_core.zig`, where the browser's own
//! FTS5 index is: `editDistance`, `maxEdits`, `betterCandidate`, the ranked
//! candidate scan and the `fts5vocab` corpus walk are all there now, folding
//! through that index's own tokenizer for the same parity reason this module
//! exists.
//!
//! What survives is the FOLD, and it is not a leftover — it is the whole basis
//! of parity by construction (§2.2). The derive step runs this tokenizer to
//! produce the terms it ships, so the browser's index and this server's agree
//! about what a word is because they were made by the same declaration. Deleting
//! `segment_fts` later does not reduce the FTS5 dependency by one flag.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");

/// How many term characters the word being typed must carry before it is
/// searched as a prefix. A one-character prefix matches very nearly the whole
/// index: expensive to score and useless as a result set (every note that
/// contains a word starting with "a"). Two is the conventional floor and is
/// where a prefix starts to discriminate. It gates ONLY the `*`; a one-letter
/// token is still searched, just as an exact term.
pub const min_prefix_len: usize = 2;

/// MUST stay identical to the `tokenize=` of `segment_fts` in `schema.zig`, and
/// to the fold the derive step runs to produce the `terms/` records the browser
/// indexes. That is what makes the two engines agree about what a word is BY
/// CONSTRUCTION rather than by review (`golden-search.md` §2.2). A test asserts
/// the two spellings have not drifted apart.
pub const fts_tokenizer = "unicode61 remove_diacritics 2";

/// Appends one token to a MATCH expression, double-quoted so every character in
/// it is a literal, with the FTS5 prefix `*` OUTSIDE the closing quote when
/// asked. Shared by `buildMatch` and the counting pass's term derivation
/// precisely so the two cannot drift apart on escaping.
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

/// A one-row FTS5 table with the SAME tokenizer as the index, used purely to
/// see an arbitrary string the way the index saw its own text. Shared by
/// find-in-note's counting and by the term derivation behind it, so there is one
/// tokenizer declaration rather than two that could drift.
///
/// ## `content=''` IS NOT A SPACE SAVING — IT IS WHAT LETS THE TABLE BE TRUNCATED
///
/// This table is created ONCE per connection, and the connections here are
/// long-lived: the writer for the process's lifetime, each reader-pool
/// connection likewise. `DELETE FROM` does not empty an FTS5 index — FTS5
/// records a deletion as a new entry in a new segment — so whatever the biggest
/// thing ever folded here was, every later fold on that connection went on
/// paying for it until a merge happened to reclaim it. `foldRows` runs ONCE PER
/// MATCHING PAGE of an in-document search, so that cost is multiplied by the
/// pages a find-in-note returns.
///
/// The failure mode is "find-in-note gets slower the longer the server has been
/// up", which no test here could see (every one opens a fresh connection) and no
/// benchmark could see (every one restarts the server first). It was real. The
/// whole-document fold that used to run here — `writeDocTerms`, retired
/// with `doc_terms` in §6 step 6 — made this concrete: one ingest, re-mint or
/// `.note` heal on the writer connection took a 300-word page fold from **0.4 ms
/// to 13.9 ms and did not give it back**, with the first search after it paying
/// **160-194 ms in a single `countMatches`**; a second whole-document fold made
/// it 35.1 ms. FTS5's automerge did reclaim it eventually, but only after several
/// hundred more folds and not reliably within two thousand. `optimizations.md`
/// entry 11b. Nothing folds a whole document here any more, but the truncate
/// stays: it is what makes the floor a property of the code rather than of what
/// happens to have run before.
///
/// The fix is that the table is CONTENTLESS, which is the precondition for
/// `'delete-all'` (`fold_reset_sql`) — the one FTS5 operation that truncates the
/// index rather than appending tombstones to it. Every caller resets with that,
/// so the table is genuinely empty at the start of every fold, whatever ran
/// before it and however long ago the process started. Contentless costs nothing
/// here: the fold's entire output is its `fts5vocab`, and no caller ever reads
/// the text back. The floor is 0.15 ms and stays there — truncating also took
/// 2.6x off a reader that had never folded a document at all, because a one-row
/// `DELETE` is a tombstone too. *Emptied is not the same as empty.*
pub const fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold USING fts5(t, content='', tokenize='" ++ fts_tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold_vocab USING fts5vocab('temp','token_fold','row');";

/// Empties `token_fold` FOR REAL. `DELETE FROM` would not: FTS5 writes a
/// deletion as a new entry in a new segment, so the terms stay in the index —
/// and the cost of scanning them stays with them — until a merge reclaims them.
/// `'delete-all'` truncates the shadow tables and reinitialises the index, which
/// is why the table above is `content=''`: the command is refused on an ordinary
/// content table, and the content is never read back here anyway (the fold's
/// whole output is its `fts5vocab`).
pub const fold_reset_sql = "INSERT INTO temp.token_fold(token_fold) VALUES('delete-all');";

/// Tokenizes `text` and returns a LIVE statement over its `(term, doc, cnt)`
/// vocabulary. The caller steps it and MUST finalize it.
///
/// Returning the statement rather than a slice is what lets the counting path
/// avoid materialising a page's whole vocabulary just to add up a few terms.
pub fn foldRows(db: sqlite.Db, text: []const u8) !sqlite.Stmt {
    try db.exec(fold_ddl);
    try db.exec(fold_reset_sql);
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
