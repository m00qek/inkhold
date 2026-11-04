//! Tests for note metadata, file types, index repair and mark pairing.

const std = @import("std");
const sn = @import("supernote");
const noteindex = @import("../note_index.zig");
const blobstore = @import("../../store/blobs.zig");
const controlplane_vo = @import("vo.zig");
const pageContentHash = noteindex.pageContentHash;
const testing = std.testing;
const nb = @import("note_builder");
const fixture = @import("fixture.zig");
const cp = @import("../controlplane.zig");
const PageRefVO = cp.PageRefVO;
const LayerVO = cp.LayerVO;
const ControlPlaneService = cp.ControlPlaneService;
const fileTypeFor = cp.fileTypeFor;
const fallbackPage = cp.fallbackPage;
const idStr = cp.idStr;
const freeEntry = cp.freeEntry;
const Fixture = fixture.Fixture;
const seedBytes = fixture.seedBytes;
const sample = @embedFile("sample.note");

const expectSameLayers = fixture.expectSameLayers;

const entryNamed = fixture.entryNamed;

const sample2 = @embedFile("sample-2.note");

/// The md5 of the blob behind file `id`, as an owned 32-hex array.
fn md5Of(f: *Fixture, id: u64) ![blobstore.md5_hex_len]u8 {
    const e = (try f.files.get(1, id)).?;
    defer freeEntry(testing.allocator, e);
    var out: [blobstore.md5_hex_len]u8 = undefined;
    @memcpy(&out, e.md5.?[0..blobstore.md5_hex_len]);
    return out;
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

    // Page 2: five layers in SNPG order, LAYER2 hidden, renamed LAYER3 current.
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

    // Page 1 (#-JSON LAYERINFO).
    const p0 = meta.pages[0].layers.?;
    try testing.expectEqual(@as(usize, 2), p0.len);
    try testing.expectEqualStrings("background", p0[0].slot);
    try testing.expectEqualStrings("main", p0[1].slot);
    try testing.expectEqualStrings("Main Layer", p0[1].name);
    try testing.expect(p0[1].isCurrent);

    // The listing's firstPage carries the same descriptors as noteMeta's page 0.
    const listing_vo = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqual(@as(usize, 1), listing_vo.entries.len);
    try expectSameLayers(meta.pages[0].layers, listing_vo.entries[0].firstPage.?.layers);

    // And so does `entryVO` (the rename response).
    const one = (try f.files.get(1, e.id)).?;
    defer freeEntry(testing.allocator, one);
    const renamed = try svc.entryVO(arena.allocator(), 1, one);
    try expectSameLayers(meta.pages[0].layers, renamed.firstPage.?.layers);
}

/// The pre-index projection, frozen: parse the whole blob and derive each
/// page's hash and dims (hardcoded default plus the `1090` swap). Proves the
/// index path changed nothing on the wire for real captures.
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
        try testing.expectEqual(w.index, g.index);
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

        const meta = (try svc.noteMeta(a, 1, id)).?;
        try expectSameRefs(want, meta.pages);

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

    try f.db.exec("DELETE FROM note_index;");
    try testing.expect(!try noteindex.isCurrent(f.db, &md5));

    const cold = (try svc.noteMeta(a, 1, id)).?;
    try testing.expect(try noteindex.isCurrent(f.db, &md5)); // backfilled in-flight
    try expectSameRefs(try legacyPageRefs(a, sample2, &md5), cold.pages);

    // Delete the blob: the warm read must open no file.
    f.files.blobs.remove(&md5);
    try testing.expect(!f.files.blobs.has(&md5));

    const warm = (try svc.noteMeta(a, 1, id)).?;
    try expectSameRefs(cold.pages, warm.pages);
    const listed = try svc.listing(a, 1, null);
    try testing.expectEqual(cold.pages.len, @as(usize, @intCast(listed.entries[0].pageCount.?)));
    try expectSameRefs(cold.pages[0..1], (&listed.entries[0].firstPage.?)[0..1]);
}

test "a STALE index row is still repaired, though nothing asks isCurrent first" {
    // `indexRow` must filter on `index_version` like `isCurrent`, or the
    // read-first order would serve stale rows forever.
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedBytes(&f, null, "real.note", sample2);
    const md5 = try md5Of(&f, id);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);
    const fresh = (try svc.noteMeta(a, 1, id)).?;

    {
        try f.db.run(
            "UPDATE note_index SET index_version = ?1 WHERE blob_md5 = ?2;",
            &.{ .{ .int = noteindex.index_version - 1 }, .{ .text = &md5 } },
        );
    }
    try testing.expect(!try noteindex.isCurrent(f.db, &md5));

    const listed = try svc.listing(a, 1, null);
    try testing.expect(try noteindex.isCurrent(f.db, &md5));
    try testing.expectEqual(@as(i64, @intCast(fresh.pages.len)), listed.entries[0].pageCount.?);
    try expectSameRefs(fresh.pages[0..1], (&listed.entries[0].firstPage.?)[0..1]);
}

test "fileTypeFor: the parser's verdict wins over the name, and a mark says so" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try testing.expectEqualStrings("pdf", try fileTypeFor(a, false, null, "book.pdf"));
    try testing.expectEqualStrings("note", try fileTypeFor(a, false, null, "liar.note"));

    // The marker, not the name, distinguishes a mark.
    const mark: [4]u8 = "mark".*;
    try testing.expectEqualStrings("mark", try fileTypeFor(a, true, mark, "anything.note"));

    // A "note", NULL or unknown marker all say "note".
    const note: [4]u8 = "note".*;
    const other: [4]u8 = "xxxx".*;
    try testing.expectEqualStrings("note", try fileTypeFor(a, true, note, "a.note"));
    try testing.expectEqualStrings("note", try fileTypeFor(a, true, null, "a.note"));
    try testing.expectEqualStrings("note", try fileTypeFor(a, true, other, "a.note"));
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

    // The extension is appended: `manual.pdf.mark`, not `manual.mark`.
    const folder = try f.files.createFolder(1, null, "Docs");
    testing.allocator.free(folder.name);
    const pdf_id = try seedBytes(&f, folder.id, "manual.pdf", "%PDF-1.7\n%%EOF\n");
    const mark_id = try seedBytes(&f, folder.id, "manual.pdf.mark", mark_bytes);

    const meta = (try svc.noteMeta(a, 1, pdf_id)).?;
    try testing.expect(meta.annotationsId != null);
    try testing.expectEqualStrings(try idStr(a, mark_id), meta.annotationsId.?);

    const lonely = try seedBytes(&f, folder.id, "lease.pdf", "%PDF-1.7\n%%EOF\n");
    try testing.expect((try svc.noteMeta(a, 1, lonely)).?.annotationsId == null);

    // Same name in a different folder is no match.
    const elsewhere = try seedBytes(&f, null, "away.pdf", "%PDF-1.7\n%%EOF\n");
    _ = try seedBytes(&f, folder.id, "away.pdf.mark", mark_bytes);
    try testing.expect((try svc.noteMeta(a, 1, elsewhere)).?.annotationsId == null);

    try testing.expect((try svc.noteMeta(a, 1, mark_id)).?.annotationsId == null);

    // A `.note` named `sneaky.pdf` is a note and gets no annotations.
    const book = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }} });
    defer gpa.free(book);
    const sneaky = try seedBytes(&f, folder.id, "sneaky.pdf", book);
    _ = try seedBytes(&f, folder.id, "sneaky.pdf.mark", mark_bytes);
    const sm = (try svc.noteMeta(a, 1, sneaky)).?;
    try testing.expectEqualStrings("note", sm.fileType.?);
    try testing.expect(sm.annotationsId == null);
}

test "listing: a document's row names the .mark folded out from behind it" {
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

    const folder = try f.files.createFolder(1, null, "Docs");
    testing.allocator.free(folder.name);
    const pdf_id = try seedBytes(&f, null, "manual.pdf", "%PDF-1.7\n%%EOF\n");
    const mark_id = try seedBytes(&f, null, "manual.pdf.mark", mark_bytes);
    _ = try seedBytes(&f, null, "lease.pdf", "%PDF-1.7\n%%EOF\n");

    const root = try svc.listing(a, 1, null);

    // The pair is one row, and that row names the mark.
    for (root.entries) |e| try testing.expect(!std.mem.eql(u8, e.name, "manual.pdf.mark"));
    const doc = try entryNamed(root, "manual.pdf");
    try testing.expectEqualStrings(try idStr(a, mark_id), doc.annotationsId.?);

    // The per-file route uses a different query; pin that they agree.
    const meta = (try svc.noteMeta(a, 1, pdf_id)).?;
    try testing.expectEqualStrings(meta.annotationsId.?, doc.annotationsId.?);

    // No mark, or a folder: the key is omitted, not null.
    const opts: std.json.Stringify.Options = .{ .emit_null_optional_fields = false };
    const alone = try entryNamed(root, "lease.pdf");
    try testing.expect(alone.annotationsId == null);
    try testing.expect(std.mem.indexOf(u8, try std.json.Stringify.valueAlloc(a, alone, opts), "annotationsId") == null);
    const dir = try entryNamed(root, "Docs");
    try testing.expect(dir.annotationsId == null);
    try testing.expect(std.mem.indexOf(u8, try std.json.Stringify.valueAlloc(a, dir, opts), "annotationsId") == null);
    try testing.expect(std.mem.indexOf(u8, try std.json.Stringify.valueAlloc(a, doc, opts), "annotationsId") != null);

    // The verified type gates it here too.
    const book = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }} });
    defer gpa.free(book);
    const sneaky = try seedBytes(&f, null, "sneaky.pdf", book);
    _ = try seedBytes(&f, null, "sneaky.pdf.mark", mark_bytes);
    const again = try svc.listing(a, 1, null);
    const s_row = try entryNamed(again, "sneaky.pdf");
    try testing.expectEqualStrings("note", s_row.fileType.?);
    try testing.expect(s_row.annotationsId == null);
    try testing.expect((try svc.noteMeta(a, 1, sneaky)).?.annotationsId == null);
}

test {
    _ = controlplane_vo;
}
