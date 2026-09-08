//! The search package's self-contained leaf: the tokenizer and the fold
//! (`fts_tokenizer`, `fold_ddl`, `foldRows`, `foldTerms`). It imports nothing of
//! the package's.
//!
//! **THIS IS THE HALF THAT SURVIVES THE SWEEP** (`golden-search.md` §6.1,
//! explicitly). `fts_tokenizer` is the `tokenize=` of `segment_fts` AND the fold
//! the derive step runs to produce the `terms/` records the browser indexes, so
//! it is the whole basis of parity-by-construction (§2.2) — deleting
//! `segment_fts` in step 8 does not reduce the server's FTS5 dependency by one
//! flag. What went in step 7 with the read expression it served is the
//! query-building half: `appendToken`, `termLen` and `min_prefix_len` shaped a
//! MATCH expression out of what the user had typed, and the browser types its
//! own now.
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

/// MUST stay identical to the `tokenize=` of `segment_fts` in `schema.zig`, and
/// to the fold the derive step runs to produce the `terms/` records the browser
/// indexes. That is what makes the two engines agree about what a word is BY
/// CONSTRUCTION rather than by review (`golden-search.md` §2.2). A test asserts
/// the two spellings have not drifted apart.
pub const fts_tokenizer = "unicode61 remove_diacritics 2";

/// A one-row FTS5 table with the SAME tokenizer as the index, used purely to
/// see an arbitrary string the way the index saw its own text. One tokenizer
/// declaration rather than two that could drift.
///
/// ## `content=''` IS NOT A SPACE SAVING — IT IS WHAT LETS THE TABLE BE TRUNCATED
///
/// This table is created ONCE per connection and reused for every fold on it.
/// `DELETE FROM` does not empty an FTS5 index — FTS5 records a deletion as a new
/// entry in a new segment — so whatever the biggest thing ever folded here was,
/// every later fold on that connection went on paying for it until a merge
/// happened to reclaim it.
///
/// The caller today is the DERIVE step (`derive_search.zig`), which folds a
/// document one page at a time through a private in-memory connection of its
/// own. That bounds the accumulation by the DOCUMENT rather than by process
/// uptime — but it does not remove it: a 1,450-page PDF is 1,450 folds sharing
/// one table, and page N pays for pages 0..N-1.
///
/// The measurements are from when this ran on the long-lived writer, so the
/// failure mode was "the server gets slower the longer it has been up" — which
/// no test here could see (every one opens a fresh connection) and no benchmark
/// could see (every one restarts the server first). It was real. The
/// whole-document fold that used to run here — `writeDocTerms`, retired with
/// `doc_terms` in §6 step 6 — made it concrete: one ingest, re-mint or `.note`
/// heal on the writer connection took a 300-word page fold from **0.4 ms to
/// 13.9 ms and did not give it back**, with the first search after it paying
/// **160-194 ms in a single per-page count**; a second whole-document fold made
/// it 35.1 ms. FTS5's automerge did reclaim it eventually, but only after several
/// hundred more folds and not reliably within two thousand. `optimizations.md`
/// entry 11b. Both of those callers are gone now, and the truncate stays: it is
/// what makes the floor a property of the code rather than of what happens to
/// have run before it.
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

// ---------------------------------------------------------------------------
// Tests — the shared fold table does not accumulate (optimizations.md 11b)
// ---------------------------------------------------------------------------

// These were written in `query.zig` and moved here when `golden-search.md` §6
// step 7 deleted that file. Their subject — `temp.token_fold`, the contentless
// fold table — is named in §6.1 as SURVIVING the sweep: it is the fold the
// derive step runs, and the whole basis of parity by construction (§2.2). The
// caller changed; the hazard did not.

const testing = std.testing;
const schema = @import("../../db/schema.zig");

/// How much INDEX STORAGE `temp.token_fold` is currently carrying, counted in
/// rows of its `%_data` shadow table — one per segment b-tree node, plus the
/// structure and averages records FTS5 always keeps.
///
/// A count rather than a stopwatch on purpose: the defect below is a TIME
/// regression, and a timing assertion is exactly the kind that fails on a loaded
/// CI box for reasons that have nothing to do with the bug. Segment rows are what
/// the vocabulary scan walks, so counting them measures the same thing
/// deterministically.
fn foldStorageRows(db: sqlite.Db) !i64 {
    var r = (try db.row("SELECT COUNT(*) FROM temp.token_fold_data;", &.{})).?;
    defer r.finalize();
    return r.int(0);
}

test "a huge fold leaves the shared fold table EMPTY rather than emptied, so a fold cannot decay behind the one before it" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // What one small fold costs on a connection that has folded nothing else.
    // This is the floor every fold on the connection must keep paying, and it
    // must not depend on anything that happened earlier on it.
    _ = try foldTerms(a, db, "caligrafia");
    const virgin = try foldStorageRows(db);
    try testing.expect(virgin > 0); // the fold really did index something

    // A far larger fold through the SAME table. The poison used to be the
    // mint's `writeDocTerms`; that write retired with `doc_terms` in §6 step 6
    // and the hazard did not follow it out. `derive_search.TermsWriter` folds
    // one page at a time through ONE connection per document, so a 1,450-page
    // PDF is 1,450 folds sharing a table: without the truncating reset, page N
    // pays for pages 0..N-1 and the derive gets slower the further into the
    // document it gets. 4,800 distinct terms is a vocabulary far larger than any
    // single page's — the shape a few hundred pages in.
    {
        var big: std.ArrayList(u8) = .empty;
        for (0..60) |i| for (0..80) |w| try big.print(a, "termo{d}x{d} ", .{ i, w });
        _ = try foldTerms(a, db, big.items);
    }

    // The very next fold must find the table as clean as the first one did.
    // Under `DELETE FROM` it did not: FTS5 keeps a deleted entry in a new
    // segment, so the whole document stayed in the index — and stayed in the
    // scan — until some later merge happened to reclaim it. Measured at the time,
    // that took a 300-word page fold from 0.15 ms to 13.9 ms PERMANENTLY, with
    // 160-194 ms on the first search after the fold.
    _ = try foldTerms(a, db, "caligrafia");
    try testing.expectEqual(virgin, try foldStorageRows(db));

    // And it is still the same tokenizer over the same string: the reset is not
    // allowed to have cost the fold its meaning.
    const terms = try foldTerms(a, db, "calígrafa reunião");
    try testing.expectEqual(@as(usize, 2), terms.len);
    try testing.expectEqualStrings("caligrafa", terms[0]);
    try testing.expectEqualStrings("reuniao", terms[1]);
}

// ---------------------------------------------------------------------------
// The bench — what a long-lived connection was doing to every fold on it
// ---------------------------------------------------------------------------

// The defect entry 11b closes is a TIME defect that only a long-lived connection
// shows, so the pin above counts segments (deterministic, cheap, CI-safe) and
// this reports the milliseconds. It runs BOTH shapes side by side rather than
// citing the old one: `temp.token_fold` as it is now (contentless, truncated by
// `'delete-all'`) against a twin that is an ordinary content table emptied by
// `DELETE FROM`, each fed the same whole document and then the same page fold on
// the same connection.
//
// `std.log.INFO` and a REAL database file at the production pragma set, for the
// reasons `txt_index.zig`'s benches state: above Debug `std.log.debug` is
// compiled out, `testing.log_level` starts at `.warn` so this is silent in the
// suite, and the figures have to be taken in ReleaseSafe because a Debug build is
// 6-10x slower under the same statements.
//
// TAKEN 2026-08-09, x86 Ryzen 7840U, NVMe, ReleaseSafe, three runs. The subject
// is entry 11a's: ~120,000 distinct terms, the vocabulary of a 15.7 MB `.txt`.
// One fold of a ~300-word page transcript:
//
// | fold table | first call after the document | steady | worst |
// |---|---:|---:|---:|
// | writer, `DELETE FROM` a content table | **92.9-94.0 ms** | **16.3-16.4 ms** | 94.0 ms |
// | writer, `'delete-all'` a contentless one | 0.38-0.57 ms | **0.24 ms** | 0.96 ms |
// | reader, `DELETE FROM`, NEVER poisoned | 0.20-0.21 ms | **0.39-0.40 ms** | 0.67 ms |
// | reader, `'delete-all'`, never poisoned | 0.21-0.28 ms | **0.15 ms** | 0.28 ms |
//
// THE CALLER THE FIGURES WERE TAKEN AGAINST IS GONE, AND THE MEASUREMENT IS NOT.
// They were taken when a per-page fold belonged to `countMatches` and a
// find-in-note batch made up to 20 of them; `golden-search.md` §6 step 7 deleted
// both, and in-document search runs in the browser now. What still folds through
// this table is the DERIVE step: `derive_search.TermsWriter` folds one page at a
// time through a single connection per document, which is the same accumulation
// the "writer" rows below measure — a whole document's vocabulary piling up in
// one table, with every later fold scanning it. The connection is now
// per-document rather than per-process, so the poisoning is bounded by the
// document; a 1,450-page PDF is 1,450 folds inside that bound. Different caller,
// same hazard, so the numbers stand as taken.
//
// Three things to read off it. **The first call after a document-sized fold was
// ~94 ms**, and every fold that follows it on that connection pays. **The steady
// state after it was 16 ms and did not come back**: 68x the 0.24 ms this same
// connection now pays, and the whole of that difference is the vocabulary scan
// walking a document nobody deleted so much as tombstoned. **And the last two
// rows are the surprise** — a connection that never folds a document, only
// one-row folds of its own, was still paying 2.6x, because a one-row `DELETE`
// is a tombstone too.
//
// FTS5's automerge does reclaim it, eventually and unpredictably: at 200 reps
// instead of 40 the "before" steady state reads 2.7 ms, because the merge landed
// somewhere past the 120th fold and dragged the mean down with it. That is what
// "bounded" would have meant here, and it is not a bound a lock hold can be
// built on.

const bench_decay_fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.decay_fold USING fts5(t, tokenize='" ++ fts_tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.decay_fold_vocab USING fts5vocab('temp','decay_fold','row');";

/// One fold of `text` through `table`, emptied by `reset` first — the shape
/// `foldRows` has, parameterised by the two things the bench varies.
fn benchFold(db: sqlite.Db, comptime table: []const u8, reset: [:0]const u8, text: []const u8) !u64 {
    const t0 = std.Io.Clock.awake.now(testing.io);
    try db.exec(reset);
    {
        var s = try db.prepare("INSERT INTO temp." ++ table ++ "(rowid, t) VALUES(1, ?1);");
        defer s.finalize();
        s.bindText(1, text);
        _ = try s.step();
    }
    var s = try db.prepare("SELECT term, cnt FROM temp." ++ table ++ "_vocab;");
    defer s.finalize();
    var terms: usize = 0;
    while (try s.step()) terms += 1;
    const t1 = std.Io.Clock.awake.now(testing.io);
    std.mem.doNotOptimizeAway(terms);
    return @intCast(t0.durationTo(t1).toNanoseconds());
}

/// `reps` folds of `text`, reported as first / steady / worst — the FIRST is
/// reported apart because it is the one that pays for whatever the whole-document
/// fold left in the table, and a mean would hide it.
fn benchFoldSeries(
    db: sqlite.Db,
    comptime table: []const u8,
    reset: [:0]const u8,
    text: []const u8,
    reps: usize,
    label: []const u8,
) !void {
    const first = try benchFold(db, table, reset, text);
    var total: u64 = 0;
    var worst: u64 = first;
    for (1..reps) |_| {
        const ns = try benchFold(db, table, reset, text);
        total += ns;
        worst = @max(worst, ns);
    }
    std.log.info("[bench] fold {s}: first {d} us, steady {d} us over {d}, worst {d} us", .{
        label, first / std.time.ns_per_us, total / (reps - 1) / std.time.ns_per_us, reps - 1, worst / std.time.ns_per_us,
    });
}

/// Puts a whole document's worth of text into `table`, one row per page — and
/// LEAVES IT THERE, which is what every caller of a non-truncating fold table
/// does, and what the next caller of it inherits.
fn benchPoison(a: std.mem.Allocator, db: sqlite.Db, comptime table: []const u8, pages: usize, words: usize) !void {
    var s = try db.prepare("INSERT INTO temp." ++ table ++ "(t) VALUES(?1);");
    defer s.finalize();
    for (0..pages) |p| {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(a);
        for (0..words) |w| try out.print(a, "termo{d}x{d} ", .{ p, w });
        s.reset();
        s.bindText(1, out.items);
        _ = try s.step();
    }
}

test "BENCH note: a page fold on a connection that has folded a whole document, truncated against merely deleted (figures printed)" {
    // A real file: the temp store has to be real, and the reader below is a
    // SECOND connection to the same database (the reader pool's shape).
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [128]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&path_buf, ".zig-cache/tmp/{s}/bench.db", .{tmp.sub_path});
    var db = try sqlite.Db.open(path);
    defer db.close();
    try schema.migrate(db);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The subject is entry 11a's: ~150,000 distinct terms, the vocabulary of the
    // 15.7 MB `.txt` at `max_file_bytes`. Written straight into the fold table
    // rather than ingested, because what poisons the table is the fold, not the
    // document — the pinning test above drives the same hazard through
    // `foldTerms`, which is the entry point that still exists.
    const poison_pages = 120;
    const poison_words = 1000;

    // A page transcript to fold afterwards, ~300 words — the unit of text a
    // single fold sees.
    var page: std.ArrayList(u8) = .empty;
    for (0..300) |w| try page.print(a, "palavra{d} ", .{w});

    const reps = 40;

    // SHIPPED: contentless, truncated by `'delete-all'`.
    try db.exec(fold_ddl);
    try benchPoison(a, db, "token_fold", poison_pages, poison_words);
    try benchFoldSeries(db, "token_fold", fold_reset_sql, page.items, reps, "SHIPPED (truncated), writer");

    // BEFORE: an ordinary content table emptied with `DELETE FROM`, fed the same
    // document — so the comparison is a measurement rather than a memory.
    try db.exec(bench_decay_fold_ddl);
    try benchPoison(a, db, "decay_fold", poison_pages, poison_words);
    try benchFoldSeries(db, "decay_fold", "DELETE FROM temp.decay_fold;", page.items, reps, "BEFORE (deleted), writer");

    // A reader-pool connection: its own temp schema, and it never folds a whole
    // document — so this is the floor, and it is what every fold on a pooled
    // reader should already have been getting.
    var ro = try sqlite.Db.openReadOnly(path);
    defer ro.close();
    try ro.exec(fold_ddl);
    try benchFoldSeries(ro, "token_fold", fold_reset_sql, page.items, reps, "SHIPPED (truncated), reader — never poisoned");

    // The same reader under the old shape, with nothing large ever folded through
    // it — the part of the cost that was never about a whole-document fold at
    // all. A one-row DELETE still leaves a tombstone, and a loop of one-row folds
    // leaves one per fold.
    try ro.exec(bench_decay_fold_ddl);
    try benchFoldSeries(ro, "decay_fold", "DELETE FROM temp.decay_fold;", page.items, reps, "BEFORE (deleted), reader — never poisoned");
}
