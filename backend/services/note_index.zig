//! The `.note` blob index: parse a container once and keep the per-page facts
//! the hot read paths need in `note_index` + `note_page_index`.

const std = @import("std");
const repeat = @import("../repeat.zig").repeat;
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const blob_source = @import("../store/blob_source.zig");
const thumbnail = @import("thumbnail.zig");
const derivesearch = @import("derive_search.zig");
const inkscan = @import("ink_scan.zig");
const sn = @import("supernote");

const Md5 = std.crypto.hash.Md5;
const Allocator = std.mem.Allocator;

/// Bump when anything the client caches under `(md5, index_version)` changes
/// (it is the browser's cache key); stale rows re-parse lazily. A schema change
/// that leaves `terms/`/`text/` byte-identical takes no bump. Never reuse a number.
pub const index_version: i64 = 16;

/// Bounds the memory a layer content hash costs.
const hash_chunk_len = blobstore.chunk_len;

/// Header window read from a cover block to sniff MIME and dims; the hard bound
/// on one cover's RSS at index time.
const cover_header_probe: usize = 64 * 1024;

/// Re-exported so the indexer and `page_payload.serialize` share one emit list.
pub const LayerRef = sn.page_payload.LayerRef;
pub const max_layers = sn.page_payload.max_layers;

/// A layer as stored: the wire ref plus panel-only facts `noteMeta` serves.
/// `name` is empty when the page has no usable `LAYERINFO`.
pub const IndexedLayer = struct {
    ref: LayerRef,
    name: []const u8 = "",
    is_current: bool = false,
};

/// v5 packed record in the `layers` blob, variable stride: u32 offset,
/// u32 length, u8 flags, u8 slot (wire id), u8 name_len, name bytes.
pub const layer_rec_head_size = 11;
/// Longest display name a record carries (`name_len` is one byte); longer truncates.
pub const max_layer_name = 255;
pub const max_layer_rec_size = layer_rec_head_size + max_layer_name;

// bit0/bit1 mirror the SNPG wire flags; bit2 is index-only; bit3 is the wire's
// bit2 (raster image), remapped by `page_payload.recordFlags` when serving.
const flag_all_blank: u8 = 0x01;
const flag_hidden: u8 = 0x02;
const flag_current: u8 = 0x04;
const flag_raster_image: u8 = 0x08;

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

// ---- parse: pure CPU, call outside the DB lock ----

pub fn parseBlob(gpa: Allocator, bytes: []const u8) Allocator.Error!Parsed {
    return parseBlobSource(gpa, sn.Source.fromSlice(bytes));
}

/// Derives the index rows for `src`. Never fails on bad input: anything that
/// does not parse or names an out-of-file range is `indexable = false`. Memory is
/// not proportional to file size; only recognition text is materialised.
pub fn parseBlobSource(gpa: Allocator, src: sn.Source) Allocator.Error!Parsed {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    // `null` == unindexable. Copy the arena into `Parsed` only at the end: an
    // `ArenaAllocator` value snapshots its state.
    const derived: ?struct { note: NoteRow, pages: []const PageRow } = derive: {
        var note = sn.parseSource(gpa, src) catch break :derive null;
        defer note.deinit();

        const dims = note.dimensions();
        const pages = try a.alloc(PageRow, note.pages.len);

        var recognized: u32 = 0;
        for (note.pages, 0..) |page, i| {
            // Validate every layer range against the file length, so no stored
            // offset can read past EOF at serve time.
            var refs_buf: [max_layers]LayerRef = undefined;
            const refs = sn.page_payload.emitLayers(note, i, &refs_buf) catch break :derive null;
            for (refs) |r| {
                if (@as(u64, r.offset) + r.len > src.size()) break :derive null;
            }

            // Join each ref to its LAYERINFO entry by slot for name + isCurrent.
            const indexed = try a.alloc(IndexedLayer, refs.len);
            for (refs, indexed) |r, *il| {
                il.* = .{ .ref = r };
                if (page.infoForSlot(r.slot)) |info| {
                    const cap = @min(info.name.len, max_layer_name);
                    il.name = try a.dupe(u8, info.name[0..cap]);
                    il.is_current = info.is_current;
                }
            }

            // Swapped for a 1090 (landscape) page; see `noteHeader`.
            const eff = dims.oriented(page.orientation());

            // Custom-style page whose background does not total as RATTA_RLE is a
            // raster image template: mark it `raster_image` and record
            // `PAGESTYLEMD5` as `bg_hash`. Streamed, one chunk of RSS.
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
                .source_page = page.number,
                .content_hash = pageContentHash(src, page) catch break :derive null,
                .width = eff.width,
                .height = eff.height,
                .layers = indexed,
                .recogn_status = page.recognitionStatus(),
                .bg_hash = bg_hash,
                // Computed at ingest: the client's virtualised strip only sees
                // the rows on screen.
                .has_ink = inkscan.pageHasInk(src, refs),
            };

            // Recognition: plain transcript for search, raw range for re-reading
            // elements and bounding boxes later.
            const addr = page.recognitionAddress();
            if (row.recogn_status == 1 and addr != 0) {
                // The one materialised block (KB-scale, needed contiguous for md5
                // and JSON). Freed before the next page.
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

            // PDF-template links: range + md5 only (the md5 is the serve `?v=`);
            // records are decoded at serve time.
            const links_addr = page.linksAddress();
            if (links_addr != 0) {
                const held = src.blockHeld(gpa, links_addr) catch break :derive null;
                defer held.deinit(gpa);
                // A zero-length block claims no hash: `links_hash != NULL` is the
                // page list's "has links" signal.
                if (held.bytes.len != 0) {
                    row.links_offset = @intCast(links_addr + 4);
                    row.links_length = @intCast(held.bytes.len);
                    row.links_hash = md5Hex(held.bytes);
                }
            }
            pages[i] = row;
        }

        // The device cover (newest-wins `COVER_3`/`2`/`1`): record its location
        // and MIME, never its bytes. Best-effort: absent, oversized (checked from
        // the length prefix before any body read), unreadable or unrecognised is
        // "no cover". Undecodable dims record 0, not NULL.
        var cover_offset: ?u64 = null;
        var cover_length: ?u32 = null;
        var cover_mime: ?[]const u8 = null;
        var cover_w: ?u32 = null;
        var cover_h: ?u32 = null;
        cover_blk: {
            const addr = note.coverAddress() orelse break :cover_blk;
            const range = src.blockRange(addr) catch break :cover_blk; // prefix only
            if (range.len == 0 or range.len > thumbnail.max_cover_bytes) break :cover_blk;
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
                // X-series only: on ASA the slice is the front of the signature
                // ("SN_F"), not a marker.
                .filetype = if (note.signature.family == .x_series)
                    try a.dupe(u8, note.signature.filetype)
                else
                    null,
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

/// md5 over the page's layer bitmap bytes (metadata entries if it has none): the
/// browser's immutable `?v=` key. The control plane calls this same function, so
/// every cached URL stays valid. Streamed in `hash_chunk_len` chunks; an I/O
/// failure propagates rather than store a half-hashed key.
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

/// True when the background block does not decode as RATTA_RLE of exactly
/// `expected_pixels`, i.e. it is an image template. Streams through
/// `RleTotalizer` and bails on overflow, so it costs one chunk. A read error
/// counts as "not an image".
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

// ---- layer packing ----

/// Packs `layers` into the v5 `layers` blob. Order is load-bearing: serving
/// replays it verbatim.
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

/// One record read back. `name` borrows the blob (statement memory): dupe it.
pub const LayerRecord = struct {
    ref: LayerRef,
    name: []const u8,
    is_current: bool,
};

/// Inverse of `packLayers`; rejects a malformed blob rather than trusting it.
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
        s.bindTextOpt(20, p.note.filetype);
        _ = try s.step();
    }

    var layer_buf: [max_layers * max_layer_rec_size]u8 = undefined;
    for (p.pages) |page| try upsertPage(db, blob_md5, page, &layer_buf);

    // Drop any tail from a previous shape. Scoped to `kind = 0`: for a blob the
    // note parser rejected `page_count` is 0, so unscoped this would drop every
    // other format's rows.
    {
        var s = try db.prepare(
            "DELETE FROM note_page_index WHERE blob_md5 = ?1 AND page_index >= ?2 AND kind = 0;",
        );
        defer s.finalize();
        s.bindText(1, blob_md5);
        s.bindInt(2, p.note.page_count);
        _ = try s.step();
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

// ---- serving a page from the index ----

/// Layer bytes from a whole-blob slice; the buffering source for
/// `serializeFromIndex`.
pub const SliceSource = struct {
    bytes: []const u8,

    pub fn read(self: SliceSource, offset: u32, len: u32) Error![]const u8 {
        if (@as(u64, offset) + len > self.bytes.len) return error.BadRange;
        return self.bytes[offset..][0..len];
    }
};

/// The note-level facts an SNPG header needs. `width`/`height` are base dims.
///
/// A `1090` (landscape) page's RLE raster is stored natively landscape (row width
/// = swapped base width), so effective dims are stored per page and used by both
/// `pagePlan`'s header and `noteMeta`. Decoding at the wrong width shears
/// silently.
pub const NoteHeader = struct { width: u32, height: u32, rle_variant: u8, page_count: u32 };

pub fn noteHeader(db: sqlite.Db, blob_md5: []const u8) !?NoteHeader {
    var r = (try db.row(
        "SELECT width, height, rle_variant, page_count FROM note_index " ++
            "WHERE blob_md5 = ?1 AND indexable = 1 AND index_version = ?2;",
        &.{ .{ .text = blob_md5 }, .{ .int = index_version } },
    )) orelse return null;
    defer r.finalize();
    return .{
        .width = @intCast(r.int(0)),
        .height = @intCast(r.int(1)),
        .rle_variant = @intCast(r.int(2)),
        .page_count = @intCast(r.int(3)),
    };
}

// `PagePlan` below has inline storage and no borrows: it is built in a narrow
// lock window and the page is streamed after the lock is released.
/// Bound on a page's inline asset hash (`PAGESTYLEMD5` is 32 hex).
pub const max_bg_hash: usize = 64;

pub const PagePlan = struct {
    header: [sn.page_payload.HEADER_SIZE]u8,
    layer_buf: [max_layers]LayerRef,
    layer_count: u8,
    /// Content md5 (hex): the `?v=` version and the `ETag`.
    content_hash: [32]u8,
    /// Exact payload size, known without file I/O.
    content_length: u64,
    /// A `raster_image` background's asset hash, sent on the wire in place of
    /// the image bytes. Empty otherwise.
    bg_hash_buf: [max_bg_hash]u8 = undefined,
    bg_hash_len: u8 = 0,

    pub fn layers(self: *const PagePlan) []const LayerRef {
        return self.layer_buf[0..self.layer_count];
    }

    pub fn bgHash(self: *const PagePlan) []const u8 {
        return self.bg_hash_buf[0..self.bg_hash_len];
    }

    pub fn wireLen(self: *const PagePlan, r: LayerRef) u64 {
        return if (r.raster_image) self.bg_hash_len else r.len;
    }
};

/// Resolves a page into a `PagePlan`: the only DB access in page serving. Null
/// when the blob has no current index row or the page is out of range.
pub fn pagePlan(db: sqlite.Db, blob_md5: []const u8, page_index: u64) !?PagePlan {
    const head = (try noteHeader(db, blob_md5)) orelse return null;

    var plan: PagePlan = .{
        .header = undefined,
        .layer_buf = undefined,
        .layer_count = 0,
        .content_hash = undefined,
        .content_length = sn.page_payload.HEADER_SIZE,
    };

    // Effective dims come from the page row; the note row gives the RLE variant.
    var page_dims: [2]u32 = undefined;
    const refs = blk: {
        var r = (try db.row(
            "SELECT layers, content_hash, width, height, bg_hash FROM note_page_index " ++
                "WHERE blob_md5 = ?1 AND page_index = ?2;",
            &.{ .{ .text = blob_md5 }, .{ .int = @intCast(page_index) } },
        )) orelse return null;
        defer r.finalize();
        const refs = try unpackLayers(r.blob(0), &plan.layer_buf);
        const hash = r.text(1);
        if (hash.len != plan.content_hash.len) return error.NotIndexed;
        @memcpy(&plan.content_hash, hash); // copied out: the statement dies below
        page_dims = .{ @intCast(r.int(2)), @intCast(r.int(3)) };
        // Copied inline: statement memory dies at the `defer`.
        if (!r.isNull(4)) {
            const bg = r.text(4);
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

/// Where a custom image template sits in the blob, by asset `hash`, for
/// `GET /note/{id}/template/{hash}`. Every page sharing a template points at the
/// same block, so `LIMIT 1` is exact. Null for an unknown hash.
pub const TemplateLocation = struct { offset: u64, length: u64 };

pub fn templateLocation(db: sqlite.Db, blob_md5: []const u8, hash: []const u8) !?TemplateLocation {
    var row = (try db.row(
        "SELECT layers FROM note_page_index WHERE blob_md5 = ?1 AND bg_hash = ?2 LIMIT 1;",
        &.{ .{ .text = blob_md5 }, .{ .text = hash } },
    )) orelse return null;
    defer row.finalize();
    var buf: [max_layers]LayerRef = undefined;
    const refs = unpackLayers(row.blob(0), &buf) catch return null;
    for (refs) |r| {
        if (r.raster_image) return .{ .offset = r.offset, .length = @intCast(r.len) };
    }
    return null;
}

/// The SNPG header from stored columns (variant from the note row, dims from the
/// page row); the one place those 20 bytes are produced.
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

/// A record's 6-byte SNPG v2 head. `wire_len` is the hash length for a
/// `raster_image` background, else `r.len`.
fn layerHead(r: LayerRef, wire_len: u64) [sn.page_payload.LAYER_HEADER_SIZE]u8 {
    var h: [sn.page_payload.LAYER_HEADER_SIZE]u8 = undefined;
    h[0] = sn.page_payload.recordFlags(r);
    h[1] = r.slot.wireId();
    std.mem.writeInt(u32, h[2..6], @intCast(wire_len), .little);
    return h;
}

/// Streams `plan`'s SNPG payload to `out` in `chunk_len` windows; never
/// materialises it. DB-free: call with the lock released. Ranges come from
/// device metadata, so `readRange` re-validates each window.
pub fn streamPage(
    blobs: blobstore.BlobStore,
    blob_md5: []const u8,
    plan: PagePlan,
    out: *std.Io.Writer,
) !void {
    var chunk: [blobstore.chunk_len]u8 = undefined;
    try out.writeAll(&plan.header);
    for (plan.layers()) |r| {
        // A raster background sends its asset hash, never the image bytes.
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

/// The buffering counterpart of `streamPage`: header plus stored layer blocks in
/// stored order. Kept for the golden test.
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

// ---- tests ----

const testing = std.testing;
const schema = @import("../db/schema.zig");
const filesvc = @import("files.zig");
const nb = @import("note_builder");

/// Real device captures; local fixtures, not redistributed.
const sample = @embedFile("sample.note");
const sample2 = @embedFile("sample-2.note");
/// Page 1 `#`-JSON LAYERINFO; page 2 base64 with a hidden Layer 2, a renamed
/// top layer, layerId -1 background.
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

/// A bare blob store on a temp dir, no database.
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
    fn source(b: *Blobs, md5: *const [blobstore.md5_hex_len]u8, out: *blob_source.BlobSource) !sn.Source {
        out.* = try blob_source.BlobSource.init(b.store, md5);
        return out.source();
    }
};

/// Records peak live bytes, to prove the blob path does not buffer.
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
        try testing.expectEqual(w.links_offset, g.links_offset);
        try testing.expectEqual(w.links_length, g.links_length);
        try testing.expectEqual(w.links_hash, g.links_hash);
        try testing.expectEqual(w.recogn_offset, g.recogn_offset);
        try testing.expectEqual(w.recogn_length, g.recogn_length);
        try testing.expectEqual(w.text_hash == null, g.text_hash == null);
        if (w.text_hash) |*h| try testing.expectEqualStrings(h, &g.text_hash.?);
        try expectSameOptStr(w.text, g.text);
    }
}

/// Indexes `bytes` under `md5` into `db`, blobs row included so the FK holds.
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

/// `page_payload.serialize`, `serializeFromIndex` and `streamPage` (off a real
/// blob) must agree byte for byte on every page, and equal the plan's
/// `content_length`.
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

    // A 0x140e-byte BGLAYER on a white-style page takes the blank-background
    // shortcut.
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

    try testing.expect(try ps.step());
    try testing.expectEqual(@as(i64, 2), ps.columnInt(3));
    try testing.expect(ps.columnIsNull(4));
    try testing.expect(ps.columnIsNull(5));
    try testing.expect(ps.columnIsNull(7));

    var note = try sn.parse(gpa, sample2);
    defer note.deinit();
    ps.reset();
    ps.bindText(1, &md5);
    try testing.expect(try ps.step());
    try testing.expectEqualStrings(&try pageContentHash(sn.Source.fromSlice(sample2), note.pages[0]), ps.columnText(0));
}

test "a truncated or corrupt note is refused at index time, never read past EOF" {
    const gpa = testing.allocator;

    // 1. Truncated: the footer address is in the last 4 bytes.
    {
        var p = try parseBlob(gpa, sample2[0 .. sample2.len / 2]);
        defer p.deinit();
        try testing.expect(!p.indexable);
        try testing.expectEqual(@as(usize, 0), p.pages.len);
    }

    // 2. A layer block claims a length past EOF; the container still parses,
    //    so only offset validation catches it.
    {
        const rle = [_]u8{ 0xAB, 0xCD, 0xEF, 0x42 };
        const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
            .{ .slot = .main, .bitmap = &rle },
        } }} });
        defer gpa.free(bytes);

        {
            var ok = try parseBlob(gpa, bytes);
            defer ok.deinit();
            try testing.expect(ok.indexable);
        }

        // The u32 length prefix sits 4 bytes before the RLE payload.
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

    var src = SliceSource{ .bytes = "short" };
    try testing.expectError(error.BadRange, src.read(0, 99));
}

test "a non-.note blob is marked unindexable once and never reparsed" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("photo.jpg", "\xff\xd8\xff\xe0 not a supernote file at all");

    var s = try f.db.prepare("SELECT indexable, page_count, index_version, indexed_at FROM note_index WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, &md5);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 0), s.columnInt(0));
    try testing.expectEqual(@as(i64, 0), s.columnInt(1));
    try testing.expectEqual(index_version, s.columnInt(2));
    const first_indexed_at = s.columnInt(3);

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

    try f.db.exec("DELETE FROM note_index;");
    try testing.expectEqual(@as(i64, 0), try f.countRows("SELECT COUNT(*) FROM note_page_index;")); // cascaded
    try testing.expect(!try isCurrent(f.db, &md5));

    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 100);
    try testing.expect(try isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    // Page rowids stay stable across a re-index.
    const rowid_before = try f.countRows("SELECT id FROM note_page_index ORDER BY page_index LIMIT 1;");

    for (0..3) |_| try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 200);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(rowid_before, try f.countRows("SELECT id FROM note_page_index ORDER BY page_index LIMIT 1;"));

    try f.db.exec("UPDATE note_index SET index_version = 0, page_count = 0;");
    try testing.expect(!try isCurrent(f.db, &md5));
    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 300);
    try testing.expect(try isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT page_count FROM note_index;"));
    try testing.expectEqual(rowid_before, try f.countRows("SELECT id FROM note_page_index ORDER BY page_index LIMIT 1;"));

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

    _ = try f.put("a.note", sample2);
    _ = try f.put("b.note", sample2);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

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

        var from_slice = try parseBlob(gpa, bytes);
        defer from_slice.deinit();
        var from_blob = try parseBlobSource(gpa, ranged);
        defer from_blob.deinit();
        try testing.expect(from_slice.indexable);
        try expectSameParsed(from_slice, from_blob);

        // 2. A full page serialization over both sources proves `emitLayers` and
        //    `serialize` byte for byte.
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

    // 1. Truncated: the footer address is in the last 4 bytes.
    {
        const md5 = try b.put(sample2[0 .. sample2.len / 2]);
        var bs: blob_source.BlobSource = undefined;
        var p = try parseBlobSource(gpa, try b.source(&md5, &bs));
        defer p.deinit();
        try testing.expect(!p.indexable);
        try testing.expectEqual(@as(usize, 0), p.pages.len);
    }

    // 2. A layer block claims a length past EOF; only range validation sees it.
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

        var note = try sn.parseSource(gpa, ranged);
        defer note.deinit();
        var refs: [max_layers]LayerRef = undefined;
        try testing.expectError(error.Truncated, sn.page_payload.emitLayers(note, 0, &refs));
        try testing.expectError(error.Truncated, sn.page_payload.serialize(gpa, note, 0));

        var p = try parseBlobSource(gpa, ranged);
        defer p.deinit();
        try testing.expect(!p.indexable);
    }

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

    // 8 MiB in one layer: a buffering parse would peak above it.
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

    // Layers hash through a stack buffer, so peak stays small.
    try testing.expect(counter.peak < 64 * 1024);
    try testing.expect(counter.peak * 100 < bytes.len);

    var counter2 = PeakAllocator{ .child = gpa };
    var p2 = try parseBlob(counter2.allocator(), bytes);
    defer p2.deinit();
    try expectSameParsed(p, p2);
    try testing.expect(counter2.peak < 64 * 1024);
}

/// A note whose second page is landscape (`ORIENTATION = 1090`).
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

    // Guard against the builder silently dropping the key.
    {
        var note = try sn.parse(gpa, bytes);
        defer note.deinit();
        try testing.expectEqual(sn.Orientation.vertical, note.pages[0].orientation());
        try testing.expectEqual(sn.Orientation.horizontal, note.pages[1].orientation());
        try testing.expectEqualStrings("1090", note.pages[1].orientationRaw().?);
    }

    const md5 = blobstore.md5HexOf(bytes);
    try indexInto(db, &md5, bytes);

    // A landscape page stores its effective (swapped) dims; base dims shear a
    // real 1090 page.
    const want = [2][2]i64{ .{ 1404, 1872 }, .{ 1872, 1404 } };
    var s = try db.prepare("SELECT width, height FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;");
    defer s.finalize();
    s.bindText(1, &md5);
    for (want) |dims| {
        try testing.expect(try s.step());
        try testing.expectEqual(dims[0], s.columnInt(0));
        try testing.expectEqual(dims[1], s.columnInt(1));
    }

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

    // Regress to v2's shape: stale version, base dims on every page.
    try f.db.exec("UPDATE note_index SET index_version = 2;");
    try f.db.exec("UPDATE note_page_index SET width = 1404, height = 1872;");
    try testing.expect(!try isCurrent(f.db, &md5));

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

    // 128 chunks, so window boundaries are exercised.
    const big = try gpa.alloc(u8, 8 * 1024 * 1024);
    defer gpa.free(big);
    for (big, 0..) |*byte, i| byte.* = @truncate(i * 31 + 7); // not memset: catches a misordered window
    const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
        .{ .slot = .main, .bitmap = big },
    } }} });
    defer gpa.free(bytes);

    const md5 = try b.put(bytes);
    try indexInto(db, &md5, bytes);

    const plan = (try pagePlan(db, &md5, 0)).?;
    const expected = sn.page_payload.HEADER_SIZE + sn.page_payload.LAYER_HEADER_SIZE + big.len;
    try testing.expectEqual(@as(u64, expected), plan.content_length);
    try testing.expect(expected > 100 * blobstore.chunk_len);

    var sink = HashingSink.init();
    try streamPage(b.store, &md5, plan, &sink.writer);
    try testing.expectEqual(@as(u64, expected), sink.total);

    var note = try sn.parse(gpa, bytes);
    defer note.deinit();
    const reference = try sn.page_payload.serialize(gpa, note, 0);
    defer gpa.free(reference);
    try testing.expectEqualStrings(&md5Hex(reference), &sink.digest());
}

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

    var ref_buf: [max_layers]LayerRef = undefined;
    const refs = try unpackLayers(packed_bytes, &ref_buf);
    for (layers, refs) |want, r| try testing.expectEqual(want.ref, r);

    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(packed_bytes[0 .. packed_bytes.len - 1], &out));
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(packed_bytes[0..5], &out));
    var too_many: [(max_layers + 1) * layer_rec_head_size]u8 = @splat(0);
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(&too_many, &out));
    var bad_slot: [layer_rec_head_size]u8 = @splat(0);
    bad_slot[9] = 0xEE;
    try testing.expectError(error.BadLayerBlob, unpackLayerRecords(&bad_slot, &out));

    const long_name = repeat(u8, "n", 300);
    const long = [_]IndexedLayer{.{ .ref = .{ .offset = 1, .len = 2, .slot = .main, .all_blank = false, .hidden = false }, .name = long_name }};
    const packed_long = packLayers(&buf, &long);
    const got_long = try unpackLayerRecords(packed_long, &out);
    try testing.expectEqual(@as(usize, max_layer_name), got_long[0].name.len);
}

const mini_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

/// A `.mark`: a `.note` with a different 4-byte marker.
fn markFile(a: Allocator) ![]u8 {
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(a, .{
        .filetype = "mark",
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
    });
}

test "the signature's file-type marker is recorded, so a .mark is distinguishable from a .note" {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    // `detect()` never gates on the marker, so only the recorded marker tells a
    // `.mark` from a note.
    {
        const bytes = try markFile(gpa);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.indexable);
        try testing.expect(p.note.page_count == 1);
        try testing.expectEqualStrings("mark", p.note.filetype.?);

        const md5 = blobstore.md5HexOf(bytes);
        try indexInto(db, &md5, bytes);
        var r = (try db.row(
            "SELECT filetype FROM note_index WHERE blob_md5 = ?1;",
            &.{.{ .text = &md5 }},
        )).?;
        defer r.finalize();
        try testing.expectEqualStrings("mark", r.text(0));
    }

    {
        const bytes = try coveredNote(gpa, null);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expectEqualStrings("note", p.note.filetype.?);
    }
}

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

    // A real cover: location recorded (offset + length + mime), not bytes.
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

        const loc = (try coverLocation(db, &md5)).?;
        try testing.expectEqual(@as(u64, at), loc.offset);
        try testing.expectEqual(@as(u64, mini_png.len), loc.length);
        try testing.expectEqualStrings("image/png", loc.mime());
    }

    // Coverless: NULL, distinct from 0.
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

    // PNG magic, corrupt IHDR: still served, dims record 0.
    {
        const corrupt_png = "\x89PNG\r\n\x1a\n" ++ "\x00\x00\x00\x0d" ++ "NOPE" ++ (repeat(u8, "z", 16));
        const bytes = try coveredNote(gpa, corrupt_png);
        defer gpa.free(bytes);
        var p = try parseBlob(gpa, bytes);
        defer p.deinit();
        try testing.expect(p.note.cover_offset != null);
        try testing.expectEqualStrings("image/png", p.note.cover_mime.?);
        try testing.expectEqual(@as(?u32, 0), p.note.cover_w);
        try testing.expectEqual(@as(?u32, 0), p.note.cover_h);
    }

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

    // Past the old 2 MB thumbnail cap (a real cover ran to 6.5 MB), and at the
    // 20 MB ceiling.
    for ([_]usize{ 3 * 1024 * 1024, thumbnail.max_cover_bytes }) |cover_len| {
        const cover = try gpa.alloc(u8, cover_len);
        defer gpa.free(cover);
        @memset(cover, 0x7e);
        @memcpy(cover[0..8], "\x89PNG\r\n\x1a\n");
        @memcpy(cover[8..12], "\x00\x00\x00\x0d");
        @memcpy(cover[12..16], "IHDR");
        std.mem.writeInt(u32, cover[16..20][0..4], 1404, .big);
        std.mem.writeInt(u32, cover[20..24][0..4], 1872, .big);

        const bytes = try coveredNote(gpa, cover);
        defer gpa.free(bytes);

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
        // Only the 64 KiB header window and metadata are allocated.
        try testing.expect(peak.peak < cover_len);
        try testing.expect(peak.peak <= cover_header_probe + 512 * 1024);

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

    // A `.note` cover streams from the blob, so ingest writes no thumbs file.
    try testing.expect(!f.files.thumbs.has(&md5));
    try testing.expect(!try needsRepair(f.db, f.files.thumbs, &md5));
    try testing.expect((try coverLocation(f.db, &md5)) != null); // resolvable from the row

    // Built from `index_version` so a later bump does not pin a stale number.
    try f.db.exec("UPDATE note_index SET index_version = 9;");
    try testing.expect(try needsRepair(f.db, f.files.thumbs, &md5));
    {
        var buf: [64]u8 = undefined;
        const sql = try std.fmt.bufPrintSentinel(&buf, "UPDATE note_index SET index_version = {d};", .{index_version}, 0);
        try f.db.exec(sql);
    }
    try testing.expect(!try needsRepair(f.db, f.files.thumbs, &md5));

    // A current coverless row is a memoised 404.
    const coverless = try coveredNote(gpa, null);
    defer gpa.free(coverless);
    const md5_2 = try f.put("coverless.note", coverless);
    try testing.expect(!try needsRepair(f.db, f.files.thumbs, &md5_2));
    try testing.expect((try coverLocation(f.db, &md5_2)) == null);

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

    // Regress to the pre-cover-location shape (the 9->10 upgrade).
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
            rec[8] = if (il.ref.all_blank) flag_all_blank else 0;
        }
        var s = try f.db.prepare("UPDATE note_page_index SET layers = ?1 WHERE page_index = 1;");
        defer s.finalize();
        s.bindBlob(1, old_blob[0 .. layers.len * 9]);
        _ = try s.step();
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

    var hidden_count: usize = 0;
    for (plan.layers()) |r| {
        if (r.hidden) {
            hidden_count += 1;
            try testing.expectEqual(sn.types.LayerSlot.layer2, r.slot);
        }
    }
    try testing.expectEqual(@as(usize, 1), hidden_count);

    // The hidden stream rides the wire without touching the default composite.
    const payload = try serializeFromIndex(gpa, db, &md5, 1, SliceSource{ .bytes = layers_edited });
    defer gpa.free(payload);
    const rgba = try sn.page_payload.decodeRgba(gpa, payload);
    defer rgba.deinit(gpa);

    var note = try sn.parse(gpa, layers_edited);
    defer note.deinit();
    const gray = try sn.renderPageGray(gpa, note, 1);
    defer gray.deinit(gpa);
    for (gray.pixels, 0..) |g, i| try testing.expectEqual(g, rgba.pixels[i * 4]);

    const l2 = try sn.page_payload.decodeLayerRgba(gpa, payload, 2);
    defer l2.deinit(gpa);
    try testing.expectEqual(rgba.width, l2.width);
}

test "eager indexing at ingest does not disturb the file tree it rides along with" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("n.note", sample);
    try testing.expect(try isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT page_count FROM note_index;"));

    _ = try f.put("copy.note", sample);
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 1), try f.countRows("SELECT COUNT(*) FROM note_page_index;"));

    const entries = try f.files.list(1, null);
    defer filesvc.Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 2), entries.len);
    try testing.expectEqual(@as(i64, 2), try f.countRows("SELECT COUNT(*) FROM files;"));
}

// ---- custom image templates ----

/// PNG magic + IHDR: cannot decode as a full-page RATTA_RLE stream.
const fake_png = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52 };
/// A valid one-pair RATTA_RLE background (0x62 transparent, 0xFF special length).
const rle_bg = [_]u8{ 0x62, 0xFF };
const template_hash = "deadbeefdeadbeefdeadbeefdeadbeef";

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

/// Page 0 has a custom image background; page 1 is ordinary RLE.
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

    var sink = std.Io.Writer.Allocating.init(gpa);
    defer sink.deinit();
    try streamPage(f.files.blobs, &md5, plan, &sink.writer);
    const streamed = sink.written();
    const buffered = try serializeFromIndex(gpa, f.db, &md5, 0, SliceSource{ .bytes = bytes });
    defer gpa.free(buffered);
    try testing.expectEqualSlices(u8, buffered, streamed);
    try testing.expectEqual(plan.content_length, streamed.len);

    const bg = snpgRecordForSlot(streamed, sn.types.LayerSlot.background.wireId()).?;
    try testing.expect(bg.flags & sn.page_payload.FLAG_RASTER_IMAGE != 0);
    try testing.expectEqualStrings(template_hash, bg.data);
    try testing.expect(!std.mem.eql(u8, bg.data, &fake_png));

    const plan1 = (try pagePlan(f.db, &md5, 1)).?;
    var sink1 = std.Io.Writer.Allocating.init(gpa);
    defer sink1.deinit();
    try streamPage(f.files.blobs, &md5, plan1, &sink1.writer);
    const bg1 = snpgRecordForSlot(sink1.written(), sn.types.LayerSlot.background.wireId()).?;
    try testing.expect(bg1.flags & sn.page_payload.FLAG_RASTER_IMAGE == 0);
    try testing.expectEqualSlices(u8, &rle_bg, bg1.data);
}

test "ingest: a sparse .mark keeps the PDF pages it names; a notebook stays 1..N" {
    // A `.mark` holds only annotated pages, at positions 0, 1, 2 belonging to
    // PDF pages 2, 5, 6.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const mark = try nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{ .{ .number = 2 }, .{ .number = 5 }, .{ .number = 6 } },
    });
    defer gpa.free(mark);
    const md5 = try f.put("annotated.pdf.mark", mark);
    try testing.expect(try isCurrent(f.db, &md5));

    var s = try f.db.prepare(
        "SELECT page_index, source_page FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    const want = [_][2]i64{ .{ 0, 2 }, .{ 1, 5 }, .{ 2, 6 } };
    for (want) |w| {
        try testing.expect(try s.step());
        try testing.expectEqual(w[0], s.columnInt(0));
        try testing.expectEqual(w[1], s.columnInt(1));
    }
    try testing.expect(!try s.step());

    // A notebook's number is still position + 1.
    const book = try nb.serialize(gpa, .{ .pages = &.{ .{}, .{}, .{} } });
    defer gpa.free(book);
    const bmd5 = try f.put("book.note", book);
    var s2 = try f.db.prepare(
        "SELECT page_index, source_page FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s2.finalize();
    s2.bindText(1, &bmd5);
    var n: i64 = 0;
    while (try s2.step()) : (n += 1) {
        try testing.expectEqual(n, s2.columnInt(0));
        try testing.expectEqual(n + 1, s2.columnInt(1));
    }
    try testing.expectEqual(@as(i64, 3), n);
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
    var buf: [fake_png.len]u8 = undefined;
    const got = try f.files.blobs.readRange(&md5, loc.offset, loc.length, &buf);
    try testing.expectEqualSlices(u8, &fake_png, got);

    try testing.expect((try templateLocation(f.db, &md5, "00000000000000000000000000000000")) == null);
}
