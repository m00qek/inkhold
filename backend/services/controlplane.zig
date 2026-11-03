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

test {
    _ = @import("controlplane/listing_test.zig");
    _ = @import("controlplane/index_test.zig");
    _ = @import("controlplane/mark_test.zig");
    _ = @import("controlplane/aspect_test.zig");
    _ = @import("controlplane/wire_test.zig");
}

// ---- tests of private helpers ----

const testing = std.testing;
const nb = @import("note_builder");
const fixture = @import("controlplane/fixture.zig");
const Fixture = fixture.Fixture;
const seedBytes = fixture.seedBytes;
const expectSameLayers = fixture.expectSameLayers;
const entryNamed = fixture.entryNamed;

/// Real device captures. Local fixtures only — they are not redistributed.
const sample = @embedFile("sample.note");

const sample2 = @embedFile("sample-2.note");

/// The md5 of the blob behind file `id`, as an owned 32-hex array.
fn md5Of(f: *Fixture, id: u64) ![blobstore.md5_hex_len]u8 {
    const e = (try f.files.get(1, id)).?;
    defer freeEntry(testing.allocator, e);
    var out: [blobstore.md5_hex_len]u8 = undefined;
    @memcpy(&out, e.md5.?[0..blobstore.md5_hex_len]);
    return out;
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
