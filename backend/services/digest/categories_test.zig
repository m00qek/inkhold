//! Tests for `digest/categories.zig`.

const std = @import("std");
const testing = std.testing;
const digest = @import("../digest.zig");
const addDigest = digest.addDigest;
const addGroup = digest.addGroup;
const deleteGroup = digest.deleteGroup;
const digestCount = digest.digestCount;
const groups = digest.groups;
const manifest = digest.manifest;
const fx = @import("fixture.zig");
const testDb = fx.testDb;

test "deleting a category deletes its digests; Uncategorized and other categories stay" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const french = try addGroup(db, 1, .{ .uid = "kb-french", .name = "Français", .md5_hash = "g1" }, 0);
    _ = try addGroup(db, 1, .{ .uid = "kb-work", .name = "Work", .md5_hash = "g2" }, 0);
    try testing.expectEqual(french, try addGroup(db, 1, .{ .uid = "kb-french", .name = "Français", .md5_hash = "g1" }, 1));
    _ = try addDigest(db, 1, .{ .parent_uid = "kb-french", .md5_hash = "a" }, 0);
    _ = try addDigest(db, 1, .{ .parent_uid = "kb-french", .md5_hash = "b" }, 0);
    _ = try addDigest(db, 1, .{ .parent_uid = "kb-work", .md5_hash = "c" }, 0);
    _ = try addDigest(db, 1, .{ .md5_hash = "d" }, 0); // Uncategorized
    _ = try addDigest(db, 2, .{ .parent_uid = "kb-french", .md5_hash = "rui" }, 0);

    try testing.expectEqual(@as(?u64, 2), try deleteGroup(db, 1, .{ .id = french }, .tablet, 5));
    try testing.expectEqual(@as(?u64, null), try deleteGroup(db, 1, .{ .id = french }, .tablet, 5)); // already gone: still fine

    const left = try groups(db, a, 1);
    try testing.expectEqual(@as(usize, 1), left.len);
    try testing.expectEqualStrings("Work", left[0].name.?);
    try testing.expectEqual(@as(usize, 2), (try manifest(db, a, 1)).len);
    try testing.expectEqual(@as(usize, 1), (try manifest(db, a, 2)).len); // rui's untouched
    try testing.expectEqual(@as(i64, 1), try digestCount(db, 1, ""));
}

test "the browser's delete: by uid, counted, to the bin, waiting for a tablet; a tablet's waits for none; Uncategorized is no category" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    _ = try digest.createCategory(db, 1, "kb", "Verbes", "g1", 1_000);
    var d = fx.nomadDigest(a);
    d.parent_uid = "kb";
    _ = try digest.addDigest(db, 1, d, 1_000);
    d.uid = "other";
    _ = try digest.addDigest(db, 1, d, 1_000);
    d.uid = "uncategorized";
    d.parent_uid = "";
    const kept = try digest.addDigest(db, 1, d, 1_000);

    try testing.expectEqual(@as(?u64, 2), try digest.deleteGroup(db, 1, .{ .uid = "kb" }, .web, 2_000));
    try testing.expectEqual(@as(usize, 0), (try digest.groups(db, a, 1)).len);
    const live = try digest.manifest(db, a, 1);
    try testing.expectEqual(@as(usize, 1), live.len);
    try testing.expectEqual(kept, live[0].id);
    try testing.expectEqual(@as(usize, 2), (try digest.binned(db, a, 1)).len);
    try testing.expect(try digest.webChangedSince(db, 1, 1_500));

    // A tablet's delete is its own: nothing waits for it.
    const work = try addGroup(db, 1, .{ .is_group = true, .uid = "kb-work", .name = "Work", .md5_hash = "g2" }, 2_500);
    try testing.expectEqual(@as(?u64, 0), try deleteGroup(db, 1, .{ .id = work }, .tablet, 3_000));
    try testing.expect(!try digest.webChangedSince(db, 1, 2_001));

    try testing.expectEqual(@as(?u64, null), try digest.deleteGroup(db, 1, .{ .uid = "kb" }, .web, 3_000));
    try testing.expectEqual(@as(?u64, null), try digest.deleteGroup(db, 1, .{ .uid = "" }, .web, 3_000));
}

test "another account's category is no category to delete, by uid or by id" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    const french = try addGroup(db, 1, .{ .uid = "kb-french", .name = "Français", .md5_hash = "g1" }, 0);
    _ = try addDigest(db, 1, .{ .parent_uid = "kb-french", .md5_hash = "a" }, 0);
    try testing.expectEqual(@as(?u64, null), try deleteGroup(db, 2, .{ .uid = "kb-french" }, .web, 1));
    try testing.expectEqual(@as(?u64, null), try deleteGroup(db, 2, .{ .id = french }, .tablet, 1));
    try testing.expectEqual(@as(usize, 1), (try groups(db, arena.allocator(), 1)).len);
    try testing.expectEqual(@as(i64, 1), try digestCount(db, 1, "kb-french"));
}
