//! The shared fixture and helpers for the `files` tests.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const Entry = filesmod.Entry;
const BinEntry = filesmod.BinEntry;
const md5_len = filesmod.md5_len;
const repeat = @import("../../util/repeat.zig").repeat;
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");

const schema = @import("../../db/schema.zig");

pub const Fixture = struct {
    db: sqlite.Db,
    files: Files,
    tmp: testing.TmpDir,

    pub fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1024);");
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 1024);");

        const tmp = testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{ .db = db, .files = Files.init(testing.allocator, testing.io, db, store, thumbs), .tmp = tmp };
    }

    pub fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    pub fn used(f: *Fixture, user_id: u64) !i64 {
        return (try f.files.capacity(user_id)).used;
    }

    /// `used_bytes` rebuilt from the tables: distinct blobs held by the user's
    /// files (trashed included) and their history rows.
    fn trueUsed(f: *Fixture, user_id: u64) !i64 {
        var r = (try f.db.row(
            \\SELECT COALESCE(SUM(b.size), 0) FROM blobs b WHERE b.md5 IN (
            \\  SELECT md5 FROM files
            \\   WHERE user_id = ?1 AND is_folder = 0 AND md5 IS NOT NULL AND md5 <> ''
            \\  UNION
            \\  SELECT fh.md5 FROM file_history fh JOIN files f ON f.id = fh.file_id
            \\   WHERE f.user_id = ?1
            \\);
        , &.{.{ .int = @intCast(user_id) }})) orelse return 0;
        defer r.finalize();
        return r.int(0);
    }

    /// The five categories sum exactly to `used_bytes`, and that to the rebuild.
    pub fn expectPartition(f: *Fixture, user_id: u64) !void {
        const b = try f.files.storageBreakdown(user_id);
        try testing.expectEqual(try f.trueUsed(user_id), b.total());
        try testing.expectEqual(try f.used(user_id), b.total());
    }

    /// Running total equals the reconstruction.
    pub fn expectQuotaBalanced(f: *Fixture, user_id: u64) !void {
        try testing.expectEqual(try f.trueUsed(user_id), try f.used(user_id));
    }
};

pub fn putBytes(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, data: []const u8) !Entry {
    var r = std.Io.Reader.fixed(data);
    return f.files.putFile(user_id, parent, name, &r, null);
}

pub fn countOf(f: *Fixture, sql: []const u8) !i64 {
    var s = try f.db.prepare(sql);
    defer s.finalize();
    _ = try s.step();
    return s.columnInt(0);
}

pub fn hasCapacityRow(f: *Fixture, user_id: u64) !bool {
    var s = try f.db.prepare("SELECT 1 FROM capacity WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    return try s.step();
}

pub fn freeEntry(e: Entry) void {
    e.deinit(testing.allocator);
}

pub fn dupeMd5(m: []const u8) [md5_len]u8 {
    var out: [md5_len]u8 = undefined;
    @memcpy(&out, m[0..md5_len]);
    return out;
}

pub fn blobRefcount(f: *Fixture, md5: []const u8) !i64 {
    var r = (try f.db.row("SELECT refcount FROM blobs WHERE md5 = ?1;", &.{.{ .text = md5 }})) orelse return -1;
    defer r.finalize();
    return r.int(0);
}

pub fn historyRows(f: *Fixture, md5: []const u8) !i64 {
    var s = try f.db.prepare("SELECT COUNT(*) FROM file_history WHERE md5 = ?1;");
    defer s.finalize();
    s.bindText(1, md5);
    _ = try s.step();
    return s.columnInt(0);
}

pub fn binRow(arena: std.mem.Allocator, f: *Fixture, user_id: u64, id: u64) !?BinEntry {
    const rows = try f.files.listBin(arena, user_id);
    for (rows) |r| {
        if (r.id == id) return r;
    }
    return null;
}

/// The synthetic `.note` builder, via the root build.zig's `note_builder` module.
const nb = @import("note_builder");

/// A minimal PNG head (320×240 IHDR).
pub const cover_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

/// A one-page `.note` with `cover` as its `COVER_2` block (null = coverless).
pub fn buildNote(gpa: std.mem.Allocator, cover: ?[]const u8) ![]u8 {
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
        .covers = if (cover) |c| &.{.{ .bytes = c }} else &.{},
    });
}

pub fn noteIndexedAt(f: *Fixture, md5: []const u8) !?i64 {
    var r = (try f.db.row("SELECT indexed_at FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = md5 }})) orelse return null;
    defer r.finalize();
    return r.int(0);
}
