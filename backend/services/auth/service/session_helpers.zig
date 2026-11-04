//! Helpers shared by the `session_test` tests.

const std = @import("std");
const sqlite = @import("../../../db/sqlite.zig");
const filesmod = @import("../../files.zig");
const blobstore = @import("../../../store/blobs.zig");
const thumbstore = @import("../../../store/thumbs.zig");

/// `deleteUser` releases blob references, so it needs a real store.
pub const TestStorage = struct {
    tmp: std.testing.TmpDir,
    files: filesmod.Files,

    pub fn init(db: sqlite.Db) !TestStorage {
        const tmp = std.testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(std.testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(std.testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(std.testing.io, thumbs_dir);
        return .{ .tmp = tmp, .files = filesmod.Files.init(std.testing.allocator, std.testing.io, db, store, thumbs) };
    }

    pub fn deinit(s: *TestStorage) void {
        s.tmp.cleanup();
    }
};
