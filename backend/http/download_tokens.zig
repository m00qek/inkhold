//! In-memory, short-TTL download tokens scoped to one `(file_id, user_id)`.
//! The device sends no access token on the `download_v3` GET, so `?t=` is the
//! capability. Multi-use within the TTL, because the device retries and sends
//! Range requests.

const std = @import("std");
const expiring = @import("../util/expiring.zig");

pub const Error = std.mem.Allocator.Error;

pub const ttl_ms: i64 = 5 * 60 * 1000;

/// 16 random bytes as lowercase hex.
pub const token_len = 32;

const Entry = struct { file_id: u64, user_id: u64, expires_at_ms: i64 };

pub const DownloadTokens = struct {
    gpa: std.mem.Allocator,
    mutex: std.Io.Mutex = .init,
    tokens: std.StringHashMapUnmanaged(Entry) = .empty,
    /// Soft cap on live tokens against a flood of mints.
    max_tokens: usize = 10_000,

    pub fn init(gpa: std.mem.Allocator) DownloadTokens {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *DownloadTokens) void {
        var it = self.tokens.iterator();
        while (it.next()) |e| self.gpa.free(e.key_ptr.*);
        self.tokens.deinit(self.gpa);
    }

    /// Mints a token for `file_id`/`user_id`, valid until `now_ms + ttl_ms`.
    pub fn mint(self: *DownloadTokens, io: std.Io, file_id: u64, user_id: u64, now_ms: i64) Error![token_len]u8 {
        var raw: [16]u8 = undefined;
        io.random(&raw);
        const hex = std.fmt.bytesToHex(raw, .lower); // [32]u8

        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);

        self.sweepLocked(now_ms);

        // Full even after the sweep: refuse (the caller answers 500).
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

    /// The `user_id` a live token for file `id` authorizes, else null. Does not
    /// consume the token.
    pub fn lookup(self: *DownloadTokens, io: std.Io, token: []const u8, id: u64, now_ms: i64) ?u64 {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const e = self.tokens.get(token) orelse return null;
        if (now_ms >= e.expires_at_ms) return null;
        if (e.file_id != id) return null; // file-scoped: a token for file A can't fetch file B
        return e.user_id;
    }

    pub fn sweep(self: *DownloadTokens, io: std.Io, now_ms: i64) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.sweepLocked(now_ms);
    }

    /// The caller must hold `mutex`.
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

    try std.testing.expectEqual(@as(?u64, 7), dt.lookup(io, &tok, 42, 1000));
    try std.testing.expectEqual(@as(?u64, 7), dt.lookup(io, &tok, 42, 1000 + ttl_ms - 1));

    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, &tok, 43, 1000));
    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, "deadbeefdeadbeefdeadbeefdeadbeef", 42, 1000));

    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, &tok, 42, 1000 + ttl_ms));
}

test "tokens are cross-user isolated and sweep reclaims expired entries" {
    var dt = DownloadTokens.init(std.testing.allocator);
    defer dt.deinit();
    const io = std.testing.io;

    const tok_a = try dt.mint(io, 10, 1, 0); // user 1's file 10
    const tok_b = try dt.mint(io, 20, 2, 0); // user 2's file 20

    try std.testing.expectEqual(@as(?u64, 1), dt.lookup(io, &tok_a, 10, 0));
    try std.testing.expectEqual(@as(?u64, 2), dt.lookup(io, &tok_b, 20, 0));
    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, &tok_a, 20, 0));
    try std.testing.expectEqual(@as(?u64, null), dt.lookup(io, &tok_b, 10, 0));

    dt.sweep(io, ttl_ms);
    try std.testing.expectEqual(@as(u32, 0), dt.tokens.count());
}
