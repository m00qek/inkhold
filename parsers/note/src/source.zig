//! Where the `.note` parser gets its bytes: a whole `.slice`, or a `.ranged`
//! positional reader (peak memory = the blocks read). The format is purely
//! address-based, so nothing is scanned linearly. Every offset comes from
//! untrusted file data, so all reads are bounds-checked here with checked adds.

const std = @import("std");

pub const Error = error{
    OutOfBounds,
    ReadFailed,
};

pub const Range = struct {
    offset: u64,
    len: u32,
};

/// A block payload, borrowed when slice-backed and owned otherwise; always
/// `deinit`.
pub const Held = struct {
    bytes: []const u8,
    owned: ?[]u8 = null,

    pub fn deinit(self: Held, gpa: std.mem.Allocator) void {
        if (self.owned) |b| gpa.free(b);
    }
};

pub const Ranged = struct {
    ctx: *anyopaque,
    size: u64,
    /// Fills `dest` completely or fails; a short read is `error.ReadFailed`.
    readFn: *const fn (ctx: *anyopaque, offset: u64, dest: []u8) Error!void,
};

pub const Source = union(enum) {
    slice: []const u8,
    ranged: Ranged,

    pub fn fromSlice(bytes: []const u8) Source {
        return .{ .slice = bytes };
    }

    pub fn size(self: Source) u64 {
        return switch (self) {
            .slice => |b| b.len,
            .ranged => |r| r.size,
        };
    }

    pub fn isSlice(self: Source) bool {
        return self == .slice;
    }

    fn inBounds(self: Source, offset: u64, len: u64) bool {
        const end = std.math.add(u64, offset, len) catch return false;
        return end <= self.size();
    }

    /// A zero-copy view, non-null only when slice-backed and in bounds.
    pub fn view(self: Source, offset: u64, len: u64) ?[]const u8 {
        switch (self) {
            .slice => |b| {
                if (!self.inBounds(offset, len)) return null;
                return b[@intCast(offset)..][0..@intCast(len)];
            },
            .ranged => return null,
        }
    }

    pub fn read(self: Source, offset: u64, dest: []u8) Error!void {
        if (!self.inBounds(offset, dest.len)) return error.OutOfBounds;
        switch (self) {
            .slice => |b| @memcpy(dest, b[@intCast(offset)..][0..dest.len]),
            .ranged => |r| try r.readFn(r.ctx, offset, dest),
        }
    }

    pub fn u32le(self: Source, offset: u64) Error!u32 {
        var buf: [4]u8 = undefined;
        try self.read(offset, &buf);
        return std.mem.readInt(u32, &buf, .little);
    }

    /// Locates the block at `address` (`u32` length + payload) and validates
    /// it; reads 4 bytes, never the body.
    pub fn blockRange(self: Source, address: u64) Error!Range {
        const len = try self.u32le(address);
        const offset = address + 4; // the u32le read proved address+4 <= size
        if (!self.inBounds(offset, len)) return error.OutOfBounds;
        return .{ .offset = offset, .len = len };
    }

    /// The block payload, borrowed when slice-backed, else copied into `gpa`.
    pub fn blockHeld(self: Source, gpa: std.mem.Allocator, address: u64) (Error || std.mem.Allocator.Error)!Held {
        const r = try self.blockRange(address);
        if (self.view(r.offset, r.len)) |v| return .{ .bytes = v };
        const buf = try gpa.alloc(u8, r.len);
        errdefer gpa.free(buf);
        try self.read(r.offset, buf);
        return .{ .bytes = buf, .owned = buf };
    }

    /// The block payload, always copied into `gpa`, so both backings behave
    /// identically for retained results.
    pub fn blockAlloc(self: Source, gpa: std.mem.Allocator, address: u64) (Error || std.mem.Allocator.Error)![]u8 {
        const r = try self.blockRange(address);
        const buf = try gpa.alloc(u8, r.len);
        errdefer gpa.free(buf);
        try self.read(r.offset, buf);
        return buf;
    }

    /// Hashes a range in `buf`-sized chunks (slice sources hash the view).
    pub fn hashRange(self: Source, hasher: anytype, offset: u64, len: u64, buf: []u8) Error!void {
        std.debug.assert(buf.len > 0);
        if (self.view(offset, len)) |v| {
            hasher.update(v);
            return;
        }
        if (!self.inBounds(offset, len)) return error.OutOfBounds;
        var done: u64 = 0;
        while (done < len) {
            const n: usize = @intCast(@min(@as(u64, buf.len), len - done));
            try self.read(offset + done, buf[0..n]);
            hasher.update(buf[0..n]);
            done += n;
        }
    }
};

// ---- test double ----

const testing = std.testing;

/// A `.ranged` source over a slice that logs every read window, so tests can
/// assert which byte ranges a tier touched.
pub const TestRanged = struct {
    bytes: []const u8,
    reads: usize = 0,
    max_read: usize = 0,
    log_buf: [max_log]Range = undefined,
    log_len: usize = 0,

    /// Log capacity; `reads` keeps counting past it, so tests assert
    /// `reads == log().len`.
    pub const max_log = 64;

    pub fn source(self: *TestRanged) Source {
        return .{ .ranged = .{ .ctx = self, .size = self.bytes.len, .readFn = readFn } };
    }

    pub fn log(self: *const TestRanged) []const Range {
        return self.log_buf[0..self.log_len];
    }

    pub fn resetLog(self: *TestRanged) void {
        self.reads = 0;
        self.max_read = 0;
        self.log_len = 0;
    }

    fn readFn(ctx: *anyopaque, offset: u64, dest: []u8) Error!void {
        const self: *TestRanged = @ptrCast(@alignCast(ctx));
        const end = std.math.add(u64, offset, dest.len) catch return error.OutOfBounds;
        if (end > self.bytes.len) return error.OutOfBounds;
        self.reads += 1;
        self.max_read = @max(self.max_read, dest.len);
        if (self.log_len < max_log) {
            self.log_buf[self.log_len] = .{ .offset = offset, .len = @intCast(dest.len) };
            self.log_len += 1;
        }
        @memcpy(dest, self.bytes[@intCast(offset)..][0..dest.len]);
    }
};

// ---- tests ----

test "slice and ranged sources agree on every accessor" {
    const bytes = [_]u8{ 0x03, 0x00, 0x00, 0x00, 'a', 'b', 'c', 'X' };
    var tr = TestRanged{ .bytes = &bytes };
    const sources = [_]Source{ Source.fromSlice(&bytes), tr.source() };

    for (sources) |src| {
        try testing.expectEqual(@as(u64, bytes.len), src.size());
        try testing.expectEqual(@as(u32, 3), try src.u32le(0));

        const r = try src.blockRange(0);
        try testing.expectEqual(@as(u64, 4), r.offset);
        try testing.expectEqual(@as(u32, 3), r.len);

        var held = try src.blockHeld(testing.allocator, 0);
        defer held.deinit(testing.allocator);
        try testing.expectEqualStrings("abc", held.bytes);

        const owned = try src.blockAlloc(testing.allocator, 0);
        defer testing.allocator.free(owned);
        try testing.expectEqualStrings("abc", owned);
    }

    try testing.expect(sources[0].view(4, 3) != null);
    try testing.expect(sources[1].view(4, 3) == null);
    try testing.expect((try sources[0].blockHeld(testing.allocator, 0)).owned == null);
}

test "out-of-bounds, overflowing and truncated reads are refused, never a panic" {
    const bytes = [_]u8{ 0xFF, 0xFF, 0xFF, 0xFF, 'a' }; // block len 0xFFFFFFFF
    var tr = TestRanged{ .bytes = &bytes };
    const max = std.math.maxInt(u64);

    for ([_]Source{ Source.fromSlice(&bytes), tr.source() }) |src| {
        var dst: [4]u8 = undefined;
        try testing.expectError(error.OutOfBounds, src.u32le(2)); // past the end
        try testing.expectError(error.OutOfBounds, src.u32le(max)); // wraps
        try testing.expectError(error.OutOfBounds, src.read(max - 1, &dst)); // wraps
        try testing.expectError(error.OutOfBounds, src.blockRange(0)); // body overruns
        try testing.expectError(error.OutOfBounds, src.blockAlloc(testing.allocator, 0));
        try testing.expect(src.view(3, 9) == null);
    }
}

test "hashRange never materialises the range it hashes" {
    const gpa = testing.allocator;
    const data = try gpa.alloc(u8, 300 * 1024);
    defer gpa.free(data);
    for (data, 0..) |*b, i| b.* = @truncate(i);

    const Md5 = std.crypto.hash.Md5;
    var want: [16]u8 = undefined;
    Md5.hash(data, &want, .{});

    var tr = TestRanged{ .bytes = data };
    var buf: [4096]u8 = undefined;
    var hasher = Md5.init(.{});
    try tr.source().hashRange(&hasher, 0, data.len, &buf);
    var got: [16]u8 = undefined;
    hasher.final(&got);

    try testing.expectEqualSlices(u8, &want, &got);
    try testing.expectEqual(@as(usize, buf.len), tr.max_read); // bounded by the chunk
    try testing.expect(tr.reads >= data.len / buf.len);
}

test "TestRanged records the exact windows it served, in order" {
    const bytes = [_]u8{ 0x02, 0x00, 0x00, 0x00, 'h', 'i' };
    var tr = TestRanged{ .bytes = &bytes };
    const src = tr.source();

    _ = try src.u32le(0);
    var two: [2]u8 = undefined;
    try src.read(4, &two);

    try testing.expectEqual(@as(usize, 2), tr.reads);
    try testing.expectEqual(tr.reads, tr.log().len); // nothing hidden by saturation
    try testing.expectEqual(Range{ .offset = 0, .len = 4 }, tr.log()[0]);
    try testing.expectEqual(Range{ .offset = 4, .len = 2 }, tr.log()[1]);

    tr.resetLog();
    try testing.expectEqual(@as(usize, 0), tr.log().len);
}
