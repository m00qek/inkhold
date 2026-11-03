//! Tests for the SNPG page payload.

const std = @import("std");
const testing = std.testing;
const page_payload = @import("page_payload.zig");
const decodeRgba = page_payload.decodeRgba;

test "decodeRgba: bad magic / short buffer rejected, never crashes" {
    const gpa = testing.allocator;
    try testing.expectError(error.BadPayload, decodeRgba(gpa, "XXXX\x01\x01\x00\x00"));
    try testing.expectError(error.BadPayload, decodeRgba(gpa, "SN"));
}
