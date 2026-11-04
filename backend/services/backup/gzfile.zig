//! Whole files through gzip, in fixed memory: the snapshot database goes in
//! with `deflate` and comes back with `inflate`. Zig's `flate.Decompress`
//! does not check the gzip trailer, so `inflate` does: the CRC-32 and the
//! length it computes must equal the last eight bytes of the file, or a
//! truncated or bit-rotted copy would pass for a whole one.

const std = @import("std");
const blob_copy = @import("blob_copy.zig");
const pace_mod = @import("pace.zig");
const flate = std.compress.flate;
const Io = std.Io;
const Dir = Io.Dir;

/// `src_dir/src` gzipped (level 1) into `dst_dir/dst`, fsynced.
pub fn deflate(io: Io, src_dir: Dir, src: []const u8, dst_dir: Dir, dst: []const u8, s: *blob_copy.Scratch, pace: *pace_mod.Pace) !void {
    const in = try src_dir.openFile(io, src, .{});
    defer in.close(io);
    var fr = in.reader(io, &s.read_buf);
    const out = try dst_dir.createFile(io, dst, .{});
    defer out.close(io);
    var fw = out.writerStreaming(io, &s.write_buf);
    s.compress = try flate.Compress.init(&fw.interface, &s.window, .gzip, .level_1);
    while (true) {
        const n = try fr.interface.readSliceShort(&s.chunk);
        if (n == 0) break;
        try s.compress.writer.writeAll(s.chunk[0..n]);
        pace.take(io, n);
    }
    try s.compress.finish();
    try fw.interface.flush();
    try out.sync(io);
}

pub const InflateError = error{
    /// Not a gzip file, cut short, or its bytes disagree with its trailer.
    GzipCorrupt,
};

/// Inflates `src_dir/src`, checking it against its own trailer. With a `sink`
/// the bytes are written there; without one the file is only checked. The
/// first `head.len` decompressed bytes are copied into `head` for the caller
/// to recognise (an SQLite header, say). Returns the decompressed length.
pub fn inflate(io: Io, src_dir: Dir, src: []const u8, sink: ?*Io.Writer, head: []u8, s: *blob_copy.Scratch, pace: *pace_mod.Pace) !u64 {
    const in = try src_dir.openFile(io, src, .{});
    defer in.close(io);

    const size = try in.length(io);
    if (size < 18) return error.GzipCorrupt; // 10-byte header + 8-byte trailer
    var trailer: [8]u8 = undefined;
    if (try in.readPositionalAll(io, &trailer, size - 8) != 8) return error.GzipCorrupt;
    const want_crc = std.mem.readInt(u32, trailer[0..4], .little);
    const want_len = std.mem.readInt(u32, trailer[4..8], .little);

    var fr = in.reader(io, &s.read_buf);
    var d = flate.Decompress.init(&fr.interface, .gzip, &s.window);
    var crc = std.hash.Crc32.init();
    var total: u64 = 0;
    while (true) {
        const n = d.reader.readSliceShort(&s.chunk) catch return error.GzipCorrupt;
        if (n == 0) break;
        const bytes = s.chunk[0..n];
        if (total < head.len) {
            // Below `head.len`, so it fits a usize on a 32-bit target too.
            const at: usize = @intCast(total);
            const k = @min(head.len - at, n);
            @memcpy(head[at..][0..k], bytes[0..k]);
        }
        crc.update(bytes);
        total += n;
        if (sink) |w| try w.writeAll(bytes);
        pace.take(io, n);
    }
    if (crc.final() != want_crc or @as(u32, @truncate(total)) != want_len) return error.GzipCorrupt;
    return total;
}

// ---- tests ----

const testing = std.testing;
const repeat = @import("../../util/repeat.zig").repeat;

test "a file deflates and inflates back to itself, checked against its trailer" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const s = try testing.allocator.create(blob_copy.Scratch);
    defer testing.allocator.destroy(s);
    var p: pace_mod.Pace = .{ .rate = 0 };
    const body = "SQLite format 3\x00" ++ repeat(u8, "page ", 3000);
    try tmp.dir.writeFile(testing.io, .{ .sub_path = "db", .data = body });
    try deflate(testing.io, tmp.dir, "db", tmp.dir, "db.gz", s, &p);

    var out: Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    var head: [16]u8 = undefined;
    try testing.expectEqual(@as(u64, body.len), try inflate(testing.io, tmp.dir, "db.gz", &out.writer, &head, s, &p));
    try testing.expectEqualSlices(u8, body, out.written());
    try testing.expectEqualSlices(u8, "SQLite format 3\x00", &head);
}

test "a cut or altered gzip file is refused, not half-read" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const s = try testing.allocator.create(blob_copy.Scratch);
    defer testing.allocator.destroy(s);
    var p: pace_mod.Pace = .{ .rate = 0 };
    try tmp.dir.writeFile(testing.io, .{ .sub_path = "db", .data = repeat(u8, "abcdefgh", 4000) });
    try deflate(testing.io, tmp.dir, "db", tmp.dir, "db.gz", s, &p);
    const gz = try tmp.dir.readFileAlloc(testing.io, "db.gz", testing.allocator, .unlimited);
    defer testing.allocator.free(gz);
    var head: [0]u8 = .{};

    try tmp.dir.writeFile(testing.io, .{ .sub_path = "cut.gz", .data = gz[0 .. gz.len - 20] });
    try testing.expectError(error.GzipCorrupt, inflate(testing.io, tmp.dir, "cut.gz", null, &head, s, &p));

    // Same length, one byte of the trailer's CRC flipped.
    gz[gz.len - 6] ^= 0x01;
    try tmp.dir.writeFile(testing.io, .{ .sub_path = "crc.gz", .data = gz });
    try testing.expectError(error.GzipCorrupt, inflate(testing.io, tmp.dir, "crc.gz", null, &head, s, &p));

    try tmp.dir.writeFile(testing.io, .{ .sub_path = "tiny.gz", .data = "x" });
    try testing.expectError(error.GzipCorrupt, inflate(testing.io, tmp.dir, "tiny.gz", null, &head, s, &p));
}
