//! MEASUREMENT ONLY — `zig build indoc-bench`. Not part of the server, not
//! reachable from it, and it changes nothing about it: a standalone executable
//! that opens an EXISTING corpus read-only and times IN-DOCUMENT search on it.
//!
//! ## The question it exists to answer
//!
//! `docs/scratch/client-side-search-impl.md` §7.3. Phase 2 of the client-side
//! search plan deletes `segment_fts` (51.7 % of the database, plus the FTS write
//! every upload pays) and assumes that requires moving find-in-note into the
//! browser. §7.3 observes it might not: `searchHistoryPages` already does
//! server-side find-in-note WITHOUT `segment_fts`, by scanning
//! `note_page_index.text` for one blob and counting each page through the
//! ephemeral `temp.token_fold`. If `searchNotePages` and `searchTxtSegments` can
//! adopt that shape, phase 2 is a server-side refactor with no client work.
//!
//! Both alternatives are SHIPPED, so this needs no prototype — it times the two
//! against each other on the deployment target.
//!
//! ## The equivalence, stated once and held
//!
//! **TOTAL COST TO THE SAME ANSWER.** The FTS path returns a bounded batch plus
//! a cursor and the client auto-drains it; the scan returns everything in one
//! pass. One batch against one whole scan would be meaningless, so `--mode fts`
//! DRAINS — it follows its own cursors until the stream ends and reports the sum
//! of every request in the drain, with the per-request maximum beside it.
//!
//! **What that per-request maximum is, precisely.** All five in-doc routes are
//! `read_only = true`, so `dispatchLocked` runs them on a POOLED reader and holds
//! `db_lock` only for the session read before dispatch — the handler body holds
//! no lock on the happy path. The maximum is therefore the READER-OCCUPANCY
//! window: how long one of `reader_pool.default_size` (3) connections is tied up.
//! It becomes a real `db_lock` hold in the pool-exhaustion fallback, which
//! `dispatchReadOnly` takes on the writer for the whole handler — so on a box
//! with three long scans in flight, the fourth request freezes everything for
//! this number. `--mode scan` is one call, so its total and its maximum are the
//! same, and that is precisely the fairness question the batching exists to fix.
//!
//! ## The fidelity gate
//!
//! Every run cross-checks the two paths' ANSWERS — matching pages and total word
//! instances — and reports `FIDELITY` on the line. A configuration where they
//! disagree is measuring two different questions and its times mean nothing.
//!
//! The connection is `openReadOnly` because both in-doc routes are `read_only`
//! and therefore served by the reader pool; benching the writer's connection
//! would bench a different cache size.

const std = @import("std");
const sqlite = @import("db/sqlite.zig");
const query = @import("services/search/query.zig");

const usage =
    \\indoc-bench --db PATH --user N --file ID --term WORD [options]
    \\
    \\  --mode fts|scan|stepped|both   what to run (default both)
    \\  --db PATH                      corpus database (opened READ-ONLY)
    \\  --user N                       user id who owns the file
    \\  --file ID                      files.id of the document searched
    \\  --kind note|txt                which live read to compare (default note)
    \\  --term WORD                    the query, as typed
    \\  --batch N                      FTS drain stride (default 20, the shipped one)
    \\  --iters N                      timed iterations (default 5)
    \\  --warmup N                     untimed iterations first (default 1)
    \\  --label TEXT                   free-form tag echoed on the output line
    \\
;

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;
    const args = try init.minimal.args.toSlice(init.arena.allocator());

    var db_path: []const u8 = "";
    var term: []const u8 = "";
    var label: []const u8 = "-";
    var mode: []const u8 = "both";
    var user_id: u64 = 0;
    var file_id: u64 = 0;
    var txt = false;
    var batch: i64 = query.default_batch;
    var iters: usize = 5;
    var warmup: usize = 1;

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
        } else if (std.mem.eql(u8, a, "--term")) {
            term = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--label")) {
            label = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--mode")) {
            mode = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--kind")) {
            txt = std.mem.eql(u8, try next(args, &i), "txt");
        } else if (std.mem.eql(u8, a, "--user")) {
            user_id = try std.fmt.parseInt(u64, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--file")) {
            file_id = try std.fmt.parseInt(u64, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--batch")) {
            batch = try std.fmt.parseInt(i64, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--iters")) {
            iters = try std.fmt.parseInt(usize, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--warmup")) {
            warmup = try std.fmt.parseInt(usize, try next(args, &i), 10);
        } else {
            try emit(io, usage, .{});
            return error.BadArgs;
        }
    }
    if (db_path.len == 0 or term.len == 0 or user_id == 0 or file_id == 0) {
        try emit(io, usage, .{});
        return error.BadArgs;
    }

    const path_z = try init.arena.allocator().dupeZ(u8, db_path);
    const db = try sqlite.Db.openReadOnly(path_z);
    defer db.close();

    // The scan is addressed by BLOB, the FTS read by file id — the same document
    // either way, and resolving it here is what lets the fidelity gate compare
    // them at all.
    const md5 = blk: {
        const r = (try db.row("SELECT md5 FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0;", &.{
            .{ .int = @intCast(file_id) },
            .{ .int = @intCast(user_id) },
        })) orelse return error.NoSuchFile;
        break :blk try init.arena.allocator().dupe(u8, r.text(0));
    };

    const want_fts = std.mem.eql(u8, mode, "fts") or std.mem.eql(u8, mode, "both");
    const want_scan = std.mem.eql(u8, mode, "scan") or std.mem.eql(u8, mode, "both");
    const want_step = std.mem.eql(u8, mode, "stepped") or std.mem.eql(u8, mode, "both");

    var fts_answer: ?Answer = null;
    var scan_answer: ?Answer = null;

    if (want_fts) {
        const r = try run(gpa, io, db, .{ .fts = .{
            .user_id = user_id,
            .file_id = file_id,
            .batch = batch,
        } }, txt, term, iters, warmup);
        fts_answer = r.answer;
        try report(io, label, "fts     ", term, r, batch);
    }
    if (want_scan) {
        const r = try run(gpa, io, db, .{ .scan = md5 }, txt, term, iters, warmup);
        scan_answer = r.answer;
        try report(io, label, "scan    ", term, r, 0);
    }
    if (want_step) {
        const r = try run(gpa, io, db, .{ .stepped = md5 }, txt, term, iters, warmup);
        try report(io, label, "stepped ", term, r, 0);
        if (scan_answer) |s| try fidelity(io, "scan-vs-stepped", s, r.answer);
    }
    if (fts_answer) |f| if (scan_answer) |s| try fidelity(io, "fts-vs-scan", f, s);

    // Process-wide high-water marks, read once at the end. `VmHWM` is peak RSS
    // and monotonic, so a single read IS the peak; `RssAnon` is instantaneous,
    // which is why the per-iteration sampler below carries the peak that matters.
    try emitStatus(io);
}

/// The ANSWER a configuration produced, independent of how it produced it —
/// what the fidelity gate compares.
const Answer = struct {
    pages: usize,
    matches: i64,
};

const Config = union(enum) {
    fts: struct { user_id: u64, file_id: u64, batch: i64 },
    scan: []const u8,
    stepped: []const u8,
};

const Run = struct {
    answer: Answer,
    /// Per-iteration TOTAL wall clock to the complete answer, sorted.
    totals: []u64,
    /// The largest SINGLE call in the cheapest-total iteration — one request's
    /// reader-occupancy window, and the `db_lock` hold it becomes when the pool
    /// is exhausted. A drained stream splits this; a scan does not.
    longest_call: u64,
    /// Requests the drain needed (1 for a scan).
    calls: usize,
    /// `temp.token_fold` round trips — one per page the path counted.
    folds: usize,
    /// Rows the path READ, matching or not.
    rows_read: usize,
    /// Bytes of page text it read.
    text_bytes: usize,
    /// Peak `RssAnon` observed while an answer was alive, in KiB.
    peak_rss_anon_kb: u64,
    /// Peak arena bytes held at the moment the answer was complete.
    peak_arena: usize,
};

fn run(
    gpa: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    cfg: Config,
    txt: bool,
    term: []const u8,
    iters: usize,
    warmup: usize,
) !Run {
    const totals = try gpa.alloc(u64, iters);
    var out: Run = .{
        .answer = .{ .pages = 0, .matches = 0 },
        .totals = totals,
        .longest_call = 0,
        .calls = 0,
        .folds = 0,
        .rows_read = 0,
        .text_bytes = 0,
        .peak_rss_anon_kb = 0,
        .peak_arena = 0,
    };
    var best_total: u64 = std.math.maxInt(u64);

    for (0..warmup + iters) |n| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const a = arena.allocator();

        var total: u64 = 0;
        var longest: u64 = 0;
        var calls: usize = 0;
        var answer: Answer = .{ .pages = 0, .matches = 0 };
        var folds: usize = 0;
        var rows_read: usize = 0;
        var text_bytes: usize = 0;

        switch (cfg) {
            // THE DRAIN. Not one batch — every batch, following the real cursor,
            // until the stream says it is exhausted. That is the same answer the
            // scan gives in one call, and the only fair thing to put beside it.
            .fts => |f| {
                var cursor: ?[]const u8 = null;
                while (true) {
                    const t0 = std.Io.Clock.awake.now(io);
                    if (txt) {
                        const r = try query.searchTxtSegments(a, db, f.user_id, f.file_id, term, cursor, f.batch);
                        const t1 = std.Io.Clock.awake.now(io);
                        const ns: u64 = @intCast(t0.durationTo(t1).toNanoseconds());
                        total += ns;
                        longest = @max(longest, ns);
                        calls += 1;
                        for (r.segments) |seg| answer.matches += seg.matches;
                        answer.pages += r.segments.len;
                        folds += r.segments.len;
                        cursor = r.cursor orelse break;
                    } else {
                        const r = try query.searchNotePages(a, db, f.user_id, f.file_id, term, cursor, f.batch);
                        const t1 = std.Io.Clock.awake.now(io);
                        const ns: u64 = @intCast(t0.durationTo(t1).toNanoseconds());
                        total += ns;
                        longest = @max(longest, ns);
                        calls += 1;
                        for (r.pages) |p| answer.matches += p.matches;
                        answer.pages += r.pages.len;
                        folds += r.pages.len;
                        cursor = r.cursor orelse break;
                    }
                }
                // The FTS path never reads a non-matching page's text, which is
                // the whole of its advantage; recorded as such rather than left
                // blank.
                rows_read = answer.pages;
            },
            .scan => |md5| {
                const t0 = std.Io.Clock.awake.now(io);
                const s = if (txt)
                    try query.indoc_bench.scanTxt(a, db, md5, term)
                else
                    try query.indoc_bench.scanNote(a, db, md5, term);
                const t1 = std.Io.Clock.awake.now(io);
                total = @intCast(t0.durationTo(t1).toNanoseconds());
                longest = total;
                calls = 1;
                answer = .{ .pages = s.pages, .matches = s.matches };
                folds = s.folds;
                rows_read = s.rows_read;
                text_bytes = s.text_bytes;
            },
            .stepped => |md5| {
                const t0 = std.Io.Clock.awake.now(io);
                const s = try query.indoc_bench.scanStepped(a, gpa, db, md5, term, txt);
                const t1 = std.Io.Clock.awake.now(io);
                total = @intCast(t0.durationTo(t1).toNanoseconds());
                longest = total;
                calls = 1;
                answer = .{ .pages = s.pages, .matches = s.matches };
                folds = s.folds;
                rows_read = s.rows_read;
                text_bytes = s.text_bytes;
            },
        }

        // Sampled HERE — with the answer complete and the arena not yet
        // released, i.e. at the configuration's own high-water mark. Sampling
        // after `deinit` would report the floor and call it the peak.
        const rss = statusKb(io, "RssAnon") orelse 0;
        out.peak_rss_anon_kb = @max(out.peak_rss_anon_kb, rss);

        if (n >= warmup) {
            totals[n - warmup] = total;
            out.answer = answer;
            out.folds = folds;
            out.rows_read = rows_read;
            out.text_bytes = text_bytes;
            out.calls = calls;
            if (total < best_total) {
                best_total = total;
                out.longest_call = longest;
            }
            out.peak_arena = @max(out.peak_arena, arena.queryCapacity());
        }
    }
    std.mem.sort(u64, totals, {}, std.sort.asc(u64));
    return out;
}

fn report(io: std.Io, label: []const u8, mode: []const u8, term: []const u8, r: Run, batch: i64) !void {
    try emit(
        io,
        "{s} | {s} | term={s} batch={d} | pages={d} matches={d} calls={d} folds={d} " ++
            "rows_read={d} text={d}KiB | p50={d:.1}ms p95={d:.1}ms min={d:.1}ms max={d:.1}ms " ++
            "longest_call={d:.1}ms | arena={d}KiB rss_anon_peak={d}KiB\n",
        .{
            label,                 mode,
            term,                  batch,
            r.answer.pages,        r.answer.matches,
            r.calls,               r.folds,
            r.rows_read,           r.text_bytes / 1024,
            ms(pct(r.totals, 50)), ms(pct(r.totals, 95)),
            ms(r.totals[0]),       ms(r.totals[r.totals.len - 1]),
            ms(r.longest_call),    r.peak_arena / 1024,
            r.peak_rss_anon_kb,
        },
    );
}

/// The gate. Two paths that disagree about the answer are not two ways of doing
/// the same thing, and timing them against each other would be a category error
/// dressed up as a table.
fn fidelity(io: std.Io, what: []const u8, a: Answer, b: Answer) !void {
    const ok = a.pages == b.pages and a.matches == b.matches;
    try emit(io, "  FIDELITY {s}: {s} — pages {d} vs {d}, matches {d} vs {d}\n", .{
        what,
        if (ok) "OK" else "**MISMATCH**",
        a.pages,
        b.pages,
        a.matches,
        b.matches,
    });
}

/// `/proc/self/status`, read the same way `health.zig` reads it and for the same
/// stated reason: a `/proc` file reports `st_size = 0`, so the size-driven
/// whole-file helpers return an empty slice and every figure silently reads as
/// "unknown" on the one platform that can answer.
fn statusKb(io: std.Io, key: []const u8) ?u64 {
    if (@import("builtin").os.tag != .linux) return null;
    var file = std.Io.Dir.cwd().openFile(io, "/proc/self/status", .{}) catch return null;
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

fn emitStatus(io: std.Io) !void {
    try emit(io, "  proc: VmHWM={?d}KiB VmRSS={?d}KiB RssAnon={?d}KiB\n", .{
        statusKb(io, "VmHWM"), statusKb(io, "VmRSS"), statusKb(io, "RssAnon"),
    });
}

fn pct(sorted: []const u64, p: usize) u64 {
    if (sorted.len == 0) return 0;
    const idx = (sorted.len * p) / 100;
    return sorted[@min(idx, sorted.len - 1)];
}

fn ms(ns: u64) f64 {
    return @as(f64, @floatFromInt(ns)) / 1_000_000.0;
}

fn emit(io: std.Io, comptime fmt: []const u8, args: anytype) !void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(io, &buf);
    try w.interface.print(fmt, args);
    try w.interface.flush();
}
