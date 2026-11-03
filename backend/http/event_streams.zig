//! Admission control and timing knobs for the held SSE streams on
//! `GET /api/controlplane/events`. An over-cap client is never refused: it gets
//! the one-shot frame and reconnects on `retry:`, a graceful poll.

const std = @import("std");

/// Concurrent held streams server-wide; a small share of `max_connections`
/// (96) so device sync is never crowded out.
pub const default_max_total: u32 = 16;

/// Concurrent held streams per user, so one person's tabs can't take the
/// global budget.
pub const default_max_per_user: u32 = 4;

/// How often a held stream re-reads `syncVersion`. Polling, deliberately: one
/// indexed SELECT per tick avoids a notification protocol on the sync commit path.
pub const default_poll_interval_ms: i64 = 500;

/// Silence before a `: ping` frame. Idle SSE connections die unnoticed (NAT,
/// sleep); the write makes death observable on both ends. Under typical
/// 30-60 s proxy idle timeouts.
pub const default_heartbeat_ms: i64 = 15_000;

/// Hard lifetime of one held stream, a backstop against half-open sockets.
/// Ending cleanly makes `EventSource` reopen after `retry:` invisibly.
pub const default_max_lifetime_ms: i64 = 10 * 60 * 1000;

/// The `retry:` interval in ms. On the one-shot path it is the entire
/// freshness mechanism, so keep it short.
pub const retry_ms: u32 = 5_000;

/// Slot-table capacity: distinct users holding streams at once.
pub const max_slots: usize = 32;

pub const EventStreams = struct {
    /// Held only for the counting loop, never across I/O.
    mutex: std.Io.Mutex = .init,
    slots: [max_slots]Slot = @splat(.{}),

    max_total: u32 = default_max_total,
    max_per_user: u32 = default_max_per_user,
    poll_interval_ms: i64 = default_poll_interval_ms,
    heartbeat_ms: i64 = default_heartbeat_ms,
    max_lifetime_ms: i64 = default_max_lifetime_ms,

    /// `held == 0` means free.
    const Slot = struct { user_id: u64 = 0, held: u32 = 0 };

    /// Reserves a stream slot for `user_id`, or false at either cap. On false
    /// the caller degrades to one-shot; on true it must `release` exactly once
    /// on every path, or the slot leaks and that user silently stops streaming.
    pub fn tryAcquire(self: *EventStreams, io: std.Io, user_id: u64) bool {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);

        var total: u32 = 0;
        var mine: ?*Slot = null;
        var free: ?*Slot = null;
        for (&self.slots) |*s| {
            if (s.held == 0) {
                if (free == null) free = s;
                continue;
            }
            total += s.held;
            if (s.user_id == user_id) mine = s;
        }

        if (total >= self.max_total) return false;
        if (mine) |m| {
            if (m.held >= self.max_per_user) return false;
            m.held += 1;
            return true;
        }
        if (self.max_per_user == 0) return false;
        const slot = free orelse return false;
        slot.* = .{ .user_id = user_id, .held = 1 };
        return true;
    }

    pub fn release(self: *EventStreams, io: std.Io, user_id: u64) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        for (&self.slots) |*s| {
            if (s.held != 0 and s.user_id == user_id) {
                s.held -= 1;
                return;
            }
        }
        // Unmatched release: an accounting bug, but logged rather than trapped,
        // since aborting the server is worse than one user falling back to polling.
        std.log.debug("event_streams: release with no matching held slot for user {d}", .{user_id});
        return;
    }

    pub fn count(self: *EventStreams, io: std.Io) u32 {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        var total: u32 = 0;
        for (&self.slots) |*s| total += s.held;
        return total;
    }

    pub fn countFor(self: *EventStreams, io: std.Io, user_id: u64) u32 {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        for (&self.slots) |*s| {
            if (s.held != 0 and s.user_id == user_id) return s.held;
        }
        return 0;
    }
};

const test_io = std.testing.io;

test "EventStreams: admits up to the per-user cap, then refuses that user only" {
    var s: EventStreams = .{ .max_total = 8, .max_per_user = 2 };

    try std.testing.expect(s.tryAcquire(test_io, 1));
    try std.testing.expect(s.tryAcquire(test_io, 1));
    try std.testing.expect(!s.tryAcquire(test_io, 1)); // user 1 is at its cap

    try std.testing.expect(s.tryAcquire(test_io, 2));
    try std.testing.expectEqual(@as(u32, 3), s.count(test_io));
    try std.testing.expectEqual(@as(u32, 2), s.countFor(test_io, 1));
    try std.testing.expectEqual(@as(u32, 1), s.countFor(test_io, 2));

    s.release(test_io, 1);
    try std.testing.expect(s.tryAcquire(test_io, 1));
    try std.testing.expect(!s.tryAcquire(test_io, 1));
}

test "EventStreams: the global cap binds before the per-user cap" {
    var s: EventStreams = .{ .max_total = 3, .max_per_user = 10 };
    for (0..3) |i| try std.testing.expect(s.tryAcquire(test_io, @intCast(i + 1)));
    for (1..5) |i| try std.testing.expect(!s.tryAcquire(test_io, @intCast(i)));
    try std.testing.expectEqual(@as(u32, 3), s.count(test_io));
}

test "EventStreams: balances back to zero and re-offers full capacity" {
    var s: EventStreams = .{ .max_total = 4, .max_per_user = 4 };
    for (0..4) |_| try std.testing.expect(s.tryAcquire(test_io, 7));
    try std.testing.expect(!s.tryAcquire(test_io, 7));
    for (0..4) |_| s.release(test_io, 7);

    try std.testing.expectEqual(@as(u32, 0), s.count(test_io));
    try std.testing.expectEqual(@as(u32, 0), s.countFor(test_io, 7));
    for (0..4) |i| try std.testing.expect(s.tryAcquire(test_io, @intCast(i + 1)));
    for (0..4) |i| s.release(test_io, @intCast(i + 1));
    try std.testing.expectEqual(@as(u32, 0), s.count(test_io));
}

test "EventStreams: a zero cap refuses everything without underflowing" {
    var zero_total: EventStreams = .{ .max_total = 0, .max_per_user = 4 };
    try std.testing.expect(!zero_total.tryAcquire(test_io, 1));
    try std.testing.expectEqual(@as(u32, 0), zero_total.count(test_io));

    var zero_user: EventStreams = .{ .max_total = 4, .max_per_user = 0 };
    try std.testing.expect(!zero_user.tryAcquire(test_io, 1));
    try std.testing.expectEqual(@as(u32, 0), zero_user.count(test_io));
}

test "EventStreams: acquire/release balance survives interleaved churn" {
    var s: EventStreams = .{ .max_total = 6, .max_per_user = 3 };
    for (0..200) |i| {
        const user: u64 = @intCast((i % 3) + 1);
        try std.testing.expect(s.tryAcquire(test_io, user));
        try std.testing.expect(s.tryAcquire(test_io, user));
        s.release(test_io, user);
        s.release(test_io, user);
        try std.testing.expectEqual(@as(u32, 0), s.count(test_io));
    }
}
