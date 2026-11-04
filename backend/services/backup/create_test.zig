//! Tests for `backup create`: what a snapshot holds, what a second run costs,
//! and every refusal.

const std = @import("std");
const testing = std.testing;
const layout = @import("layout.zig");
const manifest = @import("manifest.zig");
const lock = @import("lock.zig");
const blob_copy = @import("blob_copy.zig");
const create_mod = @import("create.zig");
const pace_mod = @import("pace.zig");
const sqlite = @import("../../db/sqlite.zig");
const fixture = @import("fixture.zig");
const repeat = @import("../../util/repeat.zig").repeat;
const create = create_mod.create;
const Io = std.Io;

const t0: i64 = 1793761200; // 2026-11-04T030000Z

fn opts() create_mod.Options {
    return .{ .rate = 0, .host = "test", .pid = 1, .version = "0.0.0" };
}

/// The md5s a snapshot's manifest lists, checking the header on the way.
fn manifestMd5s(dir: std.Io.Dir, name: []const u8, expect_blobs: u64) !std.ArrayList([32]u8) {
    var path_buf: [64]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ name, layout.manifest_name });
    const f = try dir.openFile(testing.io, path, .{});
    defer f.close(testing.io);
    var buf: [4096]u8 = undefined;
    var fr = f.reader(testing.io, &buf);
    var m = try manifest.Reader.init(&fr.interface);
    try testing.expectEqual(expect_blobs, m.header.blobs);
    var list: std.ArrayList([32]u8) = .empty;
    errdefer list.deinit(testing.allocator);
    while (try m.next()) |md5| try list.append(testing.allocator, md5);
    return list;
}

test "a snapshot holds the database, a manifest naming every blob, and the blobs themselves" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    const a = try inst.addBlob(repeat(u8, "notebook page ", 500));
    const b = try inst.addBlob("a small text file");

    var report: create_mod.Report = .{};
    try create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, opts(), &report);
    try testing.expectEqualStrings("2026-11-04T030000Z", &report.name);
    try testing.expectEqual(@as(u64, 2), report.blobs);
    try testing.expectEqual(@as(u64, 2), report.copied);

    var dir = try inst.backup();
    defer dir.close(testing.io);
    var md5s = try manifestMd5s(dir, &report.name, 2);
    defer md5s.deinit(testing.allocator);
    const lo, const hi = if (std.mem.order(u8, &a, &b) == .lt) .{ a, b } else .{ b, a };
    try testing.expectEqualStrings(&lo, &md5s.items[0]);
    try testing.expectEqualStrings(&hi, &md5s.items[1]);

    const s = try testing.allocator.create(blob_copy.Scratch);
    defer testing.allocator.destroy(s);
    var p: pace_mod.Pace = .{ .rate = 0 };
    for (md5s.items) |*m| _ = try blob_copy.check(testing.io, dir, m, &p, s);

    try dir.access(testing.io, "2026-11-04T030000Z/" ++ layout.db_name, .{});
    try dir.access(testing.io, layout.readme_name, .{});
    // Nothing a run leaves behind: no partial, no lock, no private snapshot.
    try testing.expectError(error.FileNotFound, dir.access(testing.io, "2026-11-04T030000Z.partial", .{}));
    try testing.expectError(error.FileNotFound, dir.access(testing.io, layout.lock_name, .{}));
    try testing.expectError(error.FileNotFound, dir.access(testing.io, "2026-11-04T030000Z/" ++ layout.cred_key_name, .{}));
    try testing.expectError(error.FileNotFound, inst.tmp.dir.access(testing.io, "state/data/" ++ create_mod.tmp_dir_name, .{}));
}

test "the snapshot's database is a consistent, standalone copy of the live one" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try inst.addBlob("one");
    var report: create_mod.Report = .{};
    try create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, opts(), &report);

    // Inflate the snapshot and open it as a database.
    var dir = try inst.backup();
    defer dir.close(testing.io);
    const gz = try dir.readFileAlloc(testing.io, "2026-11-04T030000Z/" ++ layout.db_name, testing.allocator, .unlimited);
    defer testing.allocator.free(gz);
    var in: Io.Reader = .fixed(gz);
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&in, .gzip, &window);
    var out: Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    _ = try d.reader.streamRemaining(&out.writer);
    try inst.tmp.dir.writeFile(testing.io, .{ .sub_path = "restored.db", .data = out.written() });

    const path = try std.fmt.allocPrintSentinel(testing.allocator, "{s}/restored.db", .{inst.root}, 0);
    defer testing.allocator.free(path);
    const db = try sqlite.Db.openNoCreate(path, 1000);
    defer db.close();
    var r = (try db.row("SELECT COUNT(*) FROM blobs;", &.{})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 1), r.int(0));
    var q = (try db.row("PRAGMA integrity_check;", &.{})).?;
    defer q.finalize();
    try testing.expectEqualStrings("ok", q.text(0));
}

test "a second run copies only what is new, and both snapshots stand alone" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try inst.addBlob("first");
    var r1: create_mod.Report = .{};
    try create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, opts(), &r1);
    _ = try inst.addBlob("second");
    var r2: create_mod.Report = .{};
    try create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0 + 86400, opts(), &r2);
    try testing.expectEqual(@as(u64, 1), r2.copied);
    try testing.expectEqual(@as(u64, 2), r2.blobs);

    var dir = try inst.backup();
    defer dir.close(testing.io);
    var m1 = try manifestMd5s(dir, &r1.name, 1);
    defer m1.deinit(testing.allocator);
    var m2 = try manifestMd5s(dir, &r2.name, 2);
    defer m2.deinit(testing.allocator);
}

test "the credential key travels only when asked" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    var o = opts();
    o.include_cred_key = true;
    var report: create_mod.Report = .{};
    try create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, o, &report);
    var dir = try inst.backup();
    defer dir.close(testing.io);
    const key = try dir.readFileAlloc(testing.io, "2026-11-04T030000Z/" ++ layout.cred_key_name, testing.allocator, .limited(64));
    defer testing.allocator.free(key);
    try testing.expectEqualSlices(u8, &fixture.cred_key, key);
}

test "a run is refused when the directory is held, missing, or already has this second" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    var report: create_mod.Report = .{};

    {
        var dir = try inst.backup();
        defer dir.close(testing.io);
        var h: lock.Holder = .{};
        const held = try lock.acquire(testing.io, dir, t0, "nas", 99, &h);
        defer held.release(testing.io);
        try testing.expectError(error.Locked, create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, opts(), &report));
        try testing.expectEqual(@as(i64, 99), report.holder.pid);
    }

    try create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, opts(), &report);
    try testing.expectError(error.SnapshotExists, create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, opts(), &report));

    const missing = try std.fmt.allocPrint(testing.allocator, "{s}/not-mounted", .{inst.root});
    defer testing.allocator.free(missing);
    try testing.expectError(error.BackupDirMissing, create(testing.allocator, testing.io, inst.paths(), missing, t0, opts(), &report));
}

test "a blob the database names but the store lost fails the run and leaves no snapshot" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try inst.addBlob("kept");
    try inst.addVanishedRow("0123456789abcdef0123456789abcdef");
    var report: create_mod.Report = .{};
    try testing.expectError(error.BlobLost, create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, opts(), &report));
    try testing.expectEqualStrings("0123456789abcdef0123456789abcdef", &report.md5);

    var dir = try inst.backup();
    defer dir.close(testing.io);
    try testing.expectError(error.FileNotFound, dir.access(testing.io, "2026-11-04T030000Z", .{}));
    try testing.expectError(error.FileNotFound, dir.access(testing.io, "2026-11-04T030000Z.partial", .{}));
    try testing.expectError(error.FileNotFound, dir.access(testing.io, layout.lock_name, .{}));
}
