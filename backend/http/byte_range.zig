//! HTTP `Range` parsing for the byte routes (RFC 9110 §14). Single ranges
//! only: a multi-range request is ignored and answered 200 with everything,
//! which §14.2 permits; MuPDF only ever asks for one window.

const std = @import("std");

pub const Resolved = union(enum) {
    /// No header, or one ignored (multi-range, unknown unit, malformed), as
    /// RFC 9110 requires for an invalid `Range`.
    none,
    /// `len` is never 0.
    partial: struct { off: u64, len: u64 },
    /// Valid but outside the representation: 416 with `bytes */{total}`.
    unsatisfiable,
};

/// Parses the raw `Range` header ("" when absent) against `total`. The last
/// byte position is inclusive; `bytes=-N` is the last N bytes.
pub fn parse(value: []const u8, total: u64) Resolved {
    const spec = trim(value);
    if (spec.len == 0) return .none;

    const eq = std.mem.indexOfScalar(u8, spec, '=') orelse return .none;
    if (!std.ascii.eqlIgnoreCase(trim(spec[0..eq]), "bytes")) return .none;

    const set = trim(spec[eq + 1 ..]);
    if (set.len == 0) return .none;
    if (std.mem.indexOfScalar(u8, set, ',') != null) return .none;

    const dash = std.mem.indexOfScalar(u8, set, '-') orelse return .none;
    const first_txt = trim(set[0..dash]);
    const last_txt = trim(set[dash + 1 ..]);

    if (first_txt.len == 0) {
        // Suffix form: the last N bytes. Read as an offset it would serve a
        // PDF's front instead of its trailer.
        const want = parseU64(last_txt) orelse return .none;
        if (want == 0) return .unsatisfiable;
        if (total == 0) return .unsatisfiable;
        const len = @min(want, total); // a suffix longer than the file is legal
        return .{ .partial = .{ .off = total - len, .len = len } };
    }

    const first = parseU64(first_txt) orelse return .none;
    if (first >= total) return .unsatisfiable;

    if (last_txt.len == 0) return .{ .partial = .{ .off = first, .len = total - first } };

    const last = parseU64(last_txt) orelse return .none;
    if (last < first) return .none;
    const end = @min(last, total - 1);
    return .{ .partial = .{ .off = first, .len = end - first + 1 } };
}

fn trim(s: []const u8) []const u8 {
    return std.mem.trim(u8, s, " \t");
}

/// Digits only: a sign is malformed inside a position, and overflow fails.
fn parseU64(s: []const u8) ?u64 {
    if (s.len == 0) return null;
    for (s) |c| if (!std.ascii.isDigit(c)) return null;
    return std.fmt.parseInt(u64, s, 10) catch null;
}

// ---------------------------------------------------------------------------

const testing = std.testing;

fn expectPartial(r: Resolved, off: u64, len: u64) !void {
    switch (r) {
        .partial => |p| {
            try testing.expectEqual(off, p.off);
            try testing.expectEqual(len, p.len);
        },
        else => return error.TestExpectedPartial,
    }
}

test "absent, malformed and declined headers are all ignored" {
    try testing.expectEqual(Resolved.none, parse("", 100));
    try testing.expectEqual(Resolved.none, parse("   ", 100));
    try testing.expectEqual(Resolved.none, parse("bytes=", 100));
    try testing.expectEqual(Resolved.none, parse("bytes=abc", 100));
    try testing.expectEqual(Resolved.none, parse("bytes=1", 100)); // no dash
    try testing.expectEqual(Resolved.none, parse("items=0-9", 100)); // unknown unit
    try testing.expectEqual(Resolved.none, parse("bytes=9-2", 100)); // inverted
    try testing.expectEqual(Resolved.none, parse("bytes=0-9,20-29", 100)); // multi
    try testing.expectEqual(Resolved.none, parse("bytes=+0-9", 100)); // signed pos
}

test "the inclusive last-byte-position, at its edges" {
    try expectPartial(parse("bytes=0-0", 100), 0, 1);
    try expectPartial(parse("bytes=0-499", 1000), 0, 500);
    try expectPartial(parse("bytes=99-99", 100), 99, 1); // the last byte
    try expectPartial(parse("bytes=0-99", 100), 0, 100); // exactly the whole file
}

test "an open-ended range runs to the end" {
    try expectPartial(parse("bytes=500-", 1000), 500, 500);
    try expectPartial(parse("bytes=0-", 1000), 0, 1000);
    try expectPartial(parse("bytes=999-", 1000), 999, 1);
}

test "the SUFFIX form counts from the end, and clamps" {
    try expectPartial(parse("bytes=-500", 1000), 500, 500);
    try expectPartial(parse("bytes=-1", 1000), 999, 1);
    try expectPartial(parse("bytes=-5000", 1000), 0, 1000);
}

test "a last-byte-position past the end clamps rather than failing" {
    try expectPartial(parse("bytes=990-5000", 1000), 990, 10);
}

test "unsatisfiable is distinct from ignored — it is a 416, not a 200" {
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=1000-", 1000));
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=1000-2000", 1000));
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=-0", 1000));
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=0-0", 0));
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=-1", 0));
}

test "absurd numbers are refused, not wrapped" {
    try testing.expectEqual(Resolved.none, parse("bytes=18446744073709551616-", 1000));
    try testing.expectEqual(Resolved.none, parse("bytes=0-18446744073709551616", 1000));
}

test "whitespace around the parts is tolerated" {
    try expectPartial(parse("  bytes = 0 - 9  ", 100), 0, 10);
}
