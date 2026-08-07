//! ControlPlaneService: projects the file tree + parsed `.note` containers into the JSON
//! shapes the browser SPA consumes (the `Api` contract in
//! `webapp/src/core/types.ts`). Where the device face (`sync.zig`)
//! exposes whole-file md5 hashes for the device to diff, this face exposes what a
//! reader needs: folder listings, per-note page lists, and per-page CONTENT
//! hashes for cache-keying.
//!
//! ## Listings and `noteMeta` read the index, not the file
//!
//! `listing` and `noteMeta` are **pure DB reads**: every fact they emit —
//! page count, per-page content hash, per-page dimensions, whether the blob is
//! even a `.note` — comes from `note_index` / `note_page_index` (see
//! `note_index.zig` and `docs/scratch/new-indexing.md`). They open no file.
//! Previously each of them read and parsed a whole `.note` per request, and a
//! listing did so **once per note in the folder**.
//!
//! A blob with no index row, or one at a stale `index_version`, is backfilled on
//! the spot (`noteindex.ensureIndexed`) and the request continues. That is what
//! makes the index self-healing with no migration step; because the parser reads
//! ranges rather than buffering (`sn.parseSource`), a backfill costs kilobytes,
//! not a whole note.
//!
//! The repair is reached through `indexRowEnsuring`, which READS BEFORE IT
//! REPAIRS: `ensureIndexed`'s gate is the same single-row lookup the read paths
//! already perform, so asking for the backfill up front cost a duplicate query
//! per note on every warm listing. A row that comes back is itself the proof the
//! blob is current.
//!
//! The per-page content hash is the md5 of a page's layer-bitmap bytes, so it
//! changes only when that page's rendered content changes — exactly the
//! immutable cache key the browser wants (`?v=<hash>`), independent of edits to
//! other pages. It is computed in exactly one place (`noteindex.pageContentHash`)
//! so the stored value and any parse-driven value can never disagree.
//!
//! ## Page serving streams, and never buffers a page
//!
//! `pagePlan`/`writePage` are the same story one step further. The plan is a
//! pure DB read — the SNPG header from the note-level columns, the layer
//! `(offset, length, blank)` records from the page row, the exact
//! `Content-Length` (`20 + Σ (5 + len)`) and the `ETag` (the stored
//! `content_hash`), none of which requires opening the file. `writePage` then
//! emits the header and pulls each layer's block out of the blob in fixed
//! `blobstore.chunk_len` windows, straight to the socket.
//!
//! Nothing on this path is proportional to the note or the page. `readBlob` —
//! which buffered up to 64 MiB of note to emit one page — is gone with the last
//! of its callers, which is what makes the memory claim in
//! `docs/scratch/new-indexing.md` § Streaming true without qualification.

const std = @import("std");
const Files = @import("files.zig").Files;
const Entry = @import("files.zig").Entry;
const sn = @import("supernote");
const noteindex = @import("note_index.zig");
const spdindex = @import("spd_index.zig");
const txtindex = @import("txt_index.zig");
const settingsmod = @import("settings.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");

// ---- response VOs (field names mirror core/types.ts exactly) ----

/// One page of a note. `hash` is the per-page content md5 (the `?v=` version and
/// the render cache key); `width`/`height` are native device pixels.
///
/// `textHash` is the md5 of the page's `RECOGNTEXT` block, or null when the
/// device never finished recognizing this page (`RECOGNSTATUS != 1`) — which is
/// MOST pages. It is deliberately a separate hash from `hash`: `hash` covers only
/// the layer bitmaps, so running recognition on the device produces a transcript
/// while leaving the strokes (and therefore `hash`) untouched. Keying the
/// transcript by `hash` would leave a freshly-recognized page pinned to its
/// pre-recognition response on a URL that never turned over.
///
/// Non-null IS the frontend's "has recognized text" signal (`PageRef.textHash` in
/// `core/types.ts`): one field rather than a boolean plus a hash, so the two can
/// never disagree, and carried on the page list so the reader can render its
/// "Recognized text" toggle in the right enabled/disabled state the moment a note
/// opens — with no speculative per-page fetch.
pub const PageRefVO = struct {
    index: i64,
    hash: []const u8,
    width: i64,
    height: i64,
    textHash: ?[]const u8 = null,
    /// The md5 of the page's `EXTERNALLINKINFO` block — the links a PDF used as
    /// this page's template brought with it (`note-format.md` §14) — or null
    /// when the page has none, which is every page of every note that was not
    /// built on an imported PDF.
    ///
    /// The same arrangement as `textHash`, for the same two reasons. It is the
    /// `?v=` of `GET /note/{id}/page/{n}/links`, and it is a SEPARATE hash from
    /// `hash` because `hash` covers the layer bitmaps only: a re-import that
    /// changed a page's links while leaving its strokes alone would not move it.
    /// And non-null IS the "this page has links" signal — one field rather than
    /// a boolean beside a hash, so the two cannot disagree — which is what lets
    /// a client skip the request entirely for the overwhelming majority of pages
    /// instead of asking every page whether it has links.
    ///
    /// The RECORDS are deliberately not here. The capture that established the
    /// format carries 51,256 of them across 1702 pages; a page list holding them
    /// would be megabytes on note-open to serve the one page on screen.
    linksHash: ?[]const u8 = null,
    /// The page's own number from the container footer, 1-based — as distinct
    /// from `index`, its position, which is what addresses the page's bytes.
    ///
    /// Omitted (null) when it equals `index + 1`, which is every page of every
    /// notebook: sending it there would be a field that is always derivable.
    /// It appears for a `.mark`, whose pages are the ANNOTATED pages of a PDF
    /// and are named by the PDF page they belong to — the three pages of a real
    /// capture are 2, 5 and 6 (`parsers/note/note-format.md` §13.2). Without it
    /// a client has no way to composite a mark onto the document it annotates.
    sourcePage: ?i64 = null,
    /// The page's layer stack for the reader's layer panel, in **SNPG record
    /// order** (bottom-to-top, matching the payload's records one-to-one —
    /// though the panel should match by `slot`, which both sides carry
    /// explicitly). Null — and therefore an OMITTED field — for a page with no
    /// layer records and for non-`.note` fallback pages.
    ///
    /// Carried on `noteMeta`'s page list AND on a listing/bin row's
    /// `firstPage`, from the same `layerVOsFromBlob` serializer over the same
    /// `note_page_index.layers` blob, so the two can never describe page 0
    /// differently. The listing used to omit it on the theory that "nothing
    /// outside the reader is layer-aware" — but the reader now OPENS from a
    /// listing summary and fills `noteMeta` in behind itself, so without this
    /// the Layers toggle has to guess for the one page the user actually
    /// landed on, and the first paint is a flat composite that gets re-decoded
    /// into a layer stack the moment the metadata lands (a visible swap).
    /// Descriptors only — at most `note_index.max_layers` of
    /// `{slot,name,visible,isCurrent}`, no image data, and no extra query: the
    /// blob is one more column on a row the listing already reads.
    layers: ?[]const LayerVO = null,
};

/// One layer of a page, for the panel. View-state facts are DEVICE-AUTHORED
/// (`LAYERINFO`) and read-only — panel toggles are view-only and never persist.
pub const LayerVO = struct {
    /// `"main"`, `"layer1"`, `"layer2"`, `"layer3"` or `"background"` — the
    /// same identity the SNPG v2 record's slot byte carries, so the client
    /// pairs panel rows with wire records by slot, never by array position.
    slot: []const u8,
    /// The display name from `LAYERINFO` ("Layer Renamed"), or `""` when the
    /// page carries no usable `LAYERINFO` — the client renders its own
    /// default label then. Never the layer block's `LAYERNAME` slot constant.
    name: []const u8,
    /// Device-authored visibility (`LAYERINFO.isVisible`). A `false` layer's
    /// stream still arrives in the payload, flagged hidden, so the panel can
    /// toggle it on.
    visible: bool,
    /// `LAYERINFO.isCurrentLayer` — which layer the device's panel had active.
    isCurrent: bool,
};

/// The frozen shape of the preview a listing row will render: the source
/// image's own pixel dims, served WITH the listing so the masonry layout can
/// reserve every tile's height before a single image byte arrives (decision 3
/// of `docs/scratch/archive/masonry.md` — reflow-free needs the aspect first).
///
/// Optional everywhere it appears, and ABSENT — never null, never 0×anything —
/// when the server holds no aspect fact: the client falls back to its own
/// defaults there, and a fabricated pair would reserve the wrong shape with
/// nothing to correct it.
pub const AspectVO = struct { w: i64, h: i64 };

/// A folder as it appears in a listing or a breadcrumb.
///
/// The count is optional and omitted (`emit_null_optional_fields = false`) on the
/// BREADCRUMB, which is a path of ancestors rather than a set of rows to render —
/// nothing displays a count there, and counting every ancestor would be a query
/// per crumb for a number nobody reads.
pub const FolderVO = struct {
    kind: []const u8 = "folder",
    id: []const u8,
    name: []const u8,
    /// Live, DIRECT children of any kind. See `Files.childCount` for the rules,
    /// and for why this is "items" rather than "notes".
    itemCount: ?i64 = null,
};

/// One row of a folder listing: a folder (only kind/id/name) or a note (all
/// fields). The note-only fields are optionals so, with
/// `emit_null_optional_fields = false`, a folder serializes to exactly
/// `{kind,id,name}` and a note to the full `NoteSummary` shape.
pub const EntryVO = struct {
    kind: []const u8,
    id: []const u8,
    name: []const u8,
    pageCount: ?i64 = null,
    firstPage: ?PageRefVO = null,
    updatedAt: ?i64 = null,
    /// What this blob actually **is**, verified rather than assumed: `"note"`
    /// whenever the indexer parsed it as a `.note` container (regardless of what
    /// the file is called), otherwise the filename's lowercased extension, or
    /// `"file"` when it has none. Other file types legitimately live in the tree
    /// — a PDF in `EXPORT/` must not render as a card badged "note".
    fileType: ?[]const u8 = null,
    /// The whole-file blob md5 (hex), or null for a folder / a row with no blob.
    ///
    /// Exists so the client can build the CONTENT-ADDRESSED raw-bytes URL
    /// `/file/{id}?v={fileHash}`. That route requires the version and 404s a
    /// mismatch, which is what lets it answer `immutable` — so without this field
    /// the endpoint is simply not addressable. Deliberately NOT inferred from
    /// `firstPage.hash`: for a non-parseable blob those two happen to be equal
    /// today (`fallbackHash` is the file md5 padded to 32 hex), and a client that
    /// leaned on that coincidence would break silently the day the placeholder
    /// changes.
    fileHash: ?[]const u8 = null,
    /// True iff at least one page carries finished on-device recognition
    /// (`recognized_page_count > 0`). Deliberately NOT `FILE_RECOGN_TYPE = 1`:
    /// a note can have recognition *enabled* with zero finished pages, and the
    /// badge must mean exactly "this note can appear in search results" — the
    /// search filter uses the same predicate.
    hasRecognizedText: ?bool = null,
    /// The preview's source shape (see `AspectVO`): a `.note`'s device-rendered
    /// cover when it ships a decodable one, else its page 0's EFFECTIVE dims
    /// (orientation applied — a landscape note serves 1872×1404); a `.spd`'s
    /// embedded-thumbnail dims. Omitted for folders, images, `.txt` and every
    /// other type — those shapes are the client's concern (decision 5 of
    /// `docs/scratch/archive/masonry.md`).
    thumbAspect: ?AspectVO = null,
    /// FOLDER-ONLY, and optional for the same reason every field above is: a note
    /// row must keep serializing to exactly the `NoteSummary` shape it does today,
    /// so this stays null there and is omitted. See `Files.childCount` — direct
    /// children only, live rows only, every kind counted.
    itemCount: ?i64 = null,
};

/// The contents of one folder plus the freshness token.
pub const ListingVO = struct {
    folderId: ?[]const u8,
    path: []const FolderVO,
    entries: []const EntryVO,
    syncVersion: i64,
};

/// The full page list for a single note (the reader opens this).
/// The full page list for a single file, plus what the file actually **is**.
///
/// `fileType`/`fileHash`/`size` are here — duplicating `EntryVO` — because the
/// READER is what a URL points at. `#/note/{id}` survives a reload and can be
/// shared, so "note, image, or no preview at all" has to be answerable from the
/// id alone; deriving it from the listing the card came from would work exactly
/// until someone refreshed. Same values, same rules, one extra row read.
pub const NoteMetaVO = struct {
    id: []const u8,
    name: []const u8,
    pages: []const PageRefVO,
    fileType: ?[]const u8 = null,
    fileHash: ?[]const u8 = null,
    size: i64 = 0,
    /// How many device pixels one millimetre is on the hardware that wrote this
    /// note — the scale that turns `PageTextVO.words` (millimetres) into page
    /// pixels. **Omitted when we have never measured that hardware**, which is
    /// the common case: `types.CanvasMm.forEquipment` is a verified allowlist
    /// with no fallback, on purpose.
    ///
    /// Absent means "do not place text on this page". The export path answers it
    /// with a raster-only PDF and says so, rather than a searchable PDF whose
    /// invisible text is quietly in the wrong place — the failure modes are not
    /// symmetric, and only one of them is visible to the person holding the file.
    ///
    /// It is here rather than on the page-text response because equipment is a
    /// note-level fact — one `APPLY_EQUIPMENT` per file, not one per page. (Both
    /// responses are now revalidated rather than immutably cached; see the note on
    /// `PageTextVO` for why that changed.)
    pxPerMm: ?f32 = null,
    /// The id of the `.mark` that annotates THIS file, when one exists beside
    /// it — `foo.pdf` is annotated by `foo.pdf.mark` in the same folder
    /// (`parsers/note/note-format.md` §13.2).
    ///
    /// Resolved here rather than by the client because the client may not hold
    /// the folder listing at all: a PDF opened from a deep link, a search result
    /// or the bin has no siblings in hand, and fetching a whole folder to
    /// discover one name is a round trip this link cannot spare. One indexed
    /// lookup answers it on a request already being made.
    ///
    /// Null for anything that is not a live `.pdf`, and for a `.pdf` with no
    /// mark beside it — which is most of them.
    annotationsId: ?[]const u8 = null,
};

/// One row of the recycle bin.
///
/// It is deliberately NOT an `EntryVO`. A bin row answers different questions —
/// where the file used to live, when it was deleted, whether it came along with a
/// folder — and carries none of the page-summary machinery a library card needs,
/// because the bin renders a list rather than a wall of thumbnails. Sharing the
/// type would mean a pile of optionals that are null in one context and required
/// in the other.
///
/// `fileType` and `fileHash` ARE here, and they are the whole of U2b's server
/// side: they are what let the client decide between the reader, an inline image
/// and the honest no-preview state, and what let it build the content-addressed
/// `/api/controlplane/bin/file/{id}?v={fileHash}` URL — without them the preview
/// endpoints are not addressable at all.
pub const BinEntryVO = struct {
    /// `"folder"` or `"note"` — the same two values `EntryVO.kind` uses, so the
    /// client's existing kind branch works unchanged. What the file actually IS
    /// still comes from `fileType`.
    kind: []const u8,
    id: []const u8,
    name: []const u8,
    /// The path the entry had WHEN IT WAS DELETED, through trashed ancestors.
    /// Half of the disambiguation the bin needs (same name, different places);
    /// `deletedAt` is the other half (same name, same place, deleted twice).
    path: []const u8,
    /// Epoch MILLISECONDS, matching `EntryVO.updatedAt`.
    deletedAt: i64,
    /// Bytes this row itself charges against quota: its file size, and **0 for a
    /// folder**. A folder's bytes are its children's, and the children are in
    /// this same list — so summing `size` over any set of rows is correct by
    /// construction and can never double-count a folder with its contents. That
    /// is exactly what the purge/empty confirmations have to state.
    size: i64,
    /// The trashed parent this row came down with, or null when there is none in
    /// the bin. With `isRoot` it is what the client groups and nests by.
    parentId: ?[]const u8 = null,
    /// True when this row is the top of a trashed subtree — the thing the user
    /// actually deleted, rather than something that went with it.
    isRoot: bool,
    fileType: ?[]const u8 = null,
    fileHash: ?[]const u8 = null,
    /// Page 0's ref, so a bin row renders the note's REAL first page through the
    /// same lazy engine the gallery uses — `/bin/note/{id}/page/0?v={hash}` is
    /// already routed, so this field is the whole of what was missing. Same
    /// shape and same meaning as `EntryVO.firstPage`.
    ///
    /// NULL rather than a placeholder page when there is nothing to draw (a
    /// folder, an unparseable blob, a note whose index row never landed). The
    /// live listing substitutes `fallbackPage` there because a gallery TILE has
    /// to be something; a bin row already has an honest doc glyph, and handing it
    /// a placeholder ref would trade that for an empty box plus a page fetch.
    firstPage: ?PageRefVO = null,
    /// Same fact and same rules as `EntryVO.thumbAspect`. A trashed entry still
    /// has its blob (trash HOLDS the reference), and the bin rows render real
    /// previews through the bin-scoped twins — so the aspect serves here too.
    thumbAspect: ?AspectVO = null,
};

/// `GET /api/controlplane/bin`.
pub const BinVO = struct {
    entries: []const BinEntryVO,
    /// What emptying the whole bin would free, in bytes. Folders contribute 0
    /// (see `BinEntryVO.size`), so this is the honest figure rather than a sum
    /// that counts a folder and its contents both.
    totalBytes: i64,
    /// The retention window in days, so the empty state and the per-row countdown
    /// quote the real number instead of a hardcoded copy that can drift from
    /// `Files.bin_retention_s`.
    retentionDays: i64,
    syncVersion: i64,
};

/// What `restore` did, for the toast that has to say so (U3).
pub const RestoredVO = struct {
    success: bool = true,
    /// The name the entry came back under — NOT necessarily the one it had.
    name: []const u8,
    renamed: bool,
    /// Trashed ancestor folders that had to come back for this entry to be
    /// reachable at all.
    ancestors: i64,
    /// Trashed descendants that came back with a restored folder.
    descendants: i64,
};

/// What a web delete did (U5), so the undo toast can state the fanout when it
/// exceeds the one row the user clicked.
pub const TrashedVO = struct {
    success: bool = true,
    id: []const u8,
    name: []const u8,
    isFolder: bool,
    /// Rows tombstoned, the clicked one included. `> 1` only for a folder.
    entries: i64,
};

/// What `emptyBin` destroyed.
pub const EmptiedVO = struct { success: bool = true, entries: i64 };

/// One version in a file's history list (`GET …/note/{id}/history`). `md5` is the
/// blob hash — the key both the content-addressed `/thumbnail/{md5}` (for the
/// list's thumbnails) and the per-version preview/search/restore routes take.
/// `createdAt` is epoch MILLISECONDS, like `EntryVO.updatedAt`/`deletedAt`.
/// `current = true` marks the row that is the file's LIVE content (sourced from
/// `files.md5`, not a `file_history` row); every retained version is `false`.
pub const HistoryVersionVO = struct {
    md5: []const u8,
    size: i64,
    createdAt: i64,
    /// Number of `.note` pages this version's blob has (`note_page_index` rows for
    /// its md5). `0` means "no page count" — a non-`.note` blob (`.spd`/`.txt`/
    /// image) has no such rows, so the UI falls back to byte size for it.
    pageCount: i64 = 0,
    current: bool = false,
};

/// `GET …/note/{id}/history` — a file's versions, newest first: the CURRENT one
/// (flagged) followed by each retained `file_history` row. The list a stranger's
/// id or a file with no history simply cannot reach (404 / it is never a folder).
pub const HistoryVO = struct {
    id: []const u8,
    versions: []const HistoryVersionVO,
};

/// `POST …/history/{md5}/restore` — the file's new current version after a
/// restore, so the toast/UI can reflect what it now points at.
pub const RestoredVersionVO = struct {
    success: bool = true,
    md5: []const u8,
    size: i64,
    createdAt: i64,
    current: bool = true,
};

/// Everything needed to serve one page, resolved from the index in a single
/// (locked) step so the bytes themselves can be streamed with no further DB
/// access. `plan` carries the exact `Content-Length` and the `ETag`; `md5` names
/// the blob the layer windows are read from.
///
/// `md5` is an owned inline copy, NOT a borrow of the `Entry` it came from, so it
/// outlives both the DB lock and the entry's arena.
pub const PagePlan = struct {
    md5: [blobstore.md5_hex_len]u8,
    plan: noteindex.PagePlan,
};

/// The `/note/{id}/template/{hash}` serve plan: the note's blob md5 (inline, so
/// nothing borrows the DB connection past the unlock) and the image template's
/// byte range inside it. Built under the DB lock, streamed with it released.
pub const TemplatePlan = struct {
    md5: [blobstore.md5_hex_len]u8,
    offset: u64,
    length: u64,
};

/// Upper bound on a `/template/{hash}` path segment — the stored `bg_hash`
/// (`PAGESTYLEMD5`) is an md5 hex, and `note_index` caps the wire hash at
/// `max_bg_hash`; the handler refuses anything longer as implausible.
pub const max_template_hash_len: usize = noteindex.max_bg_hash;

/// One recognized word and where it is, for the searchable-PDF text layer.
///
/// **THE FIELD NAMES CARRY THE UNIT ON PURPOSE.** These are MILLIMETRES on the
/// page canvas, origin top-left — the device's own numbers, verbatim out of
/// `RECOGNTEXT`. They are not pixels and there is no scale in this object; see
/// `NoteMetaVO.pxPerMm` for the conversion and for why it lives over there.
/// A consumer that reads `xMm` as a pixel offset has to ignore the name to do it.
pub const WordVO = struct {
    text: []const u8,
    xMm: f32,
    yMm: f32,
    wMm: f32,
    hMm: f32,
};

/// The recognized-text response body. A raw VO with **no `{success}` envelope**,
/// matching the frontend contract (`Api.getPageText`). `text` is optional and
/// null optionals are omitted, so a page whose stored transcript is empty
/// serializes to `{}` — which the client reads as the empty string, and the panel
/// renders as its honest "no recognized text" state.
///
/// `words` rides on THIS endpoint rather than a new one because it is the same
/// fact from the same place: both come out of the page's `RECOGNTEXT` block, and
/// `text_hash` — the md5 of that block — already versions both of them exactly.
/// A second route would mean two cache entries, two round-trips and two chances
/// to disagree, for one 2–10 KB payload. Adding a field is backward compatible:
/// the shipped OCR panel asks for `{text}` and never looks at this.
///
/// **THIS RESPONSE IS NOT IMMUTABLY CACHED, AND MUST NOT BECOME SO.** It once was
/// (`immutable, max-age=1y` under `?v={textHash}`) on the argument that the hash
/// versions the `RECOGNTEXT` block. It versions the block; it does not version
/// THIS STRUCT. When `words` was added, every browser that already held a cached
/// response kept the wordless one for a year on a URL that could never change —
/// silently, because a missing optional field deserialises to "no words" and looks
/// exactly like a page with none. The handler now sends `no-cache`; see
/// `handlers/controlplane.controlplanePageText` for the full rule and the cost
/// argument. Any struct serialised to a client is subject to the same rule.
///
/// **Everything here is in millimetres** (see `WordVO`) — deliberately NOT
/// converted to pixels server-side. Two reasons, and the second is the load-bearing
/// one:
///
///  1. mm is what the device wrote, so the body carries the device's own numbers
///     and nothing derived. Fewer server-side opinions in a cached body is fewer
///     things that can go stale independently of `?v=`.
///  2. The mm→px scale depends on `APPLY_EQUIPMENT`, which `textHash` does NOT
///     cover. Baking a scale in here would freeze a hardware guess into the body
///     with nothing able to invalidate it — so the day the scale table is
///     corrected or extended, every cached page would keep serving the old one.
///     The scale therefore lives on `NoteMetaVO`, which is a note-level fact (one
///     `APPLY_EQUIPMENT` per file, not one per page) and is already fetched on
///     note-open.
pub const PageTextVO = struct {
    text: ?[]const u8 = null,
    words: ?[]const WordVO = null,
};

/// `pageText`'s result: the body plus the stored `text_hash` the request's `?v=`
/// is checked against.
pub const PageText = struct { hash: [32]u8, vo: PageTextVO };

/// One link rectangle on a page, in the shape the client's `render/pdfLinks.ts`
/// already speaks — the SAME record a PDF's own links arrive as, so the reader's
/// link layer and the PDF exporter each consume one shape rather than two.
///
/// `x`/`y`/`w`/`h` are **device panel pixels**, origin top-left, y down. That is
/// the `.note`'s own space and needs no mapping: a `.note` page IS the panel
/// (§9.1), so the only transform left on the client is the canvas-to-panel
/// scale it already computes for the ink. (A `.pdf`'s links arrive in POINTS
/// instead; the field names match because the arithmetic downstream — one
/// uniform scale from the raster's width — is identical either way.)
///
/// `page` is the **0-based** target of an internal jump, or **-1 for an external
/// one**. §14 stores a 1-based page number and the literal `none`; the
/// conversion happens here, at the boundary, so exactly one place knows both
/// spellings.
pub const LinkVO = struct {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    page: i64,
    uri: []const u8,
};

/// A page's links. An object rather than a bare array because a top-level JSON
/// array is a shape that can never gain a field, and this one may want the
/// panel dims it was authored against.
pub const PageLinksVO = struct { links: []const LinkVO = &.{} };

/// `pageLinks`'s result: the body plus the stored `links_hash` the request's
/// `?v=` is checked against.
pub const PageLinks = struct { hash: [32]u8, vo: PageLinksVO };

/// The schemes a link may carry out of a device file, and the only ones — the
/// same allowlist the browser applies in `render/pdfLinks.ts`, stated again on
/// this side because the export path reads this endpoint too and a file that
/// leaves this machine must not carry a target we would refuse to follow
/// ourselves. Anchored at index 0 and case-folded, so neither `JavaScript:` nor
/// a leading-space variant can pass as "not a scheme we forbid".
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

    /// `GET /api/controlplane/tree` — one folder's immediate children (folders + note
    /// summaries), the breadcrumb from root, and the user's sync-version.
    /// Everything is allocated in `arena` (the handler owns and frees it).
    pub fn listing(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, parent_id: ?u64) !ListingVO {
        const entries = try self.files.list(user_id, parent_id);
        defer Files.freeEntries(self.files.gpa, entries);

        // ONE BUILDER, shared with the rename response. Both shapes used to be
        // written out here as well as in `entryVO`, field for field — two places
        // that had to agree about ten fields with nothing making them. A folder
        // costs one indexed probe for its child count (`Files.childCount`); a
        // listing holds a handful of folders, so that is a handful of lookups
        // rather than the tree scan a recursive count would need.
        var out: std.ArrayList(EntryVO) = .empty;
        for (entries) |e| try out.append(arena, try self.entryVO(arena, user_id, e));

        return .{
            .folderId = if (parent_id) |p| try idStr(arena, p) else null,
            .path = try self.breadcrumb(arena, user_id, parent_id),
            .entries = out.items,
            .syncVersion = try self.files.syncVersion(user_id),
        };
    }

    /// Build ONE listing-shaped `EntryVO` for a single entry — the rename
    /// response, so the client reconciles the row with the EXACT shape a `tree`
    /// listing carries. A folder serialises to `{kind,id,name,itemCount}`; a note
    /// to the full `NoteSummary` shape, identical to the per-row branch of
    /// `listing` (same `summarize`, same fields). `arena` owns the strings.
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
        };
    }

    /// `GET /api/controlplane/bin` — the caller's recycle bin, newest deletion
    /// first, each row carrying the path it had when it was deleted.
    ///
    /// Everything is allocated in `arena`. `Files.listBin` does the hard part (the
    /// path reconstruction through tombstoned ancestors — see there); this adds
    /// only what the browser needs on top: the verified file type, the blob hash
    /// the preview URL is keyed by, and the totals the confirmations quote.
    ///
    /// The list is FLAT and deliberately ungrouped. See `Files.listBin` for why
    /// the grouping the UI renders is left to the client.
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
                    // HEAL here (`indexRowEnsuring`, not the bare `indexRow`). The
                    // original "no backfill on a list screen" reasoning assumed a
                    // blob indexed while live STAYS current — but `index_version`
                    // bumped four times in a week (v3 landscape, v4 covers, v5/v6
                    // segments+txt), and every bump strands a trashed note whose
                    // row is now stale: `indexRow` filters on the current version,
                    // returns null, and the note loses its `firstPage` (→ a generic
                    // doc tile instead of its rendered page) and its `thumbAspect`.
                    // The library self-corrects because it heals on view; the bin
                    // has no other surface to heal on. The cost is bounded — the
                    // bin is small, and a note already healed by a library visit is
                    // just the same cheap version-check `indexRowEnsuring` protects.
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
            // The CONFIGURED window, not the compiled default: the admin console
            // can change it, and the bin's countdown and empty-state copy quote
            // this number. Reading the constant here would have made the recycle
            // bin quietly disagree with the console that set it.
            .retentionDays = (try settingsmod.Settings.init(self.files.io, self.files.db).binRetention()).days(),
            .syncVersion = try self.files.syncVersion(user_id),
        };
    }

    /// Which state a read is allowed to see. The bin's preview + view-only history
    /// endpoints are the `.trashed` callers; everything else on this face is `.live`
    /// and goes through `Files.get`, which stays the shared ownership boundary. It
    /// IS `Files.HistoryScope` (one scope type across the note/blob lookups and the
    /// `file_history` gate), so a handler threads a single `scope` to both.
    pub const ReadScope = @import("files.zig").HistoryScope;

    /// The one place the scope becomes a lookup. `.trashed` refuses a live row
    /// just as `.live` refuses a trashed one, so neither endpoint can serve the
    /// other's rows even by accident.
    pub fn lookup(self: ControlPlaneService, scope: ReadScope, user_id: u64, id: u64) !?Entry {
        return switch (scope) {
            .live => self.files.get(user_id, id),
            .trashed => self.files.getTrashed(user_id, id),
        };
    }

    /// `GET /api/controlplane/file/metadata/{id}` — the full page list for one item.
    /// Null if the id is missing / not owned / a folder.
    pub fn noteMeta(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?NoteMetaVO {
        return self.noteMetaIn(arena, user_id, id, .live);
    }

    /// `GET /api/controlplane/bin/file/metadata/{id}` — the same page list for a TRASHED
    /// note, so the bin can be previewed before anything irreversible is decided.
    /// A live id is null here, exactly as a trashed one is null through `noteMeta`.
    pub fn binNoteMeta(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?NoteMetaVO {
        return self.noteMetaIn(arena, user_id, id, .trashed);
    }

    /// Is this the server-verified `"pdf"` type? Compared against the DESCRIBED
    /// type, never the filename, so `notes.pdf` (a `.note` misnamed) does not go
    /// looking for annotations and a `.pdf` with no extension still does.
    fn isPdf(file_type: ?[]const u8) bool {
        return file_type != null and std.mem.eql(u8, file_type.?, "pdf");
    }

    /// The id of the `.mark` sitting beside `entry`, or null.
    ///
    /// The device writes annotations to a SEPARATE file whose name is the PDF's
    /// full name plus `.mark` — `foo.pdf` -> `foo.pdf.mark`, same folder. Not
    /// `foo.mark`: the extension is appended, not replaced, which is what two
    /// real captures show.
    ///
    /// **The lookup itself is `Files.liveMarkIdFor`**, which is also the half of
    /// `Files.pairOf` that carries a mark through trash/restore/purge/move. This
    /// used to be a second hand-written copy of the query, reaching into
    /// `files.db` from here; a rule the tree's owner enforces on every mutation
    /// cannot also be re-derived by a reader that does not know when it changed.
    ///
    /// The gate is looser than the pairing rule on purpose. Pairing keys off the
    /// NAME (`%.pdf` + `.mark`), because that is what a listing and an UPDATE can
    /// agree on; this keys off the DESCRIBED type, so a PDF verified by content
    /// but named without the extension still finds its ink to show. The looser
    /// side is the read-only one, which is the safe direction for them to differ.
    ///
    /// LIVE ONLY, deliberately. A trashed PDF is looked up in the bin's own scope
    /// (`noteMetaIn` passes `.live` only), so a bin preview can never composite a
    /// live file's ink onto a deleted document — and now that a pair is trashed
    /// together, a trashed PDF has no live mark to find anyway.
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
            // Only a LIVE `.pdf` can have annotations to point at: the lookup is
            // scoped to live rows, so asking it from the bin would find a live
            // mark and offer it against a trashed document.
            .annotationsId = if (scope == .live and isPdf(described.file_type))
                try self.annotationsIdFor(arena, user_id, entry)
            else
                null,
        };
    }

    /// `GET /api/controlplane/note/{id}/history/{md5}/meta` — the page list +
    /// geometry of a RETAINED version, read from ITS OWN retained `note_index`
    /// (H7), not the live note's. Null (→ the handler's 404) when `md5` is not a
    /// retained version of `id` owned by `user_id`, or `id` is missing / a folder.
    ///
    /// The preview reader needs the VERSION's real page count and per-page dims —
    /// a version whose page count differs from the current note (the "I added
    /// pages since" case) must render its own pages, not the live note's slots.
    /// So this is exactly `noteMetaIn`'s builder pointed at the version's md5+size
    /// rather than the live blob's: `pageRefsOf`/`describe` read the version's
    /// index by its md5, while `id`/`name` stay the file's. A retained version
    /// always keeps its `note_index` (retention guarantees it, H2), so this is a
    /// pure DB read — the `backfill` inside `describe`/`pageRefsOf` is a no-op
    /// keep-alive, never a re-parse.
    pub fn historyNoteMeta(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, md5: []const u8) !?NoteMetaVO {
        // The gate every per-version endpoint shares: `md5` must be a retained
        // version of THIS file, owned by the caller. A miss is the shared 404.
        const version = (try self.files.historyVersion(user_id, id, md5)) orelse return null;

        // The file's identity (id/name) is the live row's; the page geometry and
        // file type come from the VERSION's index below.
        const entry = (try self.lookup(.live, user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        if (entry.is_folder) return null;

        // A synthetic entry carrying the file's identity but the VERSION's md5+size,
        // so `pageRefsOf`/`describe` read the version's `note_index` rather than the
        // live blob's. It BORROWS the live entry's name and `version`'s inline md5 —
        // nothing here owns or frees them, so there is no double-free with `entry`.
        const version_entry: Entry = .{
            .id = entry.id,
            .parent_id = entry.parent_id,
            .name = entry.name,
            .is_folder = false,
            .md5 = &version.md5,
            .size = version.size,
            .updated_at = entry.updated_at,
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

    /// The verified mm→px scale for an indexed note, or null when there isn't one.
    ///
    /// Null on three separate grounds, and all three must stay null rather than
    /// fall back to something plausible: unknown equipment (the allowlist in
    /// `types.CanvasMm` — see there for the argument), a zero stored width (an
    /// unindexable blob), and a non-finite result. The consumer is an invisible
    /// PDF text layer, where "approximately right" and "right" are
    /// indistinguishable until long after the file has left.
    fn pxPerMmFor(equipment: ?[]const u8, width: i64) ?f32 {
        if (width <= 0) return null;
        const canvas = sn.types.CanvasMm.forEquipment(equipment) orelse return null;
        const scale = canvas.pxPerMm(@intCast(width));
        return if (std.math.isFinite(scale) and scale > 0) scale else null;
    }

    /// What this blob actually is and how big a millimetre is on it, for a caller
    /// that has only the entry (the reader's `noteMeta`). One indexed row read on
    /// top of what it was already doing; `summarize` reaches the file-type answer
    /// from an `indexRow` it has already fetched, and both funnel through
    /// `fileTypeFor` so there is exactly one rule.
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

    /// Resolves `GET /note/{id}/page/{n}` into a `PagePlan`. Null if the note or
    /// page doesn't exist, isn't owned by `user_id`, or isn't a `.note`.
    ///
    /// The body this plans for is an **Option-3 flattened page payload**
    /// ("SNPG"): a compact, self-describing blob for exactly one page, decoded in
    /// the browser by the WASM track.
    pub fn pagePlan(self: ControlPlaneService, user_id: u64, id: u64, n: u64) !?PagePlan {
        const entry = (try self.files.get(user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        return self.pagePlanOf(entry, n);
    }

    /// `GET /api/controlplane/note/{id}/history` — the file's versions, newest
    /// first: the CURRENT blob (flagged) then every retained `file_history` row.
    /// Null when the id is missing / not owned / a folder / a file with no blob —
    /// the handler's 404. The retained list only ever contains RETAINED versions
    /// (H1/H2), so each `md5` here is directly previewable/searchable/restorable.
    pub fn history(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?HistoryVO {
        return self.historyIn(arena, user_id, id, .live);
    }

    /// `GET /api/controlplane/bin/note/{id}/history` — the same version list for a
    /// TRASHED file (view-only). A live id is null here, exactly as a trashed one is
    /// null through `history`; a trashed file keeps its `file_history` (H10), so its
    /// retained versions are all listed and each remains previewable/searchable
    /// through the bin's per-version twins.
    pub fn binHistory(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?HistoryVO {
        return self.historyIn(arena, user_id, id, .trashed);
    }

    pub fn historyIn(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, scope: ReadScope) !?HistoryVO {
        const entry = (try self.lookup(scope, user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        if (entry.is_folder) return null;
        const cur_md5 = entry.md5 orelse return null; // a blob-less file has no versions

        var out: std.ArrayList(HistoryVersionVO) = .empty;
        // The current version leads (it is the newest), flagged so the UI can badge
        // it and disable "restore" on it. Its timestamp is the file's `updated_at`.
        try out.append(arena, .{
            .md5 = try arena.dupe(u8, cur_md5),
            .size = @intCast(entry.size),
            .createdAt = entry.updated_at * 1000, // epoch s → ms
            .pageCount = try self.pageCountOf(cur_md5),
            .current = true,
        });
        for (try self.files.fileHistoryIn(scope, arena, user_id, id)) |v| {
            // Guard against a retained row that happens to equal the current blob
            // (e.g. a just-restored version whose old row was not yet retired):
            // never list the current content twice.
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

    /// How many `.note` pages this blob's md5 has, as an indexed count over
    /// `note_page_index` (the `note_page_index_blob` index keys `blob_md5`). A
    /// non-`.note` blob has no such rows, so this is naturally `0` — the caller
    /// treats `0` as "no page count". Cheap enough to call per history row.
    fn pageCountOf(self: ControlPlaneService, md5: []const u8) !i64 {
        var s = try self.files.db.prepare("SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, md5);
        _ = try s.step();
        return s.columnInt(0);
    }

    /// `pagePlanOf`, but keyed directly by a blob `md5` rather than an `Entry` —
    /// the per-version preview path (`GET …/history/{md5}/page/{n}`). The md5's
    /// ownership + retained-ness are the caller's gate (`Files.historyVersion`);
    /// this only resolves where page `n`'s bytes sit. Same CONTRACT as
    /// `pagePlanOf`: **call with the DB lock HELD**, then stream `writePage`
    /// unlocked. A retained version keeps its `note_index` (H2), so this is a pure
    /// DB read — the `backfill` is a no-op keep-alive, never a re-parse.
    pub fn pagePlanForMd5(self: ControlPlaneService, md5: []const u8, n: u64) !?PagePlan {
        if (md5.len != blobstore.md5_hex_len) return null;
        self.backfill(md5);
        const plan = (try noteindex.pagePlan(self.files.db, md5, n)) orelse return null;
        var out: PagePlan = .{ .md5 = undefined, .plan = plan };
        @memcpy(&out.md5, md5[0..blobstore.md5_hex_len]);
        return out;
    }

    /// `pagePlan` for a caller that has already resolved (and ownership-checked)
    /// the entry. Split out because `/note/:id/page/:n` is a `manual_db_lock`
    /// route: its handler resolves the entry and the plan inside one narrow
    /// `ctx.db_lock` window, then streams with the lock released.
    ///
    /// CONTRACT: **must be called with the DB lock HELD** — it reads `note_index`
    /// and may backfill a cold blob. It is the paired opposite of `writePage`,
    /// which must never touch the DB. Both are cheap under the lock: two indexed
    /// single-row `SELECT`s, no file opened.
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

    /// Resolves `GET /note/{id}/template/{hash}` into where the custom IMAGE
    /// template's bytes sit inside the note's blob — the byte range the handler
    /// then streams (never resident) after sniffing its MIME. Null when the note
    /// isn't a `.note`, or no page of it has an image background under `hash`
    /// (foreign/absent — 404). Pure DB + the same self-healing backfill the page
    /// route uses; NO `.note` parse at request time (the range is already in the
    /// `layers` blob). Paired with `pagePlanOf`, it is a `manual_db_lock`-friendly
    /// value: inline storage, no SQLite borrow that must outlive the unlock.
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

    /// `GET /note/{id}/page/{n}/text` — one page's recognized transcript, plus
    /// the `text_hash` the caller's `?v=` must match. Null when the note/page
    /// doesn't exist, isn't owned by `user_id`, or **has no finished recognition**
    /// (`recogn_status != 1` / `text_hash IS NULL`) — such a page has no version
    /// that could ever match, so the handler 404s it exactly as it does a stale one.
    ///
    /// Pure DB, like every other read on this face: the transcript was extracted
    /// at index time and stored, so nothing here opens a `.note`. It is the one
    /// blob-derived thing held whole in memory, and deliberately so — a page of
    /// handwriting transcribes to KB-scale text, not blob data (see the carve-outs
    /// in `docs/scratch/new-indexing.md` § "Scope of the claim").
    pub fn pageText(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, n: u64) !?PageText {
        return self.pageTextIn(arena, user_id, id, n, .live);
    }

    /// `GET /api/controlplane/bin/note/{id}/page/{n}/text` — the same transcript for
    /// a TRASHED note, keyed on the trashed file's CURRENT md5. A live id is null
    /// here, exactly as a trashed one is null through `pageText` — the same
    /// `.live`/`.trashed` split `noteMeta`/`binNoteMeta` make, so neither route can
    /// serve the other's rows. The transcript is retained md5-keyed (H10: the FTS is
    /// tombstoned, not dropped, on trash), so this is a pure DB read like the live one.
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

    /// `GET /api/controlplane/bin/note/{id}/search?q=` — find-in-note over a TRASHED
    /// note, keyed on the trashed file's CURRENT md5. Null (→ the handler's 404) for
    /// a live/missing id or a folder — the same owned + `deleted = 1` gate the bin's
    /// other note routes share, so a live id here is a 404 exactly as it is on the
    /// bin page/text routes. `query` is already percent-decoded by the handler.
    ///
    /// Reuses the one-document scan `searchHistoryPages` (H8, NOT the FTS): the
    /// transcript is retained md5-keyed even after trash (H10), so this reads it
    /// directly. One COMPLETE response, no cursor — exactly the history-search shape,
    /// which is the same `NoteSearchResults` VO find-in-note serves.
    pub fn binSearch(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, query: []const u8) !?notesearch.HistoryResults {
        const entry = (try self.lookup(.trashed, user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        if (entry.is_folder) return null;
        const md5 = entry.md5 orelse return null;
        return try notesearch.searchHistoryPages(arena, self.files.db, md5, query);
    }

    /// `pageText`, but keyed directly by a blob `md5` rather than an `Entry` — the
    /// per-version transcript path (`GET …/history/{md5}/page/{n}/text`). The md5's
    /// ownership + retained-ness are the caller's gate (`Files.historyVersion`);
    /// this only reads that version's OWN retained `note_page_index` row, so a page
    /// whose text differs from the current version's returns the OLD text and boxes.
    /// A retained version always keeps its index (H2), so this is a pure DB read plus
    /// the same KB-scale ranged `RECOGNTEXT` read the live route does — never a
    /// re-parse. Same `PageText` result; the per-version handler ignores `.hash`
    /// (the URL's `{md5}` already pins the blob, so there is no `?v=` to check).
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
        // NULL `text` with a non-null `text_hash` is real: the indexer keeps the
        // RECOGNTEXT range when the block itself won't decode. The transcript is
        // then genuinely empty, and omitting the field says exactly that.
        if (!r.isNull(1)) out.vo.text = try arena.dupe(u8, r.text(1));

        // The word boxes: the one thing on this path that is not a pure DB read.
        // `recogn_offset`/`recogn_length` were stored by the indexer for exactly
        // this — "for lazily fetching the rich form (elements + bounding boxes)"
        // (`db/schema.zig`, `docs/scratch/new-indexing.md` §103) — so this is a
        // single KB-scale ranged read, not a note parse. Read it BEFORE the
        // statement is finalized only in the sense that the offsets are copied
        // out first; nothing below borrows the row.
        if (!r.isNull(2) and !r.isNull(3)) {
            const offset = r.int(2);
            const length = r.int(3);
            out.vo.words = self.wordsAt(arena, md5, offset, length) catch null;
        }
        return out;
    }

    /// Upper bound on a `RECOGNTEXT` block we will read for its boxes. A page of
    /// handwriting transcribes to a few KB; this is two orders of magnitude of
    /// headroom and still a hard ceiling on what one request can allocate from a
    /// blob whose contents an untrusted device chose.
    const max_recogn_bytes: i64 = 1 << 20;

    /// Parse the stored `RECOGNTEXT` range into positioned words, in MILLIMETRES.
    ///
    /// **Best-effort by design, and the caller turns any error into "no words".**
    /// The transcript is already in hand from the DB at this point, so a blob that
    /// has gone cold, a range that no longer validates, or a block that will not
    /// decode must cost the reader its word boxes and nothing else — the OCR
    /// panel, which is the shipped consumer, does not read this field at all.
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
                // Duped: the labels borrow `rec.parsed`, which is deinit'd on the
                // way out of this function even though the arena outlives it.
                .text = try arena.dupe(u8, w.label),
                .xMm = w.box.x,
                .yMm = w.box.y,
                .wMm = w.box.width,
                .hMm = w.box.height,
            };
        }
        return out;
    }

    /// `GET /note/{id}/page/{n}/links` — the links a PDF used as this page's
    /// template brought with it, plus the `links_hash` the caller's `?v=` must
    /// match. Null when the note/page doesn't exist, isn't owned by `user_id`,
    /// or **has no `EXTERNALLINKINFO` block** — which is every page of every
    /// note that was not built on an imported PDF, and which the handler 404s
    /// exactly as it does a stale `?v=`, for the same reason `pageText` does: a
    /// page with no hash has no version a request could ever match, and a
    /// client following the contract (`PageRef.linksHash` null → no request)
    /// never asks.
    pub fn pageLinks(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, n: u64) !?PageLinks {
        const entry = (try self.lookup(.live, user_id, id)) orelse return null;
        defer freeEntry(self.files.gpa, entry);
        if (entry.is_folder) return null;
        const md5 = entry.md5 orelse return null;
        return self.pageLinksForMd5(arena, md5, n);
    }

    /// `pageLinks` keyed directly by a blob md5. ONE ranged read of the page's
    /// own block — the container is address-based and the indexer stored where
    /// that block is, so serving one page's links never opens the note. The
    /// note's `page_count` rides along on the same row because an internal jump
    /// is only a link if it lands on a page that exists.
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

    /// Upper bound on an `EXTERNALLINKINFO` block we will read. The heaviest
    /// page in the capture that established the format holds 123 records in
    /// about 11 KB; this is two orders of magnitude of headroom and still a hard
    /// ceiling on what one request can allocate out of a blob whose contents an
    /// untrusted device chose.
    const max_links_bytes: i64 = 1 << 20;

    /// Upper bound on the links one page may SERVE, as opposed to hold. Each one
    /// becomes a real focusable anchor in the reader, so this is a DOM bound as
    /// much as a byte bound — 123 is the corpus's worst page, and a file that
    /// wants ten thousand hit targets over one page is doing something the
    /// reader has no business reproducing.
    const max_links_per_page: usize = 1024;

    /// Decode the stored `EXTERNALLINKINFO` range into the client's link shape.
    ///
    /// **Best-effort, and the caller turns any error into "no links".** A page
    /// that renders without its links is a page; a page that fails to render
    /// because a link block went bad is not.
    ///
    /// Three conversions happen here and nowhere else, because this is the seam
    /// where §14's spelling meets the client's:
    ///
    ///  1. **1-based page number → 0-based index**, and a target outside the
    ///     note is dropped rather than clamped. (The two agree by construction
    ///     for a notebook, whose footer numbers its pages 1..N with no gaps;
    ///     a `.mark`'s numbering is sparse, but a mark annotates a PDF and has
    ///     no imported template, so it carries no link records at all.)
    ///  2. **`none` → external**, spelled `page = -1`, which is what the client's
    ///     `PdfLink` means by external.
    ///  3. **The scheme allowlist**, applied HERE as well as in the browser. The
    ///     device file is untrusted input and this is the first gate; the
    ///     client's `linkTarget` is the last one. Duplicating it is deliberate —
    ///     the exporter reads this same endpoint, and a `javascript:` URI that
    ///     only the viewer refused would still have reached a PDF someone else
    ///     opens.
    ///
    /// A record with an empty rect is dropped for the same reason the PDF
    /// decoder drops it: it is not a hit area, and an anchor of no size is a
    /// tab stop that cannot be seen or clicked.
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
                // Duped: the record borrows `parsed`, which is deinit'd on the
                // way out of this function even though the arena outlives it.
                .uri = try arena.dupe(u8, l.uri),
            });
        }
        if (out.items.len == 0) return null;
        return out.items;
    }

    /// Writes the planned page's SNPG bytes to `out`, streaming each layer's
    /// block straight out of the blob in `blobstore.chunk_len` windows. Exactly
    /// `plan.plan.content_length` bytes.
    ///
    /// CONTRACT: **this function must never touch the DB.** It is pure filesystem
    /// plus socket, which is the whole reason the page route can drop the global
    /// lock before it — and it holds no more than one chunk of the page at a time,
    /// so a multi-MB page costs 64 KB of RSS rather than its own size.
    pub fn writePage(self: ControlPlaneService, planned: PagePlan, out: *std.Io.Writer) !void {
        try noteindex.streamPage(self.files.blobs, &planned.md5, planned.plan, out);
    }

    /// `GET /thumbnail/{hash}` — the ownership gate, and ONLY the ownership
    /// gate: may `user_id` read anything derived from the blob with md5 `hash`?
    /// The bytes themselves live in the `thumbs/` derived store and are
    /// streamed by the handler off the db lock; this is the one DB question the
    /// route asks.
    ///
    /// False → the handler's 404, which covers BOTH "the caller does not hold
    /// that blob" and (downstream) "the blob ships no thumbnail", deliberately
    /// indistinguishable. Scoped through `Files.holdsBlob`, the md5-keyed
    /// counterpart of the `files.get(user_id, id)` boundary every id-keyed read
    /// uses — necessary because a thumbnail is content-addressed and shared
    /// across users, so only a `files` row says whose it is. A short/malformed
    /// hash holds no blob and so is false too.
    pub fn thumbnailAllowed(self: ControlPlaneService, user_id: u64, hash: []const u8) !bool {
        if (hash.len != blobstore.md5_hex_len) return false;
        return self.files.holdsBlob(user_id, hash);
    }

    // ---- index-backed reads (no file I/O) ----

    /// The note-level facts a summary needs, from `note_index`. Null when there
    /// is no row at the current `index_version` — which, after `backfill`, means
    /// the blob is not on disk or could not be indexed at all.
    /// `px_per_mm` is resolved HERE, not carried out as the raw `equipment`
    /// string: `columnText` borrows the statement's row, and the `defer
    /// s.finalize()` below frees it before the caller ever sees it. Returning a
    /// plain float keeps the borrow strictly inside the statement's lifetime.
    const IndexRow = struct {
        indexable: bool,
        page_count: i64,
        /// The blob's own page dimensions. For a `.note` these are the device
        /// panel; for a `.pdf` they are page 1's rotated, cropped box in points,
        /// written by `pdf_index.zig`. Zero when nothing has measured them.
        width: i64,
        height: i64,
        /// The signature's 4-byte file-type marker — "note", or "mark" for the
        /// PDF-annotation sibling. NULL for the ASA family (no marker) and for
        /// a row written before schema v6.
        ///
        /// BY VALUE, not a slice: the marker is exactly four bytes and the row
        /// it was read from is finalized before this returns, so borrowing would
        /// dangle and duping would need an allocator this function does not take.
        filetype: ?[4]u8,
        recognized_page_count: i64,
        px_per_mm: ?f32,
        /// The `.note` cover memo (v14): NULL = ships none, 0 = stored but its
        /// dims would not decode, positive = the cover's own pixel dims.
        cover_w: ?i64,
        cover_h: ?i64,
        /// The `.spd` thumbnail's dims, riding the same single-row read via a
        /// LEFT JOIN on `spd_index` at ITS current version — NULL both when the
        /// blob has no (current) spd row and when the row records "ships no
        /// thumbnail"; 0 = stored but undecodable, exactly the cover contract.
        spd_thumb_w: ?i64,
        spd_thumb_h: ?i64,
        /// The `.spd` CANVAS (surface) dims — the real drawing shape. Atelier
        /// embeds a fixed 600x800 PORTRAIT thumbnail that letterboxes the drawing
        /// (white bands), so the thumb dims lie about a landscape sketch's shape;
        /// the tile aspect must come from the surface, not the preview. Same LEFT
        /// JOIN, same NULL/0 contract as the thumb dims.
        spd_surface_w: ?i64,
        spd_surface_h: ?i64,
    };

    fn indexRow(self: ControlPlaneService, md5: []const u8) !?IndexRow {
        // The LEFT JOIN is the whole of the `.spd` aspect's query cost: every
        // blob a listing shows already has its `note_index` row (ingest parses
        // eagerly, and the read paths backfill), so hanging `spd_index` off it
        // keeps this ONE indexed single-row lookup per note per listing — the
        // count `indexRowEnsuring`'s read-first ordering exists to protect.
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

    /// Decision 3 of `docs/scratch/archive/masonry.md`, in one place: the aspect fact a
    /// listing row serves, or null for "omit the field".
    ///
    /// A `.note` (an indexable row): the device-rendered cover's dims when one
    /// is stored AND decodable (`cover_w > 0` — 0 is the "stored but
    /// undecodable" marker, NULL is "ships none"), else page 0's EFFECTIVE dims,
    /// which the caller has already fetched as the row's `firstPage`.
    ///
    /// Anything else: the `.spd` CANVAS (surface) dims under the same 0/NULL
    /// contract — NOT the thumbnail's. Atelier embeds a fixed 600x800 portrait
    /// preview that letterboxes the drawing, so a landscape sketch's thumb dims
    /// would shape the tile portrait; the surface is the real shape. Fall back to
    /// the thumb dims only when the surface is unknown (a corrupt `ls` protobuf).
    /// Deliberately NOT gated on `spd_index.indexable` — these columns describe the
    /// file's geometry, not the layer tree, and a corrupt `ls` protobuf must not
    /// blind the layout (see `spd_index.zig`). Images, `.txt`, unknown blobs and
    /// the fallback page all land on null.
    fn aspectOf(row: IndexRow, first_page: ?PageRefVO) ?AspectVO {
        if (row.indexable) {
            if (positivePair(row.cover_w, row.cover_h)) |a| return a;
            const p = first_page orelse return null;
            return positivePair(p.width, p.height);
        }
        // A `.pdf`'s shape, from `pdf_index.zig`. WIDENED rather than folded into
        // `indexable`, which means "is this a real `.note`" and is asked that way
        // by every other caller: a row with a positive width/height has a shape
        // worth serving, whatever produced it. Before this, a PDF reached here
        // with nothing to offer and the gallery guessed 3:4.
        return positivePair(row.spd_surface_w, row.spd_surface_h) orelse
            positivePair(row.spd_thumb_w, row.spd_thumb_h) orelse
            positivePair(row.width, row.height);
    }

    /// `{w, h}` only when BOTH are known and positive: the field's contract is
    /// "absent, never 0/negative", so a half-known pair is no fact at all.
    fn positivePair(w: ?i64, h: ?i64) ?AspectVO {
        const ww = w orelse return null;
        const hh = h orelse return null;
        return if (ww > 0 and hh > 0) .{ .w = ww, .h = hh } else null;
    }

    /// `indexRow`, backfilling only if there is nothing to read.
    ///
    /// READ FIRST, REPAIR SECOND — the order is the point. `backfill`'s own gate
    /// is `noteindex.isCurrent`, which is character-for-character the lookup
    /// `indexRow` performs (`note_index` by `blob_md5` at `index_version`), so
    /// backfilling up front spent two identical single-row queries per note on
    /// the warm path — and the warm path is every listing after a blob's first
    /// read. A row returned here has already proved the blob is indexed at the
    /// current version; only its ABSENCE can justify the repair.
    ///
    /// Under the server's coarse `db_lock` a folder listing's query count is
    /// held per-request latency for every other connection, which is what makes
    /// halving it worth the reordering.
    fn indexRowEnsuring(self: ControlPlaneService, md5: []const u8) !?IndexRow {
        if (try self.indexRow(md5)) |row| return row;
        self.backfill(md5); // cold or stale: parse (ranged, unlocked) and store
        return self.indexRow(md5);
    }

    /// Lazy backfill. A missing or stale index row is repaired here, on the read
    /// path, so pre-existing blobs and `index_version` bumps need no migration.
    ///
    /// Best-effort **by design**: if indexing fails (blob gone, disk error, a
    /// nested transaction) the caller falls through to the placeholder page
    /// rather than failing the whole listing for one bad file.
    ///
    /// COST: a no-op single-row `SELECT` once a blob is indexed (`isCurrent`).
    /// The parse only ever happens on the first read of an unindexed blob, and it
    /// reads ranges rather than buffering the note.
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

    /// The `.txt` half of the lazy heal (the segment seam's first tenant):
    /// a pre-existing `.txt`, invisible to search before the v5→v6 bump,
    /// derives its paragraph segments on its first LISTING view — the one
    /// place with the file NAME in hand, which is the derivation gate.
    ///
    /// Ordered AFTER `backfill` at every call site: the note half heals the
    /// `note_index` row to the current version first, and `txt_index`'s own
    /// gate returns early on a stale row (it would only derive segments the
    /// note heal's tail-drop wipes). A no-op — one indexed SELECT — once the
    /// blob is derived. Best-effort: a bad file costs its own searchability,
    /// never the whole listing. One-time cost per blob on that first view
    /// (seconds for a big file, plan decision 6).
    fn txtBackfill(self: ControlPlaneService, md5: []const u8, name: []const u8) void {
        txtindex.ensureIndexed(
            self.files.gpa,
            self.files.db,
            self.files.blobs,
            md5,
            name,
            std.Io.Clock.real.now(self.files.io).toSeconds(),
        ) catch {};
    }

    /// One page's ref straight out of `note_page_index`. The dims are the stored
    /// **effective** per-page dims (the note's real header size, orientation
    /// applied) — not a hardcoded device size, which is what used to make this
    /// disagree with the SNPG payload on anything but a 1404×1872 device.
    ///
    /// Carries the page's layer panel too, through the SAME `layerVOsFromBlob`
    /// the reader's page list uses — this is the LISTING's page 0, and the
    /// reader opens from it before `noteMeta` lands. The blob is one more
    /// column on a row this already reads: no second statement, no per-row
    /// query, nothing proportional to the note.
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

    /// Every page of a note, in `page_index` order — one statement, no file I/O.
    /// This is the READER's page list, so each ref carries its layer panel
    /// (`LayerVO`s straight out of the packed index records — names, authored
    /// visibility, isCurrent — no blob touched).
    fn pageRefsFromIndex(self: ControlPlaneService, arena: std.mem.Allocator, md5: []const u8) ![]const PageRefVO {
        var out: std.ArrayList(PageRefVO) = .empty;
        var s = try self.files.db.prepare(
            "SELECT page_index, content_hash, width, height, text_hash, layers, source_page, links_hash " ++
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
                // Omitted when it is just the position plus one — see the field.
                // 0 is the pre-v7 / no-number reading and is omitted too: it is
                // not a legal page number and must not travel as one.
                .sourcePage = blk: {
                    const n = s.columnInt(6);
                    break :blk if (n == 0 or n == s.columnInt(0) + 1) null else n;
                },
                .linksHash = if (s.columnIsNull(7)) null else try arena.dupe(u8, s.columnText(7)),
            });
        }
        return out.items;
    }

    /// Maps one packed `layers` blob to the panel VOs (SNPG record order).
    /// Null — the honest "no panel" — for an empty or malformed blob rather
    /// than failing the whole page list over one row; the blob was written by
    /// this same version's `packLayers`, so malformed means tampered.
    ///
    /// THE serializer for this fact, shared by `pageRefsFromIndex` (the
    /// reader's page list) and `pageRefAt` (a listing/bin row's `firstPage`),
    /// so page 0 reads identically whichever response the client got it from.
    /// A second copy of this mapping is the one way those could drift.
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

    /// `noteMeta`'s page list. Non-`.note` files (`indexable = 0`) and blobs that
    /// could not be indexed keep the single-placeholder-page fallback they always
    /// had — other file types legitimately live in the tree.
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
        /// See `EntryVO.thumbAspect`. Null survives into the VO as an omitted
        /// field; a `.spd`'s aspect rides alongside the fallback placeholder
        /// page, because the two describe different things (the tile's shape
        /// vs. something to draw).
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
            // The listing is where a `.txt` heals into search (it has the
            // name — the derivation gate). Runs after the note backfill
            // inside `indexRowEnsuring`; a no-op once derived.
            self.txtBackfill(md5, entry.name);
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
            .count = fb.count,
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

/// A page's content hash — the browser's immutable `?v=` cache key. Defined ONCE,
/// in the indexer, so the stored `content_hash` column and the parse-driven page
/// path can never disagree (if they did, every cached page URL would change).
const pageContentHash = noteindex.pageContentHash;

// ---- fallbacks for non-`.note` files ----

/// A file's declared type when the indexer could not confirm it is a `.note`:
/// the filename's extension, lowercased and without the dot. `no_extension` when
/// there is none (or the name is a leading-dot name like `.keep`, whose "dot"
/// starts the name rather than separating an extension).
const no_extension = "file";

/// THE file-type rule, in one place. VERIFIED, not claimed: `indexable` means the
/// indexer actually parsed a `.note` container out of these bytes, whatever the
/// file is called; only an unparseable blob falls back to its extension.
/// The type the app reports for a blob: what the PARSER verified, not what the
/// filename claims.
///
/// An indexable blob used to report the literal "note" whatever it was, which is
/// why a `.mark` — the device's PDF-annotation sibling, structurally a thin
/// `.note` — has always been indistinguishable from a notebook. The signature's
/// 4-byte marker now decides, so a mark says so.
///
/// UNKNOWN MARKERS STILL SAY "note". The marker is NULL for the ASA family and
/// for rows written before schema v6, and it could be some fourth thing a future
/// firmware writes. All of those parse as notes and render as notes, so calling
/// them notes is the truthful answer; only a marker we positively recognise as
/// something else changes the reply.
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
const notesearch = @import("search/query.zig");
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

/// Seeds a synthetic `.note` (given per-page main-layer bitmaps) as a file, and
/// returns its file id.
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

/// What `controlplanePage` produces, collected into memory so tests can assert on
/// it: plan the page, then stream it exactly as the handler does. Null wherever
/// the handler would 404. The bytes are `arena`-owned.
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

    // Root: one folder (Work) then one note (top.note), folders-first.
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

    // Inside Work: the 3-page note, with a breadcrumb of [Work].
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
    // Folders sort first, by name: Empty, Work.
    try testing.expectEqualStrings("Empty", root.entries[0].name);
    try testing.expectEqual(@as(i64, 0), root.entries[0].itemCount.?); // → "Empty", not "0 items"

    const work = root.entries[1];
    try testing.expectEqualStrings("Work", work.name);
    // Direct children of every kind: Projects + two notes. `deep.note` is a
    // grandchild and is not counted.
    try testing.expectEqual(@as(i64, 3), work.itemCount.?);

    // A trashed child leaves the count as it leaves the listing.
    try f.files.trash(1, doomed);
    const after = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqual(@as(i64, 2), after.entries[1].itemCount.?);

    // A NOTE row carries none, so with `emit_null_optional_fields = false` its
    // JSON is exactly the `NoteSummary` shape it was before the count existed.
    const listed = try svc.listing(arena.allocator(), 1, dir.id);
    for (listed.entries) |e| {
        if (std.mem.eql(u8, e.kind, "note")) try testing.expect(e.itemCount == null);
    }
    try testing.expectEqualStrings("note", listed.entries[1].kind);
    const json = try std.json.Stringify.valueAlloc(arena.allocator(), listed.entries[1], .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, json, "itemCount") == null);
    try testing.expect(std.mem.indexOf(u8, json, "pageCount") != null); // …but the note fields are all still there

    // The BREADCRUMB is a path, not a set of rows to render: no count there.
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
    // Indices are 0-based and dimensions are the native page size.
    try testing.expectEqual(@as(i64, 0), meta.pages[0].index);
    try testing.expectEqual(@as(i64, 2), meta.pages[2].index);
    try testing.expectEqual(@as(i64, 1404), meta.pages[0].width);
    try testing.expectEqual(@as(i64, 1872), meta.pages[0].height);
    // Same bitmap (page 0 and 2 are "AAAA") → identical content hash; page 1 differs.
    try testing.expectEqualStrings(meta.pages[0].hash, meta.pages[2].hash);
    try testing.expect(!std.mem.eql(u8, meta.pages[0].hash, meta.pages[1].hash));

    // A missing id / a folder → null.
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

    // Page 2 (the edited panel): five layers in SNPG record order
    // (bottom-to-top), LAYER2 authored-invisible, the renamed current LAYER3.
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

    // Page 1 (#-JSON LAYERINFO, untouched panel): both drawn layers named.
    const p0 = meta.pages[0].layers.?;
    try testing.expectEqual(@as(usize, 2), p0.len);
    try testing.expectEqualStrings("background", p0[0].slot);
    try testing.expectEqualStrings("main", p0[1].slot);
    try testing.expectEqualStrings("Main Layer", p0[1].name);
    try testing.expect(p0[1].isCurrent);

    // The LISTING's firstPage carries the SAME descriptors as `noteMeta`'s
    // page 0 — the reader opens from the summary and must not have to guess
    // (nor repaint page 0 when the metadata lands behind it).
    const listing_vo = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqual(@as(usize, 1), listing_vo.entries.len);
    try expectSameLayers(meta.pages[0].layers, listing_vo.entries[0].firstPage.?.layers);

    // And so does the same row through `entryVO` (the rename response), which
    // the client reconciles against a listing row field-for-field.
    const one = (try f.files.get(1, e.id)).?;
    defer freeEntry(testing.allocator, one);
    const renamed = try svc.entryVO(arena.allocator(), 1, one);
    try expectSameLayers(meta.pages[0].layers, renamed.firstPage.?.layers);
}

/// Both sides of the ONE contract `layerVOsFromBlob` serializes: absent stays
/// absent (an omitted field, never `[]`), and present matches field-for-field
/// in record order.
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

    // A synthetic note whose one page carries NO layer records at all — the
    // "omitted" side of the contract (never `null`, never `[]`, absent).
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
            // Null → omitted by `emit_null_optional_fields = false`. Never `[]`.
            try testing.expect(entry.firstPage.?.layers == null);
        }
    }
    try testing.expect(seen_layered and seen_plain);

    // The BIN builds its `firstPage` through the very same `pageRefAt`, so a
    // trashed row reports exactly what it did while it was live.
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
    // The hash the byte endpoint serves under matches the one noteMeta advertised.
    try testing.expectEqualStrings(meta.pages[1].hash, &pb.hash);
    // The Content-Length promised BEFORE reading anything is what got written.
    try testing.expectEqual(pb.content_length, @as(u64, pb.bytes.len));

    // Out-of-range page and unknown note → null.
    try testing.expect((try servePage(svc, arena.allocator(), 1, id, 9)) == null);
    try testing.expect((try servePage(svc, arena.allocator(), 1, 99999, 0)) == null);
}

test "recognized text: noteMeta carries textHash, and pageText serves the transcript under it" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // A two-page note: page 0 finished recognition, page 1 is still running — so
    // exactly one page has a transcript, and the other must be indistinguishable
    // from "never recognized" to every caller.
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

    // The page list advertises the transcript's version — this is what re-enables
    // the reader's Text toggle, which was permanently disabled while every page
    // came back with a null textHash.
    const meta = (try svc.noteMeta(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 2), meta.pages.len);
    try testing.expectEqual(@as(usize, 32), meta.pages[0].textHash.?.len);
    try testing.expect(meta.pages[1].textHash == null);
    // It is NOT the content hash: recognition adds a transcript without touching
    // a single stroke, so the two must be able to move independently.
    try testing.expect(!std.mem.eql(u8, meta.pages[0].hash, meta.pages[0].textHash.?));

    // The transcript comes back under exactly the version the page list gave out.
    const pt = (try svc.pageText(a, 1, id, 0)).?;
    try testing.expectEqualStrings(meta.pages[0].textHash.?, &pt.hash);
    try testing.expectEqualStrings("hello\nworld", pt.vo.text.?); // v7: distinct recognized regions join with a newline, not a space

    // A page with no finished recognition has no version to be asked for, so the
    // read is a miss (which the handler turns into the same 404 as a stale `?v=`).
    try testing.expect((try svc.pageText(a, 1, id, 1)) == null);
    // ...as are an out-of-range page, an unknown note, and a folder.
    try testing.expect((try svc.pageText(a, 1, id, 99)) == null);
    try testing.expect((try svc.pageText(a, 1, 99999, 0)) == null);
    const dir = try f.files.createFolder(1, null, "D");
    defer testing.allocator.free(dir.name);
    try testing.expect((try svc.pageText(a, 1, dir.id, 0)) == null);

    // A non-`.note` never has a transcript, and never claims a textHash.
    const pdf = try seedBytes(&f, null, "x.pdf", "%PDF-1.7 nope");
    try testing.expect((try svc.pageText(a, 1, pdf, 0)) == null);
    const pdf_meta = (try svc.noteMeta(a, 1, pdf)).?;
    try testing.expect(pdf_meta.pages[0].textHash == null);

    // OWNERSHIP: the index row is keyed by blob md5 and blobs are deduplicated,
    // so the scoping has to come from the `files` lookup — assert it does.
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try f.db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    try testing.expect((try svc.pageText(a, 2, id, 0)) == null);
}

test "template links: noteMeta carries linksHash, and pageLinks serves the records under it" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // A three-page note in the shape §14 describes — the device rasterises an
    // imported PDF into each page's style and keeps that page's link rectangles
    // beside it. Page 0 has links, page 1 has none at all.
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{
            .{
                .style = "user_pdf_planner_1",
                .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
                .links = &.{
                    // An internal jump to page 3 of 3 — 1-based on the wire.
                    .{ .target_page = 3, .x = 901, .y = 192, .w = 407, .h = 50 },
                    // A web link whose URL carries both a comma and an `=`.
                    .{ .uri = "https://onplanners.com/g?a=1,2&b=3", .x = 53, .y = 464, .w = 297, .h = 121 },
                    // Refused: the scheme allowlist is applied on this side too,
                    // because the exporter reads this endpoint.
                    .{ .uri = "javascript:alert(1)", .x = 10, .y = 10, .w = 50, .h = 50 },
                    // Refused: a target page this note does not have.
                    .{ .target_page = 99, .x = 20, .y = 20, .w = 50, .h = 50 },
                    // Refused: an empty rect is not a hit area.
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

    // The page list advertises the version, and ONLY for the page that has one.
    // That is what lets the reader skip the request for every other page rather
    // than ask each one in turn whether it has links.
    const meta = (try svc.noteMeta(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 32), meta.pages[0].linksHash.?.len);
    try testing.expect(meta.pages[1].linksHash == null);
    // NOT the content hash: a re-imported template can change a page's links
    // without touching a stroke, so the two must move independently.
    try testing.expect(!std.mem.eql(u8, meta.pages[0].hash, meta.pages[0].linksHash.?));

    const pl = (try svc.pageLinks(a, 1, id, 0)).?;
    try testing.expectEqualStrings(meta.pages[0].linksHash.?, &pl.hash);

    // Two of the five records survive; the other three are each refused for
    // their own stated reason.
    try testing.expectEqual(@as(usize, 2), pl.vo.links.len);

    // THE 1-BASED → 0-BASED CONVERSION, which happens here and nowhere else:
    // the record says page 3, the client's `PdfLink` means index 2.
    const jump = pl.vo.links[0];
    try testing.expectEqual(@as(i64, 2), jump.page);
    try testing.expectEqual(@as(f64, 901), jump.x);
    try testing.expectEqual(@as(f64, 192), jump.y);
    try testing.expectEqual(@as(f64, 407), jump.w);
    try testing.expectEqual(@as(f64, 50), jump.h);

    // `none` → EXTERNAL is spelled -1, and the URL survives its comma and `=`
    // intact — the whole reason §14 base64s every field separately.
    const web = pl.vo.links[1];
    try testing.expectEqual(@as(i64, -1), web.page);
    try testing.expectEqualStrings("https://onplanners.com/g?a=1,2&b=3", web.uri);

    // A page with no link block has no version to be asked for, so the read is a
    // miss — which the handler turns into the same 404 as a stale `?v=`.
    try testing.expect((try svc.pageLinks(a, 1, id, 1)) == null);
    // ...as are an out-of-range page, an unknown note, a folder and a non-note.
    try testing.expect((try svc.pageLinks(a, 1, id, 99)) == null);
    try testing.expect((try svc.pageLinks(a, 1, 99999, 0)) == null);
    const dir = try f.files.createFolder(1, null, "D");
    defer gpa.free(dir.name);
    try testing.expect((try svc.pageLinks(a, 1, dir.id, 0)) == null);
    const pdf = try seedBytes(&f, null, "x.pdf", "%PDF-1.7 nope");
    try testing.expect((try svc.pageLinks(a, 1, pdf, 0)) == null);

    // OWNERSHIP: index rows are keyed by blob md5 and blobs are deduplicated, so
    // the scoping can only come from the `files` lookup — assert it does.
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try f.db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    try testing.expect((try svc.pageLinks(a, 2, id, 0)) == null);
}

test "template links: a block of nothing but unreadable records serves no links, not a failure" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // The page HAS a link block, so it has a version and the route answers 200 —
    // but nothing in the block is a record. A page renders perfectly without its
    // links, so this must degrade to "no links" rather than cost the page.
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

    // Overwrite the block's content in place with the same number of bytes of
    // nonsense, so the stored range still validates and only the CONTENT is bad.
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

    // The real shape of an undecodable RECOGNTEXT: the indexer keeps the range and
    // the hash (so the version is still meaningful) but has no transcript to store.
    try f.db.exec("UPDATE note_page_index SET text = NULL;");

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const pt = (try svc.pageText(arena.allocator(), 1, id, 0)).?;
    try testing.expect(pt.vo.text == null); // servable, just empty

    // Null optionals are omitted, so the wire form is `{}` — which the client
    // reads as "" and the panel renders as "no recognized text".
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

// ---- the migration safety net: index-driven == the old parse-driven path ----

/// The **pre-migration** projection, reproduced verbatim: read the whole blob,
/// `sn.parse` it, and derive each page's hash and dims from the parse (dims from
/// the hardcoded device default with the orientation swap — bug #8 and all).
///
/// This exists only so the index-driven path can be proved to produce the exact
/// same `PageRefVO`s for real device captures. Deleting it would delete the
/// evidence that the migration changed nothing on the wire.
///
/// It is a frozen snapshot of the OLD behaviour, so it keeps the `1090` swap
/// verbatim — which index v2 dropped and v3 reinstated as the settled behaviour
/// once landscape storage was proven natively landscape (see
/// `note_index.NoteHeader`). Both sample captures are `ORIENTATION = 1000`
/// throughout, so the branch is dead here; the live decision is asserted
/// directly against a landscape fixture in `note_index.zig`.
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
        try testing.expectEqual(w.index, g.index); // ordering is part of the contract
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

        // noteMeta: page count, per-page hashes, dims and ordering, all identical.
        const meta = (try svc.noteMeta(a, 1, id)).?;
        try expectSameRefs(want, meta.pages);

        // listing: page count and the first-page ref, identical.
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

    // Simulate a blob that predates the index (or whose eager index failed).
    // The segment rows (and their postings) are derived state too, and their
    // FK deliberately blocks deleting pages from under them — wipe them the
    // way a pre-index database simply never had them.
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('delete-all');");
    try f.db.exec("DELETE FROM segment_search;");
    try f.db.exec("DELETE FROM note_index;");
    try testing.expect(!try noteindex.isCurrent(f.db, &md5));

    const cold = (try svc.noteMeta(a, 1, id)).?;
    try testing.expect(try noteindex.isCurrent(f.db, &md5)); // backfilled in-flight
    try expectSameRefs(try legacyPageRefs(a, sample2, &md5), cold.pages);

    // THE assertion that the second read opens no file: delete the blob from
    // disk. A path that still read bytes could not possibly answer.
    f.files.blobs.remove(&md5);
    try testing.expect(!f.files.blobs.has(&md5));

    const warm = (try svc.noteMeta(a, 1, id)).?;
    try expectSameRefs(cold.pages, warm.pages);
    const listed = try svc.listing(a, 1, null);
    try testing.expectEqual(cold.pages.len, @as(usize, @intCast(listed.entries[0].pageCount.?)));
    try expectSameRefs(cold.pages[0..1], (&listed.entries[0].firstPage.?)[0..1]);
}

test "a STALE index row is still repaired, though nothing asks isCurrent first" {
    // The read paths used to call `backfill` (gated by `isCurrent`) and then
    // `indexRow` — two identical single-row lookups per note, per listing. Now
    // `indexRowEnsuring` reads first and repairs only on a miss, which is only
    // correct because `indexRow` filters on `index_version` exactly as
    // `isCurrent` does: a row at the WRONG version has to read as absent, or a
    // version bump would silently serve stale index data forever with no
    // migration able to notice.
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedBytes(&f, null, "real.note", sample2);
    const md5 = try md5Of(&f, id);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);
    const fresh = (try svc.noteMeta(a, 1, id)).?;

    // Age the row: present, but at a version this build no longer trusts.
    {
        var s = try f.db.prepare("UPDATE note_index SET index_version = ?1 WHERE blob_md5 = ?2;");
        defer s.finalize();
        s.bindInt(1, noteindex.index_version - 1);
        s.bindText(2, &md5);
        _ = try s.step();
    }
    try testing.expect(!try noteindex.isCurrent(f.db, &md5));

    // A listing must repair it rather than read straight past it.
    const listed = try svc.listing(a, 1, null);
    try testing.expect(try noteindex.isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, @intCast(fresh.pages.len)), listed.entries[0].pageCount.?);
    try expectSameRefs(fresh.pages[0..1], (&listed.entries[0].firstPage.?)[0..1]);
}

test "fileType is verified from the container, not the filename" {
    var f = try Fixture.init();
    defer f.deinit();

    // A real `.note` deliberately misnamed, a PDF-ish blob living in the tree,
    // an upper-case extension, and a name with no extension at all.
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

    // The extension rule, at its edges.
    const a = arena.allocator();
    try testing.expectEqualStrings("file", try extensionOf(a, ".keep")); // leading dot ≠ extension
    try testing.expectEqualStrings("file", try extensionOf(a, "trailing.")); // empty extension
    try testing.expectEqualStrings("gz", try extensionOf(a, "a.tar.gz")); // last dot wins
}

test "fileTypeFor: the parser's verdict wins over the name, and a mark says so" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // Not a parseable note -> the extension, whatever it claims to be.
    try testing.expectEqualStrings("pdf", try fileTypeFor(a, false, null, "book.pdf"));
    try testing.expectEqualStrings("note", try fileTypeFor(a, false, null, "liar.note"));

    // Indexable + the "mark" marker -> a mark, EVEN THOUGH it parses as a note
    // and even when the filename says otherwise. This is the whole point: the
    // marker is the only thing that distinguishes them.
    const mark: [4]u8 = "mark".*;
    try testing.expectEqualStrings("mark", try fileTypeFor(a, true, mark, "anything.note"));

    // Indexable with the "note" marker, or with NO marker at all (the ASA
    // family, and every row written before schema v6) -> "note". An unknown
    // marker must not demote a file that plainly renders as a notebook.
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

    // FILE_RECOGN_TYPE = 1 on both, but only the second has a finished page.
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

    // The badge must agree with the search filter EXACTLY: shown ⟺ findable.
    const hits = try notesearch.searchPages(arena.allocator(), testing.io, f.db, 1, "hello", 20, null);
    try testing.expectEqual(@as(usize, 1), hits.hits.len);
    try testing.expectEqualStrings("done.note", hits.hits[0].noteName);

    // A non-`.note` never claims recognized text.
    _ = try seedBytes(&f, null, "x.pdf", "%PDF-1.7 nope");
    const again = try svc.listing(arena.allocator(), 1, null);
    for (again.entries) |e| {
        if (std.mem.eql(u8, e.name, "x.pdf")) try testing.expect(!e.hasRecognizedText.?);
    }
}

/// A `std.Io.Writer` that counts bytes and drops them — a stand-in for the
/// socket. A `Writer.Allocating` here would grow to the payload size and measure
/// the test's own collector instead of the server.
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
    // > The server never holds a whole note or a whole page in memory; every blob
    // > read and write is bounded by a fixed 64 KB chunk.
    //
    // Before this step, `pageBytesOf` read the whole note into an arena
    // (`readBlob`, capped at 64 MiB) and then built the whole payload in a second
    // allocation, to emit ONE page. This measures the replacement end to end: the
    // service is handed a peak-tracking allocator and asked to plan and stream a
    // page whose single layer is 8 MiB.
    const gpa = testing.allocator;
    var f = try Fixture.init();
    defer f.deinit();
    defer f.files.gpa = gpa; // always tear the fixture down on the real allocator

    // Two notes of the same shape, differing only in size — 8 MiB and 16 MiB in a
    // single layer. Equal-length names so the one legitimately size-dependent
    // allocation on the path (the `Entry`'s duped name) is held constant too.
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

    // Everything the REQUEST path allocates is measured — seeding and indexing are
    // done, so nothing else is on this allocator.
    var peaks: [2]usize = undefined;
    var served: [2]u64 = undefined;
    for (ids, 0..) |id, i| {
        var counter = PeakAllocator{ .child = gpa };
        f.files.gpa = counter.allocator();
        var svc = ControlPlaneService.init(&f.files);

        const planned = (try svc.pagePlan(1, id, 0)).?;
        var sink = CountingSink.init();
        try svc.writePage(planned, &sink.writer);

        // It really served the whole page, at the length the index predicted with
        // no file read at all.
        try testing.expectEqual(planned.plan.content_length, sink.total);
        try testing.expect(sink.total > 8 * 1024 * 1024);

        peaks[i] = counter.peak;
        served[i] = sink.total;
        f.files.gpa = gpa;
    }

    // THE BAR: peak live heap is a fixed small budget — well under ONE chunk —
    // while serving pages three orders of magnitude larger...
    for (peaks, served) |peak, total| {
        try testing.expect(peak < blobstore.chunk_len);
        try testing.expect(peak * 100 < total);
    }
    // ...and it does not SCALE: the page doubled, the memory did not move at all.
    try testing.expect(served[1] > 2 * served[0] - 4096);
    try testing.expectEqual(peaks[0], peaks[1]);
}

test "FINDING #8: noteMeta's per-page dims match the SNPG payload's, on a non-default device" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // An N5/Manta note: 1920×2560, NOT the 1404×1872 the old `pageDims` assumed.
    // Pre-migration, noteMeta advertised 1404×1872 while the payload carried
    // 1920×2560 — the two disagreed, which is the whole of finding #8.
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
        try testing.expectEqual(@as(i64, 1920), p.width); // and it is the REAL device size
        try testing.expectEqual(@as(i64, 2560), p.height);
    }

    // The listing summary carries the same dims as the note's page 0.
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

    // The live listing's answer, taken BEFORE the delete: the bin has to agree
    // with it, because it is the same page of the same blob and the browser
    // caches both under the same content hash.
    const live = try svc.listing(arena.allocator(), 1, dir.id);
    const live_page = live.entries[0].firstPage.?;

    try f.files.trash(1, dir.id); // takes `deep.note` down with it
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
            // The bin row renders a real preview, so it carries the aspect the
            // live listing did — here the coverless note's page-0 dims.
            try testing.expectEqual(@as(i64, 1404), e.thumbAspect.?.w);
            try testing.expectEqual(@as(i64, 1872), e.thumbAspect.?.h);
        }
        // A folder has no blob at all, and an unparseable one has no page index —
        // both keep the row's doc/folder glyph rather than an empty canvas.
        // Neither has a shape to freeze, either.
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

// ---- thumbAspect (decision 3 of docs/scratch/archive/masonry.md) ----

/// A minimal PNG whose IHDR carries 320×240 — dims `thumbnail.imageDims` can
/// decode. The same fixture `spd_index.zig`'s own tests use.
const mini_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ ("p" ** 16);

/// A minimal `.spd` — an in-memory SQLite db with a `config` table carrying an
/// embedded thumbnail — serialized to caller-owned bytes. Hermetic, mirroring
/// the fixture builders in `spd_index.zig` and `test/http_integration.zig`.
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

    // The pair, in a folder: `manual.pdf` + `manual.pdf.mark`. The extension is
    // APPENDED, not replaced — `manual.mark` is a different file entirely.
    const folder = try f.files.createFolder(1, null, "Docs");
    testing.allocator.free(folder.name);
    const pdf_id = try seedBytes(&f, folder.id, "manual.pdf", "%PDF-1.7\n%%EOF\n");
    const mark_id = try seedBytes(&f, folder.id, "manual.pdf.mark", mark_bytes);

    const meta = (try svc.noteMeta(a, 1, pdf_id)).?;
    try testing.expect(meta.annotationsId != null);
    try testing.expectEqualStrings(try idStr(a, mark_id), meta.annotationsId.?);

    // A PDF with NOTHING beside it says so, rather than pointing at the mark of
    // a different document.
    const lonely = try seedBytes(&f, folder.id, "lease.pdf", "%PDF-1.7\n%%EOF\n");
    try testing.expect((try svc.noteMeta(a, 1, lonely)).?.annotationsId == null);

    // WRONG FOLDER IS NO MATCH. A mark belongs to the PDF it sits beside; the
    // same name one folder up is a different pairing.
    const elsewhere = try seedBytes(&f, null, "away.pdf", "%PDF-1.7\n%%EOF\n");
    _ = try seedBytes(&f, folder.id, "away.pdf.mark", mark_bytes);
    try testing.expect((try svc.noteMeta(a, 1, elsewhere)).?.annotationsId == null);

    // And the MARK itself does not claim to be annotated — it is not a pdf, and
    // `manual.pdf.mark.mark` does not exist.
    try testing.expect((try svc.noteMeta(a, 1, mark_id)).?.annotationsId == null);

    // THE TYPE IS THE VERIFIED ONE, NOT THE NAME. A `.note` container called
    // `sneaky.pdf` is described as a note however it is spelled, so it does not
    // go looking for annotations — even with a plausible `sneaky.pdf.mark`
    // sitting right beside it. Naming is not evidence; the indexer's answer is.
    const book = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }} });
    defer gpa.free(book);
    const sneaky = try seedBytes(&f, folder.id, "sneaky.pdf", book);
    _ = try seedBytes(&f, folder.id, "sneaky.pdf.mark", mark_bytes);
    const sm = (try svc.noteMeta(a, 1, sneaky)).?;
    try testing.expectEqualStrings("note", sm.fileType.?);
    try testing.expect(sm.annotationsId == null);
}

test "noteMeta: a sparse .mark carries sourcePage; a notebook omits it entirely" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    // A `.mark`: three pages, belonging to PDF pages 2, 5 and 6.
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
        try testing.expectEqual(@as(i64, @intCast(i)), pg.index); // position addresses the bytes
        try testing.expectEqual(n, pg.sourcePage.?); // the number places it in the PDF
    }

    // A NOTEBOOK omits the field. It is always `index + 1` there, and a value
    // that is derivable is one every listing pays for and no client needs — the
    // omission is the contract, not an accident, so it is pinned.
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

    // AND A ZERO IS OMITTED, not sent as a page number. 0 is what a pre-v7 row
    // reads back as, and what every `.txt` row carries — `txt_index` shares this
    // table and never writes the column. There is no page 0, so a client that
    // received one would be placing annotations against a page that cannot
    // exist. Forced here by writing the pre-v7 state directly.
    {
        var u = try f.db.prepare("UPDATE note_page_index SET source_page = 0;");
        defer u.finalize();
        try testing.expect(!try u.step());
    }
    const zeroed = (try svc.noteMeta(arena.allocator(), 1, mark_id)).?;
    for (zeroed.pages) |pg| try testing.expect(pg.sourcePage == null);
}

test "thumbAspect: cover dims when a cover ships, page-0 EFFECTIVE dims otherwise, absent for the shapeless" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    // A covered note: the cover's OWN dims (320×240) win over the page's.
    const covered = try nb.serialize(gpa, .{
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
        .covers = &.{.{ .bytes = mini_png }},
    });
    defer gpa.free(covered);
    _ = try seedBytes(&f, null, "covered.note", covered);

    // A coverless LANDSCAPE note: page 0's stored dims are already
    // orientation-applied (index v3), so the tile is honestly wide.
    const landscape = try nb.serialize(gpa, .{
        .pages = &.{.{ .style = "style_white", .orientation = "1090", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
    });
    defer gpa.free(landscape);
    _ = try seedBytes(&f, null, "landscape.note", landscape);

    // A coverless portrait note, an image, a text file, and a folder.
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

    // Images, `.txt` and folders: the client's concern — no aspect served.
    try testing.expect((try entryNamed(root, "photo.png")).thumbAspect == null);
    try testing.expect((try entryNamed(root, "notes.txt")).thumbAspect == null);
    try testing.expect((try entryNamed(root, "Folder")).thumbAspect == null);

    // On the wire: PRESENT is the `{w, h}` pair, ABSENT is a missing field —
    // never `"thumbAspect":null`, which a client would read as a third state.
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

    // Live: the embedded thumbnail's dims, alongside the fallback placeholder
    // page (the `.spd` is not a `.note`; the aspect and the page describe
    // different things and must not be coupled).
    const live = try entryNamed(try svc.listing(a, 1, null), "drawing.spd");
    try testing.expectEqualStrings("spd", live.fileType.?);
    try testing.expectEqual(@as(i64, 320), live.thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 240), live.thumbAspect.?.h);

    // Bin: trashed entries still have blobs and render previews — same fact.
    try f.files.trash(1, id);
    const b = try svc.bin(a, 1);
    try testing.expectEqual(@as(usize, 1), b.entries.len);
    try testing.expectEqual(@as(i64, 320), b.entries[0].thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 240), b.entries[0].thumbAspect.?.h);
    // Omitted-not-null holds on the bin VO too.
    const json = try std.json.Stringify.valueAlloc(a, b.entries[0], .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, json, "\"thumbAspect\":{\"w\":320,\"h\":240}") != null);

    // A stale spd row is no fact: the LEFT JOIN filters on ITS index_version,
    // so the field drops out rather than serving a superseded shape. (It heals
    // on the next thumbnail request — `Files.repairDerivedThumb` — not here.)
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

    // The bin heals on read now (`indexRowEnsuring`, see `bin`): an
    // `index_version` bump strands a trashed note's row, and the bin is the
    // only surface that can repair it, so a stale row re-parses to current and
    // serves its first page + aspect rather than degrading to a generic tile.
    const b = try svc.bin(a, 1);
    try testing.expectEqual(@as(usize, 1), b.entries.len);
    try testing.expect(b.entries[0].firstPage != null);
    try testing.expect(b.entries[0].thumbAspect != null);
    // And the row is genuinely current again — not a one-shot.
    try testing.expect((try svc.bin(a, 1)).entries[0].firstPage != null);
}
