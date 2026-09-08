//! Per-route DB-window statistics: `db_lock` hold times, and the reader-pool
//! windows that replaced some of them.
//!
//! The server serializes every write behind a single mutex (see
//! `transport.dispatchLocked`), so the sustained request ceiling of the whole
//! process is `1 / mean_hold_time` — one number, set by whichever route holds the
//! lock longest. That makes the hold time the most load-bearing figure in the
//! system and the one nobody can estimate: a folder listing and a library-wide
//! FTS search differ by orders of magnitude, and a global mean hides the route
//! that actually sets the ceiling. Hence per-route attribution.
//!
//! ## A pooled read is still a window, and that is the point
//!
//! **The instrumentation that proved the win is the instrumentation the reader
//! pool invalidates.** A route that moves to a pooled reader stops taking
//! `db_lock`, so without this it would stop appearing here entirely — "global
//! search: 3.41 s" would become "global search: absent", which reads like a fix
//! and is a blind spot. So `recordRead` feeds a pooled read's DURATION into the
//! same per-route histogram as a lock hold: the distribution answers "what does
//! this route cost", which is the question, and stays comparable across the
//! change. What separates the two is counted alongside it (`read_count`), and
//! `totals` — the *lock* occupancy that sets the ceiling — subtracts the reader
//! share so it keeps meaning what it says.
//!
//! ## Why the counters are atomic
//!
//! They used to be plain fields, on the strength of one invariant: every write
//! happened with `db_lock` already held, so the mutual exclusion they needed was
//! the exclusion the caller was already paying for. A pooled read holds NO lock,
//! which is its entire purpose, so that argument is gone.
//!
//! The replacement is relaxed atomics — but they must be **32-bit** ones, and
//! that is not a style choice. ARM1176JZF-S is ARMv6, which has no `ldrexd`, so
//! `@atomicLoad(u64, …)` is a compile error and a `u64` counter cannot be made
//! atomic on the deployment target AT ALL. The first version of this file used
//! `u64` and could not be built for the Pi.
//!
//! So every field here is `u32`, and the two that would overflow one — the time
//! TOTALS — are carried as milliseconds plus a microsecond remainder. A read can
//! land between the two halves of a carry, which costs at most 1 ms of skew on a
//! cumulative figure: comfortably inside "a figure from a moment ago", and
//! nothing like the garbage a torn 64-bit read produces on a 32-bit machine.
//! Deliberately NOT a mutex of the counters' own: it would have to be taken on
//! the reader path, where a stall waiting on anything shared is exactly what the
//! pool exists to prevent, and a stats table that serializes reports its own
//! contention as the server's. Relaxed ordering is right because nothing is
//! published through these fields — a percentile is a summary, not a
//! synchronization edge, and the worst a torn read can do is report a figure from
//! a moment ago.
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

/// One route's accumulated DB windows. Plain integer fields, updated with
/// relaxed atomics — see the module header for why they stopped being able to
/// rely on `db_lock`.
pub const Slot = struct {
    /// Samples recorded. **A sample is one DB WINDOW, not one request.** They are
    /// the same thing for an ordinary route (the lock spans the whole handler),
    /// but a `manual_db_lock` route contributes several short windows per request
    /// — the `resolveCaller` session read plus each of the handler's own
    /// bracketed DB touches — and a `read_only` route contributes the
    /// `resolveCaller` lock window PLUS its pooled-reader window. That is
    /// deliberate: what costs is a window, and the claim those routes make ("the
    /// windows are short") is a claim about windows.
    count: u32 = 0,
    /// Cumulative window time, carried: `total_s * 1000 + total_us`
    /// microseconds. Two `u32`s rather than one `u64` because of ARMv6 — see the
    /// header. `total_us` is kept under 1000 by the carry in `addTime`.
    total_s: u32 = 0,
    total_ns_rem: u32 = 0,
    /// A single sample's maximum, in MICROSECONDS. `u32` spans 71 minutes, which
    /// no single window approaches; nanosecond resolution on a max buys nothing a
    /// report would show.
    max_us: u32 = 0,
    buckets: [bucket_count]u32 = @splat(0),

    // ---- the reader-pool share of the above, plus what only it can say ----

    /// How many of `count` ran on a POOLED READER rather than under `db_lock`.
    /// The subtrahend that keeps `totals` honest about lock occupancy, and the
    /// field that says whether a `read_only` route is actually being pooled.
    read_count: u32 = 0,
    /// How much of `total_ns` those windows account for.
    read_total_s: u32 = 0,
    read_total_ns_rem: u32 = 0,
    /// Time spent BORROWING a reader, summed. Near zero by construction —
    /// `Pool.acquire` is one CAS and never waits — so this is not the interesting
    /// number; it is here because a future acquire that ever did block would
    /// otherwise hide inside the hold time, which is the one place it must not.
    /// The figure that matters is `fallback_count` below.
    wait_total_s: u32 = 0,
    wait_total_ns_rem: u32 = 0,
    wait_max_us: u32 = 0,
    /// Reads that found the pool EMPTY and fell back to the writer under
    /// `db_lock`. Correct, and exactly as slow as before the pool existed — so a
    /// route whose fallbacks climb is the signal to raise `default_size`, and the
    /// only way to tell "the pool is sized right" from "the pool is never used".
    fallback_count: u32 = 0,
};

/// `p.* +|= v`, atomically. Saturating rather than wrapping for the same reason
/// the non-atomic version was: a counter that wraps reports a catastrophically
/// slow route as a fast one.
fn satAdd(p: *u32, v: u32) void {
    var cur = @atomicLoad(u32, p, .monotonic);
    while (true) {
        cur = @cmpxchgWeak(u32, p, cur, cur +| v, .monotonic, .monotonic) orelse return;
    }
}

/// Add `ns` to a carried (seconds, nanosecond-remainder) pair. Carrying at ONE
/// SECOND keeps the total exact — no rounding at all — which matters because a
/// total is a sum over many samples and a per-sample truncation would compound.
/// `u32` seconds spans 136 years.
///
/// The two stores are independent, so a reader landing between them sees at most
/// one second less than the truth on a cumulative figure. That is the cost of
/// having no 64-bit atomic on the target, and it is what the header means by "a
/// figure from a moment ago".
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

/// A counter read. Every field above is written with `@atomicRmw` from threads
/// holding no common lock, so reading one as a plain field would be a data race
/// in the language even where it is benign on the hardware.
fn load(p: *const u32) u32 {
    return @atomicLoad(u32, p, .monotonic);
}

/// `p.* = @max(p.*, v)`, atomically.
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
    /// Indexed by route index; `slots[max_routes]` is the overflow slot shared by
    /// any route beyond the table (and by lock windows taken with no route
    /// matched, e.g. a 404's `resolveCaller`).
    slots: [max_routes + 1]Slot = @splat(.{}),

    /// Add one `db_lock` hold sample. Called from `Context.unlockDb` with the
    /// lock still held.
    pub fn record(self: *LockStats, route_idx: ?usize, ns: u64) void {
        _ = self.window(route_idx, ns);
    }

    /// Add one POOLED READER window: the same duration sample as `record`, plus
    /// the borrow's own cost and the fact that this window took no lock.
    ///
    /// Called from `Context.returnReader` with NO lock held — which is why every
    /// field it touches is updated atomically.
    pub fn recordRead(self: *LockStats, route_idx: ?usize, wait_ns: u64, hold_ns: u64) void {
        const s = self.window(route_idx, hold_ns);
        satAdd(&s.read_count, 1);
        addTime(&s.read_total_s, &s.read_total_ns_rem, hold_ns);
        addTime(&s.wait_total_s, &s.wait_total_ns_rem, wait_ns);
        atomicMax(&s.wait_max_us, usFromNs(wait_ns));
    }

    /// Note that a read found the pool empty and used the writer instead. The
    /// window it then takes is recorded by `record` like any other lock hold, so
    /// this counts only the DECISION — how often the pool was too small.
    pub fn recordFallback(self: *LockStats, route_idx: ?usize) void {
        satAdd(&self.slotOf(route_idx).fallback_count, 1);
    }

    fn slotOf(self: *LockStats, route_idx: ?usize) *Slot {
        return &self.slots[if (route_idx) |r| @min(r, max_routes) else max_routes];
    }

    /// The shared half of `record`/`recordRead`: one duration into the route's
    /// distribution. Returns the slot so the caller can add its own detail.
    fn window(self: *LockStats, route_idx: ?usize, ns: u64) *Slot {
        const s = self.slotOf(route_idx);
        satAdd(&s.count, 1);
        addTime(&s.total_s, &s.total_ns_rem, ns);
        atomicMax(&s.max_us, usFromNs(ns));
        satAdd(&s.buckets[bucketOf(ns)], 1);
        return s;
    }

    /// A route's summary, or null when it has never been called — an untouched
    /// route must render as absent rather than as a row of zeros, which would
    /// read as "measured, and fast".
    pub fn summarize(self: *const LockStats, route_idx: usize) ?Summary {
        const s = &self.slots[@min(route_idx, max_routes)];
        const count = load(&s.count);
        if (count == 0) return null;
        // Back to nanoseconds at the BOUNDARY, so `Summary` and every reader of
        // it keep the units they always had; the microsecond storage is an
        // implementation detail forced by the target's atomics, not a change to
        // what this reports.
        const max_ns = @as(u64, load(&s.max_us)) * std.time.ns_per_us;
        const total_ns = nsOf(load(&s.total_s), load(&s.total_ns_rem));
        return .{
            .count = count,
            .mean_ns = total_ns / count,
            // Clamped to the exact max: a bucket's upper bound can exceed the
            // largest sample actually seen, and "p95 = 90 us, max = 89 us" reads
            // as a bug in the table rather than as bucket rounding.
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

    /// Total samples and total time **under the lock**, across every route. The
    /// denominator of the ceiling arithmetic: the lock is one resource, so the
    /// aggregate occupancy is what says how much of it is left.
    ///
    /// Pooled-reader windows are SUBTRACTED here even though they are counted in
    /// each slot. They are real work and belong in a route's distribution, but
    /// they occupy no lock — leaving them in would inflate the one figure that
    /// exists to answer "how much of the global serialization point is spoken
    /// for", and would do it by exactly the amount the pool just freed up.
    pub fn totals(self: *const LockStats) struct { count: u64, total_ns: u64 } {
        var count: u64 = 0;
        var total_ns: u64 = 0;
        for (&self.slots) |*s| {
            // Saturating: the two loads are independent, so a `recordRead` that
            // lands between them can momentarily show a reader share larger than
            // the count it was counted in. A stat is not worth an underflow.
            count += load(&s.count) -| load(&s.read_count);
            const all_ns = nsOf(load(&s.total_s), load(&s.total_ns_rem));
            const read_ns = nsOf(load(&s.read_total_s), load(&s.read_total_ns_rem));
            total_ns +|= all_ns -| read_ns;
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
    /// The reader-pool share of the figures above (see `Slot`). `read_count == 0`
    /// on a `read_only` route means it is falling back every time — which is
    /// correct but is not the feature working.
    read_count: u64 = 0,
    read_total_ns: u64 = 0,
    wait_total_ns: u64 = 0,
    wait_max_ns: u64 = 0,
    fallback_count: u64 = 0,
};

/// The JSON shape the health endpoint emits per route: the summary plus the
/// identity needed to read it. `manual` is not decoration — it says whether
/// `count` counts requests or windows (see `Slot.count`).
pub const RouteReport = struct {
    method: []const u8,
    path: []const u8,
    manual: bool,
    /// Whether the route is declared `read_only`, i.e. whether its windows are
    /// expected to be pooled reads. Alongside `reader_windows` it is what tells
    /// "this route no longer holds the lock" from "this route stopped being
    /// called", which are the same absence in a lock-only report.
    read_only: bool,
    count: u64,
    mean_ns: u64,
    p50_ns: u64,
    p95_ns: u64,
    max_ns: u64,
    /// How many of `count` ran on a pooled reader, and for how long in total.
    reader_windows: u64,
    reader_ns: u64,
    /// How often the pool was empty and the read used the writer instead. The
    /// pool-sizing signal.
    reader_fallbacks: u64,
    /// Longest single borrow (not hold). Expected to be microseconds; anything
    /// else means `Pool.acquire` stopped being wait-free.
    reader_wait_max_ns: u64,
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
    // 2 us, not 1.5: the max is stored in MICROSECONDS. A `u32` of nanoseconds
    // saturates at 4.29 s, which would silently under-report exactly the windows
    // that matter most — a 6.1 s reader window has been measured on the Pi — and
    // ARMv6 has no 64-bit atomic to max with. Sub-microsecond resolution on a
    // MAX buys nothing: the smallest window this server has ever recorded is
    // 21 us. The totals beside it stay exact (`addTime` carries at one second).
    var one: LockStats = .{};
    one.record(9, 2_000);
    const s1 = one.summarize(9).?;
    try testing.expectEqual(@as(u64, 2_000), s1.max_ns);
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
