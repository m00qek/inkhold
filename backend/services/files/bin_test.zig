//! Tests for the recycle bin.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const blobstore = @import("../../store/blobs.zig");
const stripSuffix = @import("bin.zig").stripSuffix;
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const countOf = fx.countOf;
const freeEntry = fx.freeEntry;
const dupeMd5 = fx.dupeMd5;
const binRow = fx.binRow;

test "THE BIN TEST: a restored file gives back READABLE BYTES, not just a cleared flag" {
    var f = try Fixture.init();
    defer f.deinit();

    // Reads the bytes back: a flag-only check passed while the blob was GC'd.
    const body = "PAGE1 handwriting strokes \x00\x01\x02 and a trailing NUL\x00";
    const e = try putBytes(&f, 1, null, "BuJo.note", body);
    defer freeEntry(e);
    const md5 = dupeMd5(e.md5.?);

    try f.files.trash(1, e.id);
    try testing.expect(f.files.blobs.has(&md5)); // the bin HOLDS the reference

    const r = try f.files.restore(1, e.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("BuJo.note", r.name);
    try testing.expect(!r.renamed);

    const back = (try f.files.get(1, e.id)).?;
    defer freeEntry(back);
    try testing.expectEqualStrings("BuJo.note", back.name);
    try testing.expectEqual(@as(u64, body.len), back.size);

    var buf: [256]u8 = undefined;
    const read = try f.files.blobs.readRange(back.md5.?, 0, body.len, &buf);
    try testing.expectEqualSlices(u8, body, read);
    try testing.expectEqualStrings(&blobstore.md5HexOf(body), back.md5.?);
}

test "a trashed entry is absent from listings, get and path resolution" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const e = try putBytes(&f, 1, dir.id, "a.note", "body");
    defer freeEntry(e);

    try f.files.trash(1, e.id);

    const kids = try f.files.list(1, dir.id);
    defer Files.freeEntries(testing.allocator, kids);
    try testing.expectEqual(@as(usize, 0), kids.len);
    try testing.expect((try f.files.get(1, e.id)) == null);
    try testing.expect((try f.files.resolvePath(1, "/Dir/a.note")) == null);

    (try f.files.restore(1, e.id)).deinit(testing.allocator);
    const kids2 = try f.files.list(1, dir.id);
    defer Files.freeEntries(testing.allocator, kids2);
    try testing.expectEqual(@as(usize, 1), kids2.len);
    try testing.expect((try f.files.resolvePath(1, "/Dir/a.note")) != null);
}

test "trash is idempotent, tolerates already-trashed children, and walks a folder itself" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const a = try putBytes(&f, 1, dir.id, "a.note", "aaa");
    defer freeEntry(a);
    const b = try putBytes(&f, 1, dir.id, "b.note", "bbb");
    defer freeEntry(b);

    try f.files.trash(1, a.id);
    try f.files.trash(1, b.id);
    try f.files.trash(1, dir.id);
    try testing.expectEqual(@as(i64, 3), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));

    try f.files.trash(1, a.id);
    try f.files.trash(1, dir.id);
    try testing.expectEqual(@as(i64, 3), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));

    try testing.expectError(error.NotFound, f.files.trash(1, 9999));
    try testing.expectError(error.NotFound, f.files.trash(2, dir.id));

    const dir2 = try f.files.createFolder(1, null, "Dir2");
    defer testing.allocator.free(dir2.name);
    const sub = try f.files.createFolder(1, dir2.id, "Sub");
    defer testing.allocator.free(sub.name);
    const c = try putBytes(&f, 1, sub.id, "c.note", "ccc");
    defer freeEntry(c);

    try f.files.trash(1, dir2.id);
    try testing.expectEqual(@as(i64, 6), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 0;"));

    try testing.expectEqual(@as(i64, 0), try countOf(
        &f,
        "SELECT COUNT(*) FROM files WHERE deleted = 1 AND deleted_at IS NULL;",
    ));
}

test "restore brings back the whole ancestor chain, so nothing lands orphaned" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(sub.name);
    const e = try putBytes(&f, 1, sub.id, "deep.note", "deep body");
    defer freeEntry(e);

    try f.files.trash(1, dir.id); // the whole chain goes

    (try f.files.restore(1, e.id)).deinit(testing.allocator);

    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 1), root.len);
    try testing.expectEqualStrings("Dir", root[0].name);

    const p = try f.files.pathOf(testing.allocator, 1, e.id);
    defer testing.allocator.free(p);
    try testing.expectEqualStrings("/Dir/Sub/deep.note", p);
    try testing.expectEqual(e.id, (try f.files.resolvePath(1, "/Dir/Sub/deep.note")).?);
}

test "restoring a folder restores every trashed descendant" {
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

    try f.files.trash(1, dir.id);
    (try f.files.restore(1, dir.id)).deinit(testing.allocator);

    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted = 1;"));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE deleted_at IS NOT NULL;"));
    try testing.expectEqual(c.id, (try f.files.resolvePath(1, "/Dir/Sub/c.note")).?);
    try testing.expectEqual(a.id, (try f.files.resolvePath(1, "/Dir/a.note")).?);
}

test "restore auto-renames onto a taken name and reports the name it chose" {
    var f = try Fixture.init();
    defer f.deinit();

    const v1 = try putBytes(&f, 1, null, "BuJo.note", "first body");
    defer freeEntry(v1);
    try f.files.trash(1, v1.id);

    const v2 = try putBytes(&f, 1, null, "BuJo.note", "second body");
    defer freeEntry(v2);

    const r = try f.files.restore(1, v1.id);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("BuJo (2).note", r.name); // suffix on the STEM, extension kept
    try testing.expect(r.renamed); // …and the caller is TOLD, or the UI lies about the name

    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 2), root.len);
    var buf: [64]u8 = undefined;
    const restored = (try f.files.get(1, v1.id)).?;
    defer freeEntry(restored);
    try testing.expectEqualSlices(u8, "first body", try f.files.blobs.readRange(restored.md5.?, 0, 10, &buf));

    try f.files.trash(1, v1.id);
    const occupier = try putBytes(&f, 1, null, "BuJo (2).note", "occupier");
    defer freeEntry(occupier);
    const again = try f.files.restore(1, v1.id);
    defer again.deinit(testing.allocator);
    try testing.expectEqualStrings("BuJo (3).note", again.name);

    try testing.expectEqualStrings("Budget (draft)", stripSuffix("Budget (draft)"));
    try testing.expectEqualStrings("Notes", stripSuffix("Notes (2024)"));
    try testing.expectEqualStrings("(2)", stripSuffix("(2)")); // no base to keep

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try f.files.trash(1, dir.id);
    const dir2 = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir2.name);
    const dname = try f.files.restore(1, dir.id);
    defer dname.deinit(testing.allocator);
    try testing.expectEqualStrings("Dir (2)", dname.name);
}

test "two trashed siblings that share a name both come back, one suffixed" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const first = try putBytes(&f, 1, dir.id, "a.note", "first body");
    defer freeEntry(first);
    try f.files.trash(1, first.id);
    const second = try putBytes(&f, 1, dir.id, "a.note", "second body");
    defer freeEntry(second);
    try f.files.trash(1, second.id);
    try f.files.trash(1, dir.id);

    (try f.files.restore(1, dir.id)).deinit(testing.allocator);

    const kids = try f.files.list(1, dir.id);
    defer Files.freeEntries(testing.allocator, kids);
    try testing.expectEqual(@as(usize, 2), kids.len);
    try testing.expectEqualStrings("a (2).note", kids[0].name);
    try testing.expectEqualStrings("a.note", kids[1].name);

    var buf: [64]u8 = undefined;
    for (kids) |k| {
        const want: []const u8 = if (k.id == first.id) "first body" else "second body";
        try testing.expectEqualSlices(u8, want, try f.files.blobs.readRange(k.md5.?, 0, want.len, &buf));
    }
}

test "purge refuses a live entry; emptyBin clears the bin and leaves the live tree alone" {
    var f = try Fixture.init();
    defer f.deinit();

    const keep = try putBytes(&f, 1, null, "keep.note", "kept bytes");
    defer freeEntry(keep);
    const drop = try putBytes(&f, 1, null, "drop.note", "dropped bytes");
    defer freeEntry(drop);
    const drop_md5 = dupeMd5(drop.md5.?);

    try testing.expectError(error.NotFound, f.files.purge(1, keep.id));
    try testing.expectError(error.NotFound, f.files.purge(1, 9999));

    try f.files.trash(1, drop.id);
    try testing.expectError(error.NotFound, f.files.purge(2, drop.id)); // foreign

    try testing.expectEqual(@as(usize, 1), try f.files.emptyBin(1));

    try testing.expect(!f.files.blobs.has(&drop_md5));
    try testing.expect(f.files.blobs.has(keep.md5.?));
    try testing.expectEqual(@as(i64, 10), try f.used(1)); // only "kept bytes" remains
    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 1), root.len);
    try testing.expectEqual(@as(usize, 0), try f.files.emptyBin(1)); // already empty
}

test "the retention sweep purges only entries past the window" {
    var f = try Fixture.init();
    defer f.deinit();

    const old = try putBytes(&f, 1, null, "old.note", "old body");
    defer freeEntry(old);
    const recent = try putBytes(&f, 1, null, "recent.note", "recent body");
    defer freeEntry(recent);
    const live = try putBytes(&f, 1, null, "live.note", "live body");
    defer freeEntry(live);
    const old_md5 = dupeMd5(old.md5.?);

    try f.files.trash(1, old.id);
    try f.files.trash(1, recent.id);

    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = deleted_at - ?1 WHERE id = ?2;");
        defer s.finalize();
        s.bindInt(1, Files.bin_retention_s + 60);
        s.bindInt(2, @intCast(old.id));
        _ = try s.step();
    }

    try testing.expectEqual(@as(usize, 1), try f.files.sweepBin(Files.bin_retention_s));

    try testing.expect(!f.files.blobs.has(&old_md5));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files WHERE id = 1;"));
    try testing.expectEqual(@as(i64, 20), try f.used(1)); // 11 + 9, "old body" refunded

    try testing.expect(f.files.blobs.has(recent.md5.?));
    (try f.files.restore(1, recent.id)).deinit(testing.allocator);
    freeEntry((try f.files.get(1, recent.id)).?);

    try testing.expectEqual(@as(usize, 0), try f.files.sweepBin(Files.bin_retention_s));
    freeEntry((try f.files.get(1, live.id)).?);
}

test "shortening the retention window purges nothing, and the sweep applies it going forward" {
    var f = try Fixture.init();
    defer f.deinit();
    const settings = @import("../settings.zig");
    const set = settings.Settings.init(testing.io, f.db);

    const entry = try putBytes(&f, 1, null, "old.note", "old body");
    defer freeEntry(entry);
    const md5 = dupeMd5(entry.md5.?);
    try f.files.trash(1, entry.id);
    const day = settings.seconds_per_day;
    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = deleted_at - ?1 WHERE id = ?2;");
        defer s.finalize();
        s.bindInt(1, 20 * day);
        s.bindInt(2, @intCast(entry.id));
        _ = try s.step();
    }

    const now = std.Io.Clock.real.now(testing.io).toSeconds();

    {
        const cutoff = settings.sweepCutoff(now, try set.binRetention()).?;
        try testing.expectEqual(@as(usize, 0), try f.files.sweepBinBefore(cutoff));
    }

    const shortened = try set.setBinRetentionDays(7);
    try testing.expectEqual(@as(?i64, null), settings.sweepCutoff(now, shortened));
    try testing.expect(f.files.blobs.has(&md5));
    (try f.files.restore(1, entry.id)).deinit(testing.allocator); // still restorable
    freeEntry((try f.files.get(1, entry.id)).?);
    try f.files.trash(1, entry.id);

    const later = now + 7 * day + 1;
    const cutoff = settings.sweepCutoff(later, shortened).?;
    {
        var s = try f.db.prepare("UPDATE files SET deleted_at = ?1 WHERE id = ?2;");
        defer s.finalize();
        s.bindInt(1, later - 8 * day); // 8 days in the bin at that later "now"
        s.bindInt(2, @intCast(entry.id));
        _ = try s.step();
    }
    try testing.expectEqual(@as(usize, 1), try f.files.sweepBinBefore(cutoff));
    try testing.expect(!f.files.blobs.has(&md5));
}

test "the retention sweep is per-user and takes a trashed folder's whole subtree" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const inner = try putBytes(&f, 1, dir.id, "inner.note", "inner body");
    defer freeEntry(inner);
    const inner_md5 = dupeMd5(inner.md5.?);
    const other = try putBytes(&f, 2, null, "other.note", "other body");
    defer freeEntry(other);

    try f.files.trash(1, dir.id);
    try f.files.trash(2, other.id);

    try testing.expectEqual(@as(usize, 3), try f.files.sweepBin(-1)); // Dir + inner + other

    try testing.expect(!f.files.blobs.has(&inner_md5));
    try testing.expect(!f.files.blobs.has(other.md5.?));
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try testing.expectEqual(@as(i64, 0), try f.used(2)); // each user refunded separately
}

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
