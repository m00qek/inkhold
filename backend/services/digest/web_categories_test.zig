//! Tests for `digest/web_categories.zig`.

const std = @import("std");
const testing = std.testing;
const digest = @import("../digest.zig");
const fx = @import("fixture.zig");
const testDb = fx.testDb;

test "a category made in the browser: listed for the tablet with its uid and md5, waiting until a tablet lists" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try testing.expectEqual(digest.Created.done, try digest.createCategory(db, 1, "kb-new", "Verbes", "md5-a", 1_000));
    const g = (try digest.groups(db, a, 1))[0];
    try testing.expectEqualStrings("kb-new", g.uid.?);
    try testing.expectEqualStrings("Verbes", g.name.?);
    try testing.expectEqualStrings("md5-a", g.md5_hash);
    try testing.expectEqual(@as(i64, 1_000), g.last_modified_time);
    try testing.expect(!try digest.webChangedSince(db, 2, null));
    // No second of a name; another account's names, and another case, are no clash.
    try testing.expectEqual(digest.Created.name_taken, try digest.createCategory(db, 1, "kb-2", "Verbes", "md5-b", 1_000));
    try testing.expectEqual(digest.Created.done, try digest.createCategory(db, 2, "kb-2", "Verbes", "md5-b", 1_000));
    try testing.expectEqual(digest.Created.done, try digest.createCategory(db, 1, "kb-3", "verbes", "md5-c", 1_000));
    try testing.expectEqual(@as(usize, 2), (try digest.groups(db, a, 1)).len);
    try testing.expect(try digest.webChangedSince(db, 1, null));
    try digest.markTabletListed(db, 1, 1_001);
    try testing.expect(!try digest.webChangedSince(db, 1, 1_001));
}

test "a rename: a new md5 and a time past the row's own; a tablet's update clears the wait; only a live one of one's own" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The tablet's clock runs ahead of the server's.
    const id = try digest.addGroup(db, 1, .{ .is_group = true, .uid = "kb", .name = "Old", .md5_hash = "g1", .last_modified_time = 9_000 }, 1_000);
    try testing.expectEqual(digest.Renamed.done, try digest.renameCategory(db, 1, "kb", "Old", "g1b", 1_500)); // its own name
    try testing.expectEqual(digest.Renamed.done, try digest.renameCategory(db, 1, "kb", "New", "g2", 2_000));
    {
        const g = (try digest.groups(db, a, 1))[0];
        try testing.expectEqualStrings("New", g.name.?);
        try testing.expectEqualStrings("g2", g.md5_hash);
        try testing.expectEqual(@as(i64, 9_002), g.last_modified_time);
    }
    try testing.expect(try digest.webChangedSince(db, 1, null));
    _ = try digest.putGroup(db, 1, id, .{ .is_group = true, .uid = "kb", .name = "Tablet's", .md5_hash = "g3" }, 3_000);
    try testing.expect(!try digest.webChangedSince(db, 1, null));

    try testing.expectEqual(digest.Renamed.not_found, try digest.renameCategory(db, 2, "kb", "Rui's", "g4", 4_000));
    try testing.expectEqual(digest.Renamed.not_found, try digest.renameCategory(db, 1, "kb-gone", "x", "g4", 4_000));
    _ = try digest.createCategory(db, 1, "kb-other", "Other", "g5", 4_000);
    try testing.expectEqual(digest.Renamed.name_taken, try digest.renameCategory(db, 1, "kb", "Other", "g6", 5_000));
}
