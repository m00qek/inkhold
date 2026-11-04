//! Tests for the backup verbs: the grammar, and the whole chain end to end
//! through `execute` (create, list, verify, prune, restore), with the
//! messages a person reads when something is refused.

const std = @import("std");
const testing = std.testing;
const cli = @import("../cli.zig");
const parse = cli.parse;
const Command = cli.Command;
const exit_ok = cli.exit_ok;
const exit_failed = cli.exit_failed;
const fixture = @import("fixture.zig");
const bfix = @import("../services/backup/fixture.zig");
const repeat = @import("../util/repeat.zig").repeat;

test "backup verbs take a directory, and only the options that mean something to them" {
    {
        const inv = try parse(&.{ "backup", "create", "/mnt/nas/ink", "--keep=7", "--include-cred-key", "--max-rate", "512K" });
        try testing.expectEqual(Command.backup_create, inv.command);
        try testing.expectEqualStrings("/mnt/nas/ink", inv.backup_dir);
        try testing.expectEqual(@as(?u32, 7), inv.flags.keep);
        try testing.expect(inv.flags.include_cred_key);
        try testing.expectEqual(@as(?u64, 512 * 1024), inv.flags.max_rate);
    }
    {
        const inv = try parse(&.{ "backup", "verify", "/b", "2026-11-04T030000Z", "--deep" });
        try testing.expectEqual(Command.backup_verify, inv.command);
        try testing.expectEqualStrings("2026-11-04T030000Z", inv.snapshot.?);
        try testing.expect(inv.flags.deep);
    }
    {
        const inv = try parse(&.{ "restore", "/b" });
        try testing.expectEqual(Command.restore, inv.command);
        try testing.expect(inv.snapshot == null);
    }
    try testing.expectEqual(Command.backup_list, (try parse(&.{ "backup", "list", "/b" })).command);
    try testing.expectEqual(Command.backup_prune, (try parse(&.{ "backup", "prune", "/b", "--keep", "3" })).command);

    try testing.expectError(error.MissingBackupDir, parse(&.{ "backup", "create" }));
    try testing.expectError(error.MissingBackupDir, parse(&.{"restore"}));
    try testing.expectError(error.MissingKeep, parse(&.{ "backup", "prune", "/b" }));
    try testing.expectError(error.MissingOrUnknownSubcommand, parse(&.{ "backup", "now", "/b" }));
    try testing.expectError(error.MissingOrUnknownSubcommand, parse(&.{"backup"}));
    try testing.expectError(error.UnexpectedArgument, parse(&.{ "backup", "create", "/b", "extra" }));
    try testing.expectError(error.OptionNotForCommand, parse(&.{ "backup", "verify", "/b", "--keep=3" }));
    try testing.expectError(error.OptionNotForCommand, parse(&.{ "backup", "list", "/b", "--deep" }));
    try testing.expectError(error.OptionNotForCommand, parse(&.{ "restore", "/b", "--include-cred-key" }));
    try testing.expectError(error.OptionNotForCommand, parse(&.{ "serve", "--deep" }));
    try testing.expectError(error.OptionNotForCommand, parse(&.{ "users", "list", "--keep=2" }));
    try testing.expectError(error.BadOptionValue, parse(&.{ "backup", "create", "/b", "--keep=0" }));
    try testing.expectError(error.BadOptionValue, parse(&.{ "backup", "create", "/b", "--keep=lots" }));
    try testing.expectError(error.BadOptionValue, parse(&.{ "backup", "create", "/b", "--max-rate=fast" }));
    try testing.expectError(error.BadOptionValue, parse(&.{ "backup", "create", "/b", "--keep" }));
}

test "a rate reads the way people write it" {
    try testing.expectEqual(@as(?u64, 4 << 20), cli.parseRate("4M"));
    try testing.expectEqual(@as(?u64, 4 << 20), cli.parseRate("4MB/s"));
    try testing.expectEqual(@as(?u64, 512 << 10), cli.parseRate("512k"));
    try testing.expectEqual(@as(?u64, 1 << 30), cli.parseRate("1G"));
    try testing.expectEqual(@as(?u64, 0), cli.parseRate("0"));
    try testing.expectEqual(@as(?u64, 1000), cli.parseRate("1000"));
    try testing.expectEqual(@as(?u64, null), cli.parseRate("M"));
    try testing.expectEqual(@as(?u64, null), cli.parseRate("-1"));
}

/// A live install with a config file beside it. Port 1: nothing listens there,
/// so `restore` never mistakes a developer's running server for this one's.
const config_body =
    \\.{ .db_path = "state/inkhold.db", .cred_key_path = "state/cred.key", .data_dir = "state/data", .port = 1 }
;

fn configPath(tmp: testing.TmpDir, root: []const u8, buf: []u8) ![]const u8 {
    try tmp.dir.writeFile(testing.io, .{ .sub_path = "inkhold.zon", .data = config_body });
    return std.fmt.bufPrint(buf, "{s}/inkhold.zon", .{root});
}

fn run(argv: []const []const u8) !fixture.Captured {
    return fixture.capture(testing.allocator, try parse(argv));
}

test "create, list, verify, prune and restore, end to end through the command line" {
    var inst = try bfix.Install.init();
    defer inst.deinit();
    _ = try inst.addUser("ana@home.lan", "pw");
    _ = try inst.addBlob(repeat(u8, "ink ", 2000));
    var cbuf: [256]u8 = undefined;
    const cfg = try configPath(inst.tmp, inst.root, &cbuf);

    {
        const c = try run(&.{ "--config", cfg, "backup", "create", inst.backup_dir, "--max-rate=0" });
        defer c.deinit(testing.allocator);
        try testing.expectEqual(exit_ok, c.code);
        try testing.expect(std.mem.indexOf(u8, c.out, "1 file (") != null);
        try testing.expect(std.mem.indexOf(u8, c.out, "1 new") != null);
        // A temp directory shares the disk with the "live" data: warned, not refused.
        try testing.expect(std.mem.indexOf(u8, c.err, "same disk") != null);
    }
    {
        const c = try run(&.{ "backup", "list", inst.backup_dir });
        defer c.deinit(testing.allocator);
        try testing.expectEqual(exit_ok, c.code);
        try testing.expect(std.mem.indexOf(u8, c.out, "Shared file store: 1 file") != null);
    }
    {
        const c = try run(&.{ "--config", cfg, "backup", "verify", inst.backup_dir, "--deep", "--max-rate=0" });
        defer c.deinit(testing.allocator);
        try testing.expectEqual(exit_ok, c.code);
        try testing.expect(std.mem.indexOf(u8, c.out, "  ok  ") != null);
        try testing.expect(std.mem.indexOf(u8, c.out, "Re-read 1 file") != null);
    }
    {
        const c = try run(&.{ "backup", "prune", inst.backup_dir, "--keep=1" });
        defer c.deinit(testing.allocator);
        try testing.expectEqual(exit_ok, c.code);
        try testing.expect(std.mem.indexOf(u8, c.out, "Removed 0 snapshots") != null);
    }

    var target = try bfix.Target.init();
    defer target.deinit();
    var tbuf: [256]u8 = undefined;
    const tcfg = try configPath(target.tmp, target.root, &tbuf);
    {
        const c = try run(&.{ "--config", tcfg, "restore", inst.backup_dir });
        defer c.deinit(testing.allocator);
        try testing.expectEqual(exit_ok, c.code);
        try testing.expect(std.mem.indexOf(u8, c.out, "Restored 20") != null);
        // No key in the backup: the account's temporary password is shown, once.
        try testing.expect(std.mem.indexOf(u8, c.out, "ana@home.lan") != null);
        try testing.expect(std.mem.indexOf(u8, c.out, "Every tablet was signed out") != null);
    }
    {
        // And a second restore onto it is refused: it never writes over a database.
        const c = try run(&.{ "--config", tcfg, "restore", inst.backup_dir });
        defer c.deinit(testing.allocator);
        try testing.expectEqual(exit_failed, c.code);
        try testing.expect(std.mem.indexOf(u8, c.err, "already exists") != null);
    }
}

test "a missing backup directory is named, and nothing is created in its place" {
    var inst = try bfix.Install.init();
    defer inst.deinit();
    var cbuf: [256]u8 = undefined;
    const cfg = try configPath(inst.tmp, inst.root, &cbuf);
    var dbuf: [256]u8 = undefined;
    const missing = try std.fmt.bufPrint(&dbuf, "{s}/nas-not-mounted", .{inst.root});

    for ([_][]const []const u8{
        &.{ "--config", cfg, "backup", "create", missing },
        &.{ "backup", "list", missing },
        &.{ "--config", cfg, "restore", missing },
    }) |argv| {
        const c = try run(argv);
        defer c.deinit(testing.allocator);
        try testing.expectEqual(exit_failed, c.code);
        try testing.expect(std.mem.indexOf(u8, c.err, "is it mounted?") != null);
    }
    try testing.expectError(error.FileNotFound, inst.tmp.dir.access(testing.io, "nas-not-mounted", .{}));
}

test "a backup inside the live data is refused" {
    var inst = try bfix.Install.init();
    defer inst.deinit();
    var cbuf: [256]u8 = undefined;
    const cfg = try configPath(inst.tmp, inst.root, &cbuf);
    try inst.tmp.dir.createDirPath(testing.io, "state/data/backups");
    var dbuf: [256]u8 = undefined;
    const inside = try std.fmt.bufPrint(&dbuf, "{s}/state/data/backups", .{inst.root});
    const c = try run(&.{ "--config", cfg, "backup", "create", inside });
    defer c.deinit(testing.allocator);
    try testing.expectEqual(exit_failed, c.code);
    try testing.expect(std.mem.indexOf(u8, c.err, "inside the live data") != null);
}

test "every run is recorded for the admin notice, the failures most of all" {
    var inst = try bfix.Install.init();
    defer inst.deinit();
    _ = try inst.addBlob("x");
    var cbuf: [256]u8 = undefined;
    const cfg = try configPath(inst.tmp, inst.root, &cbuf);
    var dbuf: [256]u8 = undefined;
    const missing = try std.fmt.bufPrint(&dbuf, "{s}/nas-not-mounted", .{inst.root});

    for ([_][]const []const u8{
        &.{ "--config", cfg, "backup", "create", inst.backup_dir, "--max-rate=0" },
        &.{ "--config", cfg, "backup", "verify", inst.backup_dir, "--max-rate=0" },
        &.{ "--config", cfg, "backup", "create", missing },
    }) |argv| {
        const c = try run(argv);
        c.deinit(testing.allocator);
    }

    {
        var r = (try inst.db.row("SELECT last_ok_at IS NOT NULL, last_error IS NULL, snapshot, verified_at IS NOT NULL, verify_error IS NULL FROM backup_runs WHERE dir LIKE '%/backup';", &.{})).?;
        defer r.finalize();
        try testing.expectEqual(@as(i64, 1), r.int(0));
        try testing.expectEqual(@as(i64, 1), r.int(1));
        try testing.expectEqual(@as(usize, 18), r.text(2).len);
        try testing.expectEqual(@as(i64, 1), r.int(3));
        try testing.expectEqual(@as(i64, 1), r.int(4));
    }
    {
        // The unmounted share: recorded by the path as typed, with the first line a person read.
        var r = (try inst.db.row("SELECT last_ok_at IS NULL, last_error FROM backup_runs WHERE dir LIKE '%/nas-not-mounted';", &.{})).?;
        defer r.finalize();
        try testing.expectEqual(@as(i64, 1), r.int(0));
        try testing.expect(std.mem.startsWith(u8, r.text(1), "No backup directory at:"));
        try testing.expect(std.mem.indexOfScalar(u8, r.text(1), '\x1b') == null); // no styling stored
    }
}
