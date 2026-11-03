//! Builds synthetic, well-formed `.note` buffers in memory for tests.

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
    /// The footer key's number; `null` = position + 1. Set it for a sparse
    /// `.mark`-style footer (`note-format.md` §13.2).
    number: ?u32 = null,
    style: []const u8 = "",
    /// `PAGESTYLEMD5` (`null` omits the key; `"0"` = no custom asset).
    style_md5: ?[]const u8 = null,
    /// `ORIENTATION`; `null` omits the key.
    orientation: ?[]const u8 = "1000",
    layers: []const LayerSpec = &.{},
    /// A raw `LAYERINFO` value emitted verbatim (null omits the key).
    layer_info: ?[]const u8 = null,
    /// A raw `LAYERSEQ` value emitted verbatim (null omits the key).
    layer_seq: ?[]const u8 = null,
    /// `RECOGNSTATUS`: 0 none (key omitted), 1 finished, 2 still running.
    recogn_status: u8 = 0,
    /// Text-element labels for a `RECOGNTEXT` block; `recogn_elements` without
    /// word boxes.
    recogn_labels: ?[]const []const u8 = null,
    /// Elements with positioned words; wins over `recogn_labels`.
    recogn_elements: ?[]const ElementSpec = null,
    /// An `EXTERNALLINKINFO` block in the device's encoding; empty omits it.
    links: []const LinkSpec = &.{},
};

/// One `EXTERNALLINKINFO` record. Setting `uri` makes it a web link, so kind
/// and URI cannot disagree. `source_page` defaults to the page's number.
pub const LinkSpec = struct {
    source_page: ?u32 = null,
    /// Field 2, the target page's `PAGEID`.
    target_id: []const u8 = "P00000000000000000000AAAAAAAAAAAA",
    /// Field 3, 1-based.
    target_page: u32 = 1,
    /// Fields 4–7, device panel pixels.
    x: i32 = 0,
    y: i32 = 0,
    w: i32 = 10,
    h: i32 = 10,
    /// `null` = an internal jump, which stores the literal `none`.
    uri: ?[]const u8 = null,
};

/// One recognized word; `box` in mm, null for separator words.
pub const WordSpec = struct {
    label: []const u8,
    box: ?recognition.Box = null,
};

pub const ElementSpec = struct {
    label: []const u8,
    words: []const WordSpec = &.{},
};

/// A cover content block under `key` (`COVER_3`, `COVER_2`, `COVER_1`).
pub const CoverSpec = struct {
    key: []const u8 = "COVER_2",
    bytes: []const u8,
};

pub const Spec = struct {
    filetype: []const u8 = "note",
    version: u32 = 20260016,
    header: []const Kv = &.{},
    pages: []const PageSpec,
    covers: []const CoverSpec = &.{},
    /// Extra footer entries emitted verbatim (e.g. `<COVER_0:0>`).
    footer_extra: []const Kv = &.{},
};

pub fn serialize(gpa: std.mem.Allocator, spec: Spec) ![]u8 {
    var tmp = std.heap.ArenaAllocator.init(gpa);
    defer tmp.deinit();
    const t = tmp.allocator();

    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(gpa);

    var ft = @as([4]u8, @splat(0));
    @memcpy(ft[0..@min(4, spec.filetype.len)], spec.filetype[0..@min(4, spec.filetype.len)]);
    try buf.appendSlice(gpa, &ft);
    try buf.appendSlice(gpa, try std.fmt.allocPrint(t, "SN_FILE_VER_{d:0>8}", .{spec.version}));

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

        if (page.links.len != 0) {
            const number = page.number orelse @as(u32, @intCast(pi + 1));
            const addr = try appendFramed(&buf, gpa, try externalLinkInfo(t, page.links, number));
            try kvs.append(t, .{ .key = "EXTERNALLINKINFO", .value = try numStr(t, addr) });
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

    const header_addr = try appendFramed(&buf, gpa, try metaString(t, spec.header));

    var cover_kvs: std.ArrayList(Kv) = .empty;
    for (spec.covers) |cover| {
        const addr = try appendFramed(&buf, gpa, cover.bytes);
        try cover_kvs.append(t, .{ .key = cover.key, .value = try numStr(t, addr) });
    }

    var footer_kvs: std.ArrayList(Kv) = .empty;
    try footer_kvs.append(t, .{ .key = "FILE_FEATURE", .value = try numStr(t, header_addr) });
    for (page_addrs, 0..) |addr, i| {
        const n = spec.pages[i].number orelse @as(u32, @intCast(i + 1));
        const key = try std.fmt.allocPrint(t, "PAGE{d}", .{n});
        try footer_kvs.append(t, .{ .key = key, .value = try numStr(t, addr) });
    }
    try footer_kvs.appendSlice(t, cover_kvs.items);
    try footer_kvs.appendSlice(t, spec.footer_extra);
    const footer_addr = try appendFramed(&buf, gpa, try metaString(t, footer_kvs.items));

    var tail: [4]u8 = undefined;
    std.mem.writeInt(u32, &tail, footer_addr, .little);
    try buf.appendSlice(gpa, &tail);

    return buf.toOwnedSlice(gpa);
}

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

/// Appends `s` as an escaped JSON string; separator labels are `"\n"` and `" "`.
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

/// A `RECOGNTEXT` block's content: base64 of the elements JSON; a null `box`
/// writes `"bounding-box": null`.
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

/// An `EXTERNALLINKINFO` block's content with trailing `,` and `|`, written by
/// hand rather than through the decoder's helpers.
fn externalLinkInfo(a: std.mem.Allocator, specs: []const LinkSpec, page_number: u32) ![]u8 {
    const enc = std.base64.standard.Encoder;
    var out: std.ArrayList(u8) = .empty;
    for (specs) |s| {
        const uri = s.uri orelse "none";
        const fields = [_][]const u8{
            try numStr(a, s.source_page orelse page_number),
            s.target_id,
            try numStr(a, s.target_page),
            try std.fmt.allocPrint(a, "{d}", .{s.x}),
            try std.fmt.allocPrint(a, "{d}", .{s.y}),
            try std.fmt.allocPrint(a, "{d}", .{s.w}),
            try std.fmt.allocPrint(a, "{d}", .{s.h}),
            if (s.uri == null) "0" else "1",
            uri,
        };
        for (fields) |f| {
            const buf = try a.alloc(u8, enc.calcSize(f.len));
            _ = enc.encode(buf, f);
            try out.appendSlice(a, buf);
            try out.append(a, ',');
        }
        try out.append(a, '|');
    }
    return out.toOwnedSlice(a);
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
