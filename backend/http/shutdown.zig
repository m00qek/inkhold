//! Stopping on SIGTERM (a container stop, systemd) or SIGINT (Ctrl-C).
//!
//! In a container the server is PID 1, and the kernel gives PID 1 no default
//! action for SIGTERM: without a handler the signal is ignored and the runtime
//! kills the process after its timeout. So the server waits for the signal on
//! a thread of its own (blocked in every other thread, taken with sigwait), and
//! then stops properly: no new requests, the ones in flight given a moment to
//! finish, the database lock taken so no transaction is mid-way, the WAL
//! checkpointed, exit 0. SQLite and the blob store would survive a kill at any
//! instant; this is about stopping promptly and leaving a tidy database.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;

/// How long requests in flight get to finish: well inside the 10 s a container
/// runtime waits before it sends SIGKILL.
pub const grace_ms: i64 = 5000;

const is_linux = builtin.os.tag == .linux;

fn stopSet() std.os.linux.sigset_t {
    const linux = std.os.linux;
    var set = linux.sigemptyset();
    linux.sigaddset(&set, .TERM);
    linux.sigaddset(&set, .INT);
    return set;
}

/// Blocks SIGTERM and SIGINT in the calling thread and in every thread it
/// spawns afterwards. Call first, before any thread exists, so the signal can
/// only be taken by `waitStopSignal`.
pub fn blockStopSignals() void {
    if (!is_linux) return;
    const set = stopSet();
    _ = std.os.linux.sigprocmask(std.os.linux.SIG.BLOCK, &set, null);
}

/// Blocks until SIGTERM or SIGINT arrives; returns which.
pub fn waitStopSignal() std.os.linux.SIG {
    const linux = std.os.linux;
    const set = stopSet();
    while (true) {
        const rc = linux.syscall4(.rt_sigtimedwait, @intFromPtr(&set), 0, 0, @sizeOf(linux.sigset_t));
        switch (linux.errno(rc)) {
            .SUCCESS => return @fromBackingInt(@intCast(@as(u32, @intCast(rc)))),
            else => continue, // EINTR, or a signal outside the set
        }
    }
}

/// Waits until `busy` is zero or `grace_ms` passes; true when it went idle.
pub fn waitIdle(io: Io, busy: *const std.atomic.Value(u32), limit_ms: i64) bool {
    const start = Io.Clock.awake.now(io).toMilliseconds();
    while (busy.load(.acquire) != 0) {
        if (Io.Clock.awake.now(io).toMilliseconds() - start >= limit_ms) return false;
        io.sleep(.fromMilliseconds(20), .awake) catch {};
    }
    return true;
}

// ---- tests ----

const testing = std.testing;

test "waitIdle returns at once when nothing is in flight, and gives up at its limit" {
    var busy: std.atomic.Value(u32) = .init(0);
    try testing.expect(waitIdle(testing.io, &busy, 1000));
    busy.store(1, .release);
    const t0 = Io.Clock.awake.now(testing.io).toMilliseconds();
    try testing.expect(!waitIdle(testing.io, &busy, 60));
    try testing.expect(Io.Clock.awake.now(testing.io).toMilliseconds() - t0 >= 60);
}

test "waitIdle sees work finish" {
    var busy: std.atomic.Value(u32) = .init(1);
    const t = try std.Thread.spawn(.{}, struct {
        fn run(b: *std.atomic.Value(u32)) void {
            testing.io.sleep(.fromMilliseconds(40), .awake) catch {};
            b.store(0, .release);
        }
    }.run, .{&busy});
    defer t.join();
    try testing.expect(waitIdle(testing.io, &busy, 5000));
}
