//! Admission control (and the timing knobs) for the held SSE streams on
//! `GET /api/controlplane/events`.
//!
//! A held stream occupies a whole connection thread for its entire lifetime, so
//! it is the one endpoint on this server whose cost is measured in *connections*
//! rather than requests. One person with five browser tabs is five parked
//! threads; a forgotten dashboard on a spare laptop is another. That has to be
//! bounded, and bounded WITHOUT refusing: the handler degrades to the historical
//! one-shot frame when it cannot get a slot, so an over-cap client still learns
//! the current `syncVersion` and simply reconnects on the `retry:` interval — a
//! graceful poll. Refusing (503) would instead surface as a broken live channel.
//!
//! No allocation: the slot table is a fixed array, so there is nothing to free
//! and nothing that can leak across a shutdown. The mutex is `std.Io.Mutex`, the
//! same shape as `ratelimit.Limiter` and `download_tokens` — held only for the
//! few microseconds of the counting loop, never across I/O.

const std = @import("std");

/// Concurrent held streams across the whole server.
///
/// `config.max_connections` defaults to 96 and a held stream holds its slot for
/// the stream's whole life, so this is deliberately a small fraction of it: 16
/// leaves 80 connection slots for ordinary browsing AND for device sync, which
/// is the traffic that must never be crowded out. Household scale is one or two
/// people with a handful of tabs; at 8 the binding cap was a full third of a
/// dozen tabs silently degrading to polling, so 16 removes that first — and it
/// still fits `max_slots = 32`.
pub const default_max_total: u32 = 16;

/// Concurrent held streams for ONE user. Bounds a single person's tab count so
/// they cannot consume the global budget alone and lock the other household
/// member out of live updates. Four covers "library, reader, and two stale tabs";
/// the fifth degrades to polling, which is invisible in use.
pub const default_max_per_user: u32 = 4;

/// How often a held stream re-reads the caller's `syncVersion`.
///
/// CHANGE DETECTION IS POLLING, ON PURPOSE. The alternative — a condition
/// variable broadcast from the sync commit path — would mean touching the device
/// write path (`services/files.zig` / `handlers/device.zig`) to publish
/// notifications, adding a second synchronization protocol between the sync
/// transaction and these threads, and getting the "bump published after commit,
/// never before" ordering right. For a counter that changes a few times an hour
/// on a single-household server, this poll costs one indexed single-row SELECT
/// per stream per tick: at the caps above, 16 statements/second worst case, each
/// holding the global DB lock for microseconds. The latency it buys (<=500 ms to
/// see a synced note) is below the threshold where anyone would notice, and it
/// keeps the whole mechanism inside this one file.
pub const default_poll_interval_ms: i64 = 500;

/// How long a silent stream may stay silent before a `: ping` comment frame.
///
/// An idle SSE connection dies silently: a proxy or NAT reaps it, a laptop
/// sleeps, Wi-Fi drops — and NEITHER end finds out, because nothing is being
/// written. The server keeps a thread parked on a socket that will never carry
/// anything again, and the browser keeps an `EventSource` it believes is live.
/// The heartbeat makes death observable from both sides: the write fails on the
/// server (which then tears the stream down and frees the slot), and the browser
/// sees the connection error and reconnects. 15 s is comfortably under the
/// typical 30-60 s idle timeout of anything that might sit in front of this.
pub const default_heartbeat_ms: i64 = 15_000;

/// Hard lifetime of one held stream, after which the server ends the body
/// cleanly and the client reconnects.
///
/// A backstop, not a policy: it bounds the blast radius of anything that leaves
/// a stream parked that we did not anticipate (a half-open socket whose writes
/// keep succeeding into a kernel buffer, a client that vanished without a RST).
/// Ending the body is a *clean* end, so `EventSource` reopens after `retry:` and
/// the user sees nothing.
pub const default_max_lifetime_ms: i64 = 10 * 60 * 1000;

/// The `retry:` interval advertised to `EventSource`, in ms. Sent once, in the
/// first frame, on the held AND the degraded one-shot path — on the one-shot
/// path it is the entire freshness mechanism (the client reconnects every
/// `retry_ms` and each reconnect carries the current version), so it must stay
/// short enough to be a usable poll.
pub const retry_ms: u32 = 5_000;

/// Slot-table capacity. Bounds the number of DISTINCT users that may hold
/// streams at once; a user's repeat streams share one slot via its counter, and
/// `max_total` bounds the sum regardless. Sized to `config.max_connections`'
/// default so it can never be the binding constraint.
pub const max_slots: usize = 32;

pub const EventStreams = struct {
    /// Guards `slots`. Held only for the in-memory counting loop below — never
    /// across a DB read, a socket write or a sleep.
    mutex: std.Io.Mutex = .init,
    slots: [max_slots]Slot = @splat(.{}),

    max_total: u32 = default_max_total,
    max_per_user: u32 = default_max_per_user,
    poll_interval_ms: i64 = default_poll_interval_ms,
    heartbeat_ms: i64 = default_heartbeat_ms,
    max_lifetime_ms: i64 = default_max_lifetime_ms,

    /// One user's held-stream count. `held == 0` means the slot is free and
    /// `user_id` is meaningless.
    const Slot = struct { user_id: u64 = 0, held: u32 = 0 };

    /// Reserve a stream slot for `user_id`, or false when either cap is reached.
    ///
    /// On false the caller MUST degrade to the one-shot response (never refuse);
    /// on true it MUST `release` exactly once, on every exit path. The balance is
    /// the whole risk here — a missed release leaks a slot permanently, and the
    /// endpoint silently stops streaming for that user, which looks exactly like
    /// "the live channel is just a bit slow".
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
        const slot = free orelse return false; // more distinct users than slots
        slot.* = .{ .user_id = user_id, .held = 1 };
        return true;
    }

    /// Give a slot back. Exactly one per successful `tryAcquire`.
    pub fn release(self: *EventStreams, io: std.Io, user_id: u64) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        for (&self.slots) |*s| {
            if (s.held != 0 and s.user_id == user_id) {
                s.held -= 1;
                return;
            }
        }
        // No held slot for this user: a release with no matching acquire. This is
        // a slot-accounting bug, but aborting the whole server (in ReleaseSafe an
        // `unreachable` traps) over one leaked-in-the-other-direction stream is a
        // far worse failure than degrading — so it is a no-op here. Worst case the
        // affected user's live channel falls back to polling; every other stream
        // and the rest of the server keep running.
        std.log.debug("event_streams: release with no matching held slot for user {d}", .{user_id});
        return;
    }

    /// Total held streams. For tests and diagnostics.
    pub fn count(self: *EventStreams, io: std.Io) u32 {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        var total: u32 = 0;
        for (&self.slots) |*s| total += s.held;
        return total;
    }

    /// Held streams for one user. For tests and diagnostics.
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

    // A DIFFERENT user is unaffected — the per-user cap exists precisely so one
    // person's tabs cannot lock the rest of the household out.
    try std.testing.expect(s.tryAcquire(test_io, 2));
    try std.testing.expectEqual(@as(u32, 3), s.count(test_io));
    try std.testing.expectEqual(@as(u32, 2), s.countFor(test_io, 1));
    try std.testing.expectEqual(@as(u32, 1), s.countFor(test_io, 2));

    // Freeing one of user 1's re-admits exactly one.
    s.release(test_io, 1);
    try std.testing.expect(s.tryAcquire(test_io, 1));
    try std.testing.expect(!s.tryAcquire(test_io, 1));
}

test "EventStreams: the global cap binds before the per-user cap" {
    var s: EventStreams = .{ .max_total = 3, .max_per_user = 10 };
    for (0..3) |i| try std.testing.expect(s.tryAcquire(test_io, @intCast(i + 1)));
    // Every user is under its own cap, but the server is full.
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
    // The slot was returned to the free pool, not stranded on user 7.
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
    // The failure mode that matters is DRIFT: one missed release and the endpoint
    // quietly stops streaming forever. Churn it and assert the count returns to
    // zero every cycle, the same guard `ConnLimiter` carries.
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
