//! ControlPlaneService: projects the file tree and the note index into the JSON
//! shapes the browser app consumes (`webapp/src/core/types.ts`). Listings,
//! `noteMeta` and page plans are DB reads; a missing or stale index row is
//! backfilled on the spot.

const std = @import("std");
const repeat = @import("../repeat.zig").repeat;
const Files = @import("files.zig").Files;
const Entry = @import("files.zig").Entry;
const sn = @import("supernote");
const noteindex = @import("note_index.zig");
const spdindex = @import("spd_index.zig");
const settingsmod = @import("settings.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");

// ---- response VOs (field names mirror core/types.ts) ----

/// One page of a note. `hash` is the md5 of the layer bitmaps (the `?v=` cache
/// key); `width`/`height` are device pixels. `textHash` is the md5 of
/// `RECOGNTEXT`, null when unrecognized; it is separate from `hash` because
/// recognition changes the transcript without touching the strokes.
pub const PageRefVO = struct {
    index: i64,
    hash: []const u8,
    width: i64,
    height: i64,
    textHash: ?[]const u8 = null,
    /// md5 of the page's `EXTERNALLINKINFO` block (`note-format.md` §14), null
    /// when it has none. Non-null is the "has links" signal; the records stay
    /// off the page list because they can run to tens of thousands per note.
    linksHash: ?[]const u8 = null,
    /// The 1-based page number from the footer; omitted when it equals
    /// `index + 1`. A `.mark`'s pages are named by the PDF page they annotate
    /// (`note-format.md` §13.2).
    sourcePage: ?i64 = null,
    /// Layer descriptors in SNPG record order (match by `slot`), null when the
    /// page has none. Also on a listing's `firstPage`, from the same serializer,
    /// so the reader's first paint already knows the layer stack.
    layers: ?[]const LayerVO = null,
    /// Whether any non-background layer carries a mark. Omitted while
    /// `has_ink` is NULL (not yet computed) — absent means unknown, never false.
    hasInk: ?bool = null,
};

/// One layer of a page. Device-authored (`LAYERINFO`), read-only.
pub const LayerVO = struct {
    /// `"main"`, `"layer1"`..`"layer3"` or `"background"`, the SNPG v2 slot byte.
    slot: []const u8,
    /// The `LAYERINFO` display name, or `""` when there is none usable.
    name: []const u8,
    /// `LAYERINFO.isVisible`. A hidden layer's stream is still in the payload.
    visible: bool,
    /// `LAYERINFO.isCurrentLayer` — which layer the device's panel had active.
    isCurrent: bool,
};

/// The preview's source pixel dims, so the masonry layout can reserve tile
/// height before images arrive. Absent (never 0×n) when unknown.
pub const AspectVO = struct { w: i64, h: i64 };

/// A folder in a listing or a breadcrumb. `itemCount` is omitted on breadcrumbs.
pub const FolderVO = struct {
    kind: []const u8 = "folder",
    id: []const u8,
    name: []const u8,
    /// Live direct children of any kind (`Files.childCount`).
    itemCount: ?i64 = null,
};

/// One listing row: a folder serializes to `{kind,id,name}`, a note to the full
/// `NoteSummary` (null optionals are not emitted).
pub const EntryVO = struct {
    kind: []const u8,
    id: []const u8,
    name: []const u8,
    pageCount: ?i64 = null,
    firstPage: ?PageRefVO = null,
    updatedAt: ?i64 = null,
    /// `"note"` when the indexer parsed it as a `.note`, else the lowercased
    /// extension, or `"file"`.
    fileType: ?[]const u8 = null,
    /// Whole-file blob md5, for the content-addressed `/file/{id}?v=` URL. Not
    /// derivable from `firstPage.hash`, even where they coincide today.
    fileHash: ?[]const u8 = null,
    /// At least one page has finished recognition (`recognized_page_count > 0`),
    /// the same predicate search uses; not `FILE_RECOGN_TYPE`.
    hasRecognizedText: ?bool = null,
    /// A `.note`'s cover dims if decodable, else page 0's effective dims
    /// (orientation applied); a `.spd`'s thumbnail dims. Omitted otherwise.
    thumbAspect: ?AspectVO = null,
    /// Folder only.
    itemCount: ?i64 = null,
    /// The paired live `.mark`, same value as `NoteMetaVO.annotationsId`.
    /// Paired marks are hidden from listings, so the document's card is the only
    /// place to reach them. PDF only, gated on the verified `fileType`; omitted
    /// when none.
    annotationsId: ?[]const u8 = null,
};

/// The contents of one folder plus the freshness token.
pub const ListingVO = struct {
    folderId: ?[]const u8,
    path: []const FolderVO,
    entries: []const EntryVO,
    syncVersion: i64,
};

/// The page list for one file. Repeats `fileType`/`fileHash`/`size` because a
/// reader URL must be answerable from the id alone.
pub const NoteMetaVO = struct {
    id: []const u8,
    name: []const u8,
    pages: []const PageRefVO,
    fileType: ?[]const u8 = null,
    fileHash: ?[]const u8 = null,
    size: i64 = 0,
    /// Device pixels per millimetre for the writing hardware, to place
    /// `PageTextVO.words`. Omitted for unmeasured hardware
    /// (`types.CanvasMm.forEquipment` has no fallback): then export emits a
    /// raster-only PDF rather than misplaced text.
    pxPerMm: ?f32 = null,
    /// The `.mark` annotating this file (`foo.pdf.mark` beside `foo.pdf`,
    /// `note-format.md` §13.2), resolved here because the client may hold no
    /// listing. Null for non-PDFs and unannotated PDFs.
    annotationsId: ?[]const u8 = null,
};

/// One recycle-bin row. Not an `EntryVO`: it carries origin and deletion facts
/// instead of the card machinery.
pub const BinEntryVO = struct {
    /// `"folder"` or `"note"`, as in `EntryVO.kind`.
    kind: []const u8,
    id: []const u8,
    name: []const u8,
    /// The path at deletion time, through trashed ancestors.
    path: []const u8,
    /// Epoch MILLISECONDS, matching `EntryVO.updatedAt`.
    deletedAt: i64,
    /// Bytes this row charges against quota; 0 for a folder, so sums over rows
    /// never double-count.
    size: i64,
    /// The trashed parent it came down with, if that is in the bin.
    parentId: ?[]const u8 = null,
    /// Top of a trashed subtree (what the user actually deleted).
    isRoot: bool,
    fileType: ?[]const u8 = null,
    fileHash: ?[]const u8 = null,
    /// Page 0's ref, served via `/bin/note/{id}/page/0`. Null rather than a
    /// placeholder when there is nothing to draw.
    firstPage: ?PageRefVO = null,
    /// As `EntryVO.thumbAspect`; trash still holds the blob.
    thumbAspect: ?AspectVO = null,
};

/// `GET /api/controlplane/bin`.
pub const BinVO = struct {
    entries: []const BinEntryVO,
    /// What emptying the bin would free. Folders contribute 0.
    totalBytes: i64,
    /// Retention window, from `Files.bin_retention_s`.
    retentionDays: i64,
    syncVersion: i64,
};

/// What `restore` did.
pub const RestoredVO = struct {
    success: bool = true,
    /// The name it came back under, which may differ.
    name: []const u8,
    renamed: bool,
    /// Trashed ancestors restored to make it reachable.
    ancestors: i64,
    /// Trashed descendants that came back with a restored folder.
    descendants: i64,
};

/// What a web delete did, so the undo toast can state the fanout.
pub const TrashedVO = struct {
    success: bool = true,
    id: []const u8,
    name: []const u8,
    isFolder: bool,
    /// Rows tombstoned, the clicked one included.
    entries: i64,
};

/// What `emptyBin` destroyed.
pub const EmptiedVO = struct { success: bool = true, entries: i64 };

/// One version in a file's history. `md5` keys the thumbnail and per-version
/// routes; `createdAt` is epoch ms; `current` marks the live content.
pub const HistoryVersionVO = struct {
    md5: []const u8,
    size: i64,
    createdAt: i64,
    /// `.note` pages in this blob; 0 for non-`.note` blobs.
    pageCount: i64 = 0,
    current: bool = false,
};

/// A file's versions, newest first: the current one, then retained history.
pub const HistoryVO = struct {
    id: []const u8,
    versions: []const HistoryVersionVO,
};

/// The file's new current version after a restore.
pub const RestoredVersionVO = struct {
    success: bool = true,
    md5: []const u8,
    size: i64,
    createdAt: i64,
    current: bool = true,
};

/// Everything needed to serve one page, resolved under the DB lock so the bytes
/// stream with no further DB access. `md5` is an owned copy.
pub const PagePlan = struct {
    md5: [blobstore.md5_hex_len]u8,
    plan: noteindex.PagePlan,
};

/// The `/template/{hash}` serve plan: blob md5 (owned) and the template's byte
/// range inside it.
pub const TemplatePlan = struct {
    md5: [blobstore.md5_hex_len]u8,
    offset: u64,
    length: u64,
};

/// Upper bound on a `/template/{hash}` segment (an md5 hex, `max_bg_hash`).
pub const max_template_hash_len: usize = noteindex.max_bg_hash;

/// One recognized word. Units are millimetres on the page canvas, origin
/// top-left, verbatim from `RECOGNTEXT`; see `NoteMetaVO.pxPerMm`.
pub const WordVO = struct {
    text: []const u8,
    xMm: f32,
    yMm: f32,
    wMm: f32,
    hMm: f32,
};

/// The recognized-text body, with no `{success}` envelope (`Api.getPageText`);
/// an empty transcript serializes to `{}`. Must not be served `immutable`:
/// `?v=textHash` versions the `RECOGNTEXT` block, not this struct, so a field
/// added later would be pinned out of every cached copy. Words stay in mm
/// because the px scale depends on `APPLY_EQUIPMENT`, which `textHash` does not
/// cover (the scale is on `NoteMetaVO`).
pub const PageTextVO = struct {
    text: ?[]const u8 = null,
    words: ?[]const WordVO = null,
};

/// `pageText`'s result: the body plus the stored `text_hash` for `?v=`.
pub const PageText = struct { hash: [32]u8, vo: PageTextVO };

/// One link rectangle, in the shape `render/pdfLinks.ts` uses for PDF links.
/// `x`/`y`/`w`/`h` are device panel pixels, origin top-left (a `.note` page is
/// the panel, §9.1). `page` is the 0-based jump target, or -1 for an external
/// link; §14 stores 1-based numbers and `none`, converted only here.
pub const LinkVO = struct {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    page: i64,
    uri: []const u8,
};

/// A page's links, as an object so it can gain fields.
pub const PageLinksVO = struct { links: []const LinkVO = &.{} };

/// `pageLinks`'s result: the body plus the stored `links_hash` for `?v=`.
pub const PageLinks = struct { hash: [32]u8, vo: PageLinksVO };

/// The link schemes allowed out of a device file, matching the browser's
/// allowlist in `render/pdfLinks.ts`; export reads this too. Anchored at index 0
/// and case-folded.
fn allowedLinkScheme(uri: []const u8) bool {
    for ([_][]const u8{ "http://", "https://", "mailto:" }) |scheme| {
        if (uri.len < scheme.len) continue;
        if (std.ascii.eqlIgnoreCase(uri[0..scheme.len], scheme)) return true;
    }
    return false;
}

pub const ControlPlaneService = struct {
    files: *Files,

    pub fn init(files: *Files) ControlPlaneService {
        return .{ .files = files };
    }

    /// `GET /api/controlplane/tree` — one folder's children, the breadcrumb and
    /// the sync version, allocated in `arena`.
    pub fn listing(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, parent_id: ?u64) !ListingVO {
        const entries = try self.files.list(user_id, parent_id);
        defer Files.freeEntries(self.files.gpa, entries);

        // One builder shared with the rename response, so the shapes agree.
        var out: std.ArrayList(EntryVO) = .empty;
        for (entries) |e| try out.append(arena, try self.entryVO(arena, user_id, e));

        return .{
            .folderId = if (parent_id) |p| try idStr(arena, p) else null,
            .path = try self.breadcrumb(arena, user_id, parent_id),
            .entries = out.items,
            .syncVersion = try self.files.syncVersion(user_id),
        };
    }

    /// One listing-shaped `EntryVO`, also used by the rename response.
    pub fn entryVO(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, e: Entry) !EntryVO {
        if (e.is_folder) return .{
            .kind = "folder",
            .id = try idStr(arena, e.id),
            .name = try arena.dupe(u8, e.name),
            .itemCount = try self.files.childCount(user_id, e.id),
        };
        const s = try self.summarize(arena, e);
        return .{
            .kind = "note",
            .id = try idStr(arena, e.id),
            .name = try arena.dupe(u8, e.name),
            .pageCount = s.count,
            .firstPage = s.page,
            .updatedAt = e.updated_at * 1000, // epoch s → ms
            .fileType = s.file_type,
            .fileHash = if (e.md5) |m| try arena.dupe(u8, m) else null,
            .hasRecognizedText = s.has_recognized_text,
            .thumbAspect = s.aspect,
            // No query here: `e.mark_id` was resolved in the listing's own
            // statement (`mark_pairing.pairedMarkId`). Gated on the verified PDF
            // type to match `noteMetaIn`, though pairing itself is format-agnostic.
            .annotationsId = if (isPdf(s.file_type))
                if (e.mark_id) |m| try idStr(arena, m) else null
            else
                null,
        };
    }

    /// `GET /api/controlplane/bin` — the recycle bin, newest deletion first,
    /// flat (grouping is the client's; see `Files.listBin`).
    pub fn bin(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64) !BinVO {
        const rows = try self.files.listBin(arena, user_id);

        var out: std.ArrayList(BinEntryVO) = .empty;
        var total: i64 = 0;
        for (rows) |r| {
            var file_type: ?[]const u8 = null;
            var first_page: ?PageRefVO = null;
            var thumb_aspect: ?AspectVO = null;
            if (!r.is_folder) {
                total += @intCast(r.size); // folders are 0 — never double-counted
                var indexable = false;
                var marker: ?[4]u8 = null;
                if (r.md5) |md5| {
                    // Heal here too: an `index_version` bump strands a trashed
                    // note's row, and the bin is the only surface that would heal
                    // it.
                    if (try self.indexRowEnsuring(md5)) |row| {
                        indexable = row.indexable;
                        marker = row.filetype;
                        if (indexable and row.page_count > 0) first_page = try self.pageRefAt(arena, md5, 0);
                        thumb_aspect = aspectOf(row, first_page);
                    }
                }
                file_type = try fileTypeFor(arena, indexable, marker, r.name);
            }
            try out.append(arena, .{
                .kind = if (r.is_folder) "folder" else "note",
                .id = try idStr(arena, r.id),
                .name = try arena.dupe(u8, r.name),
                .path = try arena.dupe(u8, r.path),
                .deletedAt = r.deleted_at * 1000, // epoch s → ms
                .size = @intCast(r.size),
                .parentId = if (r.parent_id) |p| try idStr(arena, p) else null,
                .isRoot = r.is_root,
                .fileType = file_type,
                .fileHash = if (r.md5) |m| try arena.dupe(u8, m) else null,
                .firstPage = first_page,
                .thumbAspect = thumb_aspect,
            });
        }

        return .{
            .entries = out.items,
            .totalBytes = total,
            // The configured window (admin-settable), not the compiled default.
            .retentionDays = (try settingsmod.Settings.init(self.files.io, self.files.db).binRetention()).days(),
            .syncVersion = try self.files.syncVersion(user_id),
        };
    }

    /// Which state a read may see: `.trashed` for the bin's preview and history
    /// endpoints, `.live` otherwise. Same type as `Files.HistoryScope`.
    pub const ReadScope = @import("files.zig").HistoryScope;

    /// Each scope refuses the other's rows.
    pub fn lookup(self: ControlPlaneService, scope: ReadScope, user_id: u64, id: u64) !?Entry {
        return switch (scope) {
            .live => self.files.get(user_id, id),
            .trashed => self.files.getTrashed(user_id, id),
        };
    }

    /// `GET /api/controlplane/file/metadata/{id}`. Null if missing, not owned or a
    /// folder.
    pub fn noteMeta(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?NoteMetaVO {
        return self.noteMetaIn(arena, user_id, id, .live);
    }

    /// `GET /api/controlplane/bin/file/metadata/{id}` — the same for a trashed file.
    pub fn binNoteMeta(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?NoteMetaVO {
        return self.noteMetaIn(arena, user_id, id, .trashed);
    }

    /// Compares the verified type, never the filename.
    fn isPdf(file_type: ?[]const u8) bool {
        return file_type != null and std.mem.eql(u8, file_type.?, "pdf");
    }

    /// The live `.mark` beside `entry` (`foo.pdf` -> `foo.pdf.mark`: the
    /// extension is appended, not replaced), or null. Per-file route only;
    /// listings use `Entry.mark_id`, and the two are pinned to agree by test.
    /// The gate keys off the described type while pairing keys off the name, so
    /// a PDF named without the extension still finds its ink. Live only.
    fn annotationsIdFor(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, entry: Entry) !?[]const u8 {
        const found = (try self.files.liveMarkIdFor(user_id, entry.parent_id, entry.name)) orelse return null;
        return try idStr(arena, found);
    }

    fn noteMetaIn(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, scope: ReadScope) !?NoteMetaVO {
        const entry = (try self.lookup(scope, user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        if (entry.is_folder) return null;

        const described = try self.describe(arena, entry);
        return .{
            .id = try idStr(arena, id),
            .name = try arena.dupe(u8, entry.name),
            .pages = try self.pageRefsOf(arena, entry),
            .fileType = described.file_type,
            .fileHash = if (entry.md5) |m| try arena.dupe(u8, m) else null,
            .size = @intCast(entry.size),
            .pxPerMm = described.px_per_mm,
            // Live only: the lookup is live-scoped and must not pair with a
            // trashed document.
            .annotationsId = if (scope == .live and isPdf(described.file_type))
                try self.annotationsIdFor(arena, user_id, entry)
            else
                null,
        };
    }

    /// `GET /api/controlplane/note/{id}/history/{md5}/meta` — the page list of a
    /// retained version, from that version's own `note_index`. Null when `md5` is
    /// not a retained version of `id` owned by `user_id`.
    pub fn historyNoteMeta(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, md5: []const u8) !?NoteMetaVO {
        // The gate every per-version endpoint shares.
        const version = (try self.files.historyVersion(user_id, id, md5)) orelse return null;

        const entry = (try self.lookup(.live, user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        if (entry.is_folder) return null;

        // The file's identity with the version's md5 and size. Borrows `entry`'s
        // name and `version.md5`; owns nothing.
        const version_entry: Entry = .{
            .id = entry.id,
            .parent_id = entry.parent_id,
            .name = entry.name,
            .is_folder = false,
            .md5 = &version.md5,
            .size = version.size,
            .updated_at = entry.updated_at,
            // Unused: past ink lives in the mark's own history.
            .mark_id = entry.mark_id,
        };

        const described = try self.describe(arena, version_entry);
        return .{
            .id = try idStr(arena, id),
            .name = try arena.dupe(u8, entry.name),
            .pages = try self.pageRefsOf(arena, version_entry),
            .fileType = described.file_type,
            .fileHash = try arena.dupe(u8, &version.md5),
            .size = @intCast(version.size),
            .pxPerMm = described.px_per_mm,
        };
    }

    /// The verified mm→px scale, or null for unknown equipment, a zero width or a
    /// non-finite result. Never a plausible fallback: misplaced invisible PDF text
    /// goes unnoticed.
    fn pxPerMmFor(equipment: ?[]const u8, width: i64) ?f32 {
        if (width <= 0) return null;
        const canvas = sn.types.CanvasMm.forEquipment(equipment) orelse return null;
        const scale = canvas.pxPerMm(@intCast(width));
        return if (std.math.isFinite(scale) and scale > 0) scale else null;
    }

    /// The blob's verified type and mm→px scale, for callers that have only the
    /// entry. Shares `fileTypeFor` with `summarize`.
    const Described = struct { file_type: []const u8, px_per_mm: ?f32 };

    fn describe(self: ControlPlaneService, arena: std.mem.Allocator, entry: Entry) !Described {
        var indexable = false;
        var marker: ?[4]u8 = null;
        var px_per_mm: ?f32 = null;
        if (entry.md5) |md5| {
            if (try self.indexRowEnsuring(md5)) |row| {
                indexable = row.indexable;
                marker = row.filetype;
                px_per_mm = row.px_per_mm;
            }
        }
        return .{
            .file_type = try fileTypeFor(arena, indexable, marker, entry.name),
            .px_per_mm = px_per_mm,
        };
    }

    /// Resolves `GET /note/{id}/page/{n}` into a `PagePlan` for the SNPG page
    /// payload. Null if missing, not owned, or not a `.note`.
    pub fn pagePlan(self: ControlPlaneService, user_id: u64, id: u64, n: u64) !?PagePlan {
        const entry = (try self.files.get(user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        return self.pagePlanOf(entry, n);
    }

    /// `GET /api/controlplane/note/{id}/history` — current blob first, then each
    /// retained `file_history` row. Null when missing, not owned, a folder or
    /// blob-less.
    pub fn history(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?HistoryVO {
        return self.historyIn(arena, user_id, id, .live);
    }

    /// `GET /api/controlplane/bin/note/{id}/history` — the same for a trashed file
    /// (view-only); trash keeps `file_history`.
    pub fn binHistory(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?HistoryVO {
        return self.historyIn(arena, user_id, id, .trashed);
    }

    pub fn historyIn(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, scope: ReadScope) !?HistoryVO {
        const entry = (try self.lookup(scope, user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        if (entry.is_folder) return null;
        const cur_md5 = entry.md5 orelse return null; // a blob-less file has no versions

        var out: std.ArrayList(HistoryVersionVO) = .empty;
        // The current version leads, timestamped by `updated_at`.
        try out.append(arena, .{
            .md5 = try arena.dupe(u8, cur_md5),
            .size = @intCast(entry.size),
            .createdAt = entry.updated_at * 1000, // epoch s → ms
            .pageCount = try self.pageCountOf(cur_md5),
            .current = true,
        });
        for (try self.files.fileHistoryIn(scope, arena, user_id, id)) |v| {
            // A just-restored version may still have a row equal to the current blob.
            if (std.mem.eql(u8, &v.md5, cur_md5)) continue;
            try out.append(arena, .{
                .md5 = try arena.dupe(u8, &v.md5),
                .size = @intCast(v.size),
                .createdAt = v.created_at * 1000,
                .pageCount = try self.pageCountOf(&v.md5),
            });
        }
        return .{ .id = try idStr(arena, id), .versions = out.items };
    }

    /// `.note` page count for a blob (indexed by `note_page_index_blob`); 0 for
    /// non-`.note` blobs.
    fn pageCountOf(self: ControlPlaneService, md5: []const u8) !i64 {
        var s = try self.files.db.prepare("SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, md5);
        _ = try s.step();
        return s.columnInt(0);
    }

    /// `pagePlanOf` keyed by a retained version's md5 (`…/history/{md5}/page/{n}`);
    /// the caller gates ownership (`Files.historyVersion`). Call with the DB lock
    /// held.
    pub fn pagePlanForMd5(self: ControlPlaneService, md5: []const u8, n: u64) !?PagePlan {
        if (md5.len != blobstore.md5_hex_len) return null;
        self.backfill(md5);
        const plan = (try noteindex.pagePlan(self.files.db, md5, n)) orelse return null;
        var out: PagePlan = .{ .md5 = undefined, .plan = plan };
        @memcpy(&out.md5, md5[0..blobstore.md5_hex_len]);
        return out;
    }

    /// `pagePlan` for an already resolved, owned entry. Call with the DB lock held
    /// (it reads `note_index` and may backfill); `writePage` then streams unlocked.
    pub fn pagePlanOf(self: ControlPlaneService, entry: Entry, n: u64) !?PagePlan {
        if (entry.is_folder) return null;
        const md5 = entry.md5 orelse return null;
        if (md5.len != blobstore.md5_hex_len) return null;

        self.backfill(md5); // cold or stale blob: index it now, then serve it
        const plan = (try noteindex.pagePlan(self.files.db, md5, n)) orelse return null;

        var out: PagePlan = .{ .md5 = undefined, .plan = plan };
        @memcpy(&out.md5, md5[0..blobstore.md5_hex_len]);
        return out;
    }

    /// Where the note's image template under `hash` sits in its blob, for
    /// `GET /note/{id}/template/{hash}`. Null when not a `.note` or no page uses
    /// that background. A DB read; holds no SQLite borrow past the unlock.
    pub fn templatePlanOf(self: ControlPlaneService, entry: Entry, hash: []const u8) !?TemplatePlan {
        if (entry.is_folder) return null;
        const md5 = entry.md5 orelse return null;
        if (md5.len != blobstore.md5_hex_len) return null;

        self.backfill(md5); // cold or stale blob: index it now, then serve it
        const loc = (try noteindex.templateLocation(self.files.db, md5, hash)) orelse return null;

        var out: TemplatePlan = .{ .md5 = undefined, .offset = loc.offset, .length = loc.length };
        @memcpy(&out.md5, md5[0..blobstore.md5_hex_len]);
        return out;
    }

    /// `GET /note/{id}/page/{n}/text` — the stored transcript and its `text_hash`.
    /// Null when missing, not owned, or not recognized (`recogn_status != 1`), so
    /// the handler 404s it like a stale `?v=`.
    pub fn pageText(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, n: u64) !?PageText {
        return self.pageTextIn(arena, user_id, id, n, .live);
    }

    /// `GET /api/controlplane/bin/note/{id}/page/{n}/text` — the same for a trashed
    /// file, keyed by its current md5.
    pub fn binPageText(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, n: u64) !?PageText {
        return self.pageTextIn(arena, user_id, id, n, .trashed);
    }

    fn pageTextIn(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, n: u64, scope: ReadScope) !?PageText {
        const entry = (try self.lookup(scope, user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        if (entry.is_folder) return null;
        const md5 = entry.md5 orelse return null;
        return self.pageTextForMd5(arena, md5, n);
    }

    /// `pageText` keyed by a retained version's md5; the caller gates ownership.
    /// The per-version handler ignores `.hash` since `{md5}` pins the blob.
    pub fn pageTextForMd5(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8, n: u64) !?PageText {
        if (md5.len != blobstore.md5_hex_len) return null;

        self.backfill(md5); // a cold blob has no rows to read yet

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
            out.vo.words = self.wordsAt(arena, md5, offset, length) catch null;
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
        const entry = (try self.lookup(.live, user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        if (entry.is_folder) return null;
        const md5 = entry.md5 orelse return null;
        return self.pageLinksForMd5(arena, md5, n);
    }

    /// `pageLinks` keyed by blob md5: one ranged read of the page's block.
    /// `page_count` comes along to drop jumps past the last page.
    pub fn pageLinksForMd5(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8, n: u64) !?PageLinks {
        if (md5.len != blobstore.md5_hex_len) return null;

        self.backfill(md5); // a cold blob has no rows to read yet

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
        out.vo.links = (self.linksAt(arena, md5, r.int(1), r.int(2), r.int(3)) catch null) orelse &.{};
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

    /// Streams the planned page's SNPG bytes in `blobstore.chunk_len` windows,
    /// exactly `plan.plan.content_length` bytes. Must never touch the DB: the
    /// page route calls it with the lock released.
    pub fn writePage(self: ControlPlaneService, planned: PagePlan, out: *std.Io.Writer) !void {
        try noteindex.streamPage(self.files.blobs, &planned.md5, planned.plan, out);
    }

    /// `GET /thumbnail/{hash}` ownership gate: does `user_id` hold a blob with
    /// this md5? Thumbnails are content-addressed and shared across users, so only
    /// a `files` row says whose it is. False is a 404.
    pub fn thumbnailAllowed(self: ControlPlaneService, user_id: u64, hash: []const u8) !bool {
        if (hash.len != blobstore.md5_hex_len) return false;
        return self.files.holdsBlob(user_id, hash);
    }

    // ---- index-backed reads (no file I/O) ----

    /// Note-level facts from `note_index`, or null when no current row exists.
    /// `px_per_mm` is resolved here because `columnText` borrows the row.
    const IndexRow = struct {
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

    fn indexRow(self: ControlPlaneService, md5: []const u8) !?IndexRow {
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
            .px_per_mm = pxPerMmFor(
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
    fn aspectOf(row: IndexRow, first_page: ?PageRefVO) ?AspectVO {
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
    fn positivePair(w: ?i64, h: ?i64) ?AspectVO {
        const ww = w orelse return null;
        const hh = h orelse return null;
        return if (ww > 0 and hh > 0) .{ .w = ww, .h = hh } else null;
    }

    /// `indexRow`, backfilling only when nothing comes back. Reads first because
    /// `backfill`'s gate is the same lookup, and doubling it on every warm listing
    /// costs latency under the global `db_lock`.
    fn indexRowEnsuring(self: ControlPlaneService, md5: []const u8) !?IndexRow {
        if (try self.indexRow(md5)) |row| return row;
        self.backfill(md5); // cold or stale: parse (ranged, unlocked) and store
        return self.indexRow(md5);
    }

    /// Lazy backfill: repairs a missing or stale index row on the read path, so
    /// `index_version` bumps need no migration. Best-effort: failure falls through
    /// to the placeholder page. A single-row `SELECT` once indexed.
    fn backfill(self: ControlPlaneService, md5: []const u8) void {
        noteindex.ensureIndexed(
            self.files.gpa,
            self.files.io,
            self.files.db,
            self.files.blobs,
            md5,
            std.Io.Clock.real.now(self.files.io).toSeconds(),
        ) catch {};
    }

    // No `.txt` twin of `backfill`: a lazy heal could only write the
    // `txt_index` verdict, and the verdict must never precede the derived files
    // (`deferred.runTxt`). `Files.putFile` already wakes the worker.

    /// One page's ref from `note_page_index`, with its effective (orientation
    /// applied) dims and layer panel. Used for a listing's page 0.
    fn pageRefAt(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8, n: u64) !?PageRefVO {
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
    fn pageRefsFromIndex(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8) ![]const PageRefVO {
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
    fn layerVOsFromBlob(arena: std.mem.Allocator, blob: []const u8) !?[]const LayerVO {
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
    fn pageRefsOf(self: ControlPlaneService, arena: std.mem.Allocator, entry: Entry) ![]const PageRefVO {
        if (entry.md5) |md5| {
            if (try self.indexRowEnsuring(md5)) |row| {
                if (row.indexable and row.page_count > 0) {
                    const refs = try self.pageRefsFromIndex(arena, md5);
                    if (refs.len > 0) return refs;
                }
            }
        }
        const one = try arena.alloc(PageRefVO, 1);
        one[0] = try fallbackPage(arena, entry.md5, 0);
        return one;
    }

    /// Everything a listing row needs about one file.
    const Summary = struct {
        page: PageRefVO,
        count: i64,
        file_type: []const u8,
        has_recognized_text: bool,
        /// See `EntryVO.thumbAspect`. Independent of the placeholder page.
        aspect: ?AspectVO,
    };

    fn summarize(self: ControlPlaneService, arena: std.mem.Allocator, entry: Entry) !Summary {
        var indexable = false;
        var marker: ?[4]u8 = null;
        var count: i64 = 0;
        var has_text = false;
        var first: ?PageRefVO = null;
        var aspect: ?AspectVO = null;

        if (entry.md5) |md5| {
            if (try self.indexRowEnsuring(md5)) |row| {
                indexable = row.indexable;
                marker = row.filetype;
                count = row.page_count;
                has_text = row.recognized_page_count > 0;
                if (indexable and count > 0) first = try self.pageRefAt(arena, md5, 0);
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

    // ---- internals ----

    const First = struct { page: PageRefVO, count: i64 };

    /// The ancestor folders of `folder_id`, root-first, for breadcrumbs.
    fn breadcrumb(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, folder_id: ?u64) ![]const FolderVO {
        var list: std.ArrayList(FolderVO) = .empty;
        var cur = folder_id;
        var guard: usize = 0;
        while (cur) |cid| {
            guard += 1;
            if (guard > 256) break; // cycle guard (should never trigger)
            const e = (try self.files.get(user_id, cid)) orelse break;
            defer freeEntry(self.files.gpa, e);
            try list.append(arena, .{ .id = try idStr(arena, e.id), .name = try arena.dupe(u8, e.name) });
            cur = e.parent_id;
        }
        std.mem.reverse(FolderVO, list.items); // leaf→root walk → root-first path
        return list.items;
    }
};

/// The per-page `?v=` cache key, defined once in the indexer.
const pageContentHash = noteindex.pageContentHash;

// ---- fallbacks for non-`.note` files ----

/// The type reported for a non-`.note` without an extension (or a dotfile).
const no_extension = "file";

/// The file-type rule. `indexable` means the indexer parsed a `.note` container,
/// whatever the name; only unparseable blobs fall back to the extension. A
/// `.mark` is a thin `.note`, so the 4-byte marker decides; unknown or NULL
/// markers (ASA family, pre-v6 rows) still say "note".
fn fileTypeFor(arena: std.mem.Allocator, indexable: bool, marker: ?[4]u8, name: []const u8) ![]const u8 {
    if (!indexable) return extensionOf(arena, name);
    if (marker) |m| if (std.mem.eql(u8, &m, "mark")) return "mark";
    return "note";
}

fn extensionOf(arena: std.mem.Allocator, name: []const u8) ![]const u8 {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return no_extension;
    if (dot == 0 or dot + 1 == name.len) return no_extension;
    const ext = name[dot + 1 ..];
    const out = try arena.alloc(u8, ext.len);
    for (ext, 0..) |c, i| out[i] = std.ascii.toLower(c);
    return out;
}

fn fallbackFirst(arena: std.mem.Allocator, file_md5: ?[]const u8) !ControlPlaneService.First {
    return .{ .page = try fallbackPage(arena, file_md5, 0), .count = 1 };
}

fn fallbackPage(arena: std.mem.Allocator, file_md5: ?[]const u8, index: usize) !PageRefVO {
    const d = sn.types.Dimensions.default;
    return .{
        .index = @intCast(index),
        .hash = try arena.dupe(u8, &fallbackHash(file_md5)),
        .width = d.width,
        .height = d.height,
    };
}

/// A placeholder page hash keyed by the file md5 (padded/truncated to 32 hex).
fn fallbackHash(file_md5: ?[]const u8) [32]u8 {
    var out: [32]u8 = @splat('0');
    if (file_md5) |m| {
        const n = @min(m.len, 32);
        @memcpy(out[0..n], m[0..n]);
    }
    return out;
}

// ---- small helpers ----

fn idStr(arena: std.mem.Allocator, id: u64) ![]const u8 {
    return std.fmt.allocPrint(arena, "{d}", .{id});
}

fn freeEntry(gpa: std.mem.Allocator, e: Entry) void {
    gpa.free(e.name);
    if (e.md5) |m| gpa.free(m);
}

// ---- tests ----

const testing = std.testing;
const sqlite = @import("../db/sqlite.zig");
const schema = @import("../db/schema.zig");
const nb = @import("note_builder");

/// Real device captures. Local fixtures only — they are not redistributed.
const sample = @embedFile("sample.note");
const sample2 = @embedFile("sample-2.note");

const Fixture = struct {
    db: sqlite.Db,
    files: Files,
    tmp: testing.TmpDir,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 100000000);");
        const tmp = testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{ .db = db, .files = Files.init(testing.allocator, testing.io, db, store, thumbs), .tmp = tmp };
    }

    fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }
};

/// Seeds a synthetic `.note` with the given main-layer bitmaps; returns its id.
fn seedNote(f: *Fixture, parent: ?u64, name: []const u8, page_bitmaps: []const []const u8) !u64 {
    var pages: std.ArrayList(nb.PageSpec) = .empty;
    defer pages.deinit(testing.allocator);
    var layers: std.ArrayList([1]nb.LayerSpec) = .empty;
    defer layers.deinit(testing.allocator);
    for (page_bitmaps) |bmp| {
        try layers.append(testing.allocator, .{.{ .slot = .main, .bitmap = bmp }});
    }
    for (layers.items) |*l| {
        try pages.append(testing.allocator, .{ .layers = l[0..1] });
    }
    const bytes = try nb.serialize(testing.allocator, .{ .pages = pages.items });
    defer testing.allocator.free(bytes);

    return seedBytes(f, parent, name, bytes);
}

/// Seeds arbitrary bytes as a file and returns its id.
fn seedBytes(f: *Fixture, parent: ?u64, name: []const u8, bytes: []const u8) !u64 {
    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(1, parent, name, &r, null);
    defer testing.allocator.free(e.name);
    if (e.md5) |m| testing.allocator.free(m);
    return e.id;
}

/// Plans and streams a page as `controlplanePage` does; null where it would 404.
const Served = struct { bytes: []const u8, hash: [32]u8, content_length: u64 };

fn servePage(
    svc: ControlPlaneService,
    arena: std.mem.Allocator,
    user_id: u64,
    id: u64,
    n: u64,
) !?Served {
    const planned = (try svc.pagePlan(user_id, id, n)) orelse return null;
    var out: std.Io.Writer.Allocating = .init(arena);
    try svc.writePage(planned, &out.writer);
    return .{
        .bytes = out.written(),
        .hash = planned.plan.content_hash,
        .content_length = planned.plan.content_length,
    };
}

/// The md5 of the blob behind file `id`, as an owned 32-hex array.
fn md5Of(f: *Fixture, id: u64) ![blobstore.md5_hex_len]u8 {
    const e = (try f.files.get(1, id)).?;
    defer freeEntry(testing.allocator, e);
    var out: [blobstore.md5_hex_len]u8 = undefined;
    @memcpy(&out, e.md5.?[0..blobstore.md5_hex_len]);
    return out;
}

test "listing: folders + note summaries, breadcrumb, and syncVersion" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Work");
    defer testing.allocator.free(dir.name);
    _ = try seedNote(&f, null, "top.note", &.{"AAAA"}); // 1 page, at root
    _ = try seedNote(&f, dir.id, "deep.note", &.{ "AAAA", "BBBBBB", "CC" }); // 3 pages, in Work

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const root = try svc.listing(arena.allocator(), 1, null);
    try testing.expect(root.folderId == null);
    try testing.expectEqual(@as(usize, 0), root.path.len);
    try testing.expectEqual(@as(usize, 2), root.entries.len);
    try testing.expectEqualStrings("folder", root.entries[0].kind);
    try testing.expectEqualStrings("Work", root.entries[0].name);
    const note = root.entries[1];
    try testing.expectEqualStrings("note", note.kind);
    try testing.expectEqualStrings("top.note", note.name);
    try testing.expectEqual(@as(i64, 1), note.pageCount.?);
    try testing.expectEqual(@as(usize, 32), note.firstPage.?.hash.len);
    try testing.expectEqual(@as(i64, 1404), note.firstPage.?.width);
    try testing.expect(root.syncVersion > 0);

    const dir_str = try std.fmt.allocPrint(arena.allocator(), "{d}", .{dir.id});
    const sub = try svc.listing(arena.allocator(), 1, dir.id);
    try testing.expectEqualStrings(dir_str, sub.folderId.?);
    try testing.expectEqual(@as(usize, 1), sub.path.len);
    try testing.expectEqualStrings("Work", sub.path[0].name);
    try testing.expectEqualStrings("folder", sub.path[0].kind);
    try testing.expectEqual(@as(usize, 1), sub.entries.len);
    try testing.expectEqual(@as(i64, 3), sub.entries[0].pageCount.?);
}

test "listing: a folder row carries a direct item count; a note row carries none" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Work");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Projects");
    defer testing.allocator.free(sub.name);
    const doomed = try seedNote(&f, dir.id, "gone.note", &.{"AAAA"});
    _ = try seedNote(&f, dir.id, "kept.note", &.{"AAAA"});
    _ = try seedNote(&f, sub.id, "deep.note", &.{"AAAA"}); // a GRANDCHILD of Work
    const empty = try f.files.createFolder(1, null, "Empty");
    defer testing.allocator.free(empty.name);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const root = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqualStrings("Empty", root.entries[0].name);
    try testing.expectEqual(@as(i64, 0), root.entries[0].itemCount.?); // → "Empty", not "0 items"

    const work = root.entries[1];
    try testing.expectEqualStrings("Work", work.name);
    try testing.expectEqual(@as(i64, 3), work.itemCount.?);

    try f.files.trash(1, doomed);
    const after = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqual(@as(i64, 2), after.entries[1].itemCount.?);

    // A note row's JSON stays exactly the `NoteSummary` shape.
    const listed = try svc.listing(arena.allocator(), 1, dir.id);
    for (listed.entries) |e| {
        if (std.mem.eql(u8, e.kind, "note")) try testing.expect(e.itemCount == null);
    }
    try testing.expectEqualStrings("note", listed.entries[1].kind);
    const json = try std.json.Stringify.valueAlloc(arena.allocator(), listed.entries[1], .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, json, "itemCount") == null);
    try testing.expect(std.mem.indexOf(u8, json, "pageCount") != null); // …but the note fields are all still there

    try testing.expect(listed.path[0].itemCount == null);
}

test "noteMeta: full page list with distinct per-page content hashes" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedNote(&f, null, "n.note", &.{ "AAAA", "BBBBBB", "AAAA" });

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;
    try testing.expectEqualStrings("n.note", meta.name);
    try testing.expectEqual(@as(usize, 3), meta.pages.len);
    try testing.expectEqual(@as(i64, 0), meta.pages[0].index);
    try testing.expectEqual(@as(i64, 2), meta.pages[2].index);
    try testing.expectEqual(@as(i64, 1404), meta.pages[0].width);
    try testing.expectEqual(@as(i64, 1872), meta.pages[0].height);
    try testing.expectEqualStrings(meta.pages[0].hash, meta.pages[2].hash);
    try testing.expect(!std.mem.eql(u8, meta.pages[0].hash, meta.pages[1].hash));

    try testing.expect((try svc.noteMeta(arena.allocator(), 1, 99999)) == null);
    const dir = try f.files.createFolder(1, null, "D");
    defer testing.allocator.free(dir.name);
    try testing.expect((try svc.noteMeta(arena.allocator(), 1, dir.id)) == null);
}

test "noteMeta: per-page layers carry {slot, name, visible, isCurrent} from the real capture" {
    const layers_edited = @embedFile("layers_edited.note");
    var f = try Fixture.init();
    defer f.deinit();

    var r = std.Io.Reader.fixed(layers_edited);
    const e = try f.files.putFile(1, null, "layers.note", &r, null);
    defer testing.allocator.free(e.name);
    defer if (e.md5) |m| testing.allocator.free(m);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, e.id)).?;
    try testing.expectEqual(@as(usize, 2), meta.pages.len);

    // Page 2: five layers in SNPG order, LAYER2 hidden, renamed LAYER3 current.
    const layers = meta.pages[1].layers.?;
    const want = [_]LayerVO{
        .{ .slot = "background", .name = "Background Layer", .visible = true, .isCurrent = false },
        .{ .slot = "main", .name = "Main Layer", .visible = true, .isCurrent = false },
        .{ .slot = "layer2", .name = "Layer 2", .visible = false, .isCurrent = false },
        .{ .slot = "layer1", .name = "Layer 1", .visible = true, .isCurrent = false },
        .{ .slot = "layer3", .name = "Layer Renamed", .visible = true, .isCurrent = true },
    };
    try testing.expectEqual(want.len, layers.len);
    for (want, layers) |w, got| {
        try testing.expectEqualStrings(w.slot, got.slot);
        try testing.expectEqualStrings(w.name, got.name);
        try testing.expectEqual(w.visible, got.visible);
        try testing.expectEqual(w.isCurrent, got.isCurrent);
    }

    // Page 1 (#-JSON LAYERINFO).
    const p0 = meta.pages[0].layers.?;
    try testing.expectEqual(@as(usize, 2), p0.len);
    try testing.expectEqualStrings("background", p0[0].slot);
    try testing.expectEqualStrings("main", p0[1].slot);
    try testing.expectEqualStrings("Main Layer", p0[1].name);
    try testing.expect(p0[1].isCurrent);

    // The listing's firstPage carries the same descriptors as noteMeta's page 0.
    const listing_vo = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqual(@as(usize, 1), listing_vo.entries.len);
    try expectSameLayers(meta.pages[0].layers, listing_vo.entries[0].firstPage.?.layers);

    // And so does `entryVO` (the rename response).
    const one = (try f.files.get(1, e.id)).?;
    defer freeEntry(testing.allocator, one);
    const renamed = try svc.entryVO(arena.allocator(), 1, one);
    try expectSameLayers(meta.pages[0].layers, renamed.firstPage.?.layers);
}

/// Absent stays absent (never `[]`); present matches field-for-field in order.
fn expectSameLayers(want: ?[]const LayerVO, got: ?[]const LayerVO) !void {
    if (want == null) return testing.expect(got == null);
    try testing.expect(got != null);
    try testing.expectEqual(want.?.len, got.?.len);
    for (want.?, got.?) |w, g| {
        try testing.expectEqualStrings(w.slot, g.slot);
        try testing.expectEqualStrings(w.name, g.name);
        try testing.expectEqual(w.visible, g.visible);
        try testing.expectEqual(w.isCurrent, g.isCurrent);
    }
}

test "listing/bin firstPage: layer descriptors ride along, and are OMITTED when the page has none" {
    const layers_edited = @embedFile("layers_edited.note");
    var f = try Fixture.init();
    defer f.deinit();

    var r = std.Io.Reader.fixed(layers_edited);
    const layered = try f.files.putFile(1, null, "layers.note", &r, null);
    defer testing.allocator.free(layered.name);
    defer if (layered.md5) |m| testing.allocator.free(m);

    // A page with no layer records at all.
    const empty_bytes = try nb.serialize(testing.allocator, .{
        .pages = &.{.{ .style = "style_white", .layers = &.{} }},
    });
    defer testing.allocator.free(empty_bytes);
    const plain = try seedBytes(&f, null, "plain.note", empty_bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(a, 1, layered.id)).?;
    var seen_layered = false;
    var seen_plain = false;
    const listed = try svc.listing(a, 1, null);
    for (listed.entries) |entry| {
        if (std.mem.eql(u8, entry.name, "layers.note")) {
            seen_layered = true;
            try expectSameLayers(meta.pages[0].layers, entry.firstPage.?.layers);
            try testing.expect(entry.firstPage.?.layers.?.len > 0);
        } else if (std.mem.eql(u8, entry.name, "plain.note")) {
            seen_plain = true;
            try testing.expect(entry.firstPage.?.layers == null);
        }
    }
    try testing.expect(seen_layered and seen_plain);

    try f.files.trash(1, layered.id);
    try f.files.trash(1, plain);
    const b = try svc.bin(a, 1);
    var bin_layered = false;
    var bin_plain = false;
    for (b.entries) |entry| {
        if (std.mem.eql(u8, entry.name, "layers.note")) {
            bin_layered = true;
            try expectSameLayers(meta.pages[0].layers, entry.firstPage.?.layers);
        } else if (std.mem.eql(u8, entry.name, "plain.note")) {
            bin_plain = true;
            try testing.expect(entry.firstPage.?.layers == null);
        }
    }
    try testing.expect(bin_layered and bin_plain);
}

test "page serving: streams an SNPG payload whose hash and length match what noteMeta advertised" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedNote(&f, null, "n.note", &.{ "AAAA", "BBBBBB" });

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;

    const pb = (try servePage(svc, arena.allocator(), 1, id, 1)).?;
    try testing.expect(pb.bytes.len > 0);
    try testing.expectEqualStrings("SNPG", pb.bytes[0..4]); // flattened page payload
    try testing.expectEqualStrings(meta.pages[1].hash, &pb.hash);
    try testing.expectEqual(pb.content_length, @as(u64, pb.bytes.len));

    try testing.expect((try servePage(svc, arena.allocator(), 1, id, 9)) == null);
    try testing.expect((try servePage(svc, arena.allocator(), 1, 99999, 0)) == null);
}

test "recognized text: noteMeta carries textHash, and pageText serves the transcript under it" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // Page 0 finished recognition, page 1 is still running.
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{
        .header = &.{
            .{ .key = "APPLY_EQUIPMENT", .value = "N6" },
            .{ .key = "FILE_RECOGN_TYPE", .value = "1" },
        },
        .pages = &.{
            .{
                .style = "style_white",
                .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
                .recogn_status = 1,
                .recogn_labels = &.{ "hello", "world" },
            },
            .{
                .style = "style_white",
                .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
                .recogn_status = 2, // still running: no text, no hash
            },
        },
    });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "rec.note", bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 2), meta.pages.len);
    try testing.expectEqual(@as(usize, 32), meta.pages[0].textHash.?.len);
    try testing.expect(meta.pages[1].textHash == null);
    // Separate from the content hash: recognition does not touch strokes.
    try testing.expect(!std.mem.eql(u8, meta.pages[0].hash, meta.pages[0].textHash.?));

    const pt = (try svc.pageText(a, 1, id, 0)).?;
    try testing.expectEqualStrings(meta.pages[0].textHash.?, &pt.hash);
    try testing.expectEqualStrings("hello\nworld", pt.vo.text.?); // v7: distinct recognized regions join with a newline, not a space

    try testing.expect((try svc.pageText(a, 1, id, 1)) == null);
    try testing.expect((try svc.pageText(a, 1, id, 99)) == null);
    try testing.expect((try svc.pageText(a, 1, 99999, 0)) == null);
    const dir = try f.files.createFolder(1, null, "D");
    defer testing.allocator.free(dir.name);
    try testing.expect((try svc.pageText(a, 1, dir.id, 0)) == null);

    const pdf = try seedBytes(&f, null, "x.pdf", "%PDF-1.7 nope");
    try testing.expect((try svc.pageText(a, 1, pdf, 0)) == null);
    const pdf_meta = (try svc.noteMeta(a, 1, pdf)).?;
    try testing.expect(pdf_meta.pages[0].textHash == null);

    // Index rows are md5-keyed and blobs dedupe, so scoping comes from `files`.
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try f.db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    try testing.expect((try svc.pageText(a, 2, id, 0)) == null);
}

test "template links: noteMeta carries linksHash, and pageLinks serves the records under it" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // §14 shape: a PDF-built page keeps its link rectangles; page 1 has none.
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{
            .{
                .style = "user_pdf_planner_1",
                .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
                .links = &.{
                    .{ .target_page = 3, .x = 901, .y = 192, .w = 407, .h = 50 },
                    // A URL carrying a comma and an `=`.
                    .{ .uri = "https://onplanners.com/g?a=1,2&b=3", .x = 53, .y = 464, .w = 297, .h = 121 },
                    .{ .uri = "javascript:alert(1)", .x = 10, .y = 10, .w = 50, .h = 50 },
                    .{ .target_page = 99, .x = 20, .y = 20, .w = 50, .h = 50 },
                    .{ .target_page = 2, .x = 30, .y = 30, .w = 0, .h = 40 },
                },
            },
            .{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .style = "user_pdf_planner_3", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "planner.note", bytes);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 32), meta.pages[0].linksHash.?.len);
    try testing.expect(meta.pages[1].linksHash == null);
    try testing.expect(!std.mem.eql(u8, meta.pages[0].hash, meta.pages[0].linksHash.?));

    const pl = (try svc.pageLinks(a, 1, id, 0)).?;
    try testing.expectEqualStrings(meta.pages[0].linksHash.?, &pl.hash);

    try testing.expectEqual(@as(usize, 2), pl.vo.links.len);

    // 1-based page 3 on the wire is index 2.
    const jump = pl.vo.links[0];
    try testing.expectEqual(@as(i64, 2), jump.page);
    try testing.expectEqual(@as(f64, 901), jump.x);
    try testing.expectEqual(@as(f64, 192), jump.y);
    try testing.expectEqual(@as(f64, 407), jump.w);
    try testing.expectEqual(@as(f64, 50), jump.h);

    // `none` is -1, and the URL survives its comma and `=` (§14 base64s fields).
    const web = pl.vo.links[1];
    try testing.expectEqual(@as(i64, -1), web.page);
    try testing.expectEqualStrings("https://onplanners.com/g?a=1,2&b=3", web.uri);

    try testing.expect((try svc.pageLinks(a, 1, id, 1)) == null);
    try testing.expect((try svc.pageLinks(a, 1, id, 99)) == null);
    try testing.expect((try svc.pageLinks(a, 1, 99999, 0)) == null);
    const dir = try f.files.createFolder(1, null, "D");
    defer gpa.free(dir.name);
    try testing.expect((try svc.pageLinks(a, 1, dir.id, 0)) == null);
    const pdf = try seedBytes(&f, null, "x.pdf", "%PDF-1.7 nope");
    try testing.expect((try svc.pageLinks(a, 1, pdf, 0)) == null);

    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try f.db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    try testing.expect((try svc.pageLinks(a, 2, id, 0)) == null);
}

test "template links: a block of nothing but unreadable records serves no links, not a failure" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{
        .pages = &.{.{
            .style = "user_pdf_x_1",
            .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
            .links = &.{.{ .target_page = 1, .w = 10, .h = 10 }},
        }},
    });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "junk.note", bytes);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    // Overwrite the block in place so the range validates but the content is junk.
    const meta = (try svc.noteMeta(a, 1, id)).?;
    try testing.expect(meta.pages[0].linksHash != null);
    var r = (try f.db.row(
        "SELECT links_offset, links_length FROM note_page_index WHERE page_index = 0;",
        &.{},
    )).?;
    const off: usize = @intCast(r.int(0));
    const len: usize = @intCast(r.int(1));
    r.finalize();
    @memset(bytes[off .. off + len], '!');
    const junked = try seedBytes(&f, null, "junked.note", bytes);

    const pl = (try svc.pageLinks(a, 1, junked, 0)).?;
    try testing.expectEqual(@as(usize, 0), pl.vo.links.len);
}

test "recognized text: a stored transcript that is NULL serializes to an empty body, not an error" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{ .pages = &.{.{
        .style = "style_white",
        .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
        .recogn_status = 1,
        .recogn_labels = &.{"hi"},
    }} });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "rec.note", bytes);

    // An undecodable RECOGNTEXT: range and hash kept, no transcript.
    try f.db.exec("UPDATE note_page_index SET text = NULL;");

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const pt = (try svc.pageText(arena.allocator(), 1, id, 0)).?;
    try testing.expect(pt.vo.text == null); // servable, just empty

    const body = try std.json.Stringify.valueAlloc(gpa, pt.vo, .{ .emit_null_optional_fields = false });
    defer gpa.free(body);
    try testing.expectEqualStrings("{}", body);
}

test "cross-user isolation: another user can't read the note" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try f.db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    const id = try seedNote(&f, null, "n.note", &.{"AAAA"});

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    try testing.expect((try svc.noteMeta(arena.allocator(), 2, id)) == null);
    try testing.expect((try servePage(svc, arena.allocator(), 2, id, 0)) == null);
    const empty = try svc.listing(arena.allocator(), 2, null);
    try testing.expectEqual(@as(usize, 0), empty.entries.len);
}

// ---- index-driven == the old parse-driven path ----

/// The pre-index projection, frozen: parse the whole blob and derive each
/// page's hash and dims (hardcoded default plus the `1090` swap). Proves the
/// index path changed nothing on the wire for real captures.
fn legacyPageRefs(arena: std.mem.Allocator, bytes: []const u8, file_md5: ?[]const u8) ![]const PageRefVO {
    const note = sn.parse(arena, bytes) catch {
        const one = try arena.alloc(PageRefVO, 1);
        one[0] = try fallbackPage(arena, file_md5, 0);
        return one;
    };
    const refs = try arena.alloc(PageRefVO, note.pages.len);
    for (note.pages, 0..) |page, i| {
        const d = sn.types.Dimensions.default;
        var w: i64 = d.width;
        var h: i64 = d.height;
        if (page.orientationRaw()) |o| {
            if (std.mem.eql(u8, o, "1090")) {
                const t = w;
                w = h;
                h = t;
            }
        }
        refs[i] = .{
            .index = @intCast(i),
            .hash = try arena.dupe(u8, &try pageContentHash(sn.Source.fromSlice(bytes), page)),
            .width = w,
            .height = h,
        };
    }
    return refs;
}

fn expectSameRefs(want: []const PageRefVO, got: []const PageRefVO) !void {
    try testing.expectEqual(want.len, got.len);
    for (want, got) |w, g| {
        try testing.expectEqual(w.index, g.index);
        try testing.expectEqualStrings(w.hash, g.hash);
        try testing.expectEqual(w.width, g.width);
        try testing.expectEqual(w.height, g.height);
    }
}

test "EQUIVALENCE: index-driven listing/noteMeta match the pre-migration parse-driven path" {
    for ([_][]const u8{ sample, sample2 }) |bytes| {
        var f = try Fixture.init();
        defer f.deinit();
        const id = try seedBytes(&f, null, "real.note", bytes);

        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var svc = ControlPlaneService.init(&f.files);

        const md5 = try md5Of(&f, id);
        const want = try legacyPageRefs(a, bytes, &md5);

        const meta = (try svc.noteMeta(a, 1, id)).?;
        try expectSameRefs(want, meta.pages);

        const root = try svc.listing(a, 1, null);
        try testing.expectEqual(@as(usize, 1), root.entries.len);
        const row = root.entries[0];
        try testing.expectEqual(@as(i64, @intCast(want.len)), row.pageCount.?);
        try expectSameRefs(want[0..1], (&row.firstPage.?)[0..1]);
    }
}

test "cold path: an unindexed blob is backfilled on first read, then served with no file at all" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedBytes(&f, null, "real.note", sample2);
    const md5 = try md5Of(&f, id);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    try f.db.exec("DELETE FROM note_index;");
    try testing.expect(!try noteindex.isCurrent(f.db, &md5));

    const cold = (try svc.noteMeta(a, 1, id)).?;
    try testing.expect(try noteindex.isCurrent(f.db, &md5)); // backfilled in-flight
    try expectSameRefs(try legacyPageRefs(a, sample2, &md5), cold.pages);

    // Delete the blob: the warm read must open no file.
    f.files.blobs.remove(&md5);
    try testing.expect(!f.files.blobs.has(&md5));

    const warm = (try svc.noteMeta(a, 1, id)).?;
    try expectSameRefs(cold.pages, warm.pages);
    const listed = try svc.listing(a, 1, null);
    try testing.expectEqual(cold.pages.len, @as(usize, @intCast(listed.entries[0].pageCount.?)));
    try expectSameRefs(cold.pages[0..1], (&listed.entries[0].firstPage.?)[0..1]);
}

test "a STALE index row is still repaired, though nothing asks isCurrent first" {
    // `indexRow` must filter on `index_version` like `isCurrent`, or the
    // read-first order would serve stale rows forever.
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedBytes(&f, null, "real.note", sample2);
    const md5 = try md5Of(&f, id);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);
    const fresh = (try svc.noteMeta(a, 1, id)).?;

    {
        var s = try f.db.prepare("UPDATE note_index SET index_version = ?1 WHERE blob_md5 = ?2;");
        defer s.finalize();
        s.bindInt(1, noteindex.index_version - 1);
        s.bindText(2, &md5);
        _ = try s.step();
    }
    try testing.expect(!try noteindex.isCurrent(f.db, &md5));

    const listed = try svc.listing(a, 1, null);
    try testing.expect(try noteindex.isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, @intCast(fresh.pages.len)), listed.entries[0].pageCount.?);
    try expectSameRefs(fresh.pages[0..1], (&listed.entries[0].firstPage.?)[0..1]);
}

test "fileType is verified from the container, not the filename" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try seedBytes(&f, null, "misnamed.pdf", sample);
    _ = try seedBytes(&f, null, "report.PDF", "%PDF-1.7 not a supernote container");
    _ = try seedBytes(&f, null, "scan.txt", "just some text");
    _ = try seedBytes(&f, null, "README", "no extension here");

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);
    const root = try svc.listing(arena.allocator(), 1, null);

    var seen: usize = 0;
    for (root.entries) |e| {
        seen += 1;
        if (std.mem.eql(u8, e.name, "misnamed.pdf")) {
            try testing.expectEqualStrings("note", e.fileType.?); // the bytes win
            try testing.expectEqual(@as(i64, 1), e.pageCount.?);
        } else if (std.mem.eql(u8, e.name, "report.PDF")) {
            try testing.expectEqualStrings("pdf", e.fileType.?); // lowercased, no dot
            try testing.expectEqual(@as(i64, 1), e.pageCount.?); // fallback placeholder page
            try testing.expectEqual(@as(i64, 1404), e.firstPage.?.width);
        } else if (std.mem.eql(u8, e.name, "scan.txt")) {
            try testing.expectEqualStrings("txt", e.fileType.?);
        } else if (std.mem.eql(u8, e.name, "README")) {
            try testing.expectEqualStrings(no_extension, e.fileType.?);
        } else unreachable;
    }
    try testing.expectEqual(@as(usize, 4), seen);

    const a = arena.allocator();
    try testing.expectEqualStrings("file", try extensionOf(a, ".keep")); // leading dot ≠ extension
    try testing.expectEqualStrings("file", try extensionOf(a, "trailing.")); // empty extension
    try testing.expectEqualStrings("gz", try extensionOf(a, "a.tar.gz")); // last dot wins
}

test "fileTypeFor: the parser's verdict wins over the name, and a mark says so" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try testing.expectEqualStrings("pdf", try fileTypeFor(a, false, null, "book.pdf"));
    try testing.expectEqualStrings("note", try fileTypeFor(a, false, null, "liar.note"));

    // The marker, not the name, distinguishes a mark.
    const mark: [4]u8 = "mark".*;
    try testing.expectEqualStrings("mark", try fileTypeFor(a, true, mark, "anything.note"));

    // A "note", NULL or unknown marker all say "note".
    const note: [4]u8 = "note".*;
    const other: [4]u8 = "xxxx".*;
    try testing.expectEqualStrings("note", try fileTypeFor(a, true, note, "a.note"));
    try testing.expectEqualStrings("note", try fileTypeFor(a, true, null, "a.note"));
    try testing.expectEqualStrings("note", try fileTypeFor(a, true, other, "a.note"));
}

test "hasRecognizedText means finished pages, not recognition merely enabled" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const enabled = &[_]nb.Kv{
        .{ .key = "APPLY_EQUIPMENT", .value = "N6" },
        .{ .key = "FILE_RECOGN_TYPE", .value = "1" },
        .{ .key = "FILE_RECOGN_LANGUAGE", .value = "pt_BR" },
    };
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const running = try nb.serialize(gpa, .{
        .header = enabled,
        .pages = &.{.{
            .style = "style_white",
            .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
            .recogn_status = 2, // still running — zero finished pages
        }},
    });
    defer gpa.free(running);
    const done = try nb.serialize(gpa, .{ .header = enabled, .pages = &.{
        .{
            .style = "style_white",
            .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
            .recogn_status = 1,
            .recogn_labels = &.{ "hello", "world" },
        },
        .{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
    } });
    defer gpa.free(done);

    _ = try seedBytes(&f, null, "running.note", running);
    _ = try seedBytes(&f, null, "done.note", done);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);
    const root = try svc.listing(arena.allocator(), 1, null);

    for (root.entries) |e| {
        const want = std.mem.eql(u8, e.name, "done.note");
        try testing.expectEqual(want, e.hasRecognizedText.?);
        try testing.expectEqualStrings("note", e.fileType.?);
    }

    // The badge agrees with what a find can reach: a finished page containing
    // the term (in-document search runs in the browser off this table).
    for (root.entries) |e| {
        var s = try f.db.prepare(
            "SELECT COUNT(*) FROM note_page_index p JOIN files f ON f.md5 = p.blob_md5 " ++
                "WHERE f.id = ?1 AND p.recogn_status = 1 AND p.text LIKE '%hello%';",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(try std.fmt.parseInt(u64, e.id, 10)));
        try testing.expect(try s.step());
        try testing.expectEqual(e.hasRecognizedText.?, s.columnInt(0) > 0);
    }

    _ = try seedBytes(&f, null, "x.pdf", "%PDF-1.7 nope");
    const again = try svc.listing(arena.allocator(), 1, null);
    for (again.entries) |e| {
        if (std.mem.eql(u8, e.name, "x.pdf")) try testing.expect(!e.hasRecognizedText.?);
    }
}

/// A `std.Io.Writer` that counts and drops bytes, so the test measures the
/// server rather than a growing collector.
const CountingSink = struct {
    writer: std.Io.Writer,
    total: u64 = 0,

    fn init() CountingSink {
        return .{ .writer = .{ .buffer = &.{}, .vtable = &.{ .drain = drain } } };
    }

    fn drain(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
        const self: *CountingSink = @alignCast(@fieldParentPtr("writer", w));
        var n: usize = 0;
        for (data[0 .. data.len - 1]) |d| n += d.len;
        n += data[data.len - 1].len * splat;
        self.total += n;
        return n;
    }
};

/// Peak *live* heap, measured by wrapping the allocator the service is handed.
const PeakAllocator = struct {
    child: std.mem.Allocator,
    live: usize = 0,
    peak: usize = 0,

    fn allocator(self: *PeakAllocator) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }
    fn grew(self: *PeakAllocator, n: usize) void {
        self.live += n;
        self.peak = @max(self.peak, self.live);
    }
    fn alloc(ctx: *anyopaque, len: usize, a: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        const p = self.child.rawAlloc(len, a, ra) orelse return null;
        self.grew(len);
        return p;
    }
    fn resize(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, new_len: usize, ra: usize) bool {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        if (!self.child.rawResize(m, a, new_len, ra)) return false;
        self.live -= m.len;
        self.grew(new_len);
        return true;
    }
    fn remap(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, new_len: usize, ra: usize) ?[*]u8 {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        const p = self.child.rawRemap(m, a, new_len, ra) orelse return null;
        self.live -= m.len;
        self.grew(new_len);
        return p;
    }
    fn free(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, ra: usize) void {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        self.child.rawFree(m, a, ra);
        self.live -= m.len;
    }
};

test "THE MEMORY CLAIM: serving a page holds one chunk, not the page and not the note" {
    // The service gets a peak-tracking allocator while serving an 8 MiB layer.
    const gpa = testing.allocator;
    var f = try Fixture.init();
    defer f.deinit();
    defer f.files.gpa = gpa;

    // 8 and 16 MiB layers; equal-length names keep the duped `Entry.name` constant.
    const ids = blk: {
        var out: [2]u64 = undefined;
        for ([_]usize{ 8, 16 }, [_][]const u8{ "a.note", "b.note" }, 0..) |mib, name, i| {
            const layer = try gpa.alloc(u8, mib * 1024 * 1024);
            defer gpa.free(layer);
            for (layer, 0..) |*b, j| b.* = @truncate(j * 31 + 7);
            const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
                .{ .slot = .main, .bitmap = layer },
            } }} });
            defer gpa.free(bytes);
            try testing.expect(bytes.len > mib * 1024 * 1024);
            out[i] = try seedBytes(&f, null, name, bytes);
        }
        break :blk out;
    };

    var peaks: [2]usize = undefined;
    var served: [2]u64 = undefined;
    for (ids, 0..) |id, i| {
        var counter = PeakAllocator{ .child = gpa };
        f.files.gpa = counter.allocator();
        var svc = ControlPlaneService.init(&f.files);

        const planned = (try svc.pagePlan(1, id, 0)).?;
        var sink = CountingSink.init();
        try svc.writePage(planned, &sink.writer);

        try testing.expectEqual(planned.plan.content_length, sink.total);
        try testing.expect(sink.total > 8 * 1024 * 1024);

        peaks[i] = counter.peak;
        served[i] = sink.total;
        f.files.gpa = gpa;
    }

    // Peak live heap stays under one chunk while serving far more...
    for (peaks, served) |peak, total| {
        try testing.expect(peak < blobstore.chunk_len);
        try testing.expect(peak * 100 < total);
    }
    // ...and does not scale with page size.
    try testing.expect(served[1] > 2 * served[0] - 4096);
    try testing.expectEqual(peaks[0], peaks[1]);
}

test "FINDING #8: noteMeta's per-page dims match the SNPG payload's, on a non-default device" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // An N5 note is 1920×2560; the dims must match the SNPG header, not 1404×1872.
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N5" }},
        .pages = &.{
            .{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .style = "style_5mm_dots", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "n5.note", bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;
    try testing.expectEqual(@as(usize, 2), meta.pages.len);

    for (meta.pages, 0..) |p, i| {
        const pb = (try servePage(svc, arena.allocator(), 1, id, i)).?;
        try testing.expectEqualStrings(p.hash, &pb.hash);
        // SNPG header: MAGIC[4] VERSION[1] variant[1] reserved[2] width[4] height[4].
        const w = std.mem.readInt(u32, pb.bytes[8..12], .little);
        const h = std.mem.readInt(u32, pb.bytes[12..16], .little);
        try testing.expectEqual(@as(i64, w), p.width);
        try testing.expectEqual(@as(i64, h), p.height);
        try testing.expectEqual(@as(i64, 1920), p.width);
        try testing.expectEqual(@as(i64, 2560), p.height);
    }

    const root = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqual(meta.pages[0].width, root.entries[0].firstPage.?.width);
    try testing.expectEqual(meta.pages[0].height, root.entries[0].firstPage.?.height);
}

test "bin: a trashed note carries its real first page; a folder and an unparseable blob carry none" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Work");
    defer testing.allocator.free(dir.name);
    _ = try seedNote(&f, dir.id, "deep.note", &.{ "AAAA", "BBBBBB" });
    const other = try seedBytes(&f, null, "shot.png", "not a note container");

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    // Taken before the delete: the bin must agree (same blob, same cache key).
    const live = try svc.listing(arena.allocator(), 1, dir.id);
    const live_page = live.entries[0].firstPage.?;

    try f.files.trash(1, dir.id);
    try f.files.trash(1, other);

    const b = try svc.bin(arena.allocator(), 1);
    try testing.expectEqual(@as(usize, 3), b.entries.len);

    var seen_note = false;
    for (b.entries) |e| {
        if (std.mem.eql(u8, e.name, "deep.note")) {
            seen_note = true;
            const p = e.firstPage.?;
            try testing.expectEqual(@as(i64, 0), p.index);
            try testing.expectEqualStrings(live_page.hash, p.hash);
            try testing.expectEqual(live_page.width, p.width);
            try testing.expectEqual(live_page.height, p.height);
            try testing.expectEqual(@as(i64, 1404), e.thumbAspect.?.w);
            try testing.expectEqual(@as(i64, 1872), e.thumbAspect.?.h);
        }
        if (std.mem.eql(u8, e.name, "Work")) {
            try testing.expect(e.firstPage == null);
            try testing.expect(e.thumbAspect == null);
        }
        if (std.mem.eql(u8, e.name, "shot.png")) {
            try testing.expect(e.firstPage == null);
            try testing.expect(e.thumbAspect == null);
        }
    }
    try testing.expect(seen_note);
}

// ---- thumbAspect ----

/// A minimal PNG whose IHDR says 320×240 (as in `spd_index.zig`'s tests).
const mini_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

/// A minimal `.spd` (SQLite with a `config` thumbnail), caller-owned bytes.
fn buildSpdBytes(thumb: []const u8) ![]u8 {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE config(name TEXT PRIMARY KEY NOT NULL, value BLOB);");
    try db.exec("INSERT INTO config(name, value) VALUES('fmt_ver', '2');");
    var s = try db.prepare("INSERT INTO config(name, value) VALUES('thumbnail', ?1);");
    defer s.finalize();
    s.bindBlob(1, thumb);
    _ = try s.step();
    return db.serializeAlloc(testing.allocator);
}

/// The root listing's entry named `name`, or a failed expectation.
fn entryNamed(vo: ListingVO, name: []const u8) !EntryVO {
    for (vo.entries) |e| {
        if (std.mem.eql(u8, e.name, name)) return e;
    }
    return error.TestUnexpectedResult;
}

test "noteMeta: a PDF finds the .mark beside it, by full name and same folder" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const mark_bytes = try nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{.{ .number = 2, .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
    });
    defer gpa.free(mark_bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    // The extension is appended: `manual.pdf.mark`, not `manual.mark`.
    const folder = try f.files.createFolder(1, null, "Docs");
    testing.allocator.free(folder.name);
    const pdf_id = try seedBytes(&f, folder.id, "manual.pdf", "%PDF-1.7\n%%EOF\n");
    const mark_id = try seedBytes(&f, folder.id, "manual.pdf.mark", mark_bytes);

    const meta = (try svc.noteMeta(a, 1, pdf_id)).?;
    try testing.expect(meta.annotationsId != null);
    try testing.expectEqualStrings(try idStr(a, mark_id), meta.annotationsId.?);

    const lonely = try seedBytes(&f, folder.id, "lease.pdf", "%PDF-1.7\n%%EOF\n");
    try testing.expect((try svc.noteMeta(a, 1, lonely)).?.annotationsId == null);

    // Same name in a different folder is no match.
    const elsewhere = try seedBytes(&f, null, "away.pdf", "%PDF-1.7\n%%EOF\n");
    _ = try seedBytes(&f, folder.id, "away.pdf.mark", mark_bytes);
    try testing.expect((try svc.noteMeta(a, 1, elsewhere)).?.annotationsId == null);

    try testing.expect((try svc.noteMeta(a, 1, mark_id)).?.annotationsId == null);

    // A `.note` named `sneaky.pdf` is a note and gets no annotations.
    const book = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }} });
    defer gpa.free(book);
    const sneaky = try seedBytes(&f, folder.id, "sneaky.pdf", book);
    _ = try seedBytes(&f, folder.id, "sneaky.pdf.mark", mark_bytes);
    const sm = (try svc.noteMeta(a, 1, sneaky)).?;
    try testing.expectEqualStrings("note", sm.fileType.?);
    try testing.expect(sm.annotationsId == null);
}

test "listing: a document's row names the .mark folded out from behind it" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const mark_bytes = try nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{.{ .number = 2, .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
    });
    defer gpa.free(mark_bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const folder = try f.files.createFolder(1, null, "Docs");
    testing.allocator.free(folder.name);
    const pdf_id = try seedBytes(&f, null, "manual.pdf", "%PDF-1.7\n%%EOF\n");
    const mark_id = try seedBytes(&f, null, "manual.pdf.mark", mark_bytes);
    _ = try seedBytes(&f, null, "lease.pdf", "%PDF-1.7\n%%EOF\n");

    const root = try svc.listing(a, 1, null);

    // The pair is one row, and that row names the mark.
    for (root.entries) |e| try testing.expect(!std.mem.eql(u8, e.name, "manual.pdf.mark"));
    const doc = try entryNamed(root, "manual.pdf");
    try testing.expectEqualStrings(try idStr(a, mark_id), doc.annotationsId.?);

    // The per-file route uses a different query; pin that they agree.
    const meta = (try svc.noteMeta(a, 1, pdf_id)).?;
    try testing.expectEqualStrings(meta.annotationsId.?, doc.annotationsId.?);

    // No mark, or a folder: the key is omitted, not null.
    const opts: std.json.Stringify.Options = .{ .emit_null_optional_fields = false };
    const alone = try entryNamed(root, "lease.pdf");
    try testing.expect(alone.annotationsId == null);
    try testing.expect(std.mem.indexOf(u8, try std.json.Stringify.valueAlloc(a, alone, opts), "annotationsId") == null);
    const dir = try entryNamed(root, "Docs");
    try testing.expect(dir.annotationsId == null);
    try testing.expect(std.mem.indexOf(u8, try std.json.Stringify.valueAlloc(a, dir, opts), "annotationsId") == null);
    try testing.expect(std.mem.indexOf(u8, try std.json.Stringify.valueAlloc(a, doc, opts), "annotationsId") != null);

    // The verified type gates it here too.
    const book = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }} });
    defer gpa.free(book);
    const sneaky = try seedBytes(&f, null, "sneaky.pdf", book);
    _ = try seedBytes(&f, null, "sneaky.pdf.mark", mark_bytes);
    const again = try svc.listing(a, 1, null);
    const s_row = try entryNamed(again, "sneaky.pdf");
    try testing.expectEqualStrings("note", s_row.fileType.?);
    try testing.expect(s_row.annotationsId == null);
    try testing.expect((try svc.noteMeta(a, 1, sneaky)).?.annotationsId == null);
}

test "listing: a trashed document is never offered a live mark" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    // Trash first, ink after: the only order leaving a live mark beside a
    // trashed document, since `trash` carries pairs together.
    const doc = try seedBytes(&f, null, "old.pdf", "%PDF-1.7\n%%EOF\n");
    try f.files.trash(1, doc);
    _ = try seedBytes(&f, null, "old.pdf.mark", "bbbb");

    const root = try svc.listing(a, 1, null);
    try testing.expectError(error.TestUnexpectedResult, entryNamed(root, "old.pdf"));

    // `BinEntryVO` has no `annotationsId`; the per-file bin meta answers null.
    const b = try svc.bin(a, 1);
    var seen = false;
    for (b.entries) |e| {
        if (std.mem.eql(u8, e.name, "old.pdf")) seen = true;
    }
    try testing.expect(seen);
    try testing.expect((try svc.binNoteMeta(a, 1, doc)).?.annotationsId == null);
}

test "noteMeta: a sparse .mark carries sourcePage; a notebook omits it entirely" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    // PDF pages 2, 5 and 6.
    const mark = try nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{
            .{ .number = 2, .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .number = 5, .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .number = 6, .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
    defer gpa.free(mark);
    const mark_id = try seedBytes(&f, null, "annotated.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const mm = (try svc.noteMeta(arena.allocator(), 1, mark_id)).?;
    try testing.expectEqual(@as(usize, 3), mm.pages.len);
    const want = [_]i64{ 2, 5, 6 };
    for (mm.pages, want, 0..) |pg, n, i| {
        try testing.expectEqual(@as(i64, @intCast(i)), pg.index);
        try testing.expectEqual(n, pg.sourcePage.?);
    }

    // A notebook omits it.
    const book = try nb.serialize(gpa, .{
        .pages = &.{
            .{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
    defer gpa.free(book);
    const book_id = try seedBytes(&f, null, "book.note", book);
    const bm = (try svc.noteMeta(arena.allocator(), 1, book_id)).?;
    try testing.expectEqual(@as(usize, 2), bm.pages.len);
    for (bm.pages) |pg| try testing.expect(pg.sourcePage == null);

    // A zero (pre-v7 rows, `.txt` rows) is omitted too: there is no page 0.
    {
        var u = try f.db.prepare("UPDATE note_page_index SET source_page = 0;");
        defer u.finalize();
        try testing.expect(!try u.step());
    }
    const zeroed = (try svc.noteMeta(arena.allocator(), 1, mark_id)).?;
    for (zeroed.pages) |pg| try testing.expect(pg.sourcePage == null);
}

test "noteMeta: hasInk travels for a page that was looked at, and is OMITTED for one that was not" {
    // `false` is an answer and travels; NULL (not yet scanned) is omitted.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // One page written, one erased back to nothing (§2.1).
    const stroke = [_]u8{ 0x62, 0xFF, 0x61, 0x20, 0x62, 0xFF };
    const rubbed_out = [_]u8{ 0x62, 0xFF, 0x62, 0xFF };
    const mark = try nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{
            .{ .number = 2, .layers = &.{.{ .slot = .main, .bitmap = &stroke }} },
            .{ .number = 5, .layers = &.{.{ .slot = .main, .bitmap = &rubbed_out }} },
        },
    });
    defer gpa.free(mark);
    const id = try seedBytes(&f, null, "annotated.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const mm = (try svc.noteMeta(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 2), mm.pages.len);
    try testing.expectEqual(@as(?bool, true), mm.pages[0].hasInk);
    try testing.expectEqual(@as(?bool, false), mm.pages[1].hasInk);
    try testing.expectEqual(@as(i64, 2), mm.pages[0].sourcePage.?);
    try testing.expectEqual(@as(i64, 5), mm.pages[1].sourcePage.?);

    const opts: std.json.Stringify.Options = .{ .emit_null_optional_fields = false };
    const inked_json = try std.json.Stringify.valueAlloc(a, mm.pages[0], opts);
    try testing.expect(std.mem.indexOf(u8, inked_json, "\"hasInk\":true") != null);
    const empty_json = try std.json.Stringify.valueAlloc(a, mm.pages[1], opts);
    try testing.expect(std.mem.indexOf(u8, empty_json, "\"hasInk\":false") != null);

    // An unscanned page (has_ink NULL) carries no field.
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    const unlooked = (try svc.noteMeta(a, 1, id)).?;
    for (unlooked.pages) |pg| try testing.expect(pg.hasInk == null);
    const omitted_json = try std.json.Stringify.valueAlloc(a, unlooked.pages[0], opts);
    try testing.expect(std.mem.indexOf(u8, omitted_json, "hasInk") == null);
}

test "thumbAspect: cover dims when a cover ships, page-0 EFFECTIVE dims otherwise, absent for the shapeless" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const covered = try nb.serialize(gpa, .{
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
        .covers = &.{.{ .bytes = mini_png }},
    });
    defer gpa.free(covered);
    _ = try seedBytes(&f, null, "covered.note", covered);

    // Coverless landscape: stored page dims are already orientation-applied.
    const landscape = try nb.serialize(gpa, .{
        .pages = &.{.{ .style = "style_white", .orientation = "1090", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
    });
    defer gpa.free(landscape);
    _ = try seedBytes(&f, null, "landscape.note", landscape);

    _ = try seedNote(&f, null, "portrait.note", &.{"AAAA"});
    _ = try seedBytes(&f, null, "photo.png", "png-shaped bytes, but not indexed server-side");
    _ = try seedBytes(&f, null, "notes.txt", "plain text");
    const dir = try f.files.createFolder(1, null, "Folder");
    defer testing.allocator.free(dir.name);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);
    const root = try svc.listing(a, 1, null);

    const cov = try entryNamed(root, "covered.note");
    try testing.expectEqual(@as(i64, 320), cov.thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 240), cov.thumbAspect.?.h);

    const land = try entryNamed(root, "landscape.note");
    try testing.expectEqual(@as(i64, 1872), land.thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 1404), land.thumbAspect.?.h);

    const port = try entryNamed(root, "portrait.note");
    try testing.expectEqual(@as(i64, 1404), port.thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 1872), port.thumbAspect.?.h);

    try testing.expect((try entryNamed(root, "photo.png")).thumbAspect == null);
    try testing.expect((try entryNamed(root, "notes.txt")).thumbAspect == null);
    try testing.expect((try entryNamed(root, "Folder")).thumbAspect == null);

    // Absent is a missing key, never `"thumbAspect":null`.
    const with = try std.json.Stringify.valueAlloc(a, cov, .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, with, "\"thumbAspect\":{\"w\":320,\"h\":240}") != null);
    const without = try std.json.Stringify.valueAlloc(a, try entryNamed(root, "photo.png"), .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, without, "thumbAspect") == null);
}

test "thumbAspect: a .spd serves its thumbnail's dims, live and in the bin; a stale spd row omits" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const spd_bytes = try buildSpdBytes(mini_png);
    defer gpa.free(spd_bytes);
    const id = try seedBytes(&f, null, "drawing.spd", spd_bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const live = try entryNamed(try svc.listing(a, 1, null), "drawing.spd");
    try testing.expectEqualStrings("spd", live.fileType.?);
    try testing.expectEqual(@as(i64, 320), live.thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 240), live.thumbAspect.?.h);

    try f.files.trash(1, id);
    const b = try svc.bin(a, 1);
    try testing.expectEqual(@as(usize, 1), b.entries.len);
    try testing.expectEqual(@as(i64, 320), b.entries[0].thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 240), b.entries[0].thumbAspect.?.h);
    const json = try std.json.Stringify.valueAlloc(a, b.entries[0], .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, json, "\"thumbAspect\":{\"w\":320,\"h\":240}") != null);

    // A stale spd row drops out via the LEFT JOIN's version filter (it heals in
    // `Files.repairDerivedThumb`, not here).
    try f.db.exec("UPDATE spd_index SET index_version = 0;");
    const stale = try svc.bin(a, 1);
    try testing.expect(stale.entries[0].thumbAspect == null);
}

test "thumbAspect: the bin HEALS a stale note index row (firstPage + aspect restored)" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedNote(&f, null, "n.note", &.{"AAAA"});

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    try f.files.trash(1, id);
    try f.db.exec("UPDATE note_index SET index_version = 0;");

    const b = try svc.bin(a, 1);
    try testing.expectEqual(@as(usize, 1), b.entries.len);
    try testing.expect(b.entries[0].firstPage != null);
    try testing.expect(b.entries[0].thumbAspect != null);
    try testing.expect((try svc.bin(a, 1)).entries[0].firstPage != null);
}

// ---- wire contract fixtures ----
//
// Each test serialises a VO with the handlers' options and compares the exact
// bytes against `webapp/tests/fixtures/wire/`, which
// `webapp/tests/unit/wireContract.ts` reads back through the client
// normalizers, so a field dropped on either side fails a test. Regenerate with
// `INK_UPDATE_WIRE_FIXTURES=1 zig build test` and read the diff.

const wire_dir = "webapp/tests/fixtures/wire";

/// Set non-empty to write the fixtures instead of comparing.
const wire_update_env = "INK_UPDATE_WIRE_FIXTURES";

/// The handlers' options: null optionals become absent keys.
const wire_opts: std.json.Stringify.Options = .{ .emit_null_optional_fields = false };

/// Pinned epoch-ms for wall-clock fields, so fixtures are stable.
const wire_time_ms: i64 = 1_700_000_000_000;

/// `std.c` is available because this module links libc.
fn wireUpdating() bool {
    const v = std.c.getenv(wire_update_env) orelse return false;
    return v[0] != 0;
}

/// The repo root, by walking up from the test's unspecified cwd. The marker is
/// `webapp/src/api/client.ts` because nested packages have their own
/// `build.zig.zon`.
fn openRepoRoot() !std.Io.Dir {
    for ([_][]const u8{ ".", "..", "../..", "../../..", "../../../.." }) |rel| {
        var d = std.Io.Dir.cwd().openDir(testing.io, rel, .{}) catch continue;
        if (d.access(testing.io, "webapp/src/api/client.ts", .{})) |_| return d else |_| {}
        d.close(testing.io);
    }
    std.debug.print(
        "\nwire fixtures: could not find the repo root by walking up from the test's cwd\n" ++
            "(looked for webapp/src/api/client.ts). Run the suite as `zig build test` from the repo root.\n",
        .{},
    );
    return error.RepoRootNotFound;
}

/// Compares `vo`'s serialisation with `wire/<name>`, or writes it when updating.
fn expectWireFixture(name: []const u8, vo: anytype) !void {
    const gpa = testing.allocator;
    const json = try std.json.Stringify.valueAlloc(gpa, vo, wire_opts);
    defer gpa.free(json);

    var root = try openRepoRoot();
    defer root.close(testing.io);

    var path_buf: [256]u8 = undefined;
    const rel = try std.fmt.bufPrint(&path_buf, wire_dir ++ "/{s}", .{name});

    if (wireUpdating()) {
        try root.createDirPath(testing.io, wire_dir);
        return root.writeFile(testing.io, .{ .sub_path = rel, .data = json });
    }

    const have = root.readFileAlloc(testing.io, rel, gpa, .limited(1 << 20)) catch |err| {
        std.debug.print(
            "\nwire fixture {s} could not be read ({t}).\n" ++
                "Regenerate it with: INK_UPDATE_WIRE_FIXTURES=1 zig build test\n",
            .{ rel, err },
        );
        return err;
    };
    defer gpa.free(have);

    if (!std.mem.eql(u8, have, json)) {
        std.debug.print(
            "\nWIRE CONTRACT DRIFT in {s}\n" ++
                "The server no longer produces the committed bytes for this shape. If the\n" ++
                "change is intended, regenerate and read the diff as a wire change:\n" ++
                "    INK_UPDATE_WIRE_FIXTURES=1 zig build test && git diff {s}\n" ++
                "Then update the key table in webapp/tests/unit/wireContract.test.ts, which\n" ++
                "is what decides whether the client consumes the new field.\n",
            .{ rel, rel },
        );
        try testing.expectEqualStrings(have, json);
        return error.WireFixtureMismatch;
    }
}

fn pinEntryTime(e: EntryVO) EntryVO {
    var out = e;
    if (out.updatedAt != null) out.updatedAt = wire_time_ms;
    return out;
}

/// `vo` with every row's stamp pinned.
fn pinListingTimes(a: std.mem.Allocator, vo: ListingVO) !ListingVO {
    const entries = try a.alloc(EntryVO, vo.entries.len);
    for (vo.entries, entries) |src, *dst| dst.* = pinEntryTime(src);
    return .{ .folderId = vo.folderId, .path = vo.path, .entries = entries, .syncVersion = vo.syncVersion };
}

/// Versions pinned one second apart so the order still shows.
fn pinHistoryTimes(a: std.mem.Allocator, vo: HistoryVO) !HistoryVO {
    const versions = try a.alloc(HistoryVersionVO, vo.versions.len);
    for (vo.versions, versions, 0..) |src, *dst, i| {
        dst.* = src;
        dst.createdAt = wire_time_ms - @as(i64, @intCast(i)) * 1000;
    }
    return .{ .id = vo.id, .versions = versions };
}

/// A two-page N6 note: page 0 recognized and carrying template links, page 1
/// with neither, so each optional is both present and absent in the fixtures.
/// N6 is the only code in the mm allowlist, hence the only one with `pxPerMm`.
fn wireRecognizedNote(gpa: std.mem.Allocator, bmp: []const u8) ![]u8 {
    const words = [_]nb.WordSpec{
        .{ .label = "hello", .box = .{ .x = 10.5, .y = 20.25, .width = 15.0, .height = 6.5 } },
        .{ .label = "world", .box = .{ .x = 27.0, .y = 20.25, .width = 17.5, .height = 6.5 } },
    };
    const els = [_]nb.ElementSpec{.{ .label = "hello world", .words = &words }};
    const links = [_]nb.LinkSpec{.{ .x = 100, .y = 200, .w = 300, .h = 40, .uri = "https://example.org/" }};
    return nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{
            .{
                .style = "style_white",
                .layers = &.{.{ .slot = .main, .bitmap = bmp }},
                .recogn_status = 1,
                .recogn_elements = &els,
                .links = &links,
            },
            .{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = bmp }} },
        },
    });
}

/// A `.mark` over PDF pages 2 and 5, page 5 erased (`hasInk = false`).
fn wireMarkBytes(gpa: std.mem.Allocator) ![]u8 {
    const stroke = [_]u8{ 0x62, 0xFF, 0x61, 0x20, 0x62, 0xFF };
    const rubbed_out = [_]u8{ 0x62, 0xFF, 0x62, 0xFF };
    return nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{
            .{ .number = 2, .layers = &.{.{ .slot = .main, .bitmap = &stroke }} },
            .{ .number = 5, .layers = &.{.{ .slot = .main, .bitmap = &rubbed_out }} },
        },
    });
}

test "wire contract: PageRefVO — a page nobody has scanned omits BOTH hasInk and sourcePage" {
    // `sourcePage` is absent as derivable, `hasInk` as unknown; the client reads
    // these differently (`PageRef` in `core/types.ts`).
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedNote(&f, null, "n.note", &.{"AAAA"});

    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;
    try testing.expect(meta.pages[0].hasInk == null);
    try testing.expect(meta.pages[0].sourcePage == null);
    try expectWireFixture("page-ref.json", meta.pages[0]);
}

test "wire contract: PageRefVO — a mark page carries sourcePage and hasInk, true and false" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const mark = try wireMarkBytes(gpa);
    defer gpa.free(mark);
    const id = try seedBytes(&f, null, "annotated.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;
    try testing.expectEqual(@as(usize, 2), meta.pages.len);

    try testing.expectEqual(@as(i64, 2), meta.pages[0].sourcePage.?);
    try testing.expectEqual(@as(?bool, true), meta.pages[0].hasInk);
    try expectWireFixture("page-ref-inked.json", meta.pages[0]);

    // `hasInk` false travels; only unknown is omitted.
    try testing.expectEqual(@as(i64, 5), meta.pages[1].sourcePage.?);
    try testing.expectEqual(@as(?bool, false), meta.pages[1].hasInk);
    try expectWireFixture("page-ref-sparse-mark.json", meta.pages[1]);
}

test "wire contract: NoteMetaVO — a recognized N6 note, and an annotated PDF" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const note = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(note);
    const note_id = try seedBytes(&f, null, "recognized.note", note);

    const mark = try wireMarkBytes(gpa);
    defer gpa.free(mark);
    const pdf_id = try seedBytes(&f, null, "manual.pdf", "%PDF-1.7\n%%EOF\n");
    _ = try seedBytes(&f, null, "manual.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(a, 1, note_id)).?;
    try testing.expect(meta.pages[0].textHash != null);
    try testing.expect(meta.pages[0].linksHash != null);
    try testing.expect(meta.pages[1].textHash == null);
    try testing.expect(meta.pages[1].linksHash == null);
    try testing.expect(meta.pxPerMm != null);
    try testing.expect(meta.annotationsId == null);
    try expectWireFixture("note-meta.json", meta);

    const doc = (try svc.noteMeta(a, 1, pdf_id)).?;
    try testing.expectEqualStrings("pdf", doc.fileType.?);
    try testing.expect(doc.annotationsId != null);
    try testing.expect(doc.pxPerMm == null);
    try expectWireFixture("note-meta-pdf-with-mark.json", doc);
}

test "wire contract: EntryVO — a note row, and a PDF row naming its mark" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const note = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(note);
    _ = try seedBytes(&f, null, "recognized.note", note);

    const mark = try wireMarkBytes(gpa);
    defer gpa.free(mark);
    _ = try seedBytes(&f, null, "manual.pdf", "%PDF-1.7\n%%EOF\n");
    _ = try seedBytes(&f, null, "manual.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);
    const root = try svc.listing(a, 1, null);

    const row = try entryNamed(root, "recognized.note");
    try testing.expect(row.hasRecognizedText.?);
    try testing.expect(row.thumbAspect != null);
    try testing.expect(row.annotationsId == null);
    try testing.expect(row.itemCount == null);
    try expectWireFixture("entry.json", pinEntryTime(row));

    const doc = try entryNamed(root, "manual.pdf");
    try testing.expect(doc.annotationsId != null);
    try expectWireFixture("entry-annotated-pdf.json", pinEntryTime(doc));
}

test "wire contract: ListingVO — a subfolder listing, breadcrumb and all" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    // A subfolder, so `folderId` and `path` are both present.
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const sub = try f.files.createFolder(1, docs.id, "Sub");
    defer testing.allocator.free(sub.name);

    const note = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(note);
    _ = try seedBytes(&f, docs.id, "recognized.note", note);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const vo = try svc.listing(a, 1, docs.id);
    // The breadcrumb has no count; the child folder row does.
    try testing.expectEqual(@as(usize, 1), vo.path.len);
    try testing.expect(vo.path[0].itemCount == null);
    try testing.expectEqual(@as(usize, 2), vo.entries.len);
    try expectWireFixture("listing.json", try pinListingTimes(a, vo));
}

test "wire contract: HistoryVO — the live version flagged, a retained one behind it" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    // Re-uploading the same name retains the first version.
    const v1 = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }} });
    defer gpa.free(v1);
    const id = try seedBytes(&f, null, "n.note", v1);
    const v2 = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(v2);
    _ = try seedBytes(&f, null, "n.note", v2);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const vo = (try svc.history(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 2), vo.versions.len);
    try testing.expect(vo.versions[0].current);
    // `current` is a plain bool, so false is emitted.
    try testing.expect(!vo.versions[1].current);
    try expectWireFixture("history.json", try pinHistoryTimes(a, vo));
}

test "wire contract: PageTextVO — the transcript and its positioned words, in millimetres" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const note = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(note);
    const id = try seedBytes(&f, null, "recognized.note", note);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const pt = (try svc.pageText(arena.allocator(), 1, id, 0)).?;
    try testing.expect(pt.vo.text != null);
    try testing.expect(pt.vo.words != null);
    try expectWireFixture("page-text.json", pt.vo);
}
