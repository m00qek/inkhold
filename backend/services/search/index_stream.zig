//! The WALK behind `/api/controlplane/search-index/stream` — manifest rows plus
//! a `want=` bitmap in, one stitched gzip stream out (`golden-search.md` §3.2,
//! §3.3).
//!
//! Everything hard here has already been decided somewhere else, and this file
//! is where the three pieces meet:
//!
//!   * `http/gzip_stitch.zig` owns the container — the 10-byte header, the `03
//!     00` terminator and the `crc32_combine` trailer that makes a single-member
//!     gzip out of N independently compressed fragments. Concatenated `.gz`
//!     MEMBERS would be the obvious thing and Chromium decodes the first of them
//!     and reports success (§3.1); nothing here may reintroduce that.
//!   * `store/derived.zig` owns the stored file — a 12-byte header carrying the
//!     fragment's plaintext CRC32 and length, then the raw-deflate fragment.
//!   * `index_export.zig` owns the ordering. A bitmap position means nothing
//!     except against the exact row order `writeManifest` emitted, which is why
//!     this walk lives beside that writer and beside `want_bitmap.zig` rather
//!     than in `http/`.
//!
//! ## Two of §3.3's four mechanics are enforced HERE
//!
//! **A missing file is SKIPPED, never an error.** Between the manifest query and
//! this walk a blob can be GC'd (`removeBlobFiles` unlinks both derived files)
//! or a derive can still be outstanding — the manifest reports `index_version`
//! from the index row, and §2.4 makes the FILE the fact, so the two can disagree
//! for a whole tick. An error would have to become a status code that is already
//! on the wire, or a truncated body, and either way it poisons the stream for
//! every document that had nothing wrong with it. A skip costs nothing: the
//! client keys its index on what ARRIVED, so the document is simply still absent
//! at the next manifest and is asked for again.
//!
//! **Each fragment's CRC32 and length come from the FILE's own header**, so the
//! walk reads nothing but the files it is already opening and the trailer
//! accumulates as it goes. No DB lookup per document, and therefore no reason
//! for the write lock to be anywhere near this path.
//!
//! ## The one failure that is NOT a skip
//!
//! A fragment is committed the moment its first byte reaches the socket. If the
//! read fails after that — a disk error, a truncated file that somehow got
//! published — the deflate stream already carries half a fragment and no trailer
//! can make it whole. So the boundary is exact: `open` and `readHeader` failures
//! are skips, and anything after them is `error.StreamTruncated`, which drops
//! the connection short. A dropped connection is a decode failure in every
//! client; a finished stream with a plausible trailer over half a document would
//! not be, and that is the §3.1 failure mode wearing a different hat.
//!
//! ## One small buffer, streamed
//!
//! `buf` is the caller's, reused for every file: `File` → `Io.Writer` → socket,
//! never read-all-then-write. The library is ~1-2 MB and three concurrent first
//! visits must not be 6 MB of RSS on a 50 MB budget. Nothing here allocates.
//!
//! The copy is a positional-read loop rather than `streamRemaining`, and that is
//! a Zig std bug rather than a preference — see the comment at the loop. It is
//! worth knowing before "simplifying" this back.

const std = @import("std");
const derived = @import("../../store/derived.zig");
const gzip_stitch = @import("../../http/gzip_stitch.zig");
const index_export = @import("index_export.zig");
const want_bitmap = @import("want_bitmap.zig");

const Io = std.Io;
const Writer = std.Io.Writer;

/// What the walk did. Nothing in the RESPONSE says any of it, and that is the
/// point: the client's contract is "what arrived", so a count travelling beside
/// the bytes would be a second opinion about the same set — and the one place it
/// could disagree is exactly where a document was skipped.
pub const Stats = struct {
    /// Fragments written.
    sent: usize = 0,
    /// Documents asked for whose file was not there — expected, not an error.
    skipped: usize = 0,
    /// Total UNCOMPRESSED bytes, i.e. the gzip ISIZE and what the client decodes.
    plain_bytes: u64 = 0,
};

pub const Error = error{
    /// A fragment failed mid-write. The head is long gone; the only honest
    /// answer left is to drop the connection.
    StreamTruncated,
} || Writer.Error;

/// Write the whole body: gzip header, the wanted fragments in MANIFEST ORDER,
/// terminator, trailer.
///
/// Manifest order is tier order is priority order (§3.3), so the tiering needs
/// no mechanism of its own — it is the order the bytes come out, and the client
/// parses them as they land (8 ms of a 193 ms stream, §3.2).
///
/// `rows` must be the exact rows the caller's ETag was computed over; the route
/// is what guarantees that, and it is the whole reason for the 412 gate.
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

        // No index row means no `(md5, index_version)` to name a file with. The
        // manifest already told the client this (a null `index_version` is the
        // "do not cache this" signal), so a client that asked anyway gets the
        // same skip as any other absence rather than a special case.
        const version = row.index_version orelse {
            stats.skipped += 1;
            continue;
        };

        var file = terms.open(row.md5, version) catch {
            stats.skipped += 1;
            continue;
        };
        defer file.close(io);

        // The two numbers the trailer needs, out of the bytes we are opening
        // anyway. `readHeader` is also the format check: a truncated or
        // foreign-format file is refused here, while refusing still costs
        // nothing but a skip.
        const h = derived.readHeader(io, file) catch {
            stats.skipped += 1;
            continue;
        };

        // THE COMMIT POINT is the first byte of the loop below. Past it a partial
        // write cannot be taken back, so every failure is fatal to the response
        // rather than to the document.
        //
        // POSITIONAL READS INTO ONE BUFFER, and NOT `File.Reader.streamRemaining`
        // — which is the obvious spelling, is what `http/static.zig` uses, and
        // **panics against a CHUNKED response**. It lowers to `sendFile`, and
        // `std.http.BodyWriter.chunkedSendFile` sizes its chunk header from
        // `countSendFileLowerBound` — a LOWER bound. When the transfer writes
        // fewer bytes than that header promised, `state.chunk_len` is left
        // mid-chunk, and the next flush trips `writeSplatHeaderLimit` with a
        // limit smaller than what is buffered: `unreachable` in `fixedDrain`, or
        // `end()`'s "an earlier write call indicated more data would follow".
        // REPRODUCED against std alone, outside this repo, on Zig 0.16.0. Every
        // other streaming route here declares a `content_length`, whose sendFile
        // path keeps no such state, which is why this is the first place it bites.
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

    // Correct for an EMPTY walk too, and that is worth knowing rather than
    // assuming: `Trailer` starts empty with crc 0 and len 0, which are exactly
    // gzip's values for an empty payload, and `terminator` is a valid final
    // block on its own. A client that asked for nothing, or whose every
    // document was skipped, gets a well-formed gzip of zero bytes instead of a
    // stream its decoder rejects.
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
