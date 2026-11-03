//! Measurement only (`zig build derive-bench`): opens an existing corpus
//! read-only and times the real derive path (`derive_search.writeDerived`) on
//! the target, in three passes: `fold` alone, `derive` end to end, and
//! `compress` at each requested level. Only `compress` holds a whole document
//! in memory, so read its RSS as the bench's, not the server's.

const std = @import("std");
const sqlite = @import("db/sqlite.zig");
const fuzzy = @import("services/search/fuzzy.zig");
const derived = @import("store/derived.zig");
const derivesearch = @import("services/derive_search.zig");

const Io = std.Io;
const Dir = std.Io.Dir;

const usage =
    \\derive-bench --db PATH [options]
    \\
    \\  --db PATH        corpus database (opened READ-ONLY; take a `.backup`
    \\                   snapshot of a live WAL database, never a raw copy)
    \\  --mode fold|derive|split|all   what to run (default all; `split`
    \\                   decomposes the fold into its four statements and is not
    \\                   part of `all`)
    \\  --levels 6,4,1   deflate levels to time in the compress pass (default 6,4,1);
    \\                   EMPTY turns the pass off, which is the only way to read a
    \\                   peak RSS that is the derive path's rather than the bench's
    \\  --blob MD5       one document only (default: every one with text)
    \\  --iters N        timed iterations, best reported (default 3)
    \\  --out DIR        where the derived files are written (default derive-bench-out)
    \\  --keep           do not delete --out on exit
    \\  --label TEXT     free-form tag echoed on the header line
    \\
;

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);

    var db_path: []const u8 = "";
    var mode: []const u8 = "all";
    var levels_arg: []const u8 = "6,4,1";
    var only_blob: []const u8 = "";
    var out_dir_path: []const u8 = "derive-bench-out";
    var label: []const u8 = "-";
    var iters: usize = 3;
    var keep = false;

    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        const next = struct {
            fn get(av: []const [:0]const u8, idx: *usize) ![]const u8 {
                idx.* += 1;
                if (idx.* >= av.len) return error.MissingValue;
                return av[idx.*];
            }
        }.get;
        if (std.mem.eql(u8, a, "--db")) {
            db_path = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--mode")) {
            mode = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--levels")) {
            levels_arg = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--blob")) {
            only_blob = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--out")) {
            out_dir_path = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--label")) {
            label = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--iters")) {
            iters = try std.fmt.parseInt(usize, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--keep")) {
            keep = true;
        } else {
            try emit(io, usage, .{});
            return error.BadArgs;
        }
    }
    if (db_path.len == 0 or iters == 0) {
        try emit(io, usage, .{});
        return error.BadArgs;
    }

    var levels: std.ArrayList(u8) = .empty;
    defer levels.deinit(gpa);
    {
        var it = std.mem.tokenizeScalar(u8, levels_arg, ',');
        while (it.next()) |t| {
            const n = try std.fmt.parseInt(u8, t, 10);
            if (n < 1 or n > 9) return error.BadArgs;
            try levels.append(gpa, n);
        }
    }

    const want_fold = std.mem.eql(u8, mode, "fold") or std.mem.eql(u8, mode, "all");
    const want_derive = std.mem.eql(u8, mode, "derive") or std.mem.eql(u8, mode, "all");
    const want_split = std.mem.eql(u8, mode, "split");

    const path_z = try arena.dupeSentinel(u8, db_path, 0);
    const corpus = try sqlite.Db.openReadOnly(path_z);
    defer corpus.close();

    var out_root = try Dir.cwd().createDirPathOpen(io, out_dir_path, .{});
    defer out_root.close(io);
    var terms_root = try out_root.createDirPathOpen(io, "terms", .{});
    defer terms_root.close(io);
    var text_root = try out_root.createDirPathOpen(io, "text", .{});
    defer text_root.close(io);
    const terms_store = try derived.DerivedStore.init(io, terms_root);
    const text_store = try derived.DerivedStore.init(io, text_root);

    try emit(io,
        \\derive-bench label={s} db={s} mode={s} iters={d} levels={s} v={d}
        \\
    , .{ label, db_path, mode, iters, levels_arg, derivesearch.index_version });

    var docs = try listDocs(gpa, arena, corpus, only_blob);
    defer docs.deinit(gpa);

    var total: Totals = .{};
    total.levels = try gpa.alloc(LevelTotal, levels.items.len);
    defer gpa.free(total.levels);
    @memset(total.levels, .{});

    for (docs.items) |doc| {
        try emit(io, "\ndoc {s} kind={d} n={d} rows={d} text={d} name={s}\n", .{
            doc.md5, doc.kind, doc.n, doc.rows, doc.text_bytes, doc.name,
        });
        total.docs += 1;
        total.rows += doc.rows;
        total.text_bytes += doc.text_bytes;

        if (want_fold) {
            var best: u64 = std.math.maxInt(u64);
            var terms_chars: usize = 0;
            for (0..iters) |_| {
                const r = try foldPass(gpa, io, corpus, doc);
                best = @min(best, r.ns);
                terms_chars = r.terms_chars;
            }
            total.fold_ns += best;
            try emit(io, "  fold     {d:>10.1} ms  {d:.4} ms/page  {d:.2} MB/s  terms_chars={d}\n", .{
                msOf(best),                 msOf(best) / @as(f64, @floatFromInt(@max(doc.rows, 1))),
                mbps(doc.text_bytes, best), terms_chars,
            });
        }

        if (want_split) {
            var best: SplitResult = .{ .total = std.math.maxInt(u64) };
            for (0..iters) |_| {
                const r = try splitPass(gpa, io, corpus, doc);
                if (r.total < best.total) best = r;
            }
            total.split.ddl += best.ddl;
            total.split.reset += best.reset;
            total.split.insert += best.insert;
            total.split.vocab += best.vocab;
            total.split.total += best.total;
            try emitSplit(io, best, doc.rows);
            // The decomposed fold must agree with the whole one exactly.
            const whole = try foldPass(gpa, io, corpus, doc);
            try emit(io, "  FIDELITY split vs fold: {s} — terms_chars {d} vs {d}\n", .{
                if (whole.terms_chars == best.terms_chars) "OK" else "**MISMATCH**",
                best.terms_chars,
                whole.terms_chars,
            });
        }

        if (!want_derive) continue;

        var best_derive: u64 = std.math.maxInt(u64);
        for (0..iters) |_| {
            const t0 = Io.Clock.awake.now(io);
            var src = try pageSource(corpus, doc);
            defer src.stmt.finalize();
            try derivesearch.writeDerived(gpa, terms_store, text_store, doc.md5, doc.n, &src);
            const t1 = Io.Clock.awake.now(io);
            best_derive = @min(best_derive, @as(u64, @intCast(t0.durationTo(t1).toNanoseconds())));
        }
        total.derive_ns += best_derive;

        // `--levels ''` stops here: the only way to read a true streaming peak
        // RSS, since everything below holds a whole document's plaintext.
        if (levels.items.len == 0) {
            try emit(io, "  derive   {d:>10.1} ms  (no compress pass; peak RSS is the write path's)\n", .{
                msOf(best_derive),
            });
            if (!keep) {
                terms_store.removeAll(doc.md5);
                text_store.removeAll(doc.md5);
            }
            continue;
        }

        // `stored` is the whole file, header included.
        const terms_file = try recover(gpa, io, terms_store, doc.md5);
        defer gpa.free(terms_file.plain);
        const text_file = try recover(gpa, io, text_store, doc.md5);
        defer gpa.free(text_file.plain);

        total.terms_stored += terms_file.stored;
        total.text_stored += text_file.stored;
        total.terms_plain += terms_file.plain.len;
        total.text_plain += text_file.plain.len;

        try emit(io, "  derive   {d:>10.1} ms  terms={d}B text={d}B  (plain terms={d}B text={d}B)\n", .{
            msOf(best_derive),    terms_file.stored,   text_file.stored,
            terms_file.plain.len, text_file.plain.len,
        });

        for (levels.items, 0..) |lvl, li| {
            const t = try timeCompress(gpa, io, terms_file.plain, lvl, iters);
            const x = try timeCompress(gpa, io, text_file.plain, lvl, iters);
            total.levels[li].terms_bytes += t.bytes;
            total.levels[li].text_bytes += x.bytes;
            total.levels[li].terms_ns += t.ns;
            total.levels[li].text_ns += x.ns;
            try emit(
                io,
                "  level {d}  terms {d}B {d:.1} ms {d:.2} MB/s | text {d}B {d:.1} ms {d:.2} MB/s\n",
                .{
                    lvl,     t.bytes,    msOf(t.ns),                      mbps(terms_file.plain.len, t.ns),
                    x.bytes, msOf(x.ns), mbps(text_file.plain.len, x.ns),
                },
            );
            // Level 6 here must reproduce the payload `writeDerived` wrote.
            if (lvl == 6) {
                const ok = t.bytes + derived.header_len == terms_file.stored and
                    x.bytes + derived.header_len == text_file.stored and
                    terms_file.crc_ok and text_file.crc_ok;
                try emit(io, "  FIDELITY level 6 vs writeDerived: {s}\n", .{
                    if (ok) "OK" else "**MISMATCH**",
                });
            }
        }

        if (!keep) {
            terms_store.removeAll(doc.md5);
            text_store.removeAll(doc.md5);
        }
    }

    try emit(io, "\nTOTAL docs={d} rows={d} text={d}B\n", .{ total.docs, total.rows, total.text_bytes });
    if (want_fold) {
        try emit(io, "  fold     {d:>10.1} ms  {d:.4} ms/page  {d:.2} MB/s\n", .{
            msOf(total.fold_ns),
            msOf(total.fold_ns) / @as(f64, @floatFromInt(@max(total.rows, 1))),
            mbps(total.text_bytes, total.fold_ns),
        });
    }
    if (want_split) try emitSplit(io, total.split, total.rows);
    if (want_derive and levels.items.len == 0) {
        try emit(io, "  derive   {d:>10.1} ms  (no compress pass)\n", .{msOf(total.derive_ns)});
    } else if (want_derive) {
        try emit(io, "  derive   {d:>10.1} ms  terms={d}B text={d}B  (plain terms={d}B text={d}B)\n", .{
            msOf(total.derive_ns), total.terms_stored, total.text_stored,
            total.terms_plain,     total.text_plain,
        });
        for (levels.items, 0..) |lvl, li| {
            const L = total.levels[li];
            try emit(
                io,
                "  level {d}  terms {d}B {d:.1} ms | text {d}B {d:.1} ms | stream {d}B {d:.1} ms\n",
                .{
                    lvl,                          L.terms_bytes,                msOf(L.terms_ns), L.text_bytes, msOf(L.text_ns),
                    L.terms_bytes + L.text_bytes, msOf(L.terms_ns + L.text_ns),
                },
            );
        }
    }
    try emitStatus(io);

    if (!keep) {
        out_root.deleteTree(io, "terms") catch {};
        out_root.deleteTree(io, "text") catch {};
    }
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

const Doc = struct {
    md5: []const u8,
    name: []const u8,
    /// `note_page_index.kind`: 0 `.note`, 1 `.txt`, 2 `.pdf`.
    kind: i64,
    /// The address space, `max(page_index) + 1`, not the row count.
    n: u32,
    rows: usize,
    text_bytes: usize,
};

fn listDocs(
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    db: sqlite.Db,
    only: []const u8,
) !std.ArrayList(Doc) {
    var out: std.ArrayList(Doc) = .empty;
    errdefer out.deinit(gpa);
    var s = try db.prepare(
        \\SELECT npi.blob_md5, min(npi.kind), max(npi.page_index) + 1,
        \\       count(npi.text), sum(length(npi.text)),
        \\       coalesce((SELECT f.name FROM files f
        \\                  WHERE f.md5 = npi.blob_md5 AND f.deleted = 0 LIMIT 1), '-')
        \\  FROM note_page_index npi
        \\ WHERE (?1 = '' OR npi.blob_md5 = ?1)
        \\ GROUP BY npi.blob_md5
        \\HAVING sum(length(npi.text)) > 0
        \\ ORDER BY sum(length(npi.text)) DESC;
    );
    defer s.finalize();
    s.bindText(1, only);
    while (try s.step()) {
        try out.append(gpa, .{
            .md5 = try arena.dupe(u8, s.columnText(0)),
            .kind = s.columnInt(1),
            .n = @intCast(s.columnInt(2)),
            .rows = @intCast(s.columnInt(3)),
            .text_bytes = @intCast(s.columnInt(4)),
            .name = try arena.dupe(u8, s.columnText(5)),
        });
    }
    return out;
}

/// A `writeDerived` page source over `note_page_index`. Borrows the
/// statement's column memory, legal because `writeDerived` consumes each `Page`
/// before the next. NULL or empty text is skipped.
const Pages = struct {
    stmt: sqlite.Stmt,
    ranged: bool,

    pub fn next(self: *Pages) !?derivesearch.Page {
        while (try self.stmt.step()) {
            if (self.stmt.columnIsNull(1)) continue;
            const text = self.stmt.columnText(1);
            if (text.len == 0) continue;
            return .{
                .ordinal = self.stmt.columnInt(0),
                .text = text,
                // Only `.txt` carries a blob byte range; for other kinds these
                // columns hold the RECOGNTEXT range and must not reach the record.
                .offset = if (self.ranged) blk: {
                    break :blk if (self.stmt.columnIntOpt(2)) |o| @intCast(o) else null;
                } else null,
                .len = if (self.ranged) blk: {
                    break :blk if (self.stmt.columnIntOpt(3)) |l| @intCast(l) else null;
                } else null,
            };
        }
        return null;
    }
};

fn pageSource(db: sqlite.Db, doc: Doc) !Pages {
    var s = try db.prepare(
        "SELECT page_index, text, recogn_offset, recogn_length" ++
            " FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    errdefer s.finalize();
    s.bindText(1, doc.md5);
    return .{ .stmt = s, .ranged = doc.kind == 1 };
}

// ---------------------------------------------------------------------------
// The three passes
// ---------------------------------------------------------------------------

const FoldResult = struct {
    ns: u64,
    terms_chars: usize,
};

/// The tokenizer cost alone: `fuzzy.foldRows` per page plus the terms line,
/// on a private in-memory connection as the derive path uses.
fn foldPass(gpa: std.mem.Allocator, io: Io, db: sqlite.Db, doc: Doc) !FoldResult {
    var fold = try sqlite.Db.openMemory();
    defer fold.close();

    var src = try pageSource(db, doc);
    defer src.stmt.finalize();

    var line: std.ArrayList(u8) = .empty; // one buffer for the document, as TermsWriter has
    defer line.deinit(gpa);
    var chars: usize = 0;

    const t0 = Io.Clock.awake.now(io);
    while (try src.next()) |page| {
        line.clearRetainingCapacity();
        var rows = try fuzzy.foldRows(fold, page.text);
        defer rows.finalize();
        var any = false;
        while (try rows.step()) {
            const term = rows.columnText(0);
            if (term.len == 0) continue;
            if (any) try line.append(gpa, ' ');
            try line.appendSlice(gpa, term);
            any = true;
        }
        chars += line.items.len;
    }
    const t1 = Io.Clock.awake.now(io);
    return .{ .ns = @intCast(t0.durationTo(t1).toNanoseconds()), .terms_chars = chars };
}

const SplitResult = struct {
    ddl: u64 = 0,
    reset: u64 = 0,
    insert: u64 = 0,
    vocab: u64 = 0,
    total: u64 = 0,
    terms_chars: usize = 0,
};

/// The fold decomposed into `fuzzy.foldRows`'s four statements, to tell the
/// tokenizer from the round trip. The two SQL literals duplicate locals in
/// `foldRows`; the `FIDELITY` check guards the copy.
fn splitPass(gpa: std.mem.Allocator, io: Io, db: sqlite.Db, doc: Doc) !SplitResult {
    var fold = try sqlite.Db.openMemory();
    defer fold.close();

    var src = try pageSource(db, doc);
    defer src.stmt.finalize();

    var line: std.ArrayList(u8) = .empty;
    defer line.deinit(gpa);
    var out: SplitResult = .{};

    const t_all = Io.Clock.awake.now(io);
    while (try src.next()) |page| {
        line.clearRetainingCapacity();

        var t0 = Io.Clock.awake.now(io);
        try fold.exec(fuzzy.fold_ddl);
        var t1 = Io.Clock.awake.now(io);
        out.ddl += @intCast(t0.durationTo(t1).toNanoseconds());

        t0 = t1;
        try fold.exec(fuzzy.fold_reset_sql);
        t1 = Io.Clock.awake.now(io);
        out.reset += @intCast(t0.durationTo(t1).toNanoseconds());

        t0 = t1;
        {
            var s = try fold.prepare("INSERT INTO temp.token_fold(rowid, t) VALUES(1, ?1);");
            defer s.finalize();
            s.bindText(1, page.text);
            _ = try s.step();
        }
        t1 = Io.Clock.awake.now(io);
        out.insert += @intCast(t0.durationTo(t1).toNanoseconds());

        t0 = t1;
        {
            var s = try fold.prepare("SELECT term, cnt FROM temp.token_fold_vocab;");
            defer s.finalize();
            var any = false;
            while (try s.step()) {
                const term = s.columnText(0);
                if (term.len == 0) continue;
                if (any) try line.append(gpa, ' ');
                try line.appendSlice(gpa, term);
                any = true;
            }
        }
        t1 = Io.Clock.awake.now(io);
        out.vocab += @intCast(t0.durationTo(t1).toNanoseconds());

        out.terms_chars += line.items.len;
    }
    const t_end = Io.Clock.awake.now(io);
    out.total = @intCast(t_all.durationTo(t_end).toNanoseconds());
    return out;
}

fn emitSplit(io: Io, s: SplitResult, rows: usize) !void {
    const per = @as(f64, @floatFromInt(@max(rows, 1)));
    try emit(
        io,
        "  split    {d:>10.1} ms  ddl {d:.2} reset {d:.2} insert {d:.2} vocab {d:.2} ms/page" ++
            "  ({d:.0}% / {d:.0}% / {d:.0}% / {d:.0}%)\n",
        .{
            msOf(s.total),
            msOf(s.ddl) / per,
            msOf(s.reset) / per,
            msOf(s.insert) / per,
            msOf(s.vocab) / per,
            share(s.ddl, s.total),
            share(s.reset, s.total),
            share(s.insert, s.total),
            share(s.vocab, s.total),
        },
    );
}

fn share(part: u64, whole: u64) f64 {
    if (whole == 0) return 0;
    return 100.0 * @as(f64, @floatFromInt(part)) / @as(f64, @floatFromInt(whole));
}

const Recovered = struct {
    stored: u64,
    plain: []u8,
    /// The header's CRC32 re-taken over `plain` and compared.
    crc_ok: bool,
};

/// Reads a stored record back and inflates it. The fragment is flushed, not
/// finished (no BFINAL, so fragments concatenate), so an empty final stored
/// block is appended, as the serve path does.
fn recover(gpa: std.mem.Allocator, io: Io, store: derived.DerivedStore, md5: []const u8) !Recovered {
    var file = try store.open(md5, derivesearch.index_version);
    defer file.close(io);
    const size = (try file.stat(io)).size;

    const raw = try gpa.alloc(u8, @intCast(size));
    defer gpa.free(raw);
    _ = try file.readPositionalAll(io, raw, 0);
    const head = try derived.readHeader(io, file);

    const body = try gpa.alloc(u8, raw.len - derived.header_len + 2);
    defer gpa.free(body);
    @memcpy(body[0 .. raw.len - derived.header_len], raw[derived.header_len..]);
    body[body.len - 2] = 0x03;
    body[body.len - 1] = 0x00;

    const window = try gpa.alloc(u8, std.compress.flate.max_window_len);
    defer gpa.free(window);
    var input: std.Io.Reader = .fixed(body);
    var d = std.compress.flate.Decompress.init(&input, .raw, window);
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    _ = try d.reader.streamRemaining(&out.writer);
    const plain = try out.toOwnedSlice();

    return .{
        .stored = size,
        .plain = plain,
        .crc_ok = head.crc == std.hash.Crc32.hash(plain) and head.len == plain.len,
    };
}

const Compressed = struct { bytes: usize, ns: u64 };

/// Deflate `plain` at `level`, best of `iters`, with `derived.beginFragment`'s
/// container and window, into memory so the number is CPU, not SD card.
fn timeCompress(gpa: std.mem.Allocator, io: Io, plain: []const u8, level: u8, iters: usize) !Compressed {
    const opts: std.compress.flate.Compress.Options = switch (level) {
        1 => .level_1,
        2 => .level_2,
        3 => .level_3,
        4 => .level_4,
        5 => .level_5,
        6 => .level_6,
        7 => .level_7,
        8 => .level_8,
        else => .level_9,
    };
    // Deflate's stored-block worst case is a shade larger than the input.
    const out_buf = try gpa.alloc(u8, plain.len + plain.len / 64 + 4096);
    defer gpa.free(out_buf);
    const window = try gpa.alloc(u8, std.compress.flate.max_window_len);
    defer gpa.free(window);

    var best: u64 = std.math.maxInt(u64);
    var bytes: usize = 0;
    for (0..iters) |_| {
        var sink: std.Io.Writer = .fixed(out_buf);
        const t0 = Io.Clock.awake.now(io);
        var c = try std.compress.flate.Compress.init(&sink, window, .raw, opts);
        try c.writer.writeAll(plain);
        try c.writer.flush();
        const t1 = Io.Clock.awake.now(io);
        best = @min(best, @as(u64, @intCast(t0.durationTo(t1).toNanoseconds())));
        bytes = sink.buffered().len;
    }
    return .{ .bytes = bytes, .ns = best };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const LevelTotal = struct {
    terms_bytes: usize = 0,
    text_bytes: usize = 0,
    terms_ns: u64 = 0,
    text_ns: u64 = 0,
};

const Totals = struct {
    docs: usize = 0,
    rows: usize = 0,
    text_bytes: usize = 0,
    fold_ns: u64 = 0,
    derive_ns: u64 = 0,
    terms_stored: u64 = 0,
    text_stored: u64 = 0,
    terms_plain: usize = 0,
    text_plain: usize = 0,
    split: SplitResult = .{ .total = 0 },
    levels: []LevelTotal = &.{},
};

fn msOf(ns: u64) f64 {
    return @as(f64, @floatFromInt(ns)) / 1_000_000.0;
}

fn mbps(bytes: usize, ns: u64) f64 {
    if (ns == 0) return 0;
    return (@as(f64, @floatFromInt(bytes)) / 1_048_576.0) /
        (@as(f64, @floatFromInt(ns)) / 1_000_000_000.0);
}

/// A `/proc` file reports `st_size = 0`, so size-driven whole-file reads return
/// empty; read it as a stream.
fn statusKb(io: Io, key: []const u8) ?u64 {
    if (@import("builtin").os.tag != .linux) return null;
    var file = Dir.cwd().openFile(io, "/proc/self/status", .{}) catch return null;
    defer file.close(io);
    var read_buf: [1024]u8 = undefined;
    var out: [4096]u8 = undefined;
    var reader = file.reader(io, &read_buf);
    const n = reader.interface.readSliceShort(&out) catch return null;
    var lines = std.mem.splitScalar(u8, out[0..n], '\n');
    while (lines.next()) |line| {
        if (line.len <= key.len or !std.mem.startsWith(u8, line, key) or line[key.len] != ':') continue;
        var fields = std.mem.tokenizeAny(u8, line[key.len + 1 ..], " \t");
        const value = fields.next() orelse return null;
        return std.fmt.parseInt(u64, value, 10) catch null;
    }
    return null;
}

fn emitStatus(io: Io) !void {
    try emit(io, "  proc: VmHWM={?d}KiB VmRSS={?d}KiB RssAnon={?d}KiB\n", .{
        statusKb(io, "VmHWM"), statusKb(io, "VmRSS"), statusKb(io, "RssAnon"),
    });
}

fn emit(io: Io, comptime fmt: []const u8, args: anytype) !void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(io, &buf);
    try w.interface.print(fmt, args);
    try w.interface.flush();
}
