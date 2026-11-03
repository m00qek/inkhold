//! Content-tier integration tests against real fixtures: decode/composite
//! hashes from the reference decoder (supernote-tool), SNPG round trips, and
//! OCR extraction from `sample-2.note`.

const std = @import("std");
const note = @import("note");
const builder = @import("note_builder.zig");

const sample = @embedFile("fixtures/sample.note");
const sample2 = @embedFile("fixtures/sample-2.note");
const horizontal = @embedFile("fixtures/horizontal_layers.note");
const layers_edited = @embedFile("fixtures/layers_edited.note");

// SHA-256 of supernote-tool's decode/composite output for sample.note.
const MAINLAYER_SHA = "7de5f038683c07811ab2ab4854623de35b0e7cf02789a91ebd67a35b3d00498d";
const BGLAYER_SHA = "83da25ef64214ce8e0dc443d2974e985f0d578545deab12223a4ab1a4bb6e17d";
const COMPOSITE_SHA = "5e26ead2829b4cfb2bf460443747e012a08e520733adde6db684d14194d1839d";

fn sha256Hex(bytes: []const u8) [64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    var hex: [64]u8 = undefined;
    _ = std.fmt.bufPrint(&hex, "{x}", .{&digest}) catch unreachable;
    return hex;
}

fn expectSha(expected: []const u8, bytes: []const u8) !void {
    try std.testing.expectEqualStrings(expected, &sha256Hex(bytes));
}

fn decodeLayer(gpa: std.mem.Allocator, doc: note.Note, slot: note.types.LayerSlot) ![]u8 {
    const layer = doc.pages[0].layer(slot).?;
    const src = note.Source.fromSlice(sample);
    const r = try src.blockRange(layer.bitmapAddress());
    const data = src.view(r.offset, r.len).?;
    const dims = doc.dimensions();
    return note.decoder.decode(gpa, .ratta_rle_x2, data, dims.width, dims.height, false);
}

test "RATTA_RLE X2 decode of MAINLAYER matches reference" {
    const gpa = std.testing.allocator;
    var doc = try note.parse(gpa, sample);
    defer doc.deinit();

    const decoded = try decodeLayer(gpa, doc, .main);
    defer gpa.free(decoded);

    try std.testing.expectEqual(@as(usize, 1404 * 1872), decoded.len);
    try expectSha(MAINLAYER_SHA, decoded);
}

test "RATTA_RLE X2 decode of BGLAYER (template) matches reference" {
    const gpa = std.testing.allocator;
    var doc = try note.parse(gpa, sample);
    defer doc.deinit();

    const decoded = try decodeLayer(gpa, doc, .background);
    defer gpa.free(decoded);

    try expectSha(BGLAYER_SHA, decoded);
}

test "composited page matches reference render byte-for-byte" {
    const gpa = std.testing.allocator;
    var doc = try note.parse(gpa, sample);
    defer doc.deinit();

    const img = try note.renderPageGray(gpa, doc, 0);
    defer img.deinit(gpa);

    try std.testing.expectEqual(@as(u32, 1404), img.width);
    try std.testing.expectEqual(@as(u32, 1872), img.height);
    try expectSha(COMPOSITE_SHA, img.pixels);
}

// ---- SNPG page payload ----

test "serialize -> decodeRgba reproduces renderPageGray on the real Nomad fixture" {
    const gpa = std.testing.allocator;

    var doc = try note.parse(gpa, sample);
    defer doc.deinit();

    const gray = try note.renderPageGray(gpa, doc, 0);
    defer gray.deinit(gpa);
    try std.testing.expectEqual(@as(u32, 1404), gray.width);
    try std.testing.expectEqual(@as(u32, 1872), gray.height);

    const payload = try note.page_payload.serialize(gpa, doc, 0);
    defer gpa.free(payload);

    const rgba = try note.page_payload.decodeRgba(gpa, payload);
    defer rgba.deinit(gpa);

    try std.testing.expectEqual(gray.width, rgba.width);
    try std.testing.expectEqual(gray.height, rgba.height);
    try std.testing.expectEqual(gray.pixels.len * 4, rgba.pixels.len);

    for (gray.pixels, 0..) |g, i| {
        try std.testing.expectEqual(g, rgba.pixels[i * 4 + 0]);
        try std.testing.expectEqual(g, rgba.pixels[i * 4 + 1]);
        try std.testing.expectEqual(g, rgba.pixels[i * 4 + 2]);
        try std.testing.expectEqual(@as(u8, 0xff), rgba.pixels[i * 4 + 3]);
    }
}

test "payload is self-describing: header fields match the fixture" {
    const gpa = std.testing.allocator;

    var doc = try note.parse(gpa, sample);
    defer doc.deinit();

    const payload = try note.page_payload.serialize(gpa, doc, 0);
    defer gpa.free(payload);

    try std.testing.expect(std.mem.startsWith(u8, payload, note.page_payload.MAGIC));
    try std.testing.expectEqual(note.page_payload.VERSION, payload[4]);
    try std.testing.expectEqual(@as(u8, 1), payload[5]); // highres Nomad -> X2 variant
    try std.testing.expectEqual(@as(u32, 1404), std.mem.readInt(u32, payload[8..12], .little));
    try std.testing.expectEqual(@as(u32, 1872), std.mem.readInt(u32, payload[12..16], .little));
    try std.testing.expectEqual(@as(u32, 2), std.mem.readInt(u32, payload[16..20], .little));
}

test "serialize emits a well-formed header + one record per present layer (synthetic)" {
    const gpa = std.testing.allocator;
    const pp = note.page_payload;

    const main_rle = [_]u8{ 0x61, 0x00 };
    const bg_rle = [_]u8{ 0x62, 0x00 };
    const bytes = try builder.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .layers = &.{
            .{ .slot = .main, .bitmap = &main_rle },
            .{ .slot = .background, .bitmap = &bg_rle },
        } }},
    });
    defer gpa.free(bytes);

    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();

    const payload = try pp.serialize(gpa, doc, 0);
    defer gpa.free(payload);

    try std.testing.expect(std.mem.startsWith(u8, payload, pp.MAGIC));
    try std.testing.expectEqual(pp.VERSION, payload[4]);
    try std.testing.expectEqual(@as(u8, 1), payload[5]); // N6 -> highres -> X2 variant
    try std.testing.expectEqual(@as(u32, 1404), std.mem.readInt(u32, payload[8..12], .little));
    try std.testing.expectEqual(@as(u32, 1872), std.mem.readInt(u32, payload[12..16], .little));
    try std.testing.expectEqual(@as(u32, 2), std.mem.readInt(u32, payload[16..20], .little));

    try std.testing.expectEqual(note.types.LayerSlot.background.wireId(), payload[pp.HEADER_SIZE + 1]);
    const rec0_len = std.mem.readInt(u32, payload[pp.HEADER_SIZE + 2 ..][0..4], .little);
    try std.testing.expectEqual(@as(u32, bg_rle.len), rec0_len);
    try std.testing.expectEqual(
        @as(usize, pp.HEADER_SIZE + 2 * pp.LAYER_HEADER_SIZE + main_rle.len + bg_rle.len),
        payload.len,
    );
}

// ---- orientation: landscape pages are stored natively landscape ----

/// A full-page RLE stream of `npix` pixels alternating black and a literal
/// gray, so decoded bytes are position-dependent.
fn fullPageRle(gpa: std.mem.Allocator, npix: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    var left = npix;
    var flip = false;
    while (left > 0) {
        const code: u8 = if (flip) 0x3f else 0x61; // gray literal / black
        flip = !flip;
        if (left >= 0x4000) {
            try out.appendSlice(gpa, &.{ code, 0xFF }); // special marker: 0x4000 run
            left -= 0x4000;
        } else {
            const take = @min(left, 128); // single-byte length: run of len+1 <= 128
            try out.appendSlice(gpa, &.{ code, @intCast(take - 1) });
            left -= take;
        }
    }
    return out.toOwnedSlice(gpa);
}

// Hashes of this codebase's landscape renders of `horizontal_layers.note`,
// settled after visual inspection (no shear: the row width is swapped).
const H_PAGE1_SHA = "5733213a3401925e030aab8df038756299e21e773dba4383903d14b27ea3a0a9";
const H_PAGE2_SHA = "6179883577636a458dc4f0919af28779c78cc154b3717a1b4d652ff86a0031fc";

test "GOLDEN: real landscape capture decodes natively landscape (1872-wide rows)" {
    const gpa = std.testing.allocator;
    var doc = try note.parse(gpa, horizontal);
    defer doc.deinit();

    // Page 2's `LAYERSEQ` omits the hidden LAYER2, so the composite has Main/1/3
    // only; SNPG ships it flagged hidden.
    const img = try note.renderPageGray(gpa, doc, 1);
    defer img.deinit(gpa);
    try std.testing.expectEqual(@as(u32, 1872), img.width);
    try std.testing.expectEqual(@as(u32, 1404), img.height);
    try expectSha(H_PAGE2_SHA, img.pixels);

    const img0 = try note.renderPageGray(gpa, doc, 0);
    defer img0.deinit(gpa);
    try std.testing.expectEqual(@as(u32, 1872), img0.width);
    try std.testing.expectEqual(@as(u32, 1404), img0.height);
    try expectSha(H_PAGE1_SHA, img0.pixels);

    const payload = try note.page_payload.serialize(gpa, doc, 1);
    defer gpa.free(payload);
    try std.testing.expectEqual(@as(u32, 1872), std.mem.readInt(u32, payload[8..12], .little));
    try std.testing.expectEqual(@as(u32, 1404), std.mem.readInt(u32, payload[12..16], .little));

    const rgba = try note.page_payload.decodeRgba(gpa, payload);
    defer rgba.deinit(gpa);
    try std.testing.expectEqual(@as(u32, 1872), rgba.width);
    try std.testing.expectEqual(@as(u32, 1404), rgba.height);
    for (img.pixels, 0..) |g, i| try std.testing.expectEqual(g, rgba.pixels[i * 4]);
}

test "a landscape (1090) page renders and serializes at its effective dims" {
    const gpa = std.testing.allocator;

    // The same flat stream on a portrait and a landscape page: reshaped, never
    // rotated or transposed.
    const base = note.types.Dimensions.default; // N6: 1404×1872
    const npix = @as(usize, base.width) * @as(usize, base.height);
    const rle = try fullPageRle(gpa, npix);
    defer gpa.free(rle);

    const bytes = try builder.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{
            .{ .style = "style_white", .orientation = "1000", .layers = &.{.{ .slot = .main, .bitmap = rle }} },
            .{ .style = "style_white", .orientation = "1090", .layers = &.{.{ .slot = .main, .bitmap = rle }} },
        },
    });
    defer gpa.free(bytes);

    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();

    const p0 = try note.renderPageGray(gpa, doc, 0);
    defer p0.deinit(gpa);
    const p1 = try note.renderPageGray(gpa, doc, 1);
    defer p1.deinit(gpa);
    try std.testing.expectEqual(@as(u32, 1404), p0.width);
    try std.testing.expectEqual(@as(u32, 1872), p0.height);
    try std.testing.expectEqual(@as(u32, 1872), p1.width);
    try std.testing.expectEqual(@as(u32, 1404), p1.height);
    try std.testing.expectEqualSlices(u8, p0.pixels, p1.pixels);

    const pay0 = try note.page_payload.serialize(gpa, doc, 0);
    defer gpa.free(pay0);
    const pay1 = try note.page_payload.serialize(gpa, doc, 1);
    defer gpa.free(pay1);
    try std.testing.expectEqual(@as(u32, 1404), std.mem.readInt(u32, pay0[8..12], .little));
    try std.testing.expectEqual(@as(u32, 1872), std.mem.readInt(u32, pay0[12..16], .little));
    try std.testing.expectEqual(@as(u32, 1872), std.mem.readInt(u32, pay1[8..12], .little));
    try std.testing.expectEqual(@as(u32, 1404), std.mem.readInt(u32, pay1[12..16], .little));

    const rgba = try note.page_payload.decodeRgba(gpa, pay1);
    defer rgba.deinit(gpa);
    try std.testing.expectEqual(p1.width, rgba.width);
    try std.testing.expectEqual(p1.height, rgba.height);
    for (p1.pixels, 0..) |g, i| try std.testing.expectEqual(g, rgba.pixels[i * 4]);
}

// ---- hidden layers on the wire (layers_edited.note) ----

// Page 1 matches `horizontal_layers.note` page 1 (same lineage); page 2 is the
// composite without hidden Layer 2.
const LE_PAGE1_SHA = "5733213a3401925e030aab8df038756299e21e773dba4383903d14b27ea3a0a9";
const LE_PAGE2_SHA = "0a6c5cf68211ef561281b879ecff6643fa42bcc3fc89e69c240ba51e50986555";

test "GOLDEN: layers_edited page 2 — the hidden layer rides the wire but stays out of the default composite" {
    const gpa = std.testing.allocator;
    const pp = note.page_payload;

    var doc = try note.parse(gpa, layers_edited);
    defer doc.deinit();

    const img = try note.renderPageGray(gpa, doc, 1);
    defer img.deinit(gpa);
    try expectSha(LE_PAGE2_SHA, img.pixels);

    // Five records where LAYERSEQ draws four: LAYER2 ships flagged hidden.
    const payload = try pp.serialize(gpa, doc, 1);
    defer gpa.free(payload);
    try std.testing.expectEqual(pp.VERSION, payload[4]);
    try std.testing.expectEqual(@as(u32, 5), std.mem.readInt(u32, payload[16..20], .little));

    const want = [_]struct { slot: note.types.LayerSlot, hidden: bool }{
        .{ .slot = .background, .hidden = false },
        .{ .slot = .main, .hidden = false },
        .{ .slot = .layer2, .hidden = true },
        .{ .slot = .layer1, .hidden = false },
        .{ .slot = .layer3, .hidden = false },
    };
    var at: usize = pp.HEADER_SIZE;
    for (want) |w| {
        const flags = payload[at];
        const slot = note.types.LayerSlot.fromWireId(payload[at + 1]).?;
        const len = std.mem.readInt(u32, payload[at + 2 ..][0..4], .little);
        try std.testing.expectEqual(w.slot, slot);
        try std.testing.expectEqual(w.hidden, flags & pp.FLAG_HIDDEN != 0);
        at += pp.LAYER_HEADER_SIZE + len;
    }
    try std.testing.expectEqual(payload.len, at);

    const rgba = try pp.decodeRgba(gpa, payload);
    defer rgba.deinit(gpa);
    for (img.pixels, 0..) |g, i| try std.testing.expectEqual(g, rgba.pixels[i * 4]);

    // The hidden layer decodes with real ink and alpha-0 transparency.
    const l2 = try pp.decodeLayerRgba(gpa, payload, 2);
    defer l2.deinit(gpa);
    try std.testing.expectEqual(@as(u32, 1872), l2.width);
    var opaque_px: usize = 0;
    for (0..@as(usize, l2.width) * l2.height) |i| {
        if (l2.pixels[i * 4 + 3] == 0xff) opaque_px += 1;
    }
    try std.testing.expect(opaque_px > 0); // ink exists
    try std.testing.expect(opaque_px < @as(usize, l2.width) * l2.height); // and transparency exists

    const img0 = try note.renderPageGray(gpa, doc, 0);
    defer img0.deinit(gpa);
    try expectSha(LE_PAGE1_SHA, img0.pixels);
    const pay0 = try pp.serialize(gpa, doc, 0);
    defer gpa.free(pay0);
    try std.testing.expectEqual(@as(u32, 2), std.mem.readInt(u32, pay0[16..20], .little));
    const rgba0 = try pp.decodeRgba(gpa, pay0);
    defer rgba0.deinit(gpa);
    for (img0.pixels, 0..) |g, i| try std.testing.expectEqual(g, rgba0.pixels[i * 4]);
}

test "decodeLayerRgba on the real fixture agrees with the native single-layer decode" {
    const gpa = std.testing.allocator;
    const pp = note.page_payload;

    var doc = try note.parse(gpa, layers_edited);
    defer doc.deinit();
    const payload = try pp.serialize(gpa, doc, 1);
    defer gpa.free(payload);

    const layer = doc.pages[1].layer(.layer2).?;
    const src = note.Source.fromSlice(layers_edited);
    const r = try src.blockRange(layer.bitmapAddress());
    const data = src.view(r.offset, r.len).?;
    const dims = doc.dimensions().oriented(doc.pages[1].orientation());
    const gray = try note.decoder.decode(gpa, doc.rleVariant(), data, dims.width, dims.height, false);
    defer gpa.free(gray);

    const rgba = try pp.decodeLayerRgba(gpa, payload, 2);
    defer rgba.deinit(gpa);
    try std.testing.expectEqual(dims.width, rgba.width);
    for (gray, 0..) |g, i| {
        try std.testing.expectEqual(g, rgba.pixels[i * 4]);
        const want_alpha: u8 = if (g == 0xff) 0x00 else 0xff;
        try std.testing.expectEqual(want_alpha, rgba.pixels[i * 4 + 3]);
    }
}

// ---- recognition (real capture) ----

test "extract recognized text + boxes from a finished page" {
    const gpa = std.testing.allocator;
    var doc = try note.parse(gpa, sample2);
    defer doc.deinit();

    try std.testing.expectEqual(@as(usize, 2), doc.pageCount());

    try std.testing.expectEqual(@as(u8, 1), doc.pages[0].recognitionStatus());
    var rec = (try note.recognition.forPage(gpa, doc, 0)) orelse return error.NoRecognition;
    defer rec.deinit();

    var labels: std.ArrayList([]const u8) = .empty;
    defer labels.deinit(gpa);
    for (rec.elements()) |el| {
        if (el.isText()) try labels.append(gpa, el.label.?);
    }
    try std.testing.expectEqual(@as(usize, 3), labels.items.len);
    try std.testing.expectEqualStrings("Test", labels.items[0]);
    try std.testing.expectEqualStrings("Test", labels.items[1]);
    try std.testing.expectEqualStrings("Middle", labels.items[2]);

    const text = try rec.plainText(gpa);
    defer gpa.free(text);
    try std.testing.expectEqualStrings("Test\nMiddle\nTest", text); // v7: device layout honored — regions y-sorted (emitted out of order: Test@y11.8, Test@y136.9, Middle@y72) and newline-joined

    const first_word = rec.elements()[0].words.?[0];
    try std.testing.expect(first_word.@"bounding-box".?.width > 0);

    // The device's mm values, unscaled and in reading order.
    const placed = try rec.placedWords(gpa);
    defer gpa.free(placed);
    try std.testing.expectEqual(@as(usize, 3), placed.len);
    try std.testing.expectEqualStrings("Test", placed[0].label);
    try std.testing.expectApproxEqAbs(@as(f32, 3.3095), placed[0].box.x, 1e-3);
    try std.testing.expectApproxEqAbs(@as(f32, 11.7595), placed[0].box.y, 1e-3);
    try std.testing.expectApproxEqAbs(@as(f32, 30.3075), placed[0].box.width, 1e-3);
    try std.testing.expectApproxEqAbs(@as(f32, 16.534), placed[0].box.height, 1e-3);
    try std.testing.expectEqualStrings("Middle", placed[2].label);

    // Millimetres, not pixels: read as pixels they would hug the top-left
    // 112x149 corner.
    const scale = note.types.CanvasMm.forEquipment(doc.applyEquipment()).?.pxPerMm(doc.dimensions().width);
    const w: f32 = @floatFromInt(doc.dimensions().width);
    const h: f32 = @floatFromInt(doc.dimensions().height);
    for (placed) |p| {
        try std.testing.expect((p.box.x + p.box.width) * scale <= w);
        try std.testing.expect((p.box.y + p.box.height) * scale <= h);
    }
    try std.testing.expect((placed[1].box.y + placed[1].box.height) * scale > h * 0.5);
}

test "a page still recognising yields no text" {
    const gpa = std.testing.allocator;
    var doc = try note.parse(gpa, sample2);
    defer doc.deinit();

    try std.testing.expectEqual(@as(u8, 2), doc.pages[1].recognitionStatus()); // running
    try std.testing.expect((try note.recognition.forPage(gpa, doc, 1)) == null);
}

test "recognition.forParsedPage (the bare-page entry) agrees with the Note path" {
    const gpa = std.testing.allocator;

    var doc = try note.parse(gpa, sample2);
    defer doc.deinit();

    var rec = (try note.recognition.forParsedPage(gpa, doc.source, doc.pages[0])) orelse
        return error.NoRecognition;
    defer rec.deinit();

    const text = try rec.plainText(gpa);
    defer gpa.free(text);
    try std.testing.expectEqualStrings("Test\nMiddle\nTest", text); // v7: device layout honored — regions y-sorted (emitted out of order: Test@y11.8, Test@y136.9, Middle@y72) and newline-joined
}
