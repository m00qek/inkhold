//! Tests for quota, the quota audit and the storage partition.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const blobstore = @import("../../store/blobs.zig");
const thumbnail = @import("../thumbnail.zig");
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const countOf = fx.countOf;
const hasCapacityRow = fx.hasCapacityRow;
const freeEntry = fx.freeEntry;
const dupeMd5 = fx.dupeMd5;

test "quota is enforced and leaves no state or orphan blob behind" {
    var f = try Fixture.init();
    defer f.deinit();

    var big: [1025]u8 = undefined; // 1 byte over the 1024 quota
    @memset(&big, 'x');
    var r = std.Io.Reader.fixed(&big);
    try testing.expectError(error.QuotaExceeded, f.files.putFile(1, null, "big", &r, null));

    try testing.expectEqual(@as(i64, 0), try f.used(1)); // no capacity charged
    const entries = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 0), entries.len); // no file row
    try testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(&big)));
}

test "a missing capacity row is created on the write path and used_bytes accrues (no quota bypass)" {
    var f = try Fixture.init();
    defer f.deinit();

    // A user with no capacity row (e.g. admin createUser).
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(3, 'q@z.c', '0123456789abcdef0123456789abcdef', 0);");
    try testing.expect(!try hasCapacityRow(&f, 3));

    const a = try putBytes(&f, 3, null, "a.note", "aaaa"); // 4 bytes
    defer freeEntry(a);
    try testing.expect(try hasCapacityRow(&f, 3)); // ensureCapacity created it
    try testing.expectEqual(@as(i64, 4), try f.used(3)); // accounting is live

    {
        try f.db.run("UPDATE capacity SET total_bytes = 5 WHERE user_id = 3;", &.{});
    }
    var r = std.Io.Reader.fixed("bb"); // 4 + 2 = 6 > 5
    try testing.expectError(error.QuotaExceeded, f.files.putFile(3, null, "b.note", &r, null));
    try testing.expectEqual(@as(i64, 4), try f.used(3)); // rolled back, unchanged
}

test "THE DEDUP TEST: a blob shared by two files survives one being trashed, and one being purged" {
    var f = try Fixture.init();
    defer f.deinit();

    const body = "identical note payload";
    const a = try putBytes(&f, 1, null, "a.note", body);
    defer freeEntry(a);
    const b = try putBytes(&f, 1, null, "b.note", body);
    defer freeEntry(b);

    const md5 = dupeMd5(a.md5.?);
    try testing.expectEqualStrings(&md5, b.md5.?);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT refcount FROM blobs;"));

    try f.files.trash(1, a.id);
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT refcount FROM blobs;"));
    try testing.expect(f.files.blobs.has(&md5));

    try f.files.purge(1, a.id);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT refcount FROM blobs;"));
    try testing.expect(f.files.blobs.has(&md5));

    const kept = (try f.files.get(1, b.id)).?;
    defer freeEntry(kept);
    var buf: [64]u8 = undefined;
    try testing.expectEqualSlices(u8, body, try f.files.blobs.readRange(kept.md5.?, 0, body.len, &buf));

    try f.files.trash(1, b.id);
    try f.files.purge(1, b.id);
    try testing.expect(!f.files.blobs.has(&md5));
    try testing.expectEqual(@as(i64, 0), try f.used(1));
}

test "THE QUOTA AUDIT: used_bytes equals the reconstructed sum after every mutation" {
    var f = try Fixture.init();
    defer f.deinit();

    try f.expectQuotaBalanced(1);

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try f.expectQuotaBalanced(1); // a folder charges nothing

    const a = try putBytes(&f, 1, dir.id, "a", "aaaa");
    freeEntry(a);
    const b = try putBytes(&f, 1, dir.id, "b", "bbbbbb");
    freeEntry(b);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    // Byte-identical to "a": the same blob, charged once.
    const c = try putBytes(&f, 1, null, "c", "aaaa");
    const shared = dupeMd5(c.md5.?);
    freeEntry(c);
    try testing.expect(f.files.blobs.has(&shared));
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 10), try f.used(1)); // NOT 14

    const d = try putBytes(&f, 1, dir.id, "d", "aaaa");
    freeEntry(d);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    const b2 = try putBytes(&f, 1, dir.id, "b", "bb");
    freeEntry(b2);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 12), try f.used(1)); // 4 shared + 2 current + 6 retained

    const b3 = try putBytes(&f, 1, dir.id, "b", "aaaa");
    freeEntry(b3);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 12), try f.used(1)); // 4 shared + 6 + 2, both retained

    try f.files.trash(1, dir.id);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 12), try f.used(1));

    try f.files.purge(1, dir.id);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 4), try f.used(1));
    try testing.expect(f.files.blobs.has(&shared));

    const c_id = (try f.files.resolvePath(1, "/c")).?;
    try f.files.trash(1, c_id);
    try f.files.purge(1, c_id);
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try testing.expect(!f.files.blobs.has(&shared));
}

test "the quota audit holds across users sharing one blob" {
    var f = try Fixture.init();
    defer f.deinit();

    const a = try putBytes(&f, 1, null, "a", "shared bytes");
    const md5 = dupeMd5(a.md5.?);
    freeEntry(a);
    const b = try putBytes(&f, 2, null, "b", "shared bytes");
    freeEntry(b);

    try f.expectQuotaBalanced(1);
    try f.expectQuotaBalanced(2);
    try testing.expectEqual(@as(i64, 12), try f.used(1));
    try testing.expectEqual(@as(i64, 12), try f.used(2));

    try f.files.trash(1, 1);
    try f.files.purge(1, 1);
    try f.expectQuotaBalanced(1);
    try f.expectQuotaBalanced(2);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try testing.expectEqual(@as(i64, 12), try f.used(2)); // user 2 unaffected
    try testing.expect(f.files.blobs.has(&md5)); // still theirs
}

test "THE PARTITION AUDIT: the five storage figures sum to the reconstructed total after every mutation" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 3;

    try f.expectPartition(1);

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try f.expectPartition(1); // a folder references no blob

    const note = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v1");
    freeEntry(note);
    const spd = try putBytes(&f, 1, dir.id, "sketch.spd", "sketch-bytes");
    freeEntry(spd);
    const pdf = try putBytes(&f, 1, dir.id, "lease.pdf", "document-bytes");
    freeEntry(pdf);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expect(b.notebooks > 0 and b.sketches > 0 and b.documents > 0);
        try testing.expectEqual(@as(i64, 0), b.recycle_bin);
        try testing.expectEqual(@as(i64, 0), b.versions);
        try testing.expectEqual(try f.used(1), b.total()); // no history yet: meter == sum
    }

    const odd = try putBytes(&f, 1, dir.id, "README", "no-extension-bytes");
    freeEntry(odd);
    try f.expectPartition(1);

    {
        const before = (try f.files.storageBreakdown(1)).documents;
        const dup = try putBytes(&f, 1, null, "copy.pdf", "document-bytes");
        freeEntry(dup);
        try f.expectPartition(1);
        try testing.expectEqual(before, (try f.files.storageBreakdown(1)).documents);
    }

    const note2 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v2");
    freeEntry(note2);
    try f.expectPartition(1);
    try testing.expect((try f.files.storageBreakdown(1)).versions > 0);

    const note3 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v3");
    freeEntry(note3);
    const note4 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v4");
    freeEntry(note4);
    try f.expectPartition(1);

    {
        const b = try f.files.storageBreakdown(1);
        try testing.expect(b.versions > 0);
        try testing.expectEqual(try f.used(1), b.total());
    }

    f.files.history.keep = 1; // K lowered; the next supersede re-applies it
    const note5 = try putBytes(&f, 1, dir.id, "bujo.note", "notebook-bytes-v5");
    freeEntry(note5);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    const note_id = (try f.files.resolvePath(1, "/Dir/bujo.note")).?;
    try f.files.trash(1, note_id);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(@as(i64, 0), b.versions); // the live-file history is gone with it
        try testing.expect(b.recycle_bin > 0);
    }

    (try f.files.restore(1, note_id)).deinit(testing.allocator);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(@as(i64, 0), b.recycle_bin);
        try testing.expect(b.versions > 0);
        try testing.expect(b.notebooks > 0);
    }

    {
        const before = (try f.files.storageBreakdown(1)).documents;
        const dup_id = (try f.files.resolvePath(1, "/copy.pdf")).?;
        try f.files.trash(1, dup_id);
        try f.expectPartition(1);
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(before, b.documents); // still live's
        try testing.expectEqual(@as(i64, 0), b.recycle_bin); // and NOT also the bin's
        try f.files.purge(1, dup_id);
        try f.expectPartition(1);
        try testing.expectEqual(before, (try f.files.storageBreakdown(1)).documents);
    }

    try f.files.trash(1, note_id);
    try f.expectPartition(1);
    try f.files.purge(1, note_id);
    try f.expectPartition(1);
    {
        const b = try f.files.storageBreakdown(1);
        try testing.expectEqual(@as(i64, 0), b.notebooks);
        try testing.expectEqual(@as(i64, 0), b.versions);
        try testing.expectEqual(@as(i64, 0), b.recycle_bin);
    }

    try f.files.trash(1, dir.id);
    try f.expectPartition(1);
    _ = try f.files.emptyBin(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 0), (try f.files.storageBreakdown(1)).total());
    try testing.expectEqual(@as(i64, 0), try f.used(1));
}

test "the storage partition is per-user: one household member's bytes never appear on another's panel" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000;");
    f.files.history.keep = 2;

    const a = try putBytes(&f, 1, null, "shared.note", "shared-notebook");
    freeEntry(a);
    const b = try putBytes(&f, 2, null, "shared.note", "shared-notebook");
    freeEntry(b);
    freeEntry(try putBytes(&f, 1, null, "shared.note", "user-1-edit"));
    freeEntry(try putBytes(&f, 2, null, "shared.note", "user-2-edit"));

    try f.expectPartition(1);
    try f.expectPartition(2);

    const id2 = (try f.files.resolvePath(2, "/shared.note")).?;
    try f.files.trash(2, id2);
    try f.files.purge(2, id2);
    try f.expectPartition(1);
    try f.expectPartition(2);
    try testing.expectEqual(@as(i64, 0), (try f.files.storageBreakdown(2)).total());
    try testing.expect((try f.files.storageBreakdown(1)).total() > 0);
}

test "a link that fails takes the thumbnail with the blob, not just the blob" {
    // Thumbnail seeded directly: the cleanup is under test, not a parse.
    var f = try Fixture.init();
    defer f.deinit();

    const bytes = "content that will not fit";
    const md5 = blobstore.md5HexOf(bytes);
    try f.files.thumbs.put(&md5, "fake-thumb-bytes");
    try testing.expect(f.files.thumbs.has(&md5));

    try f.db.exec("UPDATE capacity SET total_bytes = 1 WHERE user_id = 1;");
    try testing.expectError(error.QuotaExceeded, putBytes(&f, 1, null, "too-big.note", bytes));

    try testing.expect(!f.files.thumbs.has(&md5));
    try testing.expect(!f.files.blobs.has(&md5));
}

test "quota keeps charging while trashed and is refunded only at purge" {
    var f = try Fixture.init();
    defer f.deinit();

    const e = try putBytes(&f, 1, null, "a.note", "0123456789"); // 10 bytes
    defer freeEntry(e);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    try f.files.trash(1, e.id);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    (try f.files.restore(1, e.id)).deinit(testing.allocator);
    try testing.expectEqual(@as(i64, 10), try f.used(1));

    try f.files.trash(1, e.id);
    try f.files.purge(1, e.id);
    try testing.expectEqual(@as(i64, 0), try f.used(1));
}
