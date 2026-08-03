//! In-memory, short-TTL, file-scoped download capability tokens.
//!
//! The device downloads a file by GETting the URL that `download_v3` hands it,
//! and it sends NO `x-access-token` on that GET (OSS downloads are authorized by
//! the URL, not a bearer token). So `/oss/get/:id` is a `.public` route and the
//! `?t=` query parameter is the capability that authorizes it: a random,
//! unguessable token bound to one `(file_id, user_id)` that expires after a few
//! minutes.
//!
//! DELIBERATELY SIMPLE — the minimal safe scheme for a single-household LAN. A
//! token is MULTI-USE within its TTL: the device may issue Range requests (we
//! advertise `Accept-Ranges`) or retry, so single-use would deny the second
//! fetch. This is NOT a signed URL and offers no replay protection beyond the
//! short TTL. A proper security rework (signed URLs / HTTPS) is explicitly
//! deferred; see the callers in handlers/device.zig.
//!
//! Mirrors the `ratelimit.zig` in-memory-store pattern: a mutex-guarded
//! `StringHashMapUnmanaged` created lazily, swept of expired entries, and bounded
//! so a flood of mints can't grow it without limit (per the 50 MB budget).

const std = @import("std");
const expiring = @import("../expiring.zig");

pub const Error = std.mem.Allocator.Error;

/// How long a minted download token stays valid (~5 minutes).
pub const ttl_ms: i64 = 5 * 60 * 1000;

/// A minted token: 16 random bytes rendered as 32 lowercase hex chars.
pub const token_len = 32;

const Entry = struct { file_id: u64, user_id: u64, expires_at_ms: i64 };

pub const DownloadTokens = struct {
    gpa: std.mem.Allocator,
    /// Guards the table. Normal operation is single-threaded (like the limiter),
    /// but the store is shared, so the lock keeps it safe if that ever changes.
    /// `std.Io.Mutex` (as `transport`'s `db_lock`) takes `io` to lock/unlock.
    mutex: std.Io.Mutex = .init,
    tokens: std.StringHashMapUnmanaged(Entry) = .empty,
    /// Soft cap on live tokens. Household scale never approaches it; it bounds the
    /// table against a flood of mints (each is swept away within the TTL anyway).
    max_tokens: usize = 10_000,

    pub fn init(gpa: std.mem.Allocator) DownloadTokens {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *DownloadTokens) void {
        var it = self.tokens.iterator();
        while (it.next()) |e| self.gpa.free(e.key_ptr.*);
        self.tokens.deinit(self.gpa);
    }

    /// Mints a fresh token authorizing GETs of `file_id` by `user_id` until
    /// `now_ms + ttl_ms`, and returns the 32-hex token by value (the caller embeds
    /// it in the download URL's `?t=`). `io.random` supplies the 16 random bytes.
    pub fn mint(self: *DownloadTokens, io: std.Io, file_id: u64, user_id: u64, now_ms: i64) Error![token_len]u8 {
        var raw: [16]u8 = undefined;
        io.random(&raw);
        const hex = std.fmt.bytesToHex(raw, .lower); // [32]u8

        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);

        self.sweepLocked(now_ms); // reclaim expired before we (maybe) grow

        // Bound the table: if full even after the sweep, refuse to grow (the caller
        // treats a mint error as a 500). A 128-bit-random key never collides in
        // practice, so a genuine existing token is the only found_existing case.
        if (self.tokens.count() >= self.max_tokens and !self.tokens.contains(&hex)) return error.OutOfMemory;

        const gop = try self.tokens.getOrPut(self.gpa, &hex);
        if (!gop.found_existing) {
            const owned = self.gpa.dupe(u8, &hex) catch |e| {
                _ = self.tokens.remove(&hex); // undo the half-inserted entry
                return e;
            };
            gop.key_ptr.* = owned;
        }
        gop.value_ptr.* = .{ .file_id = file_id, .user_id = user_id, .expires_at_ms = now_ms + ttl_ms };
        return hex;
    }

    /// Returns the `user_id` a token authorizes iff the token exists, is unexpired
    /// at `now_ms`, and is scoped to file `id`; else null. MULTI-USE — this does
    /// NOT consume the token (the device may Range-request or retry within the TTL).
    pub fn lookup(self: *DownloadTokens, io: std.Io, token: []const u8, id: u64, now_ms: i64) ?u64 {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const e = self.tokens.get(token) orelse return null;
        if (now_ms >= e.expires_at_ms) return null; // expired (swept lazily on the next mint)
        if (e.file_id != id) return null; // file-scoped: a token for file A can't fetch file B
        return e.user_id;
    }

    /// Drops all expired tokens. Safe to call periodically; `mint` also sweeps.
    pub fn sweep(self: *DownloadTokens, io: std.Io, now_ms: i64) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.sweepLocked(now_ms);
    }

    /// Reclaims expired tokens (best-effort, capped per call — `mint` sweeps every
    /// time, so the table stays bounded). The caller must hold `mutex`.
    fn sweepLocked(self: *DownloadTokens, now_ms: i64) void {
        expiring.sweep(Entry, self.gpa, &self.tokens, now_ms, struct {
            fn f(e: Entry, now: i64) bool {
                return now >= e.expires_at_ms;
            }
        }.f);
    }
};

test "mint issues a file-scoped token; lookup honors scope, user, and TTL (multi-use)" {
    var dt = DownloadTokens.init(std.testing.allocator);
    defer dt.deinit();
    const io = std.testing.io;

    const tok = try dt.mint(io, 42, 7, 1000);
    try std.testing.expectEqual(@as(usize, token_len), tok.len);

    // Right file + within TTL → the minting user. Multi-use: two lookups both pass.
    try std.testing.expectEqual(@as(?u64, 7), dt.lookup(io, &tok, 42, 1000));
    try std.testing.expectEqual(@as(?u64, 7), dt.lookup(io, &tok, 42, 1000 + ttl_ms - 1));

    // Wrong file id → null (file-scoped). Unknown token → null.
    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, &tok, 43, 1000));
    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, "deadbeefdeadbeefdeadbeefdeadbeef", 42, 1000));

    // At / after expiry → null.
    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, &tok, 42, 1000 + ttl_ms));
}

test "tokens are cross-user isolated and sweep reclaims expired entries" {
    var dt = DownloadTokens.init(std.testing.allocator);
    defer dt.deinit();
    const io = std.testing.io;

    const tok_a = try dt.mint(io, 10, 1, 0); // user 1's file 10
    const tok_b = try dt.mint(io, 20, 2, 0); // user 2's file 20

    // Each token only unlocks its own (file, user); it can't reach the other's file.
    try std.testing.expectEqual(@as(?u64, 1), dt.lookup(io, &tok_a, 10, 0));
    try std.testing.expectEqual(@as(?u64, 2), dt.lookup(io, &tok_b, 20, 0));
    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, &tok_a, 20, 0));
    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, &tok_b, 10, 0));

    // Sweeping past the TTL clears the table.
    dt.sweep(io, ttl_ms);
    try std.testing.expectEqual(@as(u32, 0), dt.tokens.count());
}
