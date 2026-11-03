//! Server health for the admin console: memory against budget, blob-store disk,
//! version. Household-wide totals only — no per-person activity, by design.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");

/// The RSS ceiling this project holds itself to (50 MB).
pub const memory_budget_bytes: i64 = 50 * 1024 * 1024;

pub const Health = struct {
    /// The running API version, passed in so a service need not import a handler.
    version: []const u8,
    /// Resident set size in bytes; null where unreadable (render "unknown", not 0).
    memory_bytes: ?i64,
    /// Anonymous resident set (`RssAnon`): heap and stacks. `VmRSS` also counts
    /// file-backed pages (binary text, mmapped DB), so the budget is judged on this.
    memory_anon_bytes: ?i64,
    memory_budget_bytes: i64,
    /// Deduplicated disk held by the blob store, from `blobs.size` (not the sum of
    /// quota usage; a shared blob counts once here, once per user in `capacity`).
    blob_bytes: i64,
    blob_count: i64,
};

pub fn snapshot(io: std.Io, db: sqlite.Db, version: []const u8) !Health {
    var s = try db.prepare("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM blobs;");
    defer s.finalize();
    _ = try s.step();
    const mem = procMemory(io);
    return .{
        .version = version,
        .memory_bytes = mem.rss,
        .memory_anon_bytes = mem.anon,
        .memory_budget_bytes = memory_budget_bytes,
        .blob_count = s.columnInt(0),
        .blob_bytes = s.columnInt(1),
    };
}

/// `VmRSS` and `RssAnon` from one read of `/proc/self/status`.
const Memory = struct { rss: ?i64, anon: ?i64 };

/// Reads `/proc/self/status` (states its unit, unlike statm's pages). Failures
/// yield null. Stack buffer with a short read, because `/proc` files report
/// `st_size = 0` and size-driven whole-file helpers return empty.
fn procMemory(io: std.Io) Memory {
    if (@import("builtin").os.tag != .linux) return .{ .rss = null, .anon = null };
    var file = std.Io.Dir.cwd().openFile(io, "/proc/self/status", .{}) catch
        return .{ .rss = null, .anon = null };
    defer file.close(io);
    var read_buf: [1024]u8 = undefined;
    var out: [4096]u8 = undefined;
    var reader = file.reader(io, &read_buf);
    const n = reader.interface.readSliceShort(&out) catch
        return .{ .rss = null, .anon = null };
    const body = out[0..n];
    return .{ .rss = parseStatusKb(body, "VmRSS"), .anon = parseStatusKb(body, "RssAnon") };
}

/// `<key>:\t 12345 kB` → bytes. Matches `key:` so `VmRSS` misses `Other_VmRSS`.
fn parseStatusKb(status: []const u8, key: []const u8) ?i64 {
    var lines = std.mem.splitScalar(u8, status, '\n');
    while (lines.next()) |line| {
        if (line.len <= key.len or !std.mem.startsWith(u8, line, key) or line[key.len] != ':') continue;
        var fields = std.mem.tokenizeAny(u8, line[key.len + 1 ..], " \t");
        const value = fields.next() orelse return null;
        const kb = std.fmt.parseInt(i64, value, 10) catch return null;
        return kb * 1024;
    }
    return null;
}

// ---- tests ----

const schema = @import("../db/schema.zig");
const testing = std.testing;

test "health reports deduplicated blob disk, the memory budget, and the version" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    {
        const h = try snapshot(testing.io, db, "9.9.9");
        try testing.expectEqualStrings("9.9.9", h.version);
        try testing.expectEqual(@as(i64, 0), h.blob_count);
        try testing.expectEqual(@as(i64, 0), h.blob_bytes);
        try testing.expectEqual(memory_budget_bytes, h.memory_budget_bytes);
    }

    // One blob referenced twice: disk counts its bytes once.
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('aa', 1000, 2, 0);");
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('bb', 24, 1, 0);");
    const h = try snapshot(testing.io, db, "9.9.9");
    try testing.expectEqual(@as(i64, 2), h.blob_count);
    try testing.expectEqual(@as(i64, 1024), h.blob_bytes);

    // RssAnon never exceeds VmRSS.
    if (@import("builtin").os.tag == .linux) {
        try testing.expect(h.memory_bytes != null);
        try testing.expect(h.memory_bytes.? > 0);
        try testing.expect(h.memory_anon_bytes != null);
        try testing.expect(h.memory_anon_bytes.? > 0);
        try testing.expect(h.memory_anon_bytes.? <= h.memory_bytes.?);
    }
}

test "parseStatusKb reads the requested kB line and reports nothing when it is absent" {
    const status =
        "Name:\tinkhold\n" ++
        "VmPeak:\t  102400 kB\n" ++
        "VmRSS:\t   32148 kB\n" ++
        "RssAnon:\t    1456 kB\n" ++
        "RssFile:\t   30692 kB\n" ++
        "Threads:\t2\n";
    try testing.expectEqual(@as(?i64, 32148 * 1024), parseStatusKb(status, "VmRSS"));
    try testing.expectEqual(@as(?i64, 1456 * 1024), parseStatusKb(status, "RssAnon"));

    try testing.expectEqual(@as(?i64, null), parseStatusKb("Name:\tx\nThreads:\t1\n", "VmRSS"));
    try testing.expectEqual(@as(?i64, null), parseStatusKb("VmRSS:\t   what kB\n", "VmRSS"));
    try testing.expectEqual(@as(?i64, null), parseStatusKb("", "VmRSS"));

    try testing.expectEqual(@as(?i64, null), parseStatusKb("Other_VmRSS:\t 5 kB\n", "VmRSS"));
    try testing.expectEqual(@as(?i64, null), parseStatusKb("RssAnon:\t 5 kB\n", "Rss"));
}
