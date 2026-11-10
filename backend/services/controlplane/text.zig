//! Recognised text and template links for one page, read from the index.

const std = @import("std");
const sn = @import("supernote");
const blobstore = @import("../../store/blobs.zig");
const blob_source = @import("../../store/blob_source.zig");
const controlplane = @import("../controlplane.zig");
const ControlPlaneService = controlplane.ControlPlaneService;
const WordVO = controlplane.WordVO;
const PageText = controlplane.PageText;
const LinkVO = controlplane.LinkVO;
const PageLinks = controlplane.PageLinks;
const allowedLinkScheme = controlplane.allowedLinkScheme;
const controlplane_index = @import("index.zig");
const controlplane_meta = @import("meta.zig");

/// `GET /note/{id}/page/{n}/text` — the stored text and its `text_hash`: the
/// transcript, plus any typed text boxes. Null when missing, not owned, or the
/// page has no text, so the handler 404s it like a stale `?v=`.
pub fn pageText(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, n: u64) !?PageText {
    return pageTextIn(self, arena, user_id, id, n, .live);
}

/// `GET /api/controlplane/bin/note/{id}/page/{n}/text` — the same for a trashed
/// file, keyed by its current md5.
pub fn binPageText(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, n: u64) !?PageText {
    return pageTextIn(self, arena, user_id, id, n, .trashed);
}

fn pageTextIn(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, n: u64, scope: controlplane_meta.ReadScope) !?PageText {
    const entry = (try controlplane_meta.lookup(self, scope, user_id, id)) orelse return null;
    defer entry.deinit(self.files.gpa);
    if (entry.is_folder) return null;
    const md5 = entry.md5 orelse return null;
    return pageTextForMd5(self, arena, md5, n);
}

/// `pageText` keyed by a retained version's md5; the caller gates ownership.
/// The per-version handler ignores `.hash` since `{md5}` pins the blob.
pub fn pageTextForMd5(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8, n: u64) !?PageText {
    if (md5.len != blobstore.md5_hex_len) return null;

    controlplane_index.backfill(self, md5); // a cold blob has no rows to read yet

    var r = (try self.files.db.row(
        "SELECT text_hash, text, recogn_offset, recogn_length FROM note_page_index " ++
            "WHERE blob_md5 = ?1 AND page_index = ?2 AND text_hash IS NOT NULL;",
        &.{ .{ .text = md5 }, .{ .int = @intCast(n) } },
    )) orelse return null;
    defer r.finalize();

    const stored = r.text(0);
    if (stored.len != 32) return null; // a malformed row is not a servable version

    var out: PageText = .{ .hash = undefined, .vo = .{} };
    @memcpy(&out.hash, stored);
    // NULL `text` with a `text_hash` is real: the indexer keeps the range when
    // the block will not decode.
    if (!r.isNull(1)) out.vo.text = try arena.dupe(u8, r.text(1));

    // Word boxes: one KB-scale ranged read of the stored `RECOGNTEXT` range.
    var recogn: ?[]const u8 = null;
    if (!r.isNull(2) and !r.isNull(3)) recogn = recognAt(self, arena, md5, r.int(2), r.int(3)) catch null;
    const recognised: []const WordVO = if (recogn) |c| (wordsFrom(arena, c) catch null) orelse &.{} else &.{};

    // Typed text boxes, each one "word" covering its whole box. The indexer
    // folds typed text into `text_hash`, so a hash that is not the transcript's
    // own md5 says the page has some; only then is the note read again.
    const typed_present = if (recogn) |c| !std.mem.eql(u8, &md5Hex(c), &out.hash) else true;
    const typed: []const WordVO = if (typed_present) (typedWords(self, arena, md5, n) catch null) orelse &.{} else &.{};

    if (recognised.len + typed.len > 0) out.vo.words = try std.mem.concat(arena, WordVO, &.{ recognised, typed });
    return out;
}

fn md5Hex(data: []const u8) [32]u8 {
    var digest: [std.crypto.hash.Md5.digest_length]u8 = undefined;
    std.crypto.hash.Md5.hash(data, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

/// Page `n`'s text boxes as words in millimetres, by the note's own scale
/// (`meta.pxPerMm`). Null for unmeasured hardware: a misplaced mark is worse
/// than none. One metadata parse and a few ranged reads of the strokes.
fn typedWords(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8, n: u64) !?[]const WordVO {
    const row = (try controlplane_index.indexRow(self, md5)) orelse return null;
    const scale = row.px_per_mm orelse return null;
    var bs = try blob_source.BlobSource.init(self.files.blobs, md5);
    var note = try sn.parseSource(arena, bs.source());
    defer note.deinit();
    if (n >= note.pages.len) return null;
    var boxes = try sn.textbox.forParsedPage(arena, note.source, note.pages[@intCast(n)]);
    defer boxes.deinit();
    if (boxes.boxes.len == 0) return null;

    const out = try arena.alloc(WordVO, boxes.boxes.len);
    for (boxes.boxes, out) |b, *vo| vo.* = .{
        .text = try arena.dupe(u8, b.text),
        .xMm = @as(f32, @floatFromInt(b.rect.x)) / scale,
        .yMm = @as(f32, @floatFromInt(b.rect.y)) / scale,
        .wMm = @as(f32, @floatFromInt(b.rect.w)) / scale,
        .hMm = @as(f32, @floatFromInt(b.rect.h)) / scale,
    };
    return out;
}

/// Ceiling on a `RECOGNTEXT` read; the blob is device-controlled.
const max_recogn_bytes: i64 = 1 << 20;

/// The stored `RECOGNTEXT` range. Best-effort: the caller turns any error
/// into "no words".
fn recognAt(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8, offset: i64, length: i64) !?[]const u8 {
    if (length <= 0 or length > max_recogn_bytes or offset < 0) return null;
    const buf = try arena.alloc(u8, @intCast(length));
    return try self.files.blobs.readRange(md5, @intCast(offset), @intCast(length), buf);
}

/// `RECOGNTEXT` content into words, in millimetres.
fn wordsFrom(arena: std.mem.Allocator, content: []const u8) !?[]const WordVO {
    var rec = try sn.recognition.parse(arena, content);
    defer rec.deinit();

    const placed = try rec.placedWords(arena);
    if (placed.len == 0) return null; // omitted, not an empty array

    const out = try arena.alloc(WordVO, placed.len);
    for (placed, out) |w, *vo| {
        vo.* = .{
            // Duped: labels borrow `rec`, deinit'd before return.
            .text = try arena.dupe(u8, w.label),
            .xMm = w.box.x,
            .yMm = w.box.y,
            .wMm = w.box.width,
            .hMm = w.box.height,
        };
    }
    return out;
}

/// `GET /note/{id}/page/{n}/links` — the page's links and `links_hash`. Null
/// when missing, not owned, or the page has no `EXTERNALLINKINFO`.
pub fn pageLinks(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, n: u64) !?PageLinks {
    const entry = (try controlplane_meta.lookup(self, .live, user_id, id)) orelse return null;
    defer entry.deinit(self.files.gpa);
    if (entry.is_folder) return null;
    const md5 = entry.md5 orelse return null;
    return pageLinksForMd5(self, arena, md5, n);
}

/// `pageLinks` keyed by blob md5: one ranged read of the page's block.
/// `page_count` comes along to drop jumps past the last page.
pub fn pageLinksForMd5(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8, n: u64) !?PageLinks {
    if (md5.len != blobstore.md5_hex_len) return null;

    controlplane_index.backfill(self, md5); // a cold blob has no rows to read yet

    var r = (try self.files.db.row(
        "SELECT p.links_hash, p.links_offset, p.links_length, i.page_count " ++
            "FROM note_page_index p JOIN note_index i ON i.blob_md5 = p.blob_md5 " ++
            "WHERE p.blob_md5 = ?1 AND p.page_index = ?2 AND p.links_hash IS NOT NULL;",
        &.{ .{ .text = md5 }, .{ .int = @intCast(n) } },
    )) orelse return null;
    defer r.finalize();

    const stored = r.text(0);
    if (stored.len != 32) return null; // a malformed row is not a servable version

    var out: PageLinks = .{ .hash = undefined, .vo = .{} };
    @memcpy(&out.hash, stored);
    if (r.isNull(1) or r.isNull(2)) return out; // hash without a range: nothing to read
    out.vo.links = (linksAt(self, arena, md5, r.int(1), r.int(2), r.int(3)) catch null) orelse &.{};
    return out;
}

/// Ceiling on an `EXTERNALLINKINFO` read (the worst page seen is ~11 KB).
const max_links_bytes: i64 = 1 << 20;

/// Cap on links served per page; each becomes a focusable anchor.
const max_links_per_page: usize = 1024;

/// Decodes the stored `EXTERNALLINKINFO` range. Best-effort: errors mean "no
/// links". Converts 1-based targets to 0-based (dropping out-of-range ones),
/// `none` to `page = -1`, and applies the scheme allowlist here too because
/// export reads this endpoint. Empty rects are dropped.
fn linksAt(
    self: ControlPlaneService,
    arena: std.mem.Allocator,
    md5: []const u8,
    offset: i64,
    length: i64,
    page_count: i64,
) !?[]const LinkVO {
    if (length <= 0 or length > max_links_bytes or offset < 0) return null;

    const buf = try arena.alloc(u8, @intCast(length));
    const content = try self.files.blobs.readRange(md5, @intCast(offset), @intCast(length), buf);

    var parsed = try sn.links.parse(arena, content);
    defer parsed.deinit();

    var out: std.ArrayList(LinkVO) = .empty;
    for (parsed.items) |l| {
        if (out.items.len == max_links_per_page) break;
        if (l.w <= 0 or l.h <= 0) continue;
        const target: i64 = switch (l.kind) {
            .web => -1,
            .internal => blk: {
                if (l.target_page == 0 or l.target_page > page_count) continue;
                break :blk @as(i64, l.target_page) - 1;
            },
        };
        if (target < 0 and !allowedLinkScheme(l.uri)) continue;
        try out.append(arena, .{
            .x = @floatFromInt(l.x),
            .y = @floatFromInt(l.y),
            .w = @floatFromInt(l.w),
            .h = @floatFromInt(l.h),
            .page = target,
            // Duped: the record borrows `parsed`, deinit'd before return.
            .uri = try arena.dupe(u8, l.uri),
        });
    }
    if (out.items.len == 0) return null;
    return out.items;
}
