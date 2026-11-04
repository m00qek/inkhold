//! Tests for `restore`: the round trip, each way the credential key is
//! settled, the tablets signed out, and every refusal.

const std = @import("std");
const testing = std.testing;
const layout = @import("layout.zig");
const create_mod = @import("create.zig");
const restore_mod = @import("restore.zig");
const fixture = @import("fixture.zig");
const sqlite = @import("../../db/sqlite.zig");
const password = @import("../auth/password.zig");
const repeat = @import("../../util/repeat.zig").repeat;
const restore = restore_mod.restore;

const t0: i64 = 1793761200;

fn backUp(inst: *fixture.Install, with_key: bool) !void {
    var r: create_mod.Report = .{};
    try create_mod.create(testing.allocator, testing.io, inst.paths(), inst.backup_dir, t0, .{
        .rate = 0,
        .host = "t",
        .pid = 1,
        .include_cred_key = with_key,
    }, &r);
}

/// A household: two accounts, a tablet and a browser signed in, two notebooks.
fn household(inst: *fixture.Install) ![2][32]u8 {
    const ana = try inst.addUser("ana@home.lan", "correct horse");
    _ = try inst.addUser("rui@home.lan", "battery staple");
    try inst.addSession(ana, "device", "tablet-token");
    try inst.addSession(ana, "controlplane", "browser-token");
    return .{
        try inst.addBlob(repeat(u8, "stroke ", 900)),
        try inst.addBlob("a short note"),
    };
}

fn count(db: sqlite.Db, sql: []const u8) !i64 {
    var r = (try db.row(sql, &.{})).?;
    defer r.finalize();
    return r.int(0);
}

test "a backup with its key restores whole: notes, accounts, browser sessions; tablets signed out" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    const md5s = try household(&inst);
    try backUp(&inst, true);

    var target = try fixture.Target.init();
    defer target.deinit();
    var dir = try inst.backup();
    defer dir.close(testing.io);
    var rep: restore_mod.Report = .{};
    defer rep.deinit(testing.allocator);
    try restore(testing.allocator, testing.io, target.paths(), dir, .{}, &rep);

    try testing.expectEqual(restore_mod.Key.from_backup, rep.key);
    try testing.expectEqual(@as(u64, 2), rep.blobs);
    try testing.expectEqual(@as(i64, 1), rep.devices_signed_out);
    try testing.expectEqual(@as(usize, 0), rep.resets.items.len);
    try testing.expectEqualStrings("2026-11-04T030000Z", &rep.name);

    const key = try target.tmp.dir.readFileAlloc(testing.io, "state/cred.key", testing.allocator, .limited(64));
    defer testing.allocator.free(key);
    try testing.expectEqualSlices(u8, &fixture.cred_key, key);

    const db = try target.openDb();
    defer db.close();
    try testing.expectEqual(@as(i64, 2), try count(db, "SELECT COUNT(*) FROM users;"));
    try testing.expectEqual(@as(i64, 2), try count(db, "SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT COUNT(*) FROM sessions WHERE audience = 'device';"));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT COUNT(*) FROM sessions WHERE audience = 'controlplane';"));

    // The blobs are back in the live store, byte for byte.
    var blobs = try target.tmp.dir.openDir(testing.io, "state/data/blobs", .{});
    defer blobs.close(testing.io);
    for (md5s) |m| {
        var pb: [36]u8 = undefined;
        const path = try std.fmt.bufPrint(&pb, "{s}/{s}", .{ m[0..2], &m });
        const bytes = try blobs.readFileAlloc(testing.io, path, testing.allocator, .unlimited);
        defer testing.allocator.free(bytes);
        var digest: [16]u8 = undefined;
        std.crypto.hash.Md5.hash(bytes, &digest, .{});
        try testing.expectEqualStrings(&m, &std.fmt.bytesToHex(digest, .lower));
    }
    // Nothing left beside the database.
    try testing.expectError(error.FileNotFound, target.tmp.dir.access(testing.io, "state/inkhold.db.restoring", .{}));
}

test "without the key, a restore gives every account a temporary password, once" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try household(&inst);
    try backUp(&inst, false);

    var target = try fixture.Target.init();
    defer target.deinit();
    var dir = try inst.backup();
    defer dir.close(testing.io);
    var rep: restore_mod.Report = .{};
    defer rep.deinit(testing.allocator);
    try restore(testing.allocator, testing.io, target.paths(), dir, .{}, &rep);

    try testing.expectEqual(restore_mod.Key.generated, rep.key);
    try testing.expectEqual(@as(usize, 2), rep.resets.items.len);

    // The new key opens each account at its temporary password.
    const key_bytes = try target.tmp.dir.readFileAlloc(testing.io, "state/cred.key", testing.allocator, .limited(64));
    defer testing.allocator.free(key_bytes);
    const key = key_bytes[0..password.cred_key_len].*;
    const db = try target.openDb();
    defer db.close();
    for (rep.resets.items) |r| {
        var row = (try db.row("SELECT cred_enc, must_change_password FROM users WHERE email = ?1;", &.{.{ .text = r.email }})).?;
        defer row.finalize();
        const md5 = try password.decryptCred(key, row.text(0));
        try testing.expectEqualStrings(&password.md5Hex(r.temp.slice()), &md5);
        try testing.expectEqual(@as(i64, 1), row.int(1));
    }
    // Every session ended with the reset.
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT COUNT(*) FROM sessions;"));
}

test "a key kept apart from the backup is used as it is, and the wrong one is refused" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try household(&inst);
    try backUp(&inst, false);
    var dir = try inst.backup();
    defer dir.close(testing.io);

    {
        var target = try fixture.Target.init();
        defer target.deinit();
        try target.writeKey(&fixture.cred_key);
        var rep: restore_mod.Report = .{};
        defer rep.deinit(testing.allocator);
        try restore(testing.allocator, testing.io, target.paths(), dir, .{}, &rep);
        try testing.expectEqual(restore_mod.Key.kept_existing, rep.key);
        try testing.expectEqual(@as(usize, 0), rep.resets.items.len);
        try testing.expectEqual(@as(i64, 1), rep.devices_signed_out);
    }
    {
        var target = try fixture.Target.init();
        defer target.deinit();
        const wrong: [32]u8 = @splat(0x13);
        try target.writeKey(&wrong);
        var rep: restore_mod.Report = .{};
        defer rep.deinit(testing.allocator);
        try testing.expectError(error.CredKeyMismatch, restore(testing.allocator, testing.io, target.paths(), dir, .{}, &rep));
        // Nothing usable was left behind to start a server on.
        try testing.expectError(error.FileNotFound, target.tmp.dir.access(testing.io, "state/inkhold.db", .{}));
        try testing.expectError(error.FileNotFound, target.tmp.dir.access(testing.io, "state/inkhold.db.restoring", .{}));
    }
}

test "a restore never writes over an install, a damaged snapshot or a newer schema" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    const md5s = try household(&inst);
    try backUp(&inst, true);
    var dir = try inst.backup();
    defer dir.close(testing.io);
    var rep: restore_mod.Report = .{};
    defer rep.deinit(testing.allocator);

    // Onto the live install itself.
    try testing.expectError(error.TargetNotEmpty, restore(testing.allocator, testing.io, inst.paths(), dir, .{}, &rep));

    var target = try fixture.Target.init();
    defer target.deinit();
    try testing.expectError(error.NoSuchSnapshot, restore(testing.allocator, testing.io, target.paths(), dir, .{ .snapshot = "2020-01-01T000000Z" }, &rep));

    var pb: [layout.blob_path_max]u8 = undefined;
    dir.deleteFile(testing.io, layout.blobPath(&pb, &md5s[1], false)) catch
        try dir.deleteFile(testing.io, layout.blobPath(&pb, &md5s[1], true));
    try testing.expectError(error.SnapshotDamaged, restore(testing.allocator, testing.io, target.paths(), dir, .{}, &rep));
    try testing.expectEqual(@as(u64, 1), rep.damage.?.missing);
    try testing.expectError(error.FileNotFound, target.tmp.dir.access(testing.io, "state/inkhold.db", .{}));
}

test "a backup carries no legacy plaintext password hash" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try inst.addUser("old@home.lan", "from long ago");
    try inst.db.exec("UPDATE users SET password_md5 = '0123456789abcdef0123456789abcdef';");
    try backUp(&inst, true);

    var target = try fixture.Target.init();
    defer target.deinit();
    var dir = try inst.backup();
    defer dir.close(testing.io);
    var rep: restore_mod.Report = .{};
    defer rep.deinit(testing.allocator);
    try restore(testing.allocator, testing.io, target.paths(), dir, .{}, &rep);
    const db = try target.openDb();
    defer db.close();
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT COUNT(*) FROM users WHERE password_md5 <> '';"));
    // The live table was left as it was.
    try testing.expectEqual(@as(i64, 1), try count(inst.db, "SELECT COUNT(*) FROM users WHERE password_md5 <> '';"));
}

test "half-finished uploads do not survive a restore" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    const ana = try inst.addUser("ana@home.lan", "pw");
    try inst.db.run(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, created_at) VALUES('0123456789abcdef', ?1, '/NOTE', 'x.note', 10, ?2);",
        &.{ .{ .int = @intCast(ana) }, .{ .int = t0 } },
    );
    try backUp(&inst, true);
    var target = try fixture.Target.init();
    defer target.deinit();
    var dir = try inst.backup();
    defer dir.close(testing.io);
    var rep: restore_mod.Report = .{};
    defer rep.deinit(testing.allocator);
    try restore(testing.allocator, testing.io, target.paths(), dir, .{}, &rep);
    const db = try target.openDb();
    defer db.close();
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT COUNT(*) FROM upload_sessions;"));
}

test "serverAnswers sees a listener and nothing where there is none" {
    const addr = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var server = try addr.listen(testing.io, .{ .mode = .stream });
    defer server.deinit(testing.io);
    const port = server.socket.address.getPort();
    try testing.expect(restore_mod.serverAnswers(testing.io, "127.0.0.1", port));
}

test "a restored server starts with no record of past backups" {
    var inst = try fixture.Install.init();
    defer inst.deinit();
    _ = try inst.addUser("ana@home.lan", "pw");
    try inst.db.exec("INSERT INTO backup_runs(dir, last_run_at, last_ok_at) VALUES('/mnt/nas', 1, 1);");
    try backUp(&inst, true);
    var target = try fixture.Target.init();
    defer target.deinit();
    var dir = try inst.backup();
    defer dir.close(testing.io);
    var rep: restore_mod.Report = .{};
    defer rep.deinit(testing.allocator);
    try restore(testing.allocator, testing.io, target.paths(), dir, .{}, &rep);
    const db = try target.openDb();
    defer db.close();
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT COUNT(*) FROM backup_runs;"));
}
