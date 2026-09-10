//! Derived per-document files keyed by `(source md5, index_version)`, on disk as
//! `<subdir>/<md5>.<index_version>`: `data/terms/` (§2.2) and `data/text/`.
//!
//! `store/thumbs.zig`'s shape — flat, staged in `tmp/` then fsync'd then
//! atomically renamed, cleaned up by the source blob's GC, a malformed key naming
//! nothing — with two differences:
//!   * The version is in the FILENAME (§2.1), so a parser
//!     bump cannot serve text derived by the old one. `has(md5, v)` IS the
//!     derivation state; a DB column may cache it, and is never the authority.
//!   * Writes STREAM through a handle (`begin`, write, `commit`): `.pdf` text
//!     arrives 50 pages at a time and terms are written per page. Nothing is
//!     visible before the rename, so a partial derive is invisible, not corrupt.
//!
//! `Staged` and `Fragment` are initialised THROUGH A POINTER: each owns the
//! buffer its writer points into, and returned by value that pointer would aim
//! at the dead copy.

const std = @import("std");
const blobstore = @import("blobs.zig");
// This import is why `zig test backend/store/derived.zig` alone does not
// resolve; the suite is `zig build test`.
const gzip_stitch = @import("../http/gzip_stitch.zig");

const Io = std.Io;
const Dir = std.Io.Dir;
const File = std.Io.File;

const md5_hex_len = blobstore.md5_hex_len;

/// `<32 hex>` + `.` + up to 20 digits of version.
const max_name_len = md5_hex_len + 1 + 20;

pub const DerivedStore = struct {
    io: Io,
    /// Owned by the caller; must be on the same filesystem as its `tmp/` subdir
    /// so the publish rename is atomic.
    root: Dir,

    pub fn init(io: Io, root: Dir) !DerivedStore {
        try ensureDir(io, root, "tmp");
        return .{ .io = io, .root = root };
    }

    /// An in-progress write. Anything not committed leaves no trace.
    pub const Staged = struct {
        store: DerivedStore,
        file: File,
        fw: File.Writer,
        /// Valid between `begin` and `commit`.
        interface: *std.Io.Writer,
        md5: [md5_hex_len]u8,
        version: i64,
        tmp_name: [20]u8,
        buf: [4096]u8,
        done: bool,

        /// Flush, fsync, publish, then retire every other version of this md5.
        pub fn commit(s: *Staged) !void {
            std.debug.assert(!s.done);
            try s.interface.flush();
            try s.file.sync(s.store.io); // BEFORE the rename publishes it

            var final_buf: [max_name_len]u8 = undefined;
            const final_rel = finalRel(&final_buf, &s.md5, s.version).?;
            try Dir.rename(s.store.root, s.tmpRel(), s.store.root, final_rel, s.store.io);
            s.done = true;
            s.file.close(s.store.io);

            // Only once the new version is durable and named. A crash between
            // the rename and here leaves two versions, which is safe — readers
            // ask for one by name — and the next commit clears it.
            s.store.removeOtherVersions(&s.md5, s.version);
        }

        /// Idempotent; safe to `defer` unconditionally.
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

    /// `error.InvalidMd5` for a key that is not 32 characters, before anything
    /// is created.
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

    pub fn put(self: DerivedStore, md5: []const u8, version: i64, bytes: []const u8) !void {
        var s: Staged = undefined;
        try self.begin(&s, md5, version);
        errdefer s.abort();
        try s.interface.writeAll(bytes);
        try s.commit();
    }

    /// Caller closes. `error.InvalidMd5` for a bad key, `error.FileNotFound`
    /// for a missing file.
    pub fn open(self: DerivedStore, md5: []const u8, version: i64) !File {
        var buf: [max_name_len]u8 = undefined;
        const rel = finalRel(&buf, md5, version) orelse return error.InvalidMd5;
        return self.root.openFile(self.io, rel, .{});
    }

    /// THE derivation state. A malformed md5 names nothing: a miss, not an error.
    pub fn has(self: DerivedStore, md5: []const u8, version: i64) bool {
        var buf: [max_name_len]u8 = undefined;
        const rel = finalRel(&buf, md5, version) orelse return false;
        self.root.access(self.io, rel, .{}) catch return false;
        return true;
    }

    /// Missing is not an error.
    pub fn remove(self: DerivedStore, md5: []const u8, version: i64) void {
        var buf: [max_name_len]u8 = undefined;
        const rel = finalRel(&buf, md5, version) orelse return;
        self.root.deleteFile(self.io, rel) catch {};
    }

    /// Every version — the blob-GC face, which does not know what versions
    /// exist. No-op for a malformed key.
    pub fn removeAll(self: DerivedStore, md5: []const u8) void {
        if (md5.len != md5_hex_len) return;
        self.removeMatching(md5[0..md5_hex_len].*, null);
    }

    fn removeOtherVersions(self: DerivedStore, md5: *const [md5_hex_len]u8, keep: i64) void {
        self.removeMatching(md5.*, keep);
    }

    /// Unlink `<md5>.*`, optionally sparing one version. O(entries), on a path
    /// that runs when a blob dies rather than when one is read.
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

    /// Staging files are never referenced until renamed, so any that remain are
    /// abandoned writes from a prior crash.
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

/// `<md5>.<version>`, or null. The length check lives at the one place a key
/// becomes a path, so no entry point can index a short key out of bounds; a
/// negative version is not representable and is refused for the same reason.
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
    try expectContents(store, md5_a, 7, "{\"md5\":\"…\",\"v\":7}\n{\"p\":0,\"t\":\"reuniao\"}\n{\"p\":1,\"t\":\"acta\"}\n");
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
        "",                                  "a",                                 "abc", "0123456789abcdef",
        "0123456789abcdef0123456789abcdef0", "../../../../../../etc/passwd-x-32",
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

/// On disk:
///
///     [0..4)   magic "IDF1"
///     [4..8)   CRC32 of the UNCOMPRESSED payload, little-endian
///     [8..12)  uncompressed length, little-endian u32
///     [12..)   the payload as a byte-aligned raw-deflate fragment
///
/// The CRC and length are in the FILE so the stream route can accumulate the
/// gzip trailer from the bytes it is already reading — no DB lookup, and no
/// write lock, on the read path (§3.3). The fragment is `Container.raw` +
/// `flush()`, never `finish()`, so it carries no BFINAL block and concatenates
/// with any other (§3.2).
///
/// The magic versions the CONTAINER; `index_version` in the filename versions
/// the CONTENT. They move for different reasons.
pub const header_len = 12;
const magic = "IDF1";

pub const Header = struct {
    crc: u32,
    /// u32 because gzip's ISIZE is; `crc32Combine` takes it widened.
    len: u32,
};

/// `error.BadFragment` for anything that is not one — a truncated write that
/// got published, or a future format.
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

/// Read a stored file back to its PLAINTEXT — the inverse of `Fragment`. Caller
/// owns the slice. For tests and debugging; the serve route streams untouched.
///
/// The terminator MUST be appended: no fragment carries a final block, so alone
/// it is an incomplete deflate stream, and without it the read ends by
/// starvation — `error.ReadFailed` with an EMPTY result, not a short one. An
/// early test swallowed that and asserted against nothing.
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

/// A streaming write of one document: plaintext in, header + deflate fragment
/// on disk. Embeds deflate's 64 KB window, so hold it off a deep stack frame,
/// one per document rather than per page.
pub const Fragment = struct {
    staged: DerivedStore.Staged,
    window: [std.compress.flate.max_window_len]u8,
    compress: std.compress.flate.Compress,
    crc: std.hash.Crc32,
    len: u64,

    /// The CRC and length are of the PLAINTEXT — what the gzip trailer is
    /// defined over.
    pub fn write(f: *Fragment, bytes: []const u8) !void {
        f.crc.update(bytes);
        f.len += bytes.len;
        try f.compress.writer.writeAll(bytes);
    }

    /// `flush()`, never `finish()`: no BFINAL block (see the format note).
    pub fn commit(f: *Fragment) !void {
        try f.compress.writer.flush();

        var head: [header_len]u8 = undefined;
        @memcpy(head[0..4], magic);
        std.mem.writeInt(u32, head[4..8], f.crc.final(), .little);
        std.mem.writeInt(u32, head[8..12], @truncate(f.len), .little);

        // The header reserved at `begin` is filled in now, into the STAGING
        // file, before `Staged.commit`'s fsync and rename.
        try f.staged.interface.flush();
        try f.staged.file.writePositionalAll(f.staged.store.io, &head, 0);
        try f.staged.commit();
    }

    /// Idempotent; safe to `defer` unconditionally.
    pub fn abort(f: *Fragment) void {
        f.staged.abort();
    }
};

pub fn beginFragment(store: DerivedStore, f: *Fragment, md5: []const u8, version: i64) !void {
    try store.begin(&f.staged, md5, version);
    errdefer f.staged.abort();
    f.crc = .init();
    f.len = 0;
    // Placeholder header, overwritten by `commit`.
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
