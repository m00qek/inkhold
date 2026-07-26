//! Tier 0 — detection of the `.note` file family and format version.
//!
//! Layout of the leading bytes:
//!   - bytes [0..4)  : file-type marker (e.g. "note")
//!   - X-series      : signature `SN_FILE_VER_<8 digits>` at offset 4
//!   - original      : signature `SN_FILE_ASA_<8 digits>` at offset 0
//!
//! The trailing 8 digits are a monotonically increasing version key.
//!
//! `probe_len` bytes are always enough to answer "is this a `.note` at all, and
//! which family/version" — the cheapest question the library can be asked.

const std = @import("std");

pub const Error = error{
    /// The leading bytes carry neither known signature — this is not a `.note`
    /// (or is cut so short the signature itself is missing).
    NotNote,
};

/// The most bytes a signature can occupy: 4-byte file-type marker +
/// `SN_FILE_VER_` + 8 digits. Reading exactly this much is enough to detect
/// either family without pulling in the file.
pub const probe_len = 24;

pub const Family = enum { x_series, original };

pub const Signature = struct {
    family: Family,
    /// The 8-digit version key, e.g. 20260016.
    version: u32,
    /// The 4-byte file-type marker (e.g. "note"). Borrows from input.
    filetype: []const u8,
    /// The full signature string. Borrows from input.
    raw: []const u8,

    /// High-resolution grayscale is supported from version 20230015 onward.
    pub fn supportsHighresGrayscale(self: Signature) bool {
        return self.version >= 20230015;
    }
};

const X_PREFIX = "SN_FILE_VER_";
const ASA_PREFIX = "SN_FILE_ASA_";
const DIGITS = 8;

pub fn detect(bytes: []const u8) Error!Signature {
    // Try X-series first: it is by far the common case.
    if (matchAt(bytes, 4, X_PREFIX)) |raw| {
        return .{
            .family = .x_series,
            .version = try parseVersion(raw),
            .filetype = bytes[0..4],
            .raw = raw,
        };
    }
    if (matchAt(bytes, 0, ASA_PREFIX)) |raw| {
        return .{
            .family = .original,
            .version = try parseVersion(raw),
            .filetype = bytes[0..@min(4, bytes.len)],
            .raw = raw,
        };
    }
    return error.NotNote;
}

/// If `prefix` followed by `DIGITS` digits sits at `offset`, returns the full
/// signature slice; otherwise null.
fn matchAt(bytes: []const u8, offset: usize, prefix: []const u8) ?[]const u8 {
    const total = prefix.len + DIGITS;
    if (offset + total > bytes.len) return null;
    const window = bytes[offset .. offset + total];
    if (!std.mem.startsWith(u8, window, prefix)) return null;
    for (window[prefix.len..]) |c| {
        if (!std.ascii.isDigit(c)) return null;
    }
    return window;
}

fn parseVersion(raw: []const u8) Error!u32 {
    const digits = raw[raw.len - DIGITS ..];
    return std.fmt.parseInt(u32, digits, 10) catch error.NotNote;
}

test "detect X-series signature at offset 4" {
    const sig = try detect("noteSN_FILE_VER_20260016rest-of-file");
    try std.testing.expectEqual(Family.x_series, sig.family);
    try std.testing.expectEqual(@as(u32, 20260016), sig.version);
    try std.testing.expectEqualStrings("note", sig.filetype);
    try std.testing.expect(sig.supportsHighresGrayscale());
}

test "detect original ASA signature at offset 0" {
    const sig = try detect("SN_FILE_ASA_20190529....");
    try std.testing.expectEqual(Family.original, sig.family);
    try std.testing.expectEqual(@as(u32, 20190529), sig.version);
    try std.testing.expect(!sig.supportsHighresGrayscale());
}

test "unknown signature is rejected" {
    try std.testing.expectError(error.NotNote, detect("not a supernote file at all"));
}

test "truncated input is rejected, not a crash" {
    try std.testing.expectError(error.NotNote, detect("note"));
}
