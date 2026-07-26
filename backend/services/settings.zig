//! Server-wide settings: the handful of knobs that belong to the INSTALL rather
//! than to a person, persisted in the `settings` key/value table.
//!
//! There is exactly one today — the recycle bin's retention window — and the
//! table exists because the admin console shows that window next to a **Change**
//! button. A displayed constant with an edit control beside it is a lie, so
//! either the control goes or the constant becomes config; this is the second.
//!
//! **Reads fall back to the compiled default, they never fail.** A fresh install
//! has no rows at all, and the retention sweep runs at startup before anything
//! could have written one. So "no row" is the normal state and means "the
//! default", not an error — which is also what keeps the table optional enough to
//! stay this small.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const filesmod = @import("files.zig");

/// Retention bounds, in days. The floor is a day rather than zero because a bin
/// that empties instantly is not a bin — deleting straight through to a purge is
/// the behaviour the recycle bin was built to remove. The ceiling is a year
/// because beyond it "retention" stops meaning anything a household would check.
pub const min_retention_days: i64 = 1;
pub const max_retention_days: i64 = 365;

pub const seconds_per_day: i64 = 24 * 60 * 60;

/// The `settings` key holding the bin retention window, in SECONDS.
///
/// Seconds, not days, even though the API speaks days: `sweepBin` works in
/// seconds, and a stored unit that needs converting on every read is a unit that
/// will eventually be converted twice somewhere. The API layer is where days
/// belong, because days are what a person types.
pub const bin_retention_key = "bin_retention_s";

/// The current bin retention window plus **when it was last changed** — which is
/// as load-bearing as the window itself. See `sweepCutoff`.
pub const Retention = struct {
    seconds: i64,
    /// Epoch seconds of the write that set this window; 0 when it has never been
    /// set and the compiled default is in force.
    changed_at: i64,

    pub fn days(self: Retention) i64 {
        return @divTrunc(self.seconds, seconds_per_day);
    }
};

/// The sweep cutoff to use, or **null when nothing may be purged yet**.
///
/// ## The non-retroactive rule, and what it costs
///
/// Shortening the window must not destroy anything. Applied naively — cutoff =
/// `now - retention` — dropping 30 days to 7 would make every entry trashed 8+
/// days ago instantly eligible, so the next sweep purges a month of other
/// people's notes as a side effect of an admin editing a number. Nothing warned
/// them, and the bin is the last copy.
///
/// So the retention clock for an entry runs from the LATER of "when it was
/// trashed" and "when the window last changed": an entry is destroyed only once
/// it has sat in the bin for the full window AND the window has been in force for
/// the full window. Because `changed_at` is one scalar shared by every entry,
/// that whole rule collapses into this single comparison.
///
/// **What this means for an entry already past the new, shorter window:** it is
/// not purged now, and it is not exempt either — it gets one more full window
/// from the moment of the change. Shortening 30 days to 7 therefore gives every
/// existing bin entry exactly 7 more days, and the console's countdown is honest
/// for all of them. The alternatives were both worse: purging immediately is the
/// data loss above, and grandfathering each entry at its own original window
/// means storing a per-row window and explaining to the user why two rows deleted
/// the same afternoon expire on different days.
///
/// LENGTHENING is covered by the same expression and is trivially safe — it can
/// only ever delay a purge, never bring one forward.
pub fn sweepCutoff(now: i64, retention: Retention) ?i64 {
    const cutoff = now - retention.seconds;
    if (retention.changed_at >= cutoff) return null; // the new window is not yet fully served
    return cutoff;
}

pub const Settings = struct {
    io: std.Io,
    db: sqlite.Db,

    pub const Error = error{
        /// A retention window outside `min_retention_days`..`max_retention_days`.
        InvalidRetention,
    } || sqlite.Error;

    pub fn init(io: std.Io, db: sqlite.Db) Settings {
        return .{ .io = io, .db = db };
    }

    fn now(self: Settings) i64 {
        return std.Io.Clock.real.now(self.io).toSeconds();
    }

    /// The configured bin retention window, or the compiled default when nothing
    /// has ever set one.
    pub fn binRetention(self: Settings) Error!Retention {
        var s = try self.db.prepare("SELECT value, updated_at FROM settings WHERE key = ?1;");
        defer s.finalize();
        s.bindText(1, bin_retention_key);
        // `changed_at = 0` for the default: the epoch is unconditionally older than
        // any cutoff, so `sweepCutoff` never gates an install that has not been
        // configured — the default window has, in effect, always been in force.
        if (!try s.step()) return .{ .seconds = filesmod.Files.bin_retention_s, .changed_at = 0 };
        return .{ .seconds = s.columnInt(0), .changed_at = s.columnInt(1) };
    }

    /// Set the bin retention window, in DAYS (the unit the console edits).
    /// Returns the stored result, so a caller never has to re-read to learn what
    /// it now is — including the `changed_at` that starts the grace above.
    pub fn setBinRetentionDays(self: Settings, days: i64) Error!Retention {
        if (days < min_retention_days or days > max_retention_days) return error.InvalidRetention;
        const seconds = days * seconds_per_day;
        const t = self.now();
        var s = try self.db.prepare(
            "INSERT INTO settings(key, value, updated_at) VALUES(?1, ?2, ?3) " ++
                "ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3;",
        );
        defer s.finalize();
        s.bindText(1, bin_retention_key);
        s.bindInt(2, seconds);
        s.bindInt(3, t);
        _ = try s.step();
        return .{ .seconds = seconds, .changed_at = t };
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

    // No row: the default, with `changed_at` at the epoch so nothing is gated.
    const initial = try set.binRetention();
    try testing.expectEqual(filesmod.Files.bin_retention_s, initial.seconds);
    try testing.expectEqual(@as(i64, 0), initial.changed_at);
    try testing.expectEqual(@as(i64, 30), initial.days());

    const written = try set.setBinRetentionDays(7);
    try testing.expectEqual(@as(i64, 7 * seconds_per_day), written.seconds);
    try testing.expect(written.changed_at > 0);

    // The write is what a later read sees, and it upserts rather than duplicating.
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

    // A rejected write leaves the previous window exactly as it was — the console
    // must not be able to blank retention by fat-fingering the field.
    try testing.expectEqual(@as(i64, 10), (try set.binRetention()).days());

    // The bounds themselves are legal.
    try testing.expectEqual(min_retention_days, (try set.setBinRetentionDays(min_retention_days)).days());
    try testing.expectEqual(max_retention_days, (try set.setBinRetentionDays(max_retention_days)).days());
}

test "sweepCutoff: shortening the window never purges retroactively" {
    const day = seconds_per_day;
    const t: i64 = 1_000 * day; // an arbitrary "now", far from the epoch

    // The unconfigured install: the default has always been in force, so the
    // ordinary cutoff applies and an entry trashed 31 days ago is due.
    const default_window: Retention = .{ .seconds = 30 * day, .changed_at = 0 };
    try testing.expectEqual(@as(?i64, t - 30 * day), sweepCutoff(t, default_window));

    // THE CASE THIS EXISTS FOR: the window was just cut to 7 days, and the bin
    // holds entries trashed 20 days ago — already past the NEW window. Nothing may
    // be swept at all yet, so the shortening destroys nothing.
    const just_shortened: Retention = .{ .seconds = 7 * day, .changed_at = t };
    try testing.expectEqual(@as(?i64, null), sweepCutoff(t, just_shortened));

    // Six days on, still nothing: the new window has not been in force for a full
    // window, so those 20-day-old entries are still restorable.
    try testing.expectEqual(@as(?i64, null), sweepCutoff(t + 6 * day, just_shortened));

    // Seven days on it does apply, and the entries that were already old go. That
    // is the grace expiring, not a retroactive purge — it is a full new window
    // after the change, exactly as an entry trashed the moment of the change gets.
    const after = sweepCutoff(t + 7 * day + 1, just_shortened);
    try testing.expect(after != null);
    try testing.expect(after.? > t - 20 * day); // a 20-day-old entry is now due

    // Lengthening can only ever delay: with a 60-day window set just now, an entry
    // trashed 40 days ago (due under the old 30-day window) is not swept.
    const just_lengthened: Retention = .{ .seconds = 60 * day, .changed_at = t };
    try testing.expectEqual(@as(?i64, null), sweepCutoff(t, just_lengthened));
}
