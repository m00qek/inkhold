//! Tests for `digest/web_edit.zig`.

const std = @import("std");
const testing = std.testing;
const digest = @import("../digest.zig");
const addDigest = digest.addDigest;
const addGroup = digest.addGroup;
const applyWebEdit = digest.applyWebEdit;
const categoryExists = digest.categoryExists;
const changedSince = digest.changedSince;
const deleteDigest = digest.deleteDigest;
const digestsByIds = digest.digestsByIds;
const markTabletListed = digest.markTabletListed;
const putDigest = digest.putDigest;
const tabletListedAt = digest.tabletListedAt;
const fx = @import("fixture.zig");
const testDb = fx.testDb;
const nomadDigest = fx.nomadDigest;

test "the browser's edit: a new md5, a time past the row's own, waiting until a tablet lists; a tablet's update clears it" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The tablet's clock runs ahead of the server's: its time is later than "now".
    var sent = nomadDigest(a);
    sent.last_modified_time = 5_000;
    const id = try addDigest(db, 1, sent, 1000);
    try testing.expect(try applyWebEdit(db, 1, id, .{ .comment = "Learn it by heart" }, "0123456789abcdef0123456789abcdef", 2_000));
    {
        const d = (try digestsByIds(db, a, 1, &.{id}))[0];
        try testing.expectEqualStrings("Learn it by heart", d.comment_str.?);
        try testing.expectEqualStrings("0123456789abcdef0123456789abcdef", d.md5_hash);
        try testing.expectEqual(@as(i64, 5_001), d.last_modified_time);
        // The handwritten note stays as the tablet sent it.
        try testing.expectEqualStrings(sent.handwrite_md5.?, d.handwrite_md5.?);
    }
    try testing.expectEqualSlices(u64, &.{id}, try changedSince(db, a, 1, try tabletListedAt(db, 1)));
    try testing.expectEqual(@as(usize, 0), (try changedSince(db, a, 2, null)).len);

    try markTabletListed(db, 1, 3_000);
    try testing.expectEqual(@as(?i64, 3_000), try tabletListedAt(db, 1));
    try testing.expectEqual(@as(usize, 0), (try changedSince(db, a, 1, 3_000)).len);

    // Changed again, then the tablet sends the digest back: its copy is the one now.
    try testing.expect(try applyWebEdit(db, 1, id, .{ .comment = "again" }, "fedcba9876543210fedcba9876543210", 4_000));
    try testing.expect(try putDigest(db, 1, id, sent, 4_500));
    try testing.expectEqual(@as(usize, 0), (try changedSince(db, a, 1, null)).len);

    // Not someone else's, not a deleted one.
    try testing.expect(!try applyWebEdit(db, 2, id, .{ .comment = "x" }, "00000000000000000000000000000000", 5_000));
    try deleteDigest(db, 1, id, 6_000);
    try testing.expect(!try applyWebEdit(db, 1, id, .{ .comment = "x" }, "00000000000000000000000000000000", 7_000));
}

test "the browser's move: to a live category or Uncategorized; the comment stays" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    _ = try addGroup(db, 1, .{ .is_group = true, .uid = "kb-phon", .name = "Phonétique", .md5_hash = "g" }, 1);
    const id = try addDigest(db, 1, nomadDigest(a), 1);
    try testing.expect(try categoryExists(db, 1, "kb-phon"));
    try testing.expect(try categoryExists(db, 1, ""));
    try testing.expect(!try categoryExists(db, 1, "kb-gone"));
    try testing.expect(!try categoryExists(db, 2, "kb-phon"));

    try testing.expect(try applyWebEdit(db, 1, id, .{ .parent_uid = "kb-phon" }, "11111111111111111111111111111111", 10));
    var d = (try digestsByIds(db, a, 1, &.{id}))[0];
    try testing.expectEqualStrings("kb-phon", d.parent_uid);
    try testing.expectEqualStrings("yeah", d.comment_str.?);
    try testing.expect(try applyWebEdit(db, 1, id, .{ .parent_uid = "" }, "22222222222222222222222222222222", 20));
    d = (try digestsByIds(db, a, 1, &.{id}))[0];
    try testing.expectEqualStrings("", d.parent_uid);
}

test "a digest deleted here and removed for good before a tablet saw it go still waits for the tablet" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const id = try addDigest(db, 1, nomadDigest(a), 1_000);
    try markTabletListed(db, 1, 1_500);
    try testing.expect(try digest.deleteFromWeb(db, 1, id, 2_000));
    try digest.markPurgedUnseen(db, 1, id, 3_000);
    _ = try digest.purgeDigest(db, a, 1, id);
    try testing.expect(try digest.webChangedSince(db, 1, 1_500));
    // The tablet's next listing takes it: nothing waits.
    try markTabletListed(db, 1, 4_000);
    try testing.expect(!try digest.webChangedSince(db, 1, 4_000));

    // One the tablet already saw go (its delete came from the tablet, or a listing came after) sets nothing.
    const seen = try addDigest(db, 2, nomadDigest(a), 1_000);
    try testing.expect(try digest.deleteFromWeb(db, 2, seen, 2_000));
    try markTabletListed(db, 2, 2_500);
    try digest.markPurgedUnseen(db, 2, seen, 3_000);
    try testing.expect(!try digest.webChangedSince(db, 2, 2_500));
}

test "an empty category deleted here and emptied from the bin before a tablet saw it go still waits for the tablet" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    try markTabletListed(db, 1, 1_000);
    try testing.expectEqual(digest.Created.done, try digest.createCategory(db, 1, "kb-empty", "Empty", "g1", 1_000));
    try markTabletListed(db, 1, 1_500);
    try testing.expect((try digest.deleteGroup(db, 1, .{ .uid = "kb-empty" }, .web, 2_000)) != null);
    try digest.markPurgedUnseen(db, 1, null, 3_000);
    _ = try digest.emptyDigestBin(db, arena.allocator(), 1);
    try testing.expect(try digest.webChangedSince(db, 1, 1_500));
}
