//! Tests for `backup verify`: a healthy backup passes, and each kind of damage
//! is found and named.

const std = @import("std");
const testing = std.testing;
const layout = @import("layout.zig");
const create_mod = @import("create.zig");
const verify_mod = @import("verify.zig");
const fixture = @import("fixture.zig");
const repeat = @import("../../util/repeat.zig").repeat;
const verify = verify_mod.verify;

const t0: i64 = 1793761200;
const snap = "2026-11-04T030000Z";

fn backedUp(inst: *fixture.Install) ![2][32]u8 {
    const a = try inst.addBlob(repeat(u8, "page of ink ", 800));
    const b = try inst.addBlob("short");
    var r: create_mod.Report = .{};
    try create_mod.create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, .{ .rate = 0, .host = "t", .pid = 1 }, &r);
    return .{ a, b };
}

fn deepOpts(inst: *fixture.Install, buf: []u8) !verify_mod.Options {
    return .{ .deep = true, .rate = 0, .tmp_dir = try std.fmt.bufPrint(buf, "{s}/state/verify-tmp", .{inst.root}) };
}

test "a healthy backup passes both the quick and the deep check" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try backedUp(&inst);
    var dir = try inst.backup();
    defer dir.close(testing.io);

    var quick = try verify(testing.allocator, testing.io, dir, null, .{ .rate = 0 });
    defer quick.deinit(testing.allocator);
    try testing.expect(quick.allOk());
    try testing.expectEqual(@as(u64, 2), quick.results.items[0].blobs);

    var buf: [256]u8 = undefined;
    var deep = try verify(testing.allocator, testing.io, dir, snap, try deepOpts(&inst, &buf));
    defer deep.deinit(testing.allocator);
    try testing.expect(deep.allOk());
    try testing.expectEqual(@as(u64, 2), deep.hashed);
}

test "a missing blob fails the snapshot that needs it, and is named" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    const md5s = try backedUp(&inst);
    var dir = try inst.backup();
    defer dir.close(testing.io);
    var pb: [layout.blob_path_max]u8 = undefined;
    dir.deleteFile(testing.io, layout.blobPath(&pb, &md5s[1], false)) catch
        try dir.deleteFile(testing.io, layout.blobPath(&pb, &md5s[1], true));

    var v = try verify(testing.allocator, testing.io, dir, null, .{ .rate = 0 });
    defer v.deinit(testing.allocator);
    try testing.expect(!v.allOk());
    try testing.expectEqual(@as(u64, 1), v.results.items[0].missing);
    try testing.expectEqualStrings(&md5s[1], &v.results.items[0].first_bad.?);
}

test "a rotted blob passes the quick check but not the deep one" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    const md5s = try backedUp(&inst);
    var dir = try inst.backup();
    defer dir.close(testing.io);
    // The compressible one is stored gzipped; rot a byte in its middle.
    var pb: [layout.blob_path_max]u8 = undefined;
    const path = layout.blobPath(&pb, &md5s[0], true);
    const gz = try dir.readFileAlloc(testing.io, path, testing.allocator, .unlimited);
    defer testing.allocator.free(gz);
    gz[gz.len / 2] ^= 0x55;
    try dir.writeFile(testing.io, .{ .sub_path = path, .data = gz });

    var quick = try verify(testing.allocator, testing.io, dir, null, .{ .rate = 0 });
    defer quick.deinit(testing.allocator);
    try testing.expect(quick.allOk());

    var buf: [256]u8 = undefined;
    var deep = try verify(testing.allocator, testing.io, dir, null, try deepOpts(&inst, &buf));
    defer deep.deinit(testing.allocator);
    try testing.expect(!deep.allOk());
    try testing.expectEqual(@as(u64, 1), deep.results.items[0].corrupt);
}

test "a damaged database or manifest fails the snapshot" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try backedUp(&inst);
    var dir = try inst.backup();
    defer dir.close(testing.io);

    const db_path = snap ++ "/" ++ layout.db_name;
    const gz = try dir.readFileAlloc(testing.io, db_path, testing.allocator, .unlimited);
    defer testing.allocator.free(gz);
    try dir.writeFile(testing.io, .{ .sub_path = db_path, .data = gz[0 .. gz.len / 2] });
    {
        var v = try verify(testing.allocator, testing.io, dir, null, .{ .rate = 0 });
        defer v.deinit(testing.allocator);
        try testing.expect(!v.results.items[0].db_ok);
    }
    try dir.writeFile(testing.io, .{ .sub_path = db_path, .data = gz });

    const m_path = snap ++ "/" ++ layout.manifest_name;
    const m = try dir.readFileAlloc(testing.io, m_path, testing.allocator, .unlimited);
    defer testing.allocator.free(m);
    try dir.writeFile(testing.io, .{ .sub_path = m_path, .data = m[0 .. m.len - 10] });
    var v = try verify(testing.allocator, testing.io, dir, null, .{ .rate = 0 });
    defer v.deinit(testing.allocator);
    try testing.expect(!v.results.items[0].manifest_ok);
    try testing.expect(v.results.items[0].db_ok);
}

test "verify names a snapshot that is not there, and an empty directory" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    var dir = try inst.backup();
    defer dir.close(testing.io);
    try testing.expectError(error.NoSnapshots, verify(testing.allocator, testing.io, dir, null, .{ .rate = 0 }));
    try testing.expectError(error.NoSuchSnapshot, verify(testing.allocator, testing.io, dir, snap, .{ .rate = 0 }));
    try testing.expectError(error.NoSuchSnapshot, verify(testing.allocator, testing.io, dir, "../etc", .{ .rate = 0 }));
}
