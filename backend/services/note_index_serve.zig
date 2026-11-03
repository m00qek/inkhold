//! Serving a page from the index: header, page plan, templates and the SNPG stream.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const sn = @import("supernote");
const schema = @import("../db/schema.zig");
const nb = @import("note_builder");
const fixture = @import("note_index/fixture.zig");
const Md5 = std.crypto.hash.Md5;
const Allocator = std.mem.Allocator;
const testing = std.testing;
const Blobs = fixture.Blobs;
const indexInto = fixture.indexInto;
const note_index = @import("note_index.zig");
const note_index_parse = @import("note_index_parse.zig");
const Error = note_index.Error;
const LayerRef = note_index.LayerRef;
const hexEncode = note_index_parse.hexEncode;
const index_version = note_index.index_version;
const max_layers = note_index.max_layers;
const md5Hex = note_index_parse.md5Hex;
const unpackLayers = note_index_parse.unpackLayers;

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
