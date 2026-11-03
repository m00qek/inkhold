//! Comptime repetition, for what `a ** n` spelled before Zig 0.17 removed it.

/// `unit` repeated `n` times, as a pointer to a comptime array (usable with `++`
/// and anywhere a string literal is).
pub fn repeat(comptime T: type, comptime unit: []const T, comptime n: usize) *const [unit.len * n]T {
    const out = comptime blk: {
        @setEvalBranchQuota(10 * unit.len * n + 1000);
        var a: [unit.len * n]T = undefined;
        for (0..n) |i| @memcpy(a[i * unit.len ..][0..unit.len], unit);
        break :blk a;
    };
    return &out;
}

test repeat {
    const std = @import("std");
    try std.testing.expectEqualStrings("ababab", repeat(u8, "ab", 3));
    try std.testing.expectEqualStrings("x" ++ "pp", "x" ++ repeat(u8, "p", 2));
    try std.testing.expectEqual(0, repeat(u8, "q", 0).len);
}
