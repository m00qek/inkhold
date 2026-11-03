//! Tests for custom image templates and sparse `.mark` pages.

const std = @import("std");
const sn = @import("supernote");
const Allocator = std.mem.Allocator;
const testing = std.testing;
const nb = @import("note_builder");
const noteindex = @import("../note_index.zig");
const max_layers = noteindex.max_layers;
const LayerRecord = noteindex.LayerRecord;
const unpackLayerRecords = noteindex.unpackLayerRecords;
const isCurrent = noteindex.isCurrent;
const SliceSource = noteindex.SliceSource;
const pagePlan = noteindex.pagePlan;
const templateLocation = noteindex.templateLocation;
const streamPage = noteindex.streamPage;
const serializeFromIndex = noteindex.serializeFromIndex;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;

/// PNG magic + IHDR: cannot decode as a full-page RATTA_RLE stream.
const fake_png = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52 };

/// A valid one-pair RATTA_RLE background (0x62 transparent, 0xFF special length).
const rle_bg = [_]u8{ 0x62, 0xFF };

const template_hash = "deadbeefdeadbeefdeadbeefdeadbeef";

const SnpgRecord = struct { flags: u8, slot: u8, data: []const u8 };

fn snpgRecordForSlot(payload: []const u8, want_slot: u8) ?SnpgRecord {
    const pp = sn.page_payload;
    if (payload.len < pp.HEADER_SIZE) return null;
    const layer_count = std.mem.readInt(u32, payload[16..20], .little);
    var pos: usize = pp.HEADER_SIZE;
    var i: u32 = 0;
    while (i < layer_count) : (i += 1) {
        if (pos + pp.LAYER_HEADER_SIZE > payload.len) return null;
        const flags = payload[pos];
        const slot = payload[pos + 1];
        const len = std.mem.readInt(u32, payload[pos + 2 ..][0..4], .little);
        pos += pp.LAYER_HEADER_SIZE;
        if (pos + len > payload.len) return null;
        const data = payload[pos..][0..len];
        pos += len;
        if (slot == want_slot) return .{ .flags = flags, .slot = slot, .data = data };
    }
    return null;
}

/// Page 0 has a custom image background; page 1 is ordinary RLE.
fn imageTemplateNote(gpa: Allocator) ![]u8 {
    return nb.serialize(gpa, .{ .pages = &.{
        .{
            .style = "customImage",
            .style_md5 = template_hash,
            .layers = &.{
                .{ .slot = .background, .name = "BGLAYER", .protocol = "RATTA_RLE", .bitmap = &fake_png },
                .{ .slot = .main, .name = "MAINLAYER", .protocol = "RATTA_RLE", .bitmap = &.{ 0x61, 0x00 } },
            },
        },
        .{
            .style = "style_white",
            .style_md5 = "0",
            .layers = &.{
                .{ .slot = .background, .name = "BGLAYER", .protocol = "RATTA_RLE", .bitmap = &rle_bg },
                .{ .slot = .main, .name = "MAINLAYER", .protocol = "RATTA_RLE", .bitmap = &.{ 0x61, 0x00 } },
            },
        },
    } });
}

test "ingest: a custom image background sets raster_image + bg_hash; a normal page does not" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try imageTemplateNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("template.note", bytes);
    try testing.expect(try isCurrent(f.db, &md5));

    {
        var s = try f.db.prepare("SELECT bg_hash, layers FROM note_page_index WHERE blob_md5 = ?1 AND page_index = 0;");
        defer s.finalize();
        s.bindText(1, &md5);
        try testing.expect(try s.step());
        try testing.expect(!s.columnIsNull(0));
        try testing.expectEqualStrings(template_hash, s.columnText(0));
        var recs: [max_layers]LayerRecord = undefined;
        const got = try unpackLayerRecords(s.columnBlob(1), &recs);
        var bg_seen = false;
        for (got) |r| if (r.ref.slot == .background) {
            bg_seen = true;
            try testing.expect(r.ref.raster_image);
        };
        try testing.expect(bg_seen);
    }

    {
        var s = try f.db.prepare("SELECT bg_hash, layers FROM note_page_index WHERE blob_md5 = ?1 AND page_index = 1;");
        defer s.finalize();
        s.bindText(1, &md5);
        try testing.expect(try s.step());
        try testing.expect(s.columnIsNull(0));
        var recs: [max_layers]LayerRecord = undefined;
        const got = try unpackLayerRecords(s.columnBlob(1), &recs);
        for (got) |r| if (r.ref.slot == .background) try testing.expect(!r.ref.raster_image);
    }
}

test "SNPG wire: an image background carries the asset hash (bit2), not the image bytes" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try imageTemplateNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("template.note", bytes);

    const plan = (try pagePlan(f.db, &md5, 0)).?;

    var sink = std.Io.Writer.Allocating.init(gpa);
    defer sink.deinit();
    try streamPage(f.files.blobs, &md5, plan, &sink.writer);
    const streamed = sink.written();
    const buffered = try serializeFromIndex(gpa, f.db, &md5, 0, SliceSource{ .bytes = bytes });
    defer gpa.free(buffered);
    try testing.expectEqualSlices(u8, buffered, streamed);
    try testing.expectEqual(plan.content_length, streamed.len);

    const bg = snpgRecordForSlot(streamed, sn.types.LayerSlot.background.wireId()).?;
    try testing.expect(bg.flags & sn.page_payload.FLAG_RASTER_IMAGE != 0);
    try testing.expectEqualStrings(template_hash, bg.data);
    try testing.expect(!std.mem.eql(u8, bg.data, &fake_png));

    const plan1 = (try pagePlan(f.db, &md5, 1)).?;
    var sink1 = std.Io.Writer.Allocating.init(gpa);
    defer sink1.deinit();
    try streamPage(f.files.blobs, &md5, plan1, &sink1.writer);
    const bg1 = snpgRecordForSlot(sink1.written(), sn.types.LayerSlot.background.wireId()).?;
    try testing.expect(bg1.flags & sn.page_payload.FLAG_RASTER_IMAGE == 0);
    try testing.expectEqualSlices(u8, &rle_bg, bg1.data);
}

test "ingest: a sparse .mark keeps the PDF pages it names; a notebook stays 1..N" {
    // A `.mark` holds only annotated pages, at positions 0, 1, 2 belonging to
    // PDF pages 2, 5, 6.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const mark = try nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{ .{ .number = 2 }, .{ .number = 5 }, .{ .number = 6 } },
    });
    defer gpa.free(mark);
    const md5 = try f.put("annotated.pdf.mark", mark);
    try testing.expect(try isCurrent(f.db, &md5));

    var s = try f.db.prepare(
        "SELECT page_index, source_page FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    const want = [_][2]i64{ .{ 0, 2 }, .{ 1, 5 }, .{ 2, 6 } };
    for (want) |w| {
        try testing.expect(try s.step());
        try testing.expectEqual(w[0], s.columnInt(0));
        try testing.expectEqual(w[1], s.columnInt(1));
    }
    try testing.expect(!try s.step());

    // A notebook's number is still position + 1.
    const book = try nb.serialize(gpa, .{ .pages = &.{ .{}, .{}, .{} } });
    defer gpa.free(book);
    const bmd5 = try f.put("book.note", book);
    var s2 = try f.db.prepare(
        "SELECT page_index, source_page FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s2.finalize();
    s2.bindText(1, &bmd5);
    var n: i64 = 0;
    while (try s2.step()) : (n += 1) {
        try testing.expectEqual(n, s2.columnInt(0));
        try testing.expectEqual(n + 1, s2.columnInt(1));
    }
    try testing.expectEqual(@as(i64, 3), n);
}

test "templateLocation: resolves hash to the image byte range; wrong hash is null" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try imageTemplateNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("template.note", bytes);

    const loc = (try templateLocation(f.db, &md5, template_hash)).?;
    try testing.expectEqual(@as(u64, fake_png.len), loc.length);
    var buf: [fake_png.len]u8 = undefined;
    const got = try f.files.blobs.readRange(&md5, loc.offset, loc.length, &buf);
    try testing.expectEqualSlices(u8, &fake_png, got);

    try testing.expect((try templateLocation(f.db, &md5, "00000000000000000000000000000000")) == null);
}
