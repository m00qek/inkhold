//! Allocation-free reader for the slice of protobuf wire format the `.spd`
//! layer tree (`config['ls']`) uses. Every path over untrusted bytes returns an
//! error rather than panicking.

const std = @import("std");

pub const Error = error{
    /// The buffer ended mid-field.
    Truncated,
    /// A varint did not terminate within 10 bytes.
    VarintOverflow,
    /// Group wire types (3, 4), or a length that overruns the buffer.
    Malformed,
};

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

    fn advance(self: *Reader, n: usize) Error!void {
        if (n > self.remaining()) return error.Truncated;
        self.pos += n;
    }

    /// Reads one LEB128 varint, bounded to 10 bytes so the shift never reaches
    /// 64. Bits past 64 are discarded, per the protobuf spec.
    pub fn readVarint(self: *Reader) Error!u64 {
        var result: u64 = 0;
        var shift: u6 = 0; // legal u64 shift amounts are 0..63 — exactly u6's range
        while (true) {
            const b = try self.readByte();
            result |= @as(u64, b & 0x7f) << shift;
            if (b & 0x80 == 0) return result;
            if (shift >= 63) return error.VarintOverflow;
            shift += 7;
        }
    }

    /// Reads a wire-type-2 run, bounds-checking the length before slicing.
    /// Borrows from `data`.
    pub fn readLengthDelimited(self: *Reader) Error![]const u8 {
        const len = try self.readVarint();
        if (len > self.remaining()) return error.Malformed;
        const start = self.pos;
        self.pos += @intCast(len); // safe: len <= remaining <= data.len fits usize
        return self.data[start..self.pos];
    }

    /// Skips a field. Group types (3, 4) are deprecated and never emitted by
    /// the device, so they are rejected.
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

/// A decoded field tag.
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
