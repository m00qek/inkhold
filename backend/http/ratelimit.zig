//! Token-bucket rate limiting, one bucket per key (route + IP or user),
//! created lazily and evicted when idle so the table stays bounded.

const std = @import("std");
const expiring = @import("../expiring.zig");

pub const By = enum { ip, user, both };

/// At most `max` requests per `window_s` seconds per key; `max` is also the burst.
pub const RateLimit = struct {
    max: u32,
    window_s: u32,
    by: By,

    pub fn refillPerMs(rl: RateLimit) f64 {
        return @as(f64, @floatFromInt(rl.max)) / (@as(f64, @floatFromInt(rl.window_s)) * 1000.0);
    }
};

pub const Error = std.mem.Allocator.Error;

const Bucket = struct { tokens: f64, cap: f64, last_ms: i64 };

/// Idle buckets older than this are reclaimed under pressure. Lossless: any
/// sane window has refilled fully by then, and a new bucket starts full.
const max_idle_ms: i64 = 60 * 60 * 1000;

pub const Limiter = struct {
    gpa: std.mem.Allocator,
    /// Held only for the in-memory bucket math in `take`.
    mutex: std.Io.Mutex = .init,
    buckets: std.StringHashMapUnmanaged(Bucket) = .empty,
    /// Soft cap on tracked keys, so a flood of identities can't grow the table.
    max_keys: usize = 10_000,

    pub fn init(gpa: std.mem.Allocator) Limiter {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *Limiter) void {
        var it = self.buckets.iterator();
        while (it.next()) |e| self.gpa.free(e.key_ptr.*);
        self.buckets.deinit(self.gpa);
    }

    /// Spends one token for `key`. Null if allowed, else milliseconds until a
    /// token is available.
    pub fn take(self: *Limiter, io: std.Io, key: []const u8, capacity: u32, refill_per_ms: f64, now_ms: i64) Error!?i64 {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const cap: f64 = @floatFromInt(capacity);

        // Full and a new key: reclaim idle buckets; if still full, fail open
        // rather than grow.
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

    try std.testing.expect((try lim.take(io, "k", rl.max, rate, 0)) == null);
    try std.testing.expect((try lim.take(io, "k", rl.max, rate, 0)) == null);
    const retry = (try lim.take(io, "k", rl.max, rate, 0)).?;
    try std.testing.expectEqual(@as(i64, 500), retry); // 1 token / 0.002 = 500 ms

    try std.testing.expect((try lim.take(io, "k", rl.max, rate, 499)) != null);
    try std.testing.expect((try lim.take(io, "k", rl.max, rate, 500)) == null);

    try std.testing.expect((try lim.take(io, "other", rl.max, rate, 0)) == null);
}

test "tokens never exceed capacity after a long idle" {
    const io = std.testing.io;
    var lim = Limiter.init(std.testing.allocator);
    defer lim.deinit();
    const rate = (RateLimit{ .max = 3, .window_s = 1, .by = .user }).refillPerMs();

    try std.testing.expect((try lim.take(io, "k", 3, rate, 0)) == null); // 3 -> 2
    try std.testing.expect((try lim.take(io, "k", 3, rate, 10_000)) == null); // 3 -> 2
    try std.testing.expect((try lim.take(io, "k", 3, rate, 10_000)) == null); // 2 -> 1
    try std.testing.expect((try lim.take(io, "k", 3, rate, 10_000)) == null); // 1 -> 0
    try std.testing.expect((try lim.take(io, "k", 3, rate, 10_000)) != null); // empty
}
