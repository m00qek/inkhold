//! Token-bucket rate limiting.
//!
//! Each key (a route + an IP or user identity) gets a bucket of `max` tokens
//! that refills at `max / window_s` tokens per second; every request spends one.
//! Empty bucket → the request is limited, with a Retry-After hint. Buckets are
//! created lazily and evicted when idle, keeping the table bounded (per the
//! 50 MB budget). A `std.Io.Mutex` guards the table so the threaded accept loop
//! (one OS thread per connection) can share a single Limiter safely; `take`
//! takes `io` to lock/unlock, mirroring `download_tokens`.

const std = @import("std");
const expiring = @import("../expiring.zig");

/// What a route's limit is keyed by.
pub const By = enum { ip, user, both };

/// A route's declarative rate-limit policy: at most `max` requests per
/// `window_s` seconds per key (`max` also being the burst capacity).
pub const RateLimit = struct {
    max: u32,
    window_s: u32,
    by: By,

    /// Refill rate in tokens per millisecond.
    pub fn refillPerMs(rl: RateLimit) f64 {
        return @as(f64, @floatFromInt(rl.max)) / (@as(f64, @floatFromInt(rl.window_s)) * 1000.0);
    }
};

pub const Error = std.mem.Allocator.Error;

const Bucket = struct { tokens: f64, cap: f64, last_ms: i64 };

/// Idle buckets older than this are reclaimed under memory pressure. Any sane
/// window refills fully well within an hour, so eviction is lossless (a
/// recreated bucket starts full — exactly a long-idle bucket's state).
const max_idle_ms: i64 = 60 * 60 * 1000;

pub const Limiter = struct {
    gpa: std.mem.Allocator,
    /// Guards `buckets` across the per-connection threads. Held only for the
    /// brief in-memory bucket math in `take`.
    mutex: std.Io.Mutex = .init,
    buckets: std.StringHashMapUnmanaged(Bucket) = .empty,
    /// Soft cap on tracked keys. Household scale never approaches it; it exists
    /// so a flood of distinct identities can't grow the table without bound.
    max_keys: usize = 10_000,

    pub fn init(gpa: std.mem.Allocator) Limiter {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *Limiter) void {
        var it = self.buckets.iterator();
        while (it.next()) |e| self.gpa.free(e.key_ptr.*);
        self.buckets.deinit(self.gpa);
    }

    /// Spend one token for `key`. Returns null if allowed, else the number of
    /// milliseconds until a token is available (the request is limited). `now_ms`
    /// is injected so the token-bucket math is deterministic and unit-testable.
    pub fn take(self: *Limiter, io: std.Io, key: []const u8, capacity: u32, refill_per_ms: f64, now_ms: i64) Error!?i64 {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const cap: f64 = @floatFromInt(capacity);

        // Bound the table: when full and this is a new key, reclaim idle buckets;
        // if still full, fail open (skip limiting this key) rather than grow.
        if (self.buckets.count() >= self.max_keys and !self.buckets.contains(key)) {
            self.evictStale(now_ms);
            if (self.buckets.count() >= self.max_keys and !self.buckets.contains(key)) return null;
        }

        const gop = try self.buckets.getOrPut(self.gpa, key);
        if (!gop.found_existing) {
            const owned = self.gpa.dupe(u8, key) catch |e| {
                _ = self.buckets.remove(key); // undo the half-inserted entry
                return e;
            };
            gop.key_ptr.* = owned;
            gop.value_ptr.* = .{ .tokens = cap, .cap = cap, .last_ms = now_ms };
        }

        const b = gop.value_ptr;
        if (now_ms > b.last_ms) {
            const elapsed: f64 = @floatFromInt(now_ms - b.last_ms);
            b.tokens = @min(b.cap, b.tokens + elapsed * refill_per_ms);
            b.last_ms = now_ms;
        }
        if (b.tokens >= 1.0) {
            b.tokens -= 1.0;
            return null;
        }
        const deficit = 1.0 - b.tokens;
        return @intFromFloat(@ceil(deficit / refill_per_ms));
    }

    /// Reclaim buckets untouched for `max_idle_ms` (best-effort, capped per call).
    fn evictStale(self: *Limiter, now_ms: i64) void {
        expiring.sweep(Bucket, self.gpa, &self.buckets, now_ms, struct {
            fn f(b: Bucket, now: i64) bool {
                return now - b.last_ms > max_idle_ms;
            }
        }.f);
    }
};

test "token bucket allows a burst up to capacity, then refills over time" {
    const io = std.testing.io;
    var lim = Limiter.init(std.testing.allocator);
    defer lim.deinit();

    const rl: RateLimit = .{ .max = 2, .window_s = 1, .by = .ip }; // 2 per second
    const rate = rl.refillPerMs(); // 0.002 tokens/ms

    // Burst of 2 at t=0 is allowed; the 3rd is limited.
    try std.testing.expect((try lim.take(io, "k", rl.max, rate, 0)) == null);
    try std.testing.expect((try lim.take(io, "k", rl.max, rate, 0)) == null);
    const retry = (try lim.take(io, "k", rl.max, rate, 0)).?;
    try std.testing.expectEqual(@as(i64, 500), retry); // 1 token / 0.002 = 500 ms

    // Still limited just before a token accrues; allowed once it does.
    try std.testing.expect((try lim.take(io, "k", rl.max, rate, 499)) != null);
    try std.testing.expect((try lim.take(io, "k", rl.max, rate, 500)) == null);

    // A different key has its own independent bucket.
    try std.testing.expect((try lim.take(io, "other", rl.max, rate, 0)) == null);
}

test "tokens never exceed capacity after a long idle" {
    const io = std.testing.io;
    var lim = Limiter.init(std.testing.allocator);
    defer lim.deinit();
    const rate = (RateLimit{ .max = 3, .window_s = 1, .by = .user }).refillPerMs();

    try std.testing.expect((try lim.take(io, "k", 3, rate, 0)) == null); // 3 -> 2
    // Long gap: refills to cap (3), not beyond — so only 3 immediate requests pass.
    try std.testing.expect((try lim.take(io, "k", 3, rate, 10_000)) == null); // 3 -> 2
    try std.testing.expect((try lim.take(io, "k", 3, rate, 10_000)) == null); // 2 -> 1
    try std.testing.expect((try lim.take(io, "k", 3, rate, 10_000)) == null); // 1 -> 0
    try std.testing.expect((try lim.take(io, "k", 3, rate, 10_000)) != null); // empty
}
