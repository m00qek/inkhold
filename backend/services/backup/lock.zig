//! One writer per backup directory at a time. A `prune` that ran while a
//! `create` was copying would delete blobs no manifest names yet. The lock is a
//! file created with O_EXCL, not `flock`: advisory locks do not hold on SMB or
//! in a cloud-synced folder. A crash leaves the file behind, so a lock older
//! than `stale_after_s` is taken over.

const std = @import("std");
const layout = @import("layout.zig");
const atomic = @import("../../store/atomic.zig");
const Io = std.Io;
const Dir = Io.Dir;

/// Longer than any plausible run (a first backup of a large library on a
/// Pi Zero at the default rate is well under an hour).
pub const stale_after_s: i64 = 6 * 60 * 60;

/// Who holds the lock, as read from the file, for the refusal message.
pub const Holder = struct {
    pid: i64 = 0,
    host_buf: [64]u8 = undefined,
    host_len: u8 = 0,
    started: i64 = 0,

    pub fn host(self: *const Holder) []const u8 {
        return self.host_buf[0..self.host_len];
    }
};

pub const Lock = struct {
    dir: Dir,

    /// Removes the lock file. Idempotent.
    pub fn release(self: Lock, io: Io) void {
        self.dir.deleteFile(io, layout.lock_name) catch {};
    }
};

/// Takes the lock in `dir`, or reports the live holder in `holder` and fails
/// with `error.Locked`. A stale lock (or one we cannot read) is replaced once.
pub fn acquire(io: Io, dir: Dir, now: i64, host: []const u8, pid: i64, holder: *Holder) !Lock {
    var attempt: u2 = 0;
    while (true) : (attempt += 1) {
        if (dir.createFile(io, layout.lock_name, .{ .exclusive = true })) |file| {
            defer file.close(io);
            var buf: [160]u8 = undefined;
            const body = std.fmt.bufPrint(&buf, "pid {d}\nhost {s}\nstarted {d}\n", .{ pid, host, now }) catch unreachable;
            try file.writePositionalAll(io, body, 0);
            return .{ .dir = dir };
        } else |e| switch (e) {
            error.PathAlreadyExists => {},
            else => return e,
        }
        if (attempt > 0) return error.Locked;

        holder.* = read(io, dir) orelse .{};
        if (holder.started != 0 and now - holder.started < stale_after_s) return error.Locked;
        // Stale or unreadable: the run that wrote it is gone.
        try dir.deleteFile(io, layout.lock_name);
    }
}

fn read(io: Io, dir: Dir) ?Holder {
    const file = dir.openFile(io, layout.lock_name, .{}) catch return null;
    defer file.close(io);
    var buf: [160]u8 = undefined;
    const body = atomic.readAll(io, file, &buf) catch return null;
    var h: Holder = .{};
    var it = std.mem.splitScalar(u8, body, '\n');
    while (it.next()) |line| {
        const sp = std.mem.indexOfScalar(u8, line, ' ') orelse continue;
        const key = line[0..sp];
        const val = line[sp + 1 ..];
        if (std.mem.eql(u8, key, "pid")) {
            h.pid = std.fmt.parseInt(i64, val, 10) catch 0;
        } else if (std.mem.eql(u8, key, "host")) {
            const n = @min(val.len, h.host_buf.len);
            @memcpy(h.host_buf[0..n], val[0..n]);
            h.host_len = @intCast(n);
        } else if (std.mem.eql(u8, key, "started")) {
            h.started = std.fmt.parseInt(i64, val, 10) catch 0;
        }
    }
    return h;
}

// ---- tests ----

const testing = std.testing;

test "a second writer is refused and told who holds the lock" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var h: Holder = .{};
    const lock = try acquire(testing.io, tmp.dir, 1000, "pi", 42, &h);
    try testing.expectError(error.Locked, acquire(testing.io, tmp.dir, 1001, "nas", 7, &h));
    try testing.expectEqual(@as(i64, 42), h.pid);
    try testing.expectEqualStrings("pi", h.host());
    try testing.expectEqual(@as(i64, 1000), h.started);

    lock.release(testing.io);
    const again = try acquire(testing.io, tmp.dir, 1002, "nas", 7, &h);
    again.release(testing.io);
}

test "a lock left by a crash is taken over once it is stale" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var h: Holder = .{};
    _ = try acquire(testing.io, tmp.dir, 1000, "pi", 42, &h); // never released
    try testing.expectError(error.Locked, acquire(testing.io, tmp.dir, 1000 + stale_after_s - 1, "pi", 43, &h));
    const taken = try acquire(testing.io, tmp.dir, 1000 + stale_after_s, "pi", 43, &h);
    taken.release(testing.io);
}

test "an unreadable lock file counts as stale" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(testing.io, .{ .sub_path = layout.lock_name, .data = "garbage" });
    var h: Holder = .{};
    const lock = try acquire(testing.io, tmp.dir, 5, "pi", 1, &h);
    lock.release(testing.io);
}
