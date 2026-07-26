//! The blob-backed `.note` source: the parser reading ranges out of the blob
//! store instead of out of a buffer.
//!
//! This is the piece that lets indexing stop allocating whole notes. `.note`
//! parsing is entirely address-based (footer → header → page table → layer
//! blocks), so every read it performs is small and positional — exactly what
//! `BlobStore.readRange` provides. Peak memory for a parse becomes the parsed
//! metadata plus the largest single metadata block, independent of file size.
//!
//! `readRange` is used rather than reaching for the file handle directly
//! because it is the audited path: it rejects wrapping offsets, validates every
//! range against the blob's real on-disk size, and turns a short read into
//! `error.BlobTruncated` rather than a partial success. Offsets here come from
//! the `.note`'s own metadata — data an untrusted device wrote — so that
//! defensiveness is the point. The cost is one open/stat per read; a parse
//! performs a few reads per page, all tiny, and it happens once per blob.

const std = @import("std");
const sn = @import("supernote");
const blobstore = @import("blobs.zig");

/// A `source.Source` over one stored blob. Must not be moved after `source()`
/// is called — the returned Source holds a pointer to it.
pub const BlobSource = struct {
    blobs: blobstore.BlobStore,
    /// Owned copy: the Source outlives whatever slice the caller passed in.
    md5: [blobstore.md5_hex_len]u8,
    size: u64,

    /// Fails if the blob is not on disk (`error.FileNotFound`) or the md5 is
    /// malformed.
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
            // A bad address in the file's own metadata — a parse error, not an
            // I/O failure, and the caller records it as "unindexable".
            error.RangeOutOfBounds, error.InvalidMd5, error.BufferTooSmall => return error.OutOfBounds,
            // The blob vanished or shrank under us: genuinely an I/O failure.
            else => return error.ReadFailed,
        };
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

    // Past EOF, and an offset whose length wraps: refused as OutOfBounds, which
    // the parser turns into a clean parse failure rather than a panic.
    try testing.expectError(error.OutOfBounds, src.read(12, &buf));
    try testing.expectError(error.OutOfBounds, src.u32le(std.math.maxInt(u64)));

    // A missing blob is refused at init, before any parse begins.
    try testing.expectError(error.FileNotFound, BlobSource.init(store, "f" ** 32));
    try testing.expectError(error.InvalidMd5, BlobSource.init(store, "abc"));
}
