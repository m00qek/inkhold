//! Tier 3 — handwriting-recognition (OCR) extraction from a page's
//! `RECOGNTEXT` field.
//!
//! When a page's recognition is complete (`RECOGNSTATUS == 1`), its `RECOGNTEXT`
//! content block is base64-encoded JSON of the form:
//!   { "elements": [ { "label": "Test", "type": "Text",
//!                     "words": [ { "label": "Test",
//!                                  "bounding-box": {x,y,width,height} } ] }, ... ] }
//! Bounding boxes are in **millimetres**, and a box may be `null` — the device
//! emits `"\n"` / `" "` layout separators as words with no position at all. The
//! mm→px scale is NOT `page_px_width/118.64` in general: 118.64 mm is the
//! verified canvas width of the 1404×1872 class only, so the scale comes from
//! the allowlist in `types.CanvasMm` and is *unknown* for hardware we have no
//! sample from. Non-text elements (e.g. "Raw Content") and pages still
//! recognising (empty `RECOGNTEXT`) yield no text.
//!
//! This powers full-text search (index the labels) and searchable-PDF export
//! (place invisible text at the boxes). The richer `RECOGNFILE` MyScript package
//! is not parsed here — the simple `RECOGNTEXT` path covers finished pages.

const std = @import("std");
const note_mod = @import("note.zig");
const types = @import("types.zig");

/// A `RECOGNTEXT` blob that is not base64-wrapped JSON of the expected shape is
/// `error.Corrupt` (a content block the file claims is finished recognition but
/// cannot be read as one). Allocator failure stays its own fact.
pub const Error = error{Corrupt} || std.mem.Allocator.Error;

/// A word's bounding box, in **MILLIMETRES** on the page canvas, origin
/// top-left. Not pixels: converting needs the device's physical page size, which
/// is `types.CanvasMm.forEquipment` and is deliberately unknown for hardware we
/// have no sample from.
pub const Box = struct {
    x: f32 = 0,
    y: f32 = 0,
    width: f32 = 0,
    height: f32 = 0,
};

pub const Word = struct {
    label: []const u8 = "",
    /// **NULLABLE, and null is common.** The device emits layout separators as
    /// words — `label` is `"\n"` or `" "` — with `"bounding-box": null`, because
    /// a line break is not anywhere on the page. Defaulting those to `{0,0,0,0}`
    /// would pile every separator in the top-left corner; they must be SKIPPED
    /// (which is what `placedWords` does).
    ///
    /// This being optional is also what stops a null from failing the whole
    /// parse: `std.json` has no way to put `null` into a non-optional struct, so
    /// before this a single separator cost the page its entire transcript
    /// (the indexer's `catch` dropped the text and kept only the range).
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

/// Parsed recognition for one page. Owns its allocations via `parsed`.
pub const Recognition = struct {
    parsed: std.json.Parsed(Doc),

    pub fn deinit(self: *Recognition) void {
        self.parsed.deinit();
    }

    pub fn elements(self: Recognition) []const Element {
        return self.parsed.value.elements;
    }

    /// The page's recognized text, in reading order, one line per recognized
    /// region. Caller frees.
    ///
    /// The DEVICE does the layout analysis for us and we HONOR it rather than
    /// reconstruct order from geometry (which supernote-tool does, and which
    /// would need the mm→px scale this file notes is unknown for some
    /// hardware): an element's `label` already carries the correct order WITH
    /// its `"\n"` line breaks, and its `words` list tokens — including the
    /// `"\n"`/`" "` separators, which are words with a null box — in reading
    /// order. So per region we take the `label`, or, when it is absent,
    /// concatenate the words (recovering text a bare `label orelse continue`
    /// used to DROP entirely). Regions are stable-sorted by their first placed
    /// word's `y` for the rare out-of-emit-order page, and joined with `"\n"`
    /// because distinct recognized regions are distinct lines.
    pub fn plainText(self: Recognition, gpa: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
        const els = self.elements();

        // Indices of the text regions, so the sort moves usize not structs and
        // the labels stay borrowed from `parsed`.
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
        // Stable: unplaced regions (`floatMax`) sink to the end keeping emit
        // order; region counts are tiny, so insertion sort is ideal.
        std.sort.insertion(usize, idx.items, Ctx{ .els = els }, Ctx.lt);

        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        for (idx.items, 0..) |i, n| {
            if (n != 0) try out.append(gpa, '\n');
            try appendElementText(&out, gpa, els[i]);
        }
        return out.toOwnedSlice(gpa);
    }

    /// Every word that is actually somewhere on the page, in reading order.
    /// Caller frees the slice; the labels borrow from `parsed` and live as long
    /// as this `Recognition` does.
    ///
    /// Three things are dropped, all of them for the same reason — they have no
    /// position, so a searchable-PDF text layer has nowhere to put them:
    ///   - non-`Text` elements (e.g. "Raw Content"), which carry no words;
    ///   - words with a null `bounding-box` (the `"\n"` / `" "` separators);
    ///   - words with an empty label, which would place an empty string.
    ///
    /// `plainText` is the one to use for reading/indexing — it keeps the
    /// separators, because there the layout is the point.
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

/// One recognized word that has a place on the page. `box` is in MILLIMETRES —
/// see `Box`.
pub const PlacedWord = struct {
    label: []const u8,
    box: Box,
};

/// True when a region contributes any text — a non-empty `label`, or any word
/// with a non-empty label. Regions that are empty (no label, only separators or
/// nothing) are skipped so the `"\n"` join never emits a blank line.
fn elementHasText(el: Element) bool {
    if (el.label) |l| {
        if (l.len != 0) return true;
    }
    if (el.words) |ws| {
        for (ws) |w| if (w.label.len != 0) return true;
    }
    return false;
}

/// The `y` of a region's first PLACED word (raw millimetres — ordering needs no
/// scale), or `floatMax` when it has no placed word, so unplaced regions sort to
/// the end under a stable sort.
fn firstPlacedY(el: Element) f32 {
    if (el.words) |ws| {
        for (ws) |w| {
            if (w.@"bounding-box") |bb| return bb.y;
        }
    }
    return std.math.floatMax(f32);
}

/// One region's text: the device `label` when present (it already carries the
/// `"\n"` breaks), else the words concatenated in order — the separator words
/// carry their own `"\n"`/`" "` label, so concatenation reproduces the device's
/// breaks and recovers a region a bare label check would have dropped.
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

/// Parses base64-encoded `RECOGNTEXT` content bytes into a `Recognition`.
pub fn parse(gpa: std.mem.Allocator, recogntext_content: []const u8) Error!Recognition {
    const dec = std.base64.standard.Decoder;
    const json_len = dec.calcSizeForSlice(recogntext_content) catch return error.Corrupt;
    const json_buf = try gpa.alloc(u8, json_len);
    defer gpa.free(json_buf);
    dec.decode(json_buf, recogntext_content) catch return error.Corrupt;

    // alloc_always so all strings are copied into the Parsed arena (json_buf is freed).
    const parsed = std.json.parseFromSlice(Doc, gpa, json_buf, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_always,
    }) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.Corrupt,
    };
    return .{ .parsed = parsed };
}

/// Reads and parses page `page_index`'s recognition, or null if the page has no
/// finished `RECOGNTEXT` (address 0 / still recognising).
pub fn forPage(
    gpa: std.mem.Allocator,
    note: note_mod.Note,
    page_index: usize,
) (Error || note_mod.Error)!?Recognition {
    if (page_index >= note.pages.len) return null;
    return forParsedPage(gpa, note.source, note.pages[page_index]);
}

/// The bare-page flavour of `forPage`: works off one parsed page and a source
/// without needing a full `Note`.
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

/// Base64 of `json`, the way a `RECOGNTEXT` block stores it.
fn encodeForTest(gpa: std.mem.Allocator, json: []const u8) ![]u8 {
    const enc = std.base64.standard.Encoder;
    const out = try gpa.alloc(u8, enc.calcSize(json.len));
    _ = enc.encode(out, json);
    return out;
}

test "plainText honors the device layout: label passthrough, y-sort, word reconstruction" {
    const gpa = std.testing.allocator;
    // Three regions emitted OUT of y-order; the second carries the device's own
    // `\n` inside its label (must pass through verbatim); the third has NO
    // top-level label and must be reconstructed from its words — including the
    // separator words (`\n`/` `), whose own labels reproduce the breaks — rather
    // than dropped as a bare `label orelse continue` used to.
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
    // y-sorted (top@10, mid@40, third@90), regions newline-joined, the label's
    // own `\n` preserved, the label-less region rebuilt from its words, the
    // non-Text "Raw Content" ignored.
    try std.testing.expectEqualStrings("top\nrow\nmid line\nthird", text);
}

test "placedWords skips the null-box layout separators" {
    const gpa = std.testing.allocator;
    // The device's real shape: "\n" and " " are emitted as words with a NULL
    // bounding-box, because a line break is not anywhere on the page.
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

    // Two, not four — and emphatically not four with two of them at {0,0,0,0},
    // which is what a non-optional Box with a default would have produced.
    try std.testing.expectEqual(@as(usize, 2), placed.len);
    try std.testing.expectEqualStrings("one", placed[0].label);
    try std.testing.expectEqualStrings("two", placed[1].label);
    for (placed) |p| try std.testing.expect(p.box.width > 0);
}

test "a null bounding-box no longer costs the page its whole transcript" {
    const gpa = std.testing.allocator;
    // Before `bounding-box` was optional, std.json could not put `null` into a
    // non-optional struct, so ONE separator failed the parse — and the indexer's
    // catch dropped the transcript for the entire page.
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
    // Not base64 at all.
    try std.testing.expectError(error.Corrupt, parse(gpa, "!!! not base64 !!!"));
    // Valid base64 of invalid JSON.
    const content = try encodeForTest(gpa, "{ definitely not json");
    defer gpa.free(content);
    try std.testing.expectError(error.Corrupt, parse(gpa, content));
}
