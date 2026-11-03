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

// ---- tests ----

const testing = std.testing;
const schema = @import("../db/schema.zig");
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const nb = @import("note_builder");

const ensureIndexed = noteindex.ensureIndexed;
const LayerRecord = noteindex.LayerRecord;
const unpackLayerRecords = noteindex.unpackLayerRecords;

/// Real device captures; local fixtures, not redistributed.
const sample = @embedFile("sample.note");
const sample2 = @embedFile("sample-2.note");
/// Page 1 `#`-JSON LAYERINFO; page 2 base64 with a hidden Layer 2, a renamed
/// top layer, layerId -1 background.
const layers_edited = @embedFile("layers_edited.note");

/// PNG magic + IHDR marker for a synthetic image template, and its `PAGESTYLEMD5`.
const fake_png = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52 };
const template_hash = "deadbeefdeadbeefdeadbeefdeadbeef";

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

/// A blank layer: two long transparent runs.
const rle_blank = [_]u8{ 0x62, 0xFF, 0x62, 0xFF };
/// A stroke between transparent runs.
const rle_stroke = [_]u8{ 0x62, 0xFF, 0x61, 0x20, 0x62, 0xFF };
/// A stroke in white (`0x65`, opaque `0xFE`): a white pen is a pen.
const rle_white_pen = [_]u8{ 0x62, 0xFF, 0x65, 0x20, 0x62, 0xFF };
/// MAINLAYER hidden, in the device's `#`-JSON (`#` where JSON wants `:`).
const layerinfo_main_hidden =
    "[{\"layerId\"#0,\"name\"#\"Main\",\"isVisible\"#false,\"isDeleted\"#false}]";

fn inkNote(gpa: Allocator) ![]u8 {
    return nb.serialize(gpa, .{
        .pages = &.{
            // 0 — an all-transparent main layer. EMPTY.
            .{ .style = "style_white", .layers = &.{
                .{ .slot = .main, .bitmap = &rle_blank },
            } },
            // 1 — a stroke on the main layer. INKED.
            .{ .style = "style_white", .layers = &.{
                .{ .slot = .main, .bitmap = &rle_stroke },
            } },
            // 2 — image template, nothing written. EMPTY.
            .{ .style = "customImage", .style_md5 = template_hash, .layers = &.{
                .{ .slot = .background, .name = "BGLAYER", .bitmap = &fake_png },
            } },
            // 3 — hidden main layer with a stroke. INKED.
            .{ .style = "style_white", .layer_info = layerinfo_main_hidden, .layers = &.{
                .{ .slot = .main, .bitmap = &rle_stroke },
            } },
            // 4 — the only mark is the opaque near-white `0xFE`. INKED.
            .{ .style = "style_white", .layers = &.{
                .{ .slot = .main, .bitmap = &rle_white_pen },
            } },
            // 5 — RLE template full of marks, blank main layer. EMPTY.
            .{ .style = "style_white", .layers = &.{
                .{ .slot = .background, .name = "BGLAYER", .bitmap = &rle_stroke },
                .{ .slot = .main, .bitmap = &rle_blank },
            } },
        },
    });
}

test "ingest: has_ink is the mark on a NON-BACKGROUND layer — hidden counts, a template does not, 0xFE does" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try inkNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("ink.note", bytes);

    const want = [_]i64{ 0, 1, 0, 1, 1, 0 };
    var s = try f.db.prepare(
        "SELECT page_index, has_ink FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    var n: usize = 0;
    while (try s.step()) : (n += 1) {
        try testing.expectEqual(@as(i64, @intCast(n)), s.columnInt(0));
        // Never NULL at ingest.
        try testing.expect(!s.columnIsNull(1));
        try testing.expectEqual(want[n], s.columnInt(1));
    }
    try testing.expectEqual(want.len, n);

    // Page 3 must really be hidden, or it proves nothing beyond page 1.
    var l = try f.db.prepare("SELECT layers FROM note_page_index WHERE blob_md5 = ?1 AND page_index = 3;");
    defer l.finalize();
    l.bindText(1, &md5);
    try testing.expect(try l.step());
    var recs: [max_layers]LayerRecord = undefined;
    const got = try unpackLayerRecords(l.columnBlob(0), &recs);
    try testing.expectEqual(@as(usize, 1), got.len);
    try testing.expectEqual(sn.types.LayerSlot.main, got[0].ref.slot);
    try testing.expect(got[0].ref.hidden);
}

test "has_ink AGREES WITH THE DECODER, on every page of every real capture" {
    // Compared against a full pixel decode on real captures: synthetic streams
    // share the finder's own understanding.
    const gpa = testing.allocator;
    for ([_][]const u8{ sample, sample2, layers_edited }) |bytes| {
        var note = try sn.parse(gpa, bytes);
        defer note.deinit();
        const src = sn.Source.fromSlice(bytes);
        const variant = sn.page_payload.variantOf(note);
        const dims = note.dimensions();

        for (note.pages, 0..) |page, i| {
            var refs_buf: [max_layers]LayerRef = undefined;
            const refs = try sn.page_payload.emitLayers(note, i, &refs_buf);
            const eff = dims.oriented(page.orientation());

            var painted = false;
            for (refs) |r| {
                if (r.slot == .background) continue;
                const data = src.view(r.offset, r.len).?;
                const gray = try sn.decoder.decode(gpa, variant, data, eff.width, eff.height, r.all_blank);
                defer gpa.free(gray);
                // 0xFF is the transparent sentinel; `0xFE` is paint.
                for (gray) |px| {
                    if (px != 0xFF) {
                        painted = true;
                        break;
                    }
                }
                if (painted) break;
            }
            try testing.expectEqual(painted, pageHasInk(src, refs).?);
        }
    }
}

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

test "has_ink survives a re-index, and a stale row heals to the same answer" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try inkNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("ink.note", bytes);

    // Stale row and blank column: the state of a database migrated from v15.
    try f.db.exec("UPDATE note_index SET index_version = 1;");
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try testing.expectEqual(@as(i64, 6), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink IS NULL;",
    ));

    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 0);

    try testing.expectEqual(@as(i64, 0), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink IS NULL;",
    ));
    try testing.expectEqual(@as(i64, 3), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink = 1;",
    ));
    try testing.expectEqual(@as(i64, 3), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink = 0;",
    ));
}

test "the back-fill answers exactly the NULL rows, from the stored layer ranges and no parse" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try inkNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("ink.note", bytes);

    try f.db.exec("UPDATE note_page_index SET has_ink = NULL WHERE page_index IN (0, 1, 3);");
    try testing.expect(try inkNeedsScan(f.db, &md5));

    var scan = try pendingInk(gpa, f.db, &md5);
    defer scan.deinit();
    try testing.expectEqual(@as(usize, 3), scan.pages.len);
    try testing.expectEqual(@as(u32, 0), scan.pages[0].page_index);
    try testing.expectEqual(@as(u32, 1), scan.pages[1].page_index);
    try testing.expectEqual(@as(u32, 3), scan.pages[2].page_index);
    for (scan.pages) |p| {
        try testing.expect(p.layers.len > 0);
        try testing.expectEqual(@as(?bool, null), p.has_ink);
    }

    scanInk(f.files.blobs, &md5, &scan);
    try testing.expectEqual(@as(?bool, false), scan.pages[0].has_ink);
    try testing.expectEqual(@as(?bool, true), scan.pages[1].has_ink);
    try testing.expectEqual(@as(?bool, true), scan.pages[2].has_ink); // hidden still counts

    try storeInk(f.db, &md5, scan);
    try testing.expectEqual(@as(i64, 0), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink IS NULL;",
    ));
    try testing.expect(!try inkNeedsScan(f.db, &md5));

    // Same answers as ingest.
    var s = try f.db.prepare(
        "SELECT has_ink FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    const want = [_]i64{ 0, 1, 0, 1, 1, 0 };
    var n: usize = 0;
    while (try s.step()) : (n += 1) try testing.expectEqual(want[n], s.columnInt(0));
    try testing.expectEqual(want.len, n);
}

test "the back-fill never overwrites a fresher answer, and leaves an unanswerable page NULL" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try inkNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("ink.note", bytes);
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");

    var scan = try pendingInk(gpa, f.db, &md5);
    defer scan.deinit();
    scanInk(f.files.blobs, &md5, &scan);

    // A concurrent writer answered page 1 with the opposite value.
    try f.db.exec("UPDATE note_page_index SET has_ink = 0 WHERE page_index = 1;");
    scan.pages[4].has_ink = null;

    try storeInk(f.db, &md5, scan);

    var s = try f.db.prepare(
        "SELECT has_ink FROM note_page_index WHERE blob_md5 = ?1 AND page_index = ?2;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    s.bindInt(2, 1);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 0), s.columnInt(0)); // the other writer's answer stands
    s.reset();
    s.bindText(1, &md5);
    s.bindInt(2, 4);
    try testing.expect(try s.step());
    try testing.expect(s.columnIsNull(0)); // still owed, not called empty
    try testing.expect(try inkNeedsScan(f.db, &md5));
}

// Bench: silent unless `testing.log_level` is raised to `.info`; run with
// `-Doptimize=ReleaseSafe`. Results are in the design notes.
fn benchInk(bytes: []const u8, label: []const u8, iters: usize) !void {
    const gpa = testing.allocator;
    var note = try sn.parse(gpa, bytes);
    defer note.deinit();
    if (note.pages.len == 0) return;
    const src = sn.Source.fromSlice(bytes);

    // The emit list is hoisted: the indexer builds it anyway. Timed as one run
    // of `iters` sweeps; per-sweep timing would measure the clock.
    var refs_bufs: [64][max_layers]LayerRef = undefined;
    var refs: [64][]const LayerRef = undefined;
    const pages = @min(note.pages.len, refs_bufs.len);
    var ink_bytes: u64 = 0;
    for (0..pages) |i| {
        refs[i] = try sn.page_payload.emitLayers(note, i, &refs_bufs[i]);
        for (refs[i]) |r| {
            if (r.slot != .background) ink_bytes += r.len;
        }
    }

    const t0 = std.Io.Clock.awake.now(testing.io);
    var found: usize = 0;
    for (0..iters) |_| {
        for (0..pages) |i| {
            if (pageHasInk(src, refs[i]) orelse false) found += 1;
        }
    }
    const t1 = std.Io.Clock.awake.now(testing.io);
    std.mem.doNotOptimizeAway(found);
    const ns: u64 = @intCast(t0.durationTo(t1).toNanoseconds());

    std.log.info("[bench] ink {s}: {d} pages, {d} inked, {d} bytes of ink layers, {d} ns/page over {d} sweeps", .{
        label, pages, found / iters, ink_bytes, ns / (iters * pages), iters,
    });
}

test "BENCH note: the ink scan, per page, over the real captures (figures printed)" {
    try benchInk(sample, "sample.note", 200);
    try benchInk(sample2, "sample-2.note", 200);
    try benchInk(layers_edited, "layers_edited.note", 200);
}
