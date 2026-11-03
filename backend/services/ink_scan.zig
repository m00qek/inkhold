//! Per-page `has_ink` classifier: computed at ingest, back-filled for older rows
//! by the deferred `ink` tenant from the stored layer ranges.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const blob_source = @import("../store/blob_source.zig");
const noteindex = @import("note_index.zig");
const sn = @import("supernote");

const Allocator = std.mem.Allocator;

const index_version = noteindex.index_version;
const LayerRef = noteindex.LayerRef;
const max_layers = noteindex.max_layers;
const unpackLayers = noteindex.unpackLayers;

/// Read window for the ink scan, deliberately not `hash_chunk_len`: the scan
/// stops at the first stroke, so the window fill dominates its cost. 4 KiB still
/// holds a fully blank layer of the largest panel (~600 B of RLE) in one read,
/// and an extra `readRange` costs ~100 us on the Pi 1.
const ink_chunk_len: usize = 4 * 1024;

/// True if any non-background layer has a non-transparent run; null if a layer
/// could not be read, so the tri-state column withholds an answer rather than
/// guess. The background is skipped by definition (a template is not ink);
/// hidden layers count, since their bitmap persists.
pub fn pageHasInk(src: sn.Source, layers: []const LayerRef) ?bool {
    var unreadable = false;
    for (layers) |ref| {
        if (ref.slot == .background) continue;
        if (layerHasInk(src, ref.offset, ref.len)) |inked| {
            if (inked) return true;
        } else unreadable = true;
    }
    // An unreadable layer only matters when nothing else answered yes.
    return if (unreadable) null else false;
}

/// One layer, streamed through `InkFinder` in `ink_chunk_len` windows. Null on
/// a read failure: storing `false` would claim a written page is empty.
fn layerHasInk(src: sn.Source, offset: u32, len: u32) ?bool {
    var f = sn.decoder.InkFinder.init();
    var chunk: [ink_chunk_len]u8 = undefined;
    var off: u64 = offset;
    var left: u64 = len;
    while (left > 0) {
        const n: usize = @intCast(@min(left, @as(u64, chunk.len)));
        src.read(off, chunk[0..n]) catch return null;
        f.feed(chunk[0..n]);
        if (f.found) return true; // the rest of the layer is never read
        off += n;
        left -= n;
    }
    return f.done();
}

// ---- has_ink back-fill ----

/// The `ink` tenant's FROM/WHERE (aliases `f`, `b`, `ni`; ?1 = note index
/// version): live `.note` blobs with a page whose `has_ink` is still NULL.
/// Shared by `deferred.zig` and `pending.zig` so they agree; callers may only
/// add a bound. Requires a current `note_index` row, because the note re-index
/// rewrites `has_ink` itself.
pub const ink_pending_from_where =
    \\  FROM files f
    \\  JOIN blobs b ON b.md5 = f.md5
    \\  JOIN note_index ni ON ni.blob_md5 = f.md5
    \\ WHERE f.is_folder = 0
    \\   AND f.deleted = 0
    \\   AND f.md5 IS NOT NULL
    \\   AND ni.index_version = ?1
    \\   AND ni.indexable = 1
    \\   AND EXISTS (SELECT 1 FROM note_page_index p
    \\               WHERE p.blob_md5 = f.md5 AND p.kind = 0 AND p.has_ink IS NULL)
;

/// Whether this blob still has unscanned pages; re-checked under the lock.
/// False for a missing or stale `note_index` row (the note re-index fills it).
pub fn inkNeedsScan(db: sqlite.Db, blob_md5: []const u8) !bool {
    const r = (try db.row(
        "SELECT 1 FROM note_page_index p JOIN note_index ni ON ni.blob_md5 = p.blob_md5 " ++
            "WHERE p.blob_md5 = ?1 AND ni.index_version = ?2 AND ni.indexable = 1 " ++
            "AND p.kind = 0 AND p.has_ink IS NULL LIMIT 1;",
        &.{ .{ .text = blob_md5 }, .{ .int = index_version } },
    )) orelse return false;
    r.finalize();
    return true;
}

/// One blob's outstanding pages, lifted out of the database so the scan can run
/// off the lock. Carries the packed layer records, so no `.note` parse is needed.
pub const InkScan = struct {
    arena: std.heap.ArenaAllocator,
    pages: []Page,

    pub const Page = struct {
        page_index: u32,
        /// Copied into the arena; the row's memory dies with the statement.
        layers: []const u8,
        /// Null leaves the row NULL, to be asked again.
        has_ink: ?bool = null,
    };

    pub fn deinit(self: *InkScan) void {
        self.arena.deinit();
    }
};

/// The pages of `blob_md5` still at `has_ink IS NULL`. Caller holds the lock.
pub fn pendingInk(gpa: Allocator, db: sqlite.Db, blob_md5: []const u8) !InkScan {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    var out: std.ArrayList(InkScan.Page) = .empty;
    var s = try db.prepare(
        "SELECT page_index, layers FROM note_page_index " ++
            "WHERE blob_md5 = ?1 AND kind = 0 AND has_ink IS NULL ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, blob_md5);
    while (try s.step()) {
        try out.append(a, .{
            .page_index = @intCast(s.columnInt(0)),
            .layers = try a.dupe(u8, s.columnBlob(1)),
        });
    }
    return .{ .arena = arena, .pages = out.items };
}

/// Answer every outstanding page. Call without the lock. Never fails: an
/// unreadable blob or record leaves the answer null.
pub fn scanInk(blobs: blobstore.BlobStore, md5: []const u8, scan: *InkScan) void {
    var bs = blob_source.BlobSource.init(blobs, md5) catch return;
    const src = bs.source();
    var buf: [max_layers]LayerRef = undefined;
    for (scan.pages) |*p| {
        const refs = unpackLayers(p.layers, &buf) catch continue;
        p.has_ink = pageHasInk(src, refs);
    }
}

/// Write what the scan learned, inside the caller's transaction. The
/// `has_ink IS NULL` guard keeps a fresher answer from a concurrent re-index.
pub fn storeInk(db: sqlite.Db, blob_md5: []const u8, scan: InkScan) !void {
    var s = try db.prepare(
        "UPDATE note_page_index SET has_ink = ?3 " ++
            "WHERE blob_md5 = ?1 AND page_index = ?2 AND kind = 0 AND has_ink IS NULL;",
    );
    defer s.finalize();
    for (scan.pages) |p| {
        const v = p.has_ink orelse continue;
        s.reset();
        s.bindText(1, blob_md5);
        s.bindInt(2, p.page_index);
        s.bindInt(3, if (v) 1 else 0);
        _ = try s.step();
    }
}

test {
    _ = @import("ink_scan_test.zig");
}

// ---- tests of private helpers ----

const testing = std.testing;

test "has_ink stops at the FIRST stroke — the layer's tail is never read" {
    // A source that counts bytes: a stroke in the first pair of a 1 MB layer
    // costs one chunk.
    const Counting = struct {
        bytes: []const u8,
        read_total: u64 = 0,

        fn readFn(ctx: *anyopaque, offset: u64, dest: []u8) sn.source.Error!void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (offset + dest.len > self.bytes.len) return error.OutOfBounds;
            @memcpy(dest, self.bytes[@intCast(offset)..][0..dest.len]);
            self.read_total += dest.len;
        }
        fn source(self: *@This()) sn.Source {
            return .{ .ranged = .{ .ctx = self, .size = self.bytes.len, .readFn = readFn } };
        }
    };

    const gpa = testing.allocator;
    const big = 1 << 20;
    const layer = try gpa.alloc(u8, big);
    defer gpa.free(layer);
    var i: usize = 0;
    while (i + 1 < layer.len) : (i += 2) {
        layer[i] = 0x62;
        layer[i + 1] = 0xFF;
    }

    {
        var c = Counting{ .bytes = layer };
        try testing.expectEqual(@as(?bool, false), layerHasInk(c.source(), 0, @intCast(layer.len)));
        try testing.expectEqual(@as(u64, layer.len), c.read_total);
    }

    {
        layer[0] = 0x61;
        var c = Counting{ .bytes = layer };
        try testing.expectEqual(@as(?bool, true), layerHasInk(c.source(), 0, @intCast(layer.len)));
        try testing.expectEqual(@as(u64, ink_chunk_len), c.read_total);
        try testing.expect(c.read_total < layer.len);
    }
}

test "has_ink: an unreadable layer is NULL, not 0 — the third state is what stops the lie" {
    const Broken = struct {
        fn readFn(_: *anyopaque, _: u64, _: []u8) sn.source.Error!void {
            return error.ReadFailed;
        }
        fn source(self: *@This()) sn.Source {
            return .{ .ranged = .{ .ctx = self, .size = 1024, .readFn = readFn } };
        }
    };
    var b = Broken{};
    const src = b.source();

    try testing.expectEqual(@as(?bool, null), layerHasInk(src, 0, 16));
    try testing.expectEqual(@as(?bool, null), pageHasInk(src, &.{
        .{ .offset = 0, .len = 16, .slot = .main, .all_blank = false, .hidden = false },
    }));
    // No non-background layer at all is honestly empty.
    try testing.expectEqual(@as(?bool, false), pageHasInk(src, &.{
        .{ .offset = 0, .len = 16, .slot = .background, .all_blank = false, .hidden = false },
    }));
    try testing.expectEqual(@as(?bool, false), pageHasInk(src, &.{}));
}
