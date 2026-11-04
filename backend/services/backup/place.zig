//! Where a backup may go. Two mistakes are refused or named before any byte
//! moves: a backup inside the live data (it would back itself up, and a lost
//! disk takes both), and a destination that is not there at all, which on a
//! Pi usually means the NAS is not mounted. Creating the directory then would
//! quietly fill the SD card instead, so the directory must already exist.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const Dir = Io.Dir;

pub const PlaceError = error{
    /// The backup directory does not exist (an unmounted share, a typo).
    BackupDirMissing,
    /// The backup directory is inside the data directory or the database's.
    InsideLiveData,
};

pub const Place = struct {
    /// The destination sits on the same filesystem as the live data: worth a
    /// warning, since the disk failing takes both.
    same_filesystem: bool,
};

/// Checks `backup_dir` against the live `data_dir` and `db_path`.
pub fn check(io: Io, backup_dir: []const u8, data_dir: []const u8, db_path: []const u8) !Place {
    var bbuf: [Dir.max_path_bytes]u8 = undefined;
    const backup = real(io, backup_dir, &bbuf) catch |e| switch (e) {
        error.FileNotFound => return error.BackupDirMissing,
        else => return e,
    };

    var dbuf: [Dir.max_path_bytes]u8 = undefined;
    const data = real(io, data_dir, &dbuf) catch |e| switch (e) {
        error.FileNotFound => null,
        else => return e,
    };
    if (data) |d| if (contains(d, backup)) return error.InsideLiveData;

    var sbuf: [Dir.max_path_bytes]u8 = undefined;
    const state_dir = std.fs.path.dirname(db_path) orelse ".";
    const state = try real(io, state_dir, &sbuf);
    if (contains(state, backup)) return error.InsideLiveData;

    return .{ .same_filesystem = sameFilesystem(backup, data orelse state) };
}

fn real(io: Io, path: []const u8, buf: *[Dir.max_path_bytes]u8) ![]const u8 {
    const n = try Dir.cwd().realPathFile(io, path, buf);
    return buf[0..n];
}

/// Whether `inner` is `outer` or below it, by whole path components.
pub fn contains(outer: []const u8, inner: []const u8) bool {
    if (!std.mem.startsWith(u8, inner, outer)) return false;
    if (inner.len == outer.len) return true;
    return outer.len > 0 and (outer[outer.len - 1] == '/' or inner[outer.len] == '/');
}

fn sameFilesystem(a: []const u8, b: []const u8) bool {
    if (builtin.os.tag != .linux) return false;
    const da = device(a) orelse return false;
    const db = device(b) orelse return false;
    return da == db;
}

fn device(path: []const u8) ?u64 {
    const linux = std.os.linux;
    var zbuf: [Dir.max_path_bytes + 1]u8 = undefined;
    if (path.len >= zbuf.len) return null;
    @memcpy(zbuf[0..path.len], path);
    zbuf[path.len] = 0;
    var stx: linux.Statx = undefined;
    const rc = linux.statx(linux.AT.FDCWD, @ptrCast(&zbuf), 0, .{ .TYPE = true }, &stx);
    if (linux.errno(rc) != .SUCCESS) return null;
    return (@as(u64, stx.dev_major) << 32) | stx.dev_minor;
}

// ---- tests ----

const testing = std.testing;

test "contains works by whole path components" {
    try testing.expect(contains("/var/lib/inkhold", "/var/lib/inkhold"));
    try testing.expect(contains("/var/lib/inkhold", "/var/lib/inkhold/backups"));
    try testing.expect(!contains("/var/lib/inkhold", "/var/lib/inkhold-backup"));
    try testing.expect(!contains("/var/lib/inkhold", "/var/lib"));
    try testing.expect(contains("/", "/mnt/nas"));
}

test "a backup inside the data, or a missing destination, is refused" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const gpa = testing.allocator;
    const root = try std.fmt.allocPrint(gpa, ".zig-cache/tmp/{s}", .{&tmp.sub_path});
    defer gpa.free(root);
    try tmp.dir.createDirPath(testing.io, "state/data/inside");
    try tmp.dir.createDirPath(testing.io, "elsewhere");

    const data = try std.fmt.allocPrint(gpa, "{s}/state/data", .{root});
    defer gpa.free(data);
    const db = try std.fmt.allocPrint(gpa, "{s}/state/inkhold.db", .{root});
    defer gpa.free(db);
    const inside = try std.fmt.allocPrint(gpa, "{s}/state/data/inside", .{root});
    defer gpa.free(inside);
    const beside_db = try std.fmt.allocPrint(gpa, "{s}/state", .{root});
    defer gpa.free(beside_db);
    const elsewhere = try std.fmt.allocPrint(gpa, "{s}/elsewhere", .{root});
    defer gpa.free(elsewhere);
    const missing = try std.fmt.allocPrint(gpa, "{s}/not-mounted", .{root});
    defer gpa.free(missing);

    try testing.expectError(error.InsideLiveData, check(testing.io, inside, data, db));
    try testing.expectError(error.InsideLiveData, check(testing.io, beside_db, data, db));
    try testing.expectError(error.BackupDirMissing, check(testing.io, missing, data, db));
    const ok = try check(testing.io, elsewhere, data, db);
    // A temp directory is on the same disk as the "live" data here.
    try testing.expect(ok.same_filesystem);
}
