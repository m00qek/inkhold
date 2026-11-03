//! Tests for the `ink` tenant.

const std = @import("std");
const inkscan = @import("../ink_scan.zig");
const testing = std.testing;
const deferred = @import("../deferred.zig");
const tenants = deferred.tenants;
const Found = deferred.Found;
const nextJob = deferred.nextJob;
const Worker = deferred.Worker;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const two_paragraphs = fixture.two_paragraphs;
const rotate90_pdf = fixture.rotate90_pdf;
const sample2_note = fixture.sample2_note;

fn unlookedPages(f: *Fixture, md5: []const u8) !i64 {
    var r = (try f.db.row(
        "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1 AND has_ink IS NULL;",
        &.{.{ .text = md5 }},
    )).?;
    defer r.finalize();
    return r.int(0);
}

test "INK: a NULL page is offered once, back-filled, and never offered again" {
    // A fresh upload owes nothing; the state is forced as after a v15 migration.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.note", sample2_note);

    try testing.expectEqual(@as(i64, 0), try unlookedPages(&f, &md5));
    try std.testing.expect(!try inkscan.inkNeedsScan(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try testing.expectEqual(@as(i64, 2), try unlookedPages(&f, &md5));
    try std.testing.expect(try inkscan.inkNeedsScan(f.db, &md5));

    {
        const found = (try nextJob(testing.allocator, f.db)).?;
        defer testing.allocator.free(found.name);
        try std.testing.expectEqualStrings(&md5, &found.md5);
        try std.testing.expectEqualStrings("ink", found.tenant.name);
    }

    f.drain();

    try testing.expectEqual(@as(i64, 0), try unlookedPages(&f, &md5));
    {
        var r = (try f.db.row(
            "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1 AND has_ink = 1;",
            &.{.{ .text = &md5 }},
        )).?;
        defer r.finalize();
        try testing.expectEqual(@as(i64, 2), r.int(0));
    }

    try std.testing.expect(!try inkscan.inkNeedsScan(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "INK: what the tenant owes is EXACTLY the NULL rows, and it answers only those" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.note", sample2_note);
    // Page 1's answer is deliberately wrong, so re-scanning it would show.
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL WHERE page_index = 0;");
    try f.db.exec("UPDATE note_page_index SET has_ink = 0 WHERE page_index = 1;");

    try testing.expectEqual(@as(i64, 1), try unlookedPages(&f, &md5));
    try std.testing.expect(try inkscan.inkNeedsScan(f.db, &md5));

    f.drain();

    try testing.expectEqual(@as(i64, 0), try unlookedPages(&f, &md5));
    var s = try f.db.prepare(
        "SELECT has_ink FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    try std.testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 1), s.columnInt(0)); // scanned: really inked
    try std.testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 0), s.columnInt(0)); // untouched, wrong and left alone
}

test "INK: a trashed note is not offered, and neither is a `.txt` or a `.pdf`" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.note", sample2_note);
    _ = try f.put("notes.txt", two_paragraphs);
    _ = try f.put("doc.pdf", rotate90_pdf);
    f.drain(); // clear the other two tenants' work

    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try f.db.exec("UPDATE files SET deleted = 1 WHERE name = 'notes.note';");
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE name = 'notes.note';");
    const found = (try nextJob(testing.allocator, f.db)).?;
    defer testing.allocator.free(found.name);
    try std.testing.expectEqualStrings(&md5, &found.md5);
    try std.testing.expectEqualStrings("ink", found.tenant.name);
}

test "INK: `pending_sql` and `inkNeedsScan` agree, on both sides of the work" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.note", sample2_note);
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try std.testing.expect(try inkscan.inkNeedsScan(f.db, &md5));

    f.drain();

    try std.testing.expect(!try inkscan.inkNeedsScan(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}
