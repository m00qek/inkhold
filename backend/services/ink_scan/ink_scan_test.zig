//! Tests for the ink scan.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const noteindex = @import("../note_index.zig");
const sn = @import("supernote");
const Allocator = std.mem.Allocator;
const index_version = noteindex.index_version;
const LayerRef = noteindex.LayerRef;
const max_layers = noteindex.max_layers;
const testing = std.testing;
const schema = @import("../../db/schema.zig");
const thumbstore = @import("../../store/thumbs.zig");
const filesmod = @import("../files.zig");
const nb = @import("note_builder");
const ink_scan = @import("../ink_scan.zig");
const pageHasInk = ink_scan.pageHasInk;
const inkNeedsScan = ink_scan.inkNeedsScan;
const pendingInk = ink_scan.pendingInk;
const scanInk = ink_scan.scanInk;
const storeInk = ink_scan.storeInk;

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
    files: filesmod.Files,
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
        return .{ .db = db, .files = filesmod.Files.init(testing.allocator, testing.io, db, store_, thumbs_), .tmp = tmp };
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
