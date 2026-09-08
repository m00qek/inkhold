//! MEASUREMENT ONLY — `zig build bench`. Not part of the server, not reachable
//! from it, and it changes nothing about it: this is a standalone executable
//! that opens an EXISTING corpus read-only and times library-wide search on it.
//!
//! It exists because every fix to global search so far has been measured as a
//! RATIO (VM steps before/after), and nobody had the ABSOLUTE wall-clock cost of
//! one page on the deployment target. See `docs/scratch/search-baseline.md`.
//!
//! ## What it measures
//!
//!   * `--mode matrix` — one page of the document stream at a given term
//!     density and page depth, repeated, reported as p50/p95 with the
//!     deterministic `DocPage.vm_steps` beside it. Depth is reached by
//!     following the REAL cursor, so a resumed page carries the tighter `hi`
//!     bound a resumed page really has.
//!   * `--mode decompose` — where one document's share of that goes: the FTS
//!     posting seek, the four-way join, SQLite's `snippet()`, the Zig-side
//!     escaping, and `bandStart`'s validation lookup. Every variant replays the
//!     IDENTICAL sequence of seeks the real loop issued (`query.bench.trace`),
//!     so a difference between two of them is column work and nothing else.
//!   * `--mode fuzzy` — the ZERO-HIT path, which `search-baseline.md` §7 records
//!     as UNMEASURED: primary pass, whole-vocabulary scan, re-MATCH and
//!     `rankExactFirst`, each timed separately, p50/p95 over the total. Feeds
//!     `docs/scratch/wasm-fuzzy-bench.md`.
//!   * `--mode scan` — `buildFuzzyMatch` ALONE against `segment_fts`, so the
//!     vocabulary ladder can be walked on databases that hold nothing but a
//!     vocabulary. This is the term `fuzzy.zig`'s scaling assumption is about,
//!     isolated from everything the rest of a search does.
//!
//! The connection is `openReadOnly` because `/api/controlplane/search` is a
//! `read_only` route and therefore served by the reader pool — benching the
//! writer's connection would bench a different cache size.

const std = @import("std");
const sqlite = @import("db/sqlite.zig");
const query = @import("services/search/query.zig");
const fuzzy = @import("services/search/fuzzy.zig");

const usage =
    \\search_bench --db PATH --user N --term WORD [options]
    \\
    \\  --mode matrix|decompose|fuzzy|scan   what to run (default matrix)
    \\  --db PATH                 corpus database (opened READ-ONLY)
    \\  --user N                  user id whose library is searched (not used by --mode scan)
    \\  --term WORD               the query, as typed
    \\  --limit N                 documents per page (default 10, the shipped page)
    \\  --depth N                 page number: 1 = no cursor, N follows N-1 cursors
    \\  --iters N                 timed iterations (default 30)
    \\  --warmup N                untimed iterations first (default 3)
    \\
;

const Mode = enum { matrix, decompose, fuzzy, scan };

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;
    const args = try init.minimal.args.toSlice(init.arena.allocator());

    var db_path: []const u8 = "";
    var term: []const u8 = "";
    var user_id: u64 = 0;
    var limit: usize = 10;
    var depth: usize = 1;
    var iters: usize = 30;
    var warmup: usize = 3;
    var mode: Mode = .matrix;

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
        } else if (std.mem.eql(u8, a, "--user")) {
            user_id = try std.fmt.parseInt(u64, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--limit")) {
            limit = try std.fmt.parseInt(usize, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--depth")) {
            depth = try std.fmt.parseInt(usize, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--iters")) {
            iters = try std.fmt.parseInt(usize, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--warmup")) {
            warmup = try std.fmt.parseInt(usize, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--mode")) {
            mode = std.meta.stringToEnum(Mode, try next(args, &i)) orelse {
                try emit(io, usage, .{});
                return error.BadArgs;
            };
        } else {
            try emit(io, usage, .{});
            return error.BadArgs;
        }
    }
    // `--mode scan` touches only `segment_fts`, so it needs no account: the
    // vocabulary ladder databases hold a vocabulary and nothing else.
    if (db_path.len == 0 or term.len == 0 or (user_id == 0 and mode != .scan)) {
        try emit(io, usage, .{});
        return error.BadArgs;
    }

    const path_z = try init.arena.allocator().dupeZ(u8, db_path);
    const db = try sqlite.Db.openReadOnly(path_z);
    defer db.close();

    return switch (mode) {
        .decompose => runDecompose(gpa, io, db, user_id, term, limit, depth),
        .matrix => runMatrix(gpa, io, db, user_id, term, limit, depth, iters, warmup),
        .fuzzy => runFuzzy(gpa, io, db, user_id, term, limit, iters, warmup),
        .scan => runScan(gpa, io, db, term, iters, warmup),
    };
}

/// How many distinct terms `segment_fts` holds — V in `fuzzy.zig`'s
/// `O(V · T · (L² + cap))`, and the number its "71 distinct terms" is a claim
/// about. Counted through the SAME `fts5vocab` table the scan walks, so it
/// cannot disagree with what the scan actually visits.
fn vocabSize(db: sqlite.Db) !u64 {
    try db.exec(fuzzy_vocab_ddl);
    var s = try db.prepare("SELECT COUNT(*) FROM temp.segment_vocab;");
    defer s.finalize();
    if (!try s.step()) return 0;
    return @intCast(s.columnInt(0));
}

const fuzzy_vocab_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.segment_vocab " ++
    "USING fts5vocab('main','segment_fts','row');";

/// The zero-hit path end to end, phase by phase. Every iteration re-runs the
/// REAL `collectDocs` / `buildFuzzyMatch` / `rankExactFirst` on a fresh arena,
/// exactly as `searchPages` would.
fn runFuzzy(
    gpa: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    user_id: u64,
    term: []const u8,
    limit: usize,
    iters: usize,
    warmup: usize,
) !void {
    const v = try vocabSize(db);

    const total = try gpa.alloc(u64, iters);
    defer gpa.free(total);
    const primary = try gpa.alloc(u64, iters);
    defer gpa.free(primary);
    const scan = try gpa.alloc(u64, iters);
    defer gpa.free(scan);
    const rematch = try gpa.alloc(u64, iters);
    defer gpa.free(rematch);
    const rank = try gpa.alloc(u64, iters);
    defer gpa.free(rank);

    var last: query.bench.Fuzzy = undefined;
    for (0..warmup + iters) |n| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const f = try query.bench.fuzzyPage(arena.allocator(), io, db, user_id, term, limit);
        if (n >= warmup) {
            const k = n - warmup;
            total[k] = f.total_ns;
            primary[k] = f.primary_ns;
            scan[k] = f.scan_ns;
            rematch[k] = f.rematch_ns;
            rank[k] = f.rank_ns;
            last = f;
        }
    }
    for ([_][]u64{ total, primary, scan, rematch, rank }) |s| std.mem.sort(u64, s, {}, std.sort.asc(u64));

    try emit(
        io,
        "term={s} vocab_terms={d} expanded={} alts={d} match_bytes={d} widened_rows={d} n={d}\n" ++
            "  TOTAL      p50={d:.1}ms p95={d:.1}ms min={d:.1}ms max={d:.1}ms\n" ++
            "  primary    p50={d:.1}ms p95={d:.1}ms\n" ++
            "  vocab SCAN p50={d:.1}ms p95={d:.1}ms\n" ++
            "  re-MATCH   p50={d:.1}ms p95={d:.1}ms\n" ++
            "  rankExact  p50={d:.1}ms p95={d:.1}ms\n",
        .{
            term,                 v,                 last.expanded,        last.alts,
            last.match_len,       last.widened_rows, iters,                ms(pct(total, 50)),
            ms(pct(total, 95)),   ms(total[0]),      ms(total[iters - 1]), ms(pct(primary, 50)),
            ms(pct(primary, 95)), ms(pct(scan, 50)), ms(pct(scan, 95)),    ms(pct(rematch, 50)),
            ms(pct(rematch, 95)), ms(pct(rank, 50)), ms(pct(rank, 95)),
        },
    );
}

/// `buildFuzzyMatch` alone, against whatever `segment_fts` the database holds.
/// Nothing else runs: no partition lookup, no `collectDocs`, no account. This is
/// the vocabulary scan isolated, so a ladder of databases differing ONLY in
/// vocabulary size measures the slope directly.
fn runScan(
    gpa: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    term: []const u8,
    iters: usize,
    warmup: usize,
) !void {
    const v = try vocabSize(db);
    const samples = try gpa.alloc(u64, iters);
    defer gpa.free(samples);

    // Read exactly as `searchPages` reads `q=`: no trailing space is the PREFIX
    // query the browser actually sends.
    const still_typing = term.len > 0 and term[term.len - 1] != ' ';
    const trimmed = std.mem.trim(u8, term, " \t\r\n");

    var alts: usize = 0;
    var expanded = false;
    for (0..warmup + iters) |n| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const t0 = std.Io.Clock.awake.now(io);
        const e = try fuzzy.buildFuzzyMatch(
            arena.allocator(),
            db,
            trimmed,
            still_typing,
            fuzzy.max_fuzzy_terms,
            .corpus,
        );
        const t1 = std.Io.Clock.awake.now(io);
        if (e) |x| std.mem.doNotOptimizeAway(x.match.ptr);
        if (n >= warmup) {
            samples[n - warmup] = @intCast(t0.durationTo(t1).toNanoseconds());
            expanded = e != null;
            alts = if (e) |x| x.alts.len else 0;
        }
    }
    std.mem.sort(u64, samples, {}, std.sort.asc(u64));

    try emit(
        io,
        "SCAN term={s} prefix={} vocab_terms={d} expanded={} alts={d} | " ++
            "p50={d:.2}ms p95={d:.2}ms min={d:.2}ms max={d:.2}ms n={d} | ns_per_term_p50={d:.1}\n",
        .{
            trimmed,
            still_typing,
            v,
            expanded,
            alts,
            ms(pct(samples, 50)),
            ms(pct(samples, 95)),
            ms(samples[0]),
            ms(samples[iters - 1]),
            iters,
            if (v == 0) 0 else @as(f64, @floatFromInt(pct(samples, 50))) / @as(f64, @floatFromInt(v)),
        },
    );
}

/// The cursor that reaches page `depth` — followed for real, so page 3 is the
/// page a client following two "More" taps would actually get.
fn cursorForDepth(
    gpa: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    user_id: u64,
    term: []const u8,
    limit: usize,
    depth: usize,
) !?[]const u8 {
    if (depth <= 1) return null;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var cursor: ?[]const u8 = null;
    var page: usize = 1;
    while (page < depth) : (page += 1) {
        const p = try query.bench.page(arena.allocator(), io, db, user_id, term, limit, cursor);
        cursor = p.cursor orelse return error.StreamTooShort;
    }
    // Out of the arena, which is about to go.
    return try gpa.dupe(u8, cursor.?);
}

fn runMatrix(
    gpa: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    user_id: u64,
    term: []const u8,
    limit: usize,
    depth: usize,
    iters: usize,
    warmup: usize,
) !void {
    const cursor = try cursorForDepth(gpa, io, db, user_id, term, limit, depth);
    defer if (cursor) |c| gpa.free(c);

    const samples = try gpa.alloc(u64, iters);
    defer gpa.free(samples);

    var last: query.bench.Page = undefined;
    for (0..warmup + iters) |n| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const t0 = std.Io.Clock.awake.now(io);
        const p = try query.bench.page(arena.allocator(), io, db, user_id, term, limit, cursor);
        const t1 = std.Io.Clock.awake.now(io);
        std.mem.doNotOptimizeAway(p.docs);
        if (n >= warmup) {
            samples[n - warmup] = @intCast(t0.durationTo(t1).toNanoseconds());
            last = p;
        }
    }
    std.mem.sort(u64, samples, {}, std.sort.asc(u64));

    try emit(
        io,
        "term={s} depth={d} limit={d} | docs={d} rows={d} fanout={d} band_lookups={d} " ++
            "vm_steps={d} snippet_bytes={d} more={} | p50={d:.1}ms p95={d:.1}ms " ++
            "min={d:.1}ms max={d:.1}ms n={d}\n",
        .{
            term,              depth,                        limit,
            last.docs,         last.rows,                    last.fanouts,
            last.band_lookups, last.vm_steps,                last.snippet_bytes,
            last.more,         ms(pct(samples, 50)),         ms(pct(samples, 95)),
            ms(samples[0]),    ms(samples[samples.len - 1]), iters,
        },
    );
}

fn runDecompose(
    gpa: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    user_id: u64,
    term: []const u8,
    limit: usize,
    depth: usize,
) !void {
    const cursor = try cursorForDepth(gpa, io, db, user_id, term, limit, depth);
    defer if (cursor) |c| gpa.free(c);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    // THE FIDELITY GATE. The trace is a transcription of `collectDocs`, so it
    // must cost exactly what `collectDocs` costs. If it does not, every number
    // below is measuring something else and the run is void.
    const real = try query.bench.page(a, io, db, user_id, term, limit, cursor);
    var traced_steps: i64 = 0;
    const tr = try query.bench.trace(a, io, db, user_id, term, limit, cursor, &traced_steps);
    if (traced_steps != real.vm_steps) {
        try emit(io, "FIDELITY FAILED: trace {d} steps, real {d} — decomposition void\n", .{ traced_steps, real.vm_steps });
        return error.TraceDrift;
    }

    try emit(io, "term={s} depth={d} docs={d} seeks={d} band_lookups={d} vm_steps={d}\n", .{
        term, depth, real.docs, tr.seeks.len, tr.bands.len, real.vm_steps,
    });

    // Each variant is timed over `reps` replays of the SAME seek sequence. The
    // reps are what lift a sub-millisecond difference above this box's clock.
    const reps = 20;
    inline for (.{
        .{ query.bench.Variant.prod, "prod (snippet + escape)" },
        .{ query.bench.Variant.raw_snippet, "raw_snippet (no escape)" },
        .{ query.bench.Variant.no_snippet, "no_snippet" },
        .{ query.bench.Variant.fts_only, "fts_only (no joins)" },
        .{ query.bench.Variant.prod_one_row, "prod, no spare row" },
    }) |v| {
        var best: u64 = std.math.maxInt(u64);
        var total: u64 = 0;
        var steps: i64 = 0;
        for (0..reps) |_| {
            var it_arena = std.heap.ArenaAllocator.init(gpa);
            defer it_arena.deinit();
            const t0 = std.Io.Clock.awake.now(io);
            steps = try query.bench.replay(it_arena.allocator(), io, db, user_id, term, v[0], tr.seeks);
            const t1 = std.Io.Clock.awake.now(io);
            const ns: u64 = @intCast(t0.durationTo(t1).toNanoseconds());
            best = @min(best, ns);
            total += ns;
        }
        try emit(io, "  {s: <26} best={d:.2}ms mean={d:.2}ms vm_steps={d}\n", .{
            v[1], ms(best), ms(total / reps), steps,
        });
    }

    {
        var best: u64 = std.math.maxInt(u64);
        var total: u64 = 0;
        var steps: i64 = 0;
        for (0..reps) |_| {
            const t0 = std.Io.Clock.awake.now(io);
            steps = try query.bench.replayBands(db, tr.bands);
            const t1 = std.Io.Clock.awake.now(io);
            const ns: u64 = @intCast(t0.durationTo(t1).toNanoseconds());
            best = @min(best, ns);
            total += ns;
        }
        try emit(io, "  {s: <26} best={d:.2}ms mean={d:.2}ms vm_steps={d} (n={d})\n", .{
            "band_start lookups", ms(best), ms(total / reps), steps, tr.bands.len,
        });
    }
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
