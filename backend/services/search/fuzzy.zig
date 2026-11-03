//! The search package's leaf: the shared tokenizer and the FTS5 term fold.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const schema = @import("../../db/schema.zig");

/// Re-exported so the server fold and the browser index share one tokenizer.
pub const fts_tokenizer = schema.fts_tokenizer;

/// A one-row FTS5 table, created once per connection and reused per fold.
/// `content=''` is required for `'delete-all'`, which truncates; `DELETE FROM`
/// leaves tombstones, so each fold on the connection would pay for every
/// earlier one (a page fold went from 0.4 ms to 13.9 ms).
pub const fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold USING fts5(t, content='', tokenize='" ++ fts_tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.token_fold_vocab USING fts5vocab('temp','token_fold','row');";

/// Truncates the shadow tables and reinitialises the index. Refused on an
/// ordinary content table — hence `content=''` above.
pub const fold_reset_sql = "INSERT INTO temp.token_fold(token_fold) VALUES('delete-all');";

/// A live statement over `text`'s `(term, cnt)` vocabulary; caller finalizes.
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

pub fn foldTerms(arena: std.mem.Allocator, db: sqlite.Db, tok: []const u8) ![]const []const u8 {
    var s = try foldRows(db, tok);
    defer s.finalize();
    var out: std.ArrayList([]const u8) = .empty;
    while (try s.step()) try out.append(arena, try arena.dupe(u8, s.columnText(0)));
    return out.items;
}

// ---- tests ----

const testing = std.testing;

/// Rows of the `%_data` shadow table; counted, not timed, to stay deterministic.
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

    _ = try foldTerms(a, db, "caligrafia");
    const virgin = try foldStorageRows(db);
    try testing.expect(virgin > 0);

    {
        var big: std.ArrayList(u8) = .empty;
        for (0..60) |i| for (0..80) |w| try big.print(a, "termo{d}x{d} ", .{ i, w });
        _ = try foldTerms(a, db, big.items);
    }

    _ = try foldTerms(a, db, "caligrafia");
    try testing.expectEqual(virgin, try foldStorageRows(db));
    const terms = try foldTerms(a, db, "calígrafa reunião");
    try testing.expectEqual(@as(usize, 2), terms.len);
    try testing.expectEqualStrings("caligrafa", terms[0]);
    try testing.expectEqualStrings("reuniao", terms[1]);
}

// ---- bench: truncating reset vs `DELETE FROM` ----
// Silent in the suite; take figures in ReleaseSafe. On a Ryzen 7840U with
// ~120k terms poisoned, a 300-word page fold ran 16 ms steady under
// `DELETE FROM` and 0.24 ms under `'delete-all'`.

const bench_decay_fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.decay_fold USING fts5(t, tokenize='" ++ fts_tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.decay_fold_vocab USING fts5vocab('temp','decay_fold','row');";

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

/// First / steady / worst; the first is apart because it pays for the poison.
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
    // A real file, so a second read-only connection can open it.
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [128]u8 = undefined;
    const path = try std.fmt.bufPrintSentinel(&path_buf, ".zig-cache/tmp/{s}/bench.db", .{tmp.sub_path}, 0);
    var db = try sqlite.Db.open(path);
    defer db.close();
    try schema.migrate(db);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const poison_pages = 120;
    const poison_words = 1000;

    var page: std.ArrayList(u8) = .empty;
    for (0..300) |w| try page.print(a, "palavra{d} ", .{w});

    const reps = 40;

    try db.exec(fold_ddl);
    try benchPoison(a, db, "token_fold", poison_pages, poison_words);
    try benchFoldSeries(db, "token_fold", fold_reset_sql, page.items, reps, "SHIPPED (truncated), writer");

    try db.exec(bench_decay_fold_ddl);
    try benchPoison(a, db, "decay_fold", poison_pages, poison_words);
    try benchFoldSeries(db, "decay_fold", "DELETE FROM temp.decay_fold;", page.items, reps, "BEFORE (deleted), writer");

    var ro = try sqlite.Db.openReadOnly(path);
    defer ro.close();
    try ro.exec(fold_ddl);
    try benchFoldSeries(ro, "token_fold", fold_reset_sql, page.items, reps, "SHIPPED (truncated), reader — never poisoned");

    try ro.exec(bench_decay_fold_ddl);
    try benchFoldSeries(ro, "decay_fold", "DELETE FROM temp.decay_fold;", page.items, reps, "BEFORE (deleted), reader — never poisoned");
}
