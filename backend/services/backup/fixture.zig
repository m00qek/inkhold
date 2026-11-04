//! What the backup tests share: a live install on disk (a migrated database,
//! a blob store with real files and their `blobs` rows, a credential key) and
//! an empty backup directory beside it.

const std = @import("std");
const testing = std.testing;
const sqlite = @import("../../db/sqlite.zig");
const schema = @import("../../db/schema.zig");
const blobstore = @import("../../store/blobs.zig");
const create_mod = @import("create.zig");
const Io = std.Io;
const Dir = Io.Dir;

pub const cred_key: [32]u8 = @splat(0x42);

pub const Install = struct {
    tmp: testing.TmpDir,
    root: []u8,
    db_path: [:0]u8,
    data_dir: []u8,
    cred_key_path: []u8,
    backup_dir: []u8,
    db: sqlite.Db,
    blobs_dir: Dir,
    live: blobstore.BlobStore,

    pub fn init() !Install {
        const gpa = testing.allocator;
        var tmp = testing.tmpDir(.{});
        errdefer tmp.cleanup();
        const root = try std.fmt.allocPrint(gpa, ".zig-cache/tmp/{s}", .{&tmp.sub_path});
        errdefer gpa.free(root);
        try tmp.dir.createDirPath(testing.io, "state/data/blobs");
        try tmp.dir.createDirPath(testing.io, "backup");
        try tmp.dir.writeFile(testing.io, .{ .sub_path = "state/cred.key", .data = &cred_key });

        const db_path = try std.fmt.allocPrintSentinel(gpa, "{s}/state/inkhold.db", .{root}, 0);
        errdefer gpa.free(db_path);
        const db = try sqlite.Db.open(db_path);
        errdefer db.close();
        try schema.migrate(db);
        const blobs_dir = try tmp.dir.openDir(testing.io, "state/data/blobs", .{});
        return .{
            .tmp = tmp,
            .root = root,
            .db_path = db_path,
            .data_dir = try std.fmt.allocPrint(gpa, "{s}/state/data", .{root}),
            .cred_key_path = try std.fmt.allocPrint(gpa, "{s}/state/cred.key", .{root}),
            .backup_dir = try std.fmt.allocPrint(gpa, "{s}/backup", .{root}),
            .db = db,
            .blobs_dir = blobs_dir,
            .live = try blobstore.BlobStore.init(testing.io, blobs_dir),
        };
    }

    pub fn paths(self: *const Install) create_mod.Paths {
        return .{ .db_path = self.db_path, .data_dir = self.data_dir, .cred_key_path = self.cred_key_path };
    }

    /// Stores `bytes` and records its `blobs` row, as an upload would.
    pub fn addBlob(self: *Install, bytes: []const u8) ![32]u8 {
        var r: Io.Reader = .fixed(bytes);
        const put = try self.live.put(&r, null);
        try self.db.run(
            "INSERT OR IGNORE INTO blobs(md5, size, refcount, created_at) VALUES(?1, ?2, 1, 0);",
            &.{ .{ .text = &put.md5 }, .{ .int = @intCast(put.size) } },
        );
        return put.md5;
    }

    /// A `blobs` row whose file is gone, as a purge racing the backup leaves it.
    pub fn addVanishedRow(self: *Install, md5: []const u8) !void {
        try self.db.run("INSERT INTO blobs(md5, size, refcount, created_at) VALUES(?1, 1, 1, 0);", &.{.{ .text = md5 }});
    }

    pub fn backup(self: *Install) !Dir {
        return self.tmp.dir.openDir(testing.io, "backup", .{ .iterate = true });
    }

    pub fn deinit(self: *Install) void {
        const gpa = testing.allocator;
        self.blobs_dir.close(testing.io);
        self.db.close();
        gpa.free(self.root);
        gpa.free(self.db_path);
        gpa.free(self.data_dir);
        gpa.free(self.cred_key_path);
        gpa.free(self.backup_dir);
        self.tmp.cleanup();
    }
};
