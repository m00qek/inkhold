//! Tests for `.mark` pairing through the file lifecycle.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const binmod = @import("bin.zig");
const Files = filesmod.Files;
const internal = @import("internal.zig");
const Entry = filesmod.Entry;
const markpair = @import("../mark_pairing.zig");
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const countOf = fx.countOf;
const freeEntry = fx.freeEntry;
const dupeMd5 = fx.dupeMd5;
const blobRefcount = fx.blobRefcount;
const binRow = fx.binRow;

test "listing hides a .mark that has its PDF beside it, and counts the same way" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const pdf = try putBytes(&f, 1, docs.id, "manual.pdf", "aaaa");
    defer freeEntry(pdf);
    const mk = try putBytes(&f, 1, docs.id, "manual.pdf.mark", "bbbb"); // the layer
    defer freeEntry(mk);
    const nb2 = try putBytes(&f, 1, docs.id, "notes.note", "cccc"); // a neighbour
    defer freeEntry(nb2);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    for (rows) |r| try testing.expect(!std.mem.endsWith(u8, r.name, ".mark"));

    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, docs.id));

    const still = (try f.files.get(1, mk.id)) orelse return error.Missing;
    defer freeEntry(still);
    try testing.expectEqualStrings("manual.pdf.mark", still.name);
}

test "an ORPHANED .mark still lists — it is the only trace of that ink left" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const orphan = try putBytes(&f, 1, docs.id, "lease.pdf.mark", "aaaa");
    defer freeEntry(orphan);
    const away = try putBytes(&f, 1, null, "away.pdf", "bbbb");
    defer freeEntry(away);
    const away_mk = try putBytes(&f, 1, docs.id, "away.pdf.mark", "cccc");
    defer freeEntry(away_mk);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, docs.id));
}

test "trashing a pdf takes its mark with it — a delete must not CONJURE a file" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const pdf = try putBytes(&f, 1, docs.id, "manual.pdf", "aaaa");
    defer freeEntry(pdf);
    const mk = try putBytes(&f, 1, docs.id, "manual.pdf.mark", "bbbb");
    defer freeEntry(mk);
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, docs.id));

    try f.files.trash(1, pdf.id);
    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 0), rows.len);
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));

    var r = (try f.db.row(
        "SELECT COUNT(*), COUNT(DISTINCT deleted_at) FROM files WHERE deleted = 1 AND id IN (?1, ?2);",
        &.{ .{ .int = @intCast(pdf.id) }, .{ .int = @intCast(mk.id) } },
    )).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 2), r.int(0));
    try testing.expectEqual(@as(i64, 1), r.int(1));
}

test "a folder named like a PDF never pairs, so the mark beside it keeps its row" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const sub = try f.files.createFolder(1, docs.id, "plan.pdf");
    testing.allocator.free(sub.name);
    const plan_mk = try putBytes(&f, 1, docs.id, "plan.pdf.mark", "dddd");
    defer freeEntry(plan_mk);

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    var saw_mark = false;
    for (rows) |r| if (std.mem.eql(u8, r.name, "plan.pdf.mark")) {
        saw_mark = true;
    };
    try testing.expect(saw_mark);

    try f.files.trash(1, sub.id);
    const still = (try f.files.get(1, plan_mk.id)) orelse return error.Missing;
    freeEntry(still);
}

/// A borrow into `rows`.
fn rowNamed(rows: []Entry, name: []const u8) !Entry {
    for (rows) |e| {
        if (std.mem.eql(u8, e.name, name)) return e;
    }
    return error.TestUnexpectedResult;
}

test "a listing row carries the id of the .mark hidden behind it" {
    var f = try Fixture.init();
    defer f.deinit();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("manual.pdf", rows[0].name);
    try testing.expectEqual(@as(?u64, p.mark.id), rows[0].mark_id);
}

test "mark id on a listing row: absent for a lonely file, a folder, and a mark's own row" {
    var f = try Fixture.init();
    defer f.deinit();

    const lonely = try putBytes(&f, 1, null, "lease.pdf", "aaaa");
    defer freeEntry(lonely);

    const folder = try f.files.createFolder(1, null, "Notes");
    defer testing.allocator.free(folder.name);
    const orphan = try putBytes(&f, 1, null, "Notes.mark", "bbbb");
    defer freeEntry(orphan);

    const rows = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(?u64, null), (try rowNamed(rows, "lease.pdf")).mark_id);
    try testing.expectEqual(@as(?u64, null), (try rowNamed(rows, "Notes")).mark_id);

    try testing.expectEqual(@as(?u64, null), (try rowNamed(rows, "Notes.mark")).mark_id);
}

test "a mark id is a LIVE fact on both sides — the bin never carries one" {
    var f = try Fixture.init();
    defer f.deinit();

    // Reachable when the mark arrives after the document went to the bin.
    const doc = try putBytes(&f, 1, null, "old.pdf", "aaaa");
    defer freeEntry(doc);
    try f.files.trash(1, doc.id);
    const late_mark = try putBytes(&f, 1, null, "old.pdf.mark", "bbbb");
    defer freeEntry(late_mark);
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, doc.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, late_mark.id));

    const trashed = (try f.files.getTrashed(1, doc.id)).?;
    defer freeEntry(trashed);
    try testing.expectEqual(@as(?u64, null), trashed.mark_id);

    const blind = (try f.files.getAnyState(1, doc.id)).?;
    defer freeEntry(blind);
    try testing.expectEqual(@as(?u64, null), blind.mark_id);

    const live = try putBytes(&f, 1, null, "new.pdf", "cccc");
    defer freeEntry(live);
    const ink = try putBytes(&f, 1, null, "new.pdf.mark", "dddd");
    defer freeEntry(ink);
    {
        const before = try f.files.list(1, null);
        defer Files.freeEntries(testing.allocator, before);
        try testing.expectEqual(@as(?u64, ink.id), (try rowNamed(before, "new.pdf")).mark_id);
    }

    var s = try f.db.prepare("UPDATE files SET deleted = 1, deleted_at = 1 WHERE id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(ink.id));
    _ = try s.step();

    const after = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, after);
    try testing.expectEqual(@as(?u64, null), (try rowNamed(after, "new.pdf")).mark_id);
}

test "trashing the MARK takes its PDF too — the rule runs both ways" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.mark.id);
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, p.pdf.id));
    try testing.expectEqual(@as(i64, 1), try deletedFlagOf(&f, p.mark.id));
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, docs.id));
}

test "a pair is ONE user-visible change: one sync bump for two rows" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    const before = try f.files.syncVersion(1);
    try f.files.trash(1, p.pdf.id);
    try testing.expectEqual(before + 1, try f.files.syncVersion(1));

    const after_trash = try f.files.syncVersion(1);
    (try f.files.restore(1, p.pdf.id)).deinit(testing.allocator);
    try testing.expectEqual(after_trash + 1, try f.files.syncVersion(1));

    const after_restore = try f.files.syncVersion(1);
    try f.files.trash(1, p.mark.id);
    try testing.expectEqual(after_restore + 1, try f.files.syncVersion(1));
}

test "restore brings the pair back together, from either member" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    var r = try f.files.restore(1, p.pdf.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("manual.pdf", r.name);
    try testing.expect(!r.renamed);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, p.mark.id));
    try testing.expectEqualStrings("manual.pdf.mark", try nameOf(&f, a, p.mark.id));

    try f.files.trash(1, p.mark.id);
    var r2 = try f.files.restore(1, p.mark.id);
    defer r2.deinit(testing.allocator);
    try testing.expectEqualStrings("manual.pdf.mark", r2.name);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, p.pdf.id));
}

test "restore under a name COLLISION renames both, so the pair survives it" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    const fresh = try putBytes(&f, 1, docs.id, "manual.pdf", "cccc");
    defer freeEntry(fresh);

    var r = try f.files.restore(1, p.pdf.id);
    defer r.deinit(testing.allocator);
    try testing.expect(r.renamed);
    try testing.expectEqualStrings("manual (2).pdf", r.name);

    try testing.expectEqualStrings("manual (2).pdf.mark", try nameOf(&f, a, p.mark.id));

    const rows = try f.files.list(1, docs.id);
    defer Files.freeEntries(testing.allocator, rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("manual (2).pdf", rows[0].name);
    try testing.expectEqualStrings("manual.pdf", rows[1].name);
}

test "restore skips a suffix whose .mark twin is taken, rather than adopting it" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.pdf.id);
    const fresh = try putBytes(&f, 1, docs.id, "manual.pdf", "cccc");
    defer freeEntry(fresh);
    const squatter = try putBytes(&f, 1, docs.id, "manual (2).pdf.mark", "dddd");
    defer freeEntry(squatter);

    var r = try f.files.restore(1, p.pdf.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("manual (3).pdf", r.name);
    try testing.expectEqualStrings("manual (3).pdf.mark", try nameOf(&f, a, p.mark.id));
    try testing.expectEqualStrings("manual (2).pdf.mark", try nameOf(&f, a, squatter.id));
}

test "purge destroys the pair, refunding and decref'ing BOTH blobs" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const p = try putPair(&f, docs.id, "manual", "aaaa", "bbbbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);
    const pdf_md5 = dupeMd5(p.pdf.md5.?);
    const mark_md5 = dupeMd5(p.mark.md5.?);

    try f.files.trash(1, p.pdf.id);
    try testing.expectEqual(@as(i64, 10), try f.used(1));
    try f.expectQuotaBalanced(1);

    try f.files.purge(1, p.pdf.id);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, -1), try blobRefcount(&f, &pdf_md5));
    try testing.expectEqual(@as(i64, -1), try blobRefcount(&f, &mark_md5));
    try testing.expect(!f.files.blobs.has(&pdf_md5));
    try testing.expect(!f.files.blobs.has(&mark_md5));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE is_folder = 0;"));
}

test "purging from the MARK destroys the PDF too" {
    var f = try Fixture.init();
    defer f.deinit();
    const p = try putPair(&f, null, "manual", "aaaa", "bbbbbb");
    defer freeEntry(p.pdf);
    defer freeEntry(p.mark);

    try f.files.trash(1, p.mark.id);
    try f.files.purge(1, p.mark.id);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

test "an ORPHANED mark has no pair, so it travels entirely alone" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);

    const orphan = try putBytes(&f, 1, docs.id, "lease.pdf.mark", "aaaa");
    defer freeEntry(orphan);
    const away = try putBytes(&f, 1, null, "away.pdf", "bbbb");
    defer freeEntry(away);
    const away_mk = try putBytes(&f, 1, docs.id, "away.pdf.mark", "cccc");
    defer freeEntry(away_mk);
    const bystander = try putBytes(&f, 1, docs.id, "notes.note", "dddd");
    defer freeEntry(bystander);

    try f.files.trash(1, orphan.id);
    try f.files.trash(1, away_mk.id);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, away.id));
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, bystander.id));

    (try f.files.restore(1, orphan.id)).deinit(testing.allocator);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, orphan.id));
    try f.files.purge(1, away_mk.id);
    try testing.expectEqual(@as(i64, 0), try deletedFlagOf(&f, away.id));
    const survivor = (try f.files.get(1, away.id)) orelse return error.Missing;
    freeEntry(survivor);
    try f.expectQuotaBalanced(1);

    const moved = try f.files.move(1, orphan.id, null, "elsewhere.mark", false);
    defer freeEntry(moved);
    try testing.expectEqual(@as(i64, 3), try countOf(&f, "SELECT COUNT(*) FROM files WHERE is_folder = 0;"));
}

test "a PDF with NO mark behaves exactly as it did before any of this" {
    var f = try Fixture.init();
    defer f.deinit();
    const docs = try f.files.createFolder(1, null, "Docs");
    defer testing.allocator.free(docs.name);
    const lone = try putBytes(&f, 1, docs.id, "solo.pdf", "aaaa");
    defer freeEntry(lone);

    try f.files.trash(1, lone.id);
    try testing.expectEqual(@as(i64, 4), try f.used(1)); // trash refunds nothing
    var r = try f.files.restore(1, lone.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("solo.pdf", r.name);
    try testing.expect(!r.renamed);

    const renamed = try f.files.move(1, lone.id, null, "solo.txt", false);
    defer freeEntry(renamed);
    try testing.expectEqualStrings("solo.txt", renamed.name);

    try f.files.trash(1, lone.id);
    try f.files.purge(1, lone.id);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try f.expectQuotaBalanced(1);
}

const shared = @import("marks_helpers.zig");
const putPair = shared.putPair;
const deletedFlagOf = shared.deletedFlagOf;
const nameOf = shared.nameOf;
