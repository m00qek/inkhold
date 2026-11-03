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
const controlplane_meta = @import("controlplane_meta.zig");
const controlplane_history = @import("controlplane_history.zig");
const controlplane_text = @import("controlplane_text.zig");
const controlplane_index = @import("controlplane_index.zig");

const controlplane_vo = @import("controlplane_vo.zig");
pub const PageRefVO = controlplane_vo.PageRefVO;
pub const LayerVO = controlplane_vo.LayerVO;
pub const AspectVO = controlplane_vo.AspectVO;
pub const FolderVO = controlplane_vo.FolderVO;
pub const EntryVO = controlplane_vo.EntryVO;
pub const ListingVO = controlplane_vo.ListingVO;
pub const NoteMetaVO = controlplane_vo.NoteMetaVO;
pub const BinEntryVO = controlplane_vo.BinEntryVO;
pub const BinVO = controlplane_vo.BinVO;
pub const RestoredVO = controlplane_vo.RestoredVO;
pub const TrashedVO = controlplane_vo.TrashedVO;
pub const EmptiedVO = controlplane_vo.EmptiedVO;
pub const HistoryVersionVO = controlplane_vo.HistoryVersionVO;
pub const HistoryVO = controlplane_vo.HistoryVO;
pub const RestoredVersionVO = controlplane_vo.RestoredVersionVO;
pub const PagePlan = controlplane_vo.PagePlan;
pub const TemplatePlan = controlplane_vo.TemplatePlan;
pub const max_template_hash_len = controlplane_vo.max_template_hash_len;
pub const WordVO = controlplane_vo.WordVO;
pub const PageTextVO = controlplane_vo.PageTextVO;
pub const PageText = controlplane_vo.PageText;
pub const LinkVO = controlplane_vo.LinkVO;
pub const PageLinksVO = controlplane_vo.PageLinksVO;
pub const PageLinks = controlplane_vo.PageLinks;
pub const allowedLinkScheme = controlplane_vo.allowedLinkScheme;

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

    /// Resolves `GET /note/{id}/page/{n}` into a `PagePlan` for the SNPG page
    /// payload. Null if missing, not owned, or not a `.note`.
    pub fn pagePlan(self: ControlPlaneService, user_id: u64, id: u64, n: u64) !?PagePlan {
        const entry = (try self.files.get(user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        return self.pagePlanOf(entry, n);
    }

    /// `.note` page count for a blob (indexed by `note_page_index_blob`); 0 for
    /// non-`.note` blobs.
    pub fn pageCountOf(self: ControlPlaneService, md5: []const u8) !i64 {
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

    // No `.txt` twin of `backfill`: a lazy heal could only write the
    // `txt_index` verdict, and the verdict must never precede the derived files
    // (`deferred.runTxt`). `Files.putFile` already wakes the worker.

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

    pub const ReadScope = controlplane_meta.ReadScope;
    pub const lookup = controlplane_meta.lookup;
    pub const noteMeta = controlplane_meta.noteMeta;
    pub const binNoteMeta = controlplane_meta.binNoteMeta;
    const isPdf = controlplane_meta.isPdf;
    const annotationsIdFor = controlplane_meta.annotationsIdFor;
    const noteMetaIn = controlplane_meta.noteMetaIn;
    pub const historyNoteMeta = controlplane_meta.historyNoteMeta;
    const pxPerMmFor = controlplane_meta.pxPerMmFor;
    const Described = controlplane_meta.Described;
    const describe = controlplane_meta.describe;

    pub const history = controlplane_history.history;
    pub const binHistory = controlplane_history.binHistory;
    pub const historyIn = controlplane_history.historyIn;

    pub const pageText = controlplane_text.pageText;
    pub const binPageText = controlplane_text.binPageText;
    const pageTextIn = controlplane_text.pageTextIn;
    pub const pageTextForMd5 = controlplane_text.pageTextForMd5;
    const max_recogn_bytes = controlplane_text.max_recogn_bytes;
    const wordsAt = controlplane_text.wordsAt;
    pub const pageLinks = controlplane_text.pageLinks;
    pub const pageLinksForMd5 = controlplane_text.pageLinksForMd5;
    const max_links_bytes = controlplane_text.max_links_bytes;
    const max_links_per_page = controlplane_text.max_links_per_page;
    const linksAt = controlplane_text.linksAt;

    const IndexRow = controlplane_index.IndexRow;
    const indexRow = controlplane_index.indexRow;
    const aspectOf = controlplane_index.aspectOf;
    const positivePair = controlplane_index.positivePair;
    const indexRowEnsuring = controlplane_index.indexRowEnsuring;
    const backfill = controlplane_index.backfill;
    const pageRefAt = controlplane_index.pageRefAt;
    const pageRefsFromIndex = controlplane_index.pageRefsFromIndex;
    const layerVOsFromBlob = controlplane_index.layerVOsFromBlob;
    const pageRefsOf = controlplane_index.pageRefsOf;
    const Summary = controlplane_index.Summary;
    const summarize = controlplane_index.summarize;
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
pub fn fileTypeFor(arena: std.mem.Allocator, indexable: bool, marker: ?[4]u8, name: []const u8) ![]const u8 {
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

pub fn fallbackFirst(arena: std.mem.Allocator, file_md5: ?[]const u8) !ControlPlaneService.First {
    return .{ .page = try fallbackPage(arena, file_md5, 0), .count = 1 };
}

pub fn fallbackPage(arena: std.mem.Allocator, file_md5: ?[]const u8, index: usize) !PageRefVO {
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

pub fn idStr(arena: std.mem.Allocator, id: u64) ![]const u8 {
    return std.fmt.allocPrint(arena, "{d}", .{id});
}

pub fn freeEntry(gpa: std.mem.Allocator, e: Entry) void {
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

test {
    _ = @import("controlplane/meta_test.zig");
}

// ---- tests of private helpers ----

const testing = std.testing;
const fixture = @import("controlplane/fixture.zig");
const Fixture = fixture.Fixture;
const seedBytes = fixture.seedBytes;
const sample = @embedFile("sample.note");

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
