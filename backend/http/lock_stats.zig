//! Per-route hold-time statistics for the one global `db_lock`.
//!
//! The server serializes every DB touch behind a single mutex (see
//! `transport.dispatchLocked`), so the sustained request ceiling of the whole
//! process is `1 / mean_hold_time` — one number, set by whichever route holds the
//! lock longest. That makes the hold time the most load-bearing figure in the
//! system and the one nobody can estimate: a folder listing and a library-wide
//! FTS search differ by orders of magnitude, and a global mean hides the route
//! that actually sets the ceiling. Hence per-route attribution.
//!
//! ## Why this costs nothing, and why that is not an accident
//!
//! **Every write here happens while `db_lock` is already held.** `record` is
//! called from inside the critical section, just before the unlock — so the
//! mutual exclusion these counters need is the exclusion the caller is already
//! paying for. No atomics, no second mutex, no sharding. A stats table with a
//! lock of its own would serialize on precisely the thing being measured and
//! would report its own contention as the server's.
//!
//! That invariant is the whole safety argument for the plain (non-atomic) fields
//! below, so it is not negotiable: **`record` may only be called with `db_lock`
//! held**. `Context.unlockDb` is the single call site, which is what keeps it
//! true — it records and *then* unlocks. Reads (`summarize`) run from the health
//! handler, which is an ordinary whole-handler-locked route, so it reads under
//! the same lock.
//!
//! ## Why a histogram and not a sample log
//!
//! p50/p95 need a distribution, and the ~50 MB RSS budget rules out keeping
//! samples. Each route gets a fixed-size log-linear histogram (see `bucketOf`):
//! ~1 KB per route, ~62 KB total, independent of how long the server runs and of
//! how many requests it serves. The cost is resolution — a percentile is
//! reported as its bucket's upper bound, so it is accurate to ~12.5% above 16 ns
//! and exact below it. For a figure whose interesting range spans microseconds
//! to seconds, 12.5% is far below the noise.

const std = @import("std");
const router = @import("router.zig");

/// Slots in the table: one per route index, plus one shared overflow slot.
///
/// Sized with headroom over the live route table (see the pin in `routes.zig`'s
/// test); a table that outgrows this degrades to lumping the excess into the
/// overflow slot rather than misattributing or crashing.
pub const max_routes = 96;

/// Buckets below which timings are recorded exactly, one bucket per nanosecond.
/// A lock window can genuinely be single-digit nanoseconds (a no-op branch), and
/// the log-linear scheme below is undefined for values with no leading bit to
/// index off.
const linear_buckets = 16;

/// Sub-buckets per power of two: 8 gives ~12.5% worst-case relative error on a
/// reported percentile.
const sub_bits = 3;
const sub_count = 1 << sub_bits;

/// Highest power-of-two octave tracked, 2^33 ns ≈ 8.6 s. Anything slower lands in
/// the top bucket — a lock held for over eight seconds is a catastrophe whose
/// exact magnitude does not change the conclusion.
///
/// It was 2^30 and that was too low: the first run against a real corpus pinned
/// a route's p50 AND p95 to the top bucket, which reports as a suspiciously round
/// 2.147 s and hides how bad the tail actually is. A saturating histogram must
/// saturate somewhere nothing real lives.
const max_octave = 33;
const min_octave = 4; // 2^4 = 16 = linear_buckets

const bucket_count = linear_buckets + (max_octave - min_octave + 1) * sub_count;

/// One route's accumulated hold times. Plain fields, no atomics — see the
/// module header: every write happens under `db_lock`.
pub const Slot = struct {
    /// Samples recorded. **A sample is one LOCK WINDOW, not one request.** They
    /// are the same thing for an ordinary route (the lock spans the whole
    /// handler), but a `manual_db_lock` route contributes several short windows
    /// per request — the `resolveCaller` session read plus each of the handler's
    /// own bracketed DB touches. That is deliberate: what contends is a window,
    /// and the claim those routes make ("the windows are short") is a claim about
    /// windows.
    count: u64 = 0,
    total_ns: u64 = 0,
    max_ns: u64 = 0,
    buckets: [bucket_count]u32 = @splat(0),
};

pub const LockStats = struct {
    /// Indexed by route index; `slots[max_routes]` is the overflow slot shared by
    /// any route beyond the table (and by lock windows taken with no route
    /// matched, e.g. a 404's `resolveCaller`).
    slots: [max_routes + 1]Slot = @splat(.{}),

    /// Add one lock-window sample. **Caller must hold `db_lock`.**
    pub fn record(self: *LockStats, route_idx: ?usize, ns: u64) void {
        const i = if (route_idx) |r| @min(r, max_routes) else max_routes;
        const s = &self.slots[i];
        s.count += 1;
        s.total_ns +|= ns;
        if (ns > s.max_ns) s.max_ns = ns;
        s.buckets[bucketOf(ns)] +|= 1;
    }

    /// A route's summary, or null when it has never been called — an untouched
    /// route must render as absent rather than as a row of zeros, which would
    /// read as "measured, and fast".
    pub fn summarize(self: *const LockStats, route_idx: usize) ?Summary {
        const s = &self.slots[@min(route_idx, max_routes)];
        if (s.count == 0) return null;
        return .{
            .count = s.count,
            .mean_ns = s.total_ns / s.count,
            // Clamped to the exact max: a bucket's upper bound can exceed the
            // largest sample actually seen, and "p95 = 90 us, max = 89 us" reads
            // as a bug in the table rather than as bucket rounding.
            .p50_ns = @min(percentile(s, 50), s.max_ns),
            .p95_ns = @min(percentile(s, 95), s.max_ns),
            .max_ns = s.max_ns,
        };
    }

    /// Total samples and total time under the lock, across every route. The
    /// denominator of the ceiling arithmetic: the lock is one resource, so the
    /// aggregate occupancy is what says how much of it is left.
    pub fn totals(self: *const LockStats) struct { count: u64, total_ns: u64 } {
        var count: u64 = 0;
        var total_ns: u64 = 0;
        for (&self.slots) |*s| {
            count += s.count;
            total_ns +|= s.total_ns;
        }
        return .{ .count = count, .total_ns = total_ns };
    }
};

/// One route's hold-time distribution, as the health endpoint reports it.
/// Nanoseconds throughout: the interesting range spans four orders of magnitude,
/// and rounding a 40 µs window to milliseconds would report it as zero.
pub const Summary = struct {
    count: u64,
    mean_ns: u64,
    /// Bucket upper bounds, so a percentile is an over-estimate by at most the
    /// bucket width (~12.5%) and never flatters the server.
    p50_ns: u64,
    p95_ns: u64,
    max_ns: u64,
};

/// The JSON shape the health endpoint emits per route: the summary plus the
/// identity needed to read it. `manual` is not decoration — it says whether
/// `count` counts requests or windows (see `Slot.count`).
pub const RouteReport = struct {
    method: []const u8,
    path: []const u8,
    manual: bool,
    count: u64,
    mean_ns: u64,
    p50_ns: u64,
    p95_ns: u64,
    max_ns: u64,
};

/// Fills `out` with a report row per route that has been called at least once,
/// and returns the filled prefix. Caller supplies the buffer, so this allocates
/// nothing on a request path.
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
            .count = s.count,
            .mean_ns = s.mean_ns,
            .p50_ns = s.p50_ns,
            .p95_ns = s.p95_ns,
            .max_ns = s.max_ns,
        };
        n += 1;
    }
    return out[0..n];
}

/// Bucket index for a nanosecond duration. Exact below `linear_buckets`, then
/// log-linear: the octave picks the block, the `sub_bits` bits below the leading
/// bit pick the sub-bucket within it.
fn bucketOf(ns: u64) usize {
    if (ns < linear_buckets) return @intCast(ns);
    const octave: u6 = @intCast(63 - @clz(ns));
    if (octave > max_octave) return bucket_count - 1;
    const sub: usize = @intCast((ns >> (octave - sub_bits)) & (sub_count - 1));
    return linear_buckets + (@as(usize, octave) - min_octave) * sub_count + sub;
}

/// The largest duration that lands in `bucket`. Percentiles are reported as this,
/// so the answer is never optimistic.
fn bucketUpper(bucket: usize) u64 {
    if (bucket < linear_buckets) return bucket;
    const rel = bucket - linear_buckets;
    const octave: u6 = @intCast(min_octave + rel / sub_count);
    const sub: u64 = @intCast(rel % sub_count);
    return ((sub_count + sub + 1) << (octave - sub_bits)) - 1;
}

/// The `p`-th percentile of `s`'s distribution, as a bucket upper bound.
fn percentile(s: *const Slot, p: u64) u64 {
    // Ceiling rank: the smallest bucket whose cumulative count reaches p% of the
    // samples. Floor would let p95 of 20 samples land on the 19th, which is p95's
    // whole point missed by one.
    const target = (s.count * p + 99) / 100;
    var seen: u64 = 0;
    for (&s.buckets, 0..) |c, i| {
        seen += c;
        if (seen >= target) return bucketUpper(i);
    }
    return s.max_ns;
}

// ---- tests ----

const testing = std.testing;

test "bucketOf/bucketUpper: every bucket contains what it claims to" {
    // Exact region: one bucket per nanosecond, and its upper bound is itself.
    for (0..linear_buckets) |ns| {
        try testing.expectEqual(ns, bucketOf(ns));
        try testing.expectEqual(@as(u64, ns), bucketUpper(ns));
    }

    // Log-linear region: a value's own bucket must not claim an upper bound below
    // it, and buckets must stay monotonic — the two properties percentile()
    // relies on.
    var ns: u64 = linear_buckets;
    var prev = bucketOf(linear_buckets - 1);
    while (ns < (@as(u64, 1) << 31)) : (ns = ns + 1 + ns / 7) {
        const b = bucketOf(ns);
        try testing.expect(b >= prev);
        try testing.expect(bucketUpper(b) >= ns);
        // Resolution claim: never worse than 1/sub_count above the value.
        try testing.expect(bucketUpper(b) <= ns + ns / sub_count + sub_count);
        prev = b;
    }

    // Beyond the top octave everything saturates rather than indexing out.
    try testing.expectEqual(bucket_count - 1, bucketOf(std.math.maxInt(u64)));
}

test "summarize: percentiles track the distribution, and an untouched route is absent" {
    var stats: LockStats = .{};
    try testing.expectEqual(@as(?Summary, null), stats.summarize(3));

    // 99 samples at ~1 µs and 1 at ~1 ms: the mean is dragged, p50 is not, and
    // p95 stays with the body. This is exactly the shape a slow route hides in.
    for (0..99) |_| stats.record(3, 1_000);
    stats.record(3, 1_000_000);

    const s = stats.summarize(3).?;
    try testing.expectEqual(@as(u64, 100), s.count);
    try testing.expect(s.mean_ns > 10_000); // the outlier moved it an order of magnitude
    try testing.expect(s.p50_ns >= 1_000 and s.p50_ns < 1_200);
    try testing.expect(s.p95_ns >= 1_000 and s.p95_ns < 1_200);
    try testing.expectEqual(@as(u64, 1_000_000), s.max_ns); // max is exact, not bucketed

    // A percentile never reads above the largest sample: bucket rounding must not
    // produce a p95 that exceeds a max the same table is reporting.
    var one: LockStats = .{};
    one.record(9, 1_500);
    const s1 = one.summarize(9).?;
    try testing.expectEqual(@as(u64, 1_500), s1.max_ns);
    try testing.expect(s1.p95_ns <= s1.max_ns);

    // A different slot is untouched and stays that way.
    try testing.expectEqual(@as(?Summary, null), stats.summarize(4));
}

test "record: a route index past the table lands in the overflow slot, not out of bounds" {
    var stats: LockStats = .{};
    stats.record(max_routes + 500, 42);
    stats.record(null, 42); // no route matched
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

    // `/c` never ran, so it is absent — not a zero row, which would read as
    // "measured, and free".
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("/a", rows[0].path);
    try testing.expect(!rows[0].manual);
    try testing.expectEqualStrings("/b", rows[1].path);
    try testing.expectEqualStrings("POST", rows[1].method);
    // `manual` travels with the row because it says what `count` counts: windows
    // for a manual route, requests for every other one.
    try testing.expect(rows[1].manual);
    try testing.expectEqual(@as(u64, 2), rows[1].count);
    try testing.expectEqual(@as(u64, 800), rows[1].mean_ns);
}

test "the table stays inside the RSS budget it is allowed to spend" {
    // A per-route histogram is only defensible while it is a rounding error
    // against the ~50 MB target. If a wider histogram or a bigger route table
    // ever pushes this past ~128 KB, the trade needs re-arguing rather than
    // silently growing.
    try testing.expect(@sizeOf(LockStats) < 128 * 1024);
}
