//! The search package's leaf: the tokenizer and the fold. Imports nothing of the
//! package's.
//!
//! The half of the old module that survived `golden-search.md` §6's sweep, and
//! the basis of parity by construction (§2.2): the derive step folds through
//! this tokenizer to produce the `terms/` records the browser indexes, so the
//! two engines agree about what a word is because one declaration made both.
//! Deleting `segment_fts` therefore did not remove the server's FTS5 dependency
//! (`build.zig` says so beside `-DSQLITE_ENABLE_FTS5`). The MATCH-expression
//! builder and the typo ladder live in `webapp/wasm/sqlite_core.zig` now.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");

/// MUST stay identical to `webapp/wasm/sqlite_core.zig`'s `tokenizer` — the
/// `tokenize=` of the index the BROWSER builds from the `terms/` records this
/// fold produces (§2.2). Both files say so.
pub const fts_tokenizer = "unicode61 remove_diacritics 2";

/// A one-row FTS5 table with the index's tokenizer, created ONCE per connection
/// and reused for every fold on it.
///
/// `content=''` is not a space saving: it is the precondition for
/// `'delete-all'` (`fold_reset_sql`), the one FTS5 operation that TRUNCATES.
/// `DELETE FROM` appends a tombstone in a new segment, so every fold on the
/// connection kept paying for the biggest thing folded before it: a 300-word
/// page fold went from 0.4 ms to 13.9 ms and did not come back, the first
/// search after it paid 160-194 ms, and a reader that had never folded a
/// document still paid 2.6x because a one-row `DELETE` is a tombstone too
/// (`optimizations.md` 11b). Automerge reclaimed it only after several hundred
/// folds, and not reliably within two thousand. Today's caller
/// (`derive_search.TermsWriter`) folds a document page by page through one
/// connection, so page N would pay for pages 0..N-1. Nothing reads the text
/// back; the fold's whole output is its `fts5vocab`.
pub const fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold USING fts5(t, content='', tokenize='" ++ fts_tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold_vocab USING fts5vocab('temp','token_fold','row');";

/// Truncates the shadow tables and reinitialises the index. Refused on an
/// ordinary content table — hence `content=''` above.
pub const fold_reset_sql = "INSERT INTO temp.token_fold(token_fold) VALUES('delete-all');";

/// A LIVE statement over `text`'s `(term, cnt)` vocabulary. The caller steps it
/// and MUST finalize it.
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

/// Every term `tok` tokenizes to, in vocabulary order.
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

const testing = std.testing;
const schema = @import("../../db/schema.zig");

/// Rows of `temp.token_fold`'s `%_data` shadow table — what the vocabulary scan
/// walks. Counted rather than timed so the pin is deterministic on a loaded box.
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

    // The floor: one small fold on a connection that has folded nothing else.
    _ = try foldTerms(a, db, "caligrafia");
    const virgin = try foldStorageRows(db);
    try testing.expect(virgin > 0);

    // A 4,800-term fold through the SAME table — the vocabulary a few hundred
    // pages into a `TermsWriter` run, which folds page by page on one connection.
    {
        var big: std.ArrayList(u8) = .empty;
        for (0..60) |i| for (0..80) |w| try big.print(a, "termo{d}x{d} ", .{ i, w });
        _ = try foldTerms(a, db, big.items);
    }

    // The next fold must find the table as clean as the first did (under
    // `DELETE FROM` the tombstoned document stayed in the scan), and the reset
    // must not have cost the fold its meaning.
    _ = try foldTerms(a, db, "caligrafia");
    try testing.expectEqual(virgin, try foldStorageRows(db));
    const terms = try foldTerms(a, db, "calígrafa reunião");
    try testing.expectEqual(@as(usize, 2), terms.len);
    try testing.expectEqualStrings("caligrafa", terms[0]);
    try testing.expectEqualStrings("reuniao", terms[1]);
}

// ---------------------------------------------------------------------------
// The bench — the truncating reset against `DELETE FROM`, in milliseconds
// ---------------------------------------------------------------------------

// The pin above counts segments; this prints the time. Both shapes run side by
// side on the same connection: `temp.token_fold` as shipped against a twin that
// is an ordinary content table emptied by `DELETE FROM`, each fed the same
// whole document and then the same page fold. Silent in the suite
// (`testing.log_level` starts at `.warn`); take figures in ReleaseSafe.
//
// TAKEN 2026-08-09, x86 Ryzen 7840U, NVMe, ReleaseSafe, three runs, ~120,000
// distinct terms poisoned (the vocabulary of a 15.7 MB `.txt`). One fold of a
// ~300-word page:
//
// | fold table | first call after the document | steady | worst |
// |---|---:|---:|---:|
// | writer, `DELETE FROM` a content table | **92.9-94.0 ms** | **16.3-16.4 ms** | 94.0 ms |
// | writer, `'delete-all'` a contentless one | 0.38-0.57 ms | **0.24 ms** | 0.96 ms |
// | reader, `DELETE FROM`, NEVER poisoned | 0.20-0.21 ms | **0.39-0.40 ms** | 0.67 ms |
// | reader, `'delete-all'`, never poisoned | 0.21-0.28 ms | **0.15 ms** | 0.28 ms |
//
// The caller then was find-in-note's `countMatches` (deleted, §6 step 7); the
// caller now is `derive_search.TermsWriter`, one connection per document, which
// is the same accumulation the "writer" rows measure. Automerge does reclaim
// tombstones eventually (2.7 ms steady at 200 reps instead of 40) — not a bound
// anything can be built on.

const bench_decay_fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.decay_fold USING fts5(t, tokenize='" ++ fts_tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.decay_fold_vocab USING fts5vocab('temp','decay_fold','row');";

/// `foldRows`'s shape, parameterised by the table and its reset.
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

/// `reps` folds, reported as first / steady / worst — the first apart because it
/// pays for what the whole-document fold left behind, and a mean would hide it.
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

/// A whole document into `table`, one row per page, left there.
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
    // A real file: the reader below is a second connection to the same database.
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

    const poison_pages = 120;
    const poison_words = 1000;

    // The ~300-word page transcript folded afterwards.
    var page: std.ArrayList(u8) = .empty;
    for (0..300) |w| try page.print(a, "palavra{d} ", .{w});

    const reps = 40;

    try db.exec(fold_ddl);
    try benchPoison(a, db, "token_fold", poison_pages, poison_words);
    try benchFoldSeries(db, "token_fold", fold_reset_sql, page.items, reps, "SHIPPED (truncated), writer");

    try db.exec(bench_decay_fold_ddl);
    try benchPoison(a, db, "decay_fold", poison_pages, poison_words);
    try benchFoldSeries(db, "decay_fold", "DELETE FROM temp.decay_fold;", page.items, reps, "BEFORE (deleted), writer");

    // A second connection that never folds a whole document: the floor.
    var ro = try sqlite.Db.openReadOnly(path);
    defer ro.close();
    try ro.exec(fold_ddl);
    try benchFoldSeries(ro, "token_fold", fold_reset_sql, page.items, reps, "SHIPPED (truncated), reader — never poisoned");

    // The old shape with nothing large ever folded: a one-row DELETE is a
    // tombstone too.
    try ro.exec(bench_decay_fold_ddl);
    try benchFoldSeries(ro, "decay_fold", "DELETE FROM temp.decay_fold;", page.items, reps, "BEFORE (deleted), reader — never poisoned");
}
