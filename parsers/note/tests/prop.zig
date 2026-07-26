//! A tiny, dependency-free property-testing harness.
//!
//! Zig has no built-in property testing. This runs a `property` over many
//! generated inputs and, on failure, prints the seed needed to reproduce the
//! exact case. Runs are deterministic by default (base seed 0) so CI is stable;
//! pass a different `seed` to explore more of the space.
//!
//! There is no automatic shrinking — instead we report the failing seed so you
//! can re-run that single case under a debugger:
//!
//!     try prop.check(MyInput, alloc, gen, property, .{ .seed = 12345, .runs = 1 });

const std = @import("std");

pub const Options = struct {
    /// Number of generated cases to try.
    runs: usize = 1000,
    /// Base seed; case `i` uses `seed +% i`. Deterministic by default.
    seed: u64 = 0,
    /// Suppress the failure-reproduction print (used when a failure is expected,
    /// e.g. the harness's own negative self-test).
    quiet: bool = false,
};

/// Runs `property` against `runs` generated inputs.
///
/// `gen` receives a PRNG and an arena allocator scoped to a single case (freed
/// after each run), so generators may allocate freely without leaking.
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

// A self-test: a property that must hold for all generated inputs.
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
            // Deliberately false in general; must fail.
            try std.testing.expect(x == 0);
        }
    };
    try std.testing.expectError(
        error.TestUnexpectedResult,
        check(u32, std.testing.allocator, G.gen, G.prop, .{ .runs = 100, .quiet = true }),
    );
}
