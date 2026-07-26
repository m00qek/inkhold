//! Where the `.note` parser gets its bytes from.
//!
//! The format is purely **address-based** — the last 4 bytes give the footer
//! address, the footer indexes the header and every page, each page indexes its
//! layers, and every one of those is a length-prefixed block at an absolute
//! offset. Nothing is ever scanned linearly. So the parser does not need a
//! contiguous buffer; it needs "give me the 4 bytes at N" and "give me the block
//! at N". That is exactly what a `Source` is.
//!
//! Two backings exist:
//!
//!   - `.slice` — the caller already holds the whole file (CLI, wasm, tests).
//!     Reads are `@memcpy`, and `view` hands back a borrowed sub-slice, so this
//!     costs precisely what a plain `[]const u8` parser would cost.
//!   - `.ranged` — a positional reader (e.g. a blob store's `readRange`).
//!     Nothing is buffered: peak memory is the size of the individual blocks
//!     read, not the size of the file. This backing is what makes the tiered
//!     API (see `note.zig`) worth having: `metadata()` over a ranged source is
//!     a handful of small absolute reads.
//!
//! It is a **tagged union, not a vtable**, for two reasons: the slice case stays
//! a plain slice with no indirection and a real zero-copy path, and `Note` stays
//! a single concrete type (a generic `Note(Source)` would infect `render`,
//! `recognition`, `page_payload` and every caller).
//!
//! ## Bounds are checked here, once
//!
//! Every offset the parser uses comes from the file itself — i.e. from data an
//! untrusted device wrote. `read`, `view` and `blockRange` all validate against
//! `size()` with a checked add, so a hostile length can never wrap into a
//! plausible range or read past EOF; the error is `OutOfBounds`, never a panic.
//! (The tier layer in `note.zig` reports `OutOfBounds` as `error.Truncated` —
//! see the taxonomy there.)

const std = @import("std");

pub const Error = error{
    /// A read would fall outside the source (or its offset arithmetic wrapped).
    OutOfBounds,
    /// The backing store failed to produce bytes for an in-bounds range.
    ReadFailed,
};

/// A validated `[offset, offset+len)` window inside a source.
pub const Range = struct {
    offset: u64,
    len: u32,
};

/// A block payload that is *borrowed* when the source is slice-backed and
/// *owned* when it is not. Callers treat both alike and always `deinit`.
pub const Held = struct {
    bytes: []const u8,
    owned: ?[]u8 = null,

    pub fn deinit(self: Held, gpa: std.mem.Allocator) void {
        if (self.owned) |b| gpa.free(b);
    }
};

/// A positional byte source that is not a contiguous slice.
pub const Ranged = struct {
    ctx: *anyopaque,
    /// The total size of the underlying object, in bytes.
    size: u64,
    /// Fills `dest` **completely** from `offset`, or fails. The caller has
    /// already bounds-checked `offset + dest.len` against `size`; a short read
    /// is `error.ReadFailed`, never a silent partial fill.
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

    /// True when the whole source is already in memory as one slice.
    pub fn isSlice(self: Source) bool {
        return self == .slice;
    }

    fn inBounds(self: Source, offset: u64, len: u64) bool {
        const end = std.math.add(u64, offset, len) catch return false;
        return end <= self.size();
    }

    /// A zero-copy view of `[offset, offset+len)` — non-null only when the
    /// source is slice-backed and the window is in bounds.
    pub fn view(self: Source, offset: u64, len: u64) ?[]const u8 {
        switch (self) {
            .slice => |b| {
                if (!self.inBounds(offset, len)) return null;
                return b[@intCast(offset)..][0..@intCast(len)];
            },
            .ranged => return null,
        }
    }

    /// Fills `dest` from `offset`. Exact: on success every byte of `dest` is
    /// real file content.
    pub fn read(self: Source, offset: u64, dest: []u8) Error!void {
        if (!self.inBounds(offset, dest.len)) return error.OutOfBounds;
        switch (self) {
            .slice => |b| @memcpy(dest, b[@intCast(offset)..][0..dest.len]),
            .ranged => |r| try r.readFn(r.ctx, offset, dest),
        }
    }

    /// Reads a little-endian `u32` at `offset`.
    pub fn u32le(self: Source, offset: u64) Error!u32 {
        var buf: [4]u8 = undefined;
        try self.read(offset, &buf);
        return std.mem.readInt(u32, &buf, .little);
    }

    /// Locates the length-prefixed block at `address` — a `u32` byte length
    /// followed by that many payload bytes — and validates that the whole
    /// payload lies inside the source. Reads 4 bytes, never the body.
    pub fn blockRange(self: Source, address: u64) Error!Range {
        const len = try self.u32le(address);
        const offset = address + 4; // the u32le read proved address+4 <= size
        if (!self.inBounds(offset, len)) return error.OutOfBounds;
        return .{ .offset = offset, .len = len };
    }

    /// The payload of the block at `address`: borrowed when slice-backed,
    /// otherwise copied into `gpa`. For data used and dropped within a call.
    pub fn blockHeld(self: Source, gpa: std.mem.Allocator, address: u64) (Error || std.mem.Allocator.Error)!Held {
        const r = try self.blockRange(address);
        if (self.view(r.offset, r.len)) |v| return .{ .bytes = v };
        const buf = try gpa.alloc(u8, r.len);
        errdefer gpa.free(buf);
        try self.read(r.offset, buf);
        return .{ .bytes = buf, .owned = buf };
    }

    /// The payload of the block at `address`, **always** copied into `gpa`.
    /// This is what the parsed results retain: owning unconditionally is what
    /// lets the slice and ranged paths behave identically (see `note.zig`).
    pub fn blockAlloc(self: Source, gpa: std.mem.Allocator, address: u64) (Error || std.mem.Allocator.Error)![]u8 {
        const r = try self.blockRange(address);
        const buf = try gpa.alloc(u8, r.len);
        errdefer gpa.free(buf);
        try self.read(r.offset, buf);
        return buf;
    }

    /// Feeds `[offset, offset+len)` to `hasher.update` in `buf`-sized chunks, so
    /// hashing a multi-MB layer costs `buf.len` bytes rather than `len` bytes.
    /// Slice-backed sources hash the view directly, with no copy at all.
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

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

const testing = std.testing;

/// A `.ranged` source over a slice — the test stand-in for a blob store, and the
/// thing that proves the two backings are interchangeable without any I/O.
///
/// It **accounts for every read**: count, largest size, and (up to `max_log`)
/// the exact `[offset, offset+len)` windows in call order. The window log is
/// what turns "metadata() is lazy" from a hope into a contract — the tier tests
/// assert which byte ranges were touched (see tests/note_test.zig).
pub const TestRanged = struct {
    bytes: []const u8,
    reads: usize = 0,
    max_read: usize = 0,
    log_buf: [max_log]Range = undefined,
    log_len: usize = 0,

    /// Fixed log capacity: recording saturates, `reads` keeps counting. A test
    /// that inspects `log()` must therefore assert `reads == log().len`, so
    /// saturation can never silently hide a read from the laziness proof.
    pub const max_log = 64;

    pub fn source(self: *TestRanged) Source {
        return .{ .ranged = .{ .ctx = self, .size = self.bytes.len, .readFn = readFn } };
    }

    /// Every window read so far, in call order (up to `max_log`).
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "slice and ranged sources agree on every accessor" {
    // length = 3, payload = "abc", then junk.
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

    // Only the slice source gives a borrowed view; the ranged one always copies.
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
