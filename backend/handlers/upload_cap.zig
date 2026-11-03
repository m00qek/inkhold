//! The ingest byte cap shared by both upload byte paths. Quota checked only at
//! link time would let one request fill the disk first.

const std = @import("std");

/// Grace over the declared size. The counted bytes exclude multipart framing,
/// so zero would be exact; one 64 KiB read chunk absorbs any mismatch in what
/// the frozen device protocol means by `size`, and is the cap's granularity anyway.
pub const slack_bytes: u64 = 64 * 1024;

/// Saturating, so an absurd declared size cannot wrap the limit small.
pub fn limitFor(declared: u64) u64 {
    return declared +| slack_bytes;
}

/// What is left of a session's budget after `received` bytes; charging parts
/// against the running total makes the cap per session, not per part.
/// Saturating at 0.
pub fn remainingFor(declared: u64, received: u64) u64 {
    return limitFor(declared) -| received;
}

/// A `multipart` sink that forwards to `Inner` until more than `limit` bytes are
/// offered, then fails with `error.UploadTooLarge`. The check precedes the inner
/// write, so the bound holds on disk.
pub fn Capped(comptime Inner: type) type {
    return struct {
        const Self = @This();

        inner: *Inner,
        limit: u64,
        /// Never exceeds `limit`: the write that would is refused whole.
        written: u64 = 0,

        pub fn init(inner: *Inner, limit: u64) Self {
            return .{ .inner = inner, .limit = limit };
        }

        pub fn write(self: *Self, bytes: []const u8) !void {
            // `bytes.len` is one read chunk, so this cannot overflow.
            if (self.written + bytes.len > self.limit) return error.UploadTooLarge;
            try self.inner.write(bytes);
            self.written += bytes.len;
        }
    };
}

// ---- tests ----

const testing = std.testing;

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
    // The whole chunk is refused, not truncated.
    try testing.expectError(error.UploadTooLarge, c.write("56789"));
    try testing.expectEqualStrings("1234", rec.got.items);
    try testing.expectEqual(@as(u64, 4), c.written);

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
    const declared: u64 = 1000;
    const whole = limitFor(declared); // 1000 + slack

    try testing.expectEqual(whole, remainingFor(declared, 0)); // first part: all of it
    try testing.expectEqual(whole - 400, remainingFor(declared, 400)); // 400 already staged
    try testing.expectEqual(@as(u64, 0), remainingFor(declared, whole)); // spent

    try testing.expectEqual(@as(u64, 0), remainingFor(declared, whole + 1));
    try testing.expectEqual(@as(u64, 0), remainingFor(declared, std.math.maxInt(u64)));
}
