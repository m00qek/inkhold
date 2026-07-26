//! Server health: what the admin console's Server panel shows — memory against
//! the project's budget, disk held by the blob store, and the running version.
//!
//! ## What is deliberately NOT here
//!
//! **No per-person activity of any kind.** No last-sync, no per-user note or byte
//! counts, no device-seen timestamps. That is a ruling about this endpoint, not
//! an oversight: "when did Rui last use his tablet" and "how much does he write"
//! are surveillance of a housemate dressed as operational stats, and an admin
//! here manages ACCOUNTS rather than watching the people using them. Everything
//! below is a household-wide total, and every field should stay that way — if a
//! figure can only be produced by naming a user, it does not belong in this file.
//!
//! Uptime is absent for a duller reason: it answers "has it crashed?", which in a
//! household you would already know.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");

/// The RSS ceiling this project holds itself to (50 MB), reported alongside the
/// live figure because the live figure means nothing without it — "31.4 MB" is
/// only reassuring next to the number it is not allowed to cross.
pub const memory_budget_bytes: i64 = 50 * 1024 * 1024;

pub const Health = struct {
    /// The running API version (`handlers/auth.zig`'s `api_version`), passed in
    /// rather than imported: a service must not reach into a handler.
    version: []const u8,
    /// Resident set size in bytes, or **null where the platform cannot say**.
    /// Only Linux is wired up (via `/proc`), and a null must render as "unknown"
    /// rather than as zero — a memory panel reading 0 B looks like a healthy
    /// server, which is the opposite of what an unreadable figure means.
    memory_bytes: ?i64,
    /// The ANONYMOUS resident set (`RssAnon`) — heap and stacks, the memory this
    /// process actually owns and can be blamed for. Reported beside `memory_bytes`
    /// because `VmRSS` also counts file-backed pages: the binary's own text, and —
    /// once `PRAGMA mmap_size` is on — the memory-mapped slice of the database.
    /// Those inflate `VmRSS` without the process having allocated anything, so the
    /// ~50 MB budget only means what it claims when the anon figure sits beside it.
    memory_anon_bytes: ?i64,
    memory_budget_bytes: i64,
    /// Bytes held by the content-addressed blob store, counted from `blobs.size`.
    ///
    /// This is DEDUPLICATED disk, not the sum of everyone's quota usage: one blob
    /// shared by two households is one row here and is charged to both of them in
    /// `capacity`. Disk is the honest question for a server panel — "how full is
    /// this machine" — and the per-person figure is the quota meter's job.
    ///
    /// Read from the table rather than by walking the blob directory: a directory
    /// walk on a household's whole note corpus is real I/O on a request path, and
    /// the table is the store's own accounting.
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

/// Total (`VmRSS`) and anonymous (`RssAnon`) resident bytes, each null when it
/// cannot be read. Both come from ONE read of `/proc/self/status` — the two lines
/// are adjacent in the file, so reading it twice would be waste for no gain.
const Memory = struct { rss: ?i64, anon: ?i64 };

/// Reads the process's resident memory from `/proc/self/status`.
///
/// `/proc/self/status`, not `/proc/self/statm`: statm reports PAGES and would need
/// the page size to interpret, while status states its own unit (kB) on each line.
/// One less thing to get wrong for numbers nobody can sanity-check by eye.
///
/// Every failure path yields null rather than propagating: a health endpoint that
/// 500s because it could not read a diagnostic is worse than one that says it does
/// not know, and on a non-Linux host there is simply no answer to give.
///
/// Read into a STACK buffer with an explicit short read, not `readFileAlloc`:
/// a `/proc` file reports `st_size = 0`, so the size-driven whole-file helpers
/// return an empty slice and the figure silently reads as "unknown" on the one
/// platform that can actually answer. (It also keeps a memory readout from
/// allocating, which would be a small joke at this endpoint's expense.)
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

/// Pulls `<key>:\t   12345 kB` out of a `/proc/self/status` body and returns
/// bytes. Split out from the file read so it is testable without a live `/proc`.
/// The `key:` match (not a bare prefix) keeps `VmRSS` from matching `Other_VmRSS`
/// and `RssAnon` from matching a longer key that merely starts the same way.
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

    // An empty store is 0/0, not an error — a fresh install must render.
    {
        const h = try snapshot(testing.io, db, "9.9.9");
        try testing.expectEqualStrings("9.9.9", h.version);
        try testing.expectEqual(@as(i64, 0), h.blob_count);
        try testing.expectEqual(@as(i64, 0), h.blob_bytes);
        try testing.expectEqual(memory_budget_bytes, h.memory_budget_bytes);
    }

    // Two blobs, one of them referenced twice: disk counts the BYTES ONCE. That is
    // the difference between this figure and the sum of everyone's quota usage.
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('aa', 1000, 2, 0);");
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('bb', 24, 1, 0);");
    const h = try snapshot(testing.io, db, "9.9.9");
    try testing.expectEqual(@as(i64, 2), h.blob_count);
    try testing.expectEqual(@as(i64, 1024), h.blob_bytes);

    // On Linux the live figures are real and under the budget the tests run in,
    // and RssAnon (heap+stacks) is never larger than VmRSS (which also holds the
    // file-backed pages) — the invariant that makes reporting both meaningful.
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

    // A kernel that does not report the key, and a malformed value, both read as
    // "unknown" — never as zero, which would look like a healthy server.
    try testing.expectEqual(@as(?i64, null), parseStatusKb("Name:\tx\nThreads:\t1\n", "VmRSS"));
    try testing.expectEqual(@as(?i64, null), parseStatusKb("VmRSS:\t   what kB\n", "VmRSS"));
    try testing.expectEqual(@as(?i64, null), parseStatusKb("", "VmRSS"));

    // The key must match to the colon, not as a bare prefix: neither a longer
    // line that merely contains it nor a longer key that starts the same way.
    try testing.expectEqual(@as(?i64, null), parseStatusKb("Other_VmRSS:\t 5 kB\n", "VmRSS"));
    try testing.expectEqual(@as(?i64, null), parseStatusKb("RssAnon:\t 5 kB\n", "Rss"));
}
