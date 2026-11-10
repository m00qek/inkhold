//! Text typed into a page's text boxes (`note-format.md` §10.5). A text box is
//! a record in the page's vector strokes (`TOTALPATH`), not part of the
//! handwriting transcript: the tablet never recognises it, with recognition on
//! or off. Read only when the page says it has one (`PAGETEXTBOX` not 0), and
//! by ranged reads of record headers: the strokes are never materialised.

const std = @import("std");
const note_mod = @import("note.zig");
const source = @import("source.zig");
const types = @import("types.zig");

const Allocator = std.mem.Allocator;
const Source = source.Source;

pub const Error = note_mod.Error;

/// A box's rectangle in panel pixels, as the device writes it.
pub const Rect = struct { x: i32, y: i32, w: i32, h: i32 };

pub const TextBox = struct {
    /// UTF-8, line breaks as `\n`.
    text: []const u8,
    rect: Rect,
};

pub const TextBoxes = struct {
    arena: std.heap.ArenaAllocator,
    boxes: []const TextBox,

    pub fn deinit(self: *TextBoxes) void {
        self.arena.deinit();
    }

    /// Every box's text, in record order, one per line.
    pub fn plainText(self: TextBoxes, gpa: Allocator) Allocator.Error![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        for (self.boxes, 0..) |b, i| {
            if (i != 0) try out.append(gpa, '\n');
            try out.appendSlice(gpa, b.text);
        }
        return out.toOwnedSlice(gpa);
    }
};

/// The pen value of a text-box record (`+4`); drawing strokes are 1, 10, 11,
/// 15 or 16 and the record that came with a sticker is 4.
pub const text_box_pen: u32 = 0;
/// Where the record's field list is: a `u32` byte length at `+483`, then the
/// list at `+487`. Fixed on every text box seen (§10.5).
const list_len_at: u32 = 483;
const list_at: u32 = 487;
/// The text is the 13th of the list's base64 fields; the rectangle the 5th.
const text_field: usize = 12;
const rect_field: usize = 4;
/// Device-controlled; a text box holds a few lines.
const max_list_bytes: u32 = 1 << 20;

/// The page's text boxes; empty when it has none. A malformed record yields no
/// box rather than an error; a stroke block whose framing does not walk is
/// `error.Corrupt`.
pub fn forParsedPage(gpa: Allocator, src: Source, page: types.Page) Error!TextBoxes {
    const flag = page.block.get("PAGETEXTBOX") orelse "0";
    if (std.mem.eql(u8, flag, "0")) return empty(gpa);
    return fromStrokes(gpa, src, page.totalPathAddress(), page.block.get("DISABLE"));
}

fn empty(gpa: Allocator) TextBoxes {
    return .{ .arena = std.heap.ArenaAllocator.init(gpa), .boxes = &.{} };
}

/// Walks the `TOTALPATH` block at `address`. `live`, the page's `DISABLE`
/// (`x,y,w,h|` per box), keeps only boxes the page still lists: a record the
/// device left behind for a deleted box is never returned. Null `live`
/// filters nothing.
pub fn fromStrokes(gpa: Allocator, src: Source, address: u32, live: ?[]const u8) Error!TextBoxes {
    var out = empty(gpa);
    errdefer out.deinit();
    if (address == 0) return out;
    const a = out.arena.allocator();

    const block = src.blockRange(address) catch |e| return note_mod.lift(e);
    const end = block.offset + block.len;
    if (block.len < 4) return error.Corrupt;
    const count = src.u32le(block.offset) catch |e| return note_mod.lift(e);

    var boxes: std.ArrayList(TextBox) = .empty;
    var at = block.offset + 4;
    var walked: u32 = 0;
    while (at < end) : (walked += 1) {
        if (end - at < 4) return error.Corrupt;
        const section_len = src.u32le(at) catch |e| return note_mod.lift(e);
        const record_end = std.math.add(u64, at + 4, section_len) catch return error.Corrupt;
        if (record_end > end) return error.Corrupt;
        if (try boxAt(a, src, at, section_len)) |b| {
            if (live == null or listsRect(live.?, b.rect)) try boxes.append(a, b);
        }
        at = record_end;
    }
    // Self-check (§10.0): the walk lands on the block end and counts `count`.
    if (walked != count) return error.Corrupt;
    out.boxes = boxes.items;
    return out;
}

/// The text box in the record at `at`, or null when it is not one.
fn boxAt(a: Allocator, src: Source, at: u64, section_len: u32) Error!?TextBox {
    if (section_len < list_at) return null;
    const pen = src.u32le(at + 4) catch |e| return note_mod.lift(e);
    if (pen != text_box_pen) return null;
    const list_len = src.u32le(at + list_len_at) catch |e| return note_mod.lift(e);
    if (list_len == 0 or list_len > max_list_bytes) return null;
    if (@as(u64, list_at) + list_len > @as(u64, section_len) + 4) return null;

    const list = try a.alloc(u8, list_len);
    src.read(at + list_at, list) catch |e| return note_mod.lift(e);
    return parseList(a, list);
}

/// `list` is base64 fields, each followed by a comma.
fn parseList(a: Allocator, list: []const u8) Allocator.Error!?TextBox {
    if (list[list.len - 1] != ',') return null;
    for (list) |c| if (!(std.ascii.isAlphanumeric(c) or c == '+' or c == '/' or c == '=' or c == ',')) return null;

    var fields: [text_field + 1][]const u8 = undefined;
    var it = std.mem.splitScalar(u8, list[0 .. list.len - 1], ',');
    var n: usize = 0;
    while (it.next()) |f| : (n += 1) {
        if (n <= text_field) fields[n] = f;
    }
    if (n <= text_field) return null;

    const text = (try decode64(a, fields[text_field])) orelse return null;
    if (!std.unicode.utf8ValidateSlice(text)) return null;
    const rect_raw = (try decode64(a, fields[rect_field])) orelse return null;
    const rect = parseRect(rect_raw) orelse return null;
    return .{ .text = text, .rect = rect };
}

fn decode64(a: Allocator, field: []const u8) Allocator.Error!?[]u8 {
    const dec = std.base64.standard.Decoder;
    const len = dec.calcSizeForSlice(field) catch return null;
    const out = try a.alloc(u8, len);
    dec.decode(out, field) catch return null;
    return out;
}

fn parseRect(raw: []const u8) ?Rect {
    var v: [4]i32 = undefined;
    var it = std.mem.splitScalar(u8, raw, ',');
    for (&v) |*x| {
        const part = it.next() orelse return null;
        x.* = std.fmt.parseInt(i32, std.mem.trim(u8, part, " "), 10) catch return null;
    }
    if (it.next() != null) return null;
    return .{ .x = v[0], .y = v[1], .w = v[2], .h = v[3] };
}

/// `DISABLE` names `rect` (`x,y,w,h|` entries).
fn listsRect(live: []const u8, rect: Rect) bool {
    var it = std.mem.splitScalar(u8, live, '|');
    while (it.next()) |entry| {
        const r = parseRect(entry) orelse continue;
        if (std.meta.eql(r, rect)) return true;
    }
    return false;
}

// ---- tests: hand-built stroke blocks (the device fixtures are in tests/) ----

const testing = std.testing;

/// A `TOTALPATH` block (length-prefixed) holding `records`, each already
/// framed by `record`, at address 4: address 0 means "no strokes".
fn strokeBlock(gpa: Allocator, records: []const []const u8) ![]u8 {
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(gpa);
    try body.appendSlice(gpa, &std.mem.toBytes(@as(u32, @intCast(records.len))));
    for (records) |r| try body.appendSlice(gpa, r);
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(gpa, &.{ 0, 0, 0, 0 });
    try out.appendSlice(gpa, &std.mem.toBytes(@as(u32, @intCast(body.items.len))));
    try out.appendSlice(gpa, body.items);
    return out.toOwnedSlice(gpa);
}

/// One framed record: `pen` at `+4`, and `list` (if any) at `+487`.
fn record(gpa: Allocator, pen: u32, list: ?[]const u8) ![]u8 {
    const list_bytes = list orelse "";
    const total = list_at + list_bytes.len + 26;
    const r = try gpa.alloc(u8, total);
    @memset(r, 0);
    std.mem.writeInt(u32, r[0..4], @intCast(total - 4), .little);
    std.mem.writeInt(u32, r[4..8], pen, .little);
    std.mem.writeInt(u32, r[list_len_at..][0..4], @intCast(list_bytes.len), .little);
    @memcpy(r[list_at..][0..list_bytes.len], list_bytes);
    return r;
}

/// A field list like the device's: 19 fields, `text` 13th, `rect` 5th.
fn fieldList(gpa: Allocator, text: []const u8, rect: []const u8) ![]u8 {
    const enc = std.base64.standard.Encoder;
    var out: std.ArrayList(u8) = .empty;
    for (0..19) |i| {
        const v: []const u8 = if (i == text_field) text else if (i == rect_field) rect else "0";
        const buf = try gpa.alloc(u8, enc.calcSize(v.len));
        defer gpa.free(buf);
        try out.appendSlice(gpa, enc.encode(buf, v));
        try out.append(gpa, ',');
    }
    return out.toOwnedSlice(gpa);
}

test "a text-box record yields its text and rectangle; strokes and other pens are skipped" {
    const gpa = testing.allocator;
    const list = try fieldList(gpa, "Très bien\nça va", "702,928,259,127");
    defer gpa.free(list);
    const stroke = try record(gpa, 1, null);
    defer gpa.free(stroke);
    const sticker = try record(gpa, 4, null);
    defer gpa.free(sticker);
    const box = try record(gpa, text_box_pen, list);
    defer gpa.free(box);
    const bytes = try strokeBlock(gpa, &.{ stroke, sticker, box });
    defer gpa.free(bytes);

    var got = try fromStrokes(gpa, .{ .slice = bytes }, 4, "702,928,259,127|");
    defer got.deinit();
    try testing.expectEqual(@as(usize, 1), got.boxes.len);
    try testing.expectEqualStrings("Très bien\nça va", got.boxes[0].text);
    try testing.expectEqual(Rect{ .x = 702, .y = 928, .w = 259, .h = 127 }, got.boxes[0].rect);
}

test "a box the page no longer lists in DISABLE is left out" {
    const gpa = testing.allocator;
    const kept = try fieldList(gpa, "kept", "10,20,30,40");
    defer gpa.free(kept);
    const stale = try fieldList(gpa, "deleted", "50,60,70,80");
    defer gpa.free(stale);
    const r1 = try record(gpa, text_box_pen, kept);
    defer gpa.free(r1);
    const r2 = try record(gpa, text_box_pen, stale);
    defer gpa.free(r2);
    const bytes = try strokeBlock(gpa, &.{ r1, r2 });
    defer gpa.free(bytes);

    var got = try fromStrokes(gpa, .{ .slice = bytes }, 4, "10,20,30,40|");
    defer got.deinit();
    try testing.expectEqual(@as(usize, 1), got.boxes.len);
    try testing.expectEqualStrings("kept", got.boxes[0].text);
}

test "a malformed list is no box; framing that does not walk is Corrupt" {
    const gpa = testing.allocator;
    const r = try record(gpa, text_box_pen, "not base64!,");
    defer gpa.free(r);
    const bytes = try strokeBlock(gpa, &.{r});
    defer gpa.free(bytes);
    var got = try fromStrokes(gpa, .{ .slice = bytes }, 4, null);
    defer got.deinit();
    try testing.expectEqual(@as(usize, 0), got.boxes.len);

    // The block claims two records but holds one.
    const broken = try gpa.dupe(u8, bytes);
    defer gpa.free(broken);
    std.mem.writeInt(u32, broken[8..12], 2, .little);
    try testing.expectError(error.Corrupt, fromStrokes(gpa, .{ .slice = broken }, 4, null));

    // A record running past the block end.
    const overrun = try gpa.dupe(u8, bytes);
    defer gpa.free(overrun);
    std.mem.writeInt(u32, overrun[12..16], 1 << 20, .little);
    try testing.expectError(error.Corrupt, fromStrokes(gpa, .{ .slice = overrun }, 4, null));
}
