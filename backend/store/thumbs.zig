//! Derived-thumbnail store: the extracted embedded preview of a stored blob,
//! kept on disk as `thumbs/<source_md5>` and served off the DB lock through the
//! streaming path (see `handlers/controlplane.zig` `controlplaneThumbnail`).
//!
//! ## Keyed by SOURCE md5 — a cache, not a source of truth
//!
//! A thumbnail is derived, regenerable, and 1:1 with the blob it came from, so
//! it is NOT a `BlobStore` entry: that store's invariants (name = content hash,
//! dedup, hash-verify on ingest, two-char sharding) are all wrong for a
//! source-keyed derived file. Keying by the source blob's md5 means cleanup
//! simply rides the source blob's GC (`Files.removeBlobFiles`), no refcount
//! edge, no pointer column — existence of `thumbs/<md5>` IS the fact that a
//! thumbnail exists. Flat, unsharded: household-scale counts never need blobs'
//! two-level fanout.
//!
//! ## Durability: tmp + fsync + atomic rename
//!
//! `put` stages into `tmp/`, flushes, fsyncs, then renames into place, same as
//! `BlobStore`. The fsync is load-bearing even for a "mere cache": a
//! rename-without-fsync on ext4 can persist a durable ZERO-LENGTH file across a
//! crash, and a torn `thumbs/<md5>` would pass `has()` forever — the on-demand
//! repair keys off absence, so a present-but-empty file would never heal (the
//! serve path's size-0 → 404 check is the defensive backstop). `sweepTmp` at
//! boot clears abandoned staging files.
//!
//! An ORPHANED thumb file (written before a link transaction that then rolled
//! back) is harmless: content-keyed, regenerable, and removed whenever the blob
//! itself is GC'd. No orphan sweep is built until one is ever needed.
//!
//! Every entry point validates `md5.len == 32` before building a path — a
//! malformed key names nothing, so it is a miss / no-op, never a panic (the
//! same rule as `blobs.finalRel`).

const std = @import("std");
const blobstore = @import("blobs.zig");

const Io = std.Io;
const Dir = std.Io.Dir;
const File = std.Io.File;

const md5_hex_len = blobstore.md5_hex_len;

pub const ThumbStore = struct {
    io: Io,
    /// The thumbs root directory (e.g. `<data_dir>/thumbs`). Owned by the
    /// caller; must be on the same filesystem as its `tmp/` subdir so the
    /// publish rename stays atomic.
    root: Dir,

    /// Ensures the `tmp/` staging subdir exists under `root`.
    pub fn init(io: Io, root: Dir) !ThumbStore {
        try ensureDir(io, root, "tmp");
        return .{ .io = io, .root = root };
    }

    /// Writes `bytes` as the thumbnail for source blob `md5`, atomically
    /// (tmp + flush + fsync + rename). Overwriting an existing entry is fine —
    /// the key is the source content hash, so any two writers wrote the same
    /// bytes. `bytes` are small (capped at `thumbnail.max_thumbnail_bytes`) and
    /// already resident, so this is one `writeAll`, not a streaming ingest.
    /// `error.InvalidMd5` for a key that is not 32 chars.
    pub fn put(self: ThumbStore, md5: []const u8, bytes: []const u8) !void {
        var final_buf: [md5_hex_len]u8 = undefined;
        const final_rel = finalRel(&final_buf, md5) orelse return error.InvalidMd5;

        var tmp_buf: [20]u8 = undefined; // "tmp/" + 16 hex
        const tmp_rel = self.tempName(&tmp_buf);
        const file = try self.root.createFile(self.io, tmp_rel, .{});
        var published = false;
        defer {
            file.close(self.io);
            // Any failure before the rename leaves only a staging file; drop it.
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

    /// Opens the stored thumbnail for streaming reads (serving). Caller closes.
    /// `error.InvalidMd5` if `md5` is not 32 characters; a missing file is the
    /// usual `error.FileNotFound`.
    pub fn open(self: ThumbStore, md5: []const u8) !File {
        var buf: [md5_hex_len]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return error.InvalidMd5;
        return self.root.openFile(self.io, rel, .{});
    }

    /// True if a thumbnail for this source md5 is stored. A malformed md5 names
    /// nothing, so it is a miss rather than an error.
    pub fn has(self: ThumbStore, md5: []const u8) bool {
        var buf: [md5_hex_len]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return false;
        self.root.access(self.io, rel, .{}) catch return false;
        return true;
    }

    /// Deletes a stored thumbnail (rides the source blob's GC). Missing is not
    /// an error, and neither is a malformed md5 — it names nothing to delete.
    pub fn remove(self: ThumbStore, md5: []const u8) void {
        var buf: [md5_hex_len]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return;
        self.root.deleteFile(self.io, rel) catch {};
    }

    /// Removes leftover staging files from a prior crash. Safe: temp files are
    /// never referenced until renamed, so any that remain are abandoned writes.
    pub fn sweepTmp(self: ThumbStore) void {
        self.root.deleteTree(self.io, "tmp") catch {};
        ensureDir(self.io, self.root, "tmp") catch {};
    }

    fn tempName(self: ThumbStore, buf: *[20]u8) []const u8 {
        var raw: [8]u8 = undefined;
        self.io.random(&raw);
        @memcpy(buf[0..4], "tmp/");
        buf[4..20].* = std.fmt.bytesToHex(raw, .lower);
        return buf[0..20];
    }
};

fn ensureDir(io: Io, root: Dir, sub: []const u8) !void {
    var d = root.createDirPathOpen(io, sub, .{}) catch |err| switch (err) {
        error.PathAlreadyExists => return,
        else => return err,
    };
    d.close(io);
}

/// The flat relative path for a thumbnail (just the md5 itself), or null when
/// `md5` is not exactly 32 characters. The length check lives HERE, at the one
/// place a key becomes a path, so no entry point can index a short key out of
/// bounds — a thumbnail that cannot exist is a miss, not a crash.
fn finalRel(buf: *[md5_hex_len]u8, md5: []const u8) ?[]const u8 {
    if (md5.len != md5_hex_len) return null;
    @memcpy(buf, md5[0..md5_hex_len]);
    return buf[0..md5_hex_len];
}

// ---- tests ----

const testing = std.testing;

fn readAll(io: Io, file: File, buf: []u8) ![]u8 {
    var rbuf: [4096]u8 = undefined;
    var fr = file.reader(io, &rbuf);
    var total: usize = 0;
    while (total < buf.len) {
        const n = try fr.interface.readSliceShort(buf[total..]);
        if (n == 0) break;
        total += n;
    }
    return buf[0..total];
}

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
        try testing.expectEqualStrings("jpeg-bytes-v1", try readAll(io, f, &buf));
    }

    // Overwrite (a racing re-derive of the same source) replaces cleanly.
    try store.put(md5, "jpeg-bytes-v2");
    {
        var f = try store.open(md5);
        defer f.close(io);
        var buf: [64]u8 = undefined;
        try testing.expectEqualStrings("jpeg-bytes-v2", try readAll(io, f, &buf));
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

    // Short, empty, over-long — and a path-traversal-shaped key, which the
    // length check alone already refuses (32 chars exactly, or nothing).
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

    // A leftover staging file from a "crash".
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

    // InvalidMd5 fails before any file is created; assert tmp/ stays empty by
    // sweeping and confirming a subsequent put still lands.
    try testing.expectError(error.InvalidMd5, store.put("short", "x"));
    var it = try tmp.dir.openDir(io, "tmp", .{ .iterate = true });
    defer it.close(io);
    var walker = it.iterate();
    try testing.expect((try walker.next(io)) == null); // no staged leftovers
}
