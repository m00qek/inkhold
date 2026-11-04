//! Response VOs for the control plane; field names mirror webapp/src/core/types.ts.

const std = @import("std");
const Files = @import("../files.zig").Files;
const noteindex = @import("../note_index.zig");
const blobstore = @import("../../store/blobs.zig");

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
pub fn allowedLinkScheme(uri: []const u8) bool {
    for ([_][]const u8{ "http://", "https://", "mailto:" }) |scheme| {
        if (uri.len < scheme.len) continue;
        if (std.ascii.eqlIgnoreCase(uri[0..scheme.len], scheme)) return true;
    }
    return false;
}
