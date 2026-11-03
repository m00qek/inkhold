//! Tests for `.mark` pairing and ink facts in listings and note metadata.

const std = @import("std");
const testing = std.testing;
const nb = @import("note_builder");
const cp = @import("../controlplane.zig");
const BinEntryVO = cp.BinEntryVO;
const ControlPlaneService = cp.ControlPlaneService;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const seedBytes = fixture.seedBytes;
const entryNamed = fixture.entryNamed;

test "listing: a trashed document is never offered a live mark" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    // Trash first, ink after: the only order leaving a live mark beside a
    // trashed document, since `trash` carries pairs together.
    const doc = try seedBytes(&f, null, "old.pdf", "%PDF-1.7\n%%EOF\n");
    try f.files.trash(1, doc);
    _ = try seedBytes(&f, null, "old.pdf.mark", "bbbb");

    const root = try svc.listing(a, 1, null);
    try testing.expectError(error.TestUnexpectedResult, entryNamed(root, "old.pdf"));

    // `BinEntryVO` has no `annotationsId`; the per-file bin meta answers null.
    const b = try svc.bin(a, 1);
    var seen = false;
    for (b.entries) |e| {
        if (std.mem.eql(u8, e.name, "old.pdf")) seen = true;
    }
    try testing.expect(seen);
    try testing.expect((try svc.binNoteMeta(a, 1, doc)).?.annotationsId == null);
}

test "noteMeta: a sparse .mark carries sourcePage; a notebook omits it entirely" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    // PDF pages 2, 5 and 6.
    const mark = try nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{
            .{ .number = 2, .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .number = 5, .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .number = 6, .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
    defer gpa.free(mark);
    const mark_id = try seedBytes(&f, null, "annotated.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const mm = (try svc.noteMeta(arena.allocator(), 1, mark_id)).?;
    try testing.expectEqual(@as(usize, 3), mm.pages.len);
    const want = [_]i64{ 2, 5, 6 };
    for (mm.pages, want, 0..) |pg, n, i| {
        try testing.expectEqual(@as(i64, @intCast(i)), pg.index);
        try testing.expectEqual(n, pg.sourcePage.?);
    }

    // A notebook omits it.
    const book = try nb.serialize(gpa, .{
        .pages = &.{
            .{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
    defer gpa.free(book);
    const book_id = try seedBytes(&f, null, "book.note", book);
    const bm = (try svc.noteMeta(arena.allocator(), 1, book_id)).?;
    try testing.expectEqual(@as(usize, 2), bm.pages.len);
    for (bm.pages) |pg| try testing.expect(pg.sourcePage == null);

    // A zero (pre-v7 rows, `.txt` rows) is omitted too: there is no page 0.
    {
        var u = try f.db.prepare("UPDATE note_page_index SET source_page = 0;");
        defer u.finalize();
        try testing.expect(!try u.step());
    }
    const zeroed = (try svc.noteMeta(arena.allocator(), 1, mark_id)).?;
    for (zeroed.pages) |pg| try testing.expect(pg.sourcePage == null);
}

test "noteMeta: hasInk travels for a page that was looked at, and is OMITTED for one that was not" {
    // `false` is an answer and travels; NULL (not yet scanned) is omitted.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // One page written, one erased back to nothing (§2.1).
    const stroke = [_]u8{ 0x62, 0xFF, 0x61, 0x20, 0x62, 0xFF };
    const rubbed_out = [_]u8{ 0x62, 0xFF, 0x62, 0xFF };
    const mark = try nb.serialize(gpa, .{
        .filetype = "mark",
        .pages = &.{
            .{ .number = 2, .layers = &.{.{ .slot = .main, .bitmap = &stroke }} },
            .{ .number = 5, .layers = &.{.{ .slot = .main, .bitmap = &rubbed_out }} },
        },
    });
    defer gpa.free(mark);
    const id = try seedBytes(&f, null, "annotated.pdf.mark", mark);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const mm = (try svc.noteMeta(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 2), mm.pages.len);
    try testing.expectEqual(@as(?bool, true), mm.pages[0].hasInk);
    try testing.expectEqual(@as(?bool, false), mm.pages[1].hasInk);
    try testing.expectEqual(@as(i64, 2), mm.pages[0].sourcePage.?);
    try testing.expectEqual(@as(i64, 5), mm.pages[1].sourcePage.?);

    const opts: std.json.Stringify.Options = .{ .emit_null_optional_fields = false };
    const inked_json = try std.json.Stringify.valueAlloc(a, mm.pages[0], opts);
    try testing.expect(std.mem.indexOf(u8, inked_json, "\"hasInk\":true") != null);
    const empty_json = try std.json.Stringify.valueAlloc(a, mm.pages[1], opts);
    try testing.expect(std.mem.indexOf(u8, empty_json, "\"hasInk\":false") != null);

    // An unscanned page (has_ink NULL) carries no field.
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    const unlooked = (try svc.noteMeta(a, 1, id)).?;
    for (unlooked.pages) |pg| try testing.expect(pg.hasInk == null);
    const omitted_json = try std.json.Stringify.valueAlloc(a, unlooked.pages[0], opts);
    try testing.expect(std.mem.indexOf(u8, omitted_json, "hasInk") == null);
}
