//! Recognised text and template links for one page, read from the index.

const std = @import("std");
const sn = @import("supernote");
const blobstore = @import("../../store/blobs.zig");
const controlplane = @import("../controlplane.zig");
const ControlPlaneService = controlplane.ControlPlaneService;
const WordVO = controlplane.WordVO;
const PageText = controlplane.PageText;
const LinkVO = controlplane.LinkVO;
const PageLinks = controlplane.PageLinks;
const allowedLinkScheme = controlplane.allowedLinkScheme;
const freeEntry = controlplane.freeEntry;
const controlplane_index = @import("index.zig");
const controlplane_meta = @import("meta.zig");

/// `GET /note/{id}/page/{n}/text` — the stored transcript and its `text_hash`.
/// Null when missing, not owned, or not recognized (`recogn_status != 1`), so
/// the handler 404s it like a stale `?v=`.
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
    defer freeEntry(self.files.gpa, entry);
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
            "WHERE blob_md5 = ?1 AND page_index = ?2 AND recogn_status = 1 AND text_hash IS NOT NULL;",
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
    if (!r.isNull(2) and !r.isNull(3)) {
        const offset = r.int(2);
        const length = r.int(3);
        out.vo.words = wordsAt(self, arena, md5, offset, length) catch null;
    }
    return out;
}

/// Ceiling on a `RECOGNTEXT` read; the blob is device-controlled.
const max_recogn_bytes: i64 = 1 << 20;

/// Parses the stored `RECOGNTEXT` range into words, in millimetres.
/// Best-effort: the caller turns any error into "no words".
fn wordsAt(
    self: ControlPlaneService,
    arena: std.mem.Allocator,
    md5: []const u8,
    offset: i64,
    length: i64,
) !?[]const WordVO {
    if (length <= 0 or length > max_recogn_bytes or offset < 0) return null;

    const buf = try arena.alloc(u8, @intCast(length));
    const content = try self.files.blobs.readRange(md5, @intCast(offset), @intCast(length), buf);

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
    defer freeEntry(self.files.gpa, entry);
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
