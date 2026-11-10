//! Container integration tests: committed real captures (`fixtures/*.note`)
//! plus synthetic containers from `note_builder.zig`.

const std = @import("std");
const note = @import("note");
const builder = @import("note_builder.zig");
const prop = @import("prop.zig");

const sample = @embedFile("fixtures/sample.note");
const horizontal = @embedFile("fixtures/horizontal_layers.note");
const one_thumb = @embedFile("fixtures/one_thumb.note");
const layers_edited = @embedFile("fixtures/layers_edited.note");

test "parse real Nomad sample.note (Chauvet 3.29.42)" {
    var doc = try note.parse(std.testing.allocator, sample);
    defer doc.deinit();

    try std.testing.expectEqual(note.Family.x_series, doc.signature.family);
    try std.testing.expectEqual(@as(u32, 20260016), doc.signature.version);
    try std.testing.expectEqualStrings("note", doc.signature.filetype);

    try std.testing.expectEqualStrings("N6", doc.applyEquipment().?);
    try std.testing.expectEqualStrings(
        "F20260718160909846383Na7MHLyOBbpq",
        doc.fileId().?,
    );
    const dims = doc.dimensions();
    try std.testing.expectEqual(@as(u32, 1404), dims.width);
    try std.testing.expectEqual(@as(u32, 1872), dims.height);

    try std.testing.expectEqual(@as(usize, 1), doc.pageCount());
    const page = doc.pages[0];
    try std.testing.expectEqualStrings("style_5mm_dots", page.style().?);
    try std.testing.expectEqualStrings("1000", page.orientationRaw().?);
    try std.testing.expectEqual(note.Orientation.vertical, page.orientation());
    try std.testing.expectEqual(@as(u32, 44652), page.totalPathAddress());

    const main = page.layer(.main).?;
    try std.testing.expectEqualStrings("RATTA_RLE", main.protocol().?);
    try std.testing.expectEqual(@as(u32, 11004), main.bitmapAddress());

    const bg = page.layer(.background).?;
    try std.testing.expectEqualStrings("RATTA_RLE", bg.protocol().?);
    try std.testing.expectEqual(@as(u32, 330), bg.bitmapAddress());

    try std.testing.expect(page.layer(.layer1) == null);

    const src = note.Source.fromSlice(sample);
    for (page.layers) |l| {
        const r = try src.blockRange(l.bitmapAddress());
        try std.testing.expect(r.len > 0);
    }
}

test "parse real Nomad horizontal_layers.note — every page landscape" {
    var doc = try note.parse(std.testing.allocator, horizontal);
    defer doc.deinit();

    try std.testing.expectEqual(@as(u32, 20260016), doc.signature.version);
    try std.testing.expectEqualStrings("N6", doc.applyEquipment().?);
    try std.testing.expectEqual(@as(usize, 2), doc.pageCount());

    // Orientation is per page: base dims stay portrait, both `1090` pages swap.
    const base = doc.dimensions();
    try std.testing.expectEqual(note.types.Dimensions.default, base);
    for (doc.pages) |page| {
        try std.testing.expectEqualStrings("style_h_10mm_ruled_line", page.style().?);
        try std.testing.expectEqual(note.Orientation.horizontal, page.orientation());
        try std.testing.expectEqualStrings("1090", page.orientationRaw().?);
        try std.testing.expectEqual(
            note.types.Dimensions{ .width = 1872, .height = 1404 },
            base.oriented(page.orientation()),
        );
    }

    try std.testing.expectEqual(@as(usize, 2), doc.pages[0].layers.len);
    try std.testing.expectEqual(@as(usize, 5), doc.pages[1].layers.len);
    try std.testing.expect(doc.pages[1].layer(.layer2) != null);
}

test "layers_edited.note: both LAYERINFO encodings parse from the same file" {
    var doc = try note.parse(std.testing.allocator, layers_edited);
    defer doc.deinit();

    try std.testing.expectEqual(@as(usize, 2), doc.pageCount());

    // Page 1: never-created Layers 3/2/1 read isDeleted:true; background is -1.
    {
        const info = doc.pages[0].layer_info.?;
        try std.testing.expectEqual(@as(usize, 5), info.len);
        const want_ids = [_]i32{ 3, 2, 1, 0, -1 };
        const want_names = [_][]const u8{ "Layer 3", "Layer 2", "Layer 1", "Main Layer", "Background Layer" };
        for (info, want_ids, want_names) |e, id, name| {
            try std.testing.expectEqual(id, e.layer_id);
            try std.testing.expectEqualStrings(name, e.name);
            try std.testing.expect(e.is_visible);
        }
        try std.testing.expect(info[0].is_deleted and info[1].is_deleted and info[2].is_deleted);
        try std.testing.expect(!info[3].is_deleted and info[3].is_current);
        try std.testing.expect(info[4].is_background and !info[4].is_deleted);
    }

    // Page 2: reordered 3,1,2,0,-1, top layer renamed, Layer 2 hidden.
    {
        const page = doc.pages[1];
        const info = page.layer_info.?;
        try std.testing.expectEqual(@as(usize, 5), info.len);

        const want_ids = [_]i32{ 3, 1, 2, 0, -1 };
        for (info, want_ids) |e, id| try std.testing.expectEqual(id, e.layer_id);

        try std.testing.expectEqualStrings("Layer Renamed", info[0].name);
        try std.testing.expect(info[0].is_current);
        try std.testing.expectEqualStrings("LAYER3", page.layer(.layer3).?.name().?);

        try std.testing.expectEqual(@as(i32, 2), info[2].layer_id);
        try std.testing.expect(!info[2].is_visible);
        try std.testing.expect(!info[2].is_deleted);
        try std.testing.expect(page.layer(.layer2).?.bitmapAddress() != 0);
        try std.testing.expectEqualStrings("LAYER3,LAYER1,MAINLAYER,BGLAYER", page.block.get("LAYERSEQ").?);

        try std.testing.expect(info[4].is_background);
        try std.testing.expectEqual(@as(i32, -1), info[4].layer_id);

        try std.testing.expectEqualStrings("Background Layer", page.infoForSlot(.background).?.name);
        try std.testing.expectEqualStrings("Layer 2", page.infoForSlot(.layer2).?.name);
    }
}

test "horizontal_layers.note: page 1 #-JSON records never-created layers as deleted; page 2 is base64 with LAYER2 hidden" {
    // Page 2's #-JSON-with-deleted-LAYER2 is a stale block generation; only
    // footer-referenced blocks are current.
    var doc = try note.parse(std.testing.allocator, horizontal);
    defer doc.deinit();

    const p1 = doc.pages[0].layer_info.?;
    try std.testing.expectEqual(@as(usize, 5), p1.len);
    for (p1[0..3]) |e| try std.testing.expect(e.is_deleted);
    try std.testing.expect(doc.pages[0].layer(.layer2) == null);

    const l2 = doc.pages[1].infoForSlot(.layer2).?;
    try std.testing.expect(!l2.is_visible);
    try std.testing.expect(!l2.is_deleted);
    try std.testing.expectEqualStrings("Layer 2", l2.name);
    try std.testing.expect(doc.pages[1].layer(.layer2).?.bitmapAddress() != 0);
    try std.testing.expectEqualStrings("Layer Renamed", doc.pages[1].infoForSlot(.layer3).?.name);
    try std.testing.expectEqualStrings("LAYER3,LAYER1,MAINLAYER,BGLAYER", doc.pages[1].block.get("LAYERSEQ").?);
}

test "hostile LAYERINFO is a recorded absence — the note still parses" {
    const gpa = std.testing.allocator;

    const bmp = [_]u8{ 0x61, 0x00 };
    const cases = [_]?[]const u8{
        "W3sibGF5ZXJJZCI6", // truncated base64
        "!!junk, not JSON, not base64!!",
        "[{\"layerId\"#0,", // truncated #-JSON
        null, // no LAYERINFO at all
    };
    for (cases) |raw| {
        const bytes = try builder.serialize(gpa, .{ .pages = &.{.{
            .style = "style_white",
            .layer_info = raw,
            .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
        }} });
        defer gpa.free(bytes);

        var doc = try note.parse(gpa, bytes);
        defer doc.deinit();
        try std.testing.expectEqual(@as(?[]const note.layerinfo.Entry, null), doc.pages[0].layer_info);
        try std.testing.expectEqual(@as(usize, 1), doc.pages[0].layers.len); // parses fine
    }
}

test "a '#' inside a layer NAME survives the #-JSON fixup (via the builder)" {
    const gpa = std.testing.allocator;

    const bytes = try builder.serialize(gpa, .{ .pages = &.{.{
        .style = "style_white",
        .layer_info = "[{\"layerId\"#0,\"name\"#\"my #1 layer\",\"isVisible\"#true,\"isDeleted\"#false}]",
    }} });
    defer gpa.free(bytes);

    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();
    const info = doc.pages[0].layer_info.?;
    try std.testing.expectEqual(@as(usize, 1), info.len);
    try std.testing.expectEqualStrings("my #1 layer", info[0].name);
}

test "one_thumb.note: COVER_2 resolves to a complete device-resolution PNG" {
    const gpa = std.testing.allocator;

    var doc = try note.parse(gpa, one_thumb);
    defer doc.deinit();
    try std.testing.expectEqual(@as(usize, 2), doc.pageCount());

    const addr = doc.coverAddress().?;
    try std.testing.expectEqual(@as(u64, 429), addr);

    // A full-resolution PNG, read with one `blockAlloc` at the address.
    const src = note.Source.fromSlice(one_thumb);
    const cover = try src.blockAlloc(gpa, addr);
    defer gpa.free(cover);
    try std.testing.expectEqual(@as(usize, 36909), cover.len);
    try std.testing.expectEqualSlices(u8, "\x89PNG\r\n\x1a\n", cover[0..8]);
    try std.testing.expectEqualSlices(u8, "IHDR", cover[12..16]);
    try std.testing.expectEqual(@as(u32, 1404), std.mem.readInt(u32, cover[16..20], .big));
    try std.testing.expectEqual(@as(u32, 1872), std.mem.readInt(u32, cover[20..24], .big));
}

test "both real no-cover shapes read as null: an explicit COVER_0=0 and no COVER key at all" {
    const gpa = std.testing.allocator;

    // `<COVER_0:0>` placeholder, and an older file with no COVER key.
    for ([_][]const u8{ horizontal, sample }) |bytes| {
        var doc = try note.parse(gpa, bytes);
        defer doc.deinit();
        try std.testing.expectEqual(@as(?u64, null), doc.coverAddress());
    }
}

test "coverAddress: COVER_2 preferred over COVER_1; a zeroed or lone COVER_1 handled" {
    const gpa = std.testing.allocator;
    const png2 = "\x89PNG\r\n\x1a\n--user-set--";
    const png1 = "\x89PNG\r\n\x1a\n--automatic--";
    const page: builder.PageSpec = .{ .style = "style_white" };

    {
        const bytes = try builder.serialize(gpa, .{ .pages = &.{page}, .covers = &.{
            .{ .key = "COVER_1", .bytes = png1 },
            .{ .key = "COVER_2", .bytes = png2 },
        } });
        defer gpa.free(bytes);
        var doc = try note.parse(gpa, bytes);
        defer doc.deinit();
        const cover = try note.Source.fromSlice(bytes).blockAlloc(gpa, doc.coverAddress().?);
        defer gpa.free(cover);
        try std.testing.expectEqualSlices(u8, png2, cover);
    }

    // COVER_1 only: no capture has one, so pinned synthetically.
    {
        const bytes = try builder.serialize(gpa, .{ .pages = &.{page}, .covers = &.{
            .{ .key = "COVER_1", .bytes = png1 },
        } });
        defer gpa.free(bytes);
        var doc = try note.parse(gpa, bytes);
        defer doc.deinit();
        const cover = try note.Source.fromSlice(bytes).blockAlloc(gpa, doc.coverAddress().?);
        defer gpa.free(cover);
        try std.testing.expectEqualSlices(u8, png1, cover);
    }

    // A zeroed COVER_2 is no cover and does not hide a real COVER_1.
    {
        const bytes = try builder.serialize(gpa, .{ .pages = &.{page}, .footer_extra = &.{
            .{ .key = "COVER_2", .value = "0" },
        } });
        defer gpa.free(bytes);
        var doc = try note.parse(gpa, bytes);
        defer doc.deinit();
        try std.testing.expectEqual(@as(?u64, null), doc.coverAddress());
    }
}

test "coverAddress: COVER_3 (the newer user-set key) wins over COVER_2 and COVER_1; a zeroed COVER_3 is no cover" {
    const gpa = std.testing.allocator;
    const png3 = "\x89PNG\r\n\x1a\n--user-set-v3--";
    const png2 = "\x89PNG\r\n\x1a\n--user-set--";
    const png1 = "\x89PNG\r\n\x1a\n--automatic--";
    const page: builder.PageSpec = .{ .style = "style_white" };

    {
        const bytes = try builder.serialize(gpa, .{ .pages = &.{page}, .covers = &.{
            .{ .key = "COVER_1", .bytes = png1 },
            .{ .key = "COVER_2", .bytes = png2 },
            .{ .key = "COVER_3", .bytes = png3 },
        } });
        defer gpa.free(bytes);
        var doc = try note.parse(gpa, bytes);
        defer doc.deinit();
        const cover = try note.Source.fromSlice(bytes).blockAlloc(gpa, doc.coverAddress().?);
        defer gpa.free(cover);
        try std.testing.expectEqualSlices(u8, png3, cover);
    }

    // The `user_cover.note` shape.
    {
        const bytes = try builder.serialize(gpa, .{ .pages = &.{page}, .covers = &.{
            .{ .key = "COVER_2", .bytes = png2 },
            .{ .key = "COVER_3", .bytes = png3 },
        } });
        defer gpa.free(bytes);
        var doc = try note.parse(gpa, bytes);
        defer doc.deinit();
        const cover = try note.Source.fromSlice(bytes).blockAlloc(gpa, doc.coverAddress().?);
        defer gpa.free(cover);
        try std.testing.expectEqualSlices(u8, png3, cover);
    }

    {
        const bytes = try builder.serialize(gpa, .{ .pages = &.{page}, .footer_extra = &.{
            .{ .key = "COVER_3", .value = "0" },
        } });
        defer gpa.free(bytes);
        var doc = try note.parse(gpa, bytes);
        defer doc.deinit();
        try std.testing.expectEqual(@as(?u64, null), doc.coverAddress());
    }
}

test "ORIENTATION is per-page: typed orientation and effective dims" {
    const gpa = std.testing.allocator;

    const bytes = try builder.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{
            .{ .style = "style_white", .orientation = "1000" },
            .{ .style = "style_white", .orientation = "1090" },
            .{ .style = "style_white", .orientation = null },
        },
    });
    defer gpa.free(bytes);

    const want = [_]note.Orientation{ .vertical, .horizontal, .vertical };

    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();
    const base = doc.dimensions();
    for (doc.pages, want) |page, o| try std.testing.expectEqual(o, page.orientation());

    try std.testing.expectEqual(base, base.oriented(doc.pages[0].orientation()));
    try std.testing.expectEqual(
        note.types.Dimensions{ .width = 1872, .height = 1404 },
        base.oriented(doc.pages[1].orientation()),
    );
    try std.testing.expectEqual(base, base.oriented(doc.pages[2].orientation()));

    try std.testing.expectEqual(@as(?[]const u8, null), doc.pages[2].orientationRaw());
}

test "a parsed Note owns its strings — the input buffer may be freed" {
    const gpa = std.testing.allocator;

    const bytes = try builder.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N5" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{} }},
    });
    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();

    // Scribble over and free the source; the Note's copies must survive.
    @memset(bytes, 0xAA);
    gpa.free(bytes);

    try std.testing.expectEqualStrings("N5", doc.applyEquipment().?);
    try std.testing.expectEqualStrings("style_white", doc.pages[0].style().?);
    try std.testing.expectEqual(@as(u32, 1920), doc.dimensions().width);
}

const textbox_on = @embedFile("fixtures/textbox_recognition_on.note");
const textbox_off = @embedFile("fixtures/textbox_recognition_off.note");

test "textbox_recognition_on.note: two typed boxes, accents and a line break; the transcript has none of it" {
    const gpa = std.testing.allocator;
    var doc = try note.parse(gpa, textbox_on);
    defer doc.deinit();
    const page = doc.pages[0];
    try std.testing.expectEqualStrings("1", page.block.get("PAGETEXTBOX").?); // a flag: 1 with two boxes

    var boxes = try note.textbox.forParsedPage(gpa, doc.source, page);
    defer boxes.deinit();
    try std.testing.expectEqual(@as(usize, 2), boxes.boxes.len);
    try std.testing.expectEqualStrings("Très bien\nça va", boxes.boxes[0].text);
    try std.testing.expectEqual(note.textbox.Rect{ .x = 702, .y = 928, .w = 259, .h = 127 }, boxes.boxes[0].rect);
    try std.testing.expectEqualStrings("Box 2 - 42", boxes.boxes[1].text);

    const plain = try boxes.plainText(gpa);
    defer gpa.free(plain);
    try std.testing.expectEqualStrings("Très bien\nça va\nBox 2 - 42", plain);

    // Recognition is on and finished, and still holds nothing typed.
    var rec = (try note.recognition.forPage(gpa, doc, 0)).?;
    defer rec.deinit();
    try std.testing.expectEqual(@as(usize, 0), rec.elements().len);
}

test "textbox_recognition_off.note: a Standard note stores its box the same way" {
    const gpa = std.testing.allocator;
    var doc = try note.parse(gpa, textbox_off);
    defer doc.deinit();
    try std.testing.expectEqualStrings("0", doc.header.get("FILE_RECOGN_TYPE").?);
    const page = doc.pages[0];
    try std.testing.expectEqual(@as(u32, 0), page.recognitionAddress());

    var boxes = try note.textbox.forParsedPage(gpa, doc.source, page);
    defer boxes.deinit();
    try std.testing.expectEqual(@as(usize, 1), boxes.boxes.len);
    try std.testing.expectEqualStrings("café noir", boxes.boxes[0].text);
}

test "a page without text boxes yields none, without reading its strokes" {
    const gpa = std.testing.allocator;
    var doc = try note.parse(gpa, sample);
    defer doc.deinit();
    var boxes = try note.textbox.forParsedPage(gpa, doc.source, doc.pages[0]);
    defer boxes.deinit();
    try std.testing.expectEqual(@as(usize, 0), boxes.boxes.len);
}
