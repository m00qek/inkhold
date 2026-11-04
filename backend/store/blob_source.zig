//! A `.note` parser source reading ranges from the blob store via `readRange`,
//! which bounds-checks untrusted offsets, so parse memory is independent of size.

const std = @import("std");
const repeat = @import("../util/repeat.zig").repeat;
const sn = @import("supernote");
const blobstore = @import("blobs.zig");

/// Must not move after `source()`: the returned Source points at it.
pub const BlobSource = struct {
    blobs: blobstore.BlobStore,
    md5: [blobstore.md5_hex_len]u8,
    size: u64,

    pub fn init(blobs: blobstore.BlobStore, md5: []const u8) !BlobSource {
        if (md5.len != blobstore.md5_hex_len) return error.InvalidMd5;
        var self: BlobSource = .{ .blobs = blobs, .md5 = undefined, .size = 0 };
        @memcpy(&self.md5, md5[0..blobstore.md5_hex_len]);
        self.size = try blobs.sizeOf(&self.md5);
        return self;
    }

    pub fn source(self: *BlobSource) sn.source.Source {
        return .{ .ranged = .{ .ctx = self, .size = self.size, .readFn = readFn } };
    }

    fn readFn(ctx: *anyopaque, offset: u64, dest: []u8) sn.source.Error!void {
        const self: *BlobSource = @ptrCast(@alignCast(ctx));
        _ = self.blobs.readRange(&self.md5, offset, dest.len, dest) catch |err| switch (err) {
            // A bad address in the file's own metadata: a parse error, not I/O.
            error.RangeOutOfBounds, error.InvalidMd5, error.BufferTooSmall => return error.OutOfBounds,
            else => return error.ReadFailed,
        };
    }
};

// ---- tests ----

const testing = std.testing;

test "BlobSource reads ranges out of a stored blob and refuses bad ones" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try blobstore.BlobStore.init(io, tmp.dir);

    const data = "0123456789abcdef";
    var r = std.Io.Reader.fixed(data);
    const res = try store.put(&r, null);

    var bs = try BlobSource.init(store, &res.md5);
    const src = bs.source();

    try testing.expectEqual(@as(u64, data.len), src.size());
    try testing.expect(!src.isSlice());
    try testing.expect(src.view(0, 4) == null); // ranged sources never lend

    var buf: [6]u8 = undefined;
    try src.read(4, &buf);
    try testing.expectEqualStrings("456789", &buf);

    try testing.expectError(error.OutOfBounds, src.read(12, &buf));
    try testing.expectError(error.OutOfBounds, src.u32le(std.math.maxInt(u64)));

    try testing.expectError(error.FileNotFound, BlobSource.init(store, repeat(u8, "f", 32)));
    try testing.expectError(error.InvalidMd5, BlobSource.init(store, "abc"));
}
