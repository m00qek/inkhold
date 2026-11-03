//! Index-backed reads: page refs, aspect, layers and summaries with no file I/O.

const std = @import("std");
const Entry = @import("files.zig").Entry;
const noteindex = @import("note_index.zig");
const spdindex = @import("spd_index.zig");
const controlplane = @import("controlplane.zig");
const ControlPlaneService = controlplane.ControlPlaneService;
const PageRefVO = controlplane.PageRefVO;
const LayerVO = controlplane.LayerVO;
const AspectVO = controlplane.AspectVO;
const fileTypeFor = controlplane.fileTypeFor;
const fallbackFirst = controlplane.fallbackFirst;
const fallbackPage = controlplane.fallbackPage;
const controlplane_meta = @import("controlplane_meta.zig");

/// Note-level facts from `note_index`, or null when no current row exists.
/// `px_per_mm` is resolved here because `columnText` borrows the row.
pub const IndexRow = struct {
    indexable: bool,
    page_count: i64,
    /// `.note`: device panel; `.pdf`: page 1's box in points
    /// (`pdf_index.zig`). Zero when unmeasured.
    width: i64,
    height: i64,
    /// The 4-byte type marker ("note", or "mark"); null for the ASA family
    /// and pre-v6 rows. By value because the row is finalized on return.
    filetype: ?[4]u8,
    recognized_page_count: i64,
    px_per_mm: ?f32,
    /// Cover memo: NULL = none, 0 = undecodable, positive = pixel dims.
    cover_w: ?i64,
    cover_h: ?i64,
    /// `.spd` thumbnail dims via LEFT JOIN on current `spd_index`; same
    /// NULL/0 contract as the cover.
    spd_thumb_w: ?i64,
    spd_thumb_h: ?i64,
    /// `.spd` canvas dims. The embedded thumbnail is a fixed 600x800 portrait
    /// that letterboxes, so tile aspect comes from here.
    spd_surface_w: ?i64,
    spd_surface_h: ?i64,
};

pub fn indexRow(self: ControlPlaneService, md5: []const u8) !?IndexRow {
    // The LEFT JOIN keeps this one single-row lookup per note per listing.
    var r = (try self.files.db.row(
        "SELECT n.indexable, n.page_count, n.recognized_page_count, n.equipment, n.width, " ++
            "n.cover_w, n.cover_h, sp.thumb_w, sp.thumb_h, sp.surface_w, sp.surface_h, n.filetype, n.height FROM note_index n " ++
            "LEFT JOIN spd_index sp ON sp.blob_md5 = n.blob_md5 AND sp.index_version = ?3 " ++
            "WHERE n.blob_md5 = ?1 AND n.index_version = ?2;",
        &.{ .{ .text = md5 }, .{ .int = noteindex.index_version }, .{ .int = spdindex.index_version } },
    )) orelse return null;
    defer r.finalize();
    return .{
        .indexable = r.int(0) != 0,
        .page_count = r.int(1),
        .width = r.int(4),
        .height = r.int(12),
        .filetype = blk: {
            if (r.isNull(11)) break :blk null;
            const t = r.text(11);
            if (t.len != 4) break :blk null; // not a marker we wrote
            break :blk [4]u8{ t[0], t[1], t[2], t[3] };
        },
        .recognized_page_count = r.int(2),
        .px_per_mm = controlplane_meta.pxPerMmFor(
            if (r.isNull(3)) null else r.text(3),
            r.int(4),
        ),
        .cover_w = if (r.isNull(5)) null else r.int(5),
        .cover_h = if (r.isNull(6)) null else r.int(6),
        .spd_thumb_w = if (r.isNull(7)) null else r.int(7),
        .spd_thumb_h = if (r.isNull(8)) null else r.int(8),
        .spd_surface_w = if (r.isNull(9)) null else r.int(9),
        .spd_surface_h = if (r.isNull(10)) null else r.int(10),
    };
}

/// The listing row's aspect, or null to omit. `.note`: a decodable cover,
/// else page 0's effective dims. Otherwise: `.spd` surface, then thumb, then
/// the row's own width/height (PDF). Not gated on `spd_index.indexable`: a
/// corrupt layer tree must not lose the geometry.
pub fn aspectOf(row: IndexRow, first_page: ?PageRefVO) ?AspectVO {
    if (row.indexable) {
        if (positivePair(row.cover_w, row.cover_h)) |a| return a;
        const p = first_page orelse return null;
        return positivePair(p.width, p.height);
    }
    // A `.pdf`'s shape (`pdf_index.zig`); `indexable` means "real `.note`".
    return positivePair(row.spd_surface_w, row.spd_surface_h) orelse
        positivePair(row.spd_thumb_w, row.spd_thumb_h) orelse
        positivePair(row.width, row.height);
}

/// Both known and positive, or null.
pub fn positivePair(w: ?i64, h: ?i64) ?AspectVO {
    const ww = w orelse return null;
    const hh = h orelse return null;
    return if (ww > 0 and hh > 0) .{ .w = ww, .h = hh } else null;
}

/// `indexRow`, backfilling only when nothing comes back. Reads first because
/// `backfill`'s gate is the same lookup, and doubling it on every warm listing
/// costs latency under the global `db_lock`.
pub fn indexRowEnsuring(self: ControlPlaneService, md5: []const u8) !?IndexRow {
    if (try indexRow(self, md5)) |row| return row;
    backfill(self, md5); // cold or stale: parse (ranged, unlocked) and store
    return indexRow(self, md5);
}

/// Lazy backfill: repairs a missing or stale index row on the read path, so
/// `index_version` bumps need no migration. Best-effort: failure falls through
/// to the placeholder page. A single-row `SELECT` once indexed.
pub fn backfill(self: ControlPlaneService, md5: []const u8) void {
    noteindex.ensureIndexed(
        self.files.gpa,
        self.files.io,
        self.files.db,
        self.files.blobs,
        md5,
        std.Io.Clock.real.now(self.files.io).toSeconds(),
    ) catch {};
}

/// One page's ref from `note_page_index`, with its effective (orientation
/// applied) dims and layer panel. Used for a listing's page 0.
pub fn pageRefAt(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8, n: u64) !?PageRefVO {
    var r = (try self.files.db.row(
        "SELECT content_hash, width, height, text_hash, layers, links_hash FROM note_page_index " ++
            "WHERE blob_md5 = ?1 AND page_index = ?2;",
        &.{ .{ .text = md5 }, .{ .int = @intCast(n) } },
    )) orelse return null;
    defer r.finalize();
    return .{
        .index = @intCast(n),
        .hash = try arena.dupe(u8, r.text(0)),
        .width = r.int(1),
        .height = r.int(2),
        .textHash = if (r.isNull(3)) null else try arena.dupe(u8, r.text(3)),
        .layers = try layerVOsFromBlob(arena, r.blob(4)),
        .linksHash = if (r.isNull(5)) null else try arena.dupe(u8, r.text(5)),
    };
}

/// Every page of a note in `page_index` order, one statement, no file I/O.
pub fn pageRefsFromIndex(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8) ![]const PageRefVO {
    var out: std.ArrayList(PageRefVO) = .empty;
    var s = try self.files.db.prepare(
        "SELECT page_index, content_hash, width, height, text_hash, layers, source_page, links_hash, has_ink " ++
            "FROM note_page_index " ++
            "WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, md5);
    while (try s.step()) {
        try out.append(arena, .{
            .index = s.columnInt(0),
            .hash = try arena.dupe(u8, s.columnText(1)),
            .width = s.columnInt(2),
            .height = s.columnInt(3),
            .textHash = if (s.columnIsNull(4)) null else try arena.dupe(u8, s.columnText(4)),
            .layers = try layerVOsFromBlob(arena, s.columnBlob(5)),
            // Omitted when `index + 1`; 0 (pre-v7, no number) is omitted too.
            .sourcePage = blk: {
                const n = s.columnInt(6);
                break :blk if (n == 0 or n == s.columnInt(0) + 1) null else n;
            },
            .linksHash = if (s.columnIsNull(7)) null else try arena.dupe(u8, s.columnText(7)),
            // NULL ("not yet looked") is omitted, not sent as false.
            .hasInk = if (s.columnIsNull(8)) null else s.columnInt(8) != 0,
        });
    }
    return out.items;
}

/// The one serializer from a packed `layers` blob to panel VOs, shared by
/// the page list and listing rows. Null for an empty or malformed blob.
pub fn layerVOsFromBlob(arena: std.mem.Allocator, blob: []const u8) !?[]const LayerVO {
    var buf: [noteindex.max_layers]noteindex.LayerRecord = undefined;
    const recs = noteindex.unpackLayerRecords(blob, &buf) catch return null;
    if (recs.len == 0) return null;
    const out = try arena.alloc(LayerVO, recs.len);
    for (recs, out) |rec, *vo| {
        vo.* = .{
            .slot = @tagName(rec.ref.slot),
            .name = try arena.dupe(u8, rec.name), // rec borrows statement memory
            .visible = !rec.ref.hidden,
            .isCurrent = rec.is_current,
        };
    }
    return out;
}

/// `noteMeta`'s page list; non-`.note` or unindexable blobs get one
/// placeholder page.
pub fn pageRefsOf(self: ControlPlaneService, arena: std.mem.Allocator, entry: Entry) ![]const PageRefVO {
    if (entry.md5) |md5| {
        if (try indexRowEnsuring(self, md5)) |row| {
            if (row.indexable and row.page_count > 0) {
                const refs = try pageRefsFromIndex(self, arena, md5);
                if (refs.len > 0) return refs;
            }
        }
    }
    const one = try arena.alloc(PageRefVO, 1);
    one[0] = try fallbackPage(arena, entry.md5, 0);
    return one;
}

/// Everything a listing row needs about one file.
pub const Summary = struct {
    page: PageRefVO,
    count: i64,
    file_type: []const u8,
    has_recognized_text: bool,
    /// See `EntryVO.thumbAspect`. Independent of the placeholder page.
    aspect: ?AspectVO,
};

pub fn summarize(self: ControlPlaneService, arena: std.mem.Allocator, entry: Entry) !Summary {
    var indexable = false;
    var marker: ?[4]u8 = null;
    var count: i64 = 0;
    var has_text = false;
    var first: ?PageRefVO = null;
    var aspect: ?AspectVO = null;

    if (entry.md5) |md5| {
        if (try indexRowEnsuring(self, md5)) |row| {
            indexable = row.indexable;
            marker = row.filetype;
            count = row.page_count;
            has_text = row.recognized_page_count > 0;
            if (indexable and count > 0) first = try pageRefAt(self, arena, md5, 0);
            aspect = aspectOf(row, first);
        }
    }

    const file_type = try fileTypeFor(arena, indexable, marker, entry.name);

    if (first) |p| return .{
        .page = p,
        .count = count,
        .file_type = file_type,
        .has_recognized_text = has_text,
        .aspect = aspect,
    };
    const fb = try fallbackFirst(arena, entry.md5);
    return .{
        .page = fb.page,
        // The row's count wins: a `.pdf` lands here but its probe filled
        // `page_count`. `.spd`/`.txt` have 0 and get 1.
        .count = if (count > 0) count else fb.count,
        .file_type = file_type,
        .has_recognized_text = has_text,
        .aspect = aspect,
    };
}
