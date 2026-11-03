//! Round trips, page numbering, links and the real .mark capture through the container.

const std = @import("std");
const note = @import("note");
const builder = @import("note_builder.zig");
const prop = @import("prop.zig");

const annotated_mark = @embedFile("fixtures/annotated.pdf.mark");

const Case = struct {
    spec: builder.Spec,
    bytes: []const u8,
};

const slots = [_]note.types.LayerSlot{ .main, .layer1, .layer2, .layer3, .background };

fn genCase(r: std.Random, a: std.mem.Allocator) anyerror!Case {
    const page_count = r.intRangeAtMost(usize, 1, 4);
    const pages = try a.alloc(builder.PageSpec, page_count);
    for (pages) |*page| {
        const layer_count = r.intRangeAtMost(usize, 0, slots.len);
        const layers = try a.alloc(builder.LayerSpec, layer_count);
        for (layers, 0..) |*layer, i| {
            const bmp = try a.alloc(u8, r.intRangeAtMost(usize, 0, 64));
            r.bytes(bmp);
            layer.* = .{
                .slot = slots[i], // distinct slots, in format order
                .name = try randAlnum(r, a, 3, 8),
                .protocol = "RATTA_RLE",
                .bitmap = bmp,
            };
        }
        page.* = .{ .style = try randAlnum(r, a, 0, 6), .layers = layers };
    }

    const header_count = r.intRangeAtMost(usize, 0, 4);
    const header = try a.alloc(builder.Kv, header_count);
    for (header, 0..) |*kv, i| {
        kv.* = .{
            .key = try std.fmt.allocPrint(a, "HK{d}", .{i}), // unique keys
            .value = try randAlnum(r, a, 1, 10),
        };
    }

    const spec: builder.Spec = .{
        .version = r.intRangeAtMost(u32, 20200000, 20999999),
        .header = header,
        .pages = pages,
    };
    return .{ .spec = spec, .bytes = try builder.serialize(a, spec) };
}

fn property(c: Case) anyerror!void {
    var doc = try note.parse(std.testing.allocator, c.bytes);
    defer doc.deinit();

    try std.testing.expectEqual(c.spec.version, doc.signature.version);
    try std.testing.expectEqual(c.spec.pages.len, doc.pageCount());

    const src = note.Source.fromSlice(c.bytes);
    for (c.spec.pages, doc.pages) |want_page, got_page| {
        try std.testing.expectEqual(want_page.layers.len, got_page.layers.len);
        for (want_page.layers) |want_layer| {
            const got = got_page.layer(want_layer.slot) orelse return error.MissingLayer;
            try std.testing.expectEqualStrings(want_layer.protocol, got.protocol().?);
            try std.testing.expectEqualStrings(want_layer.name, got.name().?);
            const r = try src.blockRange(got.bitmapAddress());
            const content = src.view(r.offset, r.len).?;
            try std.testing.expectEqualSlices(u8, want_layer.bitmap, content);
        }
    }

    for (c.spec.header) |kv| {
        try std.testing.expectEqualStrings(kv.value, doc.header.get(kv.key).?);
    }
}

fn randAlnum(r: std.Random, a: std.mem.Allocator, min: usize, max: usize) ![]u8 {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const n = r.intRangeAtMost(usize, min, max);
    const s = try a.alloc(u8, n);
    for (s) |*ch| ch.* = alphabet[r.intRangeLessThan(usize, 0, alphabet.len)];
    return s;
}

test "build -> serialize -> parse round-trips structure and bitmaps" {
    try prop.check(Case, std.testing.allocator, genCase, property, .{ .runs = 2000 });
}

test "a page knows its own number, and a contiguous footer numbers 1..N" {
    const gpa = std.testing.allocator;
    const bytes = try builder.serialize(gpa, .{ .pages = &.{ .{}, .{}, .{} } });
    defer gpa.free(bytes);
    var n = try note.parse(gpa, bytes);
    defer n.deinit();

    try std.testing.expectEqual(@as(usize, 3), n.pages.len);
    for (n.pages, 1..) |p, want| try std.testing.expectEqual(@as(u32, @intCast(want)), p.number);
}

test "a SPARSE footer keeps the numbers it names, not the positions they sit at" {
    // A `.mark` footer: only annotated pages, named by PDF page (§13.2).
    const gpa = std.testing.allocator;
    const bytes = try builder.serialize(gpa, .{
        .pages = &.{ .{ .number = 2 }, .{ .number = 5 }, .{ .number = 6 } },
    });
    defer gpa.free(bytes);
    var n = try note.parse(gpa, bytes);
    defer n.deinit();

    try std.testing.expectEqual(@as(usize, 3), n.pages.len);
    try std.testing.expectEqual(@as(u32, 2), n.pages[0].number);
    try std.testing.expectEqual(@as(u32, 5), n.pages[1].number);
    try std.testing.expectEqual(@as(u32, 6), n.pages[2].number);

    for (n.pages) |p| try std.testing.expect(p.block.entries.len > 0);
}

test "a PAGE key with no readable number is Corrupt, not silently renumbered" {
    // A page that cannot be placed is `Corrupt`, not renumbered.
    const gpa = std.testing.allocator;
    const bytes = try builder.serialize(gpa, .{ .pages = &.{.{}} });
    defer gpa.free(bytes);
    const bad = try gpa.dupe(u8, bytes);
    defer gpa.free(bad);
    const at = std.mem.lastIndexOf(u8, bad, "<PAGE1:").?;
    bad[at + "<PAGE".len] = 'x';
    try std.testing.expectError(error.Corrupt, note.parse(gpa, bad));
}

test "a page's links come off its own EXTERNALLINKINFO address" {
    const gpa = std.testing.allocator;
    const bytes = try builder.serialize(gpa, .{
        .pages = &.{
            .{ .style = "user_pdf_planner_2", .links = &.{
                .{ .target_page = 1701, .x = 901, .y = 192, .w = 407, .h = 50 },
                .{ .target_id = "P2026", .uri = "https://onplanners.com/", .x = 53, .y = 464, .w = 297, .h = 121 },
            } },
            .{ .style = "style_5mm_dots" },
        },
    });
    defer gpa.free(bytes);

    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();

    var page_links = (try note.links.forPage(gpa, doc, 0)).?;
    defer page_links.deinit();
    try std.testing.expectEqual(@as(usize, 2), page_links.items.len);

    try std.testing.expectEqual(@as(u32, 1), page_links.items[0].source_page);
    try std.testing.expectEqual(@as(u32, 1701), page_links.items[0].target_page);
    try std.testing.expectEqual(note.links.Kind.internal, page_links.items[0].kind);
    try std.testing.expectEqualStrings("none", page_links.items[0].uri);
    try std.testing.expectEqual(note.links.Kind.web, page_links.items[1].kind);
    try std.testing.expectEqualStrings("https://onplanners.com/", page_links.items[1].uri);
    try std.testing.expectEqual(@as(i32, 53), page_links.items[1].x);
}

test "a page with no EXTERNALLINKINFO reads as null — no block, no read" {
    // "No block" (address 0) must be distinguishable from an empty block.
    const gpa = std.testing.allocator;
    const bytes = try builder.serialize(gpa, .{ .pages = &.{ .{ .style = "style_5mm_dots" }, .{} } });
    defer gpa.free(bytes);

    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();
    try std.testing.expectEqual(@as(u32, 0), doc.pages[0].linksAddress());
    try std.testing.expect((try note.links.forPage(gpa, doc, 0)) == null);
    try std.testing.expect((try note.links.forPage(gpa, doc, 9)) == null);
}

test "GOLDEN: the .mark capture — same container, sparse footer, MARK layers" {
    // An N6 annotating a 77-page A4 document; pins `note-format.md` §13.
    const gpa = std.testing.allocator;
    var n = try note.parse(gpa, annotated_mark);
    defer n.deinit();

    try std.testing.expectEqualStrings("mark", n.signature.filetype);
    try std.testing.expectEqualStrings("SN_FILE_VER_20260016", n.signature.raw);
    try std.testing.expectEqualStrings("MARK", n.header.get("FILE_TYPE").?);
    try std.testing.expectEqualStrings("N6", n.applyEquipment().?);

    const dims = n.dimensions();
    try std.testing.expectEqual(@as(u32, 1404), dims.width);
    try std.testing.expectEqual(@as(u32, 1872), dims.height);

    try std.testing.expectEqual(@as(usize, 3), n.pages.len);
    try std.testing.expectEqual(@as(u32, 2), n.pages[0].number);
    try std.testing.expectEqual(@as(u32, 5), n.pages[1].number);
    try std.testing.expectEqual(@as(u32, 6), n.pages[2].number);

    for (n.pages, 0..) |p, i| {
        // `LAYERTYPE: MARK` is on the layer block, never the page's.
        try std.testing.expect(p.layers.len > 0);
        for (p.layers) |l| try std.testing.expectEqualStrings("MARK", l.layerType().?);
        const img = try note.renderPageGray(gpa, n, i);
        defer img.deinit(gpa);
        try std.testing.expectEqual(dims.width, @as(u32, @intCast(img.width)));
        var ink: usize = 0;
        for (img.pixels) |v| {
            if (v < 250) ink += 1;
        }
        try std.testing.expect(ink > 500);
        try std.testing.expect(ink < img.pixels.len / 100);
    }
}

test {
    _ = builder; // include the builder's own tests
    _ = prop; // and the harness's self-tests
}
