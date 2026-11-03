//! Tests for indexing `.note` files and serving pages from the index.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const blob_source = @import("../../store/blob_source.zig");
const thumbnail = @import("../thumbnail.zig");
const sn = @import("supernote");
const Allocator = std.mem.Allocator;
const testing = std.testing;
const schema = @import("../../db/schema.zig");
const filesvc = @import("../files.zig");
const nb = @import("note_builder");
const noteindex = @import("../note_index.zig");
const index_version = noteindex.index_version;
const LayerRef = noteindex.LayerRef;
const max_layers = noteindex.max_layers;
const IndexedLayer = noteindex.IndexedLayer;
const layer_rec_head_size = noteindex.layer_rec_head_size;
const max_layer_name = noteindex.max_layer_name;
const max_layer_rec_size = noteindex.max_layer_rec_size;
const Parsed = noteindex.Parsed;
const parseBlob = noteindex.parseBlob;
const parseBlobSource = noteindex.parseBlobSource;
const pageContentHash = noteindex.pageContentHash;
const packLayers = noteindex.packLayers;
const LayerRecord = noteindex.LayerRecord;
const unpackLayerRecords = noteindex.unpackLayerRecords;
const unpackLayers = noteindex.unpackLayers;
const store = noteindex.store;
const isCurrent = noteindex.isCurrent;
const needsRepair = noteindex.needsRepair;
const coverLocation = noteindex.coverLocation;
const ensureIndexed = noteindex.ensureIndexed;
const SliceSource = noteindex.SliceSource;
const pagePlan = noteindex.pagePlan;
const streamPage = noteindex.streamPage;
const serializeFromIndex = noteindex.serializeFromIndex;
const fixture = @import("fixture.zig");
const layers_edited = fixture.layers_edited;
const Fixture = fixture.Fixture;
const Blobs = fixture.Blobs;
const PeakAllocator = fixture.PeakAllocator;
const indexInto = fixture.indexInto;
const coveredNote = fixture.coveredNote;

/// Real device captures; local fixtures, not redistributed.
const sample = @embedFile("sample.note");

const sample2 = @embedFile("sample-2.note");

fn expectSameOptStr(want: ?[]const u8, got: ?[]const u8) !void {
    try testing.expectEqual(want == null, got == null);
    if (want) |w| try testing.expectEqualStrings(w, got.?);
}

fn expectSameParsed(want: Parsed, got: Parsed) !void {
    try testing.expectEqual(want.indexable, got.indexable);
    try testing.expectEqual(want.note.page_count, got.note.page_count);
    try expectSameOptStr(want.note.signature, got.note.signature);
    try testing.expectEqual(want.note.signature_version, got.note.signature_version);
    try expectSameOptStr(want.note.equipment, got.note.equipment);
    try expectSameOptStr(want.note.recogn_type, got.note.recogn_type);
    try expectSameOptStr(want.note.recogn_language, got.note.recogn_language);
    try testing.expectEqual(want.note.width, got.note.width);
    try testing.expectEqual(want.note.height, got.note.height);
    try testing.expectEqual(want.note.rle_variant, got.note.rle_variant);
    try testing.expectEqual(want.note.recognized_page_count, got.note.recognized_page_count);
    try testing.expectEqual(want.note.cover_w, got.note.cover_w);
    try testing.expectEqual(want.note.cover_h, got.note.cover_h);
    try testing.expectEqual(want.note.cover_offset, got.note.cover_offset);
    try testing.expectEqual(want.note.cover_length, got.note.cover_length);
    try expectSameOptStr(want.note.cover_mime, got.note.cover_mime);
    try testing.expectEqual(want.pages.len, got.pages.len);

    for (want.pages, got.pages) |w, g| {
        try testing.expectEqual(w.page_index, g.page_index);
        try testing.expectEqualStrings(&w.content_hash, &g.content_hash);
        try testing.expectEqual(w.width, g.width);
        try testing.expectEqual(w.height, g.height);
        try testing.expectEqual(w.layers.len, g.layers.len);
        for (w.layers, g.layers) |wl, gl| {
            try testing.expectEqual(wl.ref, gl.ref);
            try testing.expectEqualStrings(wl.name, gl.name);
            try testing.expectEqual(wl.is_current, gl.is_current);
        }
        try testing.expectEqual(w.recogn_status, g.recogn_status);
        try testing.expectEqual(w.links_offset, g.links_offset);
        try testing.expectEqual(w.links_length, g.links_length);
        try testing.expectEqual(w.links_hash, g.links_hash);
        try testing.expectEqual(w.recogn_offset, g.recogn_offset);
        try testing.expectEqual(w.recogn_length, g.recogn_length);
        try testing.expectEqual(w.text_hash == null, g.text_hash == null);
        if (w.text_hash) |*h| try testing.expectEqualStrings(h, &g.text_hash.?);
        try expectSameOptStr(w.text, g.text);
    }
}

/// `page_payload.serialize`, `serializeFromIndex` and `streamPage` (off a real
/// blob) must agree byte for byte on every page, and equal the plan's
/// `content_length`.
fn assertGolden(bytes: []const u8, label: []const u8) !void {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    var blobs = try Blobs.init();
    defer blobs.deinit();
    const md5 = try blobs.put(bytes);
    try testing.expectEqualStrings(&blobstore.md5HexOf(bytes), &md5);
    try indexInto(db, &md5, bytes);

    var note = try sn.parse(gpa, bytes);
    defer note.deinit();
    try testing.expect(note.pages.len > 0);

    for (0..note.pages.len) |i| {
        const from_parse = try sn.page_payload.serialize(gpa, note, i);
        defer gpa.free(from_parse);
        const from_index = try serializeFromIndex(gpa, db, &md5, i, SliceSource{ .bytes = bytes });
        defer gpa.free(from_index);

        const plan = (try pagePlan(db, &md5, i)).?;
        var streamed: std.Io.Writer.Allocating = .init(gpa);
        defer streamed.deinit();
        try streamPage(blobs.store, &md5, plan, &streamed.writer);

        testing.expectEqualSlices(u8, from_parse, from_index) catch |e| {
            std.debug.print("golden mismatch (buffered): {s} page {d}\n", .{ label, i });
            return e;
        };
        testing.expectEqualSlices(u8, from_parse, streamed.written()) catch |e| {
            std.debug.print("golden mismatch (streamed): {s} page {d}\n", .{ label, i });
            return e;
        };
        try testing.expectEqual(from_parse.len, @as(usize, @intCast(plan.content_length)));
    }
}

test "GOLDEN: index-driven SNPG is byte-identical to parse-driven, every page of both samples" {
    try assertGolden(sample, "sample.note"); // 1 page
    try assertGolden(sample2, "sample-2.note"); // 2 pages, page 0 recognized
}

test "GOLDEN: synthetic notes — multi-layer, blank-background shortcut, non-highres, N5 dims" {
    const gpa = testing.allocator;

    // A 0x140e-byte BGLAYER on a white-style page takes the blank-background
    // shortcut.
    const blank_bg = try gpa.alloc(u8, 0x140e);
    defer gpa.free(blank_bg);
    @memset(blank_bg, 0x62);

    const main_rle = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const l1 = [_]u8{ 0x61, 0x05 };
    const l2 = [_]u8{ 0x62, 0x01 };

    const page_blank: nb.PageSpec = .{ .style = "style_white", .layers = &.{
        .{ .slot = .main, .bitmap = &main_rle },
        .{ .slot = .background, .bitmap = blank_bg },
    } };
    const page_full: nb.PageSpec = .{
        .style = "style_5mm_dots",
        .layers = &.{
            .{ .slot = .main, .bitmap = &main_rle },
            .{ .slot = .layer1, .bitmap = &l1 },
            .{ .slot = .layer2, .bitmap = &l2 },
            .{ .slot = .background, .bitmap = blank_bg }, // same size, but not white style
        },
    };
    const page_bare: nb.PageSpec = .{ .style = "style_white", .layers = &.{} }; // no layers at all

    const cases = [_]struct { name: []const u8, spec: nb.Spec }{
        .{ .name = "highres/N6", .spec = .{
            .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
            .pages = &.{ page_blank, page_full, page_bare },
        } },
        .{ .name = "highres/N5 (1920x2560)", .spec = .{
            .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N5" }},
            .pages = &.{ page_full, page_blank },
        } },
        .{ .name = "pre-highres variant 0", .spec = .{
            .version = 20190529,
            .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
            .pages = &.{ page_blank, page_full },
        } },
    };

    for (cases) |c| {
        const bytes = try nb.serialize(gpa, c.spec);
        defer gpa.free(bytes);
        try assertGolden(bytes, c.name);
    }
}

test "note-level and page-level rows carry the facts the read paths need" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    const md5 = blobstore.md5HexOf(sample2);
    try indexInto(db, &md5, sample2);

    var s = try db.prepare(
        "SELECT page_count, indexable, equipment, width, height, rle_variant, " ++
            "recogn_type, recogn_language, recognized_page_count, signature_version " ++
            "FROM note_index WHERE blob_md5 = ?1;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 2), s.columnInt(0));
    try testing.expectEqual(@as(i64, 1), s.columnInt(1));
    try testing.expectEqualStrings("N6", s.columnText(2));
    try testing.expectEqual(@as(i64, 1404), s.columnInt(3));
    try testing.expectEqual(@as(i64, 1872), s.columnInt(4));
    try testing.expectEqual(@as(i64, 1), s.columnInt(5)); // highres → X2
    try testing.expectEqualStrings("1", s.columnText(6)); // FILE_RECOGN_TYPE
    try testing.expectEqualStrings("pt_BR", s.columnText(7));
    try testing.expectEqual(@as(i64, 1), s.columnInt(8)); // one finished page
    try testing.expectEqual(@as(i64, 20260016), s.columnInt(9));

    var ps = try db.prepare(
        "SELECT content_hash, width, height, recogn_status, text_hash, recogn_offset, " ++
            "recogn_length, text FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer ps.finalize();
    ps.bindText(1, &md5);
    try testing.expect(try ps.step());
    try testing.expectEqual(@as(usize, 32), ps.columnText(0).len);
    try testing.expectEqual(@as(i64, 1404), ps.columnInt(1)); // ORIENTATION 1000 → no swap
    try testing.expectEqual(@as(i64, 1872), ps.columnInt(2));
    try testing.expectEqual(@as(i64, 1), ps.columnInt(3));
    try testing.expectEqual(@as(usize, 32), ps.columnText(4).len);
    try testing.expect(ps.columnInt(5) > 0);
    try testing.expect(ps.columnInt(6) > 0);
    try testing.expectEqualStrings("Test\nMiddle\nTest", ps.columnText(7)); // v7: device layout honored — regions y-sorted, newline-joined

    try testing.expect(try ps.step());
    try testing.expectEqual(@as(i64, 2), ps.columnInt(3));
    try testing.expect(ps.columnIsNull(4));
    try testing.expect(ps.columnIsNull(5));
    try testing.expect(ps.columnIsNull(7));

    var note = try sn.parse(gpa, sample2);
    defer note.deinit();
    ps.reset();
    ps.bindText(1, &md5);
    try testing.expect(try ps.step());
    try testing.expectEqualStrings(&try pageContentHash(sn.Source.fromSlice(sample2), note.pages[0]), ps.columnText(0));
}

test "a truncated or corrupt note is refused at index time, never read past EOF" {
    const gpa = testing.allocator;

    // 1. Truncated: the footer address is in the last 4 bytes.
    {
        var p = try parseBlob(gpa, sample2[0 .. sample2.len / 2]);
        defer p.deinit();
        try testing.expect(!p.indexable);
        try testing.expectEqual(@as(usize, 0), p.pages.len);
    }

    // 2. A layer block claims a length past EOF; the container still parses,
    //    so only offset validation catches it.
    {
        const rle = [_]u8{ 0xAB, 0xCD, 0xEF, 0x42 };
        const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
            .{ .slot = .main, .bitmap = &rle },
        } }} });
        defer gpa.free(bytes);

        {
            var ok = try parseBlob(gpa, bytes);
            defer ok.deinit();
            try testing.expect(ok.indexable);
        }

        // The u32 length prefix sits 4 bytes before the RLE payload.
        const at = std.mem.indexOf(u8, bytes, &rle).?;
        std.mem.writeInt(u32, bytes[at - 4 ..][0..4], 0xFFFF_FFF0, .little);

        {
            var still = try sn.parse(gpa, bytes); // the container itself is intact
            still.deinit();
        }
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(!p.indexable); // but is refused as unindexable
    }

    var src = SliceSource{ .bytes = "short" };
    try testing.expectError(error.BadRange, src.read(0, 99));
}

test "a non-.note blob is marked unindexable once and never reparsed" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("photo.jpg", "\xff\xd8\xff\xe0 not a supernote file at all");

    var s = try f.db.prepare("SELECT indexable, page_count, index_version, indexed_at FROM note_index WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 0), s.columnInt(0));
    try testing.expectEqual(@as(i64, 0), s.columnInt(1));
    try testing.expectEqual(index_version, s.columnInt(2));
    const first_indexed_at = s.columnInt(3);

    try testing.expect(try isCurrent(f.db, &md5));
    try ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, first_indexed_at + 1000);
    s.reset();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(first_indexed_at, s.columnInt(3)); // untouched → not reparsed
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));
}

test "lazy backfill repairs a missing or stale row and is idempotent under repeated calls" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const md5 = try f.put("n.note", sample2);
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    try f.db.exec("DELETE FROM note_index;");
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM note_page_index;")); // cascaded
    try testing.expect(!try isCurrent(f.db, &md5));

    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 100);
    try testing.expect(try isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    // Page rowids stay stable across a re-index.
    const rowid_before = try f.countRows("SELECT id FROM note_page_index ORDER BY page_index LIMIT 1;");

    for (0..3) |_| try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 200);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(rowid_before, try f.countRows("SELECT id FROM note_page_index ORDER BY page_index LIMIT 1;"));

    try f.db.exec("UPDATE note_index SET index_version = 0, page_count = 0;");
    try testing.expect(!try isCurrent(f.db, &md5));
    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 300);
    try testing.expect(try isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT page_count FROM note_index;"));
    try testing.expectEqual(rowid_before, try f.countRows("SELECT id FROM note_page_index ORDER BY page_index LIMIT 1;"));

    var note = try sn.parse(gpa, sample2);
    defer note.deinit();
    for (0..note.pages.len) |i| {
        const a = try sn.page_payload.serialize(gpa, note, i);
        defer gpa.free(a);
        const b = try serializeFromIndex(gpa, f.db, &md5, i, SliceSource{ .bytes = sample2 });
        defer gpa.free(b);
        try testing.expectEqualSlices(u8, a, b);
    }
}

test "index rows are reaped with the blob, and survive while another file still references it" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("a.note", sample2);
    _ = try f.put("b.note", sample2);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    try f.files.trash(1, 1);
    try f.files.trash(1, 2);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    try f.files.purge(1, 1); // the blob is still referenced by b.note
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    try f.files.purge(1, 2); // refcount hits 0: blob GC'd, index goes with it
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));
}

test "the blob source and the slice source parse a note to identical results" {
    const gpa = testing.allocator;
    var b = try Blobs.init();
    defer b.deinit();

    for ([_][]const u8{ sample, sample2 }) |bytes| {
        const md5 = try b.put(bytes);
        var bs: blob_source.BlobSource = undefined;
        const ranged = try b.source(&md5, &bs);

        var from_slice = try parseBlob(gpa, bytes);
        defer from_slice.deinit();
        var from_blob = try parseBlobSource(gpa, ranged);
        defer from_blob.deinit();
        try testing.expect(from_slice.indexable);
        try expectSameParsed(from_slice, from_blob);

        // 2. A full page serialization over both sources proves `emitLayers` and
        //    `serialize` byte for byte.
        var note_slice = try sn.parse(gpa, bytes);
        defer note_slice.deinit();
        var note_blob = try sn.parseSource(gpa, ranged);
        defer note_blob.deinit();

        try testing.expectEqual(note_slice.pages.len, note_blob.pages.len);
        try testing.expectEqual(note_slice.dimensions(), note_blob.dimensions());
        try testing.expectEqualStrings(note_slice.signature.raw, note_blob.signature.raw);
        try testing.expectEqualStrings(note_slice.fileId().?, note_blob.fileId().?);

        for (0..note_slice.pages.len) |i| {
            const a_bytes = try sn.page_payload.serialize(gpa, note_slice, i);
            defer gpa.free(a_bytes);
            const b_bytes = try sn.page_payload.serialize(gpa, note_blob, i);
            defer gpa.free(b_bytes);
            try testing.expectEqualSlices(u8, a_bytes, b_bytes);

            var rec_a = try sn.recognition.forPage(gpa, note_slice, i);
            defer if (rec_a) |*r| r.deinit();
            var rec_b = try sn.recognition.forPage(gpa, note_blob, i);
            defer if (rec_b) |*r| r.deinit();
            try testing.expectEqual(rec_a == null, rec_b == null);
            if (rec_a) |ra| {
                const ta = try ra.plainText(gpa);
                defer gpa.free(ta);
                const tb = try rec_b.?.plainText(gpa);
                defer gpa.free(tb);
                try testing.expectEqualStrings(ta, tb);
            }
        }
    }
}

test "a truncated or corrupt note read through the blob source fails cleanly" {
    const gpa = testing.allocator;
    var b = try Blobs.init();
    defer b.deinit();

    // 1. Truncated: the footer address is in the last 4 bytes.
    {
        const md5 = try b.put(sample2[0 .. sample2.len / 2]);
        var bs: blob_source.BlobSource = undefined;
        var p = try parseBlobSource(gpa, try b.source(&md5, &bs));
        defer p.deinit();
        try testing.expect(!p.indexable);
        try testing.expectEqual(@as(usize, 0), p.pages.len);
    }

    // 2. A layer block claims a length past EOF; only range validation sees it.
    {
        const rle = [_]u8{ 0xAB, 0xCD, 0xEF, 0x42 };
        const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
            .{ .slot = .main, .bitmap = &rle },
        } }} });
        defer gpa.free(bytes);
        const at = std.mem.indexOf(u8, bytes, &rle).?;
        std.mem.writeInt(u32, bytes[at - 4 ..][0..4], 0xFFFF_FFF0, .little);

        const md5 = try b.put(bytes);
        var bs: blob_source.BlobSource = undefined;
        const ranged = try b.source(&md5, &bs);

        var note = try sn.parseSource(gpa, ranged);
        defer note.deinit();
        var refs: [max_layers]LayerRef = undefined;
        try testing.expectError(error.Truncated, sn.page_payload.emitLayers(note, 0, &refs));
        try testing.expectError(error.Truncated, sn.page_payload.serialize(gpa, note, 0));

        var p = try parseBlobSource(gpa, ranged);
        defer p.deinit();
        try testing.expect(!p.indexable);
    }

    {
        const md5 = try b.put("\xff\xd8\xff\xe0 not a supernote file at all");
        var bs: blob_source.BlobSource = undefined;
        var p = try parseBlobSource(gpa, try b.source(&md5, &bs));
        defer p.deinit();
        try testing.expect(!p.indexable);
    }
}

test "indexing over the blob source allocates nothing proportional to file size" {
    const gpa = testing.allocator;
    var b = try Blobs.init();
    defer b.deinit();

    // 8 MiB in one layer: a buffering parse would peak above it.
    const big = try gpa.alloc(u8, 8 * 1024 * 1024);
    defer gpa.free(big);
    @memset(big, 0x62);

    const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
        .{ .slot = .main, .bitmap = big },
    } }} });
    defer gpa.free(bytes);
    try testing.expect(bytes.len > 8 * 1024 * 1024);

    const md5 = try b.put(bytes);
    var bs: blob_source.BlobSource = undefined;
    const ranged = try b.source(&md5, &bs);

    var counter = PeakAllocator{ .child = gpa };
    var p = try parseBlobSource(counter.allocator(), ranged);
    defer p.deinit();

    try testing.expect(p.indexable);
    try testing.expectEqual(@as(u32, 1), p.note.page_count);
    try testing.expectEqual(big.len, @as(usize, p.pages[0].layers[0].ref.len)); // it really read it

    // Layers hash through a stack buffer, so peak stays small.
    try testing.expect(counter.peak < 64 * 1024);
    try testing.expect(counter.peak * 100 < bytes.len);

    var counter2 = PeakAllocator{ .child = gpa };
    var p2 = try parseBlob(counter2.allocator(), bytes);
    defer p2.deinit();
    try expectSameParsed(p, p2);
    try testing.expect(counter2.peak < 64 * 1024);
}

/// A note whose second page is landscape (`ORIENTATION = 1090`).
fn landscapeNote(gpa: Allocator) ![]u8 {
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }}, // 1404×1872 base
        .pages = &.{
            .{ .style = "style_white", .orientation = "1000", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .style = "style_white", .orientation = "1090", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
}

test "ORIENTATION 1090: the stored dims and the payload header agree, and are the EFFECTIVE dims" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    const bytes = try landscapeNote(gpa);
    defer gpa.free(bytes);

    // Guard against the builder silently dropping the key.
    {
        var note = try sn.parse(gpa, bytes);
        defer note.deinit();
        try testing.expectEqual(sn.Orientation.vertical, note.pages[0].orientation());
        try testing.expectEqual(sn.Orientation.horizontal, note.pages[1].orientation());
        try testing.expectEqualStrings("1090", note.pages[1].orientationRaw().?);
    }

    const md5 = blobstore.md5HexOf(bytes);
    try indexInto(db, &md5, bytes);

    // A landscape page stores its effective (swapped) dims; base dims shear a
    // real 1090 page.
    const want = [2][2]i64{ .{ 1404, 1872 }, .{ 1872, 1404 } };
    var s = try db.prepare("SELECT width, height FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;");
    defer s.finalize();
    s.bindText(1, &md5);
    for (want) |dims| {
        try testing.expect(try s.step());
        try testing.expectEqual(dims[0], s.columnInt(0));
        try testing.expectEqual(dims[1], s.columnInt(1));
    }

    for (want, 0..) |dims, i| {
        const plan = (try pagePlan(db, &md5, i)).?;
        try testing.expectEqual(@as(u32, @intCast(dims[0])), std.mem.readInt(u32, plan.header[8..12], .little));
        try testing.expectEqual(@as(u32, @intCast(dims[1])), std.mem.readInt(u32, plan.header[12..16], .little));
    }
}

test "a v2 row (base dims) self-heals to v3 effective dims on first read" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try landscapeNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("landscape.note", bytes); // eagerly indexed at v3

    // Regress to v2's shape: stale version, base dims on every page.
    try f.db.exec("UPDATE note_index SET index_version = 2;");
    try f.db.exec("UPDATE note_page_index SET width = 1404, height = 1872;");
    try testing.expect(!try isCurrent(f.db, &md5));

    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 42);
    try testing.expect(try isCurrent(f.db, &md5));

    var s = try f.db.prepare("SELECT width, height FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;");
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 1404), s.columnInt(0));
    try testing.expectEqual(@as(i64, 1872), s.columnInt(1));
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 1872), s.columnInt(0));
    try testing.expectEqual(@as(i64, 1404), s.columnInt(1));
}

test "GOLDEN: a landscape (ORIENTATION 1090) page serializes identically through every path" {
    const gpa = testing.allocator;
    const bytes = try landscapeNote(gpa);
    defer gpa.free(bytes);
    try assertGolden(bytes, "landscape/1090");
}

test "packed layer records round-trip (slot, hidden, current, name), and a malformed blob is rejected" {
    const layers = [_]IndexedLayer{
        .{ .ref = .{ .offset = 334, .len = 0x140e, .slot = .background, .all_blank = true, .hidden = false }, .name = "Background Layer" },
        .{ .ref = .{ .offset = 11008, .len = 42, .slot = .layer2, .all_blank = false, .hidden = true }, .name = "Layer 2" },
        .{ .ref = .{ .offset = 22000, .len = 7, .slot = .layer3, .all_blank = false, .hidden = false }, .name = "Layer Renamed", .is_current = true },
        .{ .ref = .{ .offset = 33000, .len = 9, .slot = .main, .all_blank = false, .hidden = false } }, // no LAYERINFO: empty name
    };
    var buf: [max_layers * max_layer_rec_size]u8 = undefined;
    const packed_bytes = packLayers(&buf, &layers);

    var out: [max_layers]LayerRecord = undefined;
    const got = try unpackLayerRecords(packed_bytes, &out);
    try testing.expectEqual(layers.len, got.len);
    for (layers, got) |want, g| {
        try testing.expectEqual(want.ref, g.ref);
        try testing.expectEqualStrings(want.name, g.name);
        try testing.expectEqual(want.is_current, g.is_current);
    }

    var ref_buf: [max_layers]LayerRef = undefined;
    const refs = try unpackLayers(packed_bytes, &ref_buf);
    for (layers, refs) |want, r| try testing.expectEqual(want.ref, r);

    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(packed_bytes[0 .. packed_bytes.len - 1], &out));
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(packed_bytes[0..5], &out));
    var too_many: [(max_layers + 1) * layer_rec_head_size]u8 = @splat(0);
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(&too_many, &out));
    var bad_slot: [layer_rec_head_size]u8 = @splat(0);
    bad_slot[9] = 0xEE;
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(&bad_slot, &out));

    const long_name = repeat(u8, "n", 300);
    const long = [_]IndexedLayer{.{ .ref = .{ .offset = 1, .len = 2, .slot = .main, .all_blank = false, .hidden = false }, .name = long_name }};
    const packed_long = packLayers(&buf, &long);
    const got_long = try unpackLayerRecords(packed_long, &out);
    try testing.expectEqual(@as(usize, max_layer_name), got_long[0].name.len);
}

const mini_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

/// A `.mark`: a `.note` with a different 4-byte marker.
fn markFile(a: Allocator) ![]u8 {
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(a, .{
        .filetype = "mark",
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
    });
}

test "the signature's file-type marker is recorded, so a .mark is distinguishable from a .note" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    // `detect()` never gates on the marker, so only the recorded marker tells a
    // `.mark` from a note.
    {
        const bytes = try markFile(gpa);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.indexable);
        try testing.expect(p.note.page_count == 1);
        try testing.expectEqualStrings("mark", p.note.filetype.?);

        const md5 = blobstore.md5HexOf(bytes);
        try indexInto(db, &md5, bytes);
        var r = (try db.row(
            "SELECT filetype FROM note_index WHERE blob_md5 = ?1;",
            &.{.{ .text = &md5 }},
        )).?;
        defer r.finalize();
        try testing.expectEqualStrings("mark", r.text(0));
    }

    {
        const bytes = try coveredNote(gpa, null);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expectEqualStrings("note", p.note.filetype.?);
    }
}

test "the cover is LOCATED not extracted: offset/length/mime + dims recorded; coverless stays NULL; undecodable dims store 0" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    // A real cover: location recorded (offset + length + mime), not bytes.
    {
        const bytes = try coveredNote(gpa, mini_png);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.indexable);
        try testing.expectEqualStrings("image/png", p.note.cover_mime.?);
        try testing.expectEqual(@as(?u32, mini_png.len), p.note.cover_length);
        try testing.expectEqual(@as(?u32, 320), p.note.cover_w);
        try testing.expectEqual(@as(?u32, 240), p.note.cover_h);
        const at = std.mem.indexOf(u8, bytes, mini_png).?;
        try testing.expectEqual(@as(?u64, at), p.note.cover_offset);
        try testing.expectEqualSlices(u8, mini_png, bytes[at..][0..mini_png.len]);

        const md5 = blobstore.md5HexOf(bytes);
        try indexInto(db, &md5, bytes);
        var s = try db.prepare("SELECT cover_w, cover_h, cover_offset, cover_length, cover_mime FROM note_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &md5);
        try testing.expect(try s.step());
        try testing.expectEqual(@as(i64, 320), s.columnInt(0));
        try testing.expectEqual(@as(i64, 240), s.columnInt(1));
        try testing.expectEqual(@as(i64, @intCast(at)), s.columnInt(2));
        try testing.expectEqual(@as(i64, mini_png.len), s.columnInt(3));
        try testing.expectEqualStrings("image/png", s.columnText(4));

        const loc = (try coverLocation(db, &md5)).?;
        try testing.expectEqual(@as(u64, at), loc.offset);
        try testing.expectEqual(@as(u64, mini_png.len), loc.length);
        try testing.expectEqualStrings("image/png", loc.mime());
    }

    // Coverless: NULL, distinct from 0.
    {
        const bytes = try coveredNote(gpa, null);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.indexable);
        try testing.expect(p.note.cover_offset == null);
        try testing.expect(p.note.cover_w == null);

        const md5 = blobstore.md5HexOf(bytes);
        try indexInto(db, &md5, bytes);
        try testing.expect((try coverLocation(db, &md5)) == null); // nothing to serve
        var s = try db.prepare("SELECT cover_offset IS NULL, cover_w IS NULL FROM note_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &md5);
        try testing.expect(try s.step());
        try testing.expectEqual(@as(i64, 1), s.columnInt(0));
        try testing.expectEqual(@as(i64, 1), s.columnInt(1));
    }

    // PNG magic, corrupt IHDR: still served, dims record 0.
    {
        const corrupt_png = "\x89PNG\r\n\x1a\n" ++ "\x00\x00\x00\x0d" ++ "NOPE" ++ (repeat(u8, "z", 16));
        const bytes = try coveredNote(gpa, corrupt_png);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.note.cover_offset != null);
        try testing.expectEqualStrings("image/png", p.note.cover_mime.?);
        try testing.expectEqual(@as(?u32, 0), p.note.cover_w);
        try testing.expectEqual(@as(?u32, 0), p.note.cover_h);
    }

    {
        const bytes = try coveredNote(gpa, "just some bytes, not an image");
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.indexable); // the note itself is fine
        try testing.expect(p.note.cover_offset == null);
        try testing.expect(p.note.cover_mime == null);
        try testing.expect(p.note.cover_w == null);
    }
}

test "a cover past the 20 MB ceiling is refused (no cover) from the length prefix, never read" {
    const gpa = testing.allocator;

    const huge = try gpa.alloc(u8, thumbnail.max_cover_bytes + 1);
    defer gpa.free(huge);
    @memset(huge, 0);
    @memcpy(huge[0..8], "\x89PNG\r\n\x1a\n");

    const bytes = try coveredNote(gpa, huge);
    defer gpa.free(bytes);
    var p = try parseBlob(gpa, bytes);
    defer p.deinit();
    try testing.expect(p.indexable);
    try testing.expect(p.note.cover_offset == null);
    try testing.expect(p.note.cover_length == null);
    try testing.expect(p.note.cover_mime == null);
    try testing.expect(p.note.cover_w == null);
}

test "needsRepair: missing or stale row only — no derived file exists for a .note cover" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try coveredNote(gpa, mini_png);
    defer gpa.free(bytes);
    const md5 = try f.put("covered.note", bytes);

    // A `.note` cover streams from the blob, so ingest writes no thumbs file.
    try testing.expect(!f.files.thumbs.has(&md5));
    try testing.expect(!try needsRepair(f.db, f.files.thumbs, &md5));
    try testing.expect((try coverLocation(f.db, &md5)) != null); // resolvable from the row

    // Built from `index_version` so a later bump does not pin a stale number.
    try f.db.exec("UPDATE note_index SET index_version = 9;");
    try testing.expect(try needsRepair(f.db, f.files.thumbs, &md5));
    {
        var buf: [64]u8 = undefined;
        const sql = try std.fmt.bufPrintSentinel(&buf, "UPDATE note_index SET index_version = {d};", .{index_version}, 0);
        try f.db.exec(sql);
    }
    try testing.expect(!try needsRepair(f.db, f.files.thumbs, &md5));

    // A current coverless row is a memoised 404.
    const coverless = try coveredNote(gpa, null);
    defer gpa.free(coverless);
    const md5_2 = try f.put("coverless.note", coverless);
    try testing.expect(!try needsRepair(f.db, f.files.thumbs, &md5_2));
    try testing.expect((try coverLocation(f.db, &md5_2)) == null);

    try f.db.exec("DELETE FROM note_index;");
    try testing.expect(try needsRepair(f.db, f.files.thumbs, &md5_2));
}

test "a stale row lazily re-derives to the current version and gains its cover location — no sweep, no migration" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try coveredNote(gpa, mini_png);
    defer gpa.free(bytes);
    const md5 = try f.put("covered.note", bytes); // eagerly indexed at the current version

    // Regress to the pre-cover-location shape (the 9->10 upgrade).
    try f.db.exec("UPDATE note_index SET index_version = 3, cover_w = NULL, cover_h = NULL, " ++
        "cover_offset = NULL, cover_length = NULL, cover_mime = NULL;");
    try testing.expect(!try isCurrent(f.db, &md5));

    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 42);
    try testing.expect(try isCurrent(f.db, &md5));
    var s = try f.db.prepare("SELECT cover_w, cover_h, cover_offset IS NOT NULL, cover_mime FROM note_index WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 320), s.columnInt(0));
    try testing.expectEqual(@as(i64, 240), s.columnInt(1));
    try testing.expectEqual(@as(i64, 1), s.columnInt(2)); // cover location repopulated
    try testing.expectEqualStrings("image/png", s.columnText(3));
}

test "GOLDEN: the layers_edited capture (hidden layer on the wire) through every producer" {
    try assertGolden(layers_edited, "layers_edited.note");
}

test "pagePlan serves SNPG v2: version byte, per-record slot + hidden flag, exact length" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    const md5 = blobstore.md5HexOf(layers_edited);
    try indexInto(db, &md5, layers_edited);

    const plan = (try pagePlan(db, &md5, 1)).?;
    try testing.expectEqual(sn.page_payload.VERSION, plan.header[4]);
    try testing.expectEqual(@as(u32, 5), std.mem.readInt(u32, plan.header[16..20], .little));

    var hidden_count: usize = 0;
    for (plan.layers()) |r| {
        if (r.hidden) {
            hidden_count += 1;
            try testing.expectEqual(sn.types.LayerSlot.layer2, r.slot);
        }
    }
    try testing.expectEqual(@as(usize, 1), hidden_count);

    // The hidden stream rides the wire without touching the default composite.
    const payload = try serializeFromIndex(gpa, db, &md5, 1, SliceSource{ .bytes = layers_edited });
    defer gpa.free(payload);
    const rgba = try sn.page_payload.decodeRgba(gpa, payload);
    defer rgba.deinit(gpa);

    var note = try sn.parse(gpa, layers_edited);
    defer note.deinit();
    const gray = try sn.renderPageGray(gpa, note, 1);
    defer gray.deinit(gpa);
    for (gray.pixels, 0..) |g, i| try testing.expectEqual(g, rgba.pixels[i * 4]);

    const l2 = try sn.page_payload.decodeLayerRgba(gpa, payload, 2);
    defer l2.deinit(gpa);
    try testing.expectEqual(rgba.width, l2.width);
}

test "eager indexing at ingest does not disturb the file tree it rides along with" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("n.note", sample);
    try testing.expect(try isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT page_count FROM note_index;"));

    _ = try f.put("copy.note", sample);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    const entries = try f.files.list(1, null);
    defer filesvc.Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 2), entries.len);
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM files;"));
}
