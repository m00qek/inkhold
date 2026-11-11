//! The browser's side of Digest: what the app stored (`services/digest.zig`),
//! read for a person rather than a tablet. The app keeps where a digest came
//! from in its metadata JSON, in a shape that depends on the kind of source
//! (decompiled `SummaryDO`, and the rows the Nomad sent): this reads it into
//! one `Source`. What the browser changes, a comment and a category, is
//! `digest.applyWebEdit`.

const std = @import("std");
const digest = @import("digest.zig");

/// What a digest was taken from, by its `source_type`.
pub const Kind = enum {
    /// 1: a passage selected in a PDF or an EPUB.
    document,
    /// 2: handwriting on a notebook page, converted to text.
    note,
    /// 4: typed in the Digest app itself.
    manual,
    /// A type this server has not seen a tablet send.
    other,

    pub fn of(source_type: ?i64) Kind {
        return switch (source_type orelse return .other) {
            1 => .document,
            2 => .note,
            4 => .manual,
            else => .other,
        };
    }
};

pub const Source = struct {
    kind: Kind,
    /// The file's path under the tablet's storage root, as the app sent it;
    /// null for a manual entry or an empty path.
    path: ?[]const u8 = null,
    /// 1-based; null when the app did not say.
    page: ?i64 = null,
    /// A document's size in bytes when the passage was taken (`source_size`),
    /// so a file changed since can be told; null for a note, or when not said.
    size: ?u64 = null,
};

/// Where `d` came from. Metadata the app did not write, or wrote in a shape
/// this does not know, leaves out the page and keeps the rest.
pub fn sourceOf(arena: std.mem.Allocator, d: digest.Digest) Source {
    const kind = Kind.of(d.source_type);
    const path = if (d.source_path) |p| (if (p.len == 0) null else p) else null;
    const meta = metadataObject(arena, d.metadata);
    const page: ?i64 = switch (kind) {
        .document => documentPage(arena, meta),
        .note => notePage(meta),
        .manual, .other => null,
    };
    const size: ?u64 = if (kind == .document) documentSize(meta) else null;
    return .{ .kind = kind, .path = if (kind == .manual) null else path, .page = page, .size = size };
}

/// Who wrote what the digest quotes: the row's own `author`, else the one the
/// app copies into the metadata from the document; null when neither says.
pub fn authorOf(arena: std.mem.Allocator, d: digest.Digest) ?[]const u8 {
    if (nonEmpty(d.author)) |a| return a;
    const meta = metadataObject(arena, d.metadata) orelse return null;
    return switch (meta.get("author") orelse return null) {
        .string => |s| nonEmpty(s),
        else => null,
    };
}

/// The handwritten note the server can serve: a claimed upload (it holds a
/// reference to the blob) with a well-formed md5. Null otherwise.
pub fn servableNote(d: digest.Digest) ?[]const u8 {
    if (d.handwrite_inner_name == null) return null;
    const md5 = d.handwrite_md5 orelse return null;
    if (md5.len != 32) return null;
    for (md5) |c| if (!std.ascii.isHex(c)) return null;
    return md5;
}

// ---- internals ----

fn metadataObject(arena: std.mem.Allocator, metadata: ?[]const u8) ?std.json.ObjectMap {
    const text = metadata orelse return null;
    const v = std.json.parseFromSliceLeaky(std.json.Value, arena, text, .{}) catch return null;
    return switch (v) {
        .object => |o| o,
        else => null,
    };
}

/// A document's `document_location_data` is itself JSON text: a list of
/// `{chapter, page, startPosition, endPosition}`, page 0-based. The first
/// entry is where the passage starts.
fn documentPage(arena: std.mem.Allocator, meta: ?std.json.ObjectMap) ?i64 {
    const m = meta orelse return null;
    const text = switch (m.get("document_location_data") orelse return null) {
        .string => |s| s,
        else => return null,
    };
    const v = std.json.parseFromSliceLeaky(std.json.Value, arena, text, .{}) catch return null;
    const list = switch (v) {
        .array => |a| a,
        else => return null,
    };
    if (list.items.len == 0) return null;
    const first = switch (list.items[0]) {
        .object => |o| o,
        else => return null,
    };
    const page = switch (first.get("page") orelse return null) {
        .integer => |i| i,
        else => return null,
    };
    return if (page >= 0) page + 1 else null;
}

/// A document's `source_size`, a whole number of bytes.
fn documentSize(meta: ?std.json.ObjectMap) ?u64 {
    const m = meta orelse return null;
    return switch (m.get("source_size") orelse return null) {
        .integer => |i| if (i >= 0) @intCast(i) else null,
        else => null,
    };
}

/// A note's `note_page` is 1-based, sent as a string ("2").
fn notePage(meta: ?std.json.ObjectMap) ?i64 {
    const m = meta orelse return null;
    const page: i64 = switch (m.get("note_page") orelse return null) {
        .string => |s| std.fmt.parseInt(i64, s, 10) catch return null,
        .integer => |i| i,
        else => return null,
    };
    return if (page >= 1) page else null;
}

fn nonEmpty(s: ?[]const u8) ?[]const u8 {
    const v = s orelse return null;
    return if (std.mem.trim(u8, v, " \t\r\n").len == 0) null else v;
}

// ---- tests ----

const testing = std.testing;

/// The Nomad's rows, as the hub holds them.
const pdf_metadata =
    \\{"document_location_data":"[{\"chapter\":0,\"endPosition\":50,\"page\":0,\"startPosition\":26}]","source_size":407277,"unique_identifier":"c1ad0a49d44c62dc94b8f71448b3da5a","author":"john"}
;
const note_metadata =
    \\{"author":"","note_page":"2","note_fileId":"F20261109060649314933DT231jzqIRw9","note_pageId":"P20261109062932431207F1CB7AuJNdF7","unique_identifier":"75d4b7d10094123e92ec7673753bbc2c"}
;

test "a PDF passage: its path, its page 1-based, the document's author" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const d: digest.Digest = .{
        .source_type = 1,
        .source_path = "MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf",
        .metadata = pdf_metadata,
    };
    const s = sourceOf(a, d);
    try testing.expectEqual(Kind.document, s.kind);
    try testing.expectEqualStrings(d.source_path.?, s.path.?);
    try testing.expectEqual(@as(?i64, 1), s.page);
    try testing.expectEqual(@as(?u64, 407277), s.size);
    try testing.expectEqualStrings("john", authorOf(a, d).?);
}

test "notebook handwriting: its page as the app numbers it; an empty author is none" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const d: digest.Digest = .{ .source_type = 2, .source_path = "Note/20261109_060644.note", .metadata = note_metadata };
    const s = sourceOf(a, d);
    try testing.expectEqual(Kind.note, s.kind);
    try testing.expectEqual(@as(?i64, 2), s.page);
    try testing.expectEqual(@as(?[]const u8, null), authorOf(a, d));
}

test "a manual entry has no source; unknown types and odd metadata keep what they can" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const manual = sourceOf(a, .{ .source_type = 4, .source_path = "", .metadata = "{\"unique_identifier\":\"x\"}" });
    try testing.expectEqual(Kind.manual, manual.kind);
    try testing.expectEqual(@as(?[]const u8, null), manual.path);

    const unknown = sourceOf(a, .{ .source_type = 3, .source_path = "Document/a.epub" });
    try testing.expectEqual(Kind.other, unknown.kind);
    try testing.expectEqualStrings("Document/a.epub", unknown.path.?);

    for ([_][]const u8{ "not json", "[1,2]", "{\"document_location_data\":\"[]\"}", "{\"document_location_data\":\"[{\\\"page\\\":-1}]\"}", "{\"document_location_data\":7}" }) |m| {
        const s = sourceOf(a, .{ .source_type = 1, .source_path = "Document/b.pdf", .metadata = m });
        try testing.expectEqual(Kind.document, s.kind);
        try testing.expectEqual(@as(?i64, null), s.page);
    }
    try testing.expectEqual(@as(?i64, null), sourceOf(a, .{ .source_type = 2, .metadata = "{\"note_page\":\"0\"}" }).page);
    try testing.expectEqual(@as(?i64, null), sourceOf(a, .{ .source_type = 2, .metadata = "{\"note_page\":\"two\"}" }).page);
    try testing.expectEqual(@as(?i64, 3), sourceOf(a, .{ .source_type = 2, .metadata = "{\"note_page\":3}" }).page);
}

test "a handwritten note is servable only once the server holds it" {
    const md5 = "245354713d4c121a2368d9295f6379ca";
    try testing.expectEqualStrings(md5, servableNote(.{ .handwrite_md5 = md5, .handwrite_inner_name = "d2a5342574eb6718" }).?);
    // The md5 the tablet reports before its upload is claimed.
    try testing.expectEqual(@as(?[]const u8, null), servableNote(.{ .handwrite_md5 = md5 }));
    try testing.expectEqual(@as(?[]const u8, null), servableNote(.{ .handwrite_md5 = "", .handwrite_inner_name = "x" }));
    try testing.expectEqual(@as(?[]const u8, null), servableNote(.{ .handwrite_md5 = "../../../../etc/passwd/xxxxxxxxx", .handwrite_inner_name = "x" }));
}
