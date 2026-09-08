//! Derived per-document files, keyed by `(source md5, index_version)` and kept
//! on disk as `<subdir>/<md5>.<index_version>`. Two stores share this one type:
//!
//!     data/terms/<md5>.<v>   page -> its folded terms, for search  (§2.2)
//!     data/text/<md5>.<v>    the document's segments, for reading
//!
//! It is `store/thumbs.zig` with two things added, and everything else is
//! deliberately the same — flat and unsharded, staged in `tmp/` then fsync'd
//! then atomically renamed, cleanup riding the source blob's GC, **existence of
//! the file IS the fact**, and a malformed key naming nothing rather than
//! panicking. Read that file's header for why each of those is the way it is;
//! only the differences are argued here.
//!
//! ## Difference 1: the version is in the NAME
//!
//! Same bytes, new parser, different output — so `index_version` is part of the
//! key, not just of the content (`golden-search.md` §2.1). That makes the
//! `(md5, index_version)` pair the client's cache key too, and it is what stops
//! a parser bump silently serving text derived by the old one.
//!
//! A consequence worth stating: **`has(md5, v)` is the derivation state.** There
//! is no "derived?" column to fall out of step with the disk, because the disk
//! is the record. A DB column may CACHE it for the manifest query, but it is
//! written after the rename and is never the authority.
//!
//! ## Difference 2: writes STREAM
//!
//! A thumbnail is small and already resident, so `ThumbStore.put` is one
//! `writeAll`. These files are neither. `.pdf` text arrives 50 pages at a time
//! and is never held whole (`pdf_text.nextChunk`), and a document's terms are
//! written page by page as each is folded — that is the whole point of §2.2's
//! per-page record, and holding the document to write it once would put back
//! the accumulator that record exists to delete.
//!
//! So the write is a handle: `begin` stages, the caller writes as much as it
//! likes over as long as it likes, `commit` publishes. `abort` (or simply
//! failing to commit, via `defer`) drops the staging file. Nothing is visible
//! until the rename, so a partial derive is invisible rather than corrupt.
//!
//! `Staged` is initialised THROUGH A POINTER (`begin(&staged, …)`) because it
//! owns the buffer its writer points into; returning it by value would leave
//! that pointer aimed at the dead copy.
//!
//! ## Retiring a superseded version
//!
//! `commit` unlinks every OTHER version of the same md5 once the new one is
//! safely in place (§2.7). Without it an `index_version` bump would leave the
//! old file behind for ever: nothing else would ever name it, and blob GC only
//! fires when the source blob goes away.
//!
//! `removeAll` is the GC face, and it takes no version because a caller
//! unlinking a dead blob's leftovers does not know which versions exist. It
//! scans the directory, which is O(entries) — household scale, on a path that
//! runs when a blob is destroyed, not when one is read.

const std = @import("std");
const blobstore = @import("blobs.zig");
// The stream's own two bytes rather than a second copy of them. This import is
// why `zig test backend/store/derived.zig` alone no longer resolves — the real
// suite is `zig build test`, and dodging that was how five hand-inlined
// `{ 0x03, 0x00 }` literals got into the tree in the first place.
const gzip_stitch = @import("../http/gzip_stitch.zig");

const Io = std.Io;
const Dir = std.Io.Dir;
const File = std.Io.File;

const md5_hex_len = blobstore.md5_hex_len;

/// `<32 hex>` + `.` + up to 20 digits of version.
const max_name_len = md5_hex_len + 1 + 20;

pub const DerivedStore = struct {
    io: Io,
    /// The store root (e.g. `<data_dir>/terms`). Owned by the caller; must be on
    /// the same filesystem as its `tmp/` subdir so the publish rename is atomic.
    root: Dir,

    /// Ensures the `tmp/` staging subdir exists under `root`.
    pub fn init(io: Io, root: Dir) !DerivedStore {
        try ensureDir(io, root, "tmp");
        return .{ .io = io, .root = root };
    }

    /// An in-progress write. Write through `staged.interface`; publish with
    /// `commit`. Anything that is not committed leaves no trace.
    pub const Staged = struct {
        store: DerivedStore,
        file: File,
        fw: File.Writer,
        /// The writer the caller feeds. Valid between `begin` and `commit`.
        interface: *std.Io.Writer,
        md5: [md5_hex_len]u8,
        version: i64,
        tmp_name: [20]u8,
        buf: [4096]u8,
        done: bool,

        /// Flush, fsync, publish, then retire every other version of this md5.
        pub fn commit(s: *Staged) !void {
            std.debug.assert(!s.done);
            try s.interface.flush(); // userspace buffer -> fd
            try s.file.sync(s.store.io); // fd -> disk, BEFORE the rename publishes it

            var final_buf: [max_name_len]u8 = undefined;
            const final_rel = finalRel(&final_buf, &s.md5, s.version).?;
            try Dir.rename(s.store.root, s.tmpRel(), s.store.root, final_rel, s.store.io);
            s.done = true;
            s.file.close(s.store.io);

            // Only now that the new version is durable and named: drop the old
            // ones. A crash between the rename and here leaves two versions,
            // which is safe — readers ask for one by name — and the next commit
            // clears it.
            s.store.removeOtherVersions(&s.md5, s.version);
        }

        /// Drop the staging file. Idempotent, and safe to `defer` unconditionally.
        pub fn abort(s: *Staged) void {
            if (s.done) return;
            s.done = true;
            s.file.close(s.store.io);
            s.store.root.deleteFile(s.store.io, s.tmpRel()) catch {};
        }

        fn tmpRel(s: *const Staged) []const u8 {
            return s.tmp_name[0..];
        }
    };

    /// Begin a streaming write of `(md5, version)`. `error.InvalidMd5` for a key
    /// that is not 32 characters, checked before anything is created.
    pub fn begin(self: DerivedStore, s: *Staged, md5: []const u8, version: i64) !void {
        if (md5.len != md5_hex_len) return error.InvalidMd5;
        s.store = self;
        s.version = version;
        s.done = false;
        @memcpy(&s.md5, md5[0..md5_hex_len]);
        self.tempName(&s.tmp_name);

        s.file = try self.root.createFile(self.io, s.tmpRel(), .{});
        errdefer {
            s.file.close(self.io);
            self.root.deleteFile(self.io, s.tmpRel()) catch {};
        }
        s.fw = s.file.writerStreaming(self.io, &s.buf);
        s.interface = &s.fw.interface;
    }

    /// Convenience for a caller that already holds the whole thing.
    pub fn put(self: DerivedStore, md5: []const u8, version: i64, bytes: []const u8) !void {
        var s: Staged = undefined;
        try self.begin(&s, md5, version);
        errdefer s.abort();
        try s.interface.writeAll(bytes);
        try s.commit();
    }

    /// Opens a stored file for streaming reads. Caller closes. `error.InvalidMd5`
    /// if `md5` is not 32 characters; a missing file is `error.FileNotFound`.
    pub fn open(self: DerivedStore, md5: []const u8, version: i64) !File {
        var buf: [max_name_len]u8 = undefined;
        const rel = finalRel(&buf, md5, version) orelse return error.InvalidMd5;
        return self.root.openFile(self.io, rel, .{});
    }

    /// **This is the derivation state** — see the header. A malformed md5 names
    /// nothing, so it is a miss rather than an error.
    pub fn has(self: DerivedStore, md5: []const u8, version: i64) bool {
        var buf: [max_name_len]u8 = undefined;
        const rel = finalRel(&buf, md5, version) orelse return false;
        self.root.access(self.io, rel, .{}) catch return false;
        return true;
    }

    /// Deletes one specific version. Missing is not an error.
    pub fn remove(self: DerivedStore, md5: []const u8, version: i64) void {
        var buf: [max_name_len]u8 = undefined;
        const rel = finalRel(&buf, md5, version) orelse return;
        self.root.deleteFile(self.io, rel) catch {};
    }

    /// Deletes EVERY version for this md5 — the blob-GC face, which does not
    /// know what versions exist. No-op for a malformed key.
    pub fn removeAll(self: DerivedStore, md5: []const u8) void {
        if (md5.len != md5_hex_len) return;
        self.removeMatching(md5[0..md5_hex_len].*, null);
    }

    fn removeOtherVersions(self: DerivedStore, md5: *const [md5_hex_len]u8, keep: i64) void {
        self.removeMatching(md5.*, keep);
    }

    /// Unlink `<md5>.*`, optionally sparing one version. Scans the directory
    /// because the versions present are not knowable from the key alone.
    fn removeMatching(self: DerivedStore, md5: [md5_hex_len]u8, keep: ?i64) void {
        var keep_buf: [max_name_len]u8 = undefined;
        const keep_rel: ?[]const u8 = if (keep) |v| finalRel(&keep_buf, &md5, v) else null;

        var dir = self.root.openDir(self.io, ".", .{ .iterate = true }) catch return;
        defer dir.close(self.io);
        var it = dir.iterate();
        while (it.next(self.io) catch null) |entry| {
            if (entry.kind != .file) continue;
            const name = entry.name;
            // `<md5>` `.` `<digits>` — anything else in this directory is not ours.
            if (name.len < md5_hex_len + 2) continue;
            if (!std.mem.eql(u8, name[0..md5_hex_len], &md5)) continue;
            if (name[md5_hex_len] != '.') continue;
            if (keep_rel) |k| if (std.mem.eql(u8, name, k)) continue;
            self.root.deleteFile(self.io, name) catch {};
        }
    }

    /// Removes leftover staging files from a prior crash. Safe: temp files are
    /// never referenced until renamed, so any that remain are abandoned writes.
    pub fn sweepTmp(self: DerivedStore) void {
        self.root.deleteTree(self.io, "tmp") catch {};
        ensureDir(self.io, self.root, "tmp") catch {};
    }

    fn tempName(self: DerivedStore, buf: *[20]u8) void {
        var raw: [8]u8 = undefined;
        self.io.random(&raw);
        @memcpy(buf[0..4], "tmp/");
        buf[4..20].* = std.fmt.bytesToHex(raw, .lower);
    }
};

fn ensureDir(io: Io, root: Dir, sub: []const u8) !void {
    var d = root.createDirPathOpen(io, sub, .{}) catch |err| switch (err) {
        error.PathAlreadyExists => return,
        else => return err,
    };
    d.close(io);
}

/// `<md5>.<version>`, or null when `md5` is not exactly 32 characters. The
/// length check lives HERE, at the one place a key becomes a path, so no entry
/// point can index a short key out of bounds — a file that cannot exist is a
/// miss, not a crash. A negative version is not representable in the name and
/// is refused for the same reason.
fn finalRel(buf: *[max_name_len]u8, md5: []const u8, version: i64) ?[]const u8 {
    if (md5.len != md5_hex_len) return null;
    if (version < 0) return null;
    @memcpy(buf[0..md5_hex_len], md5[0..md5_hex_len]);
    buf[md5_hex_len] = '.';
    const digits = std.fmt.printInt(buf[md5_hex_len + 1 ..], @as(u64, @intCast(version)), 10, .lower, .{});
    return buf[0 .. md5_hex_len + 1 + digits];
}

// ---- tests ----

const testing = std.testing;

const md5_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const md5_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

fn expectContents(store: DerivedStore, md5: []const u8, v: i64, want: []const u8) !void {
    var f = try store.open(md5, v);
    defer f.close(store.io);
    var buf: [8192]u8 = undefined;
    try testing.expectEqualStrings(want, try readAll(store.io, f, &buf));
}

test "streaming put/open/has round-trip" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    try testing.expect(!store.has(md5_a, 7));

    // Written in pieces, as a derive path does: a header line then pages.
    var s: DerivedStore.Staged = undefined;
    try store.begin(&s, md5_a, 7);
    errdefer s.abort();
    try s.interface.writeAll("{\"md5\":\"…\",\"v\":7}\n");
    try s.interface.writeAll("{\"p\":0,\"t\":\"reuniao\"}\n");
    try s.interface.writeAll("{\"p\":1,\"t\":\"acta\"}\n");
    try s.commit();

    try testing.expect(store.has(md5_a, 7));
    try expectContents(store, md5_a,
        7, "{\"md5\":\"…\",\"v\":7}\n{\"p\":0,\"t\":\"reuniao\"}\n{\"p\":1,\"t\":\"acta\"}\n");
}

test "nothing is visible until commit, and abort leaves no trace" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    var s: DerivedStore.Staged = undefined;
    try store.begin(&s, md5_a, 3);
    try s.interface.writeAll("half a document");
    try testing.expect(!store.has(md5_a, 3)); // staged, not published
    s.abort();
    try testing.expect(!store.has(md5_a, 3));
    s.abort(); // idempotent

    // The staging file is gone, not merely unreferenced.
    var d = try tmp.dir.openDir(io, "tmp", .{ .iterate = true });
    defer d.close(io);
    var it = d.iterate();
    try testing.expect((try it.next(io)) == null);
}

test "commit retires every OTHER version of the same md5" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    try store.put(md5_a, 5, "derived by parser 5");
    try store.put(md5_b, 5, "a different document");
    try testing.expect(store.has(md5_a, 5));

    // The parser bumps: the new version lands, the old one is unlinked, and the
    // OTHER document is untouched.
    try store.put(md5_a, 6, "derived by parser 6");
    try testing.expect(store.has(md5_a, 6));
    try testing.expect(!store.has(md5_a, 5));
    try testing.expect(store.has(md5_b, 5));
    try expectContents(store, md5_a, 6, "derived by parser 6");
}

test "re-committing the SAME version replaces it and keeps it" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    try store.put(md5_a, 7, "first derive");
    try store.put(md5_a, 7, "re-derived, same parser");
    try testing.expect(store.has(md5_a, 7));
    try expectContents(store, md5_a, 7, "re-derived, same parser");
}

test "removeAll drops every version; remove drops one" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    // Two versions of the same md5 can coexist after a crash between the rename
    // and the retirement, so GC must not assume there is only one.
    try store.put(md5_a, 5, "v5");
    try store.put(md5_b, 5, "other");
    var s: DerivedStore.Staged = undefined;
    try store.begin(&s, md5_a, 6);
    try s.interface.writeAll("v6");
    try s.interface.flush();
    try s.file.sync(io);
    var fb: [max_name_len]u8 = undefined;
    try Dir.rename(store.root, s.tmpRel(), store.root, finalRel(&fb, md5_a, 6).?, io);
    s.done = true;
    s.file.close(io);
    try testing.expect(store.has(md5_a, 5) and store.has(md5_a, 6));

    store.remove(md5_a, 5);
    try testing.expect(!store.has(md5_a, 5) and store.has(md5_a, 6));

    store.removeAll(md5_a);
    try testing.expect(!store.has(md5_a, 6));
    try testing.expect(store.has(md5_b, 5)); // a different key is untouched
    store.removeAll(md5_a); // no-op
}

test "a malformed md5 is a miss / no-op on every entry point, never a panic" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    for ([_][]const u8{
        "", "a", "abc", "0123456789abcdef",
        "0123456789abcdef0123456789abcdef0",
        "../../../../../../etc/passwd-x-32",
    }) |bad| {
        try testing.expect(!store.has(bad, 1));
        try testing.expectError(error.InvalidMd5, store.open(bad, 1));
        try testing.expectError(error.InvalidMd5, store.put(bad, 1, "x"));
        var s: DerivedStore.Staged = undefined;
        try testing.expectError(error.InvalidMd5, store.begin(&s, bad, 1));
        store.remove(bad, 1);
        store.removeAll(bad);
    }
}

test "a negative version names nothing rather than escaping the directory" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);
    try testing.expect(!store.has(md5_a, -1));
    try testing.expectError(error.InvalidMd5, store.open(md5_a, -1));
}

test "removeAll ignores files that are not ours" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    // A prefix match that is NOT `<md5>.<digits>` must survive.
    const f = try tmp.dir.createFile(io, md5_a ++ "-notours", .{});
    f.close(io);
    try store.put(md5_a, 4, "ours");

    store.removeAll(md5_a);
    try testing.expect(!store.has(md5_a, 4));
    try tmp.dir.access(io, md5_a ++ "-notours", .{});
}

test "sweepTmp clears staging and the store keeps working" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    const f = try tmp.dir.createFile(io, "tmp/deadbeefdeadbeef", .{});
    f.close(io);
    store.sweepTmp();
    try testing.expectError(error.FileNotFound, tmp.dir.access(io, "tmp/deadbeefdeadbeef", .{}));

    try store.put(md5_b, 1, "still works");
    try testing.expect(store.has(md5_b, 1));
}

// ---------------------------------------------------------------------------
// The stored FORMAT: a 12-byte header, then one raw-deflate fragment.
// ---------------------------------------------------------------------------

/// What a stored file looks like on disk:
///
///     [0..4)   magic "IDF1"
///     [4..8)   CRC32 of the UNCOMPRESSED payload, little-endian
///     [8..12)  uncompressed length, little-endian u32
///     [12..)   the payload as a byte-aligned raw-deflate fragment
///
/// **The CRC and the length are in the FILE, deliberately** (`golden-search.md`
/// §3.3): the stream route walks a list of files and accumulates the gzip
/// trailer with `crc32_combine` as it goes, so it must learn each fragment's
/// two numbers from the bytes it is already reading. A DB lookup per document
/// would put the write lock on the read path for no reason.
///
/// The fragment is `Container.raw` + `flush()` and never `finish()`, so it
/// carries no BFINAL block and concatenates with any other (§3.2). One header,
/// one trailer, N fragments in between, and the whole thing is a single-member
/// gzip that every decoder agrees about.
///
/// The magic is the format's own version. `index_version` is in the FILENAME
/// and versions the DERIVED CONTENT; this versions the CONTAINER, and the two
/// move for different reasons — a new parser bumps the first, a change to this
/// header would bump the second.
pub const header_len = 12;
const magic = "IDF1";

pub const Header = struct {
    crc: u32,
    /// Uncompressed length. u32 because gzip's ISIZE is u32 and no document
    /// here approaches 4 GB; `crc32Combine` takes it widened.
    len: u32,
};

/// Read the header of a stored file. `error.BadFragment` for anything that is
/// not one — a truncated write that somehow got published, or a file from a
/// future format.
pub fn readHeader(io: Io, file: File) !Header {
    var buf: [header_len]u8 = undefined;
    const n = try file.readPositionalAll(io, &buf, 0);
    if (n != header_len) return error.BadFragment;
    if (!std.mem.eql(u8, buf[0..4], magic)) return error.BadFragment;
    return .{
        .crc = std.mem.readInt(u32, buf[4..8], .little),
        .len = std.mem.readInt(u32, buf[8..12], .little),
    };
}

/// Read a stored file back to its PLAINTEXT — the inverse of `Fragment`.
///
/// This module defines the format, so it is the module that can read it. Three
/// callers had grown a private copy of these fifteen lines, each of them also
/// hand-inlining the two terminator bytes; one of those copies was mine, and the
/// other two followed it as precedent.
///
/// The terminator is why a fragment cannot simply be handed to an inflater. Every
/// fragment is written with `flush()` and never `finish()`, so NONE of them
/// carries a final block — that is the whole property that lets them concatenate
/// (§3.2). A single fragment is therefore an incomplete deflate stream, and
/// reading one back means appending exactly what the serve path appends after the
/// last fragment. Get that wrong and the stream ends by starvation, which
/// surfaces as `error.ReadFailed` with an EMPTY result rather than as a short
/// one — an early version of the store's own test swallowed that and asserted
/// against nothing.
///
/// Caller owns the returned slice. Mainly for tests and for a future debug path;
/// the serve route never does this — it streams the fragment out untouched.
pub fn readPlain(gpa: std.mem.Allocator, store: DerivedStore, md5: []const u8, version: i64) ![]u8 {
    var file = try store.open(md5, version);
    defer file.close(store.io);

    var body: std.Io.Writer.Allocating = .init(gpa);
    defer body.deinit();
    var buf: [4096]u8 = undefined;
    var off: u64 = header_len;
    while (true) {
        const n = try file.readPositionalAll(store.io, &buf, off);
        if (n == 0) break;
        try body.writer.writeAll(buf[0..n]);
        off += n;
        if (n < buf.len) break;
    }
    try body.writer.writeAll(&gzip_stitch.terminator);

    var input: std.Io.Reader = .fixed(body.written());
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .raw, &window);
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    _ = try d.reader.streamRemaining(&out.writer);
    return out.toOwnedSlice();
}

/// A streaming write of one document into `(md5, version)`: plaintext in,
/// header + deflate fragment on disk.
///
/// **Hold it somewhere that is not a deep stack frame.** It embeds deflate's
/// 64 KB window, so it is a large value; a derive path should own one for the
/// duration of a document rather than construct it per page.
///
/// Like `Staged`, it is initialised THROUGH A POINTER because it owns the
/// buffers its writers point into.
pub const Fragment = struct {
    staged: DerivedStore.Staged,
    window: [std.compress.flate.max_window_len]u8,
    compress: std.compress.flate.Compress,
    crc: std.hash.Crc32,
    len: u64,

    /// Append plaintext. Hashed and counted on the way in, compressed on the way
    /// out — the two numbers the header carries are of the PLAINTEXT, which is
    /// what the gzip trailer is defined over.
    pub fn write(f: *Fragment, bytes: []const u8) !void {
        f.crc.update(bytes);
        f.len += bytes.len;
        try f.compress.writer.writeAll(bytes);
    }

    /// Finish the fragment and publish the file. `flush()` rather than
    /// `finish()`: see the format note above.
    pub fn commit(f: *Fragment) !void {
        try f.compress.writer.flush();

        var head: [header_len]u8 = undefined;
        @memcpy(head[0..4], magic);
        std.mem.writeInt(u32, head[4..8], f.crc.final(), .little);
        std.mem.writeInt(u32, head[8..12], @truncate(f.len), .little);

        // The two numbers are only known now, so the header was reserved as
        // zeroes at `begin` and is filled in here — into the STAGING file,
        // before the fsync that `Staged.commit` does and long before the rename
        // publishes anything.
        try f.staged.interface.flush();
        try f.staged.file.writePositionalAll(f.staged.store.io, &head, 0);
        try f.staged.commit();
    }

    /// Drop everything. Idempotent, safe to `defer` unconditionally.
    pub fn abort(f: *Fragment) void {
        f.staged.abort();
    }
};

/// Begin a fragment write. Reserves the header, then opens the compressor.
pub fn beginFragment(store: DerivedStore, f: *Fragment, md5: []const u8, version: i64) !void {
    try store.begin(&f.staged, md5, version);
    errdefer f.staged.abort();
    f.crc = .init();
    f.len = 0;
    // Placeholder, overwritten by `commit` once the numbers exist.
    try f.staged.interface.writeAll(&[_]u8{0} ** header_len);
    f.compress = try std.compress.flate.Compress.init(
        f.staged.interface,
        &f.window,
        .raw,
        .level_6,
    );
}

test "a fragment round-trips through the header and inflates" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    const payload =
        "{\"md5\":\"…\",\"v\":7,\"n\":2}\n" ++
        "{\"p\":0,\"t\":\"reuniao orcamento projeto\"}\n" ++
        "{\"p\":1,\"t\":\"reuniao acta\"}\n";

    var f = try testing.allocator.create(Fragment);
    defer testing.allocator.destroy(f);
    try beginFragment(store, f, md5_a, 7);
    errdefer f.abort();
    // Written in pieces, as a derive path does: a line at a time.
    var it = std.mem.splitScalar(u8, payload, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        try f.write(line);
        try f.write("\n");
    }
    try f.commit();

    var file = try store.open(md5_a, 7);
    defer file.close(io);
    const h = try readHeader(io, file);
    try testing.expectEqual(std.hash.Crc32.hash(payload), h.crc);
    try testing.expectEqual(@as(u32, payload.len), h.len);

    // The body past the header must be a raw-deflate fragment that inflates to
    // exactly the plaintext -- i.e. usable as one piece of a stitched stream.
    var raw: [8192]u8 = undefined;
    const total = try file.readPositionalAll(io, &raw, 0);
    var body: std.Io.Writer.Allocating = .init(testing.allocator);
    defer body.deinit();
    try body.writer.writeAll(raw[header_len..total]);
    try body.writer.writeAll(&gzip_stitch.terminator);

    var input: std.Io.Reader = .fixed(body.written());
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .raw, &window);
    var got: std.Io.Writer.Allocating = .init(testing.allocator);
    defer got.deinit();
    _ = try d.reader.streamRemaining(&got.writer);
    try testing.expectEqualStrings(payload, got.written());
}

test "two stored fragments concatenate into one deflate stream" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    // This is the property the stream route depends on and the reason `commit`
    // uses `flush()` rather than `finish()`. Wrapping the result in a gzip
    // header and a `crc32_combine` trailer is `http/gzip_stitch.zig`'s job and
    // has its own tests there; what must hold HERE is that two independently
    // stored fragments are one valid deflate stream when placed end to end.
    const a_text = "{\"p\":0,\"t\":\"alpha beta\"}\n";
    const b_text = "{\"p\":0,\"t\":\"gamma delta\"}\n";
    for ([_][2][]const u8{ .{ md5_a, a_text }, .{ md5_b, b_text } }) |pair| {
        var f = try testing.allocator.create(Fragment);
        defer testing.allocator.destroy(f);
        try beginFragment(store, f, pair[0], 1);
        errdefer f.abort();
        try f.write(pair[1]);
        try f.commit();
    }

    var joined: std.Io.Writer.Allocating = .init(testing.allocator);
    defer joined.deinit();
    var crc: u32 = 0;
    var total_len: u32 = 0;
    for ([_][]const u8{ md5_a, md5_b }) |md5| {
        var file = try store.open(md5, 1);
        defer file.close(io);
        const h = try readHeader(io, file);
        var raw: [4096]u8 = undefined;
        const n = try file.readPositionalAll(io, &raw, 0);
        try joined.writer.writeAll(raw[header_len..n]);
        crc = h.crc;
        total_len += h.len;
    }
    try testing.expectEqual(@as(u32, a_text.len + b_text.len), total_len);
    try testing.expectEqual(std.hash.Crc32.hash(b_text), crc); // per-fragment, not combined

    // The empty FINAL stored block that ends a deflate stream -- what the serve
    // path appends after the last fragment (`gzip_stitch.terminator`). Without
    // it the stream is legitimately incomplete: every fragment was written with
    // `flush()` precisely so that none of them carries a BFINAL block.
    try joined.writer.writeAll(&gzip_stitch.terminator);

    var input: std.Io.Reader = .fixed(joined.written());
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .raw, &window);
    var got: std.Io.Writer.Allocating = .init(testing.allocator);
    defer got.deinit();
    _ = try d.reader.streamRemaining(&got.writer);
    try testing.expectEqualStrings(a_text ++ b_text, got.written());
}

test "readHeader refuses anything that is not a fragment" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    try store.put(md5_a, 1, "not a fragment at all");
    var f1 = try store.open(md5_a, 1);
    defer f1.close(io);
    try testing.expectError(error.BadFragment, readHeader(io, f1));

    try store.put(md5_b, 1, "IDF"); // shorter than a header
    var f2 = try store.open(md5_b, 1);
    defer f2.close(io);
    try testing.expectError(error.BadFragment, readHeader(io, f2));
}
