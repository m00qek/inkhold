//! The `.note` blob index: parse a container once, at ingest, and keep the
//! per-page facts the hot read paths need in SQLite (`note_index` +
//! `note_page_index`). See `docs/scratch/new-indexing.md` for the design.
//!
//! ## Two halves, on purpose
//!
//! `parseBlob` is **pure CPU and touches no database**; `store` writes rows and
//! must run inside the caller's transaction. That split is a hard structural
//! constraint, not a stylistic one: `upload/finish` runs under the whole-handler
//! global DB lock, so a naive "index inside `linkBlob`'s transaction" would hold
//! the global lock across a multi-MB parse and serialise a device syncing 100
//! notes against every other request. Parse first, unlocked; write rows locked.
//!
//! ## Self-healing, so no backfill migration is ever needed
//!
//! Rows are written eagerly at ingest (`Files.linkBlob`) and lazily on read
//! (`ensureIndexed`): a missing row, or one at a stale `index_version`, is
//! re-parsed on the spot. Because the parse is unlocked, two callers can
//! genuinely race — every write is therefore an upsert, so a duplicated parse is
//! merely wasteful and never a constraint violation.
//!
//! ## Keyed by blob md5
//!
//! Blobs are content-addressed and immutable, so an index row can never be
//! stale, and it is shared by every file that dedups onto the same content. The
//! flip side — index rows are NOT per-user — is why any future search must join
//! through `files` on `user_id`/`deleted` rather than querying the text alone.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const blob_source = @import("../store/blob_source.zig");
const search = @import("search/maintain.zig");
const thumbnail = @import("thumbnail.zig");
const sn = @import("supernote");

const Md5 = std.crypto.hash.Md5;
const Allocator = std.mem.Allocator;

/// Bump when the stored shape or its derivation changes: rows at an older
/// version are re-parsed by `ensureIndexed` the next time they are read.
///
/// - **1** → the original shape.
/// - **2** → per-page `width`/`height` were the note's base (bitmap) dims for
///   every page, including `ORIENTATION = 1090` — the agreement-over-accuracy
///   posture taken while landscape storage was an open question.
/// - **3** → per-page `width`/`height` are the EFFECTIVE dims (swapped for
///   `1090`), and the SNPG header carries the page's effective dims too. The
///   open question closed: a landscape page's raster is stored natively
///   landscape, so the swapped dims ARE its decode geometry. See *Orientation*
///   at `NoteHeader`.
/// - **4** → the device-rendered COVER rides the parse: `cover_w`/`cover_h`
///   memoize its pixel dims (NULL = no cover, 0 = undecodable) and the bytes
///   land in `thumbs/<blob_md5>` — the `.spd` thumbnail's exact shape, served
///   by the same `/thumbnail/{hash}` route. v3 rows re-derive lazily on their
///   next `ensureIndexed`/repair touch; no sweep.
/// - **5** → the layer panel: the packed `layers` records gain the SNPG v2
///   slot id + `hidden` flag, plus the per-layer display name and `isCurrent`
///   from `LAYERINFO` (variable-stride blob — see `packLayers`). The emit
///   list becomes "LAYERINFO order minus deleted" (hidden layers ride the
///   wire flagged; fallback: the old LAYERSEQ list), and pages are served as
///   SNPG **v2**. v4 rows (9-byte fixed-stride records, v1 wire) re-derive
///   lazily like every bump before them.
/// - **6** → `.txt` segments (`txt_index.zig`): text blobs gain `kind = 1`
///   paragraph rows in `note_page_index`, and this bump exists FOR them — a
///   pre-existing `.txt` sits at v5 and heals on its first listing view,
///   where the ensure path now learns the file NAME (the extension is the
///   derivation gate). The `.note` shape itself is UNCHANGED: notes re-parse
///   once, cheaply, to byte-identical rows — the goldens must not move.
/// - **7** → recognized-text ordering (`recognition.plainText`): the stored
///   page `text` now honors the device's own layout — regions joined with
///   `"\n"` (was a space), stable-sorted by first-placed-word `y`, and a
///   region with no top-level `label` reconstructed from its words instead of
///   dropped. Only the `text` column content changes (raster/SNPG goldens are
///   untouched); notes re-derive it lazily on the next `ensureIndexed`.
/// - **8** → canonical document order (in-doc-search plan): the heal re-mints
///   any holder's segment band a PAST incremental flip left OUT of page order,
///   so `rowid ASC == reading order` for legacy notes too. No stored-column
///   change — the raster/SNPG/text goldens are untouched; the bump only forces
///   `ensureIndexed` to run `recanonicalizeHolders`, a no-op on the already-
///   contiguous bands every note minted since the whole-doc-band re-mint has.
/// - **9** → per-document term set (in-doc-search entry 8b): backfills each
///   note's `doc_terms` (the in-doc fuzzy candidate pool) on the same
///   `recanonicalizeHolders` heal — for a canonical band it writes only the
///   term set, leaving the segments (and their recency) untouched. No
///   stored-column change; the goldens are unmoved.
/// - **10** → the COVER is served ON-DEMAND, streamed from the blob instead of
///   copied into `thumbs/`. `cover_offset`/`cover_length` memoize the cover
///   image block's byte offset + length INSIDE the blob and `cover_mime` its
///   sniffed type; the parse reads only the block's 4-byte length prefix and a
///   small header slice (for dims + MIME), never the whole cover, and NOTHING
///   is written to the thumbs store for a `.note`. This also lifts the cover
///   ceiling from 2 MB (`max_thumbnail_bytes`) to 20 MB (`max_cover_bytes`) —
///   real user-set covers are multi-MB PNGs. `cover_w`/`cover_h` keep their v4
///   meaning. v9 rows re-derive lazily on their next `ensureIndexed`/repair
///   touch (a v9 row has NULL `cover_offset`, so it serves no cover until it
///   heals). The raster/SNPG/text goldens are untouched.
/// - **11** → custom IMAGE templates (docs/scratch/custom-template.md): a page
///   whose custom-style background does NOT decode as RATTA_RLE
///   (`decoder.decodesToExactly`) is a browser-native image. Its background
///   record in the `layers` blob gains a `raster_image` flag (packed bit3),
///   and `note_page_index.bg_hash` records the page's `PAGESTYLEMD5` (NULL
///   otherwise) so `GET /note/{id}/template/{hash}` resolves hash → the byte
///   range already in `layers`. Served pages carry the asset HASH on the SNPG
///   wire (bit2) instead of the image bytes. A note with NO custom-image
///   background re-derives to byte-identical rows — the raster/SNPG/text
///   goldens must not move; only image pages change. v10 rows heal lazily.
// v12: ORIENTATION 1270 (270° landscape) is now recognized as horizontal, so a
// 1270 page's stored EFFECTIVE dims flip to landscape (were wrongly portrait,
// which sheared the decode). Re-derive heals the stored dims for existing notes;
// the SNPG serve path already reads them live, so its geometry fixes on rebuild.
pub const index_version: i64 = 12;

/// Chunk used when hashing a layer's bytes out of a ranged source. Bounds the
/// memory a content hash costs, independent of how large the layer is. Shared
/// with every other blob-byte path — see `blobstore.chunk_len`.
const hash_chunk_len = blobstore.chunk_len;

/// The bounded header window the index reads out of a cover block to sniff its
/// MIME and decode its dimensions — never the whole (multi-MB) block. Covers are
/// device-rendered PNGs (IHDR in the first 24 bytes); this is generous headroom
/// that also catches a JPEG's SOF, and it is the hard bound on the RSS one cover
/// costs at INDEX time (the SERVE path streams the body in `chunk_len` windows).
const cover_header_probe: usize = 64 * 1024;

/// One emitted layer's location + wire facts (slot id, hidden, all_blank).
/// Re-exported from the shared producer so the indexer and
/// `page_payload.serialize` cannot hold differing opinions about which layers a
/// page emits, in what order, with what flags.
pub const LayerRef = sn.page_payload.LayerRef;
pub const max_layers = sn.page_payload.max_layers;

/// One layer as the index stores it: the wire ref plus the panel-only facts
/// (`LAYERINFO` display name, `isCurrentLayer`) that `noteMeta` serves without
/// touching the blob. `name` is empty when the page carries no usable
/// `LAYERINFO` — the fallback emit list has no names to offer.
pub const IndexedLayer = struct {
    ref: LayerRef,
    name: []const u8 = "",
    is_current: bool = false,
};

/// v5 packed record in the `layers` blob — variable stride:
///   u32 offset, u32 length, u8 flags, u8 slot (wire id), u8 name_len,
///   name_len bytes of display name.
/// (v4 and earlier used a fixed 9-byte `offset,length,flags` record; those
/// blobs only exist under stale `index_version` rows, which every reader
/// filters out, so no unpacker ever meets one.)
pub const layer_rec_head_size = 11;
/// Longest display name a packed record can carry; longer names truncate.
/// `name_len` is one byte, and no device name approaches this.
pub const max_layer_name = 255;
pub const max_layer_rec_size = layer_rec_head_size + max_layer_name;

// Packed-record flag bits. bit0/bit1 mirror the SNPG wire flags on purpose
// (same facts); bit2 is index-only panel state; bit3 mirrors the SNPG wire's
// bit2 raster-image fact but sits at bit3 here because bit2 is already taken by
// `current` — `page_payload.recordFlags` maps it back to wire bit2 when serving.
const flag_all_blank: u8 = 0x01;
const flag_hidden: u8 = 0x02;
const flag_current: u8 = 0x04;
const flag_raster_image: u8 = 0x08;

pub const Error = error{
    /// A stored range does not fit the bytes it is being read from — a corrupt
    /// or tampered index row, refused rather than read past EOF.
    BadRange,
    /// The `layers` blob is not a whole number of records, or holds too many.
    BadLayerBlob,
    /// No current index row for this blob (or it is marked unindexable).
    NotIndexed,
};

// ---------------------------------------------------------------------------
// The parsed shape (what gets written)
// ---------------------------------------------------------------------------

pub const NoteRow = struct {
    page_count: u32 = 0,
    signature: ?[]const u8 = null,
    signature_version: u32 = 0,
    equipment: ?[]const u8 = null,
    /// Base (portrait) dimensions (`note.dimensions()`) — a note-level fact.
    /// The SNPG header carries the per-page EFFECTIVE dims from `PageRow`, not
    /// these.
    width: u32 = 0,
    height: u32 = 0,
    /// 0 = RATTA_RLE, 1 = RATTA_RLE X2 (highres grayscale).
    rle_variant: u8 = 0,
    recogn_type: ?[]const u8 = null,
    recogn_language: ?[]const u8 = null,
    recognized_page_count: u32 = 0,
    /// The COVER image's own pixel dims (a landscape note's cover is
    /// 1872×1404). NULL = the source ships no cover (`COVER_0=0` placeholder,
    /// or no COVER key); 0 = a cover is present but `thumbnail.imageDims`
    /// could not decode it (still served — the masonry aspect just falls back).
    /// Mirrors `spd_index.thumb_w/thumb_h` exactly.
    cover_w: ?u32 = null,
    cover_h: ?u32 = null,
    /// WHERE the cover image bytes sit inside the immutable blob — the byte
    /// offset (past the block's 4-byte length prefix) and the byte length — plus
    /// the MIME `thumbnail.sniffMime` recognised them under. The serve path
    /// seeks here and STREAMS `cover_length` bytes straight from the blob, so a
    /// multi-MB cover is never resident. NULL = no cover (kept in lockstep with
    /// `cover_w` NULL). A cover block larger than `thumbnail.max_cover_bytes`
    /// is refused from the length prefix and recorded as no cover. `cover_mime`
    /// is a static string from `sniffMime` (no allocation, no arena borrow).
    cover_offset: ?u64 = null,
    cover_length: ?u32 = null,
    cover_mime: ?[]const u8 = null,
};

pub const PageRow = struct {
    page_index: u32,
    /// Produced by `pageContentHash` — the browser's immutable `?v=` cache key.
    content_hash: [32]u8,
    /// EFFECTIVE dims: the note's base dims with this page's `ORIENTATION`
    /// applied (`Dimensions.oriented` — swapped for `1090`). These are both the
    /// decode geometry the SNPG header advertises and the box `noteMeta` sizes,
    /// because a landscape page's raster is stored natively landscape (v3; v2
    /// stored base dims here while that was unproven).
    width: u32,
    height: u32,
    /// Emit order (LAYERINFO-minus-deleted, fallback LAYERSEQ). Concatenating
    /// these refs' ranges after an SNPG header IS the page; the names/current
    /// flags ride along for `noteMeta`.
    layers: []const IndexedLayer,
    recogn_status: u8 = 0,
    /// md5 of the raw `RECOGNTEXT` block; null unless `recogn_status == 1`.
    text_hash: ?[32]u8 = null,
    recogn_offset: ?u32 = null,
    recogn_length: ?u32 = null,
    /// `recognition.plainText()`; null when the page has no finished text.
    text: ?[]const u8 = null,
    /// The custom IMAGE template's asset hash (`PAGESTYLEMD5`), set only when
    /// the page's background is a browser-native raster image (its `layers`
    /// background record then carries `raster_image`). NULL for blank /
    /// built-in-RLE / no-custom-style pages. The resolve key for
    /// `GET /note/{id}/template/{hash}`.
    bg_hash: ?[]const u8 = null,
};

/// Everything `store` needs, owning its own memory — deliberately free of any
/// borrow from the `.note` bytes, so the (large) buffer can be released before
/// the DB lock is taken.
pub const Parsed = struct {
    arena: std.heap.ArenaAllocator,
    /// False when the blob is not a parseable `.note`. Recorded explicitly (see
    /// `indexable` in the schema) so other file types living in the tree are not
    /// re-parsed on every read forever.
    indexable: bool,
    note: NoteRow,
    pages: []const PageRow,

    pub fn deinit(self: *Parsed) void {
        self.arena.deinit();
    }
};

// ---------------------------------------------------------------------------
// Parse — pure CPU. MUST be called outside the DB lock.
// ---------------------------------------------------------------------------

/// `parseBlobSource` for a caller that already holds the whole file (tests, and
/// any read path still buffering). Identical results, identical cost.
pub fn parseBlob(gpa: Allocator, bytes: []const u8) Allocator.Error!Parsed {
    return parseBlobSource(gpa, sn.Source.fromSlice(bytes));
}

/// Derives the index rows for whatever `src` addresses. Never fails on bad
/// input: anything that does not parse — or that references a range outside the
/// file — comes back as `indexable = false`, which is a recorded fact rather
/// than an error. Only allocation can fail.
///
/// **Nothing here is proportional to the file size.** The parse reads addressed
/// blocks; layer tables cost 4 bytes per layer (`emitLayers`); content hashing
/// streams in `hash_chunk_len` chunks; only the recognition block — KB-scale
/// metadata, and only on finished pages — is ever materialised. So indexing a
/// 40 MB note over a blob source allocates kilobytes, not 40 MB.
pub fn parseBlobSource(gpa: Allocator, src: sn.Source) Allocator.Error!Parsed {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    // `null` == unindexable. Note the arena is only copied into the returned
    // `Parsed` at the very end: an `ArenaAllocator` value snapshots its state, so
    // taking the copy early would strand everything allocated after it.
    const derived: ?struct { note: NoteRow, pages: []const PageRow } = derive: {
        // The Note owns its metadata but reads content lazily through `src`;
        // everything we keep is copied into `arena`.
        var note = sn.parseSource(gpa, src) catch break :derive null;
        defer note.deinit();

        const dims = note.dimensions();
        const pages = try a.alloc(PageRow, note.pages.len);

        var recognized: u32 = 0;
        for (note.pages, 0..) |page, i| {
            // Validates every layer range against the real file length: a corrupt
            // or hostile container fails here, so no stored offset can read past
            // EOF at serve time.
            var refs_buf: [max_layers]LayerRef = undefined;
            const refs = sn.page_payload.emitLayers(note, i, &refs_buf) catch break :derive null;
            for (refs) |r| {
                if (@as(u64, r.offset) + r.len > src.size()) break :derive null;
            }

            // The panel facts ride along: each emitted ref is joined to its
            // LAYERINFO entry (by slot) for the display name + isCurrent. A
            // page without usable LAYERINFO gets empty names — the fallback
            // emit list has none to offer.
            const indexed = try a.alloc(IndexedLayer, refs.len);
            for (refs, indexed) |r, *il| {
                il.* = .{ .ref = r };
                if (page.infoForSlot(r.slot)) |info| {
                    const cap = @min(info.name.len, max_layer_name);
                    il.name = try a.dupe(u8, info.name[0..cap]);
                    il.is_current = info.is_current;
                }
            }

            // EFFECTIVE dims: swapped for a 1090 page, whose raster is stored
            // natively landscape — see the *Orientation* note above `noteHeader`.
            const eff = dims.oriented(page.orientation());

            // Custom IMAGE template: a page with a custom style
            // (`PAGESTYLEMD5 != "0"`, not `style_white`) whose background block
            // does NOT decode as RATTA_RLE is a browser-native image. Stream the
            // background block through the RLE totalizer (bounded RSS — one
            // chunk, never the whole image) and, when it fails to total the
            // page's pixels, mark the background record `raster_image` (bit3 in
            // the packed blob → SNPG wire bit2) and record its `PAGESTYLEMD5` in
            // `bg_hash` — the `/template/{hash}` resolve key. Built-in RLE
            // templates pass the gate too but classify as RLE (cheap KB read).
            var bg_hash: ?[]const u8 = null;
            if (page.hasCustomStyle()) {
                const expected_px: u64 = @as(u64, eff.width) * eff.height;
                for (indexed) |*il| {
                    if (il.ref.slot != .background) continue;
                    if (backgroundIsImage(src, il.ref.offset, il.ref.len, expected_px)) {
                        il.ref.raster_image = true;
                        if (page.styleMd5()) |md5| bg_hash = try a.dupe(u8, md5);
                    }
                    break;
                }
            }

            var row: PageRow = .{
                .page_index = @intCast(i),
                .content_hash = pageContentHash(src, page) catch break :derive null,
                .width = eff.width,
                .height = eff.height,
                .layers = indexed,
                .recogn_status = page.recognitionStatus(),
                .bg_hash = bg_hash,
            };

            // Recognition: keep both the plain transcript (search) and the raw
            // range (for lazily re-reading elements + bounding boxes when
            // highlight-in-place on the canvas is wanted).
            const addr = page.recognitionAddress();
            if (row.recogn_status == 1 and addr != 0) {
                // The one thing that IS materialised — deliberately. It is
                // KB-scale text metadata, and both the md5 and the JSON decode
                // need it contiguous. Freed before the next page.
                const held = src.blockHeld(gpa, addr) catch break :derive null;
                defer held.deinit(gpa);
                const content = held.bytes;
                row.recogn_offset = @intCast(addr + 4);
                row.recogn_length = @intCast(content.len);
                row.text_hash = md5Hex(content);
                recognized += 1;

                if (sn.recognition.parse(gpa, content)) |parsed_rec| {
                    var rec = parsed_rec;
                    defer rec.deinit();
                    const plain = try rec.plainText(gpa);
                    defer gpa.free(plain);
                    row.text = try a.dupe(u8, plain);
                } else |_| {} // undecodable RECOGNTEXT: keep the range, drop the text
            }
            pages[i] = row;
        }

        // The device-rendered cover, riding the footer this parse already holds
        // (newest-wins `COVER_3`/`COVER_2`/`COVER_1` — see the parser). We RECORD
        // where it lives (offset + length) and its MIME rather than extract its
        // bytes: the serve path streams those bytes straight from the immutable
        // blob, so nothing multi-MB is ever resident. Best-effort and bounded —
        // an absent, oversized (`thumbnail.max_cover_bytes`, checked from the
        // 4-byte length prefix BEFORE any body read), unreadable, or
        // unrecognizable cover block is "no cover", never a failed index. NULL
        // vs 0 is the dims column contract: a cover whose dims cannot be decoded
        // records 0, never NULL, and is still served.
        var cover_offset: ?u64 = null;
        var cover_length: ?u32 = null;
        var cover_mime: ?[]const u8 = null;
        var cover_w: ?u32 = null;
        var cover_h: ?u32 = null;
        cover_blk: {
            const addr = note.coverAddress() orelse break :cover_blk;
            const range = src.blockRange(addr) catch break :cover_blk; // prefix only
            if (range.len == 0 or range.len > thumbnail.max_cover_bytes) break :cover_blk;
            // A bounded header window is all the sniff + dims need; the body is
            // never materialised here (nor a `max_cover_bytes` buffer).
            const head_len: usize = @intCast(@min(@as(u64, range.len), cover_header_probe));
            const head = try gpa.alloc(u8, head_len);
            defer gpa.free(head);
            src.read(range.offset, head) catch break :cover_blk;
            const mime = thumbnail.sniffMime(head) orelse break :cover_blk;
            if (thumbnail.imageDims(head)) |dm| {
                cover_w = dm.w;
                cover_h = dm.h;
            } else {
                cover_w = 0;
                cover_h = 0;
            }
            cover_offset = range.offset;
            cover_length = range.len;
            cover_mime = mime;
        }

        break :derive .{
            .note = .{
                .page_count = @intCast(note.pages.len),
                .signature = try a.dupe(u8, note.signature.raw),
                .signature_version = note.signature.version,
                .equipment = try dupeOpt(a, note.applyEquipment()),
                .width = dims.width,
                .height = dims.height,
                .rle_variant = @intFromEnum(sn.page_payload.variantOf(note)),
                .recogn_type = try dupeOpt(a, note.header.get("FILE_RECOGN_TYPE")),
                .recogn_language = try dupeOpt(a, note.header.get("FILE_RECOGN_LANGUAGE")),
                .recognized_page_count = recognized,
                .cover_w = cover_w,
                .cover_h = cover_h,
                .cover_offset = cover_offset,
                .cover_length = cover_length,
                .cover_mime = cover_mime,
            },
            .pages = pages,
        };
    };

    const d = derived orelse {
        _ = arena.reset(.free_all); // drop whatever a partial pass allocated
        return .{ .arena = arena, .indexable = false, .note = .{}, .pages = &.{} };
    };
    return .{ .arena = arena, .indexable = true, .note = d.note, .pages = d.pages };
}

fn dupeOpt(a: Allocator, v: ?[]const u8) Allocator.Error!?[]const u8 {
    return if (v) |s| try a.dupe(u8, s) else null;
}

/// A page's content hash: md5 over its present layers' bitmap bytes (the pixels'
/// source). Stable per rendered content; changes only when that page changes.
/// Falls back to hashing the page's metadata entries if it has no layer bitmaps.
///
/// This is the browser's immutable `?v=` cache key. It lives here, and the
/// control-plane face calls THIS function, because computing it even slightly
/// differently in the two places would invalidate every cached page URL.
///
/// Reads through `src` in bounded chunks, so hashing a multi-MB layer costs
/// `hash_chunk_len` bytes. An out-of-range address is skipped exactly as before
/// (`catch continue` on `blockRange`); a genuine I/O failure mid-layer is
/// propagated rather than silently yielding a half-hashed value, because that
/// value would otherwise be stored as a real cache key.
pub fn pageContentHash(src: sn.Source, page: sn.types.Page) sn.source.Error![32]u8 {
    var hasher = Md5.init(.{});
    var any = false;
    var chunk: [hash_chunk_len]u8 = undefined;
    for (page.layers) |layer| {
        const addr = layer.bitmapAddress();
        if (addr == 0) continue;
        const range = src.blockRange(addr) catch continue;
        try src.hashRange(&hasher, range.offset, range.len, &chunk);
        any = true;
    }
    if (!any) {
        for (page.block.entries) |e| {
            hasher.update(e.key);
            hasher.update(e.value);
        }
    }
    var digest: [Md5.digest_length]u8 = undefined;
    hasher.final(&digest);
    var hex: [32]u8 = undefined;
    hexEncode(&hex, &digest);
    return hex;
}

/// True when the background block at `[offset, offset+len)` does NOT decode as a
/// RATTA_RLE stream of exactly `expected_pixels` — i.e. it is a browser-native
/// image template. Streams the block through `decoder.RleTotalizer` in
/// `hash_chunk_len` windows and bails the moment the total overflows, so
/// classifying a multi-MB image costs one chunk of RSS and reads only its
/// leading pairs, never the whole file. A read error is treated as "not an
/// image" (leave it RLE) — the caller already validated the range in-bounds, so
/// this is purely defensive. Only ever called on a custom-style page's
/// background (the gate), so `all_blank` is false — matching `decodesToExactly`.
fn backgroundIsImage(src: sn.Source, offset: u32, len: u32, expected_pixels: u64) bool {
    var t = sn.decoder.RleTotalizer.init(expected_pixels);
    var chunk: [hash_chunk_len]u8 = undefined;
    var off: u64 = offset;
    var left: u64 = len;
    while (left > 0) {
        const n: usize = @intCast(@min(left, @as(u64, chunk.len)));
        src.read(off, chunk[0..n]) catch return false;
        t.feed(chunk[0..n]);
        if (t.overflow) return true; // already past the page's pixels — an image
        off += n;
        left -= n;
    }
    return !t.done();
}

fn md5Hex(data: []const u8) [32]u8 {
    var digest: [Md5.digest_length]u8 = undefined;
    Md5.hash(data, &digest, .{});
    var hex: [32]u8 = undefined;
    hexEncode(&hex, &digest);
    return hex;
}

fn hexEncode(out: []u8, bytes: []const u8) void {
    const hex = "0123456789abcdef";
    for (bytes, 0..) |b, i| {
        out[2 * i] = hex[b >> 4];
        out[2 * i + 1] = hex[b & 0x0f];
    }
}

// ---------------------------------------------------------------------------
// Layer packing
// ---------------------------------------------------------------------------

/// Packs `layers` into the variable-stride v5 `layers` blob (see
/// `layer_rec_head_size` for the record layout). Order is the emit order and
/// is load-bearing: serving a page replays it verbatim. Names longer than
/// `max_layer_name` are truncated.
pub fn packLayers(buf: []u8, layers: []const IndexedLayer) []u8 {
    var at: usize = 0;
    for (layers) |il| {
        const name = il.name[0..@min(il.name.len, max_layer_name)];
        std.debug.assert(buf.len >= at + layer_rec_head_size + name.len);
        const rec = buf[at..];
        std.mem.writeInt(u32, rec[0..4], il.ref.offset, .little);
        std.mem.writeInt(u32, rec[4..8], il.ref.len, .little);
        var flags: u8 = 0;
        if (il.ref.all_blank) flags |= flag_all_blank;
        if (il.ref.hidden) flags |= flag_hidden;
        if (il.is_current) flags |= flag_current;
        if (il.ref.raster_image) flags |= flag_raster_image;
        rec[8] = flags;
        rec[9] = il.ref.slot.wireId();
        rec[10] = @intCast(name.len);
        @memcpy(rec[layer_rec_head_size..][0..name.len], name);
        at += layer_rec_head_size + name.len;
    }
    return buf[0..at];
}

/// One record read back out of a packed blob. `name` BORROWS the blob (SQLite
/// statement memory on the read paths) — dupe it before the statement dies.
pub const LayerRecord = struct {
    ref: LayerRef,
    name: []const u8,
    is_current: bool,
};

/// Inverse of `packLayers`. Rejects a malformed blob (short record, trailing
/// bytes, too many records, an unknown slot id) rather than trusting it —
/// stale-format blobs only exist under stale `index_version` rows, which every
/// reader filters out before unpacking.
pub fn unpackLayerRecords(blob: []const u8, buf: *[max_layers]LayerRecord) Error![]const LayerRecord {
    var at: usize = 0;
    var n: usize = 0;
    while (at < blob.len) {
        if (n >= max_layers) return error.BadLayerBlob;
        if (blob.len - at < layer_rec_head_size) return error.BadLayerBlob;
        const rec = blob[at..];
        const name_len: usize = rec[10];
        if (blob.len - at < layer_rec_head_size + name_len) return error.BadLayerBlob;
        const flags = rec[8];
        buf[n] = .{
            .ref = .{
                .offset = std.mem.readInt(u32, rec[0..4], .little),
                .len = std.mem.readInt(u32, rec[4..8], .little),
                .slot = sn.types.LayerSlot.fromWireId(rec[9]) orelse return error.BadLayerBlob,
                .all_blank = flags & flag_all_blank != 0,
                .hidden = flags & flag_hidden != 0,
                .raster_image = flags & flag_raster_image != 0,
            },
            .name = rec[layer_rec_head_size..][0..name_len],
            .is_current = flags & flag_current != 0,
        };
        at += layer_rec_head_size + name_len;
        n += 1;
    }
    return buf[0..n];
}

/// The serving-path view of a packed blob: just the wire refs, no names.
pub fn unpackLayers(blob: []const u8, buf: *[max_layers]LayerRef) Error![]const LayerRef {
    var recs: [max_layers]LayerRecord = undefined;
    const rs = try unpackLayerRecords(blob, &recs);
    for (rs, 0..) |r, i| buf[i] = r.ref;
    return buf[0..rs.len];
}

// ---------------------------------------------------------------------------
// Write — inside the caller's transaction.
// ---------------------------------------------------------------------------

const upsert_note_sql =
    \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, signature,
    \\                       signature_version, equipment, width, height, rle_variant,
    \\                       recogn_type, recogn_language, recognized_page_count, indexed_at,
    \\                       cover_w, cover_h, cover_offset, cover_length, cover_mime)
    \\VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
    \\ON CONFLICT(blob_md5) DO UPDATE SET
    \\  index_version=excluded.index_version, indexable=excluded.indexable,
    \\  page_count=excluded.page_count, signature=excluded.signature,
    \\  signature_version=excluded.signature_version, equipment=excluded.equipment,
    \\  width=excluded.width, height=excluded.height, rle_variant=excluded.rle_variant,
    \\  recogn_type=excluded.recogn_type, recogn_language=excluded.recogn_language,
    \\  recognized_page_count=excluded.recognized_page_count, indexed_at=excluded.indexed_at,
    \\  cover_w=excluded.cover_w, cover_h=excluded.cover_h,
    \\  cover_offset=excluded.cover_offset, cover_length=excluded.cover_length,
    \\  cover_mime=excluded.cover_mime;
;

const upsert_page_sql =
    \\INSERT INTO note_page_index(blob_md5, page_index, content_hash, width, height, layers,
    \\                            recogn_status, text_hash, recogn_offset, recogn_length, text, bg_hash)
    \\VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
    \\ON CONFLICT(blob_md5, page_index) DO UPDATE SET
    \\  content_hash=excluded.content_hash, width=excluded.width, height=excluded.height,
    \\  layers=excluded.layers, recogn_status=excluded.recogn_status,
    \\  text_hash=excluded.text_hash, recogn_offset=excluded.recogn_offset,
    \\  recogn_length=excluded.recogn_length, text=excluded.text, bg_hash=excluded.bg_hash;
;

/// The one format-specific write `reconcilePage` hands the note adapter: the
/// page-row upsert (raster geometry, layers, the recognition columns the search
/// engine knows nothing about). `ordinal` is the page index the driver diffed
/// on, bound as `page_index`.
const PageUpsert = struct {
    blob_md5: []const u8,
    page: PageRow,
    buf: []u8,
    pub fn upsert(self: @This(), db: sqlite.Db, ordinal: i64) !void {
        var s = try db.prepare(upsert_page_sql);
        defer s.finalize();
        s.bindText(1, self.blob_md5);
        s.bindInt(2, ordinal);
        s.bindText(3, &self.page.content_hash);
        s.bindInt(4, self.page.width);
        s.bindInt(5, self.page.height);
        s.bindBlob(6, packLayers(self.buf, self.page.layers));
        s.bindInt(7, self.page.recogn_status);
        if (self.page.text_hash) |*h| s.bindText(8, h) else s.bindNull(8);
        s.bindIntOpt(9, if (self.page.recogn_offset) |v| @intCast(v) else null);
        s.bindIntOpt(10, if (self.page.recogn_length) |v| @intCast(v) else null);
        s.bindTextOpt(11, self.page.text);
        s.bindTextOpt(12, self.page.bg_hash);
        _ = try s.step();
    }
};

/// Writes `p`'s rows for `blob_md5`. Call inside the caller's transaction (the
/// `blobs` row must already exist — the FK is what ties index lifetime to blob
/// lifetime). Upserts throughout, so two racing parses of the same blob are
/// wasteful but never a constraint violation, and a page row keeps its `id`
/// across a re-index — no longer because the id is the FTS `content_rowid`
/// (it is not; `segment_search.id` is), but because `segment_search.segment_id`
/// REFERENCES it.
///
/// This IS the "re-parse of the SAME blob" search path (search-architecture.md
/// step 2): segment rows and their masked rowids — the owners' recency — are
/// untouched. The stored text is DIFFED per page, and only a page whose text
/// actually changed refreshes its postings, IN PLACE ('delete' old before the
/// row is rewritten, insert new after, at the same segment rowids, for every
/// partition holding the blob). On first ingest there are no segment rows yet
/// (the owner's are minted by `linkBlobIndexed` once the `files` row exists),
/// so every per-page search call here is a no-op then.
pub fn store(db: sqlite.Db, blob_md5: []const u8, p: Parsed, now: i64) !void {
    {
        var s = try db.prepare(upsert_note_sql);
        defer s.finalize();
        s.bindText(1, blob_md5);
        s.bindInt(2, index_version);
        s.bindInt(3, if (p.indexable) 1 else 0);
        s.bindInt(4, p.note.page_count);
        s.bindTextOpt(5, p.note.signature);
        s.bindInt(6, p.note.signature_version);
        s.bindTextOpt(7, p.note.equipment);
        s.bindInt(8, p.note.width);
        s.bindInt(9, p.note.height);
        s.bindInt(10, p.note.rle_variant);
        s.bindTextOpt(11, p.note.recogn_type);
        s.bindTextOpt(12, p.note.recogn_language);
        s.bindInt(13, p.note.recognized_page_count);
        s.bindInt(14, now);
        s.bindIntOpt(15, if (p.note.cover_w) |v| @as(i64, v) else null);
        s.bindIntOpt(16, if (p.note.cover_h) |v| @as(i64, v) else null);
        s.bindIntOpt(17, if (p.note.cover_offset) |v| @as(i64, @intCast(v)) else null);
        s.bindIntOpt(18, if (p.note.cover_length) |v| @as(i64, v) else null);
        s.bindTextOpt(19, p.note.cover_mime);
        _ = try s.step();
    }

    var layer_buf: [max_layers * max_layer_rec_size]u8 = undefined;
    for (p.pages) |page| {
        // The per-page re-derive discipline (diff the stored text, refresh
        // postings in place or mint a fresh rowid) lives once in
        // `search.reconcilePage`; the adapter hands it only the new text to diff
        // on and the page-row upsert.
        try search.reconcilePage(db, blob_md5, page.page_index, page.text orelse "", now, PageUpsert{
            .blob_md5 = blob_md5,
            .page = page,
            .buf = &layer_buf,
        });
    }

    // A re-index at a new `index_version` could in principle yield fewer pages;
    // drop any tail left over from the previous shape — every owner's segment
    // rows for it first (postings while the text still resolves, then the rows,
    // then the pages; the segment FK makes any other order a loud error).
    try search.dropTailSearch(db, blob_md5, p.note.page_count);
    {
        var s = try db.prepare("DELETE FROM note_page_index WHERE blob_md5 = ?1 AND page_index >= ?2;");
        defer s.finalize();
        s.bindText(1, blob_md5);
        s.bindInt(2, p.note.page_count);
        _ = try s.step();
    }
}

/// True when this blob already has an index row at the CURRENT version — the
/// cheap gate that keeps re-ingest and the lazy read path from re-parsing, and
/// that makes the unindexable marker stick instead of retrying forever.
pub fn isCurrent(db: sqlite.Db, blob_md5: []const u8) !bool {
    var s = try db.prepare("SELECT 1 FROM note_index WHERE blob_md5 = ?1 AND index_version = ?2;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, index_version);
    return try s.step();
}

/// The no-retry repair gate for the `.note` COVER — `spd_index.needsRepair`'s
/// analogue, consulted by the `/thumbnail/{hash}` serve path when the blob's own
/// magic says `.note` (see `Files.thumbNeedsRepair`). A `.note` cover is served
/// on-demand STREAMED from the immutable blob (v10), so — unlike the `.spd`
/// thumbnail — there is NO derived `thumbs/` file that can go missing. The only
/// thing a serve needs is the cover's recorded location, and that lives in the
/// index row; so the only repair reason is a missing or stale row:
///   - no row at the current `index_version` (missing, or stale after a bump —
///     a v9-or-earlier row lands here, which is how each bump heals lazily) →
///     re-parse to populate `cover_offset`/`cover_length`/`cover_mime`.
/// False otherwise — INCLUDING a current row saying "no cover"
/// (`cover_offset IS NULL`): the row is the memo, so a coverless note costs its
/// parse once (not every gallery load) and a covered note serves straight from
/// the row with no re-derive. `thumbs` is unused (kept for signature parity with
/// `spd_index.needsRepair`, which the shared `Files` dispatch also calls).
pub fn needsRepair(db: sqlite.Db, thumbs: thumbstore.ThumbStore, md5: []const u8) !bool {
    _ = thumbs; // notes stream from the blob — no derived file to check for
    return !(try isCurrent(db, md5));
}

/// The longest MIME string a cover column holds — `thumbnail.sniffMime` returns
/// only `image/jpeg`|`image/png`|`image/webp`|`image/gif`, all ≤ 10 bytes.
pub const max_cover_mime_len = 16;

/// Where a `.note` cover's bytes sit inside its blob, plus how to label them —
/// the streaming serve path's entire plan, read from the index in ONE row and
/// then usable with no further DB access. `mime` is copied INLINE because
/// SQLite statement memory dies with the query, so a `CoverLocation` value is
/// fully self-contained (no borrow to outlive the connection).
pub const CoverLocation = struct {
    offset: u64,
    length: u64,
    mime_buf: [max_cover_mime_len]u8 = undefined,
    mime_len: u8 = 0,

    pub fn mime(self: *const CoverLocation) []const u8 {
        return self.mime_buf[0..self.mime_len];
    }
};

/// The recorded cover location for `md5`, or null when the note ships no cover
/// — the `/thumbnail` serve path's lookup for a `.note` (`Files.noteCover`).
/// Reads ONLY the current-`index_version` row (a stale row is "no cover", so a
/// serve never streams from an offset a bump may have invalidated). The length
/// is re-checked against `thumbnail.max_cover_bytes` at this edge: a row is
/// content-keyed and immutable, but the ceiling is enforced where the bytes are
/// about to be read, never trusted blindly. A row with an offset but a NULL/
/// oversized length or NULL MIME is treated as no cover rather than served
/// wrong.
pub fn coverLocation(db: sqlite.Db, md5: []const u8) !?CoverLocation {
    var s = try db.prepare(
        "SELECT cover_offset, cover_length, cover_mime FROM note_index " ++
            "WHERE blob_md5 = ?1 AND index_version = ?2;",
    );
    defer s.finalize();
    s.bindText(1, md5);
    s.bindInt(2, index_version);
    if (!try s.step()) return null;
    if (s.columnIsNull(0) or s.columnIsNull(1) or s.columnIsNull(2)) return null; // no cover
    const offset: u64 = @intCast(s.columnInt(0));
    const length: u64 = @intCast(s.columnInt(1));
    if (length == 0 or length > thumbnail.max_cover_bytes) return null;
    const mime = s.columnText(2);
    if (mime.len == 0 or mime.len > max_cover_mime_len) return null;
    var loc: CoverLocation = .{ .offset = offset, .length = length };
    @memcpy(loc.mime_buf[0..mime.len], mime);
    loc.mime_len = @intCast(mime.len);
    return loc;
}

/// Drops a blob's index rows. Called from the blob GC path *inside its
/// transaction*; the schema's ON DELETE CASCADE is the structural backstop, this
/// is the explicit statement of intent (and works with FKs off).
pub fn deleteForBlob(db: sqlite.Db, blob_md5: []const u8) !void {
    {
        // Backstop only: at refcount 0 every owner has already dropped their
        // segment rows (and `decref` ran the FTS 'delete' pass just before
        // this), so this normally deletes nothing — but a row a bug left
        // behind must not trip the `segment_search.segment_id` FK below.
        var s = try db.prepare(
            "DELETE FROM segment_search WHERE segment_id IN " ++
                "(SELECT id FROM note_page_index WHERE blob_md5 = ?1);",
        );
        defer s.finalize();
        s.bindText(1, blob_md5);
        _ = try s.step();
    }
    {
        var s = try db.prepare("DELETE FROM note_page_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, blob_md5);
        _ = try s.step();
    }
    var s = try db.prepare("DELETE FROM note_index WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    _ = try s.step();
}

// ---------------------------------------------------------------------------
// Parsing a stored blob (ranged reads — no whole-file buffer)
// ---------------------------------------------------------------------------

/// Parses a stored blob into index rows, WITHOUT touching the database. This is
/// the "parse first, unlocked" half; hand the result to `store` inside the
/// transaction. Null when the blob is not on disk.
///
/// **Never buffers the note.** It reads through `BlobSource`, i.e. positional
/// `readRange` calls for the addresses the container itself names, so a device
/// syncing a 40 MB note no longer costs 40 MB of RSS in `upload/finish` — the
/// one flow that used to stream end to end and regressed when indexing landed.
/// `io` is unused (the blob store carries its own) and is kept so the call
/// sites, which thread it everywhere, do not have to change.
pub fn parseStoredBlob(gpa: Allocator, io: std.Io, blobs: blobstore.BlobStore, md5: []const u8) !?Parsed {
    _ = io;
    var bs = blob_source.BlobSource.init(blobs, md5) catch return null;
    return try parseBlobSource(gpa, bs.source());
}

/// Lazy backfill, for read paths: a no-op when the blob is already indexed at
/// the current version, otherwise parse (unlocked) and write (in a transaction).
/// This is what makes the index self-healing — pre-existing blobs, uploads whose
/// eager index failed, and `index_version` bumps all repair themselves on first
/// read, so no backfill migration is ever required.
///
/// Safe to race: the write is an upsert, so a concurrent duplicate parse costs
/// CPU and nothing else.
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
    // Canonical-order heal (index_version 8): retire any legacy edit-scatter in
    // a holder's band so `rowid ASC == page order`. A no-op on bands already
    // contiguous — every note minted since the whole-doc-band re-mint.
    try search.recanonicalizeHolders(db, md5, now);
    try db.exec("COMMIT;");
}

// ---------------------------------------------------------------------------
// Serving a page FROM the index
// ---------------------------------------------------------------------------

/// Supplies a layer's bytes given a stored `(offset, length)` out of a whole-blob
/// slice. The buffering source for `serializeFromIndex`; serving uses `streamPage`,
/// which reads windows through `BlobStore.readRange` and buffers nothing.
pub const SliceSource = struct {
    bytes: []const u8,

    pub fn read(self: SliceSource, offset: u32, len: u32) Error![]const u8 {
        if (@as(u64, offset) + len > self.bytes.len) return error.BadRange;
        return self.bytes[offset..][0..len];
    }
};

/// The note-level facts an SNPG header needs, straight from `note_index`.
/// `width`/`height` are the note's BASE (portrait) dims; the header's decode
/// geometry comes from the per-page row instead — see *Orientation* below.
///
/// ## Orientation: SETTLED — effective dims everywhere
///
/// A page with `ORIENTATION = 1090` (landscape) has its RATTA_RLE raster stored
/// **natively landscape**: the same flat byte stream, but the true row width is
/// the swapped base width (1872 on a Nomad). No longer an open question —
/// settled from both directions:
///
///  - **empirically**, on a real Nomad capture (`horizontal_layers.note`:
///    2 pages, both `1090`, 4 ink layers on page 2), which decodes coherently
///    at 1872-wide rows and shears at 1404;
///  - **against the reference**: supernote-tool v0.7.1 swaps width/height
///    before decoding (`decoder.py:138-139`) and renders natively landscape,
///    never rotating (see note-format.md §9.3).
///
/// The decision that follows: **effective dims everywhere.** `parseBlobSource`
/// stores each page's dims with the orientation applied
/// (`types.Dimensions.oriented` — the parser library's single copy of the swap
/// fact), `pagePlan` writes those same per-page dims into the SNPG header (the
/// wasm decoder's geometry), and `noteMeta` advertises them for the page box.
/// All three read the same stored value, so the payload and the box can never
/// describe different rectangles — the invariant v2 protected — and the
/// rectangle is now also the RIGHT one for a landscape page, which v2's base
/// dims were not (they sheared: a flat RLE stream decoded at the wrong width
/// fails silently, not loudly).
///
/// v1 swapped the stored dims but left the payload header unswapped — a
/// guaranteed distortion. v2 stored base dims in both places — agreement, at
/// the cost of shearing real landscape pages. v3 stores effective dims in both
/// places: agreement AND accuracy.
pub const NoteHeader = struct { width: u32, height: u32, rle_variant: u8, page_count: u32 };

pub fn noteHeader(db: sqlite.Db, blob_md5: []const u8) !?NoteHeader {
    var s = try db.prepare(
        "SELECT width, height, rle_variant, page_count FROM note_index " ++
            "WHERE blob_md5 = ?1 AND indexable = 1 AND index_version = ?2;",
    );
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, index_version);
    if (!try s.step()) return null;
    return .{
        .width = @intCast(s.columnInt(0)),
        .height = @intCast(s.columnInt(1)),
        .rle_variant = @intCast(s.columnInt(2)),
        .page_count = @intCast(s.columnInt(3)),
    };
}

/// Everything needed to emit one page's SNPG payload, resolved from index rows
/// in ONE place and then usable with **no further database access**.
///
/// It is deliberately a plain value with inline storage (no allocation, no
/// borrowed slices): the page route is `manual_db_lock`, so the plan is built
/// inside a narrow lock window and the bytes are streamed with the lock
/// released. Anything borrowed from SQLite statement memory would be a
/// use-after-free the moment the connection served the next query.
///
/// Two facts the index hands over for free, both of which the HTTP layer uses:
///
///  - `content_length` is exact and costs no file I/O — `20 + Σ (5 + len)` — so
///    a streamed page still gets a precise `Content-Length` rather than chunked
///    transfer encoding.
///  - `content_hash` is the stored `?v=` / `ETag` value, so version checking and
///    cache validation also touch no file.
/// The longest asset hash a page carries on the wire — `PAGESTYLEMD5` is a
/// 32-hex md5; this is generous headroom and a hard bound on the inline buffer.
pub const max_bg_hash: usize = 64;

pub const PagePlan = struct {
    /// The finished 20-byte SNPG header, ready to write.
    header: [sn.page_payload.HEADER_SIZE]u8,
    layer_buf: [max_layers]LayerRef,
    layer_count: u8,
    /// The page's content md5 (hex): the `?v=` version and the `ETag`.
    content_hash: [32]u8,
    /// Exact payload size in bytes.
    content_length: u64,
    /// The custom IMAGE background's asset hash — what the `raster_image`
    /// record carries as its data ON THE WIRE (instead of the image bytes), so
    /// the page payload stays small and the browser fetches the asset once. Set
    /// only when a layer is `raster_image`; empty otherwise.
    bg_hash_buf: [max_bg_hash]u8 = undefined,
    bg_hash_len: u8 = 0,

    pub fn layers(self: *const PagePlan) []const LayerRef {
        return self.layer_buf[0..self.layer_count];
    }

    pub fn bgHash(self: *const PagePlan) []const u8 {
        return self.bg_hash_buf[0..self.bg_hash_len];
    }

    /// A record's DATA length on the wire: the asset-hash length for a
    /// `raster_image` background, the RLE byte length for every other layer.
    pub fn wireLen(self: *const PagePlan, r: LayerRef) u64 {
        return if (r.raster_image) self.bg_hash_len else r.len;
    }
};

/// Resolves page `page_index` of `blob_md5` into a `PagePlan`. **This is the only
/// part of page serving that touches the database.** Null when the blob has no
/// current index row (not a `.note`, or unindexable) or the page is out of range.
pub fn pagePlan(db: sqlite.Db, blob_md5: []const u8, page_index: u64) !?PagePlan {
    const head = (try noteHeader(db, blob_md5)) orelse return null;

    var plan: PagePlan = .{
        .header = undefined,
        .layer_buf = undefined,
        .layer_count = 0,
        .content_hash = undefined,
        .content_length = sn.page_payload.HEADER_SIZE,
    };

    // The page row carries the EFFECTIVE dims — the decode geometry a landscape
    // page's natively-landscape stream requires (see *Orientation* at
    // `NoteHeader`); the note-level row contributes only the RLE variant here.
    var page_dims: [2]u32 = undefined;
    const refs = blk: {
        var s = try db.prepare(
            "SELECT layers, content_hash, width, height, bg_hash FROM note_page_index " ++
                "WHERE blob_md5 = ?1 AND page_index = ?2;",
        );
        defer s.finalize();
        s.bindText(1, blob_md5);
        s.bindInt(2, @intCast(page_index));
        if (!try s.step()) return null;
        const refs = try unpackLayers(s.columnBlob(0), &plan.layer_buf);
        const hash = s.columnText(1);
        if (hash.len != plan.content_hash.len) return error.NotIndexed;
        @memcpy(&plan.content_hash, hash); // copied out: the statement dies below
        page_dims = .{ @intCast(s.columnInt(2)), @intCast(s.columnInt(3)) };
        // The asset hash a `raster_image` background carries on the wire. Copied
        // INLINE (statement memory dies at the `defer`), bounded by max_bg_hash.
        if (!s.columnIsNull(4)) {
            const bg = s.columnText(4);
            if (bg.len > 0 and bg.len <= max_bg_hash) {
                @memcpy(plan.bg_hash_buf[0..bg.len], bg);
                plan.bg_hash_len = @intCast(bg.len);
            }
        }
        break :blk refs;
    };

    plan.layer_count = @intCast(refs.len);
    for (refs) |r| plan.content_length += sn.page_payload.LAYER_HEADER_SIZE + plan.wireLen(r);
    writeSnpgHeader(&plan.header, head.rle_variant, page_dims[0], page_dims[1], @intCast(refs.len));
    return plan;
}

/// Where a custom IMAGE template's bytes sit inside the immutable blob, resolved
/// by asset `hash` — the `GET /note/{id}/template/{hash}` serve path's entire DB
/// question, answered in ONE row with no `.note` parse. Every page that shares a
/// template references the SAME background block, so all their `layers` records
/// carry the IDENTICAL `(offset, length)`; `LIMIT 1` is therefore exact, not
/// arbitrary, and the hash in the URL guarantees the bytes cannot change. Null
/// when no page of this blob has an image background under that hash (a foreign
/// or absent template — the handler 404s it, indistinguishable from unowned).
pub const TemplateLocation = struct { offset: u64, length: u64 };

pub fn templateLocation(db: sqlite.Db, blob_md5: []const u8, hash: []const u8) !?TemplateLocation {
    var s = try db.prepare(
        "SELECT layers FROM note_page_index WHERE blob_md5 = ?1 AND bg_hash = ?2 LIMIT 1;",
    );
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindText(2, hash);
    if (!try s.step()) return null;
    var buf: [max_layers]LayerRef = undefined;
    const refs = unpackLayers(s.columnBlob(0), &buf) catch return null;
    for (refs) |r| {
        if (r.raster_image) return .{ .offset = r.offset, .length = @intCast(r.len) };
    }
    return null;
}

/// The SNPG header, built from stored columns — the variant from the note-level
/// row, `width`/`height` from the PAGE row (effective dims). The single place
/// the payload's leading 20 bytes are produced — `serializeFromIndex` and the
/// streamed serve path both come through here, so they cannot drift.
fn writeSnpgHeader(
    out: *[sn.page_payload.HEADER_SIZE]u8,
    rle_variant: u8,
    width: u32,
    height: u32,
    layer_count: u32,
) void {
    const pp = sn.page_payload;
    @memcpy(out[0..4], pp.MAGIC);
    out[4] = pp.VERSION;
    out[5] = rle_variant;
    out[6] = 0; // reserved
    out[7] = 0;
    std.mem.writeInt(u32, out[8..12], width, .little);
    std.mem.writeInt(u32, out[12..16], height, .little);
    std.mem.writeInt(u32, out[16..20], layer_count, .little);
}

/// One layer record's 6-byte SNPG v2 head (flags + slot + length). Flags come
/// from `page_payload.recordFlags` — the one place the wire bits are written.
/// `wire_len` is the record's DATA length on the wire: `r.len` for an RLE
/// layer, the asset-hash length for a `raster_image` background (whose data is
/// the hash, not the image bytes).
fn layerHead(r: LayerRef, wire_len: u64) [sn.page_payload.LAYER_HEADER_SIZE]u8 {
    var h: [sn.page_payload.LAYER_HEADER_SIZE]u8 = undefined;
    h[0] = sn.page_payload.recordFlags(r);
    h[1] = r.slot.wireId();
    std.mem.writeInt(u32, h[2..6], @intCast(wire_len), .little);
    return h;
}

/// **Streams** page `plan`'s SNPG payload to `out`, reading each layer's bytes
/// straight out of the blob in `blobstore.chunk_len` windows.
///
/// This is what makes the memory claim unqualified: the server never materialises
/// the payload, so peak memory here is one chunk regardless of how large the page
/// or the containing note is. Exactly `plan.content_length` bytes are written.
///
/// DB-FREE by contract — the caller runs it with the DB lock released. Every
/// range came from an untrusted device's own metadata, so `readRange` re-validates
/// it against the blob's real on-disk size on every window.
pub fn streamPage(
    blobs: blobstore.BlobStore,
    blob_md5: []const u8,
    plan: PagePlan,
    out: *std.Io.Writer,
) !void {
    var chunk: [blobstore.chunk_len]u8 = undefined;
    try out.writeAll(&plan.header);
    for (plan.layers()) |r| {
        // A raster-image background carries the asset HASH inline, not the image
        // bytes — the browser fetches the asset once via `/template/{hash}`. Emit
        // the hash and move on; never stream the (multi-MB) image into the page.
        if (r.raster_image) {
            try out.writeAll(&layerHead(r, plan.bg_hash_len));
            try out.writeAll(plan.bgHash());
            continue;
        }
        try out.writeAll(&layerHead(r, r.len));
        var off: u64 = r.offset;
        var left: u64 = r.len;
        while (left > 0) {
            const take = @min(left, chunk.len);
            try out.writeAll(try blobs.readRange(blob_md5, off, take, &chunk));
            off += take;
            left -= take;
        }
    }
}

/// Emits page `page_index`'s SNPG payload **purely from index rows**: the header
/// from the note-level columns, then the stored layer blocks concatenated in
/// stored order. That is the whole payoff of storing layers in emit order — the
/// writer is a dumb concatenation with no opinion of its own to drift from the
/// indexer's.
///
/// The buffering counterpart of `streamPage`, kept for the golden test, which
/// asserts all three of `page_payload.serialize`, this, and `streamPage` produce
/// identical bytes for every page of every sample note.
pub fn serializeFromIndex(
    gpa: Allocator,
    db: sqlite.Db,
    blob_md5: []const u8,
    page_index: u64,
    source: anytype,
) ![]u8 {
    const plan = (try pagePlan(db, blob_md5, page_index)) orelse return error.NotIndexed;

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, &plan.header);
    for (plan.layers()) |r| {
        // A raster-image background: the record's wire data is the asset hash,
        // NOT the image bytes (mirrors `streamPage`).
        if (r.raster_image) {
            try out.appendSlice(gpa, &layerHead(r, plan.bg_hash_len));
            try out.appendSlice(gpa, plan.bgHash());
            continue;
        }
        const data = try source.read(r.offset, r.len);
        if (data.len != r.len) return error.BadRange;
        try out.appendSlice(gpa, &layerHead(r, r.len));
        try out.appendSlice(gpa, data);
    }
    return out.toOwnedSlice(gpa);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");
const filesvc = @import("files.zig");
const nb = @import("note_builder");

/// Real device captures. Local fixtures only — they are not redistributed.
const sample = @embedFile("sample.note");
const sample2 = @embedFile("sample-2.note");
/// The layer-panel capture: page 1 `#`-JSON LAYERINFO, page 2 base64 with a
/// HIDDEN Layer 2 (bitmap persists), a renamed top layer, layerId -1 bg.
const layers_edited = @embedFile("layers_edited.note");

const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1000000000);");
        const tmp = testing.tmpDir(.{});
        const store_ = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs_ = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{ .db = db, .files = filesvc.Files.init(testing.allocator, testing.io, db, store_, thumbs_), .tmp = tmp };
    }

    fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    /// Puts `data` as a file, returning its (owned) md5 hex.
    fn put(f: *Fixture, name: []const u8, data: []const u8) ![blobstore.md5_hex_len]u8 {
        var r = std.Io.Reader.fixed(data);
        const e = try f.files.putFile(1, null, name, &r, null);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var out: [blobstore.md5_hex_len]u8 = undefined;
        @memcpy(&out, e.md5.?[0..blobstore.md5_hex_len]);
        return out;
    }

    fn countRows(f: *Fixture, sql: []const u8) !i64 {
        var s = try f.db.prepare(sql);
        defer s.finalize();
        _ = try s.step();
        return s.columnInt(0);
    }
};

/// A bare blob store on a temp dir — no database, no file tree. For the
/// source-equivalence tests, which are about bytes and allocation, not rows.
const Blobs = struct {
    tmp: testing.TmpDir,
    store: blobstore.BlobStore,

    fn init() !Blobs {
        const tmp = testing.tmpDir(.{});
        return .{ .tmp = tmp, .store = try blobstore.BlobStore.init(testing.io, tmp.dir) };
    }
    fn deinit(b: *Blobs) void {
        b.tmp.cleanup();
    }
    fn put(b: *Blobs, data: []const u8) ![blobstore.md5_hex_len]u8 {
        var r = std.Io.Reader.fixed(data);
        return (try b.store.put(&r, null)).md5;
    }
    /// A ranged source over `data`, stored as a real blob on disk.
    fn source(b: *Blobs, md5: *const [blobstore.md5_hex_len]u8, out: *blob_source.BlobSource) !sn.Source {
        out.* = try blob_source.BlobSource.init(b.store, md5);
        return out.source();
    }
};

/// Wraps an allocator to record peak *live* bytes. The proof that the blob path
/// does not buffer: run a parse through it and look at the high-water mark.
const PeakAllocator = struct {
    child: Allocator,
    live: usize = 0,
    peak: usize = 0,

    fn allocator(self: *PeakAllocator) Allocator {
        return .{ .ptr = self, .vtable = &.{
            .alloc = alloc,
            .resize = resize,
            .remap = remap,
            .free = free,
        } };
    }

    fn grew(self: *PeakAllocator, n: usize) void {
        self.live += n;
        self.peak = @max(self.peak, self.live);
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        const p = self.child.rawAlloc(len, alignment, ra) orelse return null;
        self.grew(len);
        return p;
    }
    fn resize(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) bool {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        if (!self.child.rawResize(memory, alignment, new_len, ra)) return false;
        self.live -= memory.len;
        self.grew(new_len);
        return true;
    }
    fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) ?[*]u8 {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        const p = self.child.rawRemap(memory, alignment, new_len, ra) orelse return null;
        self.live -= memory.len;
        self.grew(new_len);
        return p;
    }
    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ra: usize) void {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        self.child.rawFree(memory, alignment, ra);
        self.live -= memory.len;
    }
};

fn expectSameOptStr(want: ?[]const u8, got: ?[]const u8) !void {
    try testing.expectEqual(want == null, got == null);
    if (want) |w| try testing.expectEqualStrings(w, got.?);
}

/// Every field the index stores must be identical whichever source produced it.
fn expectSameParsed(want: Parsed, got: Parsed) !void {
    try testing.expectEqual(want.indexable, got.indexable);
    try testing.expectEqual(want.note.page_count, got.note.page_count);
    try expectSameOptStr(want.note.signature, got.note.signature);
    try testing.expectEqual(want.note.signature_version, got.note.signature_version);
    try expectSameOptStr(want.note.equipment, got.note.equipment);
    try expectSameOptStr(want.note.recogn_type, got.note.recogn_type);
    try expectSameOptStr(want.note.recogn_language, got.note.recogn_language);
    try testing.expectEqual(want.note.width, got.note.width);
    try testing.expectEqual(want.note.height, got.note.height);
    try testing.expectEqual(want.note.rle_variant, got.note.rle_variant);
    try testing.expectEqual(want.note.recognized_page_count, got.note.recognized_page_count);
    try testing.expectEqual(want.note.cover_w, got.note.cover_w);
    try testing.expectEqual(want.note.cover_h, got.note.cover_h);
    try testing.expectEqual(want.note.cover_offset, got.note.cover_offset);
    try testing.expectEqual(want.note.cover_length, got.note.cover_length);
    try expectSameOptStr(want.note.cover_mime, got.note.cover_mime);
    try testing.expectEqual(want.pages.len, got.pages.len);

    for (want.pages, got.pages) |w, g| {
        try testing.expectEqual(w.page_index, g.page_index);
        try testing.expectEqualStrings(&w.content_hash, &g.content_hash);
        try testing.expectEqual(w.width, g.width);
        try testing.expectEqual(w.height, g.height);
        try testing.expectEqual(w.layers.len, g.layers.len);
        for (w.layers, g.layers) |wl, gl| {
            try testing.expectEqual(wl.ref, gl.ref);
            try testing.expectEqualStrings(wl.name, gl.name);
            try testing.expectEqual(wl.is_current, gl.is_current);
        }
        try testing.expectEqual(w.recogn_status, g.recogn_status);
        try testing.expectEqual(w.recogn_offset, g.recogn_offset);
        try testing.expectEqual(w.recogn_length, g.recogn_length);
        try testing.expectEqual(w.text_hash == null, g.text_hash == null);
        if (w.text_hash) |*h| try testing.expectEqualStrings(h, &g.text_hash.?);
        try expectSameOptStr(w.text, g.text);
    }
}

/// Indexes `bytes` under `md5` into a fresh in-memory DB (blobs row included, so
/// the FK holds) and returns the db. Mirrors what `linkBlob` does.
fn indexInto(db: sqlite.Db, md5: []const u8, bytes: []const u8) !void {
    {
        var s = try db.prepare("INSERT OR IGNORE INTO blobs(md5, size, refcount, created_at) VALUES(?1,?2,1,0);");
        defer s.finalize();
        s.bindText(1, md5);
        s.bindInt(2, @intCast(bytes.len));
        _ = try s.step();
    }
    var p = try parseBlob(testing.allocator, bytes);
    defer p.deinit();
    try store(db, md5, p, 0);
}

/// THE acceptance criterion. If this ever fails, the design does not work.
///
/// Three producers must agree byte for byte on every page:
///   1. `page_payload.serialize` — parse-driven, the pre-index reference;
///   2. `serializeFromIndex` — index-driven, buffering;
///   3. `streamPage` — index-driven, streamed off a real on-disk blob in
///      `chunk_len` windows. This is what actually goes on the wire, so it is the
///      one that has to be identical, not merely equivalent.
/// And the plan's `content_length`, computed from the index with no file read,
/// must equal the number of bytes that come out.
fn assertGolden(bytes: []const u8, label: []const u8) !void {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    var blobs = try Blobs.init();
    defer blobs.deinit();
    const md5 = try blobs.put(bytes);
    try testing.expectEqualStrings(&blobstore.md5HexOf(bytes), &md5);
    try indexInto(db, &md5, bytes);

    var note = try sn.parse(gpa, bytes);
    defer note.deinit();
    try testing.expect(note.pages.len > 0);

    for (0..note.pages.len) |i| {
        const from_parse = try sn.page_payload.serialize(gpa, note, i);
        defer gpa.free(from_parse);
        const from_index = try serializeFromIndex(gpa, db, &md5, i, SliceSource{ .bytes = bytes });
        defer gpa.free(from_index);

        const plan = (try pagePlan(db, &md5, i)).?;
        var streamed: std.Io.Writer.Allocating = .init(gpa);
        defer streamed.deinit();
        try streamPage(blobs.store, &md5, plan, &streamed.writer);

        testing.expectEqualSlices(u8, from_parse, from_index) catch |e| {
            std.debug.print("golden mismatch (buffered): {s} page {d}\n", .{ label, i });
            return e;
        };
        testing.expectEqualSlices(u8, from_parse, streamed.written()) catch |e| {
            std.debug.print("golden mismatch (streamed): {s} page {d}\n", .{ label, i });
            return e;
        };
        try testing.expectEqual(from_parse.len, @as(usize, @intCast(plan.content_length)));
    }
}

test "GOLDEN: index-driven SNPG is byte-identical to parse-driven, every page of both samples" {
    try assertGolden(sample, "sample.note"); // 1 page
    try assertGolden(sample2, "sample-2.note"); // 2 pages, page 0 recognized
}

test "GOLDEN: synthetic notes — multi-layer, blank-background shortcut, non-highres, N5 dims" {
    const gpa = testing.allocator;

    // A BGLAYER of exactly 0x140e bytes on a white-style page takes the
    // blank-background shortcut; anything else does not.
    const blank_bg = try gpa.alloc(u8, 0x140e);
    defer gpa.free(blank_bg);
    @memset(blank_bg, 0x62);

    const main_rle = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const l1 = [_]u8{ 0x61, 0x05 };
    const l2 = [_]u8{ 0x62, 0x01 };

    const page_blank: nb.PageSpec = .{ .style = "style_white", .layers = &.{
        .{ .slot = .main, .bitmap = &main_rle },
        .{ .slot = .background, .bitmap = blank_bg },
    } };
    const page_full: nb.PageSpec = .{
        .style = "style_5mm_dots",
        .layers = &.{
            .{ .slot = .main, .bitmap = &main_rle },
            .{ .slot = .layer1, .bitmap = &l1 },
            .{ .slot = .layer2, .bitmap = &l2 },
            .{ .slot = .background, .bitmap = blank_bg }, // same size, but not white style
        },
    };
    const page_bare: nb.PageSpec = .{ .style = "style_white", .layers = &.{} }; // no layers at all

    const cases = [_]struct { name: []const u8, spec: nb.Spec }{
        .{ .name = "highres/N6", .spec = .{
            .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
            .pages = &.{ page_blank, page_full, page_bare },
        } },
        .{ .name = "highres/N5 (1920x2560)", .spec = .{
            .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N5" }},
            .pages = &.{ page_full, page_blank },
        } },
        .{ .name = "pre-highres variant 0", .spec = .{
            .version = 20190529,
            .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
            .pages = &.{ page_blank, page_full },
        } },
    };

    for (cases) |c| {
        const bytes = try nb.serialize(gpa, c.spec);
        defer gpa.free(bytes);
        try assertGolden(bytes, c.name);
    }
}

test "note-level and page-level rows carry the facts the read paths need" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    const md5 = blobstore.md5HexOf(sample2);
    try indexInto(db, &md5, sample2);

    var s = try db.prepare(
        "SELECT page_count, indexable, equipment, width, height, rle_variant, " ++
            "recogn_type, recogn_language, recognized_page_count, signature_version " ++
            "FROM note_index WHERE blob_md5 = ?1;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 2), s.columnInt(0));
    try testing.expectEqual(@as(i64, 1), s.columnInt(1));
    try testing.expectEqualStrings("N6", s.columnText(2));
    try testing.expectEqual(@as(i64, 1404), s.columnInt(3));
    try testing.expectEqual(@as(i64, 1872), s.columnInt(4));
    try testing.expectEqual(@as(i64, 1), s.columnInt(5)); // highres → X2
    try testing.expectEqualStrings("1", s.columnText(6)); // FILE_RECOGN_TYPE
    try testing.expectEqualStrings("pt_BR", s.columnText(7));
    try testing.expectEqual(@as(i64, 1), s.columnInt(8)); // one finished page
    try testing.expectEqual(@as(i64, 20260016), s.columnInt(9));

    // Page 0 is recognized: transcript, text_hash and the raw range are stored.
    var ps = try db.prepare(
        "SELECT content_hash, width, height, recogn_status, text_hash, recogn_offset, " ++
            "recogn_length, text FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer ps.finalize();
    ps.bindText(1, &md5);
    try testing.expect(try ps.step());
    try testing.expectEqual(@as(usize, 32), ps.columnText(0).len);
    try testing.expectEqual(@as(i64, 1404), ps.columnInt(1)); // ORIENTATION 1000 → no swap
    try testing.expectEqual(@as(i64, 1872), ps.columnInt(2));
    try testing.expectEqual(@as(i64, 1), ps.columnInt(3));
    try testing.expectEqual(@as(usize, 32), ps.columnText(4).len);
    try testing.expect(ps.columnInt(5) > 0);
    try testing.expect(ps.columnInt(6) > 0);
    try testing.expectEqualStrings("Test\nMiddle\nTest", ps.columnText(7)); // v7: device layout honored — regions y-sorted, newline-joined

    // Page 1 is still recognising (status 2): no text, no hash, no range.
    try testing.expect(try ps.step());
    try testing.expectEqual(@as(i64, 2), ps.columnInt(3));
    try testing.expect(ps.columnIsNull(4));
    try testing.expect(ps.columnIsNull(5));
    try testing.expect(ps.columnIsNull(7));

    // The stored content hash is exactly what the control-plane face advertises.
    var note = try sn.parse(gpa, sample2);
    defer note.deinit();
    ps.reset();
    ps.bindText(1, &md5);
    try testing.expect(try ps.step());
    try testing.expectEqualStrings(&try pageContentHash(sn.Source.fromSlice(sample2), note.pages[0]), ps.columnText(0));
}

test "a truncated or corrupt note is refused at index time, never read past EOF" {
    const gpa = testing.allocator;

    // 1. Truncated: the footer address lives in the last 4 bytes, so a cut file
    //    does not parse at all.
    {
        var p = try parseBlob(gpa, sample2[0 .. sample2.len / 2]);
        defer p.deinit();
        try testing.expect(!p.indexable);
        try testing.expectEqual(@as(usize, 0), p.pages.len);
    }

    // 2. Structurally valid, but a layer block claims a length past EOF. The
    //    container still parses (the parser never reads bitmap content), so this
    //    is exactly the case only offset validation catches.
    {
        const rle = [_]u8{ 0xAB, 0xCD, 0xEF, 0x42 };
        const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
            .{ .slot = .main, .bitmap = &rle },
        } }} });
        defer gpa.free(bytes);

        // Sanity: intact, it indexes.
        {
            var ok = try parseBlob(gpa, bytes);
            defer ok.deinit();
            try testing.expect(ok.indexable);
        }

        // Blow up the bitmap block's u32 length prefix (it sits 4 bytes before
        // the RLE payload) so it overruns the buffer.
        const at = std.mem.indexOf(u8, bytes, &rle).?;
        std.mem.writeInt(u32, bytes[at - 4 ..][0..4], 0xFFFF_FFF0, .little);

        {
            var still = try sn.parse(gpa, bytes); // the container itself is intact
            still.deinit();
        }
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(!p.indexable); // but is refused as unindexable
    }

    // 3. A stored range that does not fit the bytes it is replayed against is
    //    refused at serve time too.
    var src = SliceSource{ .bytes = "short" };
    try testing.expectError(error.BadRange, src.read(0, 99));
}

test "a non-.note blob is marked unindexable once and never reparsed" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("photo.jpg", "\xff\xd8\xff\xe0 not a supernote file at all");

    // `linkBlob` indexed it eagerly, as an explicit unindexable marker.
    var s = try f.db.prepare("SELECT indexable, page_count, index_version, indexed_at FROM note_index WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 0), s.columnInt(0));
    try testing.expectEqual(@as(i64, 0), s.columnInt(1));
    try testing.expectEqual(index_version, s.columnInt(2));
    const first_indexed_at = s.columnInt(3);

    // The marker sticks: the lazy path sees a current row and does no work.
    try testing.expect(try isCurrent(f.db, &md5));
    try ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, first_indexed_at + 1000);
    s.reset();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(first_indexed_at, s.columnInt(3)); // untouched → not reparsed
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));
}

test "lazy backfill repairs a missing or stale row and is idempotent under repeated calls" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const md5 = try f.put("n.note", sample2);
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    // Simulate a pre-existing blob (indexed before this feature existed).
    // The segment rows (and their postings) are derived state too, and their
    // FK deliberately blocks deleting pages from under them — wipe them the
    // way a pre-index database simply never had them.
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('delete-all');");
    try f.db.exec("DELETE FROM segment_search;");
    try f.db.exec("DELETE FROM note_index;");
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM note_page_index;")); // cascaded
    try testing.expect(!try isCurrent(f.db, &md5));

    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 100);
    try testing.expect(try isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    // Page rowids must be stable — the FTS table will target them.
    const rowid_before = try f.countRows("SELECT id FROM note_page_index ORDER BY page_index LIMIT 1;");

    // Repeated calls are no-ops; nothing duplicates, nothing moves.
    for (0..3) |_| try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 200);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(rowid_before, try f.countRows("SELECT id FROM note_page_index ORDER BY page_index LIMIT 1;"));

    // A stale index_version forces a rebuild (self-healing, no migration needed).
    try f.db.exec("UPDATE note_index SET index_version = 0, page_count = 0;");
    try testing.expect(!try isCurrent(f.db, &md5));
    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 300);
    try testing.expect(try isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT page_count FROM note_index;"));
    try testing.expectEqual(rowid_before, try f.countRows("SELECT id FROM note_page_index ORDER BY page_index LIMIT 1;"));

    // And a rebuilt index still serves byte-identical payloads.
    var note = try sn.parse(gpa, sample2);
    defer note.deinit();
    for (0..note.pages.len) |i| {
        const a = try sn.page_payload.serialize(gpa, note, i);
        defer gpa.free(a);
        const b = try serializeFromIndex(gpa, f.db, &md5, i, SliceSource{ .bytes = sample2 });
        defer gpa.free(b);
        try testing.expectEqualSlices(u8, a, b);
    }
}

test "index rows are reaped with the blob, and survive while another file still references it" {
    var f = try Fixture.init();
    defer f.deinit();

    // Two files, identical content → one blob, one shared index (dedup).
    _ = try f.put("a.note", sample2);
    _ = try f.put("b.note", sample2);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    // Trashing holds the reference, so the index is untouched either way.
    try f.files.trash(1, 1);
    try f.files.trash(1, 2);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    try f.files.purge(1, 1); // the blob is still referenced by b.note
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    try f.files.purge(1, 2); // refcount hits 0: blob GC'd, index goes with it
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));
}

test "the blob source and the slice source parse a note to identical results" {
    const gpa = testing.allocator;
    var b = try Blobs.init();
    defer b.deinit();

    for ([_][]const u8{ sample, sample2 }) |bytes| {
        const md5 = try b.put(bytes);
        var bs: blob_source.BlobSource = undefined;
        const ranged = try b.source(&md5, &bs);

        // 1. The index rows — page count, dims, content hashes, layer refs,
        //    recognition status/range/text-hash/transcript — must all agree.
        var from_slice = try parseBlob(gpa, bytes);
        defer from_slice.deinit();
        var from_blob = try parseBlobSource(gpa, ranged);
        defer from_blob.deinit();
        try testing.expect(from_slice.indexable);
        try expectSameParsed(from_slice, from_blob);

        // 2. The parsed Notes themselves, including a full page serialization —
        //    so `emitLayers` (4-byte length reads) and `serialize` (the layer
        //    bodies) are both proven over the ranged source, byte for byte.
        var note_slice = try sn.parse(gpa, bytes);
        defer note_slice.deinit();
        var note_blob = try sn.parseSource(gpa, ranged);
        defer note_blob.deinit();

        try testing.expectEqual(note_slice.pages.len, note_blob.pages.len);
        try testing.expectEqual(note_slice.dimensions(), note_blob.dimensions());
        try testing.expectEqualStrings(note_slice.signature.raw, note_blob.signature.raw);
        try testing.expectEqualStrings(note_slice.fileId().?, note_blob.fileId().?);

        for (0..note_slice.pages.len) |i| {
            const a_bytes = try sn.page_payload.serialize(gpa, note_slice, i);
            defer gpa.free(a_bytes);
            const b_bytes = try sn.page_payload.serialize(gpa, note_blob, i);
            defer gpa.free(b_bytes);
            try testing.expectEqualSlices(u8, a_bytes, b_bytes);

            // Recognition text, read lazily through each source.
            var rec_a = try sn.recognition.forPage(gpa, note_slice, i);
            defer if (rec_a) |*r| r.deinit();
            var rec_b = try sn.recognition.forPage(gpa, note_blob, i);
            defer if (rec_b) |*r| r.deinit();
            try testing.expectEqual(rec_a == null, rec_b == null);
            if (rec_a) |ra| {
                const ta = try ra.plainText(gpa);
                defer gpa.free(ta);
                const tb = try rec_b.?.plainText(gpa);
                defer gpa.free(tb);
                try testing.expectEqualStrings(ta, tb);
            }
        }
    }
}

test "a truncated or corrupt note read through the blob source fails cleanly" {
    const gpa = testing.allocator;
    var b = try Blobs.init();
    defer b.deinit();

    // 1. Truncated: the footer address lives in the last 4 bytes, so a cut file
    //    cannot parse. Must be `indexable = false`, not a panic or a read past
    //    the end of the blob.
    {
        const md5 = try b.put(sample2[0 .. sample2.len / 2]);
        var bs: blob_source.BlobSource = undefined;
        var p = try parseBlobSource(gpa, try b.source(&md5, &bs));
        defer p.deinit();
        try testing.expect(!p.indexable);
        try testing.expectEqual(@as(usize, 0), p.pages.len);
    }

    // 2. Structurally valid container, but a layer block claims a length past
    //    EOF — the case only range validation catches, since the parser never
    //    touches bitmap bodies.
    {
        const rle = [_]u8{ 0xAB, 0xCD, 0xEF, 0x42 };
        const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
            .{ .slot = .main, .bitmap = &rle },
        } }} });
        defer gpa.free(bytes);
        const at = std.mem.indexOf(u8, bytes, &rle).?;
        std.mem.writeInt(u32, bytes[at - 4 ..][0..4], 0xFFFF_FFF0, .little);

        const md5 = try b.put(bytes);
        var bs: blob_source.BlobSource = undefined;
        const ranged = try b.source(&md5, &bs);

        // The container still parses over the ranged source...
        var note = try sn.parseSource(gpa, ranged);
        defer note.deinit();
        // ...but the bad layer range is refused, as an error, at every level.
        var refs: [max_layers]LayerRef = undefined;
        try testing.expectError(error.Truncated, sn.page_payload.emitLayers(note, 0, &refs));
        try testing.expectError(error.Truncated, sn.page_payload.serialize(gpa, note, 0));

        var p = try parseBlobSource(gpa, ranged);
        defer p.deinit();
        try testing.expect(!p.indexable);
    }

    // 3. Random bytes that are not a `.note` at all: unindexable, no error.
    {
        const md5 = try b.put("\xff\xd8\xff\xe0 not a supernote file at all");
        var bs: blob_source.BlobSource = undefined;
        var p = try parseBlobSource(gpa, try b.source(&md5, &bs));
        defer p.deinit();
        try testing.expect(!p.indexable);
    }
}

test "indexing over the blob source allocates nothing proportional to file size" {
    const gpa = testing.allocator;
    var b = try Blobs.init();
    defer b.deinit();

    // A note whose bitmap dwarfs everything else: 8 MiB in one layer. If the
    // parse buffered the file — as `readBlobBytes` did — peak would exceed it.
    const big = try gpa.alloc(u8, 8 * 1024 * 1024);
    defer gpa.free(big);
    @memset(big, 0x62);

    const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
        .{ .slot = .main, .bitmap = big },
    } }} });
    defer gpa.free(bytes);
    try testing.expect(bytes.len > 8 * 1024 * 1024);

    const md5 = try b.put(bytes);
    var bs: blob_source.BlobSource = undefined;
    const ranged = try b.source(&md5, &bs);

    var counter = PeakAllocator{ .child = gpa };
    var p = try parseBlobSource(counter.allocator(), ranged);
    defer p.deinit();

    try testing.expect(p.indexable);
    try testing.expectEqual(@as(u32, 1), p.note.page_count);
    try testing.expectEqual(big.len, @as(usize, p.pages[0].layers[0].ref.len)); // it really read it

    // The bar: peak live bytes stay a fixed small budget, three orders of
    // magnitude under the file. (The layer is hashed in `hash_chunk_len` chunks
    // through a stack buffer, so it never lands on the heap at all.)
    try testing.expect(counter.peak < 64 * 1024);
    try testing.expect(counter.peak * 100 < bytes.len);

    // And the slice path, for contrast, is the same parse — the abstraction
    // costs the in-memory caller nothing.
    var counter2 = PeakAllocator{ .child = gpa };
    var p2 = try parseBlob(counter2.allocator(), bytes);
    defer p2.deinit();
    try expectSameParsed(p, p2);
    try testing.expect(counter2.peak < 64 * 1024);
}

/// A note whose SECOND page is landscape (`ORIENTATION = 1090`). Landscape
/// storage is settled — the raster is natively landscape (see `NoteHeader`) —
/// so v3 stores and serves the swapped (effective) dims for that page.
fn landscapeNote(gpa: Allocator) ![]u8 {
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }}, // 1404×1872 base
        .pages = &.{
            .{ .style = "style_white", .orientation = "1000", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .style = "style_white", .orientation = "1090", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
}

test "ORIENTATION 1090: the stored dims and the payload header agree, and are the EFFECTIVE dims" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    const bytes = try landscapeNote(gpa);
    defer gpa.free(bytes);

    // The fixture really does carry both orientations (guard against the builder
    // silently dropping the key and making this test vacuous).
    {
        var note = try sn.parse(gpa, bytes);
        defer note.deinit();
        try testing.expectEqual(sn.Orientation.vertical, note.pages[0].orientation());
        try testing.expectEqual(sn.Orientation.horizontal, note.pages[1].orientation());
        try testing.expectEqualStrings("1090", note.pages[1].orientationRaw().?);
    }

    const md5 = blobstore.md5HexOf(bytes);
    try indexInto(db, &md5, bytes);

    // THE DECISION, asserted: a landscape page stores its EFFECTIVE (swapped)
    // dims — its raster is natively landscape, so 1872×1404 is its real decode
    // geometry — while its portrait neighbour keeps the base dims. (v2 stored
    // base dims for both while landscape storage was unproven; that sheared a
    // real 1090 page.)
    const want = [2][2]i64{ .{ 1404, 1872 }, .{ 1872, 1404 } };
    var s = try db.prepare("SELECT width, height FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;");
    defer s.finalize();
    s.bindText(1, &md5);
    for (want) |dims| {
        try testing.expect(try s.step());
        try testing.expectEqual(dims[0], s.columnInt(0));
        try testing.expectEqual(dims[1], s.columnInt(1));
    }

    // And the payload header the client decodes with carries exactly those
    // per-page dims. The header is the decode geometry; storing and serving the
    // same value is what stops the payload and the `noteMeta` box from ever
    // describing different rectangles.
    for (want, 0..) |dims, i| {
        const plan = (try pagePlan(db, &md5, i)).?;
        try testing.expectEqual(@as(u32, @intCast(dims[0])), std.mem.readInt(u32, plan.header[8..12], .little));
        try testing.expectEqual(@as(u32, @intCast(dims[1])), std.mem.readInt(u32, plan.header[12..16], .little));
    }
}

test "a v2 row (base dims) self-heals to v3 effective dims on first read" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try landscapeNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("landscape.note", bytes); // eagerly indexed at v3

    // Regress the rows to v2's shape: stale version, base dims on every page —
    // exactly what an existing database holds across the v3 upgrade.
    try f.db.exec("UPDATE note_index SET index_version = 2;");
    try f.db.exec("UPDATE note_page_index SET width = 1404, height = 1872;");
    try testing.expect(!try isCurrent(f.db, &md5));

    // The lazy read-path gate re-parses, and the landscape page comes back
    // swapped — no migration, no backfill job.
    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 42);
    try testing.expect(try isCurrent(f.db, &md5));

    var s = try f.db.prepare("SELECT width, height FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;");
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 1404), s.columnInt(0));
    try testing.expectEqual(@as(i64, 1872), s.columnInt(1));
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 1872), s.columnInt(0));
    try testing.expectEqual(@as(i64, 1404), s.columnInt(1));
}

test "GOLDEN: a landscape (ORIENTATION 1090) page serializes identically through every path" {
    const gpa = testing.allocator;
    const bytes = try landscapeNote(gpa);
    defer gpa.free(bytes);
    try assertGolden(bytes, "landscape/1090");
}

test "a multi-MB page streams byte-exactly, at the Content-Length the index predicted" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    var b = try Blobs.init();
    defer b.deinit();

    // One 8 MiB layer — 128 chunks, so the streaming loop is genuinely exercised
    // across window boundaries rather than emitting a single short read.
    const big = try gpa.alloc(u8, 8 * 1024 * 1024);
    defer gpa.free(big);
    for (big, 0..) |*byte, i| byte.* = @truncate(i * 31 + 7); // not memset: catches a misordered window
    const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
        .{ .slot = .main, .bitmap = big },
    } }} });
    defer gpa.free(bytes);

    const md5 = try b.put(bytes);
    try indexInto(db, &md5, bytes);

    // The plan costs no file I/O, so the exact Content-Length is known before a
    // single byte is read.
    const plan = (try pagePlan(db, &md5, 0)).?;
    const expected = sn.page_payload.HEADER_SIZE + sn.page_payload.LAYER_HEADER_SIZE + big.len;
    try testing.expectEqual(@as(u64, expected), plan.content_length);
    try testing.expect(expected > 100 * blobstore.chunk_len);

    // Stream to a sink that hashes and discards — a stand-in for the socket, so
    // the test measures the streamer instead of a collector.
    var sink = HashingSink.init();
    try streamPage(b.store, &md5, plan, &sink.writer);
    try testing.expectEqual(@as(u64, expected), sink.total);

    // ...and the bytes are exactly the reference payload, at 8 MiB, chunk seams
    // and all. (The reference DOES buffer; that is the test's allocation, and the
    // point of comparison.)
    var note = try sn.parse(gpa, bytes);
    defer note.deinit();
    const reference = try sn.page_payload.serialize(gpa, note, 0);
    defer gpa.free(reference);
    try testing.expectEqualStrings(&md5Hex(reference), &sink.digest());
}

/// A `std.Io.Writer` that md5s the bytes written through it and drops them.
const HashingSink = struct {
    writer: std.Io.Writer,
    hasher: Md5,
    total: u64 = 0,

    fn init() HashingSink {
        return .{ .writer = .{ .buffer = &.{}, .vtable = &.{ .drain = drain } }, .hasher = Md5.init(.{}) };
    }

    fn digest(self: *HashingSink) [32]u8 {
        var raw: [Md5.digest_length]u8 = undefined;
        self.hasher.final(&raw);
        var hex: [32]u8 = undefined;
        hexEncode(&hex, &raw);
        return hex;
    }

    fn drain(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
        const self: *HashingSink = @alignCast(@fieldParentPtr("writer", w));
        var n: usize = 0;
        for (data[0 .. data.len - 1]) |d| {
            self.hasher.update(d);
            n += d.len;
        }
        const last = data[data.len - 1];
        for (0..splat) |_| self.hasher.update(last);
        n += last.len * splat;
        self.total += n;
        return n;
    }
};

test "packed layer records round-trip (slot, hidden, current, name), and a malformed blob is rejected" {
    const layers = [_]IndexedLayer{
        .{ .ref = .{ .offset = 334, .len = 0x140e, .slot = .background, .all_blank = true, .hidden = false }, .name = "Background Layer" },
        .{ .ref = .{ .offset = 11008, .len = 42, .slot = .layer2, .all_blank = false, .hidden = true }, .name = "Layer 2" },
        .{ .ref = .{ .offset = 22000, .len = 7, .slot = .layer3, .all_blank = false, .hidden = false }, .name = "Layer Renamed", .is_current = true },
        .{ .ref = .{ .offset = 33000, .len = 9, .slot = .main, .all_blank = false, .hidden = false } }, // no LAYERINFO: empty name
    };
    var buf: [max_layers * max_layer_rec_size]u8 = undefined;
    const packed_bytes = packLayers(&buf, &layers);

    var out: [max_layers]LayerRecord = undefined;
    const got = try unpackLayerRecords(packed_bytes, &out);
    try testing.expectEqual(layers.len, got.len);
    for (layers, got) |want, g| {
        try testing.expectEqual(want.ref, g.ref);
        try testing.expectEqualStrings(want.name, g.name);
        try testing.expectEqual(want.is_current, g.is_current);
    }

    // The refs-only view agrees, in order.
    var ref_buf: [max_layers]LayerRef = undefined;
    const refs = try unpackLayers(packed_bytes, &ref_buf);
    for (layers, refs) |want, r| try testing.expectEqual(want.ref, r);

    // Malformed shapes are refused: a truncated record, a name_len past the
    // end, too many records, an unknown slot byte.
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(packed_bytes[0 .. packed_bytes.len - 1], &out));
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(packed_bytes[0..5], &out));
    var too_many: [(max_layers + 1) * layer_rec_head_size]u8 = @splat(0);
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(&too_many, &out));
    var bad_slot: [layer_rec_head_size]u8 = @splat(0);
    bad_slot[9] = 0xEE;
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(&bad_slot, &out));

    // An overlong name truncates at pack time rather than corrupting the blob.
    const long_name = "n" ** 300;
    const long = [_]IndexedLayer{.{ .ref = .{ .offset = 1, .len = 2, .slot = .main, .all_blank = false, .hidden = false }, .name = long_name }};
    const packed_long = packLayers(&buf, &long);
    const got_long = try unpackLayerRecords(packed_long, &out);
    try testing.expectEqual(@as(usize, max_layer_name), got_long[0].name.len);
}

/// A real minimal PNG head whose IHDR carries 320×240 — decodable dims.
const mini_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ ("p" ** 16);

/// A one-page note carrying `cover` as its `COVER_2` block (null = coverless).
fn coveredNote(a: Allocator, cover: ?[]const u8) ![]u8 {
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(a, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
        .covers = if (cover) |c| &.{.{ .bytes = c }} else &.{},
    });
}

test "the cover is LOCATED not extracted: offset/length/mime + dims recorded; coverless stays NULL; undecodable dims store 0" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    // A real cover: sniffed, dims decoded, and its LOCATION recorded (offset +
    // length + mime) — NOT its bytes. The recorded window addresses the cover
    // verbatim inside the blob, which is exactly what the serve path streams.
    {
        const bytes = try coveredNote(gpa, mini_png);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.indexable);
        try testing.expectEqualStrings("image/png", p.note.cover_mime.?);
        try testing.expectEqual(@as(?u32, mini_png.len), p.note.cover_length);
        try testing.expectEqual(@as(?u32, 320), p.note.cover_w);
        try testing.expectEqual(@as(?u32, 240), p.note.cover_h);
        const at = std.mem.indexOf(u8, bytes, mini_png).?;
        try testing.expectEqual(@as(?u64, at), p.note.cover_offset);
        try testing.expectEqualSlices(u8, mini_png, bytes[at..][0..mini_png.len]);

        const md5 = blobstore.md5HexOf(bytes);
        try indexInto(db, &md5, bytes);
        var s = try db.prepare("SELECT cover_w, cover_h, cover_offset, cover_length, cover_mime FROM note_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &md5);
        try testing.expect(try s.step());
        try testing.expectEqual(@as(i64, 320), s.columnInt(0));
        try testing.expectEqual(@as(i64, 240), s.columnInt(1));
        try testing.expectEqual(@as(i64, @intCast(at)), s.columnInt(2));
        try testing.expectEqual(@as(i64, mini_png.len), s.columnInt(3));
        try testing.expectEqualStrings("image/png", s.columnText(4));

        // And `coverLocation` resolves that row into a self-contained serve plan.
        const loc = (try coverLocation(db, &md5)).?;
        try testing.expectEqual(@as(u64, at), loc.offset);
        try testing.expectEqual(@as(u64, mini_png.len), loc.length);
        try testing.expectEqualStrings("image/png", loc.mime());
    }

    // Coverless: NULL, the "source ships no cover" fact — distinct from 0.
    {
        const bytes = try coveredNote(gpa, null);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.indexable);
        try testing.expect(p.note.cover_offset == null);
        try testing.expect(p.note.cover_w == null);

        const md5 = blobstore.md5HexOf(bytes);
        try indexInto(db, &md5, bytes);
        try testing.expect((try coverLocation(db, &md5)) == null); // nothing to serve
        var s = try db.prepare("SELECT cover_offset IS NULL, cover_w IS NULL FROM note_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &md5);
        try testing.expect(try s.step());
        try testing.expectEqual(@as(i64, 1), s.columnInt(0));
        try testing.expectEqual(@as(i64, 1), s.columnInt(1));
    }

    // Sniffable PNG magic, corrupt IHDR: the cover is still LOCATED (served),
    // but dims record 0 — the masonry aspect falls back, the image still renders.
    {
        const corrupt_png = "\x89PNG\r\n\x1a\n" ++ "\x00\x00\x00\x0d" ++ "NOPE" ++ ("z" ** 16);
        const bytes = try coveredNote(gpa, corrupt_png);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.note.cover_offset != null);
        try testing.expectEqualStrings("image/png", p.note.cover_mime.?);
        try testing.expectEqual(@as(?u32, 0), p.note.cover_w);
        try testing.expectEqual(@as(?u32, 0), p.note.cover_h);
    }

    // Not a recognizable image at all: no cover, everything NULL (never a wrong MIME).
    {
        const bytes = try coveredNote(gpa, "just some bytes, not an image");
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.indexable); // the note itself is fine
        try testing.expect(p.note.cover_offset == null);
        try testing.expect(p.note.cover_mime == null);
        try testing.expect(p.note.cover_w == null);
    }
}

test "a large cover (>2 MB, and at the 20 MB ceiling) is LOCATED without materializing it; the window streams byte-identical" {
    const gpa = testing.allocator;

    // Two sizes: one comfortably past the OLD 2 MB thumbnail cap (the exact bug
    // — a real user cover ran to 6.5 MB), one right at the 20 MB ceiling.
    for ([_]usize{ 3 * 1024 * 1024, thumbnail.max_cover_bytes }) |cover_len| {
        const cover = try gpa.alloc(u8, cover_len);
        defer gpa.free(cover);
        @memset(cover, 0x7e);
        // A valid 1404×1872 PNG IHDR so it sniffs AND decodes dims.
        @memcpy(cover[0..8], "\x89PNG\r\n\x1a\n");
        @memcpy(cover[8..12], "\x00\x00\x00\x0d");
        @memcpy(cover[12..16], "IHDR");
        std.mem.writeInt(u32, cover[16..20][0..4], 1404, .big);
        std.mem.writeInt(u32, cover[20..24][0..4], 1872, .big);

        const bytes = try coveredNote(gpa, cover);
        defer gpa.free(bytes);

        // Over a REAL ranged blob source, wrapped so we can watch the high-water
        // mark: the index parse must NOT buffer the multi-MB cover.
        var blobs = try Blobs.init();
        defer blobs.deinit();
        const md5 = try blobs.put(bytes);
        var bs: blob_source.BlobSource = undefined;
        const src = try blobs.source(&md5, &bs);

        var peak = PeakAllocator{ .child = gpa };
        var p = try parseBlobSource(peak.allocator(), src);
        defer p.deinit();

        try testing.expect(p.indexable);
        try testing.expectEqual(@as(?u32, @intCast(cover_len)), p.note.cover_length);
        try testing.expectEqualStrings("image/png", p.note.cover_mime.?);
        try testing.expectEqual(@as(?u32, 1404), p.note.cover_w);
        try testing.expectEqual(@as(?u32, 1872), p.note.cover_h);
        // Non-resident: peak LIVE bytes stay far below the cover size — only the
        // 64 KiB header window and KB-scale metadata are ever allocated.
        try testing.expect(peak.peak < cover_len);
        try testing.expect(peak.peak <= cover_header_probe + 512 * 1024);

        // The recorded window addresses the cover verbatim in the blob — read it
        // back through the store in chunks and confirm byte-identity, the exact
        // thing the streaming serve path does.
        const at = p.note.cover_offset.?;
        const chunk_n = 128 * 1024;
        const buf = try gpa.alloc(u8, chunk_n);
        defer gpa.free(buf);
        var off: u64 = 0;
        while (off < cover_len) {
            const take = @min(chunk_n, cover_len - off);
            const got = try blobs.store.readRange(&md5, at + off, take, buf[0..take]);
            try testing.expectEqualSlices(u8, cover[@intCast(off)..][0..take], got);
            off += take;
        }
    }
}

test "a cover past the 20 MB ceiling is refused (no cover) from the length prefix, never read" {
    const gpa = testing.allocator;

    const huge = try gpa.alloc(u8, thumbnail.max_cover_bytes + 1);
    defer gpa.free(huge);
    @memset(huge, 0);
    @memcpy(huge[0..8], "\x89PNG\r\n\x1a\n");

    const bytes = try coveredNote(gpa, huge);
    defer gpa.free(bytes);
    var p = try parseBlob(gpa, bytes);
    defer p.deinit();
    try testing.expect(p.indexable);
    try testing.expect(p.note.cover_offset == null);
    try testing.expect(p.note.cover_length == null);
    try testing.expect(p.note.cover_mime == null);
    try testing.expect(p.note.cover_w == null);
}

test "needsRepair: missing or stale row only — no derived file exists for a .note cover" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try coveredNote(gpa, mini_png);
    defer gpa.free(bytes);
    const md5 = try f.put("covered.note", bytes);

    // A `.note` cover streams from the blob, so ingest writes NO thumbs file —
    // and a current row needs no repair regardless.
    try testing.expect(!f.files.thumbs.has(&md5));
    try testing.expect(!try needsRepair(f.db, f.files.thumbs, &md5));
    try testing.expect((try coverLocation(f.db, &md5)) != null); // resolvable from the row

    // Stale index_version (any older row after a bump) → repair; the current
    // version → none. Built from the `index_version` constant so a later bump
    // does not silently pin this at a stale number.
    try f.db.exec("UPDATE note_index SET index_version = 9;");
    try testing.expect(try needsRepair(f.db, f.files.thumbs, &md5));
    {
        var buf: [64]u8 = undefined;
        const sql = try std.fmt.bufPrintZ(&buf, "UPDATE note_index SET index_version = {d};", .{index_version});
        try f.db.exec(sql);
    }
    try testing.expect(!try needsRepair(f.db, f.files.thumbs, &md5));

    // The no-retry gate: a current row with NO cover is a memoized 404 — never a
    // re-derive, and `coverLocation` resolves to null.
    const coverless = try coveredNote(gpa, null);
    defer gpa.free(coverless);
    const md5_2 = try f.put("coverless.note", coverless);
    try testing.expect(!try needsRepair(f.db, f.files.thumbs, &md5_2));
    try testing.expect((try coverLocation(f.db, &md5_2)) == null);

    // And a missing row entirely (pre-existing blob) → repair (then memoize).
    // The segment rows (and their postings) are derived state too, and their FK
    // deliberately blocks deleting pages from under them — wipe them the way a
    // pre-index database simply never had them.
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('delete-all');");
    try f.db.exec("DELETE FROM segment_search;");
    try f.db.exec("DELETE FROM note_index;");
    try testing.expect(try needsRepair(f.db, f.files.thumbs, &md5_2));
}

test "a stale row lazily re-derives to the current version and gains its cover location — no sweep, no migration" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try coveredNote(gpa, mini_png);
    defer gpa.free(bytes);
    const md5 = try f.put("covered.note", bytes); // eagerly indexed at the current version

    // Regress the row to a pre-cover-location shape: stale version, cover columns
    // wiped — what an existing database holds across the 9→10 upgrade.
    try f.db.exec("UPDATE note_index SET index_version = 3, cover_w = NULL, cover_h = NULL, " ++
        "cover_offset = NULL, cover_length = NULL, cover_mime = NULL;");
    try testing.expect(!try isCurrent(f.db, &md5));

    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 42);
    try testing.expect(try isCurrent(f.db, &md5));
    var s = try f.db.prepare("SELECT cover_w, cover_h, cover_offset IS NOT NULL, cover_mime FROM note_index WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 320), s.columnInt(0));
    try testing.expectEqual(@as(i64, 240), s.columnInt(1));
    try testing.expectEqual(@as(i64, 1), s.columnInt(2)); // cover location repopulated
    try testing.expectEqualStrings("image/png", s.columnText(3));
}

test "a v4 row (fixed-stride layers, no identity) lazily re-derives to v5 with slots+names" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const md5 = try f.put("layers.note", layers_edited); // eagerly indexed at v5

    // Regress page 2's row to v4's shape: stale version, and the OLD 9-byte
    // fixed-stride `(offset,len,flags)` records — exactly what an existing
    // database holds across the v5 upgrade. (Layout mirrors v4's packLayers.)
    {
        var p = try parseBlob(gpa, layers_edited);
        defer p.deinit();
        var old_blob: [max_layers * 9]u8 = undefined;
        const layers = p.pages[1].layers;
        for (layers, 0..) |il, i| {
            const rec = old_blob[i * 9 ..][0..9];
            std.mem.writeInt(u32, rec[0..4], il.ref.offset, .little);
            std.mem.writeInt(u32, rec[4..8], il.ref.len, .little);
            rec[8] = if (il.ref.all_blank) flag_all_blank else 0;
        }
        var s = try f.db.prepare("UPDATE note_page_index SET layers = ?1 WHERE page_index = 1;");
        defer s.finalize();
        s.bindBlob(1, old_blob[0 .. layers.len * 9]);
        _ = try s.step();
    }
    try f.db.exec("UPDATE note_index SET index_version = 4;");
    try testing.expect(!try isCurrent(f.db, &md5));
    // The stale row is invisible to the serving gate — never unpacked.
    try testing.expect((try noteHeader(f.db, &md5)) == null);

    // The lazy read-path gate re-parses; the packed records come back in the
    // v5 shape: slot ids, the hidden flag on LAYER2, display names, isCurrent.
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

test "GOLDEN: the layers_edited capture (hidden layer on the wire) through every producer" {
    try assertGolden(layers_edited, "layers_edited.note");
}

test "pagePlan serves SNPG v2: version byte, per-record slot + hidden flag, exact length" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    const md5 = blobstore.md5HexOf(layers_edited);
    try indexInto(db, &md5, layers_edited);

    const plan = (try pagePlan(db, &md5, 1)).?;
    try testing.expectEqual(sn.page_payload.VERSION, plan.header[4]);
    try testing.expectEqual(@as(u32, 5), std.mem.readInt(u32, plan.header[16..20], .little));

    // Exactly one record is hidden — LAYER2 — and every record carries its slot.
    var hidden_count: usize = 0;
    for (plan.layers()) |r| {
        if (r.hidden) {
            hidden_count += 1;
            try testing.expectEqual(sn.types.LayerSlot.layer2, r.slot);
        }
    }
    try testing.expectEqual(@as(usize, 1), hidden_count);

    // The served bytes decode to the device-authored composite — the hidden
    // stream rides the wire without touching the default render — and the
    // default composite equals the parse-driven render byte for byte.
    const payload = try serializeFromIndex(gpa, db, &md5, 1, SliceSource{ .bytes = layers_edited });
    defer gpa.free(payload);
    const rgba = try sn.page_payload.decodeRgba(gpa, payload);
    defer rgba.deinit(gpa);

    var note = try sn.parse(gpa, layers_edited);
    defer note.deinit();
    const gray = try sn.renderPageGray(gpa, note, 1);
    defer gray.deinit(gpa);
    for (gray.pixels, 0..) |g, i| try testing.expectEqual(g, rgba.pixels[i * 4]);

    // And the hidden layer is individually decodable from the same payload.
    const l2 = try sn.page_payload.decodeLayerRgba(gpa, payload, 2);
    defer l2.deinit(gpa);
    try testing.expectEqual(rgba.width, l2.width);
}

test "eager indexing at ingest does not disturb the file tree it rides along with" {
    var f = try Fixture.init();
    defer f.deinit();

    // A real note gets a full index at link time, with no read path involved.
    const md5 = try f.put("n.note", sample);
    try testing.expect(try isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT page_count FROM note_index;"));

    // Re-linking identical content dedups and does not duplicate index rows.
    _ = try f.put("copy.note", sample);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    // Quota accounting and the tree itself are untouched by indexing.
    const entries = try f.files.list(1, null);
    defer filesvc.Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 2), entries.len);
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM files;"));
}

// ---------------------------------------------------------------------------
// Custom image templates (docs/scratch/custom-template.md)
// ---------------------------------------------------------------------------

/// PNG magic + a little IHDR — bytes that cannot decode as a RATTA_RLE stream of
/// a full page, so the classifier treats them as a browser-native image.
const fake_png = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52 };
/// A valid RATTA_RLE background: 0x62 transparent, length 0xFF (special) — one
/// pair, so it decodes as RLE regardless of page size (never treated as image).
const rle_bg = [_]u8{ 0x62, 0xFF };
const template_hash = "deadbeefdeadbeefdeadbeefdeadbeef";

/// Walks an SNPG payload's records, returning the one for `want_slot` (or null).
const SnpgRecord = struct { flags: u8, slot: u8, data: []const u8 };
fn snpgRecordForSlot(payload: []const u8, want_slot: u8) ?SnpgRecord {
    const pp = sn.page_payload;
    if (payload.len < pp.HEADER_SIZE) return null;
    const layer_count = std.mem.readInt(u32, payload[16..20], .little);
    var pos: usize = pp.HEADER_SIZE;
    var i: u32 = 0;
    while (i < layer_count) : (i += 1) {
        if (pos + pp.LAYER_HEADER_SIZE > payload.len) return null;
        const flags = payload[pos];
        const slot = payload[pos + 1];
        const len = std.mem.readInt(u32, payload[pos + 2 ..][0..4], .little);
        pos += pp.LAYER_HEADER_SIZE;
        if (pos + len > payload.len) return null;
        const data = payload[pos..][0..len];
        pos += len;
        if (slot == want_slot) return .{ .flags = flags, .slot = slot, .data = data };
    }
    return null;
}

/// A two-page note: page 0 has a CUSTOM IMAGE background (non-RLE bytes under a
/// custom style + PAGESTYLEMD5); page 1 is an ordinary blank/RLE page. Shared by
/// the ingest, wire, and endpoint tests below.
fn imageTemplateNote(gpa: Allocator) ![]u8 {
    return nb.serialize(gpa, .{ .pages = &.{
        .{
            .style = "customImage",
            .style_md5 = template_hash,
            .layers = &.{
                .{ .slot = .background, .name = "BGLAYER", .protocol = "RATTA_RLE", .bitmap = &fake_png },
                .{ .slot = .main, .name = "MAINLAYER", .protocol = "RATTA_RLE", .bitmap = &.{ 0x61, 0x00 } },
            },
        },
        .{
            .style = "style_white",
            .style_md5 = "0",
            .layers = &.{
                .{ .slot = .background, .name = "BGLAYER", .protocol = "RATTA_RLE", .bitmap = &rle_bg },
                .{ .slot = .main, .name = "MAINLAYER", .protocol = "RATTA_RLE", .bitmap = &.{ 0x61, 0x00 } },
            },
        },
    } });
}

test "ingest: a custom image background sets raster_image + bg_hash; a normal page does not" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try imageTemplateNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("template.note", bytes);
    try testing.expect(try isCurrent(f.db, &md5));

    // Page 0: bg_hash is the PAGESTYLEMD5, and the packed background record is
    // flagged raster_image.
    {
        var s = try f.db.prepare("SELECT bg_hash, layers FROM note_page_index WHERE blob_md5 = ?1 AND page_index = 0;");
        defer s.finalize();
        s.bindText(1, &md5);
        try testing.expect(try s.step());
        try testing.expect(!s.columnIsNull(0));
        try testing.expectEqualStrings(template_hash, s.columnText(0));
        var recs: [max_layers]LayerRecord = undefined;
        const got = try unpackLayerRecords(s.columnBlob(1), &recs);
        var bg_seen = false;
        for (got) |r| if (r.ref.slot == .background) {
            bg_seen = true;
            try testing.expect(r.ref.raster_image);
        };
        try testing.expect(bg_seen);
    }

    // Page 1: no custom style → bg_hash NULL, background NOT raster_image.
    {
        var s = try f.db.prepare("SELECT bg_hash, layers FROM note_page_index WHERE blob_md5 = ?1 AND page_index = 1;");
        defer s.finalize();
        s.bindText(1, &md5);
        try testing.expect(try s.step());
        try testing.expect(s.columnIsNull(0));
        var recs: [max_layers]LayerRecord = undefined;
        const got = try unpackLayerRecords(s.columnBlob(1), &recs);
        for (got) |r| if (r.ref.slot == .background) try testing.expect(!r.ref.raster_image);
    }
}

test "SNPG wire: an image background carries the asset hash (bit2), not the image bytes" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try imageTemplateNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("template.note", bytes);

    const plan = (try pagePlan(f.db, &md5, 0)).?;

    // Streamed payload == index-buffered payload (the serve paths agree), and
    // both are exactly plan.content_length bytes.
    var sink = std.Io.Writer.Allocating.init(gpa);
    defer sink.deinit();
    try streamPage(f.files.blobs, &md5, plan, &sink.writer);
    const streamed = sink.written();
    const buffered = try serializeFromIndex(gpa, f.db, &md5, 0, SliceSource{ .bytes = bytes });
    defer gpa.free(buffered);
    try testing.expectEqualSlices(u8, buffered, streamed);
    try testing.expectEqual(plan.content_length, streamed.len);

    // The background record carries the HASH as its data, flagged raster_image,
    // and NOT the (fake_png) image bytes.
    const bg = snpgRecordForSlot(streamed, sn.types.LayerSlot.background.wireId()).?;
    try testing.expect(bg.flags & sn.page_payload.FLAG_RASTER_IMAGE != 0);
    try testing.expectEqualStrings(template_hash, bg.data);
    try testing.expect(!std.mem.eql(u8, bg.data, &fake_png));

    // Page 1's background is ordinary RLE — no bit2, its own bytes on the wire.
    const plan1 = (try pagePlan(f.db, &md5, 1)).?;
    var sink1 = std.Io.Writer.Allocating.init(gpa);
    defer sink1.deinit();
    try streamPage(f.files.blobs, &md5, plan1, &sink1.writer);
    const bg1 = snpgRecordForSlot(sink1.written(), sn.types.LayerSlot.background.wireId()).?;
    try testing.expect(bg1.flags & sn.page_payload.FLAG_RASTER_IMAGE == 0);
    try testing.expectEqualSlices(u8, &rle_bg, bg1.data);
}

test "templateLocation: resolves hash to the image byte range; wrong hash is null" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try imageTemplateNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("template.note", bytes);

    const loc = (try templateLocation(f.db, &md5, template_hash)).?;
    try testing.expectEqual(@as(u64, fake_png.len), loc.length);
    // The recorded range points at the image bytes in the blob.
    var buf: [fake_png.len]u8 = undefined;
    const got = try f.files.blobs.readRange(&md5, loc.offset, loc.length, &buf);
    try testing.expectEqualSlices(u8, &fake_png, got);

    // A hash no page references resolves to nothing.
    try testing.expect((try templateLocation(f.db, &md5, "00000000000000000000000000000000")) == null);
}
