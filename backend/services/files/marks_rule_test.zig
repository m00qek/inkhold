//! Tests that the pairing rule is format-agnostic, indexed, and never adopts ink.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const binmod = @import("bin.zig");
const Files = filesmod.Files;
const internal = @import("internal.zig");
const markpair = @import("../mark_pairing.zig");
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const freeEntry = fx.freeEntry;
const shared = @import("marks_helpers.zig");
const putPair = shared.putPair;
const deletedFlagOf = shared.deletedFlagOf;
const nameOf = shared.nameOf;

test "a mark of a format we do not render is folded away exactly like a PDF's" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const book = try putBytes(&f, 1, docs.id, "novel.epub", "aaaa");
    defer freeEntry(book);
    const ink = try putBytes(&f, 1, docs.id, "novel.epub.mark", "bbbbbb");
    defer freeEntry(ink);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("novel.epub", rows[0].name);
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));

    try f.files.trash(1, book.id);
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, ink.id));
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));

    const bin = try f.files.listBin(a, 1);
    try testing.expectEqual(@as(usize, 1), bin.len);
    try testing.expectEqualStrings("novel.epub", bin[0].name);
    try testing.expectEqual(@as(u64, 10), bin[0].size);

    (try f.files.restore(1, ink.id)).deinit(testing.allocator);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, book.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));

    const other = try f.files.createFolder(1, null, "Other");
    defer testing.allocator.free(other.name);
    const moved = try f.files.move(1, book.id, other.id, "saga.epub", false);
    defer freeEntry(moved);
    try testing.expectEqualStrings("saga.epub.mark", try nameOf(&f, a, ink.id));
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, other.id));
}

test "an orphan mark of a format we do not render still lists, and travels alone" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const orphan = try putBytes(&f, 1, docs.id, "novel.epub.mark", "aaaa");
    defer freeEntry(orphan);
    const elsewhere = try putBytes(&f, 1, null, "novel.epub", "bbbb");
    defer freeEntry(elsewhere);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("novel.epub.mark", rows[0].name);

    try f.files.trash(1, orphan.id);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, elsewhere.id));
}

test "a mark of a mark is nobody's pair — the rule refuses to CHAIN" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const doc = try putBytes(&f, 1, docs.id, "a.note", "aaaa");
    defer freeEntry(doc);
    const mk = try putBytes(&f, 1, docs.id, "a.note.mark", "bbbb");
    defer freeEntry(mk);
    const chain = try putBytes(&f, 1, docs.id, "a.note.mark.mark", "cccc");
    defer freeEntry(chain);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("a.note", rows[0].name);
    try testing.expectEqualStrings("a.note.mark.mark", rows[1].name);

    try f.files.trash(1, doc.id);
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, mk.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, chain.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));

    try testing.expect(markpair.markStemOf(".mark") == null);
    try testing.expect(markpair.markStemOf("a.note.mark.mark") == null);
    try testing.expectEqualStrings("a.note", markpair.markStemOf("a.note.mark").?);
}

test "PLAN PIN: the pairing rule is an indexed sibling seek in the library AND the bin" {
    var f = try Fixture.init();
    defer f.deinit();

    // Pinned by index name (`files_live_name`, `files_bin_name`): without the
    // bin index a 40-row bin listing went from ~4k to ~222k VM steps. Needles
    // include the trailing " (" so a renamed index cannot match.
    const pins = .{
        .{ "SELECT f.id FROM files f WHERE f.user_id = ?1 AND f.deleted = 0" ++ internal.hide_paired_mark ++ ";", "files_live_name (" },
        .{ "SELECT f.id FROM files f WHERE f.user_id = ?1 AND f.deleted = 1" ++ internal.hide_paired_bin_mark ++ ";", "files_bin_name (" },
    };
    inline for (pins) |pin| {
        var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ pin[0]);
        defer s.finalize();
        var indexed = false;
        while (try s.step()) {
            const detail = s.columnText(3);
            if (std.mem.indexOf(u8, detail, "SEARCH p ") != null and
                std.mem.indexOf(u8, detail, pin[1]) != null) indexed = true;
        }
        try testing.expect(indexed);
    }

    var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ binmod.bin_listing_sql);
    defer s.finalize();
    var sized = false;
    var hidden = false;
    while (try s.step()) {
        const detail = s.columnText(3);
        if (std.mem.indexOf(u8, detail, "files_bin_name (") == null) continue;
        if (std.mem.indexOf(u8, detail, "SEARCH m ") != null) sized = true;
        if (std.mem.indexOf(u8, detail, "SEARCH p ") != null) hidden = true;
    }
    try testing.expect(sized);
    try testing.expect(hidden);

    var ids = try f.db.prepare("EXPLAIN QUERY PLAN SELECT f.id, " ++ internal.paired_mark_id ++
        " FROM files f WHERE f.user_id = ?1 AND f.deleted = 0;");
    defer ids.finalize();
    var seeks = false;
    while (try ids.step()) {
        const detail = ids.columnText(3);
        if (std.mem.indexOf(u8, detail, "SEARCH m ") != null and
            std.mem.indexOf(u8, detail, "files_live_name (") != null) seeks = true;
    }
    try testing.expect(seeks);
}

test "a rename must not let an unpaired file adopt an orphan mark" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const stray = try putBytes(&f, 1, docs.id, "handbook.pdf.mark", "aaaa");
    defer freeEntry(stray);
    const plain = try putBytes(&f, 1, docs.id, "notes.txt", "bbbb");
    defer freeEntry(plain);

    try testing.expectError(error.NameConflict, f.files.move(1, plain.id, docs.id, "handbook.pdf", false));
    try testing.expectEqualStrings("notes.txt", try nameOf(&f, a, plain.id));

    const renamed = try f.files.move(1, plain.id, docs.id, "handbook.pdf", true);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("handbook (2).pdf", renamed.name);

    try testing.expectEqualStrings("handbook.pdf.mark", try nameOf(&f, a, stray.id));
    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("handbook (2).pdf", rows[0].name);
    try testing.expectEqualStrings("handbook.pdf.mark", rows[1].name);

    const noop = try f.files.move(1, plain.id, docs.id, "handbook (2).pdf", false);
    defer freeEntry(noop);
    try testing.expectEqualStrings("handbook (2).pdf", noop.name);
}

test "a MOVE into another folder adopts nothing either — the pairing is name plus folder" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const other = try f.files.createFolder(1, null, "Other");
    defer testing.allocator.free(other.name);

    const plain = try putBytes(&f, 1, docs.id, "lease.pdf", "aaaa");
    defer freeEntry(plain);
    const stray = try putBytes(&f, 1, other.id, "lease.pdf.mark", "bbbb");
    defer freeEntry(stray);

    try testing.expectError(error.NameConflict, f.files.move(1, plain.id, other.id, "lease.pdf", false));
    const moved = try f.files.move(1, plain.id, other.id, "lease.pdf", true);
    defer freeEntry(moved);
    try testing.expectEqualStrings("lease (2).pdf", moved.name);
    try testing.expectEqualStrings("lease.pdf.mark", try nameOf(&f, a, stray.id));
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, other.id));
}

test "an orphan MARK cannot be renamed into somebody's ink — the direction that is not symmetric" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const doc = try putBytes(&f, 1, docs.id, "report.pdf", "aaaa");
    defer freeEntry(doc);
    const stray = try putBytes(&f, 1, docs.id, "stray.epub.mark", "bbbb");
    defer freeEntry(stray);

    // An orphan never reaches the chain refusal; `nameFree` answers from the
    // mark's side.
    try testing.expectError(error.NameConflict, f.files.move(1, stray.id, docs.id, "report.pdf.mark", false));
    try testing.expectEqualStrings("stray.epub.mark", try nameOf(&f, a, stray.id));

    const renamed = try f.files.move(1, stray.id, docs.id, "report.pdf.mark", true);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("report.pdf (2).mark", renamed.name);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, docs.id));
}

test "a FOLDER is exempt from the adoption guard, because a folder never pairs" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const mk = try putBytes(&f, 1, docs.id, "plan.pdf.mark", "aaaa");
    defer freeEntry(mk);
    const dir = try f.files.createFolder(1, docs.id, "Archive");
    testing.allocator.free(dir.name);

    const renamed = try f.files.move(1, dir.id, docs.id, "plan.pdf", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("plan.pdf", renamed.name);

    try testing.expectEqualStrings("plan.pdf.mark", try nameOf(&f, a, mk.id));
    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
}

test "a PAIRED move is unchanged by the adoption guard — it still carries its own ink" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const renamed = try f.files.move(1, p.pdf.id, null, "guide.epub", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("guide.epub", renamed.name);
    try testing.expectEqualStrings("guide.epub.mark", try nameOf(&f, a, p.mark.id));

    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
}

test "a FOLDER named like a mark is not ink — it lists, and nothing carries it" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const doc = try putBytes(&f, 1, docs.id, "plan.pdf", "aaaa");
    defer freeEntry(doc);
    const dir = try f.files.createFolder(1, docs.id, "plan.pdf.mark");
    testing.allocator.free(dir.name);
    const buried = try putBytes(&f, 1, dir.id, "buried.note", "bbbb");
    defer freeEntry(buried);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("plan.pdf.mark", rows[0].name); // folders first
    try testing.expectEqualStrings("plan.pdf", rows[1].name);
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, docs.id));

    try f.files.trash(1, doc.id);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, dir.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, buried.id));
    const rows2 = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows2);
    try testing.expectEqual(@as(usize, 1), rows2.len);
    try testing.expectEqualStrings("plan.pdf.mark", rows2[0].name);
}
