//! Fixture and helpers shared by the `note_index` tests.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const blob_source = @import("../../store/blob_source.zig");
const sn = @import("supernote");
const Allocator = std.mem.Allocator;
const testing = std.testing;
const schema = @import("../../db/schema.zig");
const filesmod = @import("../files.zig");
const nb = @import("note_builder");
const noteindex = @import("../note_index.zig");
const parseBlob = noteindex.parseBlob;
const store = noteindex.store;

/// Page 1 `#`-JSON LAYERINFO; page 2 base64 with a hidden Layer 2, a renamed
/// top layer, layerId -1 background.
pub const layers_edited = @embedFile("layers_edited.note");

pub const Fixture = struct {
    db: sqlite.Db,
    files: filesmod.Files,
    tmp: testing.TmpDir,

    pub fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1000000000);");
        const tmp = testing.tmpDir(.{});
        const store_ = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs_ = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{ .db = db, .files = filesmod.Files.init(testing.allocator, testing.io, db, store_, thumbs_), .tmp = tmp };
    }

    pub fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    pub fn put(f: *Fixture, name: []const u8, data: []const u8) ![blobstore.md5_hex_len]u8 {
        var r = std.Io.Reader.fixed(data);
        const e = try f.files.putFile(1, null, name, &r, null);
        defer e.deinit(testing.allocator);
        var out: [blobstore.md5_hex_len]u8 = undefined;
        @memcpy(&out, e.md5.?[0..blobstore.md5_hex_len]);
        return out;
    }

    pub fn countRows(f: *Fixture, sql: []const u8) !i64 {
        var s = try f.db.prepare(sql);
        defer s.finalize();
        _ = try s.step();
        return s.columnInt(0);
    }
};

/// A bare blob store on a temp dir, no database.
pub const Blobs = struct {
    tmp: testing.TmpDir,
    store: blobstore.BlobStore,

    pub fn init() !Blobs {
        const tmp = testing.tmpDir(.{});
        return .{ .tmp = tmp, .store = try blobstore.BlobStore.init(testing.io, tmp.dir) };
    }
    pub fn deinit(b: *Blobs) void {
        b.tmp.cleanup();
    }
    pub fn put(b: *Blobs, data: []const u8) ![blobstore.md5_hex_len]u8 {
        var r = std.Io.Reader.fixed(data);
        return (try b.store.put(&r, null)).md5;
    }
    pub fn source(b: *Blobs, md5: *const [blobstore.md5_hex_len]u8, out: *blob_source.BlobSource) !sn.Source {
        out.* = try blob_source.BlobSource.init(b.store, md5);
        return out.source();
    }
};

/// Records peak live bytes, to prove the blob path does not buffer.
pub const PeakAllocator = struct {
    child: Allocator,
    live: usize = 0,
    peak: usize = 0,

    pub fn allocator(self: *PeakAllocator) Allocator {
        return .{ .ptr = self, .vtable = &.{
            .alloc = alloc,
            .resize = resize,
            .remap = remap,
            .free = free,
        } };
    }

    pub fn grew(self: *PeakAllocator, n: usize) void {
        self.live += n;
        self.peak = @max(self.peak, self.live);
    }

    pub fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        const p = self.child.rawAlloc(len, alignment, ra) orelse return null;
        self.grew(len);
        return p;
    }
    pub fn resize(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) bool {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        if (!self.child.rawResize(memory, alignment, new_len, ra)) return false;
        self.live -= memory.len;
        self.grew(new_len);
        return true;
    }
    pub fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) ?[*]u8 {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        const p = self.child.rawRemap(memory, alignment, new_len, ra) orelse return null;
        self.live -= memory.len;
        self.grew(new_len);
        return p;
    }
    pub fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ra: usize) void {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        self.child.rawFree(memory, alignment, ra);
        self.live -= memory.len;
    }
};

/// Indexes `bytes` under `md5` into `db`, blobs row included so the FK holds.
pub fn indexInto(db: sqlite.Db, md5: []const u8, bytes: []const u8) !void {
    {
        try db.run(
            "INSERT OR IGNORE INTO blobs(md5, size, refcount, created_at) VALUES(?1,?2,1,0);",
            &.{ .{ .text = md5 }, .{ .int = @intCast(bytes.len) } },
        );
    }
    var p = try parseBlob(testing.allocator, bytes);
    defer p.deinit();
    try store(db, md5, p, 0);
}

pub fn coveredNote(a: Allocator, cover: ?[]const u8) ![]u8 {
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(a, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
        .covers = if (cover) |c| &.{.{ .bytes = c }} else &.{},
    });
}
