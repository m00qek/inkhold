//! Tests for listBin, deleted paths, restore reports and getTrashed.

const std = @import("std");
const testing = std.testing;
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const countOf = fx.countOf;
const freeEntry = fx.freeEntry;
const binRow = fx.binRow;

test "listBin reconstructs the original path THROUGH trashed ancestors" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const dir = try f.files.createFolder(1, null, "NOTE");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Work");
    defer testing.allocator.free(sub.name);
    const e = try putBytes(&f, 1, sub.id, "deep.note", "deep body");
    defer freeEntry(e);

    // The device deletes children first, so every ancestor is already a tombstone.
    try f.files.trash(1, e.id);
    try f.files.trash(1, sub.id);
    try f.files.trash(1, dir.id);

    const live_path = try f.files.pathOf(testing.allocator, 1, e.id);
    defer testing.allocator.free(live_path);
    try testing.expectEqualStrings("/", live_path);

    const row = (try binRow(a, &f, 1, e.id)).?;
    try testing.expectEqualStrings("/NOTE/Work/deep.note", row.path);
    try testing.expectEqualStrings("deep.note", row.name);
    try testing.expect(!row.is_folder);
    try testing.expectEqual(@as(u64, 9), row.size);
    try testing.expect(row.deleted_at > 0);
    try testing.expect(row.md5 != null);

    try testing.expectEqualStrings("/NOTE/Work", (try binRow(a, &f, 1, sub.id)).?.path);
    try testing.expectEqualStrings("/NOTE", (try binRow(a, &f, 1, dir.id)).?.path);
}

test "listBin: newest first, is_root marks what the user deleted, folders weigh 0" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const inside = try putBytes(&f, 1, dir.id, "inside.note", "inside!");
    defer freeEntry(inside);
    const loose = try putBytes(&f, 1, null, "loose.note", "loose");
    defer freeEntry(loose);

    try f.files.trash(1, loose.id);
    try f.files.trash(1, dir.id); // takes `inside.note` with it
    // Explicit stamps: a coarse clock can put both in the same second.
    try f.db.exec("UPDATE files SET deleted_at = 100 WHERE name = 'loose.note';");
    try f.db.exec("UPDATE files SET deleted_at = 200 WHERE name IN ('Dir','inside.note');");

    const rows = try f.files.listBin(a, 1);
    try testing.expectEqual(@as(usize, 3), rows.len);
    try testing.expectEqual(@as(i64, 200), rows[0].deleted_at);
    try testing.expectEqual(@as(i64, 200), rows[1].deleted_at);
    try testing.expectEqualStrings("loose.note", rows[2].name);

    try testing.expect((try binRow(a, &f, 1, dir.id)).?.is_root);
    try testing.expect((try binRow(a, &f, 1, loose.id)).?.is_root);
    try testing.expect(!(try binRow(a, &f, 1, inside.id)).?.is_root);

    const folder_row = (try binRow(a, &f, 1, dir.id)).?;
    try testing.expectEqual(@as(u64, 0), folder_row.size);
    try testing.expect(folder_row.md5 == null);

    const kept = try putBytes(&f, 1, null, "kept.note", "kept");
    defer freeEntry(kept);
    try testing.expect((try binRow(a, &f, 1, kept.id)) == null);

    try testing.expectEqual(@as(usize, 0), (try f.files.listBin(a, 2)).len);
    try testing.expect((try binRow(a, &f, 2, loose.id)) == null);
}

test "listBin: a trashed child under a LIVE parent is a root, and keeps its live path" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const e = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(e);

    try f.files.trash(1, e.id); // just the file; `Dir` stays live

    const row = (try binRow(arena.allocator(), &f, 1, e.id)).?;
    try testing.expectEqualStrings("/Dir/a.note", row.path);
    try testing.expect(row.is_root); // its parent is live, so it stands alone
    try testing.expectEqual(dir.id, row.parent_id.?);
}

test "listBin: the path is FROZEN at trash time — a later ancestor rename cannot move it" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const dir = try f.files.createFolder(1, null, "NOTE");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Work");
    defer testing.allocator.free(sub.name);
    const e = try putBytes(&f, 1, sub.id, "deep.note", "deep body");
    defer freeEntry(e);

    try f.files.trash(1, e.id);
    try testing.expectEqualStrings("/NOTE/Work/deep.note", (try binRow(a, &f, 1, e.id)).?.path);

    // Rename a live ancestor (device-reachable); the frozen path must not move.
    try f.db.exec("UPDATE files SET name = 'ARCHIVE' WHERE name = 'NOTE' AND user_id = 1;");
    const sub_path = try f.files.pathOf(testing.allocator, 1, sub.id);
    defer testing.allocator.free(sub_path);
    try testing.expectEqualStrings("/ARCHIVE/Work", sub_path);
    try testing.expectEqualStrings("/NOTE/Work/deep.note", (try binRow(a, &f, 1, e.id)).?.path);
}

test "trash writes deleted_path, restore clears it, and the empty bin exits early" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try testing.expectEqual(@as(usize, 0), (try f.files.listBin(a, 1)).len);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted_path IS NOT NULL;"));

    const dir = try f.files.createFolder(1, null, "NOTE");
    defer testing.allocator.free(dir.name);
    const e = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(e);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM files WHERE name = 'a.note' AND deleted_path IS NULL;"));

    try f.files.trash(1, e.id);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM files WHERE name = 'a.note' AND deleted_path = '/NOTE/a.note';"));
    try testing.expectEqualStrings("/NOTE/a.note", (try binRow(a, &f, 1, e.id)).?.path);

    {
        const r = try f.files.restore(1, e.id);
        r.deinit(testing.allocator);
    }
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted_path IS NOT NULL;"));
    try testing.expectEqual(@as(usize, 0), (try f.files.listBin(a, 1)).len);
}

test "listBin disambiguates: same name two places, and the same place deleted twice" {
    var f = try Fixture.init();
    defer f.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const d1 = try f.files.createFolder(1, null, "A");
    defer testing.allocator.free(d1.name);
    const d2 = try f.files.createFolder(1, null, "B");
    defer testing.allocator.free(d2.name);
    const in_a = try putBytes(&f, 1, d1.id, "note.note", "aaa");
    defer freeEntry(in_a);
    const in_b = try putBytes(&f, 1, d2.id, "note.note", "bbb");
    defer freeEntry(in_b);
    try f.files.trash(1, in_a.id);
    try f.files.trash(1, in_b.id);
    try testing.expectEqualStrings("/A/note.note", (try binRow(a, &f, 1, in_a.id)).?.path);
    try testing.expectEqualStrings("/B/note.note", (try binRow(a, &f, 1, in_b.id)).?.path);

    const first = try putBytes(&f, 1, null, "again.note", "1");
    defer freeEntry(first);
    try f.files.trash(1, first.id); // frees the live name again
    const second = try putBytes(&f, 1, null, "again.note", "2");
    defer freeEntry(second);
    try f.files.trash(1, second.id);

    const r1 = (try binRow(a, &f, 1, first.id)).?;
    const r2 = (try binRow(a, &f, 1, second.id)).?;
    try testing.expectEqualStrings("/again.note", r1.path);
    try testing.expectEqualStrings("/again.note", r2.path);
    try testing.expect(r1.id != r2.id);
}

test "restore REPORTS what it did: the ancestors, the descendants and the rename" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(sub.name);
    const a = try putBytes(&f, 1, sub.id, "a.note", "aaa");
    defer freeEntry(a);
    const b = try putBytes(&f, 1, sub.id, "b.note", "bbb");
    defer freeEntry(b);

    try f.files.trash(1, dir.id); // Dir + Sub + a.note + b.note

    {
        const r = try f.files.restore(1, sub.id);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("Sub", r.name);
        try testing.expect(!r.renamed);
        try testing.expectEqual(@as(usize, 1), r.ancestors);
        try testing.expectEqual(@as(usize, 2), r.descendants);
    }

    {
        const again = try f.files.restore(1, sub.id);
        defer again.deinit(testing.allocator);
        try testing.expectEqual(@as(usize, 0), again.ancestors);
        try testing.expectEqual(@as(usize, 0), again.descendants);
        try testing.expect(!again.renamed);
    }

    try f.files.trash(1, sub.id);
    const squatter = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(squatter.name);
    const r = try f.files.restore(1, sub.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("Sub (2)", r.name);
    try testing.expect(r.renamed);
    try testing.expectEqual(@as(usize, 2), r.descendants);
}

test "liveSubtreeCount is the fanout a web delete is about to have" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(sub.name);
    const a = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(a);
    const c = try putBytes(&f, 1, sub.id, "c.note", "ccc");
    defer freeEntry(c);

    try testing.expectEqual(@as(usize, 4), try f.files.liveSubtreeCount(1, dir.id)); // Dir+Sub+a+c
    try testing.expectEqual(@as(usize, 1), try f.files.liveSubtreeCount(1, a.id));

    try f.files.trash(1, c.id);
    try testing.expectEqual(@as(usize, 3), try f.files.liveSubtreeCount(1, dir.id));

    try testing.expectEqual(@as(usize, 0), try f.files.liveSubtreeCount(1, 99999));
    try testing.expectEqual(@as(usize, 0), try f.files.liveSubtreeCount(2, dir.id));
    try testing.expectEqual(@as(usize, 0), try f.files.liveSubtreeCount(1, c.id));
}

test "getTrashed sees the bin and ONLY the bin; get still sees only live rows" {
    var f = try Fixture.init();
    defer f.deinit();

    const e = try putBytes(&f, 1, null, "a.note", "aaa");
    defer freeEntry(e);

    {
        const live = (try f.files.get(1, e.id)).?;
        defer freeEntry(live);
        try testing.expectEqualStrings("a.note", live.name);
    }
    try testing.expect((try f.files.getTrashed(1, e.id)) == null);

    try f.files.trash(1, e.id);

    try testing.expect((try f.files.get(1, e.id)) == null);
    {
        const binned = (try f.files.getTrashed(1, e.id)).?;
        defer freeEntry(binned);
        try testing.expectEqualStrings("a.note", binned.name);
        try testing.expect(binned.md5 != null); // the blob reference is still held
    }

    try testing.expect((try f.files.getTrashed(2, e.id)) == null);
    try testing.expect((try f.files.getTrashed(1, 99999)) == null);
}
