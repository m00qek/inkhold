//! Tests for orientation, layer records, file-type markers, covers and repair.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbnail = @import("../thumbnail.zig");
const sn = @import("supernote");
const Allocator = std.mem.Allocator;
const testing = std.testing;
const schema = @import("../../db/schema.zig");
const filesmod = @import("../files.zig");
const nb = @import("note_builder");
const noteindex = @import("../note_index.zig");
const index_version = noteindex.index_version;
const LayerRef = noteindex.LayerRef;
const max_layers = noteindex.max_layers;
const IndexedLayer = noteindex.IndexedLayer;
const layer_rec_head_size = noteindex.layer_rec_head_size;
const max_layer_name = noteindex.max_layer_name;
const max_layer_rec_size = noteindex.max_layer_rec_size;
const parseBlob = noteindex.parseBlob;
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
const serializeFromIndex = noteindex.serializeFromIndex;
const fixture = @import("fixture.zig");
const layers_edited = fixture.layers_edited;
const Fixture = fixture.Fixture;
const indexInto = fixture.indexInto;
const coveredNote = fixture.coveredNote;
const shared = @import("index_helpers.zig");
const sample = shared.sample;
const assertGolden = shared.assertGolden;

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
    defer filesmod.Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 2), entries.len);
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM files;"));
}
