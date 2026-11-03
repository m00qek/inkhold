//! A tiny property-testing harness: runs a property over generated inputs and,
//! on failure, prints the seed to reproduce the case (no shrinking).

const std = @import("std");

pub const Options = struct {
    runs: usize = 1000,
    /// Base seed; case `i` uses `seed +% i`. Deterministic by default.
    seed: u64 = 0,
    /// Suppress the reproduction print (for expected failures).
    quiet: bool = false,
};

/// Runs `property` against `runs` inputs; `gen` gets a per-case arena.
pub fn check(
    comptime Input: type,
    allocator: std.mem.Allocator,
    gen: *const fn (random: std.Random, arena: std.mem.Allocator) anyerror!Input,
    property: *const fn (input: Input) anyerror!void,
    opts: Options,
) !void {
    var i: usize = 0;
    while (i < opts.runs) : (i += 1) {
        const seed = opts.seed +% i;
        var prng = std.Random.DefaultPrng.init(seed);

        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();

        const input = try gen(prng.random(), arena.allocator());
        property(input) catch |err| {
            if (!opts.quiet) std.debug.print(
                "\n[prop] property failed on run {d}/{d} " ++
                    "(reproduce with .{{ .seed = {d}, .runs = 1 }}): {s}\n",
                .{ i + 1, opts.runs, seed, @errorName(err) },
            );
            return err;
        };
    }
}

test "check runs the property for every generated case" {
    const G = struct {
        fn gen(r: std.Random, _: std.mem.Allocator) anyerror!u32 {
            return r.intRangeAtMost(u32, 0, 1000);
        }
        fn prop(x: u32) anyerror!void {
            try std.testing.expect(x <= 1000);
        }
    };
    try check(u32, std.testing.allocator, G.gen, G.prop, .{ .runs = 500 });
}

test "check surfaces a violated property as an error" {
    const G = struct {
        fn gen(r: std.Random, _: std.mem.Allocator) anyerror!u32 {
            return r.int(u32);
        }
        fn prop(x: u32) anyerror!void {
            try std.testing.expect(x == 0);
        }
    };
    try std.testing.expectError(
        error.TestUnexpectedResult,
        check(u32, std.testing.allocator, G.gen, G.prop, .{ .runs = 100, .quiet = true }),
    );
}
