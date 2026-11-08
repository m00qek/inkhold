//! What `inkhold backup` last did, and whether a person should hear about it.
//! The backup process records every `create` and `verify`, good or failed,
//! into `backup_runs` (one row per directory); the server reads it to show
//! admins a notice. Households never read cron mail: this is how a backup
//! that stopped working gets noticed (docs/content/contributor/storage.md (Backups)).
//!
//! The rules, as agreed:
//!   - any directory whose last `create` or `verify` failed: `failed`, always,
//!     even when the "no backup yet" notice was dismissed;
//!   - no successful backup anywhere: `never`, unless dismissed ("I back up
//!     another way");
//!   - the newest success anywhere older than `warn_after_s`: `late`. Several
//!     directories are judged together: a weekly USB disk beside a nightly NAS
//!     is not late.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");

/// One directory's record. Strings are owned by the `Runs` they came in.
pub const Run = struct {
    dir: []const u8,
    last_run_at: ?i64,
    last_ok_at: ?i64,
    last_error: ?[]const u8,
    snapshot: ?[]const u8,
    blobs: ?i64,
    bytes: ?i64,
    verified_at: ?i64,
    verify_error: ?[]const u8,
};

pub const Runs = struct {
    arena: std.heap.ArenaAllocator,
    items: []Run,

    pub fn deinit(self: *Runs) void {
        self.arena.deinit();
    }
};

/// Longest error kept per run: the first line a person read, not a log.
pub const max_error_len = 240;

pub const CreateResult = union(enum) {
    ok: struct { snapshot: []const u8, blobs: u64, bytes: u64 },
    /// What the person was told; its first line is kept.
    failed: []const u8,
};

/// Records a `create` in `dir`: a snapshot when it succeeded, else the error.
pub fn recordCreate(db: sqlite.Db, dir: []const u8, now: i64, result: CreateResult) !void {
    switch (result) {
        .ok => |r| try db.run(
            \\INSERT INTO backup_runs(dir, last_run_at, last_ok_at, last_error, snapshot, blobs, bytes)
            \\  VALUES(?1, ?2, ?2, NULL, ?3, ?4, ?5)
            \\ON CONFLICT(dir) DO UPDATE SET last_run_at = ?2, last_ok_at = ?2, last_error = NULL,
            \\  snapshot = ?3, blobs = ?4, bytes = ?5;
        , &.{ .{ .text = dir }, .{ .int = now }, .{ .text = r.snapshot }, .{ .int = @intCast(r.blobs) }, .{ .int = @intCast(r.bytes) } }),
        .failed => |msg| try db.run(
            \\INSERT INTO backup_runs(dir, last_run_at, last_error) VALUES(?1, ?2, ?3)
            \\ON CONFLICT(dir) DO UPDATE SET last_run_at = ?2, last_error = ?3;
        , &.{ .{ .text = dir }, .{ .int = now }, .{ .text = firstLine(msg) } }),
    }
}

/// Records a `verify` of `dir`: null `failure` when every snapshot passed.
pub fn recordVerify(db: sqlite.Db, dir: []const u8, now: i64, failure: ?[]const u8) !void {
    const err: sqlite.Bind = if (failure) |f| .{ .text = firstLine(f) } else .null;
    try db.run(
        \\INSERT INTO backup_runs(dir, verified_at, verify_error) VALUES(?1, ?2, ?3)
        \\ON CONFLICT(dir) DO UPDATE SET verified_at = ?2, verify_error = ?3;
    , &.{ .{ .text = dir }, .{ .int = now }, err });
}

/// Drops `dir`'s record: an admin retiring a destination it no longer uses.
pub fn forget(db: sqlite.Db, dir: []const u8) !bool {
    try db.run("DELETE FROM backup_runs WHERE dir = ?1;", &.{.{ .text = dir }});
    return db.changes() > 0;
}

/// Empties the table: what `restore` does, so a restored server does not
/// report the snapshot day's backups as its own.
pub fn clear(db: sqlite.Db) !void {
    try db.exec("DELETE FROM backup_runs;");
}

/// Every directory's record, most recent activity first.
pub fn list(gpa: std.mem.Allocator, db: sqlite.Db) !Runs {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();
    var out: std.ArrayList(Run) = .empty;
    var st = try db.prepare(
        \\SELECT dir, last_run_at, last_ok_at, last_error, snapshot, blobs, bytes, verified_at, verify_error
        \\FROM backup_runs ORDER BY MAX(COALESCE(last_run_at, 0), COALESCE(verified_at, 0)) DESC, dir;
    );
    defer st.finalize();
    while (try st.step()) {
        try out.append(a, .{
            .dir = try a.dupe(u8, st.columnText(0)),
            .last_run_at = st.columnIntOpt(1),
            .last_ok_at = st.columnIntOpt(2),
            .last_error = try dupeOpt(a, st, 3),
            .snapshot = try dupeOpt(a, st, 4),
            .blobs = st.columnIntOpt(5),
            .bytes = st.columnIntOpt(6),
            .verified_at = st.columnIntOpt(7),
            .verify_error = try dupeOpt(a, st, 8),
        });
    }
    return .{ .arena = arena, .items = out.items };
}

fn dupeOpt(a: std.mem.Allocator, st: sqlite.Stmt, col: c_int) !?[]const u8 {
    if (st.columnIsNull(col)) return null;
    return try a.dupe(u8, st.columnText(col));
}

pub const Kind = enum { none, never, late, failed };

/// What to tell an admin, if anything. `dir`, `at` and `message` point into
/// the `Runs` it was judged from.
pub const Notice = struct {
    kind: Kind,
    /// The directory concerned (`failed`), or the one with the newest success (`late`).
    dir: ?[]const u8 = null,
    /// When the failure happened, or the newest success.
    at: ?i64 = null,
    message: ?[]const u8 = null,
    /// `failed` only: the failure is the check of the backups (`verify`), not
    /// a backup run, so the notice can say which.
    check: bool = false,
};

/// Judges `runs` by the rules at the top of this file.
pub fn assess(runs: []const Run, now: i64, warn_after_s: i64, never_dismissed: bool) Notice {
    // A failure outranks everything, and the most recent one is the one to show.
    var failed: ?Notice = null;
    for (runs) |r| {
        const create_failed = r.last_error != null;
        const verify_failed = r.verify_error != null;
        if (!create_failed and !verify_failed) continue;
        const at = if (create_failed) r.last_run_at else r.verified_at;
        if (failed == null or (at orelse 0) > (failed.?.at orelse 0)) {
            failed = .{
                .kind = .failed,
                .dir = r.dir,
                .at = at,
                .message = if (create_failed) r.last_error else r.verify_error,
                .check = !create_failed,
            };
        }
    }
    if (failed) |f| return f;

    var newest: ?*const Run = null;
    for (runs) |*r| {
        const ok = r.last_ok_at orelse continue;
        if (newest == null or ok > newest.?.last_ok_at.?) newest = r;
    }
    const n = newest orelse return if (never_dismissed) .{ .kind = .none } else .{ .kind = .never };
    if (now - n.last_ok_at.? > warn_after_s) return .{ .kind = .late, .dir = n.dir, .at = n.last_ok_at };
    return .{ .kind = .none };
}

fn firstLine(msg: []const u8) []const u8 {
    const trimmed = std.mem.trim(u8, msg, " \n\r\t");
    const line = trimmed[0 .. std.mem.indexOfScalar(u8, trimmed, '\n') orelse trimmed.len];
    return line[0..@min(line.len, max_error_len)];
}

// ---- tests ----

const testing = std.testing;
const schema = @import("../../db/schema.zig");

fn freshDb() !sqlite.Db {
    const db = try sqlite.Db.openMemory();
    try schema.migrate(db);
    return db;
}

const day: i64 = 86400;
const warn: i64 = 48 * 3600;

test "a run is recorded per directory, success and failure alike" {
    const db = try freshDb();
    defer db.close();
    try recordCreate(db, "/mnt/nas", 100, .{ .ok = .{ .snapshot = "2026-11-04T030000Z", .blobs = 37, .bytes = 1000 } });
    try recordCreate(db, "/mnt/nas", 200, .{ .failed = "No backup directory at: /mnt/nas\nIt must already exist." });
    try recordVerify(db, "/media/usb", 150, null);

    var runs = try list(testing.allocator, db);
    defer runs.deinit();
    try testing.expectEqual(@as(usize, 2), runs.items.len);
    const nas = runs.items[0];
    try testing.expectEqualStrings("/mnt/nas", nas.dir);
    try testing.expectEqual(@as(?i64, 200), nas.last_run_at);
    try testing.expectEqual(@as(?i64, 100), nas.last_ok_at); // the failure keeps the last success
    try testing.expectEqualStrings("No backup directory at: /mnt/nas", nas.last_error.?);
    try testing.expectEqualStrings("2026-11-04T030000Z", nas.snapshot.?);
    const usb = runs.items[1];
    try testing.expectEqual(@as(?i64, null), usb.last_run_at);
    try testing.expectEqual(@as(?[]const u8, null), usb.verify_error);

    // A success clears the error.
    try recordCreate(db, "/mnt/nas", 300, .{ .ok = .{ .snapshot = "2026-11-05T030000Z", .blobs = 38, .bytes = 1100 } });
    var again = try list(testing.allocator, db);
    defer again.deinit();
    try testing.expectEqual(@as(?[]const u8, null), again.items[0].last_error);

    try testing.expect(try forget(db, "/media/usb"));
    try testing.expect(!try forget(db, "/media/usb"));
    try clear(db);
    var none = try list(testing.allocator, db);
    defer none.deinit();
    try testing.expectEqual(@as(usize, 0), none.items.len);
}

fn run(dir: []const u8, ok_at: ?i64, err: ?[]const u8, run_at: ?i64) Run {
    return .{ .dir = dir, .last_run_at = run_at, .last_ok_at = ok_at, .last_error = err, .snapshot = null, .blobs = null, .bytes = null, .verified_at = null, .verify_error = null };
}

test "assess: nothing yet, then a fresh success, then late" {
    const now: i64 = 10 * day;
    try testing.expectEqual(Kind.never, assess(&.{}, now, warn, false).kind);
    try testing.expectEqual(Kind.none, assess(&.{}, now, warn, true).kind); // dismissed
    try testing.expectEqual(Kind.none, assess(&.{run("/nas", now - day, null, now - day)}, now, warn, false).kind);
    const late = assess(&.{run("/nas", now - 3 * day, null, now - 3 * day)}, now, warn, false);
    try testing.expectEqual(Kind.late, late.kind);
    try testing.expectEqual(@as(?i64, now - 3 * day), late.at);
}

test "assess: several directories are judged together, a failure anywhere still warns" {
    const now: i64 = 10 * day;
    // A weekly USB disk beside a nightly NAS is not late.
    const both = [_]Run{ run("/nas", now - day, null, now - day), run("/usb", now - 6 * day, null, now - 6 * day) };
    try testing.expectEqual(Kind.none, assess(&both, now, warn, false).kind);

    // The USB disk's last run failed: that shows, whatever the NAS says.
    const usb_failed = [_]Run{ run("/nas", now - day, null, now - day), run("/usb", now - 6 * day, "disk full", now - 2 * day) };
    const n = assess(&usb_failed, now, warn, false);
    try testing.expectEqual(Kind.failed, n.kind);
    try testing.expectEqualStrings("/usb", n.dir.?);
    try testing.expectEqualStrings("disk full", n.message.?);

    // A failure shows even when "no backup yet" was dismissed.
    try testing.expectEqual(Kind.failed, assess(&.{run("/nas", null, "not mounted", now)}, now, warn, true).kind);

    // A failed verify warns too.
    var v = run("/nas", now - day, null, now - day);
    v.verify_error = "1 missing";
    v.verified_at = now;
    const checked = assess(&.{v}, now, warn, false);
    try testing.expectEqual(Kind.failed, checked.kind);
    try testing.expect(checked.check);
    try testing.expect(!n.check); // the USB disk's failure was a backup run
}

test "an error is kept to its first line, and to a sane length" {
    try testing.expectEqualStrings("first", firstLine("  first\nsecond\n"));
    try testing.expectEqual(@as(usize, max_error_len), firstLine(@import("../../util/repeat.zig").repeat(u8, "y", 300)).len);
}
