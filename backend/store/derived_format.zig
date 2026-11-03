//! The stored format of a derived file: header, plain read, and gzip fragments.

const std = @import("std");
// This import is why the file only tests under `zig build test`.
const gzip_stitch = @import("../http/gzip_stitch.zig");
const Io = std.Io;
const File = std.Io.File;
const testing = std.testing;
const md5_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const md5_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const derived = @import("derived.zig");
const DerivedStore = derived.DerivedStore;

// ---- the stored format: a 12-byte header, then one raw-deflate fragment ----

/// `[0..4)` magic "IDF1", `[4..8)` CRC32 of the uncompressed payload (LE),
/// `[8..12)` uncompressed length (LE u32), then a byte-aligned raw-deflate
/// fragment. CRC/length in the file let the stream route build the gzip trailer
/// without touching the DB. Written with `flush()`, never `finish()`, so there
/// is no BFINAL block and fragments concatenate.
pub const header_len = 12;

const magic = "IDF1";

pub const Header = struct {
    crc: u32,
    /// u32 because gzip's ISIZE is.
    len: u32,
};

pub fn readHeader(io: Io, file: File) !Header {
    var buf: [header_len]u8 = undefined;
    const n = try file.readPositionalAll(io, &buf, 0);
    if (n != header_len) return error.BadFragment;
    if (!std.mem.eql(u8, buf[0..4], magic)) return error.BadFragment;
    return .{
        .crc = std.mem.readInt(u32, buf[4..8], .little),
        .len = std.mem.readInt(u32, buf[8..12], .little),
    };
}

/// A stored file's plaintext, for tests and debugging. Caller owns the slice.
/// Appends the terminator: without it the read starves and returns empty.
pub fn readPlain(gpa: std.mem.Allocator, store: DerivedStore, md5: []const u8, version: i64) ![]u8 {
    var file = try store.open(md5, version);
    defer file.close(store.io);

    var body: std.Io.Writer.Allocating = .init(gpa);
    defer body.deinit();
    var buf: [4096]u8 = undefined;
    var off: u64 = header_len;
    while (true) {
        const n = try file.readPositionalAll(store.io, &buf, off);
        if (n == 0) break;
        try body.writer.writeAll(buf[0..n]);
        off += n;
        if (n < buf.len) break;
    }
    try body.writer.writeAll(&gzip_stitch.terminator);

    var input: std.Io.Reader = .fixed(body.written());
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .raw, &window);
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    _ = try d.reader.streamRemaining(&out.writer);
    return out.toOwnedSlice();
}

/// Plaintext in, header + deflate fragment out. Embeds deflate's 64 KB window,
/// so keep it off a deep stack frame.
pub const Fragment = struct {
    staged: DerivedStore.Staged,
    window: [std.compress.flate.max_window_len]u8,
    compress: std.compress.flate.Compress,
    crc: std.hash.Crc32,
    len: u64,

    /// CRC and length are of the plaintext, as the gzip trailer requires.
    pub fn write(f: *Fragment, bytes: []const u8) !void {
        f.crc.update(bytes);
        f.len += bytes.len;
        try f.compress.writer.writeAll(bytes);
    }

    pub fn commit(f: *Fragment) !void {
        try f.compress.writer.flush();

        var head: [header_len]u8 = undefined;
        @memcpy(head[0..4], magic);
        std.mem.writeInt(u32, head[4..8], f.crc.final(), .little);
        std.mem.writeInt(u32, head[8..12], @truncate(f.len), .little);

        try f.staged.interface.flush();
        try f.staged.file.writePositionalAll(f.staged.store.io, &head, 0);
        try f.staged.commit();
    }

    /// Idempotent; safe to `defer` unconditionally.
    pub fn abort(f: *Fragment) void {
        f.staged.abort();
    }
};

pub fn beginFragment(store: DerivedStore, f: *Fragment, md5: []const u8, version: i64) !void {
    try store.begin(&f.staged, md5, version);
    errdefer f.staged.abort();
    f.crc = .init();
    f.len = 0;
    try f.staged.interface.writeAll(&@as([header_len]u8, @splat(0)));
    f.compress = try std.compress.flate.Compress.init(
        f.staged.interface,
        &f.window,
        .raw,
        .level_6,
    );
}

test "a fragment round-trips through the header and inflates" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    const payload =
        "{\"md5\":\"…\",\"v\":7,\"n\":2}\n" ++
        "{\"p\":0,\"t\":\"reuniao orcamento projeto\"}\n" ++
        "{\"p\":1,\"t\":\"reuniao acta\"}\n";

    var f = try testing.allocator.create(Fragment);
    defer testing.allocator.destroy(f);
    try beginFragment(store, f, md5_a, 7);
    errdefer f.abort();
    var it = std.mem.splitScalar(u8, payload, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        try f.write(line);
        try f.write("\n");
    }
    try f.commit();

    var file = try store.open(md5_a, 7);
    defer file.close(io);
    const h = try readHeader(io, file);
    try testing.expectEqual(std.hash.Crc32.hash(payload), h.crc);
    try testing.expectEqual(@as(u32, payload.len), h.len);

    var raw: [8192]u8 = undefined;
    const total = try file.readPositionalAll(io, &raw, 0);
    var body: std.Io.Writer.Allocating = .init(testing.allocator);
    defer body.deinit();
    try body.writer.writeAll(raw[header_len..total]);
    try body.writer.writeAll(&gzip_stitch.terminator);

    var input: std.Io.Reader = .fixed(body.written());
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .raw, &window);
    var got: std.Io.Writer.Allocating = .init(testing.allocator);
    defer got.deinit();
    _ = try d.reader.streamRemaining(&got.writer);
    try testing.expectEqualStrings(payload, got.written());
}

test "two stored fragments concatenate into one deflate stream" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    // Two independently stored fragments must form one deflate stream end to end.
    const a_text = "{\"p\":0,\"t\":\"alpha beta\"}\n";
    const b_text = "{\"p\":0,\"t\":\"gamma delta\"}\n";
    for ([_][2][]const u8{ .{ md5_a, a_text }, .{ md5_b, b_text } }) |pair| {
        var f = try testing.allocator.create(Fragment);
        defer testing.allocator.destroy(f);
        try beginFragment(store, f, pair[0], 1);
        errdefer f.abort();
        try f.write(pair[1]);
        try f.commit();
    }

    var joined: std.Io.Writer.Allocating = .init(testing.allocator);
    defer joined.deinit();
    var crc: u32 = 0;
    var total_len: u32 = 0;
    for ([_][]const u8{ md5_a, md5_b }) |md5| {
        var file = try store.open(md5, 1);
        defer file.close(io);
        const h = try readHeader(io, file);
        var raw: [4096]u8 = undefined;
        const n = try file.readPositionalAll(io, &raw, 0);
        try joined.writer.writeAll(raw[header_len..n]);
        crc = h.crc;
        total_len += h.len;
    }
    try testing.expectEqual(@as(u32, a_text.len + b_text.len), total_len);
    try testing.expectEqual(std.hash.Crc32.hash(b_text), crc); // per-fragment, not combined

    // The empty final stored block that ends the stream.
    try joined.writer.writeAll(&gzip_stitch.terminator);

    var input: std.Io.Reader = .fixed(joined.written());
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .raw, &window);
    var got: std.Io.Writer.Allocating = .init(testing.allocator);
    defer got.deinit();
    _ = try d.reader.streamRemaining(&got.writer);
    try testing.expectEqualStrings(a_text ++ b_text, got.written());
}

test "readHeader refuses anything that is not a fragment" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    try store.put(md5_a, 1, "not a fragment at all");
    var f1 = try store.open(md5_a, 1);
    defer f1.close(io);
    try testing.expectError(error.BadFragment, readHeader(io, f1));

    try store.put(md5_b, 1, "IDF"); // shorter than a header
    var f2 = try store.open(md5_b, 1);
    defer f2.close(io);
    try testing.expectError(error.BadFragment, readHeader(io, f2));
}
