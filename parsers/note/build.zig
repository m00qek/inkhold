//! Standalone build for the `.note` parser package.
//!
//! It is intentionally self-contained: `zig build test` here runs the whole
//! suite without touching the root project's `build.zig`. Unlike the sibling
//! `.spd` package this library is **pure Zig** — no libc, no vendored C — so a
//! consumer just imports the `note` module and is done.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // The importable library.
    const note = b.addModule("note", .{ .root_source_file = b.path("src/root.zig") });

    const test_step = b.step("test", "Run the .note parser tests");

    // Unit tests that live beside the code (reached through root.zig).
    const unit_mod = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = unit_mod })).step);

    // Integration tests: real-fixture correctness (container structure, golden
    // decode hashes), the tier-laziness read-accounting proofs, and the
    // build->serialize->parse property test over synthetic containers.
    for ([_][]const u8{ "tests/note_test.zig", "tests/content_test.zig" }) |path| {
        const it_mod = b.createModule(.{
            .root_source_file = b.path(path),
            .target = target,
            .optimize = optimize,
        });
        it_mod.addImport("note", note);
        test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = it_mod })).step);
    }
}
