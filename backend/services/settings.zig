//! Install-wide settings in the `settings` key/value table. Reads never fail:
//! no row means the compiled default.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const filesmod = @import("files.zig");

/// Retention bounds, in days. A zero-day bin would be no bin.
pub const min_retention_days: i64 = 1;
pub const max_retention_days: i64 = 365;

pub const seconds_per_day: i64 = 24 * 60 * 60;

/// The `settings` key holding the bin retention window, in seconds (the API
/// speaks days; storage uses `sweepBin`'s unit so it is never converted twice).
pub const bin_retention_key = "bin_retention_s";

/// The `settings` key recording that an admin dismissed "no backup yet"
/// ("I back up another way"); 1 dismissed, absent or 0 not.
pub const backup_never_dismissed_key = "backup_never_dismissed";

pub const Retention = struct {
    seconds: i64,
    /// Epoch seconds of the write that set this window; 0 for the compiled default.
    changed_at: i64,

    pub fn days(self: Retention) i64 {
        return @divTrunc(self.seconds, seconds_per_day);
    }
};

/// The sweep cutoff, or null when nothing may be purged yet. Non-retroactive:
/// an entry's clock runs from the later of its trash time and `changed_at`, so
/// shortening the window gives every existing entry one full new window.
pub fn sweepCutoff(now: i64, retention: Retention) ?i64 {
    const cutoff = now - retention.seconds;
    if (retention.changed_at >= cutoff) return null; // the new window is not yet fully served
    return cutoff;
}

pub const Settings = struct {
    io: std.Io,
    db: sqlite.Db,

    pub const Error = error{
        InvalidRetention,
    } || sqlite.Error;

    pub fn init(io: std.Io, db: sqlite.Db) Settings {
        return .{ .io = io, .db = db };
    }

    fn now(self: Settings) i64 {
        return std.Io.Clock.real.now(self.io).toSeconds();
    }

    pub fn binRetention(self: Settings) Error!Retention {
        // `changed_at = 0`: the default has always been in force, so nothing is gated.
        var r = (try self.db.row("SELECT value, updated_at FROM settings WHERE key = ?1;", &.{.{ .text = bin_retention_key }})) orelse
            return .{ .seconds = filesmod.Files.bin_retention_s, .changed_at = 0 };
        defer r.finalize();
        return .{ .seconds = r.int(0), .changed_at = r.int(1) };
    }

    /// Set the bin retention window, in days. Returns the stored result.
    pub fn setBinRetentionDays(self: Settings, days: i64) Error!Retention {
        if (days < min_retention_days or days > max_retention_days) return error.InvalidRetention;
        const seconds = days * seconds_per_day;
        const t = self.now();
        try self.db.run(
            "INSERT INTO settings(key, value, updated_at) VALUES(?1, ?2, ?3) " ++
                "ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3;",
            &.{ .{ .text = bin_retention_key }, .{ .int = seconds }, .{ .int = t } },
        );
        return .{ .seconds = seconds, .changed_at = t };
    }

    /// Whether an admin said they back up another way, silencing "no backup
    /// yet". A failing `inkhold backup` still shows (`backup/status.zig`).
    pub fn backupNeverDismissed(self: Settings) Error!bool {
        var r = (try self.db.row("SELECT value FROM settings WHERE key = ?1;", &.{.{ .text = backup_never_dismissed_key }})) orelse return false;
        defer r.finalize();
        return r.int(0) != 0;
    }

    pub fn setBackupNeverDismissed(self: Settings, dismissed: bool) Error!void {
        try self.db.run(
            "INSERT INTO settings(key, value, updated_at) VALUES(?1, ?2, ?3) " ++
                "ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3;",
            &.{ .{ .text = backup_never_dismissed_key }, .{ .int = @intFromBool(dismissed) }, .{ .int = self.now() } },
        );
    }
};

// ---- tests ----

const schema = @import("../db/schema.zig");
const testing = std.testing;

fn testSettings(db: sqlite.Db) !Settings {
    try schema.migrate(db);
    return Settings.init(testing.io, db);
}

test "retention: an unconfigured install reads the compiled default, and a write round-trips" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    const set = try testSettings(db);

    const initial = try set.binRetention();
    try testing.expectEqual(filesmod.Files.bin_retention_s, initial.seconds);
    try testing.expectEqual(@as(i64, 0), initial.changed_at);
    try testing.expectEqual(@as(i64, 30), initial.days());

    const written = try set.setBinRetentionDays(7);
    try testing.expectEqual(@as(i64, 7 * seconds_per_day), written.seconds);
    try testing.expect(written.changed_at > 0);

    const reread = try set.binRetention();
    try testing.expectEqual(written.seconds, reread.seconds);
    try testing.expectEqual(written.changed_at, reread.changed_at);
    _ = try set.setBinRetentionDays(14);
    try testing.expectEqual(@as(i64, 14), (try set.binRetention()).days());

    var s = try db.prepare("SELECT COUNT(*) FROM settings;");
    defer s.finalize();
    _ = try s.step();
    try testing.expectEqual(@as(i64, 1), s.columnInt(0));
}

test "retention: out-of-range windows are refused and change nothing" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    const set = try testSettings(db);
    _ = try set.setBinRetentionDays(10);

    try testing.expectError(error.InvalidRetention, set.setBinRetentionDays(0));
    try testing.expectError(error.InvalidRetention, set.setBinRetentionDays(-5));
    try testing.expectError(error.InvalidRetention, set.setBinRetentionDays(max_retention_days + 1));

    // A rejected write leaves the previous window untouched.
    try testing.expectEqual(@as(i64, 10), (try set.binRetention()).days());

    try testing.expectEqual(min_retention_days, (try set.setBinRetentionDays(min_retention_days)).days());
    try testing.expectEqual(max_retention_days, (try set.setBinRetentionDays(max_retention_days)).days());
}

test "sweepCutoff: shortening the window never purges retroactively" {
    const day = seconds_per_day;
    const t: i64 = 1_000 * day; // an arbitrary "now", far from the epoch

    const default_window: Retention = .{ .seconds = 30 * day, .changed_at = 0 };
    try testing.expectEqual(@as(?i64, t - 30 * day), sweepCutoff(t, default_window));

    // Cut to 7 days while the bin holds 20-day-old entries: nothing is swept yet.
    const just_shortened: Retention = .{ .seconds = 7 * day, .changed_at = t };
    try testing.expectEqual(@as(?i64, null), sweepCutoff(t, just_shortened));

    try testing.expectEqual(@as(?i64, null), sweepCutoff(t + 6 * day, just_shortened));

    const after = sweepCutoff(t + 7 * day + 1, just_shortened);
    try testing.expect(after != null);
    try testing.expect(after.? > t - 20 * day); // a 20-day-old entry is now due

    const just_lengthened: Retention = .{ .seconds = 60 * day, .changed_at = t };
    try testing.expectEqual(@as(?i64, null), sweepCutoff(t, just_lengthened));
}

test "the 'no backup yet' dismissal reads false until set, and can be taken back" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    const set = try testSettings(db);
    try testing.expect(!try set.backupNeverDismissed());
    try set.setBackupNeverDismissed(true);
    try testing.expect(try set.backupNeverDismissed());
    try set.setBackupNeverDismissed(false);
    try testing.expect(!try set.backupNeverDismissed());
}
