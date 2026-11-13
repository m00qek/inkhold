//! Tests for `digest/bin.zig`.

const std = @import("std");
const testing = std.testing;
const digest = @import("../digest.zig");
const fx = @import("fixture.zig");
const testDb = fx.testDb;

test "the bin: digests deleted on the tablet or here, the latest first, with the category they were in" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    _ = try digest.createCategory(db, 1, "kb", "Verbes", "g1", 1_000);
    var d = fx.nomadDigest(a);
    d.parent_uid = "kb";
    const by_tablet = try digest.addDigest(db, 1, d, 1_000);
    d.uid = "u2";
    d.parent_uid = "";
    const by_web = try digest.addDigest(db, 1, d, 1_000);
    d.uid = "u3";
    _ = try digest.addDigest(db, 2, d, 1_000);

    try digest.deleteDigest(db, 1, by_tablet, 2_000);
    try testing.expect(try digest.deleteFromWeb(db, 1, by_web, 3_000));
    try testing.expect(!try digest.deleteFromWeb(db, 1, by_web, 3_000));

    const bin = try digest.binned(db, a, 1);
    try testing.expectEqual(@as(usize, 2), bin.len);
    try testing.expectEqual(by_web, bin[0].digest.id);
    try testing.expectEqual(@as(i64, 3_000), bin[0].deleted_at);
    try testing.expectEqual(@as(?[]const u8, null), bin[0].category_name);
    try testing.expectEqual(by_tablet, bin[1].digest.id);
    try testing.expectEqualStrings("Verbes", bin[1].category_name.?);
    try testing.expect(!bin[1].back);
    try testing.expectEqualStrings("La phonétique du français", bin[1].digest.content.?);
}

test "a restore: back in the manifest under its id and md5, in its category" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    _ = try digest.createCategory(db, 1, "kb", "Verbes", "g1", 1_000);
    var d = fx.nomadDigest(a);
    d.parent_uid = "kb";
    const id = try digest.addDigest(db, 1, d, 1_000);
    try digest.markTabletListed(db, 1, 1_500);
    try digest.deleteDigest(db, 1, id, 2_000);

    const r = try digest.restoreDigest(db, a, 1, id, "unused", 3_000);
    try testing.expectEqualStrings("kb", r.restored.parent_uid);
    const m = try digest.manifest(db, a, 1);
    try testing.expectEqual(@as(usize, 1), m.len);
    try testing.expectEqual(id, m[0].id);
    try testing.expectEqualStrings(d.md5_hash, m[0].md5_hash);
    try testing.expectEqual(@as(usize, 0), (try digest.binned(db, a, 1)).len);
    try testing.expect(try digest.webChangedSince(db, 1, 1_500));

    // Not in the bin any more, not someone else's.
    try testing.expect(try digest.restoreDigest(db, a, 1, id, "unused", 4_000) == .not_in_bin);
    try digest.deleteDigest(db, 1, id, 5_000);
    try testing.expect(try digest.restoreDigest(db, a, 2, id, "unused", 6_000) == .not_in_bin);
}

test "a restore from a deleted category brings the category back; from a purged one, to Uncategorized under a new md5" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    _ = try digest.createCategory(db, 1, "kb", "Verbes", "g1", 1_000);
    var d = fx.nomadDigest(a);
    d.parent_uid = "kb";
    const first = try digest.addDigest(db, 1, d, 1_000);
    d.uid = "u2";
    const second = try digest.addDigest(db, 1, d, 1_000);
    _ = try digest.deleteGroup(db, 1, .{ .uid = "kb" }, .web, 2_000);
    {
        const bin = try digest.binned(db, a, 1);
        try testing.expectEqualStrings("Verbes", bin[0].category_name.?);
    }

    const r = try digest.restoreDigest(db, a, 1, first, "unused", 3_000);
    try testing.expectEqualStrings("kb", r.restored.parent_uid);
    const groups = try digest.groups(db, a, 1);
    try testing.expectEqual(@as(usize, 1), groups.len);
    try testing.expectEqualStrings("kb", groups[0].uid.?);
    try testing.expectEqualStrings("g1", groups[0].md5_hash);
    // The other digest stays in the bin.
    try testing.expectEqual(second, (try digest.binned(db, a, 1))[0].digest.id);

    // The category deleted again and purged; the digest's restore finds none.
    _ = try digest.deleteGroup(db, 1, .{ .uid = "kb" }, .web, 4_000);
    try db.exec("DELETE FROM digests WHERE is_group = 1;");
    {
        const bin = try digest.binned(db, a, 1);
        try testing.expectEqual(@as(?[]const u8, null), bin[0].category_name);
    }
    const moved = try digest.restoreDigest(db, a, 1, second, "md5-moved", 5_000);
    try testing.expectEqualStrings("", moved.restored.parent_uid);
    const row = (try digest.digestsByIds(db, a, 1, &.{second}))[0];
    try testing.expectEqualStrings("", row.parent_uid);
    try testing.expectEqualStrings("md5-moved", row.md5_hash);
    try testing.expect(row.last_modified_time > d.last_modified_time);
}

test "a digest the tablet brought back already is not restored twice" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const d = fx.nomadDigest(a);
    const id = try digest.addDigest(db, 1, d, 1_000);
    try testing.expect(try digest.deleteFromWeb(db, 1, id, 2_000));
    // The tablet had edited it before its sync: it sends it again, as new.
    const again = try digest.addDigest(db, 1, d, 3_000);
    try testing.expect(again != id);
    try testing.expect((try digest.binned(db, a, 1))[0].back);
    try testing.expect(try digest.restoreDigest(db, a, 1, id, "unused", 4_000) == .back_already);
    try testing.expectEqual(@as(usize, 1), (try digest.manifest(db, a, 1)).len);
}

test "delete for good: only from the bin, naming the note's blob to release" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var d = fx.nomadDigest(a);
    d.handwrite_inner_name = "inner.mark";
    const id = try digest.addDigest(db, 1, d, 1_000);
    // A live digest is not in the bin.
    try testing.expect(try digest.purgeDigest(db, a, 1, id) == null);
    try digest.deleteDigest(db, 1, id, 2_000);
    try testing.expect(null == try digest.purgeDigest(db, a, 2, id));
    const gone = (try digest.purgeDigest(db, a, 1, id)).?;
    try testing.expectEqualStrings(d.handwrite_md5.?, gone.held.?);
    try testing.expectEqual(@as(usize, 0), (try digest.binned(db, a, 1)).len);
    try testing.expect(null == try digest.purgeDigest(db, a, 1, id));
}

test "a restore whose deleted category's name is taken since goes to the live one, under a new md5; no second of a name" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    _ = try digest.createCategory(db, 1, "kb", "Verbes", "g1", 1_000);
    var d = fx.nomadDigest(a);
    d.parent_uid = "kb";
    const id = try digest.addDigest(db, 1, d, 1_000);
    _ = try digest.deleteGroup(db, 1, .{ .uid = "kb" }, .web, 2_000);
    _ = try digest.createCategory(db, 1, "kb-new", "Verbes", "g2", 3_000);

    const r = try digest.restoreDigest(db, a, 1, id, "md5-moved", 4_000);
    try testing.expectEqualStrings("kb-new", r.restored.parent_uid);
    const groups = try digest.groups(db, a, 1);
    try testing.expectEqual(@as(usize, 1), groups.len);
    try testing.expectEqualStrings("kb-new", groups[0].uid.?);
    const row = (try digest.digestsByIds(db, a, 1, &.{id}))[0];
    try testing.expectEqualStrings("kb-new", row.parent_uid);
    try testing.expectEqualStrings("md5-moved", row.md5_hash);
}

test "emptying the bin: every deleted digest and category of the account, naming the notes' blobs to release" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    _ = try digest.createCategory(db, 1, "kb", "Verbes", "g1", 1_000);
    var d = fx.nomadDigest(a);
    d.handwrite_inner_name = "inner.mark";
    d.parent_uid = "kb";
    _ = try digest.addDigest(db, 1, d, 1_000);
    d.uid = "u2";
    d.parent_uid = "";
    d.handwrite_inner_name = null;
    const live = try digest.addDigest(db, 1, d, 1_000);
    d.uid = "u3";
    const binned = try digest.addDigest(db, 1, d, 1_000);
    const ruis = try digest.addDigest(db, 2, d, 1_000);
    _ = try digest.deleteGroup(db, 1, .{ .uid = "kb" }, .web, 2_000);
    try digest.deleteDigest(db, 1, binned, 2_000);
    try digest.deleteDigest(db, 2, ruis, 2_000);

    const emptied = try digest.emptyDigestBin(db, a, 1);
    try testing.expectEqual(@as(u64, 2), emptied.digests);
    try testing.expectEqual(@as(usize, 1), emptied.held.len);
    try testing.expectEqualStrings(fx.nomadDigest(a).handwrite_md5.?, emptied.held[0]);
    try testing.expectEqual(@as(usize, 0), (try digest.binned(db, a, 1)).len);
    try testing.expectEqual(live, (try digest.manifest(db, a, 1))[0].id);
    // No category left for a restore to bring back; another account's bin untouched.
    var r = (try db.row("SELECT COUNT(*) FROM digests WHERE user_id = 1 AND is_group = 1;", &.{})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 0), r.int(0));
    try testing.expectEqual(@as(usize, 1), (try digest.binned(db, a, 2)).len);
}
