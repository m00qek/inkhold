//! A backup is never in a hurry. It lowers its own CPU and I/O priority, so a
//! person on cron need not know `nice` exists, and it reads at a bounded rate,
//! because the idle I/O class is ignored by the schedulers SD cards often use.
//! On a one-core Pi this is what keeps a sync from the tablet responsive while
//! a backup runs.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;

/// The default `--max-rate`, bytes per second of source read.
pub const default_rate: u64 = 4 * 1024 * 1024;

/// Lowest CPU priority (nice 19) and the idle I/O class, for this process.
/// Best effort: a refusal (a container without the capability) changes nothing.
pub fn lowerPriority() void {
    if (builtin.os.tag != .linux) return;
    const linux = std.os.linux;
    const prio_process = 0; // PRIO_PROCESS, the calling process
    _ = linux.syscall3(.setpriority, prio_process, 0, 19);
    const ioprio_who_process = 1;
    const ioprio_class_idle = 3;
    const ioprio_class_shift = 13;
    _ = linux.syscall3(.ioprio_set, ioprio_who_process, 0, ioprio_class_idle << ioprio_class_shift);
}

/// Paces reads to `rate` bytes per second; `rate == 0` is unlimited.
pub const Pace = struct {
    rate: u64,
    start_ns: i96 = 0,
    bytes: u64 = 0,

    pub fn init(io: Io, rate: u64) Pace {
        return .{ .rate = rate, .start_ns = Io.Clock.awake.now(io).nanoseconds };
    }

    /// Accounts `n` bytes just read and sleeps if we are ahead of the rate.
    pub fn take(self: *Pace, io: Io, n: usize) void {
        if (self.rate == 0) return;
        self.bytes += n;
        const elapsed: u64 = @intCast(@max(Io.Clock.awake.now(io).nanoseconds - self.start_ns, 0));
        const wait = delayNs(self.bytes, self.rate, elapsed);
        if (wait > 0) io.sleep(.fromNanoseconds(@intCast(wait)), .awake) catch {};
    }
};

/// How far ahead of `rate` the reader is after `bytes` in `elapsed_ns`.
pub fn delayNs(bytes: u64, rate: u64, elapsed_ns: u64) u64 {
    if (rate == 0) return 0;
    const due_ns: u128 = @as(u128, bytes) * std.time.ns_per_s / rate;
    return if (due_ns > elapsed_ns) @intCast(due_ns - elapsed_ns) else 0;
}

// ---- tests ----

const testing = std.testing;

test "the pace sleeps only when a reader is ahead of its rate" {
    const mib = 1024 * 1024;
    // 4 MiB at 4 MiB/s is due at one second.
    try testing.expectEqual(@as(u64, std.time.ns_per_s), delayNs(4 * mib, 4 * mib, 0));
    try testing.expectEqual(@as(u64, std.time.ns_per_s / 2), delayNs(4 * mib, 4 * mib, std.time.ns_per_s / 2));
    try testing.expectEqual(@as(u64, 0), delayNs(4 * mib, 4 * mib, 2 * std.time.ns_per_s));
    // Unlimited never waits.
    try testing.expectEqual(@as(u64, 0), delayNs(1 << 40, 0, 0));
}
