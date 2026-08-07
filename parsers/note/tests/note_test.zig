//! Container integration tests.
//!
//! Two kinds:
//!   * real-fixture structure tests against the committed Nomad capture
//!     (`fixtures/sample.note`, sig SN_FILE_VER_20260016) — regression guard
//!     against format drift and parser changes;
//!   * synthetic containers from `note_builder.zig` — the ownership contract
//!     and the build->serialize->parse property.

const std = @import("std");
const note = @import("note");
const builder = @import("note_builder.zig");
const prop = @import("prop.zig");

const sample = @embedFile("fixtures/sample.note");
const annotated_mark = @embedFile("fixtures/annotated.pdf.mark");
const horizontal = @embedFile("fixtures/horizontal_layers.note");
const one_thumb = @embedFile("fixtures/one_thumb.note");
const layers_edited = @embedFile("fixtures/layers_edited.note");

// ---------------------------------------------------------------------------
// Real fixture: eager parse
// ---------------------------------------------------------------------------

test "parse real Nomad sample.note (Chauvet 3.29.42)" {
    var doc = try note.parse(std.testing.allocator, sample);
    defer doc.deinit();

    // Signature: newest known version, X-series.
    try std.testing.expectEqual(note.Family.x_series, doc.signature.family);
    try std.testing.expectEqual(@as(u32, 20260016), doc.signature.version);
    try std.testing.expectEqualStrings("note", doc.signature.filetype);

    // Header: Nomad (N6) -> default 1404x1872.
    try std.testing.expectEqualStrings("N6", doc.applyEquipment().?);
    try std.testing.expectEqualStrings(
        "F20260718160909846383Na7MHLyOBbpq",
        doc.fileId().?,
    );
    const dims = doc.dimensions();
    try std.testing.expectEqual(@as(u32, 1404), dims.width);
    try std.testing.expectEqual(@as(u32, 1872), dims.height);

    // One page, with a main ink layer and a background (template) layer.
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

    // Layers 1..3 were deleted in this file -> not present.
    try std.testing.expect(page.layer(.layer1) == null);

    // Every layer bitmap address must resolve to a readable content block.
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

    // The base dims stay portrait — orientation is a per-page fact — and BOTH
    // pages are `1090`, so their effective dims swap to 1872×1404.
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

    // Page 1 is the bare landscape template; page 2 carries all four ink slots
    // plus the background — the layer spread this capture was made for.
    try std.testing.expectEqual(@as(usize, 2), doc.pages[0].layers.len);
    try std.testing.expectEqual(@as(usize, 5), doc.pages[1].layers.len);
    try std.testing.expect(doc.pages[1].layer(.layer2) != null);
}

// ---------------------------------------------------------------------------
// Real fixture: LAYERINFO (layers_edited.note — the mixed-encodings capture:
// the user hid Layer 2, renamed the top layer and reordered the stack on the
// device, which rewrote PAGE 2's LAYERINFO as base64 while PAGE 1 kept the
// legacy #-JSON — both encodings in ONE file)
// ---------------------------------------------------------------------------

test "layers_edited.note: both LAYERINFO encodings parse from the same file" {
    var doc = try note.parse(std.testing.allocator, layers_edited);
    defer doc.deinit();

    try std.testing.expectEqual(@as(usize, 2), doc.pageCount());

    // PAGE 1 — untouched panel, legacy #-JSON. Full stack, top-to-bottom:
    // the never-created Layers 3/2/1 read isDeleted:true, Main is current,
    // and the background entry carries the -1 id.
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

    // PAGE 2 — edited on-device, rewritten as base64 of plain JSON. The stack
    // was reordered to 3,1,2,0,-1 (top-to-bottom); the top layer was RENAMED
    // ("Layer Renamed" lives ONLY here — its layer block's LAYERNAME stays the
    // slot constant LAYER3); Layer 2 is HIDDEN (isVisible:false, NOT deleted)
    // and its bitmap block persists in the file.
    {
        const page = doc.pages[1];
        const info = page.layer_info.?;
        try std.testing.expectEqual(@as(usize, 5), info.len);

        const want_ids = [_]i32{ 3, 1, 2, 0, -1 };
        for (info, want_ids) |e, id| try std.testing.expectEqual(id, e.layer_id);

        try std.testing.expectEqualStrings("Layer Renamed", info[0].name);
        try std.testing.expect(info[0].is_current);
        // The layer block's LAYERNAME is the slot constant — never the display name.
        try std.testing.expectEqualStrings("LAYER3", page.layer(.layer3).?.name().?);

        try std.testing.expectEqual(@as(i32, 2), info[2].layer_id);
        try std.testing.expect(!info[2].is_visible);
        try std.testing.expect(!info[2].is_deleted);
        // Hidden ≠ deleted: LAYER2's bitmap block persists...
        try std.testing.expect(page.layer(.layer2).?.bitmapAddress() != 0);
        // ...while LAYERSEQ (the authoritative DRAW list) omits it.
        try std.testing.expectEqualStrings("LAYER3,LAYER1,MAINLAYER,BGLAYER", page.block.get("LAYERSEQ").?);

        try std.testing.expect(info[4].is_background);
        try std.testing.expectEqual(@as(i32, -1), info[4].layer_id);

        // infoForSlot resolves the -1 background id like any other.
        try std.testing.expectEqualStrings("Background Layer", page.infoForSlot(.background).?.name);
        try std.testing.expectEqualStrings("Layer 2", page.infoForSlot(.layer2).?.name);
    }
}

test "horizontal_layers.note: page 1 #-JSON records never-created layers as deleted; page 2 is base64 with LAYER2 hidden" {
    // NOTE: this fixture's CURRENT page 2 carries the base64 encoding with
    // `Layer 2` HIDDEN (isVisible:false, isDeleted:false) — the same notebook
    // state `layers_edited.note` captures. The `#`-JSON-with-deleted-LAYER2
    // reading previously attributed to page 2 (note-format.md's old LAYERSEQ
    // row) came from a STALE page-block generation the append-only container
    // still holds; only the footer-referenced blocks are the file's state.
    var doc = try note.parse(std.testing.allocator, horizontal);
    defer doc.deinit();

    // Page 1 (#-JSON): the never-created Layers 3/2/1 read isDeleted:true —
    // "deleted" covers "never present" (their slot keys are absent entirely).
    const p1 = doc.pages[0].layer_info.?;
    try std.testing.expectEqual(@as(usize, 5), p1.len);
    for (p1[0..3]) |e| try std.testing.expect(e.is_deleted);
    try std.testing.expect(doc.pages[0].layer(.layer2) == null);

    // Page 2 (base64): LAYER2 hidden, not deleted; bitmap persists; LAYERSEQ
    // (the draw list) omits it.
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

// ---------------------------------------------------------------------------
// Real fixture: the cover image (one_thumb.note — user tapped "set as cover")
// ---------------------------------------------------------------------------

test "one_thumb.note: COVER_2 resolves to a complete device-resolution PNG" {
    const gpa = std.testing.allocator;

    var doc = try note.parse(gpa, one_thumb);
    defer doc.deinit();
    try std.testing.expectEqual(@as(usize, 2), doc.pageCount());

    // The capture's footer carries `<COVER_2:429>`.
    const addr = doc.coverAddress().?;
    try std.testing.expectEqual(@as(u64, 429), addr);

    // The content block is a complete pre-rendered PNG at full device
    // resolution — signature + IHDR dims read straight from the bytes (the
    // parser ships no image decoder; this is the imageDims-equivalent check).
    // The cover BYTES are one plain block read at the address — the same
    // `src.blockAlloc` an indexer runs after `coverAddress()`.
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

    // horizontal_layers.note carries the `<COVER_0:0>` placeholder the device
    // writes while no cover is chosen; sample.note (older) has no COVER key.
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

    // Both present → COVER_2 wins (the reference's preference order).
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

    // COVER_1 only (no such capture in our corpus — the fallback is pinned
    // synthetically until one surfaces).
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

    // A zeroed COVER_2 is "no cover", not address 0 — and does NOT fall through
    // to hide a real COVER_1 (0 means the slot is empty, per the COVER_0=0
    // placeholder semantics; a zeroed key beside a real one has never been
    // observed, so absence-of-harm is the property pinned here).
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

    // All three present → COVER_3 wins (newest user-set key).
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

    // COVER_3 present alongside COVER_2 → still COVER_3 (this is the real
    // incident: a `user_cover.note` whose footer carries `<COVER_3:addr>`).
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

    // A zeroed COVER_3 is "no cover" (the COVER_0=0 placeholder semantics),
    // exactly like a zeroed COVER_2 — and, with no other cover key, is null.
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

// ---------------------------------------------------------------------------
// Orientation (synthetic mixed-orientation note)
// ---------------------------------------------------------------------------

test "ORIENTATION is per-page: typed orientation and effective dims" {
    const gpa = std.testing.allocator;

    // Portrait page, landscape page, and a page with the key absent entirely.
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

    // Eager path: `Note.pages` carry the typed orientation...
    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();
    const base = doc.dimensions();
    for (doc.pages, want) |page, o| try std.testing.expectEqual(o, page.orientation());

    // ...and the effective dims swap exactly for the landscape page.
    try std.testing.expectEqual(base, base.oriented(doc.pages[0].orientation()));
    try std.testing.expectEqual(
        note.types.Dimensions{ .width = 1872, .height = 1404 },
        base.oriented(doc.pages[1].orientation()),
    );
    try std.testing.expectEqual(base, base.oriented(doc.pages[2].orientation()));

    // The absent key stays observable as absent through the raw accessor.
    try std.testing.expectEqual(@as(?[]const u8, null), doc.pages[2].orientationRaw());
}

// ---------------------------------------------------------------------------
// Ownership contract
// ---------------------------------------------------------------------------

test "a parsed Note owns its strings — the input buffer may be freed" {
    const gpa = std.testing.allocator;

    const bytes = try builder.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N5" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{} }},
    });
    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();

    // Scribble over, then free, the buffer the Note was parsed from. Everything
    // the Note exposes must survive: it was copied into the arena.
    @memset(bytes, 0xAA);
    gpa.free(bytes);

    try std.testing.expectEqualStrings("N5", doc.applyEquipment().?);
    try std.testing.expectEqualStrings("style_white", doc.pages[0].style().?);
    try std.testing.expectEqual(@as(u32, 1920), doc.dimensions().width);
}

// ---------------------------------------------------------------------------
// Property test: build -> serialize -> parse round-trips
// ---------------------------------------------------------------------------

/// A generated case: the spec plus its serialized bytes (both arena-owned).
const Case = struct {
    spec: builder.Spec,
    bytes: []const u8,
};

const slots = [_]note.types.LayerSlot{ .main, .layer1, .layer2, .layer3, .background };

fn genCase(r: std.Random, a: std.mem.Allocator) anyerror!Case {
    const page_count = r.intRangeAtMost(usize, 1, 4);
    const pages = try a.alloc(builder.PageSpec, page_count);
    for (pages) |*page| {
        // Pick a random, ordered subset of layer slots.
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
            // Byte-exact bitmap round-trip via the recorded address.
            const r = try src.blockRange(got.bitmapAddress());
            const content = src.view(r.offset, r.len).?;
            try std.testing.expectEqualSlices(u8, want_layer.bitmap, content);
        }
    }

    for (c.spec.header) |kv| {
        try std.testing.expectEqualStrings(kv.value, doc.header.get(kv.key).?);
    }
}

/// Random alphanumeric string of length in [min,max] (no `<`, `:`, `>`).
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

// --- the footer's PAGE<n> key carries a NUMBER, not just an address ----------

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
    // What a `.mark` looks like: only the annotated pages, named by the PDF page
    // they belong to (`note-format.md` §13.2). The parser used to keep the
    // footer's ADDRESS and drop the number, so this file read back as pages
    // 1, 2, 3 — and a mark composited onto its PDF would have put page 2's
    // handwriting on page 1.
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

    // The pages are still the pages: the number rides ALONGSIDE the address, and
    // a test that only checked numbers would pass if they had stopped resolving.
    for (n.pages) |p| try std.testing.expect(p.block.entries.len > 0);
}

test "a PAGE key with no readable number is Corrupt, not silently renumbered" {
    // Same posture as an unreadable VALUE. A page we cannot place is not a page
    // to quietly hand a position to — that is how a mark lands on the wrong page
    // of someone's document.
    const gpa = std.testing.allocator;
    const bytes = try builder.serialize(gpa, .{ .pages = &.{.{}} });
    defer gpa.free(bytes);
    const bad = try gpa.dupe(u8, bytes);
    defer gpa.free(bad);
    // `PAGE1` -> `PAGEx` in the footer, leaving every length and offset intact.
    const at = std.mem.lastIndexOf(u8, bad, "<PAGE1:").?;
    bad[at + "<PAGE".len] = 'x';
    try std.testing.expectError(error.Corrupt, note.parse(gpa, bad));
}

// --- EXTERNALLINKINFO: a PDF template's links, through the container ---------

test "a page's links come off its own EXTERNALLINKINFO address" {
    const gpa = std.testing.allocator;
    // A PDF-template page (the shape §14 describes: `PAGESTYLE` names the
    // imported document) carrying one internal jump and one web link, and an
    // ordinary page beside it carrying no block at all.
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

    // Field 1 is the page the links are ON — the builder writes the page's own
    // footer number, which is what every record of the real capture carries.
    try std.testing.expectEqual(@as(u32, 1), page_links.items[0].source_page);
    try std.testing.expectEqual(@as(u32, 1701), page_links.items[0].target_page);
    try std.testing.expectEqual(note.links.Kind.internal, page_links.items[0].kind);
    try std.testing.expectEqualStrings("none", page_links.items[0].uri);
    try std.testing.expectEqual(note.links.Kind.web, page_links.items[1].kind);
    try std.testing.expectEqualStrings("https://onplanners.com/", page_links.items[1].uri);
    try std.testing.expectEqual(@as(i32, 53), page_links.items[1].x);
}

test "a page with no EXTERNALLINKINFO reads as null — no block, no read" {
    // Address 0 is the state of every page of every ordinary `.note`. A caller
    // has to be able to tell "no link block" from "an empty link block",
    // because only the first costs nothing to answer.
    const gpa = std.testing.allocator;
    const bytes = try builder.serialize(gpa, .{ .pages = &.{ .{ .style = "style_5mm_dots" }, .{} } });
    defer gpa.free(bytes);

    var doc = try note.parse(gpa, bytes);
    defer doc.deinit();
    try std.testing.expectEqual(@as(u32, 0), doc.pages[0].linksAddress());
    try std.testing.expect((try note.links.forPage(gpa, doc, 0)) == null);
    // And a page index past the end is null too, never an out-of-range read.
    try std.testing.expect((try note.links.forPage(gpa, doc, 9)) == null);
}

// --- the REAL capture -------------------------------------------------------

test "GOLDEN: the .mark capture — same container, sparse footer, MARK layers" {
    // The one real `.mark` we hold: an N6 annotating a 77-page A4 document,
    // written 2026-08-04. Everything `note-format.md` §13 claims about the
    // format is asserted here against the file itself, so the spec and the
    // parser cannot drift from the capture that established both.
    const gpa = std.testing.allocator;
    var n = try note.parse(gpa, annotated_mark);
    defer n.deinit();

    // It IS this container — it parses with no special casing at all.
    try std.testing.expectEqualStrings("mark", n.signature.filetype);
    try std.testing.expectEqualStrings("SN_FILE_VER_20260016", n.signature.raw);
    try std.testing.expectEqualStrings("MARK", n.header.get("FILE_TYPE").?);
    try std.testing.expectEqualStrings("N6", n.applyEquipment().?);

    // Panel dimensions come from the equipment code, not the container: this is
    // what makes the page→panel mapping something to reconstruct (§13.3).
    const dims = n.dimensions();
    try std.testing.expectEqual(@as(u32, 1404), dims.width);
    try std.testing.expectEqual(@as(u32, 1872), dims.height);

    // SPARSE, and named: three pages, belonging to PDF pages 2, 5 and 6.
    try std.testing.expectEqual(@as(usize, 3), n.pages.len);
    try std.testing.expectEqual(@as(u32, 2), n.pages[0].number);
    try std.testing.expectEqual(@as(u32, 5), n.pages[1].number);
    try std.testing.expectEqual(@as(u32, 6), n.pages[2].number);

    // Its layers say what they are, and they render.
    for (n.pages, 0..) |p, i| {
        // `LAYERTYPE` lives on the LAYER block, not the page's — the layers are
        // what is typed `MARK`, and the page block never carries the key.
        try std.testing.expect(p.layers.len > 0);
        for (p.layers) |l| try std.testing.expectEqualStrings("MARK", l.layerType().?);
        const img = try note.renderPageGray(gpa, n, i);
        defer img.deinit(gpa);
        try std.testing.expectEqual(dims.width, @as(u32, @intCast(img.width)));
        var ink: usize = 0;
        for (img.pixels) |v| {
            if (v < 250) ink += 1;
        }
        // Real handwriting, not an empty page — and bounded, because these are
        // annotations in a margin rather than a filled sheet.
        try std.testing.expect(ink > 500);
        try std.testing.expect(ink < img.pixels.len / 100);
    }
}

test {
    _ = builder; // include the builder's own tests
    _ = prop; // and the harness's self-tests
}
