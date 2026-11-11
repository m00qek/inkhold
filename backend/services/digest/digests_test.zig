//! Tests for `digest/digests.zig`.

const std = @import("std");
const testing = std.testing;
const digest = @import("../digest.zig");
const addDigest = digest.addDigest;
const addGroup = digest.addGroup;
const addTag = digest.addTag;
const deleteDigest = digest.deleteDigest;
const digestsByIds = digest.digestsByIds;
const manifest = digest.manifest;
const purgeDeleted = digest.purgeDeleted;
const putDigest = digest.putDigest;
const uidOfMetadata = digest.uidOfMetadata;
const fx = @import("fixture.zig");
const testDb = fx.testDb;
const nomad_metadata = fx.nomad_metadata;
const nomadDigest = fx.nomadDigest;

test "a digest comes back exactly as the tablet sent it, under the id it was given" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const sent = nomadDigest(a);
    try testing.expectEqualStrings("c1ad0a49d44c62dc94b8f71448b3da5a", sent.uid.?);
    const id = try addDigest(db, 1, sent, 1000);

    const got = (try digestsByIds(db, a, 1, &.{id}))[0];
    try testing.expectEqualStrings(nomad_metadata, got.metadata.?);
    try testing.expectEqualStrings("La phonétique du français", got.content.?);
    try testing.expectEqualStrings("", got.parent_uid);
    try testing.expectEqual(@as(?i64, 1), got.source_type);
    try testing.expectEqualStrings(sent.md5_hash, got.md5_hash);
    try testing.expectEqual(sent.last_modified_time, got.last_modified_time);
    try testing.expectEqual(@as(i64, 1000), got.created_at);

    const rows = try manifest(db, a, 1);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqual(id, rows[0].id);
    try testing.expectEqualStrings(sent.handwrite_md5.?, rows[0].handwrite_md5.?);
}

test "a resent add (lost reply) updates the live digest instead of copying it" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const id = try addDigest(db, 1, nomadDigest(a), 1);
    var again = nomadDigest(a);
    again.comment_str = "edited";
    try testing.expectEqual(id, try addDigest(db, 1, again, 2));
    try testing.expectEqual(@as(usize, 1), (try manifest(db, a, 1)).len);
    try testing.expectEqualStrings("edited", (try digestsByIds(db, a, 1, &.{id}))[0].comment_str.?);

    // Deleted, then made again on the tablet: a new digest with a new id.
    try deleteDigest(db, 1, id, 3);
    const id2 = try addDigest(db, 1, nomadDigest(a), 4);
    try testing.expect(id2 != id);
}

test "ids are never reused, even after the newest digest is purged" {
    var db = try testDb();
    defer db.close();
    const first = try addDigest(db, 1, .{}, 0);
    const second = try addDigest(db, 1, .{}, 0);
    try deleteDigest(db, 1, second, 1);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    _ = try purgeDeleted(db, arena.allocator(), 100);
    const third = try addDigest(db, 1, .{}, 200);
    try testing.expect(third > second and second > first);
}

test "an update of a digest that is gone says so; one that is live keeps its id" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const id = try addDigest(db, 1, .{ .md5_hash = "a", .creation_time = 7 }, 0);
    try testing.expect(try putDigest(db, 1, id, .{ .md5_hash = "b", .parent_uid = "kb" }, 1));
    const got = (try digestsByIds(db, a, 1, &.{id}))[0];
    try testing.expectEqualStrings("b", got.md5_hash);
    try testing.expectEqualStrings("kb", got.parent_uid); // moved
    try testing.expectEqual(@as(i64, 7), got.creation_time);
    try deleteDigest(db, 1, id, 2);
    try testing.expect(!try putDigest(db, 1, id, .{}, 3));
    try testing.expect(!try putDigest(db, 2, id, .{}, 3)); // not rui's
}

test "a deleted account takes its digests" {
    var db = try testDb();
    defer db.close();
    _ = try addGroup(db, 1, .{ .uid = "g" }, 0);
    _ = try addDigest(db, 1, .{}, 0);
    _ = try addTag(db, 1, "t", 0);
    try db.exec("PRAGMA foreign_keys = ON; DELETE FROM users WHERE id = 1;");
    var r = (try db.row("SELECT (SELECT COUNT(*) FROM digests) + (SELECT COUNT(*) FROM digest_tags);", &.{})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 0), r.int(0));
}

test "metadata without a unique_identifier, or not JSON, has no uid" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqual(@as(?[]const u8, null), uidOfMetadata(a, null));
    try testing.expectEqual(@as(?[]const u8, null), uidOfMetadata(a, "not json"));
    try testing.expectEqual(@as(?[]const u8, null), uidOfMetadata(a, "{\"author\":\"x\"}"));
    try testing.expectEqual(@as(?[]const u8, null), uidOfMetadata(a, "{\"unique_identifier\":\"\"}"));
    try testing.expectEqualStrings("u1", uidOfMetadata(a, "{\"unique_identifier\":\"u1\"}").?);
}
