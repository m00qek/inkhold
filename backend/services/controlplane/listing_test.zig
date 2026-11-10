//! Tests for listings, note metadata, page serving, text and links.

const std = @import("std");
const testing = std.testing;
const nb = @import("note_builder");
const cp = @import("../controlplane.zig");
const ControlPlaneService = cp.ControlPlaneService;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const seedNote = fixture.seedNote;
const seedBytes = fixture.seedBytes;
const servePage = fixture.servePage;
const expectSameLayers = fixture.expectSameLayers;

test "listing: folders + note summaries, breadcrumb, and syncVersion" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Work");
    defer testing.allocator.free(dir.name);
    _ = try seedNote(&f, null, "top.note", &.{"AAAA"}); // 1 page, at root
    _ = try seedNote(&f, dir.id, "deep.note", &.{ "AAAA", "BBBBBB", "CC" }); // 3 pages, in Work

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const root = try svc.listing(arena.allocator(), 1, null);
    try testing.expect(root.folderId == null);
    try testing.expectEqual(@as(usize, 0), root.path.len);
    try testing.expectEqual(@as(usize, 2), root.entries.len);
    try testing.expectEqualStrings("folder", root.entries[0].kind);
    try testing.expectEqualStrings("Work", root.entries[0].name);
    const note = root.entries[1];
    try testing.expectEqualStrings("note", note.kind);
    try testing.expectEqualStrings("top.note", note.name);
    try testing.expectEqual(@as(i64, 1), note.pageCount.?);
    try testing.expectEqual(@as(usize, 32), note.firstPage.?.hash.len);
    try testing.expectEqual(@as(i64, 1404), note.firstPage.?.width);
    try testing.expect(root.syncVersion > 0);

    const dir_str = try std.fmt.allocPrint(arena.allocator(), "{d}", .{dir.id});
    const sub = try svc.listing(arena.allocator(), 1, dir.id);
    try testing.expectEqualStrings(dir_str, sub.folderId.?);
    try testing.expectEqual(@as(usize, 1), sub.path.len);
    try testing.expectEqualStrings("Work", sub.path[0].name);
    try testing.expectEqualStrings("folder", sub.path[0].kind);
    try testing.expectEqual(@as(usize, 1), sub.entries.len);
    try testing.expectEqual(@as(i64, 3), sub.entries[0].pageCount.?);
}

test "listing: a folder row carries a direct item count; a note row carries none" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Work");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Projects");
    defer testing.allocator.free(sub.name);
    const doomed = try seedNote(&f, dir.id, "gone.note", &.{"AAAA"});
    _ = try seedNote(&f, dir.id, "kept.note", &.{"AAAA"});
    _ = try seedNote(&f, sub.id, "deep.note", &.{"AAAA"}); // a GRANDCHILD of Work
    const empty = try f.files.createFolder(1, null, "Empty");
    defer testing.allocator.free(empty.name);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const root = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqualStrings("Empty", root.entries[0].name);
    try testing.expectEqual(@as(i64, 0), root.entries[0].itemCount.?); // → "Empty", not "0 items"

    const work = root.entries[1];
    try testing.expectEqualStrings("Work", work.name);
    try testing.expectEqual(@as(i64, 3), work.itemCount.?);

    try f.files.trash(1, doomed);
    const after = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqual(@as(i64, 2), after.entries[1].itemCount.?);

    // A note row's JSON stays exactly the `NoteSummary` shape.
    const listed = try svc.listing(arena.allocator(), 1, dir.id);
    for (listed.entries) |e| {
        if (std.mem.eql(u8, e.kind, "note")) try testing.expect(e.itemCount == null);
    }
    try testing.expectEqualStrings("note", listed.entries[1].kind);
    const json = try std.json.Stringify.valueAlloc(arena.allocator(), listed.entries[1], .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, json, "itemCount") == null);
    try testing.expect(std.mem.indexOf(u8, json, "pageCount") != null); // …but the note fields are all still there

    try testing.expect(listed.path[0].itemCount == null);
}

test "noteMeta: full page list with distinct per-page content hashes" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedNote(&f, null, "n.note", &.{ "AAAA", "BBBBBB", "AAAA" });

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;
    try testing.expectEqualStrings("n.note", meta.name);
    try testing.expectEqual(@as(usize, 3), meta.pages.len);
    try testing.expectEqual(@as(i64, 0), meta.pages[0].index);
    try testing.expectEqual(@as(i64, 2), meta.pages[2].index);
    try testing.expectEqual(@as(i64, 1404), meta.pages[0].width);
    try testing.expectEqual(@as(i64, 1872), meta.pages[0].height);
    try testing.expectEqualStrings(meta.pages[0].hash, meta.pages[2].hash);
    try testing.expect(!std.mem.eql(u8, meta.pages[0].hash, meta.pages[1].hash));

    try testing.expect((try svc.noteMeta(arena.allocator(), 1, 99999)) == null);
    const dir = try f.files.createFolder(1, null, "D");
    defer testing.allocator.free(dir.name);
    try testing.expect((try svc.noteMeta(arena.allocator(), 1, dir.id)) == null);
}

test "listing/bin firstPage: layer descriptors ride along, and are OMITTED when the page has none" {
    const layers_edited = @embedFile("layers_edited.note");
    var f = try Fixture.init();
    defer f.deinit();

    var r = std.Io.Reader.fixed(layers_edited);
    const layered = try f.files.putFile(1, null, "layers.note", &r, null);
    defer layered.deinit(testing.allocator);

    // A page with no layer records at all.
    const empty_bytes = try nb.serialize(testing.allocator, .{
        .pages = &.{.{ .style = "style_white", .layers = &.{} }},
    });
    defer testing.allocator.free(empty_bytes);
    const plain = try seedBytes(&f, null, "plain.note", empty_bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(a, 1, layered.id)).?;
    var seen_layered = false;
    var seen_plain = false;
    const listed = try svc.listing(a, 1, null);
    for (listed.entries) |entry| {
        if (std.mem.eql(u8, entry.name, "layers.note")) {
            seen_layered = true;
            try expectSameLayers(meta.pages[0].layers, entry.firstPage.?.layers);
            try testing.expect(entry.firstPage.?.layers.?.len > 0);
        } else if (std.mem.eql(u8, entry.name, "plain.note")) {
            seen_plain = true;
            try testing.expect(entry.firstPage.?.layers == null);
        }
    }
    try testing.expect(seen_layered and seen_plain);

    try f.files.trash(1, layered.id);
    try f.files.trash(1, plain);
    const b = try svc.bin(a, 1);
    var bin_layered = false;
    var bin_plain = false;
    for (b.entries) |entry| {
        if (std.mem.eql(u8, entry.name, "layers.note")) {
            bin_layered = true;
            try expectSameLayers(meta.pages[0].layers, entry.firstPage.?.layers);
        } else if (std.mem.eql(u8, entry.name, "plain.note")) {
            bin_plain = true;
            try testing.expect(entry.firstPage.?.layers == null);
        }
    }
    try testing.expect(bin_layered and bin_plain);
}

test "page serving: streams an SNPG payload whose hash and length match what noteMeta advertised" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedNote(&f, null, "n.note", &.{ "AAAA", "BBBBBB" });

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;

    const pb = (try servePage(svc, arena.allocator(), 1, id, 1)).?;
    try testing.expect(pb.bytes.len > 0);
    try testing.expectEqualStrings("SNPG", pb.bytes[0..4]); // flattened page payload
    try testing.expectEqualStrings(meta.pages[1].hash, &pb.hash);
    try testing.expectEqual(pb.content_length, @as(u64, pb.bytes.len));

    try testing.expect((try servePage(svc, arena.allocator(), 1, id, 9)) == null);
    try testing.expect((try servePage(svc, arena.allocator(), 1, 99999, 0)) == null);
}

test "recognized text: noteMeta carries textHash, and pageText serves the transcript under it" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // Page 0 finished recognition, page 1 is still running.
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{
        .header = &.{
            .{ .key = "APPLY_EQUIPMENT", .value = "N6" },
            .{ .key = "FILE_RECOGN_TYPE", .value = "1" },
        },
        .pages = &.{
            .{
                .style = "style_white",
                .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
                .recogn_status = 1,
                .recogn_labels = &.{ "hello", "world" },
            },
            .{
                .style = "style_white",
                .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
                .recogn_status = 2, // still running: no text, no hash
            },
        },
    });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "rec.note", bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 2), meta.pages.len);
    try testing.expectEqual(@as(usize, 32), meta.pages[0].textHash.?.len);
    try testing.expect(meta.pages[1].textHash == null);
    // Separate from the content hash: recognition does not touch strokes.
    try testing.expect(!std.mem.eql(u8, meta.pages[0].hash, meta.pages[0].textHash.?));

    const pt = (try svc.pageText(a, 1, id, 0)).?;
    try testing.expectEqualStrings(meta.pages[0].textHash.?, &pt.hash);
    try testing.expectEqualStrings("hello\nworld", pt.vo.text.?); // v7: distinct recognized regions join with a newline, not a space

    try testing.expect((try svc.pageText(a, 1, id, 1)) == null);
    try testing.expect((try svc.pageText(a, 1, id, 99)) == null);
    try testing.expect((try svc.pageText(a, 1, 99999, 0)) == null);
    const dir = try f.files.createFolder(1, null, "D");
    defer testing.allocator.free(dir.name);
    try testing.expect((try svc.pageText(a, 1, dir.id, 0)) == null);

    const pdf = try seedBytes(&f, null, "x.pdf", "%PDF-1.7 nope");
    try testing.expect((try svc.pageText(a, 1, pdf, 0)) == null);
    const pdf_meta = (try svc.noteMeta(a, 1, pdf)).?;
    try testing.expect(pdf_meta.pages[0].textHash == null);

    // Index rows are md5-keyed and blobs dedupe, so scoping comes from `files`.
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try f.db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    try testing.expect((try svc.pageText(a, 2, id, 0)) == null);
}

test "template links: noteMeta carries linksHash, and pageLinks serves the records under it" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // §14 shape: a PDF-built page keeps its link rectangles; page 1 has none.
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{
            .{
                .style = "user_pdf_planner_1",
                .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
                .links = &.{
                    .{ .target_page = 3, .x = 901, .y = 192, .w = 407, .h = 50 },
                    // A URL carrying a comma and an `=`.
                    .{ .uri = "https://onplanners.com/g?a=1,2&b=3", .x = 53, .y = 464, .w = 297, .h = 121 },
                    .{ .uri = "javascript:alert(1)", .x = 10, .y = 10, .w = 50, .h = 50 },
                    .{ .target_page = 99, .x = 20, .y = 20, .w = 50, .h = 50 },
                    .{ .target_page = 2, .x = 30, .y = 30, .w = 0, .h = 40 },
                },
            },
            .{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .style = "user_pdf_planner_3", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "planner.note", bytes);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(a, 1, id)).?;
    try testing.expectEqual(@as(usize, 32), meta.pages[0].linksHash.?.len);
    try testing.expect(meta.pages[1].linksHash == null);
    try testing.expect(!std.mem.eql(u8, meta.pages[0].hash, meta.pages[0].linksHash.?));

    const pl = (try svc.pageLinks(a, 1, id, 0)).?;
    try testing.expectEqualStrings(meta.pages[0].linksHash.?, &pl.hash);

    try testing.expectEqual(@as(usize, 2), pl.vo.links.len);

    // 1-based page 3 on the wire is index 2.
    const jump = pl.vo.links[0];
    try testing.expectEqual(@as(i64, 2), jump.page);
    try testing.expectEqual(@as(f64, 901), jump.x);
    try testing.expectEqual(@as(f64, 192), jump.y);
    try testing.expectEqual(@as(f64, 407), jump.w);
    try testing.expectEqual(@as(f64, 50), jump.h);

    // `none` is -1, and the URL survives its comma and `=` (§14 base64s fields).
    const web = pl.vo.links[1];
    try testing.expectEqual(@as(i64, -1), web.page);
    try testing.expectEqualStrings("https://onplanners.com/g?a=1,2&b=3", web.uri);

    try testing.expect((try svc.pageLinks(a, 1, id, 1)) == null);
    try testing.expect((try svc.pageLinks(a, 1, id, 99)) == null);
    try testing.expect((try svc.pageLinks(a, 1, 99999, 0)) == null);
    const dir = try f.files.createFolder(1, null, "D");
    defer gpa.free(dir.name);
    try testing.expect((try svc.pageLinks(a, 1, dir.id, 0)) == null);
    const pdf = try seedBytes(&f, null, "x.pdf", "%PDF-1.7 nope");
    try testing.expect((try svc.pageLinks(a, 1, pdf, 0)) == null);

    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try f.db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    try testing.expect((try svc.pageLinks(a, 2, id, 0)) == null);
}

test "template links: a block of nothing but unreadable records serves no links, not a failure" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{
        .pages = &.{.{
            .style = "user_pdf_x_1",
            .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
            .links = &.{.{ .target_page = 1, .w = 10, .h = 10 }},
        }},
    });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "junk.note", bytes);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    // Overwrite the block in place so the range validates but the content is junk.
    const meta = (try svc.noteMeta(a, 1, id)).?;
    try testing.expect(meta.pages[0].linksHash != null);
    var r = (try f.db.row(
        "SELECT links_offset, links_length FROM note_page_index WHERE page_index = 0;",
        &.{},
    )).?;
    const off: usize = @intCast(r.int(0));
    const len: usize = @intCast(r.int(1));
    r.finalize();
    @memset(bytes[off .. off + len], '!');
    const junked = try seedBytes(&f, null, "junked.note", bytes);

    const pl = (try svc.pageLinks(a, 1, junked, 0)).?;
    try testing.expectEqual(@as(usize, 0), pl.vo.links.len);
}

test "recognized text: a stored transcript that is NULL serializes to an empty body, not an error" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{ .pages = &.{.{
        .style = "style_white",
        .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
        .recogn_status = 1,
        .recogn_labels = &.{"hi"},
    }} });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "rec.note", bytes);

    // An undecodable RECOGNTEXT: range and hash kept, no transcript.
    try f.db.exec("UPDATE note_page_index SET text = NULL;");

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const pt = (try svc.pageText(arena.allocator(), 1, id, 0)).?;
    try testing.expect(pt.vo.text == null); // servable, just empty

    const body = try std.json.Stringify.valueAlloc(gpa, pt.vo, .{ .emit_null_optional_fields = false });
    defer gpa.free(body);
    try testing.expectEqualStrings("{}", body);
}

test "cross-user isolation: another user can't read the note" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try f.db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    const id = try seedNote(&f, null, "n.note", &.{"AAAA"});

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    try testing.expect((try svc.noteMeta(arena.allocator(), 2, id)) == null);
    try testing.expect((try servePage(svc, arena.allocator(), 2, id, 0)) == null);
    const empty = try svc.listing(arena.allocator(), 2, null);
    try testing.expectEqual(@as(usize, 0), empty.entries.len);
}

test "typed text boxes: searchable text and a textHash, recognition on or off" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    // Recognition on and finished, its transcript empty: the text is all typed.
    const on = try seedBytes(&f, null, "on.note", @embedFile("textbox_recognition_on.note"));
    const meta_on = (try svc.noteMeta(a, 1, on)).?;
    const pt_on = (try svc.pageText(a, 1, on, 0)).?;
    try testing.expectEqualStrings(meta_on.pages[0].textHash.?, &pt_on.hash);
    try testing.expectEqualStrings("Très bien\nça va\nBox 2 - 42", pt_on.vo.text.?);
    try testing.expect(pt_on.vo.words == null); // typed text has no word boxes

    // A Standard note: never recognised, still searchable.
    const off = try seedBytes(&f, null, "off.note", @embedFile("textbox_recognition_off.note"));
    const meta_off = (try svc.noteMeta(a, 1, off)).?;
    const pt_off = (try svc.pageText(a, 1, off, 0)).?;
    try testing.expectEqualStrings(meta_off.pages[0].textHash.?, &pt_off.hash);
    try testing.expectEqualStrings("café noir", pt_off.vo.text.?);
}
