//! Tests for `digest/tags.zig`.

const std = @import("std");
const testing = std.testing;
const digest = @import("../digest.zig");
const addTag = digest.addTag;
const deleteTag = digest.deleteTag;
const renameTag = digest.renameTag;
const tags = digest.tags;
const fx = @import("fixture.zig");
const testDb = fx.testDb;

test "tags per account" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const t = try addTag(db, 1, "phonetics", 5);
    _ = try addTag(db, 2, "rui", 5);
    try testing.expect(try renameTag(db, 1, t, "phonétique"));
    try testing.expect(!try renameTag(db, 2, t, "nope"));
    const mine = try tags(db, arena.allocator(), 1);
    try testing.expectEqual(@as(usize, 1), mine.len);
    try testing.expectEqualStrings("phonétique", mine[0].name);
    try deleteTag(db, 1, t);
    try deleteTag(db, 1, t);
    try testing.expectEqual(@as(usize, 0), (try tags(db, arena.allocator(), 1)).len);
}
