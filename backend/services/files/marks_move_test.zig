//! Tests for `.mark` pairs through rename, move, the bin listing and the sweep.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const countOf = fx.countOf;
const freeEntry = fx.freeEntry;
const binRow = fx.binRow;
const shared = @import("marks_helpers.zig");
const putPair = shared.putPair;
const deletedFlagOf = shared.deletedFlagOf;
const nameOf = shared.nameOf;

test "renaming a pdf renames its mark, and moving it moves its mark" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const other = try f.files.createFolder(1, null, "Other");
    defer testing.allocator.free(other.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const renamed = try f.files.move(1, p.pdf.id, docs.id, "handbook.pdf", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("handbook.pdf.mark", try nameOf(&f, a, p.mark.id));

    const moved = try f.files.move(1, p.pdf.id, other.id, "handbook.pdf", false);
    defer freeEntry(moved);
    var pr = (try f.db.row("SELECT parent_id FROM files WHERE id = ?1;", &.{.{ .int = @intCast(p.mark.id) }})).?;
    defer pr.finalize();
    try testing.expectEqual(@as(i64, @intCast(other.id)), pr.int(0));

    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, other.id));
}

test "renaming the MARK renames its pdf, and a name that cannot pair is refused" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const renamed = try f.files.move(1, p.mark.id, null, "handbook.pdf.mark", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("handbook.pdf.mark", renamed.name);
    try testing.expectEqualStrings("handbook.pdf", try nameOf(&f, a, p.pdf.id));

    const retyped = try f.files.move(1, p.pdf.id, null, "handbook.txt", false);
    defer freeEntry(retyped);
    try testing.expectEqualStrings("handbook.txt", retyped.name);
    try testing.expectEqualStrings("handbook.txt.mark", try nameOf(&f, a, p.mark.id));

    try testing.expectError(error.InvalidMove, f.files.move(1, p.mark.id, null, "notes.txt", false));
    try testing.expectError(error.InvalidMove, f.files.move(1, p.pdf.id, null, "notes.mark", false));
    try testing.expectEqualStrings("handbook.txt", try nameOf(&f, a, p.pdf.id));
    try testing.expectEqualStrings("handbook.txt.mark", try nameOf(&f, a, p.mark.id));

    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("handbook.txt", rows[0].name);
}

test "a paired move takes a suffix that is free for BOTH, or refuses to clobber" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const other = try f.files.createFolder(1, null, "Other");
    defer testing.allocator.free(other.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const squatter = try putBytes(&f, 1, other.id, "manual.pdf.mark", "cccc");
    defer freeEntry(squatter);

    try testing.expectError(error.NameConflict, f.files.move(1, p.pdf.id, other.id, "manual.pdf", false));
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, squatter.id));

    const moved = try f.files.move(1, p.pdf.id, other.id, "manual.pdf", true);
    defer freeEntry(moved);
    try testing.expectEqualStrings("manual (2).pdf", moved.name);
    try testing.expectEqualStrings("manual (2).pdf.mark", try nameOf(&f, a, p.mark.id));
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, squatter.id));

    const noop = try f.files.move(1, p.pdf.id, other.id, "manual (2).pdf", false);
    defer freeEntry(noop);
    try testing.expectEqualStrings("manual (2).pdf.mark", try nameOf(&f, a, p.mark.id));
}

test "the BIN shows one row for a trashed pair, sized as the pair" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    const rows = try f.files.listBin(a, 1);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("manual.pdf", rows[0].name);
    try testing.expectEqual(@as(u64, 10), rows[0].size);
    try testing.expectEqualStrings("/Docs/manual.pdf", rows[0].path);

    const orphan = try putBytes(&f, 1, docs.id, "lease.pdf.mark", "cc");
    defer freeEntry(orphan);
    try f.files.trash(1, orphan.id);
    const rows2 = try f.files.listBin(a, 1);
    try testing.expectEqual(@as(usize, 2), rows2.len);
    try testing.expect((try binRow(a, &f, 1, orphan.id)) != null);
    try testing.expectEqual(@as(u64, 2), (try binRow(a, &f, 1, orphan.id)).?.size);
}

test "emptyBin reports what the bin SHOWED and strands no half of a pair" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);
    const solo = try putBytes(&f, 1, null, "notes.note", "cc");
    defer freeEntry(solo);

    try f.files.trash(1, p.pdf.id);
    try f.files.trash(1, solo.id);
    try testing.expectEqual(@as(usize, 2), (try f.files.listBin(arena.allocator(), 1)).len);

    try testing.expectEqual(@as(usize, 2), try f.files.emptyBin(1));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

test "the retention sweep expires a pair as one, never half of it" {
    var f = try Fixture.init();
    defer f.deinit();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    // Backdate only the PDF, as a pre-fix bin left it.
    try f.db.exec("UPDATE files SET deleted_at = 0 WHERE name = 'manual.pdf';");

    _ = try f.files.sweepBin(1);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

test "a trash fanout counts what the folder SHOWED, mark included in the deed" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);
    const note = try putBytes(&f, 1, docs.id, "notes.note", "cccc");
    defer freeEntry(note);

    try testing.expectEqual(@as(usize, 3), try f.files.liveSubtreeCount(1, docs.id));
    try f.files.trash(1, docs.id);
    try testing.expectEqual(@as(i64, 4), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));
}

test "a folder move carries a pair inside it without touching their names" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const dest = try f.files.createFolder(1, null, "Dest");
    defer testing.allocator.free(dest.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const moved = try f.files.move(1, docs.id, dest.id, "Docs", false);
    defer freeEntry(moved);
    try testing.expectEqualStrings("manual.pdf", try nameOf(&f, a, p.pdf.id));
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, p.mark.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));
}

test "a LIVE mark beside a TRASHED pdf is not a pair — the shape a pre-fix bin left" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    // The state pre-fix databases hold: PDF trashed alone, mark live.
    try f.db.exec("UPDATE files SET deleted = 1, deleted_at = 1, deleted_path = '/Docs/manual.pdf' WHERE name = 'manual.pdf';");

    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));
    try f.files.purge(1, p.pdf.id);
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, p.mark.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, p.mark.id));
    try testing.expectEqual(@as(i64, 6), try f.used(1)); // only the PDF's 4 refunded
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);

    try f.files.trash(1, p.mark.id);
    try testing.expectEqual(@as(usize, 1), (try f.files.listBin(a, 1)).len);
    try f.files.purge(1, p.mark.id);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

test "restoring a trashed pdf leaves a LIVE mark of the same name alone" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);
    try f.db.exec("UPDATE files SET deleted = 1, deleted_at = 1, deleted_path = '/manual.pdf' WHERE name = 'manual.pdf';");

    var r = try f.files.restore(1, p.pdf.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("manual.pdf", r.name);
    try testing.expect(!r.renamed);
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, p.mark.id));
    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("manual.pdf", rows[0].name);
}
