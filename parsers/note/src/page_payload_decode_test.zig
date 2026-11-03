//! Tests for decoding SNPG payloads.

const std = @import("std");
const types = @import("types.zig");
const page_payload = @import("page_payload.zig");
const FLAG_HIDDEN = page_payload.FLAG_HIDDEN;
const FLAG_RASTER_IMAGE = page_payload.FLAG_RASTER_IMAGE;
const MAGIC = page_payload.MAGIC;
const VERSION = page_payload.VERSION;
const VERSION_1 = page_payload.VERSION_1;
const appendU32 = fixture.appendU32;
const max_layers = page_payload.max_layers;
const testing = std.testing;
const page_payload_decode = @import("page_payload_decode.zig");
const decodeRgba = page_payload_decode.decodeRgba;
const decodeLayerRgba = page_payload_decode.decodeLayerRgba;
const backgroundImageHash = page_payload_decode.backgroundImageHash;
const RecordInfo = page_payload_decode.RecordInfo;
const enumerateRecords = page_payload_decode.enumerateRecords;
const fixture = @import("page_payload_decode_fixture.zig");
const buildOneLayer = fixture.buildOneLayer;

fn appendRecord(out: *std.ArrayList(u8), gpa: std.mem.Allocator, flags: u8, slot: types.LayerSlot, rle: []const u8) !void {
    try out.append(gpa, flags);
    try out.append(gpa, slot.wireId());
    try appendU32(out, gpa, @intCast(rle.len));
    try out.appendSlice(gpa, rle);
}

test "decodeRgba: single black pixel -> opaque black RGBA" {
    const gpa = testing.allocator;
    const payload = try buildOneLayer(gpa, 1, 1, 1, false, &.{ 0x61, 0x00 });
    defer gpa.free(payload);

    const img = try decodeRgba(gpa, payload);
    defer img.deinit(gpa);
    try testing.expectEqual(@as(u32, 1), img.width);
    try testing.expectEqual(@as(u32, 1), img.height);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels);
}

test "decodeRgba: transparent code composites to the white base" {
    const gpa = testing.allocator;
    const payload = try buildOneLayer(gpa, 1, 5, 1, false, &.{ 0x62, 0x04 });
    defer gpa.free(payload);

    const img = try decodeRgba(gpa, payload);
    defer img.deinit(gpa);
    try testing.expectEqual(@as(usize, 5 * 4), img.pixels.len);
    for (0..5) |i| {
        try testing.expectEqualSlices(u8, &.{ 0xff, 0xff, 0xff, 0xff }, img.pixels[i * 4 ..][0..4]);
    }
}

test "decodeRgba: two-byte length run fills the row" {
    const gpa = testing.allocator;
    const payload = try buildOneLayer(gpa, 1, 257, 1, false, &.{ 0x61, 0x81, 0x61, 0x00 });
    defer gpa.free(payload);

    const img = try decodeRgba(gpa, payload);
    defer img.deinit(gpa);
    try testing.expectEqual(@as(usize, 257 * 4), img.pixels.len);
    for (0..257) |i| {
        try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels[i * 4 ..][0..4]);
    }
}

fn beginPayload(gpa: std.mem.Allocator, layer_count: u32) !std.ArrayList(u8) {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION);
    try out.append(gpa, 1); // x2 variant
    try out.appendSlice(gpa, &.{ 0, 0 });
    try appendU32(&out, gpa, 2); // width
    try appendU32(&out, gpa, 1); // height
    try appendU32(&out, gpa, layer_count);
    return out;
}

test "decodeRgba: two layers composite bottom-to-top (top ink wins)" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0xC9, 0x01 });
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00, 0x62, 0x00 });

    const img = try decodeRgba(gpa, out.items);
    defer img.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels[0..4]);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff }, img.pixels[4..8]);
}

test "decodeRgba: a hidden-flagged record is skipped by the default composite" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0xC9, 0x01 });
    try appendRecord(&out, gpa, FLAG_HIDDEN, .layer2, &.{ 0x61, 0x00, 0x62, 0x00 });

    const img = try decodeRgba(gpa, out.items);
    defer img.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff }, img.pixels[0..4]);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff }, img.pixels[4..8]);

    const hidden = try decodeLayerRgba(gpa, out.items, 1);
    defer hidden.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, hidden.pixels[0..4]);
}

test "decodeRgba: a v1 payload (5-byte heads, no slot) still decodes" {
    const gpa = testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION_1);
    try out.append(gpa, 1); // x2 variant
    try out.appendSlice(gpa, &.{ 0, 0 });
    try appendU32(&out, gpa, 1);
    try appendU32(&out, gpa, 1);
    try appendU32(&out, gpa, 1);
    try out.append(gpa, 0x00); // v1 head: flags only, no slot byte
    try appendU32(&out, gpa, 2);
    try out.appendSlice(gpa, &.{ 0x61, 0x00 }); // 1 black px

    const img = try decodeRgba(gpa, out.items);
    defer img.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels);

    const one = try decodeLayerRgba(gpa, out.items, 0);
    defer one.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, one.pixels);

    out.items[4] = 3;
    try testing.expectError(error.BadPayload, decodeRgba(gpa, out.items));
}

test "decodeLayerRgba: one record, transparent 0xff maps to alpha 0" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0xC9, 0x01 }); // gray, gray
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00, 0x62, 0x00 }); // black, transparent

    const bg = try decodeLayerRgba(gpa, out.items, 0);
    defer bg.deinit(gpa);
    try testing.expectEqual(@as(u32, 2), bg.width);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff, 0xc9, 0xc9, 0xc9, 0xff }, bg.pixels);

    const main_l = try decodeLayerRgba(gpa, out.items, 1);
    defer main_l.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, main_l.pixels[0..4]);
    try testing.expectEqual(@as(u8, 0x00), main_l.pixels[7]); // alpha 0
    try testing.expectEqual(@as(u8, 0xff), main_l.pixels[4]); // rgb stays white under it

    try testing.expectError(error.LayerOutOfRange, decodeLayerRgba(gpa, out.items, 2));
}

test "backgroundImageHash: a bit2 background record yields its asset hash" {
    const gpa = testing.allocator;
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, FLAG_RASTER_IMAGE, .background, hash);
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00 });
    try testing.expectEqualStrings(hash, backgroundImageHash(out.items).?);
}

test "backgroundImageHash: null for an ordinary RLE page (no bit2 anywhere)" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0x65, 0x03 });
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00 });
    try testing.expect(backgroundImageHash(out.items) == null);
}

test "backgroundImageHash: a raster-image flag on a non-background slot is ignored" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 1);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, FLAG_RASTER_IMAGE, .main, "x");
    try testing.expect(backgroundImageHash(out.items) == null);
}

test "backgroundImageHash: short / foreign / truncated input returns null, never crashes" {
    const gpa = testing.allocator;
    try testing.expect(backgroundImageHash("SN") == null);
    try testing.expect(backgroundImageHash("XXXX\x02\x01\x00\x00") == null);
    var out = try beginPayload(gpa, 1);
    defer out.deinit(gpa);
    try out.append(gpa, FLAG_RASTER_IMAGE);
    try out.append(gpa, types.LayerSlot.background.wireId());
    try appendU32(&out, gpa, 64); // claims 64 bytes of hash; none follow
    try testing.expect(backgroundImageHash(out.items) == null);
}

test "enumerateRecords: v2 records yield slot + flag bits + hash, dims from header" {
    const gpa = testing.allocator;
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    var out = try beginPayload(gpa, 2); // 2x1 header
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, FLAG_RASTER_IMAGE, .background, hash);
    try appendRecord(&out, gpa, FLAG_HIDDEN, .main, &.{ 0x61, 0x03 });

    var buf: [max_layers]RecordInfo = undefined;
    const en = enumerateRecords(out.items, &buf).?;
    try testing.expectEqual(@as(u32, 2), en.width);
    try testing.expectEqual(@as(u32, 1), en.height);
    try testing.expectEqual(@as(usize, 2), en.records.len);

    try testing.expectEqual(types.LayerSlot.background, en.records[0].slot);
    try testing.expect(!en.records[0].excluded);
    try testing.expect(en.records[0].raster_image);
    try testing.expectEqualStrings(hash, en.records[0].data);

    try testing.expectEqual(types.LayerSlot.main, en.records[1].slot);
    try testing.expect(en.records[1].excluded);
    try testing.expect(!en.records[1].raster_image);
}

test "enumerateRecords: rejects everything the stacked panel cannot present" {
    const gpa = testing.allocator;
    var buf: [max_layers]RecordInfo = undefined;

    {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(gpa);
        try out.appendSlice(gpa, MAGIC);
        try out.append(gpa, VERSION_1);
        try out.append(gpa, 1);
        try out.appendSlice(gpa, &.{ 0, 0 });
        try appendU32(&out, gpa, 2);
        try appendU32(&out, gpa, 1);
        try appendU32(&out, gpa, 1);
        try out.append(gpa, 0x00); // v1 head: flags only
        try appendU32(&out, gpa, 2);
        try out.appendSlice(gpa, &.{ 0x61, 0x00 });
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    try testing.expect(enumerateRecords("XXXX\x02\x01\x00\x00", &buf) == null);
    try testing.expect(enumerateRecords(&.{ 0x53, 0x4e, 0x50, 0x47, 2 }, &buf) == null);

    {
        var out = try beginPayload(gpa, 1);
        defer out.deinit(gpa);
        try out.append(gpa, 0x00);
        try out.append(gpa, 5); // no such slot
        try appendU32(&out, gpa, 2);
        try out.appendSlice(gpa, &.{ 0x61, 0x00 });
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    {
        var out = try beginPayload(gpa, 1);
        defer out.deinit(gpa);
        try out.append(gpa, 0x00);
        try out.append(gpa, types.LayerSlot.main.wireId());
        try appendU32(&out, gpa, 999); // claims bytes the payload lacks
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    {
        var out = try beginPayload(gpa, 1);
        defer out.deinit(gpa);
        try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00 });
        try out.appendSlice(gpa, &.{ 0xde, 0xad }); // not our payload
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    {
        var zero = try beginPayload(gpa, 0);
        defer zero.deinit(gpa);
        try testing.expect(enumerateRecords(zero.items, &buf) == null);

        var over = try beginPayload(gpa, 6);
        defer over.deinit(gpa);
        try testing.expect(enumerateRecords(over.items, &buf) == null);
    }
}
