//! HTTP `Range` parsing for the byte routes (RFC 9110 §14).
//!
//! Split out as a PURE function over (header, total) because that is where the
//! bugs live: the three syntactic forms mean three different arithmetic, the
//! last-byte position is INCLUSIVE (an off-by-one here serves the wrong bytes
//! forever, silently, to a client that cannot tell), and a suffix range longer
//! than the file is legal and clamps rather than failing. None of that needs a
//! socket to test.
//!
//! **Single ranges only.** A multi-range request (`bytes=0-9,20-29`) must be
//! answered with a `multipart/byteranges` body, which means composing MIME parts
//! on a server whose whole posture is fixed buffers and streaming. RFC 9110
//! §14.2 explicitly permits ignoring `Range` and answering 200 with the whole
//! representation, so that is what a multi-range request gets. No client we serve
//! sends one: MuPDF's stream asks for one window at a time.

const std = @import("std");

pub const Resolved = union(enum) {
    /// No `Range` header, or one we deliberately decline (multi-range, an unknown
    /// unit, anything malformed). RFC 9110: an invalid `Range` MUST be ignored.
    none,
    /// A satisfiable window. `len` is never 0 — a zero-length range is not
    /// representable in the header's inclusive form.
    partial: struct { off: u64, len: u64 },
    /// Syntactically valid but outside the representation: answer `416` with
    /// `Content-Range: bytes */{total}`.
    unsatisfiable,
};

/// Parse `value` (the raw `Range` header, "" when absent) against a `total` size.
///
/// Handles the three forms:
///   - `bytes=0-499`   first 500 bytes (last-byte-pos INCLUSIVE)
///   - `bytes=500-`    from 500 to the end
///   - `bytes=-500`    the LAST 500 bytes (a suffix length, not an offset)
pub fn parse(value: []const u8, total: u64) Resolved {
    const spec = trim(value);
    if (spec.len == 0) return .none;

    // Unit must be `bytes`. Anything else is a unit we do not implement, and an
    // unrecognised unit is ignored rather than refused.
    const eq = std.mem.indexOfScalar(u8, spec, '=') orelse return .none;
    if (!std.ascii.eqlIgnoreCase(trim(spec[0..eq]), "bytes")) return .none;

    const set = trim(spec[eq + 1 ..]);
    if (set.len == 0) return .none;
    // Multi-range: decline, and answer 200 with everything (see the header note).
    if (std.mem.indexOfScalar(u8, set, ',') != null) return .none;

    const dash = std.mem.indexOfScalar(u8, set, '-') orelse return .none;
    const first_txt = trim(set[0..dash]);
    const last_txt = trim(set[dash + 1 ..]);

    if (first_txt.len == 0) {
        // SUFFIX form: `-N` is "the last N bytes", NOT "from 0 to N". Reading it
        // as an offset is the classic misparse and serves the front of the file
        // to a client asking for the back — which for a PDF means the trailer,
        // which means every document fails to open.
        const want = parseU64(last_txt) orelse return .none;
        if (want == 0) return .unsatisfiable; // `bytes=-0`: no bytes can satisfy it
        if (total == 0) return .unsatisfiable;
        const len = @min(want, total); // a suffix longer than the file is legal
        return .{ .partial = .{ .off = total - len, .len = len } };
    }

    const first = parseU64(first_txt) orelse return .none;
    // A first-byte-pos at or past the end is unsatisfiable — including on an
    // EMPTY representation, where every position is past the end.
    if (first >= total) return .unsatisfiable;

    if (last_txt.len == 0) return .{ .partial = .{ .off = first, .len = total - first } };

    const last = parseU64(last_txt) orelse return .none;
    if (last < first) return .none; // inverted: malformed, so ignored
    // Clamp: a last-byte-pos past the end is legal and means "to the end".
    const end = @min(last, total - 1);
    return .{ .partial = .{ .off = first, .len = end - first + 1 } };
}

fn trim(s: []const u8) []const u8 {
    return std.mem.trim(u8, s, " \t");
}

/// Digits only, and rejects anything that would overflow. Deliberately NOT
/// `parseInt` with a sign: `bytes=-5` is the suffix form, and a `+` or a `-`
/// inside a position is malformed rather than clever.
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
    // Ignored means "serve 200 with everything" — never an error to the client.
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
    // `0-0` is ONE byte, not zero. This is the off-by-one that would serve every
    // client one byte short of what it asked for, forever, undetectably.
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
    // `-500` is the last 500 bytes. Read as an offset it would serve the FRONT,
    // which for a PDF is the one place its trailer certainly is not.
    try expectPartial(parse("bytes=-500", 1000), 500, 500);
    try expectPartial(parse("bytes=-1", 1000), 999, 1);
    // Longer than the file: legal, and means the whole thing.
    try expectPartial(parse("bytes=-5000", 1000), 0, 1000);
}

test "a last-byte-position past the end clamps rather than failing" {
    try expectPartial(parse("bytes=990-5000", 1000), 990, 10);
}

test "unsatisfiable is distinct from ignored — it is a 416, not a 200" {
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=1000-", 1000));
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=1000-2000", 1000));
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=-0", 1000));
    // An empty representation: every position is past the end.
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=0-0", 0));
    try testing.expectEqual(Resolved.unsatisfiable, parse("bytes=-1", 0));
}

test "absurd numbers are refused, not wrapped" {
    // 2^64 does not fit; parsing must fail rather than truncate into a valid-
    // looking offset.
    try testing.expectEqual(Resolved.none, parse("bytes=18446744073709551616-", 1000));
    try testing.expectEqual(Resolved.none, parse("bytes=0-18446744073709551616", 1000));
}

test "whitespace around the parts is tolerated" {
    try expectPartial(parse("  bytes = 0 - 9  ", 100), 0, 10);
}
