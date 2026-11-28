//! One `inkhold serve` per data folder. Two servers on one folder would each
//! run a worker over the same queue, keep caches the other never updates, and
//! sweep blobs the other is still writing. The lock is the kernel's, not a
//! file's existence: `flock` on `<data_dir>/.inkhold-serve.lock`, which the
//! kernel drops when its holder dies, by crash or `kill -9` alike, so a start
//! after one needs nobody to delete anything. The file itself is never
//! deleted; its one line ("pid host") only names the holder in the refusal.
//!
//! Exact on one machine, whatever the filesystem (local disk, an SD card, an
//! NFS or SMB mount, containers sharing a volume): the kernel holding the
//! mount sees both locks. Across machines only where the share forwards locks
//! (NFSv4, SMB without `nobrl`); not for `local_lock` NFS mounts or a
//! cloud-synced folder. Not `services/backup/lock.zig`'s O_EXCL file: that
//! survives a crash and needs a liveness check, which a pid cannot give from
//! another machine; a backup ends, so it can take over after hours, a server
//! does not.
//!
//! `serve` holds it for its life and `restore` for its run; `users` and the
//! other `backup` commands run beside a live server by design and never take it.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const Dir = Io.Dir;

pub const file_name = ".inkhold-serve.lock";

/// The most of a holder's line read back: it is information, never trusted.
const max_line = 128;
const max_host = 64;

/// Who holds the lock, as its line says, for the refusal message only.
pub const Holder = struct {
    pid: u32,
    host_buf: [max_host]u8 = undefined,
    host_len: u8 = 0,

    pub fn host(self: *const Holder) []const u8 {
        return self.host_buf[0..self.host_len];
    }
};

/// " (pid 1234 on hub)" for a refusal line; nothing when the holder is unknown.
pub fn writeHolder(w: *std.Io.Writer, holder: ?Holder) !void {
    const h = holder orelse return;
    try w.print(" (pid {d} on {s})", .{ h.pid, h.host() });
}

pub const Lock = struct {
    file: Io.File,

    /// Releases the lock (the kernel does the same when the process dies).
    /// The file stays, so its inode never changes under a holder.
    pub fn release(self: Lock, io: Io) void {
        self.file.close(io);
    }
};

/// Takes the lock on `dir`, this process's pid and host in its line. Fails
/// with `error.Locked` while another holds it, `holder` then naming it when
/// its line reads as a pid and a host, else null.
pub fn acquire(io: Io, dir: Dir, holder: *?Holder) !Lock {
    var buf: [std.posix.HOST_NAME_MAX]u8 = undefined;
    const host = std.posix.gethostname(&buf) catch "unknown";
    const pid: u32 = if (builtin.os.tag == .linux) @intCast(std.os.linux.getpid()) else 0;
    return acquireAs(io, dir, pid, host, holder);
}

/// `acquire` with the line given, for tests.
pub fn acquireAs(io: Io, dir: Dir, pid: u32, host: []const u8, holder: *?Holder) !Lock {
    holder.* = null;
    // Not truncated on open: a refused taker must still read the holder's line.
    const file = dir.createFile(io, file_name, .{ .read = true, .truncate = false, .lock = .exclusive, .lock_nonblocking = true }) catch |e| switch (e) {
        error.WouldBlock => {
            holder.* = readHolder(io, dir);
            return error.Locked;
        },
        else => return e,
    };
    errdefer file.close(io);
    var line_buf: [max_line]u8 = undefined;
    const line = std.fmt.bufPrint(&line_buf, "{d} {s}\n", .{ pid, host[0..@min(host.len, max_host)] }) catch unreachable;
    try file.setLength(io, 0);
    try file.writePositionalAll(io, line, 0);
    return .{ .file = file };
}

/// The holder its line names: a pid of digits and a host of visible ASCII.
/// Anything else (empty, garbage, unreadable, too long) names nobody.
fn readHolder(io: Io, dir: Dir) ?Holder {
    const file = dir.openFile(io, file_name, .{}) catch return null;
    defer file.close(io);
    var buf: [max_line]u8 = undefined;
    const n = file.readPositionalAll(io, &buf, 0) catch return null;
    return parseHolder(buf[0..n]);
}

fn parseHolder(text: []const u8) ?Holder {
    const line = std.mem.trimEnd(u8, text[0 .. std.mem.indexOfScalar(u8, text, '\n') orelse text.len], " \r");
    var words = std.mem.splitScalar(u8, line, ' ');
    const pid_text = words.next() orelse return null;
    const host = words.next() orelse return null;
    if (words.next() != null) return null;
    if (pid_text.len == 0 or pid_text.len > 10) return null;
    for (pid_text) |c| if (!std.ascii.isDigit(c)) return null;
    const pid = std.fmt.parseInt(u32, pid_text, 10) catch return null;
    if (host.len == 0 or host.len > max_host) return null;
    for (host) |c| if (c < 0x21 or c > 0x7e) return null;
    var h: Holder = .{ .pid = pid, .host_len = @intCast(host.len) };
    @memcpy(h.host_buf[0..host.len], host);
    return h;
}

test "a second taker on the same folder is refused, and reads who holds it" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var holder: ?Holder = null;
    const first = try acquireAs(io, tmp.dir, 1234, "hub", &holder);
    defer first.release(io);
    // flock is per open file description: a second open in this process
    // conflicts as a second process's would.
    try std.testing.expectError(error.Locked, acquireAs(io, tmp.dir, 99, "pi", &holder));
    try std.testing.expectEqual(@as(u32, 1234), holder.?.pid);
    try std.testing.expectEqualStrings("hub", holder.?.host());
}

test "released, as at a holder's exit, the next taker gets it at once" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var holder: ?Holder = null;
    const first = try acquireAs(io, tmp.dir, 1, "a", &holder);
    first.release(io);
    const second = try acquireAs(io, tmp.dir, 2, "b", &holder);
    second.release(io);
}

test "a lock file left behind by a dead server does not block, whatever it says" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    for ([_][]const u8{ "4242 hub\n", "", "\x00\xff garbage that is no line at all", "99999999999999 x\n" }) |left| {
        try tmp.dir.writeFile(io, .{ .sub_path = file_name, .data = left });
        var holder: ?Holder = null;
        const lock = try acquireAs(io, tmp.dir, 7, "pi", &holder);
        lock.release(io);
    }
}

test "a holder's line is information only: garbage names nobody, and nothing past a pid and a host is read" {
    try std.testing.expect(parseHolder("") == null);
    try std.testing.expect(parseHolder("\x00\xff") == null);
    try std.testing.expect(parseHolder("12a hub") == null);
    try std.testing.expect(parseHolder("12 hub extra") == null);
    try std.testing.expect(parseHolder("12 h\x1bub") == null);
    try std.testing.expect(parseHolder("99999999999 hub") == null);
    // A host one byte past the cap.
    try std.testing.expect(parseHolder("12 hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh") == null);
    const h = parseHolder("12 hub\nanything after the line").?;
    try std.testing.expectEqual(@as(u32, 12), h.pid);
    try std.testing.expectEqualStrings("hub", h.host());
}

test "a holder killed with SIGKILL leaves the folder free: the kernel drops its lock" {
    if (builtin.os.tag != .linux) return error.SkipZigTest;
    const io = std.testing.io;
    const linux = std.os.linux;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [Dir.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintSentinel(&path_buf, ".zig-cache/tmp/{s}/" ++ file_name, .{tmp.sub_path}, 0);

    const forked = linux.fork();
    if (forked == 0) {
        // The child of a threaded process: raw calls only, and it never returns
        // into the test runner. It takes the lock and waits to be killed, but
        // gives up by itself after a bounded sleep, so nothing can outlive the
        // test however the parent fails.
        const fd = linux.open(path, .{ .ACCMODE = .RDWR, .CREAT = true }, 0o644);
        if (linux.errno(fd) == .SUCCESS and linux.errno(linux.flock(@intCast(fd), std.posix.LOCK.EX)) == .SUCCESS) {
            const second: linux.timespec = .{ .sec = 1, .nsec = 0 };
            for (0..20) |_| _ = linux.nanosleep(&second, null);
        }
        linux.exit_group(0);
    }
    if (linux.errno(forked) != .SUCCESS) return error.SkipZigTest;
    const child: linux.pid_t = @intCast(forked);
    var reaped = false;
    defer if (!reaped) {
        _ = linux.kill(child, linux.SIG.KILL);
        var status: i32 = 0;
        _ = linux.waitpid(child, &status, 0);
    };

    // Until the child holds it, this taker gets it (and gives it back). A
    // deadline, not a spin: a child that cannot lock fails the test, and the
    // defer above kills and reaps it.
    var holder: ?Holder = null;
    const deadline = Io.Clock.awake.now(io).toMilliseconds() + 5_000;
    while (true) {
        if (acquireAs(io, tmp.dir, 1, "parent", &holder)) |l| l.release(io) else |e| {
            try std.testing.expectEqual(error.Locked, e);
            break;
        }
        if (Io.Clock.awake.now(io).toMilliseconds() > deadline) return error.ChildNeverHeldTheLock;
    }
    _ = linux.kill(child, linux.SIG.KILL);
    var status: i32 = 0;
    _ = linux.waitpid(child, &status, 0);
    reaped = true;
    const lock = try acquireAs(io, tmp.dir, 1, "parent", &holder);
    lock.release(io);
}
