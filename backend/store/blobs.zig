//! Content-addressed blob store: `.note` bytes live on the filesystem, keyed by
//! their md5. Everything here is built to **never expose a corrupt or partial
//! blob**:
//!
//!   1. Stream the input to a uniquely-named temp file while hashing incrementally
//!      (never hold a whole file in RAM — see [[resource-budget]]).
//!   2. `flush` + `fsync` the temp file so its bytes are durable on disk.
//!   3. If the caller gave an expected md5, verify the streamed content matches it
//!      — a mismatch means transit corruption or wrong data, and we refuse it.
//!   4. Publish with an **atomic rename** into `<ab>/<md5>`. A reader therefore
//!      only ever sees a file that is complete and correctly named; a crash
//!      mid-write leaves only a temp file (swept on startup), never a bad blob.
//!
//! Because the name *is* the content hash, an existing blob is known-good and is
//! never overwritten (we dedup instead). Single-threaded for now.

const std = @import("std");
const Md5 = std.crypto.hash.Md5;
const Io = std.Io;
const Dir = std.Io.Dir;
const File = std.Io.File;

pub const md5_hex_len = 32;

/// **The** blob I/O chunk size — the single number behind the memory claim:
///
/// > The server never holds a whole note or a whole page in memory; every blob
/// > read and write is bounded by a fixed 64 KB chunk.
///
/// Every path that moves blob bytes (ingest, `/oss` up/download, page serving,
/// content hashing) sizes its buffer from this constant, so the claim has one
/// number behind it rather than a handful of independently-written literals.
///
/// **Compile-time on purpose — do not make it a runtime knob.** Serve mode runs
/// one thread per connection with an explicit 1 MiB stack, and these buffers sit
/// on that stack (two of them on the streaming paths: one read, one write). A
/// configured megabyte-scale chunk would be an immediate stack overflow, which is
/// strictly worse than whatever tuning would buy. Making it configurable means
/// first moving the buffers to the heap and clamping the value; see
/// `docs/scratch/new-indexing.md` § "Chunk size".
pub const chunk_len = 64 * 1024;

/// The longest `uploadId` a multipart chunk may carry. It names a temp file, so
/// it is bounded here (and the handler rejects anything longer or containing a
/// character outside its allowlist before it ever reaches this store).
pub const max_upload_id = 64;

/// Upper bound on a chunk temp path: `"tmp/" + uploadId + "_" + u32` (a u32 is at
/// most 10 decimal digits). Sizes the on-stack buffers so a `bufPrint` can never
/// run out of room for a well-formed `uploadId`.
const chunk_name_max = "tmp/".len + max_upload_id + "_".len + 10;

/// Builds the `tmp/<uploadId>_<part>` path for a multipart chunk into `buf`. The
/// single place the chunk-name format lives, shared by begin/merge/cleanup so the
/// three can't drift.
fn chunkTmpName(buf: []u8, upload_id: []const u8, part: u32) ![]u8 {
    return std.fmt.bufPrint(buf, "tmp/{s}_{d}", .{ upload_id, part });
}

pub const PutResult = struct {
    md5: [md5_hex_len]u8,
    size: u64,
    /// True if identical content was already stored (the temp file was discarded).
    deduped: bool,
};

pub const BlobStore = struct {
    io: Io,
    /// The blob root directory (e.g. `<data_dir>/blobs`). Owned by the caller;
    /// must be on the same filesystem as its `tmp/` subdir for atomic renames.
    root: Dir,

    /// Ensures the `tmp/` staging subdir exists under `root`.
    pub fn init(io: Io, root: Dir) !BlobStore {
        try ensureDir(io, root, "tmp");
        return .{ .io = io, .root = root };
    }

    /// Streams every remaining byte of `reader` into the store and returns the
    /// content's md5 + size. If `expected_md5` is non-null and the streamed bytes
    /// don't hash to it, returns `error.HashMismatch` and stores nothing.
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
        ing.deinit(); // close the fd (the temp is already published or deduped away)
        return res;
    }

    /// Opens a fresh, uniquely-named temp file and returns an `Ingest` that
    /// accepts pushed bytes (hashing incrementally) before `finish` publishes them
    /// content-addressed. This is the push-oriented sibling of `put`: it lets a
    /// caller that produces bytes (e.g. a multipart part extractor) stream them in
    /// without first materializing them behind a `Reader`, while keeping every
    /// durability guarantee `put` has. `write_buf` is the userspace write buffer
    /// and must outlive the `Ingest` (the caller owns it, on the stack).
    pub fn beginIngest(self: BlobStore, write_buf: []u8) !Ingest {
        var tmp_buf: [20]u8 = undefined; // "tmp/" + 16 hex
        const tmp_rel = self.tempName(&tmp_buf);
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

    /// Opens the temp file for one part of a multipart upload. `upload_id` is a
    /// pre-validated path component (see `max_upload_id` and the handler's
    /// allowlist), so the only way `chunkTmpName` fails is a programming error.
    pub fn beginChunkIngest(self: BlobStore, upload_id: []const u8, part_number: u32, write_buf: []u8) !ChunkIngest {
        var tmp_buf: [chunk_name_max]u8 = undefined;
        const tmp_rel = try chunkTmpName(&tmp_buf, upload_id, part_number);
        const file = try self.root.createFile(self.io, tmp_rel, .{});
        return .{
            .store = self,
            .file = file,
            .fw = file.writerStreaming(self.io, write_buf),
        };
    }

    /// Merges the `total_chunks` parts written by `beginChunkIngest` into one
    /// content-addressed blob, deleting each part as it is consumed.
    ///
    /// ASSUMES it is called once, after the final part is stored. The device
    /// uploads parts sequentially, so "the last part arrived" means "every part
    /// is on disk"; a missing part (a drop, or out-of-order delivery) fails
    /// cleanly here rather than merging a hole — and the resulting md5 is checked
    /// again against the device's `content_hash` at the `upload/finish` commit. On
    /// ANY failure every remaining part of this upload is swept, so a broken
    /// transfer never leaks temp files until the next startup sweep.
    pub fn mergeChunks(self: BlobStore, upload_id: []const u8, total_chunks: u32, write_buf: []u8) !PutResult {
        // Runs last on failure (after `ing.abort`): removes whatever parts the
        // loop below hadn't yet consumed-and-deleted. Idempotent — a part already
        // gone is exactly the goal.
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

    /// Best-effort deletion of every temp part of a multipart upload. Used to
    /// clean up after an aborted merge; errors are ignored (a missing part is the
    /// intended end state).
    fn deleteChunks(self: BlobStore, upload_id: []const u8, total_chunks: u32) void {
        var part: u32 = 1;
        while (part <= total_chunks) : (part += 1) {
            var tmp_buf: [chunk_name_max]u8 = undefined;
            const tmp_rel = chunkTmpName(&tmp_buf, upload_id, part) catch continue;
            self.root.deleteFile(self.io, tmp_rel) catch {};
        }
    }

    /// True if a blob with this md5 is stored. A malformed md5 names no blob, so
    /// it is a miss rather than an error.
    pub fn has(self: BlobStore, md5: []const u8) bool {
        var buf: [35]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return false;
        return self.hasRel(rel);
    }

    /// Opens a blob for streaming reads (download). Caller closes.
    /// `error.InvalidMd5` if `md5` is not 32 hex characters.
    pub fn open(self: BlobStore, md5: []const u8) !File {
        var buf: [35]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return error.InvalidMd5;
        return self.root.openFile(self.io, rel, .{});
    }

    /// Reads exactly `len` bytes starting at `offset` from the blob `md5` into
    /// `buf`, returning the filled `buf[0..len]`. Positional (`pread`-style): no
    /// seek state, so it is safe to call concurrently on the same blob.
    ///
    /// DEFENSIVE BY CONTRACT. Callers pass offsets that came from a `.note`
    /// file's own metadata, i.e. from data an untrusted device wrote, so every
    /// one of them is treated as hostile:
    ///
    ///   - `offset + len` is computed with a checked add, so a near-`maxInt`
    ///     offset can never wrap into a valid-looking range;
    ///   - the range is validated against the blob's *actual* on-disk size, so a
    ///     read can never run past EOF;
    ///   - a short read (a blob truncated under us) is `error.BlobTruncated`,
    ///     never a silently-partial success — the returned slice is always
    ///     exactly `len` bytes of real file content;
    ///   - a malformed md5 is rejected before it can index out of bounds while
    ///     building the path.
    ///
    /// Errors: `error.InvalidMd5` (not 32 hex chars), `error.BufferTooSmall`
    /// (`len > buf.len`), `error.RangeOutOfBounds` (overflowing or past EOF),
    /// `error.BlobTruncated` (short read), plus `open`/`stat` errors — notably
    /// `error.FileNotFound` for a missing blob. Never panics, never short-reads.
    pub fn readRange(self: BlobStore, md5: []const u8, offset: u64, len: u64, buf: []u8) ![]const u8 {
        if (md5.len != md5_hex_len) return error.InvalidMd5; // guards finalRel's md5[0..32]
        if (len > buf.len) return error.BufferTooSmall;

        var file = try self.open(md5); // missing blob -> error.FileNotFound
        defer file.close(self.io);
        const size = (try file.stat(self.io)).size;

        // Checked add first: `offset + len` must not wrap before it is compared.
        const end = std.math.add(u64, offset, len) catch return error.RangeOutOfBounds;
        if (end > size) return error.RangeOutOfBounds;

        const out = buf[0..@intCast(len)]; // len <= buf.len, so the cast cannot truncate
        if (out.len == 0) return out; // a validated empty range: no syscall needed
        const n = try file.readPositionalAll(self.io, out, offset);
        if (n != out.len) return error.BlobTruncated; // never report a partial read as success
        return out;
    }

    /// The authoritative on-disk byte size of a stored blob. Because a blob's
    /// name *is* its content hash, this is the true ingested size — the value the
    /// device-upload commit path trusts instead of the device's declared size.
    pub fn sizeOf(self: BlobStore, md5: []const u8) !u64 {
        var file = try self.open(md5);
        defer file.close(self.io);
        const st = try file.stat(self.io);
        return st.size;
    }

    /// Deletes a blob (GC when its refcount hits 0). Missing is not an error,
    /// and neither is a malformed md5 — it names nothing to delete.
    pub fn remove(self: BlobStore, md5: []const u8) void {
        var buf: [35]u8 = undefined;
        const rel = finalRel(&buf, md5) orelse return;
        self.root.deleteFile(self.io, rel) catch {};
    }

    /// Removes leftover temp files from a prior crash. Safe: temp files are never
    /// referenced until renamed, so any that remain are abandoned writes.
    pub fn sweepTmp(self: BlobStore) void {
        self.root.deleteTree(self.io, "tmp") catch {};
        ensureDir(self.io, self.root, "tmp") catch {};
    }

    fn hasRel(self: BlobStore, rel: []const u8) bool {
        self.root.access(self.io, rel, .{}) catch return false;
        return true;
    }

    fn tempName(self: BlobStore, buf: *[20]u8) []const u8 {
        var raw: [8]u8 = undefined;
        self.io.random(&raw);
        @memcpy(buf[0..4], "tmp/");
        buf[4..20].* = std.fmt.bytesToHex(raw, .lower);
        return buf[0..20];
    }
};

/// A single in-flight blob write, streaming pushed bytes into a temp file while
/// hashing incrementally (see `BlobStore.beginIngest`). The lifecycle is
/// exactly `put`'s, split so the caller drives the byte source:
///   - `write` any number of times (each chunk is hashed + written, never buffered whole);
///   - `finish` to fsync, verify an optional expected md5, and atomically publish
///     (or dedup) the blob, returning its `PutResult`;
///   - `deinit` to close the fd after a successful `finish`;
///   - `abort` (close + drop the temp) on any failure before publish.
/// The struct must not be moved after `beginIngest` returns — take `*Ingest`.
pub const Ingest = struct {
    store: BlobStore,
    file: File,
    fw: File.Writer,
    hasher: Md5,
    size: u64,
    tmp_name: [20]u8, // "tmp/" + 16 hex, the temp file's path relative to the store root

    /// Feeds one chunk of blob bytes: hashed and written through to the temp file.
    pub fn write(self: *Ingest, bytes: []const u8) !void {
        self.hasher.update(bytes);
        try self.fw.interface.writeAll(bytes);
        self.size += bytes.len;
    }

    /// Flushes + fsyncs the temp file, then publishes it content-addressed. If
    /// `expected_md5` is non-null and the streamed bytes don't hash to it, returns
    /// `error.HashMismatch` and publishes nothing (the caller's `abort` drops the
    /// temp). Does not close the fd — call `deinit` after a successful finish.
    pub fn finish(self: *Ingest, expected_md5: ?[]const u8) !PutResult {
        try self.fw.interface.flush(); // userspace buffer -> fd
        try self.file.sync(self.store.io); // fd -> disk, before we publish it

        var digest: [Md5.digest_length]u8 = undefined;
        self.hasher.final(&digest);
        const md5 = std.fmt.bytesToHex(digest, .lower);

        // Integrity gate: reject content that isn't what the caller promised.
        if (expected_md5) |exp| {
            if (!std.ascii.eqlIgnoreCase(exp, &md5)) return error.HashMismatch;
        }

        const tmp_rel = self.tmp_name[0..];
        var final_buf: [35]u8 = undefined; // "<ab>/<md5>"
        const final_rel = finalRel(&final_buf, &md5).?; // bytesToHex always yields 32

        // Already have this exact content — it's known-good, keep it, drop the temp.
        if (self.store.hasRel(final_rel)) {
            self.store.root.deleteFile(self.store.io, tmp_rel) catch {};
            return .{ .md5 = md5, .size = self.size, .deduped = true };
        }

        // Publish atomically: a reader sees the blob only once it is complete.
        try ensureDir(self.store.io, self.store.root, md5[0..2]);
        try Dir.rename(self.store.root, tmp_rel, self.store.root, final_rel, self.store.io);
        return .{ .md5 = md5, .size = self.size, .deduped = false };
    }

    /// Closes the temp file's fd (after a successful `finish`).
    pub fn deinit(self: *Ingest) void {
        self.file.close(self.store.io);
    }

    /// Closes the fd and drops the temp file — for any failure before publish.
    pub fn abort(self: *Ingest) void {
        self.file.close(self.store.io);
        self.store.root.deleteFile(self.store.io, self.tmp_name[0..]) catch {};
    }
};

/// A single in-flight chunk write, streaming pushed bytes into a named temp file.
pub const ChunkIngest = struct {
    store: BlobStore,
    file: File,
    fw: File.Writer,

    pub fn write(self: *ChunkIngest, bytes: []const u8) !void {
        try self.fw.interface.writeAll(bytes);
    }

    pub fn finish(self: *ChunkIngest) !void {
        try self.fw.interface.flush(); // userspace buffer -> fd
        try self.file.sync(self.store.io); // fd -> disk
    }

    pub fn deinit(self: *ChunkIngest) void {
        self.file.close(self.store.io);
    }

    pub fn abort(self: *ChunkIngest) void {
        self.file.close(self.store.io);
        // Abandoned temp file is swept at startup by sweepTmp
    }
};

fn ensureDir(io: Io, root: Dir, sub: []const u8) !void {
    var d = root.createDirPathOpen(io, sub, .{}) catch |err| switch (err) {
        error.PathAlreadyExists => return,
        else => return err,
    };
    d.close(io);
}

/// Builds the "<ab>/<md5>" relative path for a blob into `buf`; null if `md5` is
/// not exactly 32 characters.
///
/// The length check lives HERE, at the single place that indexes into an md5,
/// rather than at each caller. The md5s that reach this function come from
/// `files.md5` — a NULLABLE text column that is empty for folder rows and can be
/// short in any database SQLite will happily hand back (a hand-edited row, a
/// restore from an older schema). `md5[0..32]` on such a value is a server
/// panic; a blob that cannot exist should be a miss, not a crash.
fn finalRel(buf: *[35]u8, md5: []const u8) ?[]const u8 {
    if (md5.len != md5_hex_len) return null;
    buf[0] = md5[0];
    buf[1] = md5[1];
    buf[2] = '/';
    @memcpy(buf[3..35], md5[0..32]);
    return buf[0..35];
}

/// The lowercase md5 hex of a whole slice (for callers that already hold the
/// bytes; `put` hashes streamed content instead).
pub fn md5HexOf(data: []const u8) [md5_hex_len]u8 {
    var digest: [Md5.digest_length]u8 = undefined;
    Md5.hash(data, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

// ---- tests ----

const md5Hex = md5HexOf;

fn readAll(io: Io, file: File, buf: []u8) ![]u8 {
    var rbuf: [chunk_len]u8 = undefined;
    var fr = file.reader(io, &rbuf);
    var total: usize = 0;
    while (total < buf.len) {
        const n = try fr.interface.readSliceShort(buf[total..]);
        if (n == 0) break;
        total += n;
    }
    return buf[0..total];
}

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

    // Read the blob back and confirm it is byte-identical.
    var f = try store.open(&res.md5);
    defer f.close(io);
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings(data, try readAll(io, f, &buf));

    // Storing the same content again dedups (same md5, no second copy).
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

    // Nothing was published — no partial/corrupt blob is left behind.
    try std.testing.expect(!store.has(&md5Hex(data)));

    // The correct expected md5 succeeds.
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
    // A window in the middle, the whole blob, and the last byte.
    try std.testing.expectEqualStrings("456789", try store.readRange(&res.md5, 4, 6, &buf));
    try std.testing.expectEqualStrings(data, try store.readRange(&res.md5, 0, data.len, &buf));
    try std.testing.expectEqualStrings("f", try store.readRange(&res.md5, 15, 1, &buf));
    // An oversized buffer is fine — the result is sliced to `len`, not to buf.len.
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

    // Zero length: a validated empty read at any in-range offset, INCLUDING the
    // EOF boundary (offset == size), succeeds and yields an empty slice.
    try std.testing.expectEqual(@as(usize, 0), (try store.readRange(&md5, 0, 0, &buf)).len);
    try std.testing.expectEqual(@as(usize, 0), (try store.readRange(&md5, 16, 0, &buf)).len);
    // ...but a zero-length read PAST EOF is still rejected — it is a bad offset.
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 17, 0, &buf));

    // Offset past EOF, with and without length.
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 16, 1, &buf));
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 99, 1, &buf));

    // In-range offset, but offset + len runs past EOF (the classic bad-metadata
    // case: a plausible offset with a length that walks off the end).
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 10, 7, &buf));
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, 0, 17, &buf));

    // Integer-overflow-adjacent: offset + len wraps in u64. Without the checked
    // add these would compute a small `end` and be accepted as in-range.
    try std.testing.expectError(error.BufferTooSmall, store.readRange(&md5, max, max, &buf));
    try std.testing.expectError(error.BufferTooSmall, store.readRange(&md5, 1, max, &buf));
    // Same wrap, but with a length small enough that the buffer check passes, so
    // the overflow check itself is what has to reject it.
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, max - 4, 8, &buf));
    try std.testing.expectError(error.RangeOutOfBounds, store.readRange(&md5, max, 1, &buf));

    // Buffer too small for the requested length: refused, not silently clamped.
    var small: [4]u8 = undefined;
    try std.testing.expectError(error.BufferTooSmall, store.readRange(&md5, 0, 8, &small));

    // Missing blob, and a malformed md5 (which must not index out of bounds).
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

    // Truncate the blob behind the store's back (disk corruption / a bad restore).
    // The range was valid for the original size; it must now fail cleanly rather
    // than hand back fewer bytes than asked for. `error.BlobTruncated` covers the
    // narrower case where the file shrinks between the stat and the read.
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

    // "" is what `files.md5` reads back as for a folder row (NULL -> ""), and a
    // short value is what a hand-edited or half-migrated row can hold. Every
    // entry point that builds a blob path from one used to slice `md5[0..32]`
    // unchecked, so any of these was a server panic reachable from a purge or a
    // download of such a row.
    for ([_][]const u8{ "", "a", "abc", "0123456789abcdef", "0123456789abcdef0123456789abcde" }) |bad| {
        try std.testing.expect(!store.has(bad));
        try std.testing.expectError(error.InvalidMd5, store.open(bad));
        try std.testing.expectError(error.InvalidMd5, store.sizeOf(bad));
        var buf: [8]u8 = undefined;
        try std.testing.expectError(error.InvalidMd5, store.readRange(bad, 0, 4, &buf));
        store.remove(bad); // best-effort: names nothing, deletes nothing
    }

    // Over-long is rejected too — 33 chars would otherwise silently truncate to a
    // path that could collide with a real blob.
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
