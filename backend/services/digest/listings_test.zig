//! Tests for `digest/listings.zig`.

const std = @import("std");
const testing = std.testing;
const digest = @import("../digest.zig");
const addDigest = digest.addDigest;
const deleteDigest = digest.deleteDigest;
const digestsPage = digest.digestsPage;
const manifest = digest.manifest;
const fx = @import("fixture.zig");
const testDb = fx.testDb;

test "the manifest lists every live digest, unpaged, and nothing deleted or anyone else's" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var ids: [1200]u64 = undefined;
    for (&ids, 0..) |*id, i| id.* = try addDigest(db, 1, .{ .md5_hash = "x", .last_modified_time = @intCast(i) }, 0);
    _ = try addDigest(db, 2, .{ .md5_hash = "rui" }, 0);
    try deleteDigest(db, 1, ids[5], 9);
    try deleteDigest(db, 1, ids[5], 9); // already gone: still fine
    try deleteDigest(db, 1, 999_999, 9); // never existed: still fine

    const rows = try manifest(db, a, 1);
    try testing.expectEqual(@as(usize, 1199), rows.len);
    for (rows) |r| try testing.expect(r.id != ids[5]);
    try testing.expectEqual(@as(usize, 1), (try manifest(db, a, 2)).len);
}

test "pages are 1-based and the last one comes back short, as the app reads them" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    for (0..5) |_| _ = try addDigest(db, 1, .{ .parent_uid = "kb" }, 0);
    _ = try addDigest(db, 1, .{}, 0);
    try testing.expectEqual(@as(usize, 2), (try digestsPage(db, a, 1, "kb", 1, 2)).len);
    try testing.expectEqual(@as(usize, 2), (try digestsPage(db, a, 1, "kb", 2, 2)).len);
    try testing.expectEqual(@as(usize, 1), (try digestsPage(db, a, 1, "kb", 3, 2)).len);
    try testing.expectEqual(@as(usize, 0), (try digestsPage(db, a, 1, "kb", 4, 2)).len);
    try testing.expectEqual(@as(usize, 6), (try digestsPage(db, a, 1, null, 0, 100)).len);
}
