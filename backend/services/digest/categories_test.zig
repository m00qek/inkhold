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

    try deleteGroup(db, 1, french, 5);
    try deleteGroup(db, 1, french, 5); // already gone: still fine

    const left = try groups(db, a, 1);
    try testing.expectEqual(@as(usize, 1), left.len);
    try testing.expectEqualStrings("Work", left[0].name.?);
    try testing.expectEqual(@as(usize, 2), (try manifest(db, a, 1)).len);
    try testing.expectEqual(@as(usize, 1), (try manifest(db, a, 2)).len); // rui's untouched
    try testing.expectEqual(@as(i64, 1), try digestCount(db, 1, ""));
}
