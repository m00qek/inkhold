//! Content-addressed blob store, keyed by md5. Never exposes a partial blob:
//! stream to a temp file while hashing, fsync, verify the expected md5, then
//! atomically rename into `<ab>/<md5>`. Existing blobs are never overwritten.

const std = @import("std");
const atomic = @import("atomic.zig");
const Md5 = std.crypto.hash.Md5;
const Io = std.Io;
const Dir = std.Io.Dir;
const File = std.Io.File;

pub const md5_hex_len = 32;

/// The blob I/O chunk size; every path moving blob bytes sizes its buffer from
/// it. Compile-time on purpose: the buffers live on 1 MiB connection stacks.
pub const chunk_len = 64 * 1024;

/// Longest `uploadId` a multipart chunk may carry; it names a temp file.
pub const max_upload_id = 64;

/// `"tmp/" + uploadId + "_" + u32` (≤ 10 digits).
const chunk_name_max = "tmp/".len + max_upload_id + "_".len + 10;

/// `tmp/<uploadId>_<part>`, shared by begin/merge/cleanup.
fn chunkTmpName(buf: []u8, upload_id: []const u8, part: u32) ![]u8 {
    return std.fmt.bufPrint(buf, "tmp/{s}_{d}", .{ upload_id, part });
}

pub const PutResult = struct {
    md5: [md5_hex_len]u8,
    size: u64,
    deduped: bool,
};

pub const BlobStore = struct {
    io: Io,
    /// Owned by the caller; must share a filesystem with its `tmp/` for the rename.
    root: Dir,

    /// Opens the store at `root`, creating its `tmp/` staging directory.
    pub fn init(io: Io, root: Dir) !BlobStore {
        try atomic.ensureDir(io, root, "tmp");
        return .{ .io = io, .root = root };
    }

    /// Streams `reader` into the store. A mismatch with `expected_md5` is
    /// `error.HashMismatch` and stores nothing.
    pub fn put(self: BlobStore, reader: *Io.Reader, expected_md5: ?[]const u8) !PutResult {
        var wbuf: [chunk_len]u8 = undefined;
        var ing = try self.beginIngest(&wbuf);
        errdefer ing.abort(); // drop the temp on any streaming/verify failure

        var chunk: [chunk_len]u8 = undefined;
        while (true) {
            const n = try reader.readSliceShort(&chunk);
            if (n == 0) break;
            try ing.write(chunk[0..n]);
        }
        const res = try ing.finish(expected_md5);
        ing.deinit(); // the temp is already published or deduped away
        return res;
    }

    /// Push-oriented sibling of `put`. `write_buf` must outlive the `Ingest`.
    pub fn beginIngest(self: BlobStore, write_buf: []u8) !Ingest {
        var tmp_buf: [20]u8 = undefined; // "tmp/" + 16 hex
        const tmp_rel = atomic.tempName(self.io, &tmp_buf);
        const file = try self.root.createFile(self.io, tmp_rel, .{});
        return .{
            .store = self,
            .file = file,
            .fw = file.writerStreaming(self.io, write_buf),
            .hasher = Md5.init(.{}),
            .size = 0,
            .tmp_name = tmp_buf,
        };
    }

    /// Opens the temp file for one multipart part. `upload_id` is pre-validated.
    pub fn beginChunkIngest(self: BlobStore, upload_id: []const u8, part_number: u32, write_buf: []u8) !ChunkIngest {
        var tmp_buf: [chunk_name_max]u8 = undefined;
        const tmp_rel = try chunkTmpName(&tmp_buf, upload_id, part_number);
        const file = try self.root.createFile(self.io, tmp_rel, .{});
        var kept: [chunk_name_max]u8 = undefined;
        @memcpy(kept[0..tmp_rel.len], tmp_rel);
        return .{
            .store = self,
            .file = file,
            .fw = file.writerStreaming(self.io, write_buf),
            .tmp_name = kept,
            .tmp_len = tmp_rel.len,
        };
    }

    /// Merges the parts into one blob, deleting each as consumed. Call once, after
    /// the last part (the device uploads sequentially); a missing part fails here,
    /// and any failure sweeps the remaining parts.
    pub fn mergeChunks(self: BlobStore, upload_id: []const u8, total_chunks: u32, write_buf: []u8) !PutResult {
        // Runs after `ing.abort` on failure; idempotent.
        errdefer self.deleteChunks(upload_id, total_chunks);

        var ing = try self.beginIngest(write_buf);
        errdefer ing.abort();

        var read_buf: [chunk_len]u8 = undefined;
        var part: u32 = 1;
        while (part <= total_chunks) : (part += 1) {
            var tmp_buf: [chunk_name_max]u8 = undefined;
            const tmp_rel = try chunkTmpName(&tmp_buf, upload_id, part);
            var file = try self.root.openFile(self.io, tmp_rel, .{}); // missing part -> fail
            defer {
                file.close(self.io);
                self.root.deleteFile(self.io, tmp_rel) catch {};
            }

            var fr = file.reader(self.io, &read_buf);
            var chunk_buf: [chunk_len]u8 = undefined;
            while (true) {
                const n = try fr.interface.readSliceShort(&chunk_buf);
                if (n == 0) break;
                try ing.write(chunk_buf[0..n]);
            }
        }
        const res = try ing.finish(null);
        ing.deinit();
        return res;
    }

    /// Bytes staged for one part, or 0. A re-POSTed part replaces its temp file, so
    /// the session's received total subtracts this before adding the new size.
    pub fn stagedPartSize(self: BlobStore, upload_id: []const u8, part_number: u32) u64 {
        var tmp_buf: [chunk_name_max]u8 = undefined;
        const tmp_rel = chunkTmpName(&tmp_buf, upload_id, part_number) catch return 0;
        var file = self.root.openFile(self.io, tmp_rel, .{}) catch return 0;
        defer file.close(self.io);
        const st = file.stat(self.io) catch return 0;
        return st.size;
    }

    fn deleteChunks(self: BlobStore, upload_id: []const u8, total_chunks: u32) void {
        var part: u32 = 1;
        while (part <= total_chunks) : (part += 1) {
            var tmp_buf: [chunk_name_max]u8 = undefined;
            const tmp_rel = chunkTmpName(&tmp_buf, upload_id, part) catch continue;
            self.root.deleteFile(self.io, tmp_rel) catch {};
        }
    }

    /// A malformed md5 is a miss, not an error.
    pub fn has(self: BlobStore, md5: []const u8) bool {
        var buf: [35]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return false;
        return self.hasRel(rel);
    }

    /// Opens a blob for streaming reads. Caller closes.
    pub fn open(self: BlobStore, md5: []const u8) !File {
        var buf: [35]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return error.InvalidMd5;
        return self.root.openFile(self.io, rel, .{});
    }

    /// Reads exactly `len` bytes at `offset` into `buf`; positional, so safe
    /// concurrently. Offsets come from untrusted `.note` metadata: checked add,
    /// bounds against the real file size, a short read is `error.BlobTruncated`.
    pub fn readRange(self: BlobStore, md5: []const u8, offset: u64, len: u64, buf: []u8) ![]const u8 {
        if (md5.len != md5_hex_len) return error.InvalidMd5; // guards finalRel's md5[0..32]
        if (len > buf.len) return error.BufferTooSmall;

        var file = try self.open(md5); // missing blob -> error.FileNotFound
        defer file.close(self.io);
        const size = (try file.stat(self.io)).size;

        const end = std.math.add(u64, offset, len) catch return error.RangeOutOfBounds;
        if (end > size) return error.RangeOutOfBounds;

        const out = buf[0..@intCast(len)]; // len <= buf.len, so the cast cannot truncate
        if (out.len == 0) return out; // a validated empty range: no syscall needed
        const n = try file.readPositionalAll(self.io, out, offset);
        if (n != out.len) return error.BlobTruncated; // never report a partial read as success
        return out;
    }

    /// The true on-disk size; trusted over the device's declared size.
    pub fn sizeOf(self: BlobStore, md5: []const u8) !u64 {
        var file = try self.open(md5);
        defer file.close(self.io);
        const st = try file.stat(self.io);
        return st.size;
    }

    /// GC'd when refcount hits 0. Missing or malformed is not an error.
    pub fn remove(self: BlobStore, md5: []const u8) void {
        var buf: [35]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return;
        self.root.deleteFile(self.io, rel) catch {};
    }

    /// Removes temp files abandoned by a crash.
    pub fn sweepTmp(self: BlobStore) void {
        atomic.sweepTmp(self.io, self.root);
    }

    fn hasRel(self: BlobStore, rel: []const u8) bool {
        self.root.access(self.io, rel, .{}) catch return false;
        return true;
    }
};

/// One in-flight blob write: `write`*, then `finish` + `deinit`, or `abort`
/// before publish. Must not move after `beginIngest`.
pub const Ingest = struct {
    store: BlobStore,
    file: File,
    fw: File.Writer,
    hasher: Md5,
    size: u64,
    tmp_name: [20]u8, // "tmp/" + 16 hex

    /// Appends to the temp file and the running md5.
    pub fn write(self: *Ingest, bytes: []const u8) !void {
        self.hasher.update(bytes);
        try self.fw.interface.writeAll(bytes);
        self.size += bytes.len;
    }

    /// Fsyncs and publishes (or dedups). Does not close the fd: call `deinit`.
    pub fn finish(self: *Ingest, expected_md5: ?[]const u8) !PutResult {
        try self.fw.interface.flush(); // userspace buffer -> fd
        try self.file.sync(self.store.io); // fd -> disk, before we publish it

        var digest: [Md5.digest_length]u8 = undefined;
        self.hasher.final(&digest);
        const md5 = std.fmt.bytesToHex(digest, .lower);

        if (expected_md5) |exp| {
            if (!std.ascii.eqlIgnoreCase(exp, &md5)) return error.HashMismatch;
        }

        const tmp_rel = self.tmp_name[0..];
        var final_buf: [35]u8 = undefined; // "<ab>/<md5>"
        const final_rel = finalRel(&final_buf, &md5).?; // bytesToHex always yields 32

        if (self.store.hasRel(final_rel)) {
            self.store.root.deleteFile(self.store.io, tmp_rel) catch {};
            return .{ .md5 = md5, .size = self.size, .deduped = true };
        }

        try atomic.ensureDir(self.store.io, self.store.root, md5[0..2]);
        try Dir.rename(self.store.root, tmp_rel, self.store.root, final_rel, self.store.io);
        return .{ .md5 = md5, .size = self.size, .deduped = false };
    }

    /// Closes the fd after `finish`; the published blob stays.
    pub fn deinit(self: *Ingest) void {
        self.file.close(self.store.io);
    }

    /// Closes the fd and drops the temp file.
    pub fn abort(self: *Ingest) void {
        self.file.close(self.store.io);
        self.store.root.deleteFile(self.store.io, self.tmp_name[0..]) catch {};
    }
};

/// One part of a multipart device upload, staged under `tmp/` by upload id and
/// part number until `mergeChunks` hashes them into a blob. `write`*, `finish`,
/// `deinit`; or `abort`.
pub const ChunkIngest = struct {
    store: BlobStore,
    file: File,
    fw: File.Writer,
    tmp_name: [chunk_name_max]u8,
    tmp_len: usize,

    /// Appends to the part.
    pub fn write(self: *ChunkIngest, bytes: []const u8) !void {
        try self.fw.interface.writeAll(bytes);
    }

    /// Flushes and fsyncs the part; `deinit` still closes it.
    pub fn finish(self: *ChunkIngest) !void {
        try self.fw.interface.flush(); // userspace buffer -> fd
        try self.file.sync(self.store.io); // fd -> disk
    }

    /// Closes the fd; the part stays on disk for the merge.
    pub fn deinit(self: *ChunkIngest) void {
        self.file.close(self.store.io);
    }

    /// Closes the fd and drops the part; the ingest cap aborts parts routinely.
    pub fn abort(self: *ChunkIngest) void {
        self.file.close(self.store.io);
        self.store.root.deleteFile(self.store.io, self.tmp_name[0..self.tmp_len]) catch {};
    }
};

test "ChunkIngest.abort drops its part rather than leaving it for the sweep" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try BlobStore.init(std.testing.io, tmp.dir);

    var buf: [64]u8 = undefined;
    var ing = try store.beginChunkIngest("abcdef0123456789", 1, &buf);
    try ing.write("some partial bytes");

    // The path the ingest actually used, not a recomputed one.
    const path = try std.testing.allocator.dupe(u8, ing.tmp_name[0..ing.tmp_len]);
    defer std.testing.allocator.free(path);
    try std.testing.expect(store.hasRel(path)); // it is really there first

    ing.abort();
    try std.testing.expect(!store.hasRel(path));
}

test "stagedPartSize reports what a part holds, and 0 for one that is not there" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try BlobStore.init(std.testing.io, tmp.dir);

    try std.testing.expectEqual(@as(u64, 0), store.stagedPartSize("abcdef0123456789", 1));

    var buf: [64]u8 = undefined;
    {
        var ing = try store.beginChunkIngest("abcdef0123456789", 1, &buf);
        try ing.write("0123456789"); // 10 bytes
        try ing.finish();
        ing.deinit();
    }
    try std.testing.expectEqual(@as(u64, 10), store.stagedPartSize("abcdef0123456789", 1));
    try std.testing.expectEqual(@as(u64, 0), store.stagedPartSize("abcdef0123456789", 2));

    {
        var ing = try store.beginChunkIngest("abcdef0123456789", 1, &buf);
        try ing.write("abc"); // 3 bytes
        try ing.finish();
        ing.deinit();
    }
    try std.testing.expectEqual(@as(u64, 3), store.stagedPartSize("abcdef0123456789", 1));
}

/// "<ab>/<md5>", or null unless `md5` is 32 chars. `files.md5` is nullable and
/// may be short ("" for folders); a missing blob must be a miss, not a panic.
fn finalRel(buf: *[35]u8, md5: []const u8) ?[]const u8 {
    if (md5.len != md5_hex_len) return null;
    buf[0] = md5[0];
    buf[1] = md5[1];
    buf[2] = '/';
    @memcpy(buf[3..35], md5[0..32]);
    return buf[0..35];
}

/// The blob key of `data`: its md5 as lowercase hex.
pub fn md5HexOf(data: []const u8) [md5_hex_len]u8 {
    var digest: [Md5.digest_length]u8 = undefined;
    Md5.hash(data, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

// ---- tests ----

const md5Hex = md5HexOf;

test "put stores content-addressed bytes, dedups, and reads back exactly" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try BlobStore.init(io, tmp.dir);

    const data = "hello supernote, this is a .note blob";
    var r = Io.Reader.fixed(data);
    const res = try store.put(&r, null);

    try std.testing.expectEqual(@as(u64, data.len), res.size);
    try std.testing.expect(!res.deduped);
    try std.testing.expectEqualStrings(&md5Hex(data), &res.md5); // md5 computed correctly
    try std.testing.expect(store.has(&res.md5));

    var f = try store.open(&res.md5);
    defer f.close(io);
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings(data, try atomic.readAll(io, f, &buf));

    var r2 = Io.Reader.fixed(data);
    const res2 = try store.put(&r2, null);
    try std.testing.expect(res2.deduped);
    try std.testing.expectEqualStrings(&res.md5, &res2.md5);
}

test "put rejects content that doesn't match the expected md5 (integrity gate)" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try BlobStore.init(io, tmp.dir);

    const data = "some bytes";
    const wrong = "ffffffffffffffffffffffffffffffff"; // not md5(data)
    var r = Io.Reader.fixed(data);
    try std.testing.expectError(error.HashMismatch, store.put(&r, wrong));

    try std.testing.expect(!store.has(&md5Hex(data)));

    var r2 = Io.Reader.fixed(data);
    const res = try store.put(&r2, &md5Hex(data));
    try std.testing.expect(store.has(&res.md5));
}

test "readRange returns exactly the requested window" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try BlobStore.init(io, tmp.dir);

    const data = "0123456789abcdef"; // 16 bytes
    var r = Io.Reader.fixed(data);
    const res = try store.put(&r, null);

    var buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("456789", try store.readRange(&res.md5, 4, 6, &buf));
    try std.testing.expectEqualStrings(data, try store.readRange(&res.md5, 0, data.len, &buf));
    try std.testing.expectEqualStrings("f", try store.readRange(&res.md5, 15, 1, &buf));
    try std.testing.expectEqual(@as(usize, 6), (try store.readRange(&res.md5, 4, 6, &buf)).len);
}

test "readRange refuses every out-of-range, overflowing, or missing case" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try BlobStore.init(io, tmp.dir);

    const data = "0123456789abcdef"; // 16 bytes
    var r = Io.Reader.fixed(data);
    const res = try store.put(&r, null);
    const md5 = res.md5;

    var buf: [32]u8 = undefined;
    const max = std.math.maxInt(u64);

    try std.testing.expectEqual(@as(usize, 0), (try store.readRange(&md5, 0, 0, &buf)).len);
    try std.testing.expectEqual(@as(usize, 0), (try store.readRange(&md5, 16, 0, &buf)).len);
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 17, 0, &buf));

    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 16, 1, &buf));
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 99, 1, &buf));

    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 10, 7, &buf));
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 0, 17, &buf));

    // offset + len wraps in u64.
    try std.testing.expectError(error.BufferTooSmall, store.readRange(&md5, max, max, &buf));
    try std.testing.expectError(error.BufferTooSmall, store.readRange(&md5, 1, max, &buf));
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, max - 4, 8, &buf));
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, max, 1, &buf));

    var small: [4]u8 = undefined;
    try std.testing.expectError(error.BufferTooSmall, store.readRange(&md5, 0, 8, &small));

    const absent = "ffffffffffffffffffffffffffffffff";
    try std.testing.expectError(error.FileNotFound, store.readRange(absent, 0, 1, &buf));
    try std.testing.expectError(error.FileNotFound, store.readRange(absent, 0, 0, &buf));
    try std.testing.expectError(error.InvalidMd5, store.readRange("abc", 0, 1, &buf));
    try std.testing.expectError(error.InvalidMd5, store.readRange("", 0, 0, &buf));
}

test "readRange validates against the blob's real size, so a truncated blob is refused" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try BlobStore.init(io, tmp.dir);

    const data = "0123456789abcdef";
    var r = Io.Reader.fixed(data);
    const res = try store.put(&r, null);

    // Truncate the blob behind the store's back.
    var rel: [35]u8 = undefined;
    const f = try tmp.dir.openFile(io, finalRel(&rel, &res.md5).?, .{ .mode = .read_write });
    try f.setLength(io, 8);
    f.close(io);

    var buf: [32]u8 = undefined;
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&res.md5, 0, 16, &buf));
    try std.testing.expectEqualStrings("01234567", try store.readRange(&res.md5, 0, 8, &buf));
}

test "a short or empty md5 is a miss on every path, never a panic" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try BlobStore.init(io, tmp.dir);

    // "" is a folder row's md5; short values come from hand-edited rows.
    for ([_][]const u8{ "", "a", "abc", "0123456789abcdef", "0123456789abcdef0123456789abcde" }) |bad| {
        try std.testing.expect(!store.has(bad));
        try std.testing.expectError(error.InvalidMd5, store.open(bad));
        try std.testing.expectError(error.InvalidMd5, store.sizeOf(bad));
        var buf: [8]u8 = undefined;
        try std.testing.expectError(error.InvalidMd5, store.readRange(bad, 0, 4, &buf));
        store.remove(bad); // best-effort: names nothing, deletes nothing
    }

    // 33 chars would otherwise truncate to a path that could collide.
    const too_long = "0123456789abcdef0123456789abcdef0";
    try std.testing.expect(!store.has(too_long));
    try std.testing.expectError(error.InvalidMd5, store.open(too_long));
}

test "remove deletes a blob; sweepTmp is safe to call" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try BlobStore.init(io, tmp.dir);

    const data = "delete me";
    var r = Io.Reader.fixed(data);
    const res = try store.put(&r, null);
    try std.testing.expect(store.has(&res.md5));

    store.remove(&res.md5);
    try std.testing.expect(!store.has(&res.md5));
    store.remove(&res.md5); // removing a missing blob is a no-op

    store.sweepTmp(); // no crash, tmp dir still usable
    var r2 = Io.Reader.fixed(data);
    _ = try store.put(&r2, null);
}
