//! Fixture and helpers shared by the `controlplane` tests.

const std = @import("std");
const Files = @import("../files.zig").Files;
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const testing = std.testing;
const sqlite = @import("../../db/sqlite.zig");
const schema = @import("../../db/schema.zig");
const nb = @import("note_builder");
const cp = @import("../controlplane.zig");
const LayerVO = cp.LayerVO;
const EntryVO = cp.EntryVO;
const ListingVO = cp.ListingVO;
const ControlPlaneService = cp.ControlPlaneService;

pub const Fixture = struct {
    db: sqlite.Db,
    files: Files,
    tmp: testing.TmpDir,

    pub fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 100000000);");
        const tmp = testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{ .db = db, .files = Files.init(testing.allocator, testing.io, db, store, thumbs), .tmp = tmp };
    }

    pub fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }
};

/// Seeds a synthetic `.note` with the given main-layer bitmaps; returns its id.
pub fn seedNote(f: *Fixture, parent: ?u64, name: []const u8, page_bitmaps: []const []const u8) !u64 {
    var pages: std.ArrayList(nb.PageSpec) = .empty;
    defer pages.deinit(testing.allocator);
    var layers: std.ArrayList([1]nb.LayerSpec) = .empty;
    defer layers.deinit(testing.allocator);
    for (page_bitmaps) |bmp| {
        try layers.append(testing.allocator, .{.{ .slot = .main, .bitmap = bmp }});
    }
    for (layers.items) |*l| {
        try pages.append(testing.allocator, .{ .layers = l[0..1] });
    }
    const bytes = try nb.serialize(testing.allocator, .{ .pages = pages.items });
    defer testing.allocator.free(bytes);

    return seedBytes(f, parent, name, bytes);
}

/// Seeds arbitrary bytes as a file and returns its id.
pub fn seedBytes(f: *Fixture, parent: ?u64, name: []const u8, bytes: []const u8) !u64 {
    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(1, parent, name, &r, null);
    defer e.deinit(testing.allocator);
    return e.id;
}

/// Plans and streams a page as `page` does; null where it would 404.
pub const Served = struct { bytes: []const u8, hash: [32]u8, content_length: u64 };

pub fn servePage(
    svc: ControlPlaneService,
    arena: std.mem.Allocator,
    user_id: u64,
    id: u64,
    n: u64,
) !?Served {
    const planned = (try svc.pagePlan(user_id, id, n)) orelse return null;
    var out: std.Io.Writer.Allocating = .init(arena);
    try svc.writePage(planned, &out.writer);
    return .{
        .bytes = out.written(),
        .hash = planned.plan.content_hash,
        .content_length = planned.plan.content_length,
    };
}

/// Absent stays absent (never `[]`); present matches field-for-field in order.
pub fn expectSameLayers(want: ?[]const LayerVO, got: ?[]const LayerVO) !void {
    if (want == null) return testing.expect(got == null);
    try testing.expect(got != null);
    try testing.expectEqual(want.?.len, got.?.len);
    for (want.?, got.?) |w, g| {
        try testing.expectEqualStrings(w.slot, g.slot);
        try testing.expectEqualStrings(w.name, g.name);
        try testing.expectEqual(w.visible, g.visible);
        try testing.expectEqual(w.isCurrent, g.isCurrent);
    }
}

/// The root listing's entry named `name`, or a failed expectation.
pub fn entryNamed(vo: ListingVO, name: []const u8) !EntryVO {
    for (vo.entries) |e| {
        if (std.mem.eql(u8, e.name, name)) return e;
    }
    return error.TestUnexpectedResult;
}
