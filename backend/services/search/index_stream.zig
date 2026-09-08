//! The walk behind `/api/controlplane/search-index/stream`: manifest rows plus a
//! `want=` bitmap in, one stitched gzip out.
//! `http/gzip_stitch.zig` owns the container, `store/derived.zig` the stored file
//! (a 12-byte header with the plaintext CRC32 and length, then a raw-deflate
//! fragment), `index_export.zig` the row order a bitmap position is read against.
//!
//! Must not break:
//!   * A missing file is SKIPPED, never an error. The manifest and the disk can
//!     disagree for a tick (a blob GC'd, a derive outstanding — §2.4 makes the
//!     FILE the fact), and an error here is a status code already on the wire or
//!     a truncated body: it poisons the stream for every document that was fine.
//!     A skip costs nothing because the client keys its index on what ARRIVED.
//!   * The trailer comes from each file's own header: no DB lookup per document,
//!     so the write lock is nowhere near this path.
//!   * `buf` is the caller's and nothing here allocates: three concurrent first
//!     visits of a ~1-2 MB library on a 50 MB budget.
//!   * The copy is a positional-read loop, not `streamRemaining` — a std bug,
//!     see the loop. Do not "simplify" it back.

const std = @import("std");
const derived = @import("../../store/derived.zig");
const gzip_stitch = @import("../../http/gzip_stitch.zig");
const index_export = @import("index_export.zig");
const want_bitmap = @import("want_bitmap.zig");

const Io = std.Io;
const Writer = std.Io.Writer;

/// What the walk did. Deliberately NOT in the response: the client's contract is
/// "what arrived", and a count beside the bytes could only disagree with it
/// exactly where a document was skipped.
pub const Stats = struct {
    sent: usize = 0,
    /// Asked for, file not there — expected, not an error.
    skipped: usize = 0,
    /// UNCOMPRESSED bytes, i.e. the gzip ISIZE.
    plain_bytes: u64 = 0,
};

pub const Error = error{
    /// A fragment failed mid-write; the head is gone, so drop the connection.
    StreamTruncated,
} || Writer.Error;

/// Write the whole body: gzip header, the wanted fragments in MANIFEST ORDER
/// (which is tier order, which is priority order — §3.3), terminator, trailer.
///
/// `rows` must be the exact rows the caller's ETag was computed over; the
/// route's 412 gate is what guarantees that.
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

        // No index row, no file name. The manifest already said so (a null
        // `index_version` is "do not cache this"); asking anyway is a plain skip.
        const version = row.index_version orelse {
            stats.skipped += 1;
            continue;
        };

        var file = terms.open(row.md5, version) catch {
            stats.skipped += 1;
            continue;
        };
        defer file.close(io);

        // Also the format check: a truncated or foreign file is refused while
        // refusing still costs only a skip.
        const h = derived.readHeader(io, file) catch {
            stats.skipped += 1;
            continue;
        };

        // COMMIT POINT: past the first byte below a partial write cannot be
        // taken back, so every failure is fatal to the response, not the document.
        //
        // Positional reads, NOT `File.Reader.streamRemaining` (the obvious
        // spelling, and what `http/static.zig` uses): it PANICS against a chunked
        // response. It lowers to `sendFile`, and `std.http.BodyWriter
        // .chunkedSendFile` sizes its chunk header from `countSendFileLowerBound`
        // — a LOWER bound. A transfer shorter than that header promised leaves
        // `state.chunk_len` mid-chunk, and the next flush trips
        // `writeSplatHeaderLimit`: `unreachable` in `fixedDrain`, or `end()`'s
        // "an earlier write call indicated more data would follow". Reproduced
        // against std alone on Zig 0.16.0. This response is chunked because
        // `content_length` and the skip rule cannot both hold; every other
        // streaming route declares a length, whose sendFile path keeps no such
        // state, which is why this is the first place it bites.
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

    // Correct for an EMPTY walk too: crc 0 / len 0 are gzip's values for an
    // empty payload and `terminator` is a valid final block on its own, so a
    // client whose every document was skipped gets a well-formed empty gzip.
    try trailer.finish(w);
    return stats;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

/// Decode a stitched body as ONE gzip member and check its trailer BY HAND.
///
/// The hand check is not belt and braces. `std.compress.flate.Decompress` reads
/// the gzip footer into `container_metadata` and never verifies it
/// (`gzip_stitch.zig`'s header records the finding), so a Zig-only round trip
/// passes on a stream `gzip -t` and every browser reject. Comparing against our
/// own hash of the output is the comparison they make.
fn inflateChecked(a: std.mem.Allocator, body: []const u8) ![]u8 {
    // Exactly ONE gzip member, checked on the whole 10-byte header rather than
    // its 3-byte magic: over a hundred kilobytes of deflate output a 3-byte
    // needle collides by chance often enough to make this flaky, and 10 bytes
    // does not. This is the §3.1 assertion in its cheapest form — the broken
    // implementation is a concatenation of members, and it is indistinguishable
    // from this one by every "did the request work" check.
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, body, gzip_stitch.header));

    // And Zig behaves EXACTLY like the clients that matter here, which is what
    // makes the check below load-bearing rather than decorative: `Decompress`
    // goes to `.end` after one member's footer, so a concatenation decodes to
    // its first document and stops — 37 bytes of 7,980, reported as success.
    // Node's zlib is the outlier that decodes all of them (§3.1).

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
        // ORDER, not merely membership: manifest order is priority order, and a
        // walk that sorted or reversed would still decode to a valid stream.
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

    // Four skips of four different shapes, one survivor, and a stream a browser
    // accepts. Every one of these is a real state the manifest can describe and
    // the disk can disagree with (§2.4).
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

    // 200 documents of varying size, which is the shape §3.2 measured: enough
    // that `crc32Combine` walks several different lengths and that a read buffer
    // smaller than a document is exercised many times over.
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
    // 512 bytes for documents up to ~3 KB: the buffer is deliberately smaller
    // than a document, because "one small buffer" is the claim being tested and
    // a buffer that happened to fit would test nothing.
    var buf: [512]u8 = undefined;
    const stats = try write(io, store, rows.items, want, &out.writer, &buf);
    try testing.expectEqual(@as(usize, n), stats.sent);
    try testing.expectEqual(expected.written().len, stats.plain_bytes);
    try testing.expectEqualStrings(expected.written(), try inflateChecked(a, out.written()));
}
