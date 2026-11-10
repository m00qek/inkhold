//! Parsing a `.note` into index rows (pure CPU, outside the DB lock), and layer packing.

const std = @import("std");
const blobstore = @import("../../store/blobs.zig");
const blob_source = @import("../../store/blob_source.zig");
const thumbnail = @import("../thumbnail.zig");
const inkscan = @import("../ink_scan.zig");
const sn = @import("supernote");
const noteindex = @import("../note_index.zig");
const note_index_serve = @import("serve.zig");
const Md5 = std.crypto.hash.Md5;
const Allocator = std.mem.Allocator;
const Error = noteindex.Error;
const IndexedLayer = noteindex.IndexedLayer;
const LayerRef = noteindex.LayerRef;
const NoteRow = noteindex.NoteRow;
const PageRow = noteindex.PageRow;
const Parsed = noteindex.Parsed;
const isCurrent = noteindex.isCurrent;
const max_layers = noteindex.max_layers;
const noteHeader = note_index_serve.noteHeader;
const store = noteindex.store;

/// Bounds the memory a layer content hash costs.
const hash_chunk_len = blobstore.chunk_len;

/// Header window read from a cover block to sniff MIME and dims; the hard bound
/// on one cover's RSS at index time.
const cover_header_probe: usize = 64 * 1024;

/// v5 packed record in the `layers` blob, variable stride: u32 offset,
/// u32 length, u8 flags, u8 slot (wire id), u8 name_len, name bytes.
pub const layer_rec_head_size = 11;
/// Longest display name a record carries (`name_len` is one byte); longer truncates.
pub const max_layer_name = 255;
pub const max_layer_rec_size = layer_rec_head_size + max_layer_name;

// bit0/bit1 mirror the SNPG wire flags; bit2 is index-only; bit3 is the wire's
// bit2 (raster image), remapped by `page_payload.recordFlags` when serving.
pub const flag_all_blank: u8 = 0x01;
const flag_hidden: u8 = 0x02;
const flag_current: u8 = 0x04;
const flag_raster_image: u8 = 0x08;

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

            // Typed text boxes: never in the transcript, recognition on or off,
            // so they join the page's text here. Best-effort: strokes that do
            // not walk add nothing and never make the note unindexable.
            typed: {
                var boxes = sn.textbox.forParsedPage(gpa, src, page) catch |e| switch (e) {
                    error.OutOfMemory => return error.OutOfMemory,
                    else => break :typed,
                };
                defer boxes.deinit();
                if (boxes.boxes.len == 0) break :typed;
                const typed_text = try boxes.plainText(gpa);
                defer gpa.free(typed_text);
                row.text = if (row.text) |t|
                    (if (t.len == 0) try a.dupe(u8, typed_text) else try std.mem.concat(a, u8, &.{ t, "\n", typed_text }))
                else
                    try a.dupe(u8, typed_text);
                // The `?v=` key must change when either half does.
                var h = Md5.init(.{});
                if (row.text_hash) |*th| h.update(th);
                h.update("\x00typed\x00");
                h.update(typed_text);
                var digest: [Md5.digest_length]u8 = undefined;
                h.final(&digest);
                var hex: [32]u8 = undefined;
                hexEncode(&hex, &digest);
                row.text_hash = hex;
                // Searchable without recognition: counted like a recognised page.
                if (row.recogn_status != 1) recognized += 1;
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

pub fn md5Hex(data: []const u8) [32]u8 {
    var digest: [Md5.digest_length]u8 = undefined;
    Md5.hash(data, &digest, .{});
    var hex: [32]u8 = undefined;
    hexEncode(&hex, &digest);
    return hex;
}

pub fn hexEncode(out: []u8, bytes: []const u8) void {
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

// ---- tests of private helpers ----

const testing = std.testing;
const fixture = @import("fixture.zig");
const Blobs = fixture.Blobs;
const PeakAllocator = fixture.PeakAllocator;
const coveredNote = fixture.coveredNote;

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
