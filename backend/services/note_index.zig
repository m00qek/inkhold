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
                .rle_variant = @backingInt(sn.page_payload.variantOf(note)),
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

test {
    _ = @import("note_index/index_test.zig");
    _ = @import("note_index/index_cover_test.zig");
    _ = @import("note_index/template_test.zig");
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
