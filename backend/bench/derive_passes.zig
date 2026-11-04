//! The bench passes: fold, split, recover and compress, each timed.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const fuzzy = @import("../services/search/fuzzy.zig");
const derived = @import("../store/derived.zig");
const derivesearch = @import("../services/derive_search.zig");
const Io = std.Io;
const derive_bench = @import("derive.zig");
const Doc = derive_bench.Doc;
const emit = derive_bench.emit;
const msOf = derive_bench.msOf;
const pageSource = derive_bench.pageSource;

// ---------------------------------------------------------------------------

// The three passes
// ---------------------------------------------------------------------------

const FoldResult = struct {
    ns: u64,
    terms_chars: usize,
};

/// The tokenizer cost alone: `fuzzy.foldRows` per page plus the terms line,
/// on a private in-memory connection as the derive path uses.
pub fn foldPass(gpa: std.mem.Allocator, io: Io, db: sqlite.Db, doc: Doc) !FoldResult {
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

pub const SplitResult = struct {
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
pub fn splitPass(gpa: std.mem.Allocator, io: Io, db: sqlite.Db, doc: Doc) !SplitResult {
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

pub fn emitSplit(io: Io, s: SplitResult, rows: usize) !void {
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
pub fn recover(gpa: std.mem.Allocator, io: Io, store: derived.DerivedStore, md5: []const u8) !Recovered {
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
pub fn timeCompress(gpa: std.mem.Allocator, io: Io, plain: []const u8, level: u8, iters: usize) !Compressed {
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
