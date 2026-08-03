//! The ingest byte cap shared by the two upload byte-paths (`device.ossPut` and
//! `controlplane.controlplaneUpload`).
//!
//! **The hole this closes.** Both handlers stream a `multipart/form-data` body
//! straight into the blob store, and until this existed nothing compared the
//! arriving bytes against ANY limit while they were arriving: quota was enforced
//! only at LINK time, i.e. after every byte was already on disk. An authenticated
//! caller — a compromised tablet, a mistaken script, a household member — could
//! therefore fill the disk with a single request while every quota check in the
//! codebase still passed. On the target box (a Pi, disk being the binding
//! constraint) a full disk takes the SQLite database down with it, so "we refuse
//! it at the end" is not a defence.
//!
//! **The shape of the fix.** `Capped` wraps the blob-store `Ingest`/`ChunkIngest`
//! sink that `multipart.streamPart` writes into and counts. One comparison per
//! chunk, BEFORE the bytes reach the inner sink, so the temp file never grows
//! past the cap: what lands on disk is bounded by `limit`, full stop. Exceeding it
//! is `error.UploadTooLarge`, which each handler translates into its own face's
//! refusal (see the call sites — the device face must answer with the protocol's
//! coded 200 envelope, the browser face with a 413).
//!
//! **What the cap is measured against** is the caller's business, and differs:
//!   - `/oss/put` — the `declared_size` the device announced at `upload/apply`,
//!     which was already quota-checked there (`Files.wouldFit`);
//!   - the browser upload — the user's REMAINING quota, since it has no apply step
//!     and bytes past that headroom are bytes `linkBlob` would refuse anyway.
//! Both add `slack_bytes`.

const std = @import("std");

/// Grace added to whatever a call site declares, before a stream is refused.
///
/// **Why any slack at all, and why this much.** The bytes counted here are the
/// part's CONTENT bytes: `multipart.streamPart` strips the framing (the `--
/// boundary` prologue and the closing delimiter) before the sink ever sees them,
/// so the ~150–164 bytes of envelope the device wraps a `/oss/put` body in
/// (docs/reference/device-protocol-endpoints.md, from the live capture) are
/// already gone and a slack of ZERO would be arithmetically correct.
///
/// It is not zero because the device protocol is FROZEN: we cannot renegotiate
/// what the Nomad means by the `size` it declares at `upload/apply`, and refusing
/// a real upload by a handful of bytes would break sync in a way no user could
/// diagnose. One 64 KiB read chunk of tolerance is the cheapest insurance against
/// that class of mismatch — and it is also the granularity at which the cap can
/// be observed at all (`multipart` hands the sink up to one `read_chunk`), so a
/// smaller value would not buy a tighter bound on disk in practice.
///
/// Against the threat it is irrelevant: the bound is `declared + 64 KiB` however
/// many requests arrive, and the declared figure was already checked against
/// quota. Sixty-four kilobytes of slop per refused request is not a disk-fill.
///
/// It also has one deliberate side effect on the browser face, where the cap is
/// the user's remaining quota: a user AT quota can still re-upload a small file
/// whose content is already stored (a dedup hit charges nothing), because the
/// grace covers it. Larger dedup hits are refused — unavoidably, since whether
/// content dedups is knowable only after accepting the bytes, which is the exact
/// cost being refused.
pub const slack_bytes: u64 = 64 * 1024;

/// `declared + slack_bytes`, saturating — a nonsense declared size (a hostile or
/// corrupted `upload_sessions` row near `u64max`) must never wrap the limit down
/// to something small, nor panic the single-threaded server.
pub fn limitFor(declared: u64) u64 {
    return declared +| slack_bytes;
}

/// What is LEFT of a chunked upload's whole-session budget after `received` bytes
/// have already been staged — the limit ONE part of it may carry.
///
/// **This is what makes the cap per-session rather than per-part.** `limitFor`
/// alone bounds one request, and a chunked `/oss/put` is N requests under a
/// caller-chosen `totalChunks`: each part passed the same test independently, so
/// N parts could stage N × the cap before the merge and the total was still
/// unbounded. Charging each part against the running total closes it, because the
/// budget the parts share is the one the device declared and quota already
/// approved at `upload/apply`.
///
/// Saturating, so a total that has somehow overshot its limit yields 0 (refuse
/// everything but an empty write) rather than wrapping to an enormous budget.
pub fn remainingFor(declared: u64, received: u64) u64 {
    return limitFor(declared) -| received;
}

/// A `multipart` sink that forwards to `Inner` (`blobstore.Ingest` or
/// `blobstore.ChunkIngest`) until more than `limit` bytes have been offered, then
/// fails with `error.UploadTooLarge` and writes no more.
///
/// The comparison happens BEFORE the inner write, so the refusal is a bound on
/// what reaches the filesystem, not merely on what is reported afterwards.
pub fn Capped(comptime Inner: type) type {
    return struct {
        const Self = @This();

        inner: *Inner,
        /// Largest number of bytes this stream may carry, inclusive.
        limit: u64,
        /// Bytes accepted so far. Never exceeds `limit` (the write that would is
        /// refused whole).
        written: u64 = 0,

        pub fn init(inner: *Inner, limit: u64) Self {
            return .{ .inner = inner, .limit = limit };
        }

        pub fn write(self: *Self, bytes: []const u8) !void {
            // `written <= limit` holds on entry and `bytes.len` is one read chunk,
            // so this add cannot overflow a u64.
            if (self.written + bytes.len > self.limit) return error.UploadTooLarge;
            try self.inner.write(bytes);
            self.written += bytes.len;
        }
    };
}

// ---- tests ----

const testing = std.testing;

/// Stands in for the blob-store ingest: records what actually reached the sink.
const Recorder = struct {
    got: std.ArrayList(u8) = .empty,
    fn write(self: *Recorder, bytes: []const u8) !void {
        try self.got.appendSlice(testing.allocator, bytes);
    }
    fn deinit(self: *Recorder) void {
        self.got.deinit(testing.allocator);
    }
};

test "Capped passes bytes through up to and including the limit" {
    var rec: Recorder = .{};
    defer rec.deinit();
    var c = Capped(Recorder).init(&rec, 10);
    try c.write("12345");
    try c.write("67890"); // exactly at the limit is ACCEPTED
    try testing.expectEqualStrings("1234567890", rec.got.items);
    try testing.expectEqual(@as(u64, 10), c.written);
}

test "Capped refuses the write that would cross the limit, and that write never reaches disk" {
    var rec: Recorder = .{};
    defer rec.deinit();
    var c = Capped(Recorder).init(&rec, 8);
    try c.write("1234");
    // The whole chunk is refused — not truncated to fit. What the inner sink
    // holds is exactly what was accepted before the refusal, so the temp file is
    // bounded by `limit` rather than by `limit + one chunk`.
    try testing.expectError(error.UploadTooLarge, c.write("56789"));
    try testing.expectEqualStrings("1234", rec.got.items);
    try testing.expectEqual(@as(u64, 4), c.written);

    // Still refusing afterwards (a sink is never resumed after a refusal, but the
    // counter must not have been advanced by the failed write either).
    try testing.expectError(error.UploadTooLarge, c.write("56789"));
}

test "a zero limit accepts nothing but an empty write" {
    var rec: Recorder = .{};
    defer rec.deinit();
    var c = Capped(Recorder).init(&rec, 0);
    try c.write(""); // an empty part is a legitimate (if useless) upload
    try testing.expectError(error.UploadTooLarge, c.write("x"));
}

test "limitFor saturates instead of wrapping on an absurd declared size" {
    try testing.expectEqual(@as(u64, 1000 + slack_bytes), limitFor(1000));
    try testing.expectEqual(std.math.maxInt(u64), limitFor(std.math.maxInt(u64)));
    try testing.expectEqual(std.math.maxInt(u64), limitFor(std.math.maxInt(u64) - 1));
}

test "remainingFor shrinks the budget by what the session already staged" {
    // The per-part cap was `limitFor(declared)` on EVERY part of a chunked upload,
    // so N parts each got the whole budget and the total was unbounded. The budget
    // is one figure the parts share.
    const declared: u64 = 1000;
    const whole = limitFor(declared); // 1000 + slack

    try testing.expectEqual(whole, remainingFor(declared, 0)); // first part: all of it
    try testing.expectEqual(whole - 400, remainingFor(declared, 400)); // 400 already staged
    try testing.expectEqual(@as(u64, 0), remainingFor(declared, whole)); // spent

    // Saturating: a total that somehow overshot leaves NO budget, rather than
    // wrapping to something enormous — which is the direction that would hand an
    // attacker the whole disk out of an arithmetic slip.
    try testing.expectEqual(@as(u64, 0), remainingFor(declared, whole + 1));
    try testing.expectEqual(@as(u64, 0), remainingFor(declared, std.math.maxInt(u64)));
}
