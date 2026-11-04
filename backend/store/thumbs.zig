//! Derived-thumbnail store: `thumbs/<source_md5>`, flat. A regenerable cache
//! whose cleanup rides the source blob's GC; written tmp + fsync + rename so a
//! crash cannot leave a zero-length file that `has()` would trust forever.

const std = @import("std");
const atomic = @import("atomic.zig");
const blobstore = @import("blobs.zig");

const Io = std.Io;
const Dir = std.Io.Dir;
const File = std.Io.File;

const md5_hex_len = blobstore.md5_hex_len;

pub const ThumbStore = struct {
    io: Io,
    /// Owned by the caller; must share a filesystem with its `tmp/` for the rename.
    root: Dir,

    pub fn init(io: Io, root: Dir) !ThumbStore {
        try atomic.ensureDir(io, root, "tmp");
        return .{ .io = io, .root = root };
    }

    /// Atomically stores the thumbnail for source blob `md5`. Overwrite is fine:
    /// same key, same bytes.
    pub fn put(self: ThumbStore, md5: []const u8, bytes: []const u8) !void {
        var final_buf: [md5_hex_len]u8 = undefined;
        const final_rel = finalRel(&final_buf, md5) orelse return error.InvalidMd5;

        var tmp_buf: [20]u8 = undefined; // "tmp/" + 16 hex
        const tmp_rel = atomic.tempName(self.io, &tmp_buf);
        const file = try self.root.createFile(self.io, tmp_rel, .{});
        var published = false;
        defer {
            file.close(self.io);
            if (!published) self.root.deleteFile(self.io, tmp_rel) catch {};
        }

        var wbuf: [4096]u8 = undefined;
        var fw = file.writerStreaming(self.io, &wbuf);
        try fw.interface.writeAll(bytes);
        try fw.interface.flush(); // userspace buffer -> fd
        try file.sync(self.io); // fd -> disk, BEFORE the rename publishes it

        try Dir.rename(self.root, tmp_rel, self.root, final_rel, self.io);
        published = true;
    }

    /// Opens the thumbnail for streaming. Caller closes.
    pub fn open(self: ThumbStore, md5: []const u8) !File {
        var buf: [md5_hex_len]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return error.InvalidMd5;
        return self.root.openFile(self.io, rel, .{});
    }

    /// A malformed md5 is a miss, not an error.
    pub fn has(self: ThumbStore, md5: []const u8) bool {
        var buf: [md5_hex_len]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return false;
        self.root.access(self.io, rel, .{}) catch return false;
        return true;
    }

    /// Missing or malformed is not an error.
    pub fn remove(self: ThumbStore, md5: []const u8) void {
        var buf: [md5_hex_len]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return;
        self.root.deleteFile(self.io, rel) catch {};
    }

    /// Removes staging files abandoned by a crash.
    /// Removes temp files abandoned by a crash.
    pub fn sweepTmp(self: ThumbStore) void {
        atomic.sweepTmp(self.io, self.root);
    }
};

/// The relative path (the md5 itself), or null unless `md5` is 32 chars; the
/// one place a key becomes a path.
fn finalRel(buf: *[md5_hex_len]u8, md5: []const u8) ?[]const u8 {
    if (md5.len != md5_hex_len) return null;
    @memcpy(buf, md5[0..md5_hex_len]);
    return buf[0..md5_hex_len];
}

// ---- tests ----

const testing = std.testing;

test "put/open/has/remove round-trip, and overwrite is idempotent" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try ThumbStore.init(io, tmp.dir);

    const md5 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try testing.expect(!store.has(md5));

    try store.put(md5, "jpeg-bytes-v1");
    try testing.expect(store.has(md5));
    {
        var f = try store.open(md5);
        defer f.close(io);
        var buf: [64]u8 = undefined;
        try testing.expectEqualStrings("jpeg-bytes-v1", try atomic.readAll(io, f, &buf));
    }

    try store.put(md5, "jpeg-bytes-v2");
    {
        var f = try store.open(md5);
        defer f.close(io);
        var buf: [64]u8 = undefined;
        try testing.expectEqualStrings("jpeg-bytes-v2", try atomic.readAll(io, f, &buf));
    }

    store.remove(md5);
    try testing.expect(!store.has(md5));
    store.remove(md5); // removing a missing entry is a no-op
}

test "a malformed md5 is a miss / no-op on every entry point, never a panic" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try ThumbStore.init(io, tmp.dir);

    // Includes a traversal-shaped key, refused by the length check alone.
    for ([_][]const u8{ "", "a", "abc", "0123456789abcdef", "0123456789abcdef0123456789abcdef0", "../../../../../../etc/passwd-x-32" }) |bad| {
        try testing.expect(!store.has(bad));
        try testing.expectError(error.InvalidMd5, store.open(bad));
        try testing.expectError(error.InvalidMd5, store.put(bad, "x"));
        store.remove(bad); // names nothing, deletes nothing
    }
}

test "sweepTmp clears staging and the store keeps working" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try ThumbStore.init(io, tmp.dir);

    {
        const f = try tmp.dir.createFile(io, "tmp/deadbeefdeadbeef", .{});
        f.close(io);
    }
    store.sweepTmp();
    tmp.dir.access(io, "tmp/deadbeefdeadbeef", .{}) catch |e| {
        try testing.expectEqual(error.FileNotFound, e);
    };

    const md5 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    try store.put(md5, "still works");
    try testing.expect(store.has(md5));
}

test "a failed put leaves no staging file behind" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try ThumbStore.init(io, tmp.dir);

    try testing.expectError(error.InvalidMd5, store.put("short", "x"));
    var it = try tmp.dir.openDir(io, "tmp", .{ .iterate = true });
    defer it.close(io);
    var walker = it.iterate();
    try testing.expect((try walker.next(io)) == null); // no staged leftovers
}
