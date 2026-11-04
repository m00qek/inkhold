//! Fixture and helpers shared by the `index_export` tests.

const std = @import("std");
const sqlite = @import("../../../db/sqlite.zig");
const filesmod = @import("../../files.zig");
const derivedstore = @import("../../../store/derived.zig");
const testing = std.testing;
const schema = @import("../../../db/schema.zig");
const blobstore = @import("../../../store/blobs.zig");
const thumbstore = @import("../../../store/thumbs.zig");
const nb = @import("note_builder");
const deferred = @import("../../deferred.zig");
const index_export = @import("../index_export.zig");
const Row = index_export.Row;
const Manifest = index_export.Manifest;
const manifest = index_export.manifest;

/// Two users and the real `Files` service: rows come from the ingest path,
/// never hand-inserted.
pub const Fixture = struct {
    db: sqlite.Db,
    files: filesmod.Files,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    /// `drainNow` demands a real lock.
    lock: std.Io.Mutex = .init,

    pub fn init() !Fixture {
        const db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        for ([_]u8{ 1, 2 }) |uid| {
            try db.run(
                "INSERT INTO users(id, email, password_md5, created_at) VALUES(?1, ?1 || '@b.c', '0123456789abcdef0123456789abcdef', 0);",
                &.{.{ .int = uid }},
            );
            try db.run(
                "INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 1000000000);",
                &.{.{ .int = uid }},
            );
        }
        const tmp = testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        var files = filesmod.Files.init(testing.allocator, testing.io, db, store, thumbs);
        // Without the derived stores the cursor falls back to the database.
        const terms_dir = try tmp.dir.createDirPathOpen(testing.io, "terms", .{});
        files.terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
        const text_dir = try tmp.dir.createDirPathOpen(testing.io, "text", .{});
        files.text = try derivedstore.DerivedStore.init(testing.io, text_dir);
        return .{
            .db = db,
            .files = files,
            .tmp = tmp,
            .arena = std.heap.ArenaAllocator.init(testing.allocator),
        };
    }

    pub fn deinit(f: *Fixture) void {
        f.arena.deinit();
        f.db.close();
        f.tmp.cleanup();
    }

    pub fn a(f: *Fixture) std.mem.Allocator {
        return f.arena.allocator();
    }

    /// A real `.note` whose page carries `labels` as finished recognition.
    pub fn putNote(f: *Fixture, user_id: u64, name: []const u8, labels: []const []const u8) !u64 {
        const bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
            .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
            .recogn_status = 1,
            .recogn_labels = labels,
        }} });
        defer testing.allocator.free(bytes);
        return f.putBytes(user_id, name, bytes);
    }

    /// Content the indexer cannot parse as a `.note`.
    pub fn putBytes(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !u64 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer e.deinit(testing.allocator);
        return e.id;
    }

    /// Runs the real deferred worker to exhaustion.
    pub fn drain(f: *Fixture) void {
        deferred.drainNow(testing.allocator, f.db, f.files.blobs, &f.lock, testing.io);
    }

    pub fn touch(f: *Fixture, id: u64, at: i64) !void {
        try f.db.run(
            "UPDATE files SET updated_at = ?2 WHERE id = ?1;",
            &.{ .{ .int = @intCast(id) }, .{ .int = at } },
        );
    }

    pub fn manifest(f: *Fixture, user_id: u64) !Manifest {
        return index_export.manifest(f.a(), f.files, user_id);
    }

    pub fn rowFor(f: *Fixture, user_id: u64, file_id: u64) !?Row {
        const m = try f.manifest(user_id);
        for (m.rows) |r| if (r.file_id == @as(i64, @intCast(file_id))) return r;
        return null;
    }
};

pub fn fill(f: *Fixture, user_id: u64, prefix: []const u8, from: usize, to: usize) !void {
    for (from..to) |i| _ = try f.putBytes(
        user_id,
        try std.fmt.allocPrint(f.a(), "{s}{d:0>4}.pdf", .{ prefix, i }),
        try std.fmt.allocPrint(f.a(), "%PDF-1.4 {s} {d}", .{ prefix, i }),
    );
}
