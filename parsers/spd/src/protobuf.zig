//! A hardened, allocation-free reader for the sliver of protobuf wire format the
//! `.spd` layer tree uses (`config['ls']`). It is NOT a general protobuf library
//! — it is exactly the primitives `spd.zig` needs, written so that **every path
//! over attacker-controlled bytes returns an error instead of panicking.**
//!
//! The PoC's reader had three concrete crash vectors this file closes:
//!   * `shift += 7` on a `u5` UB-panicked on a 6th varint byte  → `readVarint`
//!     tracks the shift as a bounded `u6` and rejects an over-long varint.
//!   * length-delimited slices (`data[pos .. pos+len]`) were taken without
//!     checking `len` against what remained  → `readLengthDelimited` bounds it
//!     BEFORE slicing.
//!   * `skipWireType` / `msg_len` advanced `pos` past the buffer unchecked
//!     → `advance` / `skip` bound every move.

const std = @import("std");

pub const Error = error{
    /// The buffer ended mid-field (a truncated varint, or a length/fixed field
    /// whose declared size runs past the end).
    Truncated,
    /// A base-128 varint did not terminate within 10 bytes — it cannot be a
    /// valid 64-bit value, so the stream is malformed.
    VarintOverflow,
    /// A wire type we do not decode (the deprecated group types 3 and 4), or a
    /// declared length that overruns the remaining buffer.
    Malformed,
};

/// A cursor over a protobuf message body. Holds no allocation; every accessor
/// either advances `pos` within bounds or returns an `Error`.
pub const Reader = struct {
    data: []const u8,
    pos: usize = 0,

    pub fn atEnd(self: *const Reader) bool {
        return self.pos >= self.data.len;
    }

    fn remaining(self: *const Reader) usize {
        return self.data.len - self.pos;
    }

    fn readByte(self: *Reader) Error!u8 {
        if (self.pos >= self.data.len) return error.Truncated;
        const b = self.data[self.pos];
        self.pos += 1;
        return b;
    }

    /// Advances `n` bytes, refusing to step past the end. This is the single
    /// choke point that makes "skip this field" safe for fixed-width wire types.
    fn advance(self: *Reader, n: usize) Error!void {
        if (n > self.remaining()) return error.Truncated;
        self.pos += n;
    }

    /// Reads one base-128 (LEB128) varint. Bounded to 10 bytes: that is the most
    /// a 64-bit value can occupy, and the guard is what stops the shift amount
    /// from ever reaching 64 — a `u64 << 64` is undefined and would panic in
    /// safe builds. The 10th byte contributes only its low bit; higher bits are
    /// discarded per the protobuf spec, which is fine for the small field values
    /// (ids, flags, opacity) this format carries.
    pub fn readVarint(self: *Reader) Error!u64 {
        var result: u64 = 0;
        var shift: u6 = 0; // legal u64 shift amounts are 0..63 — exactly u6's range
        while (true) {
            const b = try self.readByte();
            result |= @as(u64, b & 0x7f) << shift;
            if (b & 0x80 == 0) return result;
            // Continuation bit set but we are already at the last legal shift:
            // an 11th byte cannot fit, so the varint is malformed.
            if (shift >= 63) return error.VarintOverflow;
            shift += 7;
        }
    }

    /// Reads a length-prefixed byte run (wire type 2). The length is validated
    /// against the remaining buffer **before** the slice is formed — this is the
    /// OOB the PoC had. The returned slice borrows from `data`.
    pub fn readLengthDelimited(self: *Reader) Error![]const u8 {
        const len = try self.readVarint();
        if (len > self.remaining()) return error.Malformed;
        const start = self.pos;
        self.pos += @intCast(len); // safe: len <= remaining <= data.len fits usize
        return self.data[start..self.pos];
    }

    /// Skips a field of the given wire type, keeping `pos` in bounds throughout.
    /// Group wire types (3, 4) are deprecated and never emitted by the device,
    /// so we reject them rather than implement recursive group skipping.
    pub fn skip(self: *Reader, wire_type: u3) Error!void {
        switch (wire_type) {
            0 => _ = try self.readVarint(), // varint
            1 => try self.advance(8), // fixed64
            2 => _ = try self.readLengthDelimited(), // length-delimited
            5 => try self.advance(4), // fixed32
            else => return error.Malformed, // 3,4 (groups), 6,7 (reserved)
        }
    }
};

/// A decoded field tag: its field number and wire type, split out so callers can
/// `switch` on the pair. `wire` is a `u3` because the low 3 bits are the wire
/// type by definition.
pub const Tag = struct {
    field: u64,
    wire: u3,

    pub fn read(r: *Reader) Error!Tag {
        const raw = try r.readVarint();
        return .{ .field = raw >> 3, .wire = @intCast(raw & 0x07) };
    }
};

test "readVarint decodes a single-byte value" {
    var r = Reader{ .data = &[_]u8{0x08} };
    try std.testing.expectEqual(@as(u64, 8), try r.readVarint());
    try std.testing.expect(r.atEnd());
}

test "readVarint decodes a multi-byte value" {
    // 300 = 0xAC 0x02 in LEB128.
    var r = Reader{ .data = &[_]u8{ 0xAC, 0x02 } };
    try std.testing.expectEqual(@as(u64, 300), try r.readVarint());
}

test "readVarint rejects a truncated varint instead of panicking" {
    // Continuation bit set but no following byte.
    var r = Reader{ .data = &[_]u8{0x80} };
    try std.testing.expectError(error.Truncated, r.readVarint());
}

test "readVarint rejects an over-long (>10 byte) varint — the u5-shift bug" {
    // Eleven 0x80 bytes: all continuation, never terminates within 64 bits.
    var r = Reader{ .data = &[_]u8{ 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80 } };
    try std.testing.expectError(error.VarintOverflow, r.readVarint());
}

test "readVarint accepts a full 10-byte varint" {
    // Max u64: nine 0xFF payloads then 0x01. Must NOT be flagged overflow.
    var r = Reader{ .data = &[_]u8{ 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01 } };
    try std.testing.expectEqual(@as(u64, std.math.maxInt(u64)), try r.readVarint());
}

test "readLengthDelimited bounds the length before slicing" {
    // Says "5 bytes follow" but only 2 remain.
    var r = Reader{ .data = &[_]u8{ 0x05, 'a', 'b' } };
    try std.testing.expectError(error.Malformed, r.readLengthDelimited());
}

test "readLengthDelimited returns the exact run" {
    var r = Reader{ .data = &[_]u8{ 0x03, 'a', 'b', 'c', 'X' } };
    try std.testing.expectEqualStrings("abc", try r.readLengthDelimited());
    try std.testing.expectEqual(@as(usize, 4), r.pos); // trailing 'X' untouched
}

test "skip keeps position in bounds for fixed widths" {
    var r = Reader{ .data = &[_]u8{ 0x01, 0x02, 0x03 } }; // only 3 bytes
    try std.testing.expectError(error.Truncated, r.skip(1)); // fixed64 wants 8
}

test "skip rejects group wire types rather than looping" {
    var r = Reader{ .data = &[_]u8{0x00} };
    try std.testing.expectError(error.Malformed, r.skip(3));
}
