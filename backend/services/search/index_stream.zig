//! The search-index stream: manifest rows plus a `want=` bitmap in, one
//! stitched gzip out. A missing or malformed file is skipped, never an error,
//! because the headers are already on the wire.

const std = @import("std");
const derived = @import("../../store/derived.zig");
const gzip_stitch = @import("../../http/gzip_stitch.zig");
const index_export = @import("index_export.zig");
const want_bitmap = @import("want_bitmap.zig");

const Io = std.Io;
const Writer = std.Io.Writer;

/// What the walk did. Not sent: the client's contract is what arrived.
pub const Stats = struct {
    sent: usize = 0,
    skipped: usize = 0,
    /// Uncompressed bytes (the gzip ISIZE).
    plain_bytes: u64 = 0,
};

pub const Error = error{
    /// A fragment failed mid-write; the head is gone, so drop the connection.
    StreamTruncated,
} || Writer.Error;

/// Writes the whole body: header, wanted fragments in manifest (priority)
/// order, terminator, trailer. `rows` must be the rows the ETag covered.
pub fn write(
    io: Io,
    terms: derived.DerivedStore,
    rows: []const index_export.Row,
    want: want_bitmap.WantBitmap,
    w: *Writer,
    buf: []u8,
) Error!Stats {
    var stats: Stats = .{};
    var trailer: gzip_stitch.Trailer = .{};

    try w.writeAll(gzip_stitch.header);

    for (rows, 0..) |row, position| {
        if (!want.isSet(position)) continue;

        // A null `index_version` was already "do not cache" in the manifest.
        const version = row.index_version orelse {
            stats.skipped += 1;
            continue;
        };

        var file = terms.open(row.md5, version) catch {
            stats.skipped += 1;
            continue;
        };
        defer file.close(io);

        const h = derived.readHeader(io, file) catch {
            stats.skipped += 1;
            continue;
        };

        // Commit point: past here every failure kills the response.
        // Positional reads, not `File.Reader.streamRemaining`: on a chunked
        // response its `sendFile` sizes the chunk from a lower bound and std
        // panics on the next flush (Zig 0.16.0).
        var off: u64 = derived.header_len;
        while (true) {
            const n = file.readPositionalAll(io, buf, off) catch return error.StreamTruncated;
            if (n == 0) break;
            try w.writeAll(buf[0..n]);
            off += n;
            if (n < buf.len) break; // short read = end of file
        }

        trailer.append(h.crc, h.len);
        stats.sent += 1;
        stats.plain_bytes += h.len;
    }

    // An empty walk still yields a valid empty gzip (crc 0, len 0).
    try trailer.finish(w);
    return stats;
}

// ---- tests ----

const testing = std.testing;

fn putFragment(store: derived.DerivedStore, md5: []const u8, version: i64, payload: []const u8) !void {
    var f = try testing.allocator.create(derived.Fragment);
    defer testing.allocator.destroy(f);
    try derived.beginFragment(store, f, md5, version);
    errdefer f.abort();
    try f.write(payload);
    try f.commit();
}

fn testRow(md5: []const u8, version: ?i64) index_export.Row {
    return .{
        .file_id = 1,
        .md5 = md5,
        .updated_at = 0,
        .index_version = version,
        .tier = .note,
        .derivation = .derived,
    };
}

/// Decodes as one gzip member and checks the trailer by hand: std's
/// `Decompress` never verifies the footer.
fn inflateChecked(a: std.mem.Allocator, body: []const u8) ![]u8 {
    // One member: match the whole 10-byte header, since a 3-byte magic
    // collides by chance in deflate output. Zig, like browsers, stops after
    // the first member, so a concatenation would look like success.
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, body, gzip_stitch.header));

    var input: std.Io.Reader = .fixed(body);
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .gzip, &window);
    var got: Writer.Allocating = .init(a);
    errdefer got.deinit();
    _ = try d.reader.streamRemaining(&got.writer);

    try testing.expectEqual(std.hash.Crc32.hash(got.written()), d.container_metadata.gzip.crc);
    try testing.expectEqual(@as(u32, @intCast(got.written().len)), d.container_metadata.gzip.count);
    return got.toOwnedSlice();
}

fn wantAll(buf: []u8, n: usize) !want_bitmap.WantBitmap {
    var bits: [64]u8 = @splat(0);
    for (0..n) |i| bits[i >> 3] |= @as(u8, 1) << @intCast(i & 7);
    const encoded = std.base64.url_safe_no_pad.Encoder.encode(buf, bits[0 .. (n + 7) / 8]);
    return want_bitmap.parse(encoded, n);
}

test "the walk stitches the wanted fragments, in manifest order, as one gzip" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try derived.DerivedStore.init(io, tmp.dir);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var md5s: [4][32]u8 = undefined;
    var docs: [4][]const u8 = undefined;
    for (&md5s, &docs, 0..) |*m, *doc, i| {
        m.* = std.fmt.bytesToHex(std.mem.toBytes(@as(u128, i + 1)), .lower);
        doc.* = try std.fmt.allocPrint(
            a,
            "{{\"md5\":\"{s}\",\"v\":7,\"n\":1}}\n{{\"p\":0,\"t\":\"documento {d}\"}}\n",
            .{ m.*, i },
        );
        try putFragment(store, m, 7, doc.*);
    }

    const rows = [_]index_export.Row{
        testRow(&md5s[0], 7), testRow(&md5s[1], 7), testRow(&md5s[2], 7), testRow(&md5s[3], 7),
    };

    // --- every document ---
    {
        var wbuf: [8]u8 = undefined;
        const want = try wantAll(&wbuf, rows.len);
        var out: Writer.Allocating = .init(a);
        var buf: [256]u8 = undefined;
        const stats = try write(io, store, &rows, want, &out.writer, &buf);
        try testing.expectEqual(@as(usize, 4), stats.sent);
        try testing.expectEqual(@as(usize, 0), stats.skipped);

        const plain = try inflateChecked(a, out.written());
        const joined = try std.mem.concat(a, u8, &docs);
        try testing.expectEqualStrings(joined, plain);
        try testing.expectEqual(joined.len, stats.plain_bytes);
    }

    // --- a SUBSET: positions 1 and 3, which is the coalesced-refetch case ---
    {
        const want = try want_bitmap.parse("Cg", rows.len); // 0x0a = bits 1 and 3
        try testing.expectEqual(@as(usize, 2), want.countSet());
        var out: Writer.Allocating = .init(a);
        var buf: [256]u8 = undefined;
        const stats = try write(io, store, &rows, want, &out.writer, &buf);
        try testing.expectEqual(@as(usize, 2), stats.sent);

        const plain = try inflateChecked(a, out.written());
        const joined = try std.mem.concat(a, u8, &.{ docs[1], docs[3] });
        try testing.expectEqualStrings(joined, plain);
    }

    // --- nothing at all is a valid empty gzip, not a malformed one ---
    {
        const want = try want_bitmap.parse("", rows.len);
        var out: Writer.Allocating = .init(a);
        var buf: [256]u8 = undefined;
        const stats = try write(io, store, &rows, want, &out.writer, &buf);
        try testing.expectEqual(@as(usize, 0), stats.sent);
        try testing.expectEqualStrings("", try inflateChecked(a, out.written()));
    }
}

test "a missing, unversioned or malformed file is SKIPPED and the stream stays valid" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try derived.DerivedStore.init(io, tmp.dir);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const good = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const gc_d = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // blob collected since the manifest
    const nover = "cccccccccccccccccccccccccccccccc"; // no index row yet
    const junk = "dddddddddddddddddddddddddddddddd"; // a file that is not a fragment
    const wrongv = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // derived at another index_version

    const doc = "{\"md5\":\"a\",\"v\":7,\"n\":1}\n{\"p\":0,\"t\":\"sobrevivente\"}\n";
    try putFragment(store, good, 7, doc);
    try store.put(junk, 7, "this is not a deflate fragment");
    try putFragment(store, wrongv, 6, "{\"stale\":true}\n");

    const rows = [_]index_export.Row{
        testRow(gc_d, 7), testRow(good, 7), testRow(nover, null), testRow(junk, 7), testRow(wrongv, 7),
    };

    var wbuf: [8]u8 = undefined;
    const want = try wantAll(&wbuf, rows.len);
    var out: Writer.Allocating = .init(a);
    var buf: [256]u8 = undefined;
    const stats = try write(io, store, &rows, want, &out.writer, &buf);

    try testing.expectEqual(@as(usize, 1), stats.sent);
    try testing.expectEqual(@as(usize, 4), stats.skipped);
    try testing.expectEqualStrings(doc, try inflateChecked(a, out.written()));
}

test "many fragments: the trailer comes only from the files' own headers" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try derived.DerivedStore.init(io, tmp.dir);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const n = 200;
    var rows: std.ArrayList(index_export.Row) = .empty;
    var expected: Writer.Allocating = .init(a);
    var prng = std.Random.DefaultPrng.init(0xC0FFEE);
    const rand = prng.random();
    for (0..n) |i| {
        const md5 = try a.dupe(u8, &std.fmt.bytesToHex(std.mem.toBytes(@as(u128, i + 1)), .lower));
        const words = try a.alloc(u8, 1 + rand.uintLessThan(usize, 3000));
        for (words) |*c| c.* = if (rand.boolean()) ' ' else rand.intRangeAtMost(u8, 'a', 'z');
        const doc = try std.fmt.allocPrint(a, "{{\"md5\":\"{s}\",\"v\":7,\"n\":1}}\n{{\"p\":0,\"t\":\"{s}\"}}\n", .{ md5, words });
        try putFragment(store, md5, 7, doc);
        try rows.append(a, testRow(md5, 7));
        try expected.writer.writeAll(doc);
    }

    var wbuf: [(n + 7) / 8 * 4 + 4]u8 = undefined;
    const want = try wantAll(&wbuf, n);
    var out: Writer.Allocating = .init(a);
    // Smaller than a document on purpose.
    var buf: [512]u8 = undefined;
    const stats = try write(io, store, rows.items, want, &out.writer, &buf);
    try testing.expectEqual(@as(usize, n), stats.sent);
    try testing.expectEqual(expected.written().len, stats.plain_bytes);
    try testing.expectEqualStrings(expected.written(), try inflateChecked(a, out.written()));
}
