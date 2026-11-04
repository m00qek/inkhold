//! Tests for `backup prune`: what it removes, what it never removes, and that
//! it refuses to sweep on a manifest it cannot trust.

const std = @import("std");
const testing = std.testing;
const layout = @import("layout.zig");
const lock = @import("lock.zig");
const create_mod = @import("create.zig");
const prune_mod = @import("prune.zig");
const verify_mod = @import("verify.zig");
const blob_copy = @import("blob_copy.zig");
const fixture = @import("fixture.zig");
const prune = prune_mod.prune;

const day: i64 = 86400;
const t0: i64 = 1793761200;

fn run(inst: *fixture.Install, at: i64, keep: ?u32) !create_mod.Report {
    var r: create_mod.Report = .{};
    try create_mod.create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, at, .{ .rate = 0, .host = "t", .pid = 1, .keep = keep }, &r);
    return r;
}

fn deleteRow(inst: *fixture.Install, md5: []const u8) !void {
    try inst.db.run("DELETE FROM blobs WHERE md5 = ?1;", &.{.{ .text = md5 }});
}

test "prune keeps the newest snapshots and every blob they name, and nothing else" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    const old = try inst.addBlob("only in the first snapshot");
    const always = try inst.addBlob("in every snapshot");
    _ = try run(&inst, t0, null);
    try deleteRow(&inst, &old); // the user emptied the bin
    _ = try run(&inst, t0 + day, null);
    const late = try inst.addBlob("added on day three");
    _ = try run(&inst, t0 + 2 * day, null);

    var dir = try inst.backup();
    defer dir.close(testing.io);
    var rep: prune_mod.Report = .{};
    try prune(testing.allocator, testing.io, dir, 2, t0 + 3 * day, "t", 1, &rep);
    try testing.expectEqual(@as(u32, 1), rep.removed_snapshots);
    try testing.expectEqual(@as(u64, 1), rep.removed_blobs);
    try testing.expect(rep.freed_bytes > 0);

    try testing.expect(!blob_copy.has(testing.io, dir, &old));
    try testing.expect(blob_copy.has(testing.io, dir, &always));
    try testing.expect(blob_copy.has(testing.io, dir, &late));
    try testing.expectError(error.FileNotFound, dir.access(testing.io, "2026-11-04T030000Z", .{}));

    var v = try verify_mod.verify(testing.allocator, testing.io, dir, null, .{ .rate = 0 });
    defer v.deinit(testing.allocator);
    try testing.expect(v.allOk());
    try testing.expectEqual(@as(usize, 2), v.results.items.len);
}

test "create --keep prunes as part of the run" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try inst.addBlob("x");
    _ = try run(&inst, t0, 1);
    const r = try run(&inst, t0 + day, 1);
    try testing.expectEqual(@as(u32, 1), r.pruned.removed_snapshots);
    var dir = try inst.backup();
    defer dir.close(testing.io);
    try testing.expectError(error.FileNotFound, dir.access(testing.io, "2026-11-04T030000Z", .{}));
    try dir.access(testing.io, "2026-11-05T030000Z", .{});
}

test "prune sweeps what interrupted runs left, and leaves strangers' files alone" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    const md5 = try inst.addBlob("kept");
    _ = try run(&inst, t0, null);
    var dir = try inst.backup();
    defer dir.close(testing.io);
    try dir.createDirPath(testing.io, "2026-11-05T030000Z.partial");
    var tb: [layout.blob_path_max + 4]u8 = undefined;
    try dir.writeFile(testing.io, .{ .sub_path = blob_copy.tempPath(&tb, &md5), .data = "half" });
    var fb: [layout.blobs_dir.len + 3]u8 = undefined;
    var nbuf: [64]u8 = undefined;
    const stranger = try std.fmt.bufPrint(&nbuf, "{s}/desktop.ini", .{layout.blobFanout(&fb, &md5)});
    try dir.writeFile(testing.io, .{ .sub_path = stranger, .data = "windows was here" });
    try dir.createDirPath(testing.io, "2026-11-06T030000Z"); // no manifest

    var rep: prune_mod.Report = .{};
    try prune(testing.allocator, testing.io, dir, 5, t0 + 7 * day, "t", 1, &rep);
    try testing.expectEqual(@as(u32, 1), rep.removed_partials);
    try testing.expectEqual(@as(u64, 1), rep.removed_temps);
    try testing.expectEqual(@as(u64, 0), rep.removed_blobs);
    try testing.expectEqual(@as(u32, 1), rep.incomplete);
    try dir.access(testing.io, stranger, .{});
    try dir.access(testing.io, "2026-11-06T030000Z", .{});
    try testing.expect(blob_copy.has(testing.io, dir, &md5));
}

test "a manifest that cannot be read to its end stops the sweep before anything is deleted" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    const a = try inst.addBlob("a");
    const b = try inst.addBlob("b");
    _ = try run(&inst, t0, null);
    var dir = try inst.backup();
    defer dir.close(testing.io);
    const path = "2026-11-04T030000Z/" ++ layout.manifest_name;
    const m = try dir.readFileAlloc(testing.io, path, testing.allocator, .unlimited);
    defer testing.allocator.free(m);
    try dir.writeFile(testing.io, .{ .sub_path = path, .data = m[0 .. m.len - 33] }); // drop the last md5

    var rep: prune_mod.Report = .{};
    try testing.expectError(error.BadManifest, prune(testing.allocator, testing.io, dir, 1, t0 + day, "t", 1, &rep));
    try testing.expectEqualStrings("2026-11-04T030000Z", &rep.bad.?);
    try testing.expect(blob_copy.has(testing.io, dir, &a));
    try testing.expect(blob_copy.has(testing.io, dir, &b));
}

test "prune never keeps zero, and waits for a running create" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    var dir = try inst.backup();
    defer dir.close(testing.io);
    var rep: prune_mod.Report = .{};
    try testing.expectError(error.KeepZero, prune(testing.allocator, testing.io, dir, 0, t0, "t", 1, &rep));

    var h: lock.Holder = .{};
    const held = try lock.acquire(testing.io, dir, t0, "pi", 77, &h);
    defer held.release(testing.io);
    try testing.expectError(error.Locked, prune(testing.allocator, testing.io, dir, 3, t0, "t", 1, &rep));
    try testing.expectEqual(@as(i64, 77), rep.holder.pid);
}
