//! Wire-contract fixtures: each VO's JSON as the web app's types expect it.

const std = @import("std");
const testing = std.testing;
const nb = @import("note_builder");
const cp = @import("../controlplane.zig");
const PageRefVO = cp.PageRefVO;
const EntryVO = cp.EntryVO;
const ListingVO = cp.ListingVO;
const NoteMetaVO = cp.NoteMetaVO;
const HistoryVersionVO = cp.HistoryVersionVO;
const HistoryVO = cp.HistoryVO;
const PageTextVO = cp.PageTextVO;
const ControlPlaneService = cp.ControlPlaneService;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const seedNote = fixture.seedNote;
const seedBytes = fixture.seedBytes;
const entryNamed = fixture.entryNamed;

const wire = @import("../../test/wire.zig");
const expectWireFixture = wire.expectVO;
const wire_time_ms = wire.time_ms;

fn pinEntryTime(e: EntryVO) EntryVO {
    var out = e;
    if (out.updatedAt != null) out.updatedAt = wire_time_ms;
    return out;
}

/// `vo` with every row's stamp pinned.
fn pinListingTimes(a: std.mem.Allocator, vo: ListingVO) !ListingVO {
    const entries = try a.alloc(EntryVO, vo.entries.len);
    for (vo.entries, entries) |src, *dst| dst.* = pinEntryTime(src);
    return .{ .folderId = vo.folderId, .path = vo.path, .entries = entries, .syncVersion = vo.syncVersion };
}

/// Versions pinned one second apart so the order still shows.
fn pinHistoryTimes(a: std.mem.Allocator, vo: HistoryVO) !HistoryVO {
    const versions = try a.alloc(HistoryVersionVO, vo.versions.len);
    for (vo.versions, versions, 0..) |src, *dst, i| {
        dst.* = src;
        dst.createdAt = wire_time_ms - @as(i64, @intCast(i)) * 1000;
    }
    return .{ .id = vo.id, .versions = versions };
}

/// A two-page N6 note: page 0 recognized and carrying template links, page 1
/// with neither, so each optional is both present and absent in the fixtures.
/// N6 is the only code in the mm allowlist, hence the only one with `pxPerMm`.
fn wireRecognizedNote(gpa: std.mem.Allocator, bmp: []const u8) ![]u8 {
    const words = [_]nb.WordSpec{
        .{ .label = "hello", .box = .{ .x = 10.5, .y = 20.25, .width = 15.0, .height = 6.5 } },
        .{ .label = "world", .box = .{ .x = 27.0, .y = 20.25, .width = 17.5, .height = 6.5 } },
    };
    const els = [_]nb.ElementSpec{.{ .label = "hello world", .words = &words }};
    const links = [_]nb.LinkSpec{.{ .x = 100, .y = 200, .w = 300, .h = 40, .uri = "https://example.org/" }};
    return nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{
            .{
                .style = "style_white",
                .layers = &.{.{ .slot = .main, .bitmap = bmp }},
                .recogn_status = 1,
                .recogn_elements = &els,
                .links = &links,
            },
            .{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = bmp }} },
        },
    });
}

/// A `.mark` over PDF pages 2 and 5, page 5 erased (`hasInk = false`).
fn wireMarkBytes(gpa: std.mem.Allocator) ![]u8 {
    const stroke = [_]u8{ 0x62, 0xFF, 0x61, 0x20, 0x62, 0xFF };
    const rubbed_out = [_]u8{ 0x62, 0xFF, 0x62, 0xFF };
    return nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{
            .{ .number = 2, .layers = &.{.{ .slot = .main, .bitmap = &stroke }} },
            .{ .number = 5, .layers = &.{.{ .slot = .main, .bitmap = &rubbed_out }} },
        },
    });
}

test "wire contract: PageRefVO — a page nobody has scanned omits BOTH hasInk and sourcePage" {
    // `sourcePage` is absent as derivable, `hasInk` as unknown; the client reads
    // these differently (`PageRef` in `core/types.ts`).
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedNote(&f, null, "n.note", &.{"AAAA"});

    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;
    try testing.expect(meta.pages[0].hasInk == null);
    try testing.expect(meta.pages[0].sourcePage == null);
    try expectWireFixture("page-ref.json", meta.pages[0]);
}

test "wire contract: PageRefVO — a mark page carries sourcePage and hasInk, true and false" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const mark = try wireMarkBytes(gpa);
    defer gpa.free(mark);
    const id = try seedBytes(&f, null, "annotated.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;
    try testing.expectEqual(@as(usize, 2), meta.pages.len);

    try testing.expectEqual(@as(i64, 2), meta.pages[0].sourcePage.?);
    try testing.expectEqual(@as(?bool, true), meta.pages[0].hasInk);
    try expectWireFixture("page-ref-inked.json", meta.pages[0]);

    // `hasInk` false travels; only unknown is omitted.
    try testing.expectEqual(@as(i64, 5), meta.pages[1].sourcePage.?);
    try testing.expectEqual(@as(?bool, false), meta.pages[1].hasInk);
    try expectWireFixture("page-ref-sparse-mark.json", meta.pages[1]);
}

test "wire contract: NoteMetaVO — a recognized N6 note, and an annotated PDF" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const note = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(note);
    const note_id = try seedBytes(&f, null, "recognized.note", note);

    const mark = try wireMarkBytes(gpa);
    defer gpa.free(mark);
    const pdf_id = try seedBytes(&f, null, "manual.pdf", "%PDF-1.7\n%%EOF\n");
    _ = try seedBytes(&f, null, "manual.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(a, 1, note_id)).?;
    try testing.expect(meta.pages[0].textHash != null);
    try testing.expect(meta.pages[0].linksHash != null);
    try testing.expect(meta.pages[1].textHash == null);
    try testing.expect(meta.pages[1].linksHash == null);
    try testing.expect(meta.pxPerMm != null);
    try testing.expect(meta.annotationsId == null);
    try expectWireFixture("note-meta.json", meta);

    const doc = (try svc.noteMeta(a, 1, pdf_id)).?;
    try testing.expectEqualStrings("pdf", doc.fileType.?);
    try testing.expect(doc.annotationsId != null);
    try testing.expect(doc.pxPerMm == null);
    try expectWireFixture("note-meta-pdf-with-mark.json", doc);
}

test "wire contract: EntryVO — a note row, and a PDF row naming its mark" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const note = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(note);
    _ = try seedBytes(&f, null, "recognized.note", note);

    const mark = try wireMarkBytes(gpa);
    defer gpa.free(mark);
    _ = try seedBytes(&f, null, "manual.pdf", "%PDF-1.7\n%%EOF\n");
    _ = try seedBytes(&f, null, "manual.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);
    const root = try svc.listing(a, 1, null);

    const row = try entryNamed(root, "recognized.note");
    try testing.expect(row.hasRecognizedText.?);
    try testing.expect(row.thumbAspect != null);
    try testing.expect(row.annotationsId == null);
    try testing.expect(row.itemCount == null);
    try expectWireFixture("entry.json", pinEntryTime(row));

    const doc = try entryNamed(root, "manual.pdf");
    try testing.expect(doc.annotationsId != null);
    try expectWireFixture("entry-annotated-pdf.json", pinEntryTime(doc));
}

test "a listing row names an XPS's or a comic book's mark as noteMeta does; an EPUB's, neither" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const mark = try wireMarkBytes(gpa);
    defer gpa.free(mark);

    var ids: [3]u64 = undefined;
    inline for (.{ "guide.xps", "comic.cbz", "book.epub" }, 0..) |name, i| {
        ids[i] = try seedBytes(&f, null, name, "PK\x03\x04 a zip");
        _ = try seedBytes(&f, null, name ++ ".mark", mark);
    }

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);
    const root = try svc.listing(a, 1, null);

    inline for (.{ "guide.xps", "comic.cbz", "book.epub" }, 0..) |name, i| {
        const row = try entryNamed(root, name);
        const meta = (try svc.noteMeta(a, 1, ids[i])).?;
        if (i < 2) {
            try testing.expect(row.annotationsId != null);
            try testing.expectEqualStrings(meta.annotationsId.?, row.annotationsId.?);
        } else {
            try testing.expect(row.annotationsId == null and meta.annotationsId == null);
        }
    }
    // Paired, so the marks themselves list as no rows of their own.
    for (root.entries) |e| try testing.expect(!std.mem.endsWith(u8, e.name, ".mark"));
}

/// A `.mark` whose pages are numbered as given, each one layer of `ink`.
fn markOn(gpa: std.mem.Allocator, pages: []const struct { number: u32, ink: []const u8 }) ![]u8 {
    // The layers live here, not in a literal inside the loop, whose storage
    // each iteration would reuse.
    var layers: [4][1]nb.LayerSpec = undefined;
    var built: [4]nb.PageSpec = undefined;
    for (pages, 0..) |pg, i| {
        layers[i] = .{.{ .slot = .main, .bitmap = pg.ink }};
        built[i] = .{ .number = pg.number, .layers = &layers[i] };
    }
    return nb.serialize(gpa, .{ .filetype = "mark", .pages = built[0..pages.len] });
}

fn coverOf(svc: *ControlPlaneService, arena: std.mem.Allocator, name: []const u8) !?[]const u8 {
    const root = try svc.listing(arena, 1, null);
    return (try entryNamed(root, name)).coverInkHash;
}

const ink_a = [_]u8{ 0x62, 0xFF, 0x61, 0x20, 0x62, 0xFF };
const ink_b = [_]u8{ 0x62, 0xFF, 0x61, 0x40, 0x62, 0xFF };
const no_ink = [_]u8{ 0x62, 0xFF, 0x62, 0xFF };
const idStr = cp.idStr;

test "a listing row's coverInkHash moves when its mark's page 1 is written again, not when page 2 is" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    _ = try seedBytes(&f, null, "a.pdf", "%PDF-1.7\n%%EOF\n");
    const v1 = try markOn(gpa, &.{ .{ .number = 1, .ink = &ink_a }, .{ .number = 2, .ink = &ink_a } });
    defer gpa.free(v1);
    _ = try seedBytes(&f, null, "a.pdf.mark", v1);
    const first = (try coverOf(&svc, arena.allocator(), "a.pdf")) orelse return error.TestExpectedCoverInk;

    // The same mark, page 2 written again: page 1's ink, and the tile, unchanged.
    const v2 = try markOn(gpa, &.{ .{ .number = 1, .ink = &ink_a }, .{ .number = 2, .ink = &ink_b } });
    defer gpa.free(v2);
    _ = try seedBytes(&f, null, "a.pdf.mark", v2);
    try testing.expectEqualStrings(first, (try coverOf(&svc, arena.allocator(), "a.pdf")).?);

    // Page 1 written again: a new hash, so a new tile.
    const v3 = try markOn(gpa, &.{ .{ .number = 1, .ink = &ink_b }, .{ .number = 2, .ink = &ink_b } });
    defer gpa.free(v3);
    _ = try seedBytes(&f, null, "a.pdf.mark", v3);
    const third = (try coverOf(&svc, arena.allocator(), "a.pdf")) orelse return error.TestExpectedCoverInk;
    try testing.expect(!std.mem.eql(u8, first, third));

    // Page 1 rubbed out: no ink, no hash.
    const v4 = try markOn(gpa, &.{.{ .number = 1, .ink = &no_ink }});
    defer gpa.free(v4);
    _ = try seedBytes(&f, null, "a.pdf.mark", v4);
    try testing.expect((try coverOf(&svc, arena.allocator(), "a.pdf")) == null);
}

test "coverInkHash picks page 1 by the viewer's rule: unnumbered at index 0, and the last of two" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    _ = try seedBytes(&f, null, "two.xps", "PK\x03\x04 a paged document");
    const two = try markOn(gpa, &.{ .{ .number = 1, .ink = &ink_a }, .{ .number = 1, .ink = &ink_b } });
    defer gpa.free(two);
    const two_id = try seedBytes(&f, null, "two.xps.mark", two);
    const meta = (try svc.noteMeta(arena.allocator(), 1, two_id)).?;
    // The viewer keeps the last page it maps to page 1.
    try testing.expectEqualStrings(meta.pages[1].hash, (try coverOf(&svc, arena.allocator(), "two.xps")).?);

    // The later of two blank: the viewer shows the blank one, so the tile has no ink.
    _ = try seedBytes(&f, null, "blank.xps", "PK\x03\x04 a paged document");
    const blank = try markOn(gpa, &.{ .{ .number = 1, .ink = &ink_a }, .{ .number = 1, .ink = &no_ink } });
    defer gpa.free(blank);
    _ = try seedBytes(&f, null, "blank.xps.mark", blank);
    try testing.expect((try coverOf(&svc, arena.allocator(), "blank.xps")) == null);

    // An unnumbered page (pre-v7 rows) at index 0 is page 1 to the viewer.
    _ = try seedBytes(&f, null, "old.cbz", "PK\x03\x04 a paged document");
    const old = try markOn(gpa, &.{.{ .number = 3, .ink = &ink_a }});
    defer gpa.free(old);
    _ = try seedBytes(&f, null, "old.cbz.mark", old);
    try f.db.exec("UPDATE note_page_index SET source_page = 0 WHERE source_page = 3;");
    try testing.expect((try coverOf(&svc, arena.allocator(), "old.cbz")) != null);
}

test "a bin row carries its trashed mark and page-1 ink, as a listing row does" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const doc = try seedBytes(&f, null, "gone.pdf", "%PDF-1.7\n%%EOF\n");
    const ink = try markOn(gpa, &.{.{ .number = 1, .ink = &ink_a }});
    defer gpa.free(ink);
    const mark = try seedBytes(&f, null, "gone.pdf.mark", ink);
    const live = (try coverOf(&svc, arena.allocator(), "gone.pdf")).?;

    try f.files.trash(1, doc);
    const bin = try svc.bin(arena.allocator(), 1);
    var row: ?cp.BinEntryVO = null;
    for (bin.entries) |e| {
        try testing.expect(!std.mem.endsWith(u8, e.name, ".mark")); // the pair is one row there too
        if (std.mem.eql(u8, e.name, "gone.pdf")) row = e;
    }
    const r = row orelse return error.TestExpectedBinRow;
    try testing.expectEqualStrings(try idStr(arena.allocator(), mark), r.annotationsId.?);
    try testing.expectEqualStrings(live, r.coverInkHash.?);
}

test "wire contract: ListingVO — a subfolder listing, breadcrumb and all" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    // A subfolder, so `folderId` and `path` are both present.
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const sub = try f.files.createFolder(1, docs.id, "Sub");
    defer testing.allocator.free(sub.name);

    const note = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(note);
    _ = try seedBytes(&f, docs.id, "recognized.note", note);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const vo = try svc.listing(a, 1, docs.id);
    // The breadcrumb has no count; the child folder row does.
    try testing.expectEqual(@as(usize, 1), vo.path.len);
    try testing.expect(vo.path[0].itemCount == null);
    try testing.expectEqual(@as(usize, 2), vo.entries.len);
    try expectWireFixture("listing.json", try pinListingTimes(a, vo));
}

test "wire contract: HistoryVO — the live version flagged, a retained one behind it" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    // Re-uploading the same name retains the first version.
    const v1 = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }} });
    defer gpa.free(v1);
    const id = try seedBytes(&f, null, "n.note", v1);
    const v2 = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(v2);
    _ = try seedBytes(&f, null, "n.note", v2);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const vo = (try svc.history(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 2), vo.versions.len);
    try testing.expect(vo.versions[0].current);
    // `current` is a plain bool, so false is emitted.
    try testing.expect(!vo.versions[1].current);
    try expectWireFixture("history.json", try pinHistoryTimes(a, vo));
}

test "wire contract: PageTextVO — the transcript and its positioned words, in millimetres" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const note = try wireRecognizedNote(gpa, &bmp);
    defer gpa.free(note);
    const id = try seedBytes(&f, null, "recognized.note", note);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const pt = (try svc.pageText(arena.allocator(), 1, id, 0)).?;
    try testing.expect(pt.vo.text != null);
    try testing.expect(pt.vo.words != null);
    try expectWireFixture("page-text.json", pt.vo);
}
