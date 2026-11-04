//! Moving one blob between the live store and a backup, in either direction.
//! Into a backup, a blob is gzipped (level 1: on notebooks and PDFs a higher
//! level buys nothing) unless that saves under 10%, in which case it is kept
//! as it came. Either way it is checked against its md5 on the way, written
//! to a temp name, fsynced and renamed, so a backup never holds a partial or a
//! wrong blob under a real name. Every buffer lives in one `Scratch`, sized
//! once: memory does not depend on the size of a blob or of the library.

const std = @import("std");
const layout = @import("layout.zig");
const pace_mod = @import("pace.zig");
const blobstore = @import("../../store/blobs.zig");
const atomic = @import("../../store/atomic.zig");
const flate = std.compress.flate;
const Md5 = std.crypto.hash.Md5;
const Io = std.Io;
const Dir = Io.Dir;
const File = Io.File;

const chunk_len = blobstore.chunk_len;

/// Compressed must be at most 90% of raw to be kept compressed.
const keep_ratio_num = 9;
const keep_ratio_den = 10;

/// Every buffer one copy needs (~420 KB). Heap-allocate it once per run.
pub const Scratch = struct {
    read_buf: [chunk_len]u8,
    write_buf: [chunk_len]u8,
    chunk: [chunk_len]u8,
    window: [flate.max_window_len]u8,
    compress: flate.Compress,
};

pub const Outcome = enum {
    /// Already in the backup under either name; nothing was read.
    present,
    compressed,
    raw,
};

pub const CopyError = error{
    /// The live store has no file for this md5.
    SourceMissing,
    /// The live file does not hash to its name.
    SourceCorrupt,
};

/// Whether the backup holds `md5`, compressed or not.
pub fn has(io: Io, dst: Dir, md5: []const u8) bool {
    var buf: [layout.blob_path_max]u8 = undefined;
    if (dst.access(io, layout.blobPath(&buf, md5, true), .{})) |_| return true else |_| {}
    if (dst.access(io, layout.blobPath(&buf, md5, false), .{})) |_| return true else |_| {}
    return false;
}

/// Copies `md5` from the live store into the backup rooted at `dst`, unless
/// it is already there. Reads are paced by `pace`.
pub fn put(io: Io, live: blobstore.BlobStore, dst: Dir, md5: []const u8, compress: bool, pace: *pace_mod.Pace, s: *Scratch) !Outcome {
    std.debug.assert(layout.isMd5(md5));
    if (has(io, dst, md5)) return .present;

    var fan: [layout.blobs_dir.len + 3]u8 = undefined;
    try atomic.ensureDir(io, dst, layout.blobFanout(&fan, md5));

    var tmp_buf: [layout.blob_path_max + 4]u8 = undefined;
    var name_buf: [layout.blob_path_max]u8 = undefined;
    const tmp = tempPath(&tmp_buf, md5);
    errdefer dst.deleteFile(io, tmp) catch {};

    if (compress) {
        const sizes = try writeFromLive(io, live, dst, tmp, md5, true, pace, s);
        if (sizes.out * keep_ratio_den <= sizes.raw * keep_ratio_num) {
            try Dir.rename(dst, tmp, dst, layout.blobPath(&name_buf, md5, true), io);
            return .compressed;
        }
        // Not worth it: keep the blob as it came.
        try dst.deleteFile(io, tmp);
    }
    _ = try writeFromLive(io, live, dst, tmp, md5, false, pace, s);
    try Dir.rename(dst, tmp, dst, layout.blobPath(&name_buf, md5, false), io);
    return .raw;
}

/// `blobs/ab/<md5>.tmp`: beside its final name, so the rename stays within
/// one directory. A crash leaves it for `prune`.
pub fn tempPath(buf: *[layout.blob_path_max + 4]u8, md5: []const u8) []const u8 {
    var name_buf: [layout.blob_path_max]u8 = undefined;
    const name = layout.blobPath(&name_buf, md5, false);
    return std.fmt.bufPrint(buf, "{s}.tmp", .{name}) catch unreachable;
}

const Sizes = struct { raw: u64, out: u64 };

/// Streams the live blob into `dst/tmp`, gzipped or not, hashing what it reads.
fn writeFromLive(io: Io, live: blobstore.BlobStore, dst: Dir, tmp: []const u8, md5: []const u8, gzip: bool, pace: *pace_mod.Pace, s: *Scratch) !Sizes {
    const src = live.open(md5) catch |e| switch (e) {
        error.FileNotFound => return error.SourceMissing,
        else => return e,
    };
    defer src.close(io);
    var fr = src.reader(io, &s.read_buf);

    const out = try dst.createFile(io, tmp, .{});
    defer out.close(io);
    var fw = out.writerStreaming(io, &s.write_buf);

    var sink: *Io.Writer = &fw.interface;
    if (gzip) {
        s.compress = try flate.Compress.init(&fw.interface, &s.window, .gzip, .level_1);
        sink = &s.compress.writer;
    }

    var hasher = Md5.init(.{});
    var raw: u64 = 0;
    while (true) {
        const n = try fr.interface.readSliceShort(&s.chunk);
        if (n == 0) break;
        hasher.update(s.chunk[0..n]);
        try sink.writeAll(s.chunk[0..n]);
        raw += n;
        pace.take(io, n);
    }
    if (gzip) try s.compress.finish();
    try fw.interface.flush();
    try out.sync(io);

    var digest: [Md5.digest_length]u8 = undefined;
    hasher.final(&digest);
    const hex = std.fmt.bytesToHex(digest, .lower);
    if (!std.mem.eql(u8, &hex, md5)) return error.SourceCorrupt;
    return .{ .raw = raw, .out = try out.length(io) };
}

/// A blob in a backup, read back as its original bytes. Built in place by
/// `open` (the decompressor points at the file reader beside it): never copy.
pub const Source = struct {
    file: File,
    fr: File.Reader,
    decompress: flate.Decompress,
    compressed: bool,

    pub fn reader(self: *Source) *Io.Reader {
        return if (self.compressed) &self.decompress.reader else &self.fr.interface;
    }

    pub fn close(self: *Source, io: Io) void {
        self.file.close(io);
    }
};

pub const OpenError = error{
    /// Neither `<md5>` nor `<md5>.gz` is in the backup.
    BlobMissing,
};

/// Opens `md5` from the backup at `root` into `src`, decompressing when stored
/// gzipped. Uses `s.read_buf` and `s.window`.
pub fn open(io: Io, root: Dir, md5: []const u8, s: *Scratch, src: *Source) !void {
    var buf: [layout.blob_path_max]u8 = undefined;
    if (root.openFile(io, layout.blobPath(&buf, md5, true), .{})) |f| {
        src.file = f;
        src.compressed = true;
    } else |e| switch (e) {
        error.FileNotFound => {
            src.file = root.openFile(io, layout.blobPath(&buf, md5, false), .{}) catch |e2| switch (e2) {
                error.FileNotFound => return error.BlobMissing,
                else => return e2,
            };
            src.compressed = false;
        },
        else => return e,
    }
    src.fr = src.file.reader(io, &s.read_buf);
    if (src.compressed) src.decompress = flate.Decompress.init(&src.fr.interface, .gzip, &s.window);
}

pub const CheckError = error{
    /// The bytes read back do not hash to the blob's name.
    BlobCorrupt,
};

/// Reads `md5` back from the backup and checks it hashes to its name. Gzip's
/// own trailer is not trusted (`flate.Decompress` does not check it); the
/// md5 of the decompressed bytes is the check.
pub fn check(io: Io, root: Dir, md5: []const u8, pace: *pace_mod.Pace, s: *Scratch) !u64 {
    var src: Source = undefined;
    try open(io, root, md5, s, &src);
    defer src.close(io);
    var hasher = Md5.init(.{});
    var total: u64 = 0;
    const r = src.reader();
    while (true) {
        const n = r.readSliceShort(&s.chunk) catch |e| switch (e) {
            error.ReadFailed => return if (src.compressed) error.BlobCorrupt else e,
        };
        if (n == 0) break;
        hasher.update(s.chunk[0..n]);
        total += n;
        pace.take(io, n);
    }
    var digest: [Md5.digest_length]u8 = undefined;
    hasher.final(&digest);
    const hex = std.fmt.bytesToHex(digest, .lower);
    if (!std.mem.eql(u8, &hex, md5)) return error.BlobCorrupt;
    return total;
}

// ---- tests ----

const testing = std.testing;
const repeat = @import("../../util/repeat.zig").repeat;

const Env = struct {
    tmp: testing.TmpDir,
    live_dir: Dir,
    dst: Dir,
    live: blobstore.BlobStore,
    s: *Scratch,

    fn init() !Env {
        var tmp = testing.tmpDir(.{});
        errdefer tmp.cleanup();
        const live_dir = try tmp.dir.createDirPathOpen(testing.io, "live", .{});
        const dst = try tmp.dir.createDirPathOpen(testing.io, "backup", .{});
        return .{
            .tmp = tmp,
            .live_dir = live_dir,
            .dst = dst,
            .live = try blobstore.BlobStore.init(testing.io, live_dir),
            .s = try testing.allocator.create(Scratch),
        };
    }

    fn putLive(self: *Env, bytes: []const u8) ![32]u8 {
        var r: Io.Reader = .fixed(bytes);
        return (try self.live.put(&r, null)).md5;
    }

    fn deinit(self: *Env) void {
        testing.allocator.destroy(self.s);
        self.live_dir.close(testing.io);
        self.dst.close(testing.io);
        self.tmp.cleanup();
    }
};

fn unlimited() pace_mod.Pace {
    return .{ .rate = 0 };
}

test "a compressible blob is stored gzipped and reads back as its own bytes" {
    var env = try Env.init();
    defer env.deinit();
    const text = repeat(u8, "the quick brown fox jumps over the lazy dog\n", 400);
    const md5 = try env.putLive(text);
    var p = unlimited();

    try testing.expectEqual(Outcome.compressed, try put(testing.io, env.live, env.dst, &md5, true, &p, env.s));
    var buf: [layout.blob_path_max]u8 = undefined;
    const st = try env.dst.statFile(testing.io, layout.blobPath(&buf, &md5, true), .{});
    try testing.expect(st.size < text.len / 10);
    try testing.expectEqual(@as(u64, text.len), try check(testing.io, env.dst, &md5, &p, env.s));
    // A second run reads nothing.
    try testing.expectEqual(Outcome.present, try put(testing.io, env.live, env.dst, &md5, true, &p, env.s));
}

test "a blob gzip cannot shrink by 10% is kept as it came" {
    var env = try Env.init();
    defer env.deinit();
    var noise: [8192]u8 = undefined;
    var prng: std.Random.DefaultPrng = .init(7);
    prng.random().bytes(&noise);
    const md5 = try env.putLive(&noise);
    var p = unlimited();

    try testing.expectEqual(Outcome.raw, try put(testing.io, env.live, env.dst, &md5, true, &p, env.s));
    var buf: [layout.blob_path_max]u8 = undefined;
    try testing.expectError(error.FileNotFound, env.dst.access(testing.io, layout.blobPath(&buf, &md5, true), .{}));
    const raw = try env.dst.readFileAlloc(testing.io, layout.blobPath(&buf, &md5, false), testing.allocator, .unlimited);
    defer testing.allocator.free(raw);
    try testing.expectEqualSlices(u8, &noise, raw);
    var tb: [layout.blob_path_max + 4]u8 = undefined;
    try testing.expectError(error.FileNotFound, env.dst.access(testing.io, tempPath(&tb, &md5), .{}));
}

test "--no-compress keeps every blob in its own format" {
    var env = try Env.init();
    defer env.deinit();
    const md5 = try env.putLive("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    var p = unlimited();
    try testing.expectEqual(Outcome.raw, try put(testing.io, env.live, env.dst, &md5, false, &p, env.s));
}

test "a live blob that does not match its name is refused, and leaves nothing" {
    var env = try Env.init();
    defer env.deinit();
    const md5 = try env.putLive("original bytes");
    // Rot the live file in place.
    var lb: [layout.blob_path_max]u8 = undefined;
    const live_rel = layout.blobPath(&lb, &md5, false)[layout.blobs_dir.len + 1 ..];
    try env.live_dir.writeFile(testing.io, .{ .sub_path = live_rel, .data = "rotten bytes!!" });
    var p = unlimited();

    try testing.expectError(error.SourceCorrupt, put(testing.io, env.live, env.dst, &md5, true, &p, env.s));
    try testing.expect(!has(testing.io, env.dst, &md5));
    var tb: [layout.blob_path_max + 4]u8 = undefined;
    try testing.expectError(error.FileNotFound, env.dst.access(testing.io, tempPath(&tb, &md5), .{}));
}

test "a blob missing from the live store is SourceMissing" {
    var env = try Env.init();
    defer env.deinit();
    var p = unlimited();
    try testing.expectError(error.SourceMissing, put(testing.io, env.live, env.dst, "0123456789abcdef0123456789abcdef", true, &p, env.s));
}

test "check finds a missing and a corrupted backup blob" {
    var env = try Env.init();
    defer env.deinit();
    var p = unlimited();
    try testing.expectError(error.BlobMissing, check(testing.io, env.dst, "0123456789abcdef0123456789abcdef", &p, env.s));

    const md5 = try env.putLive(repeat(u8, "x", 5000));
    _ = try put(testing.io, env.live, env.dst, &md5, true, &p, env.s);
    var buf: [layout.blob_path_max]u8 = undefined;
    // Same length, different bytes: a corrupted gzip member.
    const path = layout.blobPath(&buf, &md5, true);
    const gz = try env.dst.readFileAlloc(testing.io, path, testing.allocator, .unlimited);
    defer testing.allocator.free(gz);
    gz[gz.len / 2] ^= 0xff;
    try env.dst.writeFile(testing.io, .{ .sub_path = path, .data = gz });
    try testing.expectError(error.BlobCorrupt, check(testing.io, env.dst, &md5, &p, env.s));
}
