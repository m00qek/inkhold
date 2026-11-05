//! Per-route DB-window statistics: `db_lock` hold times and pooled-reader
//! windows, as fixed-size log-linear histograms.
//!
//! Counters are relaxed 32-bit atomics: pooled reads hold no lock, and ARMv6
//! (the Pi's ARM1176) has no 64-bit atomics, so `@atomicLoad(u64, …)` won't
//! compile there. Time totals are carried as seconds plus a nanosecond
//! remainder.

const std = @import("std");
const router = @import("router.zig");

/// One slot per route index plus a shared overflow slot.
pub const max_routes = 112;

/// Below this, timings are bucketed exactly (the log-linear scheme needs a
/// leading bit).
const linear_buckets = 16;

/// Sub-buckets per power of two: ~12.5% worst-case percentile error.
const sub_bits = 3;
const sub_count = 1 << sub_bits;

/// Highest octave tracked, 2^33 ns ≈ 8.6 s; slower lands in the top bucket.
/// 2^30 was too low: real p50s saturated at a misleading 2.147 s.
const max_octave = 33;
const min_octave = 4; // 2^4 = linear_buckets

const bucket_count = linear_buckets + (max_octave - min_octave + 1) * sub_count;

/// One route's accumulated DB windows, updated with relaxed atomics.
pub const Slot = struct {
    /// Samples recorded, one per DB window: a `manual_db_lock` or `read_only`
    /// route contributes several per request.
    count: u32 = 0,
    /// Cumulative window time as `total_s` seconds plus `total_ns_rem` ns.
    total_s: u32 = 0,
    total_ns_rem: u32 = 0,
    /// Largest sample in microseconds (`u32` ns would saturate at 4.29 s).
    max_us: u32 = 0,
    buckets: [bucket_count]u32 = @splat(0),

    // ---- reader-pool share ----

    /// How many of `count` ran on a pooled reader; subtracted in `totals`.
    read_count: u32 = 0,
    read_total_s: u32 = 0,
    read_total_ns_rem: u32 = 0,
    /// Time spent borrowing a reader. Near zero (`Pool.acquire` never waits);
    /// kept so a blocking acquire couldn't hide in the hold time.
    wait_total_s: u32 = 0,
    wait_total_ns_rem: u32 = 0,
    wait_max_us: u32 = 0,
    /// Reads that found the pool empty and used the writer: the signal to
    /// raise the pool size.
    fallback_count: u32 = 0,
};

/// `p.* +|= v`, atomically. Saturating: a wrapped counter reports a slow route
/// as fast.
fn satAdd(p: *u32, v: u32) void {
    var cur = @atomicLoad(u32, p, .monotonic);
    while (true) {
        cur = @cmpxchgWeak(u32, p, cur, cur +| v, .monotonic, .monotonic) orelse return;
    }
}

/// Adds `ns` to a carried (seconds, ns remainder) pair, exactly. The two
/// stores are independent, so a concurrent reader may see up to one second less.
fn addTime(secs: *u32, rem: *u32, ns: u64) void {
    satAdd(secs, @intCast(@min(ns / std.time.ns_per_s, std.math.maxInt(u32))));
    const add: u32 = @intCast(ns % std.time.ns_per_s);
    if (add == 0) return;
    var cur = @atomicLoad(u32, rem, .monotonic);
    while (true) {
        const next = cur +| add;
        const store: u32 = if (next >= std.time.ns_per_s) next - std.time.ns_per_s else next;
        cur = @cmpxchgWeak(u32, rem, cur, store, .monotonic, .monotonic) orelse {
            if (next >= std.time.ns_per_s) satAdd(secs, 1);
            return;
        };
    }
}

fn nsOf(secs: u32, rem: u32) u64 {
    return @as(u64, secs) * std.time.ns_per_s + rem;
}

/// Atomic load: writers hold no common lock.
fn load(p: *const u32) u32 {
    return @atomicLoad(u32, p, .monotonic);
}

fn atomicMax(p: *u32, v: u32) void {
    var cur = @atomicLoad(u32, p, .monotonic);
    while (cur < v) {
        cur = @cmpxchgWeak(u32, p, cur, v, .monotonic, .monotonic) orelse return;
    }
}

fn usFromNs(ns: u64) u32 {
    return @intCast(@min(ns / std.time.ns_per_us, std.math.maxInt(u32)));
}

pub const LockStats = struct {
    /// Indexed by route; `slots[max_routes]` is the overflow, also used when no
    /// route matched.
    slots: [max_routes + 1]Slot = @splat(.{}),

    /// One `db_lock` hold sample, recorded with the lock still held.
    pub fn record(self: *LockStats, route_idx: ?usize, ns: u64) void {
        _ = self.window(route_idx, ns);
    }

    /// One pooled-reader window plus its borrow cost; called with no lock held.
    pub fn recordRead(self: *LockStats, route_idx: ?usize, wait_ns: u64, hold_ns: u64) void {
        const s = self.window(route_idx, hold_ns);
        satAdd(&s.read_count, 1);
        addTime(&s.read_total_s, &s.read_total_ns_rem, hold_ns);
        addTime(&s.wait_total_s, &s.wait_total_ns_rem, wait_ns);
        atomicMax(&s.wait_max_us, usFromNs(wait_ns));
    }

    /// Counts a pool-empty fallback; its lock window is recorded by `record`.
    pub fn recordFallback(self: *LockStats, route_idx: ?usize) void {
        satAdd(&self.slotOf(route_idx).fallback_count, 1);
    }

    fn slotOf(self: *LockStats, route_idx: ?usize) *Slot {
        return &self.slots[if (route_idx) |r| @min(r, max_routes) else max_routes];
    }

    fn window(self: *LockStats, route_idx: ?usize, ns: u64) *Slot {
        const s = self.slotOf(route_idx);
        satAdd(&s.count, 1);
        addTime(&s.total_s, &s.total_ns_rem, ns);
        atomicMax(&s.max_us, usFromNs(ns));
        satAdd(&s.buckets[bucketOf(ns)], 1);
        return s;
    }

    /// Null for a never-called route, so it renders absent rather than as zeros.
    pub fn summarize(self: *const LockStats, route_idx: usize) ?Summary {
        const s = &self.slots[@min(route_idx, max_routes)];
        const count = load(&s.count);
        if (count == 0) return null;
        const max_ns = @as(u64, load(&s.max_us)) * std.time.ns_per_us;
        const total_ns = nsOf(load(&s.total_s), load(&s.total_ns_rem));
        return .{
            .count = count,
            .mean_ns = total_ns / count,
            // Clamped: a bucket's upper bound can exceed the real max.
            .p50_ns = @min(percentile(s, 50), max_ns),
            .p95_ns = @min(percentile(s, 95), max_ns),
            .max_ns = max_ns,
            .read_count = load(&s.read_count),
            .read_total_ns = nsOf(load(&s.read_total_s), load(&s.read_total_ns_rem)),
            .wait_total_ns = nsOf(load(&s.wait_total_s), load(&s.wait_total_ns_rem)),
            .wait_max_ns = @as(u64, load(&s.wait_max_us)) * std.time.ns_per_us,
            .fallback_count = load(&s.fallback_count),
        };
    }

    /// Total samples and time under the lock, across routes: the denominator
    /// of the ceiling arithmetic. Pooled-reader windows are subtracted since
    /// they occupy no lock.
    pub fn totals(self: *const LockStats) struct { count: u64, total_ns: u64 } {
        var count: u64 = 0;
        var total_ns: u64 = 0;
        for (&self.slots) |*s| {
            // Saturating: the independent loads can momentarily disagree.
            count += load(&s.count) -| load(&s.read_count);
            const all_ns = nsOf(load(&s.total_s), load(&s.total_ns_rem));
            const read_ns = nsOf(load(&s.read_total_s), load(&s.read_total_ns_rem));
            total_ns +|= all_ns -| read_ns;
        }
        return .{ .count = count, .total_ns = total_ns };
    }
};

/// One route's hold-time distribution, in nanoseconds.
pub const Summary = struct {
    count: u64,
    mean_ns: u64,
    /// Bucket upper bounds, so never optimistic.
    p50_ns: u64,
    p95_ns: u64,
    max_ns: u64,
    /// Reader-pool share. `read_count == 0` on a `read_only` route means it
    /// falls back every time.
    read_count: u64 = 0,
    read_total_ns: u64 = 0,
    wait_total_ns: u64 = 0,
    wait_max_ns: u64 = 0,
    fallback_count: u64 = 0,
};

/// Per-route health-endpoint row. `manual` says whether `count` counts
/// requests or windows.
pub const RouteReport = struct {
    method: []const u8,
    path: []const u8,
    manual: bool,
    /// With `reader_windows`, tells "no longer holds the lock" from "not called".
    read_only: bool,
    count: u64,
    mean_ns: u64,
    p50_ns: u64,
    p95_ns: u64,
    max_ns: u64,
    reader_windows: u64,
    reader_ns: u64,
    reader_fallbacks: u64,
    /// Longest single borrow; anything above microseconds means `acquire` blocks.
    reader_wait_max_ns: u64,
};

/// Fills `out` with a row per called route; returns the filled prefix.
pub fn report(
    stats: *const LockStats,
    routes: []const router.Route,
    out: []RouteReport,
) []RouteReport {
    var n: usize = 0;
    for (routes, 0..) |r, i| {
        if (n == out.len) break;
        const s = stats.summarize(i) orelse continue;
        out[n] = .{
            .method = @tagName(r.method),
            .path = r.path,
            .manual = r.manual_db_lock,
            .read_only = r.read_only,
            .count = s.count,
            .mean_ns = s.mean_ns,
            .p50_ns = s.p50_ns,
            .p95_ns = s.p95_ns,
            .max_ns = s.max_ns,
            .reader_windows = s.read_count,
            .reader_ns = s.read_total_ns,
            .reader_fallbacks = s.fallback_count,
            .reader_wait_max_ns = s.wait_max_ns,
        };
        n += 1;
    }
    return out[0..n];
}

/// Bucket index for a duration: exact below `linear_buckets`, then the octave
/// picks the block and the next `sub_bits` bits the sub-bucket.
fn bucketOf(ns: u64) usize {
    if (ns < linear_buckets) return @intCast(ns);
    const octave: u6 = @intCast(63 - @clz(ns));
    if (octave > max_octave) return bucket_count - 1;
    const sub: usize = @intCast((ns >> (octave - sub_bits)) & (sub_count - 1));
    return linear_buckets + (@as(usize, octave) - min_octave) * sub_count + sub;
}

/// The largest duration in `bucket`; percentiles report this.
fn bucketUpper(bucket: usize) u64 {
    if (bucket < linear_buckets) return bucket;
    const rel = bucket - linear_buckets;
    const octave: u6 = @intCast(min_octave + rel / sub_count);
    const sub: u64 = @intCast(rel % sub_count);
    return ((sub_count + sub + 1) << (octave - sub_bits)) - 1;
}

fn percentile(s: *const Slot, p: u64) u64 {
    // Ceiling rank, so p95 of 20 samples is the 20th, not the 19th.
    const target = (load(&s.count) * p + 99) / 100;
    var seen: u64 = 0;
    for (&s.buckets, 0..) |*c, i| {
        seen += @atomicLoad(u32, c, .monotonic);
        if (seen >= target) return bucketUpper(i);
    }
    return @as(u64, load(&s.max_us)) * std.time.ns_per_us;
}

// ---- tests ----

const testing = std.testing;

test "bucketOf/bucketUpper: every bucket contains what it claims to" {
    for (0..linear_buckets) |ns| {
        try testing.expectEqual(ns, bucketOf(ns));
        try testing.expectEqual(@as(u64, ns), bucketUpper(ns));
    }

    var ns: u64 = linear_buckets;
    var prev = bucketOf(linear_buckets - 1);
    while (ns < (@as(u64, 1) << 31)) : (ns = ns + 1 + ns / 7) {
        const b = bucketOf(ns);
        try testing.expect(b >= prev);
        try testing.expect(bucketUpper(b) >= ns);
        try testing.expect(bucketUpper(b) <= ns + ns / sub_count + sub_count);
        prev = b;
    }

    try testing.expectEqual(bucket_count - 1, bucketOf(std.math.maxInt(u64)));
}

test "summarize: percentiles track the distribution, and an untouched route is absent" {
    var stats: LockStats = .{};
    try testing.expectEqual(@as(?Summary, null), stats.summarize(3));

    for (0..99) |_| stats.record(3, 1_000);
    stats.record(3, 1_000_000);

    const s = stats.summarize(3).?;
    try testing.expectEqual(@as(u64, 100), s.count);
    try testing.expect(s.mean_ns > 10_000);
    try testing.expect(s.p50_ns >= 1_000 and s.p50_ns < 1_200);
    try testing.expect(s.p95_ns >= 1_000 and s.p95_ns < 1_200);
    try testing.expectEqual(@as(u64, 1_000_000), s.max_ns);

    // The max is stored in whole microseconds, hence 2 us rather than 1.5.
    var one: LockStats = .{};
    one.record(9, 2_000);
    const s1 = one.summarize(9).?;
    try testing.expectEqual(@as(u64, 2_000), s1.max_ns);
    try testing.expect(s1.p95_ns <= s1.max_ns);

    try testing.expectEqual(@as(?Summary, null), stats.summarize(4));
}

test "record: a route index past the table lands in the overflow slot, not out of bounds" {
    var stats: LockStats = .{};
    stats.record(max_routes + 500, 42);
    stats.record(null, 42);
    try testing.expectEqual(@as(u64, 2), stats.slots[max_routes].count);
}

test "totals: the aggregate is the denominator of the ceiling arithmetic" {
    var stats: LockStats = .{};
    stats.record(0, 100);
    stats.record(1, 300);
    const t = stats.totals();
    try testing.expectEqual(@as(u64, 2), t.count);
    try testing.expectEqual(@as(u64, 400), t.total_ns);
}

test "report: names only the routes that ran, and carries their lock policy" {
    const noop = struct {
        fn h(_: *@import("context.zig").Context, _: *router.Request, _: router.Params) anyerror!void {}
    }.h;
    const routes = [_]router.Route{
        .{ .method = .GET, .path = "/a", .scopes = &.{.public}, .handler = noop },
        .{ .method = .POST, .path = "/b", .scopes = &.{.public}, .handler = noop, .manual_db_lock = true },
        .{ .method = .GET, .path = "/c", .scopes = &.{.public}, .handler = noop },
    };

    var stats: LockStats = .{};
    stats.record(0, 500);
    stats.record(1, 700);
    stats.record(1, 900);

    var buf: [max_routes]RouteReport = undefined;
    const rows = report(&stats, &routes, &buf);

    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("/a", rows[0].path);
    try testing.expect(!rows[0].manual);
    try testing.expectEqualStrings("/b", rows[1].path);
    try testing.expectEqualStrings("POST", rows[1].method);
    try testing.expect(rows[1].manual);
    try testing.expectEqual(@as(u64, 2), rows[1].count);
    try testing.expectEqual(@as(u64, 800), rows[1].mean_ns);
}

test "the table stays inside the RSS budget it is allowed to spend" {
    // Must stay a rounding error against the ~50 MB RSS target.
    try testing.expect(@sizeOf(LockStats) < 128 * 1024);
}
