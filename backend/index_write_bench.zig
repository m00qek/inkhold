//! MEASUREMENT ONLY — `zig build index-write-bench`. Not part of the server, not
//! reachable from it, and it changes nothing about it: a standalone executable
//! that copies an EXISTING database to a scratch file and reports what the
//! server's old write-side search maintenance occupies in it.
//!
//! ## The question it existed to answer, and the half of it that is left
//!
//! schema v14 deletes `segment_fts`,
//! `segment_search`, `search_partitions`, the reserved-band machinery and the
//! `kind = 1` / `kind = 2` rows in `note_page_index`, and said plainly:
//!
//! > re-measure upload latency and worker lock holds: **removing that
//! > maintenance is the actual prize and nobody has measured what it is worth.**
//!
//! A before/after needs the BEFORE taken while the machinery still exists. This
//! is the instrument that took it — **§8.5, on the ARM1176, 2026-09-08**, and
//! the headline is **98.1 s of held `db_lock` for a whole-library ingest**. The
//! shape is `derive_bench.zig`'s, for its reasons: cross-compiled
//! `-Dtarget=arm-linux-musleabihf -Dcpu=arm1176jzf_s`, scp'd to the deployment
//! target, run there — the numbers wanted are the ARM1176's, and a
//! cross-compiled test binary cannot be `zig build test`-run from the dev box.
//!
//! **STEP 8 HAS NOW LANDED, and the timing half of this file went with its
//! subject.** `whole`, `split` and `mint` drove `txt_index.reserve` /
//! `storeChunk` / `finish` — the shipped `search.reserveOwnerBlobBands`,
//! `fillBandChunk` and `finishOwnerBlobBands` with the tenant's row upsert
//! around them. Those functions no longer exist, and a bench that reimplemented
//! them would be timing a museum piece rather than the server: the BEFORE column
//! is taken, and re-taking it is not possible or wanted. What remains is
//! `probe`, which is the AFTER measurement.
//!
//! ## What `probe` says, and why that IS the after-number
//!
//! `probe` reports what the machinery OCCUPIES — segment rows, partitions,
//! `kind = 1`/`kind = 2` rows, the FTS index's own bytes — and every count is
//! guarded on its table existing. Against a migrated database every one of them
//! reads `— (gone)` or zero, beside a `database bytes` figure that can be
//! compared with the same run before the migration. That is the whole AFTER
//! column: **every millisecond §8.5's BEFORE records is now structurally zero,
//! because the statements that spent them are not in the binary.**
//!
//! `whole`, `split` and `mint` are still accepted and still named in `--mode`,
//! and they print `machinery absent` and do nothing. Kept rather than removed so
//! a re-run of the exact §8.5 command line answers the question instead of
//! failing on an argument.
//!
//! `machinery` below is the comptime gate that decides which of those two things
//! happens, and it is computed from `@hasDecl` over the tenant that owned the
//! write. It is not a switch: it reads the code.
//!
//! ## Being a guest on the target
//!
//! `--db` is opened only to be COPIED; every write lands in `--scratch`, which
//! is removed on exit unless `--keep`. Put the scratch file on the SD card and
//! never in `/tmp` — `/tmp` is a tmpfs on this box, and a commit that never
//! reaches an SD card is not the commit the server pays for.

const std = @import("std");
const sqlite = @import("db/sqlite.zig");
const txtindex = @import("services/txt_index.zig");

const Io = std.Io;
const Dir = std.Io.Dir;

/// Does the write-side maintenance step 8 removes still exist?
///
/// The one comptime gate in this file, and it ASKS THE CODE rather than being
/// set by hand: these are the `.txt` tenant's four entry points into the write,
/// and every one of them was `search.reserveOwnerBlobBands` /
/// `fillBandChunk` / `finishOwnerBlobBands` with a row upsert around it. If they
/// ever come back, this file's header is wrong and should be read again.
///
/// It is `false` as of §6 step 8 — verified by building, not promised.
const machinery =
    @hasDecl(txtindex, "reserve") and
    @hasDecl(txtindex, "storeChunk") and
    @hasDecl(txtindex, "finish") and
    @hasDecl(txtindex, "upsertSegment") and
    @hasDecl(txtindex, "chunkEnd");

const usage =
    \\index-write-bench --db PATH [options]
    \\
    \\  --db PATH        corpus database. NEVER written and never opened for
    \\                   writing: it is copied to --scratch and that copy is what
    \\                   the bench mutates. Take a `.backup` snapshot of a live
    \\                   WAL database, never a raw copy.
    \\  --scratch PATH   the writable copy (default index-write-bench.db). Put it
    \\                   on the SAME storage the server's database lives on — a
    \\                   commit to a tmpfs is not the commit being measured.
    \\  --mode probe|whole|split|mint|all   what to run. Since schema
    \\                   v14 landed, `probe` is the only mode with a
    \\                   subject; whole/split/mint say `machinery absent` and do
    \\                   nothing, and are still accepted so the exact command
    \\                   line reproduces rather than failing on an argument.
    \\  --blob MD5       (accepted, and now inert — it selected one document for
    \\                   the timed modes)
    \\  --passes N       (accepted, and now inert — whole/split passes per
    \\                   document)
    \\  --keep           do not delete --scratch on exit
    \\  --label TEXT     free-form tag echoed on the header line
    \\
;

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);

    var db_path: []const u8 = "";
    var scratch_path: []const u8 = "index-write-bench.db";
    var mode: []const u8 = "all";
    var only_blob: []const u8 = "";
    var label: []const u8 = "-";
    var passes: usize = 2;
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
        } else if (std.mem.eql(u8, a, "--scratch")) {
            scratch_path = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--mode")) {
            mode = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--blob")) {
            only_blob = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--label")) {
            label = try next(args, &i);
        } else if (std.mem.eql(u8, a, "--passes")) {
            passes = try std.fmt.parseInt(usize, try next(args, &i), 10);
        } else if (std.mem.eql(u8, a, "--keep")) {
            keep = true;
        } else {
            try emit(io, usage, .{});
            return error.BadArgs;
        }
    }
    if (db_path.len == 0 or passes == 0) {
        try emit(io, usage, .{});
        return error.BadArgs;
    }

    const want_probe = std.mem.eql(u8, mode, "probe") or std.mem.eql(u8, mode, "all");
    const want_whole = std.mem.eql(u8, mode, "whole") or std.mem.eql(u8, mode, "all");
    const want_split = std.mem.eql(u8, mode, "split") or std.mem.eql(u8, mode, "all");
    const want_mint = std.mem.eql(u8, mode, "mint");

    try emit(io,
        \\index-write-bench label={s} db={s} scratch={s} mode={s} passes={d} machinery={s}
        \\
    , .{ label, db_path, scratch_path, mode, passes, if (machinery) "present" else "ABSENT" });

    // The copy. Everything below writes to `scratch`, so `--db` is never opened
    // for writing and a live server's database is never at risk from a run.
    try copyDb(io, db_path, scratch_path);
    defer if (!keep) removeDb(io, scratch_path);

    const scratch_z = try arena.dupeZ(u8, scratch_path);
    const db = try sqlite.Db.open(scratch_z);
    defer db.close();

    if (want_probe) try emitProbe(io, db, "probe");

    if (!machinery and (want_whole or want_split or want_mint)) {
        try emit(io,
            \\
            \\  machinery absent — schema v14 has landed and there is no
            \\  write-side search maintenance left to time. That IS the after-measurement:
            \\  every millisecond §8.5's BEFORE column records is now zero, and `probe`
            \\  above is the evidence that the rows are gone too.
            \\
        , .{});
    }

    try emitStatus(io);
}

// ---------------------------------------------------------------------------
// The scratch copy
// ---------------------------------------------------------------------------

/// Copies `src` to `dst`, and unlinks `dst`'s `-wal`/`-shm` first so a leftover
/// pair from a previous run can never be replayed onto a fresh copy. Streamed in
/// 1 MiB blocks: a 30 MB database is not held in memory on a 426 MB box.
fn copyDb(io: Io, src: []const u8, dst: []const u8) !void {
    removeDb(io, dst);
    var in = try Dir.cwd().openFile(io, src, .{});
    defer in.close(io);
    var out = try Dir.cwd().createFile(io, dst, .{});
    defer out.close(io);

    var buf: [1 << 20]u8 = undefined;
    var at: u64 = 0;
    const size = (try in.stat(io)).size;
    while (at < size) {
        const want: usize = @intCast(@min(@as(u64, buf.len), size - at));
        _ = try in.readPositionalAll(io, buf[0..want], at);
        try out.writePositionalAll(io, buf[0..want], at);
        at += want;
    }
}

fn removeDb(io: Io, path: []const u8) void {
    var name_buf: [4096]u8 = undefined;
    for ([_][]const u8{ "", "-wal", "-shm" }) |suffix| {
        const p = std.fmt.bufPrint(&name_buf, "{s}{s}", .{ path, suffix }) catch continue;
        Dir.cwd().deleteFile(io, p) catch {};
    }
}

/// What the machinery occupies, in rows and in bytes — and, after §6 step 8, the
/// AFTER measurement: every row of it at zero and every table of it gone.
///
/// **`needs` is asked of `sqlite_master` FIRST rather than letting the count
/// fail.** A missing table is the expected answer here, not a fault, and
/// `sqlite.Db.prepare` logs `std.log.err` for a statement that will not compile —
/// so probing by failure printed five error lines above the very result they
/// were reporting. Asking whether the object exists says the same thing quietly.
fn emitProbe(io: Io, db: sqlite.Db, tag: []const u8) !void {
    try emit(io, "\n{s}:\n", .{tag});
    const counts = [_]struct { label: []const u8, needs: ?[]const u8 = null, sql: []const u8 }{
        .{ .label = "segment_search rows       ", .needs = "segment_search", .sql = "SELECT count(*) FROM segment_search;" },
        .{ .label = "search_partitions rows    ", .needs = "search_partitions", .sql = "SELECT count(*) FROM search_partitions;" },
        .{ .label = "segment_fts indexed docs  ", .needs = "segment_fts_docsize", .sql = "SELECT count(*) FROM segment_fts_docsize;" },
        .{ .label = "segment_fts index bytes   ", .needs = "segment_fts_data", .sql = "SELECT coalesce(sum(length(block)), 0) FROM segment_fts_data;" },
        .{ .label = "note_page_index kind=0    ", .sql = "SELECT count(*) FROM note_page_index WHERE kind = 0;" },
        .{ .label = "note_page_index kind=1    ", .sql = "SELECT count(*) FROM note_page_index WHERE kind = 1;" },
        .{ .label = "note_page_index kind=2    ", .sql = "SELECT count(*) FROM note_page_index WHERE kind = 2;" },
        .{ .label = "note_page_index text bytes", .sql = "SELECT coalesce(sum(length(text)), 0) FROM note_page_index WHERE kind <> 0;" },
        .{ .label = "database bytes            ", .sql = "SELECT (SELECT * FROM pragma_page_count) * (SELECT * FROM pragma_page_size);" },
    };
    for (counts) |c| {
        const v: ?i64 = blk: {
            if (c.needs) |name| if (!try hasObject(db, name)) break :blk null;
            var r = (db.row(c.sql, &.{}) catch break :blk null) orelse break :blk null;
            defer r.finalize();
            break :blk r.int(0);
        };
        if (v) |n| {
            try emit(io, "  {s} {d}\n", .{ c.label, n });
        } else {
            try emit(io, "  {s} — (gone)\n", .{c.label});
        }
    }
}

/// Does `sqlite_master` carry an object of this name? Includes FTS5's shadow
/// tables, which is what the probe asks about.
fn hasObject(db: sqlite.Db, name: []const u8) !bool {
    var r = (try db.row(
        "SELECT count(*) FROM sqlite_master WHERE name = ?1;",
        &.{.{ .text = name }},
    )) orelse return false;
    defer r.finalize();
    return r.int(0) > 0;
}

/// The p-th percentile of an ALREADY SORTED slice, nearest-rank. Nearest-rank
/// and not interpolated because a lock hold is a real event: p95 should name a
/// transaction that actually happened.
fn pct(sorted: []const u64, p: usize) u64 {
    if (sorted.len == 0) return 0;
    const rank = (p * sorted.len + 99) / 100; // ceil
    return sorted[@min(rank, sorted.len) - 1];
}

fn nsBetween(a: Io.Timestamp, b: Io.Timestamp) u64 {
    return @intCast(a.durationTo(b).toNanoseconds());
}

fn msOf(ns: u64) f64 {
    return @as(f64, @floatFromInt(ns)) / 1_000_000.0;
}

fn share(part: u64, whole: u64) f64 {
    if (whole == 0) return 0;
    return 100.0 * @as(f64, @floatFromInt(part)) / @as(f64, @floatFromInt(whole));
}

/// `/proc/self/status`, read the same way `derive_bench.zig` and `health.zig`
/// read it and for the same stated reason: a `/proc` file reports `st_size = 0`,
/// so the size-driven whole-file helpers return an empty slice and every figure
/// silently reads as "unknown" on the one platform that can answer.
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
