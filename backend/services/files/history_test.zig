//! Tests for version history and the per-user version policy.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const history = @import("history.zig");
const md5_len = filesmod.md5_len;
const repeat = @import("../../repeat.zig").repeat;
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const countOf = fx.countOf;
const freeEntry = fx.freeEntry;
const dupeMd5 = fx.dupeMd5;
const blobRefcount = fx.blobRefcount;
const historyRows = fx.historyRows;
const cover_png = fx.cover_png;
const buildNote = fx.buildNote;
const noteIndexedAt = fx.noteIndexedAt;

test "HISTORY: supersede RETAINS the old version — history row, blob on disk, render index kept" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const b1 = try buildNote(testing.allocator, cover_png);
    defer testing.allocator.free(b1);
    const v1 = try putBytes(&f, 1, null, "bujo.note", b1);
    const old_md5 = dupeMd5(v1.md5.?);
    const old_size = v1.size;
    freeEntry(v1);
    try testing.expect((try noteIndexedAt(&f, &old_md5)) != null); // render index minted
    try testing.expectEqual(@as(i64, 1), try blobRefcount(&f, &old_md5)); // one live ref

    const b2 = try buildNote(testing.allocator, null); // coverless -> different content -> new blob
    defer testing.allocator.free(b2);
    const v2 = try putBytes(&f, 1, null, "bujo.note", b2);
    defer freeEntry(v2);
    const new_md5 = dupeMd5(v2.md5.?);
    try testing.expect(!std.mem.eql(u8, &old_md5, &new_md5));

    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expect(f.files.blobs.has(&old_md5)); // the OLD blob is still on disk (not GC'd)
    try testing.expect((try noteIndexedAt(&f, &old_md5)) != null); // its render index rode along for free
    try testing.expectEqual(@as(i64, 0), try blobRefcount(&f, &old_md5));
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &old_md5));

    {
        var s = try f.db.prepare("SELECT md5, size, file_id FROM file_history;");
        defer s.finalize();
        try testing.expect(try s.step());
        try testing.expectEqualStrings(&old_md5, s.columnText(0));
        try testing.expectEqual(@as(i64, @intCast(old_size)), s.columnInt(1));
        try testing.expectEqual(@as(i64, @intCast(v2.id)), s.columnInt(2)); // same file row
    }
    try testing.expect(f.files.blobs.has(&new_md5)); // the current version present too
}

test "HISTORY: keep = K retains only the newest K superseded versions; evicted blobs GC'd" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 2;

    var mds: [5][md5_len]u8 = undefined;
    for (0..5) |i| {
        const body = try std.fmt.allocPrint(testing.allocator, "version-{d}-unique-body", .{i});
        defer testing.allocator.free(body);
        const e = try putBytes(&f, 1, null, "doc.txt", body);
        mds[i] = dupeMd5(e.md5.?);
        freeEntry(e);
    }

    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expect(!f.files.blobs.has(&mds[0])); // v1 evicted -> blob GC'd
    try testing.expect(!f.files.blobs.has(&mds[1])); // v2 evicted -> blob GC'd
    try testing.expect(f.files.blobs.has(&mds[2])); // v3 retained
    try testing.expect(f.files.blobs.has(&mds[3])); // v4 retained
    try testing.expect(f.files.blobs.has(&mds[4])); // v5 is the live current
    try testing.expect((try noteIndexedAt(&f, &mds[0])) == null);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM blobs WHERE refcount < 0;")); // never over-decremented
}

test "HISTORY: eviction never DELETEs with a cursor open on file_history" {
    // Pins the collect-then-delete discipline via `sqlite.CursorWatch`; the
    // outcome is the same either way. Each arm needs its own configuration.
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    {
        f.files.history.keep = 2;
        f.files.history.max_bytes = 1_000_000;
        var w: sqlite.CursorWatch = .{ .db = f.db, .table = "file_history" };
        w.arm();
        defer w.disarm();
        for (0..6) |i| {
            const body = try std.fmt.allocPrint(testing.allocator, "bodybytes{d}", .{i}); // exactly 10 bytes
            defer testing.allocator.free(body);
            freeEntry(try putBytes(&f, 1, null, "doc.txt", body));
        }
        try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
        try testing.expect(w.mutations > 0);
        try testing.expectEqual(@as(usize, 0), w.overlaps);
    }

    {
        f.files.history.keep = 100;
        f.files.history.max_bytes = 20;
        var w: sqlite.CursorWatch = .{ .db = f.db, .table = "file_history" };
        w.arm();
        defer w.disarm();
        for (0..6) |i| {
            const body = try std.fmt.allocPrint(testing.allocator, "otherbyt{d}x", .{i}); // exactly 10 bytes
            defer testing.allocator.free(body);
            freeEntry(try putBytes(&f, 1, null, "doc2.txt", body));
        }
        try testing.expect(try history.historyBytes(f.files) <= 20);
        try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
        try testing.expect(w.mutations > 0);
        try testing.expectEqual(@as(usize, 0), w.overlaps);
    }
}

test "HISTORY: the max_bytes ceiling evicts oldest history-only versions until under" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 100; // K is not the bound here — max_bytes is
    f.files.history.max_bytes = 20; // room for at most two 10-byte history blobs

    var mds: [6][md5_len]u8 = undefined;
    for (0..6) |i| {
        const body = try std.fmt.allocPrint(testing.allocator, "bodybytes{d}", .{i}); // exactly 10 bytes
        defer testing.allocator.free(body);
        try testing.expectEqual(@as(usize, 10), body.len);
        const e = try putBytes(&f, 1, null, "doc.txt", body);
        mds[i] = dupeMd5(e.md5.?);
        freeEntry(e);
    }

    try testing.expect(try history.historyBytes(f.files) <= 20);
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expect(!f.files.blobs.has(&mds[0]));
    try testing.expect(!f.files.blobs.has(&mds[1]));
    try testing.expect(!f.files.blobs.has(&mds[2]));
    try testing.expect(f.files.blobs.has(&mds[3]));
    try testing.expect(f.files.blobs.has(&mds[4]));
    try testing.expect(f.files.blobs.has(&mds[5]));
}

test "§6: a user AT their allotment can still EDIT — history gives way, the edit does not" {
    var f = try Fixture.init();
    defer f.deinit();
    f.files.history.keep = 5;
    try f.db.exec("UPDATE capacity SET total_bytes = 30 WHERE user_id = 1;"); // exactly three 10-byte blobs

    freeEntry(try putBytes(&f, 1, null, "n.note", "aaaaaaaaaa"));
    freeEntry(try putBytes(&f, 1, null, "n.note", "bbbbbbbbbb"));
    freeEntry(try putBytes(&f, 1, null, "n.note", "cccccccccc"));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1)); // current + two retained: FULL
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    freeEntry(try putBytes(&f, 1, null, "n.note", "dddddddddd"));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1));
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    {
        const e = (try f.files.get(1, (try f.files.resolvePath(1, "/n.note")).?)).?;
        defer freeEntry(e);
        try testing.expectEqualStrings(&blobstore.md5HexOf("dddddddddd"), e.md5.?);
    }
    try testing.expectEqual(@as(i64, 0), try historyRows(&f, &blobstore.md5HexOf("aaaaaaaaaa")));
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &blobstore.md5HexOf("cccccccccc")));

    {
        var r = std.Io.Reader.fixed(repeat(u8, "x", 40));
        try testing.expectError(error.QuotaExceeded, f.files.putFile(1, null, "big.note", &r, null));
    }
    try f.expectQuotaBalanced(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1));
    try testing.expectEqual(@as(i64, 2), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    freeEntry(try putBytes(&f, 1, null, "n.note", "eeeeeeeeee"));
    freeEntry(try putBytes(&f, 1, null, "n.note", "ffffffffff"));
    try f.expectQuotaBalanced(1);
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 30), try f.used(1));
}

test "§6: eviction is PER-USER — one person's churn can no longer evict another's versions" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000;");
    f.files.history.keep = 100; // K is not the bound here
    f.files.history.max_bytes = 20; // a global ceiling this test blows through

    freeEntry(try putBytes(&f, 2, null, "u2.note", "user-two-original"));
    freeEntry(try putBytes(&f, 2, null, "u2.note", "user-two-edited!!"));
    const u2_rows = "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = 2;";
    try testing.expectEqual(@as(i64, 1), try countOf(&f, u2_rows));

    for (0..6) |i| {
        const body = try std.fmt.allocPrint(testing.allocator, "user-one-version-{d}", .{i});
        defer testing.allocator.free(body);
        freeEntry(try putBytes(&f, 1, null, "u1.note", body));
    }

    try testing.expectEqual(@as(i64, 1), try countOf(&f, u2_rows));
    try f.expectQuotaBalanced(1);
    try f.expectQuotaBalanced(2);
    try f.expectPartition(1);
    try f.expectPartition(2);
}

test "HISTORY: a dedup'd blob is never GC'd while a live file OR a history row still holds it" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 5;

    const a1 = try putBytes(&f, 1, null, "a.txt", "shared-content");
    const x = dupeMd5(a1.md5.?);
    freeEntry(a1);
    const b1 = try putBytes(&f, 1, null, "b.txt", "shared-content");
    defer freeEntry(b1);
    try testing.expect(std.mem.eql(u8, &x, b1.md5.?)); // deduped onto the same blob
    try testing.expectEqual(@as(i64, 2), try blobRefcount(&f, &x)); // two live refs

    const a2 = try putBytes(&f, 1, null, "a.txt", "a-new-content");
    defer freeEntry(a2);
    try testing.expectEqual(@as(i64, 1), try blobRefcount(&f, &x)); // b still live
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &x));
    try testing.expect(f.files.blobs.has(&x));

    const b2 = try putBytes(&f, 1, null, "b.txt", "b-new-content");
    defer freeEntry(b2);
    try testing.expectEqual(@as(i64, 0), try blobRefcount(&f, &x));
    try testing.expectEqual(@as(i64, 2), try historyRows(&f, &x));
    try testing.expect(f.files.blobs.has(&x)); // retained purely by history

    try f.files.trash(1, a2.id);
    try f.files.purge(1, a2.id);
    try testing.expectEqual(@as(i64, 1), try historyRows(&f, &x));
    try testing.expect(f.files.blobs.has(&x));

    try f.files.trash(1, b2.id);
    try f.files.purge(1, b2.id);
    try testing.expectEqual(@as(i64, 0), try historyRows(&f, &x));
    try testing.expect(!f.files.blobs.has(&x));
}

test "setVersionPolicy: lowering evicts NOW, refunds the bytes, and keeps the partition exact" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 5;
    f.files.history.max_keep = 5; // default AND ceiling here, so the clamp below has a bound to hit

    inline for (.{ "v1", "v2", "v3", "v4", "v5" }) |body| {
        const e = try putBytes(&f, 1, null, "bujo.note", "notebook-" ++ body);
        freeEntry(e);
    }
    try f.expectPartition(1);
    try testing.expectEqual(@as(i64, 4), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));

    {
        const counts = try f.files.retainedPerFile(testing.allocator, 1);
        defer testing.allocator.free(counts);
        try testing.expectEqualSlices(u32, &.{4}, counts);
    }

    const before = try f.used(1);
    const change = try f.files.setVersionPolicy(1, 1);

    try testing.expectEqual(@as(u32, 1), change.policy.keep);
    try testing.expectEqual(@as(u32, 3), change.removed_versions);
    try testing.expect(change.freed_bytes > 0);
    try testing.expectEqual(before - change.freed_bytes, try f.used(1));
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try f.expectPartition(1);

    const raised = try f.files.setVersionPolicy(1, 4);
    try testing.expectEqual(@as(u32, 0), raised.removed_versions);
    try testing.expectEqual(@as(i64, 0), raised.freed_bytes);
    try testing.expectEqual(@as(i64, 1), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try f.expectPartition(1);

    const over = try f.files.setVersionPolicy(1, 9999);
    try testing.expectEqual(@as(u32, 5), over.policy.keep);
    try testing.expectEqual(@as(u32, 5), over.policy.max_keep);

    const off = try f.files.setVersionPolicy(1, 0);
    try testing.expectEqual(@as(u32, 0), off.policy.keep);
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM file_history;"));
    try testing.expectEqual(@as(i64, 0), (try f.files.storageBreakdown(1)).versions);
    try f.expectPartition(1);
    {
        const counts = try f.files.retainedPerFile(testing.allocator, 1);
        defer testing.allocator.free(counts);
        try testing.expectEqual(@as(usize, 0), counts.len); // no file has history now
    }
}

test "the default and the ceiling are two knobs, and the default is always reachable" {
    var f = try Fixture.init();
    defer f.deinit();

    f.files.history.keep = 5;
    f.files.history.max_keep = 15;
    {
        const p = try f.files.versionPolicy(1);
        try testing.expectEqual(@as(u32, 5), p.keep);
        try testing.expectEqual(@as(u32, 15), p.max_keep);
    }
    {
        const c = try f.files.setVersionPolicy(1, 12);
        try testing.expectEqual(@as(u32, 12), c.policy.keep);
        try testing.expectEqual(@as(u32, 12), (try f.files.versionPolicy(1)).keep);
    }
    {
        const c = try f.files.setVersionPolicy(1, 99);
        try testing.expectEqual(@as(u32, 15), c.policy.keep); // clamped to the ceiling
    }

    // A pre-`max_keep` install with `keep = 20` must not be clamped to 15.
    f.files.history.keep = 20;
    f.files.history.max_keep = 15;
    {
        const p = try f.files.versionPolicy(2);
        try testing.expectEqual(@as(u32, 20), p.keep); // untouched
        try testing.expectEqual(@as(u32, 20), p.max_keep); // and choosable
    }
}

test "setVersionPolicy is per-user: lowering your dial never touches a housemate's history" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("INSERT OR IGNORE INTO users(id, email, name) VALUES(2, 'b@h.lan', 'b');");
    try f.db.exec("INSERT OR IGNORE INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000000);");
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    f.files.history.keep = 5;

    inline for (.{ "1", "2", "3" }) |v| {
        const a = try putBytes(&f, 1, null, "a.note", "ana-" ++ v);
        freeEntry(a);
        const b = try putBytes(&f, 2, null, "b.note", "ben-" ++ v);
        freeEntry(b);
    }
    const ben_before = try countOf(&f, "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = 2;");
    try testing.expect(ben_before > 0);
    const ben_used_before = try f.used(2);

    _ = try f.files.setVersionPolicy(1, 0);

    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = 1;"));
    try testing.expectEqual(ben_before, try countOf(&f, "SELECT COUNT(*) FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = 2;"));
    try testing.expectEqual(ben_used_before, try f.used(2));
    try f.expectPartition(1);
    try f.expectPartition(2);
}
