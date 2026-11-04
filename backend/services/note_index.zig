//! The `.note` blob index: parse a container once and keep the per-page facts
//! the hot read paths need in `note_index` + `note_page_index`.

const std = @import("std");
const repeat = @import("../util/repeat.zig").repeat;
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const blob_source = @import("../store/blob_source.zig");
const thumbnail = @import("thumbnail.zig");
const derivesearch = @import("derive_search.zig");
const inkscan = @import("ink_scan.zig");
const sn = @import("supernote");

const Allocator = std.mem.Allocator;

/// Bump when anything the client caches under `(md5, index_version)` changes
/// (it is the browser's cache key); stale rows re-parse lazily. A schema change
/// that leaves `terms/`/`text/` byte-identical takes no bump. Never reuse a number.
pub const index_version: i64 = 16;

/// Re-exported so the indexer and `page_payload.serialize` share one emit list.
pub const LayerRef = sn.page_payload.LayerRef;
pub const max_layers = sn.page_payload.max_layers;

const note_index_parse = @import("note_index/parse.zig");
const note_index_serve = @import("note_index/serve.zig");

// ---- parsing a container into rows (`note_index/parse.zig`) ----
pub const parseBlob = note_index_parse.parseBlob;
pub const parseBlobSource = note_index_parse.parseBlobSource;
pub const pageContentHash = note_index_parse.pageContentHash;
pub const packLayers = note_index_parse.packLayers;
pub const LayerRecord = note_index_parse.LayerRecord;
pub const unpackLayerRecords = note_index_parse.unpackLayerRecords;
pub const unpackLayers = note_index_parse.unpackLayers;
pub const layer_rec_head_size = note_index_parse.layer_rec_head_size;
pub const max_layer_name = note_index_parse.max_layer_name;
pub const max_layer_rec_size = note_index_parse.max_layer_rec_size;

// ---- serving pages from the index (`note_index/serve.zig`) ----
pub const SliceSource = note_index_serve.SliceSource;
pub const NoteHeader = note_index_serve.NoteHeader;
pub const noteHeader = note_index_serve.noteHeader;
pub const max_bg_hash = note_index_serve.max_bg_hash;
pub const PagePlan = note_index_serve.PagePlan;
pub const pagePlan = note_index_serve.pagePlan;
pub const TemplateLocation = note_index_serve.TemplateLocation;
pub const templateLocation = note_index_serve.templateLocation;
pub const streamPage = note_index_serve.streamPage;
pub const serializeFromIndex = note_index_serve.serializeFromIndex;

/// A layer as stored: the wire ref plus panel-only facts `noteMeta` serves.
/// `name` is empty when the page has no usable `LAYERINFO`.
pub const IndexedLayer = struct {
    ref: LayerRef,
    name: []const u8 = "",
    is_current: bool = false,
};

pub const Error = error{
    /// A stored range does not fit the bytes it is read from.
    BadRange,
    /// The `layers` blob is not a whole number of records, or holds too many.
    BadLayerBlob,
    /// No current index row for this blob (or it is marked unindexable).
    NotIndexed,
};

// ---- parsed shape ----

pub const NoteRow = struct {
    page_count: u32 = 0,
    signature: ?[]const u8 = null,
    signature_version: u32 = 0,
    /// 4-byte file-type marker: "note" or "mark" (PDF annotation). NULL for the
    /// original/ASA family, whose signature starts at offset 0.
    filetype: ?[]const u8 = null,
    equipment: ?[]const u8 = null,
    /// Base (portrait) dims; per-page effective dims are on `PageRow`.
    width: u32 = 0,
    height: u32 = 0,
    /// 0 = RATTA_RLE, 1 = RATTA_RLE X2 (highres grayscale).
    rle_variant: u8 = 0,
    recogn_type: ?[]const u8 = null,
    recogn_language: ?[]const u8 = null,
    recognized_page_count: u32 = 0,
    /// The cover image's own pixel dims. NULL = no cover; 0 = present but
    /// undecodable (still served). Mirrors `spd_index.thumb_w/thumb_h`.
    cover_w: ?u32 = null,
    cover_h: ?u32 = null,
    /// Cover bytes' location inside the blob (offset past the 4-byte length
    /// prefix) and sniffed MIME; the serve path streams from here. NULL in
    /// lockstep with `cover_w`. Covers over `thumbnail.max_cover_bytes` are
    /// recorded as none. `cover_mime` is a static string.
    cover_offset: ?u64 = null,
    cover_length: ?u32 = null,
    cover_mime: ?[]const u8 = null,
};

pub const PageRow = struct {
    /// Position in the container, 0-based; the addressing key.
    page_index: u32,
    /// The footer `PAGE<n>` number, 1-based, 0 if absent. Differs from
    /// `page_index + 1` for a `.mark`, which stores only annotated pages under
    /// their PDF page numbers.
    source_page: u32 = 0,
    /// The browser's immutable `?v=` cache key.
    content_hash: [32]u8,
    /// Effective dims (orientation applied); both the SNPG decode geometry and
    /// the `noteMeta` page box.
    width: u32,
    height: u32,
    /// Emit order (LAYERINFO minus deleted, fallback LAYERSEQ); these ranges
    /// concatenated after an SNPG header are the page.
    layers: []const IndexedLayer,
    recogn_status: u8 = 0,
    /// md5 of the raw `RECOGNTEXT` block; null unless `recogn_status == 1`.
    text_hash: ?[32]u8 = null,
    recogn_offset: ?u32 = null,
    recogn_length: ?u32 = null,
    /// `EXTERNALLINKINFO` range and md5, null together. Only pages rasterised
    /// from an imported PDF template have links; the range is stored rather than
    /// the records (one page can hold tens of thousands).
    links_offset: ?u32 = null,
    links_length: ?u32 = null,
    links_hash: ?[32]u8 = null,
    /// `recognition.plainText()`; null when the page has no finished text.
    text: ?[]const u8 = null,
    /// `PAGESTYLEMD5` of a custom raster-image template background; the resolve
    /// key for `GET /note/{id}/template/{hash}`. NULL otherwise.
    bg_hash: ?[]const u8 = null,
    /// See `ink_scan.pageHasInk`; null means unknown and is retried. A flag, not
    /// a count: the scan stops at the first stroke.
    has_ink: ?bool = null,
};

/// Owns its memory (no borrow from the `.note` bytes), so the buffer can be
/// freed before the DB lock is taken.
pub const Parsed = struct {
    arena: std.heap.ArenaAllocator,
    /// False for a non-`.note` blob; recorded so it is not re-parsed every read.
    indexable: bool,
    note: NoteRow,
    pages: []const PageRow,

    pub fn deinit(self: *Parsed) void {
        self.arena.deinit();
    }
};

/// The `.note` page source for `derive_search`. Pages with no finished
/// transcript are skipped (common: devices sync before recognition finishes).
pub const Pages = struct {
    p: *const Parsed,
    i: usize = 0,

    pub fn init(p: *const Parsed) Pages {
        return .{ .p = p };
    }

    pub fn next(self: *Pages) !?derivesearch.Page {
        while (self.i < self.p.pages.len) {
            const page = self.p.pages[self.i];
            self.i += 1;
            if (page.text) |t| return .{ .ordinal = page.page_index, .text = t };
        }
        return null;
    }
};

// ---- write: inside the caller's transaction ----

// The upsert below deliberately resets none of `pdf_text`, `pdf_probe`,
// `txt_index`: the tail delete is scoped to `kind = 0`, and `pdf_index.needsProbe`
// treats "ok with page_count 0" as outstanding instead.
const upsert_note_sql =
    \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, signature,
    \\                       signature_version, equipment, width, height, rle_variant,
    \\                       recogn_type, recogn_language, recognized_page_count, indexed_at,
    \\                       cover_w, cover_h, cover_offset, cover_length, cover_mime, filetype)
    \\VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
    \\ON CONFLICT(blob_md5) DO UPDATE SET
    \\  index_version=excluded.index_version, indexable=excluded.indexable,
    \\  page_count=excluded.page_count, signature=excluded.signature,
    \\  signature_version=excluded.signature_version, equipment=excluded.equipment,
    \\  width=excluded.width, height=excluded.height, rle_variant=excluded.rle_variant,
    \\  recogn_type=excluded.recogn_type, recogn_language=excluded.recogn_language,
    \\  recognized_page_count=excluded.recognized_page_count, indexed_at=excluded.indexed_at,
    \\  cover_w=excluded.cover_w, cover_h=excluded.cover_h,
    \\  cover_offset=excluded.cover_offset, cover_length=excluded.cover_length,
    \\  cover_mime=excluded.cover_mime, filetype=excluded.filetype;
;

const upsert_page_sql =
    \\INSERT INTO note_page_index(blob_md5, page_index, content_hash, width, height, layers,
    \\                            recogn_status, text_hash, recogn_offset, recogn_length, text, bg_hash,
    \\                            source_page, links_offset, links_length, links_hash, has_ink)
    \\VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
    \\ON CONFLICT(blob_md5, page_index) DO UPDATE SET
    \\  content_hash=excluded.content_hash, width=excluded.width, height=excluded.height,
    \\  layers=excluded.layers, recogn_status=excluded.recogn_status,
    \\  text_hash=excluded.text_hash, recogn_offset=excluded.recogn_offset,
    \\  recogn_length=excluded.recogn_length, text=excluded.text, bg_hash=excluded.bg_hash,
    \\  source_page=excluded.source_page, links_offset=excluded.links_offset,
    \\  links_length=excluded.links_length, links_hash=excluded.links_hash,
    \\  has_ink=excluded.has_ink;
;

/// One page row. `buf` is scratch for `packLayers`.
fn upsertPage(db: sqlite.Db, blob_md5: []const u8, page: PageRow, buf: []u8) !void {
    var s = try db.prepare(upsert_page_sql);
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, page.page_index);
    s.bindText(3, &page.content_hash);
    s.bindInt(4, page.width);
    s.bindInt(5, page.height);
    s.bindBlob(6, packLayers(buf, page.layers));
    s.bindInt(7, page.recogn_status);
    if (page.text_hash) |*h| s.bindText(8, h) else s.bindNull(8);
    s.bindIntOpt(9, if (page.recogn_offset) |v| @intCast(v) else null);
    s.bindIntOpt(10, if (page.recogn_length) |v| @intCast(v) else null);
    s.bindTextOpt(11, page.text);
    s.bindTextOpt(12, page.bg_hash);
    s.bindInt(13, page.source_page);
    s.bindIntOpt(14, if (page.links_offset) |v| @intCast(v) else null);
    s.bindIntOpt(15, if (page.links_length) |v| @intCast(v) else null);
    if (page.links_hash) |*h| s.bindText(16, h) else s.bindNull(16);
    // 1, 0, or NULL ("not yet looked"; the `ink` tenant retries).
    s.bindIntOpt(17, if (page.has_ink) |v| @as(i64, if (v) 1 else 0) else null);
    _ = try s.step();
}

/// Writes `p`'s rows for `blob_md5` inside the caller's transaction (the `blobs`
/// row must exist; the FK ties index lifetime to blob lifetime). Upserts, so
/// racing parses are harmless and a page keeps its `id` across re-index.
pub fn store(db: sqlite.Db, blob_md5: []const u8, p: Parsed, now: i64) !void {
    {
        try db.run(
            upsert_note_sql,
            &.{
                .{ .text = blob_md5 },
                .{ .int = index_version },
                .{ .int = if (p.indexable) 1 else 0 },
                .{ .int = p.note.page_count },
                .{ .text_opt = p.note.signature },
                .{ .int = p.note.signature_version },
                .{ .text_opt = p.note.equipment },
                .{ .int = p.note.width },
                .{ .int = p.note.height },
                .{ .int = p.note.rle_variant },
                .{ .text_opt = p.note.recogn_type },
                .{ .text_opt = p.note.recogn_language },
                .{ .int = p.note.recognized_page_count },
                .{ .int = now },
                .{ .int_opt = if (p.note.cover_w) |v| @as(i64, v) else null },
                .{ .int_opt = if (p.note.cover_h) |v| @as(i64, v) else null },
                .{ .int_opt = if (p.note.cover_offset) |v| @as(i64, @intCast(v)) else null },
                .{ .int_opt = if (p.note.cover_length) |v| @as(i64, v) else null },
                .{ .text_opt = p.note.cover_mime },
                .{ .text_opt = p.note.filetype },
            },
        );
    }

    var layer_buf: [max_layers * max_layer_rec_size]u8 = undefined;
    for (p.pages) |page| try upsertPage(db, blob_md5, page, &layer_buf);

    // Drop any tail from a previous shape. Scoped to `kind = 0`: for a blob the
    // note parser rejected `page_count` is 0, so unscoped this would drop every
    // other format's rows.
    {
        try db.run(
            "DELETE FROM note_page_index WHERE blob_md5 = ?1 AND page_index >= ?2 AND kind = 0;",
            &.{ .{ .text = blob_md5 }, .{ .int = p.note.page_count } },
        );
    }
}

/// True when this blob has an index row at the current version; also what makes
/// the unindexable marker stick.
pub fn isCurrent(db: sqlite.Db, blob_md5: []const u8) !bool {
    var s = try db.prepare("SELECT 1 FROM note_index WHERE blob_md5 = ?1 AND index_version = ?2;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, index_version);
    return try s.step();
}

/// Cover repair gate for the `/thumbnail` serve path: true only when the row is
/// missing or stale. A current row saying "no cover" is the memo. `thumbs` is
/// unused, kept for parity with `spd_index.needsRepair`.
pub fn needsRepair(db: sqlite.Db, thumbs: thumbstore.ThumbStore, md5: []const u8) !bool {
    _ = thumbs; // notes stream from the blob — no derived file to check for
    return !(try isCurrent(db, md5));
}

/// `sniffMime` returns at most `image/jpeg|png|webp|gif`.
pub const max_cover_mime_len = 16;

/// A `.note` cover's location and MIME, read in one row; `mime` is inline so the
/// value outlives the statement.
pub const CoverLocation = struct {
    offset: u64,
    length: u64,
    mime_buf: [max_cover_mime_len]u8 = undefined,
    mime_len: u8 = 0,

    pub fn mime(self: *const CoverLocation) []const u8 {
        return self.mime_buf[0..self.mime_len];
    }
};

/// The recorded cover location, or null for no cover. Only a current-version
/// row counts, and the length is re-checked against `max_cover_bytes` here;
/// a malformed row is treated as no cover.
pub fn coverLocation(db: sqlite.Db, md5: []const u8) !?CoverLocation {
    var r = (try db.row(
        "SELECT cover_offset, cover_length, cover_mime FROM note_index " ++
            "WHERE blob_md5 = ?1 AND index_version = ?2;",
        &.{ .{ .text = md5 }, .{ .int = index_version } },
    )) orelse return null;
    defer r.finalize();
    if (r.isNull(0) or r.isNull(1) or r.isNull(2)) return null; // no cover
    const offset: u64 = @intCast(r.int(0));
    const length: u64 = @intCast(r.int(1));
    if (length == 0 or length > thumbnail.max_cover_bytes) return null;
    const mime = r.text(2);
    if (mime.len == 0 or mime.len > max_cover_mime_len) return null;
    var loc: CoverLocation = .{ .offset = offset, .length = length };
    @memcpy(loc.mime_buf[0..mime.len], mime);
    loc.mime_len = @intCast(mime.len);
    return loc;
}

/// Drops a blob's index rows, inside the blob GC transaction. ON DELETE CASCADE
/// is the backstop; this also works with FKs off.
pub fn deleteForBlob(db: sqlite.Db, blob_md5: []const u8) !void {
    {
        try db.run("DELETE FROM note_page_index WHERE blob_md5 = ?1;", &.{.{ .text = blob_md5 }});
    }
    try db.run("DELETE FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = blob_md5 }});
}

// ---- parsing a stored blob (ranged reads) ----

/// Parses a stored blob without touching the database; hand the result to
/// `store`. Null when the blob is not on disk. Reads ranges through
/// `BlobSource`, never buffering the note. `io` is unused.
pub fn parseStoredBlob(gpa: Allocator, io: std.Io, blobs: blobstore.BlobStore, md5: []const u8) !?Parsed {
    _ = io;
    var bs = blob_source.BlobSource.init(blobs, md5) catch return null;
    return try parseBlobSource(gpa, bs.source());
}

/// Lazy self-heal for read paths: no-op at the current version, else parse
/// unlocked and write in a transaction. Safe to race (upserts).
pub fn ensureIndexed(
    gpa: Allocator,
    io: std.Io,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    md5: []const u8,
    now: i64,
) !void {
    if (try isCurrent(db, md5)) return;

    var parsed = (try parseStoredBlob(gpa, io, blobs, md5)) orelse return;
    defer parsed.deinit();

    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    try store(db, md5, parsed, now);
    try db.exec("COMMIT;");
}

// ---- tests of private helpers ----

const testing = std.testing;
const schema = @import("../db/schema.zig");
const nb = @import("note_builder");
const fixture = @import("note_index/fixture.zig");
const layers_edited = fixture.layers_edited;
const Fixture = fixture.Fixture;
const Blobs = fixture.Blobs;
const PeakAllocator = fixture.PeakAllocator;
const indexInto = fixture.indexInto;
const coveredNote = fixture.coveredNote;

test "a v4 row (fixed-stride layers, no identity) lazily re-derives to v5 with slots+names" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const md5 = try f.put("layers.note", layers_edited); // eagerly indexed at v5

    // Regress page 2 to v4's 9-byte fixed-stride `(offset,len,flags)` records.
    {
        var p = try parseBlob(gpa, layers_edited);
        defer p.deinit();
        var old_blob: [max_layers * 9]u8 = undefined;
        const layers = p.pages[1].layers;
        for (layers, 0..) |il, i| {
            const rec = old_blob[i * 9 ..][0..9];
            std.mem.writeInt(u32, rec[0..4], il.ref.offset, .little);
            std.mem.writeInt(u32, rec[4..8], il.ref.len, .little);
            rec[8] = if (il.ref.all_blank) note_index_parse.flag_all_blank else 0;
        }
        try f.db.run(
            "UPDATE note_page_index SET layers = ?1 WHERE page_index = 1;",
            &.{.{ .blob = old_blob[0 .. layers.len * 9] }},
        );
    }
    try f.db.exec("UPDATE note_index SET index_version = 4;");
    try testing.expect(!try isCurrent(f.db, &md5));
    try testing.expect((try noteHeader(f.db, &md5)) == null);

    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 42);
    try testing.expect(try isCurrent(f.db, &md5));

    var s = try f.db.prepare("SELECT layers FROM note_page_index WHERE blob_md5 = ?1 AND page_index = 1;");
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    var recs: [max_layers]LayerRecord = undefined;
    const got = try unpackLayerRecords(s.columnBlob(0), &recs);
    try testing.expectEqual(@as(usize, 5), got.len);

    const want = [_]struct { slot: sn.types.LayerSlot, hidden: bool, name: []const u8, current: bool }{
        .{ .slot = .background, .hidden = false, .name = "Background Layer", .current = false },
        .{ .slot = .main, .hidden = false, .name = "Main Layer", .current = false },
        .{ .slot = .layer2, .hidden = true, .name = "Layer 2", .current = false },
        .{ .slot = .layer1, .hidden = false, .name = "Layer 1", .current = false },
        .{ .slot = .layer3, .hidden = false, .name = "Layer Renamed", .current = true },
    };
    for (got, want) |g, w| {
        try testing.expectEqual(w.slot, g.ref.slot);
        try testing.expectEqual(w.hidden, g.ref.hidden);
        try testing.expectEqualStrings(w.name, g.name);
        try testing.expectEqual(w.current, g.is_current);
    }
}

test {
    _ = note_index_parse;
    _ = note_index_serve;
}
