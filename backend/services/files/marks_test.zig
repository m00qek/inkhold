//! Tests for `.mark` pairing through the file lifecycle.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const binmod = @import("bin.zig");
const Files = filesmod.Files;
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

/// Distinct bytes so the quota arithmetic can tell them apart. Caller frees both.
const MarkPair = struct { pdf: Entry, mark: Entry };
fn putPair(f: *Fixture, parent: ?u64, stem: []const u8, pdf_bytes: []const u8, mark_bytes: []const u8) !MarkPair {
    var buf: [128]u8 = undefined;
    const pdf_name = try std.fmt.bufPrint(&buf, "{s}.pdf", .{stem});
    const pdf = try putBytes(f, 1, parent, pdf_name, pdf_bytes);
    errdefer freeEntry(pdf);
    var buf2: [128]u8 = undefined;
    const mark_name = try std.fmt.bufPrint(&buf2, "{s}.pdf.mark", .{stem});
    const mark = try putBytes(f, 1, parent, mark_name, mark_bytes);
    return .{ .pdf = pdf, .mark = mark };
}

/// Straight from the table, never through the folding API.
fn deletedFlagOf(f: *Fixture, id: u64) !i64 {
    var r = (try f.db.row("SELECT deleted FROM files WHERE id = ?1;", &.{.{ .int = @intCast(id) }})) orelse return -1;
    defer r.finalize();
    return r.int(0);
}

/// Straight from the table; "" when the row is gone.
fn nameOf(f: *Fixture, arena: std.mem.Allocator, id: u64) ![]const u8 {
    var r = (try f.db.row("SELECT name FROM files WHERE id = ?1;", &.{.{ .int = @intCast(id) }})) orelse return "";
    defer r.finalize();
    return arena.dupe(u8, r.text(0));
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
        .{ "SELECT f.id FROM files f WHERE f.user_id = ?1 AND f.deleted = 0" ++ Files.hide_paired_mark ++ ";", "files_live_name (" },
        .{ "SELECT f.id FROM files f WHERE f.user_id = ?1 AND f.deleted = 1" ++ Files.hide_paired_bin_mark ++ ";", "files_bin_name (" },
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

    var ids = try f.db.prepare("EXPLAIN QUERY PLAN SELECT f.id, " ++ Files.paired_mark_id ++
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
