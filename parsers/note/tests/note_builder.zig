//! Builds synthetic, well-formed `.note` byte buffers in memory.
//!
//! This is test infrastructure: it lets tests construct arbitrary containers
//! (used by the round-trip property test and the tier-laziness proofs) without
//! needing real device files, and it exercises the exact block/address layout
//! the parser consumes.

const std = @import("std");
const note = @import("note");

const types = note.types;
const recognition = note.recognition;

pub const Kv = struct { key: []const u8, value: []const u8 };

pub const LayerSpec = struct {
    slot: types.LayerSlot,
    name: []const u8 = "MAINLAYER",
    protocol: []const u8 = "RATTA_RLE",
    bitmap: []const u8,
};

pub const PageSpec = struct {
    style: []const u8 = "",
    /// `PAGESTYLEMD5`: the style asset's content hash (`null` omits the key).
    /// `"0"` = no custom asset. A custom IMAGE template names its asset here;
    /// tests set it (plus a non-RLE background bitmap) to exercise the
    /// image-template classifier.
    style_md5: ?[]const u8 = null,
    /// `ORIENTATION`: `"1000"` vertical (the device default), `"1090"`
    /// horizontal. `null` omits the key entirely — for exercising a consumer's
    /// absent-key default (vertical).
    orientation: ?[]const u8 = "1000",
    layers: []const LayerSpec = &.{},
    /// A raw `LAYERINFO` value emitted VERBATIM (null omits the key). Raw on
    /// purpose: tests exercise both real encodings (`#`-JSON, base64) and
    /// hostile garbage through the same field.
    layer_info: ?[]const u8 = null,
    /// A raw `LAYERSEQ` value emitted verbatim (null omits the key).
    layer_seq: ?[]const u8 = null,
    /// `RECOGNSTATUS`: 0 none (key omitted), 1 finished, 2 still running.
    recogn_status: u8 = 0,
    /// Text-element labels. When present, a `RECOGNTEXT` block holding the
    /// device's shape (base64 of the MyScript-ish elements JSON) is emitted and
    /// referenced from the page — so a consumer's recognition path can be
    /// exercised without a real device capture.
    ///
    /// Shorthand for `recogn_elements` with no per-word boxes; use that one when
    /// the test cares where the words are.
    recogn_labels: ?[]const []const u8 = null,
    /// The full recognition shape: elements, each with positioned words. Takes
    /// precedence over `recogn_labels` when both are set.
    recogn_elements: ?[]const ElementSpec = null,
};

/// One recognized word. `box` is in MILLIMETRES (see `recognition.zig`);
/// null means the device wrote `"bounding-box": null`, which is what it does for
/// the `"\n"` / `" "` layout separators.
pub const WordSpec = struct {
    label: []const u8,
    box: ?recognition.Box = null,
};

/// One `Text` element: the joined label plus the words it is made of.
pub const ElementSpec = struct {
    label: []const u8,
    words: []const WordSpec = &.{},
};

/// A cover image emitted as a content block and referenced from the footer.
/// `key` selects the type suffix the device uses: `COVER_3` = user-set on
/// current firmware (the newest, most-preferred key), `COVER_2` = user-set on
/// older firmware, `COVER_1` = automatic. Any string works — tests pin the
/// newest-wins preference by mixing them.
pub const CoverSpec = struct {
    key: []const u8 = "COVER_2",
    bytes: []const u8,
};

pub const Spec = struct {
    filetype: []const u8 = "note",
    version: u32 = 20260016,
    header: []const Kv = &.{},
    pages: []const PageSpec,
    /// Cover image blocks (see `CoverSpec`). Multiple entries let a test build
    /// the both-keys-present file the preference order is specified against.
    covers: []const CoverSpec = &.{},
    /// Extra footer entries emitted VERBATIM — e.g. the device's
    /// `<COVER_0:0>` "no cover set" placeholder.
    footer_extra: []const Kv = &.{},
};

/// Serializes `spec` into a valid X-series `.note` buffer owned by `gpa`.
pub fn serialize(gpa: std.mem.Allocator, spec: Spec) ![]u8 {
    var tmp = std.heap.ArenaAllocator.init(gpa);
    defer tmp.deinit();
    const t = tmp.allocator();

    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(gpa);

    // Leading header: 4-byte file-type marker + signature at offset 4.
    var ft = [_]u8{0} ** 4;
    @memcpy(ft[0..@min(4, spec.filetype.len)], spec.filetype[0..@min(4, spec.filetype.len)]);
    try buf.appendSlice(gpa, &ft);
    try buf.appendSlice(gpa, try std.fmt.allocPrint(t, "SN_FILE_VER_{d:0>8}", .{spec.version}));

    // Pages (and their layer blocks + bitmaps) first, recording addresses.
    const page_addrs = try t.alloc(u32, spec.pages.len);
    for (spec.pages, 0..) |page, pi| {
        var kvs: std.ArrayList(Kv) = .empty;
        try kvs.append(t, .{ .key = "PAGESTYLE", .value = page.style });
        if (page.style_md5) |m| try kvs.append(t, .{ .key = "PAGESTYLEMD5", .value = m });
        if (page.orientation) |o| try kvs.append(t, .{ .key = "ORIENTATION", .value = o });
        if (page.layer_info) |li| try kvs.append(t, .{ .key = "LAYERINFO", .value = li });
        if (page.layer_seq) |seq| try kvs.append(t, .{ .key = "LAYERSEQ", .value = seq });

        if (page.recogn_status != 0) {
            try kvs.append(t, .{ .key = "RECOGNSTATUS", .value = try numStr(t, page.recogn_status) });
        }
        // `recogn_elements` wins; `recogn_labels` is the same thing with no words.
        const elements: ?[]const ElementSpec = page.recogn_elements orelse blk: {
            const labels = page.recogn_labels orelse break :blk null;
            const els = try t.alloc(ElementSpec, labels.len);
            for (labels, els) |label, *e| e.* = .{ .label = label };
            break :blk els;
        };
        if (elements) |els| {
            const addr = try appendFramed(&buf, gpa, try recognText(t, els));
            try kvs.append(t, .{ .key = "RECOGNTEXT", .value = try numStr(t, addr) });
        }

        for (page.layers) |layer| {
            const bmp_addr = try appendFramed(&buf, gpa, layer.bitmap);
            const layer_meta = try metaString(t, &.{
                .{ .key = "LAYERNAME", .value = layer.name },
                .{ .key = "LAYERPROTOCOL", .value = layer.protocol },
                .{ .key = "LAYERTYPE", .value = "NOTE" },
                .{ .key = "LAYERBITMAP", .value = try numStr(t, bmp_addr) },
            });
            const layer_addr = try appendFramed(&buf, gpa, layer_meta);
            try kvs.append(t, .{ .key = layer.slot.key(), .value = try numStr(t, layer_addr) });
        }

        page_addrs[pi] = try appendFramed(&buf, gpa, try metaString(t, kvs.items));
    }

    // Header block.
    const header_addr = try appendFramed(&buf, gpa, try metaString(t, spec.header));

    // Cover content blocks, recording each one's footer entry.
    var cover_kvs: std.ArrayList(Kv) = .empty;
    for (spec.covers) |cover| {
        const addr = try appendFramed(&buf, gpa, cover.bytes);
        try cover_kvs.append(t, .{ .key = cover.key, .value = try numStr(t, addr) });
    }

    // Footer block: FILE_FEATURE + one PAGE<n> entry per page (+ covers/extra).
    var footer_kvs: std.ArrayList(Kv) = .empty;
    try footer_kvs.append(t, .{ .key = "FILE_FEATURE", .value = try numStr(t, header_addr) });
    for (page_addrs, 0..) |addr, i| {
        const key = try std.fmt.allocPrint(t, "PAGE{d}", .{i + 1});
        try footer_kvs.append(t, .{ .key = key, .value = try numStr(t, addr) });
    }
    try footer_kvs.appendSlice(t, cover_kvs.items);
    try footer_kvs.appendSlice(t, spec.footer_extra);
    const footer_addr = try appendFramed(&buf, gpa, try metaString(t, footer_kvs.items));

    // Trailing 4 bytes: the footer address.
    var tail: [4]u8 = undefined;
    std.mem.writeInt(u32, &tail, footer_addr, .little);
    try buf.appendSlice(gpa, &tail);

    return buf.toOwnedSlice(gpa);
}

/// Appends `[u32 len][payload]` and returns the address (offset of the length).
fn appendFramed(buf: *std.ArrayList(u8), gpa: std.mem.Allocator, payload: []const u8) !u32 {
    const addr: u32 = @intCast(buf.items.len);
    var lenb: [4]u8 = undefined;
    std.mem.writeInt(u32, &lenb, @intCast(payload.len), .little);
    try buf.appendSlice(gpa, &lenb);
    try buf.appendSlice(gpa, payload);
    return addr;
}

fn metaString(a: std.mem.Allocator, kvs: []const Kv) ![]u8 {
    var s: std.ArrayList(u8) = .empty;
    for (kvs) |kv| {
        try s.append(a, '<');
        try s.appendSlice(a, kv.key);
        try s.append(a, ':');
        try s.appendSlice(a, kv.value);
        try s.append(a, '>');
    }
    return s.toOwnedSlice(a);
}

fn numStr(a: std.mem.Allocator, n: u32) ![]u8 {
    return std.fmt.allocPrint(a, "{d}", .{n});
}

/// Appends `s` as a JSON string literal, escaped. Not optional politeness: the
/// separator words this builder exists to reproduce have labels of `"\n"` and
/// `" "`, and splicing a raw newline into a JSON string produces a document that
/// will not parse — which then looks exactly like a decoder bug downstream.
fn appendJsonString(a: std.mem.Allocator, doc: *std.ArrayList(u8), s: []const u8) !void {
    try doc.append(a, '"');
    for (s) |c| switch (c) {
        '"' => try doc.appendSlice(a, "\\\""),
        '\\' => try doc.appendSlice(a, "\\\\"),
        '\n' => try doc.appendSlice(a, "\\n"),
        '\r' => try doc.appendSlice(a, "\\r"),
        '\t' => try doc.appendSlice(a, "\\t"),
        else => if (c < 0x20) try doc.print(a, "\\u{x:0>4}", .{c}) else try doc.append(a, c),
    };
    try doc.append(a, '"');
}

/// The content of a `RECOGNTEXT` block: base64 of the elements JSON the device
/// writes (see `recognition.zig`).
///
/// A word with a null `box` serializes `"bounding-box": null` — the real device
/// shape for a layout separator, and the case a consumer must skip rather than
/// place at the origin.
fn recognText(a: std.mem.Allocator, elements: []const ElementSpec) ![]u8 {
    var doc: std.ArrayList(u8) = .empty;
    try doc.appendSlice(a, "{\"elements\":[");
    for (elements, 0..) |element, i| {
        if (i != 0) try doc.append(a, ',');
        try doc.appendSlice(a, "{\"type\":\"Text\",\"label\":");
        try appendJsonString(a, &doc, element.label);
        try doc.appendSlice(a, ",\"words\":[");
        for (element.words, 0..) |w, j| {
            if (j != 0) try doc.append(a, ',');
            try doc.appendSlice(a, "{\"label\":");
            try appendJsonString(a, &doc, w.label);
            try doc.appendSlice(a, ",\"bounding-box\":");
            if (w.box) |b| {
                try doc.print(a, "{{\"x\":{d},\"y\":{d},\"width\":{d},\"height\":{d}}}", .{
                    b.x, b.y, b.width, b.height,
                });
            } else {
                try doc.appendSlice(a, "null");
            }
            try doc.append(a, '}');
        }
        try doc.appendSlice(a, "]}");
    }
    try doc.appendSlice(a, "]}");

    const enc = std.base64.standard.Encoder;
    const out = try a.alloc(u8, enc.calcSize(doc.items.len));
    _ = enc.encode(out, doc.items);
    return out;
}

test "serialize produces a buffer parseable by the parser" {
    const bitmap = [_]u8{ 0x61, 0x0A, 0x62, 0xFF };
    const bytes = try serialize(std.testing.allocator, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{
            .style = "style_5mm_dots",
            .layers = &.{.{ .slot = .main, .bitmap = &bitmap }},
        }},
    });
    defer std.testing.allocator.free(bytes);

    var doc = try note.parse(std.testing.allocator, bytes);
    defer doc.deinit();

    try std.testing.expectEqual(@as(usize, 1), doc.pageCount());
    try std.testing.expectEqualStrings("N6", doc.applyEquipment().?);
    const main = doc.pages[0].layer(.main).?;
    try std.testing.expectEqualStrings("RATTA_RLE", main.protocol().?);
}
