//! Digests removed for good, with their handwritten notes: the rows and the
//! notes' blob references go in one transaction, the blobs' bytes after it
//! commits, as a file's do (`files/bin.zig`). The bin's retention, its
//! "delete for good" and Empty bin all come here.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const digest = @import("digest.zig");
const filesmod = @import("files.zig");

/// Purges every account's digests deleted before `before_ms`. Returns how
/// many handwritten notes' references it released.
pub fn purgeBefore(db: sqlite.Db, files: filesmod.Files, before_ms: i64) !usize {
    var arena = std.heap.ArenaAllocator.init(files.gpa);
    defer arena.deinit();
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    const held = try digest.purgeDeleted(db, arena.allocator(), before_ms);
    try commitReleasing(db, files, arena.allocator(), held);
    return held.len;
}

/// Removes one digest from `user_id`'s bin for good. False when it is not
/// in that bin.
pub fn purgeOne(db: sqlite.Db, files: filesmod.Files, user_id: u64, id: u64) !bool {
    var arena = std.heap.ArenaAllocator.init(files.gpa);
    defer arena.deinit();
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    try digest.markPurgedUnseen(db, user_id, id, nowMs(files));
    const gone = (try digest.purgeDigest(db, arena.allocator(), user_id, id)) orelse {
        try db.exec("ROLLBACK;");
        return false;
    };
    const held: []const []const u8 = if (gone.held) |m| &.{m} else &.{};
    try commitReleasing(db, files, arena.allocator(), held);
    return true;
}

/// Empties `user_id`'s bin of digests. Returns how many went.
pub fn purgeAll(db: sqlite.Db, files: filesmod.Files, user_id: u64) !u64 {
    var arena = std.heap.ArenaAllocator.init(files.gpa);
    defer arena.deinit();
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    try digest.markPurgedUnseen(db, user_id, null, nowMs(files));
    const emptied = try digest.emptyDigestBin(db, arena.allocator(), user_id);
    try commitReleasing(db, files, arena.allocator(), emptied.held);
    return emptied.digests;
}

fn nowMs(files: filesmod.Files) i64 {
    return std.Io.Clock.real.now(files.io).toMilliseconds();
}

/// Releases the rows' references to `held`, commits, then removes the bytes
/// of each blob no row references any more.
fn commitReleasing(db: sqlite.Db, files: filesmod.Files, a: std.mem.Allocator, held: []const []const u8) !void {
    var remove: std.ArrayList([]const u8) = .empty;
    for (held) |md5| if (try files.releaseBlob(md5)) try remove.append(a, md5);
    try db.exec("COMMIT;");
    for (remove.items) |md5| files.removeBlobFiles(md5);
}

const Fixture = struct {
    db: sqlite.Db,
    tmp: std.testing.TmpDir,
    files: filesmod.Files,

    /// A database with one account and a blob store holding `md5`'s blob,
    /// referenced `refs` times.
    fn init(md5: []const u8, refs: i64) !*Fixture {
        const testing = std.testing;
        const schema = @import("../db/schema.zig");
        const blobstore = @import("../store/blobs.zig");
        const thumbstore = @import("../store/thumbs.zig");
        const f = try testing.allocator.create(Fixture);
        errdefer testing.allocator.destroy(f);
        f.db = try sqlite.Db.openMemory();
        try schema.migrate(f.db);
        try f.db.exec("INSERT INTO users(id, email, password_md5, cred_enc, is_admin, created_at) VALUES(1,'a@h','','',1,0);");
        f.tmp = testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(testing.io, f.tmp.dir);
        const thumbs_dir = try f.tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        f.files = filesmod.Files.init(testing.allocator, testing.io, f.db, store, thumbs);
        try f.db.run("INSERT INTO blobs(md5, size, refcount, created_at) VALUES(?1, 3, ?2, 0);", &.{ .{ .text = md5 }, .{ .int = refs } });
        return f;
    }

    fn deinit(f: *Fixture) void {
        f.tmp.cleanup();
        f.db.close();
        std.testing.allocator.destroy(f);
    }

    fn refcount(f: *Fixture, md5: []const u8) !?i64 {
        var r = (try f.db.row("SELECT refcount FROM blobs WHERE md5 = ?1;", &.{.{ .text = md5 }})) orelse return null;
        defer r.finalize();
        return r.int(0);
    }
};

test "an expired deleted digest is purged and its handwritten note's blob released" {
    const testing = std.testing;
    const md5 = "245354713d4c121a2368d9295f6379ca";
    const f = try Fixture.init(md5, 1);
    defer f.deinit();
    // Deleted long ago, holding the note; and one deleted just now, kept.
    try f.db.exec(
        \\INSERT INTO digests(user_id, handwrite_md5, handwrite_inner_name, created_at, updated_at, deleted, deleted_at)
        \\VALUES (1, '245354713d4c121a2368d9295f6379ca', 'abcd', 0, 0, 1, 1000),
        \\       (1, NULL, NULL, 0, 0, 1, 900000);
    );
    try testing.expectEqual(@as(usize, 1), try purgeBefore(f.db, f.files, 5000));
    var left = (try f.db.row("SELECT COUNT(*) FROM digests;", &.{})).?;
    defer left.finalize();
    try testing.expectEqual(@as(i64, 1), left.int(0));
    try testing.expectEqual(@as(?i64, null), try f.refcount(md5));
}

test "delete for good: only from the account's bin; a note a live digest shares stays" {
    const testing = std.testing;
    const md5 = "245354713d4c121a2368d9295f6379ca";
    const f = try Fixture.init(md5, 2);
    defer f.deinit();
    // The same note on a deleted digest and on a live one.
    try f.db.exec(
        \\INSERT INTO digests(id, user_id, handwrite_md5, handwrite_inner_name, created_at, updated_at, deleted, deleted_at)
        \\VALUES (7, 1, '245354713d4c121a2368d9295f6379ca', 'a', 0, 0, 1, 1000),
        \\       (8, 1, '245354713d4c121a2368d9295f6379ca', 'b', 0, 0, 0, NULL);
    );
    try testing.expect(!try purgeOne(f.db, f.files, 2, 7));
    try testing.expect(!try purgeOne(f.db, f.files, 1, 8));
    try testing.expect(try purgeOne(f.db, f.files, 1, 7));
    try testing.expectEqual(@as(?i64, 1), try f.refcount(md5));
    try testing.expect(!try purgeOne(f.db, f.files, 1, 7));
}
