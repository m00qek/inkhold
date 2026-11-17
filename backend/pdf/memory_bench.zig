//! Measurement only (`zig build pdf-memory-bench`): what MuPDF really costs on
//! the target against what its memory pool counts (`backend/pdf/pool.zig`).
//! For each file: the probe, then a text pass over every page, while a thread
//! samples the process's `RssAnon` every 2 ms. Prints the ceiling's peak, the
//! sampled peak above the idle baseline, and their ratio; a ratio well above 1
//! means the ceiling undercounts what MuPDF holds.
//!
//!     pdf-memory-bench FILE...

const std = @import("std");
const probe = @import("probe.zig");
const text = @import("text.zig");

extern fn ink_pdf_text_held_after_close(fd: c_int) i64;

var peak_anon_kb = std.atomic.Value(usize).init(0);
var sampling = std.atomic.Value(bool).init(true);

fn rssAnonKb() usize {
    var buf: [4096]u8 = undefined;
    const fd = std.c.open("/proc/self/status", .{});
    if (fd < 0) return 0;
    defer _ = std.c.close(fd);
    const got = std.c.read(fd, &buf, buf.len);
    if (got <= 0) return 0;
    const n: usize = @intCast(got);
    const at = std.mem.indexOf(u8, buf[0..n], "RssAnon:") orelse return 0;
    var it = std.mem.tokenizeAny(u8, buf[at + "RssAnon:".len .. n], " \t\n");
    return std.fmt.parseInt(usize, it.next() orelse return 0, 10) catch 0;
}

fn sampler(io: std.Io) void {
    while (sampling.load(.acquire)) {
        const now = rssAnonKb();
        if (now > peak_anon_kb.load(.monotonic)) peak_anon_kb.store(now, .monotonic);
        io.sleep(.fromMilliseconds(2), .awake) catch {};
    }
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    if (args.len < 2) {
        std.debug.print("usage: pdf-memory-bench FILE...\n", .{});
        return error.Usage;
    }
    const t = try std.Thread.spawn(.{}, sampler, .{io});
    defer {
        sampling.store(false, .release);
        t.join();
    }
    std.debug.print("ceiling {d} KB\n", .{probe.budgetBytes() / 1024});
    for (args[1..]) |path| {
        const f = try std.Io.Dir.cwd().openFile(io, path, .{});
        defer f.close(io);
        try measure(io, path, "probe", f);
        try measure(io, path, "text", f);
        const before = rssAnonKb();
        const held = ink_pdf_text_held_after_close(f.handle);
        if (held != 0) std.debug.print("{s} text: {d} bytes still counted after drop (rss_anon {d} -> {d} KB)\n", .{ path, held, before, rssAnonKb() });
    }
}

fn measure(io: std.Io, path: []const u8, pass: []const u8, f: std.Io.File) !void {
    io.sleep(.fromMilliseconds(50), .awake) catch {};
    const base = rssAnonKb();
    peak_anon_kb.store(base, .monotonic);
    const start = std.Io.Clock.awake.now(io);
    var counted: u64 = 0;
    var verdict: []const u8 = "ok";
    var pages: u32 = 0;
    var too_large_pages: u32 = 0;
    if (std.mem.eql(u8, pass, "probe")) {
        const m = probe.probeMeasured(f);
        counted = m.peak_bytes;
        if (m.held_after != 0) std.debug.print("{s} probe: {d} bytes still counted after drop\n", .{ path, m.held_after });
        if (m.result) |s| pages = s.pages else |e| verdict = @errorName(e);
    } else {
        if (text.Extractor.open(f)) |opened| {
            var ex = opened;
            pages = ex.pages;
            var n: u32 = 0;
            while (n < ex.pages) : (n += 1) _ = ex.page(n) catch |e| {
                verdict = @errorName(e);
                break;
            };
            ex.close();
            counted = ex.peak_bytes;
            too_large_pages = ex.too_large_pages;
        } else |e| verdict = @errorName(e);
    }
    const ms = start.durationTo(std.Io.Clock.awake.now(io)).toMilliseconds();
    io.sleep(.fromMilliseconds(10), .awake) catch {};
    const peak = peak_anon_kb.load(.monotonic);
    const delta = peak -| base;
    const counted_kb = counted / 1024;
    const ratio = if (counted_kb == 0) 0 else @as(f64, @floatFromInt(delta)) / @as(f64, @floatFromInt(counted_kb));
    std.debug.print("{s} {s}: {s} pages={d} too_large_pages={d} counted_peak={d} KB rss_anon_base={d} KB peak_delta={d} KB ratio={d:.2} after={d} KB {d} ms\n", .{
        path, pass, verdict, pages, too_large_pages, counted_kb, base, delta, ratio, rssAnonKb(), ms,
    });
}
