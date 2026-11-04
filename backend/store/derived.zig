//! Derived per-document files (`data/terms/`, `data/text/`) on disk as
//! `<subdir>/<md5>.<index_version>`; `has(md5, v)` is the derivation state.
//! Streamed writes staged in `tmp/` and atomically renamed, so a partial derive
//! is invisible. `Staged`/`Fragment` are initialised through a pointer: each
//! owns the buffer its writer points into.

const std = @import("std");
const atomic = @import("atomic.zig");
const blobstore = @import("blobs.zig");
// This import is why the file only tests under `zig build test`.
const gzip_stitch = @import("../compress/gzip_stitch.zig");

const derived_format = @import("derived_format.zig");
pub const header_len = derived_format.header_len;
pub const Header = derived_format.Header;
pub const readHeader = derived_format.readHeader;
pub const readPlain = derived_format.readPlain;
pub const Fragment = derived_format.Fragment;
pub const beginFragment = derived_format.beginFragment;

const Io = std.Io;
const Dir = std.Io.Dir;
const File = std.Io.File;

const md5_hex_len = blobstore.md5_hex_len;

const max_name_len = md5_hex_len + 1 + 20;

pub const DerivedStore = struct {
    io: Io,
    /// Owned by the caller; must share a filesystem with its `tmp/` for the rename.
    root: Dir,

    /// Opens the store at `root`, creating its `tmp/` staging directory.
    pub fn init(io: Io, root: Dir) !DerivedStore {
        try atomic.ensureDir(io, root, "tmp");
        return .{ .io = io, .root = root };
    }

    pub const Staged = struct {
        store: DerivedStore,
        file: File,
        fw: File.Writer,
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

            // Only once the new version is durable; a crash here leaves two versions,
            // which is safe and cleared by the next commit.
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

    /// Starts staging `<md5>.<version>` in `s`: write through `s.interface`, then
    /// `commit` or `abort`. `s` must not move afterwards.
    pub fn begin(self: DerivedStore, s: *Staged, md5: []const u8, version: i64) !void {
        if (md5.len != md5_hex_len) return error.InvalidMd5;
        s.store = self;
        s.version = version;
        s.done = false;
        @memcpy(&s.md5, md5[0..md5_hex_len]);
        _ = atomic.tempName(self.io, &s.tmp_name);

        s.file = try self.root.createFile(self.io, s.tmpRel(), .{});
        errdefer {
            s.file.close(self.io);
            self.root.deleteFile(self.io, s.tmpRel()) catch {};
        }
        s.fw = s.file.writerStreaming(self.io, &s.buf);
        s.interface = &s.fw.interface;
    }

    /// Stages, writes and commits `bytes` in one step.
    pub fn put(self: DerivedStore, md5: []const u8, version: i64, bytes: []const u8) !void {
        var s: Staged = undefined;
        try self.begin(&s, md5, version);
        errdefer s.abort();
        try s.interface.writeAll(bytes);
        try s.commit();
    }

    /// Caller closes.
    pub fn open(self: DerivedStore, md5: []const u8, version: i64) !File {
        var buf: [max_name_len]u8 = undefined;
        const rel = finalRel(&buf, md5, version) orelse return error.InvalidMd5;
        return self.root.openFile(self.io, rel, .{});
    }

    /// Whether `<md5>.<version>` is published.
    pub fn has(self: DerivedStore, md5: []const u8, version: i64) bool {
        var buf: [max_name_len]u8 = undefined;
        const rel = finalRel(&buf, md5, version) orelse return false;
        self.root.access(self.io, rel, .{}) catch return false;
        return true;
    }

    /// Deletes one published version; a missing file or malformed key is a no-op.
    pub fn remove(self: DerivedStore, md5: []const u8, version: i64) void {
        var buf: [max_name_len]u8 = undefined;
        const rel = finalRel(&buf, md5, version) orelse return;
        self.root.deleteFile(self.io, rel) catch {};
    }

    /// Every version (the blob-GC face). No-op for a malformed key.
    pub fn removeAll(self: DerivedStore, md5: []const u8) void {
        if (md5.len != md5_hex_len) return;
        self.removeMatching(md5[0..md5_hex_len].*, null);
    }

    fn removeOtherVersions(self: DerivedStore, md5: *const [md5_hex_len]u8, keep: i64) void {
        self.removeMatching(md5.*, keep);
    }

    fn removeMatching(self: DerivedStore, md5: [md5_hex_len]u8, keep: ?i64) void {
        var keep_buf: [max_name_len]u8 = undefined;
        const keep_rel: ?[]const u8 = if (keep) |v| finalRel(&keep_buf, &md5, v) else null;

        var dir = self.root.openDir(self.io, ".", .{ .iterate = true }) catch return;
        defer dir.close(self.io);
        var it = dir.iterate();
        while (it.next(self.io) catch null) |entry| {
            if (entry.kind != .file) continue;
            const name = entry.name;
            if (name.len < md5_hex_len + 2) continue;
            if (!std.mem.eql(u8, name[0..md5_hex_len], &md5)) continue;
            if (name[md5_hex_len] != '.') continue;
            if (keep_rel) |k| if (std.mem.eql(u8, name, k)) continue;
            self.root.deleteFile(self.io, name) catch {};
        }
    }

    /// Removes staging files abandoned by a crash.
    /// Removes temp files abandoned by a crash.
    pub fn sweepTmp(self: DerivedStore) void {
        atomic.sweepTmp(self.io, self.root);
    }
};

/// `<md5>.<version>`, or null for a short key or negative version.
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

fn expectContents(store: DerivedStore, md5: []const u8, v: i64, want: []const u8) !void {
    var f = try store.open(md5, v);
    defer f.close(store.io);
    var buf: [8192]u8 = undefined;
    try testing.expectEqualStrings(want, try atomic.readAll(store.io, f, &buf));
}

test "streaming put/open/has round-trip" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try DerivedStore.init(io, tmp.dir);

    try testing.expect(!store.has(md5_a, 7));

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

    // Two versions can coexist after a crash, so GC must not assume one.
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

test {
    _ = derived_format;
}
