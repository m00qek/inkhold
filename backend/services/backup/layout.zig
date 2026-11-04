//! The names inside a backup directory, and nothing else: where a snapshot,
//! a blob, the manifest and the lock live. Every name is plain ASCII with no
//! `:` so the folder survives FAT, SMB and cloud sync clients unchanged.
//!
//!     <dir>/
//!       blobs/ab/<md5>[.gz]       one immutable file per blob
//!       2026-11-04T030000Z/       one per snapshot, sortable by name
//!         inkhold.db.gz
//!         cred.key                only with --include-cred-key
//!         manifest.txt            written last: its presence means complete
//!       README.txt
//!       .inkhold-backup.lock      while a create or prune runs

const std = @import("std");
const epoch = std.time.epoch;

pub const md5_len = 32;

pub const blobs_dir = "blobs";
pub const manifest_name = "manifest.txt";
pub const db_name = "inkhold.db.gz";
pub const cred_key_name = "cred.key";
pub const readme_name = "README.txt";
pub const lock_name = ".inkhold-backup.lock";
pub const partial_suffix = ".partial";
pub const gz_suffix = ".gz";

/// `YYYY-MM-DDTHHMMSSZ`, UTC.
pub const snapshot_name_len = 18;
pub const SnapshotName = [snapshot_name_len]u8;

/// The snapshot directory name for `unix_s`. Lexical order is time order.
pub fn snapshotName(unix_s: i64) SnapshotName {
    const secs: epoch.EpochSeconds = .{ .secs = @intCast(@max(unix_s, 0)) };
    const yd = secs.getEpochDay().calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = secs.getDaySeconds();
    var out: SnapshotName = undefined;
    _ = std.fmt.bufPrint(&out, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}{d:0>2}{d:0>2}Z", .{
        yd.year,
        md.month.numeric(),
        md.day_index + 1,
        ds.getHoursIntoDay(),
        ds.getMinutesIntoHour(),
        ds.getSecondsIntoMinute(),
    }) catch unreachable;
    return out;
}

/// Whether `name` has the shape `snapshotName` produces. Anything else in the
/// directory (a `.partial`, a user's own file) is not a snapshot.
pub fn isSnapshotName(name: []const u8) bool {
    if (name.len != snapshot_name_len) return false;
    const shape = "dddd-dd-ddTddddddZ";
    for (name, shape) |c, s| {
        if (s == 'd') {
            if (!std.ascii.isDigit(c)) return false;
        } else if (c != s) return false;
    }
    return true;
}

/// Whether `s` is 32 lowercase hex digits, the only blob name we write.
pub fn isMd5(s: []const u8) bool {
    if (s.len != md5_len) return false;
    for (s) |c| switch (c) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

/// Room for `blobs/ab/<md5>.gz`.
pub const blob_path_max = blobs_dir.len + 1 + 2 + 1 + md5_len + gz_suffix.len;

/// `blobs/ab/<md5>` or, compressed, `blobs/ab/<md5>.gz`.
pub fn blobPath(buf: *[blob_path_max]u8, md5: []const u8, compressed: bool) []const u8 {
    std.debug.assert(md5.len == md5_len);
    return std.fmt.bufPrint(buf, "{s}/{s}/{s}{s}", .{
        blobs_dir, md5[0..2], md5, if (compressed) gz_suffix else "",
    }) catch unreachable;
}

/// The fan-out directory of a blob: `blobs/ab`.
pub fn blobFanout(buf: *[blobs_dir.len + 3]u8, md5: []const u8) []const u8 {
    return std.fmt.bufPrint(buf, "{s}/{s}", .{ blobs_dir, md5[0..2] }) catch unreachable;
}

/// What a person finds when they open the folder.
pub const readme =
    \\This folder is an Inkhold backup.
    \\
    \\  blobs/                 your notebooks and documents, one file each,
    \\                         named by their md5 (".gz" when compressed)
    \\  <date>T<time>Z/        one snapshot per backup run: the database,
    \\                         and a manifest listing the files it needs
    \\
    \\Every snapshot is complete on its own: restoring one needs only that
    \\folder and blobs/. Keep the whole folder as private as the notes it
    \\holds; nothing in it is encrypted.
    \\
    \\To restore onto a fresh install (the server stopped):
    \\
    \\    inkhold restore <this folder>
    \\
    \\To check it without restoring:
    \\
    \\    inkhold backup verify <this folder>
    \\
;

// ---- tests ----

const testing = std.testing;

test "a snapshot name is UTC, sortable and carries no colon" {
    try testing.expectEqualStrings("1970-01-01T000000Z", &snapshotName(0));
    try testing.expectEqualStrings("2026-11-04T030000Z", &snapshotName(1793761200));
    try testing.expectEqualStrings("2024-02-29T235959Z", &snapshotName(1709251199));
    const a = snapshotName(1793761200);
    const b = snapshotName(1793761201);
    try testing.expect(std.mem.order(u8, &a, &b) == .lt);
    try testing.expect(std.mem.indexOfScalar(u8, &a, ':') == null);
}

test "only names snapshotName makes count as snapshots" {
    try testing.expect(isSnapshotName(&snapshotName(1793761200)));
    try testing.expect(!isSnapshotName("2026-11-04T030000Z.partial"));
    try testing.expect(!isSnapshotName("2026-11-04T03:00:00Z"));
    try testing.expect(!isSnapshotName("blobs"));
    try testing.expect(!isSnapshotName("2026-11-04X030000Z"));
}

test "blob paths fan out by the first two hex digits" {
    const md5 = "0123456789abcdef0123456789abcdef";
    var buf: [blob_path_max]u8 = undefined;
    try testing.expectEqualStrings("blobs/01/0123456789abcdef0123456789abcdef", blobPath(&buf, md5, false));
    try testing.expectEqualStrings("blobs/01/0123456789abcdef0123456789abcdef.gz", blobPath(&buf, md5, true));
    var fb: [blobs_dir.len + 3]u8 = undefined;
    try testing.expectEqualStrings("blobs/01", blobFanout(&fb, md5));
}

test "isMd5 accepts only the lowercase hex we write" {
    try testing.expect(isMd5("0123456789abcdef0123456789abcdef"));
    try testing.expect(!isMd5("0123456789ABCDEF0123456789abcdef"));
    try testing.expect(!isMd5("0123456789abcdef0123456789abcde"));
    try testing.expect(!isMd5("0123456789abcdef0123456789abcdeg"));
}
