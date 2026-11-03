//! Tier 3: handwriting recognition from a page's `RECOGNTEXT` block (base64
//! JSON, `note-format.md` §11.1). Boxes are millimetres and may be null; the
//! mm→px scale comes from `types.CanvasMm` and is unknown for unsampled hardware.

const std = @import("std");
const note_mod = @import("note.zig");
const types = @import("types.zig");

/// A `RECOGNTEXT` blob that is not base64 JSON of the expected shape.
pub const Error = error{Corrupt} || std.mem.Allocator.Error;

/// A word box in millimetres, origin top-left.
pub const Box = struct {
    x: f32 = 0,
    y: f32 = 0,
    width: f32 = 0,
    height: f32 = 0,
};

pub const Word = struct {
    label: []const u8 = "",
    /// Null for the device's `"\n"`/`" "` separator words; must be skipped, not
    /// defaulted to {0,0,0,0}. Optional so one null cannot fail the whole parse.
    @"bounding-box": ?Box = null,
};

pub const Element = struct {
    label: ?[]const u8 = null,
    type: ?[]const u8 = null,
    words: ?[]const Word = null,

    pub fn isText(self: Element) bool {
        return self.type != null and std.mem.eql(u8, self.type.?, "Text");
    }
};

const Doc = struct { elements: []const Element = &.{} };

pub const Recognition = struct {
    parsed: std.json.Parsed(Doc),

    pub fn deinit(self: *Recognition) void {
        self.parsed.deinit();
    }

    pub fn elements(self: Recognition) []const Element {
        return self.parsed.value.elements;
    }

    /// The page text, one line per region; caller frees. Honours the device's
    /// layout: each region's `label` (or its words concatenated when absent),
    /// stable-sorted by first placed word's `y`, joined with `"\n"`.
    pub fn plainText(self: Recognition, gpa: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
        const els = self.elements();

        var idx: std.ArrayList(usize) = .empty;
        defer idx.deinit(gpa);
        for (els, 0..) |el, i| {
            if (el.isText() and elementHasText(el)) try idx.append(gpa, i);
        }

        const Ctx = struct {
            els: []const Element,
            fn lt(c: @This(), a: usize, b: usize) bool {
                return firstPlacedY(c.els[a]) < firstPlacedY(c.els[b]);
            }
        };
        // Stable, so unplaced regions (`floatMax`) keep emit order at the end.
        std.sort.insertion(usize, idx.items, Ctx{ .els = els }, Ctx.lt);

        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        for (idx.items, 0..) |i, n| {
            if (n != 0) try out.append(gpa, '\n');
            try appendElementText(&out, gpa, els[i]);
        }
        return out.toOwnedSlice(gpa);
    }

    /// Every word with a position, for a PDF text layer; caller frees, labels
    /// borrow from `parsed`. Drops non-`Text` elements, null boxes and empty
    /// labels. Use `plainText` for indexing.
    pub fn placedWords(self: Recognition, gpa: std.mem.Allocator) std.mem.Allocator.Error![]PlacedWord {
        var out: std.ArrayList(PlacedWord) = .empty;
        errdefer out.deinit(gpa);
        for (self.elements()) |el| {
            if (!el.isText()) continue;
            for (el.words orelse continue) |w| {
                const box = w.@"bounding-box" orelse continue;
                if (w.label.len == 0) continue;
                try out.append(gpa, .{ .label = w.label, .box = box });
            }
        }
        return out.toOwnedSlice(gpa);
    }
};

/// A recognized word with a position; `box` is in millimetres.
pub const PlacedWord = struct {
    label: []const u8,
    box: Box,
};

/// Whether a region has any text, so the join never emits a blank line.
fn elementHasText(el: Element) bool {
    if (el.label) |l| {
        if (l.len != 0) return true;
    }
    if (el.words) |ws| {
        for (ws) |w| if (w.label.len != 0) return true;
    }
    return false;
}

/// A region's first placed word's `y` (mm), or `floatMax` if none.
fn firstPlacedY(el: Element) f32 {
    if (el.words) |ws| {
        for (ws) |w| {
            if (w.@"bounding-box") |bb| return bb.y;
        }
    }
    return std.math.floatMax(f32);
}

/// A region's `label`, else its words concatenated (separator words carry
/// their own breaks).
fn appendElementText(out: *std.ArrayList(u8), gpa: std.mem.Allocator, el: Element) std.mem.Allocator.Error!void {
    if (el.label) |lab| {
        if (lab.len != 0) {
            try out.appendSlice(gpa, lab);
            return;
        }
    }
    if (el.words) |ws| {
        for (ws) |w| try out.appendSlice(gpa, w.label);
    }
}

pub fn parse(gpa: std.mem.Allocator, recogntext_content: []const u8) Error!Recognition {
    const dec = std.base64.standard.Decoder;
    const json_len = dec.calcSizeForSlice(recogntext_content) catch return error.Corrupt;
    const json_buf = try gpa.alloc(u8, json_len);
    defer gpa.free(json_buf);
    dec.decode(json_buf, recogntext_content) catch return error.Corrupt;

    // alloc_always: strings are copied into the Parsed arena (json_buf is freed).
    const parsed = std.json.parseFromSlice(Doc, gpa, json_buf, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_always,
    }) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.Corrupt,
    };
    return .{ .parsed = parsed };
}

/// Page `page_index`'s recognition, or null if unfinished (address 0).
pub fn forPage(
    gpa: std.mem.Allocator,
    note: note_mod.Note,
    page_index: usize,
) (Error || note_mod.Error)!?Recognition {
    if (page_index >= note.pages.len) return null;
    return forParsedPage(gpa, note.source, note.pages[page_index]);
}

/// `forPage` for one parsed page and a source.
pub fn forParsedPage(
    gpa: std.mem.Allocator,
    src: note_mod.Source,
    page: types.Page,
) (Error || note_mod.Error)!?Recognition {
    const addr = page.recognitionAddress();
    if (addr == 0) return null;
    const held = src.blockHeld(gpa, addr) catch |e| return switch (e) {
        error.OutOfMemory => error.OutOfMemory,
        error.OutOfBounds => error.Truncated,
        error.ReadFailed => error.ReadFailed,
    };
    defer held.deinit(gpa);
    return try parse(gpa, held.bytes);
}

fn encodeForTest(gpa: std.mem.Allocator, json: []const u8) ![]u8 {
    const enc = std.base64.standard.Encoder;
    const out = try gpa.alloc(u8, enc.calcSize(json.len));
    _ = enc.encode(out, json);
    return out;
}

test "plainText honors the device layout: label passthrough, y-sort, word reconstruction" {
    const gpa = std.testing.allocator;
    // Regions out of y-order; one label carries its own `\n`; one has no
    // label and must be rebuilt from its words.
    const json =
        \\{"elements":[
        \\ {"type":"Text","label":"third","words":[{"label":"third","bounding-box":{"x":0,"y":90,"width":5,"height":5}}]},
        \\ {"type":"Text","label":"top\nrow","words":[{"label":"top","bounding-box":{"x":0,"y":10,"width":5,"height":5}}]},
        \\ {"type":"Text","words":[
        \\   {"label":"mid","bounding-box":{"x":0,"y":40,"width":5,"height":5}},
        \\   {"label":" ","bounding-box":null},
        \\   {"label":"line","bounding-box":{"x":9,"y":40,"width":5,"height":5}}
        \\ ]},
        \\ {"type":"Raw Content","label":"ignored"}
        \\]}
    ;
    const content = try encodeForTest(gpa, json);
    defer gpa.free(content);
    var rec = try parse(gpa, content);
    defer rec.deinit();

    const text = try rec.plainText(gpa);
    defer gpa.free(text);
    try std.testing.expectEqualStrings("top\nrow\nmid line\nthird", text);
}

test "placedWords skips the null-box layout separators" {
    const gpa = std.testing.allocator;
    const json =
        \\{"elements":[{"type":"Text","label":"one two","words":[
        \\  {"label":"one","bounding-box":{"x":1,"y":2,"width":3,"height":4}},
        \\  {"label":"\n","bounding-box":null},
        \\  {"label":" ","bounding-box":null},
        \\  {"label":"two","bounding-box":{"x":5,"y":6,"width":7,"height":8}}
        \\]}]}
    ;
    const content = try encodeForTest(gpa, json);
    defer gpa.free(content);

    var rec = try parse(gpa, content);
    defer rec.deinit();

    const placed = try rec.placedWords(gpa);
    defer gpa.free(placed);

    // Two, not four with two at {0,0,0,0}.
    try std.testing.expectEqual(@as(usize, 2), placed.len);
    try std.testing.expectEqualStrings("one", placed[0].label);
    try std.testing.expectEqualStrings("two", placed[1].label);
    for (placed) |p| try std.testing.expect(p.box.width > 0);
}

test "a null bounding-box no longer costs the page its whole transcript" {
    const gpa = std.testing.allocator;
    // One null box used to fail the whole page's parse.
    const json =
        \\{"elements":[{"type":"Text","label":"hello","words":[{"label":"\n","bounding-box":null}]}]}
    ;
    const content = try encodeForTest(gpa, json);
    defer gpa.free(content);

    var rec = try parse(gpa, content);
    defer rec.deinit();

    const text = try rec.plainText(gpa);
    defer gpa.free(text);
    try std.testing.expectEqualStrings("hello", text);
}

test "placedWords ignores non-Text elements and empty labels" {
    const gpa = std.testing.allocator;
    const json =
        \\{"elements":[
        \\  {"type":"Raw Content","label":"scribble","words":[
        \\    {"label":"nope","bounding-box":{"x":1,"y":1,"width":1,"height":1}}]},
        \\  {"type":"Text","label":"yes","words":[
        \\    {"label":"","bounding-box":{"x":2,"y":2,"width":2,"height":2}},
        \\    {"label":"yes","bounding-box":{"x":3,"y":3,"width":3,"height":3}}]}
        \\]}
    ;
    const content = try encodeForTest(gpa, json);
    defer gpa.free(content);

    var rec = try parse(gpa, content);
    defer rec.deinit();

    const placed = try rec.placedWords(gpa);
    defer gpa.free(placed);
    try std.testing.expectEqual(@as(usize, 1), placed.len);
    try std.testing.expectEqualStrings("yes", placed[0].label);
}

test "a blob that is not base64-JSON is Corrupt, never a panic or a json error" {
    const gpa = std.testing.allocator;
    try std.testing.expectError(error.Corrupt, parse(gpa, "!!! not base64 !!!"));
    const content = try encodeForTest(gpa, "{ definitely not json");
    defer gpa.free(content);
    try std.testing.expectError(error.Corrupt, parse(gpa, content));
}
