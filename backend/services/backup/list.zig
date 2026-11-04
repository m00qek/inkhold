//! `inkhold backup list`: the snapshots in a backup directory, newest last,
//! from their manifest headers alone, and what the shared blob store holds.
//! A snapshot directory without a readable manifest is reported as
//! incomplete, never as a snapshot.

const std = @import("std");
const layout = @import("layout.zig");
const manifest = @import("manifest.zig");
const Io = std.Io;
const Dir = Io.Dir;

pub const Entry = struct {
    name: layout.SnapshotName,
    /// Null when the manifest is missing or unreadable: an interrupted run.
    header: ?manifest.Header,
    /// Size of the compressed database on disk.
    db_bytes: u64,
};

pub const Listing = struct {
    /// Ascending by name, so oldest first.
    entries: std.ArrayList(Entry) = .empty,
    /// `.partial` directories: runs that never finished (prune removes them).
    partials: u32 = 0,

    pub fn deinit(self: *Listing, gpa: std.mem.Allocator) void {
        self.entries.deinit(gpa);
    }

    /// The complete snapshots, oldest first.
    pub fn complete(self: *const Listing, buf: []Entry) []Entry {
        var n: usize = 0;
        for (self.entries.items) |e| if (e.header != null and n < buf.len) {
            buf[n] = e;
            n += 1;
        };
        return buf[0..n];
    }
};

pub fn list(gpa: std.mem.Allocator, io: Io, dir: Dir) !Listing {
    var out: Listing = .{};
    errdefer out.deinit(gpa);
    var it = dir.iterate();
    while (try it.next(io)) |e| {
        if (e.kind != .directory) continue;
        if (std.mem.endsWith(u8, e.name, layout.partial_suffix) and
            layout.isSnapshotName(e.name[0 .. e.name.len - layout.partial_suffix.len]))
        {
            out.partials += 1;
            continue;
        }
        if (!layout.isSnapshotName(e.name)) continue;
        var entry: Entry = .{ .name = e.name[0..layout.snapshot_name_len].*, .header = null, .db_bytes = 0 };
        entry.header = readHeader(io, dir, &entry.name) catch null;
        entry.db_bytes = dbBytes(io, dir, &entry.name);
        try out.entries.append(gpa, entry);
    }
    std.mem.sort(Entry, out.entries.items, {}, struct {
        fn lt(_: void, a: Entry, b: Entry) bool {
            return std.mem.order(u8, &a.name, &b.name) == .lt;
        }
    }.lt);
    return out;
}

/// The manifest header of snapshot `name`; errors when absent or malformed.
pub fn readHeader(io: Io, dir: Dir, name: []const u8) !manifest.Header {
    var pbuf: [layout.snapshot_name_len + 1 + layout.manifest_name.len]u8 = undefined;
    const path = std.fmt.bufPrint(&pbuf, "{s}/{s}", .{ name, layout.manifest_name }) catch unreachable;
    const f = try dir.openFile(io, path, .{});
    defer f.close(io);
    var buf: [1024]u8 = undefined;
    var fr = f.reader(io, &buf);
    const m = try manifest.Reader.init(&fr.interface);
    return m.header;
}

fn dbBytes(io: Io, dir: Dir, name: []const u8) u64 {
    var pbuf: [layout.snapshot_name_len + 1 + layout.db_name.len]u8 = undefined;
    const path = std.fmt.bufPrint(&pbuf, "{s}/{s}", .{ name, layout.db_name }) catch unreachable;
    const st = dir.statFile(io, path, .{}) catch return 0;
    return st.size;
}

pub const StoreStats = struct {
    blobs: u64 = 0,
    /// On disk, so compressed where a blob is.
    bytes: u64 = 0,
    /// `<md5>.tmp` files an interrupted copy left.
    temps: u64 = 0,
};

/// One pass over `blobs/`, one fan-out directory at a time.
pub fn storeStats(io: Io, dir: Dir) !StoreStats {
    var stats: StoreStats = .{};
    var blobs = dir.openDir(io, layout.blobs_dir, .{ .iterate = true }) catch |e| switch (e) {
        error.FileNotFound => return stats,
        else => return e,
    };
    defer blobs.close(io);
    var fans = blobs.iterate();
    while (try fans.next(io)) |fan| {
        if (fan.kind != .directory) continue;
        var sub = try blobs.openDir(io, fan.name, .{ .iterate = true });
        defer sub.close(io);
        var files = sub.iterate();
        while (try files.next(io)) |f| {
            if (f.kind != .file) continue;
            if (std.mem.endsWith(u8, f.name, ".tmp")) {
                stats.temps += 1;
                continue;
            }
            stats.blobs += 1;
            const st = sub.statFile(io, f.name, .{}) catch continue;
            stats.bytes += st.size;
        }
    }
    return stats;
}

// ---- tests ----

const testing = std.testing;
const fixture = @import("fixture.zig");
const create_mod = @import("create.zig");

test "list shows snapshots oldest first, and names an interrupted run without counting it" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try inst.addBlob("x");
    const o: create_mod.Options = .{ .rate = 0, .host = "t", .pid = 1, .version = "0.0.0" };
    var r: create_mod.Report = .{};
    try create_mod.create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, 1793761200 + 60, o, &r);
    try create_mod.create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, 1793761200, o, &r);

    var dir = try inst.backup();
    defer dir.close(testing.io);
    try dir.createDirPath(testing.io, "2026-11-05T030000Z.partial");
    try dir.createDirPath(testing.io, "2026-11-06T030000Z"); // no manifest
    try dir.createDirPath(testing.io, "my own folder");

    var l = try list(testing.allocator, testing.io, dir);
    defer l.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 3), l.entries.items.len);
    try testing.expectEqual(@as(u32, 1), l.partials);
    try testing.expectEqualStrings("2026-11-04T030000Z", &l.entries.items[0].name);
    try testing.expectEqualStrings("2026-11-04T030100Z", &l.entries.items[1].name);
    try testing.expect(l.entries.items[0].header != null);
    try testing.expect(l.entries.items[0].db_bytes > 0);
    try testing.expect(l.entries.items[2].header == null);

    var buf: [8]Entry = undefined;
    try testing.expectEqual(@as(usize, 2), l.complete(&buf).len);

    const stats = try storeStats(testing.io, dir);
    try testing.expectEqual(@as(u64, 1), stats.blobs);
    try testing.expectEqual(@as(u64, 0), stats.temps);
}
